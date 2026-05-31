// app/app.unitMetrics.js
// Unit + Staff longitudinal metrics with interval presets and narrative reports.
(function () {
  if (window.__unitMetricsSingletonLoaded) return;
  window.__unitMetricsSingletonLoaded = true;

  const $ = (id) => document.getElementById(id);
  const ACUITY_KEYS = ["tele","drip","nih","bg","ciwa","emu","restraint","sitter","vpo","isolation","admit","lateDc"];
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
      <div style="display:grid;grid-template-columns:36px minmax(220px,280px) 36px;align-items:center;gap:6px;">
        <button id="metricsStaffPrev" type="button" disabled style="width:36px;height:36px;padding:0;">&larr;</button>
        <div id="metricsStaffCurrent" style="width:100%;padding:6px 10px;border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#fff;font-size:13px;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Select staff</div>
        <button id="metricsStaffNext" type="button" disabled style="width:36px;height:36px;padding:0;">&rarr;</button>
      </div>
      <select id="metricsStaffSelect" disabled style="display:none;min-width:180px;"><option value="">Select staff</option></select>
      <label><strong>Report:</strong></label>
      <select id="metricsReportDepth"><option value="quick">Quick paragraph</option><option value="extensive">Extensive report</option></select>
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
        <div class="staff-card-header">Insights Summary</div>
        <div id="pulseSummaryMetrics" style="font-size:13px;line-height:1.45;"></div>
        <div id="metricsNarrativeQuick" style="margin-top:8px;font-size:13px;line-height:1.5;"></div>
        <div id="metricsNarrativeFull" style="margin-top:8px;font-size:12px;line-height:1.5;opacity:.9;"></div>
        <div id="metricsFocusedReport" style="margin-top:12px;"></div>
        <div id="metricsMergeSuggestion" style="margin-top:10px;"></div>
        <div id="metricsPrunePanel" style="margin-top:10px;"></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;">
        <div class="staff-card" style="flex:1;min-width:320px;"><div id="metricsQuad1Title" class="staff-card-header">Summary A</div><div id="metricsQuad1Body" style="padding:12px;"></div></div>
        <div class="staff-card" style="flex:1;min-width:320px;"><div id="metricsQuad2Title" class="staff-card-header">Summary B</div><div id="metricsQuad2Body" style="padding:12px;"></div></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;">
        <div class="staff-card" style="flex:1;min-width:320px;"><div id="metricsQuad3Title" class="staff-card-header">Summary C</div><div id="metricsQuad3Body" style="padding:12px;"></div></div>
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
    renderPrunePanel(staffRows);
    const n = rows.length;
    const avgPts = n ? rows.reduce((s, r) => s + num(r.totalPts, 0), 0) / n : 0;
    const avgA = n ? rows.reduce((s, r) => s + num(r.admits, 0), 0) / n : 0;
    const avgD = n ? rows.reduce((s, r) => s + num(r.discharges, 0), 0) / n : 0;
    const tags = {};
    rows.forEach((r) => merge(tags, r.tagsObj || {}));
    const top = topTags(tags, 10);
    const avgTagTiles = avgTagsPerShift(tags, n, 10);

    renderSummaryTiles([
      { k: "Shifts Reviewed", v: n, sub: "Selected interval" },
      { k: "Average Census", v: avgPts.toFixed(1), sub: "Patients per shift" },
      { k: "Average Admits", v: avgA.toFixed(1), sub: "Per shift" },
      { k: "Average Discharges", v: avgD.toFixed(1), sub: "Per shift" }
    ], "No unit metrics are available in this time range.");
    $("metricsNarrativeQuick").textContent = n ? "The 2x2 summary below shows the unit's most common acuity needs and average flow patterns across the selected shifts." : "No unit metrics are available in this time range.";
    $("metricsNarrativeFull").innerHTML = "";

    const modeSet = new Set(rows.map((r) => String(r.shift || "").toLowerCase()).filter((s) => s === "day" || s === "night"));
    let flowMode = String(window.__metricsUnitSummaryMode || "");
    if (!modeSet.has(flowMode)) flowMode = modeSet.has("day") ? "day" : modeSet.has("night") ? "night" : "";
    window.__metricsUnitSummaryMode = flowMode;
    const flowRows = flowMode ? rows.filter((r) => String(r.shift || "").toLowerCase() === flowMode) : rows.slice();
    const flowCount = flowRows.length;
    const avgCensus = flowCount ? flowRows.reduce((sum, r) => sum + num(r.totalPts, 0), 0) / flowCount : 0;
    const avgDischarges = flowCount ? flowRows.reduce((sum, r) => sum + num(r.discharges, 0), 0) / flowCount : 0;
    const avgAdmits = flowCount ? flowRows.reduce((sum, r) => sum + num(r.admits, 0), 0) / flowCount : 0;

    const snapMap = new Map();
    (snaps || []).forEach((s) => snapMap.set(shiftKey(s.shift_date, s.shift_type), s));
    const hidden = loadHiddenProfiles();
    const rnRows = (staffRows || []).filter((r) => String(r.role || "").toUpperCase() === "RN" && !isFillerStaffName(r.staff_name) && !isHiddenStaffName(r.staff_name, hidden));
    const rnTagTotals = {};
    rnRows.forEach((r) => {
      const s = snapMap.get(shiftKey(r.shift_date, r.shift_type));
      const pats = Array.isArray(s?.state?.patients) ? s.state.patients : [];
      const ids = new Set(Array.isArray(r.details?.patient_ids) ? r.details.patient_ids.map(Number) : []);
      merge(rnTagTotals, tagsFromPatients(pats, ids));
    });
    const avgRnTagTiles = avgTagsPerShift(rnTagTotals, rnRows.length, 10);

    setQuad(1, "Total Acuity Tags Over Time", "tags", top.slice(0, 10), n ? `Collected across ${n} shift${n === 1 ? "" : "s"} in this view.` : "No shift data.", "No tag data.");
    setQuad(2, "Average Acuity Tags Per Shift", "tags", avgTagTiles.slice(0, 10), avgTagTiles.length ? "Average acuity-tag frequency per shift." : "No shift data.", "No average tag data.");
    setQuad(3, "Average Unit Flow", "metrics", [
      { k: "Average Census", v: avgCensus.toFixed(1), sub: flowMode ? `${flowMode.toUpperCase()} shifts` : "Selected shifts" },
      { k: "Average Discharges", v: avgDischarges.toFixed(1), sub: flowMode ? `${flowMode.toUpperCase()} shifts` : "Selected shifts" },
      { k: "Average Admits", v: avgAdmits.toFixed(1), sub: flowMode ? `${flowMode.toUpperCase()} shifts` : "Selected shifts" }
    ], flowCount ? `${flowCount} ${flowMode || "selected"} shift${flowCount === 1 ? "" : "s"} included.` : "No matching shifts in this view.", "No shift data.");
    setQuad(4, "Average Acuity Tags Per RN Assignment", "tags", avgRnTagTiles, rnRows.length ? `Average acuity-tag frequency across ${rnRows.length} RN assignments.` : "No RN assignment data.", "No RN assignment data.");

    const q3Meta = $("metricsQuad3Meta");
    if (q3Meta) {
      q3Meta.innerHTML = `
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="metricsUnitModeDay" type="button" style="padding:6px 12px;border-radius:999px;border:1px solid rgba(15,23,42,.12);background:${flowMode === "day" ? "#e2ecff" : "#fff"};font-weight:${flowMode === "day" ? "800" : "600"};">Day</button>
          <button id="metricsUnitModeNight" type="button" style="padding:6px 12px;border-radius:999px;border:1px solid rgba(15,23,42,.12);background:${flowMode === "night" ? "#e2ecff" : "#fff"};font-weight:${flowMode === "night" ? "800" : "600"};">Night</button>
          <span style="align-self:center;">${flowCount ? `${flowCount} shift${flowCount === 1 ? "" : "s"} included.` : "No matching shifts."}</span>
        </div>
      `;
      const dayBtn = $("metricsUnitModeDay");
      const nightBtn = $("metricsUnitModeNight");
      if (dayBtn) dayBtn.onclick = () => { window.__metricsUnitSummaryMode = "day"; if (__last) renderAll(__last, __lastReq); };
      if (nightBtn) nightBtn.onclick = () => { window.__metricsUnitSummaryMode = "night"; if (__last) renderAll(__last, __lastReq); };
    }

    let table = `<div style="overflow:auto;"><table style="width:100%;min-width:760px;border-collapse:separate;border-spacing:0;"><thead><tr style="font-size:12px;opacity:.75;text-align:left;"><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Date</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Shift</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Pts</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Admits</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Discharges</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Top tags</th></tr></thead><tbody>`;
    rows.forEach((r) => { table += `<tr style="font-size:13px;"><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.date)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.shift)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.totalPts, 0)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.admits, 0)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.discharges, 0)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(topTags(r.tagsObj || {},3).map((x) => `${x.k}:${x.v}`).join(", ") || "-")}</td></tr>`; });
    table += `</tbody></table></div>`;
    if ($("pulseTableDetailsSlot")) $("pulseTableDetailsSlot").innerHTML = table;
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
      const s = snapMap.get(shiftKey(r.shift_date, r.shift_type)); if (!s) return;
      const pats = Array.isArray(s.state?.patients) ? s.state.patients : [];
      const ids = new Set(Array.isArray(r.details?.patient_ids) ? r.details.patient_ids.map(Number) : []);
      merge(tagTotals, tagsFromPatients(pats, ids));
    });
    const top = topTags(tagTotals, 10);
    const totalTagBurden = Object.values(tagTotals).reduce((sum, v) => sum + num(v, 0), 0);
    const avgTagBurden = n ? totalTagBurden / n : 0;
    const avgTagTiles = avgTagsPerShift(tagTotals, n, 10);
    const firstShift = mine[0] || null;
    const lastShift = mine[mine.length - 1] || null;
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
      const s = snapMap.get(shiftKey(r.shift_date, r.shift_type));
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
    setQuad(2, "Trend Over Time", "metrics", [
      { k: "Start Load", v: startWorkload.toFixed(1) },
      { k: "End Load", v: endWorkload.toFixed(1) },
      { k: "Load Change", v: `${workloadDelta > 0 ? "+" : ""}${workloadDelta.toFixed(1)}` },
      { k: "Patient Range", v: `${minPatients}-${maxPatients}` }
    ], "Shift trend across the selected worked shifts.", "No trend data.");
    setQuad(3, "Average Acuity Tags Per Worked Shift", "tags", avgTagTiles.length ? avgTagTiles : top.slice(0, 10), compare ? `Rank: ${ordinal(totalRank)} total exposure and ${ordinal(avgRank)} average exposure.` : "Average historical acuity tags per worked shift.", "No acuity-tag data.");
    setQuad(4, "Peer Comparison", "metrics", [
      { k: "Workload vs RN Avg", v: `${(avgL - peerL).toFixed(1) >= 0 ? "+" : ""}${(avgL - peerL).toFixed(1)}`, sub: "Compared with RN peers" },
      { k: "Patients vs RN Avg", v: `${(avgP - peerP).toFixed(1) >= 0 ? "+" : ""}${(avgP - peerP).toFixed(1)}`, sub: "Compared with RN peers" },
      { k: "Total Exposure Rank", v: ordinal(totalRank) },
      { k: "Average Exposure Rank", v: ordinal(avgRank) }
    ], compare ? "Peer comparison based on worked-shift exposure." : "Peer comparison is off.", "No peer comparison data.");

    let table = `<div style="overflow:auto;"><table style="width:100%;min-width:920px;border-collapse:separate;border-spacing:0;"><thead><tr style="font-size:12px;opacity:.75;text-align:left;"><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Date</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Shift</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Staff</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Patients</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Workload</th><th style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.12);">Top tag exposure</th></tr></thead><tbody>`;
    mine.forEach((r) => {
      const s = snapMap.get(shiftKey(r.shift_date, r.shift_type));
      const pats = Array.isArray(s?.state?.patients) ? s.state.patients : [];
      const ids = new Set(Array.isArray(r.details?.patient_ids) ? r.details.patient_ids.map(Number) : []);
      const rowTags = topTags(tagsFromPatients(pats, ids), 3).map((x) => `${x.k}:${x.v}`).join(", ") || "-";
      table += `<tr style="font-size:13px;"><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.shift_date)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.shift_type)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(r.staff_name)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.patients_assigned, 0)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${num(r.workload_score, 0).toFixed(1)}</td><td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.06);">${esc(rowTags)}</td></tr>`;
    });
    table += `</tbody></table></div>`;
    if ($("pulseTableDetailsSlot")) $("pulseTableDetailsSlot").innerHTML = table;
    if ($("pulseTable")) $("pulseTable").innerHTML = table;
  }

  function renderAll(data, reqId) {
    if (reqId !== __req) return;
    ensureShell();
    const interval = String($("metricsInterval")?.value || "last_12_shifts");
    const view = String($("metricsViewMode")?.value || "unit");
    const depth = String($("metricsReportDepth")?.value || "quick");
    const compare = true;
    const shift = String($("pulseShiftType")?.value || "");
    const shiftFilter = (shift === "day" || shift === "night") ? shift : "";

    const analytics = data.analytics.map((r) => ({ shift_date: r.shift_date || r.date || "", shift_type: r.shift_type || r.shift || "", totalPts: num(r.total_pts ?? r.metrics?.totals?.total_pts, 0), admits: num(r.admits ?? r.metrics?.totals?.admits, 0), discharges: num(r.discharges ?? r.metrics?.totals?.discharges, 0), tagsObj: extractTagCounts(r), raw: r })).filter((r) => r.shift_date && (!shiftFilter || String(r.shift_type).toLowerCase() === shiftFilter));
    const snapshots = data.snapshots.filter((s) => s.shift_date && (!shiftFilter || String(s.shift_type || "").toLowerCase() === shiftFilter));
    const staff = data.staff.filter((r) => r.shift_date && (!shiftFilter || String(r.shift_type || "").toLowerCase() === shiftFilter));
    setStaffOptions(staff);
    $("metricsStaffSelect").disabled = view !== "staff";

    const rowsCombined = [];
    const by = new Map();
    analytics.forEach((a) => by.set(shiftKey(a.shift_date, a.shift_type), { date: a.shift_date, shift: a.shift_type, totalPts: a.totalPts, admits: a.admits, discharges: a.discharges, tagsObj: a.tagsObj }));
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
    const minDate = rowsWindow[0]?.date || "0000-00-00", maxDate = rowsWindow[rowsWindow.length - 1]?.date || "9999-99-99";
    const eventsWin = data.events.filter((e) => { const d = ymd(e.created_at || e.ts || Date.now()); if (d < minDate || d > maxDate) return false; if (!shiftFilter) return true; const h = new Date(e.created_at || e.ts || Date.now()).getHours(); return (shiftFilter === "day" ? (h >= 7 && h < 19) : (h < 7 || h >= 19)); });
    const staffWindow = applyInterval(staff.map((r) => ({ ...r, date: r.shift_date, shift: r.shift_type })), interval).map((r) => r.raw || r);

    if (view === "staff") renderStaff(staffWindow, snapshots, depth, compare);
    else renderUnit(rowsWindow, snapshots, eventsWin, depth, staffWindow);
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
    if ($("pulseTo") && !$("pulseTo").value) $("pulseTo").value = ymd(Date.now());
    if ($("pulseFrom") && !$("pulseFrom").value) { const d = new Date(); d.setDate(d.getDate() - 30); $("pulseFrom").value = ymd(d); }
    ensureControls();
    ensureShell();
    wire();
    setStatus("Choose Unit/Staff view and click Load Metrics.");
  });
})();
