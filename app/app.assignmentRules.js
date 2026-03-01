// app/app.assignmentRules.js
// ---------------------------------------------------------
// Smarter distribution helpers for distributing patients across staff.
// Goal: keep counts even AND balance acuity load (RN/PCA scores).
//
// + Phase 1 additions:
// - Hard rule checks (RN + PCA): counts per owner, and unavoidable vs avoidable.
// - Swap suggestions: find a simple patient swap between two owners that reduces
//   rule breaks / stacking (especially BG).
//
// NEW (Dec 2025):
// - "Locked to RN" aware in-place repair.
//
// FIX (Dec 2025):
// - distributePatientsEvenly() supports preserveExisting.
//
// ✅ NEW (Jan 2026):
// - "Safe Rebalance": Rebalance will ONLY APPLY if it improves the assignment.
// - Report-source constraints as a primary objective:
//   - 4 patients → max 3 report sources
//   - 3 patients → max 2 report sources
//
// ✅ PERF (Jan 2026):
// - Build prev-owner maps once per evaluation pass (no repeated .find scans)
//
// ✅ Rebalance (Jan 2026):
// - Early exit in repairAssignmentsInPlace when avoidable <= 0 and reportOverflow <= 0
//   (no swap search when assignment is already safe and report-optimized).
//
// ✅ Rule-aware distribution (Jan 2026):
// - distributePatientsEvenly: constraint-first sort, rule-aware owner choice (avoid
//   creating avoidable tag violations), report-source penalty, walk tie-breaker.
// - Repair: wider offender set (5), more iterations when called from Populate (35).
// ---------------------------------------------------------

(function () {
  // -----------------------------
  // Tiny utilities
  // -----------------------------
  function safeArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function toPatientObj(p) {
    if (!p) return null;
    if (typeof p === "object") return p;
    if (typeof window.getPatientById === "function") return window.getPatientById(p) || null;
    return null;
  }

  function getId(p) {
    return typeof p === "object" ? p.id : p;
  }

  function resolvePatient(idOrObj) {
    const p = toPatientObj(idOrObj);
    if (!p || p.isEmpty) return null;
    return p;
  }

  function sum(obj, key, amount) {
    obj[key] = (obj[key] || 0) + (amount || 0);
  }

  function isOn(p, keys) {
    for (const k of keys) {
      if (p && p[k]) return true;
    }
    return false;
  }

  // -----------------------------
  // Scoring helpers (projected)
  // -----------------------------
  function rnPatientScore(p) {
    if (!p || p.isEmpty) return 0;
    if (typeof window.getRnPatientScore === "function") return window.getRnPatientScore(p);
    if (typeof window.getPatientScore === "function") return window.getPatientScore(p);
    return 0;
  }

  function pcaPatientScore(p) {
    if (!p || p.isEmpty) return 0;
    if (typeof window.getPcaPatientScore === "function") return window.getPcaPatientScore(p);

    let score = 0;
    if (p.isolation) score += 3;
    if (p.admit) score += 3;
    if (p.lateDc) score += 2;
    if (p.chg) score += 3;
    if (p.foley) score += 3;
    if (p.q2turns) score += 4;
    if (p.feeder) score += 3;
    return score;
  }

  function ownerProjectedLoad(owner, role, extraPatientObj) {
    const ids = safeArray(owner && owner.patients);
    let sumLoad = 0;

    for (const id of ids) {
      const p = (typeof window.getPatientById === "function") ? window.getPatientById(id) : null;
      if (!p || p.isEmpty) continue;
      sumLoad += (role === "pca") ? pcaPatientScore(p) : rnPatientScore(p);
    }

    if (extraPatientObj && !extraPatientObj.isEmpty) {
      sumLoad += (role === "pca") ? pcaPatientScore(extraPatientObj) : rnPatientScore(extraPatientObj);
    }

    return sumLoad;
  }

  // =========================================================
  // Phase 1: Hard rule checking + swap suggestions
  // =========================================================
  const RN_LIMITS = {
    drip: 1,
    nih: 1,
    bg: 2,
    tf: 2,
    ciwa: 1,
    restraint: 1,
    sitter: 1,
    vpo: 1,
    isolation: 2,
    admit: 1,
    lateDc: 1
  };

  const PCA_LIMITS = {
    chg: 1,
    foley: 1,
    q2turns: 1,
    feeder: 1,
    isolation: 2,
    admit: 1,
    lateDc: 1
  };

  const RN_TAG_KEYS = {
    drip: ["drip", "drips"],
    nih: ["nih"],
    bg: ["bg", "bgChecks"],
    tf: ["tf"],
    ciwa: ["ciwa", "cows", "ciwaCows"],
    restraint: ["restraint", "restraints"],
    sitter: ["sitter"],
    vpo: ["vpo"],
    isolation: ["isolation", "iso"],
    admit: ["admit"],
    lateDc: ["lateDc", "lateDC", "latedc"]
  };

  const PCA_TAG_KEYS = {
    tele: ["telePca", "tele"],
    chg: ["chg"],
    foley: ["foley"],
    q2turns: ["q2turns", "q2Turns"],
    feeder: ["feeder", "feeders"],
    strictIo: ["strictIo", "heavy"],
    isolation: ["isolation", "isoPca", "iso"],
    admit: ["admitPca", "admit"],
    lateDc: ["lateDcPca", "lateDc", "lateDC", "latedc"]
  };

  function countTagsForOwner(owner, role) {
    const counts = {};
    const ids = safeArray(owner && owner.patients);

    for (const id of ids) {
      const p = resolvePatient(id);
      if (!p) continue;

      if (role === "pca") {
        for (const tag in PCA_TAG_KEYS) {
          if (isOn(p, PCA_TAG_KEYS[tag])) sum(counts, tag, 1);
        }
      } else {
        for (const tag in RN_TAG_KEYS) {
          if (isOn(p, RN_TAG_KEYS[tag])) sum(counts, tag, 1);
        }
      }
    }

    return counts;
  }

  function countTagsForUnit(owners, role) {
    const total = {};
    for (const o of safeArray(owners)) {
      const c = countTagsForOwner(o, role);
      for (const k in c) sum(total, k, c[k]);
    }
    return total;
  }

  function unavoidableThreshold(totalTagCount, ownerCount, limitPerOwner) {
    return totalTagCount > (ownerCount * limitPerOwner);
  }

  // =========================================================
  // ✅ Prev-owner maps (PERF)
  // =========================================================
  function buildPrevOwnerMap(role2) {
    const map = new Map();
    if (role2 === "pca") {
      safeArray(window.currentPcas).forEach(o => {
        const name = o?.name || `PCA ${o?.id ?? ""}`;
        safeArray(o?.patients).forEach(pid => map.set(Number(pid), name));
      });
      return map;
    }

    safeArray(window.currentNurses).forEach(o => {
      const name = o?.name || `RN ${o?.id ?? ""}`;
      safeArray(o?.patients).forEach(pid => map.set(Number(pid), name));
    });
    return map;
  }

  function uniqCount(arr) {
    return new Set(safeArray(arr).filter(Boolean)).size;
  }

  function allowedReportSourcesForCount(ptCount) {
    const n = Number(ptCount) || 0;
    if (n >= 4) return 3;     // ✅ your rule
    if (n === 3) return 2;    // ✅ your relaxed rule
    if (n === 2) return 2;
    if (n === 1) return 1;
    return 0;
  }

  function reportSourcesForOwner(owner, prevMap) {
    const names = [];
    for (const pid of safeArray(owner?.patients)) {
      const nm = prevMap?.get(Number(pid)) || "";
      if (nm) names.push(nm);
    }
    return uniqCount(names);
  }

  function reportOverflowForOwner(owner, prevMap) {
    const ptCount = safeArray(owner?.patients).length;
    const allowed = allowedReportSourcesForCount(ptCount);
    const sources = reportSourcesForOwner(owner, prevMap);
    return Math.max(0, sources - allowed);
  }

  function reportOverflowTotal(owners2, prevMap) {
    return safeArray(owners2).reduce((s, o) => s + reportOverflowForOwner(o, prevMap), 0);
  }

  // Rule-aware distribution: tag counts for a single patient (same keys as countTagsForOwner)
  function countTagsForPatient(patient, role) {
    const pid = getId(patient);
    if (pid == null) return {};
    const tempOwner = { patients: [pid] };
    return countTagsForOwner(tempOwner, role);
  }

  // Would adding this patient to this owner create an avoidable violation?
  function wouldAddingPatientCauseAvoidableViolation(owner, patient, ownersAll, role, limitsOverride) {
    const limits = limitsOverride || (role === "pca" ? PCA_LIMITS : RN_LIMITS);
    const ownerCount = Math.max(1, safeArray(ownersAll).length);
    const ownerCounts = countTagsForOwner(owner, role);
    const patientCounts = countTagsForPatient(patient, role);
    const unitCounts = countTagsForUnit(ownersAll, role);

    for (const tag in limits) {
      const limit = limits[tag];
      const combined = (ownerCounts[tag] || 0) + (patientCounts[tag] || 0);
      if (combined <= limit) continue;

      const unitTotalWithNew = (unitCounts[tag] || 0) + (patientCounts[tag] || 0);
      const unavoidable = unavoidableThreshold(unitTotalWithNew, ownerCount, limit);
      if (!unavoidable) return true;
    }
    return false;
  }

  // Report-source count if we added this patient to this owner (for cap check)
  function reportSourcesAfterAdd(owner, patientId, prevMap) {
    if (!prevMap) return 0;
    const tempOwner = { patients: safeArray(owner?.patients).concat(Number(patientId)) };
    return reportSourcesForOwner(tempOwner, prevMap);
  }

  // Count of tags that have limit 1 (hardest to place); used for constraint-first sort
  function countLimitOneTags(patient, role, limits) {
    const lims = limits || (role === "pca" ? PCA_LIMITS : RN_LIMITS);
    const patientCounts = countTagsForPatient(patient, role);
    let n = 0;
    for (const tag in lims) {
      if (lims[tag] === 1 && (patientCounts[tag] || 0) > 0) n++;
    }
    return n;
  }

  function roomNumberForPatientId(pid) {
    const p = resolvePatient(pid);
    if (!p) return null;

    if (typeof window.getRoomNumber === "function") {
      const n = window.getRoomNumber(p);
      if (typeof n === "number" && isFinite(n) && n !== 9999) return n;
    }

    const label =
      (typeof window.getRoomLabelForPatient === "function" ? window.getRoomLabelForPatient(p) : "") ||
      String(p.room || "");

    const m = String(label).match(/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function walkingSpreadForOwner(owner) {
    const nums = safeArray(owner?.patients)
      .map(roomNumberForPatientId)
      .filter(n => typeof n === "number" && isFinite(n));
    if (nums.length < 2) return 0;
    nums.sort((a, b) => a - b);
    return nums[nums.length - 1] - nums[0];
  }

  function ownerLoad(owner, role2) {
    return ownerProjectedLoad(owner, role2 === "pca" ? "pca" : "nurse", null);
  }

  function loadImbalance(owners2, role2) {
    const loads = safeArray(owners2).map(o => ownerLoad(o, role2));
    if (!loads.length) return 0;
    const min = Math.min(...loads);
    const max = Math.max(...loads);
    return max - min;
  }

  function countSpread(owners2) {
    const counts = safeArray(owners2).map(o => safeArray(o?.patients).length);
    if (!counts.length) return 0;
    return Math.max(...counts) - Math.min(...counts);
  }

  function evaluateOwnerHardRules(owner, ownersAll, role, limitsOverride, ctx = {}) {
    const limits = limitsOverride || (role === "pca" ? PCA_LIMITS : RN_LIMITS);
    const ownerCount = Math.max(1, safeArray(ownersAll).length);

    const ownerCounts = countTagsForOwner(owner, role);
    const unitCounts = countTagsForUnit(ownersAll, role);

    const violations = [];
    const warnings = [];

    for (const tag in limits) {
      const limit = limits[tag];
      const mine = ownerCounts[tag] || 0;
      if (mine <= limit) continue;

      const unitTotal = unitCounts[tag] || 0;
      const unavoidable = unavoidableThreshold(unitTotal, ownerCount, limit);

      const severity = unavoidable ? "warning" : "violation";

      const msg =
        role === "pca"
          ? `PCA rule: ${tag} is stacked (${mine} > ${limit})`
          : `RN rule: ${tag} is stacked (${mine} > ${limit})`;

      const rec = {
        tag,
        mine,
        limit,
        unitTotal,
        ownerCount,
        unavoidable,
        severity,
        message: msg
      };

      if (severity === "violation") violations.push(rec);
      else warnings.push(rec);
    }

    // ✅ Report sources flag (WARNING so it doesn't trip avoidable==0 gate)
    // Still strongly optimized via qualityTuple.reportOverflow.
    const prevMap = ctx?.prevOwnerByPid || null;
    if (prevMap) {
      const ptCount = safeArray(owner?.patients).length;
      const limit = allowedReportSourcesForCount(ptCount);
      const mine = reportSourcesForOwner(owner, prevMap);
      if (limit > 0 && mine > limit) {
        warnings.push({
          tag: "REPORT_SOURCES",
          mine,
          limit,
          unavoidable: false,
          severity: "warning",
          message: `Report sources high (${mine} > ${limit})`
        });
      }
    }

    return {
      counts: ownerCounts,
      violations,
      warnings,
      hasRuleBreak: violations.length > 0,
      hasAnyFlag: (violations.length + warnings.length) > 0
    };
  }

  // Public: evaluate all owners at once (build prev map ONCE)
  window.evaluateAssignmentHardRules = function (owners, role, limitsOverride) {
    const list = safeArray(owners).filter(Boolean);
    const out = {};

    const r = (role === "pca") ? "pca" : "nurse";
    const prevOwnerByPid = buildPrevOwnerMap(r);

    list.forEach((o, idx) => {
      const key = o?.name || o?.label || `owner_${idx + 1}`;
      out[key] = evaluateOwnerHardRules(o, list, r, limitsOverride, { prevOwnerByPid });
    });

    return out;
  };

  // ---------------------------------------------------------
  // Swap suggestion (simple but effective)
  // ---------------------------------------------------------
  function cloneOwnerPatients(owner) {
    return safeArray(owner && owner.patients).slice();
  }

  function computePenaltyForOwnerEval(evalObj) {
    const v = safeArray(evalObj?.violations).length;
    const w = safeArray(evalObj?.warnings).length;

    const bgPenalty =
      (evalObj?.violations || []).some(x => x.tag === "bg") ? 3 : 0;

    return (v * 10) + (w * 4) + bgPenalty;
  }

  function computeTotalPenalty(owners, role, limitsOverride) {
    let sumPen = 0;
    const list = safeArray(owners).filter(Boolean);
    for (let i = 0; i < list.length; i++) {
      const ev = evaluateOwnerHardRules(list[i], list, role, limitsOverride, { prevOwnerByPid: buildPrevOwnerMap(role) });
      sumPen += computePenaltyForOwnerEval(ev);
    }
    return sumPen;
  }

  window.suggestBestSwap = function (owners, role, limitsOverride) {
    const list = safeArray(owners).filter(Boolean);
    if (list.length < 2) return { ok: false, reason: "Need at least 2 owners" };

    const r = (role === "pca") ? "pca" : "nurse";
    const basePenalty = computeTotalPenalty(list, r, limitsOverride);

    let best = null;

    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a];
        const B = list[b];

        const Apts = safeArray(A.patients);
        const Bpts = safeArray(B.patients);
        if (!Apts.length || !Bpts.length) continue;

        for (let i = 0; i < Apts.length; i++) {
          for (let j = 0; j < Bpts.length; j++) {
            const Aclone = cloneOwnerPatients(A);
            const Bclone = cloneOwnerPatients(B);

            const tmp = Aclone[i];
            Aclone[i] = Bclone[j];
            Bclone[j] = tmp;

            const originalA = A.patients;
            const originalB = B.patients;

            A.patients = Aclone;
            B.patients = Bclone;

            const newPenalty = computeTotalPenalty(list, r, limitsOverride);

            A.patients = originalA;
            B.patients = originalB;

            const improvement = basePenalty - newPenalty;
            if (improvement <= 0) continue;

            if (!best || improvement > best.improvement) {
              best = {
                ownerA: A?.name || `owner_${a + 1}`,
                ownerB: B?.name || `owner_${b + 1}`,
                patientFromA: Apts[i],
                patientFromB: Bpts[j],
                improvement,
                basePenalty,
                newPenalty
              };
            }
          }
        }
      }
    }

    if (!best) return { ok: true, found: false, basePenalty };
    return { ok: true, found: true, ...best };
  };

  // =========================================================
  // Lexicographic “quality tuple”
  // Lower is always better. Earlier fields dominate.
  // =========================================================
  function countAvoidableViolationsAll(owners2, role2, limitsOverride) {
    let total = 0;
    const arr = safeArray(owners2).filter(Boolean);
    for (const o of arr) {
      const ev = evaluateOwnerHardRules(o, arr, role2, limitsOverride, { prevOwnerByPid: buildPrevOwnerMap(role2) });
      total += safeArray(ev?.violations).length;
    }
    return total;
  }

  function countWarningsAll(owners2, role2, limitsOverride) {
    let total = 0;
    const arr = safeArray(owners2).filter(Boolean);
    for (const o of arr) {
      const ev = evaluateOwnerHardRules(o, arr, role2, limitsOverride, { prevOwnerByPid: buildPrevOwnerMap(role2) });
      total += safeArray(ev?.warnings).length;
    }
    return total;
  }

  function qualityTuple(owners2, role2, limitsOverride) {
    const list2 = safeArray(owners2).filter(Boolean);
    const prevMap = buildPrevOwnerMap(role2);

    return {
      avoidable: countAvoidableViolationsAll(list2, role2, limitsOverride),
      reportOverflow: reportOverflowTotal(list2, prevMap),
      spread: countSpread(list2),
      loadImb: loadImbalance(list2, role2),
      churn: list2.reduce((s, o) => s + reportSourcesForOwner(o, prevMap), 0),
      walk: list2.reduce((s, o) => s + walkingSpreadForOwner(o), 0)
    };
  }

  function isBetterTuple(next, base) {
    if (!base) return true;
    if (next.avoidable !== base.avoidable) return next.avoidable < base.avoidable;
    if (next.reportOverflow !== base.reportOverflow) return next.reportOverflow < base.reportOverflow;
    if (next.spread !== base.spread) return next.spread < base.spread;
    if (next.loadImb !== base.loadImb) return next.loadImb < base.loadImb;
    if (next.churn !== base.churn) return next.churn < base.churn;
    return next.walk < base.walk;
  }

  function deepCloneOwnersShallow(owners2) {
    return safeArray(owners2).map(o => ({
      ...o,
      patients: safeArray(o?.patients).slice()
    }));
  }

  // =========================================================
  // MAIN: distributePatientsEvenly
  // =========================================================
  window.distributePatientsEvenly = function (owners, patients, options = {}) {
    owners = safeArray(owners).filter(Boolean);
    if (!owners.length) return;

    const listRaw = safeArray(patients).filter(Boolean);
    if (!listRaw.length) return;

    const randomize = !!options.randomize;
    const role = (options.role === "pca" || options.role === "nurse") ? options.role : "nurse";
    const useLoadBalancing = (options.useLoadBalancing !== false);
    const preserveExisting = !!options.preserveExisting;

    function ensurePatientsArrays() {
      owners.forEach(o => { if (!Array.isArray(o.patients)) o.patients = []; });
    }

    function assignedSet() {
      const set = new Set();
      owners.forEach(o => safeArray(o.patients).forEach(pid => set.add(Number(pid))));
      return set;
    }

    let list = listRaw.map(toPatientObj).filter(p => p && !p.isEmpty);

    if (!list.length) {
      if (!preserveExisting) owners.forEach(o => { o.patients = []; });
      else ensurePatientsArrays();

      const already = preserveExisting ? assignedSet() : new Set();

      // Fallback only: all patients empty (no acuity data). Normal Populate never hits this.
      listRaw.forEach((p, index) => {
        const patientId = Number(getId(p));
        if (preserveExisting && already.has(patientId)) return;
        const owner = owners[index % owners.length];
        if (!Array.isArray(owner.patients)) owner.patients = [];
        owner.patients.push(patientId);
      });
      return;
    }

    if (preserveExisting) {
      const already = assignedSet();
      list = list.filter(p => !already.has(Number(p.id)));
    }

    if (randomize) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = list[i];
        list[i] = list[j];
        list[j] = tmp;
      }
    }

    if (!preserveExisting) owners.forEach(o => { o.patients = []; });
    else ensurePatientsArrays();

    if (!useLoadBalancing) {
      // Fallback only: caller explicitly disabled load balancing. Oncoming Populate always uses load balancing.
      const already = preserveExisting ? assignedSet() : new Set();
      list.forEach((p, index) => {
        const pid = Number(p.id);
        if (preserveExisting && already.has(pid)) return;
        const owner = owners[index % owners.length];
        if (!Array.isArray(owner.patients)) owner.patients = [];
        owner.patients.push(pid);
      });
      return;
    }

    const limitsOverride = options.limitsOverride || null;
    const limits = limitsOverride || (role === "pca" ? PCA_LIMITS : RN_LIMITS);

    // Constraint-first: place high-constraint patients first (limit-1 tags), then by acuity
    list.sort((a, b) => {
      const constraintA = countLimitOneTags(a, role, limits);
      const constraintB = countLimitOneTags(b, role, limits);
      if (constraintB !== constraintA) return constraintB - constraintA;
      const sa = (role === "pca") ? pcaPatientScore(a) : rnPatientScore(a);
      const sb = (role === "pca") ? pcaPatientScore(b) : rnPatientScore(b);
      return sb - sa;
    });

    const totalRemaining = list.length;
    const baseCounts = owners.map(o => safeArray(o.patients).length);
    const totalAll = baseCounts.reduce((s, x) => s + x, 0) + totalRemaining;

    const nOwners = owners.length;
    const base = Math.floor(totalAll / nOwners);
    const remainder = totalAll % nOwners;

    const desiredCaps = owners.map((_, i) => base + (i < remainder ? 1 : 0));
    const capByIndex = desiredCaps.map((cap, i) => Math.max(cap, baseCounts[i]));

    const r2 = (role === "pca") ? "pca" : "nurse";
    const prevMap = buildPrevOwnerMap(r2);
    const LOAD_EPSILON = 2;
    const REPORT_SOURCE_PENALTY = 100;

    list.forEach(p => {
      let bestIdx = -1;
      let bestScore = Infinity;
      let bestWalk = Infinity;

      for (let i = 0; i < owners.length; i++) {
        const o = owners[i];
        const curCount = safeArray(o.patients).length;
        if (curCount >= capByIndex[i]) continue;

        const causesViolation = wouldAddingPatientCauseAvoidableViolation(o, p, owners, role, limitsOverride);
        let score = ownerProjectedLoad(o, r2, p);
        if (causesViolation) score += REPORT_SOURCE_PENALTY * 2;

        const sourcesAfter = reportSourcesAfterAdd(o, p.id, prevMap);
        const allowedSources = allowedReportSourcesForCount(curCount + 1);
        if (sourcesAfter > allowedSources) score += REPORT_SOURCE_PENALTY;

        const tempOwner = { patients: safeArray(o.patients).concat(Number(p.id)) };
        const walkAfter = walkingSpreadForOwner(tempOwner);

        const scoreTie = (bestIdx >= 0 && Math.abs(score - bestScore) <= LOAD_EPSILON);
        if (bestIdx === -1 || score < bestScore || (scoreTie && walkAfter < bestWalk)) {
          bestScore = score;
          bestWalk = walkAfter;
          bestIdx = i;
        }
      }

      if (bestIdx === -1) {
        bestIdx = 0;
        let bestCount = Infinity;
        for (let i = 0; i < owners.length; i++) {
          const c = safeArray(owners[i].patients).length;
          if (c < bestCount) {
            bestCount = c;
            bestIdx = i;
          }
        }
      }

      const chosen = owners[bestIdx];
      if (!Array.isArray(chosen.patients)) chosen.patients = [];
      chosen.patients.push(Number(p.id));
    });
  };

  // =========================================================
  // Phase 2: In-place repair rebalance
  // =========================================================
  function getWorstOffenders(owners2, role2, limitsOverride) {
    const arr = safeArray(owners2).filter(Boolean);
    const prevMap = buildPrevOwnerMap(role2);

    const scored = arr.map((o, idx) => {
      const ev = evaluateOwnerHardRules(o, arr, role2, limitsOverride, { prevOwnerByPid: prevMap });
      const v = safeArray(ev?.violations).length;
      const ro = reportOverflowForOwner(o, prevMap);
      const load = ownerLoad(o, role2);
      return { o, idx, v, ro, load };
    });

    scored.sort((a, b) => {
      if (b.v !== a.v) return b.v - a.v;
      if (b.ro !== a.ro) return b.ro - a.ro;
      return b.load - a.load;
    });

    return scored.filter(x => (x.v > 0) || (x.ro > 0));
  }

  function swapInPlace(ownerA, i, ownerB, j) {
    const A = safeArray(ownerA.patients);
    const B = safeArray(ownerB.patients);
    const tmp = A[i];
    A[i] = B[j];
    B[j] = tmp;
    ownerA.patients = A;
    ownerB.patients = B;
  }

  // ✅ RN lock helpers
  function rnLockMeta(patientId) {
    const p = resolvePatient(patientId);
    if (!p) return { enabled: false, rnId: null };
    const enabled = !!p.lockRnEnabled;
    const rnId = (p.lockRnTo !== undefined && p.lockRnTo !== null) ? Number(p.lockRnTo) : null;
    return { enabled, rnId: Number.isFinite(rnId) ? rnId : null };
  }

  function isSwapAllowedWithRnLocks(ownerA, pidA, ownerB, pidB, role2) {
    if (role2 !== "nurse") return true;

    const A = Number(ownerA?.id);
    const B = Number(ownerB?.id);

    const lockA = rnLockMeta(pidA);
    const lockB = rnLockMeta(pidB);

    if (lockA.enabled && lockA.rnId && Number(lockA.rnId) !== B) return false;
    if (lockB.enabled && lockB.rnId && Number(lockB.rnId) !== A) return false;

    return true;
  }

  function repairAssignmentsInPlaceInternal(owners2, role2, limitsOverride, opts = {}) {
    const list2 = safeArray(owners2).filter(Boolean);
    if (list2.length < 2) return { ok: false, reason: "Need at least 2 owners" };

    const r2 = (role2 === "pca") ? "pca" : "nurse";
    const maxIters = typeof opts.maxIters === "number" ? opts.maxIters : 20;

    // Early exit when clean: no avoidable violations and no report-source overflow.
    // Avoids running the swap search when assignment is already safe and report-optimized.
    const initialTuple = qualityTuple(list2, r2, limitsOverride);
    if (initialTuple.avoidable <= 0 && initialTuple.reportOverflow <= 0) {
      return {
        ok: true,
        done: true,
        iter: 0,
        avoidableViolations: initialTuple.avoidable,
        reportOverflow: initialTuple.reportOverflow,
        warnings: countWarningsAll(list2, r2, limitsOverride)
      };
    }

    let iter = 0;

    while (iter < maxIters) {
      iter++;

      const baseTuple = qualityTuple(list2, r2, limitsOverride);

      if (baseTuple.avoidable <= 0 && baseTuple.reportOverflow <= 0) {
        return {
          ok: true,
          done: true,
          iter,
          avoidableViolations: baseTuple.avoidable,
          reportOverflow: baseTuple.reportOverflow,
          warnings: countWarningsAll(list2, r2, limitsOverride)
        };
      }

      const offenders = getWorstOffenders(list2, r2, limitsOverride);
      const candidateAIdxs = offenders.length
        ? offenders.slice(0, 5).map(x => x.idx)
        : list2.slice(0, 3).map((_, idx) => idx);

      let best = null;

      for (const aIdx of candidateAIdxs) {
        const A = list2[aIdx];
        const Apts = safeArray(A.patients);
        if (!Apts.length) continue;

        for (let bIdx = 0; bIdx < list2.length; bIdx++) {
          if (bIdx === aIdx) continue;
          const B = list2[bIdx];
          const Bpts = safeArray(B.patients);
          if (!Bpts.length) continue;

          for (let i = 0; i < Apts.length; i++) {
            for (let j = 0; j < Bpts.length; j++) {
              const pidA = Apts[i];
              const pidB = Bpts[j];

              if (!isSwapAllowedWithRnLocks(A, pidA, B, pidB, r2)) continue;

              const origA = A.patients;
              const origB = B.patients;

              swapInPlace(A, i, B, j);

              const nextTuple = qualityTuple(list2, r2, limitsOverride);

              A.patients = origA;
              B.patients = origB;

              if (!isBetterTuple(nextTuple, baseTuple)) continue;

              const candidate = { aIdx, bIdx, i, j, pidA, pidB, baseTuple, nextTuple };
              if (!best || isBetterTuple(candidate.nextTuple, best.nextTuple)) best = candidate;
            }
          }
        }
      }

      if (!best) {
        return {
          ok: true,
          done: false,
          iter,
          avoidableViolations: qualityTuple(list2, r2, limitsOverride).avoidable,
          reportOverflow: qualityTuple(list2, r2, limitsOverride).reportOverflow,
          warnings: countWarningsAll(list2, r2, limitsOverride),
          reason: "No improving swap found (some issues may be unavoidable)."
        };
      }

      const Ause = list2[best.aIdx];
      const Buse = list2[best.bIdx];
      if (Ause && Buse) swapInPlace(Ause, best.i, Buse, best.j);
      else break;
    }

    return {
      ok: true,
      done: false,
      iter: maxIters,
      avoidableViolations: qualityTuple(list2, r2, limitsOverride).avoidable,
      reportOverflow: qualityTuple(list2, r2, limitsOverride).reportOverflow,
      warnings: countWarningsAll(list2, r2, limitsOverride),
      reason: "Hit max repair iterations"
    };
  }

  window.repairAssignmentsInPlace = function (owners2, role2, limitsOverride, opts = {}) {
    return repairAssignmentsInPlaceInternal(owners2, role2, limitsOverride, opts);
  };

  // =========================================================
  // ✅ NEW: Safe Rebalance API (never makes it worse)
  // =========================================================
  window.rebalanceOwnersSafely = function (owners, role, limitsOverride, opts = {}) {
    const r = (role === "pca") ? "pca" : "nurse";
    const baseOwners = safeArray(owners).filter(Boolean);

    const baselineTuple = qualityTuple(baseOwners, r, limitsOverride);
    const baselinePatients = baseOwners.map(o => safeArray(o?.patients).slice());

    const clone = deepCloneOwnersShallow(baseOwners);
    const res = repairAssignmentsInPlaceInternal(clone, r, limitsOverride, opts);

    const nextTuple = qualityTuple(clone, r, limitsOverride);

    // ✅ HARD GATE: never apply preventable (avoidable) rule breaks
    if (nextTuple.avoidable > 0) {
      baseOwners.forEach((o, idx) => { o.patients = safeArray(baselinePatients[idx]); });
      return {
        ok: true,
        applied: false,
        reason: "Unable to produce a rule-clean rebalance (avoidable violations remain).",
        baseline: baselineTuple,
        attempted: nextTuple,
        repair: res
      };
    }

    if (!isBetterTuple(nextTuple, baselineTuple)) {
      baseOwners.forEach((o, idx) => { o.patients = safeArray(baselinePatients[idx]); });
      return {
        ok: true,
        applied: false,
        reason: "Unable to produce a more optimal assignment.",
        baseline: baselineTuple,
        attempted: nextTuple,
        repair: res
      };
    }

    baseOwners.forEach((o, idx) => { o.patients = safeArray(clone[idx]?.patients); });

    return {
      ok: true,
      applied: true,
      baseline: baselineTuple,
      improved: nextTuple,
      repair: res
    };
  };

})();
