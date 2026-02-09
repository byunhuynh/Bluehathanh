// Cấu hình Worker cho PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// --- 1. CẤU HÌNH HỆ THỐNG ---
const GAS_WEB_APP_URL =
  "https://script.google.com/macros/s/AKfycbz739LM8dmIafQL_ZCeSMf6ei0yTQmY4TO8ornE-jx_pB8tdfv0GWVKlj9NDSSSPQvy/exec";

// Khởi tạo Session ID (Duy nhất mỗi lần mở trình duyệt)
const currentSessionID =
  sessionStorage.getItem("WORK_SESSION_ID") ||
  "S-" + Math.random().toString(36).substring(2, 8).toUpperCase();
sessionStorage.setItem("WORK_SESSION_ID", currentSessionID);
document.getElementById("displaySessionID").innerText = currentSessionID;

// Khai báo các thành phần giao diện (DOM)
const fileInput = document.getElementById("fileInput");
const fileListDisplay = document.getElementById("fileListDisplay");
const processBtn = document.getElementById("processBtn");
const productSummaryBody = document.getElementById("productSummaryBody");
const detailLogBody = document.getElementById("detailLogBody");
const totalProductCountLabel = document.getElementById("totalProductCount");
const progressContainer = document.getElementById("progressContainer");
const mainProgressBar = document.getElementById("mainProgressBar");
const progressPercent = document.getElementById("progressPercent");
const progressText = document.getElementById("progressText");
const displayBatchID = document.getElementById("displayBatchID");

let selectedFiles = [];
let globalProductCounter = 0;

// --- 2. QUẢN LÝ DANH SÁCH FILE ---

fileInput.addEventListener("change", (e) => {
  selectedFiles = [...selectedFiles, ...Array.from(e.target.files)];
  renderFileList();
});

function renderFileList() {
  processBtn.disabled = selectedFiles.length === 0;
  fileListDisplay.innerHTML = selectedFiles.length
    ? selectedFiles
        .map(
          (file, idx) => `
        <div class="d-flex justify-content-between align-items-center mb-2 bg-light p-2 rounded">
            <span class="small text-truncate" style="max-width: 60%"><i class="fa-solid fa-file-pdf text-danger me-2"></i>${file.name}</span>
            <div class="d-flex align-items-center">
                <span class="file-status-text status-waiting" id="status-text-${idx}">Chờ xử lý</span>
                <i class="fa-solid fa-times cursor-pointer text-muted" onclick="removeFile(${idx})" id="remove-icon-${idx}"></i>
            </div>
        </div>`,
        )
        .join("")
    : `<div class="text-center text-muted py-5 small">Chưa chọn tệp tin</div>`;
}

function removeFile(idx) {
  selectedFiles.splice(idx, 1);
  renderFileList();
}

const toBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result);
    reader.onerror = (err) => reject(err);
  });

// --- 3. LUỒNG XỬ LÝ CHÍNH (FIX LỖI 405) ---

processBtn.addEventListener("click", async () => {
  const filesToProcess = [...selectedFiles];
  const currentBatchID = "B-" + Date.now().toString().slice(-6);
  const folderDate = new Date().toISOString().split("T")[0];

  // Cập nhật giao diện khi bắt đầu
  displayBatchID.innerText = currentBatchID;
  productSummaryBody.innerHTML = "";
  detailLogBody.innerHTML = "";
  globalProductCounter = 0;
  totalProductCountLabel.innerText = "0 items";
  document.getElementById("detailTableArea").style.display = "block";
  progressContainer.style.display = "block";
  processBtn.disabled = true;

  for (let i = 0; i < filesToProcess.length; i++) {
    const file = filesToProcess[i];
    try {
      updateProgress(i, filesToProcess.length, `Đang xử lý: ${file.name}`);

      // --- BƯỚC A: GỬI PDF & KHỞI TẠO DRIVE (Backend) ---
      updateFileStatus(
        i,
        "Khởi tạo Drive...",
        "status-working",
        "fa-spinner fa-spin",
      );
      const b64 = await toBase64(file);

      const uploadRes = await fetch(GAS_WEB_APP_URL, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, // Fix lỗi 405 tại đây
        body: JSON.stringify({
          action: "upload",
          dateStr: folderDate,
          sessionId: currentSessionID,
          batchId: currentBatchID,
          fileName: file.name,
          fileData: b64,
        }),
      });

      if (!uploadRes.ok)
        throw new Error("Server phản hồi lỗi " + uploadRes.status);
      const uploadJson = await uploadRes.json();
      const targetCopyId = uploadJson.copyId;

      // --- BƯỚC B: BÓC TÁCH DỮ LIỆU PDF (Frontend) ---
      updateFileStatus(
        i,
        "Bóc tách dữ liệu...",
        "status-working",
        "fa-file-magnifying-glass fa-beat",
      );
      const analyzedData = await extractPdfContent(file);

      // Hiển thị dữ liệu lên bảng Summary và bảng Detail
      renderProductsToSummary(file.name, analyzedData.productList);
      renderStatusRow(file.name, analyzedData);

      // --- BƯỚC C: GHI DỮ LIỆU VÀO SHEET (Backend) ---
      if (analyzedData.productList.length > 0) {
        updateFileStatus(
          i,
          "Ghi vào Sheet...",
          "status-working",
          "fa-cloud-arrow-up",
        );

        const saveRes = await fetch(GAS_WEB_APP_URL, {
          method: "POST",
          mode: "cors",
          headers: { "Content-Type": "text/plain;charset=utf-8" }, // Fix lỗi 405 tại đây
          body: JSON.stringify({
            action: "saveData",
            copyId: targetCopyId,
            products: analyzedData.productList,
            po: analyzedData.po,
            customer: analyzedData.customer,
          }),
        });

        const saveJson = await saveRes.json();
        if (saveJson.status === "success") {
          updateBackendStatusCell(
            file.name,
            `Đã ghi ${saveJson.rowCount} hàng`,
          );
          updateFileStatus(
            i,
            "Thành công!",
            "status-success",
            "fa-check-circle",
          );
        } else {
          throw new Error(saveJson.message);
        }
      } else {
        updateFileStatus(
          i,
          "PDF trống/Lỗi",
          "text-danger",
          "fa-triangle-exclamation",
        );
      }
    } catch (err) {
      console.error("Lỗi chi tiết:", err);
      updateFileStatus(i, "Lỗi kết nối!", "text-danger", "fa-circle-xmark");
      // Ghi nhận lỗi vào bảng chi tiết để người dùng biết
      const statusCell = document.querySelector(
        `#detailLogBody tr[data-filename="${file.name}"] .status-col`,
      );
      if (statusCell)
        statusCell.innerHTML = `<span class="text-danger small">${err.message}</span>`;
    }
  }

  updateProgress(
    filesToProcess.length,
    filesToProcess.length,
    "Hoàn thành lượt xử lý!",
  );
  processBtn.disabled = false;
  fileInput.value = ""; // Reset input file
  selectedFiles = []; // Xóa danh sách chờ
});

// --- 4. BỘ MÁY BÓC TÁCH ĐA HỆ THỐNG ---

async function extractPdfContent(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const items = content.items.map((it) => it.str.trim());

  // Hiển thị Debug Index
  document.getElementById("debugRawArea").innerHTML = items
    .map((it, idx) => (it !== "" ? `<div>[${idx}] ${it}</div>` : ""))
    .join("");

  // Nhận diện hệ thống (Factory Pattern)
  const system = identifySystem(items, file.name);

  switch (system) {
    case "LOTTE":
      return parseLotte(items);
    // Sau này bạn có thể thêm: case "AEON": return parseAeon(items);
    default:
      return {
        customer: "Chưa nhận diện",
        po: "N/A",
        price: "0",
        productList: [],
        status: "Chưa hỗ trợ",
      };
  }
}

function identifySystem(items, fileName) {
  const fullText = items.join(" ");
  // Nhận diện Lotte qua Mã số thuế hoặc Từ khóa
  if (items.includes("0107889783") || fullText.includes("LOTTE MART"))
    return "LOTTE";
  return "UNKNOWN";
}

function parseLotte(items) {
  let products = [];
  const anchorRegex = /^\d-\d{6}-\d{3}$/; // Mốc nhận diện mã hàng nội bộ Lotte

  for (let i = 0; i < items.length; i++) {
    if (anchorRegex.test(items[i])) {
      products.push({
        saleCd: items[i + 2] || "N/A", // Barcode
        uom: items[i + 7] || "0", // Quy cách (Ví dụ: 4)
        ordQty: items[i + 11] || "0", // SL đặt (Ví dụ: 5)
        splyPrc: items[i + 15] || "0", // Đơn giá
        prodNm: (items[i + 4] || "") + " " + (items[i + 5] || ""), // Tên hàng ghép từ 2 dòng
      });
    }
  }
  return {
    customer: "LOTTE MART",
    po: items[88] || "N/A", // PO Lotte ở index 88
    price: items[274] || "0", // Tổng tiền thanh toán ở index 274
    productList: products,
  };
}

// --- 5. CÁC HÀM CẬP NHẬT GIAO DIỆN (UI) ---

function renderProductsToSummary(fileName, products) {
  if (globalProductCounter === 0) productSummaryBody.innerHTML = "";
  products.forEach((p) => {
    const row = productSummaryBody.insertRow();
    row.innerHTML = `
            <td class="ps-3"><span class="filename-badge" title="${fileName}">${fileName}</span></td>
            <td class="fw-bold">${p.saleCd}</td>
            <td class="small">${p.prodNm}</td>
            <td class="text-center">${p.uom}</td>
            <td class="text-center fw-bold text-primary">${p.ordQty}</td>
            <td class="text-end pe-3">${p.splyPrc}</td>`;
    globalProductCounter++;
  });
  totalProductCountLabel.innerText = `${globalProductCounter} items`;
}

function renderStatusRow(fileName, data) {
  const row = detailLogBody.insertRow();
  row.setAttribute("data-filename", fileName);
  row.innerHTML = `
        <td class="ps-3"><strong>${fileName}</strong></td>
        <td>${data.customer}</td>
        <td class="fw-bold text-primary">${data.po}</td>
        <td class="text-end fw-bold">${data.price}</td>
        <td class="text-center status-col"><span class="text-muted small"><i class="fa-solid fa-spinner fa-spin me-2"></i>Đang ghi Sheet...</span></td>`;
}

function updateBackendStatusCell(fileName, msg) {
  const row = document.querySelector(
    `#detailLogBody tr[data-filename="${fileName}"]`,
  );
  if (row) {
    row.querySelector(".status-col").innerHTML =
      `<span class="badge bg-success"><i class="fa-solid fa-check me-1"></i>${msg}</span>`;
  }
}

function updateProgress(curr, tot, txt) {
  const pc = Math.round((curr / tot) * 100);
  mainProgressBar.style.width = pc + "%";
  progressPercent.innerText = pc + "%";
  progressText.innerText = txt;
}

function updateFileStatus(idx, txt, cls, icon) {
  const t = document.getElementById(`status-text-${idx}`);
  const i = document.getElementById(`remove-icon-${idx}`);
  if (t) {
    t.innerText = txt;
    t.className = `file-status-text ${cls}`;
  }
  if (i) i.className = `fa-solid ${icon} ${cls}`;
}

function copySessionID() {
  const id = document.getElementById("displaySessionID").innerText;
  navigator.clipboard.writeText(id).then(() => {
    alert("Đã sao chép Session ID: " + id);
  });
}
