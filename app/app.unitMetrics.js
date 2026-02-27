// app/app.unitMetrics.js
// Unit + Staff longitudinal metrics with interval presets and narrative reports.
(function () {
  if (window.__unitMetricsSingletonLoaded) return;
  window.__unitMetricsSingletonLoaded = true;

  const $ = (id) => document.getElementById(id);
  const ACUITY_KEYS = ["tele","drip","nih","bg","ciwa","restraint","sitter","vpo","isolation","admit","lateDc"];
  const SHIFT_WINDOWS = { last_3_shifts: 3, last_6_shifts: 6, last_12_shifts: 12 };
  let __req = 0;
  let __last = null;
  let __lastReq = 0;

  const num = (x, d = 0) => Number.isFinite(Number(x)) ? Number(x) : d;
  const esc = (v) => String(v || "").replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
  const ymd = (d) => new Date(d).toISOString().slice(0, 10);
  const activeUnitId = () => (window.activeUnitId ? String(window.activeUnitId) : "");
  const sbReady = () => !!(window.sb && window.sb.client && typeof window.sb.client.from === "function");
  const shiftRank = (s) => (String(s).toLowerCase() === "day" ? 1 : 2);
  const shiftKey = (date, shift) => `${date}|${String(shift || "").toLowerCase()}`;

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
    wrap.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;width:100%;margin-top:8px;";
    wrap.innerHTML = `
      <label><strong>View:</strong></label>
      <select id="metricsViewMode"><option value="unit">Unit</option><option value="staff">Staff</option></select>
      <label><strong>Interval:</strong></label>
      <select id="metricsInterval">
        <option value="last_3_shifts">Last 3 shifts</option>
        <option value="last_6_shifts">Last 6 shifts</option>
        <option value="last_12_shifts" selected>Last 12 shifts</option>
        <option value="last_3_months">Last 3 months</option>
        <option value="last_6_months">Last 6 months</option>
        <option value="last_12_months">Last 12 months</option>
        <option value="all_time">All-Time</option>
      </select>
      <label><strong>Staff:</strong></label>
      <select id="metricsStaffSelect" disabled style="min-width:180px;"><option value="">Select staff</option></select>
      <label><strong>Report:</strong></label>
      <select id="metricsReportDepth"><option value="quick">Quick paragraph</option><option value="extensive">Extensive report</option></select>
      <label style="display:flex;align-items:center;gap:6px;"><input id="metricsCompareToggle" type="checkbox" checked />Compare to unit avg</label>
    `;
    host.appendChild(wrap);
  }

  function ensureShell() {
    const root = $("pulseSummary");
    if (!root) return;
    if ($("pulseChartPatients") && $("pulseChartFlow") && $("pulseChartTags") && $("pulseChartShiftTime")) return;
    root.innerHTML = `
      <div class="staff-card">
        <div class="staff-card-header">Insights Summary</div>
        <div id="pulseSummaryMetrics" style="font-size:13px;line-height:1.45;"></div>
        <div id="metricsNarrativeQuick" style="margin-top:8px;font-size:13px;line-height:1.5;"></div>
        <div id="metricsNarrativeFull" style="margin-top:8px;font-size:12px;line-height:1.5;opacity:.9;"></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;">
        <div class="staff-card" style="flex:1;min-width:320px;"><div class="staff-card-header">Trend A</div><canvas id="pulseChartPatients" height="150"></canvas><div id="pulseChartPatientsMeta" style="font-size:12px;opacity:.75;"></div></div>
        <div class="staff-card" style="flex:1;min-width:320px;"><div class="staff-card-header">Trend B</div><canvas id="pulseChartFlow" height="150"></canvas><div id="pulseChartFlowMeta" style="font-size:12px;opacity:.75;"></div></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;">
        <div class="staff-card" style="flex:1;min-width:320px;"><div class="staff-card-header">Acuity Tags</div><canvas id="pulseChartTags" height="170"></canvas><div id="pulseChartTagsMeta" style="font-size:12px;opacity:.75;"></div></div>
        <div class="staff-card" style="flex:1;min-width:320px;"><div class="staff-card-header">Shift-Time Burden</div><canvas id="pulseChartShiftTime" height="170"></canvas><div id="pulseChartShiftTimeMeta" style="font-size:12px;opacity:.75;"></div></div>
      </div>
      <details class="staff-card" style="margin-top:12px;"><summary style="cursor:pointer;font-weight:700;padding:10px 12px;">Show table details</summary><div id="pulseTableDetailsSlot" style="padding:10px 12px;"></div></details>
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
  function merge(into, src) { Object.keys(src || {}).forEach((k) => { into[k] = (into[k] || 0) + num(src[k], 0); }); }
  function topTags(obj, n = 10) { return Object.entries(obj || {}).map(([k, v]) => ({ k, v: num(v, 0) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, n); }

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

  function workloadBucket(score, role) {
    const s = num(score, 0), rn = String(role || "").toUpperCase() === "RN";
    if (s <= (rn ? 10 : 14)) return "Low";
    if (s <= (rn ? 16 : 22)) return "Moderate";
    if (s <= (rn ? 26 : 32)) return "High";
    return "Very High";
  }

  function setStaffOptions(rows) {
    const sel = $("metricsStaffSelect"); if (!sel) return;
    const prev = sel.value; const map = new Map();
    rows.forEach((r) => { if (String(r.role).toUpperCase() !== "RN") return; const key = `${r.staff_id || ""}::${r.staff_name || "Unknown Staff"}`; if (!map.has(key)) map.set(key, r.staff_name || "Unknown Staff"); });
    let html = `<option value="">Select staff</option>`;
    Array.from(map.entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1]))).forEach(([k, label]) => { html += `<option value="${esc(k)}">${esc(label)}</option>`; });
    sel.innerHTML = html;
    if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
    if (!sel.value && sel.options.length > 1) sel.selectedIndex = 1;
  }

  function renderUnit(rows, snaps, events, depth) {
    const n = rows.length;
    const avgPts = n ? rows.reduce((s, r) => s + num(r.totalPts, 0), 0) / n : 0;
    const avgA = n ? rows.reduce((s, r) => s + num(r.admits, 0), 0) / n : 0;
    const avgD = n ? rows.reduce((s, r) => s + num(r.discharges, 0), 0) / n : 0;
    const tags = {}; rows.forEach((r) => merge(tags, r.tagsObj || {})); const top = topTags(tags, 10);
    const hi = rows.slice().sort((a, b) => num(b.totalPts, 0) - num(a.totalPts, 0))[0];
    const lo = rows.slice().sort((a, b) => num(a.totalPts, 0) - num(b.totalPts, 0))[0];

    $("pulseSummaryMetrics").innerHTML = `<div><strong>Shifts analyzed:</strong> ${n}</div><div><strong>Avg census:</strong> ${avgPts.toFixed(1)}</div><div><strong>Avg admits/discharges:</strong> ${avgA.toFixed(1)} / ${avgD.toFixed(1)}</div><div><strong>Highest shift:</strong> ${hi ? `${hi.date} ${String(hi.shift).toUpperCase()} (${num(hi.totalPts,0)} pts)` : "-"}</div>`;
    $("metricsNarrativeQuick").textContent = n ? `Unit workload averages ${avgPts.toFixed(1)} patients with flow at ${avgA.toFixed(1)} admits and ${avgD.toFixed(1)} discharges per shift. Highest pressure was ${hi.date} ${String(hi.shift).toUpperCase()}, and dominant acuity drivers were ${top.slice(0,3).map((x) => x.k).join(", ") || "none"}.` : "No unit metrics in this interval.";
    $("metricsNarrativeFull").innerHTML = depth === "extensive" ? `<div><strong>Operational spread:</strong> census ranges from ${lo ? num(lo.totalPts,0) : 0} to ${hi ? num(hi.totalPts,0) : 0}.</div><div><strong>Tag profile:</strong> ${top.slice(0,6).map((x) => `${x.k}:${x.v}`).join(", ") || "none"}.</div><div><strong>Interpretation:</strong> use top-tag concentration and event-time spikes to guide charge/resource support on peak hours.</div>` : "";

    const labels = rows.map((r) => `${r.date} ${String(r.shift || "").slice(0,1).toUpperCase()}`);
    drawLine("pulseChartPatients", labels, [{ values: rows.map((r) => num(r.totalPts, 0)) }]);
    drawLine("pulseChartFlow", labels, [{ values: rows.map((r) => num(r.admits, 0)) }, { values: rows.map((r) => num(r.discharges, 0)) }]);
    drawBars("pulseChartTags", top.slice(0, 10));

    const acu = Array(24).fill(0), adm = Array(24).fill(0), dis = Array(24).fill(0);
    events.forEach((e) => {
      const h = num(new Date(e.created_at || e.ts).getHours(), -1); if (h < 0 || h > 23) return;
      const t = String(e.event_type || "").toUpperCase();
      if (t.includes("ACUITY")) acu[h]++; if (t.includes("ADMIT")) adm[h]++; if (t.includes("DISCHARGE")) dis[h]++;
    });
    drawLine("pulseChartShiftTime", Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")), [{ values: acu }, { values: adm }, { values: dis }]);

    $("pulseChartPatientsMeta").textContent = n ? `Min/Max census: ${Math.min(...rows.map((r) => num(r.totalPts, 0)))} / ${Math.max(...rows.map((r) => num(r.totalPts, 0)))}` : "-";
    $("pulseChartFlowMeta").textContent = `Total admits/discharges: ${rows.reduce((s, r) => s + num(r.admits, 0), 0)} / ${rows.reduce((s, r) => s + num(r.discharges, 0), 0)}`;
    $("pulseChartTagsMeta").textContent = top.length ? `Top tags: ${top.slice(0,5).map((x) => `${x.k}:${x.v}`).join(" • ")}` : "No tag data.";
    $("pulseChartShiftTimeMeta").textContent = "Hourly burden from audit event stream.";

    let table = `<div style="overflow:auto;"><table style="width:100%;min-width:760px;border-collapse:separate;border-spacing:0;"><thead><tr style="font-size:12px;opacity:.75;text-align:left;"><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Date</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Shift</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Pts</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Admits</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Discharges</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Top tags</th></tr></thead><tbody>`;
    rows.forEach((r) => { table += `<tr style="font-size:13px;"><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.date)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.shift)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.totalPts, 0)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.admits, 0)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.discharges, 0)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(topTags(r.tagsObj || {},3).map((x) => `${x.k}:${x.v}`).join(", ") || "-")}</td></tr>`; });
    table += `</tbody></table></div>`;
    $("pulseTableDetailsSlot").innerHTML = table;
    if ($("pulseTable")) $("pulseTable").innerHTML = table;
  }

  function renderStaff(rows, snaps, depth, compare) {
    const sel = String($("metricsStaffSelect")?.value || "");
    const [staffId, staffName] = sel.split("::");
    const mine = rows.filter((r) => String(r.role).toUpperCase() === "RN" && (!staffId || String(r.staff_id || "") === staffId) && String(r.staff_name || "").trim().toLowerCase() === String(staffName || "").trim().toLowerCase());
    const peers = rows.filter((r) => String(r.role).toUpperCase() === "RN");
    const n = mine.length;
    const avgL = n ? mine.reduce((s, r) => s + num(r.workload_score, 0), 0) / n : 0;
    const avgP = n ? mine.reduce((s, r) => s + num(r.patients_assigned, 0), 0) / n : 0;
    const peerL = peers.length ? peers.reduce((s, r) => s + num(r.workload_score, 0), 0) / peers.length : 0;
    const peerP = peers.length ? peers.reduce((s, r) => s + num(r.patients_assigned, 0), 0) / peers.length : 0;
    const cats = { Low: 0, Moderate: 0, High: 0, "Very High": 0 }; mine.forEach((r) => { cats[workloadBucket(r.workload_score, "RN")]++; });
    const snapMap = new Map(); snaps.forEach((s) => snapMap.set(shiftKey(s.shift_date, s.shift_type), s));
    const tagTotals = {};
    mine.forEach((r) => {
      const s = snapMap.get(shiftKey(r.shift_date, r.shift_type)); if (!s) return;
      const pats = Array.isArray(s.state?.patients) ? s.state.patients : [];
      const ids = new Set(Array.isArray(r.details?.patient_ids) ? r.details.patient_ids.map(Number) : []);
      merge(tagTotals, tagsFromPatients(pats, ids));
    });
    const top = topTags(tagTotals, 10);

    $("pulseSummaryMetrics").innerHTML = `<div><strong>Shifts analyzed:</strong> ${n}</div><div><strong>Avg workload:</strong> ${avgL.toFixed(1)}</div><div><strong>Avg patients:</strong> ${avgP.toFixed(1)}</div>${compare ? `<div><strong>Vs unit avg:</strong> workload ${(avgL - peerL).toFixed(1)}, patients ${(avgP - peerP).toFixed(1)}</div>` : ""}<div><strong>Category counts:</strong> L:${cats.Low} M:${cats.Moderate} H:${cats.High} VH:${cats["Very High"]}</div>`;
    $("metricsNarrativeQuick").textContent = n ? `${staffName || "Selected nurse"} worked ${n} shifts with average workload ${avgL.toFixed(1)} and ${avgP.toFixed(1)} patients. Most frequent burden category was ${Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] || "Low"}, with top acuity exposure from ${top.slice(0,3).map((x) => x.k).join(", ") || "none"}.` : "No staff rows found for this selection.";
    $("metricsNarrativeFull").innerHTML = depth === "extensive" ? `<div><strong>Longitudinal burden:</strong> Low ${cats.Low}, Moderate ${cats.Moderate}, High ${cats.High}, Very High ${cats["Very High"]}.</div><div><strong>Acuity burden totals:</strong> ${top.slice(0,6).map((x) => `${x.k}:${x.v}`).join(", ") || "none"}.</div>${compare ? `<div><strong>Comparison:</strong> workload delta ${(avgL - peerL).toFixed(1)}, patient-load delta ${(avgP - peerP).toFixed(1)} vs RN unit average.</div>` : ""}` : "";

    const labels = mine.map((r) => `${r.shift_date} ${String(r.shift_type || "").slice(0,1).toUpperCase()}`);
    drawLine("pulseChartPatients", labels, [{ values: mine.map((r) => num(r.workload_score, 0)) }]);
    const line2 = [{ values: mine.map((r) => num(r.patients_assigned, 0)) }]; if (compare && peers.length) line2.push({ values: labels.map(() => peerL) }); drawLine("pulseChartFlow", labels, line2);
    drawBars("pulseChartTags", [{ k: "Low", v: cats.Low }, { k: "Moderate", v: cats.Moderate }, { k: "High", v: cats.High }, { k: "Very High", v: cats["Very High"] }]);
    drawBars("pulseChartShiftTime", top.map((x) => ({ k: x.k, v: x.v })).slice(0, 10));
    $("pulseChartPatientsMeta").textContent = n ? `Workload min/max: ${Math.min(...mine.map((r) => num(r.workload_score, 0))).toFixed(1)} / ${Math.max(...mine.map((r) => num(r.workload_score, 0))).toFixed(1)}` : "-";
    $("pulseChartFlowMeta").textContent = compare ? `Unit avg workload: ${peerL.toFixed(1)}` : "Patients assigned trend";
    $("pulseChartTagsMeta").textContent = "Workload category counts";
    $("pulseChartShiftTimeMeta").textContent = "Assigned acuity-tag burden totals";

    let table = `<div style="overflow:auto;"><table style="width:100%;min-width:860px;border-collapse:separate;border-spacing:0;"><thead><tr style="font-size:12px;opacity:.75;text-align:left;"><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Date</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Shift</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Staff</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Patients</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Workload</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Category</th></tr></thead><tbody>`;
    mine.forEach((r) => { table += `<tr style="font-size:13px;"><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.shift_date)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.shift_type)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.staff_name)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.patients_assigned, 0)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.workload_score, 0).toFixed(1)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(workloadBucket(r.workload_score, "RN"))}</td></tr>`; });
    table += `</tbody></table></div>`;
    $("pulseTableDetailsSlot").innerHTML = table;
    if ($("pulseTable")) $("pulseTable").innerHTML = table;
  }

  function renderAll(data, reqId) {
    if (reqId !== __req) return;
    ensureShell();
    const interval = String($("metricsInterval")?.value || "last_12_shifts");
    const view = String($("metricsViewMode")?.value || "unit");
    const depth = String($("metricsReportDepth")?.value || "quick");
    const compare = !!$("metricsCompareToggle")?.checked;
    const shift = String($("pulseShiftType")?.value || "");
    const shiftFilter = (shift === "day" || shift === "night") ? shift : "";

    const analytics = data.analytics.map((r) => ({ shift_date: r.shift_date || r.date || "", shift_type: r.shift_type || r.shift || "", totalPts: num(r.total_pts ?? r.metrics?.totals?.total_pts, 0), admits: num(r.admits ?? r.metrics?.totals?.admits, 0), discharges: num(r.discharges ?? r.metrics?.totals?.discharges, 0), tagsObj: (r.tag_counts && typeof r.tag_counts === "object") ? r.tag_counts : {}, raw: r })).filter((r) => r.shift_date && (!shiftFilter || String(r.shift_type).toLowerCase() === shiftFilter));
    const snapshots = data.snapshots.filter((s) => s.shift_date && (!shiftFilter || String(s.shift_type || "").toLowerCase() === shiftFilter));
    const staff = data.staff.filter((r) => r.shift_date && (!shiftFilter || String(r.shift_type || "").toLowerCase() === shiftFilter));
    setStaffOptions(staff);
    $("metricsStaffSelect").disabled = view !== "staff";

    const rowsCombined = [];
    const by = new Map();
    analytics.forEach((a) => by.set(shiftKey(a.shift_date, a.shift_type), { date: a.shift_date, shift: a.shift_type, totalPts: a.totalPts, admits: a.admits, discharges: a.discharges, tagsObj: a.tagsObj }));
    snapshots.forEach((s) => { const k = shiftKey(s.shift_date, s.shift_type); if (!by.has(k)) { const pats = Array.isArray(s.state?.patients) ? s.state.patients : []; by.set(k, { date: s.shift_date, shift: s.shift_type, totalPts: num(s.state?.total_pts, pats.filter((p) => p && !p.isEmpty).length), admits: num(s.state?.admits, 0), discharges: num(s.state?.discharges, 0), tagsObj: tagsFromPatients(pats) }); } });
    by.forEach((v) => rowsCombined.push(v));
    const rowsWindow = applyInterval(rowsCombined, interval);
    const minDate = rowsWindow[0]?.date || "0000-00-00", maxDate = rowsWindow[rowsWindow.length - 1]?.date || "9999-99-99";
    const eventsWin = data.events.filter((e) => { const d = ymd(e.created_at || e.ts || Date.now()); if (d < minDate || d > maxDate) return false; if (!shiftFilter) return true; const h = new Date(e.created_at || e.ts || Date.now()).getHours(); return (shiftFilter === "day" ? (h >= 7 && h < 19) : (h < 7 || h >= 19)); });
    const staffWindow = applyInterval(staff.map((r) => ({ ...r, date: r.shift_date, shift: r.shift_type })), interval).map((r) => r.raw || r);

    if (view === "staff") renderStaff(staffWindow, snapshots, depth, compare);
    else renderUnit(rowsWindow, snapshots, eventsWin, depth);
    setStatus(`Loaded analytics:${data.analytics.length}, snapshots:${data.snapshots.length}, staff:${data.staff.length}, events:${data.events.length}`);
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

  function wire() {
    const btn = $("btnLoadPulse");
    if (btn && !btn.__metricsWired) { btn.addEventListener("click", () => loadUnitMetrics()); btn.__metricsWired = true; }
    ["pulseShiftType","metricsViewMode","metricsInterval","metricsStaffSelect","metricsReportDepth","metricsCompareToggle"].forEach((id) => {
      const n = $(id); if (!n || n.__metricsWired) return;
      n.addEventListener("change", () => { if (__last) renderAll(__last, __lastReq); else loadUnitMetrics(); });
      n.__metricsWired = true;
    });
    window.unitMetrics = window.unitMetrics || {};
    window.unitMetrics.load = loadUnitMetrics;
    window.unitPulse = window.unitPulse || {};
    window.unitPulse.load = loadUnitMetrics;
  }

  window.addEventListener("DOMContentLoaded", () => {
    if ($("pulseTo") && !$("pulseTo").value) $("pulseTo").value = ymd(Date.now());
    if ($("pulseFrom") && !$("pulseFrom").value) { const d = new Date(); d.setDate(d.getDate() - 30); $("pulseFrom").value = ymd(d); }
    ensureControls();
    ensureShell();
    wire();
    setStatus("Choose Unit/Staff view and click Load Metrics.");
  });
})();
