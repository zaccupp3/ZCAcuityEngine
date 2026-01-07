/* =========================================================
   app/app.printOncoming.js
   - In-page print (hidden iframe) to avoid popup blockers
   - Prints Oncoming Leadership + RN cards + PCA cards
   - PRINT-ONLY UI rules: colors preserved, pins removed, PCA 2-col grid
   - PCA rows auto-tighten to keep all PCAs on one printed page
========================================================= */

(function () {
  "use strict";

  // Ensure namespaces
  window.app = window.app || {};

  function getValueById(id) {
    const el = document.getElementById(id);
    if (!el) return "";
    return (el.value || el.textContent || "").trim();
  }

  // Remove emoji pins or stray symbols from printed Room cells
  function stripPins(s) {
    return String(s || "")
      .replace(/📌|📍|📎/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // Extract cards from a container that contains multiple "blocks" (cards)
  function extractCardsFrom(containerId, kind) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return [];

    const blocks = Array.from(
      wrap.querySelectorAll(".nurseBlock, .pcaBlock, .assignment-card, .liveCard")
    );

    const cards = (blocks.length ? blocks : Array.from(wrap.children))
      .map((block) => parseCard(block, kind))
      .filter(Boolean);

    return cards;
  }

  function parseCard(block, kind) {
    const titleEl =
      block.querySelector(".liveCardHeader strong") ||
      block.querySelector("strong") ||
      block.querySelector("h3") ||
      block.querySelector("h4");

    const title =
      (titleEl ? titleEl.textContent : "").trim() ||
      (kind === "RN" ? "Incoming RN" : "Incoming PCA");

    const table = block.querySelector("table");
    if (!table) return { title, rows: [], kind };

    const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
    const rows = bodyRows
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

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function computePcaTightness(pcaCards) {
    const cards = pcaCards || [];
    const totalRows = cards.reduce((sum, c) => sum + (c.rows?.length || 0), 0);

    if (totalRows <= 28) return 0;
    if (totalRows <= 36) return 1;
    if (totalRows <= 44) return 2;
    return 3;
  }

  function formatMonDay(d) {
    const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    const mon = months[d.getMonth()];
    const day = d.getDate();
    return `${mon}-${day}`;
  }

  function detectShiftFromCards(rnCards, pcaCards) {
    const all = []
      .concat(rnCards || [])
      .concat(pcaCards || [])
      .flatMap((c) => c?.rows || [])
      .map((r) => String(r?.from || "").toUpperCase());

    if (all.some((s) => s.includes("NOC"))) return "NOC";
    if (all.some((s) => s.includes("DAY"))) return "DAY";
    return "—";
  }

  function buildPrintHTML(data) {
    const now = new Date();
    const dateMonDay = formatMonDay(now);
    const shift = detectShiftFromCards(data.rnCards, data.pcaCards);

    const pcaTight = computePcaTightness(data.pcaCards);
    const pcaCardCount = (data.pcaCards || []).length;
    const pcaCardsMode = pcaCardCount >= 5 ? "5plus" : "lt5";

    const topBar = `
      <div class="topbar-grid">
        <div class="topbar-card">
          <div class="topbar-label">CHG</div>
          <div class="topbar-value">${escapeHtml(data.charge || "—")}</div>
        </div>
        <div class="topbar-card">
          <div class="topbar-label">CM</div>
          <div class="topbar-value">${escapeHtml(data.mentor || "—")}</div>
        </div>
        <div class="topbar-card">
          <div class="topbar-label">CTA</div>
          <div class="topbar-value">${escapeHtml(data.cta || "—")}</div>
        </div>
        <div class="topbar-card">
          <div class="topbar-label">DATE</div>
          <div class="topbar-value">${escapeHtml(dateMonDay)}</div>
        </div>
        <div class="topbar-card">
          <div class="topbar-label">SHIFT</div>
          <div class="topbar-value">${escapeHtml(shift)}</div>
        </div>
      </div>
    `;

    const rnCards = renderCards(data.rnCards, {
      section: "Incoming RN Assignments",
      kind: "RN",
      headerHtml: topBar,
    });

    const pcaCards = renderCards(data.pcaCards, {
      section: "Incoming PCA Assignments",
      kind: "PCA",
      headerHtml: topBar,
    });

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Oncoming Assignments — Print</title>
<style>
  :root{
    --ink: #0f172a;
    --muted: #334155;

    --panel: #ffffff;
    --panel-border: #e2e8f0;
    --panel-shadow: 0 1px 0 rgba(15, 23, 42, 0.05);

    --header-strip: transparent;
    --table-head: #eef5ff;
    --row-divider: #e5e7eb;
  }

  *{ box-sizing: border-box; }
  html, body{
    margin: 0;
    padding: 0;
    color: var(--ink);
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    background: #fff;
  }

  @page { margin: 8mm; }

  .topbar-grid{
    display:grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
    margin: 0 0 8px;
  }
  .topbar-card{
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 7px 10px;
    box-shadow: var(--panel-shadow);
    overflow:hidden;
    text-align: center;
  }
  .topbar-label{
    font-size: 10.5px;
    font-weight: 950;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #0f172a;
    margin-bottom: 2px;
    line-height: 1.05;
    text-align: center;
  }
  .topbar-value{
    font-size: 12.5px;
    font-weight: 900;
    color: var(--ink);
    line-height: 1.1;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .section-title{
    margin: 8px 0 6px;
    font-size: 12px;
    font-weight: 1000;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #0f172a;
  }

  .print-section.pca-section{
    break-before: page;
    page-break-before: always;
  }

  .grid-rn{
    display:grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    align-items: stretch;
  }

  .grid-pca{
    display:grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    align-items: stretch;
  }

  .card{
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    box-shadow: var(--panel-shadow);
    overflow:hidden;
    break-inside: avoid;
    page-break-inside: avoid;
    display:flex;
    flex-direction: column;
    min-height: 0;
  }

  .card-head{
    background: var(--header-strip);
    padding: 6px 10px 5px;
    font-weight: 900;
    font-size: 12px;
    letter-spacing: 0.01em;
    flex: 0 0 auto;
  }

  table{
    width:100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  thead th{
    background: var(--table-head);
    font-size: 11px;
    font-weight: 1000;
    padding: 6px 8px;
    border-bottom: 1px solid var(--row-divider);
    white-space: nowrap;
    text-align: center;
  }
  tbody td{
    padding: 6px 8px;
    border-bottom: 1px solid var(--row-divider);
    font-size: 11px;
    font-weight: 800;
    vertical-align: middle;
  }
  tbody tr:last-child td{ border-bottom: none; }

  .col-room{ width: 62px; }
  .col-level{ width: 58px; }
  .col-notes{ width: 52%; }
  .col-from{ width: 28%; }

  td.col-room{ text-align: center; }
  td.col-level{ text-align: center; }

  /* ✅ CHANGE: center notes under "Acuity Notes" */
  td.col-notes{
    text-align: center;
    padding-left: 8px;
    padding-right: 8px;
  }

  td.col-from{ text-align: center; }

  td.notes{
    font-weight: 800;
    color: #0f172a;
  }

  /* ========= PCA AUTO-COMPACT ========= */
  .pca table thead th,
  .pca table tbody td{
    padding-top: 6px;
    padding-bottom: 6px;
    font-size: 11px;
    line-height: 1.15;
  }
  .pca .card-head{
    padding: 6px 10px 5px;
    font-size: 12px;
  }

  body[data-pca-cards="5plus"][data-pca-tight="0"] .pca table thead th,
  body[data-pca-cards="5plus"][data-pca-tight="0"] .pca table tbody td{
    padding-top: 7px;
    padding-bottom: 7px;
  }

  body[data-pca-tight="1"] .pca table thead th,
  body[data-pca-tight="1"] .pca table tbody td{
    padding-top: 4px;
    padding-bottom: 4px;
    font-size: 10.3px;
    line-height: 1.12;
  }
  body[data-pca-tight="1"] .pca .card-head{
    padding: 5px 10px 4px;
    font-size: 11.7px;
  }

  body[data-pca-tight="2"] .pca table thead th,
  body[data-pca-tight="2"] .pca table tbody td{
    padding-top: 3px;
    padding-bottom: 3px;
    font-size: 10px;
    line-height: 1.08;
  }
  body[data-pca-tight="2"] .pca .card-head{
    padding: 5px 10px 4px;
    font-size: 11.4px;
  }

  body[data-pca-tight="3"] .pca table thead th,
  body[data-pca-tight="3"] .pca table tbody td{
    padding-top: 2px;
    padding-bottom: 2px;
    font-size: 9.7px;
    line-height: 1.05;
  }
  body[data-pca-tight="3"] .pca .card-head{
    padding: 4px 10px 3px;
    font-size: 11.1px;
  }

  body[data-pca-tight="2"] .pca .col-from,
  body[data-pca-tight="3"] .pca .col-from{ width: 24%; }

  @media screen and (max-width: 980px){
    .grid-rn{ grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .topbar-grid{ grid-template-columns: 1fr; }
    .grid-pca{ grid-template-columns: 1fr; }
  }
</style>
</head>
<body data-pca-tight="${pcaTight}" data-pca-cards="${pcaCardsMode}">
  <div class="print-wrap">
    ${rnCards}
    ${pcaCards}
  </div>
</body>
</html>`;
  }

  function renderCards(cards, opts) {
    const section = opts.section || "";
    const kind = opts.kind || "RN";
    const gridClass = kind === "PCA" ? "grid-pca" : "grid-rn";
    const headerHtml = opts.headerHtml || "";

    const htmlCards = (cards || [])
      .map((c) => renderOneCard(c, { kind }))
      .join("");

    const sectionClass =
      kind === "PCA" ? "print-section pca-section" : "print-section rn-section";

    return `
      <div class="${sectionClass}">
        ${headerHtml || ""}
        <div class="section-title">${escapeHtml(section)}</div>
        <div class="${gridClass}">
          ${htmlCards || `<div style="font-size:12px; color:#475569; font-weight:700;">No ${escapeHtml(kind)} assignments found.</div>`}
        </div>
      </div>
    `;
  }

  function renderOneCard(card, opts) {
    const kind = opts.kind || card.kind || "RN";
    const isPca = kind === "PCA";

    const rowsHtml = (card.rows || [])
      .map((r) => {
        return `<tr>
          <td class="col-room">${escapeHtml(stripPins(r.room))}</td>
          <td class="col-level">${escapeHtml(r.level || "")}</td>
          <td class="col-notes notes">${escapeHtml(r.notes || "")}</td>
          <td class="col-from">${escapeHtml(r.from || "")}</td>
        </tr>`;
      })
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
              <th class="col-from">${escapeHtml(isPca ? "Prev. PCA" : "Prev. RN")}</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || ""}
          </tbody>
        </table>
      </div>
    `;
  }

  // In-page print using hidden iframe (avoids popup blockers)
  function getOrCreatePrintFrame() {
    let frame = document.getElementById("printFrameOncoming");
    if (frame) return frame;

    frame = document.createElement("iframe");
    frame.id = "printFrameOncoming";
    frame.style.position = "fixed";
    frame.style.right = "0";
    frame.style.bottom = "0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    frame.style.opacity = "0";
    frame.style.pointerEvents = "none";
    document.body.appendChild(frame);
    return frame;
  }

  function openPrintPreview() {
    try {
      const data = {
        charge: getValueById("incomingChargeName"),
        mentor: getValueById("incomingMentorName"),
        cta: getValueById("incomingCtaName"),
        rnCards: extractCardsFrom("assignmentOutput", "RN"),
        pcaCards: extractCardsFrom("pcaAssignmentOutput", "PCA"),
      };

      const html = buildPrintHTML(data);

      const frame = getOrCreatePrintFrame();
      const w = frame.contentWindow;
      const d = frame.contentDocument || w.document;

      d.open();
      d.write(html);
      d.close();

      setTimeout(() => {
        try {
          w.focus();
          w.print();
        } catch (e) {
          console.error("[printOncoming] iframe print() failed:", e);
          alert("Print failed. See console for details.");
        }
      }, 250);
    } catch (e) {
      console.error("[printOncoming] open() error:", e);
      alert("Print failed. See console for details.");
    }
  }

  // Export
  window.printOncoming = { open: openPrintPreview };
  window.app.printOncoming = window.printOncoming;

  console.log("[printOncoming] loaded: window.printOncoming.open is ready");
})();