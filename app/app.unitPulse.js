// app/app.unitPulse.js
// ---------------------------------------------------------
// UNIT PULSE — Chart-first MVP (race-condition safe)
//
// GUARANTEES:
// - Only latest request can mutate UI
// - No blank overwrites
// - Analytics-first, snapshot fallback
// ---------------------------------------------------------

(function () {
  const $ = (id) => document.getElementById(id);

  // ---- request guard
  let __pulseReqSeq = 0;

  function guard(reqId, fn) {
    if (reqId !== __pulseReqSeq) return;
    fn();
  }

  function sbReady() {
    return !!(window.sb && window.sb.client);
  }

  function activeUnitId() {
    return window.activeUnitId ? String(window.activeUnitId) : "";
  }

  function safeNum(x, fallback = 0) {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  }

  function clampDateStr(s) {
    if (!s || typeof s !== "string") return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }

  function setPulseStatus(msg, isError = false) {
    const node = $("pulseStatusMsg");
    if (!node) return;
    node.textContent = msg || "";
    node.style.color = isError ? "#b91c1c" : "#0f172a";
  }

  function setSummary(html) {
    const node = $("pulseSummary");
    if (node) node.innerHTML = html || "";
  }

  function setTable(html) {
    const node = $("pulseTable");
    if (node) node.innerHTML = html || "";
  }

  // ---------------------------------------------------------
  // Tag helpers
  // ---------------------------------------------------------
  function parseTagString(str) {
    const out = {};
    if (!str) return out;
    str.split(",").forEach(p => {
      const m = p.trim().match(/^(.+?):\s*(\d+)$/);
      if (!m) return;
      out[m[1]] = (out[m[1]] || 0) + Number(m[2]);
    });
    return out;
  }

  function mergeTagCounts(into, src) {
    if (!src) return;
    Object.keys(src).forEach(k => {
      into[k] = (into[k] || 0) + safeNum(src[k], 0);
    });
  }

  function topTags(tags, limit = 10) {
    return Object.entries(tags || {})
      .map(([k, v]) => ({ k, v }))
      .filter(x => x.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, limit);
  }

  // ---------------------------------------------------------
  // Normalize row (analytics or snapshot)
  // ---------------------------------------------------------
  function normalizeRow(r) {
    const blob = r.metrics || r.state || {};
    return {
      date: r.shift_date,
      shift: r.shift_type,
      totalPts: safeNum(blob?.totals?.total_pts ?? r.total_pts, 0),
      admits: safeNum(blob?.totals?.admits ?? r.admits, 0),
      discharges: safeNum(blob?.totals?.discharges ?? r.discharges, 0),
      tagsObj: blob?.tag_counts || null,
      tagsStr: blob?.top_tags || ""
    };
  }

  // ---------------------------------------------------------
  // Render dashboard (single entry point)
  // ---------------------------------------------------------
  function renderDashboard(rowsRaw) {
    const rows = rowsRaw.map(normalizeRow)
      .filter(r => r.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    const n = rows.length;

    const avgPts = n ? rows.reduce((s, r) => s + r.totalPts, 0) / n : 0;
    const avgA = n ? rows.reduce((s, r) => s + r.admits, 0) / n : 0;
    const avgD = n ? rows.reduce((s, r) => s + r.discharges, 0) / n : 0;

    const tagAgg = {};
    rows.forEach(r => {
      if (r.tagsObj) mergeTagCounts(tagAgg, r.tagsObj);
      else mergeTagCounts(tagAgg, parseTagString(r.tagsStr));
    });

    setSummary(`
      <div><strong>Rows:</strong> ${n}</div>
      <div><strong>Avg total patients:</strong> ${avgPts.toFixed(1)}</div>
      <div><strong>Avg admits:</strong> ${avgA.toFixed(1)}</div>
      <div><strong>Avg discharges:</strong> ${avgD.toFixed(1)}</div>
    `);

    setTable(buildTable(rows));
  }

  function buildTable(rows) {
    if (!rows.length) return `<div>No data.</div>`;

    let html = `
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th>Date</th><th>Shift</th><th>Total pts</th>
            <th>Admits</th><th>Discharges</th><th>Top acuity tags</th>
          </tr>
        </thead><tbody>
    `;

    rows.forEach(r => {
      const tagText = r.tagsStr ||
        (r.tagsObj ? topTags(r.tagsObj).map(x => `${x.k}:${x.v}`).join(", ") : "—");

      html += `
        <tr>
          <td>${r.date}</td>
          <td>${r.shift}</td>
          <td>${r.totalPts}</td>
          <td>${r.admits}</td>
          <td>${r.discharges}</td>
          <td>${tagText}</td>
        </tr>
      `;
    });

    html += "</tbody></table>";
    return html;
  }

  // ---------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------
  async function loadAnalytics(unitId, from, to, shift) {
    let q = window.sb.client
      .from("analytics_shift_metrics")
      .select("*")
      .eq("unit_id", unitId);

    if (from) q = q.gte("shift_date", from);
    if (to) q = q.lte("shift_date", to);
    if (shift) q = q.eq("shift_type", shift);

    return q.order("shift_date", { ascending: false });
  }

  async function loadSnapshots(unitId, from, to, shift) {
    let q = window.sb.client
      .from("shift_snapshots")
      .select("*")
      .eq("unit_id", unitId);

    if (from) q = q.gte("shift_date", from);
    if (to) q = q.lte("shift_date", to);
    if (shift) q = q.eq("shift_type", shift);

    return q.order("shift_date", { ascending: false });
  }

  // ---------------------------------------------------------
  // Public loader
  // ---------------------------------------------------------
  async function loadUnitPulse() {
    const reqId = ++__pulseReqSeq;

    const unitId = activeUnitId();
    const from = clampDateStr($("pulseFrom")?.value);
    const to = clampDateStr($("pulseTo")?.value);
    const shiftRaw = $("pulseShiftType")?.value;
    const shift = shiftRaw === "day" || shiftRaw === "night" ? shiftRaw : "";

    guard(reqId, () => setPulseStatus("Loading…"));

    if (!unitId || !sbReady()) {
      guard(reqId, () => {
        setPulseStatus("Not ready.", true);
        renderDashboard([]);
      });
      return;
    }

    try {
      const { data: aRows } = await loadAnalytics(unitId, from, to, shift);
      guard(reqId, () => {
        if (aRows?.length) {
          setPulseStatus(`Loaded ${aRows.length} analytics row(s).`);
          renderDashboard(aRows);
        } else {
          loadSnapshots(unitId, from, to, shift).then(({ data: sRows }) => {
            guard(reqId, () => {
              setPulseStatus(`Loaded ${sRows?.length || 0} snapshot row(s).`);
              renderDashboard(sRows || []);
            });
          });
        }
      });
    } catch (e) {
      guard(reqId, () => {
        setPulseStatus("Load failed.", true);
        renderDashboard([]);
      });
    }
  }

  // ---------------------------------------------------------
  // Wire UI
  // ---------------------------------------------------------
  function wire() {
    $("btnLoadPulse")?.addEventListener("click", loadUnitPulse);
    ["pulseFrom", "pulseTo", "pulseShiftType"].forEach(id => {
      $(id)?.addEventListener("change", loadUnitPulse);
    });
  }

  window.addEventListener("DOMContentLoaded", wire);
})();