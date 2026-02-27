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
//
// Notes / Fixes:
// ✅ PCA parsing robustness: accepts pca.rooms as strings OR objects ({room})
// ✅ Leadership persistence + UI injection:
//    - stores on window.unitLeadership + window.currentLeadership
//    - best-effort writes to common leadership input IDs (current + incoming)
// ✅ Leadership apply is "do no harm":
//    - applies only if confident (≥2 roles OR leadershipMeta.confident)
//    - never overwrites existing roles with blanks
// ✅ Apply never calls setupCurrentNurses/setupCurrentPcas (prevents overwrite)
// ✅ Review panel renders PCA rooms robustly (no more “[object Object]”)
// ✅ PERFORMANCE: batch import mode prevents per-flag re-render storms
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
    if (/\bISO\b/.test(joined) || /\bISOL\b/.test(joined)) tags.add("ISO");
    if (/\bSITTER\b/.test(joined) || /\bSIT\b/.test(joined)) tags.add("SITTER");
    if (/\bBG\b/.test(joined)) tags.add("BG");
    if (/\bNIH\b/.test(joined)) tags.add("NIH");
    if (/\bADMIT\b/.test(joined) || /\bADM\b/.test(joined)) tags.add("ADMIT");
    if (/\bLATE\s*D\/?C\b/.test(joined) || /\bLATE\s*DC\b/.test(joined)) tags.add("LATE_DC");
    if (/\bCIWA\b/.test(joined)) tags.add("CIWA");
    if (/\bVPO\b/.test(joined)) tags.add("VPO");
    if (/\bRESTRAINTS?\b/.test(joined)) tags.add("RESTRAINT");
    if (/\bGTT\b/.test(joined) || /\bDRIP\b/.test(joined)) tags.add("GTT");
    if (/\bEMPTY\b/.test(joined) || /\bOPEN\b/.test(joined) || /\bVACANT\b/.test(joined)) tags.add("EMPTY");

    return Array.from(tags);
  }

  function uniqNumbers(arr) {
    const out = [];
    const seen = new Set();
    (Array.isArray(arr) ? arr : []).forEach((x) => {
      const n = Number(x);
      if (!Number.isFinite(n)) return;
      if (seen.has(n)) return;
      seen.add(n);
      out.push(n);
    });
    return out;
  }

  function normalizeRoomTokenForPreview(roomLike) {
    // for UI preview only
    if (roomLike == null) return "";
    if (typeof roomLike === "string" || typeof roomLike === "number") return normalizeRoom(String(roomLike));
    if (typeof roomLike === "object") {
      const rr = roomLike.room || roomLike.bed || roomLike.roomNumber || roomLike.id || "";
      return normalizeRoom(String(rr));
    }
    return "";
  }

  function coercePcaRoomsList(pca) {
    // Accept:
    // - { rooms:["201A","202B"] }
    // - { rooms:[{room:"201A"},{room:"202B"}] }
    // - { patients:["201A",...]} (rare parser variants)
    const rooms = Array.isArray(pca?.rooms) ? pca.rooms : (Array.isArray(pca?.patients) ? pca.patients : []);
    const list = [];
    for (const x of rooms) {
      const tok = normalizeRoomTokenForPreview(x);
      if (tok) list.push(tok);
    }
    return list;
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

  function getParsedLeadership(parsed) {
    const lead = parsed?.leadership || parsed?.leaders || parsed?.lead || null;
    if (!lead || typeof lead !== "object") return null;

    const charge = lead.charge || lead.chargeNurse || lead.charge_nurse || lead.Charge || lead["Charge Nurse"] || "";
    const mentor = lead.mentor || lead.clinicalMentor || lead.clinical_mentor || lead.Mentor || lead["Clinical Mentor"] || "";
    const cta = lead.cta || lead.CTA || lead["CTA"] || "";

    const out = {
      charge: String(charge || "").trim(),
      mentor: String(mentor || "").trim(),
      cta: String(cta || "").trim(),
    };

    if (!out.charge && !out.mentor && !out.cta) return null;
    return out;
  }

  function getLeadershipConfidence(parsed, leadershipObj) {
    const meta = parsed?.leadershipMeta || null;
    if (meta && typeof meta === "object") {
      if (meta.confident === true) return true;
    }
    const l = leadershipObj || null;
    if (!l) return false;
    const found = [l.charge, l.mentor, l.cta].filter(Boolean).length;
    return found >= 2;
  }

  function setValueIfExists(ids, value) {
    for (const id of (ids || [])) {
      const el = document.getElementById(id);
      if (!el) continue;
      try {
        if ("value" in el) el.value = String(value || "");
        else el.textContent = String(value || "");
        return true;
      } catch (_) {}
    }
    return false;
  }

  function applyLeadershipToUi(leadership) {
    if (!leadership) return false;

    // Best-effort: support both Current + Incoming ids (so print/live/oncoming can read consistently)
    const ok1 = setValueIfExists(
      ["currentChargeName", "chargeName", "liveChargeName", "chargeNurseName", "currentChargeNurseName"],
      leadership.charge
    );
    const ok2 = setValueIfExists(
      ["currentMentorName", "mentorName", "liveMentorName", "clinicalMentorName", "currentClinicalMentorName"],
      leadership.mentor
    );
    const ok3 = setValueIfExists(
      ["currentCtaName", "ctaName", "liveCtaName"],
      leadership.cta
    );

    // Also write incoming equivalents if present (harmless; keeps parity)
    setValueIfExists(["incomingChargeName"], leadership.charge);
    setValueIfExists(["incomingMentorName"], leadership.mentor);
    setValueIfExists(["incomingCtaName"], leadership.cta);

    return !!(ok1 || ok2 || ok3);
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
      setStatus('Rotation updated. Click "Run/Parse" again.');
    });

    $("scanReviewRotateRight").addEventListener("click", () => {
      window.__scanRotateDeg = ((window.__scanRotateDeg || 0) + 90) % 360;
      updateRotationUi();
      setStatus('Rotation updated. Click "Run/Parse" again.');
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

  function setCounts({ rns = 0, pcas = 0, rnRooms = 0, leadership = 0 } = {}) {
    const el = $("scanReviewCounts");
    if (el) el.textContent = `RNs: ${rns} • PCAs: ${pcas} • RN room rows: ${rnRooms}${leadership ? " • Leadership: ✓" : ""}`;
  }

  function updateRotationUi() {
    const deg = window.__scanRotateDeg || 0;
    const el = $("scanReviewRotation");
    if (el) el.textContent = `${deg}°`;
  }

  function renderParsed(parsed) {
    const box = $("scanReviewParsed");
    if (!box) return;

    const rns = Array.isArray(parsed?.rns) ? parsed.rns : [];
    const pcas = Array.isArray(parsed?.pcas) ? parsed.pcas : [];
    const leadership = getParsedLeadership(parsed);
    const leadershipConf = getLeadershipConfidence(parsed, leadership);

    const rnRoomRows = rns.reduce((sum, rn) => sum + (Array.isArray(rn.rooms) ? rn.rooms.length : 0), 0);
    setCounts({ rns: rns.length, pcas: pcas.length, rnRooms: rnRoomRows, leadership: leadershipConf ? 1 : 0 });

    if (!pcas.length && !rns.length && !leadership) {
      box.innerHTML = `<div style="font-size:12px; opacity:.7;">No PCAs detected.<br>No RNs detected.<br>No leadership detected.</div>`;
      return;
    }

    let html = "";

    if (leadership) {
      const confNote = leadershipConf ? "" : `<div style="margin-top:6px; opacity:.7;">(Not confident — will not apply automatically)</div>`;
      html += `<div style="font-weight:800; margin-bottom:8px;">Leadership</div>`;
      html += `
        <div style="border:1px solid #eee; border-radius:12px; padding:10px; margin-bottom:12px; font-size:12px;">
          <div><b>Charge:</b> ${esc(leadership.charge || "—")}</div>
          <div><b>Clinical Mentor:</b> ${esc(leadership.mentor || "—")}</div>
          <div><b>CTA:</b> ${esc(leadership.cta || "—")}</div>
          ${confNote}
        </div>
      `;
    }

    if (pcas.length) {
      html += `<div style="font-weight:800; margin-bottom:8px;">PCAs</div>`;
      for (const p of pcas) {
        const rooms = coercePcaRoomsList(p);
        html += `
          <div style="border:1px solid #eee; border-radius:12px; padding:10px; margin-bottom:10px;">
            <div style="font-weight:700;">${esc(p.name || "PCA")}${p.count != null ? ` <span style="opacity:.6; font-weight:600;">(${esc(p.count)})</span>` : ""}</div>
            <div style="font-size:12px; opacity:.8; margin-top:6px;">${esc(rooms.join(", "))}</div>
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

    if (Array.isArray(parsed?.warnings) && parsed.warnings.length) {
      html += `
        <div style="margin-top:10px; border:1px dashed #ddd; border-radius:12px; padding:10px; font-size:12px;">
          <div style="font-weight:800; margin-bottom:6px;">Warnings</div>
          <ul style="margin:0; padding-left:18px;">
            ${parsed.warnings.map(w => `<li style="opacity:.8;">${esc(w)}</li>`).join("")}
          </ul>
        </div>
      `;
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

    if (isCsvPayload(payload)) {
      imgEl.style.display = "none";
      if (noteEl) {
        noteEl.style.display = "block";
        noteEl.innerHTML = `<b>CSV file:</b> ${esc(payload?.imagePath || payload?.file?.name || "—")}<br/><span style="opacity:.75;">Click “Parse CSV Now” to build the review.</span>`;
      }
      return;
    }

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

      window.__lastScanOcr = { text };
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
  // OCR → Parse
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
  // APPLY TO LIVE
  // ---------------------------------------------------------
  function getPatientsArray() {
    if (Array.isArray(window.patients)) return window.patients;
    if (Array.isArray(window.unitState?.patients)) return window.unitState.patients;
    if (Array.isArray(window.state?.patients)) return window.state.patients;
    return null;
  }

  function findPatientByRoom(room) {
    if (typeof window.getPatientByRoom === "function") {
      try {
        const p = window.getPatientByRoom(room);
        if (p) return p;
      } catch (_) {}
    }

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
    const boolKeys = [
      "tele",
      "drip",
      "nih",
      "bg",
      "bgChecks",
      "ciwa",
      "cows",
      "ciwaCows",
      "restraint",
      "restraints",
      "sitter",
      "vpo",
      "isolation",
      "iso",
      "admit",
      "lateDc",
      "lateDC",
      "latedc",
    ];
    for (const key of boolKeys) {
      if (typeof p[key] === "boolean") p[key] = false;
    }
    if (typeof p.reviewed === "boolean") p.reviewed = false;
  }

  function setFlagViaUiHandler(p, key, checked) {
    if (!p || typeof p.id !== "number") return;

    // ✅ Batch-import mode: avoid re-render storms from togglePatientFlag
    if (window.__importBatching === true) {
      if (typeof p[key] === "boolean") p[key] = !!checked;
      return;
    }

    if (typeof window.togglePatientFlag === "function") {
      try {
        window.togglePatientFlag(p.id, key, !!checked);
        return;
      } catch (e) {
        console.warn("[import] togglePatientFlag failed, falling back to direct set:", key, e);
      }
    }

    if (typeof p[key] === "boolean") p[key] = !!checked;
  }

  function applyLevelAndTagsToPatient(p, level, tags) {
    const tagSet = new Set((tags || []).map(t => String(t).toUpperCase()));

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

    if (typeof p.isEmpty === "boolean") p.isEmpty = false;

    if (level === "Tele") setFlagViaUiHandler(p, "tele", true);
    else if (level === "MS") setFlagViaUiHandler(p, "tele", false);

    setFlagViaUiHandler(p, "isolation", tagSet.has("ISO"));
    setFlagViaUiHandler(p, "sitter", tagSet.has("SITTER"));
    setFlagViaUiHandler(p, "bg", tagSet.has("BG"));
    setFlagViaUiHandler(p, "nih", tagSet.has("NIH"));
    setFlagViaUiHandler(p, "admit", tagSet.has("ADMIT"));
    setFlagViaUiHandler(p, "lateDc", tagSet.has("LATE_DC"));
    setFlagViaUiHandler(p, "ciwa", tagSet.has("CIWA"));
    setFlagViaUiHandler(p, "vpo", tagSet.has("VPO"));
    setFlagViaUiHandler(p, "restraint", tagSet.has("RESTRAINT"));
    setFlagViaUiHandler(p, "drip", tagSet.has("GTT"));

    if (typeof p.bgChecks === "boolean") p.bgChecks = !!p.bg;
    if (typeof p.cows === "boolean") p.cows = !!p.ciwa;
    if (typeof p.ciwaCows === "boolean") p.ciwaCows = !!p.ciwa;
    if (typeof p.iso === "boolean") p.iso = !!p.isolation;
    if (typeof p.lateDC === "boolean") p.lateDC = !!p.lateDc;
    if (typeof p.latedc === "boolean") p.latedc = !!p.lateDc;
    if (typeof p.restraints === "boolean") p.restraints = !!p.restraint;

    const notes = [];
    if (tagSet.has("ISO")) notes.push("ISO");
    if (tagSet.has("SITTER")) notes.push("SITTER");
    if (tagSet.has("BG")) notes.push("BG");
    if (tagSet.has("NIH")) notes.push("NIH");
    if (tagSet.has("ADMIT")) notes.push("ADMIT");
    if (tagSet.has("LATE_DC")) notes.push("LATE DC");
    if (tagSet.has("CIWA")) notes.push("CIWA");
    if (tagSet.has("VPO")) notes.push("VPO");
    if (tagSet.has("RESTRAINT")) notes.push("RESTRAINT");
    if (tagSet.has("GTT")) notes.push("GTT");

    p.acuityNotes = notes;
    p.tags = notes;

    if (typeof p.reviewed === "boolean") p.reviewed = true;
  }

  function buildRosterFromParsed(parsed) {
    const rns = Array.isArray(parsed?.rns) ? parsed.rns : [];
    const pcas = Array.isArray(parsed?.pcas) ? parsed.pcas : [];

    const roomToPid = buildRoomToPatientIdMap();

    const newNurses = rns.map((rn, idx) => {
      const ids = [];
      for (const rr of (rn.rooms || [])) {
        const room = normalizeRoom(rr?.room);
        const pid = roomToPid.get(room);
        if (typeof pid === "number") ids.push(pid);
      }
      return {
        id: idx + 1,
        name: String(rn?.name || "").trim(),
        patients: uniqNumbers(ids),
        max: 10,
        type: rn?.type || "RN",
        staff_id: null,
        restrictions: rn?.restrictions || undefined,
      };
    });

    const newPcas = pcas.map((pca, idx) => {
      const ids = [];
      const rooms = coercePcaRoomsList(pca);
      for (const roomRaw of rooms) {
        const room = normalizeRoom(roomRaw);
        const pid = roomToPid.get(room);
        if (typeof pid === "number") ids.push(pid);
      }
      return {
        id: idx + 1,
        name: String(pca?.name || "").trim(),
        patients: uniqNumbers(ids),
        max: 7,
        type: "PCA",
        staff_id: null,
        restrictions: (pca?.restrictions && typeof pca.restrictions === "object") ? pca.restrictions : { noIso: false },
      };
    });

    return { newNurses, newPcas };
  }

  function applyLeadershipToState(leadership, parsed) {
    if (!leadership) return { applied: false, reason: "missing" };

    const confident = getLeadershipConfidence(parsed, leadership);
    if (!confident) return { applied: false, reason: "not_confident" };

    const incoming = {
      charge: String(leadership.charge || "").trim(),
      mentor: String(leadership.mentor || "").trim(),
      cta: String(leadership.cta || "").trim(),
    };

    // Merge (do-no-harm): never overwrite existing roles with blanks
    const existing = window.unitLeadership || window.currentLeadership || window.unitState?.leadership || {};
    const merged = {
      charge: incoming.charge || existing.charge || "",
      mentor: incoming.mentor || existing.mentor || "",
      cta: incoming.cta || existing.cta || "",
    };

    const foundAfter = [merged.charge, merged.mentor, merged.cta].filter(Boolean).length;
    if (foundAfter < 2) return { applied: false, reason: "too_empty_after_merge" };

    // Canonical-ish locations for other modules to read:
    window.unitLeadership = merged;
    window.currentLeadership = merged;
    window.__currentLeadership = merged;

    // If a unitState object exists, tuck it there too (non-destructive):
    if (window.unitState && typeof window.unitState === "object") {
      window.unitState.leadership = merged;
      window.unitState.currentLeadership = merged;
    }

    // Best-effort: also push into UI inputs so Staffing Details + print modules can read values.
    applyLeadershipToUi(merged);

    return { applied: true };
  }

  // IMPORTANT: DO NOT call setupCurrentNurses/setupCurrentPcas during import,
  // because those functions can rehydrate from saved state and overwrite the imported roster.
  function syncStaffingUiAfterRosterReplace({ rnCount, pcaCount }) {
    // best-effort: set the count selects if they exist, then render lists
    try {
      const pcaCountIds = ["currentPcasCount", "currentPcaCount", "currentPcaSelect", "pcaCount", "pcaCountSelect", "currentPcas"];
      for (const id of pcaCountIds) {
        const el = document.getElementById(id);
        if (el && ("value" in el)) { el.value = String(pcaCount || 0); break; }
      }
    } catch (_) {}

    try {
      const rnCountIds = ["currentNursesCount", "currentRnCount", "currentRnSelect", "rnCount", "rnCountSelect", "currentRnsCount", "currentRns"];
      for (const id of rnCountIds) {
        const el = document.getElementById(id);
        if (el && ("value" in el)) { el.value = String(rnCount || 0); break; }
      }
    } catch (_) {}

    // Render only (never setup)
    try { if (typeof window.renderCurrentNurseList === "function") window.renderCurrentNurseList(); } catch (_) {}
    try { if (typeof window.renderCurrentPcaList === "function") window.renderCurrentPcaList(); } catch (_) {}
  }

  async function safeApplyParsedToLive({ parsed, unitId, sessionId, opts }) {
    // PERF: batch import mode (avoid per-toggle re-render storms)
    window.__importBatching = true;

    try {
      const rns = Array.isArray(parsed?.rns) ? parsed.rns : [];
      const pcas = Array.isArray(parsed?.pcas) ? parsed.pcas : [];
      const leadership = getParsedLeadership(parsed);

      if (!rns.length && !pcas.length && !leadership) {
        return { ok: false, error: "No RN, PCA, or leadership rows detected in parsed data." };
      }

      const options = opts && typeof opts === "object" ? opts : {};
      const overwritePerRoom = options.overwritePerRoom !== false;
      const replaceRoster = options.replaceRoster !== false;
      const mode = String(options.mode || "").toLowerCase();
      const isCsvMode = mode === "csv";

      // Build room-level updates from RN rooms
      const updates = [];
      for (const rn of rns) {
        for (const rr of (rn.rooms || [])) {
          const room = normalizeRoom(rr?.room);
          if (!room) continue;
          const level = normalizeLevel(rr?.levelOfCare);
          const tags = normalizeTags(rr?.notes);
          if (!level && !tags.length) continue;
          updates.push({ room, level, tags });
        }
      }

      // CSV mode: clear supported acuity flags across all patients first,
      // then apply only flags explicitly present in parsed CSV rows.
      if (isCsvMode && overwritePerRoom) {
        const allPatients = getPatientsArray();
        for (const p of allPatients) {
          if (!p) continue;
          clearSupportedFlags(p);
        }
      }

      // Apply per-room updates (patient flags)
      for (const u of updates) {
        const p = findPatientByRoom(u.room);
        if (!p) continue;
        if (!isCsvMode && overwritePerRoom) clearSupportedFlags(p);
        applyLevelAndTagsToPatient(p, u.level, u.tags);
      }

      let appliedRooms = 0;
      for (const u of updates) {
        const p = findPatientByRoom(u.room);
        if (p) appliedRooms++;
      }

      // Leadership (do-no-harm + confidence gating)
      let leadershipApplied = 0;
      let leadershipReason = "";
      if (leadership) {
        const res = applyLeadershipToState(leadership, parsed);
        leadershipApplied = res.applied ? 1 : 0;
        leadershipReason = res.reason || "";
      }

      // Debug flags
      try {
        parsed.leadershipApplied = !!leadershipApplied;
        parsed.leadershipAppliedReason = leadershipReason || "";
        window.__lastScanParsed = window.__lastScanParsed || {};
        window.__lastScanParsed.leadershipApplied = parsed.leadershipApplied;
        window.__lastScanParsed.leadershipAppliedReason = parsed.leadershipAppliedReason;
      } catch (_) {}

      let rnAssigned = 0;
      let pcaAssigned = 0;

      if (replaceRoster) {
        const { newNurses, newPcas } = buildRosterFromParsed(parsed);

        // Replace canonical arrays
        window.currentNurses = Array.isArray(newNurses) ? newNurses : [];
        window.currentPcas = Array.isArray(newPcas) ? newPcas : [];

        rnAssigned = window.currentNurses.length;
        pcaAssigned = window.currentPcas.length;

        // Persist immediately so any wrappers don’t “snap back”
        try { if (typeof window.saveState === "function") window.saveState(); } catch (_) {}

        // Update staffing UI without calling setup
        syncStaffingUiAfterRosterReplace({ rnCount: rnAssigned, pcaCount: pcaAssigned });
      }

      // Turn off batching BEFORE render calls (so normal UI interactions behave)
      window.__importBatching = false;

      // Global refresh
      try { if (typeof window.markDirty === "function") window.markDirty(); } catch (_) {}

      try { if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles(); } catch (_) {}
      try { if (typeof window.renderPatientList === "function") window.renderPatientList(); } catch (_) {}
      try { if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments(); } catch (_) {}

      // Oncoming renderers are harmless if present (keeps other panels consistent)
      try { if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput(); } catch (_) {}
      try { if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput(); } catch (_) {}

      try { if (typeof window.renderQueueList === "function") window.renderQueueList(); } catch (_) {}
      try { if (typeof window.unitPulse?.refresh === "function") window.unitPulse.refresh(); } catch (_) {}

      // Let printLive module refresh derived headers if it has a hook
      try { if (typeof window.printLive?.refreshHeaders === "function") window.printLive.refreshHeaders(); } catch (_) {}

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
            leadershipApplied,
            leadershipReason: leadershipReason || "",
            leadership: leadership || null,
            leadershipMeta: parsed?.leadershipMeta || null,
            totalUpdates: updates.length,
            rosterReplaced: !!replaceRoster,
            ts: Date.now(),
          });
        }
      } catch (_) {}

      return { ok: true, appliedRooms, totalUpdates: updates.length, rnAssigned, pcaAssigned, leadershipApplied, leadershipReason, rosterReplaced: !!replaceRoster };
    } catch (e) {
      console.error(e);
      return { ok: false, error: e?.message || String(e) };
    } finally {
      // Always clear batching
      window.__importBatching = false;
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
      const isCsv = isCsvPayload(payload);

      setStatus("Applying to LIVE…");
      const res = await window.applyScanParsedToLive({
        parsed,
        unitId: payload?.unitId || window.activeUnitId,
        sessionId: payload?.sessionId || null,
        opts: {
          overwritePerRoom: true,
          replaceRoster: true,
          mode: isCsv ? "csv" : "pdf/ocr",
        },
      });

      if (!res?.ok) {
        setError(`Apply failed: ${res?.error || "unknown error"}`);
        setStatus("Apply failed.");
        return;
      }

      const leadTxt = res.leadershipApplied ? ", leadership: ✓" : (res.leadershipReason ? `, leadership: ✕ (${res.leadershipReason})` : "");
      setStatus(`Applied ✅ (rooms updated: ${res.appliedRooms ?? "?"}, RN roster: ${res.rnAssigned ?? 0}, PCA roster: ${res.pcaAssigned ?? 0}${leadTxt})`);
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

    const runBtn = $("scanReviewRun");
    const subtitle = $("scanReviewSubtitle");
    if (runBtn) runBtn.textContent = isCsv ? "Parse CSV Now" : "Run OCR Now";
    if (subtitle) subtitle.textContent = isCsv
      ? "CSV import is deterministic. Parse and verify before applying."
      : "Verify rooms, Tele/MS, and acuity notes before applying.";

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
