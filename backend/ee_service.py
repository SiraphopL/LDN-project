# ee_service.py
import re
import ee

ASSET_ROOT = "projects/steady-method-477813-p9/assets/"

# ถ้า frontend ส่งมาเป็น "Chiang Mai" หรือ "Chiang_Mai" ก็รองรับทั้งคู่
def to_asset_province_name(province: str) -> str:
    p = province.strip()
    p = p.replace(" ", "_")
    # กันเคสพิมพ์ underscore ซ้อน
    p = re.sub(r"_+", "_", p)
    return p

def init_ee():
    ee.Initialize(project="steady-method-477813-p9")

LAYER_SUFFIX = {
    "luc": "luc_ldn",
    "soc": "soc_ldn",
    "npp": "npp_ldn",
    "ldn": "final_ldn",
}

def get_indicator_image(province: str, layer: str) -> ee.Image:
    if layer not in LAYER_SUFFIX:
        raise ValueError(f"unknown layer: {layer}")

    prov = to_asset_province_name(province)
    asset_id = f"{ASSET_ROOT}{prov}_{LAYER_SUFFIX[layer]}"
    return ee.Image(asset_id)

from functools import lru_cache

@lru_cache(maxsize=32)
def get_roi(province: str):
    prov_name = province.replace("_", " ").strip()

    fc = ee.FeatureCollection("FAO/GAUL_SIMPLIFIED_500m/2015/level1") \
        .filter(ee.Filter.eq("ADM1_NAME", prov_name))

    if fc.size().getInfo() == 0:
        raise ValueError(f"Province not found in GAUL_SIMPLIFIED_500m: {prov_name}")

    # ✅ ตรงกับ GEE script: cfg.roi.first().geometry(ROI_MAX_ERROR)
    return ee.Feature(fc.first()).geometry(5)

def vis_params(layer: str):
    if layer in ("luc", "soc", "npp"):
        return {"min": 1, "max": 3, "palette": ["#d7191c", "#1a9641", "#fdd835"]}
    if layer == "ldn":
        return {"min": 0, "max": 4, "palette": ["#4def8e", "#32cd32", "#FA8072", "#FF0000", "#800000"]}
    return {}

def make_tile_url(image: ee.Image, vis: dict):
    m = image.visualize(**vis).getMapId()
    return {
        "mapid": m["mapid"],
        "token": m["token"],
        "urlFormat": m["tile_fetcher"].url_format
    }