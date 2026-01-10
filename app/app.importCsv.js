// app/app.importCsv.js
// ---------------------------------------------------------
// IMPORT ASSIGNMENT (CSV)
// Structured path: CSV → Normalize → Review → Apply
//
// Exposes:
// - window.openImportAssignmentCsv()
//
// Requires:
// - window.openScanReview(payload)  (from app.scanReviewApply.js)
// ---------------------------------------------------------

(function () {
  if (window.__importCsvLoaded) return;
  window.__importCsvLoaded = true;

  const $ = (id) => document.getElementById(id);

  function ensureModal() {
    if ($("importCsvModal")) return;

    const wrap = document.createElement("div");
    wrap.id = "importCsvModal";
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
            <div style="font-weight:800;">Import Assignment (CSV)</div>
            <div style="font-size:12px; opacity:.7;">Structured import. Best accuracy + fastest review.</div>
          </div>
          <button id="importCsvClose" type="button" style="border:0; background:#f3f3f3; padding:10px 12px; border-radius:12px; cursor:pointer;">Close</button>
        </div>

        <div style="padding:16px;">
          <div id="importCsvDrop"
               style="border:2px dashed #ddd; border-radius:16px; padding:18px; text-align:center; cursor:pointer;">
            <div style="font-weight:800;">Drag & drop CSV here</div>
            <div style="font-size:12px; opacity:.7; margin-top:6px;">or click to choose a file</div>
            <div style="margin-top:10px; font-size:12px; opacity:.65;">Accepted: .csv</div>
            <input id="importCsvFile" type="file" accept=".csv,text/csv" style="display:none;" />
          </div>

          <div style="margin-top:10px; font-size:12px; opacity:.75; line-height:1.35;">
            <b>Expected columns:</b> RN, Room, Level (optional), Acuity/Notes (optional), Empty (optional).<br/>
            Aliases are supported (RN Name/Nurse, Room#/ROOM#, Tele/MS, Tags).
          </div>

          <div id="importCsvErr" style="margin-top:10px; color:#c00; font-size:12px; display:none;"></div>

          <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:16px; flex-wrap:wrap;">
            <button id="importCsvContinue" type="button"
              style="border:0; background:#111; color:#fff; padding:10px 12px; border-radius:12px; cursor:pointer;"
              disabled>
              Continue to Review
            </button>
          </div>

          <div id="importCsvChosen" style="margin-top:10px; font-size:12px; opacity:.75;"></div>
        </div>
      </div>
    `;

    document.body.appendChild(wrap);

    $("importCsvClose").addEventListener("click", () => {
      $("importCsvModal").style.display = "none";
    });

    const drop = $("importCsvDrop");
    const fileInput = $("importCsvFile");

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

    $("importCsvContinue").addEventListener("click", () => {
      const f = window.__importCsvPickedFile;
      if (!f) return;
      openReviewForCsvFile(f);
    });
  }

  function setErr(msg) {
    const el = $("importCsvErr");
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

    const isCsv = file && String(file.name || "").toLowerCase().endsWith(".csv");
    if (!isCsv) {
      setErr("Please choose a CSV file (.csv).");
      window.__importCsvPickedFile = null;
      $("importCsvContinue").disabled = true;
      $("importCsvChosen").textContent = "";
      return;
    }

    window.__importCsvPickedFile = file;
    $("importCsvContinue").disabled = false;
    $("importCsvChosen").textContent = `Selected: ${file.name} (${Math.round((file.size || 0) / 1024)} KB)`;
  }

  function openReviewForCsvFile(file) {
    if (typeof window.openScanReview !== "function") {
      setErr("openScanReview missing. Ensure app.scanReviewApply.js is loaded.");
      return;
    }

    const payload = {
      // imageUrl not needed for CSV mode, but keep a stable field for parity/debug
      imageUrl: "",
      imagePath: file.name,
      file,
      fileType: "csv",
      sessionId: "local-csv",
      unitId: window.activeUnitId || null,
    };

    $("importCsvModal").style.display = "none";
    window.openScanReview(payload);
  }

  function openImportAssignmentCsv() {
    ensureModal();
    window.__importCsvPickedFile = null;
    setErr(null);
    $("importCsvContinue").disabled = true;
    $("importCsvChosen").textContent = "";
    $("importCsvModal").style.display = "flex";
  }

  window.openImportAssignmentCsv = openImportAssignmentCsv;
})();