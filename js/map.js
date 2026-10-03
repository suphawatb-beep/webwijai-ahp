// ======================================================
// สร้างแผนที่ (MapLibre GL JS) - Modern Style
// ======================================================

document.addEventListener("DOMContentLoaded", function () {

    const map = new maplibregl.Map({
        container: "map",
        // ใช้ OpenFreeMap แทนการเรียก tile.openstreetmap.org โดยตรง
        // เพื่อไม่ให้เกิดหน้า "Access blocked" จากนโยบาย tile server
        style: "https://tiles.openfreemap.org/styles/liberty",
        center: [102.835, 16.432],
        zoom: 9,
        minZoom: 7,
        maxZoom: 18
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }));
    window.map = map;

    // ไม่มีหมุด/รัศมีโรงงาน เพราะโรงงานไม่ใช่ปัจจัยของงานวิจัยฉบับนี้
});

// ======================================================
// จัดการชั้นข้อมูลรายปัจจัย (Layer toggle) และ WLC
// ======================================================
function factorLayerId(factor) {
    const safe = factor.replace(/[^a-zA-Z0-9ก-๙_-]/g, "_");
    return { src: `factor-src-${safe}`, layer: `factor-layer-${safe}` };
}

function addFactorLayer(factor, imageBase64, bounds) {
    if (!window.map) return;
    const [west, south, east, north] = bounds;
    const coordinates = [[west, north], [east, north], [east, south], [west, south]];
    const dataUrl = `data:image/png;base64,${imageBase64}`;
    const { src, layer } = factorLayerId(factor);

    const applyLayer = () => {
        if (window.map.getLayer(layer)) window.map.removeLayer(layer);
        if (window.map.getSource(src)) window.map.removeSource(src);
        window.map.addSource(src, { type: "image", url: dataUrl, coordinates });
        window.map.addLayer({ id: layer, type: "raster", source: src, paint: { "raster-opacity": 0.65, "raster-resampling": "nearest" } });
    };
    if (window.map.isStyleLoaded()) applyLayer(); else window.map.once("load", applyLayer);
}

function setFactorLayerVisible(factor, visible) {
    if (!window.map) return;
    const { layer } = factorLayerId(factor);
    if (window.map.getLayer(layer)) window.map.setLayoutProperty(layer, "visibility", visible ? "visible" : "none");
}

function removeFactorLayer(factor) {
    if (!window.map) return;
    const { src, layer } = factorLayerId(factor);
    if (window.map.getLayer(layer)) window.map.removeLayer(layer);
    if (window.map.getSource(src)) window.map.removeSource(src);
}

function factorLayerExists(factor) {
    if (!window.map) return false;
    return !!window.map.getLayer(factorLayerId(factor).layer);
}

function addSuitabilityLayer(imageBase64, bounds) {
    if (!window.map) return;
    const [west, south, east, north] = bounds;
    const coordinates = [[west, north], [east, north], [east, south], [west, south]];
    const dataUrl = `data:image/png;base64,${imageBase64}`;

    const applyLayer = () => {
        if (window.map.getLayer("suitability-layer")) window.map.removeLayer("suitability-layer");
        if (window.map.getSource("suitability-src")) window.map.removeSource("suitability-src");
        window.map.addSource("suitability-src", { type: "image", url: dataUrl, coordinates: coordinates });
        window.map.addLayer({ id: "suitability-layer", type: "raster", source: "suitability-src", paint: { "raster-opacity": 0.8, "raster-resampling": "nearest" } });

        if (!window._suitabilityClickBound) {
            window._suitabilityClickBound = true;
            window.map.on("click", (e) => {
                if (!window.map.getLayer("suitability-layer")) return;
                const features = window.map.queryRenderedFeatures(e.point, { layers: ["suitability-layer"] });
                if (features.length === 0) return;
                if (typeof window.onSuitabilityMapClick === "function") {
                    window.onSuitabilityMapClick(e.lngLat.lng, e.lngLat.lat);
                }
            });
            window.map.on("mousemove", (e) => {
                if (!window.map.getLayer("suitability-layer")) { window.map.getCanvas().style.cursor = ""; return; }
                const features = window.map.queryRenderedFeatures(e.point, { layers: ["suitability-layer"] });
                window.map.getCanvas().style.cursor = features.length > 0 ? "pointer" : "";
            });
        }
        window.map.fitBounds([[west, south], [east, north]], { padding: 30, duration: 800 });
    };
    if (window.map.isStyleLoaded()) applyLayer(); else window.map.once("load", applyLayer);
}

function removeSuitabilityLayer() {
    if (!window.map) return;
    if (window.map.getLayer("suitability-layer")) window.map.removeLayer("suitability-layer");
    if (window.map.getSource("suitability-src")) window.map.removeSource("suitability-src");
}