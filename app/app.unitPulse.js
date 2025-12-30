// app/app.unitPulse.js
// ---------------------------------------------------------
// UNIT PULSE — Chart-first MVP (hardened)
//
// HARD GUARANTEES:
// ✅ Only one UnitPulse runtime (singleton guard)
// ✅ Latest request wins (requestId guard)
// ✅ Chart shell never stays missing (auto-repair observer)
// ✅ Analytics-first, snapshot fallback
//
// If something else overwrites #pulseSummary, we detect it,
// rebuild the shell, and re-render the last good data.
// ---------------------------------------------------------

(function () {
  // ---- singleton guard (prevents double-init / double listeners)
  if (window.__unitPulseSingletonLoaded) return;
  window.__unitPulseSingletonLoaded = true;

  const $ = (id) => document.getElementById(id);

  // latest-request-wins guard
  let __pulseReqSeq = 0;

  // cache last successful rows so we can re-render after DOM wipe
  let __lastGoodRowsRaw = [];
  let __lastGoodReqId = 0;

  function sbReady() {
    return !!(window.sb && window.sb.client && typeof window.sb.client.from === "function");
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
    node.style.opacity = "0.85";
  }

  // ---------------------------------------------------------
  // Chart shell (inject once, then update children)
  // ---------------------------------------------------------
  function chartCanvasesExist() {
    return !!($("pulseChartPatients") && $("pulseChartFlow") && $("pulseChartTags"));
  }

  function ensureChartShell() {
    const container = $("pulseSummary");
    if (!container) return;

    if (chartCanvasesExist()) return;

    container.innerHTML = `
      <div id="pulseChartsWrap" style="display:flex;flex-direction:column;gap:12px;">
        <div class="staff-card">
          <div class="staff-card-header">Pulse Summary</div>
          <div id="pulseSummaryMetrics" style="font-size:13px;line-height:1.45;opacity:0.95;">
            No data loaded yet.
          </div>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:12px;">
          <div class="staff-card" style="flex:1;min-width:320px;">
            <div class="staff-card-header">Total Patients (Trend)</div>
            <canvas id="pulseChartPatients" height="140" style="width:100%;display:block;"></canvas>
            <div id="pulseChartPatientsMeta" style="font-size:12px;opacity:0.75;margin-top:6px;"></div>
          </div>

          <div class="staff-card" style="flex:1;min-width:320px;">
            <div class="staff-card-header">Admits & Discharges (Trend)</div>
            <canvas id="pulseChartFlow" height="140" style="width:100%;display:block;"></canvas>
            <div id="pulseChartFlowMeta" style="font-size:12px;opacity:0.75;margin-top:6px;"></div>
          </div>
        </div>

        <div class="staff-card">
          <div class="staff-card-header">Top Acuity Tags (Selected Range)</div>
          <canvas id="pulseChartTags" height="170" style="width:100%;display:block;"></canvas>
          <div id="pulseChartTagsMeta" style="font-size:12px;opacity:0.75;margin-top:6px;"></div>
        </div>

        <details class="staff-card" style="margin-top:4px;">
          <summary style="cursor:pointer;font-weight:700;padding:10px 12px;">Show table details</summary>
          <div style="padding:10px 12px;" id="pulseTableDetailsSlot"></div>
        </details>
      </div>
    `;
  }

  function setSummaryMetrics(html) {
    const node = $("pulseSummaryMetrics");
    if (!node) return;
    node.innerHTML = html || "No data loaded yet.";
  }

  function setTableHtml(html) {
    const slot = $("pulseTableDetailsSlot");
    if (slot) slot.innerHTML = html || "";

    // Keep legacy table area in sync if present
    const node = $("pulseTable");
    if (node) node.innerHTML = html || "";
  }

  // ---------------------------------------------------------
  // Tag helpers
  // ---------------------------------------------------------
  function parseTagString(str) {
    const out = {};
    if (!str || typeof str !== "string") return out;

    const parts = str.split(",").map(s => s.trim()).filter(Boolean);
    parts.forEach(p => {
      const m = p.match(/^([a-zA-Z0-9_\- ]+)\s*:\s*([0-9]+(\.[0-9]+)?)$/);
      if (!m) return;
      const k = String(m[1]).trim();
      const v = safeNum(m[2], 0);
      if (!k || !v) return;
      out[k] = (out[k] || 0) + v;
    });
    return out;
  }

  function mergeTagCounts(into, tagsObj) {
    if (!tagsObj || typeof tagsObj !== "object") return;
    Object.keys(tagsObj).forEach(k => {
      into[k] = (into[k] || 0) + safeNum(tagsObj[k], 0);
    });
  }

  function topTags(tagCounts, limit = 10) {
    return Object.entries(tagCounts || {})
      .map(([k, v]) => ({ k, v: safeNum(v, 0) }))
      .filter(x => x.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, limit);
  }

  // ---------------------------------------------------------
  // Row normalization (analytics + snapshot tolerant)
  // ---------------------------------------------------------
  function getJsonBlob(r) {
    return r?.metrics || r?.snapshot || r?.payload || r?.state || null;
  }

  function normalizeRow(r) {
    const blob = getJsonBlob(r);

    const date = r.shift_date || r.date || r.shiftDate || "";
    const shift = r.shift_type || r.shift || r.shiftType || "";

    const colTotalPts = r.total_pts ?? r.total_patients ?? r.totalPatients ?? r.patients_total;
    const blobTotalPts =
      blob?.totals?.total_pts ??
      blob?.totals?.total_patients ??
      blob?.total_pts ??
      blob?.total_patients ??
      blob?.patients_total;

    const colAdmits = r.admits ?? r.total_admits ?? r.admit_count;
    const blobAdmits = blob?.totals?.admits ?? blob?.admits ?? blob?.admit_count;

    const colDis = r.discharges ?? r.total_discharges ?? r.discharge_count;
    const blobDis = blob?.totals?.discharges ?? blob?.discharges ?? blob?.discharge_count;

    const totalPts = safeNum(colTotalPts ?? blobTotalPts, 0);
    const admits = safeNum(colAdmits ?? blobAdmits, 0);
    const discharges = safeNum(colDis ?? blobDis, 0);

    const tagsStr =
      r.top_tags ??
      r.tags_summary ??
      blob?.top_tags ??
      blob?.tags_summary ??
      "";

    const tagsObj =
      (r.tag_counts && typeof r.tag_counts === "object") ? r.tag_counts :
      (blob?.tag_counts && typeof blob.tag_counts === "object") ? blob.tag_counts :
      (blob?.tags && typeof blob.tags === "object") ? blob.tags :
      null;

    return { date, shift, totalPts, admits, discharges, tagsStr, tagsObj, raw: r };
  }

  // ---------------------------------------------------------
  // Canvas helpers (no libs)
  // ---------------------------------------------------------
  function getCanvasCtx(id) {
    const c = $(id);
    if (!c) return null;

    const rect = c.getBoundingClientRect();
    if (!rect.width || rect.width < 10) return null;

    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.floor(rect.width * dpr));
    const hAttr = c.getAttribute("height");
    const cssH = hAttr ? Number(hAttr) : rect.height;
    c.height = Math.max(1, Math.floor((cssH || 140) * dpr));

    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function drawAxes(ctx, w, h, pad) {
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, pad);
    ctx.lineTo(pad, h - pad);
    ctx.lineTo(w - pad, h - pad);
    ctx.stroke();
    ctx.restore();
  }

  function drawLineChart(ctx, labels, seriesList, opts = {}) {
    const w = ctx.canvas.getBoundingClientRect().width;
    const h = ctx.canvas.getBoundingClientRect().height;
    const pad = opts.pad ?? 18;

    ctx.clearRect(0, 0, w, h);
    drawAxes(ctx, w, h, pad);

    const allVals = seriesList.flatMap(s => s.values).map(v => safeNum(v, 0));
    const maxV = Math.max(1, ...allVals);
    const minV = Math.min(0, ...allVals);
    const range = Math.max(1e-9, maxV - minV);

    const n = Math.max(1, labels.length);
    const xStep = (w - pad * 2) / Math.max(1, (n - 1));

    function xy(i, v) {
      const x = pad + i * xStep;
      const norm = (safeNum(v, 0) - minV) / range;
      const y = (h - pad) - norm * (h - pad * 2);
      return { x, y };
    }

    ctx.save();
    ctx.globalAlpha = 0.08;
    for (let k = 1; k <= 3; k++) {
      const y = pad + ((h - pad * 2) * k / 4);
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(w - pad, y);
      ctx.stroke();
    }
    ctx.restore();

    seriesList.forEach((s, idx) => {
      ctx.save();
      ctx.globalAlpha = idx === 0 ? 0.9 : 0.55;
      ctx.lineWidth = idx === 0 ? 2.2 : 1.6;

      ctx.beginPath();
      s.values.forEach((v, i) => {
        const p = xy(i, v);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();

      ctx.globalAlpha = idx === 0 ? 0.9 : 0.55;
      s.values.forEach((v, i) => {
        const p = xy(i, v);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.restore();
    });

    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.font = "11px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.textBaseline = "top";
    if (labels.length) {
      ctx.fillText(String(labels[0]), pad, h - pad + 2);
      const last = String(labels[labels.length - 1]);
      const tw = ctx.measureText(last).width;
      ctx.fillText(last, w - pad - tw, h - pad + 2);
    }
    ctx.restore();
  }

  function drawBarChart(ctx, items, opts = {}) {
    const w = ctx.canvas.getBoundingClientRect().width;
    const h = ctx.canvas.getBoundingClientRect().height;
    const pad = opts.pad ?? 18;

    ctx.clearRect(0, 0, w, h);
    drawAxes(ctx, w, h, pad);

    const maxV = Math.max(1, ...items.map(x => safeNum(x.v, 0)));
    const barAreaW = w - pad * 2;
    const barAreaH = h - pad * 2;

    const n = Math.max(1, items.length);
    const gap = 8;
    const barW = Math.max(12, (barAreaW - gap * (n - 1)) / n);

    items.forEach((it, i) => {
      const v = safeNum(it.v, 0);
      const x = pad + i * (barW + gap);
      const bh = (v / maxV) * barAreaH;
      const y = (h - pad) - bh;

      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x, y, barW, bh);
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = 0.65;
      ctx.font = "11px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.textBaseline = "top";
      const lbl = String(it.k).slice(0, 10);
      const tw = ctx.measureText(lbl).width;
      ctx.fillText(lbl, x + (barW - tw) / 2, h - pad + 2);
      ctx.restore();
    });
  }

  // ---------------------------------------------------------
  // Table
  // ---------------------------------------------------------
  function buildTableHtml(rowsNorm) {
    if (!rowsNorm.length) {
      return `<div style="font-size:13px;opacity:0.7;">No rows.</div>`;
    }

    let html = `
      <div style="overflow:auto;">
        <table style="width:100%;border-collapse:separate;border-spacing:0;min-width:760px;">
          <thead>
            <tr style="text-align:left;font-size:12px;opacity:0.75;">
              <th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.12);">Date</th>
              <th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.12);">Shift</th>
              <th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.12);">Total pts</th>
              <th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.12);">Admits</th>
              <th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.12);">Discharges</th>
              <th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.12);">Top acuity tags</th>
            </tr>
          </thead>
          <tbody>
    `;

    rowsNorm.forEach(r => {
      const tagText =
        r.tagsStr ||
        (r.tagsObj ? topTags(r.tagsObj, 10).map(x => `${x.k}:${x.v}`).join(", ") : "—");

      html += `
        <tr style="font-size:13px;">
          <td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.06);white-space:nowrap;">${r.date || "—"}</td>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.06);">${r.shift || "—"}</td>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.06);">${r.totalPts}</td>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.06);">${r.admits}</td>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.06);">${r.discharges}</td>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.06);opacity:0.85;">${tagText}</td>
        </tr>
      `;
    });

    html += `</tbody></table></div>`;
    return html;
  }

  // ---------------------------------------------------------
  // Render (single guarded path)
  // ---------------------------------------------------------
  function renderDashboard(rowsRaw, reqId) {
    if (reqId !== __pulseReqSeq) return;

    ensureChartShell();
    if (!chartCanvasesExist()) return; // if DOM was wiped mid-render, observer will repair and rerender

    const rowsNorm = (rowsRaw || [])
      .map(normalizeRow)
      .filter(r => r.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const n = rowsNorm.length;

    const avgPts = n ? rowsNorm.reduce((s, r) => s + r.totalPts, 0) / n : 0;
    const avgAdmits = n ? rowsNorm.reduce((s, r) => s + r.admits, 0) / n : 0;
    const avgDis = n ? rowsNorm.reduce((s, r) => s + r.discharges, 0) / n : 0;

    const tagCounts = {};
    rowsNorm.forEach(r => {
      if (r.tagsObj) mergeTagCounts(tagCounts, r.tagsObj);
      else mergeTagCounts(tagCounts, parseTagString(r.tagsStr));
    });
    const top = topTags(tagCounts, 10);

    setSummaryMetrics(`
      <div><strong>Rows:</strong> ${n}</div>
      <div><strong>Avg total patients:</strong> ${avgPts.toFixed(1)}</div>
      <div><strong>Avg admits:</strong> ${avgAdmits.toFixed(1)}</div>
      <div><strong>Avg discharges:</strong> ${avgDis.toFixed(1)}</div>
    `);

    const labels = rowsNorm.map(r => r.date);
    const ptsSeries = rowsNorm.map(r => r.totalPts);
    const admitsSeries = rowsNorm.map(r => r.admits);
    const disSeries = rowsNorm.map(r => r.discharges);

    const ctxPts = getCanvasCtx("pulseChartPatients");
    if (ctxPts) {
      drawLineChart(ctxPts, labels, [{ name: "Total Patients", values: ptsSeries }], { pad: 18 });
      const meta = $("pulseChartPatientsMeta");
      if (meta) meta.textContent = n ? `Min: ${Math.min(...ptsSeries)} • Max: ${Math.max(...ptsSeries)} • Avg: ${avgPts.toFixed(1)}` : "—";
    }

    const ctxFlow = getCanvasCtx("pulseChartFlow");
    if (ctxFlow) {
      drawLineChart(ctxFlow, labels, [
        { name: "Admits", values: admitsSeries },
        { name: "Discharges", values: disSeries }
      ], { pad: 18 });

      const meta = $("pulseChartFlowMeta");
      if (meta) {
        const sumA = admitsSeries.reduce((s, x) => s + safeNum(x, 0), 0);
        const sumD = disSeries.reduce((s, x) => s + safeNum(x, 0), 0);
        meta.textContent = `Total admits: ${sumA} • Total discharges: ${sumD}`;
      }
    }

    const ctxTags = getCanvasCtx("pulseChartTags");
    if (ctxTags) {
      drawBarChart(ctxTags, top.slice(0, 10), { pad: 18 });
      const meta = $("pulseChartTagsMeta");
      if (meta) {
        meta.textContent = top.length
          ? `Top tags: ${top.slice(0, 5).map(x => `${x.k}:${x.v}`).join(" • ")}`
          : "No tag data yet.";
      }
    }

    setTableHtml(buildTableHtml(rowsNorm));
  }

  // ---------------------------------------------------------
  // Auto-repair: if something wipes the charts, rebuild + rerender
  // ---------------------------------------------------------
  function installRepairObserver() {
    const root = $("pulseSummary");
    if (!root || root.__pulseObserverInstalled) return;
    root.__pulseObserverInstalled = true;

    const obs = new MutationObserver(() => {
      // If charts missing but we have prior data, repair + rerender
      if (!chartCanvasesExist() && __lastGoodRowsRaw && __lastGoodRowsRaw.length) {
        ensureChartShell();

        // rerender on next tick (DOM must settle)
        setTimeout(() => {
          // Still only rerender if current request seq hasn't advanced beyond last good render id
          // (we don't want older data to overwrite newer loads)
          const reqId = __lastGoodReqId || __pulseReqSeq;
          renderDashboard(__lastGoodRowsRaw, reqId);
        }, 0);
      }
    });

    obs.observe(root, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------
  // Supabase loaders
  // ---------------------------------------------------------
  async function loadAnalyticsRows(unitId, fromYMD, toYMD, shiftType) {
    const client = window.sb.client;

    let q = client.from("analytics_shift_metrics").select("*").eq("unit_id", unitId);
    if (fromYMD) q = q.gte("shift_date", fromYMD);
    if (toYMD) q = q.lte("shift_date", toYMD);
    if (shiftType) q = q.eq("shift_type", shiftType);

    const { data, error } = await q.order("shift_date", { ascending: false });
    if (error) return { ok: false, error, rows: [] };
    return { ok: true, rows: Array.isArray(data) ? data : [] };
  }

  async function loadSnapshotRows(unitId, fromYMD, toYMD, shiftType) {
    const client = window.sb.client;

    let q = client.from("shift_snapshots").select("*").eq("unit_id", unitId);
    if (fromYMD) q = q.gte("shift_date", fromYMD);
    if (toYMD) q = q.lte("shift_date", toYMD);
    if (shiftType) q = q.eq("shift_type", shiftType);

    const { data, error } = await q.order("shift_date", { ascending: false });
    if (error) return { ok: false, error, rows: [] };
    return { ok: true, rows: Array.isArray(data) ? data : [] };
  }

  // ---------------------------------------------------------
  // Public loader
  // ---------------------------------------------------------
  async function loadUnitPulse() {
    const reqId = ++__pulseReqSeq;

    const unitId = activeUnitId();
    const from = clampDateStr($("pulseFrom")?.value) || null;
    const to = clampDateStr($("pulseTo")?.value) || null;
    const shiftRaw = $("pulseShiftType")?.value || "";
    const shiftType = (shiftRaw === "day" || shiftRaw === "night") ? shiftRaw : "";

    ensureChartShell();
    installRepairObserver();
    if (reqId !== __pulseReqSeq) return;

    setPulseStatus("Loading…");

    if (!unitId) {
      setPulseStatus("No active unit selected.", true);
      renderDashboard([], reqId);
      return;
    }
    if (!sbReady()) {
      setPulseStatus("Offline/demo mode — Supabase not ready.", true);
      renderDashboard([], reqId);
      return;
    }

    try {
      const a = await loadAnalyticsRows(unitId, from, to, shiftType);
      if (reqId !== __pulseReqSeq) return;

      if (a.ok && a.rows.length) {
        setPulseStatus(`Loaded ${a.rows.length} analytics shift metric row(s).`);
        __lastGoodRowsRaw = a.rows.slice();
        __lastGoodReqId = reqId;
        renderDashboard(a.rows, reqId);
        return;
      }

      const s = await loadSnapshotRows(unitId, from, to, shiftType);
      if (reqId !== __pulseReqSeq) return;

      if (!s.ok) {
        setPulseStatus(`Could not load pulse (${s.error?.message || s.error}).`, true);
        renderDashboard([], reqId);
        return;
      }

      setPulseStatus(`Loaded ${s.rows.length} shift snapshot(s) (fallback).`);
      __lastGoodRowsRaw = s.rows.slice();
      __lastGoodReqId = reqId;
      renderDashboard(s.rows, reqId);
    } catch (e) {
      if (reqId !== __pulseReqSeq) return;
      setPulseStatus(`Error loading pulse (${String(e)}).`, true);
      renderDashboard([], reqId);
    }
  }

  // ---------------------------------------------------------
  // Wire UI
  // ---------------------------------------------------------
  function setDefaultDatesIfEmpty() {
    const fromEl = $("pulseFrom");
    const toEl = $("pulseTo");
    if (!fromEl || !toEl) return;

    if (!clampDateStr(toEl.value)) {
      const d = new Date();
      toEl.value = d.toISOString().slice(0, 10);
    }
    if (!clampDateStr(fromEl.value)) {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      fromEl.value = d.toISOString().slice(0, 10);
    }
  }

  function wirePulseUI() {
    const btn = $("btnLoadPulse");
    if (btn && !btn.__pulseWired) {
      btn.addEventListener("click", () => loadUnitPulse());
      btn.__pulseWired = true;
    }

    const fromEl = $("pulseFrom");
    const toEl = $("pulseTo");
    const shiftEl = $("pulseShiftType");
    [fromEl, toEl, shiftEl].forEach(node => {
      if (!node || node.__pulseWired) return;
      node.addEventListener("change", () => loadUnitPulse());
      node.__pulseWired = true;
    });

    window.unitPulse = window.unitPulse || {};
    window.unitPulse.load = loadUnitPulse;
  }

  window.addEventListener("DOMContentLoaded", () => {
    setDefaultDatesIfEmpty();
    ensureChartShell();
    installRepairObserver();
    wirePulseUI();
    setPulseStatus("Choose a range and click “Load Pulse”.");
  });
})();