// ======================================================
// สร้างแผนที่ (MapLibre GL JS) - Modern Style
// ======================================================

document.addEventListener("DOMContentLoaded", function () {

    const map = new maplibregl.Map({
        container: "map",
        style: {
            version: 8,
            sources: {
                osm: {
                    type: "raster",
                    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                    tileSize: 256,
                    attribution: "© OpenStreetMap Contributors"
                }
            },
            layers: [{ id: "osm", type: "raster", source: "osm" }]
        },
        center: [102.835, 16.432], 
        zoom: 9,
        minZoom: 7,
        maxZoom: 18
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }));
    window.map = map;

    let mitrMarker = null;
    let kslMarker = null;

    // ==========================================
    // คลาสสร้างปุ่มควบคุม (Modern Toggle Switch)
    // ==========================================
    class ModernFactoryToggle {
        onAdd(map) {
            this._map = map;
            
            // 1. ฝัง CSS สำหรับความสวยงามแบบ Modern
            const style = document.createElement('style');
            style.innerHTML = `
                .modern-panel {
                    background: rgba(255, 255, 255, 0.85);
                    backdrop-filter: blur(10px);
                    padding: 12px 18px;
                    border-radius: 12px;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.1);
                    display: flex;
                    align-items: center;
                    gap: 15px;
                    font-family: 'Sarabun', 'Segoe UI', Tahoma, sans-serif;
                    border: 1px solid rgba(255,255,255,0.4);
                }
                .toggle-text {
                    font-size: 14px;
                    font-weight: 600;
                    color: #2c3e50;
                }
                .switch {
                    position: relative;
                    display: inline-block;
                    width: 44px;
                    height: 24px;
                    margin: 0;
                }
                .switch input { opacity: 0; width: 0; height: 0; }
                .slider {
                    position: absolute;
                    cursor: pointer;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background-color: #cbd5e1;
                    transition: .4s;
                    border-radius: 34px;
                }
                .slider:before {
                    position: absolute;
                    content: "";
                    height: 18px; width: 18px;
                    left: 3px; bottom: 3px;
                    background-color: white;
                    transition: .4s;
                    border-radius: 50%;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
                }
                input:checked + .slider { background-color: #10b981; }
                input:checked + .slider:before { transform: translateX(20px); }
            `;
            document.head.appendChild(style);

            // 2. สร้าง Container แบบใหม่
            this._container = document.createElement('div');
            this._container.className = 'maplibregl-ctrl modern-panel';
            this._container.innerHTML = `
                <span class="toggle-text">แสดงรัศมีโรงงาน (50 กม.)</span>
                <label class="switch">
                    <input type="checkbox" id="toggle-factories" checked>
                    <span class="slider"></span>
                </label>
            `;

            // 3. ดักจับเหตุการณ์
            const checkbox = this._container.querySelector('#toggle-factories');
            checkbox.addEventListener('change', (e) => {
                const isVisible = e.target.checked;
                const displayStyle = isVisible ? 'block' : 'none';
                const visibilityProp = isVisible ? 'visible' : 'none';

                if (mitrMarker) mitrMarker.getElement().style.display = displayStyle;
                if (kslMarker) kslMarker.getElement().style.display = displayStyle;
                if (map.getLayer('buffer-mitr-layer')) map.setLayoutProperty('buffer-mitr-layer', 'visibility', visibilityProp);
                if (map.getLayer('buffer-ksl-layer')) map.setLayoutProperty('buffer-ksl-layer', 'visibility', visibilityProp);
            });

            return this._container;
        }
        onRemove() {
            this._container.parentNode.removeChild(this._container);
            this._map = undefined;
        }
    }

    map.on("load", () => {
        // เพิ่ม Modern Control ลงบนแผนที่
        map.addControl(new ModernFactoryToggle(), 'top-right');

        function createPopup(htmlContent) {
            return new maplibregl.Popup({ offset: 25, closeButton: false }).setHTML(htmlContent);
        }

        // ==========================================
        // ดีไซน์ Popup แบบ Modern Card
        // ==========================================
        
        // 1. โรงงาน Mitr Phu Wiang Sugar
        mitrMarker = new maplibregl.Marker({ color: "#e11d48" })
            .setLngLat([102.4284022, 16.48810877]) 
            .setPopup(createPopup(`
                <div style="text-align: center; font-family: 'Sarabun', sans-serif; min-width: 180px; padding: 5px;">
                    <div style="background: #e11d48; color: white; padding: 4px 12px; border-radius: 20px; font-weight: bold; font-size: 13px; display: inline-block;">โรงงานน้ำตาลมิตรภูเวียง</div>
                    <div style="margin-top: 6px; color: #64748b; font-size: 12px;">(Mitr Phu Wiang Sugar)</div>
                    <div style="margin: 10px 0; border-top: 1px dashed #cbd5e1;"></div>
                    <div style="color: #0f172a; font-weight: 600; font-size: 14px;">รัศมีครอบคลุม: 50 กิโลเมตร</div>
                    <div style="color: #64748b; font-size: 12px;">ใช้ประเมินระยะทางขนส่งที่คุ้มค่า</div>
                </div>
            `))
            .addTo(map);

        // 2. โรงงาน Khon Kaen Company
        kslMarker = new maplibregl.Marker({ color: "#2563eb" })
            .setLngLat([102.8399618, 16.73162708])
            .setPopup(createPopup(`
                <div style="text-align: center; font-family: 'Sarabun', sans-serif; min-width: 180px; padding: 5px;">
                    <div style="background: #2563eb; color: white; padding: 4px 12px; border-radius: 20px; font-weight: bold; font-size: 13px; display: inline-block;">โรงงานน้ำตาลขอนแก่น</div>
                    <div style="margin-top: 6px; color: #64748b; font-size: 12px;">(Khon Kaen Company / KSL)</div>
                    <div style="margin: 10px 0; border-top: 1px dashed #cbd5e1;"></div>
                    <div style="color: #0f172a; font-weight: 600; font-size: 14px;">รัศมีครอบคลุม: 50 กิโลเมตร</div>
                    <div style="color: #64748b; font-size: 12px;">ใช้ประเมินระยะทางขนส่งที่คุ้มค่า</div>
                </div>
            `))
            .addTo(map);

        function createGeoJSONCircle(center, radiusInKm, points = 64) {
            const coords = { longitude: center[0], latitude: center[1] };
            const distanceX = radiusInKm / (111.320 * Math.cos(coords.latitude * Math.PI / 180));
            const distanceY = radiusInKm / 110.574;
            const ret = [];
            for (let i = 0; i < points; i++) {
                const theta = (i / points) * (2 * Math.PI);
                ret.push([coords.longitude + distanceX * Math.cos(theta), coords.latitude + distanceY * Math.sin(theta)]);
            }
            ret.push(ret[0]); 
            return { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [ret] } }] };
        }

        // เพิ่มเลเยอร์วงกลม
        map.addSource('buffer-mitr', { type: 'geojson', data: createGeoJSONCircle([102.4284022, 16.48810877], 50) });
        map.addLayer({ id: 'buffer-mitr-layer', type: 'fill', source: 'buffer-mitr', paint: { 'fill-color': '#e11d48', 'fill-opacity': 0.08 }, layout: { 'visibility': 'visible' } });

        map.addSource('buffer-ksl', { type: 'geojson', data: createGeoJSONCircle([102.8399618, 16.73162708], 50) });
        map.addLayer({ id: 'buffer-ksl-layer', type: 'fill', source: 'buffer-ksl', paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.08 }, layout: { 'visibility': 'visible' } });
    });
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