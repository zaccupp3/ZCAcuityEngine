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

  function collectHighRiskSections() {
    const active = getActivePatients();
    const config = [
      { label: "Drips", key: "drip" },
      { label: "NIH", key: "nih" },
      { label: "BG Checks", key: "bg" },
      { label: "CIWA/COWS", key: "ciwa" },
      { label: "Restraints", key: "restraint" },
      { label: "Sitters", key: "sitter" },
      { label: "VPO", key: "vpo" },
      { label: "Isolation", key: "isolation" },
      { label: "Admits", key: "admit" },
      { label: "Late DC", key: "lateDc" },
      { label: "CHG", key: "chg" },
      { label: "Foley", key: "foley" },
      { label: "Q2 Turns", key: "q2turns" },
      { label: "Heavy", key: "heavy" },
      { label: "Feeders", key: "feeder" },
    ];

    return config
      .map((c) => {
        const rooms = active
          .filter((p) => !!p[c.key])
          .map((p) => getRoomLabelForPrint(p))
          .filter(Boolean)
          .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));
        return { ...c, rooms, count: rooms.length };
      })
      .filter((s) => s.count > 0);
  }

  function getDripRooms() {
    return getActivePatients()
      .filter((p) => !!p.drip)
      .map((p) => getRoomLabelForPrint(p))
      .filter(Boolean)
      .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));
  }

  function loadHandoffDraft() {
    try {
      const raw = localStorage.getItem("handoffPacketDraft");
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) {}
    return { dripByRoom: {}, endorsements: "" };
  }

  function saveHandoffDraft(draft) {
    try {
      localStorage.setItem("handoffPacketDraft", JSON.stringify(draft || {}));
    } catch (_) {}
  }

  function showHandoffInputModal(dripRooms) {
    const rooms = Array.isArray(dripRooms) ? dripRooms : [];
    const prior = loadHandoffDraft();
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = [
        "position:fixed", "inset:0", "background:rgba(15,23,42,0.5)",
        "display:flex", "align-items:center", "justify-content:center",
        "z-index:10002", "padding:16px"
      ].join(";");

      const rowsHtml = rooms.length
        ? rooms.map((room) => `
            <div style="display:grid; grid-template-columns:92px 1fr; gap:8px; align-items:center;">
              <label for="handoffDrip_${escapeHtml(room)}" style="font-weight:700;">Room ${escapeHtml(room)}</label>
              <input id="handoffDrip_${escapeHtml(room)}" data-room="${escapeHtml(room)}" type="text"
                placeholder="Medication and rate (e.g., Heparin 12 u/kg/hr)"
                value="${escapeHtml(prior.dripByRoom?.[room] || "")}"
                style="padding:8px 10px; border:1px solid rgba(15,23,42,0.2); border-radius:8px;" />
            </div>
          `).join("")
        : `<div style="font-size:12px; opacity:0.8;">No active drip patients currently flagged.</div>`;

      const card = document.createElement("div");
      card.style.cssText = [
        "width:min(760px,96vw)", "max-height:90vh", "overflow:auto",
        "background:#fff", "border-radius:12px", "border:1px solid rgba(15,23,42,0.16)",
        "box-shadow:0 20px 45px rgba(2,6,23,0.28)", "padding:14px"
      ].join(";");
      card.innerHTML = `
        <div style="font-weight:900; font-size:15px; color:#0f172a;">Hand-Off Details</div>
        <div style="margin-top:4px; font-size:12px; color:#475569;">Add drip details and any special endorsements before packet preview.</div>
        <div style="margin-top:12px; border:1px solid rgba(15,23,42,0.12); border-radius:10px; padding:10px;">
          <div style="font-weight:800; margin-bottom:8px;">Drip Details by Room</div>
          <div style="display:grid; gap:8px;">${rowsHtml}</div>
        </div>
        <div style="margin-top:10px; border:1px solid rgba(15,23,42,0.12); border-radius:10px; padding:10px;">
          <div style="font-weight:800; margin-bottom:8px;">Special Endorsements / Patients to Monitor</div>
          <textarea id="handoffEndorsements" rows="5" style="width:100%; padding:8px 10px; border:1px solid rgba(15,23,42,0.2); border-radius:8px; resize:vertical;">${escapeHtml(prior.endorsements || "")}</textarea>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:12px;">
          <button id="handoffCancel" type="button" style="padding:8px 12px;">Cancel</button>
          <button id="handoffContinue" type="button" style="padding:8px 12px; font-weight:700;">Continue to Preview</button>
        </div>
      `;

      overlay.appendChild(card);
      document.body.appendChild(overlay);

      const close = (result) => {
        try { overlay.remove(); } catch (_) {}
        resolve(result || null);
      };

      card.querySelector("#handoffCancel")?.addEventListener("click", () => close(null));
      card.querySelector("#handoffContinue")?.addEventListener("click", () => {
        const dripByRoom = {};
        card.querySelectorAll("input[data-room]").forEach((el) => {
          const room = String(el.getAttribute("data-room") || "");
          const text = String(el.value || "").trim();
          if (room && text) dripByRoom[room] = text;
        });
        const endorsements = String(card.querySelector("#handoffEndorsements")?.value || "").trim();
        const out = { dripByRoom, endorsements };
        saveHandoffDraft(out);
        close(out);
      });
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    });
  }

  function buildHighRiskHandoffSection(opts = {}) {
    const sections = collectHighRiskSections();
    const dripDetails = opts.dripByRoom || {};
    const endorsements = String(opts.endorsements || "").trim();

    const sectionRows = sections.map((s) => `
      <div class="hr-row">
        <div class="hr-label">${escapeHtml(s.label)} (${s.count})</div>
        <div class="hr-value">${escapeHtml(s.rooms.join(", "))}</div>
      </div>
    `).join("");

    const dripRooms = getDripRooms();
    const dripRows = dripRooms.map((room) => `
      <tr>
        <td>${escapeHtml(room)}</td>
        <td>${escapeHtml(dripDetails[room] || "")}</td>
      </tr>
    `).join("");

    return `
      <section class="handoff-risk-page">
        <div class="hr-title">High-Risk Hand-Off Report</div>
        <div class="hr-sub">Only active acuity tags are shown.</div>
        <div class="hr-sections">${sectionRows || `<div class="hr-empty">No high-risk tags flagged.</div>`}</div>
        <div class="hr-drip-wrap">
          <div class="hr-block-title">Drip Medication / Rate Details</div>
          <table class="hr-drip-table">
            <thead><tr><th>Room</th><th>Medication and Rate</th></tr></thead>
            <tbody>${dripRows || `<tr><td colspan="2">No drip patients flagged.</td></tr>`}</tbody>
          </table>
        </div>
        <div class="hr-endorse-wrap">
          <div class="hr-block-title">Special Endorsements / Patients to Monitor</div>
          <div class="hr-endorse-text">${escapeHtml(endorsements || "—")}</div>
        </div>
      </section>
    `;
  }

  function appendHighRiskSectionToDocument(htmlDoc, sectionHtml) {
    const style = `
      <style>
        .handoff-risk-page{ break-before:page; page-break-before:always; padding:8px 2px; font-family:Arial,sans-serif; color:#0f172a; }
        .hr-title{ font-size:22px; font-weight:900; letter-spacing:.01em; margin-bottom:4px; }
        .hr-sub{ font-size:12px; color:#475569; margin-bottom:10px; }
        .hr-sections{ display:grid; gap:7px; margin-bottom:12px; }
        .hr-row{ display:grid; grid-template-columns:220px 1fr; gap:10px; border:1px solid rgba(15,23,42,0.15); border-radius:8px; padding:8px 10px; }
        .hr-label{ font-weight:800; }
        .hr-value{ font-weight:600; }
        .hr-empty{ border:1px solid rgba(15,23,42,0.15); border-radius:8px; padding:10px; font-size:12px; color:#475569; }
        .hr-block-title{ font-weight:900; margin-bottom:6px; font-size:13px; }
        .hr-drip-wrap,.hr-endorse-wrap{ border:1px solid rgba(15,23,42,0.15); border-radius:8px; padding:10px; margin-bottom:10px; }
        .hr-drip-table{ width:100%; border-collapse:collapse; table-layout:fixed; }
        .hr-drip-table th,.hr-drip-table td{ border:1px solid rgba(15,23,42,0.18); padding:6px 8px; font-size:12px; vertical-align:top; text-align:left; }
        .hr-drip-table th:first-child,.hr-drip-table td:first-child{ width:85px; text-align:center; }
        .hr-endorse-text{ min-height:74px; white-space:pre-wrap; font-size:12px; line-height:1.35; }
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

  function buildPrintHTMLNew(data) {
    const now = new Date();
    const dateMonDay = formatMonDay(now);
    const shift = getShiftTypeLabel(data.rnCards, data.pcaCards);

    const pcaTight = computePcaTightness(data.pcaCards);
    const pcaCardsMode = (data.pcaCards || []).length >= 5 ? "5plus" : "lt5";

    const topBar = `
      <div class="topbar-grid">
        <div class="topbar-card"><div class="topbar-label">CHG</div><div class="topbar-value">${escapeHtml(data.charge || "-")}</div></div>
        <div class="topbar-card"><div class="topbar-label">CM</div><div class="topbar-value">${escapeHtml(data.mentor || "-")}</div></div>
        <div class="topbar-card"><div class="topbar-label">CTA</div><div class="topbar-value">${escapeHtml(data.cta || "-")}</div></div>
        <div class="topbar-card"><div class="topbar-label">DATE</div><div class="topbar-value">${escapeHtml(dateMonDay)}</div></div>
        <div class="topbar-card"><div class="topbar-label">SHIFT</div><div class="topbar-value">${escapeHtml(shift)}</div></div>
      </div>
    `;

    const rnCards = renderCardsNew(data.rnCards, { section: "Incoming RN Assignments", kind: "RN", headerHtml: topBar });
    const pcaCards = renderCardsNew(data.pcaCards, { section: "Incoming PCA Assignments", kind: "PCA", headerHtml: topBar });

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Oncoming Assignments - Print</title>
<style>
  :root{ --ink:#0f172a; --panel:#fff; --panel-border:#e2e8f0; --panel-shadow:0 1px 0 rgba(15,23,42,.05); --table-head:#eef5ff; --row-divider:#e5e7eb; }
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; color:var(--ink); font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; background:#fff; }
  @page { margin:8mm; }
  .topbar-grid{ display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; margin:0 0 8px; }
  .topbar-card{ background:var(--panel); border:1px solid var(--panel-border); border-radius:10px; padding:7px 10px; box-shadow:var(--panel-shadow); overflow:hidden; text-align:center; }
  .topbar-label{ font-size:10.5px; font-weight:950; letter-spacing:.08em; text-transform:uppercase; margin-bottom:2px; }
  .topbar-value{ font-size:12.5px; font-weight:900; line-height:1.1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .section-title{ margin:8px 0 6px; font-size:12px; font-weight:1000; letter-spacing:.08em; text-transform:uppercase; }
  .print-section.pca-section{ break-before:page; page-break-before:always; }
  .grid-rn{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
  .grid-pca{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
  .card{ background:var(--panel); border:1px solid var(--panel-border); border-radius:10px; box-shadow:var(--panel-shadow); overflow:hidden; break-inside:avoid; page-break-inside:avoid; }
  .card-head{ padding:6px 10px 5px; font-weight:900; font-size:12px; }
  table{ width:100%; border-collapse:collapse; table-layout:fixed; }
  thead th{ background:var(--table-head); font-size:11px; font-weight:1000; padding:6px 8px; border-bottom:1px solid var(--row-divider); text-align:center; }
  tbody td{ padding:6px 8px; border-bottom:1px solid var(--row-divider); font-size:11px; font-weight:800; }
  tbody tr:last-child td{ border-bottom:none; }
  .col-room{ width:62px; text-align:center; }
  .col-level{ width:58px; text-align:center; }
  .col-notes{ width:60%; text-align:center; }
  .pca thead th,.pca tbody td{ padding-top:6px; padding-bottom:6px; font-size:11px; line-height:1.15; }
  body[data-pca-tight="1"] .pca thead th, body[data-pca-tight="1"] .pca tbody td{ padding-top:4px; padding-bottom:4px; font-size:10.3px; line-height:1.12; }
  body[data-pca-tight="2"] .pca thead th, body[data-pca-tight="2"] .pca tbody td{ padding-top:3px; padding-bottom:3px; font-size:10px; line-height:1.08; }
  body[data-pca-tight="3"] .pca thead th, body[data-pca-tight="3"] .pca tbody td{ padding-top:2px; padding-bottom:2px; font-size:9.7px; line-height:1.05; }
  @media screen and (max-width:980px){ .grid-rn{ grid-template-columns:repeat(2,minmax(0,1fr)); } .topbar-grid{ grid-template-columns:1fr; } .grid-pca{ grid-template-columns:1fr; } }
</style>
</head>
<body data-pca-tight="${pcaTight}" data-pca-cards="${pcaCardsMode}">
  <div class="print-wrap">${rnCards}${pcaCards}</div>
</body>
</html>`;
  }

  function renderTraditionalPcaSummary(pcaCards) {
    const rows = (pcaCards || []).map((c) => {
      const rooms = (c.rows || [])
        .map((r) => stripPins(r.room || ""))
        .filter(Boolean)
        .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));
      return `<tr><td class="name">${escapeHtml(c.title || "Incoming PCA")}</td><td class="count">${rooms.length}</td><td class="rooms">${escapeHtml(rooms.join(", "))}</td></tr>`;
    }).join("");

    return `
      <table class="trad-pca-table">
        <thead><tr><th>PCA</th><th>PTS</th><th>PATIENT LIST</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3">No PCA assignments found.</td></tr>`}</tbody>
      </table>
    `;
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

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Oncoming Assignments - Print (Traditional)</title>
<style>
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; background:#fff; color:#111827; font-family:"Times New Roman", serif; }
  @page { margin:8mm; }
  .wrap{ padding:4px; }
  .top{ display:grid; grid-template-columns:1.35fr .85fr .8fr; gap:8px; margin-bottom:8px; align-items:start; }
  .box{ border:1px solid #111; padding:5px; min-height:88px; }
  .title{ font-weight:700; font-size:13px; text-align:center; margin-bottom:4px; }
  .center-line{ text-align:center; font-weight:700; margin:6px 0; font-size:12px; line-height:1.2; }
  .right-top{ text-align:center; font-size:22px; font-weight:700; line-height:1.08; margin-bottom:6px; }
  .open-rooms{ font-size:11px; line-height:1.22; word-break:break-word; }
  table{ width:100%; border-collapse:collapse; table-layout:fixed; }
  th,td{ border:1px solid #111; padding:3px 4px; font-size:12px; vertical-align:top; }
  th{ background:#f3f4f6; text-align:center; font-weight:700; }
  .trad-pca-table{ table-layout:auto; }
  .trad-pca-table th, .trad-pca-table td{ padding:2px 4px; font-size:11px; line-height:1.15; }
  .trad-pca-table td.name{ width:32%; font-weight:700; white-space:nowrap; }
  .trad-pca-table th:nth-child(2), .trad-pca-table td.count{ width:42px; text-align:center; white-space:nowrap; }
  .trad-pca-table td.rooms{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .trad-rn-grid{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
  .trad-rn-head{ border:1px solid #111; border-bottom:none; text-align:center; font-weight:700; padding:4px; font-size:13px; }
  .trad-rn-card table{ table-layout:fixed; }
  .trad-rn-card th, .trad-rn-card td{ padding:2px 3px; line-height:1.1; }
  .trad-rn-card th:nth-child(1), .trad-rn-card td:nth-child(1){ width:24%; text-align:center; }
  .trad-rn-card th:nth-child(2), .trad-rn-card td:nth-child(2){ width:20%; text-align:center; }
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
        <div class="title">PCA Assignments</div>
        ${renderTraditionalPcaSummary(data.pcaCards)}
      </div>
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
  </div>
</body>
</html>`;
  }

  function showPrintModeChooser() {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.style.cssText = [
        "position:fixed", "inset:0", "background:rgba(15,23,42,0.45)",
        "display:flex", "align-items:center", "justify-content:center", "z-index:9999"
      ].join(";");

      const card = document.createElement("div");
      card.style.cssText = [
        "width:min(420px,92vw)", "background:#fff", "border:1px solid rgba(15,23,42,0.2)",
        "border-radius:12px", "padding:14px", "box-shadow:0 18px 40px rgba(2,6,23,0.25)"
      ].join(";");

      card.innerHTML = `
        <div style="font-weight:800; font-size:14px; margin-bottom:10px;">Oncoming Print Format</div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button id="printOncomingModeNew" type="button" style="padding:8px 12px; font-weight:700;">New / Expanded</button>
          <button id="printOncomingModeTraditional" type="button" style="padding:8px 12px; font-weight:700;">Traditional</button>
          <button id="printOncomingModeCancel" type="button" style="padding:8px 12px;">Cancel</button>
        </div>
      `;

      backdrop.appendChild(card);
      document.body.appendChild(backdrop);

      const close = (mode) => {
        try { backdrop.remove(); } catch (_) {}
        resolve(mode || null);
      };

      card.querySelector("#printOncomingModeNew")?.addEventListener("click", () => close("new"));
      card.querySelector("#printOncomingModeTraditional")?.addEventListener("click", () => close("traditional"));
      card.querySelector("#printOncomingModeCancel")?.addEventListener("click", () => close(null));
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(null); });
    });
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
          <div style="display:flex; gap:8px;">
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

  function openInAppPrintPreview(html, modeLabel) {
    const overlay = getOrCreatePreviewOverlay();
    const frame = overlay.querySelector("#printPreviewOncomingFrame");
    const title = overlay.querySelector("#printPreviewOncomingTitle");
    const btnPrint = overlay.querySelector("#printPreviewOncomingDoPrint");
    const btnClose = overlay.querySelector("#printPreviewOncomingClose");

    if (!frame || !btnPrint || !btnClose) return;

    if (title) title.textContent = `Oncoming Print Preview (${modeLabel})`;
    frame.srcdoc = html;
    overlay.style.display = "flex";

    const close = () => {
      overlay.style.display = "none";
      frame.srcdoc = "";
    };

    btnClose.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
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

  async function openPrintPreview(mode) {
    try {
      let selectedMode = String(mode || "").toLowerCase();
      if (selectedMode !== "new" && selectedMode !== "traditional") {
        selectedMode = (await showPrintModeChooser()) || "";
        if (!selectedMode) return;
      }

      const data = {
        charge: getValueById("incomingChargeName"),
        mentor: getValueById("incomingMentorName"),
        cta: getValueById("incomingCtaName"),
        rnCards: extractCardsFrom("assignmentOutput", "RN"),
        pcaCards: extractCardsFrom("pcaAssignmentOutput", "PCA"),
      };

      const html = selectedMode === "traditional"
        ? buildPrintHTMLTraditional(data)
        : buildPrintHTMLNew(data);

      const modeLabel = selectedMode === "traditional" ? "Traditional" : "New / Expanded";
      openInAppPrintPreview(html, modeLabel);
    } catch (e) {
      console.error("[printOncoming] open() error:", e);
      alert("Print failed. See console for details.");
    }
  }

  async function openPacketPreview(mode) {
    try {
      let selectedMode = String(mode || "").toLowerCase();
      if (selectedMode !== "new" && selectedMode !== "traditional") {
        selectedMode = (await showPrintModeChooser()) || "";
        if (!selectedMode) return;
      }

      const handoffInput = await showHandoffInputModal(getDripRooms());
      if (!handoffInput) return;

      const data = {
        charge: getValueById("incomingChargeName"),
        mentor: getValueById("incomingMentorName"),
        cta: getValueById("incomingCtaName"),
        rnCards: extractCardsFrom("assignmentOutput", "RN"),
        pcaCards: extractCardsFrom("pcaAssignmentOutput", "PCA"),
      };

      const assignmentHtml = selectedMode === "traditional"
        ? buildPrintHTMLTraditional(data)
        : buildPrintHTMLNew(data);
      const packetHtml = appendHighRiskSectionToDocument(
        assignmentHtml,
        buildHighRiskHandoffSection(handoffInput)
      );

      const modeLabel = `Hand-Off Packet • ${selectedMode === "traditional" ? "Traditional" : "New / Expanded"}`;
      openInAppPrintPreview(packetHtml, modeLabel);
    } catch (e) {
      console.error("[printOncoming] openPacketPreview() error:", e);
      alert("Packet preview failed. See console for details.");
    }
  }

  async function openHighRiskOnlyPreview() {
    try {
      const handoffInput = await showHandoffInputModal(getDripRooms());
      if (!handoffInput) return;
      const html = buildHighRiskOnlyDocument(handoffInput);
      openInAppPrintPreview(html, "High-Risk Hand-Off");
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
  };
  window.app.printOncoming = window.printOncoming;

  console.log("[printOncoming] loaded: window.printOncoming.open is ready");
})();
