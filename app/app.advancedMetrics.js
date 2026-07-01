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
  const normalizeShift = (s) => {
    const v = String(s || "").trim().toLowerCase();
    if (v === "day" || v.includes("day")) return "day";
    if (v === "night" || v === "noc" || v.includes("night") || v.includes("noc")) return "night";
    return v;
  };
  const shiftRank = (s) => normalizeShift(s) === "day" ? 1 : 2;
  const shiftKey = (date, shift) => `${date}|${normalizeShift(shift)}`;
  const ymd = (v) => {
    const d = new Date(v || Date.now());
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
  };

  const ACUITY_KEYS = ["tele","drip","nih","bg","ciwa","cows","psych","prns","emu","restraint","sitter","vpo","isolation","admit","lateDc"];
  const HIGH_RISK_KEYS = ["sitter","vpo","restraint","ciwa","cows","psych","prns","nih","emu","isolation"];
  const SKIN_PROXY_KEYS = ["q2turns","q2Turns","strictIo","heavy","feeder","foley"];
  const PCA_BURDEN_KEYS = ["chg","q2turns","q2Turns","feeder","isolation"];

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

  function isFillerStaffName(name) {
    const n = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!n) return true;
    return (
      /^incoming\s+(rn|pca)\s*\d*$/.test(n) ||
      /^current\s+(rn|pca)\s*\d*$/.test(n) ||
      /^oncoming\s+(rn|pca)\s*\d*$/.test(n) ||
      /^(noc|day|night)\s+(rn|pca)\s*\d*$/.test(n) ||
      /^(rn|pca)\s*staff$/.test(n) ||
      /^(rn|pca)\s*\d+$/.test(n) ||
      /^unknown\s+staff$/.test(n)
    );
  }

  function eventType(ev) {
    return String(ev?.event_type || ev?.type || "").trim().toUpperCase();
  }

  function eventDate(ev) {
    return ymd(ev?.created_at || ev?.ts || Date.now());
  }

  function rnPatientScore(p) {
    if (!p || p.isEmpty) return 0;
    let score = 1;
    if (p.drip || p.drips) score += 3;
    if (p.nih) score += 3;
    if (p.bg || p.bgChecks) score += 3;
    if (p.tf) score += 2;
    if (p.ciwa || p.ciwaCows) score += 3;
    if (p.cows) score += 3;
    if (p.psych) score += 3;
    if (p.prns) score += 3;
    if (p.emu) score += 3;
    if (p.restraint || p.restraints) score += 3;
    if (p.sitter) score += 3;
    if (p.vpo) score += 3;
    if (p.isolation || p.iso) score += 1;
    if (p.admit) score += 3;
    if (p.lateDc) score += 1;
    return score;
  }

  function pcaPatientScore(p) {
    if (!p || p.isEmpty) return 0;
    let score = 1;
    if (p.chg) score += 1;
    if (p.q2turns || p.q2Turns) score += 1;
    if (p.isolation || p.iso) score += 1;
    if (p.feeder || p.feeders) score += 1;
    return score;
  }

  function rnComboBonus(p) {
    if (!p || p.isEmpty) return 0;
    let bonus = 0;
    const behavior = !!(p.ciwa || p.cows || p.ciwaCows || p.psych || p.prns);
    if (p.sitter && (p.restraint || p.restraints)) bonus += 3;
    if (behavior && p.sitter) bonus += 3;
    if (p.emu && p.sitter) bonus += 3;
    if ((p.drip || p.drips) && behavior) bonus += 3;
    if ((p.drip || p.drips) && p.emu) bonus += 3;
    if ((p.drip || p.drips) && p.sitter) bonus += 4;
    if (p.nih && (p.bg || p.bgChecks)) bonus += 2;
    return bonus;
  }

  function rnStackingBonus(patients) {
    const pts = safeArray(patients).filter((p) => p && !p.isEmpty);
    const bg = pts.filter((p) => p.bg || p.bgChecks).length;
    const iso = pts.filter((p) => p.isolation || p.iso).length;
    const drip = pts.filter((p) => p.drip || p.drips).length;
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

  function workloadScoreFor(role, patients) {
    const pts = safeArray(patients).filter((p) => p && !p.isEmpty);
    if (String(role || "").toUpperCase() === "PCA") {
      return pts.reduce((sum, p) => sum + pcaPatientScore(p), 0);
    }
    return pts.reduce((sum, p) => sum + rnPatientScore(p) + rnComboBonus(p), 0) + rnStackingBonus(pts);
  }

  function rowDetails(row) {
    const d = row?.details;
    if (d && typeof d === "object") return d;
    if (typeof d === "string") {
      try { return JSON.parse(d) || {}; } catch {}
    }
    return {};
  }

  function displayStaffName(row) {
    const details = rowDetails(row);
    return String(
      row?.staff_name ||
      row?.name ||
      details.staff_name ||
      details.name ||
      details.owner_name ||
      details.display_name ||
      ""
    ).trim();
  }

  function scoringSourceLabel(row) {
    const details = rowDetails(row);
    if (details.recalculated_from_snapshot) return "Current";
    if (details.score_fallback_reason === "missing_patient_ids") return "Stored: no patient IDs";
    if (details.score_fallback_reason === "missing_snapshot") return "Stored: no snapshot";
    if (details.score_fallback_reason === "missing_snapshot_patients") return "Stored: no patient list";
    if (details.score_fallback_reason === "no_active_assigned_patients") return "Stored: no active pts";
    return "Stored";
  }

  function recalcStaffRowsWithCurrentScoring(staff, snapshots) {
    const snapMap = new Map();
    safeArray(snapshots).forEach((snap) => snapMap.set(shiftKey(snap.shift_date, snap.shift_type), snap));
    return safeArray(staff).map((row) => {
      const details = rowDetails(row);
      const ids = safeArray(details.patient_ids).map(Number).filter(Number.isFinite);
      if (!ids.length) return { ...row, details: { ...details, score_fallback_reason: "missing_patient_ids" } };
      const snap = snapMap.get(shiftKey(row.shift_date, row.shift_type));
      if (!snap) return { ...row, details: { ...details, score_fallback_reason: "missing_snapshot" } };
      const patients = safeArray(snap?.state?.patients);
      if (!patients.length) return { ...row, details: { ...details, score_fallback_reason: "missing_snapshot_patients" } };
      const patientById = new Map(patients.map((p) => [Number(p?.id), p]));
      const assigned = ids.map((id) => patientById.get(id)).filter((p) => p && !p.isEmpty);
      if (!assigned.length) return { ...row, details: { ...details, score_fallback_reason: "no_active_assigned_patients" } };
      return {
        ...row,
        details: { ...details, analytics_scoring_version: "2026-07-01-current", recalculated_from_snapshot: true },
        patients_assigned: assigned.length,
        workload_score: workloadScoreFor(row.role, assigned)
      };
    });
  }

  function extractAnalyticsRows(data, shiftFilter) {
    const by = new Map();
    safeArray(data.analytics).forEach((row) => {
      const date = row.shift_date || row.date || "";
      const shift = normalizeShift(row.shift_type || row.shift || "");
      if (!date || (shiftFilter && shift !== shiftFilter)) return;
      const metrics = row.metrics && typeof row.metrics === "object" ? row.metrics : {};
      const tags = row.tag_counts && typeof row.tag_counts === "object" ? row.tag_counts : (metrics.tag_counts || {});
      const timeline = metrics.timeline_summary && typeof metrics.timeline_summary === "object" ? metrics.timeline_summary : {};
      by.set(shiftKey(date, shift), {
        date,
        shift,
        totalPts: num(row.total_pts ?? metrics?.totals?.total_pts, 0),
        admits: num(row.admits ?? metrics?.totals?.admits, 0),
        discharges: num(row.discharges ?? metrics?.totals?.discharges, 0),
        acuityChanges: num(metrics?.totals?.acuity_changes, 0),
        assignmentChanges: num(metrics?.totals?.assignment_changes, 0),
        eventCount: num(metrics?.totals?.event_count, 0),
        timelineSummary: timeline,
        tagsObj: tags || {}
      });
    });

    safeArray(data.snapshots).forEach((snap) => {
      const date = snap.shift_date || "";
      const shift = normalizeShift(snap.shift_type || "");
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
        timelineSummary: state.timeline_summary || {},
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
      if (!existing.timelineSummary || !Object.keys(existing.timelineSummary || {}).length) existing.timelineSummary = fallback.timelineSummary;
    });

    return Array.from(by.values())
      .sort((a, b) => a.date.localeCompare(b.date) || (shiftRank(a.shift) - shiftRank(b.shift)));
  }

  function applyControls(data) {
    const shift = normalizeShift($("advancedShiftType")?.value || "");
    const shiftFilter = shift === "day" || shift === "night" ? shift : "";
    const from = String($("advancedFrom")?.value || "");
    const to = String($("advancedTo")?.value || "");
    const interval = String($("advancedInterval")?.value || "all");

    const inDate = (date) => (!from || date >= from) && (!to || date <= to);
    const rows = extractAnalyticsRows(data, shiftFilter)
      .filter((r) => inDate(r.date));
    const snapshots = safeArray(data.snapshots)
      .filter((s) => s.shift_date && inDate(s.shift_date) && (!shiftFilter || normalizeShift(s.shift_type) === shiftFilter))
      .sort((a, b) => String(a.shift_date).localeCompare(String(b.shift_date)) || (shiftRank(a.shift_type) - shiftRank(b.shift_type)));
    const staffRaw = safeArray(data.staff)
      .filter((r) => r.shift_date && inDate(r.shift_date) && (!shiftFilter || normalizeShift(r.shift_type) === shiftFilter));
    const staff = recalcStaffRowsWithCurrentScoring(staffRaw, snapshots);
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

  function reportContext(title) {
    const map = {
      "Shift Workload Equity": {
        focus: "Acuity balance",
        counted: "RN/PCA workload scores, patient counts, high-load rows",
        use: "Balance assignments before shift start and spot repeated heavy loads."
      },
      "Hand-off Efficiency": {
        focus: "Report burden",
        counted: "Finalized shift-change report sources received and destinations given",
        use: "Reduce how many staff each person must find or hear from at shift change."
      },
      "High-Risk Patient Coverage": {
        focus: "Patient safety",
        counted: "Sitter, VPO, restraint, CIWA, NIH, EMU, isolation, coverage gaps",
        use: "Check that high-risk patients have RN/PCA coverage and resource support."
      },
      "Staff Load and Burnout Risk": {
        focus: "Staff support",
        counted: "Average workload, high-load rows, admit/discharge flow",
        use: "Identify repeated high-exposure staff and where support may be needed."
      },
      "PCA Rounding and Care Burden": {
        focus: "Care burden",
        counted: "PCA patients plus CHG, totals, isolation, and feeder flags",
        use: "Plan PCA/resource rounding support around the simplified workload score."
      },
      "Admit and Discharge Flow": {
        focus: "Unit flow",
        counted: "Admits, discharges, net flow per selected shift window",
        use: "Show workload that census alone misses."
      },
      "Pressure Injury Prevention Coverage": {
        focus: "Skin safety",
        counted: "Totals, feeder, isolation, CHG, and PCA patient load",
        use: "Identify assignments needing turn/skin-care support."
      },
      "Leadership Handoff Quality": {
        focus: "Continuity",
        counted: "Charge/resource/CTA/PCA resource fields, oncoming staff, gaps",
        use: "Catch missing leadership coverage before handoff."
      }
    };
    return map[title] || { focus: "Operations", counted: "Selected shift metrics", use: "Use as a leadership review signal." };
  }

  function reportPriority(title) {
    const order = [
      "Shift Workload Equity",
      "Hand-off Efficiency",
      "High-Risk Patient Coverage",
      "Staff Load and Burnout Risk",
      "PCA Rounding and Care Burden",
      "Admit and Discharge Flow",
      "Pressure Injury Prevention Coverage",
      "Leadership Handoff Quality"
    ];
    const idx = order.indexOf(title);
    return idx === -1 ? 999 : idx;
  }

  function metricCard({ title, score, level, summary, metrics, bullets, detailsHtml }) {
    const safeScore = Math.max(0, Math.min(100, Math.round(num(score, 0))));
    const label = level || riskLevel(safeScore);
    const context = reportContext(title);
    return `
      <div class="advanced-report-card">
        <div class="advanced-report-head">
          <div>
            <div class="advanced-report-title">${esc(title)}</div>
            <div class="advanced-report-summary">${esc(summary || "")}</div>
            <div style="margin-top:6px;font-size:12px;color:#64748b;">
              <strong>${esc(context.focus)}:</strong> ${esc(context.use)}
            </div>
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
        ${detailsHtml || ""}
      </div>
    `;
  }

  function reportRows(reports) {
    return `
      <div class="advanced-table-wrap">
        <table class="advanced-report-table">
          <thead>
            <tr><th>Report</th><th>Focus</th><th>What Is Counted</th><th>How To Use It</th><th>Level</th></tr>
          </thead>
          <tbody>
            ${reports.map((r) => {
              const context = reportContext(r.title);
              return `
                <tr>
                  <td><strong>${esc(r.title)}</strong><br><small>${Math.round(num(r.score, 0))}/100</small></td>
                  <td>${esc(context.focus)}</td>
                  <td>${esc(context.counted)}</td>
                  <td>${esc(context.use)}</td>
                  <td>${esc(r.level || riskLevel(r.score))}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  window.__advancedMetricsBuildReports = buildReports;
  window.__advancedMetricsReportRows = reportRows;
  window.__advancedMetricsMetricCard = metricCard;

  function aggregateStaffLeaderboard(staff) {
    const groups = new Map();
    safeArray(staff).forEach((row) => {
      const role = String(row.role || "").toUpperCase();
      const name = displayStaffName(row);
      if ((role !== "RN" && role !== "PCA") || !name) return;
      if (isFillerStaffName(name)) return;
      const key = `${role}|${name.toLowerCase().replace(/\s+/g, " ")}`;
      if (!groups.has(key)) {
        groups.set(key, {
          role,
          name,
          shifts: 0,
          loadTotal: 0,
          patientTotal: 0,
          admits: 0,
          discharges: 0,
          acuityChanges: 0,
          assignmentChanges: 0,
          starterRows: 0
        });
      }
      const rec = groups.get(key);
      const details = row.details && typeof row.details === "object" ? row.details : {};
      rec.shifts += 1;
      rec.loadTotal += num(row.workload_score, 0);
      rec.patientTotal += num(row.patients_assigned, 0);
      rec.admits += num(details.admits, 0);
      rec.discharges += num(details.discharges, 0);
      rec.acuityChanges += num(details.acuity_changes, 0);
      rec.assignmentChanges += num(details.assignment_changes, 0);
      if (details.starter_only) rec.starterRows += 1;
    });

    return Array.from(groups.values()).map((rec) => ({
      ...rec,
      avgLoad: rec.shifts ? rec.loadTotal / rec.shifts : 0,
      avgPatients: rec.shifts ? rec.patientTotal / rec.shifts : 0,
      events: rec.admits + rec.discharges + rec.acuityChanges + rec.assignmentChanges
    }));
  }

  function workloadTier(score, role) {
    const s = num(score, 0);
    const rn = String(role || "").toUpperCase() === "RN";
    if (s <= (rn ? 10 : 14)) return "Low";
    if (s <= (rn ? 16 : 22)) return "Moderate";
    if (s <= (rn ? 26 : 32)) return "High";
    return "Very High";
  }

  function latestDateInRows(rows) {
    return safeArray(rows)
      .map((r) => String(r.shift_date || r.date || "").slice(0, 10))
      .filter(Boolean)
      .sort()
      .slice(-1)[0] || "";
  }

  function rollingStartDate(latestDate, days = 14) {
    const d = new Date(`${latestDate || ymd()}T00:00:00`);
    if (!Number.isFinite(d.getTime())) return "";
    d.setDate(d.getDate() - Math.max(0, days - 1));
    return d.toISOString().slice(0, 10);
  }

  function rowShiftLabel(row) {
    const shift = normalizeShift(row?.shift_type || row?.shift || "");
    return shift === "night" ? "NOC" : (shift === "day" ? "Day" : String(row?.shift_type || row?.shift || "-"));
  }

  function highLoadThreshold(role) {
    return String(role || "").toUpperCase() === "PCA" ? 23 : 17;
  }

  function highLoadStaffRows(staff, startDate, endDate) {
    return safeArray(staff)
      .filter((row) => {
        const role = String(row.role || "").toUpperCase();
        const date = String(row.shift_date || "").slice(0, 10);
        const load = num(row.workload_score, 0);
        if (role !== "RN" && role !== "PCA") return false;
        if (!date || (startDate && date < startDate) || (endDate && date > endDate)) return false;
        return load >= highLoadThreshold(role);
      })
      .sort((a, b) =>
        num(b.workload_score, 0) - num(a.workload_score, 0) ||
        String(b.shift_date || "").localeCompare(String(a.shift_date || "")) ||
        displayStaffName(a).localeCompare(displayStaffName(b))
      );
  }

  function highLoadRowsTable(rows, title, limit = 8) {
    const list = safeArray(rows).slice(0, limit);
    return `
      <div class="advanced-detail-block">
        <div class="advanced-detail-title">${esc(title)}</div>
        <div class="advanced-table-wrap">
          <table class="advanced-report-table advanced-report-table--compact">
            <thead>
              <tr><th>Staff</th><th>Role</th><th>Shift</th><th>Load</th><th>Pts</th><th>Tier</th><th>Score</th></tr>
            </thead>
            <tbody>
              ${list.length ? list.map((r) => {
                const role = String(r.role || "").toUpperCase();
                const load = num(r.workload_score, 0);
                const shift = `${String(r.shift_date || "-").slice(5)} ${rowShiftLabel(r)}`;
                return `
                  <tr>
                    <td>${esc(displayStaffName(r) || "-")}</td>
                    <td>${esc(role || "-")}</td>
                    <td>${esc(shift)}</td>
                    <td>${load.toFixed(1)}</td>
                    <td>${num(r.patients_assigned, 0).toFixed(0)}</td>
                    <td>${esc(workloadTier(load, role))}</td>
                    <td>${esc(scoringSourceLabel(r))}</td>
                  </tr>
                `;
              }).join("") : `<tr><td colspan="7">No high-load staff rows in this window.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function roleSpreadStats(staff, role) {
    const groups = new Map();
    safeArray(staff).forEach((row) => {
      const rowRole = String(row.role || "").toUpperCase();
      if (rowRole !== role) return;
      const key = shiftKey(row.shift_date, row.shift_type);
      if (!key || key === "|") return;
      const load = num(row.workload_score, 0);
      if (load <= 0) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(load);
    });
    const gaps = Array.from(groups.values())
      .filter((loads) => loads.length >= 2)
      .map((loads) => Math.max(...loads) - Math.min(...loads));
    return {
      count: gaps.length,
      avg: gaps.length ? gaps.reduce((s, v) => s + v, 0) / gaps.length : 0,
      max: gaps.length ? Math.max(...gaps) : 0
    };
  }

  function leaderboardTable(title, rows, mode) {
    const list = safeArray(rows);
    return `
      <div class="advanced-report-card">
        <div class="advanced-report-title">${esc(title)}</div>
        <div class="advanced-report-summary">${esc(mode === "high" ? "Highest average workload in selected window." : "Lowest average workload in selected window.")}</div>
        <div class="advanced-table-wrap" style="margin-top:10px;">
          <table class="advanced-report-table">
            <thead>
              <tr><th>Staff</th><th>Tier</th><th>Avg Load</th><th>Avg Pts</th><th>Rows</th><th>Events</th></tr>
            </thead>
            <tbody>
              ${list.length ? list.map((r) => `
                <tr>
                  <td>${esc(r.name)}${r.starterRows ? ` <small>(${r.starterRows} start)</small>` : ""}</td>
                  <td>${esc(workloadTier(r.avgLoad, r.role))}</td>
                  <td>${r.avgLoad.toFixed(1)}</td>
                  <td>${r.avgPatients.toFixed(1)}</td>
                  <td>${r.shifts}</td>
                  <td>${r.events}</td>
                </tr>
              `).join("") : `<tr><td colspan="6">No matching staff rows.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderLeaderboard(staff) {
    const groups = aggregateStaffLeaderboard(staff).filter((r) => r.shifts > 0);
    const byRole = (role) => groups.filter((r) => r.role === role && r.avgLoad > 0);
    const high = (role) => byRole(role).sort((a, b) => b.avgLoad - a.avgLoad || b.avgPatients - a.avgPatients || a.name.localeCompare(b.name)).slice(0, 5);
    const low = (role) => byRole(role).sort((a, b) => a.avgLoad - b.avgLoad || a.avgPatients - b.avgPatients || a.name.localeCompare(b.name)).slice(0, 5);
    return `
      <div class="staff-card">
        <div class="staff-card-header">Workload Leaderboard</div>
        <div style="font-size:12px;line-height:1.45;color:#475569;margin-bottom:10px;">
          Top and bottom average workload groups for the selected window. Use this as an equity signal, not a performance judgment.
        </div>
        <div class="advanced-report-grid">
          ${leaderboardTable("RN Top 5 Highest", high("RN"), "high")}
          ${leaderboardTable("RN Top 5 Lowest", low("RN"), "low")}
          ${leaderboardTable("PCA Top 5 Highest", high("PCA"), "high")}
          ${leaderboardTable("PCA Top 5 Lowest", low("PCA"), "low")}
        </div>
      </div>
    `;
  }

  function buildReports(filtered) {
    const rows = filtered.rows;
    const snapshots = filtered.snapshots;
    const staff = filtered.staff.filter((r) => !isFillerStaffName(displayStaffName(r)));
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
    const skinProxyCount = countTaggedPatients(allPatients, SKIN_PROXY_KEYS);
    const pcaBurdenTags = tagCountsFromPatients(allPatients, PCA_BURDEN_KEYS);
    const highRiskTags = tagCountsFromPatients(allPatients, HIGH_RISK_KEYS);
    const skinTags = tagCountsFromPatients(allPatients, SKIN_PROXY_KEYS);
    const admits = total(rows, (r) => r.admits);
    const discharges = total(rows, (r) => r.discharges);
    const moves = total(rows, (r) => r.assignmentChanges) || events.filter((ev) => eventType(ev) === "ASSIGNMENT_MOVED").length;
    const acuityChanges = total(rows, (r) => r.acuityChanges) || events.filter((ev) => eventType(ev) === "ACUITY_CHANGED").length;
    const timelineAcuityEvents = total(rows, (r) => r.timelineSummary?.acuity_timeline_events) ||
      events.filter((ev) => eventType(ev) === "ACUITY_CHANGED" && ev?.payload?.acuity_timeline).length;
    const timelineAssignmentEvents = total(rows, (r) => r.timelineSummary?.assignment_timeline_events) ||
      events.filter((ev) => eventType(ev) === "ASSIGNMENT_MOVED" && ev?.payload?.assignment_timeline).length;
    const avgHandoff = (role, key) => {
      const handoffRows = rows.map((r) => r.timelineSummary?.handoff_sources?.[role] || null).filter(Boolean);
      return handoffRows.length
        ? handoffRows.reduce((sum, row) => sum + num(row?.[key], 0), 0) / handoffRows.length
        : 0;
    };
    const handoffRowCount = (role) => rows.map((r) => r.timelineSummary?.handoff_sources?.[role] || null).filter(Boolean).length;
    const maxHandoff = (role, key) => {
      const handoffRows = rows.map((r) => r.timelineSummary?.handoff_sources?.[role] || null).filter(Boolean);
      return handoffRows.length
        ? Math.max(...handoffRows.map((row) => num(row?.[key], 0)))
        : 0;
    };
    const rnOutgoingAvg = avgHandoff("rn", "outgoing_avg_destinations");
    const rnIncomingAvg = avgHandoff("rn", "incoming_avg_sources");
    const pcaOutgoingAvg = avgHandoff("pca", "outgoing_avg_destinations");
    const pcaIncomingAvg = avgHandoff("pca", "incoming_avg_sources");
    const rnIncomingMax = maxHandoff("rn", "incoming_max_sources");
    const rnOutgoingMax = maxHandoff("rn", "outgoing_max_destinations");
    const pcaIncomingMax = maxHandoff("pca", "incoming_max_sources");
    const pcaOutgoingMax = maxHandoff("pca", "outgoing_max_destinations");
    const rnHandoffRows = handoffRowCount("rn");
    const pcaHandoffRows = handoffRowCount("pca");
    const handoffPressure = Math.max(rnIncomingAvg, rnOutgoingAvg, pcaIncomingAvg, pcaOutgoingAvg);
    const uncoveredTotal = latestCoverage.uncoveredRn.length + latestCoverage.uncoveredPca.length;
    const latestStaffDate = latestDateInRows(staff.length ? staff : rows);
    const rolling14Start = rollingStartDate(latestStaffDate, 14);
    const rollingHighLoadStaff = highLoadStaffRows(staff, rolling14Start, latestStaffDate);
    const leadership = latest?.state?.leadership || {};
    const currentLeadership = leadership.current || {};
    const incomingLeadership = leadership.incoming || {};
    const leadershipFilled = ["charge","mentor","cta","pcaResource"].filter((k) => currentLeadership[k]).length +
      ["charge","mentor","cta","pcaResource"].filter((k) => incomingLeadership[k]).length;
    const leadershipPct = pct(leadershipFilled, 8);
    const oncoming = latest?.state?.oncoming_assignment || {};
    const oncomingStaffCount = safeArray(oncoming.nurses).length + safeArray(oncoming.pcas).length;

    const flowBurden = shiftCount ? (admits + discharges) / shiftCount : 0;
    const rnSpread = spread(rnLoads);
    const pcaSpread = spread(pcaLoads);
    const rnGapStats = roleSpreadStats(staff, "RN");
    const pcaGapStats = roleSpreadStats(staff, "PCA");
    const maxRoleSpread = Math.max(rnSpread, pcaSpread);
    const loadRisk = Math.min(100, (maxRoleSpread * 2.2) + pct(rollingHighLoadStaff.length, Math.max(1, staffCount)) * 0.7);
    const coverageRisk = Math.min(100, pct(uncoveredTotal, Math.max(1, latestCoverage.pats.length * 2)));

    return [
      {
        title: "Shift Workload Equity",
        score: Math.min(100, maxRoleSpread * 3 + pct(rollingHighLoadStaff.length, Math.max(1, staffCount)) * 0.7),
        summary: `RN spread ${rnSpread.toFixed(1)} and PCA spread ${pcaSpread.toFixed(1)} in selected staff rows.`,
        metrics: [
          { k: "RN Avg Load", v: avg(rnLoads).toFixed(1), sub: "Selected staff rows" },
          { k: "PCA Avg Load", v: avg(pcaLoads).toFixed(1), sub: "Selected staff rows" },
          { k: "RN Gap Max", v: rnGapStats.max.toFixed(1), sub: `${rnGapStats.count} finalized shift(s)` },
          { k: "PCA Gap Max", v: pcaGapStats.max.toFixed(1), sub: `${pcaGapStats.count} finalized shift(s)` },
          { k: "Rolling High Rows", v: String(rollingHighLoadStaff.length), sub: rolling14Start && latestStaffDate ? `${rolling14Start.slice(5)}-${latestStaffDate.slice(5)}` : "Last 14 days" }
        ],
        bullets: [
          `Reviewed ${staffCount} staff-shift rows across ${shiftCount} shift(s).`,
          "RN and PCA workload spreads are calculated separately because the scoring scales are different.",
          `Typical finalized-shift gap in this view: RN avg ${rnGapStats.avg.toFixed(1)}, PCA avg ${pcaGapStats.avg.toFixed(1)}.`,
          "Use named high-load rows below to guide staff support and assignment fairness conversations."
        ],
        detailsHtml: highLoadRowsTable(rollingHighLoadStaff, "Highest workload rows in rolling 14 days", 6)
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
        title: "Hand-off Efficiency",
        score: Math.min(100, handoffPressure * 28 + moves * 5),
        summary: `Finalized shift-change handoffs: RN ${rnIncomingAvg.toFixed(1)} received/${rnOutgoingAvg.toFixed(1)} given, PCA ${pcaIncomingAvg.toFixed(1)} received/${pcaOutgoingAvg.toFixed(1)} given.`,
        metrics: [
          { k: "RN Received From", v: rnIncomingAvg.toFixed(1), sub: `Max ${rnIncomingMax.toFixed(0)} source RN(s)` },
          { k: "RN Gave Report To", v: rnOutgoingAvg.toFixed(1), sub: `Max ${rnOutgoingMax.toFixed(0)} destination RN(s)` },
          { k: "PCA Received From", v: pcaIncomingAvg.toFixed(1), sub: `Max ${pcaIncomingMax.toFixed(0)} source PCA(s)` },
          { k: "PCA Gave Report To", v: pcaOutgoingAvg.toFixed(1), sub: `Max ${pcaOutgoingMax.toFixed(0)} destination PCA(s)` }
        ],
        bullets: [
          `Averages use finalized shift-change handoff summaries stored in analytics_shift_metrics.metrics.timeline_summary.`,
          `Handoff rows available in this view: RN ${rnHandoffRows}, PCA ${pcaHandoffRows}.`,
          "Received-from counts show how many offgoing staff an oncoming staff member must hear report from.",
          "Gave-report-to counts show how many oncoming staff an offgoing staff member must find before leaving.",
          `${moves} live assignment movement event(s) and ${timelineAssignmentEvents} assignment timeline event(s) were captured.`
        ]
      },
      {
        title: "Staff Load and Burnout Risk",
        score: Math.min(100, loadRisk + flowBurden * 4),
        summary: `${rollingHighLoadStaff.length} high-load staff-shift row(s) in the rolling 14-day view.`,
        metrics: [
          { k: "RN High Rows", v: String(rollingHighLoadStaff.filter((r) => String(r.role || "").toUpperCase() === "RN").length), sub: "Rolling 14 days" },
          { k: "PCA High Rows", v: String(rollingHighLoadStaff.filter((r) => String(r.role || "").toUpperCase() === "PCA").length), sub: "Rolling 14 days" },
          { k: "Flow Burden", v: flowBurden.toFixed(1), sub: "Admits + discharges per shift" }
        ],
        bullets: [
          `High-load threshold starts at RN ${highLoadThreshold("RN")} and PCA ${highLoadThreshold("PCA")} using the current scoring model.`,
          "Use longitudinally to identify repeated high-load exposure by name and shift.",
          "Keep this framed as staff support and assignment equity.",
          "Pair with staffing context before making operational conclusions."
        ],
        detailsHtml: highLoadRowsTable(rollingHighLoadStaff, "High-load staff-shift rows needing review", 10)
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
          "PCA burden score counts 1 point per patient plus 1 each for CHG, totals, isolation, and feeder.",
          "A QR rounding feed would unlock elapsed-time-since-last-round reporting.",
          "Resource PCA coverage should be reviewed when care-burden tags cluster."
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
          "Current proxy emphasizes totals, feeders, isolation, CHG, and patient load.",
          "Add explicit skin-risk and turn-completion events for stronger process-measure reporting.",
          "Best used as an interdisciplinary support signal."
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
    ].map((r) => ({ ...r, level: riskLevel(r.score) }))
      .sort((a, b) => reportPriority(a.title) - reportPriority(b.title));
  }

  function renderAdvancedMetrics(data) {
    const root = $("advancedMetricsRoot");
    if (!root) return;
    const filtered = applyControls(data);
    const reports = buildReports(filtered);
    const rows = filtered.rows;
    const snapshots = filtered.snapshots;
    const staff = filtered.staff.filter((r) => !isFillerStaffName(displayStaffName(r)));
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

    const staffReports = reports.filter((r) => /staff|workload|hand-off|pca/i.test(String(r.title || "")));
    root.innerHTML = `
      <div class="staff-card">
        <div class="staff-card-header">Staff Metrics Summary</div>
        <div class="advanced-summary-grid">
          <div class="advanced-summary-tile"><span>Unit</span><strong>${esc(unitName)}</strong><small>Active unit filter</small></div>
          <div class="advanced-summary-tile"><span>Shifts</span><strong>${rows.length}</strong><small>Selected window</small></div>
          <div class="advanced-summary-tile"><span>Staff Rows</span><strong>${staff.length}</strong><small>RN/PCA worked-shift rows</small></div>
          <div class="advanced-summary-tile"><span>Events</span><strong>${events.length}</strong><small>Audit events loaded</small></div>
          <div class="advanced-summary-tile"><span>Priority Avg</span><strong>${avgScore.toFixed(0)}</strong><small>${highReports} high-priority report(s)</small></div>
          <div class="advanced-summary-tile"><span>Latest Snapshot</span><strong>${esc(latest ? `${latest.shift_date} ${latest.shift_type}` : "-")}</strong><small>Handoff/coverage basis</small></div>
        </div>
      </div>
      ${renderLeaderboard(staff)}
      <div class="advanced-report-grid">
        ${staffReports.map(metricCard).join("")}
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
