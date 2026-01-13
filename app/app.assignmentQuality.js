// app/app.assignmentQuality.js
// ---------------------------------------------------------
// Assignment Quality Index (AQI)
// - Draggable modal report for ONCOMING assignments (RN + PCA)
// - Scores: hard rules, report sources, hallway spread (soft)
// - Uses existing engine:
//   - window.evaluateAssignmentHardRules(owners, role)
//   - incomingNurses / incomingPcas
//   - getPatientById / getRoomLabelForPatient / getRoomNumber (optional)
//   - currentNurses/currentPcas for report sources
//
// NEW (Jan 2026):
// ✅ Strong report-source constraints for ONCOMING (RN):
//    - 4 patients => max 3 report sources
//    - 3 patients => max 2 report sources
//    Implemented as a steep penalty + surfaced in UI.
// ---------------------------------------------------------

(function () {
  function safeArray(v) { return Array.isArray(v) ? v : []; }
  function $(id) { return document.getElementById(id); }

  function getPatient(pid) {
    try { return (typeof window.getPatientById === "function") ? window.getPatientById(pid) : null; }
    catch { return null; }
  }

  function getBedLabel(p) {
    if (!p) return "";
    if (typeof window.getRoomLabelForPatient === "function") return window.getRoomLabelForPatient(p);
    return String(p.room || p.id || "");
  }

  function getRoomNumberFromPatient(p) {
    if (typeof window.getRoomNumber === "function") {
      const n = window.getRoomNumber(p);
      if (typeof n === "number" && isFinite(n)) return n;
    }
    const label = getBedLabel(p);
    const m = String(label).match(/\d+/);
    return m ? Number(m[0]) : null;
  }

  // -------------------------
  // Report source helpers (from LIVE owners)
  // -------------------------
  function prevOwnerNameForPatient(patientId, role) {
    const pid = Number(patientId);
    if (!pid) return "";

    const owners = (role === "pca") ? safeArray(window.currentPcas) : safeArray(window.currentNurses);
    const found = owners.find(o => safeArray(o.patients).includes(pid));
    if (!found) return "";
    return found.name || (role === "pca" ? `PCA ${found.id}` : `RN ${found.id}`);
  }

  function uniqueReportSourcesCount(patientIds, role) {
    const set = new Set();
    safeArray(patientIds).forEach(pid => {
      const name = prevOwnerNameForPatient(pid, role);
      if (name) set.add(name);
    });
    return set.size;
  }

  // ✅ NEW: allowed report sources (strong constraint for RN oncoming)
  function allowedReportSources(patientCount, role) {
    const n = Number(patientCount) || 0;

    // RN constraints (your rule)
    if (role === "nurse") {
      if (n >= 4) return 3;
      if (n === 3) return 2;
      // 1–2 patients: keep it tight but not punitive
      if (n === 2) return 2;
      if (n === 1) return 1;
      return 2;
    }

    // PCA: keep prior gentle behavior (can tune later)
    // (PCA report source concept is less clinically critical than RN handoff)
    if (role === "pca") {
      if (n >= 8) return 4;
      if (n >= 6) return 3;
      if (n >= 4) return 3;
      if (n === 3) return 2;
      if (n === 2) return 2;
      if (n === 1) return 1;
      return 2;
    }

    return 2;
  }

  // -------------------------
  // Hallway spread (soft metric)
  // -------------------------
  function hallwayStatsForOwner(owner) {
    const ids = safeArray(owner?.patients);
    const rooms = ids
      .map(id => getPatient(id))
      .filter(p => p && !p.isEmpty)
      .map(p => getRoomNumberFromPatient(p))
      .filter(n => typeof n === "number" && isFinite(n))
      .sort((a, b) => a - b);

    if (!rooms.length) {
      return { hasData: false, range: 0, largestGap: 0, clusters: 0, rooms: [] };
    }

    const min = rooms[0];
    const max = rooms[rooms.length - 1];
    const range = max - min;

    let largestGap = 0;
    for (let i = 1; i < rooms.length; i++) {
      const gap = rooms[i] - rooms[i - 1];
      if (gap > largestGap) largestGap = gap;
    }

    const GAP_SPLIT = 7;
    let clusters = 1;
    for (let i = 1; i < rooms.length; i++) {
      if ((rooms[i] - rooms[i - 1]) >= GAP_SPLIT) clusters++;
    }

    return { hasData: true, range, largestGap, clusters, rooms };
    }

  function hallwayPenalty(stats) {
    if (!stats?.hasData) return 0;

    const rangePenalty = Math.min(30, Math.max(0, stats.range));
    const gapPenalty = Math.min(25, Math.max(0, stats.largestGap));
    const clusterPenalty = Math.max(0, (stats.clusters - 1) * 8);

    return rangePenalty * 0.8 + gapPenalty * 1.2 + clusterPenalty;
  }

  function hallwayLabel(stats) {
    if (!stats?.hasData) return "n/a";
    if (stats.clusters >= 2 || stats.largestGap >= 12 || stats.range >= 18) return "Rough";
    if (stats.largestGap >= 8 || stats.range >= 12) return "Moderate";
    return "Tight";
  }

  // -------------------------
  // Hard rule scoring (uses your existing engine)
  // -------------------------
  function hardRuleScoreForOwner(evalObj) {
    const v = safeArray(evalObj?.violations).length;
    const w = safeArray(evalObj?.warnings).length;
    return (v * 18) + (w * 6);
  }

  function buildOwnerRow(owner, evalObj, role) {
    const name = owner?.name || (role === "pca" ? "PCA" : "RN");
    const patientIds = safeArray(owner?.patients);
    const patientCount = patientIds.length;

    const v = safeArray(evalObj?.violations);
    const w = safeArray(evalObj?.warnings);

    const reportSources = uniqueReportSourcesCount(patientIds, role);
    const allowed = allowedReportSources(patientCount, role);
    const over = Math.max(0, reportSources - allowed);

    const hall = hallwayStatsForOwner(owner);
    const hallRating = hallwayLabel(hall);

    const hardPenalty = hardRuleScoreForOwner(evalObj);

    // ✅ NEW: much steeper penalty when over the allowed cap.
    // This makes it act like a strong constraint in the AQI ranking.
    const REPORT_OVER_WEIGHT = (role === "nurse") ? 22 : 10;
    const reportPenalty = over * REPORT_OVER_WEIGHT;

    const hallPenalty = hallwayPenalty(hall) * 0.6;

    const totalPenalty = hardPenalty + reportPenalty + hallPenalty;

    const flagsText =
      v.length
        ? `❗ ${v.map(x => x.tag).slice(0, 3).join(", ")}`
        : w.length
          ? `⚠️ ${w.map(x => x.tag).slice(0, 3).join(", ")}`
          : "OK";

    const roomsText = hall.hasData ? `${hall.rooms.join(", ")}` : "n/a";

    const reportText =
      over > 0
        ? `${reportSources}/${allowed} ⚠︎`
        : `${reportSources}/${allowed}`;

    return {
      name,
      reportSources,
      reportAllowed: allowed,
      reportOver: over,
      reportText,
      hallRating,
      totalPenalty,
      flagsText,
      roomsText,
      patientCount,
      violationCount: v.length,
      warningCount: w.length
    };
  }

  function summarizeGroup(owners, role) {
    const list = safeArray(owners);
    const map = (typeof window.evaluateAssignmentHardRules === "function")
      ? window.evaluateAssignmentHardRules(list, role)
      : null;

    const rows = list.map((o, idx) => {
      const key = o?.name || o?.label || `owner_${idx + 1}`;
      const ev = map ? map[key] : null;
      return buildOwnerRow(o, ev, role);
    });

    rows.sort((a, b) => b.totalPenalty - a.totalPenalty);

    const preventableBreaks = rows.reduce((s, r) => s + (r.violationCount || 0), 0);
    const unavoidableFlags = rows.reduce((s, r) => s + (r.warningCount || 0), 0);

    const avgReport = rows.length
      ? (rows.reduce((s, r) => s + (r.reportSources || 0), 0) / rows.length)
      : 0;

    const overCapCount = rows.reduce((s, r) => s + ((r.reportOver || 0) > 0 ? 1 : 0), 0);

    const hallCounts = { Tight: 0, Moderate: 0, Rough: 0, "n/a": 0 };
    rows.forEach(r => { hallCounts[r.hallRating] = (hallCounts[r.hallRating] || 0) + 1; });

    return {
      rows,
      preventableBreaks,
      unavoidableFlags,
      avgReport: Math.round(avgReport * 10) / 10,
      hallCounts,
      reportOverCapOwners: overCapCount
    };
  }

  // -------------------------
  // “% of best achievable” (simple v1)
  // -------------------------
  function percentOfBestAchievable(summaryRn, summaryPca) {
    const rnPenalty =
      (summaryRn.preventableBreaks * 24) +
      Math.max(0, (summaryRn.avgReport - 2.5)) * 18 +
      (summaryRn.reportOverCapOwners * 10);

    const pcaPenalty =
      (summaryPca.preventableBreaks * 24) +
      Math.max(0, (summaryPca.avgReport - 2.5)) * 18 +
      (summaryPca.reportOverCapOwners * 4);

    const total = rnPenalty + pcaPenalty;
    const pct = Math.max(0, Math.min(100, Math.round(100 - total)));
    return pct;
  }

  // -------------------------
  // Modal UI + Drag behavior
  // -------------------------
  function openModal() {
    const modal = $("aqiModal");
    const body = $("aqiBody");
    if (!modal || !body) {
      alert("AQI modal not found in index.html (aqiModal / aqiBody).");
      return;
    }

    const rnOwners = safeArray(window.incomingNurses);
    const pcaOwners = safeArray(window.incomingPcas);

    if (!rnOwners.length || !pcaOwners.length) {
      body.innerHTML = `<div style="padding:10px;font-weight:700;">Set up ONCOMING RNs/PCAs first (Staffing Details tab), then re-run.</div>`;
      modal.style.display = "flex";
      return;
    }

    if (typeof window.evaluateAssignmentHardRules !== "function") {
      body.innerHTML = `<div style="padding:10px;font-weight:700;">Rules engine not loaded (evaluateAssignmentHardRules missing).</div>`;
      modal.style.display = "flex";
      return;
    }

    const rn = summarizeGroup(rnOwners, "nurse");
    const pca = summarizeGroup(pcaOwners, "pca");
    const pct = percentOfBestAchievable(rn, pca);

    body.innerHTML = `
      <div class="aqi-grid">
        <div class="aqi-card">
          <div class="aqi-kpi">
            <div class="aqi-kpi-label">% of best achievable</div>
            <div class="aqi-kpi-value">${pct}%</div>
            <div class="aqi-kpi-sub">
              Focus order: preventable breaks → report sources → hallway comfort.
            </div>
          </div>
        </div>

        <div class="aqi-card">
          <div class="aqi-section-title">RN summary</div>
          <div class="aqi-line">Preventable rule breaks: <strong>${rn.preventableBreaks}</strong></div>
          <div class="aqi-line">Unavoidable flags: <strong>${rn.unavoidableFlags}</strong></div>
          <div class="aqi-line">Avg report sources: <strong>${rn.avgReport}</strong></div>
          <div class="aqi-line">Owners over cap: <strong>${rn.reportOverCapOwners}</strong></div>
          <div class="aqi-line">Hallway: <strong>Tight ${rn.hallCounts.Tight}</strong> · <strong>Moderate ${rn.hallCounts.Moderate}</strong> · <strong>Rough ${rn.hallCounts.Rough}</strong></div>
          <div class="aqi-line" style="opacity:.85;font-size:12px;margin-top:6px;">
            RN caps: 4 pts → ≤3 sources · 3 pts → ≤2 sources
          </div>
        </div>

        <div class="aqi-card">
          <div class="aqi-section-title">PCA summary</div>
          <div class="aqi-line">Preventable rule breaks: <strong>${pca.preventableBreaks}</strong></div>
          <div class="aqi-line">Unavoidable flags: <strong>${pca.unavoidableFlags}</strong></div>
          <div class="aqi-line">Avg report sources: <strong>${pca.avgReport}</strong></div>
          <div class="aqi-line">Owners over cap: <strong>${pca.reportOverCapOwners}</strong></div>
          <div class="aqi-line">Hallway: <strong>Tight ${pca.hallCounts.Tight}</strong> · <strong>Moderate ${pca.hallCounts.Moderate}</strong> · <strong>Rough ${pca.hallCounts.Rough}</strong></div>
        </div>
      </div>

      <div class="aqi-card" style="margin-top:12px;">
        <div class="aqi-section-title">RN details (worst → best)</div>
        ${renderTable(rn.rows)}
      </div>

      <div class="aqi-card" style="margin-top:12px;">
        <div class="aqi-section-title">PCA details (worst → best)</div>
        ${renderTable(pca.rows)}
      </div>
    `;

    modal.style.display = "flex";
  }

  function closeModal() {
    const modal = $("aqiModal");
    if (modal) modal.style.display = "none";
  }

  function renderTable(rows) {
    const safe = safeArray(rows);
    const tr = safe.map(r => `
      <tr>
        <td><strong>${escapeHtml(r.name)}</strong></td>
        <td style="text-align:center;">${escapeHtml(String(r.flagsText))}</td>
        <td style="text-align:center;">${escapeHtml(String(r.reportText || ""))}</td>
        <td style="text-align:center;">${escapeHtml(String(r.hallRating))}</td>
        <td style="font-size:12px;opacity:.8;">${escapeHtml(String(r.roomsText))}</td>
      </tr>
    `).join("");

    return `
      <div class="aqi-table-wrap">
        <table class="aqi-table">
          <thead>
            <tr>
              <th>Staff</th>
              <th>Rule flags</th>
              <th>Report sources</th>
              <th>Hallway</th>
              <th>Rooms</th>
            </tr>
          </thead>
          <tbody>${tr}</tbody>
        </table>
      </div>
    `;
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function wireDrag() {
    const modal = $("aqiModal");
    const panel = $("aqiPanel");
    const handle = $("aqiDragHandle");
    if (!modal || !panel || !handle) return;

    let isDown = false;
    let startX = 0, startY = 0;
    let origX = 0, origY = 0;

    handle.addEventListener("mousedown", (e) => {
      isDown = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = panel.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;

      panel.style.margin = "0";
      panel.style.position = "fixed";
      panel.style.left = `${origX}px`;
      panel.style.top = `${origY}px`;
      panel.style.transform = "none";

      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDown) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = `${origX + dx}px`;
      panel.style.top = `${origY + dy}px`;
    });

    window.addEventListener("mouseup", () => { isDown = false; });
  }

  window.assignmentQuality = {
    open: openModal,
    close: closeModal
  };

  window.addEventListener("DOMContentLoaded", () => {
    const x = $("aqiClose");
    const modal = $("aqiModal");
    if (x) x.addEventListener("click", closeModal);
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeModal();
      });
    }
    wireDrag();
  });
})();