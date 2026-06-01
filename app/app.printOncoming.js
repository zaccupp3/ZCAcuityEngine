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
      .replace(/[\u{1F4CC}\u{1F4CD}\u{1F4CE}\u{1F697}]/gu, "")
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

  function sanitizeRichHtml(html) {
    const src = String(html || "").trim();
    if (!src) return "";
    const doc = document.implementation.createHTMLDocument("");
    doc.body.innerHTML = src;
    doc.body.querySelectorAll("script,style,iframe,object,embed,link,meta").forEach((node) => node.remove());
    doc.body.querySelectorAll("*").forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const allowed = ["b", "strong", "i", "em", "u", "br", "div", "p", "span", "ul", "ol", "li"];
      if (!allowed.includes(tag)) {
        const span = doc.createElement("span");
        span.innerHTML = el.innerHTML;
        el.replaceWith(span);
        return;
      }
      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || "");
        if (name === "style") {
          const keep = value
            .split(";")
            .map((part) => part.trim())
            .filter((part) => /^(text-align|font-weight|font-style|text-decoration)\s*:/i.test(part))
            .join("; ");
          if (keep) el.setAttribute("style", keep);
          else el.removeAttribute("style");
        } else {
          el.removeAttribute(attr.name);
        }
      });
    });
    return doc.body.innerHTML.trim().replace(/&nbsp;/gi, " ").replace(/\u00a0/g, " ");
  }

  function richValueOrBlank(html) {
    const safe = sanitizeRichHtml(html);
    return safe || "";
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
      if (!Number.isNaN(d.getTime())) return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${String(d.getFullYear()).slice(-2)}`;
    }
    const now = new Date();
    return `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getFullYear()).slice(-2)}`;
  }

  function getUnitLabel() {
    const unitSelect = document.getElementById("unitSwitcher");
    const selectedText = String(unitSelect?.selectedOptions?.[0]?.textContent || "").trim();
    if (selectedText) return selectedText;
    return "Charge Nurse Assignment";
  }

  function isSixNorthUnit() {
    const label = String(getUnitLabel() || "").trim().toLowerCase();
    if (label.includes("6 north") || label === "6n") return true;
    const activeId = String(window.activeUnitId || "");
    const row = (Array.isArray(window.availableUnits) ? window.availableUnits : [])
      .find((entry) => String(entry?.unit_id || entry?.unit?.id || "") === activeId);
    const name = String(row?.unit?.name || "").trim().toLowerCase();
    const code = String(row?.unit?.code || "").trim().toLowerCase();
    return name === "6 north" || code === "6n";
  }

  function getPrintHeaderTitle(shift) {
    const unit = getUnitLabel();
    const shiftLabel = String(shift || "").trim();
    if (!shiftLabel || shiftLabel === "-") return unit;
    return `${unit} ${shiftLabel} Shift`;
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

  function roomsLineForAnyTag(tagKeys) {
    const keys = Array.isArray(tagKeys) ? tagKeys : [tagKeys];
    const rooms = getActivePatients()
      .filter((p) => p && keys.some((key) => {
        if (key === "strictIo") return !!(p.strictIo || p.heavy);
        if (key === "feeder") return !!(p.feeder || p.feeders);
        return !!p[key];
      }))
      .map((p) => getRoomLabelForPrint(p))
      .filter(Boolean)
      .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));
    return rooms.length ? rooms.join(", ") : "";
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
    { id: "emu", label: "EMU", autoKey: "emu" },
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

  const CHARGE_REPORT_TEXT_ROWS = [
    { id: "peritoneal_dialysis", label: "Peritoneal Dialysis" },
    { id: "comfort_care", label: "Comfort Care" },
    { id: "constant_observer", label: "Constant Observer" },
    { id: "one_to_one_sitter", label: "1:1 Sitter" },
    { id: "modified_safety_team", label: "Modified Safety Team", tall: true },
    { id: "code_burt", label: "Code BURT / 55 Risk" },
    { id: "surgeries", label: "SURGERIES (out times, last name)" },
    { id: "xfers_in", label: "XFERS IN" },
    { id: "xfers_out", label: "XFERS OUT" },
    { id: "dcs_noon", label: "DCs - EDD today out by noon" },
    { id: "dcs_1500", label: "DCs - EDD today out by 1500" },
    { id: "dcs_complex", label: "DCs - # of Complex Pts" },
    { id: "sick_calls", label: "SICK CALLS" },
    { id: "extra_shifts", label: "EXTRA SHIFTS (incentive offered?)" },
    { id: "flexed", label: "FLEXED" },
    { id: "floated", label: "FLOATED" },
    { id: "open_beds", label: "OPEN BEDS" },
    { id: "variation_matrix", label: "VARIATION FROM MATRIX" },
    { id: "fall_code_rrt", label: "FALL/CODE/RRT/OCC RPT" },
  ];

  const CHARGE_REPORT_AUTO_ROWS = [
    { id: "census", label: "CENSUS / Staffed Beds" },
    { id: "remote_tele", label: "REMOTE TELE" },
    { id: "csc_nih", label: "CSC w/ NIH" },
    { id: "isolation", label: "ISOLATION" },
    { id: "restraints", label: "Restraints" },
    { id: "vpo", label: "VPO" },
  ];

  const CHARGE_REPORT_RICH_IDS = CHARGE_REPORT_TEXT_ROWS.map((row) => row.id).concat(["high_risk_pts"]);
  const DAILY_PACKET_TEXT = "Productivity; Charge Report with Assignments (Day and Night), Single Zone Report with edits (both shifts), Midnight Census, Lunch Break sheets (both shifts/all units), Voalte phone audit.";

  function buildDefaultHighRiskDraft() {
    const details = {};
    const roomDetails = {};
    EDITABLE_SECTIONS.forEach((s) => {
      details[s.id] = "";
      roomDetails[s.id] = {};
    });
    CHARGE_REPORT_RICH_IDS.forEach((id) => {
      details[id] = "";
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
    CHARGE_REPORT_RICH_IDS.forEach((id) => {
      const txt = String(detailsSrc[id] || "").trim();
      if (txt && txt !== "None") base.details[id] = txt;
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

  function highRiskEditorHasActiveTypingFocus() {
    try {
      const active = document.activeElement;
      if (!active) return false;
      const root = document.getElementById("highRiskStructuredEditor");
      return !!(root && root.contains(active) && active.matches && active.matches("[data-hr-rich]"));
    } catch (_) {
      return false;
    }
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
      root.querySelectorAll("[data-hr-rich]").forEach((el) => {
        const id = String(el.getAttribute("data-hr-rich") || "").trim();
        if (!id) return;
        draft.details[id] = sanitizeRichHtml(el.innerHTML);
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
    CHARGE_REPORT_RICH_IDS.forEach((id) => {
      draft.details[id] = "";
    });
    draft.updatedAt = new Date().toISOString();
    saveHandoffDraft(draft);
    renderHighRiskStructuredEditor();
  }

  function countRoomsForTag(tagKey) {
    const rooms = roomsForTag(tagKey);
    return rooms.length ? String(rooms.length) : "None";
  }

  function getTargetBedCountForReport() {
    try {
      if (typeof window.getTargetPatientCount === "function") return Number(window.getTargetPatientCount()) || 0;
      if (typeof window.getConfiguredBeds === "function") {
        const beds = window.getConfiguredBeds();
        return Array.isArray(beds) ? beds.length : 0;
      }
    } catch (_) {}
    return getActivePatients().length || 0;
  }

  function getChargeReportAutoValues() {
    const activeCount = getActivePatients().length;
    const staffedBeds = getTargetBedCountForReport();
    const census = staffedBeds ? `${activeCount} / ${staffedBeds}` : String(activeCount || "");
    const charge = getValueById("incomingChargeName") || getValueById("currentChargeName") || getValueById("chargeName");
    const leader = getValueById("incomingMentorName") || getValueById("incomingCtaName") || getValueById("currentMentorName") || getValueById("mentorName");
    const shift = getShiftTypeLabel([], []);
    return {
      charge,
      leader,
      dateShift: `${getShiftDateLabel()} ${shift && shift !== "-" ? shift : ""}`.trim(),
      census: census || "None",
      remote_tele: countRoomsForTag("tele"),
      csc_nih: roomsLine("nih"),
      isolation: roomsLine("isolation"),
      restraints: roomsLine("restraint"),
      vpo: roomsLine("vpo"),
    };
  }

  function renderHighRiskStructuredEditor() {
    const root = document.getElementById("highRiskStructuredEditor");
    if (!root) return;
    if (highRiskEditorHasActiveTypingFocus()) {
      window.__highRiskRenderPending = true;
      return;
    }
    window.__highRiskRenderPending = false;
    root.style.maxWidth = "none";
    root.style.margin = "0 0 12px 0";
    root.style.padding = "0";
    const draft = refreshHighRiskDraftFromPatients();
    const auto = getChargeReportAutoValues();

    function renderToolbar(id) {
      return `
        <div class="hr-rich-toolbar" data-toolbar-for="${escapeHtml(id)}">
          <button type="button" data-hr-cmd="bold"><strong>B</strong></button>
          <button type="button" data-hr-cmd="underline"><u>U</u></button>
          <button type="button" data-hr-cmd="justifyLeft">Left</button>
          <button type="button" data-hr-cmd="justifyCenter">Center</button>
          <button type="button" data-hr-cmd="justifyRight">Right</button>
          <button type="button" data-hr-cmd="insertUnorderedList">List</button>
        </div>
      `;
    }

    function renderRichField(id, opts = {}) {
      const value = richValueOrBlank(draft.details?.[id]);
      return `
        <div class="hr-rich-wrap ${opts.tall ? "hr-rich-tall" : ""}">
          ${renderToolbar(id)}
          <div class="hr-rich-input" contenteditable="true" data-hr-rich="${escapeHtml(id)}">${value}</div>
        </div>
      `;
    }

    function renderReportRow(row) {
      const autoValue = Object.prototype.hasOwnProperty.call(auto, row.id) ? auto[row.id] : null;
      return `
        <div class="hr-charge-row ${row.tall ? "hr-row-tall" : ""}">
          <div class="hr-charge-label">${escapeHtml(row.label)}</div>
          <div class="hr-charge-value">
            ${autoValue != null
              ? `<div class="hr-auto-value">${escapeHtml(autoValue || "None")}</div>`
              : renderRichField(row.id, { tall: row.tall })}
          </div>
        </div>
      `;
    }

    const reportRows = [
      { id: "census", label: "CENSUS / Staffed Beds" },
      { id: "remote_tele", label: "REMOTE TELE" },
      { id: "csc_nih", label: "CSC w/ NIH" },
      { id: "isolation", label: "ISOLATION" },
      { id: "restraints", label: "Restraints" },
      ...CHARGE_REPORT_TEXT_ROWS.slice(0, 5),
      { id: "vpo", label: "VPO" },
      ...CHARGE_REPORT_TEXT_ROWS.slice(5),
    ];

    root.innerHTML = `
      <style>
        .hr-editor-sheet{ background:#fff; border:1px solid #111; color:#111; font-family:Arial, Helvetica, sans-serif; }
        .hr-editor-title{ text-align:center; font-size:28px; font-weight:800; line-height:1.1; padding:12px 8px 4px; }
        .hr-header-grid{ display:grid; grid-template-columns:1fr 1fr; border-top:1px solid #111; border-bottom:1px solid #111; }
        .hr-header-line{ display:grid; grid-template-columns:auto 1fr; align-items:center; min-height:30px; border-right:1px solid #111; }
        .hr-header-line:nth-child(2){ border-right:0; }
        .hr-header-line.hr-wide{ grid-column:1 / -1; border-top:1px solid #111; border-right:0; }
        .hr-header-line strong{ padding:4px 10px; font-size:18px; }
        .hr-header-line span{ padding:4px 10px; font-size:18px; border-left:1px solid #111; min-height:100%; display:flex; align-items:center; }
        .hr-charge-row{ display:grid; grid-template-columns:37% 63%; min-height:24px; border-bottom:1px solid #111; }
        .hr-charge-label{ padding:2px 8px; font-size:17px; line-height:1.12; display:flex; align-items:center; border-right:1px solid #111; }
        .hr-charge-value{ padding:0; min-width:0; }
        .hr-auto-value{ padding:2px 8px; font-size:17px; line-height:1.12; white-space:pre-wrap; min-height:23px; }
        .hr-row-tall{ min-height:82px; }
        .hr-rich-wrap{ min-height:28px; }
        .hr-rich-toolbar{ display:flex; flex-wrap:wrap; gap:3px; padding:3px 5px; border-bottom:1px solid #d1d5db; background:#f8fafc; }
        .hr-rich-toolbar button{ border:1px solid #cbd5e1; background:#fff; color:#111827; border-radius:4px; min-height:24px; padding:2px 7px; font-size:12px; font-weight:700; }
        .hr-rich-input{ min-height:28px; padding:4px 9px; font-size:18px; line-height:1.2; outline:none; overflow-wrap:anywhere; }
        .hr-rich-tall .hr-rich-input{ min-height:64px; }
        .hr-bottom-block{ padding:12px 0 0; border:0; background:#fff; }
        .hr-bottom-title{ font-size:17px; font-weight:800; text-decoration:underline; margin:0 0 4px; }
        .hr-bottom-block .hr-rich-wrap{ border:1px solid #cbd5e1; }
        .hr-bottom-block .hr-rich-input{ min-height:70px; font-size:16px; }
      </style>
      <div class="hr-editor-sheet">
        <div class="hr-editor-title">Charge Nurse Communication Report</div>
        <div class="hr-header-grid">
          <div class="hr-header-line"><strong>CHARGE:</strong><span>${escapeHtml(auto.charge || "")}</span></div>
          <div class="hr-header-line"><strong>Date:</strong><span>${escapeHtml(auto.dateShift || "")}</span></div>
          <div class="hr-header-line hr-wide"><strong>LEADER (MENTOR/RESOURCE):</strong><span>${escapeHtml(auto.leader || "")}</span></div>
        </div>
        ${reportRows.map(renderReportRow).join("")}
      </div>
      <div class="hr-bottom-block">
        <div class="hr-bottom-title">High-Risk Pts:</div>
        ${renderRichField("high_risk_pts", { tall: true })}
      </div>
      <div class="hr-bottom-block">
        <div class="hr-bottom-title">Daily Packet, in this order:</div>
        <div style="font-size:16px; line-height:1.25;">${escapeHtml(DAILY_PACKET_TEXT)}</div>
      </div>
    `;

    root.querySelectorAll("[data-hr-rich]").forEach((el) => {
      el.addEventListener("input", () => { collectHighRiskDraftFromUi(); });
      el.addEventListener("blur", () => {
        collectHighRiskDraftFromUi();
        if (window.__highRiskRenderPending) {
          window.__highRiskRenderPending = false;
          setTimeout(() => {
            try { renderHighRiskStructuredEditor(); } catch (_) {}
          }, 0);
        }
      });
    });
    root.querySelectorAll("[data-hr-cmd]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const wrap = btn.closest(".hr-rich-wrap");
        const editor = wrap ? wrap.querySelector("[data-hr-rich]") : null;
        if (!editor) return;
        editor.focus();
        try { document.execCommand(btn.getAttribute("data-hr-cmd"), false, null); } catch (_) {}
        collectHighRiskDraftFromUi();
      });
    });
  }

  function buildHighRiskHandoffSection(opts = {}) {
    const draft = normalizeHandoffDraft(opts);
    const auto = getChargeReportAutoValues();
    const richValue = (id) => {
      const html = sanitizeRichHtml(draft.details?.[id]);
      return html || "None";
    };

    const reportRows = [
      { id: "census", label: "CENSUS / Staffed Beds" },
      { id: "remote_tele", label: "REMOTE TELE" },
      { id: "csc_nih", label: "CSC w/ NIH" },
      { id: "isolation", label: "ISOLATION" },
      { id: "restraints", label: "Restraints" },
      ...CHARGE_REPORT_TEXT_ROWS.slice(0, 5),
      { id: "vpo", label: "VPO" },
      ...CHARGE_REPORT_TEXT_ROWS.slice(5),
    ];

    const rowHtml = reportRows.map((row) => {
      const value = Object.prototype.hasOwnProperty.call(auto, row.id)
        ? escapeHtml(auto[row.id] || "None")
        : richValue(row.id);
      return `
        <div class="hr-report-row ${row.tall ? "hr-row-tall" : ""}">
          <div class="hr-report-label">${escapeHtml(row.label)}</div>
          <div class="hr-report-value">${value}</div>
        </div>
      `;
    }).join("");

    return `
      <section class="handoff-risk-page">
        <div class="hr-title">Charge Nurse Communication Report</div>
        <div class="hr-report-sheet">
          <div class="hr-head-row">
            <div><strong>CHARGE:</strong> ${escapeHtml(auto.charge || "")}</div>
            <div><strong>Date:</strong> ${escapeHtml(auto.dateShift || "")}</div>
          </div>
          <div class="hr-head-row hr-head-wide">
            <div><strong>LEADER (MENTOR/RESOURCE):</strong> ${escapeHtml(auto.leader || "")}</div>
          </div>
          ${rowHtml}
        </div>
        <div class="hr-high-risk">
          <strong><u>High-Risk Pts:</u></strong>
          <div>${richValue("high_risk_pts")}</div>
        </div>
        <div class="hr-daily-packet">
          <strong>Daily Packet, in this order:</strong>
          <div>${escapeHtml(DAILY_PACKET_TEXT)}</div>
        </div>
      </section>
    `;
  }

  function appendHighRiskSectionToDocument(htmlDoc, sectionHtml) {
    const style = `
      <style>
        @page { size: 8.5in 11in; margin: 0.28in; }
        .handoff-risk-page{
          break-before:page;
          page-break-before:always;
          padding:0;
          font-family:Arial, Helvetica, sans-serif;
          color:#000;
          width:100%;
        }
        .hr-title{ font-size:25px; font-weight:800; text-align:center; margin:0 0 4px; }
        .hr-report-sheet{ border:1px solid #111; }
        .hr-head-row{ display:grid; grid-template-columns:1fr 0.45fr; border-bottom:1px solid #111; min-height:23px; }
        .hr-head-row > div{ padding:2px 8px; font-size:17px; line-height:1.1; border-left:1px solid #111; }
        .hr-head-row > div:first-child{ border-left:0; }
        .hr-head-wide{ display:block; }
        .hr-head-wide > div{ border-left:0; text-align:left; }
        .hr-report-row{ display:grid; grid-template-columns:46% 54%; min-height:20px; border-bottom:1px solid #111; break-inside:avoid; page-break-inside:avoid; }
        .hr-report-row:last-child{ border-bottom:0; }
        .hr-row-tall{ min-height:58px; }
        .hr-report-label{ padding:2px 8px; font-size:17px; line-height:1.08; display:flex; align-items:center; border-right:1px solid #111; }
        .hr-report-value{ padding:2px 8px; font-size:17px; line-height:1.1; white-space:normal; overflow-wrap:anywhere; }
        .hr-report-value p,.hr-report-value div{ margin:0; }
        .hr-report-value ul,.hr-report-value ol{ margin:0 0 0 18px; padding:0; }
        .hr-high-risk{ margin-top:20px; font-size:14.5px; line-height:1.25; overflow-wrap:anywhere; }
        .hr-high-risk > div{ display:inline; }
        .hr-high-risk p,.hr-high-risk div{ margin:0; }
        .hr-daily-packet{ margin-top:18px; font-size:14px; line-height:1.25; overflow-wrap:anywhere; }
        .hr-daily-packet div{ display:inline; }
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
      String(block.getAttribute("data-print-title") || "").trim() ||
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
      .filter(Boolean)
      .filter((card) => !isHoldOwnerTitle(card?.title));
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
    const noRole = raw.replace(/\((RN|PCA|SITTER|SITTER ASSIGNMENT|MOD ASSIGNMENT)\)/gi, "").trim();
    const idMatch = noRole.match(/(?:#?\s*)(\d{5,})$/);
    const id = idMatch ? `#${idMatch[1]}` : "";
    const name = noRole.replace(/(?:#?\s*)\d{5,}$/, "").trim() || noRole || String(fallback || "");
    return { name, id };
  }

  function isPlaceholderStaffName(name, role) {
    const text = String(name || "").trim();
    const r = String(role || "").toLowerCase() === "pca" ? "pca" : "rn";
    return new RegExp(`^(current|incoming)?\\s*${r}\\s*\\d+$`, "i").test(text);
  }

  function explicitFourDigitExtension(seed) {
    const s = String(seed || "").trim();
    if (!s) return "";
    const direct = s.match(/\b(?:x|ext\.?|extension)?\s*(\d{4})\b/i);
    if (direct) return `x${direct[1]}`;
    return "";
  }

  function staffPrintName(title, fallback, role) {
    const staff = splitStaffDisplay(title || "", fallback || role || "");
    const ext = explicitFourDigitExtension(title || staff.name || "");
    const nameRaw = String(staff.name || "").replace(/\b(?:x|ext\.?|extension)?\s*\d{4}\b/i, "").trim();
    const name = isPlaceholderStaffName(nameRaw, role) ? "" : nameRaw;
    return [name, ext].filter(Boolean).join(" ");
  }

  function patientForPrintRoom(room) {
    const cleanRoom = stripPins(room || "");
    if (!cleanRoom) return null;
    return getActivePatients().find((p) => stripPins(getRoomLabelForPrint(p)) === cleanRoom) || null;
  }

  function rowIsTeleOrNih(row) {
    const p = patientForPrintRoom(row?.room);
    if (p && (p.tele || p.nih || p.emu)) return true;
    const level = String(row?.level || "");
    const notes = String(row?.notes || "");
    return !!level.trim() || /\b(nih|emu)\b/i.test(notes);
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

  function renderSixNorthRnBox(card) {
    const staffLine = staffPrintName(card?.title || "", "RN", "rn");
    const ratioCap = (Array.isArray(card?.rows) ? card.rows : []).some(rowIsTeleOrNih) ? 4 : 5;
    const rows = (card?.rows || [])
      .slice()
      .sort((a, b) => roomSortKey(a.room).localeCompare(roomSortKey(b.room)))
      .map((r) => {
        const tele = String(r.level || "").trim() ? "&#10084;" : "";
        return `<tr><td class="room">${escapeHtml(stripPins(r.room || ""))}</td><td class="tele">${tele}</td><td>${escapeHtml(r.notes || "")}</td></tr>`;
      })
      .join("");

    return `
      <section class="six-rn-box">
        <div class="six-rn-head">
          <div class="six-rn-line"><strong>RN:</strong> <span class="six-staff-name">${escapeHtml(staffLine)}</span></div>
          <div class="six-ratio-line"><strong>Ratio:</strong> <span>${ratioCap}:1</span></div>
        </div>
        <table><tbody>${rows || `<tr><td class="room"></td><td class="tele"></td><td></td></tr>`}</tbody></table>
      </section>
    `;
  }

  function renderSixNorthPcaBox(card, idx) {
    const staffLine = staffPrintName(card?.title || "", `PCA ${idx + 1}`, "pca");
    const rawTitle = String(card?.title || "");
    const specialLabel = /\bmod\b/i.test(rawTitle) ? "Mod" : (/\bsitter\b/i.test(rawTitle) ? "Sitter" : "");
    const rooms = (card?.rows || [])
      .map((r) => stripPins(r.room || ""))
      .filter(Boolean)
      .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));
    return `
      <section class="six-pca-box">
        <div class="six-pca-head"><strong>${specialLabel ? escapeHtml(specialLabel) + ":" : "PCA:"}</strong> <span class="six-staff-name">${escapeHtml(staffLine)}</span></div>
        <div class="six-pca-rooms">${escapeHtml(rooms.join(", "))}</div>
      </section>
    `;
  }

  function chargeReportTextLine(id) {
    try {
      const draft = normalizeHandoffDraft(loadHandoffDraft());
      const raw = String(draft?.details?.[id] || "").trim();
      let text = raw;
      if (/<[a-z][\s\S]*>/i.test(raw) && typeof document !== "undefined") {
        const div = document.createElement("div");
        div.innerHTML = raw.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|p|li)>/gi, "\n");
        text = div.textContent || "";
      } else {
        text = raw.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
      }
      text = String(text || "").replace(/\u00a0/g, " ").replace(/&nbsp;/gi, " ").trim();
      if (!text || text === "None") return "";
      return text.replace(/\s*\r?\n\s*/g, "; ");
    } catch (_) {
      return "";
    }
  }

  function renderSixNorthTaskRows() {
    const rows = [
      ["CSC", roomsLineForAnyTag("nih")],
      ["Total Care", roomsLineForAnyTag(["q2turns", "q2Turns", "strictIo", "heavy"])],
      ["1:1 Feed", roomsLineForAnyTag(["feeder", "feeders"])],
      ["Code Burt/55", chargeReportTextLine("code_burt")],
      ["VPO", roomsLine("vpo")],
      ["Comfort", chargeReportTextLine("comfort_care")],
      ["Float", chargeReportTextLine("floated")],
      ["Flex", chargeReportTextLine("flexed")]
    ];
    return rows.map(([label, value]) => `
      <div class="six-task-row">
        <strong>${escapeHtml(label)}:</strong>
        <span>${escapeHtml(value === "None" ? "" : value)}</span>
      </div>
    `).join("");
  }

  function renderSixNorthMap() {
    const top = ["52","51","50","49","48","47","46","45","44","43","42","41"];
    const mid = ["53","54","55","56","57","58","59"];
    const f = ["60","61","62","63","64","65","66"];
    const right = ["76","75","74","73","72","71","70","69","68","67"];
    return `
      <div class="six-map">
        <div class="map-strip strip-a">${top.map(n => `<span>${n}</span>`).join("")}</div>
        <div class="map-strip strip-b">${mid.map(n => `<span>${n}</span>`).join("")}</div>
        <div class="map-tower tower-d"><strong>D</strong></div>
        <div class="map-tower tower-e"><strong>E</strong></div>
        <div class="map-stack stack-f">${f.map(n => `<span>${n}</span>`).join("")}</div>
        <div class="map-stack stack-g">${right.map(n => `<span>${n}</span>`).join("")}</div>
        <div class="map-tower tower-f"><strong>F</strong></div>
        <div class="map-heart">&#10084;</div>
      </div>
    `;
  }

  function buildPrintHTMLSixNorth(data) {
    const rnCards = (data.rnCards || []).slice(0, 9);
    while (rnCards.length < 9) rnCards.push({ title: "", rows: [] });
    const pcaCards = (data.pcaCards || [])
      .filter((card, idx) => {
        const hasPatients = Array.isArray(card?.rows) && card.rows.length > 0;
        const staffLine = staffPrintName(card?.title || "", `PCA ${idx + 1}`, "pca");
        return hasPatients || !!staffLine;
      })
      .slice(0, 7);
    const shiftDate = getShiftDateLabel();
    const shift = getShiftTypeLabel(data.rnCards, data.pcaCards);
    const dateShift = `${shiftDate} ${shift && shift !== "-" ? shift : ""}`.trim();

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>6 North Assignments</title>
<style>
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; background:#fff; color:#000; font-family:Arial, Helvetica, sans-serif; }
  @page{ size:8.5in 11in; margin:0.22in; }
  .six-wrap{ width:8.05in; min-height:10.55in; margin:0 auto; padding-left:0.3in; display:grid; grid-template-columns:2.45in 2.45in 2.45in; grid-template-rows:0.24in 0.26in repeat(5, 1.52in); gap:0.14in; position:relative; }
  .six-date{ grid-column:1 / -1; border:1px solid #111; height:0.24in; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:800; letter-spacing:0; }
  .six-lead{ border:1px solid #111; display:grid; grid-template-columns:0.78in 1fr; height:0.24in; font-size:13px; font-weight:700; align-items:center; }
  .six-lead span:first-child{ border-right:1px solid #111; height:100%; padding:2px 4px; }
  .six-lead span:last-child{ padding:2px 4px; }
  .six-rn-box{ border:1px solid #111; display:flex; flex-direction:column; min-height:0; }
  .six-rn-head{ height:0.42in; background:#fff; border-bottom:1px solid #111; font-size:12px; line-height:1.05; padding:2px 4px; overflow:hidden; }
  .six-rn-line,.six-ratio-line{ display:flex; gap:3px; align-items:baseline; white-space:nowrap; min-width:0; }
  .six-rn-line strong,.six-ratio-line strong,.six-pca-head strong{ font-weight:800; flex:0 0 0.48in; }
  .six-rn-line span,.six-ratio-line span{ font-weight:700; overflow:hidden; text-overflow:ellipsis; }
  .six-rn-line .six-staff-name,.six-pca-head .six-staff-name{ background:#d9d9d9; padding:1px 3px; }
  .six-rn-line{ max-width:100%; }
  .six-rn-box table{ width:100%; border-collapse:collapse; table-layout:fixed; flex:1; }
  .six-rn-box td{ font-size:11px; line-height:1.05; padding:1px 3px; vertical-align:top; border:0; }
  .six-rn-box td.room{ width:0.34in; border-right:1px solid #111; text-align:center; font-weight:700; }
  .six-rn-box td.tele{ width:0.18in; color:#dc2626; text-align:center; }
  .six-side{ grid-column:3; grid-row:3 / span 5; display:flex; flex-direction:column; min-height:0; }
  .six-pca-box{ border:1px solid #111; border-bottom:0; height:0.58in; }
  .six-pca-box:nth-child(7){ border-bottom:1px solid #111; }
  .six-pca-head{ height:0.2in; font-size:14px; padding:2px 4px; background:#fff; display:flex; gap:3px; align-items:baseline; white-space:nowrap; overflow:hidden; }
  .six-pca-head span{ font-weight:700; overflow:hidden; text-overflow:ellipsis; }
  .six-pca-rooms{ font-size:11px; padding:4px; line-height:1.15; }
  .six-task-row{ border:1px solid #111; border-top:0; min-height:0.36in; font-size:14px; padding:5px 4px; background:#fff; display:flex; align-items:baseline; gap:4px; }
  .six-task-row strong{ flex:0 0 0.58in; font-weight:800; }
  .six-task-row span{ font-size:11px; min-width:0; overflow-wrap:anywhere; }
  .six-map{ border:1px solid #bbb; height:1.62in; position:relative; align-self:end; }
  .map-strip,.map-stack{ position:absolute; border:1px solid #bbb; background:#fff; display:flex; align-items:center; justify-content:space-around; font-weight:700; font-size:11px; }
  .map-strip span{ writing-mode:vertical-rl; }
  .strip-a{ left:0; top:0; width:2.18in; height:0.28in; }
  .strip-b{ left:0.02in; top:0.92in; width:1.38in; height:0.28in; }
  .map-tower{ position:absolute; border:1px solid #bbb; background:#fff; display:flex; align-items:center; justify-content:center; font-size:26px; }
  .tower-e{ left:0.52in; top:0.3in; width:0.52in; height:0.42in; }
  .tower-d{ right:0.28in; top:0.28in; width:0.52in; height:0.42in; }
  .stack-f{ right:0.38in; bottom:0.02in; width:0.44in; height:1.08in; flex-direction:column; }
  .stack-g{ right:-0.02in; bottom:0.02in; width:0.5in; height:1.5in; flex-direction:column; }
  .tower-f{ right:0.02in; bottom:0.3in; width:0.48in; height:0.42in; }
  .map-heart{ position:absolute; left:0.25in; bottom:0.25in; color:#000; font-size:16px; }
  .six-unit{ position:absolute; left:-0.04in; top:4.95in; transform:rotate(-90deg); transform-origin:center; font-weight:700; font-size:16px; white-space:nowrap; }
  .pca-rounds{ margin:0.18in auto 0; border:1px solid #111; width:0.68in; height:0.48in; display:flex; align-items:center; justify-content:center; text-align:center; font-weight:700; font-size:13px; }
  @media print{ .six-wrap{ margin:0; } }
</style>
</head>
<body>
  <div class="six-wrap">
    <div class="six-date">${escapeHtml(dateShift)}</div>
    <div class="six-lead"><span>Charge:</span><span>${escapeHtml(data.charge || "")}</span></div>
    <div class="six-lead"><span>Mentor:</span><span>${escapeHtml(data.mentor || "")}</span></div>
    <div class="six-lead"><span>CTA:</span><span>${escapeHtml(data.cta || "")}</span></div>
    <div class="six-unit">6 North</div>
    ${renderSixNorthRnBox(rnCards[0])}
    ${renderSixNorthRnBox(rnCards[1])}
    <div class="six-side">
      ${pcaCards.map(renderSixNorthPcaBox).join("")}
      ${renderSixNorthTaskRows()}
      <div class="pca-rounds">PCA<br>Rounds</div>
    </div>
    ${renderSixNorthRnBox(rnCards[2])}
    ${renderSixNorthRnBox(rnCards[3])}
    ${renderSixNorthRnBox(rnCards[4])}
    ${renderSixNorthRnBox(rnCards[5])}
    ${renderSixNorthRnBox(rnCards[6])}
    ${renderSixNorthRnBox(rnCards[7])}
    ${renderSixNorthRnBox(rnCards[8])}
    ${renderSixNorthMap()}
  </div>
</body>
</html>`;
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

  function renderLegacyWorksheetPcaRows(pcaCards, fallbackName) {
    const rows = (pcaCards || [])
      .filter((c) => !isHoldOwnerTitle(c?.title) && !isSitterOwnerTitle(c?.title))
      .map((c) => {
      const rooms = (c.rows || [])
        .map((r) => stripPins(r.room || ""))
        .filter(Boolean)
        .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));
      const title = String(c.title || fallbackName || "PCA").trim();
      return `<tr><td class="pca-name">${escapeHtml(title)}</td><td class="num">${rooms.length}</td><td class="pca-rooms">${escapeHtml(rooms.join(", ")) || "-"}</td></tr>`;
    }).join("");
    return rows || `<tr><td colspan="3">None</td></tr>`;
  }

  function isHoldOwnerTitle(title) {
    const t = String(title || "").toLowerCase();
    return t.includes("needs to be assigned") || t.includes("(hold)") || t.includes("hold");
  }

  function isSitterOwnerTitle(title) {
    const t = String(title || "").toLowerCase();
    return /\bsitter\b/.test(t) || /\bmod\b/.test(t);
  }

  function roomPairLabel(pairKey) {
    const pair = String(pairKey || "").trim();
    if (!pair) return "";
    return `${pair}A/${pair}B`;
  }

  function configuredSitterAssignments(pcaOwners) {
    return (Array.isArray(pcaOwners) ? pcaOwners : [])
      .filter((pca) => pca && pca.isSitter && String(pca.sitterRoomPair || "").trim())
      .map((pca) => ({
        room: String(pca.sitterRoomPair || "").trim(),
        label: `${String(pca.sitterRoomPair || "").trim()} - ${String(pca.name || "Sitter PCA").trim()}`
      }))
      .sort((a, b) => roomSortKey(a.room).localeCompare(roomSortKey(b.room)));
  }

  function collectHoldRoomsFromCards(cards) {
    const out = [];
    (Array.isArray(cards) ? cards : []).forEach((c) => {
      if (!isHoldOwnerTitle(c?.title)) return;
      (Array.isArray(c.rows) ? c.rows : []).forEach((r) => {
        const room = stripPins(r?.room || "");
        if (room) out.push(room);
      });
    });
    return Array.from(new Set(out)).sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));
  }

  function renderLegacyWorksheetSpecialRows(rnCards, pcaCards, pcaOwners) {
    const pcaCardList = Array.isArray(pcaCards) ? pcaCards : [];
    const rnCardList = Array.isArray(rnCards) ? rnCards : [];
    const sitter = configuredSitterAssignments(pcaOwners);
    const vpo = [];
    pcaCardList.forEach((c) => {
      const title = String(c.title || "PCA").trim();
      const rows = Array.isArray(c.rows) ? c.rows : [];
      rows
        .filter((r) => /sitter/i.test(String(r.notes || "")) || isSitterOwnerTitle(title))
        .forEach((r) => {
          const room = stripPins(r.room || "");
          if (!room) return;
          const label = `${room} - ${title}`;
          if (!sitter.some((entry) => entry.label === label)) sitter.push({ room, label });
        });
    });

    rnCardList.concat(pcaCardList).forEach((c) => {
      const title = String(c.title || "").trim();
      const rows = Array.isArray(c.rows) ? c.rows : [];
      rows
        .filter((r) => /vpo/i.test(String(r.notes || "")))
        .forEach((r) => {
          const room = stripPins(r.room || "");
          if (!room) return;
          vpo.push({ room });
        });
    });

    const sitterLines = sitter
      .sort((a, b) => roomSortKey(a.room).localeCompare(roomSortKey(b.room)))
      .map((s) => s.label);

    const vpoLines = vpo
      .sort((a, b) => roomSortKey(a.room).localeCompare(roomSortKey(b.room)))
      .map((x) => `${x.room}`);

    return {
      sitterHtml: sitterLines.length ? sitterLines.map((x) => `<div>${escapeHtml(x)}</div>`).join("") : "",
      vpoHtml: vpoLines.length ? vpoLines.map((x) => `<div>${escapeHtml(x)}</div>`).join("") : ""
    };
  }

  function renderLegacyWorksheetRnGrid(rnCards, fallbackName) {
    const cardList = (rnCards || []).filter((c) => !isHoldOwnerTitle(c?.title));
    const cards = cardList.map((c) => {
      const rows = (c.rows || []).map((r) => ({
        room: stripPins(r.room || ""),
        level: String(r.level || ""),
        notes: String(r.notes || "")
      }));
      const displayRows = rows.length ? rows.slice() : [{ room: "", level: "", notes: "" }];
      while (displayRows.length < 4) displayRows.push({ room: "", level: "", notes: "" });
      const title = String(c.title || fallbackName || "RN").trim();

      const bodyRows = displayRows.map((r, idx) => `
        <tr>
          ${idx === 0 ? `<td class="rn-name" rowspan="${displayRows.length}">${escapeHtml(title).replace(/\s+/g, " ")}</td>` : ""}
          <td class="room">${escapeHtml(r.room)}</td>
          <td class="acty">${escapeHtml(r.level)}</td>
          <td class="notes">${escapeHtml(r.notes)}</td>
        </tr>
      `).join("");

      return `
        <table class="ws-rn-card">
          <thead>
            <tr><th>RN</th><th>ROOM #</th><th>ACTY</th><th>NOTES</th></tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      `;
    });

    while (cards.length % 3 !== 0) {
      cards.push(`
        <table class="ws-rn-card ws-rn-card-empty">
          <thead><tr><th>RN</th><th>ROOM #</th><th>ACTY</th><th>NOTES</th></tr></thead>
          <tbody>
            <tr><td class="rn-name" rowspan="4"></td><td class="room"></td><td class="acty"></td><td class="notes"></td></tr>
            <tr><td class="room"></td><td class="acty"></td><td class="notes"></td></tr>
            <tr><td class="room"></td><td class="acty"></td><td class="notes"></td></tr>
            <tr><td class="room"></td><td class="acty"></td><td class="notes"></td></tr>
          </tbody>
        </table>
      `);
    }

    return cards.join("") || `<table class="ws-rn-card"><thead><tr><th>RN</th><th>ROOM #</th><th>ACTY</th><th>NOTES</th></tr></thead><tbody><tr><td class="rn-name" rowspan="4">${escapeHtml(fallbackName || "RN")}</td><td class="room"></td><td class="acty"></td><td class="notes"></td></tr><tr><td class="room"></td><td class="acty"></td><td class="notes"></td></tr><tr><td class="room"></td><td class="acty"></td><td class="notes"></td></tr><tr><td class="room"></td><td class="acty"></td><td class="notes"></td></tr></tbody></table>`;
  }


  function buildPrintHTMLTraditional(data) {
    const shiftDate = getShiftDateLabel();
    const shift = getShiftTypeLabel(data.rnCards, data.pcaCards);
    const printTitle = getPrintHeaderTitle(shift);
    const openRooms = getOpenRoomLabels();
    const holdRooms = collectHoldRoomsFromCards(data.pcaCards).concat(collectHoldRoomsFromCards(data.rnCards || []));
    const availabilityRooms = Array.from(new Set([...(openRooms || []), ...holdRooms]))
      .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));
    const pcaRows = renderLegacyWorksheetPcaRows(data.pcaCards, "Incoming PCA");
    const rnGrid = renderLegacyWorksheetRnGrid(data.rnCards, "Incoming RN");
    const specials = renderLegacyWorksheetSpecialRows(data.rnCards, data.pcaCards, data.pcaOwners);

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Oncoming Assignments - Print (Traditional)</title>
<style>
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; background:#fff; color:#111827; font-family:"Times New Roman", serif; }
  @page { margin:4mm; size:11in 8.5in; }
  .wrap{ padding:1px; width:100%; max-width:100%; margin:0 auto; min-height:8.2in; }
  .ws-page-title{ text-align:center; font-size:24px; font-weight:700; line-height:1.1; margin:6px 0 10px; }
  :root{ --ws-line:0.8px solid #111; }
  .ws-table{ width:100%; border-collapse:collapse; table-layout:fixed; }
  .ws-table th,.ws-table td{ border:var(--ws-line); padding:2px 4px; font-size:11px; line-height:1.12; vertical-align:top; }
  .ws-pca-table{ table-layout:fixed; }
  .ws-pca-table td.pca-name{ white-space:nowrap; width:18%; }
  .ws-pca-table td.num{ width:7%; }
  .ws-pca-table td.pca-rooms{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:40%; }
  .ws-head{ font-weight:700; text-align:center; }
  .ws-top-grid{ display:grid; grid-template-columns:1.68fr .82fr; gap:0; border:var(--ws-line); border-bottom:none; }
  .ws-top-grid > div{ border-right:var(--ws-line); }
  .ws-top-grid > div:last-child{ border-right:none; }
  .ws-date{ text-align:center; font-size:44px; font-weight:700; line-height:1.04; margin-top:4px; }
  .ws-msg{ text-align:center; font-size:21px; font-weight:700; margin-top:4px; }
  .ws-mid{ display:grid; grid-template-columns:.88fr 1.24fr .88fr; border:var(--ws-line); border-top:none; }
  .ws-mid > div{ border-right:var(--ws-line); min-height:140px; }
  .ws-mid > div:last-child{ border-right:none; }
  .ws-box-title{ font-size:12px; font-weight:700; text-align:center; margin:2px 0; }
  .ws-line{ border-top:var(--ws-line); min-height:20px; padding:2px 4px; font-size:11px; }
  .ws-list{ padding:2px 4px; font-size:10px; line-height:1.2; }
  .ws-leadership-box{
    min-height:140px;
    display:flex;
    flex-direction:column;
    justify-content:space-evenly;
    align-items:center;
    text-align:center;
    padding:4px 6px;
    font-size:19px;
    font-weight:700;
    border-left:var(--ws-line);
    border-right:var(--ws-line);
    height:100%;
  }
  .ws-rn-grid{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:0; border-left:var(--ws-line); border-right:var(--ws-line); border-bottom:var(--ws-line); }
  .ws-rn-card{ width:100%; border-collapse:collapse; table-layout:fixed; }
  .ws-rn-card th,.ws-rn-card td{ padding:2px 3px; font-size:11px; line-height:1.05; vertical-align:top; border-left:var(--ws-line); border-right:var(--ws-line); }
  .ws-rn-card thead th{ text-align:center; font-weight:700; border-top:var(--ws-line); border-bottom:var(--ws-line); }
  .ws-rn-card tbody td{ border-top:none; border-bottom:none; }
  .ws-rn-card tbody tr:last-child td{ border-bottom:var(--ws-line); }
  .ws-rn-card td.room{ text-align:center; width:17%; }
  .ws-rn-card td.acty{ text-align:center; width:8%; }
  .ws-rn-card td.notes{ text-align:center; font-size:9px; }
  .ws-rn-card td.rn-name{ width:31%; text-align:center; font-weight:700; vertical-align:middle; }
  .num{ width:60px; text-align:center; font-weight:700; }
  .availability-room{ font-size:11px; line-height:1.2; padding:4px; }
  @media print { .wrap{ padding:0; } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="ws-page-title">${escapeHtml(printTitle)}</div>
    <div class="ws-top-grid">
      <div>
        <table class="ws-table ws-pca-table">
          <tbody>
            ${pcaRows}
          </tbody>
        </table>
      </div>
      <div>
        <div class="ws-date">${escapeHtml(shiftDate)} ${escapeHtml(shift)}</div>
        <div class="ws-msg">Have a great shift! :)</div>
      </div>
    </div>

    <div class="ws-mid">
      <div>
        <div class="ws-line"><strong>Flex</strong></div>
        <div class="ws-line"><strong>Float</strong></div>
        <div class="ws-line"><strong>Sitters</strong><div class="ws-list">${specials.sitterHtml || ""}</div></div>
        <div class="ws-line"><strong>VPO</strong><div class="ws-list">${specials.vpoHtml || ""}</div></div>
      </div>
      <div>
        <div class="ws-leadership-box">
          <div>Charge Nurse: ${escapeHtml(data.charge || "-")}</div>
          <div>Clinical Mentor: ${escapeHtml(data.mentor || "-")}</div>
          <div>CTA: ${escapeHtml(data.cta || "-")}</div>
        </div>
      </div>
      <div>
        <div class="ws-box-title">Room Availability</div>
        <table class="ws-table">
          <tbody><tr><td class="availability-room">${escapeHtml(availabilityRooms.join(", ") || "None")}</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="ws-rn-grid">${rnGrid}</div>
  </div>
</body>
</html>`;
  }

  function buildPrintHTMLNew(data) {
    const shiftDate = getShiftDateLabel();
    const shift = getShiftTypeLabel(data.rnCards, data.pcaCards);
    const printTitle = getPrintHeaderTitle(shift);
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
  .wrap{ padding:2px; width:100%; max-width:100%; margin:0 auto; overflow:hidden; }
  .page-title{ text-align:center; font-size:24px; font-weight:700; line-height:1.1; margin:4px 0 8px; }
  .top{ display:grid; grid-template-columns:1.5fr 1.1fr; gap:6px; margin-bottom:4px; align-items:stretch; width:100%; max-width:100%; }
  .box{ border:1px solid #111; padding:5px 7px; min-height:54px; }
  .title{ font-weight:700; font-size:13px; text-align:center; margin-bottom:4px; }
  .center-line{ text-align:center; font-weight:700; margin:4px 0; font-size:12px; line-height:1.2; }
  .right-top{ text-align:center; font-size:30px; font-weight:700; line-height:1.04; margin-bottom:3px; }
  .open-rooms{ font-size:11px; line-height:1.22; word-break:break-word; }
  table{ width:100%; border-collapse:collapse; table-layout:fixed; max-width:100%; }
  th,td{ border:1px solid #111; padding:2px 3px; font-size:11px; vertical-align:top; overflow-wrap:anywhere; word-break:break-word; }
  th{ background:#f3f4f6; text-align:center; font-weight:700; }
  .trad-pca-wrap{ margin-top:6px; }
  .trad-pca-row{ display:grid; grid-template-columns:repeat(var(--pca-cols), minmax(0, 1fr)); gap:6px; }
  .trad-pca-card{ border:1px solid #111; min-width:0; }
  .trad-pca-head{ border-bottom:1px solid #111; text-align:center; font-weight:700; padding:2px 2px; font-size:11px; }
  .trad-pca-card table{ table-layout:fixed; }
  .trad-pca-card th, .trad-pca-card td{ padding:1px 2px; line-height:1.02; font-size:9px; }
  .trad-pca-card th:nth-child(1), .trad-pca-card td:nth-child(1){ width:24%; text-align:center; font-weight:700; }
  .trad-pca-card th:nth-child(2), .trad-pca-card td:nth-child(2){ width:18%; text-align:center; font-weight:700; }
  .trad-pca-card th:nth-child(3){ text-align:center; }
  .trad-pca-card td:nth-child(3){ text-align:center; }
  .trad-rn-grid{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; width:100%; max-width:100%; }
  .trad-rn-head{ border:1px solid #111; border-bottom:none; text-align:center; font-weight:700; padding:4px 3px; font-size:13px; }
  .trad-rn-card table{ table-layout:fixed; }
  .trad-rn-card th, .trad-rn-card td{ padding:2px 2px; line-height:1.04; font-size:10px; }
  .trad-rn-card th:nth-child(1), .trad-rn-card td:nth-child(1){ width:20%; text-align:center; font-weight:700; }
  .trad-rn-card th:nth-child(2), .trad-rn-card td:nth-child(2){ width:13%; text-align:center; font-weight:700; }
  .trad-rn-card th:nth-child(3){ text-align:center; }
  .trad-rn-card td:nth-child(3){ text-align:center; font-size:8.9px; }
  .trad-empty{ border:1px solid #111; padding:8px; font-size:12px; }
  @media print { .wrap{ padding:0; } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="page-title">${escapeHtml(printTitle)}</div>
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
      pcaOwners: Array.isArray(window.incomingPcas) ? window.incomingPcas : [],
    };
  }

  function buildOncomingPreviewDoc(mode, includePacket) {
    const selectedMode = String(mode || "new").toLowerCase() === "traditional" ? "traditional" : "new";
    const handoffInput = collectHighRiskDraftFromUi();
    const data = collectOncomingPrintData();
    const assignmentHtml = buildPrintHTMLSixNorth(data);
    if (!includePacket) return assignmentHtml;
    refreshHighRiskDraftFromPatients();
    return appendHighRiskSectionToDocument(
      assignmentHtml,
      buildHighRiskHandoffSection(handoffInput)
    );
  }

  async function openPrintPreview(mode) {
    try {
      window.__oncomingPreviewRerender = null;
      const html = buildOncomingPreviewDoc("sixnorth", false);
      openInAppPrintPreview(html, "6 North Worksheet", { mode: "sixnorth", allowModeSwitch: false });
    } catch (e) {
      console.error("[printOncoming] open() error:", e);
      alert("Print failed. See console for details.");
    }
  }

  async function openPacketPreview(mode) {
    try {
      const selectedMode = String(mode || "traditional").toLowerCase() === "traditional" ? "traditional" : "new";
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
  window.__buildSixNorthAssignmentPrint = buildPrintHTMLSixNorth;
  window.app.printOncoming = window.printOncoming;

  function hookAcuityTilesAutoRefresh() {
    if (window.__highRiskAutoRefreshWrapped) return;
    if (typeof window.updateAcuityTiles !== "function") return;
    const original = window.updateAcuityTiles;
    window.updateAcuityTiles = function wrappedUpdateAcuityTiles() {
      const out = original.apply(this, arguments);
      try {
        if (highRiskEditorHasActiveTypingFocus()) window.__highRiskRenderPending = true;
        else renderHighRiskStructuredEditor();
      } catch (_) {}
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
