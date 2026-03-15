// app/app.assignmentsrender.js
// ---------------------------------------------------------
// Rendering + generator for Oncoming (incoming) assignments ONLY
// Adds "Prev. RN / Prev. PCA" columns by referencing LIVE assignments.
//
// Adds:
// - ! icon (yellow warning vs red violation) based on hard-rule checks
//
// NEW (Dec 2025):
// - RN Continuity Pin (📌) per patient row on ONCOMING RN table
// - Pinned patients stay with that RN across Populate/Rebalance.
//
// NEW (Dec 2025 - Fixes):
// - MOVE-based count balancer (diff ≤ 1 when possible) for BOTH RN and PCA
// - RN-only and PCA-only rebalance buttons removed; Rebalance (Both) + Populate remain.
// - Empty-owner drop zone row so empty cards can accept drops
//
// FIX (Jan 2026):
// - Canonicalize state references (incomingNurses/incomingPcas/patients) to avoid drift.
//
// FIX (Jan 2026 - Safe Rebalance Wiring):
// - Rebalance buttons use window.rebalanceOwnersSafely (if available)
// - If applied:false, keep baseline and show "Unable to rebalance safely"
//
// PERF (Jan 2026 -> refined v2):
// - Cache Prev RN/PCA owner maps ONCE per render cycle (RN+PCA share it)
// - Cache hard-rule eval maps once per render
// - Batch RN+PCA render where possible to reduce duplicate DOM work
// - Replace per-row hover IIFEs with a single lightweight global handler
//
// Rebalance (Jan 2026):
// - Count balancer is report-source aware: when evening counts, prefer moves that
//   don't increase report overflow (4 pts → max 3 sources, 3 pts → max 2).
//
// UI PATCH (Jan 2026 - Oncoming header refresh):
// - Remove lightbulb icons (no 💡 buttons)
// - Show Report sources only in the header metadata row
// - Improve rebalance feedback: banner includes before/after deltas
// - Add in-flight guards to prevent double-click thrash / duplicate apply
// ---------------------------------------------------------

if (window.__assignmentsRenderLoaded) {
  // no-op
} else {
  window.__assignmentsRenderLoaded = true;

  function safeArray(v) {
    return Array.isArray(v) ? v : [];
  }

  // =========================================================
  // ✅ Canonical state accessors (prevents reference drift)
  // =========================================================
  function __getIncomingNurses() {
    const w = window.incomingNurses;
    if (Array.isArray(w)) return w;
    if (Array.isArray(typeof incomingNurses !== "undefined" ? incomingNurses : null)) return incomingNurses;
    return [];
  }

  function __getIncomingPcas() {
    const w = window.incomingPcas;
    if (Array.isArray(w)) return w;
    if (Array.isArray(typeof incomingPcas !== "undefined" ? incomingPcas : null)) return incomingPcas;
    return [];
  }

  function __getPatients() {
    const w = window.patients;
    if (Array.isArray(w)) return w;
    if (Array.isArray(typeof patients !== "undefined" ? patients : null)) return patients;
    return [];
  }

  function __syncIncomingGlobals() {
    const nurses = __getIncomingNurses();
    const pcas = __getIncomingPcas();
    const pts = __getPatients();

    if (!Array.isArray(window.incomingNurses)) window.incomingNurses = nurses;
    if (!Array.isArray(window.incomingPcas)) window.incomingPcas = pcas;
    if (!Array.isArray(window.patients)) window.patients = pts;

    try {
      if (typeof incomingNurses !== "undefined" && incomingNurses !== window.incomingNurses) {
        incomingNurses = window.incomingNurses;
      }
    } catch (_) {}

    try {
      if (typeof incomingPcas !== "undefined" && incomingPcas !== window.incomingPcas) {
        incomingPcas = window.incomingPcas;
      }
    } catch (_) {}

    try {
      if (typeof patients !== "undefined" && patients !== window.patients) {
        patients = window.patients;
      }
    } catch (_) {}
  }

  __syncIncomingGlobals();

  // -----------------------------
  // Helpers: build prev-owner maps ONCE per render cycle (PERF)
  // -----------------------------
  function buildPrevOwnerMaps() {
    const prevRnByPid = new Map();
    const prevPcaByPid = new Map();

    if (Array.isArray(window.currentNurses)) {
      window.currentNurses.forEach(rn => {
        const name = rn?.name || `RN ${rn?.id ?? ""}`;
        (rn?.patients || []).forEach(pid => prevRnByPid.set(Number(pid), name));
      });
    }

    if (Array.isArray(window.currentPcas)) {
      window.currentPcas.forEach(p => {
        const name = p?.name || `PCA ${p?.id ?? ""}`;
        (p?.patients || []).forEach(pid => prevPcaByPid.set(Number(pid), name));
      });
    }

    return { prevRnByPid, prevPcaByPid };
  }

  function uniqueCountFromMap(patientIds, map) {
    const set = new Set();
    (patientIds || []).forEach(pid => {
      const v = map.get(Number(pid));
      if (v) set.add(v);
    });
    return set.size;
  }

  // Report-source helpers (mirror assignmentRules: 4 pts → max 3 sources, 3 pts → max 2)
  // Used by count balancer to prefer moves that don't increase report-source drag.
  function __allowedReportSourcesForCount(ptCount) {
    const n = Number(ptCount) || 0;
    if (n >= 4) return 3;
    if (n === 3) return 2;
    if (n === 2) return 2;
    if (n === 1) return 1;
    return 0;
  }

  function __reportSourcesForOwner(owner, prevMap) {
    if (!prevMap || !owner) return 0;
    const ids = Array.isArray(owner.patients) ? owner.patients : [];
    return uniqueCountFromMap(ids, prevMap);
  }

  function __reportOverflowForOwner(owner, prevMap) {
    const ptCount = Array.isArray(owner?.patients) ? owner.patients.length : 0;
    const allowed = __allowedReportSourcesForCount(ptCount);
    const sources = __reportSourcesForOwner(owner, prevMap);
    return Math.max(0, sources - allowed);
  }

  function __reportOverflowTotal(owners, prevMap) {
    if (!prevMap) return 0;
    return (owners || []).reduce((sum, o) => sum + __reportOverflowForOwner(o, prevMap), 0);
  }

  function __reportSourceTotal(owners, prevMap) {
    if (!prevMap) return 0;
    return (owners || []).reduce((sum, o) => sum + __reportSourcesForOwner(o, prevMap), 0);
  }

  // Render-cycle cache (RN + PCA share)
  // This prevents RN render + PCA render from recomputing maps back-to-back.
  const __renderCycleCache = {
    token: 0,
    prevMaps: null
  };

  function __beginRenderCycle() {
    __renderCycleCache.token = (Number(__renderCycleCache.token) || 0) + 1;
    __renderCycleCache.prevMaps = null;
    return __renderCycleCache.token;
  }

  function __getPrevMapsForCycle() {
    if (__renderCycleCache.prevMaps) return __renderCycleCache.prevMaps;
    __renderCycleCache.prevMaps = buildPrevOwnerMaps();
    return __renderCycleCache.prevMaps;
  }

  // -----------------------------
  // Backward-compatible helpers (still exposed)
  // -----------------------------
  function getPrevRnNameForPatient(patientId) {
    const pid = Number(patientId);
    if (!pid) return "";
    if (!Array.isArray(window.currentNurses)) return "";
    const owner = window.currentNurses.find(n => Array.isArray(n.patients) && n.patients.includes(pid));
    return owner ? (owner.name || `RN ${owner.id}`) : "";
  }

  function getPrevPcaNameForPatient(patientId) {
    const pid = Number(patientId);
    if (!pid) return "";
    if (!Array.isArray(window.currentPcas)) return "";
    const owner = window.currentPcas.find(p => Array.isArray(p.patients) && p.patients.includes(pid));
    return owner ? (owner.name || `PCA ${owner.id}`) : "";
  }

  window.getPrevRnNameForPatient = getPrevRnNameForPatient;
  window.getPrevPcaNameForPatient = getPrevPcaNameForPatient;

  // -----------------------------
  // Room label helpers
  // -----------------------------
  function getBedLabel(p) {
    if (!p) return "";
    if (typeof window.getRoomLabelForPatient === "function") return window.getRoomLabelForPatient(p);
    return String(p.room || p.id || "");
  }

  function isExpectedDischarge(p) {
    return !!(p && !p.isEmpty && p.expectedDischarge);
  }

  function showOncomingDischargeVisuals() {
    return window.__oncomingShowDischargeVisuals !== false;
  }

  function __syncOncomingDischargeVisualToggle() {
    const btn = document.getElementById("oncomingDischargeVisualToggle");
    if (!btn) return;
    const on = showOncomingDischargeVisuals();
    btn.textContent = on ? "DCs On" : "DCs Off";
    btn.setAttribute("data-state", on ? "on" : "off");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Hide expected discharge bed highlights" : "Show expected discharge bed highlights";
  }

  window.toggleOncomingDischargeVisuals = function toggleOncomingDischargeVisuals() {
    window.__oncomingShowDischargeVisuals = !showOncomingDischargeVisuals();
    __syncOncomingDischargeVisualToggle();
    try { renderOncomingAll(); } catch (_) {}
  };

  function bedCellHtml(p, extraHtml = "") {
    const bedLabel = getBedLabel(p);
    const showDischarge = showOncomingDischargeVisuals() && isExpectedDischarge(p);
    const dischargeClass = showDischarge ? " discharge-expected" : "";
    const carBadge = showDischarge
      ? `<span class="expected-discharge-indicator" title="Expected discharge soon" aria-label="Expected discharge soon">&#128663;</span>`
      : "";
    return `<span class="bed-chip${dischargeClass}">${escapeHtml(bedLabel)}${carBadge}${extraHtml}</span>`;
  }

  function safeSortPatientsForDisplay(a, b) {
    const ga = (typeof window.getRoomNumber === "function") ? window.getRoomNumber(a) : 9999;
    const gb = (typeof window.getRoomNumber === "function") ? window.getRoomNumber(b) : 9999;
    if (ga !== gb) return ga - gb;
    return (Number(a?.id) || 0) - (Number(b?.id) || 0);
  }

  function __sitterRoomGroupKey(p) {
    const bed = getBedLabel(p);
    const m = String(bed || "").trim().match(/^(\d+)/);
    return m ? m[1] : String(bed || "");
  }

  function __applyPcaSitterDesignations(pcas, activePatients) {
    const owners = Array.isArray(pcas) ? pcas : [];
    const pts = Array.isArray(activePatients) ? activePatients : [];
    const pinned = new Set();
    const claimedPairs = new Set();
    const claimedPatientIds = new Set();

    owners.forEach((pca) => {
      const pair = String(pca?.sitterRoomPair || "").trim();
      const isSitterPca = !!pca?.isSitter && !!pair;
      if (!isSitterPca) return;
      if (claimedPairs.has(pair)) {
        pca.patients = [];
        pca.maxPatients = 2;
        return;
      }

      const hits = pts
        .filter((p) => p && !p.isEmpty && !!p.sitter && __sitterRoomGroupKey(p) === pair)
        .sort(safeSortPatientsForDisplay)
        .slice(0, 2)
        .map((p) => Number(p.id))
        .filter((id) => Number.isFinite(id) && !claimedPatientIds.has(id));

      pca.patients = Array.from(new Set(hits));
      pca.maxPatients = 2;
      claimedPairs.add(pair);
      pca.patients.forEach((id) => {
        pinned.add(id);
        claimedPatientIds.add(id);
      });
    });

    return pinned;
  }

  function __enforceSitterAssignmentsExclusive(pcas, activePatients) {
    const owners = Array.isArray(pcas) ? pcas : [];
    const pts = Array.isArray(activePatients) ? activePatients : [];
    const pinned = __applyPcaSitterDesignations(owners, pts);
    if (!pinned.size) return pinned;

    owners.forEach((pca) => {
      const isSitterPca = !!pca?.isSitter && !!String(pca?.sitterRoomPair || "").trim();
      if (isSitterPca) return;
      const raw = Array.isArray(pca?.patients) ? pca.patients : [];
      pca.patients = raw
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && !pinned.has(id));
    });
    return pinned;
  }

  function __sanitizeOwnerAssignmentsToActiveBeds(owner, activeIdSet) {
    if (!owner || !activeIdSet) return [];
    const raw = Array.isArray(owner.patients) ? owner.patients : [];
    const cleaned = raw
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && activeIdSet.has(id));
    const unique = Array.from(new Set(cleaned));
    if (!Array.isArray(owner.patients) || owner.patients.length !== unique.length || owner.patients.some((v, i) => Number(v) !== unique[i])) {
      owner.patients = unique;
    }
    return unique;
  }

  // -----------------------------
  // RN / PCA Continuity Pin helpers
  // -----------------------------
  function getPatientLockMeta(p, role = "nurse") {
    if (!p || typeof p !== "object") {
      return role === "pca" ? { enabled: false, pcaId: null } : { enabled: false, rnId: null };
    }
    if (role === "pca") {
      const enabled = !!p.lockPcaEnabled;
      const pcaId = (p.lockPcaTo !== undefined && p.lockPcaTo !== null) ? Number(p.lockPcaTo) : null;
      return { enabled, pcaId: Number.isFinite(pcaId) ? pcaId : null };
    }
    const enabled = !!p.lockRnEnabled;
    const rnId = (p.lockRnTo !== undefined && p.lockRnTo !== null) ? Number(p.lockRnTo) : null;
    return { enabled, rnId: Number.isFinite(rnId) ? rnId : null };
  }

  function isPatientPinnedToIncomingRn(patientId, incomingRnId) {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return false;
    const meta = getPatientLockMeta(p);
    return !!meta.enabled && meta.rnId === Number(incomingRnId);
  }

  function isPatientPinnedToAnyIncomingRn(patientId) {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return false;
    const meta = getPatientLockMeta(p);
    return !!meta.enabled && Number.isFinite(meta.rnId);
  }

  function isPatientPinnedToIncomingPca(patientId, incomingPcaId) {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return false;
    const meta = getPatientLockMeta(p, "pca");
    return !!meta.enabled && meta.pcaId === Number(incomingPcaId);
  }

  function isPatientPinnedToAnyIncomingPca(patientId) {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return false;
    const meta = getPatientLockMeta(p, "pca");
    return !!meta.enabled && Number.isFinite(meta.pcaId);
  }

  function toggleIncomingRnPin(patientId, incomingRnId) {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return;

    const rnId = Number(incomingRnId);
    const meta = getPatientLockMeta(p);

    if (meta.enabled && meta.rnId === rnId) {
      p.lockRnEnabled = false;
      p.lockRnTo = null;
    } else {
      p.lockRnEnabled = true;
      p.lockRnTo = rnId;
    }

    try { if (typeof window.saveState === "function") window.saveState(); } catch {}
    try { if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput(); } catch {}
  }
  window.toggleIncomingRnPin = toggleIncomingRnPin;

  function toggleIncomingPcaPin(patientId, incomingPcaId) {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return;

    const pcaId = Number(incomingPcaId);
    const meta = getPatientLockMeta(p, "pca");

    if (meta.enabled && meta.pcaId === pcaId) {
      p.lockPcaEnabled = false;
      p.lockPcaTo = null;
    } else {
      p.lockPcaEnabled = true;
      p.lockPcaTo = pcaId;
    }

    try { if (typeof window.saveState === "function") window.saveState(); } catch {}
    try { if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput(); } catch {}
  }
  window.toggleIncomingPcaPin = toggleIncomingPcaPin;

  function cleanupRnPinsAgainstRoster() {
    const roster = __getIncomingNurses();
    const rosterIds = new Set(roster.map(n => Number(n.id)));

    const pts = __getPatients();
    pts.forEach(p => {
      const meta = getPatientLockMeta(p);
      if (!meta.enabled) return;
      if (!rosterIds.has(meta.rnId)) {
        p.lockRnEnabled = false;
        p.lockRnTo = null;
      }
    });
  }

  function cleanupPcaPinsAgainstRoster() {
    const roster = __getIncomingPcas().filter((p) => !(p?.isSitter && String(p?.sitterRoomPair || "").trim()));
    const rosterIds = new Set(roster.map((p) => Number(p.id)));

    const pts = __getPatients();
    pts.forEach((p) => {
      const meta = getPatientLockMeta(p, "pca");
      if (!meta.enabled) return;
      if (!rosterIds.has(meta.pcaId)) {
        p.lockPcaEnabled = false;
        p.lockPcaTo = null;
      }
    });
  }

  function applyRnPinsBeforeDistribute(activePatients) {
    const roster = __getIncomingNurses();
    if (!roster.length) return { pinnedAssigned: [], unlockedPool: activePatients || [] };

    const byId = new Map(roster.map(n => [Number(n.id), n]));
    const pinnedAssigned = [];
    const unlockedPool = [];

    (activePatients || []).forEach(p => {
      const meta = getPatientLockMeta(p);
      if (meta.enabled && meta.rnId && byId.has(meta.rnId)) {
        const rn = byId.get(meta.rnId);
        rn.patients = Array.isArray(rn.patients) ? rn.patients : [];
        if (!rn.patients.includes(Number(p.id))) rn.patients.push(Number(p.id));
        pinnedAssigned.push(Number(p.id));
      } else {
        unlockedPool.push(p);
      }
    });

    return { pinnedAssigned, unlockedPool };
  }

  function applyPcaPinsBeforeDistribute(activePatients, owners) {
    const roster = Array.isArray(owners) ? owners : __getIncomingPcas();
    if (!roster.length) return { pinnedAssigned: [], unlockedPool: activePatients || [] };

    const byId = new Map(roster.map((p) => [Number(p.id), p]));
    const pinnedAssigned = [];
    const unlockedPool = [];

    (activePatients || []).forEach((p) => {
      const meta = getPatientLockMeta(p, "pca");
      if (meta.enabled && meta.pcaId && byId.has(meta.pcaId)) {
        const pca = byId.get(meta.pcaId);
        pca.patients = Array.isArray(pca.patients) ? pca.patients : [];
        if (!pca.patients.includes(Number(p.id))) pca.patients.push(Number(p.id));
        pinnedAssigned.push(Number(p.id));
      } else {
        unlockedPool.push(p);
      }
    });

    return { pinnedAssigned, unlockedPool };
  }

  // -----------------------------
  // Guard helpers: avoidable violations + even counts
  // -----------------------------
  function getAvoidableViolationCount(owners, role) {
    try {
      if (typeof window.evaluateAssignmentHardRules !== "function") return 0;
      const map = window.evaluateAssignmentHardRules(owners, role);
      if (!map || typeof map !== "object") return 0;

      let total = 0;
      Object.values(map).forEach(ev => {
        total += (Array.isArray(ev?.violations) ? ev.violations.length : 0);
      });
      return total;
    } catch {
      return 0;
    }
  }

  function computeCountTargets(totalPatients, nOwners) {
    const base = Math.floor(totalPatients / Math.max(1, nOwners));
    const remainder = totalPatients % Math.max(1, nOwners);
    return { minTarget: base, maxTarget: base + (remainder > 0 ? 1 : 0) };
  }

  function getMovablePatientIdsFromOwner(owner, role) {
    const ids = Array.isArray(owner?.patients) ? owner.patients.slice() : [];
    if (role === "nurse") return ids.filter(pid => !isPatientPinnedToAnyIncomingRn(pid));
    if (role === "pca") return ids.filter(pid => !isPatientPinnedToAnyIncomingPca(pid));
    return ids;
  }

  function tryMovePatient(owners, role, fromOwner, toOwner, patientId) {
    if (!fromOwner || !toOwner) return false;
    if (!Array.isArray(fromOwner.patients)) fromOwner.patients = [];
    if (!Array.isArray(toOwner.patients)) toOwner.patients = [];

    const idx = fromOwner.patients.indexOf(patientId);
    if (idx === -1) return false;

    if (role === "nurse" && isPatientPinnedToAnyIncomingRn(patientId)) return false;
    if (role === "pca" && isPatientPinnedToAnyIncomingPca(patientId)) return false;

    fromOwner.patients.splice(idx, 1);
    if (!toOwner.patients.includes(patientId)) toOwner.patients.push(patientId);
    return true;
  }

  function isExpectedDischargePatientId(patientId) {
    try {
      const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
      return !!(p && !p.isEmpty && p.expectedDischarge);
    } catch {
      return false;
    }
  }

  function countExpectedDischargesForOwnerLocal(owner) {
    return safeArray(owner?.patients).reduce((sum, pid) => sum + (isExpectedDischargePatientId(pid) ? 1 : 0), 0);
  }

  function expectedDischargeBaseLimitLocal(owner, role) {
    const count = safeArray(owner?.patients).length;
    if (role === "pca") return Math.floor(count / 2);
    return 3;
  }

  function totalExpectedDischargesLocal(owners) {
    return safeArray(owners).reduce((sum, owner) => sum + countExpectedDischargesForOwnerLocal(owner), 0);
  }

  function totalExpectedDischargeCapacityLocal(owners, role) {
    return safeArray(owners).reduce((sum, owner) => sum + expectedDischargeBaseLimitLocal(owner, role), 0);
  }

  function getExpectedDischargeOverflowLocal(owner, role) {
    return Math.max(0, countExpectedDischargesForOwnerLocal(owner) - expectedDischargeBaseLimitLocal(owner, role));
  }

  function getAvoidableExpectedDischargeOverflowLocal(owners, role) {
    const totalOverflow = safeArray(owners).reduce((sum, owner) => sum + getExpectedDischargeOverflowLocal(owner, role), 0);
    const unavoidable = Math.max(0, totalExpectedDischargesLocal(owners) - totalExpectedDischargeCapacityLocal(owners, role));
    return Math.max(0, totalOverflow - unavoidable);
  }

  function countSpreadLocal(owners) {
    const counts = safeArray(owners).map((o) => safeArray(o?.patients).length);
    if (!counts.length) return 0;
    return Math.max(...counts) - Math.min(...counts);
  }

  function roomNumberLocal(patientId) {
    try {
      const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
      if (!p) return null;
      if (typeof window.getRoomNumber === "function") {
        const n = window.getRoomNumber(p);
        return Number.isFinite(n) ? Number(n) : null;
      }
      const raw = String(p?.room || p?.roomNumber || "");
      const m = raw.match(/(\d+)/);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  function roomSpanForOwnerLocal(owner) {
    const rooms = safeArray(owner?.patients)
      .map((pid) => roomNumberLocal(pid))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (rooms.length < 2) return 0;
    return rooms[rooms.length - 1] - rooms[0];
  }

  function roomSpreadOverflowLocal(owners, role) {
    const limit = role === "pca" ? 14 : 10;
    return safeArray(owners).reduce((sum, owner) => {
      const span = roomSpanForOwnerLocal(owner);
      return sum + Math.max(0, span - limit);
    }, 0);
  }

  function rebalanceExpectedDischarges(owners, role, opts = {}) {
    const list = Array.isArray(owners) ? owners.filter(Boolean) : [];
    if (list.length < 2) return { ok: true, changed: false };

    const maxPasses = typeof opts.maxPasses === "number" ? opts.maxPasses : 80;
    const maps = buildPrevOwnerMaps();
    const prevMap = role === "nurse" ? maps.prevRnByPid : maps.prevPcaByPid;
    let changed = false;

    for (let pass = 0; pass < maxPasses; pass++) {
      const baseAvoid = getAvoidableViolationCount(list, role);
      const baseDischargeAvoid = getAvoidableExpectedDischargeOverflowLocal(list, role);
      if (baseDischargeAvoid <= 0) break;

      const baseRoomOverflow = roomSpreadOverflowLocal(list, role);
      const baseReportOverflow = prevMap ? __reportOverflowTotal(list, prevMap) : 0;
      const baseReportTotal = prevMap ? __reportSourceTotal(list, prevMap) : 0;
      const baseSpread = countSpreadLocal(list);
      const overOwners = list
        .map((owner) => ({ owner, overflow: getExpectedDischargeOverflowLocal(owner, role), discharges: countExpectedDischargesForOwnerLocal(owner) }))
        .filter((entry) => entry.overflow > 0)
        .sort((a, b) => b.overflow - a.overflow || b.discharges - a.discharges);

      let best = null;

      for (const sourceEntry of overOwners) {
        const fromOwner = sourceEntry.owner;
        const movableDischarges = getMovablePatientIdsFromOwner(fromOwner, role).filter((pid) => isExpectedDischargePatientId(pid));
        if (!movableDischarges.length) continue;

        const targetOwners = list
          .filter((owner) => owner !== fromOwner)
          .sort((a, b) => {
            const overflowDiff = getExpectedDischargeOverflowLocal(a, role) - getExpectedDischargeOverflowLocal(b, role);
            if (overflowDiff !== 0) return overflowDiff;
            return safeArray(a?.patients).length - safeArray(b?.patients).length;
          });

        for (const patientId of movableDischarges) {
          for (const toOwner of targetOwners) {
            const fromOrig = safeArray(fromOwner.patients).slice();
            const toOrig = safeArray(toOwner.patients).slice();
            const did = tryMovePatient(list, role, fromOwner, toOwner, patientId);
            if (!did) continue;

            const nextAvoid = getAvoidableViolationCount(list, role);
            const nextDischargeAvoid = getAvoidableExpectedDischargeOverflowLocal(list, role);
            const nextRoomOverflow = roomSpreadOverflowLocal(list, role);
            const nextReportOverflow = prevMap ? __reportOverflowTotal(list, prevMap) : 0;
            const nextReportTotal = prevMap ? __reportSourceTotal(list, prevMap) : 0;
            const nextSpread = countSpreadLocal(list);

            fromOwner.patients = fromOrig;
            toOwner.patients = toOrig;

            const improvesDischarge = nextDischargeAvoid < baseDischargeAvoid;
            const avoidsWorseningRules = nextAvoid <= baseAvoid;
            if (!improvesDischarge || !avoidsWorseningRules) continue;

            const candidate = {
              fromOwner,
              toOwner,
              patientId,
              nextAvoid,
              nextDischargeAvoid,
              nextRoomOverflow,
              nextReportTotal,
              nextReportOverflow,
              nextSpread
            };

            if (!best) {
              best = candidate;
              continue;
            }

            if (candidate.nextAvoid !== best.nextAvoid) {
              if (candidate.nextAvoid < best.nextAvoid) best = candidate;
              continue;
            }
            if (candidate.nextDischargeAvoid !== best.nextDischargeAvoid) {
              if (candidate.nextDischargeAvoid < best.nextDischargeAvoid) best = candidate;
              continue;
            }
            if (candidate.nextRoomOverflow !== best.nextRoomOverflow) {
              if (candidate.nextRoomOverflow < best.nextRoomOverflow) best = candidate;
              continue;
            }
            if (candidate.nextReportTotal !== best.nextReportTotal) {
              if (candidate.nextReportTotal < best.nextReportTotal) best = candidate;
              continue;
            }
            if (candidate.nextReportOverflow !== best.nextReportOverflow) {
              if (candidate.nextReportOverflow < best.nextReportOverflow) best = candidate;
              continue;
            }
            if (candidate.nextSpread < best.nextSpread) best = candidate;
          }
        }
      }

      if (!best) break;
      const applied = tryMovePatient(list, role, best.fromOwner, best.toOwner, best.patientId);
      if (!applied) break;
      changed = true;
    }

    return { ok: true, changed };
  }

  function rebalanceSingleMovesStrict(owners, role, opts = {}) {
    const list = Array.isArray(owners) ? owners.filter(Boolean) : [];
    if (list.length < 2) return { ok: true, changed: false };

    const maxPasses = typeof opts.maxPasses === "number" ? opts.maxPasses : 80;
    const maps = buildPrevOwnerMaps();
    const prevMap = role === "nurse" ? maps.prevRnByPid : maps.prevPcaByPid;
    let changed = false;

    for (let pass = 0; pass < maxPasses; pass++) {
      const baseAvoid = getAvoidableViolationCount(list, role);
      const baseDischargeAvoid = getAvoidableExpectedDischargeOverflowLocal(list, role);
      const baseSpread = countSpreadLocal(list);
      const baseRoomOverflow = roomSpreadOverflowLocal(list, role);
      const baseReportOverflow = prevMap ? __reportOverflowTotal(list, prevMap) : 0;
      const baseReportTotal = prevMap ? __reportSourceTotal(list, prevMap) : 0;
      let best = null;

      for (const fromOwner of list) {
        const movable = getMovablePatientIdsFromOwner(fromOwner, role);
        if (!movable.length) continue;

        for (const patientId of movable) {
          for (const toOwner of list) {
            if (!toOwner || toOwner === fromOwner) continue;

            const fromOrig = safeArray(fromOwner.patients).slice();
            const toOrig = safeArray(toOwner.patients).slice();
            const did = tryMovePatient(list, role, fromOwner, toOwner, patientId);
            if (!did) continue;

            const nextAvoid = getAvoidableViolationCount(list, role);
            const nextDischargeAvoid = getAvoidableExpectedDischargeOverflowLocal(list, role);
            const nextSpread = countSpreadLocal(list);
            const nextRoomOverflow = roomSpreadOverflowLocal(list, role);
            const nextReportOverflow = prevMap ? __reportOverflowTotal(list, prevMap) : 0;
            const nextReportTotal = prevMap ? __reportSourceTotal(list, prevMap) : 0;

            fromOwner.patients = fromOrig;
            toOwner.patients = toOrig;

            const improves =
              nextAvoid < baseAvoid ||
              (nextAvoid === baseAvoid && nextDischargeAvoid < baseDischargeAvoid) ||
              (nextAvoid === baseAvoid && nextDischargeAvoid === baseDischargeAvoid && nextSpread < baseSpread) ||
              (nextAvoid === baseAvoid && nextDischargeAvoid === baseDischargeAvoid && nextSpread === baseSpread && nextRoomOverflow < baseRoomOverflow) ||
              (nextAvoid === baseAvoid && nextDischargeAvoid === baseDischargeAvoid && nextSpread === baseSpread && nextRoomOverflow === baseRoomOverflow && nextReportOverflow < baseReportOverflow) ||
              (nextAvoid === baseAvoid && nextDischargeAvoid === baseDischargeAvoid && nextSpread === baseSpread && nextRoomOverflow === baseRoomOverflow && nextReportOverflow === baseReportOverflow && nextReportTotal < baseReportTotal);

            if (!improves) continue;

            const candidate = {
              fromOwner,
              toOwner,
              patientId,
              nextAvoid,
              nextDischargeAvoid,
              nextSpread,
              nextRoomOverflow,
              nextReportTotal,
              nextReportOverflow
            };

            if (!best) {
              best = candidate;
            } else if (candidate.nextAvoid < best.nextAvoid) {
              best = candidate;
            } else if (candidate.nextAvoid === best.nextAvoid && candidate.nextDischargeAvoid < best.nextDischargeAvoid) {
              best = candidate;
            } else if (candidate.nextAvoid === best.nextAvoid && candidate.nextDischargeAvoid === best.nextDischargeAvoid && candidate.nextSpread < best.nextSpread) {
              best = candidate;
            } else if (candidate.nextAvoid === best.nextAvoid && candidate.nextDischargeAvoid === best.nextDischargeAvoid && candidate.nextSpread === best.nextSpread && candidate.nextRoomOverflow < best.nextRoomOverflow) {
              best = candidate;
            } else if (candidate.nextAvoid === best.nextAvoid && candidate.nextDischargeAvoid === best.nextDischargeAvoid && candidate.nextSpread === best.nextSpread && candidate.nextRoomOverflow === best.nextRoomOverflow && candidate.nextReportOverflow < best.nextReportOverflow) {
              best = candidate;
            } else if (candidate.nextAvoid === best.nextAvoid && candidate.nextDischargeAvoid === best.nextDischargeAvoid && candidate.nextSpread === best.nextSpread && candidate.nextRoomOverflow === best.nextRoomOverflow && candidate.nextReportOverflow === best.nextReportOverflow && candidate.nextReportTotal < best.nextReportTotal) {
              best = candidate;
            }

            if (best && best.nextAvoid <= 0 && best.nextDischargeAvoid <= 0 && best.nextSpread <= 1) break;
          }
          if (best && best.nextAvoid <= 0 && best.nextDischargeAvoid <= 0 && best.nextSpread <= 1) break;
        }
        if (best && best.nextAvoid <= 0 && best.nextDischargeAvoid <= 0 && best.nextSpread <= 1) break;
      }

      if (!best) break;
      const applied = tryMovePatient(list, role, best.fromOwner, best.toOwner, best.patientId);
      if (!applied) break;
      changed = true;

      if (best.nextAvoid <= 0 && best.nextDischargeAvoid <= 0 && best.nextSpread <= 1) {
        const checkAvoid = getAvoidableViolationCount(list, role);
        const checkDischargeAvoid = getAvoidableExpectedDischargeOverflowLocal(list, role);
        const checkSpread = countSpreadLocal(list);
        if (checkAvoid <= 0 && checkDischargeAvoid <= 0 && checkSpread <= 1) break;
      }
    }

    return { ok: true, changed };
  }

  function __snapshotSingleOwnerArrays(owners) {
    return safeArray(owners).map((owner) => safeArray(owner?.patients).slice());
  }

  function __debugOwnerSummary(owners) {
    return safeArray(owners).map((owner) => ({
      id: Number(owner?.id),
      name: String(owner?.name || ""),
      count: safeArray(owner?.patients).length,
      patients: safeArray(owner?.patients).slice()
    }));
  }

  function __formatOwnerCounts(summary) {
    return safeArray(summary)
      .map((owner) => `${owner?.name || "Owner"}:${Number(owner?.count) || 0}`)
      .join(" | ");
  }

  function __formatEngineReason(result, fallbackText) {
    if (result?.reason) return String(result.reason);
    if (result?.summary && typeof result.summary === "object") {
      const s = result.summary;
      return [
        typeof s.hardViolations === "number" ? `hard violations ${s.hardViolations}` : "",
        typeof s.countSpread === "number" ? `count spread ${s.countSpread}` : "",
        typeof s.loadSpread === "number" ? `load spread ${s.loadSpread}` : "",
        typeof s.reportOverflow === "number" ? `report overflow ${s.reportOverflow}` : ""
      ].filter(Boolean).join(", ");
    }
    return fallbackText || "No better candidate was accepted.";
  }

  function __nonIdealScore(owners, role, prevMap) {
    const list = Array.isArray(owners) ? owners.filter(Boolean) : [];
    const loads = list.map((owner) => {
      const ids = safeArray(owner?.patients);
      return ids.reduce((sum, pid) => {
        const patient = (typeof window.getPatientById === "function") ? window.getPatientById(pid) : null;
        if (!patient || patient.isEmpty) return sum;
        if (role === "pca") {
          let score = 0;
          if (patient.isolation) score += 3;
          if (patient.admit || patient.admitPca) score += 3;
          if (patient.lateDc || patient.lateDcPca) score += 2;
          if (patient.chg) score += 3;
          if (patient.foley) score += 3;
          if (patient.q2turns || patient.q2Turns) score += 4;
          if (patient.feeder) score += 3;
          return sum + score;
        }
        let score = 0;
        if (patient.tele) score += 1;
        if (patient.nih) score += 4;
        if (patient.drip || patient.drips) score += 5;
        if (patient.bg || patient.bgChecks) score += 2;
        if (patient.ciwa || patient.cows || patient.ciwaCows) score += 4;
        if (patient.sitter) score += 4;
        if (patient.isolation || patient.iso) score += 2;
        if (patient.admit) score += 4;
        if (patient.lateDc) score += 2;
        return sum + score;
      }, 0);
    });
    const loadSpread = loads.length ? (Math.max(...loads) - Math.min(...loads)) : 0;
    return {
      violations: getAvoidableViolationCount(list, role),
      dischargeOverflow: getAvoidableExpectedDischargeOverflowLocal(list, role),
      countSpread: countSpreadLocal(list),
      loadSpread,
      roomOverflow: roomSpreadOverflowLocal(list, role),
      reportTotal: prevMap ? __reportSourceTotal(list, prevMap) : 0,
      reportOverflow: prevMap ? __reportOverflowTotal(list, prevMap) : 0
    };
  }

  function __formatNonIdealScore(score) {
    if (!score || typeof score !== "object") return "";
    return `violations ${Number(score.violations) || 0}, discharge ${Number(score.dischargeOverflow) || 0}, spread ${Number(score.countSpread) || 0}, load ${Number(score.loadSpread) || 0}, report ${Number(score.reportOverflow) || 0}, sources ${Number(score.reportTotal) || 0}, room ${Number(score.roomOverflow) || 0}`;
  }

  function __compareNonIdealScore(a, b) {
    const left = [
      Number(a?.violations) || 0,
      Number(a?.dischargeOverflow) || 0,
      Number(a?.countSpread) || 0,
      Number(a?.loadSpread) || 0,
      Number(a?.reportOverflow) || 0,
      Number(a?.reportTotal) || 0,
      Number(a?.roomOverflow) || 0
    ];
    const right = [
      Number(b?.violations) || 0,
      Number(b?.dischargeOverflow) || 0,
      Number(b?.countSpread) || 0,
      Number(b?.loadSpread) || 0,
      Number(b?.reportOverflow) || 0,
      Number(b?.reportTotal) || 0,
      Number(b?.roomOverflow) || 0
    ];
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return left[i] - right[i];
    }
    return 0;
  }

  function __sumNonIdealScores(a, b) {
    return {
      violations: (Number(a?.violations) || 0) + (Number(b?.violations) || 0),
      dischargeOverflow: (Number(a?.dischargeOverflow) || 0) + (Number(b?.dischargeOverflow) || 0),
      countSpread: (Number(a?.countSpread) || 0) + (Number(b?.countSpread) || 0),
      loadSpread: (Number(a?.loadSpread) || 0) + (Number(b?.loadSpread) || 0),
      reportTotal: (Number(a?.reportTotal) || 0) + (Number(b?.reportTotal) || 0),
      reportOverflow: (Number(a?.reportOverflow) || 0) + (Number(b?.reportOverflow) || 0),
      roomOverflow: (Number(a?.roomOverflow) || 0) + (Number(b?.roomOverflow) || 0)
    };
  }

  function __boardQualitySummary(score, role) {
    const items = [];
    if ((Number(score?.violations) || 0) <= 0) items.push(`${role} rules clean`);
    if ((Number(score?.dischargeOverflow) || 0) <= 0) items.push(`${role} discharges clean`);
    if ((Number(score?.countSpread) || 0) <= 0) items.push(`${role} counts balanced`);
    return items.length ? items.join(" | ") : `${role} needs cleanup`;
  }

  function __boardQualityNeeds(score, role) {
    const items = [];
    if ((Number(score?.countSpread) || 0) > 0) items.push("count balance");
    if ((Number(score?.loadSpread) || 0) > (role === "RN" ? 6 : 8)) items.push("fairer acuity/load");
    if ((Number(score?.reportOverflow) || 0) > 0 || (role === "RN" && (Number(score?.reportTotal) || 0) > 24)) items.push("fewer report sources");
    if ((Number(score?.roomOverflow) || 0) > 0) items.push("tighter room clusters");
    if ((Number(score?.violations) || 0) > 0) items.push("rule cleanup");
    return items.slice(0, 2).join(" | ") || "hold this layout";
  }

  function __isOncomingTabVisible() {
    const oncomingTab = document.getElementById("oncomingAssignmentTab");
    return !!(oncomingTab && oncomingTab.style.display !== "none");
  }

  function __syncOncomingQualityPanelVisibility() {
    const panel = document.getElementById("oncomingQualityPanel");
    if (!panel) return;
    if (!__isOncomingTabVisible()) {
      panel.style.display = "none";
      panel.innerHTML = "";
      return;
    }
    if (!panel.innerHTML.trim()) return;
    panel.style.display = "block";
  }

  function __renderOncomingQualityPanel() {
    const host = document.getElementById("globalAssignmentPrintActions");
    let panel = document.getElementById("oncomingQualityPanel");
    if (!panel && host) {
      panel = document.createElement("div");
      panel.id = "oncomingQualityPanel";
      host.appendChild(panel);
    }
    if (!panel) return;

    if (!__isOncomingTabVisible()) {
      panel.style.display = "none";
      panel.innerHTML = "";
      return;
    }

    const prevMaps = __getPrevMapsForCycle();
    const { prevRnByPid, prevPcaByPid } = prevMaps || buildPrevOwnerMaps();
    const nurses = __getIncomingNurses();
    const openPcas = __getIncomingPcas().filter((p) => !(p?.isSitter && String(p?.sitterRoomPair || "").trim()));
    const rnScore = __nonIdealScore(nurses, "nurse", prevRnByPid);
    const pcaScore = __nonIdealScore(openPcas, "pca", prevPcaByPid);
    const lastDebug = window.__lastOncomingRebalanceDebug || {};
    const lastAfter = lastDebug.after || {};
    const lastV2 = lastDebug.v2 || {};
    const lastRnV2 = lastV2.rn || null;
    const lastPcaV2 = lastV2.pca || null;
    const lastRnAfterCounts = __formatOwnerCounts(lastAfter.rn);
    const lastPcaAfterCounts = __formatOwnerCounts(lastAfter.pca);
    const lastRnReason = __formatEngineReason(lastRnV2, "No RN candidate accepted.");
    const lastPcaReason = __formatEngineReason(lastPcaV2, "No PCA candidate accepted.");
    const lastRnEngine = String(lastRnV2?.engine || "Engine");
    const lastPcaEngine = String(lastPcaV2?.engine || "Engine");
    const lastClick = lastDebug.clickReceivedAt || lastDebug.startedAt || "";
    const rnSummary = __boardQualitySummary(rnScore, "RN");
    const pcaSummary = __boardQualitySummary(pcaScore, "PCA");
    const rnNeeds = __boardQualityNeeds(rnScore, "RN");
    const pcaNeeds = __boardQualityNeeds(pcaScore, "PCA");
    const collapsed = window.__oncomingQualityPanelCollapsed !== false;
    const detailStyle = collapsed ? "display:none;" : "display:block;";
    const caret = collapsed ? "▸" : "▾";
    const rnCounts = rnNeeds;
    const pcaCounts = pcaNeeds;

    panel.style.display = "block";
    panel.style.width = "100%";
    panel.innerHTML = `
      <div class="oncoming-quality-card" style="display:block; width:100%; box-sizing:border-box; background:#fff; border:1px solid #d7dde8; border-radius:12px; padding:10px 12px; box-shadow:0 8px 18px rgba(15,23,42,0.08);">
        <button type="button" class="oncoming-quality-toggle" aria-expanded="${collapsed ? "false" : "true"}" onclick="window.toggleOncomingQualityPanel && window.toggleOncomingQualityPanel()">
          <span>${caret}</span>
          <span>Board Quality</span>
        </button>
        <div style="${detailStyle}">
        <div class="oncoming-quality-line"><strong>RN:</strong> ${escapeHtml(rnSummary)}</div>
        <div class="oncoming-quality-meta">Focus: ${escapeHtml(rnNeeds)}</div>
        <div class="oncoming-quality-line"><strong>PCA:</strong> ${escapeHtml(pcaSummary)}</div>
        <div class="oncoming-quality-meta">RN counts: ${escapeHtml(rnCounts || "—")}</div>
        <div class="oncoming-quality-meta">PCA counts: ${escapeHtml(pcaCounts || "—")}</div>
        <div class="oncoming-quality-meta">Last path: ${escapeHtml(String(lastDebug.path || "none"))}</div>
        <div class="oncoming-quality-meta">Last click: ${escapeHtml(String(lastClick || "none"))}</div>
        <div class="oncoming-quality-meta">Last RN after: ${escapeHtml(lastRnAfterCounts || "none")}</div>
        <div class="oncoming-quality-meta">Last PCA after: ${escapeHtml(lastPcaAfterCounts || "none")}</div>
        <div class="oncoming-quality-meta">Last RN engine: ${escapeHtml(`${lastRnEngine}: ${String(lastRnReason || "none")}`)}</div>
        <div class="oncoming-quality-meta">Last PCA engine: ${escapeHtml(`${lastPcaEngine}: ${String(lastPcaReason || "none")}`)}</div>
      </div>
    `;
  }

  function __restoreSingleOwnerArrays(owners, snapshot) {
    safeArray(owners).forEach((owner, idx) => {
      if (!owner) return;
      owner.patients = safeArray(snapshot?.[idx]).slice();
    });
  }

  function __fullRebuildOwnersForRole(owners, role, activePatients) {
    const list = Array.isArray(owners) ? owners.filter(Boolean) : [];
    const pts = Array.isArray(activePatients) ? activePatients.filter((p) => p && !p.isEmpty) : [];
    if (!list.length || !pts.length) return { changed: false, avoidable: getAvoidableViolationCount(list, role) };

    const before = __snapshotSingleOwnerArrays(list);
    list.forEach((owner) => { owner.patients = []; });

    try {
      if (role === "pca") {
        const { unlockedPool } = applyPcaPinsBeforeDistribute(pts, list);
        if (typeof window.distributePatientsEvenly === "function") {
          window.distributePatientsEvenly(list, unlockedPool, { randomize: false, role: "pca", preserveExisting: true });
        }
      } else {
        const { unlockedPool } = applyRnPinsBeforeDistribute(pts);
        if (typeof window.distributePatientsEvenly === "function") {
          window.distributePatientsEvenly(list, unlockedPool, { randomize: false, role: "nurse", preserveExisting: true });
        }
      }

      rebalanceExpectedDischarges(list, role, { maxPasses: role === "nurse" ? 180 : 120 });
      balanceCountsWithoutCreatingNewAvoidableViolations(list, role, { maxPasses: 80 });
      rebalanceExpectedDischarges(list, role, { maxPasses: role === "nurse" ? 180 : 120 });
      if (typeof window.repairAssignmentsInPlace === "function") {
        window.repairAssignmentsInPlace(list, role, null, { maxIters: role === "nurse" ? 50 : 35 });
      }
      rebalanceExpectedDischarges(list, role, { maxPasses: role === "nurse" ? 180 : 120 });

      const afterAvoidable = getAvoidableViolationCount(list, role);
      const beforeAvoidable = getAvoidableViolationCount(before.map((patients) => ({ patients })), role);
      const changed = JSON.stringify(before) !== JSON.stringify(__snapshotSingleOwnerArrays(list));
      return { changed, avoidable: afterAvoidable, improved: afterAvoidable < beforeAvoidable };
    } catch (e) {
      console.warn("[oncoming rebuild] role rebuild failed", role, e);
      __restoreSingleOwnerArrays(list, before);
      return { changed: false, avoidable: getAvoidableViolationCount(list, role), error: e };
    }
  }

  function __prevMapToObject(prevMap) {
    const out = {};
    if (!(prevMap instanceof Map)) return out;
    prevMap.forEach((value, key) => {
      out[Number(key)] = String(value || "");
    });
    return out;
  }

  function __getPreferredAssignmentEngine() {
    if (window.assignmentEngineV3 && typeof window.assignmentEngineV3.solve === "function") {
      return { label: "Engine V3", solver: window.assignmentEngineV3.solve };
    }
    if (window.assignmentEngineV2 && typeof window.assignmentEngineV2.solve === "function") {
      return { label: "Engine V2", solver: window.assignmentEngineV2.solve };
    }
    return null;
  }

  function __applyEngineV2Solution(owners, patients, role, prevMap, opts = {}) {
    const engine = __getPreferredAssignmentEngine();
    if (!engine) {
      return { applied: false, reason: "No assignment engine loaded." };
    }

    const list = Array.isArray(owners) ? owners.filter(Boolean) : [];
    const pts = Array.isArray(patients) ? patients.filter((p) => p && !p.isEmpty) : [];
    if (!list.length || !pts.length) return { applied: false, reason: "No owners or patients available." };

    const before = __snapshotSingleOwnerArrays(list);
    const beforeAvoid = getAvoidableViolationCount(list, role);
    const beforeDischarge = getAvoidableExpectedDischargeOverflowLocal(list, role);
    const beforeSpread = countSpreadLocal(list);
    const beforeRoomOverflow = roomSpreadOverflowLocal(list, role);
    const beforeReport = prevMap ? __reportOverflowTotal(list, prevMap) : 0;

    try {
      const seedOwners = !!opts.reseedOwners
        ? list.map((owner) => ({
            id: owner.id,
            name: owner.name,
            patients: [],
            isSitter: !!owner?.isSitter,
            sitterRoomPair: owner?.sitterRoomPair || ""
          }))
        : list.map((owner) => ({
            id: owner.id,
            name: owner.name,
            patients: safeArray(owner?.patients).slice(),
            isSitter: !!owner?.isSitter,
            sitterRoomPair: owner?.sitterRoomPair || ""
          }));

      const result = engine.solver({
        role,
        owners: seedOwners,
        patients: pts.map((p) => ({ ...p })),
        prevOwnerByPid: __prevMapToObject(prevMap),
        maxPasses: typeof opts.maxPasses === "number" ? opts.maxPasses : 120
      });

      const solvedOwners = safeArray(result?.owners);
      if (!solvedOwners.length) {
        __restoreSingleOwnerArrays(list, before);
        return { applied: false, reason: `${engine.label} returned no solution.`, engine: engine.label };
      }

      const byId = new Map(solvedOwners.map((owner) => [Number(owner.id), safeArray(owner?.patients).slice()]));
      list.forEach((owner) => {
        owner.patients = byId.has(Number(owner.id)) ? byId.get(Number(owner.id)).slice() : [];
      });

      const afterAvoid = getAvoidableViolationCount(list, role);
      const afterDischarge = getAvoidableExpectedDischargeOverflowLocal(list, role);
      const afterSpread = countSpreadLocal(list);
      const afterRoomOverflow = roomSpreadOverflowLocal(list, role);
      const afterReport = prevMap ? __reportOverflowTotal(list, prevMap) : 0;
      const changed = JSON.stringify(before) !== JSON.stringify(__snapshotSingleOwnerArrays(list));
      const improved =
        afterAvoid < beforeAvoid ||
        (afterAvoid === beforeAvoid && afterDischarge < beforeDischarge) ||
        (afterAvoid === beforeAvoid && afterDischarge === beforeDischarge && afterSpread < beforeSpread) ||
        (afterAvoid === beforeAvoid && afterDischarge === beforeDischarge && afterSpread === beforeSpread && afterRoomOverflow < beforeRoomOverflow) ||
        (afterAvoid === beforeAvoid && afterDischarge === beforeDischarge && afterSpread === beforeSpread && afterRoomOverflow === beforeRoomOverflow && afterReport < beforeReport);

      const cleanEnough = afterAvoid <= 0 && afterDischarge <= 0 && afterSpread <= 1 && afterRoomOverflow <= 0;
      const acceptableByForce =
        !!opts.forceApply &&
        changed &&
        (
          improved ||
          cleanEnough ||
          afterSpread < beforeSpread ||
          afterAvoid < beforeAvoid ||
          afterDischarge < beforeDischarge ||
          afterRoomOverflow < beforeRoomOverflow
        );

      if (!changed || (!improved && !cleanEnough && !acceptableByForce)) {
        __restoreSingleOwnerArrays(list, before);
        return {
          applied: false,
          reason: `${engine.label} did not improve this assignment.`,
          engine: engine.label,
          summary: result?.summary || null,
          metrics: {
            beforeAvoid,
            beforeDischarge,
            beforeSpread,
            beforeRoomOverflow,
            beforeReport,
            afterAvoid,
            afterDischarge,
            afterSpread,
            afterRoomOverflow,
            afterReport,
            changed,
            improved,
            cleanEnough
          }
        };
      }

      return {
        applied: true,
        changed: true,
        engine: engine.label,
        summary: result?.summary || null,
        metrics: {
          beforeAvoid,
          beforeDischarge,
          beforeSpread,
          beforeRoomOverflow,
          beforeReport,
          afterAvoid,
          afterDischarge,
          afterSpread,
          afterRoomOverflow,
          afterReport,
          changed,
          improved,
          cleanEnough,
          acceptableByForce
        }
      };
    } catch (e) {
      console.warn("[assignment engine] solve failed", role, e);
      __restoreSingleOwnerArrays(list, before);
      return { applied: false, reason: `${engine.label} solve failed.`, engine: engine.label };
    }
  }

  function balanceCountsWithoutCreatingNewAvoidableViolations(owners, role, opts = {}) {
    const maxPasses = typeof opts.maxPasses === "number" ? opts.maxPasses : 60;
    const list = Array.isArray(owners) ? owners : [];
    const n = list.length;
    if (n < 2) return { ok: true, changed: false };

    const assignedSet = new Set();
    list.forEach(o => (Array.isArray(o?.patients) ? o.patients : []).forEach(pid => assignedSet.add(Number(pid))));
    const totalAssigned = assignedSet.size;

    const { minTarget, maxTarget } = computeCountTargets(totalAssigned, n);

    // Report-source-aware: prefer moves that don't increase report overflow (fewer handoffs).
    const maps = buildPrevOwnerMaps();
    const prevMap = role === "nurse" ? maps.prevRnByPid : maps.prevPcaByPid;

    let changed = false;
    let passes = 0;

    while (passes < maxPasses) {
      passes++;

      const counts = list.map(o => (Array.isArray(o?.patients) ? o.patients.length : 0));
      const spread = Math.max(...counts) - Math.min(...counts);
      if (spread <= 1) break;

      const over2 = list
        .map(o => ({ o, c: (Array.isArray(o?.patients) ? o.patients.length : 0) }))
        .sort((a, b) => b.c - a.c);

      const under2 = list
        .map(o => ({ o, c: (Array.isArray(o?.patients) ? o.patients.length : 0) }))
        .sort((a, b) => a.c - b.c);

      const from = over2[0]?.o;
      const to = under2[0]?.o;
      if (!from || !to || from === to) break;

      const movable = getMovablePatientIdsFromOwner(from, role);
      if (!movable.length) break;

      const baseViol = getAvoidableViolationCount(list, role);
      const baseReportOverflow = prevMap ? __reportOverflowTotal(list, prevMap) : 0;
      let best = null;

      for (const pid of movable) {
        const fromOrig = from.patients.slice();
        const toOrig = to.patients.slice();

        const did = tryMovePatient(list, role, from, to, pid);
        if (!did) {
          from.patients = fromOrig;
          to.patients = toOrig;
          continue;
        }

        const nextViol = getAvoidableViolationCount(list, role);
        const nextReportOverflow = prevMap ? __reportOverflowTotal(list, prevMap) : 0;

        from.patients = fromOrig;
        to.patients = toOrig;

        if (nextViol > baseViol) continue;

        // Prefer: fewer violations first, then lower report overflow (report-source aware).
        const violScore = baseViol - nextViol;
        const reportScore = baseReportOverflow - nextReportOverflow;
        if (!best) {
          best = { pid, nextViol, nextReportOverflow, violScore, reportScore };
          if (violScore > 0) break;
          continue;
        }
        if (violScore > best.violScore) {
          best = { pid, nextViol, nextReportOverflow, violScore, reportScore };
          if (violScore > 0) break;
          continue;
        }
        if (violScore === best.violScore && nextReportOverflow < best.nextReportOverflow) {
          best = { pid, nextViol, nextReportOverflow, violScore, reportScore };
        }
      }

      if (!best) break;

      const didApply = tryMovePatient(list, role, from, to, best.pid);
      if (!didApply) break;

      changed = true;

      const counts2 = list.map(o => (Array.isArray(o?.patients) ? o.patients.length : 0));
      const spread2 = Math.max(...counts2) - Math.min(...counts2);
      if (spread2 <= 1) break;

      const okCaps = counts2.every(c => c >= minTarget && c <= maxTarget);
      if (okCaps) break;

      void maxTarget;
    }

    return { ok: true, changed, passes };
  }

  // -----------------------------
  // Explanation + rule flag helpers
  // -----------------------------
  function safeGetPerOwnerExplain(owner, ownersAll, role) {
    try {
      if (window.explain && typeof window.explain.perOwner === "function") {
        return window.explain.perOwner(owner, ownersAll, role);
      }
    } catch (e) {
      console.warn("[explain] perOwner failed", e);
    }
    return "";
  }

  function safeGetRuleEvalMap(ownersAll, role) {
    try {
      if (typeof window.evaluateAssignmentHardRules === "function") {
        return window.evaluateAssignmentHardRules(ownersAll, role);
      }
    } catch (e) {
      console.warn("[rules] evaluateAssignmentHardRules failed", e);
    }
    return null;
  }

  function getOwnerRuleEvalFromMap(owner, map) {
    if (!map) return null;

    const key = owner?.name || owner?.label || null;
    if (key && map[key]) return map[key];

    if (key) {
      const keys = Object.keys(map);
      const foundKey = keys.find(k => String(k).toLowerCase() === String(key).toLowerCase());
      if (foundKey) return map[foundKey];
    }
    return null;
  }

  function buildRuleTooltip(ruleEval) {
    if (!ruleEval) return "";
    const v = Array.isArray(ruleEval.violations) ? ruleEval.violations : [];
    const w = Array.isArray(ruleEval.warnings) ? ruleEval.warnings : [];
    if (!v.length && !w.length) return "";

    const parts = [];
    v.forEach(x => parts.push(`❗ ${x.tag}: ${x.mine} > ${x.limit}`));
    w.forEach(x => parts.push(`⚠ ${x.tag}: ${x.mine} > ${x.limit} (may be unavoidable)`));
    return parts.join(" • ");
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function firstNameOnly(name) {
    const raw = String(name || "").trim();
    if (!raw) return "";
    const noId = raw.replace(/#?\d{4,}/g, "").trim();
    const first = noId.split(/\s+/).filter(Boolean)[0] || "";
    return first || raw;
  }

  // Keep this API (even though we removed 💡 buttons)
  window.__openOwnerExplain = function (btnEl) {
    try {
      const text = btnEl?.getAttribute("data-explain") || btnEl?.title || "";
      if (!text) return;
      alert(text);
    } catch (e) {
      console.warn("__openOwnerExplain failed", e);
    }
  };

  // ✅ Lightweight pin hover handler (replaces per-row IIFEs)
  if (!window.__cuppPinHoverHandler) {
    window.__cuppPinHoverHandler = function (ev, enter) {
      try {
        const tr = ev?.currentTarget || ev?.target;
        if (!tr) return;
        const btn = tr.querySelector && tr.querySelector('button[data-pinbtn="1"]');
        if (!btn) return;

        const pinned = btn.getAttribute("data-pinned") === "1";
        if (pinned) {
          btn.style.opacity = "1";
          btn.style.pointerEvents = "auto";
          return;
        }

        if (enter) {
          btn.style.opacity = "0.55";
          btn.style.pointerEvents = "auto";
        } else {
          btn.style.opacity = "0";
          btn.style.pointerEvents = "none";
        }
      } catch (_) {}
    };
  }

  // -----------------------------
  // ✅ Empty drop-row helper
  // -----------------------------
  function buildEmptyDropRow(colspan, label) {
    return `
      <tr class="empty-drop-row" draggable="false" style="height:48px;">
        <td colspan="${colspan}" style="
          padding:14px 10px;
          text-align:center;
          font-size:12px;
          opacity:0.65;
          border-top:1px dashed rgba(15,23,42,0.12);
        ">
          ${escapeHtml(label || "Drop patients here")}
        </td>
      </tr>
    `;
  }

  // =========================================================
  // ✅ Status banner helpers
  // =========================================================
  function __ensureBanner(containerId, bannerId) {
    const container = document.getElementById(containerId);
    if (!container) return null;

    let el = document.getElementById(bannerId);
    if (!el) {
      el = document.createElement("div");
      el.id = bannerId;
      el.style.cssText = [
        "display:none",
        "margin:10px 0 14px 0",
        "padding:10px 12px",
        "border-radius:10px",
        "font-size:12px",
        "line-height:1.25",
        "border:1px solid rgba(15,23,42,0.12)",
        "background:rgba(15,23,42,0.03)"
      ].join(";");
      container.prepend(el);
    }
    return el;
  }

  function __setBanner(containerId, bannerId, kind, msg) {
    const el = __ensureBanner(containerId, bannerId);
    if (!el) return;

    const safeMsg = escapeHtml(msg || "");
    if (!safeMsg) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }

    let border = "rgba(15,23,42,0.12)";
    let bg = "rgba(15,23,42,0.03)";
    let title = "Update";

    if (kind === "ok") {
      border = "rgba(16,185,129,0.35)";
      bg = "rgba(16,185,129,0.08)";
      title = "Rebalance applied";
    } else if (kind === "warn") {
      border = "rgba(245,158,11,0.45)";
      bg = "rgba(245,158,11,0.10)";
      title = "No safe improvement found";
    } else if (kind === "bad") {
      border = "rgba(239,68,68,0.45)";
      bg = "rgba(239,68,68,0.10)";
      title = "Blocked";
    }

    el.style.borderColor = border;
    el.style.background = bg;
    el.style.display = "block";
    el.innerHTML = `<strong style="display:block;margin-bottom:4px;">${escapeHtml(title)}</strong>${safeMsg}`;
  }

  function __clearBanners() {
    __setBanner("assignmentOutput", "oncomingStatusRn", "", "");
    __setBanner("pcaAssignmentOutput", "oncomingStatusPca", "", "");
  }

  function __showOncomingRebalanceToast(kind, msg) {
    let el = document.getElementById("oncomingRebalanceToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "oncomingRebalanceToast";
      el.style.cssText = [
        "display:none",
        "max-width:100%",
        "padding:10px 12px",
        "border-radius:10px",
        "font-size:12px",
        "line-height:1.3",
        "box-shadow:0 8px 20px rgba(0,0,0,0.12)"
      ].join(";");
      const host = document.getElementById("globalAssignmentPrintActions");
      if (host) host.appendChild(el);
      else document.body.appendChild(el);
    }
    const safe = escapeHtml(msg || "");
    if (!safe) {
      el.style.display = "none";
      el.textContent = "";
      return;
    }

    if (kind === "ok") {
      el.style.background = "rgba(16,185,129,0.95)";
      el.style.color = "#052e1c";
      el.style.border = "1px solid rgba(16,185,129,0.95)";
    } else if (kind === "warn") {
      el.style.background = "rgba(245,158,11,0.95)";
      el.style.color = "#2b1300";
      el.style.border = "1px solid rgba(245,158,11,0.95)";
    } else {
      el.style.background = "rgba(15,23,42,0.95)";
      el.style.color = "#fff";
      el.style.border = "1px solid rgba(15,23,42,0.95)";
    }

    el.innerHTML = safe;
    el.style.display = "block";
    clearTimeout(window.__oncomingRebalanceToastTimer);
    window.__oncomingRebalanceToastTimer = setTimeout(() => {
      if (el) el.style.display = "none";
    }, 4200);
  }

  function __setRebalanceButtonBusy(isBusy) {
    const btn = document.getElementById("btnRebalanceOncomingBoth");
    if (!btn) return;
    btn.disabled = !!isBusy;
    btn.textContent = isBusy ? "Rebalancing..." : "Rebalance (Both)";
    btn.style.opacity = isBusy ? "0.75" : "";
    btn.style.cursor = isBusy ? "progress" : "";
  }

  function __suspendOncomingAutoPopulate(ms) {
    const dur = Math.max(0, Number(ms) || 0);
    window.__oncomingAutoPopulateSuspendUntil = Date.now() + dur;
    clearTimeout(window.__oncomingAutoPopulateTimer);
  }

  function __suspendCloudRealtimeApply(ms) {
    const dur = Math.max(0, Number(ms) || 0);
    window.__cloud = window.__cloud || {};
    window.__cloud.suspendRealtimeApplyUntil = Date.now() + dur;
  }

  function __setOncomingPopulateStatus(state, metaText) {
    const pill = document.getElementById("oncomingPopulateStatus");
    if (!pill) return;

    const dot = pill.querySelector && pill.querySelector(".staffing-status-dot");
    const textEl = pill.querySelector && pill.querySelector(".staffing-status-text");
    const metaEl = pill.querySelector && pill.querySelector(".staffing-status-meta");

    pill.setAttribute("data-state", String(state || ""));

    const isComplete = state === "complete";
    const isRebalancing = state === "rebalancing";
    if (dot) dot.style.background = isComplete ? "#22c55e" : (isRebalancing ? "#2563eb" : "#fbbf24");
    if (textEl) textEl.textContent = isComplete ? "All Patients Populated" : (isRebalancing ? "Rebalancing Assignments" : "Populating");
    if (metaEl) metaEl.textContent = metaText || "";
  }

  function __refreshOncomingPopulateStatus() {
    const ptsAll = __getPatients();
    const active = ptsAll.filter(p => p && !p.isEmpty);
    const total = active.length;

    const rnSet = new Set();
    const pcaSet = new Set();

    __getIncomingNurses().forEach(rn => {
      (rn?.patients || []).forEach(pid => rnSet.add(Number(pid)));
    });

    __getIncomingPcas().forEach(pca => {
      (pca?.patients || []).forEach(pid => pcaSet.add(Number(pid)));
    });

    const populatedCount = active.reduce((sum, p) => {
      const pid = Number(p?.id);
      if (!Number.isFinite(pid)) return sum;
      return sum + (rnSet.has(pid) && pcaSet.has(pid) ? 1 : 0);
    }, 0);

    const allPopulated = total === 0 ? true : populatedCount === total;
    __setOncomingPopulateStatus(allPopulated ? "complete" : "populating", `${populatedCount}/${total}`);

    const canAutoPopulate = !!(__getIncomingNurses().length && __getIncomingPcas().length && total > 0);
    const suspendedUntil = Number(window.__oncomingAutoPopulateSuspendUntil || 0);
    const autoPopulateSuspended = Date.now() < suspendedUntil;
    if (canAutoPopulate && !autoPopulateSuspended && !allPopulated && !window.__oncomingPopulateInFlight && !window.__oncomingRebalanceBothInFlight) {
      const now = Date.now();
      const last = Number(window.__oncomingAutoPopulateTs || 0);
      if (now - last > 1500) {
        window.__oncomingAutoPopulateTs = now;
        clearTimeout(window.__oncomingAutoPopulateTimer);
        window.__oncomingAutoPopulateTimer = setTimeout(() => {
          try {
            if (!window.__oncomingPopulateInFlight && !window.__oncomingRebalanceBothInFlight) {
              populateOncomingAssignment(false);
            }
          } catch (_) {}
        }, 180);
      }
    }
  }

  // =========================================================
  // ✅ UI helper (Report sources only)
  // =========================================================
  function __buildMetaRowHtml(reportSources) {
    const rs = (reportSources === undefined || reportSources === null) ? "—" : String(reportSources);

    return `
      <div style="
        display:flex;
        align-items:baseline;
        justify-content:flex-end;
        gap:12px;
        width:100%;
        margin-top:2px;
        font-size:12px;
        opacity:0.80;
      ">
        <div style="white-space:nowrap;">
          <strong>Report sources:</strong> ${escapeHtml(rs)}
        </div>
      </div>
    `;
  }

  // =========================================================
  // ✅ Rebalance visibility helpers (before/after deltas)
  // =========================================================
  function __snapshotOwners(owners) {
    const snap = new Map();
    (owners || []).forEach(o => {
      const id = Number(o?.id);
      const pts = Array.isArray(o?.patients) ? o.patients.slice() : [];
      if (Number.isFinite(id)) snap.set(id, pts.map(Number));
    });
    return snap;
  }

  function __restoreOwnersFromSnapshot(owners, snap) {
    (owners || []).forEach((o) => {
      const id = Number(o?.id);
      if (!Number.isFinite(id)) return;
      o.patients = safeArray(snap?.get(id)).slice();
    });
  }

  function __countMovesFromSnapshots(beforeSnap, ownersAfter) {
    try {
      let moves = 0;
      (ownersAfter || []).forEach(o => {
        const id = Number(o?.id);
        const after = Array.isArray(o?.patients) ? o.patients.map(Number) : [];
        const before = beforeSnap?.get(id) || [];
        if (before.length !== after.length) {
          moves += Math.abs(before.length - after.length);
          return;
        }
        // same length: count membership changes
        const b = new Set(before);
        const a = new Set(after);
        let diff = 0;
        before.forEach(pid => { if (!a.has(pid)) diff++; });
        after.forEach(pid => { if (!b.has(pid)) diff++; });
        moves += diff;
      });
      // moves above double-counts across two owners; normalize
      return Math.max(0, Math.round(moves / 2));
    } catch {
      return 0;
    }
  }

  function __reportStatsForOwners(owners, role, prevMap) {
    const list = Array.isArray(owners) ? owners : [];
    const counts = list.map(o => (Array.isArray(o?.patients) ? o.patients.length : 0));
    const maxCount = counts.length ? Math.max(...counts) : 0;
    const minCount = counts.length ? Math.min(...counts) : 0;

    const reportCounts = list.map(o => uniqueCountFromMap(o?.patients || [], prevMap));
    const maxReport = reportCounts.length ? Math.max(...reportCounts) : 0;
    const sumReport = reportCounts.reduce((a, b) => a + (Number(b) || 0), 0);

    const avoid = getAvoidableViolationCount(list, role);

    return {
      minCount,
      maxCount,
      maxReport,
      sumReport,
      avoid
    };
  }

  function __formatDeltaLine(label, before, after) {
    if (before === after) return `${label}: ${before}`;
    return `${label}: ${before} → ${after}`;
  }

  // =========================================================
  // RN Oncoming Render
  // =========================================================
  function __renderAssignmentOutputWithCache(prevMaps) {
    __syncIncomingGlobals();

    const container = document.getElementById("assignmentOutput");
    if (!container) return;

    if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

    let html = "";
    const allOwners = __getIncomingNurses();
    const activeIdSet = new Set(
      __getPatients()
        .filter((p) => p && !p.isEmpty)
        .map((p) => Number(p.id))
        .filter(Number.isFinite)
    );

    const { prevRnByPid } = prevMaps || buildPrevOwnerMaps();

    // ✅ PERF: rules map once
    const rnRuleMap = safeGetRuleEvalMap(allOwners, "nurse");

    allOwners.forEach(nurse => {
      const validAssignedIds = __sanitizeOwnerAssignmentsToActiveBeds(nurse, activeIdSet);
      const pts = validAssignedIds
        .map(pid => getPatientById(pid))
        .filter(p => p && !p.isEmpty)
        .sort(safeSortPatientsForDisplay);

      const loadScore = (typeof getNurseLoadScore === "function") ? getNurseLoadScore(nurse) : 0;
      const loadClass = (typeof getLoadClass === "function") ? getLoadClass(loadScore, "nurse") : "";

      const reportSources = uniqueCountFromMap(nurse.patients || [], prevRnByPid);

      const ruleEval = getOwnerRuleEvalFromMap(nurse, rnRuleMap);
      const vCount = ruleEval?.violations?.length || 0;
      const wCount = ruleEval?.warnings?.length || 0;
      const ruleTip = buildRuleTooltip(ruleEval);

      html += `
        <div class="assignment-card ${loadClass}">
          <div class="assignment-header">
            <div style="display:flex;align-items:flex-start;gap:10px;">
              <div style="min-width:0;flex:1;">
                <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;">
                  <div style="min-width:0;">
                    <strong>${escapeHtml(nurse.name)}</strong> (${escapeHtml((nurse.type || "").toUpperCase())})
                  </div>
                  ${
                    (vCount || wCount)
                      ? `<button class="icon-btn ${vCount ? "flag-bad" : "flag-warn"}" type="button"
                          title="${escapeHtml(ruleTip || "Rule flag(s) present")}"
                          style="flex:0 0 auto;">!</button>`
                      : ``
                  }
                </div>

                ${__buildMetaRowHtml(reportSources)}
              </div>
            </div>

            <div>Patients: ${pts.length} | Load Score: ${loadScore}</div>
          </div>

          <table class="assignment-table">
            <thead>
              <tr>
                <th>Bed</th>
                <th>Level</th>
                <th>Acuity Notes</th>
                <th>Prev. RN</th>
              </tr>
            </thead>
            <tbody
              ondragover="onRowDragOver(event)"
              ondrop="onRowDrop(event, 'incoming', 'nurse', ${nurse.id})"
            >
      `;

      if (!pts.length) {
        html += buildEmptyDropRow(4, "Drop a patient here to assign to this RN");
      }

      pts.forEach(p => {
        const prevName = firstNameOnly(prevRnByPid.get(Number(p.id)) || "");

        const pinned = isPatientPinnedToIncomingRn(p.id, nurse.id);
        const draggable = pinned ? "false" : "true";

        const pinControl = `
          <button
            type="button"
            aria-label="Pin patient to this RN"
            title="${escapeHtml(pinned ? "Pinned to this RN (click to unpin)" : "Pin to this RN (preserve on regenerate)")}"
            onclick="window.toggleIncomingRnPin(${p.id}, ${nurse.id})"
            data-pinbtn="1"
            data-pinned="${pinned ? "1" : "0"}"
            style="
              margin-left:8px;
              border:none;
              background:transparent;
              cursor:pointer;
              font-size:14px;
              line-height:1;
              padding:0;
              opacity:${pinned ? "1" : "0"};
              pointer-events:${pinned ? "auto" : "none"};
            "
          >📌</button>
        `;

        html += `
          <tr
            draggable="${draggable}"
            ondragstart="onRowDragStart(event, 'incoming', 'nurse', ${nurse.id}, ${p.id})"
            ondragend="onRowDragEnd(event)"
            ondblclick="openPatientProfileFromRoom(${p.id})"
            onmouseenter="window.__cuppPinHoverHandler(event, true)"
            onmouseleave="window.__cuppPinHoverHandler(event, false)"
            style="${pinned ? "opacity:0.98;" : ""}"
          >
            <td>${bedCellHtml(p, pinControl)}</td>
            <td>${p.tele ? "Tele" : "MS"}</td>
            <td>${typeof rnTagString === "function" ? rnTagString(p) : ""}</td>
            <td>${escapeHtml(prevName || "-")}</td>
          </tr>
        `;
      });

      html += `
            </tbody>
          </table>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  // =========================================================
  // PCA Oncoming Render
  // =========================================================
  function __renderPcaAssignmentOutputWithCache(prevMaps) {
    __syncIncomingGlobals();

    const container = document.getElementById("pcaAssignmentOutput");
    if (!container) return;

    if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

    let html = "";
    const allOwners = __getIncomingPcas();
    const activeIdSet = new Set(
      __getPatients()
        .filter((p) => p && !p.isEmpty)
        .map((p) => Number(p.id))
        .filter(Number.isFinite)
    );

    const { prevPcaByPid } = prevMaps || buildPrevOwnerMaps();

    // ✅ PERF: rules map once
    const pcaRuleMap = safeGetRuleEvalMap(allOwners, "pca");

    allOwners.forEach(pca => {
      const validAssignedIds = __sanitizeOwnerAssignmentsToActiveBeds(pca, activeIdSet);
      const pts = validAssignedIds
        .map(pid => getPatientById(pid))
        .filter(p => p && !p.isEmpty)
        .sort(safeSortPatientsForDisplay);

      const loadScore = (typeof getPcaLoadScore === "function") ? getPcaLoadScore(pca) : 0;
      const loadClass = (typeof getLoadClass === "function") ? getLoadClass(loadScore, "pca") : "";

      const reportSources = uniqueCountFromMap(pca.patients || [], prevPcaByPid);

      const ruleEval = getOwnerRuleEvalFromMap(pca, pcaRuleMap);
      const vCount = ruleEval?.violations?.length || 0;
      const wCount = ruleEval?.warnings?.length || 0;
      const ruleTip = buildRuleTooltip(ruleEval);
      const sitterPair = String(pca?.sitterRoomPair || "").trim();
      const isSitterPca = !!pca?.isSitter && !!sitterPair;
      const sitterRoomsLabel = isSitterPca ? `${sitterPair}A, ${sitterPair}B` : "";

      html += `
        <div class="assignment-card ${loadClass}">
          <div class="assignment-header">
            <div style="display:flex;align-items:flex-start;gap:10px;">
              <div style="min-width:0;flex:1;">
                <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;">
                  <div style="min-width:0;">
                    <strong>${escapeHtml(pca.name)}</strong> (${isSitterPca ? "Sitter" : "PCA"})${isSitterPca ? ` ${pts.length} | ${escapeHtml(sitterRoomsLabel)}` : ``}
                  </div>
                  ${
                    (vCount || wCount)
                      ? `<button class="icon-btn ${vCount ? "flag-bad" : "flag-warn"}" type="button"
                          title="${escapeHtml(ruleTip || "Rule flag(s) present")}"
                          style="flex:0 0 auto;">!</button>`
                      : ``
                  }
                </div>

                ${__buildMetaRowHtml(reportSources)}
              </div>
            </div>

            <div>${isSitterPca ? `Load Score: ${loadScore}` : `Patients: ${pts.length} | Load Score: ${loadScore}`}</div>
          </div>

          <table class="assignment-table">
            <thead>
              <tr>
                <th>Bed</th>
                <th>Level</th>
                <th>Acuity Notes</th>
                <th>Prev. PCA</th>
              </tr>
            </thead>
            <tbody
              ondragover="onRowDragOver(event)"
              ondrop="onRowDrop(event, 'incoming', 'pca', ${pca.id})"
            >
      `;

      if (!pts.length) {
        html += buildEmptyDropRow(4, "Drop a patient here to assign to this PCA");
      }

      pts.forEach(p => {
        const prevName = firstNameOnly(prevPcaByPid.get(Number(p.id)) || "");
        const pinned = isPatientPinnedToIncomingPca(p.id, pca.id);
        const draggable = pinned ? "false" : "true";
        const pinControl = `
          <button
            type="button"
            aria-label="Pin patient to this PCA"
            title="${escapeHtml(pinned ? "Pinned to this PCA (click to unpin)" : "Pin to this PCA (preserve on regenerate)")}"
            onclick="window.toggleIncomingPcaPin(${p.id}, ${pca.id})"
            data-pinbtn="1"
            data-pinned="${pinned ? "1" : "0"}"
            style="
              margin-left:8px;
              border:none;
              background:transparent;
              cursor:pointer;
              font-size:14px;
              line-height:1;
              padding:0;
              opacity:${pinned ? "1" : "0"};
              pointer-events:${pinned ? "auto" : "none"};
            "
          >📌</button>
        `;

        html += `
          <tr
            draggable="${draggable}"
            ondragstart="onRowDragStart(event, 'incoming', 'pca', ${pca.id}, ${p.id})"
            ondragend="onRowDragEnd(event)"
            ondblclick="openPatientProfileFromRoom(${p.id})"
            onmouseenter="window.__cuppPinHoverHandler(event, true)"
            onmouseleave="window.__cuppPinHoverHandler(event, false)"
            style="${pinned ? "opacity:0.98;" : ""}"
          >
            <td>${bedCellHtml(p, pinControl)}</td>
            <td>${p.tele ? "Tele" : "MS"}</td>
            <td>${typeof pcaTagString === "function" ? pcaTagString(p) : ""}</td>
            <td>${escapeHtml(prevName || "-")}</td>
          </tr>
        `;
      });

      html += `
            </tbody>
          </table>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  // Batch render (RN + PCA share the same prev maps)
  function renderOncomingAll() {
    __beginRenderCycle();
    __syncOncomingDischargeVisualToggle();
    const prevMaps = __getPrevMapsForCycle();
    __renderAssignmentOutputWithCache(prevMaps);
    __renderPcaAssignmentOutputWithCache(prevMaps);
    __refreshOncomingPopulateStatus();
    __renderOncomingQualityPanel();
  }

  // Public render fns (keep API stable)
  function renderAssignmentOutput() {
    __beginRenderCycle();
    __syncOncomingDischargeVisualToggle();
    const prevMaps = __getPrevMapsForCycle();
    __renderAssignmentOutputWithCache(prevMaps);
    __refreshOncomingPopulateStatus();
    __renderOncomingQualityPanel();
  }

  function renderPcaAssignmentOutput() {
    __beginRenderCycle();
    __syncOncomingDischargeVisualToggle();
    const prevMaps = __getPrevMapsForCycle();
    __renderPcaAssignmentOutputWithCache(prevMaps);
    __refreshOncomingPopulateStatus();
    __renderOncomingQualityPanel();
  }

  function renderSitterAssignmentOutput() {
    // Sitter is modeled as a PCA designation; no standalone sitter board.
    __refreshOncomingPopulateStatus();
  }

  // =========================================================
  // Generator (Oncoming populate + rebalance)
  // =========================================================
  function populateOncomingAssignment(randomize = false) {
    if (window.__oncomingPopulateInFlight) return;
    window.__oncomingPopulateInFlight = true;
    __suspendOncomingAutoPopulate(1200);
    __setOncomingPopulateStatus("populating");

    try {
      __syncIncomingGlobals();
      __clearBanners();

      if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

      const nurses = __getIncomingNurses();
      const pcas = __getIncomingPcas();
      const ptsAll = __getPatients();

      if (!nurses.length || !pcas.length) {
        alert("Please set up ONCOMING RNs and PCAs on the Staffing Details tab first.");
        return;
      }

      const activePatients = ptsAll.filter(p => p && !p.isEmpty);
      if (!activePatients.length) {
        alert("No active patients found.");
        return;
      }

      nurses.forEach(n => { n.patients = []; });
      pcas.forEach(p => { p.patients = []; });

      cleanupRnPinsAgainstRoster();
      cleanupPcaPinsAgainstRoster();

      let list = activePatients.slice();
      if (randomize) list.sort(() => Math.random() - 0.5);
      else list.sort(safeSortPatientsForDisplay);

      const { unlockedPool } = applyRnPinsBeforeDistribute(list);

      if (typeof window.distributePatientsEvenly === "function") {
        window.distributePatientsEvenly(nurses, unlockedPool, { randomize, role: "nurse", preserveExisting: true });
        const pinnedToSitterPcas = __enforceSitterAssignmentsExclusive(pcas, list);
        const openPcas = pcas.filter((p) => !(p?.isSitter && String(p?.sitterRoomPair || "").trim()));
        const pcaPoolSeed = list.filter((p) => !pinnedToSitterPcas.has(Number(p?.id)));
        const { unlockedPool: pcaPool } = applyPcaPinsBeforeDistribute(pcaPoolSeed, openPcas);
        if (openPcas.length) {
          window.distributePatientsEvenly(openPcas, pcaPool, { randomize, role: "pca", preserveExisting: true });
        }
        rebalanceSingleMovesStrict(nurses, "nurse", { maxPasses: 120 });
        if (openPcas.length) rebalanceSingleMovesStrict(openPcas, "pca", { maxPasses: 120 });
        rebalanceExpectedDischarges(nurses, "nurse", { maxPasses: 80 });
        if (openPcas.length) rebalanceExpectedDischarges(openPcas, "pca", { maxPasses: 80 });
      } else {
        alert("ERROR: distributePatientsEvenly is not loaded. Check script order + app.assignmentRules.js loading.");
        console.error("distributePatientsEvenly missing — check index.html script order and app.assignmentRules.js.");
        return;
      }

      // keep these passes reasonable to avoid UI lag
      rebalanceSingleMovesStrict(nurses, "nurse", { maxPasses: 80 });
      balanceCountsWithoutCreatingNewAvoidableViolations(nurses, "nurse", { maxPasses: 50 });
      const openPcasForBalance = pcas.filter((p) => !(p?.isSitter && String(p?.sitterRoomPair || "").trim()));
      rebalanceSingleMovesStrict(openPcasForBalance, "pca", { maxPasses: 80 });
      balanceCountsWithoutCreatingNewAvoidableViolations(openPcasForBalance, "pca", { maxPasses: 50 });

      if (typeof window.repairAssignmentsInPlace === "function") {
        window.repairAssignmentsInPlace(nurses, "nurse", null, { maxIters: 35 });
        window.repairAssignmentsInPlace(openPcasForBalance, "pca", null, { maxIters: 35 });
      }
      __enforceSitterAssignmentsExclusive(pcas, list);
      const populatePrevMaps = buildPrevOwnerMaps();
      __applyEngineV2Solution(nurses, activePatients, "nurse", populatePrevMaps.prevRnByPid, { maxPasses: 160, forceApply: true });
      __applyEngineV2Solution(openPcasForBalance, activePatients, "pca", populatePrevMaps.prevPcaByPid, { maxPasses: 160, forceApply: true });

      // ✅ batched render
      renderOncomingAll();

      if (typeof window.saveState === "function") window.saveState();
      if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
    } finally {
      window.__oncomingPopulateInFlight = false;
    }
  }

  function __runSafeRebalance(owners, role) {
    if (typeof window.rebalanceOwnersSafely !== "function") {
      if (typeof window.repairAssignmentsInPlace === "function") {
        window.repairAssignmentsInPlace(owners, role, null, { maxIters: 22 });
        return { applied: true, reason: "" };
      }
      return { applied: false, reason: "Rebalance engine not loaded." };
    }

    const res = window.rebalanceOwnersSafely(owners, role);
    if (!res?.applied) return { applied: false, reason: res?.reason || "Unable to rebalance safely." };
    return { applied: true, reason: "" };
  }

  function __waitForUiPaint() {
    return new Promise((resolve) => {
      const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
      raf(() => setTimeout(resolve, 0));
    });
  }

  async function rebalanceOncomingAssignment() {
    if (window.__oncomingRebalanceBothInFlight) return;
    window.__oncomingRebalanceBothInFlight = true;
    __setRebalanceButtonBusy(true);
    __suspendOncomingAutoPopulate(5000);
    __suspendCloudRealtimeApply(5000);
    __setOncomingPopulateStatus("rebalancing", "Thinking...");
    await __waitForUiPaint();

    try {
      __syncIncomingGlobals();
      __clearBanners();

      const nurses = __getIncomingNurses();
      const pcas = __getIncomingPcas();
      const ptsAll = __getPatients();

      // stats baseline (for visibility)
      const prevMaps = __getPrevMapsForCycle();
      const { prevRnByPid, prevPcaByPid } = prevMaps || buildPrevOwnerMaps();

      const beforeSnapRn = __snapshotOwners(nurses);
      const beforeSnapPca = __snapshotOwners(pcas);
      const beforeStatsRn = __reportStatsForOwners(nurses, "nurse", prevRnByPid);
      const beforeStatsPca = __reportStatsForOwners(pcas, "pca", prevPcaByPid);
      const beforeScoreRn = __nonIdealScore(nurses, "nurse", prevRnByPid);
      const beforeScorePca = __nonIdealScore(pcas.filter((p) => !(p?.isSitter && String(p?.sitterRoomPair || "").trim())), "pca", prevPcaByPid);
      const baselinePreventableRn = getAvoidableViolationCount(nurses, "nurse");
      const baselinePreventablePca = getAvoidableViolationCount(pcas.filter((p) => !(p?.isSitter && String(p?.sitterRoomPair || "").trim())), "pca");
      window.__lastOncomingRebalanceDebug = {
        startedAt: new Date().toISOString(),
        before: {
          rn: __debugOwnerSummary(nurses),
          pca: __debugOwnerSummary(pcas)
        },
        path: "starting"
      };

      try {
        cleanupRnPinsAgainstRoster();
        cleanupPcaPinsAgainstRoster();
        nurses.forEach(rn => {
          rn.patients = Array.isArray(rn.patients) ? rn.patients : [];
          rn.patients = rn.patients.filter(pid => !isPatientPinnedToIncomingRn(pid, rn.id));
        });
        pcas.forEach(pca => {
          pca.patients = Array.isArray(pca.patients) ? pca.patients : [];
          pca.patients = pca.patients.filter(pid => !isPatientPinnedToIncomingPca(pid, pca.id));
        });
        const active = ptsAll.filter(p => p && !p.isEmpty);
        applyRnPinsBeforeDistribute(active);
        const openPcasForPins = pcas.filter((p) => !(p?.isSitter && String(p?.sitterRoomPair || "").trim()));
        applyPcaPinsBeforeDistribute(active, openPcasForPins);
      } catch (e) {
        console.warn("[rebalance BOTH] pin placement pre-pass failed", e);
      }

      const openPcas = pcas.filter((p) => !(p?.isSitter && String(p?.sitterRoomPair || "").trim()));
      const activePatients = ptsAll.filter((p) => p && !p.isEmpty);
      let v2Rn = { applied: false, reason: "Engine V2 deferred to final pass." };
      let v2Pca = { applied: false, reason: "Engine V2 deferred to final pass." };
      window.__lastOncomingRebalanceDebug.v2 = {
        rn: v2Rn,
        pca: v2Pca,
        afterV2: {
          rn: __debugOwnerSummary(nurses),
          pca: __debugOwnerSummary(pcas)
        }
      };

      const strictMoveRn = rebalanceSingleMovesStrict(nurses, "nurse", { maxPasses: 140 });
      const strictMovePca = rebalanceSingleMovesStrict(openPcas, "pca", { maxPasses: 140 });
      const dischargePassRn = rebalanceExpectedDischarges(nurses, "nurse", { maxPasses: 160 });
      const dischargePassPca = rebalanceExpectedDischarges(openPcas, "pca", { maxPasses: 120 });
      let rnRes = __runSafeRebalance(nurses, "nurse");
      let pcaRes = __runSafeRebalance(openPcas, "pca");
      rebalanceSingleMovesStrict(nurses, "nurse", { maxPasses: 140 });
      rebalanceSingleMovesStrict(openPcas, "pca", { maxPasses: 140 });
      const rnCountFallback = balanceCountsWithoutCreatingNewAvoidableViolations(nurses, "nurse", { maxPasses: 80 });
      const pcaCountFallback = balanceCountsWithoutCreatingNewAvoidableViolations(openPcas, "pca", { maxPasses: 80 });
      rebalanceSingleMovesStrict(nurses, "nurse", { maxPasses: 140 });
      rebalanceSingleMovesStrict(openPcas, "pca", { maxPasses: 140 });
      rebalanceExpectedDischarges(nurses, "nurse", { maxPasses: 160 });
      rebalanceExpectedDischarges(openPcas, "pca", { maxPasses: 120 });
      let afterPrimaryPreventableRn = getAvoidableViolationCount(nurses, "nurse");
      let afterPrimaryPreventablePca = getAvoidableViolationCount(openPcas, "pca");
      let emergencyRnRebuild = { changed: false, improved: false };
      let emergencyPcaRebuild = { changed: false, improved: false };
      const pcaPoolForRebuild = activePatients.filter((p) => !(__getIncomingPcas().some((owner) => owner?.isSitter && String(owner?.sitterRoomPair || "").trim() && safeArray(owner?.patients).includes(Number(p?.id)))));

      if (afterPrimaryPreventableRn > 0) {
        emergencyRnRebuild = __fullRebuildOwnersForRole(nurses, "nurse", activePatients);
        rnRes = __runSafeRebalance(nurses, "nurse");
        rebalanceExpectedDischarges(nurses, "nurse", { maxPasses: 180 });
        afterPrimaryPreventableRn = getAvoidableViolationCount(nurses, "nurse");
      }
      if (afterPrimaryPreventablePca > 0 && openPcas.length) {
        emergencyPcaRebuild = __fullRebuildOwnersForRole(openPcas, "pca", pcaPoolForRebuild);
        pcaRes = __runSafeRebalance(openPcas, "pca");
        rebalanceExpectedDischarges(openPcas, "pca", { maxPasses: 140 });
        afterPrimaryPreventablePca = getAvoidableViolationCount(openPcas, "pca");
      }
      __enforceSitterAssignmentsExclusive(pcas, ptsAll.filter((p) => p && !p.isEmpty));
      v2Rn = __applyEngineV2Solution(nurses, activePatients, "nurse", prevRnByPid, { maxPasses: 220, reseedOwners: true, forceApply: true });
      v2Pca = __applyEngineV2Solution(openPcas, activePatients, "pca", prevPcaByPid, { maxPasses: 220, reseedOwners: true, forceApply: true });
      window.__lastOncomingRebalanceDebug.v2 = {
        rn: v2Rn,
        pca: v2Pca,
        afterV2: {
          rn: __debugOwnerSummary(nurses),
          pca: __debugOwnerSummary(pcas)
        }
      };

      const finalPreventableRn = getAvoidableViolationCount(nurses, "nurse");
      const finalPreventablePca = getAvoidableViolationCount(openPcas, "pca");
      const finalRoomOverflowRn = roomSpreadOverflowLocal(nurses, "nurse");
      const finalRoomOverflowPca = roomSpreadOverflowLocal(openPcas, "pca");
      const afterScoreRnAttempt = __nonIdealScore(nurses, "nurse", prevRnByPid);
      const afterScorePcaAttempt = __nonIdealScore(openPcas, "pca", prevPcaByPid);
      const beforeBoardScore = __sumNonIdealScores(beforeScoreRn, beforeScorePca);
      const afterBoardScore = __sumNonIdealScores(afterScoreRnAttempt, afterScorePcaAttempt);
      window.__lastOncomingRebalanceDebug.path = "legacy_fallback";
      window.__lastOncomingRebalanceDebug.after = {
        rn: __debugOwnerSummary(nurses),
        pca: __debugOwnerSummary(pcas),
        finalPreventableRn,
        finalPreventablePca,
        finalRoomOverflowRn,
        finalRoomOverflowPca,
        beforeBoardScore,
        afterBoardScore
      };
      const baselinePreventablePresent = baselinePreventableRn > 0 || baselinePreventablePca > 0;
      const finalCountSpreadRn = countSpreadLocal(nurses);
      const finalCountSpreadPca = countSpreadLocal(openPcas);
      const perfectRuleClean =
        finalPreventableRn <= 0 &&
        finalPreventablePca <= 0 &&
        finalCountSpreadRn <= 1 &&
        finalCountSpreadPca <= 1 &&
        finalRoomOverflowRn <= 0 &&
        finalRoomOverflowPca <= 0;
      const boardImproved = __compareNonIdealScore(afterBoardScore, beforeBoardScore) < 0;
      const countStillImbalanced = finalCountSpreadRn > 1 || finalCountSpreadPca > 1;
      const roomStillWide = finalRoomOverflowRn > 0 || finalRoomOverflowPca > 0;
      const shouldRollback = countStillImbalanced || roomStillWide || (!perfectRuleClean && !boardImproved);
      if (shouldRollback) {
        __restoreOwnersFromSnapshot(nurses, beforeSnapRn);
        __restoreOwnersFromSnapshot(pcas, beforeSnapPca);
      }

      const afterStatsRn = __reportStatsForOwners(nurses, "nurse", prevRnByPid);
      const afterStatsPca = __reportStatsForOwners(pcas, "pca", prevPcaByPid);
      const afterScoreRn = __nonIdealScore(nurses, "nurse", prevRnByPid);
      const afterScorePca = __nonIdealScore(openPcas, "pca", prevPcaByPid);
      const beforeCountsRnText = __formatOwnerCounts(window.__lastOncomingRebalanceDebug?.before?.rn);
      const afterCountsRnText = __formatOwnerCounts(window.__lastOncomingRebalanceDebug?.after?.rn || __debugOwnerSummary(nurses));
      const beforeCountsPcaText = __formatOwnerCounts(window.__lastOncomingRebalanceDebug?.before?.pca);
      const afterCountsPcaText = __formatOwnerCounts(window.__lastOncomingRebalanceDebug?.after?.pca || __debugOwnerSummary(pcas));
      const v2RnReason = __formatEngineReason(v2Rn, "Engine V2 did not accept a better RN assignment.");
      const v2PcaReason = __formatEngineReason(v2Pca, "Engine V2 did not accept a better PCA assignment.");

      const movesRn = __countMovesFromSnapshots(beforeSnapRn, nurses);
      const movesPca = __countMovesFromSnapshots(beforeSnapPca, pcas);
      const rnApplied = !shouldRollback && !!(v2Rn?.applied || strictMoveRn?.changed || dischargePassRn?.changed || rnRes.applied || rnCountFallback?.changed || emergencyRnRebuild?.changed || movesRn > 0);
      const pcaApplied = !shouldRollback && !!(v2Pca?.applied || strictMovePca?.changed || dischargePassPca?.changed || pcaRes.applied || pcaCountFallback?.changed || emergencyPcaRebuild?.changed || movesPca > 0);

      const msgOkRn = [
        `Applied ${movesRn} move${movesRn === 1 ? "" : "s"}.`,
        v2Rn?.applied ? "Engine V2 final pass applied." : "",
        strictMoveRn?.changed ? "Direct one-patient RN moves applied." : "",
        emergencyRnRebuild?.changed ? "Escalated to a full discharge-aware RN rebuild." : "",
        (rnCountFallback?.changed && !rnRes.applied) ? "Count-priority balancing applied." : "",
        __formatDeltaLine("Max report sources", beforeStatsRn.maxReport, afterStatsRn.maxReport),
        __formatDeltaLine("Report-source total", beforeStatsRn.sumReport, afterStatsRn.sumReport),
        __formatDeltaLine("Avoidable violations", beforeStatsRn.avoid, afterStatsRn.avoid),
        __formatDeltaLine("Count spread", `${beforeStatsRn.minCount}-${beforeStatsRn.maxCount}`, `${afterStatsRn.minCount}-${afterStatsRn.maxCount}`),
        `Non-ideal score: ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}`,
        `Counts: ${afterCountsRnText}`
      ].filter(Boolean).join(" ");

      const msgOkPca = [
        `Applied ${movesPca} move${movesPca === 1 ? "" : "s"}.`,
        v2Pca?.applied ? "Engine V2 final pass applied." : "",
        strictMovePca?.changed ? "Direct one-patient PCA moves applied." : "",
        emergencyPcaRebuild?.changed ? "Escalated to a full discharge-aware PCA rebuild." : "",
        (pcaCountFallback?.changed && !pcaRes.applied) ? "Count-priority balancing applied." : "",
        __formatDeltaLine("Max report sources", beforeStatsPca.maxReport, afterStatsPca.maxReport),
        __formatDeltaLine("Report-source total", beforeStatsPca.sumReport, afterStatsPca.sumReport),
        __formatDeltaLine("Avoidable violations", beforeStatsPca.avoid, afterStatsPca.avoid),
        __formatDeltaLine("Count spread", `${beforeStatsPca.minCount}-${beforeStatsPca.maxCount}`, `${afterStatsPca.minCount}-${afterStatsPca.maxCount}`),
        `Non-ideal score: ${__formatNonIdealScore(beforeScorePca)} -> ${__formatNonIdealScore(afterScorePca)}`,
        `Counts: ${afterCountsPcaText}`
      ].filter(Boolean).join(" ");

      __setBanner(
        "assignmentOutput",
        "oncomingStatusRn",
        rnApplied ? "ok" : "warn",
        rnApplied ? msgOkRn : (
          shouldRollback
            ? (baselinePreventablePresent
                ? `No board-quality improvement was found. Existing preventable RN/PCA rule breaks remain unchanged. Score ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}. Before: ${beforeCountsRnText}. After attempt: ${afterCountsRnText}. Engine V2: ${v2RnReason}.`
                : `Rebalance rolled back because it did not improve board quality. Score ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}. Before: ${beforeCountsRnText}. After attempt: ${afterCountsRnText}. Engine V2: ${v2RnReason}.`)
            : `${rnRes.reason || "Unable to rebalance safely."} Score ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}. Before: ${beforeCountsRnText}. After attempt: ${afterCountsRnText}. Engine V2: ${v2RnReason}.`
        )
      );

      __setBanner(
        "pcaAssignmentOutput",
        "oncomingStatusPca",
        pcaApplied ? "ok" : "warn",
        pcaApplied ? msgOkPca : (
          shouldRollback
            ? (baselinePreventablePresent
                ? `No board-quality improvement was found. Existing preventable RN/PCA rule breaks remain unchanged. Score ${__formatNonIdealScore(beforeScorePca)} -> ${__formatNonIdealScore(afterScorePca)}. Before: ${beforeCountsPcaText}. After attempt: ${afterCountsPcaText}. Engine V2: ${v2PcaReason}.`
                : `Rebalance rolled back because it did not improve board quality. Score ${__formatNonIdealScore(beforeScorePca)} -> ${__formatNonIdealScore(afterScorePca)}. Before: ${beforeCountsPcaText}. After attempt: ${afterCountsPcaText}. Engine V2: ${v2PcaReason}.`)
            : `${pcaRes.reason || "Unable to rebalance safely."} Score ${__formatNonIdealScore(beforeScorePca)} -> ${__formatNonIdealScore(afterScorePca)}. Before: ${beforeCountsPcaText}. After attempt: ${afterCountsPcaText}. Engine V2: ${v2PcaReason}.`
        )
      );
      __showOncomingRebalanceToast(
        (rnApplied || pcaApplied) ? "ok" : "warn",
        (rnApplied || pcaApplied)
          ? `Rebalance complete. RN moves: ${movesRn}. PCA moves: ${movesPca}.`
          : (
              shouldRollback
                ? (baselinePreventablePresent
                    ? `No safe rebalance improvement found. RN score ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}.`
                    : `Rebalance canceled because it did not improve board quality. RN score ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}.`)
                : `No safe rebalance improvement found. RN score ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}. Engine V2: ${v2RnReason}.`
            )
      );

      // ✅ batched render
      __suspendOncomingAutoPopulate(5000);
      __suspendCloudRealtimeApply(5000);
      renderOncomingAll();

      if (typeof window.saveState === "function") window.saveState();
      try {
        if (window.cloudSync && typeof window.cloudSync.publishUnitStateNow === "function") {
          void window.cloudSync.publishUnitStateNow("rebalance_apply");
        }
      } catch (_) {}
      if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err || "Unknown rebalance error.");
      try {
        window.__lastOncomingRebalanceDebug = {
          ...(window.__lastOncomingRebalanceDebug || {}),
          error: msg
        };
      } catch (_) {}
      try {
        __setBanner("assignmentOutput", "oncomingStatusRn", "warn", `Rebalance failed: ${msg}`);
        __setBanner("pcaAssignmentOutput", "oncomingStatusPca", "warn", `Rebalance failed: ${msg}`);
        __showOncomingRebalanceToast("warn", `Rebalance failed: ${msg}`);
      } catch (_) {}
      try { console.error("[oncoming rebalance] failed", err); } catch (_) {}
    } finally {
      try {
        window.__lastOncomingRebalanceDebug = {
          ...(window.__lastOncomingRebalanceDebug || {}),
          finishedAt: new Date().toISOString()
        };
      } catch (_) {}
      window.__oncomingRebalanceBothInFlight = false;
      __setRebalanceButtonBusy(false);
      try { __renderOncomingQualityPanel(); } catch (_) {}
      try { __refreshOncomingPopulateStatus(); } catch (_) {}
    }
  }

  function __hookOncomingAutoPopulateSignals() {
    if (window.__oncomingAutoPopulateSignalsHooked) return;
    window.__oncomingAutoPopulateSignalsHooked = true;

    ["renderPatientList", "updateDischargeCount", "updateAcuityTiles"].forEach((fnName) => {
      const original = window[fnName];
      if (typeof original !== "function" || original.__oncomingWrapped) return;
      const wrapped = function () {
        const out = original.apply(this, arguments);
        try { __refreshOncomingPopulateStatus(); } catch (_) {}
        return out;
      };
      wrapped.__oncomingWrapped = true;
      window[fnName] = wrapped;
    });
  }

  __hookOncomingAutoPopulateSignals();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", __hookOncomingAutoPopulateSignals);
  } else {
    setTimeout(__hookOncomingAutoPopulateSignals, 0);
  }

  // Expose globally (CRITICAL for index.html onclick)
  window.renderAssignmentOutput = renderAssignmentOutput;
  window.renderPcaAssignmentOutput = renderPcaAssignmentOutput;
  window.renderSitterAssignmentOutput = renderSitterAssignmentOutput;
  window.renderOncomingAll = renderOncomingAll;

  window.populateOncomingAssignment = populateOncomingAssignment;
  window.rebalanceOncomingAssignment = rebalanceOncomingAssignment;
  window.toggleOncomingQualityPanel = function toggleOncomingQualityPanel() {
    window.__oncomingQualityPanelCollapsed = window.__oncomingQualityPanelCollapsed === false;
    try { __renderOncomingQualityPanel(); } catch (_) {}
  };
  window.triggerOncomingRebalance = async function triggerOncomingRebalance() {
    const nowIso = new Date().toISOString();
    window.__lastOncomingRebalanceDebug = {
      ...(window.__lastOncomingRebalanceDebug || {}),
      clickReceivedAt: nowIso,
      clickCount: Number(window.__lastOncomingRebalanceDebug?.clickCount || 0) + 1,
      buttonTriggered: true
    };

    if (window.__oncomingRebalanceBothInFlight) {
      __showOncomingRebalanceToast("warn", "Rebalance is already running.");
      return;
    }

    __showOncomingRebalanceToast("ok", "Rebalance click received.");
    await rebalanceOncomingAssignment();
  };

  // Version marker
  window.__assignmentsRenderBuild =
    "v2026-01-25__reportSourceAwareCountBalancer";

  document.addEventListener("click", function () {
    setTimeout(() => {
      try { __syncOncomingQualityPanelVisibility(); } catch (_) {}
    }, 0);
  });
  setInterval(() => {
    try { __syncOncomingQualityPanelVisibility(); } catch (_) {}
  }, 500);
}
