/* =========================================================
   app/app.printOncoming.js
   - In-page print (hidden iframe) to avoid popup blockers
   - Two print modes: New / Expanded and Traditional
   - New mode prints RN/PCA without Prev. RN/Prev. PCA columns
========================================================= */

(function () {
  "use strict";

  window.app = window.app || {};

  function getValueById(id) {
    const el = document.getElementById(id);
    if (!el) return "";
    return (el.value || el.textContent || "").trim();
  }

  function stripPins(s) {
    return String(s || "")
      .replace(/[\u{1F4CC}\u{1F4CD}\u{1F4CE}]/gu, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatMonDay(d) {
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    return `${months[d.getMonth()]}-${d.getDate()}`;
  }

  function roomSortKey(label) {
    const s = String(label || "");
    const m = s.match(/(\d+)/);
    const n = m ? Number(m[1]) : 9999;
    const suffix = s.replace(/\d+/g, "").toUpperCase();
    return `${String(n).padStart(4, "0")}-${suffix}`;
  }

  function getRoomLabelForPrint(p) {
    try {
      if (typeof window.getRoomLabelForPatient === "function") {
        return stripPins(window.getRoomLabelForPatient(p) || "");
      }
    } catch (_) {}
    return stripPins(p?.room || p?.id || "");
  }

  function getShiftTypeLabel(rnCards, pcaCards) {
    const fromFinalize = String(getValueById("finalizeShiftType") || "").toLowerCase();
    if (fromFinalize === "day") return "DAY";
    if (fromFinalize === "night") return "NOC";

    const all = []
      .concat(rnCards || [])
      .concat(pcaCards || [])
      .flatMap((c) => c?.rows || [])
      .map((r) => String(r?.from || "").toUpperCase());

    if (all.some((s) => s.includes("NOC") || s.includes("NIGHT"))) return "NOC";
    if (all.some((s) => s.includes("DAY"))) return "DAY";
    return "-";
  }

  function getShiftDateLabel() {
    const raw = String(getValueById("finalizeShiftDate") || "").trim();
    if (raw) {
      const d = new Date(`${raw}T00:00:00`);
      if (!Number.isNaN(d.getTime())) return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
    }
    const now = new Date();
    return `${now.getMonth() + 1}/${now.getDate()}/${String(now.getFullYear()).slice(-2)}`;
  }

  function getOpenRoomLabels() {
    const pts = Array.isArray(window.patients) ? window.patients : [];
    return pts
      .filter((p) => p && p.isEmpty)
      .map((p) => getRoomLabelForPrint(p))
      .filter(Boolean)
      .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));
  }

  function getActivePatients() {
    const pts = Array.isArray(window.patients) ? window.patients : [];
    return pts.filter((p) => p && !p.isEmpty);
  }

  function roomsForTag(tagKey) {
    return getActivePatients()
      .filter((p) => {
        if (!p) return false;
        if (tagKey === "strictIo") return !!(p.strictIo || p.heavy);
        return !!p[tagKey];
      })
      .map((p) => getRoomLabelForPrint(p))
      .filter(Boolean)
      .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));
  }

  function roomsLine(tagKey) {
    const rooms = roomsForTag(tagKey);
    return rooms.length ? rooms.join(", ") : "None";
  }

  const EDITABLE_SECTIONS = [
    { id: "drips", label: "Drips", autoKey: "drip" },
    { id: "special_procedures", label: "Special Procedures", autoKey: "" },
    { id: "tube_feeds", label: "Tube Feeds", autoKey: "tf" },
    { id: "wounds", label: "Wounds", autoKey: "" },
    { id: "central_lines", label: "Central Lines", autoKey: "" },
    { id: "isolations", label: "Isolations", autoKey: "isolation" },
    { id: "nih", label: "NIH", autoKey: "nih" },
    { id: "ciwa", label: "CIWA", autoKey: "ciwa" },
    { id: "sitters", label: "Sitters", autoKey: "sitter" },
    { id: "co", label: "C/O", autoKey: "" },
    { id: "restraints", label: "Restraints", autoKey: "restraint" },
    { id: "special_endorsements", label: "Special Endorsements", autoKey: "" },
  ];

  const AUTOFILL_SECTIONS = [
    { id: "admits", label: "Admits", autoKey: "admit" },
    { id: "discharges", label: "D/C", autoKey: "lateDc" },
    { id: "foley", label: "Foley Catheters", autoKey: "foley" },
    { id: "strict_ios", label: "Strict I's & O's", autoKey: "strictIo" },
    { id: "bg", label: "Blood Glucose", autoKey: "bg" },
  ];

  function buildDefaultHighRiskDraft() {
    const details = {};
    const roomDetails = {};
    EDITABLE_SECTIONS.forEach((s) => {
      details[s.id] = "";
      roomDetails[s.id] = {};
    });
    return { details, roomDetails, updatedAt: new Date().toISOString() };
  }

  function normalizeHandoffDraft(rawObj) {
    const base = buildDefaultHighRiskDraft();
    const src = (rawObj && typeof rawObj === "object") ? rawObj : {};
    const detailsSrc = (src.details && typeof src.details === "object") ? src.details : {};
    const roomDetailsSrc = (src.roomDetails && typeof src.roomDetails === "object") ? src.roomDetails : {};
    const editableSrc = (src.editable && typeof src.editable === "object") ? src.editable : {};

    // Legacy compatibility: map old draft fields into editable sections
    if (!detailsSrc.drips && src.dripByRoom && typeof src.dripByRoom === "object") {
      const lines = Object.keys(src.dripByRoom)
        .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)))
        .map((room) => `${room} - ${String(src.dripByRoom[room] || "").trim()}`)
        .filter(Boolean);
      if (lines.length) detailsSrc.drips = lines.join("\n");
    }
    if (!detailsSrc.special_endorsements && src.endorsements) {
      detailsSrc.special_endorsements = String(src.endorsements || "").trim();
    }

    // Legacy editor v1 wrote full text into editable[id]; map that into details.
    EDITABLE_SECTIONS.forEach((s) => {
      const fromDetails = String(detailsSrc[s.id] || "").trim();
      if (fromDetails) {
        base.details[s.id] = fromDetails;
        if (s.autoKey) {
          fromDetails
            .split(/\r?\n/)
            .map((line) => String(line || "").trim())
            .filter(Boolean)
            .forEach((line) => {
              const m = line.match(/^([A-Za-z0-9]+)\s*-\s*(.+)$/);
              if (m) base.roomDetails[s.id][m[1].trim()] = m[2].trim();
            });
        }
        return;
      }

      const legacy = String(editableSrc[s.id] || "").trim();
      if (!legacy || legacy === "None") return;

      const auto = s.autoKey ? roomsLine(s.autoKey) : "None";
      // If legacy value is just the auto rooms line, keep details empty.
      if (legacy === auto) return;
      base.details[s.id] = legacy;
    });
    EDITABLE_SECTIONS.forEach((s) => {
      const srcObj = roomDetailsSrc[s.id];
      if (!srcObj || typeof srcObj !== "object") return;
      Object.keys(srcObj).forEach((room) => {
        const txt = String(srcObj[room] || "").trim();
        if (txt) base.roomDetails[s.id][room] = txt;
      });
    });
    return base;
  }

  function loadHandoffDraft() {
    try {
      const raw = localStorage.getItem("handoffPacketDraft");
      const parsed = raw ? JSON.parse(raw) : null;
      return normalizeHandoffDraft(parsed);
    } catch (_) {}
    return buildDefaultHighRiskDraft();
  }

  function saveHandoffDraft(draft) {
    try {
      localStorage.setItem("handoffPacketDraft", JSON.stringify(normalizeHandoffDraft(draft)));
    } catch (_) {}
  }

  function refreshHighRiskDraftFromPatients() {
    const prior = loadHandoffDraft();
    // Rooms are always derived live from tags; only details are persisted.
    saveHandoffDraft(prior);
    return prior;
  }

  function collectHighRiskDraftFromUi() {
    const root = document.getElementById("highRiskStructuredEditor");
    const draft = loadHandoffDraft();
    const normalizeDraftText = (v) => {
      const txt = String(v || "").trim();
      return /^none$/i.test(txt) ? "" : txt;
    };
    if (root) {
      EDITABLE_SECTIONS.forEach((s) => {
        if (s.autoKey) {
          const bucket = {};
          root.querySelectorAll(`[data-hr-detail-room="${s.id}"]`).forEach((el) => {
            const room = String(el.getAttribute("data-room") || "").trim();
            if (!room) return;
            const txt = normalizeDraftText(el.value);
            if (txt) bucket[room] = txt;
          });
          draft.roomDetails[s.id] = bucket;
        } else {
          const el = root.querySelector(`[data-hr-detail="${s.id}"]`);
          if (!el) return;
          draft.details[s.id] = normalizeDraftText(el.value);
        }
      });
      draft.updatedAt = new Date().toISOString();
      saveHandoffDraft(draft);
    }
    return draft;
  }

  function clearHighRiskDraftText() {
    const draft = loadHandoffDraft();
    EDITABLE_SECTIONS.forEach((s) => {
      draft.details[s.id] = "";
      draft.roomDetails[s.id] = {};
    });
    draft.updatedAt = new Date().toISOString();
    saveHandoffDraft(draft);
    renderHighRiskStructuredEditor();
  }

  function renderHighRiskStructuredEditor() {
    const root = document.getElementById("highRiskStructuredEditor");
    if (!root) return;
    root.style.maxWidth = "none";
    root.style.margin = "0 0 12px 0";
    root.style.padding = "2px 6px";
    const draft = refreshHighRiskDraftFromPatients();
    const sectionById = Object.fromEntries(EDITABLE_SECTIONS.map((s) => [s.id, s]));
    const autoLines = Object.fromEntries(AUTOFILL_SECTIONS.map((s) => [s.autoKey, roomsLine(s.autoKey)]));

    const sectionTitle = (id, fallback) => escapeHtml(sectionById[id]?.label || fallback || id);

    function renderAutoByRoomSection(id, customTitle) {
      const s = sectionById[id];
      const title = customTitle || s?.label || id;
      if (!s || !s.autoKey) return `<div style="font-size:13px; color:#64748b;">None</div>`;
      const rooms = roomsForTag(s.autoKey);
      const roomDetails = (draft.roomDetails && draft.roomDetails[s.id] && typeof draft.roomDetails[s.id] === "object")
        ? draft.roomDetails[s.id]
        : {};
      if (!rooms.length) return `<div style="font-size:13px; color:#64748b;">None</div>`;
      const rows = rooms.map((room) => `
        <div style="display:grid; grid-template-columns:auto minmax(0,1fr); gap:8px; align-items:start; margin-bottom:6px;">
          <div style="display:inline-flex; align-items:center; justify-content:center; width:fit-content; padding:6px 10px; border:1px solid rgba(15,23,42,0.16); border-radius:10px; font-size:16px; line-height:1.1; background:#f8fafc; font-weight:800; color:#0f172a;">${escapeHtml(room)}</div>
          <textarea data-hr-detail-room="${escapeHtml(s.id)}" data-room="${escapeHtml(room)}" rows="1" data-hr-autosize="1" placeholder="None" style="width:100%; resize:none; min-height:34px; padding:6px 10px; border:1px solid rgba(15,23,42,0.2); border-radius:10px; font-size:16px; line-height:1.22; color:#0f172a; overflow:hidden;">${escapeHtml(String(roomDetails[room] || ""))}</textarea>
        </div>
      `).join("");
      return `
        <div style="font-weight:700; font-size:17px; text-decoration:underline; margin-bottom:4px;">${escapeHtml(title)}:</div>
        ${rows}
      `;
    }

    function renderFreeTextSection(id, customTitle) {
      const s = sectionById[id];
      const title = customTitle || s?.label || id;
      const value = String(draft.details?.[id] || "");
      return `
        <div style="font-weight:700; font-size:17px; text-decoration:underline; margin-bottom:4px;">${escapeHtml(title)}:</div>
        <textarea data-hr-detail="${escapeHtml(id)}" rows="1" data-hr-autosize="1" placeholder="None" style="width:100%; resize:none; min-height:34px; padding:6px 10px; border:1px solid rgba(15,23,42,0.2); border-radius:10px; font-size:16px; line-height:1.22; color:#0f172a; overflow:hidden;">${escapeHtml(value)}</textarea>
      `;
    }

    function renderReadOnlySection(title, text) {
      return `
        <div style="font-weight:700; font-size:17px; text-decoration:underline; margin-bottom:4px;">${escapeHtml(title)}:</div>
        <div style="font-size:16px; line-height:1.2; white-space:pre-wrap; min-height:24px;">${escapeHtml(String(text || "None"))}</div>
      `;
    }

    root.innerHTML = `
      <div style="font-weight:900; font-size:34px; line-height:1.02; margin-bottom:8px; letter-spacing:-0.02em; color:#0f172a;">High-Risk Hand-Off Editor</div>
      <div style="font-size:16px; color:#334155; margin-bottom:10px;">
        Same structure as printed hand-off. Edit in place and print as shown.
      </div>
      <div style="border:1px solid #222; background:#fff;">
        <div style="display:grid; grid-template-columns:1.2fr 1fr .9fr 1.4fr; border-bottom:1px solid #222;">
          <div style="padding:6px; border-right:1px solid #222; grid-column:1 / span 3;">
            ${renderAutoByRoomSection("drips", "GTT")}
            ${renderAutoByRoomSection("tube_feeds", "TF")}
          </div>
          <div style="padding:6px;">
            ${renderReadOnlySection("Admits", autoLines.admit)}
            ${renderReadOnlySection("D/C", autoLines.lateDc)}
            ${renderReadOnlySection("Transfers", "None")}
          </div>
        </div>

        <div style="display:grid; grid-template-columns:1.2fr 1fr .9fr 1.4fr; border-bottom:1px solid #222;">
          <div style="padding:6px; border-right:1px solid #222;">${renderFreeTextSection("special_procedures", sectionTitle("special_procedures"))}</div>
          <div style="padding:6px; border-right:1px solid #222;">${renderFreeTextSection("wounds", sectionTitle("wounds"))}</div>
          <div style="padding:6px; border-right:1px solid #222;">
            ${renderFreeTextSection("central_lines", sectionTitle("central_lines"))}
            ${renderReadOnlySection("Foley Catheters", autoLines.foley)}
          </div>
          <div style="padding:6px;">${renderAutoByRoomSection("isolations", "Isolation")}</div>
        </div>

        <div style="display:grid; grid-template-columns:1.2fr 1fr .9fr 1.4fr; border-bottom:1px solid #222;">
          <div style="padding:6px; border-right:1px solid #222;">${renderAutoByRoomSection("nih", "NIH")}</div>
          <div style="padding:6px; border-right:1px solid #222;">
            ${renderAutoByRoomSection("ciwa", "CIWA")}
            ${renderReadOnlySection("COWS", "None")}
          </div>
          <div style="padding:6px; border-right:1px solid #222;">${renderReadOnlySection("Strict I's & O's", autoLines.strictIo)}</div>
          <div style="padding:6px;">${renderReadOnlySection("Blood Glucose", autoLines.bg)}</div>
        </div>

        <div style="display:grid; grid-template-columns:1.2fr 1fr .9fr 1.4fr; border-bottom:1px solid #222;">
          <div style="padding:6px; border-right:1px solid #222; grid-column:1 / span 3;">${renderAutoByRoomSection("sitters", "Sitters")}</div>
          <div style="padding:6px;">
            ${renderFreeTextSection("co", "CO")}
            ${renderAutoByRoomSection("restraints", "Restraints")}
            ${renderReadOnlySection("Code 55/BURT", "None")}
          </div>
        </div>

        <div style="padding:6px;">
          ${renderFreeTextSection("special_endorsements", sectionTitle("special_endorsements"))}
        </div>
      </div>
    `;

    root.querySelectorAll("textarea[data-hr-detail]").forEach((el) => {
      el.addEventListener("input", () => { collectHighRiskDraftFromUi(); });
      el.addEventListener("change", () => { collectHighRiskDraftFromUi(); });
    });
    root.querySelectorAll("textarea[data-hr-detail-room]").forEach((el) => {
      el.addEventListener("input", () => { collectHighRiskDraftFromUi(); });
      el.addEventListener("change", () => { collectHighRiskDraftFromUi(); });
    });
    root.querySelectorAll("textarea[data-hr-autosize]").forEach((el) => {
      const autoSize = () => {
        el.style.height = "0px";
        el.style.height = `${Math.max(34, el.scrollHeight)}px`;
      };
      autoSize();
      el.addEventListener("input", autoSize);
      el.addEventListener("focus", () => {
        if (/^none$/i.test(String(el.value || "").trim())) {
          el.value = "";
          autoSize();
        }
      });
      el.addEventListener("blur", () => {
        if (!String(el.value || "").trim()) {
          el.value = "None";
          autoSize();
        }
      });
      if (!String(el.value || "").trim()) {
        el.value = "None";
        autoSize();
      }
    });
  }

  function buildHighRiskHandoffSection(opts = {}) {
    const draft = normalizeHandoffDraft(opts);
    const byId = {};
    EDITABLE_SECTIONS.forEach((s) => { byId[s.id] = s; });

    const editableValue = (id) => {
      const s = byId[id];
      if (!s) return "None";
      if (!s.autoKey) {
        const txt = String(draft.details?.[s.id] || "").trim();
        return txt || "None";
      }
      const rooms = roomsForTag(s.autoKey);
      if (!rooms.length) return "None";
      const byRoom = draft.roomDetails?.[s.id] || {};
      const lines = rooms.map((room) => {
        const txt = String(byRoom[room] || "").trim();
        return txt ? `${room} - ${txt}` : `${room}`;
      });
      return lines.join("\n");
    };

    const autoValue = (key) => {
      const line = String(roomsLine(key) || "").trim();
      return line || "None";
    };

    return `
      <section class="handoff-risk-page">
        <div class="hr-title">High-Risk Hand-Off Report</div>
        <div class="hr-sheet">
          <div class="hr-row hr-row-top">
            <div class="hr-cell">
              <div class="hr-cell-title">GTT:</div>
              <div class="hr-cell-value">${escapeHtml(editableValue("drips"))}</div>
              <div class="hr-cell-title">TF:</div>
              <div class="hr-cell-value">${escapeHtml(editableValue("tube_feeds"))}</div>
            </div>
            <div class="hr-cell">
              <div class="hr-cell-title">Admits:</div>
              <div class="hr-cell-value">${escapeHtml(autoValue("admit"))}</div>
              <div class="hr-cell-title">D/C:</div>
              <div class="hr-cell-value">${escapeHtml(autoValue("lateDc"))}</div>
              <div class="hr-cell-title">Transfers:</div>
              <div class="hr-cell-value">None</div>
            </div>
          </div>

          <div class="hr-row hr-row-mid4">
            <div class="hr-cell">
              <div class="hr-cell-title">Special Procedures:</div>
              <div class="hr-cell-value">${escapeHtml(editableValue("special_procedures"))}</div>
            </div>
            <div class="hr-cell">
              <div class="hr-cell-title">Wounds:</div>
              <div class="hr-cell-value">${escapeHtml(editableValue("wounds"))}</div>
            </div>
            <div class="hr-cell">
              <div class="hr-cell-title">Central Lines:</div>
              <div class="hr-cell-value">${escapeHtml(editableValue("central_lines"))}</div>
              <div class="hr-cell-title">Foley Catheters:</div>
              <div class="hr-cell-value">${escapeHtml(autoValue("foley"))}</div>
            </div>
            <div class="hr-cell">
              <div class="hr-cell-title">Isolation:</div>
              <div class="hr-cell-value">${escapeHtml(editableValue("isolations"))}</div>
            </div>
          </div>

          <div class="hr-row hr-row-mid4">
            <div class="hr-cell">
              <div class="hr-cell-title">NIH</div>
              <div class="hr-cell-value">${escapeHtml(editableValue("nih"))}</div>
            </div>
            <div class="hr-cell">
              <div class="hr-cell-title">CIWA:</div>
              <div class="hr-cell-value">${escapeHtml(editableValue("ciwa"))}</div>
              <div class="hr-cell-title">COWS:</div>
              <div class="hr-cell-value">None</div>
            </div>
            <div class="hr-cell">
              <div class="hr-cell-title">Strict I's & O's:</div>
              <div class="hr-cell-value">${escapeHtml(autoValue("strictIo"))}</div>
            </div>
            <div class="hr-cell">
              <div class="hr-cell-title">Blood Glucose:</div>
              <div class="hr-cell-value">${escapeHtml(autoValue("bg"))}</div>
            </div>
          </div>

          <div class="hr-row hr-row-bottom">
            <div class="hr-cell">
              <div class="hr-cell-title">Sitters:</div>
              <div class="hr-cell-value">${escapeHtml(editableValue("sitters"))}</div>
            </div>
            <div class="hr-cell">
              <div class="hr-cell-title">CO:</div>
              <div class="hr-cell-value">${escapeHtml(editableValue("co"))}</div>
              <div class="hr-cell-title">Restraints:</div>
              <div class="hr-cell-value">${escapeHtml(editableValue("restraints"))}</div>
              <div class="hr-cell-title">Code 55/BURT:</div>
              <div class="hr-cell-value">None</div>
            </div>
          </div>

          <div class="hr-row hr-row-endorse">
            <div class="hr-cell">
              <div class="hr-cell-title">Special Endorsements:</div>
              <div class="hr-cell-value">${escapeHtml(editableValue("special_endorsements"))}</div>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function appendHighRiskSectionToDocument(htmlDoc, sectionHtml) {
    const style = `
      <style>
        @page { size: 11in 8.5in; margin: 5mm; }
        .handoff-risk-page{ break-before:page; page-break-before:always; padding:2px 1px; font-family:"Times New Roman",serif; color:#000; }
        .hr-title{ font-size:30px; font-weight:700; text-align:center; margin-bottom:6px; }
        .hr-sheet{ border:1px solid #222; display:grid; grid-auto-rows:minmax(26px, auto); }
        .hr-row{ display:grid; gap:0; min-height:0; align-items:stretch; }
        .hr-row + .hr-row{ border-top:1px solid #222; }
        .hr-row-top{ grid-template-columns:1.2fr 1fr .9fr 1.4fr; }
        .hr-row-mid4{ grid-template-columns:1.2fr 1fr .9fr 1.4fr; }
        .hr-row-bottom{ grid-template-columns:1.2fr 1fr .9fr 1.4fr; }
        .hr-row-endorse{ grid-template-columns:1fr; }
        .hr-row-top .hr-cell:first-child{ grid-column:1 / span 3; }
        .hr-row-bottom .hr-cell:first-child{ grid-column:1 / span 3; }
        .hr-cell{ padding:2px 5px; min-height:24px; border-left:1px solid #222; display:flex; flex-direction:column; }
        .hr-cell:first-child{ border-left:none; }
        .hr-cell-title{ font-weight:700; font-size:15px; text-decoration:underline; margin-bottom:1px; }
        .hr-cell-value{ font-size:15px; line-height:1.16; white-space:pre-wrap; word-break:break-word; margin-bottom:1px; }
        .hr-row-endorse .hr-cell{ min-height:28px; }
      </style>
    `;
    if (htmlDoc.includes("</head>")) {
      htmlDoc = htmlDoc.replace("</head>", `${style}</head>`);
    }
    if (htmlDoc.includes("</body>")) {
      return htmlDoc.replace("</body>", `${sectionHtml}</body>`);
    }
    return `${htmlDoc}${style}${sectionHtml}`;
  }

  function parseCard(block, kind) {
    const titleEl =
      block.querySelector(".assignment-header strong") ||
      block.querySelector(".liveCardHeader strong") ||
      block.querySelector("strong") ||
      block.querySelector("h3") ||
      block.querySelector("h4");

    const title =
      (titleEl ? titleEl.textContent : "").trim() ||
      (kind === "RN" ? "Incoming RN" : "Incoming PCA");

    const table = block.querySelector("table");
    if (!table) return { title, rows: [], kind };

    const rows = Array.from(table.querySelectorAll("tbody tr"))
      .map((tr) => {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (!tds.length) return null;

        const room = stripPins((tds[0]?.textContent || "").trim());
        const level = (tds[1]?.textContent || "").trim();
        const notes = (tds[2]?.textContent || "").trim();
        const from = (tds[3]?.textContent || "").trim();

        if (!room && !level && !notes && !from) return null;
        return { room, level, notes, from };
      })
      .filter(Boolean);

    return { title, rows, kind };
  }

  function extractCardsFrom(containerId, kind) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return [];

    const blocks = Array.from(wrap.querySelectorAll(".nurseBlock, .pcaBlock, .assignment-card, .liveCard"));
    return (blocks.length ? blocks : Array.from(wrap.children))
      .map((block) => parseCard(block, kind))
      .filter(Boolean);
  }

  function computePcaTightness(pcaCards) {
    const totalRows = (pcaCards || []).reduce((sum, c) => sum + (c.rows?.length || 0), 0);
    if (totalRows <= 28) return 0;
    if (totalRows <= 36) return 1;
    if (totalRows <= 44) return 2;
    return 3;
  }

  function splitStaffDisplay(title, fallback) {
    const raw = String(title || fallback || "").trim();
    const noRole = raw.replace(/\((RN|PCA|SITTER)\)/gi, "").trim();
    const idMatch = noRole.match(/(?:#?\s*)(\d{5,})$/);
    const id = idMatch ? `#${idMatch[1]}` : "";
    const name = noRole.replace(/(?:#?\s*)\d{5,}$/, "").trim() || noRole || String(fallback || "");
    return { name, id };
  }


  function renderOneCardNew(card, kind) {
    const isPca = kind === "PCA";
    const rowsHtml = (card.rows || [])
      .map((r) => `
        <tr>
          <td class="col-room">${escapeHtml(stripPins(r.room || ""))}</td>
          <td class="col-level">${escapeHtml(r.level || "")}</td>
          <td class="col-notes">${escapeHtml(r.notes || "")}</td>
        </tr>`)
      .join("");

    return `
      <div class="card ${isPca ? "pca" : "rn"}">
        <div class="card-head">${escapeHtml(card.title || (isPca ? "Incoming PCA" : "Incoming RN"))}</div>
        <table>
          <thead>
            <tr>
              <th class="col-room">Bed</th>
              <th class="col-level">Level</th>
              <th class="col-notes">Acuity Notes</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  function renderCardsNew(cards, opts) {
    const kind = opts.kind || "RN";
    const gridClass = kind === "PCA" ? "grid-pca" : "grid-rn";
    const sectionClass = kind === "PCA" ? "print-section pca-section" : "print-section rn-section";

    const htmlCards = (cards || []).map((c) => renderOneCardNew(c, kind)).join("");

    return `
      <div class="${sectionClass}">
        ${opts.headerHtml || ""}
        <div class="section-title">${escapeHtml(opts.section || "")}</div>
        <div class="${gridClass}">
          ${htmlCards || `<div style="font-size:12px; color:#475569; font-weight:700;">No ${escapeHtml(kind)} assignments found.</div>`}
        </div>
      </div>
    `;
  }

  function renderTraditionalPcaRow(pcaCards) {
    const cards = (pcaCards || []).map((c) => {
      const rooms = (c.rows || [])
        .map((r) => stripPins(r.room || ""))
        .filter(Boolean)
        .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));

      return `
        <div class="trad-pca-card">
          <div class="trad-pca-head">${escapeHtml(c.title || "Incoming PCA")}</div>
          <table>
            <thead><tr><th>PTS</th><th>PATIENT LIST</th></tr></thead>
            <tbody><tr><td>${rooms.length}</td><td>${escapeHtml(rooms.join(", "))}</td></tr></tbody>
          </table>
        </div>
      `;
    }).join("");

    return cards || `<div class="trad-empty">No PCA assignments found.</div>`;
  }

  function renderModernPcaExpandedRow(pcaCards) {
    const cards = (pcaCards || []).map((c) => {
      const rows = (c.rows || []).map((r) => `
        <tr>
          <td>${escapeHtml(stripPins(r.room || ""))}</td>
          <td>${escapeHtml(r.level || "")}</td>
          <td>${escapeHtml(r.notes || "")}</td>
        </tr>
      `).join("");

      return `
        <div class="trad-pca-card">
          <div class="trad-pca-head">${escapeHtml(c.title || "Incoming PCA")}</div>
          <table>
            <thead><tr><th>BED</th><th>ACTY</th><th>ACUITY NOTES</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }).join("");

    return cards || `<div class="trad-empty">No PCA assignments found.</div>`;
  }

  function renderTraditionalRnGrid(rnCards) {
    const cards = (rnCards || []).map((c) => {
      const rows = (c.rows || []).map((r) => `
        <tr>
          <td>${escapeHtml(stripPins(r.room || ""))}</td>
          <td>${escapeHtml(r.level || "")}</td>
          <td>${escapeHtml(r.notes || "")}</td>
        </tr>
      `).join("");

      return `
        <div class="trad-rn-card">
          <div class="trad-rn-head">${escapeHtml(c.title || "Incoming RN")}</div>
          <table>
            <thead><tr><th>ROOM#</th><th>ACTY</th><th>NOTES</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }).join("");

    return cards || `<div class="trad-empty">No RN assignments found.</div>`;
  }


  function buildPrintHTMLTraditional(data) {
    const shiftDate = getShiftDateLabel();
    const shift = getShiftTypeLabel(data.rnCards, data.pcaCards);
    const openRooms = getOpenRoomLabels();
    const pcaCols = Math.max(1, Math.min(8, (data.pcaCards || []).length || 1));

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Oncoming Assignments - Print (Traditional)</title>
<style>
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; background:#fff; color:#111827; font-family:"Times New Roman", serif; }
  @page { margin:5mm; size:11in 8.5in; }
  .wrap{ padding:2px; width:100%; max-width:10.9in; margin:0 auto; }
  .top{ display:grid; grid-template-columns:1.5fr 1.1fr; gap:8px; margin-bottom:8px; align-items:stretch; }
  .box{ border:1px solid #111; padding:6px 8px; min-height:62px; }
  .title{ font-weight:700; font-size:13px; text-align:center; margin-bottom:4px; }
  .center-line{ text-align:center; font-weight:700; margin:4px 0; font-size:12px; line-height:1.2; }
  .right-top{ text-align:center; font-size:30px; font-weight:700; line-height:1.04; margin-bottom:3px; }
  .open-rooms{ font-size:11px; line-height:1.22; word-break:break-word; }
  table{ width:100%; border-collapse:collapse; table-layout:fixed; }
  th,td{ border:1px solid #111; padding:3px 4px; font-size:12px; vertical-align:top; }
  th{ background:#f3f4f6; text-align:center; font-weight:700; }
  .trad-pca-wrap{ margin-top:8px; }
  .trad-pca-row{
    display:grid;
    grid-template-columns:repeat(var(--pca-cols), minmax(0, 1fr));
    gap:6px;
  }
  .trad-pca-card{
    border:1px solid #111;
    min-width:0;
  }
  .trad-pca-head{
    border-bottom:1px solid #111;
    text-align:center;
    font-weight:700;
    padding:3px 2px;
    font-size:12px;
  }
  .trad-pca-card table{ table-layout:fixed; }
  .trad-pca-card th, .trad-pca-card td{ padding:2px 3px; line-height:1.05; font-size:10px; }
  .trad-pca-card th:nth-child(1), .trad-pca-card td:nth-child(1){ width:22%; text-align:center; font-weight:700; }
  .trad-pca-card th:nth-child(2), .trad-pca-card td:nth-child(2){ text-align:left; }
  .trad-rn-grid{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
  .trad-rn-head{ border:1px solid #111; border-bottom:none; text-align:center; font-weight:700; padding:4px 3px; font-size:13px; }
  .trad-rn-card table{ table-layout:fixed; }
  .trad-rn-card th, .trad-rn-card td{ padding:2px 3px; line-height:1.05; font-size:11px; }
  .trad-rn-card th:nth-child(1), .trad-rn-card td:nth-child(1){ width:30%; text-align:center; font-weight:700; }
  .trad-rn-card th:nth-child(2), .trad-rn-card td:nth-child(2){ width:16%; text-align:center; font-weight:700; }
  .trad-rn-card th:nth-child(3){ text-align:center; }
  .trad-rn-card td:nth-child(3){ text-align:left; }
  .trad-empty{ border:1px solid #111; padding:8px; font-size:12px; }
  @media print { .wrap{ padding:0; } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="box">
        <div class="title">Leadership Team</div>
        <div class="center-line">Charge Nurse: ${escapeHtml(data.charge || "-")}</div>
        <div class="center-line">Clinical Mentor/Resource: ${escapeHtml(data.mentor || "-")}</div>
        <div class="center-line">CTA: ${escapeHtml(data.cta || "-")}</div>
      </div>
      <div class="box">
        <div class="right-top">${escapeHtml(shiftDate)} ${escapeHtml(shift)}</div>
        <div class="title">Room Availability</div>
        <div class="open-rooms">${escapeHtml(openRooms.join(", ") || "None")}</div>
      </div>
    </div>
    <div class="trad-rn-grid">${renderTraditionalRnGrid(data.rnCards)}</div>
    <div class="box trad-pca-wrap">
      <div class="title">PCA Assignments</div>
      <div class="trad-pca-row" style="--pca-cols:${pcaCols};">
        ${renderTraditionalPcaRow(data.pcaCards)}
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  function buildPrintHTMLNew(data) {
    const shiftDate = getShiftDateLabel();
    const shift = getShiftTypeLabel(data.rnCards, data.pcaCards);
    const openRooms = getOpenRoomLabels();
    const pcaCols = Math.max(1, Math.min(8, (data.pcaCards || []).length || 1));

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Oncoming Assignments - Print (Modern)</title>
<style>
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; background:#fff; color:#111827; font-family:"Times New Roman", serif; }
  @page { margin:5mm; size:11in 8.5in; }
  .wrap{ padding:2px; width:100%; max-width:10.9in; margin:0 auto; }
  .top{ display:grid; grid-template-columns:1.5fr 1.1fr; gap:8px; margin-bottom:8px; align-items:stretch; }
  .box{ border:1px solid #111; padding:6px 8px; min-height:62px; }
  .title{ font-weight:700; font-size:13px; text-align:center; margin-bottom:4px; }
  .center-line{ text-align:center; font-weight:700; margin:4px 0; font-size:12px; line-height:1.2; }
  .right-top{ text-align:center; font-size:30px; font-weight:700; line-height:1.04; margin-bottom:3px; }
  .open-rooms{ font-size:11px; line-height:1.22; word-break:break-word; }
  table{ width:100%; border-collapse:collapse; table-layout:fixed; }
  th,td{ border:1px solid #111; padding:3px 4px; font-size:12px; vertical-align:top; }
  th{ background:#f3f4f6; text-align:center; font-weight:700; }
  .trad-pca-wrap{ margin-top:8px; }
  .trad-pca-row{ display:grid; grid-template-columns:repeat(var(--pca-cols), minmax(0, 1fr)); gap:6px; }
  .trad-pca-card{ border:1px solid #111; min-width:0; }
  .trad-pca-head{ border-bottom:1px solid #111; text-align:center; font-weight:700; padding:3px 2px; font-size:12px; }
  .trad-pca-card table{ table-layout:fixed; }
  .trad-pca-card th, .trad-pca-card td{ padding:2px 3px; line-height:1.05; font-size:10px; }
  .trad-pca-card th:nth-child(1), .trad-pca-card td:nth-child(1){ width:24%; text-align:center; font-weight:700; }
  .trad-pca-card th:nth-child(2), .trad-pca-card td:nth-child(2){ width:18%; text-align:center; font-weight:700; }
  .trad-pca-card th:nth-child(3){ text-align:center; }
  .trad-pca-card td:nth-child(3){ text-align:left; }
  .trad-rn-grid{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
  .trad-rn-head{ border:1px solid #111; border-bottom:none; text-align:center; font-weight:700; padding:4px 3px; font-size:13px; }
  .trad-rn-card table{ table-layout:fixed; }
  .trad-rn-card th, .trad-rn-card td{ padding:2px 3px; line-height:1.05; font-size:11px; }
  .trad-rn-card th:nth-child(1), .trad-rn-card td:nth-child(1){ width:30%; text-align:center; font-weight:700; }
  .trad-rn-card th:nth-child(2), .trad-rn-card td:nth-child(2){ width:16%; text-align:center; font-weight:700; }
  .trad-rn-card th:nth-child(3){ text-align:center; }
  .trad-rn-card td:nth-child(3){ text-align:left; }
  .trad-empty{ border:1px solid #111; padding:8px; font-size:12px; }
  @media print { .wrap{ padding:0; } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="box">
        <div class="title">Leadership Team</div>
        <div class="center-line">Charge Nurse: ${escapeHtml(data.charge || "-")}</div>
        <div class="center-line">Clinical Mentor/Resource: ${escapeHtml(data.mentor || "-")}</div>
        <div class="center-line">CTA: ${escapeHtml(data.cta || "-")}</div>
      </div>
      <div class="box">
        <div class="right-top">${escapeHtml(shiftDate)} ${escapeHtml(shift)}</div>
        <div class="title">Room Availability</div>
        <div class="open-rooms">${escapeHtml(openRooms.join(", ") || "None")}</div>
      </div>
    </div>
    <div class="trad-rn-grid">${renderTraditionalRnGrid(data.rnCards)}</div>
    <div class="box trad-pca-wrap">
      <div class="title">PCA Assignments</div>
      <div class="trad-pca-row" style="--pca-cols:${pcaCols};">
        ${renderModernPcaExpandedRow(data.pcaCards)}
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  function getOrCreatePreviewOverlay() {
    let overlay = document.getElementById("printPreviewOncomingOverlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "printPreviewOncomingOverlay";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:10001",
      "background:rgba(15,23,42,0.55)",
      "display:none",
      "align-items:center",
      "justify-content:center",
      "padding:16px"
    ].join(";");

    overlay.innerHTML = `
      <div style="width:min(1200px,98vw); height:min(92vh,980px); background:#fff; border-radius:12px; overflow:hidden; border:1px solid rgba(15,23,42,0.18); box-shadow:0 18px 45px rgba(2,6,23,0.35); display:flex; flex-direction:column;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; border-bottom:1px solid rgba(15,23,42,0.12); background:#f8fafc;">
          <div id="printPreviewOncomingTitle" style="font-weight:800; font-size:13px; color:#0f172a;">Oncoming Print Preview</div>
          <div id="printPreviewOncomingModeSwitch" style="display:flex; gap:6px;">
            <button id="printPreviewModeNew" type="button" style="padding:6px 10px; font-weight:700;">New / Expanded</button>
            <button id="printPreviewModeTraditional" type="button" style="padding:6px 10px; font-weight:700;">Traditional</button>
          </div>
          <div style="display:flex; gap:8px; margin-left:auto;">
            <button id="printPreviewOncomingDoPrint" type="button" style="padding:6px 12px; font-weight:700;">Print / Save PDF</button>
            <button id="printPreviewOncomingClose" type="button" style="padding:6px 10px;">Close</button>
          </div>
        </div>
        <iframe id="printPreviewOncomingFrame" style="width:100%; height:100%; border:0;"></iframe>
      </div>
    `;

    document.body.appendChild(overlay);
    return overlay;
  }

  function openInAppPrintPreview(html, modeLabel, opts = {}) {
    const overlay = getOrCreatePreviewOverlay();
    const frame = overlay.querySelector("#printPreviewOncomingFrame");
    const title = overlay.querySelector("#printPreviewOncomingTitle");
    const btnPrint = overlay.querySelector("#printPreviewOncomingDoPrint");
    const btnClose = overlay.querySelector("#printPreviewOncomingClose");
    const modeWrap = overlay.querySelector("#printPreviewOncomingModeSwitch");
    const btnModeNew = overlay.querySelector("#printPreviewModeNew");
    const btnModeTraditional = overlay.querySelector("#printPreviewModeTraditional");

    if (!frame || !btnPrint || !btnClose) return;

    if (title) title.textContent = `Oncoming Print Preview (${modeLabel})`;
    const activeMode = String(opts.mode || "new").toLowerCase();
    const allowSwitch = !!opts.allowModeSwitch;
    if (modeWrap) modeWrap.style.display = allowSwitch ? "flex" : "none";
    if (btnModeNew) btnModeNew.style.opacity = activeMode === "new" ? "1" : "0.65";
    if (btnModeTraditional) btnModeTraditional.style.opacity = activeMode === "traditional" ? "1" : "0.65";

    frame.srcdoc = html;
    overlay.style.display = "flex";

    const close = () => {
      overlay.style.display = "none";
      frame.srcdoc = "";
    };

    btnClose.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    if (btnModeNew) {
      btnModeNew.onclick = () => {
        if (typeof window.__oncomingPreviewRerender === "function") window.__oncomingPreviewRerender("new");
      };
    }
    if (btnModeTraditional) {
      btnModeTraditional.onclick = () => {
        if (typeof window.__oncomingPreviewRerender === "function") window.__oncomingPreviewRerender("traditional");
      };
    }
    btnPrint.onclick = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch (e) {
        console.error("[printOncoming] preview print() failed:", e);
        alert("Print failed. See console for details.");
      }
    };
  }

  function buildHighRiskOnlyDocument(handoffInput) {
    const base = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>High-Risk Hand-Off Report</title>
</head>
<body></body>
</html>`;
    const section = buildHighRiskHandoffSection(handoffInput || {});
    let html = appendHighRiskSectionToDocument(base, section);
    html = html.replace(
      "</head>",
      `<style>.handoff-risk-page{break-before:auto !important; page-break-before:auto !important;}</style></head>`
    );
    return html;
  }

  function collectOncomingPrintData() {
    return {
      charge: getValueById("incomingChargeName"),
      mentor: getValueById("incomingMentorName"),
      cta: getValueById("incomingCtaName"),
      rnCards: extractCardsFrom("assignmentOutput", "RN"),
      pcaCards: extractCardsFrom("pcaAssignmentOutput", "PCA"),
    };
  }

  function buildOncomingPreviewDoc(mode, includePacket) {
    const selectedMode = String(mode || "new").toLowerCase() === "traditional" ? "traditional" : "new";
    const data = collectOncomingPrintData();
    const assignmentHtml = selectedMode === "traditional"
      ? buildPrintHTMLTraditional(data)
      : buildPrintHTMLNew(data);
    if (!includePacket) return assignmentHtml;
    refreshHighRiskDraftFromPatients();
    const handoffInput = collectHighRiskDraftFromUi();
    return appendHighRiskSectionToDocument(
      assignmentHtml,
      buildHighRiskHandoffSection(handoffInput)
    );
  }

  async function openPrintPreview(mode) {
    try {
      const selectedMode = String(mode || "new").toLowerCase() === "traditional" ? "traditional" : "new";
      window.__oncomingPreviewRerender = (nextMode) => {
        const m = String(nextMode || "new").toLowerCase() === "traditional" ? "traditional" : "new";
        const doc = buildOncomingPreviewDoc(m, false);
        const lbl = m === "traditional" ? "Traditional" : "New / Expanded";
        openInAppPrintPreview(doc, lbl, { mode: m, allowModeSwitch: true });
      };
      const html = buildOncomingPreviewDoc(selectedMode, false);
      const modeLabel = selectedMode === "traditional" ? "Traditional" : "New / Expanded";
      openInAppPrintPreview(html, modeLabel, { mode: selectedMode, allowModeSwitch: true });
    } catch (e) {
      console.error("[printOncoming] open() error:", e);
      alert("Print failed. See console for details.");
    }
  }

  async function openPacketPreview(mode) {
    try {
      const selectedMode = String(mode || "new").toLowerCase() === "traditional" ? "traditional" : "new";
      window.__oncomingPreviewRerender = (nextMode) => {
        const m = String(nextMode || "new").toLowerCase() === "traditional" ? "traditional" : "new";
        const doc = buildOncomingPreviewDoc(m, true);
        const lbl = `Hand-Off Packet • ${m === "traditional" ? "Traditional" : "New / Expanded"}`;
        openInAppPrintPreview(doc, lbl, { mode: m, allowModeSwitch: true });
      };
      const packetHtml = buildOncomingPreviewDoc(selectedMode, true);
      const modeLabel = `Hand-Off Packet • ${selectedMode === "traditional" ? "Traditional" : "New / Expanded"}`;
      openInAppPrintPreview(packetHtml, modeLabel, { mode: selectedMode, allowModeSwitch: true });
    } catch (e) {
      console.error("[printOncoming] openPacketPreview() error:", e);
      alert("Packet preview failed. See console for details.");
    }
  }

  async function openHighRiskOnlyPreview() {
    try {
      refreshHighRiskDraftFromPatients();
      const handoffInput = collectHighRiskDraftFromUi();
      const html = buildHighRiskOnlyDocument(handoffInput);
      window.__oncomingPreviewRerender = null;
      openInAppPrintPreview(html, "High-Risk Hand-Off", { allowModeSwitch: false });
    } catch (e) {
      console.error("[printOncoming] openHighRiskOnlyPreview() error:", e);
      alert("High-Risk preview failed. See console for details.");
    }
  }

  window.printOncoming = {
    open: openPrintPreview,
    openNew: () => openPrintPreview("new"),
    openTraditional: () => openPrintPreview("traditional"),
    openPacket: openPacketPreview,
    openHighRiskOnly: openHighRiskOnlyPreview,
    refreshHighRiskDraftFromPatients,
    collectHighRiskDraftFromUi,
    clearAllText: clearHighRiskDraftText,
    renderHighRiskStructuredEditor,
  };
  window.app.printOncoming = window.printOncoming;

  function hookAcuityTilesAutoRefresh() {
    if (window.__highRiskAutoRefreshWrapped) return;
    if (typeof window.updateAcuityTiles !== "function") return;
    const original = window.updateAcuityTiles;
    window.updateAcuityTiles = function wrappedUpdateAcuityTiles() {
      const out = original.apply(this, arguments);
      try { renderHighRiskStructuredEditor(); } catch (_) {}
      return out;
    };
    window.__highRiskAutoRefreshWrapped = true;
  }

  hookAcuityTilesAutoRefresh();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      try { renderHighRiskStructuredEditor(); } catch (_) {}
    });
  } else {
    try { renderHighRiskStructuredEditor(); } catch (_) {}
  }

  console.log("[printOncoming] loaded: window.printOncoming.open is ready");
})();
