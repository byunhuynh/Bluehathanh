// Cấu hình Worker cho PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// --- 1. CẤU HÌNH HỆ THỐNG ---
const GAS_WEB_APP_URL =
  "https://script.google.com/macros/s/AKfycbz739LM8dmIafQL_ZCeSMf6ei0yTQmY4TO8ornE-jx_pB8tdfv0GWVKlj9NDSSSPQvy/exec";

const currentSessionID =
  sessionStorage.getItem("WORK_SESSION_ID") ||
  "S-" + Math.random().toString(36).substring(2, 8).toUpperCase();
sessionStorage.setItem("WORK_SESSION_ID", currentSessionID);
document.getElementById("displaySessionID").innerText = currentSessionID;

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

fileInput.addEventListener("change", (e) => {
  selectedFiles = [...selectedFiles, ...Array.from(e.target.files)];
  renderFileList();
});

function renderFileList() {
  processBtn.disabled = selectedFiles.length === 0;
  fileListDisplay.innerHTML = selectedFiles
    .map(
      (file, idx) => `
        <div class="d-flex justify-content-between align-items-center mb-2 bg-light p-2 rounded">
            <span class="small text-truncate" style="max-width: 60%"><i class="fa-solid fa-file-pdf text-danger me-2"></i>${file.name}</span>
            <div class="d-flex align-items-center">
                <span class="file-status-text status-waiting" id="status-text-${idx}">Chờ...</span>
                <i class="fa-solid fa-times cursor-pointer text-muted" onclick="removeFile(${idx})" id="remove-icon-${idx}"></i>
            </div>
        </div>`,
    )
    .join("");
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

/** 1. VÒNG LẶP ĐIỀU PHỐI CHÍNH **/
processBtn.addEventListener("click", async () => {
  await loadMasterData();
  const filesToProcess = [...selectedFiles];
  const currentBatchID = "B-" + Date.now().toString().slice(-6);
  const folderDate = new Date().toISOString().split("T")[0];

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

      // Bước A: Tạo Folder/Sheet (1 file PDF gốc = 1 folder lưu trữ)
      updateFileStatus(
        i,
        "Khởi tạo Drive...",
        "status-working",
        "fa-spinner fa-spin",
      );
      const b64 = await toBase64(file);
      const uploadRes = await fetch(GAS_WEB_APP_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "upload",
          dateStr: folderDate,
          sessionId: currentSessionID,
          batchId: currentBatchID,
          fileName: file.name,
          fileData: b64,
        }),
      });
      const { copyId } = await uploadRes.json();

      // Bước B: Bóc tách PDF đa trang
      updateFileStatus(
        i,
        "Đang đọc PDF...",
        "status-working",
        "fa-file-magnifying-glass fa-beat",
      );

      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        updateProgress(
          i,
          filesToProcess.length,
          `Xử lý ${file.name} - Trang ${pageNum}`,
        );

        const pageData = await extractPageData(pdf, pageNum, file.name);

        // Hiển thị sản phẩm lên UI
        renderProductsToSummary(file.name, pageData.productList, pageNum);
        renderStatusRow(file.name, pageData, pageNum, pdf.numPages);

        // Bước C: Ghi dữ liệu từng trang vào Sheet tương ứng
        if (pageData.productList.length > 0) {
          const saveRes = await fetch(GAS_WEB_APP_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({
              action: "saveData",
              copyId: copyId,
              products: pageData.productList,
              po: pageData.po,
              customer: pageData.customer,
            }),
          });
          const saveJson = await saveRes.json();
          if (saveJson.status === "success") {
            updateBackendStatusCell(
              file.name,
              pageNum,
              `Ghi ${saveJson.rowCount} hàng`,
            );
          }
        }
      }
      updateFileStatus(i, "Hoàn tất PDF", "status-success", "fa-check-circle");
    } catch (err) {
      console.error(err);
      updateFileStatus(i, "Lỗi!", "text-danger", "fa-circle-xmark");
    }
  }
  updateProgress(
    filesToProcess.length,
    filesToProcess.length,
    "Hoàn thành Batch!",
  );
  processBtn.disabled = false;
});

/** 2. HÀM ĐỌC DỮ LIỆU TỪNG TRANG **/
async function extractPageData(pdf, pageNum, fileName) {
  const page = await pdf.getPage(pageNum);
  const content = await page.getTextContent();
  const items = content.items.map((it) => it.str.trim());

  // Hiển thị Debug cho trang hiện tại
  document.getElementById("debugRawArea").innerHTML +=
    `<div>--- TRANG ${pageNum} ---</div>` +
    items
      .map((it, idx) => (it !== "" ? `<div>[${idx}] ${it}</div>` : ""))
      .join("");

  const system = identifySystem(items);
  let parsed = {
    customer: "Chưa rõ",
    custId: "---",
    po: "N/A",
    price: "0",
    productList: [],
  };

  if (system === "LOTTE") {
    parsed = parseLotte(items);
  }

  // Kiểm tra giá (Logic mẫu: Nếu giá <= 0 thì coi là sai)
  let wrongPriceCount = 0;
  parsed.productList.forEach((p) => {
    const val = parseFloat(p.splyPrc.replace(/,/g, "")) || 0;
    if (val <= 0) wrongPriceCount++; // Bạn thay logic so sánh giá thật ở đây
  });

  parsed.priceCheck = {
    total: parsed.productList.length,
    wrong: wrongPriceCount,
  };

  return parsed;
}

function identifySystem(items) {
  const fullText = items.join(" ");
  if (items.includes("0107889783") || fullText.includes("LOTTE MART"))
    return "LOTTE";
  return "UNKNOWN";
}

function parseLotte(items) {
  let products = [];
  const anchorRegex = /^\d-\d{6}-\d{3}$/;
  for (let i = 0; i < items.length; i++) {
    if (anchorRegex.test(items[i])) {
      products.push({
        saleCd: items[i + 2] || "N/A",
        uom: items[i + 7] || "0",
        ordQty: items[i + 11] || "0",
        splyPrc: items[i + 15] || "0",
        prodNm: (items[i + 4] || "") + " " + (items[i + 5] || ""),
      });
    }
  }
  return {
    customer: "LOTTE MART",
    custId: "---", // Cập nhật sau
    po: items[88] || "N/A",
    price: items[274] || "0",
    productList: products,
  };
}

/** 3. HELPER UI FUNCTIONS **/

let MasterCatalog = {}; // Bộ nhớ đệm danh mục

/** Tải danh mục từ AppScript */
async function loadMasterData() {
  try {
    const res = await fetch(GAS_WEB_APP_URL, {
      method: "POST",
      body: JSON.stringify({ action: "getMasterData" }),
    });
    const json = await res.json();
    if (json.status === "success") {
      MasterCatalog = json.data;
      console.log(
        "Hệ thống đã nạp " +
          Object.keys(MasterCatalog).length +
          " mã nhận diện.",
      );
    }
  } catch (err) {
    console.error("Lỗi tải danh mục:", err);
  }
}

function renderProductsToSummary(fileName, products, pageNum) {
  if (globalProductCounter === 0) productSummaryBody.innerHTML = "";

  products.forEach((p) => {
    const row = productSummaryBody.insertRow();

    // Tìm kiếm barcode trong bộ từ điển MasterCatalog (đã tải từ Backend)
    const master = MasterCatalog[p.saleCd] || {
      name: `<span class="text-danger">MÃ MỚI: ${p.prodNm}</span>`, // Nếu ko thấy trong sheet thì hiện tên PDF để cảnh báo
      correctPrice: 0,
    };

    const pricePO = parseFloat(p.splyPrc.replace(/,/g, "")) || 0;
    const priceCorrect = parseFloat(master.correctPrice) || 0;

    // Xác định hàng KM: Giá PO = 0 hoặc tên PDF có chữ KM
    const isPromo = pricePO === 0 || p.prodNm.toLowerCase().includes("km");
    const isPriceWrong = !isPromo && pricePO !== priceCorrect;

    // Tô màu đỏ nhạt nếu sai giá
    if (isPriceWrong) row.style.backgroundColor = "#fff2f2";
    // Tô màu xanh nhạt nếu là hàng KM
    if (isPromo) row.style.backgroundColor = "#f0fff4";

    row.innerHTML = `
            <td class="ps-3 sticky-col">
                <span class="filename-badge">${fileName} (P${pageNum})</span>
            </td>
            <td class="fw-bold">${p.saleCd}</td>
            <td class="small fw-bold text-dark">
                ${master.name} 
            </td>
            <td class="text-center fw-bold">${p.ordQty}</td>
            <td class="text-end">${pricePO.toLocaleString()}</td>
            <td class="text-end text-success fw-bold">${priceCorrect.toLocaleString()}</td>
            <td class="text-center">
                ${isPromo ? '<span class="badge bg-success">KM</span>' : isPriceWrong ? '<span class="badge bg-danger">Sai giá</span>' : '<span class="badge bg-light text-dark">OK</span>'}
            </td>
            <td class="text-end pe-3 fw-bold">
                ${(pricePO * (parseFloat(p.ordQty) || 0)).toLocaleString()}
            </td>
        `;
    globalProductCounter++;
  });
  totalProductCountLabel.innerText = `${globalProductCounter} items`;
}
function renderStatusRow(fileName, data, pageNum, totalPages) {
  const row = detailLogBody.insertRow();
  const rowId = `row-${fileName.replace(/\s+/g, "-")}-${pageNum}`;
  row.setAttribute("id", rowId);

  const priceStatus =
    data.priceCheck.wrong > 0
      ? `<span class="badge bg-danger">${data.priceCheck.wrong}/${data.priceCheck.total} Sai giá</span>`
      : `<span class="badge bg-success">OK</span>`;

  row.innerHTML = `
        <td class="ps-3"><strong>${fileName}</strong></td>
        <td class="text-center"><span class="badge bg-secondary">${pageNum}/${totalPages}</span></td>
        <td>${data.custId}</td>
        <td>${data.customer}</td>
        <td class="fw-bold text-primary">${data.po}</td>
        <td class="text-end fw-bold">${data.price}</td>
        <td class="text-center">${priceStatus}</td>
        <td class="text-center status-col"><span class="text-muted small">Đang xử lý...</span></td>`;
}

function updateBackendStatusCell(fileName, pageNum, msg) {
  const rowId = `row-${fileName.replace(/\s+/g, "-")}-${pageNum}`;
  const row = document.getElementById(rowId);
  if (row)
    row.querySelector(".status-col").innerHTML =
      `<span class="badge bg-success"><i class="fa-solid fa-check me-1"></i>${msg}</span>`;
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
