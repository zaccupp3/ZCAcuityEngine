// app/app.unitMetrics.js
// Unit + Staff longitudinal metrics with interval presets and narrative reports.
(function () {
  if (window.__unitMetricsSingletonLoaded) return;
  window.__unitMetricsSingletonLoaded = true;

  const $ = (id) => document.getElementById(id);
  const ACUITY_KEYS = ["tele","drip","nih","bg","ciwa","cows","psych","prns","emu","restraint","sitter","vpo","isolation","admit","lateDc"];
  const SHIFT_WINDOWS = { last_3_shifts: 3, last_6_shifts: 6, last_12_shifts: 12 };
  let __req = 0;
  let __last = null;
  let __lastReq = 0;

  const num = (x, d = 0) => Number.isFinite(Number(x)) ? Number(x) : d;
  const arr = (v) => Array.isArray(v) ? v : [];
  const esc = (v) => String(v || "").replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
  const ymd = (d) => new Date(d).toISOString().slice(0, 10);
  function addDaysYmd(date, days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return "";
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + Number(days || 0));
    return ymd(d);
  }
  function eventLocalParts(eventLike) {
    const d = new Date(eventLike?.created_at || eventLike?.ts || Date.now());
    if (Number.isNaN(d.getTime())) return { date: "", hour: 0 };
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return { date: `${year}-${month}-${day}`, hour: d.getHours() };
  }
  const activeUnitId = () => (window.activeUnitId ? String(window.activeUnitId) : "");
  const sbReady = () => !!(window.sb && window.sb.client && typeof window.sb.client.from === "function");
  const normalizeShift = (s) => {
    const v = String(s || "").trim().toLowerCase();
    if (v === "day" || v.includes("day")) return "day";
    if (v === "night" || v === "noc" || v.includes("night") || v.includes("noc")) return "night";
    return v;
  };
  const shiftRank = (s) => (normalizeShift(s) === "day" ? 1 : 2);
  const shiftKey = (date, shift) => `${date}|${normalizeShift(shift)}`;
  const aliasKey = () => `cupp_staff_profile_aliases_${activeUnitId() || "local"}`;
  const dismissKey = () => `cupp_staff_profile_dismissals_${activeUnitId() || "local"}`;
  const hiddenKey = () => `cupp_staff_profile_hidden_${activeUnitId() || "local"}`;

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
  function loadAliases() {
    return readJson(aliasKey(), {});
  }
  function saveAliases(map) {
    writeJson(aliasKey(), map || {});
  }
  function loadDismissals() {
    return readJson(dismissKey(), {});
  }
  function saveDismissals(map) {
    writeJson(dismissKey(), map || {});
  }
  function loadHiddenProfiles() {
    return readJson(hiddenKey(), {});
  }
  function saveHiddenProfiles(map) {
    writeJson(hiddenKey(), map || {});
  }
  function normName(v) {
    return String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
  }
  function pairKey(a, b) {
    return [normName(a), normName(b)].sort().join("::");
  }
  function isFillerStaffName(name) {
    const n = normName(name);
    if (!n) return true;
    return (
      /^incoming\s+(rn|pca)\s*\d*$/.test(n) ||
      /^current\s+(rn|pca)\s*\d*$/.test(n) ||
      /^oncoming\s+(rn|pca)\s*\d*$/.test(n) ||
      /^(noc|day|night)\s+rn\s*\d*$/.test(n) ||
      /^(noc|day|night)\s+pca\s*\d*$/.test(n) ||
      /^(rn|pca)\s*staff$/.test(n) ||
      /^(rn|pca)\s*\d+$/.test(n) ||
      /^unknown\s+staff$/.test(n)
    );
  }
  function isHiddenStaffName(name, hidden) {
    return !!(hidden && hidden[normName(name)]);
  }
  function canPruneMetricsData() {
    const role = String(window.activeUnitRole || "").toLowerCase();
    return role === "admin" || role === "owner";
  }
  function canonicalStaffName(name, aliases) {
    const key = normName(name);
    return aliases[key] || String(name || "").trim();
  }
  function likelySamePerson(a, b) {
    const aNorm = normName(a);
    const bNorm = normName(b);
    if (!aNorm || !bNorm || aNorm === bNorm) return false;
    const aParts = aNorm.split(" ").filter(Boolean);
    const bParts = bNorm.split(" ").filter(Boolean);
    const aFirst = aParts[0] || "";
    const bFirst = bParts[0] || "";
    if (!aFirst || aFirst !== bFirst) return false;
    if (aParts.length === 1 || bParts.length === 1) return true;
    return aNorm.includes(bNorm) || bNorm.includes(aNorm);
  }
  function chooseCanonicalName(a, b) {
    const aa = String(a || "").trim();
    const bb = String(b || "").trim();
    if (bb.length > aa.length) return bb;
    return aa || bb;
  }

  function setStatus(msg, err = false) {
    const el = $("pulseStatusMsg");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = err ? "#b91c1c" : "#0f172a";
  }

  function ensureControls() {
    const host = document.querySelector("#unitMetricsTab .staff-inline-controls");
    if (!host || $("metricsViewMode")) return;
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:contents;";
    wrap.innerHTML = `
      <label for="metricsInterval"><strong>Interval:</strong></label>
      <select id="metricsInterval">
        <option value="all_time" selected>All time</option>
        <option value="selected_dates">Selected dates</option>
        <option value="last_3_shifts">Last 3 shifts</option>
        <option value="last_6_shifts">Last 6 shifts</option>
        <option value="last_12_shifts">Last 12 shifts</option>
        <option value="last_3_months">Last 3 months</option>
        <option value="last_6_months">Last 6 months</option>
        <option value="last_12_months">Last 12 months</option>
      </select>
      <input id="metricsViewMode" type="hidden" value="unit" />
      <button id="metricsStaffPrev" type="button" disabled style="display:none;">&larr;</button>
      <div id="metricsStaffCurrent" style="display:none;">Select staff</div>
      <button id="metricsStaffNext" type="button" disabled style="display:none;">&rarr;</button>
      <select id="metricsStaffSelect" disabled style="display:none;min-width:180px;"><option value="">Select staff</option></select>
      <select id="metricsReportDepth" style="display:none;"><option value="quick">Quick paragraph</option><option value="extensive">Extensive report</option></select>
      <button id="btnBackfillMetrics" type="button">Backfill Stored Metrics</button>
      <button id="btnMetricsPrune" type="button" style="display:none;border-radius:999px;padding:7px 12px;">Prune Staff Data</button>
    `;
    host.appendChild(wrap);
    const pruneBtn = $("btnMetricsPrune");
    if (pruneBtn) pruneBtn.style.display = canPruneMetricsData() ? "" : "none";
  }

  function ensureShell() {
    const root = $("pulseSummary");
    if (!root) return;
    if ($("metricsQuad1Body") && $("metricsQuad2Body") && $("metricsQuad3Body") && $("metricsQuad4Body")) return;
    root.innerHTML = `
      <div class="staff-card">
        <div id="metricsQuad1Title" class="staff-card-header">Unit Summary</div>
        <div id="pulseSummaryMetrics" style="font-size:13px;line-height:1.45;"></div>
        <div id="metricsNarrativeQuick" style="margin-top:8px;font-size:13px;line-height:1.5;"></div>
        <div id="metricsNarrativeFull" style="margin-top:8px;font-size:12px;line-height:1.5;opacity:.9;"></div>
        <div id="metricsQuad1Body" style="padding-top:12px;"></div>
        <div id="metricsFocusedReport" style="margin-top:12px;"></div>
        <div id="metricsMergeSuggestion" style="margin-top:10px;"></div>
        <div id="metricsPrunePanel" style="margin-top:10px;"></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;">
        <div class="staff-card" style="flex:1;min-width:320px;"><div id="metricsQuad2Title" class="staff-card-header">Summary B</div><div id="metricsQuad2Body" style="padding:12px;"></div></div>
        <div class="staff-card" style="flex:1;min-width:320px;"><div id="metricsQuad3Title" class="staff-card-header">Summary C</div><div id="metricsQuad3Body" style="padding:12px;"></div></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;">
        <div class="staff-card" style="flex:1;min-width:320px;"><div id="metricsQuad4Title" class="staff-card-header">Summary D</div><div id="metricsQuad4Body" style="padding:12px;"></div></div>
      </div>
      <div id="pulseTableDetailsSlot" style="display:none;"></div>
    `;
  }

  function ctx(id) {
    const c = $(id); if (!c) return null;
    const r = c.getBoundingClientRect(); if (!r.width) return null;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.floor(r.width * dpr));
    c.height = Math.max(1, Math.floor(num(c.getAttribute("height"), 140) * dpr));
    const x = c.getContext("2d"); x.setTransform(dpr,0,0,dpr,0,0); return x;
  }
  function drawLine(c, labels, series) {
    const x = ctx(c); if (!x) return; const w = x.canvas.getBoundingClientRect().width, h = x.canvas.getBoundingClientRect().height, p = 18;
    x.clearRect(0,0,w,h); x.beginPath(); x.moveTo(p,p); x.lineTo(p,h-p); x.lineTo(w-p,h-p); x.stroke();
    const all = series.flatMap((s) => s.values).map((v) => num(v, 0)); const max = Math.max(1, ...all), min = Math.min(0, ...all), rng = Math.max(1e-9, max - min);
    const step = (w - p * 2) / Math.max(1, labels.length - 1);
    const pt = (i, v) => ({ xx: p + i * step, yy: (h - p) - ((num(v, 0) - min) / rng) * (h - p * 2) });
    series.forEach((s, idx) => { x.globalAlpha = idx ? .55 : .9; x.lineWidth = idx ? 1.6 : 2.2; x.beginPath(); s.values.forEach((v, i) => { const pp = pt(i, v); if (!i) x.moveTo(pp.xx, pp.yy); else x.lineTo(pp.xx, pp.yy); }); x.stroke(); });
    x.globalAlpha = 1;
  }
  function drawBars(c, items) {
    const x = ctx(c); if (!x) return; const w = x.canvas.getBoundingClientRect().width, h = x.canvas.getBoundingClientRect().height, p = 18;
    x.clearRect(0,0,w,h); x.beginPath(); x.moveTo(p,p); x.lineTo(p,h-p); x.lineTo(w-p,h-p); x.stroke();
    const max = Math.max(1, ...items.map((it) => num(it.v, 0))); const n = Math.max(1, items.length), g = 8, bw = Math.max(12, ((w - p * 2) - g * (n - 1)) / n);
    items.forEach((it, i) => { const v = num(it.v, 0), bh = (v / max) * (h - p * 2), xx = p + i * (bw + g), yy = (h - p) - bh; x.globalAlpha = .55; x.fillRect(xx, yy, bw, bh); });
    x.globalAlpha = 1;
  }

  function tagsFromPatients(pats, idSet) {
    const out = {};
    (Array.isArray(pats) ? pats : []).forEach((p) => {
      if (!p || p.isEmpty) return;
      if (idSet && !idSet.has(Number(p.id))) return;
      ACUITY_KEYS.forEach((k) => { if (p[k]) out[k] = (out[k] || 0) + 1; });
    });
    return out;
  }
  function renderTagTiles(hostId, items, emptyText) {
    const el = $(hostId);
    if (!el) return;
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      el.innerHTML = `<div style="grid-column:1 / -1;opacity:.7;font-size:12px;">${esc(emptyText || "No tag data.")}</div>`;
      return;
    }
    el.innerHTML = list.map((it) => `
      <div style="
        border:1px solid rgba(15,23,42,.10);
        border-radius:14px;
        background:rgba(255,255,255,.92);
        box-shadow:0 6px 18px rgba(0,0,0,.05);
        padding:12px 10px;
        display:flex;
        flex-direction:column;
        gap:6px;
        min-height:82px;
      ">
        <div style="font-size:12px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:.02em;">${esc(it.k)}</div>
        <div style="font-size:26px;font-weight:900;color:#0f172a;line-height:1;">${num(it.v, 0)}</div>
      </div>
    `).join("");
  }
  function renderMetricTiles(hostId, items, emptyText) {
    const el = $(hostId);
    if (!el) return;
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      el.innerHTML = `<div style="opacity:.7;font-size:12px;">${esc(emptyText || "No data.")}</div>`;
      return;
    }
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;">
        ${list.map((it) => `
          <div style="
            border:1px solid rgba(15,23,42,.10);
            border-radius:14px;
            background:rgba(255,255,255,.92);
            box-shadow:0 6px 18px rgba(0,0,0,.05);
            padding:12px 10px;
            display:flex;
            flex-direction:column;
            gap:6px;
            min-height:82px;
          ">
            <div style="font-size:12px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:.02em;">${esc(it.k)}</div>
            <div style="font-size:26px;font-weight:900;color:#0f172a;line-height:1;">${esc(String(it.v))}</div>
            ${it.sub ? `<div style="font-size:11px;color:#64748b;line-height:1.35;">${esc(String(it.sub))}</div>` : ``}
          </div>
        `).join("")}
      </div>
    `;
  }

  function barColor(index) {
    const colors = ["#2563eb", "#059669", "#d97706", "#7c3aed", "#dc2626", "#0891b2"];
    return colors[index % colors.length];
  }

  function renderBarChart(hostId, items, emptyText) {
    const el = $(hostId);
    if (!el) return;
    const list = (Array.isArray(items) ? items : [])
      .map((it) => ({ ...it, v: num(it.v, 0) }))
      .filter((it) => it.v > 0 || it.keepZero)
      .slice(0, 12);
    if (!list.length) {
      el.innerHTML = `<div style="opacity:.7;font-size:12px;">${esc(emptyText || "No chart data.")}</div>`;
      return;
    }
    const max = Math.max(1, ...list.map((it) => Math.abs(num(it.v, 0))));
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${list.map((it, idx) => {
          const width = Math.max(3, Math.round((Math.abs(num(it.v, 0)) / max) * 100));
          return `
            <div style="display:grid;grid-template-columns:minmax(92px,150px) 1fr auto;gap:10px;align-items:center;">
              <div style="font-size:12px;font-weight:800;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(it.k)}</div>
              <div style="height:14px;border-radius:999px;background:#e2e8f0;overflow:hidden;">
                <div style="width:${width}%;height:100%;border-radius:999px;background:${barColor(idx)};"></div>
              </div>
              <div style="font-size:12px;font-weight:900;color:#0f172a;min-width:42px;text-align:right;">${esc(String(it.label ?? it.v))}</div>
              ${it.sub ? `<div style="grid-column:2 / 4;font-size:11px;color:#64748b;margin-top:-6px;">${esc(String(it.sub))}</div>` : ``}
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function renderLineChart(hostId, chart, emptyText) {
    const el = $(hostId);
    if (!el) return;
    const series = Array.isArray(chart?.series) ? chart.series : [];
    const validSeries = series
      .map((s) => ({
        ...s,
        points: (Array.isArray(s.points) ? s.points : [])
          .map((p) => ({ ...p, v: num(p.v, NaN) }))
          .filter((p) => Number.isFinite(p.v))
      }))
      .filter((s) => s.points.length);

    if (!validSeries.length) {
      el.innerHTML = `<div style="opacity:.7;font-size:12px;">${esc(emptyText || "No line graph data.")}</div>`;
      return;
    }

    const labels = [];
    validSeries.forEach((s) => {
      s.points.forEach((p) => {
        const k = String(p.k || "");
        if (k && !labels.includes(k)) labels.push(k);
      });
    });
    const allValues = validSeries.flatMap((s) => s.points.map((p) => p.v));
    const minValRaw = Math.min(...allValues, 0);
    const maxValRaw = Math.max(...allValues, 1);
    const pad = Math.max(1, (maxValRaw - minValRaw) * 0.12);
    const minVal = Math.max(0, minValRaw - pad);
    const maxVal = maxValRaw + pad;
    const width = 640;
    const height = 220;
    const left = 44;
    const right = 18;
    const top = 18;
    const bottom = 46;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const xFor = (k) => {
      const idx = Math.max(0, labels.indexOf(String(k || "")));
      return labels.length <= 1 ? left + plotW / 2 : left + (idx / (labels.length - 1)) * plotW;
    };
    const yFor = (v) => top + (1 - ((num(v, 0) - minVal) / Math.max(1, maxVal - minVal))) * plotH;
    const ticks = [0, 0.5, 1].map((t) => {
      const value = minVal + (maxVal - minVal) * (1 - t);
      const y = top + plotH * t;
      return { y, value };
    });

    const svgSeries = validSeries.map((s, idx) => {
      const color = s.color || barColor(idx);
      const points = s.points.map((p) => `${xFor(p.k).toFixed(1)},${yFor(p.v).toFixed(1)}`).join(" ");
      const dots = s.points.map((p) => `
        <circle cx="${xFor(p.k).toFixed(1)}" cy="${yFor(p.v).toFixed(1)}" r="4" fill="${esc(color)}">
          <title>${esc(`${s.name || "Series"} ${p.k}: ${p.v.toFixed(1)}`)}</title>
        </circle>
      `).join("");
      return `<polyline fill="none" stroke="${esc(color)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${points}" />${dots}`;
    }).join("");

    const labelEvery = Math.max(1, Math.ceil(labels.length / 5));
    el.innerHTML = `
      <div style="grid-column:1 / -1;width:100%;overflow:hidden;">
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(chart?.title || "Line graph")}" style="width:100%;height:auto;display:block;">
          <rect x="0" y="0" width="${width}" height="${height}" fill="#fff" rx="8"></rect>
          ${ticks.map((tick) => `
            <line x1="${left}" y1="${tick.y.toFixed(1)}" x2="${width - right}" y2="${tick.y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"></line>
            <text x="${left - 8}" y="${(tick.y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#64748b">${tick.value.toFixed(1)}</text>
          `).join("")}
          ${labels.map((label, idx) => idx % labelEvery === 0 ? `
            <text x="${xFor(label).toFixed(1)}" y="${height - 20}" text-anchor="middle" font-size="10" fill="#64748b">${esc(label.replace("|", " "))}</text>
          ` : "").join("")}
          ${svgSeries}
        </svg>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:#475569;">
          ${validSeries.map((s, idx) => `
            <span style="display:inline-flex;align-items:center;gap:6px;">
              <span style="width:18px;height:3px;border-radius:999px;background:${esc(s.color || barColor(idx))};display:inline-block;"></span>
              ${esc(s.name || `Series ${idx + 1}`)}
            </span>
          `).join("")}
        </div>
      </div>
    `;
  }

  function renderSplitLineCharts(hostId, charts, emptyText) {
    const el = $(hostId);
    if (!el) return;
    const list = Array.isArray(charts) ? charts : [];
    if (!list.length) {
      el.innerHTML = `<div style="opacity:.7;font-size:12px;">${esc(emptyText || "No trend data.")}</div>`;
      return;
    }
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;width:100%;grid-column:1 / -1;">
        ${list.map((chart, idx) => `
          <div style="border:1px solid rgba(15,23,42,.10);border-radius:8px;background:#fff;padding:8px;">
            <div style="font-size:12px;font-weight:900;color:#334155;margin-bottom:4px;">${esc(chart.title || `Trend ${idx + 1}`)}</div>
            <div id="${hostId}Split${idx}"></div>
          </div>
        `).join("")}
      </div>
    `;
    list.forEach((chart, idx) => renderLineChart(`${hostId}Split${idx}`, chart, emptyText));
  }

  function compactShiftLabel(row) {
    const d = String(row?.date || row?.shift_date || "");
    const mmdd = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5).replace("-", "/") : d;
    const s = normalizeShift(row?.shift || row?.shift_type || "");
    return `${mmdd}|${s === "night" ? "N" : s === "day" ? "D" : "All"}`;
  }

  function buildTagTrendChart(rows, keys, title) {
    const list = Array.isArray(rows) ? rows : [];
    const labels = list.map(compactShiftLabel);
    return {
      title,
      series: (keys || []).map((key, idx) => ({
        name: key,
        color: barColor(idx),
        points: list.map((row, i) => ({
          k: labels[i],
          v: num(row?.tagsObj?.[key], 0)
        }))
      }))
    };
  }

  function buildSingleTrendChart(rows, seriesList, title) {
    const list = Array.isArray(rows) ? rows : [];
    const labels = list.map(compactShiftLabel);
    return {
      title,
      series: (seriesList || []).map((s, idx) => ({
        name: s.name,
        color: s.color || barColor(idx),
        points: list.map((row, i) => ({ k: labels[i], v: num(s.value(row), 0) }))
      }))
    };
  }

  function buildAverageWorkloadTrendCharts(rows, staffRows) {
    const list = Array.isArray(rows) ? rows : [];
    const labels = list.map(compactShiftLabel);
    const byShiftRole = new Map();
    (staffRows || []).forEach((r) => {
      const role = String(r.role || "").toUpperCase();
      if (role !== "RN" && role !== "PCA") return;
      if (isFillerStaffName(r.staff_name)) return;
      const key = `${shiftKey(r.shift_date, r.shift_type)}|${role}`;
      if (!byShiftRole.has(key)) byShiftRole.set(key, { total: 0, count: 0 });
      const rec = byShiftRole.get(key);
      rec.total += num(r.workload_score, 0);
      rec.count += 1;
    });
    const make = (role, color) => ({
      title: `${role} average workload`,
      series: [{
        name: `${role} average workload`,
        color,
        points: list.map((row, i) => {
          const rec = byShiftRole.get(`${shiftKey(row.date, row.shift)}|${role}`);
          return { k: labels[i], v: rec?.count ? rec.total / rec.count : 0 };
        })
      }]
    });
    return [make("RN", "#2563eb"), make("PCA", "#059669")];
  }

  function selectedTrendTags(top) {
    const defaults = (top || []).slice(0, 5).map((x) => x.k);
    const current = Array.isArray(window.__metricsSelectedTrendTags) ? window.__metricsSelectedTrendTags : defaults;
    const allowed = new Set((top || []).map((x) => x.k));
    const clean = current.filter((k) => allowed.has(k));
    return Array.isArray(window.__metricsSelectedTrendTags) ? clean : defaults;
  }

  function renderTrendSelector(metaId, top) {
    const host = $(metaId);
    if (!host) return;
    const selected = new Set(selectedTrendTags(top));
    const options = (top || []).slice(0, 8);
    host.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <span>Show lines:</span>
        ${options.map((x) => `
          <label style="display:inline-flex;gap:4px;align-items:center;font-size:12px;">
            <input type="checkbox" data-metrics-tag-line="${esc(x.k)}" ${selected.has(x.k) ? "checked" : ""} />
            ${esc(x.k)}
          </label>
        `).join("")}
      </div>
    `;
    host.querySelectorAll("[data-metrics-tag-line]").forEach((input) => {
      input.addEventListener("change", () => {
        window.__metricsSelectedTrendTags = Array.from(host.querySelectorAll("[data-metrics-tag-line]:checked"))
          .map((el) => el.getAttribute("data-metrics-tag-line"))
          .filter(Boolean);
        if (__last) renderAll(__last, __lastReq);
      });
    });
  }

  function renderAnalyticsReportIndex(rows, snapshots, staff, events) {
    const host = $("pulseTableDetailsSlot");
    if (!host) return;
    const canBuild = typeof window.__advancedMetricsBuildReports === "function" && typeof window.__advancedMetricsReportRows === "function";
    if (!canBuild) {
      host.style.display = "";
      host.innerHTML = `<div class="staff-card"><div class="staff-card-header">Report Index</div><div style="font-size:12px;color:#64748b;">Report index is loading. Reload metrics after Advanced Metrics code finishes loading.</div></div>`;
      return;
    }
    const reports = window.__advancedMetricsBuildReports({
      rows: (rows || []).map((r) => ({
        ...r,
        shift_date: r.date || r.shift_date,
        shift_type: r.shift || r.shift_type
      })),
      snapshots: snapshots || [],
      staff: staff || [],
      events: events || []
    });
    host.style.display = "";
    host.innerHTML = `
      <div class="staff-card" style="margin-top:12px;">
        <div class="staff-card-header">Report Index</div>
        <div style="font-size:12px;line-height:1.45;color:#475569;margin-bottom:10px;">
          Unit-level index for acuity balance, handoff efficiency, patient safety, flow, and patient experience pressure.
        </div>
        ${window.__advancedMetricsReportRows(reports)}
        ${typeof window.__advancedMetricsMetricCard === "function" ? `
          <div style="margin-top:12px;font-size:12px;line-height:1.45;color:#475569;">
            Scoring rationale cards show what each index watches and how the score is being interpreted. These are intentionally editable signals for future refinement.
          </div>
          <div class="advanced-report-grid" style="margin-top:10px;">
            ${reports.map((r) => window.__advancedMetricsMetricCard(r)).join("")}
          </div>
        ` : ""}
      </div>
    `;
  }

  function renderSummaryTiles(items, emptyText) {
    const host = $("pulseSummaryMetrics");
    if (!host) return;
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      host.innerHTML = `<div style="opacity:.7;font-size:12px;">${esc(emptyText || "No summary data.")}</div>`;
      return;
    }
    host.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;">
        ${list.map((it) => `
          <div style="border:1px solid rgba(15,23,42,.10);border-radius:14px;background:rgba(255,255,255,.92);box-shadow:0 6px 18px rgba(0,0,0,.05);padding:12px 10px;display:flex;flex-direction:column;gap:6px;min-height:82px;">
            <div style="font-size:12px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:.02em;">${esc(it.k)}</div>
            <div style="font-size:24px;font-weight:900;color:#0f172a;line-height:1;">${esc(String(it.v))}</div>
            ${it.sub ? `<div style="font-size:11px;color:#64748b;line-height:1.35;">${esc(String(it.sub))}</div>` : ``}
          </div>
        `).join("")}
      </div>
    `;
  }
  function setQuad(id, title, mode, items, meta, emptyText) {
    const titleEl = $(`metricsQuad${id}Title`);
    const bodyEl = $(`metricsQuad${id}Body`);
    if (titleEl) titleEl.textContent = title;
    if (!bodyEl) return;
    bodyEl.innerHTML = `
      <div id="metricsQuad${id}Tiles" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;"></div>
      <div id="metricsQuad${id}Meta" style="padding-top:12px;font-size:12px;opacity:.75;"></div>
    `;
    if (mode === "tags") renderTagTiles(`metricsQuad${id}Tiles`, items, emptyText);
    else if (mode === "bars") renderBarChart(`metricsQuad${id}Tiles`, items, emptyText);
    else if (mode === "lines") renderLineChart(`metricsQuad${id}Tiles`, items, emptyText);
    else if (mode === "splitLines") renderSplitLineCharts(`metricsQuad${id}Tiles`, items, emptyText);
    else renderMetricTiles(`metricsQuad${id}Tiles`, items, emptyText);
    const metaEl = $(`metricsQuad${id}Meta`);
    if (metaEl) metaEl.textContent = meta || "";
  }
  function renderPrunePanel(rows) {
    const host = $("metricsPrunePanel");
    const topBtn = $("btnMetricsPrune");
    if (!host) return;
    if (!canPruneMetricsData()) {
      host.innerHTML = "";
      if (topBtn) topBtn.style.display = "none";
      return;
    }
    const open = !!window.__metricsPruneOpen;
    if (topBtn) {
      topBtn.style.display = "";
      topBtn.textContent = open ? "Hide Prune Tools" : "Prune Staff Data";
    }
    const hidden = loadHiddenProfiles();
    const aliases = loadAliases();
    const names = Array.from(new Set((rows || []).map((r) => String(r.staff_name || "").trim()).filter(Boolean)));
    const filler = names.filter((name) => isFillerStaffName(name) && !isHiddenStaffName(name, hidden)).sort((a, b) => a.localeCompare(b));
    const activeNames = names.filter((name) => !isFillerStaffName(name) && !isHiddenStaffName(name, hidden));
    const duplicatePairs = [];
    for (let i = 0; i < activeNames.length; i += 1) {
      for (let j = i + 1; j < activeNames.length; j += 1) {
        const a = activeNames[i], b = activeNames[j];
        if (aliases[normName(a)] || aliases[normName(b)]) continue;
        if (likelySamePerson(a, b)) duplicatePairs.push({ a, b });
      }
    }
    host.innerHTML = open ? `
        <div style="margin-top:10px;border:1px solid rgba(15,23,42,.10);border-radius:14px;background:rgba(248,250,252,.92);padding:12px;">
          <div style="font-size:13px;font-weight:900;color:#0f172a;margin-bottom:8px;">Profile cleanup</div>
          <div style="font-size:12px;color:#475569;margin-bottom:10px;">Hide filler profiles from metrics and combine likely duplicate staff names into one profile view.</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;">
            <div>
              <div style="font-size:12px;font-weight:800;color:#475569;margin-bottom:6px;">Filler profiles</div>
              ${filler.length ? filler.map((name) => `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(15,23,42,.06);"><span style="font-size:12px;">${esc(name)}</span><button type="button" class="metrics-hide-filler" data-name="${esc(name)}">Hide</button></div>`).join("") : `<div style="font-size:12px;color:#64748b;">No filler profiles detected.</div>`}
            </div>
            <div>
              <div style="font-size:12px;font-weight:800;color:#475569;margin-bottom:6px;">Recommended merges</div>
              ${duplicatePairs.length ? duplicatePairs.slice(0, 8).map((pair) => `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(15,23,42,.06);"><span style="font-size:12px;">${esc(pair.a)} + ${esc(pair.b)}</span><button type="button" class="metrics-merge-pair" data-a="${esc(pair.a)}" data-b="${esc(pair.b)}">Combine</button></div>`).join("") : `<div style="font-size:12px;color:#64748b;">No likely duplicates detected.</div>`}
              <div style="margin-top:10px;"><button id="metricsPruneManualCombine" type="button">Manual Combine...</button></div>
            </div>
          </div>
        </div>
      ` : ``;
    host.querySelectorAll(".metrics-hide-filler").forEach((btn) => {
      btn.onclick = () => {
        const next = loadHiddenProfiles();
        next[normName(btn.getAttribute("data-name") || "")] = true;
        saveHiddenProfiles(next);
        if (__last) renderAll(__last, __lastReq);
      };
    });
    host.querySelectorAll(".metrics-merge-pair").forEach((btn) => {
      btn.onclick = () => {
        const a = String(btn.getAttribute("data-a") || "");
        const b = String(btn.getAttribute("data-b") || "");
        const canonical = chooseCanonicalName(a, b);
        const next = loadAliases();
        next[normName(a)] = canonical;
        next[normName(b)] = canonical;
        saveAliases(next);
        window.__metricsStaffRequestedValue = `RN::${normName(canonical)}`;
        if (__last) renderAll(__last, __lastReq);
      };
    });
    const manual = $("metricsPruneManualCombine");
    if (manual) manual.onclick = () => {
      const first = window.prompt("Type the first profile name to combine.", "");
      if (!first) return;
      const second = window.prompt(`Combine "${first}" with which other profile?`, "");
      if (!second) return;
      const canonical = chooseCanonicalName(first, second);
      const next = loadAliases();
      next[normName(first)] = canonical;
      next[normName(second)] = canonical;
      saveAliases(next);
      window.__metricsStaffRequestedValue = `RN::${normName(canonical)}`;
      if (__last) renderAll(__last, __lastReq);
    };
  }
  function renderFocusedStaffReport(payload) {
    const host = $("metricsFocusedReport");
    if (!host) return;
    if (!payload) {
      host.innerHTML = "";
      return;
    }
    const trendRows = Array.isArray(payload.trendRows) ? payload.trendRows : [];
    const tagRows = Array.isArray(payload.tagRows) ? payload.tagRows : [];
    host.innerHTML = `
      <div style="
        border:1px solid rgba(15,23,42,.10);
        border-radius:14px;
        background:rgba(248,250,252,.9);
        padding:12px;
      ">
        <div style="font-size:13px;font-weight:900;color:#0f172a;margin-bottom:8px;">Focused Staff Report</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;">
          <div style="border:1px solid rgba(15,23,42,.08);border-radius:12px;background:#fff;padding:10px;">
            <div style="font-size:12px;font-weight:800;color:#475569;">Average Shift</div>
            <div style="margin-top:6px;font-size:12px;line-height:1.45;color:#0f172a;">
              <div>${payload.avgPatients} patients</div>
              <div>${payload.avgWorkload} load score</div>
              <div>${payload.avgTagBurden} higher-acuity tags</div>
            </div>
          </div>
          <div style="border:1px solid rgba(15,23,42,.08);border-radius:12px;background:#fff;padding:10px;">
            <div style="font-size:12px;font-weight:800;color:#475569;">Trend Over Time</div>
            <div style="margin-top:6px;font-size:12px;line-height:1.45;color:#0f172a;">
              ${trendRows.length ? trendRows.map((row) => `<div>${esc(row)}</div>`).join("") : "<div>No trend data yet.</div>"}
            </div>
          </div>
          <div style="border:1px solid rgba(15,23,42,.08);border-radius:12px;background:#fff;padding:10px;">
            <div style="font-size:12px;font-weight:800;color:#475569;">Most Common Care Needs</div>
            <div style="margin-top:6px;font-size:12px;line-height:1.45;color:#0f172a;">
              ${tagRows.length ? tagRows.map((row) => `<div>${esc(row)}</div>`).join("") : "<div>No acuity-tag data yet.</div>"}
            </div>
          </div>
        </div>
      </div>
    `;
  }
  function renderMergeSuggestion(group, allGroups) {
    const host = $("metricsMergeSuggestion");
    if (!host) return;
    if (!group) {
      host.innerHTML = "";
      return;
    }
    const dismissals = loadDismissals();
    const aliases = loadAliases();
    const candidate = (allGroups || []).find((other) => {
      if (!other || other.key === group.key || other.role !== group.role) return false;
      if (aliases[normName(other.label)] || aliases[normName(group.label)]) return false;
      if (dismissals[pairKey(group.label, other.label)]) return false;
      return likelySamePerson(group.label, other.label);
    });
    host.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        ${candidate ? `<div style="font-size:12px;color:#334155;">Possible duplicate profile: <strong>${esc(group.label)}</strong> and <strong>${esc(candidate.label)}</strong></div>` : `<div style="font-size:12px;color:#64748b;">No likely duplicate profile suggested for this staff member.</div>`}
        ${candidate ? `<button id="metricsApproveMerge" type="button">Combine</button><button id="metricsDismissMerge" type="button">Dismiss</button>` : ``}
        <button id="metricsManualMerge" type="button">Manual Combine...</button>
      </div>
    `;
    const approve = $("metricsApproveMerge");
    if (approve) approve.onclick = () => {
      const next = loadAliases();
      const canonical = chooseCanonicalName(group.label, candidate.label);
      next[normName(group.label)] = canonical;
      next[normName(candidate.label)] = canonical;
      saveAliases(next);
      window.__metricsStaffRequestedValue = `RN::${normName(canonical)}`;
      if (__last) renderAll(__last, __lastReq);
    };
    const dismiss = $("metricsDismissMerge");
    if (dismiss) dismiss.onclick = () => {
      const next = loadDismissals();
      next[pairKey(group.label, candidate.label)] = true;
      saveDismissals(next);
      window.__metricsStaffRequestedValue = group.key;
      if (__last) renderAll(__last, __lastReq);
    };
    const manual = $("metricsManualMerge");
    if (manual) manual.onclick = () => {
      const other = window.prompt(`Type the other profile name to combine with "${group.label}".`, "");
      if (!other) return;
      const match = (allGroups || []).find((g) => g && g.role === group.role && normName(g.label) === normName(other));
      if (!match) {
        setStatus(`No matching staff profile found for "${other}".`, true);
        return;
      }
      const canonical = chooseCanonicalName(group.label, match.label);
      const next = loadAliases();
      next[normName(group.label)] = canonical;
      next[normName(match.label)] = canonical;
      saveAliases(next);
      window.__metricsStaffRequestedValue = `RN::${normName(canonical)}`;
      if (__last) renderAll(__last, __lastReq);
    };
  }
  function extractTagCounts(row) {
    if (row?.tag_counts && typeof row.tag_counts === "object") return row.tag_counts;
    if (row?.metrics?.tag_counts && typeof row.metrics.tag_counts === "object") return row.metrics.tag_counts;
    return {};
  }
  function nextShiftFromSnapshot(snap) {
    const shift = normalizeShift(snap?.shift_type || "");
    if (!snap?.shift_date || (shift !== "day" && shift !== "night")) return null;
    return {
      shift_date: shift === "night" ? addDaysYmd(snap.shift_date, 1) : snap.shift_date,
      shift_type: shift === "night" ? "day" : "night",
      source_shift_date: snap.shift_date,
      source_shift_type: shift
    };
  }
  function snapshotForStaffRow(snapMap, row) {
    const direct = snapMap.get(shiftKey(row?.shift_date, row?.shift_type));
    if (direct) return direct;
    if (row?.details?.starter_only && row.details.source_shift_date && row.details.source_shift_type) {
      return snapMap.get(shiftKey(row.details.source_shift_date, row.details.source_shift_type)) || null;
    }
    return null;
  }
  function rowShiftLabel(row) {
    const shift = normalizeShift(row?.shift_type || row?.shift || "");
    return row?.details?.starter_only ? `${shift} start` : shift;
  }
  function merge(into, src) { Object.keys(src || {}).forEach((k) => { into[k] = (into[k] || 0) + num(src[k], 0); }); }
  function topTags(obj, n = 10) { return Object.entries(obj || {}).map(([k, v]) => ({ k, v: num(v, 0) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, n); }
  function avgTagsPerShift(obj, shiftCount, n = 10) {
    const denom = Math.max(1, num(shiftCount, 1));
    return Object.entries(obj || {})
      .map(([k, v]) => ({ k, v: Math.round((num(v, 0) / denom) * 10) / 10 }))
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, n);
  }
  function buildRnAverageTagTrendChart(rows, staffRows, snaps, keys) {
    const snapMap = new Map();
    (snaps || []).forEach((s) => snapMap.set(shiftKey(s.shift_date, s.shift_type), s));
    const byShift = new Map();
    (staffRows || [])
      .filter((r) => String(r.role || "").toUpperCase() === "RN" && !isFillerStaffName(r.staff_name))
      .forEach((r) => {
        const key = shiftKey(r.shift_date, r.shift_type);
        if (!byShift.has(key)) byShift.set(key, { count: 0, tags: {} });
        const rec = byShift.get(key);
        rec.count += 1;
        const snap = snapshotForStaffRow(snapMap, r);
        const pats = Array.isArray(snap?.state?.patients) ? snap.state.patients : [];
        const ids = new Set(Array.isArray(r.details?.patient_ids) ? r.details.patient_ids.map(Number) : []);
        merge(rec.tags, tagsFromPatients(pats, ids));
      });
    const list = Array.isArray(rows) ? rows : [];
    const labels = list.map(compactShiftLabel);
    return {
      title: "Average RN assignment acuity tags by shift",
      series: (keys || []).map((key, idx) => ({
        name: `RN avg ${key}`,
        color: barColor(idx + 1),
        points: list.map((row, i) => {
          const rec = byShift.get(shiftKey(row.date, row.shift));
          return { k: labels[i], v: rec?.count ? num(rec.tags?.[key], 0) / rec.count : 0 };
        })
      }))
    };
  }
  function ordinal(n) {
    const x = Math.max(1, Math.floor(num(n, 1)));
    const mod10 = x % 10, mod100 = x % 100;
    if (mod10 === 1 && mod100 !== 11) return `${x}st`;
    if (mod10 === 2 && mod100 !== 12) return `${x}nd`;
    if (mod10 === 3 && mod100 !== 13) return `${x}rd`;
    return `${x}th`;
  }

  function monthCutoff(months) { const d = new Date(); d.setMonth(d.getMonth() - months); return ymd(d); }
  function applyInterval(rows, interval) {
    const list = (rows || []).slice();
    if (interval in SHIFT_WINDOWS) {
      const n = SHIFT_WINDOWS[interval];
      return list.sort((a, b) => b.date.localeCompare(a.date) || (shiftRank(a.shift) - shiftRank(b.shift))).slice(0, n).sort((a, b) => a.date.localeCompare(b.date) || (shiftRank(a.shift) - shiftRank(b.shift)));
    }
    if (interval === "last_3_months" || interval === "last_6_months" || interval === "last_12_months") {
      const m = interval === "last_3_months" ? 3 : interval === "last_6_months" ? 6 : 12;
      const cut = monthCutoff(m); return list.filter((r) => r.date >= cut).sort((a, b) => a.date.localeCompare(b.date) || (shiftRank(a.shift) - shiftRank(b.shift)));
    }
    return list.sort((a, b) => a.date.localeCompare(b.date) || (shiftRank(a.shift) - shiftRank(b.shift)));
  }

  function staffRowsFromSnapshots(snaps, existingRows) {
    const existing = new Set(arr(existingRows).map((r) =>
      `${shiftKey(r.shift_date, r.shift_type)}|${String(r.role || "").toUpperCase()}|${normName(r.staff_name)}`
    ));
    const rows = [];

    arr(snaps).forEach((snap) => {
      const date = snap?.shift_date || "";
      const shift = normalizeShift(snap?.shift_type || "");
      const profiles = arr(snap?.state?.staff_profiles);
      profiles.forEach((profile) => {
        const role = String(profile?.role || "").toUpperCase();
        const name = String(profile?.name || profile?.staff_name || "").trim();
        if (!date || !shift || !role || !name) return;
        const key = `${shiftKey(date, shift)}|${role}|${normName(name)}`;
        if (existing.has(key)) return;
        existing.add(key);
        rows.push({
          unit_id: snap.unit_id || "",
          shift_date: date,
          shift_type: shift,
          staff_id: profile.staff_id || null,
          staff_name: name,
          role,
          patients_assigned: num(profile.patients_assigned, arr(profile?.details?.patient_ids).length),
          workload_score: num(profile.workload_score, 0),
          details: profile.details || {},
          source: "shift_snapshot"
        });
      });
    });

    return rows;
  }

  function starterPatientScore(role, p) {
    const r = String(role || "").toUpperCase();
    let score = 0;
    if (r === "PCA") {
      score += 1;
      if (p?.chg) score += 1;
      if (p?.q2turns || p?.q2Turns) score += 1;
      if (p?.isolation || p?.iso) score += 1;
      if (p?.feeder || p?.feeders) score += 1;
      return score;
    }
    score += 1;
    if (p?.drip) score += 3;
    if (p?.nih) score += 3;
    if (p?.bg) score += 3;
    if (p?.tf) score += 2;
    if (p?.ciwa) score += 3;
    if (p?.cows) score += 3;
    if (p?.psych) score += 3;
    if (p?.prns) score += 3;
    if (p?.emu) score += 3;
    if (p?.restraint) score += 3;
    if (p?.sitter) score += 3;
    if (p?.vpo) score += 3;
    if (p?.isolation) score += 1;
    if (p?.admit) score += 3;
    if (p?.lateDc) score += 1;
    if (p?.sitter && p?.restraint) score += 3;
    const behavior = !!(p?.ciwa || p?.cows || p?.ciwaCows || p?.psych || p?.prns);
    if (behavior && p?.sitter) score += 3;
    if (p?.emu && p?.sitter) score += 3;
    if (p?.drip && behavior) score += 3;
    if (p?.drip && p?.emu) score += 3;
    if (p?.drip && p?.sitter) score += 4;
    if (p?.nih && p?.bg) score += 2;
    return score;
  }

  function starterStackingBonus(role, patients) {
    const pts = arr(patients).filter((p) => p && !p.isEmpty);
    if (String(role || "").toUpperCase() === "PCA") {
      return 0;
    }
    const bg = pts.filter((p) => p.bg).length;
    const iso = pts.filter((p) => p.isolation).length;
    const drip = pts.filter((p) => p.drip).length;
    const behavior = pts.filter((p) => p.ciwa || p.cows || p.ciwaCows || p.psych || p.prns).length;
    const emu = pts.filter((p) => p.emu).length;
    const sitter = pts.filter((p) => p.sitter).length;
    const vpo = pts.filter((p) => p.vpo).length;
    let bonus = 0;
    if (bg >= 3) bonus += 4;
    if (iso >= 3) bonus += 4;
    if (drip >= 2) bonus += 6;
    if (behavior >= 1 && sitter >= 1) bonus += 4;
    if (emu >= 1 && sitter >= 1) bonus += 4;
    if (vpo >= 1 && behavior >= 1) bonus += 3;
    if (vpo >= 1 && emu >= 1) bonus += 3;
    return bonus;
  }

  function starterWorkloadScore(role, patients) {
    const pts = arr(patients).filter((p) => p && !p.isEmpty);
    return pts.reduce((sum, p) => sum + starterPatientScore(role, p), 0) + starterStackingBonus(role, pts);
  }

  function recalcStaffRowsWithCurrentScoring(rows, snaps) {
    const snapMap = new Map();
    arr(snaps).forEach((snap) => snapMap.set(shiftKey(snap.shift_date, snap.shift_type), snap));
    return arr(rows).map((row) => {
      const snap = snapshotForStaffRow(snapMap, row);
      const patients = arr(snap?.state?.patients);
      const ids = arr(row?.details?.patient_ids).map(Number).filter(Number.isFinite);
      if (!snap || !ids.length || !patients.length) return row;
      const patientById = new Map(patients.map((p) => [Number(p?.id), p]));
      const assigned = ids.map((id) => patientById.get(id)).filter((p) => p && !p.isEmpty);
      if (!assigned.length) return row;
      return {
        ...row,
        workload_score: starterWorkloadScore(row.role, assigned),
        patients_assigned: assigned.length,
        details: {
          ...(row.details || {}),
          analytics_scoring_version: "2026-07-01-current",
          recalculated_from_snapshot: true
        }
      };
    });
  }

  function starterRowsFromSnapshots(snaps, existingStaffRows, existingAnalyticsRows) {
    const existingStaff = new Set(arr(existingStaffRows).map((r) =>
      `${shiftKey(r.shift_date, r.shift_type)}|${String(r.role || "").toUpperCase()}|${normName(r.staff_name)}`
    ));
    const existingAnalytics = new Set(arr(existingAnalyticsRows).map((r) => shiftKey(r.shift_date, r.shift_type)));
    const staff = [];
    const analytics = [];

    arr(snaps).forEach((snap) => {
      const next = nextShiftFromSnapshot(snap);
      if (!next) return;
      const state = snap?.state && typeof snap.state === "object" ? snap.state : {};
      const oncoming = state.oncoming_assignment && typeof state.oncoming_assignment === "object" ? state.oncoming_assignment : {};
      const patients = arr(state.patients);
      const patientById = new Map(patients.map((p) => [Number(p?.id), p]));
      const hasOncoming = arr(oncoming.nurses).length || arr(oncoming.pcas).length;
      if (!hasOncoming) return;

      const makeStaff = (role, owners) => arr(owners).forEach((owner) => {
        const name = String(owner?.name || "").trim();
        if (!name || isFillerStaffName(name)) return;
        const roleKey = String(role || "").toUpperCase();
        const key = `${shiftKey(next.shift_date, next.shift_type)}|${roleKey}|${normName(name)}`;
        if (existingStaff.has(key)) return;
        existingStaff.add(key);
        const ids = arr(owner?.patients).map(Number).filter(Number.isFinite);
        const assigned = ids.map((id) => patientById.get(Number(id))).filter((p) => p && !p.isEmpty);
        staff.push({
          unit_id: snap.unit_id || "",
          shift_date: next.shift_date,
          shift_type: next.shift_type,
          staff_id: owner?.staff_id || owner?.staffId || null,
          staff_name: name,
          role: roleKey,
          patients_assigned: assigned.length,
          workload_score: starterWorkloadScore(roleKey, assigned),
          details: {
            patient_ids: ids,
            patient_rooms: assigned.map((p) => String(p.room || p.id || "")).filter(Boolean),
            expected_discharges: assigned.filter((p) => !!p.expectedDischarge).length,
            admits: 0,
            discharges: 0,
            acuity_changes: 0,
            assignment_changes: 0,
            event_count: 0,
            starter_only: true,
            projected_full_shift: true,
            starter_source: "analytics_snapshot_fallback",
            source_shift_date: next.source_shift_date,
            source_shift_type: next.source_shift_type,
            shift_snapshot_id: snap.id || null
          },
          source: "shift_snapshot_starter"
        });
      });

      makeStaff("RN", oncoming.nurses);
      makeStaff("PCA", oncoming.pcas);

      if (!existingAnalytics.has(shiftKey(next.shift_date, next.shift_type))) {
        existingAnalytics.add(shiftKey(next.shift_date, next.shift_type));
        analytics.push({
          date: next.shift_date,
          shift: next.shift_type,
          totalPts: num(state.total_pts, patients.filter((p) => p && !p.isEmpty).length),
          admits: 0,
          discharges: 0,
          tagsObj: tagsFromPatients(patients),
          starterOnly: true,
          source_shift_date: next.source_shift_date,
          source_shift_type: next.source_shift_type
        });
      }
    });

    return { staff, analytics };
  }

  function workloadBucket(score, role) {
    const s = num(score, 0), rn = String(role || "").toUpperCase() === "RN";
    if (s <= (rn ? 10 : 14)) return "Low";
    if (s <= (rn ? 16 : 22)) return "Moderate";
    if (s <= (rn ? 26 : 32)) return "High";
    return "Very High";
  }

  function setStaffOptions(rows) {
    const sel = $("metricsStaffSelect"); if (!sel) return;
    const requested = String(window.__metricsStaffRequestedValue || "");
    const prev = requested || sel.value; const map = new Map();
    const aliases = loadAliases();
    const hidden = loadHiddenProfiles();
    rows.forEach((r) => {
      if (String(r.role).toUpperCase() !== "RN") return;
      if (isFillerStaffName(r.staff_name) || isHiddenStaffName(r.staff_name, hidden)) return;
      const label = canonicalStaffName(r.staff_name || "Unknown Staff", aliases);
      const key = `RN::${normName(label)}`;
      if (!map.has(key)) map.set(key, label);
    });
    let html = `<option value="">Select staff</option>`;
    Array.from(map.entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1]))).forEach(([k, label]) => { html += `<option value="${esc(k)}">${esc(label)}</option>`; });
    sel.innerHTML = html;
    if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
    if (!sel.value && sel.options.length > 1) sel.selectedIndex = 1;
    window.__metricsStaffRequestedValue = sel.value || "";
    const current = $("metricsStaffCurrent");
    if (current) current.textContent = sel.value ? sel.options[sel.selectedIndex]?.textContent || "Select staff" : "Select staff";
    const prevBtn = $("metricsStaffPrev");
    const nextBtn = $("metricsStaffNext");
    if (prevBtn) prevBtn.disabled = !sel.value || sel.selectedIndex <= 1;
    if (nextBtn) nextBtn.disabled = !sel.value || sel.selectedIndex >= sel.options.length - 1;
  }

  function renderUnit(rows, snaps, events, depth, staffRows) {
    renderFocusedStaffReport(null);
    renderMergeSuggestion(null, []);
    const pruneHost = $("metricsPrunePanel");
    if (pruneHost) pruneHost.innerHTML = "";
    const pruneBtn = $("btnMetricsPrune");
    if (pruneBtn) pruneBtn.style.display = "none";
    const n = rows.length;
    const avgPts = n ? rows.reduce((s, r) => s + num(r.totalPts, 0), 0) / n : 0;
    const avgA = n ? rows.reduce((s, r) => s + num(r.admits, 0), 0) / n : 0;
    const avgD = n ? rows.reduce((s, r) => s + num(r.discharges, 0), 0) / n : 0;
    const tags = {};
    rows.forEach((r) => merge(tags, r.tagsObj || {}));
    const top = topTags(tags, 10);
    const avgTagTiles = avgTagsPerShift(tags, n, 10);

    renderSummaryTiles([
      { k: "Shifts Reviewed", v: n, sub: "All matching shifts" },
      { k: "Average Census", v: avgPts.toFixed(1), sub: "All shifts measured" },
      { k: "Average Admits", v: avgA.toFixed(1), sub: "Per shift" },
      { k: "Average Discharges", v: avgD.toFixed(1), sub: "Per shift" },
      { k: "Top Acuity", v: top[0]?.k || "-", sub: top[0] ? `${top[0].v} observations` : "No tags" }
    ], "No unit metrics are available in this time range.");
    $("metricsNarrativeQuick").textContent = n ? "Unit analytics are shown as all matching shifts by default. Use the compact query bar for date, shift, and interval filters." : "No unit metrics are available in this time range.";
    $("metricsNarrativeFull").innerHTML = "";

    const flowStats = (label, subset) => {
      const count = subset.length;
      return [
        { k: `${label} Census`, v: count ? subset.reduce((sum, r) => sum + num(r.totalPts, 0), 0) / count : 0, label: count ? (subset.reduce((sum, r) => sum + num(r.totalPts, 0), 0) / count).toFixed(1) : "0.0", sub: `${count} shifts`, keepZero: true },
        { k: `${label} Admits`, v: count ? subset.reduce((sum, r) => sum + num(r.admits, 0), 0) / count : 0, label: count ? (subset.reduce((sum, r) => sum + num(r.admits, 0), 0) / count).toFixed(1) : "0.0", sub: "Per shift", keepZero: true },
        { k: `${label} DCs`, v: count ? subset.reduce((sum, r) => sum + num(r.discharges, 0), 0) / count : 0, label: count ? (subset.reduce((sum, r) => sum + num(r.discharges, 0), 0) / count).toFixed(1) : "0.0", sub: "Per shift", keepZero: true }
      ];
    };
    const dayRows = rows.filter((r) => normalizeShift(r.shift) === "day");
    const nightRows = rows.filter((r) => normalizeShift(r.shift) === "night");

    const snapMap = new Map();
    (snaps || []).forEach((s) => snapMap.set(shiftKey(s.shift_date, s.shift_type), s));
    const hidden = loadHiddenProfiles();
    const rnRows = (staffRows || []).filter((r) => String(r.role || "").toUpperCase() === "RN" && !isFillerStaffName(r.staff_name) && !isHiddenStaffName(r.staff_name, hidden));
    const rnTagTotals = {};
    rnRows.forEach((r) => {
      const s = snapshotForStaffRow(snapMap, r);
      const pats = Array.isArray(s?.state?.patients) ? s.state.patients : [];
      const ids = new Set(Array.isArray(r.details?.patient_ids) ? r.details.patient_ids.map(Number) : []);
      merge(rnTagTotals, tagsFromPatients(pats, ids));
    });
    const avgRnTagTiles = avgTagsPerShift(rnTagTotals, rnRows.length, 10);

    setQuad(1, "Unit Summary", "metrics", [
      { k: "All Shifts", v: n, sub: "Current filter" },
      { k: "Day Shifts", v: dayRows.length, sub: "Measured" },
      { k: "Night Shifts", v: nightRows.length, sub: "Measured" },
      { k: "Acuity Obs", v: Object.values(tags).reduce((s, v) => s + num(v, 0), 0), sub: "Total tag count" }
    ], n ? "Top-level unit summary for the selected interval." : "No shift data.", "No summary data.");
    setQuad(2, "Average Unit Flow", "bars", [
      ...flowStats("All", rows),
      ...flowStats("Day", dayRows),
      ...flowStats("Night", nightRows)
    ], n ? "Average census, admits, and discharges by shift category." : "No shift data.", "No flow data.");
    const trendTags = selectedTrendTags(top);
    setQuad(3, "Acuity Tags Over Time", "lines", buildTagTrendChart(rows, trendTags, "Acuity tag trends by shift"), n ? `${n} shifts. Hover points for shift/date values.` : "No shift data.", "No tag trend data.");
    renderTrendSelector("metricsQuad3Meta", top);
    setQuad(4, "Average Workload Over Time", "splitLines", buildAverageWorkloadTrendCharts(rows, staffRows), "RN and PCA workload trends are shown separately because the scoring scales are different.", "No workload trend data.");
    renderAnalyticsReportIndex(rows, snaps, staffRows, events);

    let table = `<div style="overflow:auto;"><table style="width:100%;min-width:760px;border-collapse:separate;border-spacing:0;"><thead><tr style="font-size:12px;opacity:.75;text-align:left;"><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Date</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Shift</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Pts</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Admits</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Discharges</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Top tags</th></tr></thead><tbody>`;
    rows.forEach((r) => { table += `<tr style="font-size:13px;"><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.date)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.starterOnly ? `${r.shift} start` : r.shift)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.totalPts, 0)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.admits, 0)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.discharges, 0)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(topTags(r.tagsObj || {},3).map((x) => `${x.k}:${x.v}`).join(", ") || "-")}</td></tr>`; });
    table += `</tbody></table></div>`;
    if ($("pulseTable")) $("pulseTable").innerHTML = table;
  }

  function renderStaff(rows, snaps, depth, compare) {
    const sel = String($("metricsStaffSelect")?.value || "");
    const [roleKey, canonicalNorm] = sel.split("::");
    const aliases = loadAliases();
    const hidden = loadHiddenProfiles();
    const mine = rows.filter((r) => String(r.role).toUpperCase() === "RN" && !isFillerStaffName(r.staff_name) && !isHiddenStaffName(r.staff_name, hidden) && (!roleKey || roleKey === "RN") && normName(canonicalStaffName(r.staff_name || "", aliases)) === String(canonicalNorm || ""));
    const peers = rows.filter((r) => String(r.role).toUpperCase() === "RN" && !isFillerStaffName(r.staff_name) && !isHiddenStaffName(r.staff_name, hidden));
    const groupOptions = Array.from(($("metricsStaffSelect")?.options || [])).slice(1).map((opt) => ({ key: opt.value, role: "RN", label: opt.textContent || "" }));
    const currentGroup = groupOptions.find((g) => g.key === sel) || null;
    const n = mine.length;
    const avgL = n ? mine.reduce((s, r) => s + num(r.workload_score, 0), 0) / n : 0;
    const avgP = n ? mine.reduce((s, r) => s + num(r.patients_assigned, 0), 0) / n : 0;
    const peerL = peers.length ? peers.reduce((s, r) => s + num(r.workload_score, 0), 0) / peers.length : 0;
    const peerP = peers.length ? peers.reduce((s, r) => s + num(r.patients_assigned, 0), 0) / peers.length : 0;
    const snapMap = new Map(); snaps.forEach((s) => snapMap.set(shiftKey(s.shift_date, s.shift_type), s));
    const tagTotals = {};
    mine.forEach((r) => {
      const s = snapshotForStaffRow(snapMap, r); if (!s) return;
      const pats = Array.isArray(s.state?.patients) ? s.state.patients : [];
      const ids = new Set(Array.isArray(r.details?.patient_ids) ? r.details.patient_ids.map(Number) : []);
      merge(tagTotals, tagsFromPatients(pats, ids));
    });
    const top = topTags(tagTotals, 10);
    const totalTagBurden = Object.values(tagTotals).reduce((sum, v) => sum + num(v, 0), 0);
    const avgTagBurden = n ? totalTagBurden / n : 0;
    const avgTagTiles = avgTagsPerShift(tagTotals, n, 10);
    const mineSorted = mine.slice().sort((a, b) =>
      String(a.shift_date || "").localeCompare(String(b.shift_date || "")) ||
      (shiftRank(a.shift_type) - shiftRank(b.shift_type))
    );
    const firstShift = mineSorted[0] || null;
    const lastShift = mineSorted[mineSorted.length - 1] || null;
    const startWorkload = firstShift ? num(firstShift.workload_score, 0) : 0;
    const endWorkload = lastShift ? num(lastShift.workload_score, 0) : 0;
    const workloadDelta = endWorkload - startWorkload;
    const patientCounts = mine.map((r) => num(r.patients_assigned, 0));
    const maxPatients = patientCounts.length ? Math.max(...patientCounts) : 0;
    const minPatients = patientCounts.length ? Math.min(...patientCounts) : 0;

    const peerExposureMap = new Map();
    peers.forEach((r) => {
      const key = `RN::${normName(canonicalStaffName(r.staff_name || "", aliases))}`;
      if (!peerExposureMap.has(key)) peerExposureMap.set(key, { total: 0, shifts: 0, tags: {} });
      const rec = peerExposureMap.get(key);
      rec.shifts += 1;
      const s = snapshotForStaffRow(snapMap, r);
      if (!s) return;
      const pats = Array.isArray(s.state?.patients) ? s.state.patients : [];
      const ids = new Set(Array.isArray(r.details?.patient_ids) ? r.details.patient_ids.map(Number) : []);
      const localTags = tagsFromPatients(pats, ids);
      Object.keys(localTags).forEach((k) => {
        rec.tags[k] = (rec.tags[k] || 0) + num(localTags[k], 0);
        rec.total += num(localTags[k], 0);
      });
    });

    const peerRankings = Array.from(peerExposureMap.entries())
      .map(([key, rec]) => ({
        key,
        total: rec.total,
        avg: rec.shifts ? rec.total / rec.shifts : 0
      }))
      .sort((a, b) => b.total - a.total || b.avg - a.avg || a.key.localeCompare(b.key));
    const selectedPeerKey = sel;
    const totalRank = Math.max(1, peerRankings.findIndex((x) => x.key === selectedPeerKey) + 1 || 1);
    const avgRank = Math.max(1, peerRankings.slice().sort((a, b) => b.avg - a.avg || b.total - a.total || a.key.localeCompare(b.key)).findIndex((x) => x.key === selectedPeerKey) + 1 || 1);
    const unitByShift = new Map();
    peers.forEach((r) => {
      const key = shiftKey(r.shift_date, r.shift_type);
      if (!unitByShift.has(key)) unitByShift.set(key, { load: 0, patients: 0, count: 0 });
      const rec = unitByShift.get(key);
      rec.load += num(r.workload_score, 0);
      rec.patients += num(r.patients_assigned, 0);
      rec.count += 1;
    });
    const comparisonLabel = (r) => `${r.shift_date}|${normalizeShift(r.shift_type).toUpperCase()}`;
    const staffLoadPoints = mineSorted.map((r) => ({ k: comparisonLabel(r), v: num(r.workload_score, 0) }));
    const unitLoadPoints = mineSorted.map((r) => {
      const rec = unitByShift.get(shiftKey(r.shift_date, r.shift_type));
      return { k: comparisonLabel(r), v: rec?.count ? rec.load / rec.count : 0 };
    });
    const staffPatientPoints = mineSorted.map((r) => ({ k: comparisonLabel(r), v: num(r.patients_assigned, 0) }));
    const unitPatientPoints = mineSorted.map((r) => {
      const rec = unitByShift.get(shiftKey(r.shift_date, r.shift_type));
      return { k: comparisonLabel(r), v: rec?.count ? rec.patients / rec.count : 0 };
    });

    renderPrunePanel(rows);
    renderSummaryTiles([
      { k: "Worked Shifts", v: n, sub: "Only shifts this person worked" },
      { k: "Avg Patients", v: avgP.toFixed(1), sub: "Per worked shift" },
      { k: "Avg Load Score", v: avgL.toFixed(1), sub: "Per worked shift" },
      { k: "Avg Acuity Tags", v: avgTagBurden.toFixed(1), sub: `Ranks ${ordinal(avgRank)} among RN peers` }
    ], "No worked shifts were found for this staff member in the selected range.");
    $("metricsNarrativeQuick").textContent = n ? `${currentGroup?.label || "Selected nurse"} has most often been caring for patients with ${top.slice(0,3).map((x) => x.k).join(", ") || "routine needs"}. This staff profile only uses shifts where this person was actually on and working, so days they were off do not count against their averages.${compare ? ` Compared with peers, this staff member ranks ${ordinal(totalRank)} for total higher-acuity exposure.` : ""}` : "No worked shifts were found for this staff member in the selected range.";
    $("metricsNarrativeFull").innerHTML = "";
    renderFocusedStaffReport(null);
    renderMergeSuggestion(currentGroup, groupOptions);
    setQuad(1, "Average Shift", "metrics", [
      { k: "Patients", v: avgP.toFixed(1), sub: "Average per worked shift" },
      { k: "Load Score", v: avgL.toFixed(1), sub: "Average per worked shift" },
      { k: "Acuity Tags", v: avgTagBurden.toFixed(1), sub: "Average per worked shift" }
    ], n ? `${n} worked shift${n === 1 ? "" : "s"} reviewed.` : "No worked shifts.", "No worked shifts.");
    setQuad(2, "Workload vs Unit Average", "lines", {
      title: "Selected staff workload compared with unit RN average",
      series: [
        { name: currentGroup?.label || "Selected staff", color: "#2563eb", points: staffLoadPoints },
        { name: "Unit RN average", color: "#059669", points: unitLoadPoints }
      ]
    }, `Start ${startWorkload.toFixed(1)}, end ${endWorkload.toFixed(1)}, change ${workloadDelta > 0 ? "+" : ""}${workloadDelta.toFixed(1)}.`, "No trend data.");
    setQuad(3, "Average Acuity Tags Per Worked Shift", "bars", (avgTagTiles.length ? avgTagTiles : top.slice(0, 10)).map((x) => ({ k: x.k, v: x.v, label: num(x.v, 0).toFixed(1) })), compare ? `Rank: ${ordinal(totalRank)} total exposure and ${ordinal(avgRank)} average exposure.` : "Average historical acuity tags per worked shift.", "No acuity-tag data.");
    setQuad(4, "Patients vs Unit Average", "lines", {
      title: "Selected staff patient count compared with unit RN average",
      series: [
        { name: currentGroup?.label || "Selected staff", color: "#7c3aed", points: staffPatientPoints },
        { name: "Unit RN average", color: "#d97706", points: unitPatientPoints }
      ]
    }, compare ? `Average load rank ${ordinal(avgRank)} among visible RN peers.` : "Peer comparison is off.", "No peer comparison data.");

    let table = `<div style="overflow:auto;"><table style="width:100%;min-width:920px;border-collapse:separate;border-spacing:0;"><thead><tr style="font-size:12px;opacity:.75;text-align:left;"><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Date</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Shift</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Staff</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Patients</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Workload</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Top tag exposure</th></tr></thead><tbody>`;
    mine.forEach((r) => {
      const s = snapshotForStaffRow(snapMap, r);
      const pats = Array.isArray(s?.state?.patients) ? s.state.patients : [];
      const ids = new Set(Array.isArray(r.details?.patient_ids) ? r.details.patient_ids.map(Number) : []);
      const rowTags = topTags(tagsFromPatients(pats, ids), 3).map((x) => `${x.k}:${x.v}`).join(", ") || "-";
      table += `<tr style="font-size:13px;"><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.shift_date)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(rowShiftLabel(r))}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.staff_name)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.patients_assigned, 0)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.workload_score, 0).toFixed(1)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(rowTags)}</td></tr>`;
    });
    table += `</tbody></table></div>`;
    if ($("pulseTableDetailsSlot")) $("pulseTableDetailsSlot").innerHTML = table;
    if ($("pulseTable")) $("pulseTable").innerHTML = table;
  }

  function renderAll(data, reqId) {
    if (reqId !== __req) return;
    ensureShell();
    const interval = String($("metricsInterval")?.value || "all_time");
    const view = "unit";
    const depth = String($("metricsReportDepth")?.value || "quick");
    const compare = true;
    const shift = normalizeShift($("pulseShiftType")?.value || "");
    const shiftFilter = (shift === "day" || shift === "night") ? shift : "";
    const fromDate = String($("pulseFrom")?.value || "");
    const toDate = String($("pulseTo")?.value || "");
    const inDateRange = (date) => {
      const d = String(date || "");
      return !!d && (!fromDate || d >= fromDate) && (!toDate || d <= toDate);
    };
    const shiftMatches = (shiftType) => !shiftFilter || normalizeShift(shiftType) === shiftFilter;

    const allSnapshots = data.snapshots.filter((s) => s && s.shift_date);
    const starterFallback = starterRowsFromSnapshots(allSnapshots, data.staff, data.analytics);
    const analytics = data.analytics
      .map((r) => ({ shift_date: r.shift_date || r.date || "", shift_type: normalizeShift(r.shift_type || r.shift || ""), totalPts: num(r.total_pts ?? r.metrics?.totals?.total_pts, 0), admits: num(r.admits ?? r.metrics?.totals?.admits, 0), discharges: num(r.discharges ?? r.metrics?.totals?.discharges, 0), tagsObj: extractTagCounts(r), starterOnly: !!r.metrics?.starter_only, raw: r }))
      .filter((r) => inDateRange(r.shift_date) && shiftMatches(r.shift_type));
    const fallbackAnalytics = starterFallback.analytics
      .filter((r) => inDateRange(r.date) && shiftMatches(r.shift));
    const snapshots = allSnapshots.filter((s) => inDateRange(s.shift_date) && shiftMatches(s.shift_type));
    const staffBase = data.staff.filter((r) => inDateRange(r.shift_date) && shiftMatches(r.shift_type));
    const fallbackStaff = starterFallback.staff
      .filter((r) => inDateRange(r.shift_date) && shiftMatches(r.shift_type));
    const staff = staffBase.concat(staffRowsFromSnapshots(snapshots, staffBase)).concat(fallbackStaff);

    const rowsCombined = [];
    const by = new Map();
    analytics.forEach((a) => by.set(shiftKey(a.shift_date, a.shift_type), { date: a.shift_date, shift: a.shift_type, totalPts: a.totalPts, admits: a.admits, discharges: a.discharges, tagsObj: a.tagsObj, starterOnly: a.starterOnly }));
    fallbackAnalytics.forEach((a) => {
      const key = shiftKey(a.date, a.shift);
      if (!by.has(key)) by.set(key, a);
    });
    snapshots.forEach((s) => {
      const k = shiftKey(s.shift_date, s.shift_type);
      const pats = Array.isArray(s.state?.patients) ? s.state.patients : [];
      const snapshotTags = tagsFromPatients(pats);
      const snapshotPts = num(s.state?.total_pts, pats.filter((p) => p && !p.isEmpty).length);
      const snapshotAdmits = num(s.state?.admits, 0);
      const snapshotDischarges = num(s.state?.discharges, 0);
      if (!by.has(k)) {
        by.set(k, { date: s.shift_date, shift: s.shift_type, totalPts: snapshotPts, admits: snapshotAdmits, discharges: snapshotDischarges, tagsObj: snapshotTags });
        return;
      }
      const existing = by.get(k) || {};
      if (!existing.tagsObj || !Object.keys(existing.tagsObj).length) existing.tagsObj = snapshotTags;
      if (!num(existing.totalPts, 0) && snapshotPts) existing.totalPts = snapshotPts;
      if (!num(existing.admits, 0) && snapshotAdmits) existing.admits = snapshotAdmits;
      if (!num(existing.discharges, 0) && snapshotDischarges) existing.discharges = snapshotDischarges;
      by.set(k, existing);
    });
    by.forEach((v) => rowsCombined.push(v));
    const rowsWindow = applyInterval(rowsCombined, interval);
    const activeKeys = new Set(rowsWindow.map((r) => shiftKey(r.date, r.shift)));
    const selectedShifts = rowsWindow.map((r) => ({ date: r.date, shift: normalizeShift(r.shift) }));
    const minDate = rowsWindow[0]?.date || "0000-00-00", maxDate = rowsWindow[rowsWindow.length - 1]?.date || "9999-99-99";
    const eventsWin = data.events.filter((e) => {
      const parts = eventLocalParts(e);
      if (!parts.date) return false;
      if (selectedShifts.length) {
        return selectedShifts.some((row) => {
          if (row.shift === "day") return parts.date === row.date && parts.hour >= 7 && parts.hour < 19;
          if (row.shift === "night") {
            return (parts.date === row.date && parts.hour >= 19) ||
              (parts.date === addDaysYmd(row.date, 1) && parts.hour < 7);
          }
          return parts.date === row.date;
        });
      }
      if (parts.date < minDate || parts.date > maxDate) return false;
      if (!shiftFilter) return true;
      return shiftFilter === "day" ? (parts.hour >= 7 && parts.hour < 19) : (parts.hour < 7 || parts.hour >= 19);
    });
    const staffWindowRaw = staff
      .map((r) => ({ ...r, date: r.shift_date, shift: normalizeShift(r.shift_type) }))
      .filter((r) => !activeKeys.size || activeKeys.has(shiftKey(r.date, r.shift)))
      .map((r) => r.raw || r);
    const staffWindow = recalcStaffRowsWithCurrentScoring(staffWindowRaw, allSnapshots);
    const sourceKeys = new Set();
    staffWindow.forEach((r) => {
      if (r?.details?.starter_only && r.details.source_shift_date && r.details.source_shift_type) {
        sourceKeys.add(shiftKey(r.details.source_shift_date, r.details.source_shift_type));
      }
    });
    const snapshotsWindow = activeKeys.size
      ? allSnapshots.filter((s) => activeKeys.has(shiftKey(s.shift_date, s.shift_type)) || sourceKeys.has(shiftKey(s.shift_date, s.shift_type)))
      : allSnapshots;
    setStaffOptions(staffWindow);
    if ($("metricsStaffSelect")) $("metricsStaffSelect").disabled = true;

    renderUnit(rowsWindow, snapshotsWindow, eventsWin, depth, staffWindow);
    setStatus(`Loaded filtered shifts:${rowsWindow.length}, staff rows:${staffWindow.length}, snapshots:${snapshotsWindow.length}. Source totals analytics:${data.analytics.length}, staff:${data.staff.length}.`);
  }

  async function loadUnitMetrics() {
    const reqId = ++__req;
    ensureControls(); ensureShell();
    if (!activeUnitId()) { setStatus("No active unit selected.", true); return; }
    if (!sbReady()) { setStatus("Offline/demo mode - Supabase not ready.", true); return; }
    const uid = activeUnitId();
    setStatus("Loading metrics data...");
    try {
      const [a, s, st, e] = await Promise.all([
        window.sb.client.from("analytics_shift_metrics").select("*").eq("unit_id", uid).order("shift_date", { ascending: false }).limit(5000),
        window.sb.client.from("shift_snapshots").select("*").eq("unit_id", uid).order("shift_date", { ascending: false }).limit(5000),
        window.sb.client.from("staff_shift_metrics").select("*").eq("unit_id", uid).order("shift_date", { ascending: false }).limit(8000),
        window.sb.client.from("audit_events").select("created_at,ts,event_type,payload,unit_id").eq("unit_id", uid).order("created_at", { ascending: true }).limit(15000)
      ]);
      if (reqId !== __req) return;
      const data = { analytics: Array.isArray(a.data) ? a.data : [], snapshots: Array.isArray(s.data) ? s.data : [], staff: Array.isArray(st.data) ? st.data : [], events: Array.isArray(e.data) ? e.data : [] };
      __last = data; __lastReq = reqId; renderAll(data, reqId);
    } catch (err) {
      if (reqId !== __req) return;
      setStatus(`Error loading metrics (${String(err)}).`, true);
    }
  }

  async function runBackfill() {
    if (!window.shiftBackfill || typeof window.shiftBackfill.backfillUnitShiftMetrics !== "function") {
      setStatus("Backfill route is not loaded.", true);
      return;
    }
    if (!activeUnitId()) {
      setStatus("No active unit selected.", true);
      return;
    }

    const btn = $("btnBackfillMetrics");
    try {
      if (btn) btn.disabled = true;
      setStatus("Backfilling stored metrics...");
      const res = await window.shiftBackfill.backfillUnitShiftMetrics(activeUnitId());
      const warningCount = Array.isArray(res?.warnings) ? res.warnings.length : 0;
      setStatus(`Backfill complete: ${num(res?.shifts_processed, 0)} shifts, ${num(res?.staff_upserts, 0)} staff rows${warningCount ? `, ${warningCount} analytics schema warning(s)` : ""}.`);
      await loadUnitMetrics();
    } catch (err) {
      setStatus(`Backfill error (${String(err?.message || err)}).`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function wire() {
    const btn = $("btnLoadPulse");
    if (btn && !btn.__metricsWired) { btn.addEventListener("click", () => loadUnitMetrics()); btn.__metricsWired = true; }
    const backfillBtn = $("btnBackfillMetrics");
    if (backfillBtn && !backfillBtn.__metricsWired) { backfillBtn.addEventListener("click", () => runBackfill()); backfillBtn.__metricsWired = true; }
    const pruneBtn = $("btnMetricsPrune");
    if (pruneBtn && !pruneBtn.__metricsWired) {
      pruneBtn.addEventListener("click", () => {
        window.__metricsPruneOpen = !window.__metricsPruneOpen;
        if (__last) renderAll(__last, __lastReq);
      });
      pruneBtn.__metricsWired = true;
    }
    const prevBtn = $("metricsStaffPrev");
    const nextBtn = $("metricsStaffNext");
    const sel = $("metricsStaffSelect");
    if (prevBtn && sel && !prevBtn.__metricsWired) {
      prevBtn.addEventListener("click", () => {
        if (sel.selectedIndex > 1) sel.selectedIndex -= 1;
        window.__metricsStaffRequestedValue = sel.value || "";
        if (__last) renderAll(__last, __lastReq); else loadUnitMetrics();
      });
      prevBtn.__metricsWired = true;
    }
    if (nextBtn && sel && !nextBtn.__metricsWired) {
      nextBtn.addEventListener("click", () => {
        if (sel.selectedIndex < sel.options.length - 1) sel.selectedIndex += 1;
        window.__metricsStaffRequestedValue = sel.value || "";
        if (__last) renderAll(__last, __lastReq); else loadUnitMetrics();
      });
      nextBtn.__metricsWired = true;
    }
    ["pulseShiftType","metricsViewMode","metricsInterval","metricsStaffSelect","metricsReportDepth"].forEach((id) => {
      const n = $(id); if (!n || n.__metricsWired) return;
      n.addEventListener("change", () => {
        if (id === "metricsStaffSelect") window.__metricsStaffRequestedValue = n.value || "";
        if (__last) renderAll(__last, __lastReq); else loadUnitMetrics();
      });
      n.__metricsWired = true;
    });
    window.unitMetrics = window.unitMetrics || {};
    window.unitMetrics.load = loadUnitMetrics;
    window.unitPulse = window.unitPulse || {};
    window.unitPulse.load = loadUnitMetrics;
  }

  window.addEventListener("DOMContentLoaded", () => {
    if ($("pulseTo") && !$("pulseTo").value) $("pulseTo").value = "";
    if ($("pulseFrom") && !$("pulseFrom").value) $("pulseFrom").value = "";
    if ($("pulseShiftType") && !$("pulseShiftType").value) $("pulseShiftType").value = "";
    if ($("metricsInterval")) $("metricsInterval").value = "all_time";
    ensureControls();
    ensureShell();
    wire();
    setStatus("Choose Unit/Staff view and click Load Metrics.");
  });
})();
