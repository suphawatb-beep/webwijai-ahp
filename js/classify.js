/*
==========================================================
Classify
Reclassification ตามเกณฑ์งานวิจัย 4 ระดับ:
4 = S1, 3 = S2, 2 = S3, 1 = N
==========================================================
*/

function renderClassificationForm(factor, breaks, rawMin, rawMax) {
    const fixedScores = [4, 3, 2, 1];
    const labels = {4: "S1", 3: "S2", 2: "S3", 1: "N"};

    const rowsHTML = fixedScores.map((score, idx) => {
        const existing = breaks[idx] || { min: "", max: "", score };
        return `
        <div class="cls-row" data-idx="${idx}">
            <span class="cls-row-label">${idx + 1}</span>
            <input type="number" step="any" class="cls-min" value="${existing.min}" title="ค่าต่ำสุดของช่วง ${labels[score]}">
            <span>ถึง</span>
            <input type="number" step="any" class="cls-max" value="${existing.max}" title="ค่าสูงสุดของช่วง ${labels[score]}">
            <span>=</span>
            <select class="cls-score" title="คะแนนของ ${labels[score]}" disabled>
                <option value="${score}" selected>${score}</option>
            </select>
            <span>คะแนน (${labels[score]})</span>
        </div>`;
    }).join("");

    return `
        <p class="cls-hint">
            ค่าดิบของปัจจัย "<b>${factor}</b>" อยู่ในช่วง <b>${rawMin}</b> ถึง <b>${rawMax}</b><br>
            กำหนดช่วงข้อมูลให้ตรงกับเกณฑ์ในงานวิจัย โดยระบบล็อกคะแนนเป็น
            <b>4 = S1, 3 = S2, 2 = S3, 1 = N</b>
        </p>
        <div style="margin:8px 0 12px; padding:10px; background:#f1f8e9; border-radius:6px; font-size:12px;">
            <b>หมายเหตุ:</b> กำหนดช่วงจากค่าน้อยไปค่ามากและอย่าให้ช่วงทับซ้อนกัน
        </div>
        <div id="clsRows">${rowsHTML}</div>
        <div style="display:flex; gap:10px; justify-content:center; margin-top:14px;">
            <button type="button" id="clsSave" style="width:auto; padding:10px 28px;">บันทึกเกณฑ์</button>
            <button type="button" id="clsClose" style="width:auto; padding:10px 28px; background:#d32f2f;">ปิด</button>
        </div>
    `;
}

function readClassificationFromDOM() {
    const rows = document.querySelectorAll("#clsRows .cls-row");
    const breaks = [];
    rows.forEach(row => {
        const min = parseFloat(row.querySelector(".cls-min").value);
        const max = parseFloat(row.querySelector(".cls-max").value);
        const score = parseFloat(row.querySelector(".cls-score").value);
        if (!isNaN(min) && !isNaN(max) && !isNaN(score)) {
            breaks.push({ min, max, score });
        }
    });
    return breaks;
}
