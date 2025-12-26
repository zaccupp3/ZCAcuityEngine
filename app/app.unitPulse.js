// app/app.unitPulse.js
// ---------------------------------------------------------
// UNIT PULSE — Chart-first MVP (no external libraries)
//
// Fixes:
// ✅ Avoids PostgREST 400 spam by selecting "*" (schema-tolerant)
// ✅ Logs a sample row to console so you can see what's actually stored
// ✅ Charts: Total Patients trend, Admits/Discharges trend, Top Tags bar
// ✅ Still includes table (under <details>)
// ✅ Can read either:
//    - top-level columns (total_pts / total_patients / admits / discharges / top_tags)
//    - OR a jsonb snapshot payload (row.snapshot / row.payload / row.state)
//
// Expected (flexible) fields:
// - unit_id
// - shift_date (YYYY-MM-DD)
// - shift_type ("day"|"night")
// - totals: total_pts OR total_patients
// - admits
// - discharges
// - tags summary: top_tags OR tags_summary OR top_acuity_tags
//
// Optional JSONB (recommended later):
// - snapshot: { totals:{totalPts, admits, discharges}, tags:{tele:22,...} }
// ---------------------------------------------------------

(function () {
  const $ = (id) => document.getElementById(id);

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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    return s;
  }

  function setPulseStatus(msg, isError = false) {
    const node = $("pulseStatusMsg");
    if (!node) return;
    node.textContent = msg || "";
    node.style.color = isError ? "#b91c1c" : "#0f172a";
    node.style.opacity = "0.85";
  }

  function setSummary(html) {
    const node = $("pulseSummary");
    if (!node) return;
    node.innerHTML = html || "No data loaded yet.";
  }

  function setTable(html) {
    const node = $("pulseTable");
    if (!node) return;
    node.innerHTML = html || "";
  }

  // ---------------------------------------------------------
  // Parse tags summary string: "tele:22, nih:6, bg:5"
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
  // Pull metrics either from columns OR JSON blob
  // ---------------------------------------------------------
  function getJsonBlob(r) {
    // common names you might use later
    return r?.snapshot || r?.payload || r?.state || r?.metrics || null;
  }

  function normalizeRow(r) {
    const date = r.shift_date || r.date || r.shiftDate || "";
    const shift = r.shift_type || r.shift || r.shiftType || "";

    const blob = getJsonBlob(r);

    // totals from columns
    const colTotalPts = r.total_pts ?? r.total_patients ?? r.totalPatients;

    // totals from blob
    const blobTotalPts =
      blob?.totals?.totalPts ??
      blob?.totals?.total_pts ??
      blob?.totals?.total_patients ??
      blob?.totalPts ??
      blob?.total_pts ??
      blob?.total_patients;

    const colAdmits = r.admits ?? r.total_admits ?? r.admit_count;
    const blobAdmits =
      blob?.totals?.admits ??
      blob?.admits ??
      blob?.admit_count;

    const colDis = r.discharges ?? r.total_discharges ?? r.discharge_count;
    const blobDis =
      blob?.totals?.discharges ??
      blob?.discharges ??
      blob?.discharge_count;

    const totalPts = safeNum(colTotalPts ?? blobTotalPts, 0);
    const admits = safeNum(colAdmits ?? blobAdmits, 0);
    const discharges = safeNum(colDis ?? blobDis, 0);

    // tags string (if you store precomputed)
    const tagsStr =
      r.top_tags ??
      r.tags_summary ??
      r.top_acuity_tags ??
      "";

    // tags object (if you store JSON map)
    const tagsObj =
      blob?.tags && typeof blob.tags === "object" ? blob.tags : null;

    return { date, shift, totalPts, admits, discharges, tagsStr, tagsObj, raw: r };
  }

  // ---------------------------------------------------------
  // Minimal canvas chart helpers (no libraries)
  // ---------------------------------------------------------
  function ensureChartShell() {
    const container = $("pulseSummary");
    if (!container) return;

    if ($("pulseChartsWrap")) return;

    container.innerHTML = `
      <div id="pulseChartsWrap" style="display:flex;flex-direction:column;gap:12px;">
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

  function getCanvasCtx(id) {
    const c = $(id);
    if (!c) return null;

    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.floor(rect.width * dpr));
    c.height = Math.max(1, Math.floor((c.getAttribute("height") ? Number(c.getAttribute("height")) : rect.height) * dpr));
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
  // Table rendering
  // ---------------------------------------------------------
  function buildTableHtml(rowsNorm) {
    if (!rowsNorm.length) return `<div style="font-size:13px;opacity:0.7;">No rows.</div>`;

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
      const tagText = r.tagsStr || (r.tagsObj ? Object.entries(r.tagsObj).slice(0, 10).map(([k,v]) => `${k}:${v}`).join(", ") : "—");
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
  // Dashboard rendering
  // ---------------------------------------------------------
  function renderDashboard(rowsRaw) {
    const rowsNorm = (rowsRaw || []).map(normalizeRow)
      .filter(r => r.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    ensureChartShell();

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

    const chartsWrap = $("pulseChartsWrap");
    if (chartsWrap && !chartsWrap.__summaryInjected) {
      const summaryCard = document.createElement("div");
      summaryCard.className = "staff-card";
      summaryCard.innerHTML = `
        <div class="staff-card-header">Pulse Summary</div>
        <div style="font-size:13px;line-height:1.45;">
          <div><strong>Rows:</strong> ${n}</div>
          <div><strong>Avg total patients:</strong> ${avgPts.toFixed(1)}</div>
          <div><strong>Avg admits:</strong> ${avgAdmits.toFixed(1)}</div>
          <div><strong>Avg discharges:</strong> ${avgDis.toFixed(1)}</div>
        </div>
      `;
      chartsWrap.insertBefore(summaryCard, chartsWrap.firstChild);
      chartsWrap.__summaryInjected = true;
    }

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
          : "No tag data yet (top_tags empty).";
      }
    }

    const tableSlot = $("pulseTableDetailsSlot");
    if (tableSlot) tableSlot.innerHTML = buildTableHtml(rowsNorm);

    setTable(buildTableHtml(rowsNorm));
    setSummary(""); // charts shell is summary now
  }

  // ---------------------------------------------------------
  // Supabase load (schema-tolerant)
  // ---------------------------------------------------------
  async function loadShiftSnapshots(unitId, fromYMD, toYMD, shiftType) {
    const client = window.sb.client;

    let q = client
      .from("shift_snapshots")
      .select("*")           // ✅ prevents 400 if a column name doesn't exist
      .eq("unit_id", unitId);

    if (fromYMD) q = q.gte("shift_date", fromYMD);
    if (toYMD) q = q.lte("shift_date", toYMD);
    if (shiftType) q = q.eq("shift_type", shiftType);

    const { data, error } = await q.order("shift_date", { ascending: false });
    if (error) return { ok: false, error };
    return { ok: true, rows: Array.isArray(data) ? data : [] };
  }

  // ---------------------------------------------------------
  // Public: load pulse
  // ---------------------------------------------------------
  async function loadUnitPulse() {
    const unitId = activeUnitId();
    const from = clampDateStr($("pulseFrom")?.value) || null;
    const to = clampDateStr($("pulseTo")?.value) || null;

    const shiftRaw = $("pulseShiftType")?.value || "";
    const shiftType = (shiftRaw === "day" || shiftRaw === "night") ? shiftRaw : "";

    setPulseStatus("Loading…");

    if (!unitId) {
      setPulseStatus("No active unit selected.", true);
      renderDashboard([]);
      return;
    }

    if (!sbReady()) {
      setPulseStatus("Offline/demo mode — Supabase not ready.", true);
      renderDashboard([]);
      return;
    }

    try {
      const res = await loadShiftSnapshots(unitId, from, to, shiftType);
      if (!res.ok) {
        console.warn("[UnitPulse] load failed", res.error);
        setPulseStatus(`Could not load shift snapshots (${res.error?.message || res.error}).`, true);
        renderDashboard([]);
        return;
      }

      // ✅ debug: inspect what columns are actually present
      console.log("[UnitPulse] rows:", res.rows.length);
      if (res.rows[0]) console.log("[UnitPulse] sample row:", res.rows[0]);

      setPulseStatus(`Loaded ${res.rows.length} shift snapshot(s).`);
      renderDashboard(res.rows);
    } catch (e) {
      console.warn("[UnitPulse] exception", e);
      setPulseStatus(`Error loading pulse (${String(e)}).`, true);
      renderDashboard([]);
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
    wirePulseUI();
    setPulseStatus("Choose a range and click “Load Pulse”.");
  });
})();