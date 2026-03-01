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

    owners.forEach((pca) => {
      const pair = String(pca?.sitterRoomPair || "").trim();
      const isSitterPca = !!pca?.isSitter && !!pair;
      if (!isSitterPca) return;

      const hits = pts
        .filter((p) => p && !p.isEmpty && !!p.sitter && __sitterRoomGroupKey(p) === pair)
        .sort(safeSortPatientsForDisplay)
        .slice(0, 2)
        .map((p) => Number(p.id))
        .filter(Number.isFinite);

      pca.patients = Array.from(new Set(hits));
      pca.maxPatients = 2;
      pca.patients.forEach((id) => pinned.add(id));
    });

    return pinned;
  }

  // -----------------------------
  // RN Continuity Pin helpers
  // -----------------------------
  function getPatientLockMeta(p) {
    if (!p || typeof p !== "object") return { enabled: false, rnId: null };
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
    if (role !== "nurse") return ids;
    return ids.filter(pid => !isPatientPinnedToIncomingRn(pid, owner.id));
  }

  function tryMovePatient(owners, role, fromOwner, toOwner, patientId) {
    if (!fromOwner || !toOwner) return false;
    if (!Array.isArray(fromOwner.patients)) fromOwner.patients = [];
    if (!Array.isArray(toOwner.patients)) toOwner.patients = [];

    const idx = fromOwner.patients.indexOf(patientId);
    if (idx === -1) return false;

    if (role === "nurse" && isPatientPinnedToIncomingRn(patientId, fromOwner.id)) return false;

    fromOwner.patients.splice(idx, 1);
    if (!toOwner.patients.includes(patientId)) toOwner.patients.push(patientId);
    return true;
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

  function __setOncomingPopulateStatus(state, metaText) {
    const pill = document.getElementById("oncomingPopulateStatus");
    if (!pill) return;

    const dot = pill.querySelector && pill.querySelector(".staffing-status-dot");
    const textEl = pill.querySelector && pill.querySelector(".staffing-status-text");
    const metaEl = pill.querySelector && pill.querySelector(".staffing-status-meta");

    const isComplete = state === "complete";
    if (dot) dot.style.background = isComplete ? "#22c55e" : "#fbbf24";
    if (textEl) textEl.textContent = isComplete ? "All Patients Populated" : "Populating";
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

    const { prevRnByPid } = prevMaps || buildPrevOwnerMaps();

    // ✅ PERF: rules map once
    const rnRuleMap = safeGetRuleEvalMap(allOwners, "nurse");

    allOwners.forEach(nurse => {
      const pts = (nurse.patients || [])
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
        const prevName = prevRnByPid.get(Number(p.id)) || "";
        const bedLabel = getBedLabel(p);

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
            <td>${escapeHtml(bedLabel)} ${pinControl}</td>
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

    const { prevPcaByPid } = prevMaps || buildPrevOwnerMaps();

    // ✅ PERF: rules map once
    const pcaRuleMap = safeGetRuleEvalMap(allOwners, "pca");

    allOwners.forEach(pca => {
      const pts = (pca.patients || [])
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
        const prevName = prevPcaByPid.get(Number(p.id)) || "";
        const bedLabel = getBedLabel(p);

        html += `
          <tr
            draggable="true"
            ondragstart="onRowDragStart(event, 'incoming', 'pca', ${pca.id}, ${p.id})"
            ondragend="onRowDragEnd(event)"
            ondblclick="openPatientProfileFromRoom(${p.id})"
          >
            <td>${escapeHtml(bedLabel)}</td>
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
    const prevMaps = __getPrevMapsForCycle();
    __renderAssignmentOutputWithCache(prevMaps);
    __renderPcaAssignmentOutputWithCache(prevMaps);
    __refreshOncomingPopulateStatus();
  }

  // Public render fns (keep API stable)
  function renderAssignmentOutput() {
    __beginRenderCycle();
    const prevMaps = __getPrevMapsForCycle();
    __renderAssignmentOutputWithCache(prevMaps);
    __refreshOncomingPopulateStatus();
  }

  function renderPcaAssignmentOutput() {
    __beginRenderCycle();
    const prevMaps = __getPrevMapsForCycle();
    __renderPcaAssignmentOutputWithCache(prevMaps);
    __refreshOncomingPopulateStatus();
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

      let list = activePatients.slice();
      if (randomize) list.sort(() => Math.random() - 0.5);
      else list.sort(safeSortPatientsForDisplay);

      const { unlockedPool } = applyRnPinsBeforeDistribute(list);

      if (typeof window.distributePatientsEvenly === "function") {
        window.distributePatientsEvenly(nurses, unlockedPool, { randomize, role: "nurse", preserveExisting: true });
        const pinnedToSitterPcas = __applyPcaSitterDesignations(pcas, list);
        const pcaPool = list.filter((p) => !pinnedToSitterPcas.has(Number(p?.id)));
        const openPcas = pcas.filter((p) => !(p?.isSitter && String(p?.sitterRoomPair || "").trim()));
        if (openPcas.length) {
          window.distributePatientsEvenly(openPcas, pcaPool, { randomize, role: "pca", preserveExisting: true });
        }
      } else {
        alert("ERROR: distributePatientsEvenly is not loaded. Check script order + app.assignmentRules.js loading.");
        console.error("distributePatientsEvenly missing — check index.html script order and app.assignmentRules.js.");
        return;
      }

      // keep these passes reasonable to avoid UI lag
      balanceCountsWithoutCreatingNewAvoidableViolations(nurses, "nurse", { maxPasses: 50 });
      balanceCountsWithoutCreatingNewAvoidableViolations(pcas, "pca", { maxPasses: 50 });

      if (typeof window.repairAssignmentsInPlace === "function") {
        window.repairAssignmentsInPlace(nurses, "nurse", null, { maxIters: 35 });
        window.repairAssignmentsInPlace(pcas, "pca", null, { maxIters: 35 });
      }

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

  function rebalanceOncomingAssignment() {
    if (window.__oncomingRebalanceBothInFlight) return;
    window.__oncomingRebalanceBothInFlight = true;

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

      try {
        cleanupRnPinsAgainstRoster();
        nurses.forEach(rn => {
          rn.patients = Array.isArray(rn.patients) ? rn.patients : [];
          rn.patients = rn.patients.filter(pid => !isPatientPinnedToIncomingRn(pid, rn.id));
        });
        const active = ptsAll.filter(p => p && !p.isEmpty);
        applyRnPinsBeforeDistribute(active);
      } catch (e) {
        console.warn("[rebalance BOTH] pin placement pre-pass failed", e);
      }

      const rnRes = __runSafeRebalance(nurses, "nurse");
      const pcaRes = __runSafeRebalance(pcas, "pca");

      const afterStatsRn = __reportStatsForOwners(nurses, "nurse", prevRnByPid);
      const afterStatsPca = __reportStatsForOwners(pcas, "pca", prevPcaByPid);

      const movesRn = __countMovesFromSnapshots(beforeSnapRn, nurses);
      const movesPca = __countMovesFromSnapshots(beforeSnapPca, pcas);

      const msgOkRn = [
        `Applied ${movesRn} move${movesRn === 1 ? "" : "s"}.`,
        __formatDeltaLine("Max report sources", beforeStatsRn.maxReport, afterStatsRn.maxReport),
        __formatDeltaLine("Report-source total", beforeStatsRn.sumReport, afterStatsRn.sumReport),
        __formatDeltaLine("Avoidable violations", beforeStatsRn.avoid, afterStatsRn.avoid),
        __formatDeltaLine("Count spread", `${beforeStatsRn.minCount}-${beforeStatsRn.maxCount}`, `${afterStatsRn.minCount}-${afterStatsRn.maxCount}`)
      ].join(" ");

      const msgOkPca = [
        `Applied ${movesPca} move${movesPca === 1 ? "" : "s"}.`,
        __formatDeltaLine("Max report sources", beforeStatsPca.maxReport, afterStatsPca.maxReport),
        __formatDeltaLine("Report-source total", beforeStatsPca.sumReport, afterStatsPca.sumReport),
        __formatDeltaLine("Avoidable violations", beforeStatsPca.avoid, afterStatsPca.avoid),
        __formatDeltaLine("Count spread", `${beforeStatsPca.minCount}-${beforeStatsPca.maxCount}`, `${afterStatsPca.minCount}-${afterStatsPca.maxCount}`)
      ].join(" ");

      __setBanner(
        "assignmentOutput",
        "oncomingStatusRn",
        rnRes.applied ? "ok" : "warn",
        rnRes.applied ? msgOkRn : (rnRes.reason || "Unable to rebalance safely.")
      );

      __setBanner(
        "pcaAssignmentOutput",
        "oncomingStatusPca",
        pcaRes.applied ? "ok" : "warn",
        pcaRes.applied ? msgOkPca : (pcaRes.reason || "Unable to rebalance safely.")
      );

      // ✅ batched render
      renderOncomingAll();

      if (typeof window.saveState === "function") window.saveState();
      if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
    } finally {
      window.__oncomingRebalanceBothInFlight = false;
    }
  }

  // Expose globally (CRITICAL for index.html onclick)
  window.renderAssignmentOutput = renderAssignmentOutput;
  window.renderPcaAssignmentOutput = renderPcaAssignmentOutput;
  window.renderSitterAssignmentOutput = renderSitterAssignmentOutput;
  window.renderOncomingAll = renderOncomingAll;

  window.populateOncomingAssignment = populateOncomingAssignment;
  window.rebalanceOncomingAssignment = rebalanceOncomingAssignment;

  // Version marker
  window.__assignmentsRenderBuild =
    "v2026-01-25__reportSourceAwareCountBalancer";
}
