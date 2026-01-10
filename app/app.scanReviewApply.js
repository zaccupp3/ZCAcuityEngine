// app/app.scanReviewApply.js
// ---------------------------------------------------------
// REVIEW + APPLY UI (Import → LIVE)
//
// Supports:
// ✅ PDF/image OCR mode (existing)
// ✅ CSV mode (structured): Parse CSV → Review → Apply
//
// Exposes:
// - window.openScanReview({ imageUrl, sessionId, unitId, imagePath, file, fileType })
// - window.applyScanParsedToLive({ parsed, unitId, sessionId, opts })  ✅
//
// Requires (OCR modes):
// - window.scanOcr.runOcr(source, opts)
// - window.scanParserTemplateV2.parse(ocrObj)
// - window.scanPdf.renderUrlToCanvas(url, { scale, pageNumber })  // for PDF
//
// Requires (CSV mode):
// - window.csvNormalizer.normalizeCsvText(text, opts)
// ---------------------------------------------------------

(function () {
  if (window.__scanReviewApplyLoaded) return;
  window.__scanReviewApplyLoaded = true;

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------
  // Small utils
  // ---------------------------------------------------------
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function isBlobUrl(u) {
    const s = String(u || "");
    return s.startsWith("blob:");
  }

  function normalizeName(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function normalizeRoom(s) {
    const r = String(s || "").trim().toUpperCase();
    if (!r) return "";
    return r.replace(/\s+/g, "").replace(/[^0-9A-Z/]/g, "");
  }

  function normalizeLevel(s) {
    const t = String(s || "").trim().toLowerCase();
    if (!t) return "";
    if (t.includes("tele")) return "Tele";
    if (t === "ms" || t.includes("med") || t.includes("m/s")) return "MS";
    return "";
  }

  function normalizeTags(notesArr) {
    const raw = Array.isArray(notesArr) ? notesArr : [];
    const joined = raw.map(x => String(x || "").trim()).filter(Boolean).join(", ").toUpperCase();

    const tags = new Set();

    // Supported mapping → patient flags
    if (/\bISO\b/.test(joined) || /\bISOL\b/.test(joined)) tags.add("ISO");
    if (/\bSITTER\b/.test(joined) || /\bSIT\b/.test(joined)) tags.add("SITTER");
    if (/\bBG\b/.test(joined)) tags.add("BG");
    if (/\bNIH\b/.test(joined)) tags.add("NIH");
    if (/\bADMIT\b/.test(joined) || /\bADM\b/.test(joined)) tags.add("ADMIT");
    if (/\bCIWA\b/.test(joined)) tags.add("CIWA");
    if (/\bGTT\b/.test(joined)) tags.add("GTT");

    // Empty-room support (CSV workflows)
    if (/\bEMPTY\b/.test(joined) || /\bOPEN\b/.test(joined) || /\bVACANT\b/.test(joined)) tags.add("EMPTY");

    return Array.from(tags);
  }

  function isCsvPayload(payload) {
    const ft = String(payload?.fileType || "").toLowerCase();
    if (ft === "csv") return true;
    const path = String(payload?.imagePath || "").toLowerCase();
    if (path.endsWith(".csv")) return true;
    const f = payload?.file;
    if (f && typeof File !== "undefined" && f instanceof File) {
      const n = String(f.name || "").toLowerCase();
      if (n.endsWith(".csv")) return true;
      const t = String(f.type || "").toLowerCase();
      if (t.includes("csv")) return true;
    }
    return false;
  }

  // Robust PDF detection
  function isPdfPayload(payload) {
    const ft = String(payload?.fileType || "").toLowerCase();
    if (ft === "pdf") return true;

    const f = payload?.file;
    if (f && typeof File !== "undefined" && f instanceof File) {
      const t = String(f.type || "").toLowerCase();
      if (t === "application/pdf") return true;
      const n = String(f.name || "").toLowerCase();
      if (n.endsWith(".pdf")) return true;
    }

    const path = String(payload?.imagePath || "").toLowerCase();
    if (path.includes(".pdf")) return true;

    const url = String(payload?.imageUrl || "").toLowerCase();
    if (url.includes(".pdf")) return true;

    if (window.scanPdf?.isPdfUrl) {
      try { if (window.scanPdf.isPdfUrl(url)) return true; } catch (_) {}
    }

    return false;
  }

  // ---------------------------------------------------------
  // Modal + UI
  // ---------------------------------------------------------
  function ensureModal() {
    if ($("scanReviewModal")) return;

    const wrap = document.createElement("div");
    wrap.id = "scanReviewModal";
    wrap.style.cssText = `
      position:fixed; inset:0; z-index:10000;
      background: rgba(0,0,0,.48);
      display:none; align-items:center; justify-content:center;
      padding: 16px;
    `;

    wrap.innerHTML = `
      <div style="width:min(1180px,96vw); max-height:92vh; overflow:auto; background:#fff; border-radius:16px; box-shadow:0 12px 50px rgba(0,0,0,.28);">
        <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 16px; border-bottom:1px solid #eee; gap:12px; flex-wrap:wrap;">
          <div>
            <div style="font-weight:800;">Review Import (Import → LIVE)</div>
            <div id="scanReviewSubtitle" style="font-size:12px; opacity:.7;">Verify rooms, Tele/MS, and acuity notes before applying.</div>
          </div>

          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
            <div id="scanReviewRotateWrap" style="display:flex; gap:8px; align-items:center;">
              <button id="scanReviewRotateLeft" type="button" style="border:0; background:#f3f3f3; padding:10px 12px; border-radius:12px; cursor:pointer;">Rotate ⟲</button>
              <button id="scanReviewRotateRight" type="button" style="border:0; background:#f3f3f3; padding:10px 12px; border-radius:12px; cursor:pointer;">Rotate ⟳</button>
              <div style="font-size:12px; opacity:.7;">Rotation: <span id="scanReviewRotation">0°</span></div>
            </div>

            <button id="scanReviewRun" type="button" style="border:0; background:#111; color:#fff; padding:10px 12px; border-radius:12px; cursor:pointer;">Run OCR Now</button>
            <button id="scanReviewClose" type="button" style="border:0; background:#f3f3f3; padding:10px 12px; border-radius:12px; cursor:pointer;">Close</button>
          </div>
        </div>

        <div style="padding:16px; display:flex; gap:16px; flex-wrap:wrap;">
          <div style="flex:1; min-width:320px;">
            <div style="font-weight:700; margin-bottom:8px;">Preview</div>
            <div style="border:1px solid #eee; border-radius:14px; padding:10px;">
              <img id="scanReviewImg" src="" alt="Preview" style="max-width:100%; border-radius:12px; display:block;" />
              <div id="scanReviewPreviewNote" style="margin-top:8px; font-size:12px; opacity:.75; display:none;"></div>

              <div style="margin-top:8px; font-size:12px; opacity:.75;">
                <div><b>Session:</b> <span id="scanReviewSession">—</span></div>
                <div><b>Unit:</b> <span id="scanReviewUnit">—</span></div>
                <div><b>Type:</b> <span id="scanReviewFileType">—</span></div>
              </div>
            </div>
            <button id="scanReviewDebugBtn" type="button" style="margin-top:10px; border:0; background:#f3f3f3; padding:10px 12px; border-radius:12px; cursor:pointer; font-size:12px;">
              Debug (Raw + parsed)
            </button>
          </div>

          <div style="flex:1.35; min-width:420px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
              <div style="font-weight:700; margin-bottom:8px;">Parsed Output</div>
              <div id="scanReviewCounts" style="font-size:12px; opacity:.7;">—</div>
            </div>

            <div id="scanReviewStatus" style="font-size:12px; opacity:.7; margin-bottom:8px;">No parsed data yet.</div>

            <div id="scanReviewParsed" style="border:1px solid #eee; border-radius:14px; padding:12px; min-height:180px;">
              <div style="font-size:12px; opacity:.7;">No parsed data yet.</div>
            </div>

            <div style="margin-top:12px; display:flex; justify-content:flex-end; gap:10px; flex-wrap:wrap;">
              <button id="scanReviewApplyBtn" type="button" style="border:0; background:#22c55e; color:#06210f; padding:10px 14px; border-radius:12px; cursor:pointer;">
                Apply to LIVE
              </button>
            </div>

            <div id="scanReviewError" style="margin-top:10px; color:#c00; font-size:12px; display:none;"></div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(wrap);

    $("scanReviewClose").addEventListener("click", () => {
      $("scanReviewModal").style.display = "none";
    });

    $("scanReviewRun").addEventListener("click", async () => {
      const payload = window.__scanSessionPayload || {};
      if (isCsvPayload(payload)) {
        await runCsvParse();
      } else {
        await runOcrAndParse();
      }
    });

    $("scanReviewApplyBtn").addEventListener("click", async () => {
      await applyToLive();
    });

    $("scanReviewRotateLeft").addEventListener("click", () => {
      window.__scanRotateDeg = ((window.__scanRotateDeg || 0) + 270) % 360;
      updateRotationUi();
      setStatus('Rotation updated. Click "Run OCR Now" again.');
    });

    $("scanReviewRotateRight").addEventListener("click", () => {
      window.__scanRotateDeg = ((window.__scanRotateDeg || 0) + 90) % 360;
      updateRotationUi();
      setStatus('Rotation updated. Click "Run OCR Now" again.');
    });

    $("scanReviewDebugBtn").addEventListener("click", () => {
      console.log("[review] payload:", window.__scanSessionPayload);
      console.log("[review] last raw:", window.__lastScanOcr);
      console.log("[review] last parsed:", window.__lastScanParsed);
      alert("Debug dumped to console:\n- window.__scanSessionPayload\n- window.__lastScanOcr\n- window.__lastScanParsed");
    });
  }

  function setError(msg) {
    const el = $("scanReviewError");
    if (!el) return;
    if (!msg) {
      el.style.display = "none";
      el.textContent = "";
      return;
    }
    el.style.display = "block";
    el.textContent = msg;
  }

  function setStatus(msg) {
    const el = $("scanReviewStatus");
    if (el) el.textContent = msg || "";
  }

  function setCounts({ rns = 0, pcas = 0, rnRooms = 0 } = {}) {
    const el = $("scanReviewCounts");
    if (el) el.textContent = `RNs: ${rns} • PCAs: ${pcas} • RN room rows: ${rnRooms}`;
  }

  function updateRotationUi() {
    const deg = window.__scanRotateDeg || 0;
    const el = $("scanReviewRotation");
    if (el) el.textContent = `${deg}°`;
  }

  function renderParsed(parsed) {
    const box = $("scanReviewParsed");
    if (!box) return;

    const pcas = Array.isArray(parsed?.pcas) ? parsed.pcas : [];
    const rns = Array.isArray(parsed?.rns) ? parsed.rns : [];
    const rnRoomRows = rns.reduce((sum, rn) => sum + (Array.isArray(rn.rooms) ? rn.rooms.length : 0), 0);

    setCounts({ rns: rns.length, pcas: pcas.length, rnRooms: rnRoomRows });

    if (!pcas.length && !rns.length) {
      box.innerHTML = `<div style="font-size:12px; opacity:.7;">No PCAs detected.<br>No RNs detected.</div>`;
      return;
    }

    let html = "";

    if (pcas.length) {
      html += `<div style="font-weight:800; margin-bottom:8px;">PCAs</div>`;
      for (const p of pcas) {
        html += `
          <div style="border:1px solid #eee; border-radius:12px; padding:10px; margin-bottom:10px;">
            <div style="font-weight:700;">${esc(p.name || "PCA")}${p.count != null ? ` <span style="opacity:.6; font-weight:600;">(${esc(p.count)})</span>` : ""}</div>
            <div style="font-size:12px; opacity:.8; margin-top:6px;">${esc((p.rooms || []).join(", "))}</div>
          </div>
        `;
      }
    } else {
      html += `<div style="font-size:12px; opacity:.7; margin-bottom:12px;">No PCAs detected.</div>`;
    }

    if (rns.length) {
      html += `<div style="font-weight:800; margin:10px 0 8px;">RNs (Assignments)</div>`;
      for (const rn of rns) {
        html += `
          <div style="border:1px solid #eee; border-radius:12px; padding:10px; margin-bottom:12px;">
            <div style="font-weight:800; margin-bottom:8px;">${esc(rn.name || "RN")}</div>
            <table style="width:100%; border-collapse:collapse; font-size:12px;">
              <thead>
                <tr style="text-align:left; opacity:.75;">
                  <th style="padding:6px 4px; border-bottom:1px solid #eee;">Room</th>
                  <th style="padding:6px 4px; border-bottom:1px solid #eee;">Tele/MS</th>
                  <th style="padding:6px 4px; border-bottom:1px solid #eee;">Notes</th>
                </tr>
              </thead>
              <tbody>
                ${(rn.rooms || []).map(rr => `
                  <tr>
                    <td style="padding:6px 4px; border-bottom:1px solid #f3f3f3;">${esc(rr.room || "")}</td>
                    <td style="padding:6px 4px; border-bottom:1px solid #f3f3f3;">${esc(rr.levelOfCare || "—")}</td>
                    <td style="padding:6px 4px; border-bottom:1px solid #f3f3f3;">${esc((rr.notes || []).join(", ") || "—")}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `;
      }
    } else {
      html += `<div style="font-size:12px; opacity:.7;">No RNs detected.</div>`;
    }

    box.innerHTML = html;
  }

  // ---------------------------------------------------------
  // Preview / OCR source builders
  // ---------------------------------------------------------
  function loadImg(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (!isBlobUrl(url)) img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Image load failed"));
      img.src = url;
    });
  }

  function rotateCanvasFromCanvas(sourceCanvas, deg) {
    const rad = (deg * Math.PI) / 180;
    const sw = sourceCanvas.width;
    const sh = sourceCanvas.height;

    const out = document.createElement("canvas");
    const ctx = out.getContext("2d");

    if (deg % 180 === 0) {
      out.width = sw;
      out.height = sh;
    } else {
      out.width = sh;
      out.height = sw;
    }

    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(sourceCanvas, -sw / 2, -sh / 2);
    return out;
  }

  async function buildCanvasFromImageUrl(imageUrl) {
    const img = await loadImg(imageUrl);
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    ctx.drawImage(img, 0, 0);
    return c;
  }

  async function getOcrSource(payload, deg) {
    if (isPdfPayload(payload)) {
      if (!window.scanPdf?.renderUrlToCanvas) {
        throw new Error("scanPdf.renderUrlToCanvas missing. Ensure PDF.js + app.scanPdf.js loaded before review.");
      }
      setStatus("Rendering PDF…");
      const pdfCanvas = await window.scanPdf.renderUrlToCanvas(payload.imageUrl, { scale: 2.75, pageNumber: 1 });

      if (deg && deg % 360 !== 0) {
        setStatus(`Rotating ${deg}°…`);
        return rotateCanvasFromCanvas(pdfCanvas, deg);
      }

      return pdfCanvas;
    }

    if (deg && deg % 360 !== 0) {
      setStatus(`Rotating ${deg}°…`);
      const c = await buildCanvasFromImageUrl(payload.imageUrl);
      return rotateCanvasFromCanvas(c, deg);
    }

    return payload.imageUrl;
  }

  async function setPreviewFromPayload(payload) {
    const imgEl = $("scanReviewImg");
    const noteEl = $("scanReviewPreviewNote");
    if (!imgEl) return;

    // CSV: hide image preview, show filename note
    if (isCsvPayload(payload)) {
      imgEl.style.display = "none";
      if (noteEl) {
        noteEl.style.display = "block";
        noteEl.innerHTML = `<b>CSV file:</b> ${esc(payload?.imagePath || payload?.file?.name || "—")}<br/><span style="opacity:.75;">Click “Parse CSV Now” to build the review.</span>`;
      }
      return;
    }

    // Non-CSV: show image preview
    imgEl.style.display = "block";
    if (noteEl) noteEl.style.display = "none";

    try {
      if (isPdfPayload(payload)) {
        if (!window.scanPdf?.renderUrlToCanvas) {
          imgEl.src = "";
          return;
        }
        setStatus("Rendering PDF preview…");
        const c = await window.scanPdf.renderUrlToCanvas(payload.imageUrl, { scale: 1.6, pageNumber: 1 });
        imgEl.src = c.toDataURL("image/png");
        return;
      }

      imgEl.src = payload?.imageUrl || "";
    } catch (e) {
      console.warn("[review] preview render failed:", e);
      imgEl.src = payload?.imageUrl || "";
    }
  }

  // ---------------------------------------------------------
  // CSV → Parse
  // ---------------------------------------------------------
  async function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("File read failed"));
      reader.readAsText(file);
    });
  }

  async function runCsvParse() {
    setError(null);

    const payload = window.__scanSessionPayload || {};
    const f = payload.file;

    if (!f) {
      setError("Missing CSV file handle. Re-open Import CSV and try again.");
      return;
    }
    if (!window.csvNormalizer?.normalizeCsvText) {
      setError("csvNormalizer.normalizeCsvText missing. Ensure app.csvNormalizer.js is loaded before review module.");
      return;
    }

    try {
      $("scanReviewRun").disabled = true;
      setStatus("Reading CSV…");
      const text = await readFileAsText(f);

      setStatus("Normalizing CSV…");
      const parsed = window.csvNormalizer.normalizeCsvText(text, {
        filename: payload.imagePath || f.name || "import.csv",
      });

      window.__lastScanOcr = { text }; // for debug parity
      window.__lastScanParsed = parsed;

      renderParsed(parsed);
      setStatus("Parsed ✅ Ready to apply.");
    } catch (e) {
      console.error(e);
      setError(`CSV parse failed: ${e?.message || e}`);
      setStatus("Error.");
    } finally {
      $("scanReviewRun").disabled = false;
    }
  }

  // ---------------------------------------------------------
  // OCR → Parse (existing)
  // ---------------------------------------------------------
  async function runOcrAndParse() {
    setError(null);

    const payload = window.__scanSessionPayload;
    if (!payload?.imageUrl) {
      setError("Missing payload imageUrl. Re-open Import and try again.");
      return;
    }

    if (!window.scanOcr?.runOcr) {
      setError("scanOcr.runOcr missing. Check script order + cache bust.");
      return;
    }
    if (!window.scanParserTemplateV2?.parse) {
      setError("scanParserTemplateV2.parse missing. Check script order + cache bust.");
      return;
    }

    try {
      const deg = window.__scanRotateDeg || 0;

      setStatus("Preparing source…");
      $("scanReviewRun").disabled = true;

      const source = await getOcrSource(payload, deg);

      setStatus("Running OCR…");
      const o = await window.scanOcr.runOcr(source, { minWidth: 3200 });

      window.__lastScanOcr = o;

      setStatus(`OCR done. textLen=${o.text?.length || 0}, words=${o.words?.length || 0}`);

      const parsed = window.scanParserTemplateV2.parse(o);
      window.__lastScanParsed = parsed;

      renderParsed(parsed);
      setStatus("Ready to apply.");
    } catch (e) {
      console.error(e);
      setError(`OCR/Parse failed: ${e?.message || e}`);
      setStatus("Error.");
    } finally {
      $("scanReviewRun").disabled = false;
    }
  }

  // ---------------------------------------------------------
  // APPLY TO LIVE (existing + EMPTY support)
  // ---------------------------------------------------------
  function getPatientsArray() {
    if (Array.isArray(window.patients)) return window.patients;
    if (Array.isArray(window.unitState?.patients)) return window.unitState.patients;
    if (Array.isArray(window.state?.patients)) return window.state.patients;
    return null;
  }

  function findPatientByRoom(room) {
    const patients = getPatientsArray();
    if (!patients) return null;

    const target = String(room || "").toUpperCase();
    for (let i = 0; i < patients.length; i++) {
      const p = patients[i];
      if (!p) continue;
      const pr = String(p.room || p.roomNumber || "").toUpperCase();
      if (pr === target) return p;
    }
    return null;
  }

  function buildRoomToPatientIdMap() {
    const patients = getPatientsArray();
    const map = new Map();
    if (!patients) return map;
    for (const p of patients) {
      if (!p) continue;
      const r = String(p.room || "").toUpperCase();
      if (!r) continue;
      if (typeof p.id === "number") map.set(r, p.id);
    }
    return map;
  }

  function clearSupportedFlags(p) {
    if (typeof p.tele === "boolean") p.tele = false;

    if (typeof p.isolation === "boolean") p.isolation = false;
    if (typeof p.sitter === "boolean") p.sitter = false;
    if (typeof p.bg === "boolean") p.bg = false;
    if (typeof p.nih === "boolean") p.nih = false;
    if (typeof p.admit === "boolean") p.admit = false;
    if (typeof p.ciwa === "boolean") p.ciwa = false;

    if (typeof p.drip === "boolean") p.drip = false;

    if (typeof p.reviewed === "boolean") p.reviewed = false;
  }

  function applyLevelAndTagsToPatient(p, level, tags) {
    const tagSet = new Set((tags || []).map(t => String(t).toUpperCase()));

    // EMPTY room semantics:
    // - mark room empty
    // - clear flags + notes
    // - optional clear name
    if (tagSet.has("EMPTY")) {
      clearSupportedFlags(p);

      if (typeof p.isEmpty === "boolean") p.isEmpty = true;
      if (typeof p.name === "string") p.name = "";
      if (typeof p.patientName === "string") p.patientName = "";
      p.acuityNotes = [];
      p.tags = [];

      if (typeof p.reviewed === "boolean") p.reviewed = true;
      return;
    }

    // Not empty → ensure occupied
    if (typeof p.isEmpty === "boolean") p.isEmpty = false;

    // Level mapping
    if (level === "Tele") {
      if (typeof p.tele === "boolean") p.tele = true;
    } else if (level === "MS") {
      if (typeof p.tele === "boolean") p.tele = false;
    }

    // Tags mapping
    if (typeof p.isolation === "boolean") p.isolation = tagSet.has("ISO");
    if (typeof p.sitter === "boolean") p.sitter = tagSet.has("SITTER");
    if (typeof p.bg === "boolean") p.bg = tagSet.has("BG");
    if (typeof p.nih === "boolean") p.nih = tagSet.has("NIH");
    if (typeof p.admit === "boolean") p.admit = tagSet.has("ADMIT");
    if (typeof p.ciwa === "boolean") p.ciwa = tagSet.has("CIWA");
    if (typeof p.drip === "boolean") p.drip = tagSet.has("GTT");

    // Friendly display list
    const notes = [];
    if (p.isolation) notes.push("ISO");
    if (p.sitter) notes.push("SITTER");
    if (p.bg) notes.push("BG");
    if (p.nih) notes.push("NIH");
    if (p.admit) notes.push("ADMIT");
    if (p.ciwa) notes.push("CIWA");
    if (tagSet.has("GTT")) notes.push("GTT");

    p.acuityNotes = notes;
    p.tags = notes;

    if (typeof p.reviewed === "boolean") p.reviewed = true;
  }

  function findStaffByName(list, name) {
    const target = normalizeName(name);
    if (!target) return null;
    const arr = Array.isArray(list) ? list : [];
    for (const s of arr) {
      const sn = normalizeName(s?.name);
      if (!sn) continue;
      if (sn === target) return s;
    }
    return null;
  }

  async function safeApplyParsedToLive({ parsed, unitId, sessionId, opts }) {
    try {
      const rns = Array.isArray(parsed?.rns) ? parsed.rns : [];
      const pcas = Array.isArray(parsed?.pcas) ? parsed.pcas : [];

      if (!rns.length && !pcas.length) {
        return { ok: false, error: "No RN or PCA rows detected in parsed data." };
      }

      const options = opts && typeof opts === "object" ? opts : {};
      const assignIfNamesMatch = options.assignIfNamesMatch !== false;
      const overwritePerRoom = options.overwritePerRoom !== false;

      const updates = [];
      for (const rn of rns) {
        for (const rr of (rn.rooms || [])) {
          const room = normalizeRoom(rr.room);
          if (!room) continue;

          const level = normalizeLevel(rr.levelOfCare);
          const tags = normalizeTags(rr.notes);

          // allow EMPTY-only updates even if no level/tags otherwise
          if (!level && !tags.length) continue;
          updates.push({ room, level, tags, rnName: String(rn.name || "").trim() });
        }
      }

      if (!updates.length) {
        return { ok: false, error: "Parsed data produced no room-level updates." };
      }

      const hooks = [
        window.applyImportRoomUpdatesToLive,
        window.applyRoomUpdatesToLive,
        window.applyScanRoomUpdatesToLive,
      ].filter(fn => typeof fn === "function");

      if (hooks.length) {
        const res = await hooks[0]({ updates, unitId, sessionId, opts: options });
        return res?.ok ? res : { ok: false, error: res?.error || "Apply hook failed." };
      }

      const patients = getPatientsArray();
      if (!patients) {
        return {
          ok: false,
          error:
            "No patient collection located. Expected window.patients (array). " +
            "Confirm app.state.js defines window.patients and script order is correct.",
        };
      }

      let appliedRooms = 0;
      for (const u of updates) {
        const p = findPatientByRoom(u.room);
        if (!p) continue;

        if (overwritePerRoom) clearSupportedFlags(p);
        applyLevelAndTagsToPatient(p, u.level, u.tags);

        appliedRooms++;
      }

      let rnAssigned = 0;
      let pcaAssigned = 0;

      if (assignIfNamesMatch) {
        const roomToPid = buildRoomToPatientIdMap();

        if (Array.isArray(window.currentNurses) && window.currentNurses.length) {
          for (const rn of rns) {
            const staff = findStaffByName(window.currentNurses, rn?.name);
            if (!staff) continue;

            const ids = [];
            for (const rr of (rn.rooms || [])) {
              const room = normalizeRoom(rr.room);
              const pid = roomToPid.get(room);
              if (typeof pid === "number") ids.push(pid);
            }

            staff.patients = ids;
            rnAssigned++;
          }
        }

        if (Array.isArray(window.currentPcas) && window.currentPcas.length) {
          for (const pca of pcas) {
            const staff = findStaffByName(window.currentPcas, pca?.name);
            if (!staff) continue;

            const ids = [];
            for (const roomRaw of (pca.rooms || [])) {
              const room = normalizeRoom(roomRaw);
              const pid = roomToPid.get(room);
              if (typeof pid === "number") ids.push(pid);
            }

            staff.patients = ids;
            pcaAssigned++;
          }
        }
      }

      // Persist + refresh
      try { if (typeof window.saveState === "function") window.saveState(); } catch (_) {}
      try { if (typeof window.markDirty === "function") window.markDirty(); } catch (_) {}

      try { if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles(); } catch (_) {}
      try { if (typeof window.renderPatientList === "function") window.renderPatientList(); } catch (_) {}
      try { if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments(); } catch (_) {}
      try { if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput(); } catch (_) {}
      try { if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput(); } catch (_) {}
      try { if (typeof window.renderQueueList === "function") window.renderQueueList(); } catch (_) {}
      try { if (typeof window.unitPulse?.refresh === "function") window.unitPulse.refresh(); } catch (_) {}

      try {
        if (typeof window.appendEvent === "function") {
          const payload = window.__scanSessionPayload || {};
          window.appendEvent({
            type: "import_assignment_apply",
            source: "review",
            mode: isCsvPayload(payload) ? "csv" : "pdf/ocr",
            unitId: unitId || window.activeUnitId || null,
            sessionId: sessionId || null,
            appliedRooms,
            rnAssigned,
            pcaAssigned,
            totalUpdates: updates.length,
            ts: Date.now(),
          });
        }
      } catch (_) {}

      return { ok: true, appliedRooms, totalUpdates: updates.length, rnAssigned, pcaAssigned };
    } catch (e) {
      console.error(e);
      return { ok: false, error: e?.message || String(e) };
    }
  }

  window.applyScanParsedToLive = safeApplyParsedToLive;

  async function applyToLive() {
    setError(null);

    const payload = window.__scanSessionPayload;
    const parsed = window.__lastScanParsed;

    if (!parsed) {
      setError('No parsed data yet. Click "Run/Parse" first.');
      return;
    }

    try {
      setStatus("Applying to LIVE…");
      const res = await window.applyScanParsedToLive({
        parsed,
        unitId: payload?.unitId || window.activeUnitId,
        sessionId: payload?.sessionId || null,
        opts: { overwritePerRoom: true, assignIfNamesMatch: true },
      });

      if (!res?.ok) {
        setError(`Apply failed: ${res?.error || "unknown error"}`);
        setStatus("Apply failed.");
        return;
      }

      setStatus(`Applied ✅ (rooms updated: ${res.appliedRooms ?? "?"}, RN matched: ${res.rnAssigned ?? 0}, PCA matched: ${res.pcaAssigned ?? 0})`);
    } catch (e) {
      console.error(e);
      setError(`Apply error: ${e?.message || e}`);
      setStatus("Apply failed.");
    }
  }

  // ---------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------
  async function openScanReview(payload) {
    ensureModal();

    window.__scanSessionPayload = payload || null;
    window.__lastScanOcr = null;
    window.__lastScanParsed = null;

    window.__scanRotateDeg = 0;
    updateRotationUi();

    setError(null);
    setCounts({ rns: 0, pcas: 0, rnRooms: 0 });

    const isPdf = isPdfPayload(payload);
    const isCsv = isCsvPayload(payload);

    $("scanReviewSession").textContent = payload?.sessionId || "—";
    $("scanReviewUnit").textContent = payload?.unitId || "—";
    $("scanReviewFileType").textContent = isCsv ? "CSV" : (isPdf ? "PDF" : "Image");

    // Button labeling based on mode
    const runBtn = $("scanReviewRun");
    const subtitle = $("scanReviewSubtitle");
    if (runBtn) runBtn.textContent = isCsv ? "Parse CSV Now" : "Run OCR Now";
    if (subtitle) subtitle.textContent = isCsv
      ? "CSV import is deterministic. Parse and verify before applying."
      : "Verify rooms, Tele/MS, and acuity notes before applying.";

    // Rotation controls only for image OCR mode
    const rotWrap = $("scanReviewRotateWrap");
    const allowRotate = !isPdf && !isCsv;
    if (rotWrap) rotWrap.style.opacity = allowRotate ? "1" : "0.45";
    $("scanReviewRotateLeft").disabled = !allowRotate;
    $("scanReviewRotateRight").disabled = !allowRotate;

    $("scanReviewParsed").innerHTML = `<div style="font-size:12px; opacity:.7;">No parsed data yet.</div>`;
    setStatus(isCsv ? 'No parsed data yet. Click "Parse CSV Now".' : 'No parsed data yet. Click "Run OCR Now".');

    $("scanReviewModal").style.display = "flex";

    await setPreviewFromPayload(payload);
  }

  window.openScanReview = openScanReview;
})();