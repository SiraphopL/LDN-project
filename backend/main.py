from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import ee

from ee_service import init_ee, get_roi, get_indicator_image, vis_params, make_tile_url
from functools import lru_cache

M2_PER_RAI = 1600
CHART_SCALE = 40


def _round2(n: ee.Number) -> ee.Number:
    return ee.Number(n).multiply(100).round().divide(100)


def _base_mask(img: ee.Image) -> ee.Image:
    img = ee.Image(img)
    m = img.eq(img)
    m = m.And(img.neq(-9999)).And(img.neq(-999)).And(img.neq(-1))
    return img.updateMask(m)


def _band_min_max(img: ee.Image, roi: ee.Geometry, scale: ee.Number) -> tuple[ee.Number, ee.Number]:
    """
    Compute min/max for the first band so we can auto-detect whether classes are 0-based or 1-based.
    """
    img = ee.Image(img)
    band = ee.String(img.bandNames().get(0))
    stats = img.reduceRegion(
        reducer=ee.Reducer.minMax(),
        geometry=roi,
        scale=scale,
        bestEffort=True,
        tileScale=8,
        maxPixels=1e13,
    )
    vmin = ee.Number(stats.get(band.cat("_min"), 0))
    vmax = ee.Number(stats.get(band.cat("_max"), 0))
    return vmin, vmax


def _normalize_indicator_continuous(img: ee.Image, roi: ee.Geometry, ref_proj: ee.Projection, zero_based: ee.Number) -> ee.Image:
    img = _base_mask(img).clip(roi)
    img = img.updateMask(img.gte(-0.5).And(img.lte(3.5)))
    v = img.round().toInt()
    one_is = ee.Number(ee.Algorithms.If(ee.Number(zero_based).eq(1), 2, 1))
    two_is = ee.Number(ee.Algorithms.If(ee.Number(zero_based).eq(1), 3, 2))
    cls = (
        ee.Image(-1)
        .where(v.eq(0), 1)
        .where(v.eq(1), one_is)
        .where(v.eq(2), two_is)
        .where(v.eq(3), 3)
        .rename("class")
        .toByte()
        .setDefaultProjection(ref_proj)
        .updateMask(img.mask())
    )
    return cls


def _normalize_indicator_discrete(img: ee.Image, roi: ee.Geometry, ref_proj: ee.Projection, zero_based: ee.Number) -> ee.Image:
    img = _base_mask(img).clip(roi)
    v = img.round().toInt()
    one_is = ee.Number(ee.Algorithms.If(ee.Number(zero_based).eq(1), 2, 1))
    two_is = ee.Number(ee.Algorithms.If(ee.Number(zero_based).eq(1), 3, 2))
    cls = (
        ee.Image(-1)
        .where(v.eq(0), 1)
        .where(v.eq(1), one_is)
        .where(v.eq(2), two_is)
        .where(v.eq(3), 3)
        .rename("class")
        .toByte()
        .setDefaultProjection(ref_proj)
        .updateMask(img.mask())
    )
    return cls


def _normalize_final_ldn(img: ee.Image, roi: ee.Geometry) -> ee.Image:
    img = _base_mask(img).clip(roi)
    v = img.toInt()
    vmin, vmax = _band_min_max(v, roi, ee.Number(CHART_SCALE))
    one_based = ee.Number(vmin.gte(1).And(vmax.lte(5)))
    cls = ee.Image(ee.Algorithms.If(one_based.eq(1), v.subtract(1), v)).rename("class")
    return cls


def _area_by_class_rai(class_img: ee.Image, roi: ee.Geometry, scale: ee.Number) -> ee.Dictionary:
    class_img = ee.Image(class_img).toInt().rename("class")
    valid = class_img.mask()
    class_img = class_img.updateMask(valid)

    area = (
        ee.Image.pixelArea()
        .divide(M2_PER_RAI)
        .rename("area_rai")
        .addBands(class_img)
    )

    stats = area.reduceRegion(
        reducer=ee.Reducer.sum().group(groupField=1, groupName="class"),
        geometry=roi,
        scale=scale,
        bestEffort=True,
        tileScale=8,
        maxPixels=1e13,
    )

    groups = ee.List(stats.get("groups"))

    def _iter(g, acc):
        g = ee.Dictionary(g)
        acc = ee.Dictionary(acc)
        k = ee.Number(g.get("class")).toInt().format()
        v = ee.Number(g.get("sum"))
        return acc.set(k, v)

    return ee.Dictionary(groups.iterate(_iter, ee.Dictionary({})))


def _build_common_mask(province: str, roi: ee.Geometry) -> ee.Image:
    """
    ✅ ตรงกับ GEE script บรรทัด 1040-1046:
    commonMask = luc.mask().and(soc.mask()).and(npp.mask())
    แต่ละ indicator ผ่าน normalize + mask LDN ก่อน
    """
    ldn_raw = get_indicator_image(province, "ldn")
    ldn_norm = _normalize_final_ldn(ldn_raw, roi)
    ldn_mask = ldn_norm.mask()
    ref_proj = ldn_raw.projection()

    luc_raw = get_indicator_image(province, "luc").updateMask(ldn_mask)
    soc_raw = get_indicator_image(province, "soc").updateMask(ldn_mask)
    npp_raw = get_indicator_image(province, "npp").updateMask(ldn_mask)

    luc_min, luc_max = _band_min_max(luc_raw, roi, ee.Number(CHART_SCALE))
    soc_min, soc_max = _band_min_max(soc_raw, roi, ee.Number(CHART_SCALE))
    npp_min, npp_max = _band_min_max(npp_raw, roi, ee.Number(CHART_SCALE))

    luc_zero_based = ee.Number(luc_min.lte(0).And(luc_max.lte(2)))
    soc_zero_based = ee.Number(soc_min.lte(0).And(soc_max.lte(2)))
    npp_zero_based = ee.Number(npp_min.lte(0).And(npp_max.lte(2)))

    luc_norm = _normalize_indicator_continuous(luc_raw, roi, ref_proj, luc_zero_based)
    soc_norm = _normalize_indicator_discrete(soc_raw, roi, ref_proj, soc_zero_based)
    npp_norm = _normalize_indicator_continuous(npp_raw, roi, ref_proj, npp_zero_based)

    common_mask = (
        luc_norm.mask()
        .And(soc_norm.mask())
        .And(npp_norm.mask())
        .And(ldn_mask)
    )
    return common_mask


def _get_class_image_for_layer(province: str, layer: str, roi: ee.Geometry) -> ee.Image:
    raw = get_indicator_image(province, layer)
    ref_proj = raw.projection()

    # mask ด้วย LDN ก่อน (เหมือน GEE script บรรทัด 1035-1037)
    ldn_img = get_indicator_image(province, "ldn")
    ldn_norm = _normalize_final_ldn(ldn_img, roi)
    ldn_mask = ldn_norm.mask()

    if layer != "ldn":
        raw = raw.updateMask(ldn_mask)

    if layer in ("luc", "npp"):
        vmin, vmax = _band_min_max(raw, roi, ee.Number(CHART_SCALE))
        zero_based = ee.Number(vmin.lte(0).And(vmax.lte(2)))
        img = _normalize_indicator_continuous(raw, roi, ref_proj, zero_based)
    elif layer == "soc":
        vmin, vmax = _band_min_max(raw, roi, ee.Number(CHART_SCALE))
        zero_based = ee.Number(vmin.lte(0).And(vmax.lte(2)))
        img = _normalize_indicator_discrete(raw, roi, ref_proj, zero_based)
    elif layer == "ldn":
        img = ldn_norm

    # ✅ ใช้ commonMask เหมือน GEE script บรรทัด 1040-1046
    # GEE: commonMask = luc.mask().and(soc.mask()).and(npp.mask())
    # และ ldnStatusWithOutside ถูก mask ด้วย commonMask ผ่าน ldnFromIndicators
    # แต่สังเกตว่า GEE ใช้ ldnAssetWithOutside (ไม่ใช่ ldnFromIndicators) สำหรับกราฟ
    # ดังนั้น LDN กราฟขวาใช้ asset ตรงๆ + mask แค่ LDN เอง (ไม่ใช้ commonMask)
    return img


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_ee()
    ee.data.setDeadline(60000)
    yield

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@lru_cache(maxsize=256)
def _summary_cached(province: str, layer: str):
    roi = get_roi(province)
    class_img = _get_class_image_for_layer(province, layer, roi)
    scale = ee.Number(CHART_SCALE)

    area_dict = _area_by_class_rai(class_img, roi, scale)

    if layer == "ldn":
        order_keys = ["4", "3", "2", "1", "0"]
        labels = ["Severely degraded", "Moderately degraded", "Slightly degraded", "Improved", "Stable"]
    else:
        order_keys = ["1", "2", "3"]
        labels = ["Degraded", "Improved", "Stable"]

    values_ee = ee.List([
        _round2(ee.Number(area_dict.get(k, 0))) for k in order_keys
    ])

    return {
        "province": province,
        "layer": layer,
        "unit": "rai",
        "labels": labels,
        "values": values_ee.getInfo(),
        "raw": area_dict.getInfo(),
    }

@lru_cache(maxsize=256)
def _tile_cached(province: str, layer: str):
    roi = get_roi(province)
    class_img = _get_class_image_for_layer(province, layer, roi)
    return make_tile_url(class_img, vis_params(layer))

@app.get("/tiles")
def tiles(province: str, layer: str):
    try:
        return _tile_cached(province, layer)
    except Exception as e:
        raise HTTPException(400, str(e))

@app.get("/sample")
def sample(province: str, lon: float, lat: float):
    try:
        roi = get_roi(province)
        pt = ee.Geometry.Point([lon, lat])

        bands = []
        for lyr in ["luc", "soc", "npp", "ldn"]:
            img = _get_class_image_for_layer(province, lyr, roi)
            img = img.rename(lyr)
            bands.append(img)

        combined = ee.Image.cat(bands)
        scale = 30

        is_in_roi = roi.contains(pt, maxError=1)
        pixel_values = combined.reduceRegion(
            reducer=ee.Reducer.first(),
            geometry=pt,
            scale=scale,
        )

        computed = ee.Dictionary({
            "in_roi": is_in_roi,
            "values": pixel_values
        })

        data = computed.getInfo()

        if not data.get("in_roi"):
            return {"in_roi": False}

        raw_values = data.get("values")

        if not raw_values:
            return {"in_roi": True, "values": None}

        return {
            "in_roi": True,
            "values": {
                "luc": {"class": raw_values.get("luc")},
                "soc": {"class": raw_values.get("soc")},
                "npp": {"class": raw_values.get("npp")},
                "ldn": {"class": raw_values.get("ldn")},
            }
        }

    except Exception as e:
        raise HTTPException(400, str(e))

@app.get("/summary")
def summary(province: str, layer: str):
    try:
        roi = get_roi(province)
        class_img = _get_class_image_for_layer(province, layer, roi)
        scale = ee.Number(CHART_SCALE)

        area_dict = _area_by_class_rai(class_img, roi, scale)

        if layer == "ldn":
            order_keys = ["4", "3", "2", "1", "0"]
            labels = ["Severely degraded", "Moderately degraded", "Slightly degraded", "Improved", "Stable"]    
        else:
            order_keys = ["1", "2", "3"]
            labels = ["Degraded", "Improved", "Stable"]

        values_ee = ee.List([
            _round2(ee.Number(area_dict.get(k, 0))) for k in order_keys
        ])

        total_area = (
            ee.Image.pixelArea()
            .divide(M2_PER_RAI)
            .reduceRegion(
                reducer=ee.Reducer.sum(),
                geometry=roi,
                scale=scale,
                bestEffort=True,
                maxPixels=1e13,
            )
            .get("area")
        )

        return {
            "province": province,
            "layer": layer,
            "unit": "rai",
            "province_area": _round2(ee.Number(total_area)).getInfo(),
            "labels": labels,
            "values": values_ee.getInfo(),
            "raw": area_dict.getInfo(),
        }
    except Exception as e:
        raise HTTPException(400, str(e))

@app.get("/bounds")
def bounds(province: str):
    try:
        roi = get_roi(province)
        bbox = roi.bounds().getInfo()
        coords = bbox["coordinates"][0]
        minLon, minLat = coords[0]
        maxLon, maxLat = coords[2]
        return {
            "bounds": [
                [minLat, minLon],
                [maxLat, maxLon]
            ]
        }
    except Exception as e:
        print("BOUNDS ERROR:", e)
        raise HTTPException(400, str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
