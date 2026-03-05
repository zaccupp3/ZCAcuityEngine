/* =========================================================
   app/app.printLive.js
   - In-app preview + print for LIVE assignments
   - Modes: New / Expanded and Traditional
   - Orientation: Portrait or Landscape
========================================================= */

(function () {
  "use strict";

  window.app = window.app || {};

  function getValueById(id) {
    const el = document.getElementById(id);
    if (!el) return "";
    return (el.value || el.textContent || "").trim();
  }

  function firstNonEmpty(values) {
    for (const v of values) {
      const s = String(v || "").trim();
      if (s) return s;
    }
    return "";
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

  function detectShift() {
    const s = String(window.pcaShift || "").toLowerCase();
    if (s.includes("noc") || s.includes("night")) return "NOC";
    if (s.includes("day")) return "DAY";
    return "-";
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

  function getOpenRoomLabels() {
    const pts = Array.isArray(window.patients) ? window.patients : [];
    return pts
      .filter((p) => p && p.isEmpty)
      .map((p) => getRoomLabelForPrint(p))
      .filter(Boolean)
      .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));
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
      (kind === "RN" ? "Current RN" : "Current PCA");

    const table = block.querySelector("table");
    if (!table) return { title, rows: [], kind };

    const rows = Array.from(table.querySelectorAll("tbody tr"))
      .map((tr) => {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (!tds.length) return null;

        const room = stripPins((tds[0]?.textContent || "").trim());
        const level = (tds[1]?.textContent || "").trim();
        const notes = (tds[2]?.textContent || "").trim();

        if (!room && !level && !notes) return null;
        return { room, level, notes };
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
        <div class="card-head">${escapeHtml(card.title || (isPca ? "Current PCA" : "Current RN"))}</div>
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

  function buildPrintHTMLNew(data, orientation) {
    const pageSize = "size: 11in 8.5in;";
    const dateMonDay = formatMonDay(new Date());
    const shift = data.shift || detectShift();
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

    const rnCards = renderCardsNew(data.rnCards, { section: "Current RN Assignments", kind: "RN", headerHtml: topBar });
    const pcaCards = renderCardsNew(data.pcaCards, { section: "Current PCA Assignments", kind: "PCA", headerHtml: topBar });

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LIVE Assignments - Print</title>
<style>
  :root{ --ink:#0f172a; --panel:#fff; --panel-border:#e2e8f0; --panel-shadow:0 1px 0 rgba(15,23,42,.05); --table-head:#eef5ff; --row-divider:#e5e7eb; }
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; color:var(--ink); font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; background:#fff; }
  @page { margin:5mm; ${pageSize} }
  .print-wrap{ width:100%; max-width:10.9in; margin:0 auto; }
  .topbar-grid{ display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; margin:0 0 8px; }
  .topbar-card{ background:var(--panel); border:1px solid var(--panel-border); border-radius:10px; padding:7px 10px; box-shadow:var(--panel-shadow); text-align:center; }
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
  .col-room{ width:52px; text-align:center; }
  .col-level{ width:52px; text-align:center; }
  .col-notes{ width:44%; text-align:center; }
  tbody td.col-notes{ font-size:9.5px; line-height:1.05; }
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
      return `<tr><td class="name">${escapeHtml(c.title || "Current PCA")}</td><td class="count">${rooms.length}</td><td class="rooms">${escapeHtml(rooms.join(", "))}</td></tr>`;
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
          <div class="trad-rn-head">${escapeHtml(c.title || "Current RN")}</div>
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
    const rows = (pcaCards || []).filter((c) => !isHoldOwnerTitle(c?.title) && !isSitterOwnerTitle(c?.title)).map((c) => {
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
    return /\bsitter\b/.test(t);
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

  function renderLegacyWorksheetSpecialRows(pcaCards) {
    const cards = Array.isArray(pcaCards) ? pcaCards : [];
    const sitter = [];
    const vpo = [];
    cards.forEach((c) => {
      const title = String(c.title || "PCA").trim();
      const rows = Array.isArray(c.rows) ? c.rows : [];
      const rooms = rows.map((r) => stripPins(r.room || "")).filter(Boolean);
      const hasSitter = isSitterOwnerTitle(title) || rows.some((r) => /sitter/i.test(String(r.notes || "")));
      const hasVpo = rows.some((r) => /vpo/i.test(String(r.notes || "")));
      if (hasSitter) sitter.push({ title, rooms: Array.from(new Set(rooms)).sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b))) });
      if (hasVpo) vpo.push({
        title,
        rooms: rows
          .filter((r) => /vpo/i.test(String(r.notes || "")))
          .map((r) => stripPins(r.room || ""))
          .filter(Boolean)
      });
    });

    const sitterLines = sitter
      .map((s) => {
        const room = (s.rooms && s.rooms[0]) ? s.rooms[0] : "-";
        return `Sitter designation: ${room} - ${s.title}`;
      })
      .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));

    const vpoLines = vpo
      .flatMap((s) => (s.rooms || []).map((room) => ({ room, title: s.title })))
      .sort((a, b) => roomSortKey(a.room).localeCompare(roomSortKey(b.room)))
      .map((x) => `${x.room} - ${x.title}`);

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


  function buildPrintHTMLTraditional(data, orientation) {
    const pageSize = "size: 11in 8.5in;";
    const shiftDate = `${new Date().getMonth() + 1}/${new Date().getDate()}/${String(new Date().getFullYear()).slice(-2)}`;
    const shift = data.shift || detectShift();
    const openRooms = getOpenRoomLabels();
    const holdRooms = collectHoldRoomsFromCards(data.pcaCards).concat(collectHoldRoomsFromCards(data.rnCards || []));
    const availabilityRooms = Array.from(new Set([...(openRooms || []), ...holdRooms]))
      .sort((a, b) => roomSortKey(a).localeCompare(roomSortKey(b)));
    const pcaRows = renderLegacyWorksheetPcaRows(data.pcaCards, "Current PCA");
    const rnGrid = renderLegacyWorksheetRnGrid(data.rnCards, "Current RN");
    const specials = renderLegacyWorksheetSpecialRows(data.pcaCards);

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LIVE Assignments - Print (Traditional)</title>
<style>
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; background:#fff; color:#111827; font-family:"Times New Roman", serif; }
  @page { margin:5mm; ${pageSize} }
  .wrap{ padding:2px; width:100%; max-width:10.9in; margin:0 auto; min-height:7.9in; }
  .ws-table{ width:100%; border-collapse:collapse; table-layout:fixed; }
  .ws-table th,.ws-table td{ border:1px solid #111; padding:2px 4px; font-size:11px; line-height:1.12; vertical-align:top; }
  .ws-pca-table{ table-layout:auto; }
  .ws-pca-table td.pca-name{ white-space:nowrap; width:1%; }
  .ws-pca-table td.pca-rooms{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ws-head{ font-weight:700; text-align:center; }
  .ws-top-grid{ display:grid; grid-template-columns:2fr 1fr; gap:0; border:1px solid #111; border-bottom:none; }
  .ws-top-grid > div{ border-right:1px solid #111; }
  .ws-top-grid > div:last-child{ border-right:none; }
  .ws-date{ text-align:center; font-size:44px; font-weight:700; line-height:1.04; margin-top:4px; }
  .ws-msg{ text-align:center; font-size:21px; font-weight:700; margin-top:4px; }
  .ws-mid{ display:grid; grid-template-columns:1fr 1fr 1fr; border:1px solid #111; border-top:none; }
  .ws-mid > div{ border-right:1px solid #111; min-height:120px; }
  .ws-mid > div:last-child{ border-right:none; }
  .ws-box-title{ font-size:12px; font-weight:700; text-align:center; margin:2px 0; }
  .ws-line{ border-top:1px solid #111; min-height:20px; padding:2px 4px; font-size:11px; }
  .ws-list{ padding:2px 4px; font-size:10px; line-height:1.2; }
  .ws-leadership-box{
    min-height:120px;
    display:flex;
    flex-direction:column;
    justify-content:space-evenly;
    align-items:center;
    text-align:center;
    padding:4px 6px;
    font-size:19px;
    font-weight:700;
  }
  .ws-rn-grid{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:0; border-left:1px solid #111; border-right:1px solid #111; border-bottom:1px solid #111; }
  .ws-rn-card{ width:100%; border-collapse:collapse; table-layout:fixed; }
  .ws-rn-card th,.ws-rn-card td{ padding:2px 3px; font-size:11px; line-height:1.05; vertical-align:top; border-left:1px solid #111; border-right:1px solid #111; }
  .ws-rn-card thead th{ text-align:center; font-weight:700; border-top:1px solid #111; border-bottom:1px solid #111; }
  .ws-rn-card tbody td{ border-top:none; border-bottom:none; }
  .ws-rn-card tbody tr:last-child td{ border-bottom:1px solid #111; }
  .ws-rn-card td.room,.ws-rn-card td.acty{ text-align:center; width:14%; }
  .ws-rn-card td.notes{ font-size:9px; }
  .ws-rn-card td.rn-name{ width:28%; text-align:center; font-weight:700; vertical-align:middle; }
  .num{ width:60px; text-align:center; font-weight:700; }
  .availability-room{ font-size:11px; line-height:1.2; padding:4px; }
  @media print { .wrap{ padding:0; } }
</style>
</head>
<body>
  <div class="wrap">
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

  function showLivePrintChooser() {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.style.cssText = [
        "position:fixed", "inset:0", "background:rgba(15,23,42,0.45)",
        "display:flex", "align-items:center", "justify-content:center", "z-index:10002"
      ].join(";");

      const card = document.createElement("div");
      card.style.cssText = [
        "width:min(520px,94vw)", "background:#fff", "border:1px solid rgba(15,23,42,0.2)",
        "border-radius:12px", "padding:14px", "box-shadow:0 18px 40px rgba(2,6,23,0.25)"
      ].join(";");

      card.innerHTML = `
        <div style="font-weight:800; font-size:14px; margin-bottom:8px;">Live Assignment Print Options</div>
        <div style="display:grid; gap:8px; margin-bottom:10px;">
          <label style="font-size:12px; font-weight:700;">View</label>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button id="livePrintModeNew" type="button" style="padding:8px 12px; font-weight:700;">New / Expanded</button>
            <button id="livePrintModeTraditional" type="button" style="padding:8px 12px; font-weight:700;">Traditional</button>
          </div>
          <label style="font-size:12px; font-weight:700; margin-top:4px;">Orientation</label>
          <div style="display:flex; gap:14px; align-items:center;">
            <label><input type="radio" name="livePrintOrientation" value="portrait" checked /> Portrait</label>
            <label><input type="radio" name="livePrintOrientation" value="landscape" /> Landscape</label>
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px;">
          <button id="livePrintCancel" type="button" style="padding:8px 12px;">Cancel</button>
        </div>
      `;

      backdrop.appendChild(card);
      document.body.appendChild(backdrop);

      const close = (result) => {
        try { backdrop.remove(); } catch (_) {}
        resolve(result || null);
      };

      const getOrientation = () => card.querySelector('input[name="livePrintOrientation"]:checked')?.value || "portrait";
      card.querySelector("#livePrintModeNew")?.addEventListener("click", () => close({ mode: "new", orientation: getOrientation() }));
      card.querySelector("#livePrintModeTraditional")?.addEventListener("click", () => close({ mode: "traditional", orientation: getOrientation() }));
      card.querySelector("#livePrintCancel")?.addEventListener("click", () => close(null));
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(null); });
    });
  }

  function getOrCreatePreviewOverlay() {
    let overlay = document.getElementById("printPreviewLiveOverlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "printPreviewLiveOverlay";
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:10003", "background:rgba(15,23,42,0.55)",
      "display:none", "align-items:center", "justify-content:center", "padding:16px"
    ].join(";");

    overlay.innerHTML = `
      <div style="width:min(1200px,98vw); height:min(92vh,980px); background:#fff; border-radius:12px; overflow:hidden; border:1px solid rgba(15,23,42,0.18); box-shadow:0 18px 45px rgba(2,6,23,0.35); display:flex; flex-direction:column;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; border-bottom:1px solid rgba(15,23,42,0.12); background:#f8fafc;">
          <div id="printPreviewLiveTitle" style="font-weight:800; font-size:13px; color:#0f172a;">LIVE Print Preview</div>
          <div style="display:flex; gap:8px;">
            <button id="printPreviewLiveDoPrint" type="button" style="padding:6px 12px; font-weight:700;">Print / Save PDF</button>
            <button id="printPreviewLiveClose" type="button" style="padding:6px 10px;">Close</button>
          </div>
        </div>
        <iframe id="printPreviewLiveFrame" style="width:100%; height:100%; border:0;"></iframe>
      </div>
    `;

    document.body.appendChild(overlay);
    return overlay;
  }

  function openInAppPrintPreview(html, label) {
    const overlay = getOrCreatePreviewOverlay();
    const frame = overlay.querySelector("#printPreviewLiveFrame");
    const title = overlay.querySelector("#printPreviewLiveTitle");
    const btnPrint = overlay.querySelector("#printPreviewLiveDoPrint");
    const btnClose = overlay.querySelector("#printPreviewLiveClose");
    if (!frame || !btnPrint || !btnClose) return;

    if (title) title.textContent = `LIVE Print Preview (${label})`;
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
        console.error("[printLive] preview print() failed:", e);
        alert("Print failed. See console for details.");
      }
    };
  }

  async function openPrintPreview(options = {}) {
    try {
      let mode = String(options.mode || "").toLowerCase();
      let orientation = String(options.orientation || "portrait").toLowerCase();

      if (mode !== "new" && mode !== "traditional") {
        const pick = await showLivePrintChooser();
        if (!pick) return;
        mode = pick.mode;
        orientation = pick.orientation;
      }

      const charge = firstNonEmpty([
        getValueById("currentChargeName"),
        getValueById("chargeName"),
        getValueById("liveChargeName"),
        getValueById("incomingChargeName"),
      ]);

      const mentor = firstNonEmpty([
        getValueById("currentMentorName"),
        getValueById("mentorName"),
        getValueById("liveMentorName"),
        getValueById("incomingMentorName"),
      ]);

      const cta = firstNonEmpty([
        getValueById("currentCtaName"),
        getValueById("ctaName"),
        getValueById("liveCtaName"),
        getValueById("incomingCtaName"),
      ]);

      const data = {
        charge,
        mentor,
        cta,
        shift: detectShift(),
        rnCards: extractCardsFrom("liveNurseAssignments", "RN"),
        pcaCards: extractCardsFrom("livePcaAssignments", "PCA"),
      };

      const html = mode === "traditional"
        ? buildPrintHTMLTraditional(data, orientation)
        : buildPrintHTMLNew(data, orientation);

      const label = `${mode === "traditional" ? "Traditional" : "New / Expanded"} - Landscape (11x8.5)`;
      openInAppPrintPreview(html, label);
    } catch (e) {
      console.error("[printLive] open() error:", e);
      alert("Print failed. See console for details.");
    }
  }

  window.printLive = {
    open: openPrintPreview,
    openNew: (orientation = "portrait") => openPrintPreview({ mode: "new", orientation }),
    openTraditional: (orientation = "portrait") => openPrintPreview({ mode: "traditional", orientation }),
  };
  window.app.printLive = window.printLive;

  console.log("[printLive] loaded: window.printLive.open is ready");
})();
