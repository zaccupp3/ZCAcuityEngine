// app/app.assignmentRules.js
// ---------------------------------------------------------
// Smarter distribution helpers for distributing patients across staff.
// Goal: keep counts even AND balance acuity load (RN/PCA scores).
//
// + Phase 1 additions:
// - Hard rule checks (RN + PCA): counts per owner, and unavoidable vs avoidable.
// - Swap suggestions: find a simple patient swap between two owners that reduces
//   rule breaks / stacking (especially BG).
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
    // if it's an id, resolve via global helper
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
    // flexible: supports multiple possible property names
    // e.g. ["bg","bgChecks","bloodSugar"] etc
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

    // Mirrors your getPcaLoadScore per-patient contributions in app.patientsAcuity.js
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

    // sum existing
    for (const id of ids) {
      const p = (typeof window.getPatientById === "function") ? window.getPatientById(id) : null;
      if (!p || p.isEmpty) continue;
      sumLoad += (role === "pca") ? pcaPatientScore(p) : rnPatientScore(p);
    }

    // add hypothetical patient
    if (extraPatientObj && !extraPatientObj.isEmpty) {
      sumLoad += (role === "pca") ? pcaPatientScore(extraPatientObj) : rnPatientScore(extraPatientObj);
    }

    return sumLoad;
  }

  // =========================================================
  // Phase 1: Hard rule checking + swap suggestions
  // =========================================================

  // Hard rules you described (defaults; can be overridden by unit settings later)
  const RN_LIMITS = {
    drip: 1,
    nih: 1,
    bg: 2,
    ciwa: 1,
    restraint: 1,
    sitter: 1,
    vpo: 1,
    isolation: 2, // allow 1–2
    admit: 1,
    lateDc: 1
  };

  const PCA_LIMITS = {
    // tele: balanced evenly (handled by score/swap suggestions more than "red rule"),
    // but we can still flag extreme stacking later if you want.
    chg: 1,     // keep even
    foley: 1,   // keep even
    q2turns: 1, // keep even
    feeder: 1,  // keep even
    heavy: 1,   // keep even
    isolation: 2,
    admit: 1,
    lateDc: 1
  };

  // These key maps let us read your patient objects even if property names vary slightly.
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
    tele: ["telePca", "tele"], // some builds use tele for both
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
    // If a unit has more of a tag than "limit * owners", then SOMEONE must exceed.
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

      // "red" vs "amber" (unavoidable but still worth highlighting)
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
      // helpful for UI
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

  function computePenaltyForOwnerEval(evalObj, role) {
    // "violation" should matter more than "warning"
    const v = safeArray(evalObj?.violations).length;
    const w = safeArray(evalObj?.warnings).length;

    // Extra weight for BG stacking specifically (you called it out a lot)
    const bgPenalty =
      (evalObj?.violations || []).some(x => x.tag === "bg") ? 3 : 0;

    return (v * 10) + (w * 4) + bgPenalty;
  }

  function computeTotalPenalty(owners, role, limitsOverride) {
    let sum = 0;
    const list = safeArray(owners).filter(Boolean);
    for (let i = 0; i < list.length; i++) {
      const ev = evaluateOwnerHardRules(list[i], list, role, limitsOverride);
      sum += computePenaltyForOwnerEval(ev, role);
    }
    return sum;
  }

  // Finds the best 1-for-1 swap between two owners that reduces penalty.
  // Works well for 8 RNs x 4 pts each.
  window.suggestBestSwap = function (owners, role, limitsOverride) {
    const list = safeArray(owners).filter(Boolean);
    if (list.length < 2) return { ok: false, reason: "Need at least 2 owners" };

    const basePenalty = computeTotalPenalty(list, role === "pca" ? "pca" : "nurse", limitsOverride);

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
            // simulate swap
            const Aclone = cloneOwnerPatients(A);
            const Bclone = cloneOwnerPatients(B);

            const tmp = Aclone[i];
            Aclone[i] = Bclone[j];
            Bclone[j] = tmp;

            const originalA = A.patients;
            const originalB = B.patients;

            A.patients = Aclone;
            B.patients = Bclone;

            const newPenalty = computeTotalPenalty(list, role === "pca" ? "pca" : "nurse", limitsOverride);

            // revert
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
  // MAIN: distributePatientsEvenly (your existing logic)
  // =========================================================
  // owners: array of nurse/PCA objects (must have .patients array)
  // patients: array of patient objects or ids
  // options:
  //  - randomize?: boolean (optional shuffle)
  //  - role?: "nurse"|"pca" (recommended)
  //  - useLoadBalancing?: boolean (default true)
  //
  // Behavior:
  // 1) keeps patient counts balanced (diff <= 1)
  // 2) within that, greedily places highest-acuity patients onto lowest projected load owner
  //
  window.distributePatientsEvenly = function (owners, patients, options = {}) {
    owners = safeArray(owners).filter(Boolean);
    if (!owners.length) return;

    const listRaw = safeArray(patients).filter(Boolean);
    if (!listRaw.length) return;

    const randomize = !!options.randomize;
    const role = (options.role === "pca" || options.role === "nurse") ? options.role : "nurse";
    const useLoadBalancing = (options.useLoadBalancing !== false);

    // Normalize to patient objects (ignore null)
    let list = listRaw.map(toPatientObj).filter(p => p && !p.isEmpty);

    // Fallback if caller passed ids but getPatientById not available
    if (!list.length) {
      // still do count-even distribution on raw ids
      owners.forEach(o => { o.patients = []; });
      listRaw.forEach((p, index) => {
        const patientId = getId(p);
        const owner = owners[index % owners.length];
        if (!Array.isArray(owner.patients)) owner.patients = [];
        owner.patients.push(patientId);
      });
      return;
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
    // Priority: Hard rules (avoidable) -> Acuity balance -> Report churn -> Walking spread
    // =========================================================

    function uniqCount(arr) {
      return new Set(safeArray(arr).filter(Boolean)).size;
    }

    function getPrevOwnerNameForPatient(patientId, role) {
      const pid = Number(patientId);
      if (!pid) return "";

      if (role === "pca") {
        const list = Array.isArray(window.currentPcas) ? window.currentPcas : [];
        const owner = list.find(o => Array.isArray(o.patients) && o.patients.includes(pid));
        return owner ? (owner.name || `PCA ${owner.id}`) : "";
      }

      const list = Array.isArray(window.currentNurses) ? window.currentNurses : [];
      const owner = list.find(o => Array.isArray(o.patients) && o.patients.includes(pid));
      return owner ? (owner.name || `RN ${owner.id}`) : "";
    }

    function reportSourcesForOwner(owner, role) {
      const names = [];
      for (const pid of safeArray(owner?.patients)) {
        const nm = getPrevOwnerNameForPatient(pid, role);
        if (nm) names.push(nm);
      }
      return uniqCount(names);
    }

    function roomNumberForPatientId(pid) {
      const p = resolvePatient(pid);
      if (!p) return null;

      // Prefer your existing helper if present
      if (typeof window.getRoomNumber === "function") {
        const n = window.getRoomNumber(p);
        if (typeof n === "number" && isFinite(n) && n !== 9999) return n;
      }

      // Fallback: extract digits from label/room
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
      return nums[nums.length - 1] - nums[0]; // range
    }

    function ownerLoad(owner, role) {
      // Uses your existing per-patient score logic
      return ownerProjectedLoad(owner, role === "pca" ? "pca" : "nurse", null);
    }

    function loadImbalance(owners, role) {
      const loads = safeArray(owners).map(o => ownerLoad(o, role));
      if (!loads.length) return 0;
      const min = Math.min(...loads);
      const max = Math.max(...loads);
      return max - min; // simple + stable
    }

    function countAvoidableViolationsAll(owners, role, limitsOverride) {
      let total = 0;
      const list = safeArray(owners).filter(Boolean);
      for (const o of list) {
        const ev = evaluateOwnerHardRules(o, list, role, limitsOverride);
        total += safeArray(ev?.violations).length; // avoidable only
      }
      return total;
    }

    function countWarningsAll(owners, role, limitsOverride) {
      let total = 0;
      const list = safeArray(owners).filter(Boolean);
      for (const o of list) {
        const ev = evaluateOwnerHardRules(o, list, role, limitsOverride);
        total += safeArray(ev?.warnings).length;
      }
      return total;
    }

    function getWorstOffenders(owners, role, limitsOverride) {
      const list = safeArray(owners).filter(Boolean);
      const scored = list.map((o, idx) => {
        const ev = evaluateOwnerHardRules(o, list, role, limitsOverride);
        const v = safeArray(ev?.violations).length;
        // tie-break: higher load means more urgent when violations tie
        const load = ownerLoad(o, role);
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

    // Main: tries to remove ALL avoidable violations while keeping acuity balanced,
    // then (only then) reduces churn, then walking.
    window.repairAssignmentsInPlace = function (owners, role, limitsOverride, opts = {}) {
      const list = safeArray(owners).filter(Boolean);
      if (list.length < 2) return { ok: false, reason: "Need at least 2 owners" };

      const r = (role === "pca") ? "pca" : "nurse";
      const maxIters = typeof opts.maxIters === "number" ? opts.maxIters : 20;

      let iter = 0;

      while (iter < maxIters) {
        iter++;

        const baseViol = countAvoidableViolationsAll(list, r, limitsOverride);
        if (baseViol <= 0) {
          return {
            ok: true,
            done: true,
            iter,
            avoidableViolations: 0,
            warnings: countWarningsAll(list, r, limitsOverride)
          };
        }

        const baseLoadImb = loadImbalance(list, r);
        const baseChurn = list.reduce((s, o) => s + reportSourcesForOwner(o, r), 0);
        const baseWalk = list.reduce((s, o) => s + walkingSpreadForOwner(o), 0);

        // Focus search on the worst offenders first
        const offenders = getWorstOffenders(list, r, limitsOverride);
        const candidateAs = offenders.length ? offenders.slice(0, 3).map(x => x.o) : list.slice(0, 3);

        let best = null;

        for (const A of candidateAs) {
          const Apts = safeArray(A.patients);
          if (!Apts.length) continue;

          for (const B of list) {
            if (B === A) continue;
            const Bpts = safeArray(B.patients);
            if (!Bpts.length) continue;

            for (let i = 0; i < Apts.length; i++) {
              for (let j = 0; j < Bpts.length; j++) {
                // simulate swap
                const origA = A.patients;
                const origB = B.patients;

                swapInPlace(A, i, B, j);

                const viol = countAvoidableViolationsAll(list, r, limitsOverride);

                // If swap makes violations worse, skip fast
                if (viol > baseViol) {
                  A.patients = origA;
                  B.patients = origB;
                  continue;
                }

                const loadImb = loadImbalance(list, r);
                const churn = list.reduce((s, o) => s + reportSourcesForOwner(o, r), 0);
                const walk = list.reduce((s, o) => s + walkingSpreadForOwner(o), 0);

                // revert
                A.patients = origA;
                B.patients = origB;

                // Lexicographic objective (matches your stated priorities):
                // 1) minimize avoidable violations
                // 2) minimize load imbalance
                // 3) minimize report churn
                // 4) minimize walking spread
                const candidate = {
                  Aname: A.name,
                  Bname: B.name,
                  i, j,
                  fromA: Apts[i],
                  fromB: Bpts[j],
                  viol,
                  loadImb,
                  churn,
                  walk,
                  base: { baseViol, baseLoadImb, baseChurn, baseWalk }
                };

                function betterThan(x, y) {
                  if (!y) return true;
                  if (x.viol !== y.viol) return x.viol < y.viol;
                  if (x.loadImb !== y.loadImb) return x.loadImb < y.loadImb;
                  if (x.churn !== y.churn) return x.churn < y.churn;
                  return x.walk < y.walk;
                }

                // Only accept swaps that improve at least one top-tier dimension
                const improves =
                  (candidate.viol < baseViol) ||
                  (candidate.viol === baseViol && candidate.loadImb < baseLoadImb) ||
                  (candidate.viol === baseViol && candidate.loadImb === baseLoadImb && candidate.churn < baseChurn) ||
                  (candidate.viol === baseViol && candidate.loadImb === baseLoadImb && candidate.churn === baseChurn && candidate.walk < baseWalk);

                if (!improves) continue;
                if (betterThan(candidate, best)) best = candidate;
              }
            }
          }
        }

        // No improving swap found -> stop (might be statistically impossible to eliminate all)
        if (!best) {
          return {
            ok: true,
            done: false,
            iter,
            avoidableViolations: baseViol,
            warnings: countWarningsAll(list, r, limitsOverride),
            reason: "No improving swap found (may be unavoidable with current totals)"
          };
        }

        // Apply best swap
        const ownerA = list.find(o => o.name === best.Aname) || list.find(o => o === best.Aname) || list.find(o => (o?.name || "") === best.Aname);
        const ownerB = list.find(o => o.name === best.Bname) || list.find(o => o === best.Bname) || list.find(o => (o?.name || "") === best.Bname);

        // Safer: locate by object reference via pass-through search
        const Aobj = list.find(o => o?.name === best.Aname) || list.find(o => o === candidateAs.find(x => x?.name === best.Aname));
        const Bobj = list.find(o => o?.name === best.Bname) || list.find(o => o === list.find(x => x?.name === best.Bname));

        const Ause = Aobj || list.find(o => o?.name === best.Aname);
        const Buse = Bobj || list.find(o => o?.name === best.Bname);

        if (Ause && Buse) {
          swapInPlace(Ause, best.i, Buse, best.j);
        } else {
          // Fallback: apply by index search
          const Ai = list.findIndex(o => o?.name === best.Aname);
          const Bi = list.findIndex(o => o?.name === best.Bname);
          if (Ai >= 0 && Bi >= 0) swapInPlace(list[Ai], best.i, list[Bi], best.j);
        }
      }

      // Hit iteration cap
      return {
        ok: true,
        done: false,
        iter: maxIters,
        avoidableViolations: countAvoidableViolationsAll(list, r, limitsOverride),
        warnings: countWarningsAll(list, r, limitsOverride),
        reason: "Hit max repair iterations"
      };
    };
    
    // Reset owners
    owners.forEach(o => { o.patients = []; });

    // If load balancing turned off, do pure round robin
    if (!useLoadBalancing) {
      list.forEach((p, index) => {
        const owner = owners[index % owners.length];
        if (!Array.isArray(owner.patients)) owner.patients = [];
        owner.patients.push(p.id);
      });
      return;
    }

    // Sort patients: highest acuity first so we spread the hard stuff early
    list.sort((a, b) => {
      const sa = (role === "pca") ? pcaPatientScore(a) : rnPatientScore(a);
      const sb = (role === "pca") ? pcaPatientScore(b) : rnPatientScore(b);
      return sb - sa;
    });

    // Target counts: keep counts as even as possible
    const total = list.length;
    const nOwners = owners.length;
    const base = Math.floor(total / nOwners);
    const remainder = total % nOwners;

    // Some owners can take base+1, others base
    const capByIndex = owners.map((_, i) => base + (i < remainder ? 1 : 0));

    // Greedy: each patient goes to eligible owner with lowest projected load
    list.forEach(p => {
      let bestIdx = -1;
      let bestScore = Infinity;

      for (let i = 0; i < owners.length; i++) {
        const o = owners[i];
        const curCount = safeArray(o.patients).length;
        if (curCount >= capByIndex[i]) continue; // respect count balancing

        const projected = ownerProjectedLoad(o, role === "pca" ? "pca" : "nurse", p);

        if (projected < bestScore) {
          bestScore = projected;
          bestIdx = i;
        }
      }

      // If everyone is capped (shouldn’t happen), fallback to smallest count
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
      chosen.patients.push(p.id);
    });
  };
})();