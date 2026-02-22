from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import ee

from ee_service import init_ee, get_roi, get_indicator_image, vis_params, make_tile_url
from functools import lru_cache

# =====================
# ให้กราฟ “ตรงกับ GEE”
# - เปลี่ยนจากนับจำนวนพิกเซล -> คำนวณ “พื้นที่ (ไร่)” ด้วย pixelArea
# - ทำ normalization ให้ LUC/NPP (ค่าต่อเนื่อง) -> 3 class (1/2/3)
# - mask NoData แบบเดียวกับในสคริปต์ GEE
# - (สำคัญ) mask indicator ให้ใช้ขอบเขต valid-data ของ LDN ด้วย
# =====================

M2_PER_RAI = 1600
CHART_SCALE = 100   # ให้ตรงกับฝั่ง GEE ที่ตั้ง CHART_SCALE=100


def _round2(n: ee.Number) -> ee.Number:
    return ee.Number(n).multiply(100).round().divide(100)


def _get_chart_scale(img: ee.Image) -> float:
    # ใช้ native resolution ของ asset ตรง ๆ
    return float(img.projection().nominalScale().getInfo() or 30)


def _base_mask(img: ee.Image) -> ee.Image:
    """mask NaN/NoData ที่มักเจอ (-9999, -999, -1)"""
    img = ee.Image(img)
    # NaN check: x == x
    m = img.eq(img)
    m = m.And(img.neq(-9999)).And(img.neq(-999)).And(img.neq(-1))
    return img.updateMask(m)


def _normalize_indicator_continuous(img: ee.Image, roi: ee.Geometry, ref_proj: ee.Projection) -> ee.Image:
    """สำหรับ LUC/NPP ที่เป็นค่าต่อเนื่อง ~ 1.0–3.0 (อาจมี 1.333, 1.666 ฯลฯ)
    ปัดเป็น 1/2/3 แล้วเก็บเป็น band ชื่อ 'class'"""
    img = _base_mask(img).clip(roi)

    # กันค่าหลุดช่วงแบบคร่าว ๆ (เหมือน GEE)
    img = img.updateMask(img.gte(0.5).And(img.lte(3.5)))

    v = img.round().toInt()
    cls = (
        ee.Image(-1)
        .where(v.eq(1), 1)
        .where(v.eq(2), 2)
        .where(v.eq(3), 3)
        .rename("class")
        .toByte()
        .setDefaultProjection(ref_proj)
        .updateMask(img.mask())
    )
    return cls


def _normalize_indicator_discrete(img: ee.Image, roi: ee.Geometry, ref_proj: ee.Projection) -> ee.Image:
    """สำหรับ SOC ที่เป็น 1/2/3 อยู่แล้ว (แต่เผื่อเป็น float)"""
    img = _base_mask(img).clip(roi)
    v = img.round().toInt()
    cls = (
        ee.Image(-1)
        .where(v.eq(1), 1)
        .where(v.eq(2), 2)
        .where(v.eq(3), 3)
        .rename("class")
        .toByte()
        .setDefaultProjection(ref_proj)
        .updateMask(img.mask())
    )
    return cls


def _normalize_final_ldn(img: ee.Image, roi: ee.Geometry) -> ee.Image:
    """LDN สุดท้าย: 0..4 (0 stable, 1 improved, 2 slight, 3 moderate, 4 severe)"""
    img = _base_mask(img).clip(roi)
    cls = img.round().toInt().rename("class")
    return cls


def _area_by_class_rai(class_img: ee.Image, roi: ee.Geometry, scale: ee.Number) -> ee.Dictionary:
    """คืน dict: {"0": area_rai, "1": area_rai, ... }"""
    # ✅ ปัดค่าให้เป็น integer class ก่อนคำนวณพื้นที่ (กัน error จาก floating point noise)
    class_img = ee.Image(class_img).round().toInt().rename("class")

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


def _get_class_image_for_layer(province: str, layer: str, roi: ee.Geometry) -> ee.Image:
    if layer not in {"luc", "soc", "npp", "ldn"}:
        raise ValueError("layer must be one of luc/soc/npp/ldn")

    raw = get_indicator_image(province, layer)

    # ✅ Mask indicator ให้ใช้ขอบเขตเดียวกับ LDN (เพื่อให้พื้นที่รวมตรงกัน)
    if layer != "ldn":
        ldn_img = get_indicator_image(province, "ldn")
        raw = raw.updateMask(ldn_img.mask())

    return raw.clip(roi)



@asynccontextmanager
async def lifespan(app: FastAPI):
    init_ee()
    ee.data.setDeadline(60000)  # 60s กันค้างไม่จบ
    yield

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # allow all origins for local dev
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
        labels = [
            "Severely degraded",
            "Moderately degraded",
            "Slightly degraded",
            "Improved",
            "Stable",
        ]
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

        # Optimize: Combine layers first
        bands = []
        for lyr in ["luc", "soc", "npp", "ldn"]:
            img = _get_class_image_for_layer(province, lyr, roi)
            img = img.rename(lyr)
            bands.append(img)

        combined = ee.Image.cat(bands)

        # Use fixed scale=30 to avoid extra API call
        scale = 30

        # Build computation: Check ROI and get values in one Go
        is_in_roi = roi.contains(pt, maxError=1)
        
        # Use reduceRegion instead of sample for direct dictionary
        pixel_values = combined.reduceRegion(
            reducer=ee.Reducer.first(),
            geometry=pt,
            scale=scale,
        )

        # Single API call
        computed = ee.Dictionary({
            "in_roi": is_in_roi,
            "values": pixel_values
        })
        
        data = computed.getInfo()

        if not data.get("in_roi"):
            return {"in_roi": False}

        raw_values = data.get("values")
        
        # If raw_values is None or empty, it means masked (nodata)
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

        # ✅ รวมเป็น “พื้นที่ (ไร่)” ตามคลาส เหมือนใน GEE
        area_dict = _area_by_class_rai(class_img, roi, scale)

        if layer == "ldn":
            order_keys = ["4", "3", "2", "1", "0"]
            labels = [
                "Severely degraded",
                "Moderately degraded",
                "Slightly degraded",
                "Improved",
                "Stable",
            ]
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
            # raw เอาไว้ debug ถ้าต้องเทียบกับ GEE
            "raw": area_dict.getInfo(),
        }
    except Exception as e:
        raise HTTPException(400, str(e))

@app.get("/bounds")
def bounds(province: str):
    try:
        roi = get_roi(province)   # ← อันนี้เป็น Geometry อยู่แล้ว

        # ใช้ roi ตรง ๆ ไม่ต้อง .geometry()
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
