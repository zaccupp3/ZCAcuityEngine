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
// - "Locked to RN" aware in-place repair:
//   If patient.lockRnEnabled && patient.lockRnTo is set,
//   repairAssignmentsInPlace() will NOT swap/move that patient away from its locked RN.
//
// FIX (Dec 2025):
// - distributePatientsEvenly() now supports options.preserveExisting:
//   it will NOT wipe owner.patients, and it will NOT re-assign already-assigned patients.
//   (This is required so pinned patients pre-placed by assignmentsrender.js survive regenerate.)
// - repairAssignmentsInPlace() now also prioritizes COUNT BALANCE (spread) so it won't
//   “fix” rules by creating 7 vs 3 patient distributions when avoidable.
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
    if (typeof window.getPatientScore === "function") return window.getPatientScore(p);
    return 0;
  }

  function pcaPatientScore(p) {
    if (!p || p.isEmpty) return 0;

    let score = 0;
    if (p.isolation) score += 3;
    if (p.admit) score += 3;
    if (p.lateDc) score += 2;
    if (p.chg) score += 3;
    if (p.foley) score += 3;
    if (p.q2turns) score += 4;
    if (p.heavy) score += 5;
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
    heavy: 1,
    isolation: 2,
    admit: 1,
    lateDc: 1
  };

  const RN_TAG_KEYS = {
    drip: ["drip", "drips"],
    nih: ["nih"],
    bg: ["bg", "bgChecks"],
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
    heavy: ["heavy"],
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

  function evaluateOwnerHardRules(owner, ownersAll, role, limitsOverride) {
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

    return {
      counts: ownerCounts,
      violations,
      warnings,
      hasRuleBreak: violations.length > 0,
      hasAnyFlag: (violations.length + warnings.length) > 0
    };
  }

  // Public: evaluate all owners at once
  // Returns a map keyed by owner.name (fallback index)
  window.evaluateAssignmentHardRules = function (owners, role, limitsOverride) {
    const list = safeArray(owners).filter(Boolean);
    const out = {};
    list.forEach((o, idx) => {
      const key = o?.name || o?.label || `owner_${idx + 1}`;
      out[key] = evaluateOwnerHardRules(o, list, role === "pca" ? "pca" : "nurse", limitsOverride);
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
      const ev = evaluateOwnerHardRules(list[i], list, role, limitsOverride);
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

    // Normalize to patient objects (ignore null)
    let list = listRaw.map(toPatientObj).filter(p => p && !p.isEmpty);

    // Fallback if caller passed ids but getPatientById not available
    if (!list.length) {
      if (!preserveExisting) owners.forEach(o => { o.patients = []; });
      else ensurePatientsArrays();

      const already = preserveExisting ? assignedSet() : new Set();

      listRaw.forEach((p, index) => {
        const patientId = Number(getId(p));
        if (preserveExisting && already.has(patientId)) return;
        const owner = owners[index % owners.length];
        if (!Array.isArray(owner.patients)) owner.patients = [];
        owner.patients.push(patientId);
      });
      return;
    }

    // If preserveExisting, remove any patients already pre-assigned (e.g., pins)
    if (preserveExisting) {
      const already = assignedSet();
      list = list.filter(p => !already.has(Number(p.id)));
    }

    // Optional shuffle before sorting
    if (randomize) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = list[i];
        list[i] = list[j];
        list[j] = tmp;
      }
    }

    // =========================================================
    // Phase 2: In-place repair rebalance (NO full redistribution)
    // Priority:
    //   1) Avoidable hard rule violations
    //   2) COUNT balance spread (maxCount-minCount)
    //   3) Load imbalance
    //   4) Report churn
    //   5) Walking spread
    // =========================================================

    function uniqCount(arr) {
      return new Set(safeArray(arr).filter(Boolean)).size;
    }

    function getPrevOwnerNameForPatient(patientId, role2) {
      const pid = Number(patientId);
      if (!pid) return "";

      if (role2 === "pca") {
        const arr = Array.isArray(window.currentPcas) ? window.currentPcas : [];
        const owner = arr.find(o => Array.isArray(o.patients) && o.patients.includes(pid));
        return owner ? (owner.name || `PCA ${owner.id}`) : "";
      }

      const arr = Array.isArray(window.currentNurses) ? window.currentNurses : [];
      const owner = arr.find(o => Array.isArray(o.patients) && o.patients.includes(pid));
      return owner ? (owner.name || `RN ${owner.id}`) : "";
    }

    function reportSourcesForOwner(owner, role2) {
      const names = [];
      for (const pid of safeArray(owner?.patients)) {
        const nm = getPrevOwnerNameForPatient(pid, role2);
        if (nm) names.push(nm);
      }
      return uniqCount(names);
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

    function countAvoidableViolationsAll(owners2, role2, limitsOverride) {
      let total = 0;
      const arr = safeArray(owners2).filter(Boolean);
      for (const o of arr) {
        const ev = evaluateOwnerHardRules(o, arr, role2, limitsOverride);
        total += safeArray(ev?.violations).length;
      }
      return total;
    }

    function countWarningsAll(owners2, role2, limitsOverride) {
      let total = 0;
      const arr = safeArray(owners2).filter(Boolean);
      for (const o of arr) {
        const ev = evaluateOwnerHardRules(o, arr, role2, limitsOverride);
        total += safeArray(ev?.warnings).length;
      }
      return total;
    }

    function getWorstOffenders(owners2, role2, limitsOverride) {
      const arr = safeArray(owners2).filter(Boolean);
      const scored = arr.map((o, idx) => {
        const ev = evaluateOwnerHardRules(o, arr, role2, limitsOverride);
        const v = safeArray(ev?.violations).length;
        const load = ownerLoad(o, role2);
        return { o, idx, v, load };
      });

      scored.sort((a, b) => {
        if (b.v !== a.v) return b.v - a.v;
        return b.load - a.load;
      });

      return scored.filter(x => x.v > 0);
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

    // -----------------------------
    // ✅ RN lock helpers (lock-aware repair)
    // Patient fields:
    //   patient.lockRnEnabled (bool)
    //   patient.lockRnTo (incoming RN id)
    // -----------------------------
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

      // After swap:
      // - pidA would belong to ownerB
      // - pidB would belong to ownerA
      if (lockA.enabled && lockA.rnId && Number(lockA.rnId) !== B) return false;
      if (lockB.enabled && lockB.rnId && Number(lockB.rnId) !== A) return false;

      return true;
    }

    // Main in-place repair
    window.repairAssignmentsInPlace = function (owners2, role2, limitsOverride, opts = {}) {
      const list2 = safeArray(owners2).filter(Boolean);
      if (list2.length < 2) return { ok: false, reason: "Need at least 2 owners" };

      const r2 = (role2 === "pca") ? "pca" : "nurse";
      const maxIters = typeof opts.maxIters === "number" ? opts.maxIters : 20;

      let iter = 0;

      while (iter < maxIters) {
        iter++;

        const baseViol = countAvoidableViolationsAll(list2, r2, limitsOverride);
        if (baseViol <= 0) {
          return {
            ok: true,
            done: true,
            iter,
            avoidableViolations: 0,
            warnings: countWarningsAll(list2, r2, limitsOverride)
          };
        }

        const baseCountSpread = countSpread(list2);
        const baseLoadImb = loadImbalance(list2, r2);
        const baseChurn = list2.reduce((s, o) => s + reportSourcesForOwner(o, r2), 0);
        const baseWalk = list2.reduce((s, o) => s + walkingSpreadForOwner(o), 0);

        const offenders = getWorstOffenders(list2, r2, limitsOverride);
        const candidateAIdxs = offenders.length
          ? offenders.slice(0, 3).map(x => x.idx)
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

                // ✅ lock gate
                if (!isSwapAllowedWithRnLocks(A, pidA, B, pidB, r2)) continue;

                const origA = A.patients;
                const origB = B.patients;

                swapInPlace(A, i, B, j);

                const viol = countAvoidableViolationsAll(list2, r2, limitsOverride);

                if (viol > baseViol) {
                  A.patients = origA;
                  B.patients = origB;
                  continue;
                }

                const cSpread = countSpread(list2);
                const loadImb = loadImbalance(list2, r2);
                const churn = list2.reduce((s, o) => s + reportSourcesForOwner(o, r2), 0);
                const walk = list2.reduce((s, o) => s + walkingSpreadForOwner(o), 0);

                // revert
                A.patients = origA;
                B.patients = origB;

                const candidate = {
                  aIdx, bIdx, i, j,
                  pidA, pidB,
                  viol,
                  cSpread,
                  loadImb,
                  churn,
                  walk,
                  base: { baseViol, baseCountSpread, baseLoadImb, baseChurn, baseWalk }
                };

                function betterThan(x, y) {
                  if (!y) return true;
                  if (x.viol !== y.viol) return x.viol < y.viol;
                  if (x.cSpread !== y.cSpread) return x.cSpread < y.cSpread;
                  if (x.loadImb !== y.loadImb) return x.loadImb < y.loadImb;
                  if (x.churn !== y.churn) return x.churn < y.churn;
                  return x.walk < y.walk;
                }

                const improves =
                  (candidate.viol < baseViol) ||
                  (candidate.viol === baseViol && candidate.cSpread < baseCountSpread) ||
                  (candidate.viol === baseViol && candidate.cSpread === baseCountSpread && candidate.loadImb < baseLoadImb) ||
                  (candidate.viol === baseViol && candidate.cSpread === baseCountSpread && candidate.loadImb === baseLoadImb && candidate.churn < baseChurn) ||
                  (candidate.viol === baseViol && candidate.cSpread === baseCountSpread && candidate.loadImb === baseLoadImb && candidate.churn === baseChurn && candidate.walk < baseWalk);

                if (!improves) continue;
                if (betterThan(candidate, best)) best = candidate;
              }
            }
          }
        }

        if (!best) {
          return {
            ok: true,
            done: false,
            iter,
            avoidableViolations: baseViol,
            warnings: countWarningsAll(list2, r2, limitsOverride),
            reason: "No improving swap found (or locks prevent improvement). Some stacking may be unavoidable."
          };
        }

        // ✅ Apply best swap
        const Ause = list2[best.aIdx];
        const Buse = list2[best.bIdx];
        if (Ause && Buse) swapInPlace(Ause, best.i, Buse, best.j);
        else break;
      }

      return {
        ok: true,
        done: false,
        iter: maxIters,
        avoidableViolations: countAvoidableViolationsAll(
          safeArray(owners2).filter(Boolean),
          (role2 === "pca") ? "pca" : "nurse",
          limitsOverride
        ),
        warnings: countWarningsAll(
          safeArray(owners2).filter(Boolean),
          (role2 === "pca") ? "pca" : "nurse",
          limitsOverride
        ),
        reason: "Hit max repair iterations"
      };
    };

    // -----------------------------
    // Distribution
    // -----------------------------

    // If NOT preserving, wipe first. If preserving, keep existing assignments (e.g., pinned).
    if (!preserveExisting) {
      owners.forEach(o => { o.patients = []; });
    } else {
      ensurePatientsArrays();
    }

    // If load balancing turned off, do round-robin across remaining list
    if (!useLoadBalancing) {
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

    // Sort patients: highest acuity first so we spread the hard stuff early
    list.sort((a, b) => {
      const sa = (role === "pca") ? pcaPatientScore(a) : rnPatientScore(a);
      const sb = (role === "pca") ? pcaPatientScore(b) : rnPatientScore(b);
      return sb - sa;
    });

    // Target caps must account for already-assigned patients if preserveExisting
    const totalRemaining = list.length;

    // Current counts per owner (could include pinned)
    const baseCounts = owners.map(o => safeArray(o.patients).length);

    // Total patients on the board = already assigned + remaining
    const totalAll = baseCounts.reduce((s, x) => s + x, 0) + totalRemaining;

    const nOwners = owners.length;
    const base = Math.floor(totalAll / nOwners);
    const remainder = totalAll % nOwners;

    // We want final counts to be either base or base+1
    // Compute each owner's cap as (base or base+1), but never below its current count.
    const desiredCaps = owners.map((_, i) => base + (i < remainder ? 1 : 0));
    const capByIndex = desiredCaps.map((cap, i) => Math.max(cap, baseCounts[i]));

    // Greedy: each patient goes to eligible owner with lowest projected load,
    // while respecting caps (count balancing).
    list.forEach(p => {
      let bestIdx = -1;
      let bestScore = Infinity;

      for (let i = 0; i < owners.length; i++) {
        const o = owners[i];
        const curCount = safeArray(o.patients).length;
        if (curCount >= capByIndex[i]) continue;

        const projected = ownerProjectedLoad(o, role === "pca" ? "pca" : "nurse", p);

        if (projected < bestScore) {
          bestScore = projected;
          bestIdx = i;
        }
      }

      // Fallback: if everyone is capped (rare; can happen with heavy pinning),
      // put it on the current smallest-count owner.
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
})();