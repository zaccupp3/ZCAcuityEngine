// app/app.shiftGapPanel.js
// On-demand assignment gap comparison against finalized historical shifts.
(function () {
  if (window.__shiftGapPanelLoaded) return;
  window.__shiftGapPanelLoaded = true;

  const safeArray = (v) => Array.isArray(v) ? v : [];
  const num = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (m) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[m]));
  const activeUnitId = () => (window.activeUnitId ? String(window.activeUnitId) : "");
  const shiftKey = (date, shift) => `${String(date || "").slice(0, 10)}|${normalizeShift(shift)}`;

  let historyCache = null;
  let historyCacheAt = 0;

  function normalizeShift(s) {
    const v = String(s || "").trim().toLowerCase();
    if (v === "day" || v.includes("day")) return "day";
    if (v === "night" || v === "noc" || v.includes("night") || v.includes("noc")) return "night";
    return v;
  }

  function isHoldOwner(owner) {
    if (!owner) return false;
    if (owner.isHold || owner.__hold) return true;
    const name = String(owner.name || "").trim().toLowerCase();
    const type = String(owner.type || "").trim().toLowerCase();
    return Number(owner.id) === 0 || type === "hold" || name.includes("needs to be assigned");
  }

  function rowDetails(row) {
    const d = row?.details;
    if (d && typeof d === "object") return d;
    if (typeof d === "string") {
      try { return JSON.parse(d) || {}; } catch (_) {}
    }
    return {};
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
    const behavior = !!(p.ciwa || p.cows || p.ciwaCows || p.psych || p.prns);
    let bonus = 0;
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

  function currentBoardKey() {
    const oncoming = document.getElementById("oncomingAssignmentTab");
    const live = document.getElementById("liveAssignmentTab");
    if (oncoming && oncoming.style.display !== "none") return "incoming";
    if (live && live.style.display !== "none") return "live";
    return "incoming";
  }

  function currentOwners(role, board) {
    const incoming = board === "incoming";
    if (role === "PCA") return safeArray(incoming ? window.incomingPcas : window.currentPcas).filter((o) => o && !isHoldOwner(o));
    return safeArray(incoming ? window.incomingNurses : window.currentNurses).filter((o) => o && !isHoldOwner(o));
  }

  function currentRoleGap(role, board) {
    const owners = currentOwners(role, board);
    const scores = owners
      .map((owner) => role === "PCA"
        ? (typeof window.getPcaLoadScore === "function" ? window.getPcaLoadScore(owner) : 0)
        : (typeof window.getNurseLoadScore === "function" ? window.getNurseLoadScore(owner) : 0))
      .map((v) => num(v, 0))
      .filter((v) => v > 0);
    return {
      role,
      count: scores.length,
      minLoad: scores.length ? Math.min(...scores) : 0,
      maxLoad: scores.length ? Math.max(...scores) : 0,
      gap: scores.length >= 2 ? Math.max(...scores) - Math.min(...scores) : 0
    };
  }

  function statsFromGaps(gaps) {
    const vals = safeArray(gaps).filter((v) => Number.isFinite(Number(v))).map(Number);
    return {
      shifts: vals.length,
      min: vals.length ? Math.min(...vals) : 0,
      avg: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0,
      max: vals.length ? Math.max(...vals) : 0
    };
  }

  async function loadHistoricalStats(force = false) {
    if (!force && historyCache && Date.now() - historyCacheAt < 5 * 60 * 1000) return historyCache;
    if (!activeUnitId()) throw new Error("No active unit selected.");
    if (!window.sb?.client?.from) throw new Error("Supabase is not ready.");

    const uid = activeUnitId();
    const [staffRes, snapRes] = await Promise.all([
      window.sb.client.from("staff_shift_metrics").select("*").eq("unit_id", uid).order("shift_date", { ascending: false }).limit(8000),
      window.sb.client.from("shift_snapshots").select("shift_date,shift_type,state").eq("unit_id", uid).order("shift_date", { ascending: false }).limit(5000)
    ]);
    if (staffRes.error) throw staffRes.error;

    const snaps = new Map();
    safeArray(snapRes.data).forEach((snap) => snaps.set(shiftKey(snap.shift_date, snap.shift_type), snap));
    const byShiftRole = new Map();

    safeArray(staffRes.data).forEach((row) => {
      const role = String(row.role || "").toUpperCase();
      if (role !== "RN" && role !== "PCA") return;
      const key = shiftKey(row.shift_date, row.shift_type);
      const details = rowDetails(row);
      const ids = safeArray(details.patient_ids).map(Number).filter(Number.isFinite);
      let score = num(row.workload_score, 0);
      const snap = snaps.get(key);
      const patients = safeArray(snap?.state?.patients);
      if (ids.length && patients.length) {
        const patientById = new Map(patients.map((p) => [Number(p?.id), p]));
        const assigned = ids.map((id) => patientById.get(id)).filter((p) => p && !p.isEmpty);
        if (assigned.length) score = workloadScoreFor(role, assigned);
      }
      if (score <= 0) return;
      const roleKey = `${key}|${role}`;
      if (!byShiftRole.has(roleKey)) byShiftRole.set(roleKey, []);
      byShiftRole.get(roleKey).push(score);
    });

    const gaps = { RN: [], PCA: [] };
    byShiftRole.forEach((scores, roleKey) => {
      if (scores.length < 2) return;
      const role = roleKey.endsWith("|PCA") ? "PCA" : "RN";
      gaps[role].push(Math.max(...scores) - Math.min(...scores));
    });

    historyCache = { RN: statsFromGaps(gaps.RN), PCA: statsFromGaps(gaps.PCA) };
    historyCacheAt = Date.now();
    return historyCache;
  }

  function markerPct(value, min, max) {
    if (max <= min) return 50;
    return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  }

  function roleRowHtml(role, current, stats) {
    const within = stats.shifts > 0 && current.gap >= stats.min && current.gap <= stats.max;
    const pct = markerPct(current.gap, stats.min, stats.max);
    const avgPct = markerPct(stats.avg, stats.min, stats.max);
    return `
      <div class="shift-gap-role-card ${within ? "is-in-range" : "is-out-range"}">
        <div class="shift-gap-role-head">
          <strong>${esc(role)} Gap</strong>
          <span>${within ? "Within historical range" : "Outside historical range"}</span>
        </div>
        <div class="shift-gap-scale">
          <div class="shift-gap-line"></div>
          <div class="shift-gap-avg" style="left:${avgPct}%;" title="Historical average ${stats.avg.toFixed(1)}"></div>
          <div class="shift-gap-marker" style="left:${pct}%;" title="Current gap ${current.gap.toFixed(1)}">${current.gap.toFixed(1)}</div>
        </div>
        <div class="shift-gap-labels">
          <span>Min ${stats.min.toFixed(1)}</span>
          <strong>Avg ${stats.avg.toFixed(1)}</strong>
          <span>Max ${stats.max.toFixed(1)}</span>
        </div>
        <div class="shift-gap-mini-table">
          <div><span>Current low</span><strong>${current.minLoad.toFixed(1)}</strong></div>
          <div><span>Current high</span><strong>${current.maxLoad.toFixed(1)}</strong></div>
          <div><span>Historical shifts</span><strong>${stats.shifts}</strong></div>
        </div>
      </div>
    `;
  }

  function renderResults(stats) {
    const board = currentBoardKey();
    const rn = currentRoleGap("RN", board);
    const pca = currentRoleGap("PCA", board);
    const body = document.getElementById("shiftGapPanelBody");
    const status = document.getElementById("shiftGapPanelStatus");
    if (!body) return;
    body.innerHTML = `
      ${roleRowHtml("RN", rn, stats.RN)}
      ${roleRowHtml("PCA", pca, stats.PCA)}
    `;
    if (status) status.textContent = `${board === "incoming" ? "Oncoming" : "Live"} assignment compared with finalized historical gaps.`;
  }

  function ensurePanel() {
    if (document.getElementById("shiftGapPanel")) return;
    const host = document.createElement("div");
    host.id = "shiftGapPanel";
    host.className = "shift-gap-panel is-collapsed";
    host.innerHTML = `
      <button id="shiftGapToggle" type="button" class="shift-gap-toggle">Shift Gap</button>
      <div class="shift-gap-card">
        <div class="shift-gap-card-head">
          <div>
            <strong>Shift Score Gaps</strong>
            <small id="shiftGapPanelStatus">Generate from current assignment layout.</small>
          </div>
          <button id="shiftGapClose" type="button" aria-label="Collapse shift gap panel">x</button>
        </div>
        <div id="shiftGapPanelBody" class="shift-gap-body">
          <div class="shift-gap-empty">Use Generate after adjusting the assignment.</div>
        </div>
        <div class="shift-gap-actions">
          <button id="shiftGapGenerate" type="button">Generate</button>
        </div>
      </div>
    `;
    document.body.appendChild(host);

    document.getElementById("shiftGapToggle")?.addEventListener("click", () => host.classList.remove("is-collapsed"));
    document.getElementById("shiftGapClose")?.addEventListener("click", () => host.classList.add("is-collapsed"));
    document.getElementById("shiftGapGenerate")?.addEventListener("click", async () => {
      const btn = document.getElementById("shiftGapGenerate");
      const status = document.getElementById("shiftGapPanelStatus");
      try {
        if (btn) btn.disabled = true;
        if (status) status.textContent = "Loading finalized shift gap history...";
        const stats = await loadHistoricalStats(false);
        renderResults(stats);
      } catch (error) {
        if (status) status.textContent = `Unable to generate: ${error?.message || error}`;
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  window.generateShiftGapPanel = async function generateShiftGapPanel(force = false) {
    ensurePanel();
    const stats = await loadHistoricalStats(force);
    renderResults(stats);
    return stats;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensurePanel);
  } else {
    ensurePanel();
  }
})();
