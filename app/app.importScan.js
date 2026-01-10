// app/app.importScan.js
// ---------------------------------------------------------
// IMPORT ASSIGNMENT (Desktop-first)
// Mode A: Local PDF drag/drop → PDF.js render → OCR → Parse → Review → Apply
//
// Adds:
// - "Import CSV/Excel" entry point (structured import) that uses window.openImportAssignmentCsv()
//
// Exposes:
// - window.openImportAssignmentScan()  (kept name for compatibility)
//
// Requires:
// - window.openScanReview({ ... })
// - window.scanPdf (app.scanPdf.js) + PDF.js loaded
// - window.openImportAssignmentCsv() (from app.importCsv.js)  [optional, button hides if missing]
//
// Leaves existing phone/QR upload pipeline intact (not removed).
// ---------------------------------------------------------

(function () {
  if (window.__importScanLoaded) return;
  window.__importScanLoaded = true;

  const $ = (id) => document.getElementById(id);

  function ensureModal() {
    if ($("importScanModal")) return;

    const wrap = document.createElement("div");
    wrap.id = "importScanModal";
    wrap.style.cssText = `
      position:fixed; inset:0; z-index:10000;
      background: rgba(0,0,0,.48);
      display:none; align-items:center; justify-content:center;
      padding: 16px;
    `;

    wrap.innerHTML = `
      <div style="width:min(760px,96vw); background:#fff; border-radius:16px; box-shadow:0 12px 50px rgba(0,0,0,.28); overflow:hidden;">
        <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 16px; border-bottom:1px solid #eee;">
          <div>
            <div style="font-weight:800;">Import Assignment</div>
            <div style="font-size:12px; opacity:.7;">
              Preferred: CSV/Excel (structured). Also supports Excel-generated PDF (OCR fallback).
            </div>
          </div>
          <button id="importScanClose" type="button" style="border:0; background:#f3f3f3; padding:10px 12px; border-radius:12px; cursor:pointer;">Close</button>
        </div>

        <div style="padding:16px; display:flex; flex-direction:column; gap:12px;">
          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <button id="importScanGoCsv" type="button"
              style="border:0; background:#111; color:#fff; padding:10px 12px; border-radius:12px; cursor:pointer;">
              Import CSV/Excel (recommended)
            </button>

            <button id="importScanGoPdf" type="button"
              style="border:0; background:#f3f3f3; padding:10px 12px; border-radius:12px; cursor:pointer;">
              Import PDF (OCR fallback)
            </button>

            <button id="importScanFallbackPhoto" type="button"
              style="border:0; background:#f3f3f3; padding:10px 12px; border-radius:12px; cursor:pointer; font-size:12px;">
              Use phone/QR import (fallback)
            </button>
          </div>

          <div id="importScanPdfPane" style="display:none;">
            <div id="importScanDrop"
                 style="border:2px dashed #ddd; border-radius:16px; padding:18px; text-align:center; cursor:pointer;">
              <div style="font-weight:800;">Drag & drop PDF here</div>
              <div style="font-size:12px; opacity:.7; margin-top:6px;">or click to choose a file</div>
              <div style="margin-top:10px; font-size:12px; opacity:.65;">Accepted: .pdf</div>
              <input id="importScanFile" type="file" accept="application/pdf" style="display:none;" />
            </div>

            <div id="importScanErr" style="margin-top:10px; color:#c00; font-size:12px; display:none;"></div>

            <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:16px; flex-wrap:wrap;">
              <button id="importScanContinue" type="button"
                style="border:0; background:#111; color:#fff; padding:10px 12px; border-radius:12px; cursor:pointer;"
                disabled>
                Continue to Review
              </button>
            </div>

            <div id="importScanChosen" style="margin-top:10px; font-size:12px; opacity:.75;"></div>
          </div>

          <div style="font-size:12px; opacity:.7; line-height:1.35;">
            <b>Tip:</b> CSV import is deterministic and fastest. PDF OCR is supported as fallback for teams that only print.
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(wrap);

    $("importScanClose").addEventListener("click", () => {
      $("importScanModal").style.display = "none";
    });

    // Buttons to switch panes
    $("importScanGoPdf").addEventListener("click", () => {
      $("importScanPdfPane").style.display = "block";
    });

    $("importScanGoCsv").addEventListener("click", () => {
      // Hide modal and open CSV import if available
      $("importScanModal").style.display = "none";
      if (typeof window.openImportAssignmentCsv === "function") {
        window.openImportAssignmentCsv();
      } else {
        alert("CSV import not loaded. Ensure app.importCsv.js is included (script order + cache bust).");
      }
    });

    // If CSV import is missing, visually disable the button
    if (typeof window.openImportAssignmentCsv !== "function") {
      const btn = $("importScanGoCsv");
      btn.style.opacity = "0.5";
      btn.style.cursor = "not-allowed";
      btn.addEventListener("click", (e) => e.preventDefault());
    }

    // PDF picker wiring
    const drop = $("importScanDrop");
    const fileInput = $("importScanFile");

    drop.addEventListener("click", () => fileInput.click());

    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.style.borderColor = "#999";
    });

    drop.addEventListener("dragleave", () => {
      drop.style.borderColor = "#ddd";
    });

    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.style.borderColor = "#ddd";
      const f = e.dataTransfer?.files?.[0];
      if (f) onPickFile(f);
    });

    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (f) onPickFile(f);
    });

    $("importScanContinue").addEventListener("click", () => {
      const f = window.__importScanPickedFile;
      if (!f) return;
      openReviewForPdfFile(f);
    });

    $("importScanFallbackPhoto").addEventListener("click", () => {
      if (typeof window.openImportAssignmentScanLegacy === "function") {
        window.openImportAssignmentScanLegacy();
      } else {
        alert("Fallback not wired in this build. (Legacy photo/QR flow still exists in your project; we can re-link it.)");
      }
    });
  }

  function setErr(msg) {
    const el = $("importScanErr");
    if (!el) return;
    if (!msg) {
      el.style.display = "none";
      el.textContent = "";
      return;
    }
    el.style.display = "block";
    el.textContent = msg;
  }

  function onPickFile(file) {
    setErr(null);

    const isPdf =
      file &&
      (file.type === "application/pdf" || String(file.name || "").toLowerCase().endsWith(".pdf"));

    if (!isPdf) {
      setErr("Please choose a PDF file (.pdf).");
      window.__importScanPickedFile = null;
      $("importScanContinue").disabled = true;
      $("importScanChosen").textContent = "";
      return;
    }

    window.__importScanPickedFile = file;
    $("importScanContinue").disabled = false;
    $("importScanChosen").textContent = `Selected: ${file.name} (${Math.round((file.size || 0) / 1024)} KB)`;
  }

  function openReviewForPdfFile(file) {
    if (typeof window.openScanReview !== "function") {
      setErr("openScanReview missing. Ensure app.scanReviewApply.js is loaded.");
      return;
    }

    const url = URL.createObjectURL(file);

    const payload = {
      imageUrl: url,
      imagePath: file.name,
      file,
      fileType: "pdf",
      sessionId: "local-pdf",
      unitId: window.activeUnitId || null,
    };

    $("importScanModal").style.display = "none";
    window.openScanReview(payload);
  }

  function openImportAssignmentScan() {
    ensureModal();

    // Reset PDF pane state each open
    window.__importScanPickedFile = null;
    setErr(null);

    const pdfPane = $("importScanPdfPane");
    if (pdfPane) pdfPane.style.display = "none";

    const cont = $("importScanContinue");
    if (cont) cont.disabled = true;

    const chosen = $("importScanChosen");
    if (chosen) chosen.textContent = "";

    $("importScanModal").style.display = "flex";
  }

  window.openImportAssignmentScan = openImportAssignmentScan;
})();