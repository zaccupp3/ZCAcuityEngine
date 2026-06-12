// app/app.advancedMetrics.js
// Advanced unit-scoped operational reports built from finalized shifts,
// staff_shift_metrics, shift_snapshots, analytics_shift_metrics, and audit_events.
(function () {
  if (window.__advancedMetricsLoaded) return;
  window.__advancedMetricsLoaded = true;

  const $ = (id) => document.getElementById(id);
  const safeArray = (v) => (Array.isArray(v) ? v : []);
  const num = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (m) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[m]));
  const activeUnitId = () => (window.activeUnitId ? String(window.activeUnitId) : "");
  const sbReady = () => !!(window.sb && window.sb.client && typeof window.sb.client.from === "function");
  const shiftRank = (s) => String(s || "").toLowerCase() === "day" ? 1 : 2;
  const shiftKey = (date, shift) => `${date}|${String(shift || "").toLowerCase()}`;
  const ymd = (v) => {
    const d = new Date(v || Date.now());
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
  };

  const ACUITY_KEYS = ["tele","drip","nih","bg","ciwa","emu","restraint","sitter","vpo","isolation","admit","lateDc"];
  const HIGH_RISK_KEYS = ["sitter","vpo","restraint","ciwa","nih","emu","isolation"];
  const FALL_PROXY_KEYS = ["sitter","vpo","restraint","ciwa","nih","emu"];
  const SKIN_PROXY_KEYS = ["q2turns","q2Turns","strictIo","heavy","feeder","foley"];
  const PCA_BURDEN_KEYS = ["chg","foley","q2turns","q2Turns","strictIo","heavy","feeder","isolation","sitter","restraint","admit","lateDc"];

  let __req = 0;
  let __lastData = null;

  function setStatus(msg, isError = false) {
    const el = $("advancedMetricsStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isError ? "#b91c1c" : "#0f172a";
  }

  function getRoomNumber(p) {
    const raw = String(p?.room ?? p?.id ?? "");
    const m = raw.match(/\d+/);
    return m ? Number(m[0]) : 9999;
  }

  function activePatientsFromSnapshot(snapshot) {
    return safeArray(snapshot?.state?.patients)
      .filter((p) => p && !p.isEmpty)
      .sort((a, b) => getRoomNumber(a) - getRoomNumber(b));
  }

  function assignedIdSet(owners) {
    const out = new Set();
    safeArray(owners).forEach((owner) => {
      safeArray(owner?.patients).forEach((pid) => {
        const n = Number(pid);
        if (Number.isFinite(n)) out.add(n);
      });
    });
    return out;
  }

  function tagCountsFromPatients(patients, keys) {
    const out = {};
    safeArray(patients).forEach((p) => {
      if (!p || p.isEmpty) return;
      safeArray(keys || ACUITY_KEYS).forEach((k) => {
        if (p[k]) out[k] = (out[k] || 0) + 1;
      });
    });
    return out;
  }

  function countTaggedPatients(patients, keys) {
    return safeArray(patients).filter((p) => safeArray(keys).some((k) => !!p?.[k])).length;
  }

  function merge(into, src) {
    Object.keys(src || {}).forEach((k) => { into[k] = (into[k] || 0) + num(src[k], 0); });
    return into;
  }

  function topTags(obj, limit = 6) {
    return Object.entries(obj || {})
      .map(([k, v]) => ({ k, v: num(v, 0) }))
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v || a.k.localeCompare(b.k))
      .slice(0, limit);
  }

  function eventType(ev) {
    return String(ev?.event_type || ev?.type || "").trim().toUpperCase();
  }

  function eventDate(ev) {
    return ymd(ev?.created_at || ev?.ts || Date.now());
  }

  function extractAnalyticsRows(data, shiftFilter) {
    const by = new Map();
    safeArray(data.analytics).forEach((row) => {
      const date = row.shift_date || row.date || "";
      const shift = String(row.shift_type || row.shift || "").toLowerCase();
      if (!date || (shiftFilter && shift !== shiftFilter)) return;
      const metrics = row.metrics && typeof row.metrics === "object" ? row.metrics : {};
      const tags = row.tag_counts && typeof row.tag_counts === "object" ? row.tag_counts : (metrics.tag_counts || {});
      by.set(shiftKey(date, shift), {
        date,
        shift,
        totalPts: num(row.total_pts ?? metrics?.totals?.total_pts, 0),
        admits: num(row.admits ?? metrics?.totals?.admits, 0),
        discharges: num(row.discharges ?? metrics?.totals?.discharges, 0),
        acuityChanges: num(metrics?.totals?.acuity_changes, 0),
        assignmentChanges: num(metrics?.totals?.assignment_changes, 0),
        eventCount: num(metrics?.totals?.event_count, 0),
        tagsObj: tags || {}
      });
    });

    safeArray(data.snapshots).forEach((snap) => {
      const date = snap.shift_date || "";
      const shift = String(snap.shift_type || "").toLowerCase();
      if (!date || (shiftFilter && shift !== shiftFilter)) return;
      const k = shiftKey(date, shift);
      const state = snap.state && typeof snap.state === "object" ? snap.state : {};
      const pats = activePatientsFromSnapshot(snap);
      const fallback = {
        date,
        shift,
        totalPts: num(state.total_pts, pats.length),
        admits: num(state.admits, 0),
        discharges: num(state.discharges, 0),
        acuityChanges: num(state.acuity_changes, 0),
        assignmentChanges: num(state.assignment_changes, 0),
        eventCount: 0,
        tagsObj: state.tag_counts || tagCountsFromPatients(pats, ACUITY_KEYS)
      };
      if (!by.has(k)) {
        by.set(k, fallback);
        return;
      }
      const existing = by.get(k);
      if (!Object.keys(existing.tagsObj || {}).length) existing.tagsObj = fallback.tagsObj;
      if (!existing.totalPts && fallback.totalPts) existing.totalPts = fallback.totalPts;
      if (!existing.admits && fallback.admits) existing.admits = fallback.admits;
      if (!existing.discharges && fallback.discharges) existing.discharges = fallback.discharges;
      if (!existing.assignmentChanges && fallback.assignmentChanges) existing.assignmentChanges = fallback.assignmentChanges;
      if (!existing.acuityChanges && fallback.acuityChanges) existing.acuityChanges = fallback.acuityChanges;
    });

    return Array.from(by.values())
      .sort((a, b) => a.date.localeCompare(b.date) || (shiftRank(a.shift) - shiftRank(b.shift)));
  }

  function applyControls(data) {
    const shift = String($("advancedShiftType")?.value || "").toLowerCase();
    const shiftFilter = shift === "day" || shift === "night" ? shift : "";
    const from = String($("advancedFrom")?.value || "");
    const to = String($("advancedTo")?.value || "");
    const interval = String($("advancedInterval")?.value || "all");

    const inDate = (date) => (!from || date >= from) && (!to || date <= to);
    const rows = extractAnalyticsRows(data, shiftFilter)
      .filter((r) => inDate(r.date));
    const snapshots = safeArray(data.snapshots)
      .filter((s) => s.shift_date && inDate(s.shift_date) && (!shiftFilter || String(s.shift_type || "").toLowerCase() === shiftFilter))
      .sort((a, b) => String(a.shift_date).localeCompare(String(b.shift_date)) || (shiftRank(a.shift_type) - shiftRank(b.shift_type)));
    const staff = safeArray(data.staff)
      .filter((r) => r.shift_date && inDate(r.shift_date) && (!shiftFilter || String(r.shift_type || "").toLowerCase() === shiftFilter));
    const events = safeArray(data.events)
      .filter((ev) => inDate(eventDate(ev)));

    if (interval === "last_3" || interval === "last_6" || interval === "last_12") {
      const n = Number(interval.replace("last_", "")) || 12;
      const keys = new Set(rows.slice(-n).map((r) => shiftKey(r.date, r.shift)));
      return {
        rows: rows.filter((r) => keys.has(shiftKey(r.date, r.shift))),
        snapshots: snapshots.filter((s) => keys.has(shiftKey(s.shift_date, s.shift_type))),
        staff: staff.filter((r) => keys.has(shiftKey(r.shift_date, r.shift_type))),
        events
      };
    }

    return { rows, snapshots, staff, events };
  }

  function getLatestSnapshot(snapshots) {
    return safeArray(snapshots).slice().sort((a, b) =>
      String(b.shift_date || "").localeCompare(String(a.shift_date || "")) ||
      (shiftRank(b.shift_type) - shiftRank(a.shift_type))
    )[0] || null;
  }

  function snapshotCoverageStats(snapshot) {
    const pats = activePatientsFromSnapshot(snapshot);
    const current = snapshot?.state?.current_assignment || {};
    const rnSet = assignedIdSet(current.nurses);
    const pcaSet = assignedIdSet(current.pcas);
    const uncoveredRn = pats.filter((p) => !rnSet.has(Number(p.id)));
    const uncoveredPca = pats.filter((p) => !pcaSet.has(Number(p.id)));
    return { pats, uncoveredRn, uncoveredPca, rnCount: safeArray(current.nurses).length, pcaCount: safeArray(current.pcas).length };
  }

  function pct(part, whole) {
    const w = Math.max(1, num(whole, 0));
    return Math.round((num(part, 0) / w) * 100);
  }

  function riskLevel(score) {
    const s = num(score, 0);
    if (s >= 75) return "High";
    if (s >= 45) return "Moderate";
    return "Low";
  }

  function metricCard({ title, score, level, summary, metrics, bullets }) {
    const safeScore = Math.max(0, Math.min(100, Math.round(num(score, 0))));
    const label = level || riskLevel(safeScore);
    return `
      <div class="advanced-report-card">
        <div class="advanced-report-head">
          <div>
            <div class="advanced-report-title">${esc(title)}</div>
            <div class="advanced-report-summary">${esc(summary || "")}</div>
          </div>
          <div class="advanced-score advanced-score-${label.toLowerCase()}">
            <span>${safeScore}</span>
            <small>${esc(label)}</small>
          </div>
        </div>
        <div class="advanced-metric-grid">
          ${safeArray(metrics).map((m) => `
            <div class="advanced-mini-metric">
              <div>${esc(m.k)}</div>
              <strong>${esc(m.v)}</strong>
              ${m.sub ? `<small>${esc(m.sub)}</small>` : ""}
            </div>
          `).join("")}
        </div>
        <ul class="advanced-report-list">
          ${safeArray(bullets).slice(0, 5).map((b) => `<li>${esc(b)}</li>`).join("")}
        </ul>
      </div>
    `;
  }

  function reportRows(reports) {
    return `
      <div class="advanced-table-wrap">
        <table class="advanced-report-table">
          <thead>
            <tr><th>Report</th><th>Score</th><th>Level</th><th>Primary Signal</th></tr>
          </thead>
          <tbody>
            ${reports.map((r) => `
              <tr>
                <td>${esc(r.title)}</td>
                <td>${Math.round(num(r.score, 0))}</td>
                <td>${esc(r.level || riskLevel(r.score))}</td>
                <td>${esc(r.summary || "")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function buildReports(filtered) {
    const rows = filtered.rows;
    const snapshots = filtered.snapshots;
    const staff = filtered.staff;
    const events = filtered.events;
    const latest = getLatestSnapshot(snapshots);
    const latestCoverage = snapshotCoverageStats(latest);
    const shiftCount = rows.length;
    const staffCount = staff.length;
    const rnRows = staff.filter((r) => String(r.role || "").toUpperCase() === "RN");
    const pcaRows = staff.filter((r) => String(r.role || "").toUpperCase() === "PCA");
    const workloads = staff.map((r) => num(r.workload_score, 0)).filter((v) => v > 0);
    const rnLoads = rnRows.map((r) => num(r.workload_score, 0)).filter((v) => v > 0);
    const pcaLoads = pcaRows.map((r) => num(r.workload_score, 0)).filter((v) => v > 0);
    const avg = (arr) => arr.length ? arr.reduce((s, v) => s + num(v, 0), 0) / arr.length : 0;
    const spread = (arr) => arr.length ? Math.max(...arr) - Math.min(...arr) : 0;
    const total = (arr, getter) => arr.reduce((s, x) => s + num(getter(x), 0), 0);
    const allPatients = snapshots.flatMap((s) => activePatientsFromSnapshot(s));
    const highRiskCount = countTaggedPatients(allPatients, HIGH_RISK_KEYS);
    const fallProxyCount = countTaggedPatients(allPatients, FALL_PROXY_KEYS);
    const skinProxyCount = countTaggedPatients(allPatients, SKIN_PROXY_KEYS);
    const pcaBurdenTags = tagCountsFromPatients(allPatients, PCA_BURDEN_KEYS);
    const highRiskTags = tagCountsFromPatients(allPatients, HIGH_RISK_KEYS);
    const skinTags = tagCountsFromPatients(allPatients, SKIN_PROXY_KEYS);
    const admits = total(rows, (r) => r.admits);
    const discharges = total(rows, (r) => r.discharges);
    const moves = total(rows, (r) => r.assignmentChanges) || events.filter((ev) => eventType(ev) === "ASSIGNMENT_MOVED").length;
    const acuityChanges = total(rows, (r) => r.acuityChanges) || events.filter((ev) => eventType(ev) === "ACUITY_CHANGED").length;
    const uncoveredTotal = latestCoverage.uncoveredRn.length + latestCoverage.uncoveredPca.length;
    const highLoadStaff = staff.filter((r) => {
      const role = String(r.role || "").toUpperCase();
      const load = num(r.workload_score, 0);
      return role === "RN" ? load >= 24 : load >= 30;
    });
    const leadership = latest?.state?.leadership || {};
    const currentLeadership = leadership.current || {};
    const incomingLeadership = leadership.incoming || {};
    const leadershipFilled = ["charge","mentor","cta","pcaResource"].filter((k) => currentLeadership[k]).length +
      ["charge","mentor","cta","pcaResource"].filter((k) => incomingLeadership[k]).length;
    const leadershipPct = pct(leadershipFilled, 8);
    const oncoming = latest?.state?.oncoming_assignment || {};
    const oncomingStaffCount = safeArray(oncoming.nurses).length + safeArray(oncoming.pcas).length;

    const flowBurden = shiftCount ? (admits + discharges) / shiftCount : 0;
    const workloadSpread = spread(workloads);
    const loadRisk = Math.min(100, (workloadSpread * 3) + pct(highLoadStaff.length, Math.max(1, staffCount)) * 0.6);
    const coverageRisk = Math.min(100, pct(uncoveredTotal, Math.max(1, latestCoverage.pats.length * 2)));

    return [
      {
        title: "Shift Workload Equity",
        score: Math.min(100, workloadSpread * 4 + pct(highLoadStaff.length, Math.max(1, staffCount)) * 0.8),
        summary: `${workloadSpread.toFixed(1)} point workload spread across selected staff metrics.`,
        metrics: [
          { k: "RN Avg Load", v: avg(rnLoads).toFixed(1), sub: "Selected staff rows" },
          { k: "PCA Avg Load", v: avg(pcaLoads).toFixed(1), sub: "Selected staff rows" },
          { k: "High Load Staff", v: String(highLoadStaff.length), sub: "Above support threshold" }
        ],
        bullets: [
          `Reviewed ${staffCount} staff-shift rows across ${shiftCount} shift(s).`,
          `Highest workload spread is ${workloadSpread.toFixed(1)} points.`,
          "Use this to support assignment fairness conversations beyond raw ratios."
        ]
      },
      {
        title: "High-Risk Patient Coverage",
        score: Math.min(100, coverageRisk + pct(highRiskCount, Math.max(1, allPatients.length)) * 0.8),
        summary: `${highRiskCount} high-risk patient-shift observations across selected snapshots.`,
        metrics: [
          { k: "High-Risk Obs", v: String(highRiskCount), sub: topTags(highRiskTags, 3).map((x) => `${x.k}:${x.v}`).join(", ") || "No tags" },
          { k: "RN Gaps", v: String(latestCoverage.uncoveredRn.length), sub: "Latest snapshot" },
          { k: "PCA Gaps", v: String(latestCoverage.uncoveredPca.length), sub: "Latest snapshot" }
        ],
        bullets: [
          `Latest snapshot has ${latestCoverage.pats.length} active patients.`,
          "Review stacked sitter, VPO, restraint, CIWA, NIH, EMU, and isolation assignments.",
          "Coverage gaps should be corrected before print/handoff when possible."
        ]
      },
      {
        title: "Admit and Discharge Flow",
        score: Math.min(100, flowBurden * 12 + Math.abs(admits - discharges) * 4),
        summary: `${admits} admits and ${discharges} discharges in the selected window.`,
        metrics: [
          { k: "Admits", v: String(admits), sub: `${shiftCount ? (admits / shiftCount).toFixed(1) : "0.0"} per shift` },
          { k: "Discharges", v: String(discharges), sub: `${shiftCount ? (discharges / shiftCount).toFixed(1) : "0.0"} per shift` },
          { k: "Net Flow", v: String(admits - discharges), sub: "Admits minus discharges" }
        ],
        bullets: [
          "High flow shifts create work that raw census does not show.",
          "Queue timing fields will make time-to-place reporting more precise.",
          "Use with discharge burden to anticipate patient experience pressure."
        ]
      },
      {
        title: "Assignment Churn",
        score: Math.min(100, moves * 10 + pct(moves, Math.max(1, shiftCount * 8))),
        summary: `${moves} assignment movement event(s) or finalized movement count(s).`,
        metrics: [
          { k: "Moves", v: String(moves), sub: "Selected window" },
          { k: "Acuity Changes", v: String(acuityChanges), sub: "Related instability signal" },
          { k: "Moves/Shift", v: shiftCount ? (moves / shiftCount).toFixed(1) : "0.0" }
        ],
        bullets: [
          "High churn can increase handoff risk and staff frustration.",
          "Future move reason codes can separate planned rebalancing from call-off or acuity-driven changes.",
          "Review repeated moves involving high-risk patients."
        ]
      },
      {
        title: "Staff Load and Burnout Risk",
        score: Math.min(100, loadRisk + flowBurden * 4),
        summary: `${highLoadStaff.length} high-load staff-shift row(s) in this view.`,
        metrics: [
          { k: "Avg Load", v: avg(workloads).toFixed(1), sub: "RN/PCA combined" },
          { k: "High Load Rows", v: String(highLoadStaff.length), sub: "Support threshold" },
          { k: "Flow Burden", v: flowBurden.toFixed(1), sub: "Admits + discharges per shift" }
        ],
        bullets: [
          "Use longitudinally to identify repeated high-load exposure.",
          "Keep this framed as staff support and assignment equity.",
          "Pair with staffing context before making operational conclusions."
        ]
      },
      {
        title: "PCA Rounding and Care Burden",
        score: Math.min(100, avg(pcaLoads) * 2.2 + Object.values(pcaBurdenTags).reduce((s, v) => s + num(v, 0), 0) / Math.max(1, shiftCount)),
        summary: `${pcaRows.length} PCA staff-shift rows with care-burden tag context.`,
        metrics: [
          { k: "PCA Avg Load", v: avg(pcaLoads).toFixed(1) },
          { k: "PCA Rows", v: String(pcaRows.length) },
          { k: "Top Burden", v: topTags(pcaBurdenTags, 1)[0]?.k || "-", sub: topTags(pcaBurdenTags, 3).map((x) => `${x.k}:${x.v}`).join(", ") || "No tags" }
        ],
        bullets: [
          "PCA burden should include CHG, Foley, totals/q2, feeder, strict I/O, isolation, sitter, and restraint.",
          "A QR rounding feed would unlock elapsed-time-since-last-round reporting.",
          "Resource PCA coverage should be reviewed when care-burden tags cluster."
        ]
      },
      {
        title: "Fall and Injury Prevention Risk",
        score: Math.min(100, pct(fallProxyCount, Math.max(1, allPatients.length)) + coverageRisk + avg(workloads)),
        summary: `${fallProxyCount} fall/injury proxy patient-shift observation(s).`,
        metrics: [
          { k: "Risk Proxies", v: String(fallProxyCount), sub: topTags(tagCountsFromPatients(allPatients, FALL_PROXY_KEYS), 3).map((x) => `${x.k}:${x.v}`).join(", ") || "No tags" },
          { k: "Coverage Gaps", v: String(uncoveredTotal), sub: "Latest snapshot RN/PCA gaps" },
          { k: "High Load Rows", v: String(highLoadStaff.length) }
        ],
        bullets: [
          "This is a leading-indicator proxy, not an actual fall rate.",
          "Add fall/near-fall event types to convert this into outcomes reporting.",
          "Use for charge/resource rounding targets."
        ]
      },
      {
        title: "Pressure Injury Prevention Coverage",
        score: Math.min(100, pct(skinProxyCount, Math.max(1, allPatients.length)) + avg(pcaLoads) + coverageRisk),
        summary: `${skinProxyCount} skin-risk proxy patient-shift observation(s).`,
        metrics: [
          { k: "Skin Proxies", v: String(skinProxyCount), sub: topTags(skinTags, 3).map((x) => `${x.k}:${x.v}`).join(", ") || "No tags" },
          { k: "PCA Avg Load", v: avg(pcaLoads).toFixed(1) },
          { k: "PCA Gaps", v: String(latestCoverage.uncoveredPca.length), sub: "Latest snapshot" }
        ],
        bullets: [
          "Current proxy uses totals/q2, strict I/O, heavy care, feeder, and Foley tags.",
          "Add explicit skin-risk and turn-completion events for stronger process-measure reporting.",
          "Best used as an interdisciplinary support signal."
        ]
      },
      {
        title: "Patient Experience Readiness",
        score: Math.min(100, coverageRisk + flowBurden * 8 + pct(highLoadStaff.length, Math.max(1, staffCount))),
        summary: `Responsiveness pressure from coverage, flow, and workload signals.`,
        metrics: [
          { k: "Coverage Gaps", v: String(uncoveredTotal), sub: "RN + PCA latest snapshot" },
          { k: "Flow/Shift", v: flowBurden.toFixed(1), sub: "Admits + discharges" },
          { k: "High Load Staff", v: String(highLoadStaff.length) }
        ],
        bullets: [
          "This aligns to HCAHPS-adjacent operations such as responsiveness, discharge pressure, and care coordination.",
          "It does not replace official patient survey data.",
          "Use as a pre-shift or mid-shift leadership check."
        ]
      },
      {
        title: "Leadership Handoff Quality",
        score: Math.max(0, 100 - leadershipPct + coverageRisk + (oncomingStaffCount ? 0 : 25)),
        summary: `${leadershipFilled}/8 leadership fields filled across current and incoming teams.`,
        metrics: [
          { k: "Leadership", v: `${leadershipFilled}/8`, sub: "Charge/resource/CTA/PCA resource" },
          { k: "Oncoming Staff", v: String(oncomingStaffCount), sub: "Latest snapshot" },
          { k: "Coverage Gaps", v: String(uncoveredTotal), sub: "Latest snapshot" }
        ],
        bullets: [
          "Use before shift change to catch missing roles or open coverage gaps.",
          "High-risk carryover should be reviewed when oncoming assignments are incomplete.",
          "This supports safer handoffs and cleaner leadership continuity."
        ]
      }
    ].map((r) => ({ ...r, level: riskLevel(r.score) }));
  }

  function renderAdvancedMetrics(data) {
    const root = $("advancedMetricsRoot");
    if (!root) return;
    const filtered = applyControls(data);
    const reports = buildReports(filtered);
    const rows = filtered.rows;
    const snapshots = filtered.snapshots;
    const staff = filtered.staff;
    const events = filtered.events;
    const avgScore = reports.length ? reports.reduce((s, r) => s + num(r.score, 0), 0) / reports.length : 0;
    const highReports = reports.filter((r) => r.level === "High").length;
    const latest = getLatestSnapshot(snapshots);
    const unitLabel = (window.availableUnits || []).find((u) => String(u?.unit_id || "") === activeUnitId());
    const unitName = unitLabel?.unit?.name || unitLabel?.units?.name || unitLabel?.unit?.code || unitLabel?.units?.code || activeUnitId() || "Selected unit";

    if (!rows.length && !snapshots.length && !staff.length) {
      root.innerHTML = `
        <div class="staff-card">
          <div class="staff-card-header">No Advanced Metrics Yet</div>
          <div style="font-size:14px;line-height:1.45;color:#475569;">
            No finalized shift metrics were found for ${esc(unitName)} in this filter. Finalize at least one shift for this unit, then reload this tab.
          </div>
        </div>
      `;
      setStatus(`Loaded ${esc(unitName)}: no finalized data in this filter.`);
      return;
    }

    root.innerHTML = `
      <div class="staff-card">
        <div class="staff-card-header">Advanced Metrics Summary</div>
        <div class="advanced-summary-grid">
          <div class="advanced-summary-tile"><span>Unit</span><strong>${esc(unitName)}</strong><small>Active unit filter</small></div>
          <div class="advanced-summary-tile"><span>Shifts</span><strong>${rows.length}</strong><small>Selected window</small></div>
          <div class="advanced-summary-tile"><span>Staff Rows</span><strong>${staff.length}</strong><small>RN/PCA worked-shift rows</small></div>
          <div class="advanced-summary-tile"><span>Events</span><strong>${events.length}</strong><small>Audit events loaded</small></div>
          <div class="advanced-summary-tile"><span>Risk Avg</span><strong>${avgScore.toFixed(0)}</strong><small>${highReports} high report(s)</small></div>
          <div class="advanced-summary-tile"><span>Latest Snapshot</span><strong>${esc(latest ? `${latest.shift_date} ${latest.shift_type}` : "-")}</strong><small>Handoff/coverage basis</small></div>
        </div>
      </div>
      <div class="staff-card">
        <div class="staff-card-header">Report Index</div>
        ${reportRows(reports)}
      </div>
      <div class="advanced-report-grid">
        ${reports.map(metricCard).join("")}
      </div>
    `;

    setStatus(`Loaded ${unitName}: ${rows.length} shifts, ${snapshots.length} snapshots, ${staff.length} staff rows, ${events.length} events.`);
  }

  async function loadAdvancedMetrics() {
    const reqId = ++__req;
    if (!activeUnitId()) {
      setStatus("No active unit selected.", true);
      return;
    }
    if (!sbReady()) {
      setStatus("Supabase is not ready. Sign in and select a unit, then reload.", true);
      return;
    }
    const uid = activeUnitId();
    setStatus("Loading advanced metrics...");
    try {
      const [a, s, st, e] = await Promise.all([
        window.sb.client.from("analytics_shift_metrics").select("*").eq("unit_id", uid).order("shift_date", { ascending: false }).limit(5000),
        window.sb.client.from("shift_snapshots").select("*").eq("unit_id", uid).order("shift_date", { ascending: false }).limit(5000),
        window.sb.client.from("staff_shift_metrics").select("*").eq("unit_id", uid).order("shift_date", { ascending: false }).limit(8000),
        window.sb.client.from("audit_events").select("created_at,ts,event_type,payload,unit_id,shift_key").eq("unit_id", uid).order("created_at", { ascending: true }).limit(15000)
      ]);
      if (reqId !== __req) return;
      const data = {
        analytics: safeArray(a.data),
        snapshots: safeArray(s.data),
        staff: safeArray(st.data),
        events: safeArray(e.data)
      };
      __lastData = data;
      renderAdvancedMetrics(data);
    } catch (err) {
      if (reqId !== __req) return;
      setStatus(`Advanced metrics load failed: ${String(err?.message || err)}`, true);
    }
  }

  function wire() {
    const btn = $("btnLoadAdvancedMetrics");
    if (btn && !btn.__advancedMetricsWired) {
      btn.__advancedMetricsWired = true;
      btn.addEventListener("click", loadAdvancedMetrics);
    }
    ["advancedFrom", "advancedTo", "advancedShiftType", "advancedInterval"].forEach((id) => {
      const el = $(id);
      if (el && !el.__advancedMetricsWired) {
        el.__advancedMetricsWired = true;
        el.addEventListener("change", () => {
          if (__lastData) renderAdvancedMetrics(__lastData);
        });
      }
    });
  }

  window.advancedMetrics = window.advancedMetrics || {};
  window.advancedMetrics.load = loadAdvancedMetrics;
  window.advancedMetrics.render = () => { if (__lastData) renderAdvancedMetrics(__lastData); else loadAdvancedMetrics(); };

  document.addEventListener("DOMContentLoaded", wire);
  setTimeout(wire, 0);
})();
