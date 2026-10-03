import base64
import io
import json
import pathlib
import zlib
import tempfile
import zipfile
import os
import gc
import time
from contextvars import ContextVar
from collections.abc import MutableMapping

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from PIL import Image
from pydantic import BaseModel, field_validator

app = FastAPI(title="AHP WebGIS Sugarcane - Khon Kaen")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# ==========================================================
# แยกข้อมูล Backend ตาม Session ของผู้ใช้
# ==========================================================
current_session_id = ContextVar("current_session_id", default="anonymous")

# Session storage
session_store: dict[str, dict] = {}
session_last_seen: dict[str, float] = {}
SESSION_TTL = 30 * 60          # 30 นาที
CLEANUP_INTERVAL = 5 * 60      # ตรวจทุก 5 นาที
last_cleanup_time = 0.0

def get_session_id() -> str:
    sid = current_session_id.get()
    return sid if sid else "anonymous"

def get_session_store() -> dict:
    sid = get_session_id()
    session_last_seen[sid] = time.monotonic()
    if sid not in session_store:
        session_store[sid] = {
            "raw_layers": {},
            "uploaded_layers": {},
            "classification_tables": {},
            "last_suitability_result": {"array": None},
        }
    return session_store[sid]

class SessionDict(MutableMapping):
    def __init__(self, key: str):
        self.key = key
    def _data(self):
        return get_session_store()[self.key]
    def __getitem__(self, key):
        return self._data()[key]
    def __setitem__(self, key, value):
        self._data()[key] = value
    def __delitem__(self, key):
        del self._data()[key]
    def __iter__(self):
        return iter(self._data())
    def __len__(self):
        return len(self._data())
    def clear(self):
        self._data().clear()
    def get(self, key, default=None):
        return self._data().get(key, default)
    def pop(self, key, default=None):
        return self._data().pop(key, default)

def clear_session(session_id: str) -> bool:
    """ลบข้อมูล Raster/ผลลัพธ์ของ Session เดียว แล้วขอคืนหน่วยความจำ"""
    store = session_store.pop(session_id, None)
    session_last_seen.pop(session_id, None)

    if store is None:
        return False

    for key in ["raw_layers", "uploaded_layers", "classification_tables", "last_suitability_result"]:
        if key in store and isinstance(store[key], dict):
            store[key].clear()

    store.clear()
    del store
    gc.collect()
    return True

def cleanup_expired_sessions():
    global last_cleanup_time
    now = time.monotonic()
    if now - last_cleanup_time < CLEANUP_INTERVAL:
        return
        
    last_cleanup_time = now
    expired_sids = [
        sid for sid, last_seen in session_last_seen.items() 
        if now - last_seen > SESSION_TTL
    ]
    for sid in expired_sids:
        clear_session(sid)

@app.middleware("http")
async def session_middleware(request, call_next):
    sid = request.headers.get("X-Session-ID") or "anonymous"
    sid = sid[:128]

    if request.method == "OPTIONS":
        return await call_next(request)

    cleanup_expired_sessions()

    if sid != "anonymous":
        session_last_seen[sid] = time.monotonic()

    token = current_session_id.set(sid)
    try:
        response = await call_next(request)
        return response
    finally:
        current_session_id.reset(token)

class AHPRequest(BaseModel):
    factors: list[str]
    matrix: list[list[float]]

    @field_validator("matrix")
    @classmethod
    def check_square(cls, m, info):
        n = len(m)
        if any(len(row) != n for row in m):
            raise ValueError("matrix ต้องเป็นเมทริกซ์จัตุรัส (n x n)")
        return m

RI_TABLE = {
    1: 0.00, 2: 0.00, 3: 0.58, 4: 0.90, 5: 1.12,
    6: 1.24, 7: 1.32, 8: 1.41, 9: 1.45, 10: 1.49,
}

def solve_ahp_weights(matrix: list[list[float]]) -> dict:
    A = np.array(matrix, dtype=float)
    n = A.shape[0]

    eigenvalues, eigenvectors = np.linalg.eig(A)
    max_index = int(np.argmax(np.real(eigenvalues)))
    max_lambda = float(np.real(eigenvalues[max_index]))
    principal_vector = np.real(eigenvectors[:, max_index])

    if np.sum(principal_vector) < 0:
        principal_vector = -principal_vector

    weights = principal_vector / np.sum(principal_vector)

    ci = (max_lambda - n) / (n - 1) if n > 1 else 0.0
    ri = RI_TABLE.get(n, 1.49)
    cr = ci / ri if ri > 0 else 0.0

    return {
        "weights": weights,
        "lambda_max": max_lambda,
        "ci": ci,
        "cr": cr,
        "is_consistent": bool(cr < 0.10),
    }

@app.post("/api/ahp-calculate")
def calculate_ahp(data: AHPRequest):
    n = len(data.factors)
    if len(data.matrix) != n:
        raise HTTPException(400, "จำนวนแถวของ matrix ไม่ตรงกับจำนวน factors")

    solved = solve_ahp_weights(data.matrix)
    weight_dict = {
        data.factors[i]: round(float(solved["weights"][i]), 4) for i in range(n)
    }

    result = {
        "status": "success",
        "weights": weight_dict,
        "lambda_max": round(solved["lambda_max"], 4),
        "ci": round(solved["ci"], 4),
        "cr": round(solved["cr"], 4),
        "is_consistent": solved["is_consistent"],
    }
    return result

KHONKAEN_BOUNDS = {"west": 101.70, "east": 103.25, "south": 15.55, "north": 17.15}
GRID_WIDTH = 480
GRID_HEIGHT = 400

raw_layers = SessionDict("raw_layers")
uploaded_layers = SessionDict("uploaded_layers")
classification_tables = SessionDict("classification_tables")
last_suitability_result = SessionDict("last_suitability_result")

_BOUNDARY_PATH = os.path.join(os.path.dirname(__file__), "data", "khonkaen_boundary.geojson")
_province_mask_cache = None

def get_province_mask() -> np.ndarray:
    global _province_mask_cache
    if _province_mask_cache is not None:
        return _province_mask_cache

    try:
        from shapely.geometry import shape
        import shapely

        with open(_BOUNDARY_PATH, encoding="utf-8") as f:
            boundary = json.load(f)
        polygon = shape(boundary["geometry"])
        LON, LAT = _grid_lonlat()
        points = shapely.points(LON.ravel(), LAT.ravel())
        _province_mask_cache = shapely.contains(polygon, points).reshape(LON.shape)
    except Exception as e:
        print(f"⚠️ โหลดขอบเขตจังหวัดไม่สำเร็จ (จะแสดงเป็นสี่เหลี่ยมแทนรูปทรงจริง): {e}")
        _province_mask_cache = np.ones((GRID_HEIGHT, GRID_WIDTH), dtype=bool)

    return _province_mask_cache

def _normalize(a: np.ndarray) -> np.ndarray:
    a = a.astype(float)
    rng = a.max() - a.min()
    if rng < 1e-9:
        return np.zeros_like(a)
    return (a - a.min()) / rng

def _grid_lonlat():
    lon = np.linspace(KHONKAEN_BOUNDS["west"], KHONKAEN_BOUNDS["east"], GRID_WIDTH)
    lat = np.linspace(KHONKAEN_BOUNDS["north"], KHONKAEN_BOUNDS["south"], GRID_HEIGHT)
    return np.meshgrid(lon, lat)

def generate_synthetic_layer(factor_name: str) -> np.ndarray:
    seed = zlib.crc32(factor_name.encode("utf-8"))
    rng = np.random.default_rng(seed)
    LON, LAT = _grid_lonlat()
    lon01 = _normalize(LON)
    lat01 = _normalize(LAT)
    base = np.sin(lon01 * 8 + seed % 7) * np.cos(lat01 * 6 + seed % 5)
    noise = rng.normal(0, 0.06, base.shape)
    return _normalize(base + noise)

def apply_classification(raw: np.ndarray, breaks: list[dict]) -> np.ndarray:
    if not breaks:
        return _normalize(raw)

    raw = np.asarray(raw, dtype=float)
    scored = np.full(raw.shape, np.nan, dtype=float)

    for i, b in enumerate(breaks):
        lo, hi, score = float(b["min"]), float(b["max"]), float(b["score"])
        if i == len(breaks) - 1:
            mask = (raw >= lo) & (raw <= hi)
        elif abs(lo - hi) < 1e-12:
            mask = np.isclose(raw, lo)
        else:
            mask = (raw >= lo) & (raw < hi)
        scored = np.where(mask, score, scored)

    min_score = min(float(b["score"]) for b in breaks)
    scored = np.where(np.isnan(scored), min_score, scored)

    max_score = max(float(b["score"]) for b in breaks)
    return scored / max_score if max_score > 0 else np.zeros_like(scored)

def default_classification_breaks(raw: np.ndarray, n_classes: int = 4) -> list[dict]:
    valid = np.asarray(raw, dtype=float)
    valid = valid[np.isfinite(valid)]
    if valid.size == 0:
        raise HTTPException(400, "ไฟล์ไม่มีค่าข้อมูลที่ใช้จำแนกได้")

    uniq = np.unique(valid)
    if np.all(np.isin(uniq, [1, 2, 3, 4])) and len(uniq) <= 4:
        return [
            {"min": 1.0, "max": 1.0, "score": 1.0},
            {"min": 2.0, "max": 2.0, "score": 2.0},
            {"min": 3.0, "max": 3.0, "score": 3.0},
            {"min": 4.0, "max": 4.0, "score": 4.0},
        ]

    lo, hi = float(valid.min()), float(valid.max())
    if hi - lo < 1e-12:
        hi = lo + 1.0
    edges = np.linspace(lo, hi, 5)
    return [
        {"min": round(float(edges[0]), 6), "max": round(float(edges[1]), 6), "score": 1.0},
        {"min": round(float(edges[1]), 6), "max": round(float(edges[2]), 6), "score": 2.0},
        {"min": round(float(edges[2]), 6), "max": round(float(edges[3]), 6), "score": 3.0},
        {"min": round(float(edges[3]), 6), "max": round(float(edges[4]), 6), "score": 4.0},
    ]

def get_layer(factor_name: str) -> np.ndarray:
    if factor_name in classification_tables and factor_name in raw_layers:
        return apply_classification(raw_layers[factor_name], classification_tables[factor_name])
    if factor_name in uploaded_layers:
        return uploaded_layers[factor_name]
    return generate_synthetic_layer(factor_name)

def get_layer_source(factor_name: str) -> str:
    if factor_name in classification_tables and factor_name in raw_layers:
        return "classified"
    if factor_name in uploaded_layers:
        return "uploaded"
    return "synthetic"

def layer_to_rgba(score: np.ndarray) -> np.ndarray:
    r = np.clip(0.85 - score * 0.65, 0, 1)
    g = np.clip(0.90 - score * 0.55, 0, 1)
    b = np.full_like(score, 0.95)
    a = np.full_like(score, 0.55)
    rgba = np.stack([r, g, b, a], axis=-1)
    rgba_u8 = (rgba * 255).astype(np.uint8)
    rgba_u8[~get_province_mask(), 3] = 0
    return rgba_u8

def score_to_rgba(score: np.ndarray) -> np.ndarray:
    score = np.clip((score - 1.0) / 3.0, 0.0, 1.0)
    r = np.clip(2 * (1 - score), 0, 1)
    g = np.clip(2 * score, 0, 1)
    b = np.zeros_like(score)
    a = np.full_like(score, 0.60)
    rgba = np.stack([r, g, b, a], axis=-1)
    rgba_u8 = (rgba * 255).astype(np.uint8)
    rgba_u8[~get_province_mask(), 3] = 0
    return rgba_u8

def array_to_png_base64(rgba: np.ndarray) -> str:
    img = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")

def bounds_list() -> list[float]:
    b = KHONKAEN_BOUNDS
    return [b["west"], b["south"], b["east"], b["north"]]

@app.get("/api/layer-preview")
def layer_preview(factor: str):
    layer = get_layer(factor)
    return {
        "status": "success",
        "factor": factor,
        "source": get_layer_source(factor),
        "has_raw": factor in raw_layers,
        "preview_image_base64": array_to_png_base64(layer_to_rgba(layer)),
        "bounds": bounds_list(),
    }

@app.post("/api/upload-layer")
async def upload_layer(factor: str = Form(...), file: UploadFile = File(...)):
    try:
        filename = (file.filename or "").lower()
        content = await file.read()
        if not content:
            raise HTTPException(400, "ไฟล์ที่อัปโหลดว่างเปล่า")

        try:
            if filename.endswith((".tif", ".tiff")):
                raw, coverage_pct, meta = _read_geotiff_to_grid(content)
            elif filename.endswith((".geojson", ".json")):
                raw = _read_geojson_to_grid(content)
                coverage_pct = 100.0
                meta = {"crs": "EPSG:4326", "dtype": "geometry-distance", "nodata": None}
            elif filename.endswith(".zip"):
                raw, coverage_pct, meta = _read_zip_to_grid(content)
            else:
                raise HTTPException(400, "รองรับ .tif/.tiff, .geojson/.json หรือ ZIP ของ Shapefile ที่มี .shp/.shx/.dbf")
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(400, f"อ่านไฟล์ไม่สำเร็จ: {type(exc).__name__}: {exc}") from exc

        valid = raw[np.isfinite(raw)]
        if valid.size == 0:
            raise HTTPException(400, "ไฟล์ไม่มีค่าข้อมูลที่ใช้วิเคราะห์ได้")

        raw_layers[factor] = raw.astype(np.float32)

        finite_upload = raw_layers[factor][np.isfinite(raw_layers[factor])]
        unique_upload = np.unique(finite_upload)
        allowed_scores = np.isin(unique_upload, [1, 2, 3, 4])
        if not np.all(allowed_scores):
            bad_values = unique_upload[~allowed_scores][:10].tolist()
            raise HTTPException(400, f"ไฟล์ {factor} ต้องเป็น Raster คะแนน 1-4 เท่านั้น พบค่าอื่น เช่น {bad_values}")

        uploaded_layers[factor] = raw_layers[factor].copy()
        classification_tables.pop(factor, None)

        preview = array_to_png_base64(layer_to_rgba(uploaded_layers[factor]))

        res = {
            "status": "success",
            "factor": factor,
            "source": "uploaded",
            "raw_min": round(float(valid.min()), 4),
            "raw_max": round(float(valid.max()), 4),
            "coverage_percent": round(float(coverage_pct), 1),
            "crs": meta.get("crs"),
            "dtype": meta.get("dtype"),
            "nodata": meta.get("nodata"),
            "preview_image_base64": preview,
            "bounds": bounds_list(),
        }

        # ลบไฟล์ดิบที่อ่านเข้า memory ทันที
        del content, raw
        gc.collect()

        return res
    finally:
        await file.close()
        gc.collect()

def _read_geotiff_to_grid(content: bytes) -> tuple[np.ndarray, float, dict]:
    try:
        import rasterio
        from rasterio.io import MemoryFile
        from rasterio.transform import from_bounds
        from rasterio.warp import Resampling, reproject
    except ImportError as exc:
        raise HTTPException(500, "ต้องติดตั้งไลบรารี rasterio ก่อน") from exc

    dst_transform = from_bounds(
        KHONKAEN_BOUNDS["west"], KHONKAEN_BOUNDS["south"],
        KHONKAEN_BOUNDS["east"], KHONKAEN_BOUNDS["north"],
        GRID_WIDTH, GRID_HEIGHT,
    )
    destination = np.full((GRID_HEIGHT, GRID_WIDTH), np.nan, dtype=np.float32)

    with MemoryFile(content) as memfile:
        with memfile.open() as src:
            if src.count < 1:
                raise HTTPException(400, "GeoTIFF ไม่มี band ข้อมูล")
            if src.crs is None:
                raise HTTPException(400, "GeoTIFF ไม่มีระบบพิกัด (CRS) ในไฟล์ กรุณา Define Projection/Project แล้วบันทึก GeoTIFF ใหม่")

            src_band = src.read(1, masked=True, out_dtype="float32")
            data = src_band.filled(np.nan).astype(np.float32, copy=False)
            src_nodata = np.nan

            if src.nodata is None and np.issubdtype(src.dtypes[0], np.integer):
                finite = data[np.isfinite(data)]
                if finite.size:
                    vmax = float(np.max(finite))
                    max_count = int(np.sum(finite == vmax))
                    max_ratio = max_count / finite.size
                    if vmax in (127.0, 255.0, 65535.0) and max_ratio > 0.20:
                        data[data == vmax] = np.nan

            reproject(
                source=data,
                destination=destination,
                src_transform=src.transform,
                src_crs=src.crs,
                dst_transform=dst_transform,
                dst_crs="EPSG:4326",
                resampling=Resampling.nearest,
                src_nodata=src_nodata,
                dst_nodata=np.nan,
            )

            crs_text = src.crs.to_string()
            dtype = src.dtypes[0]
            nodata = src.nodata

    valid_mask = np.isfinite(destination)
    coverage_pct = float(valid_mask.mean() * 100)
    if not valid_mask.any():
        raise HTTPException(400, "GeoTIFF ไม่ทับซ้อนกับกรอบพื้นที่จังหวัดขอนแก่นที่ระบบกำหนด หรือพิกัดไม่ถูกต้อง")

    valid_values = destination[valid_mask]
    fill_value = float(np.min(valid_values))
    destination = np.where(valid_mask, destination, fill_value).astype(np.float32)

    return destination, coverage_pct, {"crs": crs_text, "dtype": dtype, "nodata": nodata}

def _read_zip_to_grid(content: bytes) -> tuple[np.ndarray, float, dict]:
    with tempfile.TemporaryDirectory() as tmpdir:
        zip_path = os.path.join(tmpdir, "upload.zip")
        with open(zip_path, "wb") as f:
            f.write(content)
        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                bad = zf.testzip()
                if bad:
                    raise HTTPException(400, f"ZIP เสียหายหรืออ่านสมาชิกไม่ได้: {bad}")
                zf.extractall(tmpdir)
        except zipfile.BadZipFile as exc:
            raise HTTPException(400, "ไฟล์ ZIP ไม่ถูกต้องหรือเสียหาย") from exc

        shp_files = []
        tif_files = []
        for dirpath, _, files in os.walk(tmpdir):
            for name in files:
                low = name.lower()
                full = os.path.join(dirpath, name)
                if low.endswith(".shp"):
                    shp_files.append(full)
                elif low.endswith((".tif", ".tiff")):
                    tif_files.append(full)

        if shp_files:
            return _read_shapefile_path_to_grid(shp_files[0])

        if len(tif_files) == 1:
            with open(tif_files[0], "rb") as f:
                return _read_geotiff_to_grid(f.read())

        if len(tif_files) > 1:
            names = ", ".join(os.path.basename(x) for x in tif_files[:6])
            more = " ..." if len(tif_files) > 6 else ""
            raise HTTPException(400, f"ZIP นี้มี GeoTIFF {len(tif_files)} ไฟล์ ({names}{more}) ระบบรับ 1 ปัจจัยต่อ 1 การอัปโหลด กรุณาอัปโหลด .tif ทีละไฟล์")

        raise HTTPException(400, "ไม่พบ .shp หรือ .tif/.tiff ใน ZIP")

def _read_geojson_to_grid(content: bytes) -> np.ndarray:
    try:
        from shapely.geometry import shape
        from shapely.ops import unary_union
        import shapely
    except ImportError as exc:
        raise HTTPException(500, "ต้องติดตั้งไลบรารี shapely ก่อน") from exc

    try:
        geojson_data = json.loads(content)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, "ไฟล์ GeoJSON ไม่ถูกต้อง (parse ไม่ผ่าน)") from exc

    features = geojson_data.get("features", [geojson_data])
    geoms = [shape(f["geometry"]) for f in features if f.get("geometry")]
    if not geoms:
        raise HTTPException(400, "ไม่พบรูปทรง (geometry) ในไฟล์ GeoJSON")

    merged = unary_union(geoms).simplify(0.005, preserve_topology=False)
    LON, LAT = _grid_lonlat()
    points = shapely.points(LON.ravel(), LAT.ravel())
    distances_deg = shapely.distance(points, merged).reshape(LON.shape)
    raw = (distances_deg * 111.32).astype(np.float32)

    del points, geoms, merged, geojson_data
    gc.collect()

    return raw

def _read_shapefile_path_to_grid(shp_path: str) -> tuple[np.ndarray, float, dict]:
    try:
        import geopandas as gpd
        import shapely
        from shapely.ops import unary_union
    except ImportError as exc:
        raise HTTPException(500, "ต้องติดตั้งไลบรารี geopandas ก่อน (pip install geopandas)") from exc

    sidecar_dir = os.path.dirname(shp_path)
    base = os.path.splitext(shp_path)[0]
    missing = [ext for ext in (".shx", ".dbf") if not os.path.exists(base + ext)]
    if missing:
        raise HTTPException(400, f"Shapefile ขาดไฟล์ประกอบ: {', '.join(missing)}")

    gdf = gpd.read_file(shp_path)
    if gdf.empty:
        raise HTTPException(400, "Shapefile ไม่มีข้อมูล")
    if gdf.crs is None:
        raise HTTPException(400, "Shapefile ไม่มี CRS กรุณา Define Projection ก่อนบีบอัดเป็น ZIP")
    gdf = gdf.to_crs(epsg=4326)

    geoms = gdf.geometry.dropna().tolist()
    if not geoms:
        raise HTTPException(400, "ไฟล์ Shapefile ไม่มีข้อมูลรูปทรง (Geometry)")

  # Simplify รูปทรงก่อนคำนวณ ช่วยลดการใช้ RAM ลงกว่า 90%
    merged = unary_union(geoms).simplify(0.005, preserve_topology=False)

    LON, LAT = _grid_lonlat()
    points = shapely.points(LON.ravel(), LAT.ravel())
    distances_deg = shapely.distance(points, merged).reshape(LON.shape)
    raw = (distances_deg * 111.32).astype(np.float32)

    # บังคับคืน RAM ทันที
    del points, geoms, merged, gdf
    gc.collect()
    
    return raw, 100.0, {"crs": "EPSG:4326", "dtype": "geometry-distance", "nodata": None}

class ClassBreak(BaseModel):
    min: float
    max: float
    score: float

class ClassificationRequest(BaseModel):
    factor: str
    breaks: list[ClassBreak]

    @field_validator("breaks")
    @classmethod
    def validate_research_classes(cls, v):
        if len(v) != 4:
            raise ValueError("งานวิจัยกำหนด 4 ระดับเท่านั้น: 1=N, 2=S3, 3=S2, 4=S1")
        scores = sorted(int(round(b.score)) for b in v)
        if scores != [1, 2, 3, 4]:
            raise ValueError("คะแนนต้องมีครบ 1, 2, 3, 4 และใช้แต่ละคะแนนได้ครั้งเดียว")
        for b in v:
            if b.min > b.max:
                raise ValueError("ค่า min ต้องไม่มากกว่า max")
        return v

@app.get("/api/layer-classification")
def get_layer_classification(factor: str):
    if factor not in raw_layers:
        raise HTTPException(400, "ปัจจัยนี้ยังไม่มีไฟล์ข้อมูลจริง กรุณาอัปโหลดไฟล์ก่อน")
    raw = raw_layers[factor]
    is_saved = factor in classification_tables
    breaks = classification_tables[factor] if is_saved else default_classification_breaks(raw)

    valid = raw[np.isfinite(raw)]
    uniq = np.unique(valid)
    is_score_raster = bool(valid.size and np.all(np.isin(uniq, [1, 2, 3, 4])) and len(uniq) <= 4)
    return {
        "status": "success",
        "factor": factor,
        "is_saved": is_saved,
        "raw_min": round(float(valid.min()), 4),
        "raw_max": round(float(valid.max()), 4),
        "unique_values_sample": [float(x) for x in uniq[:20]],
        "is_score_raster": is_score_raster,
        "breaks": breaks,
    }

@app.post("/api/set-classification")
def set_classification(data: ClassificationRequest):
    if data.factor not in raw_layers:
        raise HTTPException(400, "ปัจจัยนี้ยังไม่มีไฟล์ข้อมูลจริง กรุณาอัปโหลดไฟล์ก่อนตั้งเกณฑ์คะแนน")

    breaks = [b.model_dump() for b in data.breaks]
    ordered = sorted(breaks, key=lambda x: (x["min"], x["max"]))
    for prev, cur in zip(ordered, ordered[1:]):
        if cur["min"] < prev["max"] and not (abs(cur["min"] - prev["max"]) < 1e-12):
            raise HTTPException(400, "ช่วงเกณฑ์คะแนนทับซ้อนกัน กรุณาแก้ค่า min/max ให้ไม่ทับกัน")
    classification_tables[data.factor] = breaks
    classified = apply_classification(raw_layers[data.factor], breaks)

    return {
        "status": "success",
        "factor": data.factor,
        "source": "classified",
        "preview_image_base64": array_to_png_base64(layer_to_rgba(classified)),
        "bounds": bounds_list(),
    }

@app.post("/api/reset-layers")
def reset_layers(session_id: str | None = None):
    sid = (session_id or get_session_id())[:128]
    cleared = clear_session(sid)
    return {
        "status": "success",
        "cleared": cleared,
        "message": "ล้างข้อมูลของ Session นี้แล้ว" if cleared else "ไม่พบข้อมูลของ Session นี้"
    }

@app.get("/api/layers-status")
def layers_status():
    return {"status": "success", "factors_with_raw_data": list(raw_layers.keys())}


@app.get("/api/suitability-value")
def suitability_value(lon: float, lat: float):
    if last_suitability_result.get("array") is None:
        raise HTTPException(400, "ยังไม่มีผลลัพธ์ กรุณากดคำนวณแผนที่ก่อน")

    arr = last_suitability_result["array"]
    col_frac = (lon - KHONKAEN_BOUNDS["west"]) / (KHONKAEN_BOUNDS["east"] - KHONKAEN_BOUNDS["west"])
    row_frac = (KHONKAEN_BOUNDS["north"] - lat) / (KHONKAEN_BOUNDS["north"] - KHONKAEN_BOUNDS["south"])
    col = max(0, min(GRID_WIDTH - 1, int(round(col_frac * (GRID_WIDTH - 1)))))
    row = max(0, min(GRID_HEIGHT - 1, int(round(row_frac * (GRID_HEIGHT - 1)))))

    score = float(arr[row, col])
    if score >= 3.25:
        label = "S1"
    elif score >= 2.50:
        label = "S2"
    elif score >= 1.75:
        label = "S3"
    else:
        label = "N"

    return {"status": "success", "lon": round(lon, 5), "lat": round(lat, 5),
            "score": round(score, 4), "label": label}

class SuitabilityRequest(BaseModel):
    weights: dict[str, float]

@app.post("/api/suitability")
def calculate_suitability(data: SuitabilityRequest):
    if not data.weights:
        raise HTTPException(400, "ไม่มีข้อมูลน้ำหนัก (weights)")

    required_factors = ["Soil", "Water", "Rainfall", "Drought", "Flood", "Road"]
    missing = [f for f in required_factors if f not in raw_layers]
    if missing:
        raise HTTPException(400, "ยังไม่มีไฟล์ข้อมูลจริงของ: " + ", ".join(missing))

    weight_sum = sum(float(data.weights.get(f, 0.0)) for f in required_factors)
    if weight_sum <= 0:
        raise HTTPException(400, "ผลรวมน้ำหนัก AHP ต้องมากกว่า 0")

    suitability = np.zeros((GRID_HEIGHT, GRID_WIDTH), dtype=np.float32)
    layer_sources = {}
    for factor in required_factors:
        weight = float(data.weights.get(factor, 0.0)) / weight_sum
        layer = get_layer(factor).astype(np.float32)
        suitability += layer * weight
        layer_sources[factor] = get_layer_source(factor)

    province_mask = get_province_mask()
    valid = suitability[province_mask]
    if valid.size == 0:
        raise HTTPException(500, "ไม่พบเซลล์ภายในขอบเขตจังหวัดขอนแก่น")
        
    suitability[~province_mask] = np.nan
    last_suitability_result["array"] = suitability
    image_base64 = array_to_png_base64(score_to_rgba(suitability))

    valid_scores = suitability[province_mask]
    valid_scores = valid_scores[np.isfinite(valid_scores)]

    pct_s1 = float(np.mean((valid_scores >= 3.25) & (valid_scores <= 4.00)) * 100)
    pct_s2 = float(np.mean((valid_scores >= 2.50) & (valid_scores < 3.25)) * 100)
    pct_s3 = float(np.mean((valid_scores >= 1.75) & (valid_scores < 2.50)) * 100)
    pct_n  = float(np.mean((valid_scores >= 1.00) & (valid_scores < 1.75)) * 100)

    n_classified = sum(1 for s in layer_sources.values() if s == "classified")
    n_uploaded = sum(1 for s in layer_sources.values() if s == "uploaded")
    note = f"ใช้ข้อมูลจริงครบ {n_uploaded}/6 ปัจจัย | WLC แบ่ง 4 ระดับ: N 1.00-<1.75, S3 1.75-<2.50, S2 2.50-<3.25, S1 3.25-4.00"

    return {
        "status": "success",
        "image_base64": image_base64,
        "bounds": bounds_list(),
        "layer_sources": layer_sources,
        "stats": {
            "mean_score": round(float(valid_scores.mean()), 4),
            "min_score": round(float(valid_scores.min()), 4),
            "max_score": round(float(valid_scores.max()), 4),
            "percent_s1": round(pct_s1, 2),
            "percent_s2": round(pct_s2, 2),
            "percent_s3": round(pct_s3, 2),
            "percent_n": round(pct_n, 2),
            "total_percent": round(pct_s1 + pct_s2 + pct_s3 + pct_n, 2),
        },
        "note": note,
    }

# API สำหรับดาวน์โหลดแผนที่ผลลัพธ์เป็นไฟล์ต่างๆ
@app.get("/api/download")
def download_result(type: str, session_id: str | None = None):
    sid = (session_id or get_session_id())[:128]
    store = session_store.get(sid)
    if store is None or store.get("last_suitability_result", {}).get("array") is None:
        raise HTTPException(400, "ยังไม่มีผลลัพธ์ของ Session นี้ กรุณากดคำนวณแผนที่ก่อน")

    suit_array = store["last_suitability_result"]["array"]

    # =========================================================================
    # !! หมายเหตุ: โค้ดส่วนนี้ (บรรทัดด้านล่างเป็นต้นไป) ถูกตัดขาดในข้อความต้นฉบับที่คุณส่งมา
    # ถ้าของเดิมมีโค้ดส่วนแปลงไฟล์/ดาวน์โหลดต่อจากนี้ อย่าลืมนำมาต่อด้วยนะครับ
    # =========================================================================
