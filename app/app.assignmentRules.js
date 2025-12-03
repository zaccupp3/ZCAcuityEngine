// app/app.assignmentRules.js
// ---------------------------------------------------------
// Smarter distribution helpers for distributing patients across staff.
// Goal: keep counts even AND balance acuity load (RN/PCA scores).
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
    let sum = 0;

    // sum existing
    for (const id of ids) {
      const p = (typeof window.getPatientById === "function") ? window.getPatientById(id) : null;
      if (!p || p.isEmpty) continue;
      sum += (role === "pca") ? pcaPatientScore(p) : rnPatientScore(p);
    }

    // add hypothetical patient
    if (extraPatientObj && !extraPatientObj.isEmpty) {
      sum += (role === "pca") ? pcaPatientScore(extraPatientObj) : rnPatientScore(extraPatientObj);
    }

    return sum;
  }

  // -----------------------------
  // MAIN: distributePatientsEvenly
  // -----------------------------
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