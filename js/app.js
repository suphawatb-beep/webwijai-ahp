const BACKEND_URL = "https://webwijai-ahp.onrender.com";

function showToast(message, type = "info", duration = 4500) {
    const container = document.getElementById("toastContainer");
    if (!container) { window.alert(message); return; }
    const icons = { success: "✅", error: "⛔", warning: "⚠️", info: "ℹ️" };
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <span class="toast-msg">${message.replace(/\n/g, "<br>")}</span>
        <button type="button" class="toast-close" title="ปิด">✕</button>
    `;
    container.appendChild(toast);
    const remove = () => { toast.classList.add("toast-out"); setTimeout(() => toast.remove(), 200); };
    toast.querySelector(".toast-close").onclick = remove;
    if (duration > 0) setTimeout(remove, duration);
}

let criteria = ["DEM", "Slope", "Soil", "Rainfall", "Road", "Water", "DistanceToFactory"];
let layerState = {};
let classifyingFactor = null;
let lastAhpWeights = null;

function getLayerState(factor) {
    if (!layerState[factor]) {
        layerState[factor] = { visible: false, source: "synthetic", hasRaw: false };
    }
    return layerState[factor];
}

function renderDataReadinessBadge() {
    const badge = document.getElementById("dataReadinessBadge");
    if (!badge) return;

    const readyCount = criteria.filter(c => getLayerState(c).hasRaw).length;
    const total = criteria.length;

    if (total === 0) {
        badge.textContent = "";
        return;
    }

    if (readyCount === total) {
        badge.className = "readiness-badge all-ready";
        badge.textContent = `✅ มีข้อมูลจริงครบแล้ว ${readyCount} / ${total} ปัจจัย`;
    } else {
        badge.className = "readiness-badge";
        badge.textContent = `⚠️ มีข้อมูลจริงแล้ว ${readyCount} / ${total} ปัจจัย (ที่เหลือใช้ข้อมูลจำลองชั่วคราว)`;
    }
}

function renderCriteriaList() {
    renderDataReadinessBadge();

    const list = document.getElementById("criteriaList");
    list.innerHTML = criteria.map((c, idx) => {
        const state = getLayerState(c);
        let badgeClass = "source-badge";
        let badgeText = "จำลอง";
        if (state.source === "uploaded") { badgeClass = "source-badge uploaded"; badgeText = "ไฟล์จริง"; }
        if (state.source === "classified") { badgeClass = "source-badge classified"; badgeText = "จัดกลุ่มแล้ว"; }
        const rowClass = state.visible ? "criteria-row layer-visible" : "criteria-row";
        const classifyDisabled = state.hasRaw ? "" : "disabled";
        const classifyTitle = state.hasRaw ? "กำหนดเกณฑ์คะแนนของปัจจัยนี้" : "ต้องแนบไฟล์จริง (📎) ก่อนจึงกำหนดเกณฑ์คะแนนได้";

        return `
        <div class="${rowClass}" data-factor="${c}">
            <input type="checkbox" class="layer-toggle" data-idx="${idx}" ${state.visible ? "checked" : ""} title="แสดง/ซ่อนชั้นข้อมูลนี้">
            <span class="criteria-name" title="${c}">${c}</span>
            <span class="${badgeClass}">${badgeText}</span>
            <button type="button" class="icon-btn attach-btn" data-idx="${idx}" title="แนบไฟล์ .tif หรือไฟล์ .zip (Shapefile)">📎</button>
            <input type="file" class="hidden-file-input" data-idx="${idx}" accept=".tif,.tiff,.geojson,.json,.zip" style="display:none;">
            <button type="button" class="icon-btn classify-btn" data-idx="${idx}" ${classifyDisabled} title="${classifyTitle}">🎯</button>
            <button type="button" class="icon-btn remove-btn" data-idx="${idx}" title="ลบปัจจัยนี้">✕</button>
        </div>`;
    }).join("");

    list.querySelectorAll(".layer-toggle").forEach(cb => {
        cb.onchange = () => onToggleLayer(criteria[parseInt(cb.dataset.idx, 10)], cb.checked);
    });

    list.querySelectorAll(".attach-btn").forEach(btn => {
        btn.onclick = () => {
            const idx = parseInt(btn.dataset.idx, 10);
            list.querySelector(`.hidden-file-input[data-idx="${idx}"]`).click();
        };
    });

    list.querySelectorAll(".hidden-file-input").forEach(input => {
        input.onchange = () => {
            const idx = parseInt(input.dataset.idx, 10);
            const file = input.files[0];
            if (file) onUploadLayerFile(criteria[idx], file);
        };
    });

    list.querySelectorAll(".classify-btn").forEach(btn => {
        btn.onclick = () => {
            if (btn.disabled) return;
            const idx = parseInt(btn.dataset.idx, 10);
            openClassifyModal(criteria[idx]);
        };
    });

    list.querySelectorAll(".remove-btn").forEach(btn => {
        btn.onclick = () => {
            const idx = parseInt(btn.dataset.idx, 10);
            const factor = criteria[idx];
            removeFactorLayer(factor);
            delete layerState[factor];
            criteria.splice(idx, 1);
            renderCriteriaList();
        };
    });
}

document.getElementById("addCriteria").onclick = function () {
    const input = document.getElementById("newCriteriaInput");
    const name = input.value.trim();
    if (!name) return;
    if (criteria.includes(name)) {
        showToast("มีปัจจัยชื่อนี้อยู่แล้ว", "warning");
        return;
    }
    criteria.push(name);
    input.value = "";
    renderCriteriaList();
};

document.getElementById("newCriteriaInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("addCriteria").click();
});

renderCriteriaList();

// ตรวจสอบตอนโหลดหน้าว่ามีปัจจัยไหนมีข้อมูลจริงอยู่แล้วในระบบบ้าง (เช่น
// พิกัดโรงงานน้ำตาลที่โหลดไว้ล่วงหน้าตอนเปิด backend)
(async function checkPreloadedLayers() {
    try {
        const res = await fetch(`${BACKEND_URL}/api/layers-status`);
        if (!res.ok) return;
        const data = await res.json();
        const factorsReady = data.factors_with_raw_data || [];
        let changed = false;
        factorsReady.forEach(factor => {
            if (criteria.includes(factor)) {
                getLayerState(factor).hasRaw = true;
                getLayerState(factor).source = "uploaded";
                changed = true;
            }
        });
        if (changed) renderCriteriaList();
    } catch (err) {
        // backend ยังไม่เปิด ก็แค่ข้ามไป
    }
})();

// คลิกบนแผนที่เพื่อดูคะแนนความเหมาะสม ณ จุดนั้น
window.onSuitabilityMapClick = async function (lon, lat) {
    try {
        const res = await fetch(`${BACKEND_URL}/api/suitability-value?lon=${lon}&lat=${lat}`);
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const colors = { "เหมาะสมมาก": "#2e7d32", "เหมาะสมปานกลาง": "#f57f17", "เหมาะสมน้อย": "#c62828" };
        const color = colors[data.label] || "#555";
        new maplibregl.Popup({ offset: 10 })
            .setLngLat([lon, lat])
            .setHTML(`
                <div style="font-family:'Prompt',sans-serif; text-align:center; min-width:150px; padding:4px;">
                    <div style="font-size:12px; color:#666; margin-bottom:4px;">คะแนนความเหมาะสม</div>
                    <div style="font-size:22px; font-weight:700; color:${color};">${data.score}</div>
                    <div style="font-size:13px; font-weight:600; color:${color}; margin-top:2px;">${data.label}</div>
                    <div style="font-size:10px; color:#999; margin-top:6px;">${data.lat}, ${data.lon}</div>
                </div>
            `)
            .addTo(window.map);
    } catch (err) {
        console.error("ดึงคะแนน ณ จุดที่คลิกไม่สำเร็จ:", err);
    }
};

async function onToggleLayer(factor, visible) {
    const state = getLayerState(factor);
    state.visible = visible;

    if (!visible) {
        setFactorLayerVisible(factor, false);
        return;
    }

    if (factorLayerExists(factor)) {
        setFactorLayerVisible(factor, true);
        return;
    }

    try {
        const res = await fetch(`${BACKEND_URL}/api/layer-preview?factor=${encodeURIComponent(factor)}`);
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        addFactorLayer(factor, data.preview_image_base64, data.bounds);
        state.source = data.source;
        if (data.has_raw) state.hasRaw = true;
        renderCriteriaList();
    } catch (err) {
        showToast("ไม่สามารถโหลดชั้นข้อมูลได้ กรุณาเช็คว่าเปิด backend อยู่หรือไม่", "error");
        state.visible = false;
        renderCriteriaList();
    }
}

async function onUploadLayerFile(factor, file) {
    const row = document.querySelector(`.criteria-row[data-factor="${factor}"]`);
    const badge = row.querySelector('.source-badge');
    
    const originalText = badge.textContent;
    const originalClass = badge.className;
    badge.textContent = "⏳ กำลังประมวลผล...";
    badge.className = "source-badge";
    badge.style.backgroundColor = "#ff9800";
    badge.style.color = "#fff";

    const formData = new FormData();
    formData.append("factor", factor);
    formData.append("file", file);

    try {
        const res = await fetch(`${BACKEND_URL}/api/upload-layer`, {
            method: "POST",
            body: formData,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || res.statusText);
        }
        const data = await res.json();

        badge.style = ""; 
        addFactorLayer(factor, data.preview_image_base64, data.bounds);
        const state = getLayerState(factor);
        state.visible = true;
        state.source = "uploaded";
        state.hasRaw = true;
        renderCriteriaList();

    } catch (err) {
        badge.style = "";
        badge.textContent = originalText;
        badge.className = originalClass;
        showToast("อัปโหลดไฟล์ไม่สำเร็จ: " + err.message, "error");
    }
}

async function openClassifyModal(factor) {
    try {
        const res = await fetch(`${BACKEND_URL}/api/layer-classification?factor=${encodeURIComponent(factor)}`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || res.statusText);
        }
        const data = await res.json();

        classifyingFactor = factor;
        document.getElementById("classifyTitle").textContent = `กำหนดเกณฑ์คะแนน — ${factor}`;
        document.getElementById("classifyBody").innerHTML = renderClassificationForm(factor, data.breaks, data.raw_min, data.raw_max);

        bindClassifyModalEvents();
        document.getElementById("classifyModal").style.display = "block";
    } catch (err) {
        showToast("เปิดหน้ากำหนดเกณฑ์คะแนนไม่สำเร็จ: " + err.message, "error");
    }
}

function bindClassifyModalEvents() {
    document.getElementById("clsAddRow").onclick = () => {
        const breaks = readClassificationFromDOM();
        const last = breaks[breaks.length - 1];
        const step = last ? (last.max - last.min || 100) : 100;
        breaks.push({
            min: last ? last.max : 0,
            max: last ? last.max + step : 100,
            score: 5,
        });
        document.getElementById("classifyBody").innerHTML = renderClassificationForm(classifyingFactor, breaks, "-", "-");
        bindClassifyModalEvents();
    };

    document.querySelectorAll(".cls-remove-row").forEach(btn => {
        btn.onclick = () => {
            const breaks = readClassificationFromDOM();
            const idx = parseInt(btn.dataset.idx, 10);
            breaks.splice(idx, 1);
            document.getElementById("classifyBody").innerHTML = renderClassificationForm(classifyingFactor, breaks, "-", "-");
            bindClassifyModalEvents();
        };
    });

    document.getElementById("clsSave").onclick = saveClassification;
    document.getElementById("clsClose").onclick = () => {
        document.getElementById("classifyModal").style.display = "none";
        classifyingFactor = null;
    };
}

async function saveClassification() {
    const breaks = readClassificationFromDOM();
    if (breaks.length === 0) {
        showToast("กรุณากำหนดอย่างน้อย 1 ช่วงเกณฑ์คะแนน", "warning");
        return;
    }

    try {
        const res = await fetch(`${BACKEND_URL}/api/set-classification`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ factor: classifyingFactor, breaks: breaks }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || res.statusText);
        }
        const data = await res.json();

        addFactorLayer(classifyingFactor, data.preview_image_base64, data.bounds);
        const state = getLayerState(classifyingFactor);
        state.visible = true;
        state.source = "classified";
        state.hasRaw = true;

        document.getElementById("classifyModal").style.display = "none";
        classifyingFactor = null;
        renderCriteriaList();
    } catch (err) {
        showToast("บันทึกเกณฑ์คะแนนไม่สำเร็จ: " + err.message, "error");
    }
}

document.getElementById("createMatrix").onclick = function () {
    const matrixBody = document.getElementById("matrixModalBody");
    matrixBody.innerHTML = renderMatrixTable(criteria);
    document.getElementById("matrixModal").style.display = "block";
};

document.getElementById("closeMatrixModal").onclick = function () {
    document.getElementById("matrixModal").style.display = "none";
};

document.getElementById("calculate").onclick = async function () {
    if (criteria.length < 2) {
        showToast("ต้องมีปัจจัยอย่างน้อย 2 ตัว กรุณาเพิ่มปัจจัยในรายการปัจจัยก่อน", "warning");
        return;
    }

    const testInput = document.getElementById("cell_0_1");
    if (!testInput) {
        showToast("กรุณากดปุ่ม 'สร้าง Matrix' เพื่อเปิดตารางกรอกข้อมูลก่อนกดคำนวณครับ", "warning");
        return;
    }

    const matrix = readMatrixFromDOM(criteria);
    const payload = { factors: criteria, matrix: matrix };

    try {
        const ahpResponse = await fetch(`${BACKEND_URL}/api/ahp-calculate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const result = await ahpResponse.json();

        if (!result.is_consistent) {
            showToast(`ค่า CR = ${result.cr} (เกิน 0.10)\nข้อมูลยังไม่สอดคล้อง กรุณาปรับตัวเลือกในตารางใหม่`, "warning", 6000);
            return;
        }

        lastAhpWeights = result.weights;
        renderAhpResult(result);
        
        document.getElementById("matrixModal").style.display = "none";
        showToast("คำนวณน้ำหนัก AHP สำเร็จ\nขั้นต่อไป: กดปุ่ม '2. คำนวณแผนที่' เพื่อดูผลบนแผนที่", "success", 6000);

    } catch (error) {
        showToast("ไม่สามารถเชื่อมต่อกับ Python Backend ได้! (กรุณาเช็คว่าเปิด uvicorn อยู่ไหม)", "error", 6000);
    }
};

function renderAhpResult(result) {
    let resultHTML = `
        <div id="ahp-result-box" style="background: #e8f5e9; padding: 15px; border-radius: 8px; margin-top: 15px; border: 1px solid #c8e6c9;">
            <h3 style="color: #2e7d32; margin-bottom: 10px; font-size: 14px; text-align: center;">สรุปผลการคำนวณ AHP</h3>
            <p style="font-size: 13px; text-align: center; margin-bottom: 10px;">
                <b>CR:</b> ${result.cr} <span style="color:green;">(&lt; 0.10)</span>
            </p>
            <table style="width: 100%; font-size: 13px; text-align: left; border-collapse: collapse;">
                <tr style="background: #a5d6a7; color: #1b5e20;">
                    <th style="padding: 6px;">ปัจจัย</th>
                    <th style="padding: 6px;">น้ำหนัก (%)</th>
                </tr>`;

    for (const [factor, weight] of Object.entries(result.weights)) {
        resultHTML += `<tr style="border-bottom: 1px solid #c8e6c9;">
                        <td style="padding:6px; color:#2e7d32;">${factor}</td>
                        <td style="padding:6px; font-weight:bold; color:#1b5e20;">${(weight * 100).toFixed(2)}%</td>
                       </tr>`;
    }
    resultHTML += `</table></div>`;
    document.getElementById("ahpResultContainer").innerHTML = resultHTML;
}

document.getElementById("calculateSuitability").onclick = async function () {
    if (!lastAhpWeights) {
        showToast("กรุณากดปุ่ม '1. คำนวณน้ำหนัก' ให้เสร็จก่อน", "warning");
        return;
    }

    const missingRealData = criteria.filter(c => !getLayerState(c).hasRaw);
    if (missingRealData.length > 0) {
        const proceed = await showMissingDataWarning(missingRealData);
        if (!proceed) return;
    }

    try {
        await calculateAndShowSuitability(lastAhpWeights);
        const dlBtn = document.getElementById("downloadBtn");
        if (dlBtn) {
            dlBtn.disabled = false;
            dlBtn.style.opacity = "1";
            dlBtn.style.cursor = "pointer";
        }
    } catch (error) {
        showToast("ไม่สามารถเชื่อมต่อกับ Python Backend ได้! (กรุณาเช็คว่าเปิด uvicorn อยู่ไหม)", "error", 6000);
    }
};

function showMissingDataWarning(missingFactors) {
    return new Promise((resolve) => {
        const modal = document.getElementById("confirmModal");
        document.getElementById("confirmMissingList").innerHTML = missingFactors.map(f => `<li>${f}</li>`).join("");

        const cleanup = (result) => {
            modal.style.display = "none";
            resolve(result);
        };

        document.getElementById("confirmProceed").onclick = () => cleanup(true);
        document.getElementById("confirmCancel").onclick = () => cleanup(false);
        modal.style.display = "block";
    });
}

async function calculateAndShowSuitability(weights) {
    const response = await fetch(`${BACKEND_URL}/api/suitability`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weights: weights }),
    });

    if (!response.ok) {
        showToast("คำนวณแผนที่ความเหมาะสมไม่สำเร็จ", "error");
        return;
    }

    const data = await response.json();
    addSuitabilityLayer(data.image_base64, data.bounds);
    renderSuitabilityLegend(data.stats, data.note);

    if (data.layer_sources) {
        Object.entries(data.layer_sources).forEach(([factor, source]) => {
            const state = getLayerState(factor);
            state.source = source;
            if (source === "uploaded" || source === "classified") state.hasRaw = true;
        });
        renderCriteriaList();
    }
}

function renderSuitabilityLegend(stats, note) {
    const mapSection = document.getElementById("map");
    let legend = document.getElementById("suitability-legend");
    if (legend) legend.remove();

    legend = document.createElement("div");
    legend.id = "suitability-legend";
    legend.className = "suitability-legend";
    legend.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 2px solid #e8f5e9; padding-bottom: 8px; margin-bottom: 10px;">
            <h4 style="margin:0; color: #1b5e20;">ผลลัพธ์ความเหมาะสม</h4>
            <label class="toggle-switch" title="เปิด/ปิดการแสดงผลเลเยอร์นี้">
                <input type="checkbox" id="toggleSuitability" checked>
                <span class="slider round"></span>
            </label>
        </div>
        <div style="display:flex; align-items:center; gap:10px; margin-bottom: 12px;">
            <span style="font-size:0.75rem; color:#555;">ความโปร่งใส:</span>
            <input type="range" id="opacitySuitability" min="0" max="100" value="75" style="flex:1; accent-color:#2e7d32;">
            <span id="opacityValue" style="font-size:0.75rem; font-weight:bold; width:30px;">75%</span>
        </div>
        <div class="legend-gradient"></div>
        <div class="legend-labels"><span>ไม่เหมาะสม</span><span>เหมาะสมมาก</span></div>
        <ul>
            <li>คะแนนเฉลี่ย: <b>${stats.mean_score}</b> (0-1)</li>
            <li>เหมาะสมสูง (≥0.7): <b>${stats.percent_high_suitability}%</b></li>
            <li>เหมาะสมปานกลาง: <b>${stats.percent_medium_suitability}%</b></li>
            <li>เหมาะสมต่ำ: <b>${stats.percent_low_suitability}%</b></li>
        </ul>
        <p class="legend-note">${note}</p>
    `;
    mapSection.appendChild(legend);

    document.getElementById('toggleSuitability').addEventListener('change', function(e) {
        const visibility = e.target.checked ? 'visible' : 'none';
        if (map.getLayer('suitability-layer')) { 
            map.setLayoutProperty('suitability-layer', 'visibility', visibility);
        }
    });

    document.getElementById('opacitySuitability').addEventListener('input', function(e) {
        const opacity = e.target.value / 100;
        document.getElementById('opacityValue').textContent = e.target.value + '%';
        if (map.getLayer('suitability-layer')) {
            map.setPaintProperty('suitability-layer', 'raster-opacity', opacity);
        }
    });
}

document.getElementById("reset").onclick = async function () {
    try {
        await fetch(`${BACKEND_URL}/api/reset-layers`, { method: "POST" });
    } catch (err) {}
    location.reload();
};

// -----------------------------------------------------
// ฟังก์ชันจัดการดาวน์โหลดไฟล์
// -----------------------------------------------------
let selectedDownloadType = "Shapefile";
document.querySelectorAll(".dl-type-btn").forEach(btn => {
    btn.onclick = function() {
        document.querySelectorAll(".dl-type-btn").forEach(b => b.classList.remove("active"));
        this.classList.add("active");
        selectedDownloadType = this.dataset.type;
    };
});

document.getElementById("downloadBtn").onclick = function() {
    if (this.disabled) return;
    
    // เปลี่ยนข้อความในปุ่มแทนการเด้ง alert() เพื่อป้องกันเบราว์เซอร์บล็อก
    const btn = this;
    const originalText = btn.textContent;
    btn.textContent = `⏳ กำลังโหลด ${selectedDownloadType}...`;
    btn.style.backgroundColor = "#ff9800"; // เปลี่ยนเป็นสีส้มชั่วคราว
    btn.disabled = true;

    // สร้างลิงก์จำลองเพื่อบังคับดาวน์โหลดไฟล์
    const downloadUrl = `${BACKEND_URL}/api/download?type=${selectedDownloadType}`;
    const a = document.createElement('a');
    a.href = downloadUrl;
    // ซ่อนลิงก์และจำลองการคลิก
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // คืนสถานะปุ่มกลับมาเป็นเหมือนเดิมหลังจากผ่านไป 5 วินาที
    setTimeout(() => {
        btn.textContent = originalText;
        btn.style.backgroundColor = ""; 
        btn.disabled = false;
    }, 5000);
};