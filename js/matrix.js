/*
==========================================================

Matrix

ไฟล์นี้รับผิดชอบเรื่อง "Pairwise Comparison Matrix" ล้วน ๆ:
- สร้างตาราง HTML ตามรายชื่อปัจจัยที่ผู้ใช้กำหนดเอง (ไม่ตายตัวอีกต่อไป)
- ช่องกรอกค่าน้ำหนักเปลี่ยนจากพิมพ์ตัวเลขอิสระ เป็น "เลือก" จาก
  สเกลมาตรฐานของ Saaty เท่านั้น คือ 1, 3, 5, 7, 9 (และส่วนกลับ)
  เพื่อป้องกันผู้ใช้กรอกค่าที่ไม่มีความหมายในทาง AHP เช่น 4.7, 12 ฯลฯ
- อ่านค่าจากตารางกลับมาเป็น matrix (array 2 มิติ) เพื่อส่งให้ backend

==========================================================
*/

// สเกลมาตรฐาน Saaty: value = ค่าที่จะใช้ในเมทริกซ์, label = คำอธิบายที่ผู้ใช้เห็น
const AHP_SCALE = [
    { value: 9,   label: "9  สำคัญกว่ามากที่สุด" },
    { value: 7,   label: "7  สำคัญกว่ามาก" },
    { value: 5,   label: "5  สำคัญกว่าปานกลาง" },
    { value: 3,   label: "3  สำคัญกว่าเล็กน้อย" },
    { value: 1,   label: "1  สำคัญเท่ากัน" },
    { value: 1/3, label: "1/3  สำคัญน้อยกว่าเล็กน้อย" },
    { value: 1/5, label: "1/5  สำคัญน้อยกว่าปานกลาง" },
    { value: 1/7, label: "1/7  สำคัญน้อยกว่ามาก" },
    { value: 1/9, label: "1/9  สำคัญน้อยกว่ามากที่สุด" },
];

// สร้าง <select> หนึ่งช่องสำหรับเปรียบเทียบ "criteria[i] เทียบกับ criteria[j]"
function buildScaleSelect(i, j) {
    let options = AHP_SCALE.map(opt =>
        `<option value="${opt.value}" ${opt.value === 1 ? "selected" : ""}>${opt.label}</option>`
    ).join("");

    return `<select class="ahp-scale-select" id="cell_${i}_${j}" title="เปรียบเทียบระหว่างสองปัจจัยนี้">
                ${options}
            </select>`;
}

// สร้างตาราง Pairwise Matrix ทั้งหมดจากรายชื่อปัจจัย (criteria) ที่ได้รับมา
// criteria คือ array ของชื่อปัจจัย เช่น ["DEM","Slope","Soil", ...] — ผู้ใช้เพิ่ม/ลบเองได้อย่างอิสระ
function renderMatrixTable(criteria) {
    if (criteria.length < 2) {
        return `<p style="text-align:center; color:#c62828;">
                    ต้องมีปัจจัยอย่างน้อย 2 ตัวจึงจะสร้างตารางเปรียบเทียบได้
                    กรุณาเพิ่มปัจจัยในช่อง "กำหนดปัจจัย (ตัวแปร)" ก่อน
                </p>`;
    }

    let html = "<table style='width:100%; text-align:center; border-collapse: collapse; margin-bottom: 20px;'><tr><th>ปัจจัย</th>";

    criteria.forEach(c => {
        html += `<th style='padding:10px; border:1px solid #ccc; background:#1b5e20; color:white;'>${c}</th>`;
    });
    html += "</tr>";

    for (let i = 0; i < criteria.length; i++) {
        html += `<tr><th style='padding:10px; border:1px solid #ccc; background:#1b5e20; color:white;'>${criteria[i]}</th>`;

        for (let j = 0; j < criteria.length; j++) {
            if (i === j) {
                html += `<td style='border:1px solid #ccc; background:#e8f5e9; font-weight:bold;'>1</td>`;
            } else if (i < j) {
                html += `<td style='border:1px solid #ccc; padding: 5px;'>${buildScaleSelect(i, j)}</td>`;
            } else {
                // ช่องส่วนกลับ (ฝั่งซ้ายล่าง) คำนวณอัตโนมัติจากฝั่งขวาบน ไม่ต้องกรอกซ้ำ
                html += `<td style='border:1px solid #ccc; background:#f4f7f8; color:#777;' id='cell_${i}_${j}'>ส่วนกลับ (auto)</td>`;
            }
        }
        html += "</tr>";
    }
    html += "</table>";
    return html;
}

// อ่านค่าทั้งตารางกลับมาเป็น matrix (array 2 มิติ) ตามลำดับ criteria ปัจจุบัน
function readMatrixFromDOM(criteria) {
    let matrix = [];
    for (let i = 0; i < criteria.length; i++) {
        let row = [];
        for (let j = 0; j < criteria.length; j++) {
            if (i === j) {
                row.push(1.0);
            } else if (i < j) {
                const el = document.getElementById(`cell_${i}_${j}`);
                const val = el ? parseFloat(el.value) : 1.0;
                row.push(val);
            } else {
                const el = document.getElementById(`cell_${j}_${i}`);
                const val = el ? parseFloat(el.value) : 1.0;
                row.push(1.0 / val);
            }
        }
        matrix.push(row);
    }
    return matrix;
}
