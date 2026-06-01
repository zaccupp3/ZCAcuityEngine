// app/app.assignmentEngineV2.js
// Sidecar assignment engine. This does not replace the live engine yet.

(function () {
  function safeArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function cloneJson(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function toMapById(list) {
    const map = new Map();
    safeArray(list).forEach((item) => {
      if (!item || item.id == null) return;
      map.set(Number(item.id), item);
    });
    return map;
  }

  function getRoomNumber(patient) {
    const raw = String(patient?.room || patient?.roomNumber || "");
    const m = raw.match(/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function patientLoad(patient, role) {
    if (!patient || patient.isEmpty) return 0;
    const p = patient;
    if (role === "pca") {
      let score = 0;
      if (p.isolation) score += 3;
      if (p.admit || p.admitPca) score += 3;
      if (p.lateDc || p.lateDcPca) score += 2;
      if (p.chg) score += 3;
      if (p.foley) score += 3;
      if (p.q2turns || p.q2Turns) score += 4;
      if (p.feeder) score += 3;
      return score;
    }
    let score = 0;
    if (p.tele) score += 1;
    if (p.nih) score += 4;
    if (p.drip || p.drips) score += 5;
    if (p.bg || p.bgChecks) score += 2;
    if (p.ciwa || p.cows || p.ciwaCows) score += 4;
    if (p.emu) score += 4;
    if (p.sitter) score += 4;
    if (p.isolation || p.iso) score += 2;
    if (p.admit) score += 4;
    if (p.lateDc) score += 2;
    return score;
  }

  const LIMITS = {
    nurse: {
      drip: { keys: ["drip", "drips"], limit: 1 },
      nih: { keys: ["nih"], limit: 1 },
      bg: { keys: ["bg", "bgChecks"], limit: 2 },
      ciwa: { keys: ["ciwa", "cows", "ciwaCows"], limit: 1 },
      emu: { keys: ["emu"], limit: 1 },
      sitter: { keys: ["sitter"], limit: 1 },
      isolation: { keys: ["isolation", "iso"], limit: 2 },
      admit: { keys: ["admit"], limit: 1 },
      lateDc: { keys: ["lateDc", "lateDC", "latedc"], limit: 1 }
    },
    pca: {
      chg: { keys: ["chg"], limit: 1 },
      foley: { keys: ["foley"], limit: 1 },
      q2turns: { keys: ["q2turns", "q2Turns"], limit: 1 },
      feeder: { keys: ["feeder"], limit: 1 },
      isolation: { keys: ["isolation", "iso", "isoPca"], limit: 2 },
      admit: { keys: ["admit", "admitPca"], limit: 1 },
      lateDc: { keys: ["lateDc", "lateDC", "latedc", "lateDcPca"], limit: 1 }
    }
  };

  function countTargets(owners) {
    const total = safeArray(owners).reduce((sum, owner) => sum + safeArray(owner?.patients).length, 0);
    const ownerCount = Math.max(1, safeArray(owners).length);
    const minTarget = Math.floor(total / ownerCount);
    const remainder = total % ownerCount;
    return { total, ownerCount, minTarget, maxTarget: minTarget + (remainder > 0 ? 1 : 0) };
  }

  function rnRatioCap(owner, patientMap) {
    const needsFour = safeArray(owner?.patients).some((pid) => {
      const patient = patientMap.get(Number(pid));
      return !!(patient && (patient.tele || patient.nih || patient.emu));
    });
    return needsFour ? 4 : 5;
  }

  function dischargeLimit(owner, owners, role) {
    const count = safeArray(owner?.patients).length;
    if (role === "pca") return Math.floor(count / 2);
    void owners;
    return 3;
  }

  function reportSourceLimit(count) {
    if (count >= 4) return 3;
    if (count === 3) return 2;
    if (count === 2) return 2;
    if (count === 1) return 1;
    return 0;
  }

  function tagCount(owner, patientMap, role, def) {
    return safeArray(owner?.patients).reduce((sum, pid) => {
      const patient = patientMap.get(Number(pid));
      if (!patient) return sum;
      return sum + (def.keys.some((k) => !!patient[k]) ? 1 : 0);
    }, 0);
  }

  function hasNihEmuPair(owner, patientMap) {
    let hasNih = false;
    let hasEmu = false;
    safeArray(owner?.patients).forEach((pid) => {
      const patient = patientMap.get(Number(pid));
      if (patient?.nih) hasNih = true;
      if (patient?.emu) hasEmu = true;
    });
    return hasNih && hasEmu;
  }

  function evaluateOwner(owner, owners, patientMap, role) {
    const limits = LIMITS[role] || LIMITS.nurse;
    const violations = [];
    const count = safeArray(owner?.patients).length;
    const targets = countTargets(owners);
    if (role !== "pca") {
      const ratioCap = rnRatioCap(owner, patientMap);
      if (count > ratioCap) violations.push({ tag: "rnRatio", mine: count, limit: ratioCap });
      if (count > 5) violations.push({ tag: "rnAbsoluteMax", mine: count, limit: 5 });
      if (hasNihEmuPair(owner, patientMap)) violations.push({ tag: "nihEmu", mine: 2, limit: 1 });
    }
    if (count < targets.minTarget || count > targets.maxTarget) {
      violations.push({ tag: "countBalance", mine: count, limit: `${targets.minTarget}-${targets.maxTarget}` });
    }

    const expectedDischarges = safeArray(owner?.patients).reduce((sum, pid) => {
      const patient = patientMap.get(Number(pid));
      return sum + (patient?.expectedDischarge ? 1 : 0);
    }, 0);
    const dischargeCap = dischargeLimit(owner, owners, role);
    if (expectedDischarges > dischargeCap) {
      violations.push({ tag: "expectedDischarge", mine: expectedDischarges, limit: dischargeCap });
    }

    Object.entries(limits).forEach(([tag, def]) => {
      const mine = tagCount(owner, patientMap, role, def);
      if (mine > def.limit) violations.push({ tag, mine, limit: def.limit });
    });

    return {
      count,
      expectedDischarges,
      violations
    };
  }

  function loadForOwner(owner, patientMap, role) {
    return safeArray(owner?.patients).reduce((sum, pid) => sum + patientLoad(patientMap.get(Number(pid)), role), 0);
  }

  function reportSourcesForOwner(owner, prevOwnerByPid) {
    const seen = new Set();
    safeArray(owner?.patients).forEach((pid) => {
      const prev = prevOwnerByPid.get(Number(pid));
      if (prev) seen.add(prev);
    });
    return seen.size;
  }

  function roomSpreadForOwner(owner, patientMap) {
    const rooms = safeArray(owner?.patients)
      .map((pid) => getRoomNumber(patientMap.get(Number(pid))))
      .filter((n) => typeof n === "number" && Number.isFinite(n))
      .sort((a, b) => a - b);
    if (rooms.length < 2) return 0;
    return rooms[rooms.length - 1] - rooms[0];
  }

  function roomOverflowForOwners(owners, patientMap, role) {
    const limit = role === "pca" ? 14 : 10;
    return safeArray(owners).reduce((sum, owner) => sum + Math.max(0, roomSpreadForOwner(owner, patientMap) - limit), 0);
  }

  function continuityLossForOwner(owner, prevOwnerByPid) {
    const expected = String(owner?.name || "");
    return safeArray(owner?.patients).reduce((sum, pid) => sum + ((prevOwnerByPid.get(Number(pid)) === expected) ? 0 : 1), 0);
  }

  function evaluateState(owners, patients, role, prevOwnerByPid) {
    const patientMap = toMapById(patients);
    const ownerEvals = safeArray(owners).map((owner) => evaluateOwner(owner, owners, patientMap, role));
    const loads = safeArray(owners).map((owner) => loadForOwner(owner, patientMap, role));
    const counts = safeArray(owners).map((owner) => safeArray(owner?.patients).length);
    const reports = safeArray(owners).map((owner) => reportSourcesForOwner(owner, prevOwnerByPid));
    const reportTotal = reports.reduce((sum, n) => sum + n, 0);
    const reportOverflow = safeArray(owners).reduce((sum, owner, idx) => {
      const allowed = reportSourceLimit(safeArray(owner?.patients).length);
      return sum + Math.max(0, reports[idx] - allowed);
    }, 0);
    const roomOverflow = roomOverflowForOwners(owners, patientMap, role);
    const walk = safeArray(owners).reduce((sum, owner) => sum + roomSpreadForOwner(owner, patientMap), 0);
    const continuityLoss = safeArray(owners).reduce((sum, owner) => sum + continuityLossForOwner(owner, prevOwnerByPid), 0);
    const hardViolations = ownerEvals.reduce((sum, ev) => sum + safeArray(ev.violations).length, 0);
    const maxLoad = loads.length ? Math.max(...loads) : 0;
    const minLoad = loads.length ? Math.min(...loads) : 0;
    const maxCount = counts.length ? Math.max(...counts) : 0;
    const minCount = counts.length ? Math.min(...counts) : 0;

    return {
      hardViolations,
      countSpread: maxCount - minCount,
      loadSpread: maxLoad - minLoad,
      roomOverflow,
      reportTotal,
      reportOverflow,
      walk,
      continuityLoss,
      ownerEvals
    };
  }

  function compareStates(a, b) {
    if (!b) return -1;
    const tupleA = [a.hardViolations, a.countSpread, a.loadSpread, a.reportOverflow, a.reportTotal, a.roomOverflow, a.walk, a.continuityLoss];
    const tupleB = [b.hardViolations, b.countSpread, b.loadSpread, b.reportOverflow, b.reportTotal, b.roomOverflow, b.walk, b.continuityLoss];
    for (let i = 0; i < tupleA.length; i++) {
      if (tupleA[i] !== tupleB[i]) return tupleA[i] - tupleB[i];
    }
    return 0;
  }

  function cloneOwners(owners) {
    return safeArray(owners).map((owner) => ({
      ...owner,
      patients: safeArray(owner?.patients).slice()
    }));
  }

  function movePatient(owners, fromIdx, toIdx, patientId) {
    const from = owners[fromIdx];
    const to = owners[toIdx];
    const idx = safeArray(from?.patients).indexOf(Number(patientId));
    if (idx === -1) return false;
    from.patients.splice(idx, 1);
    if (!to.patients.includes(Number(patientId))) to.patients.push(Number(patientId));
    return true;
  }

  function isPinnedToDifferentOwner(patient, targetOwnerId, role) {
    if (!patient) return false;
    if (role === "pca") return !!(patient.lockPcaEnabled && Number(patient.lockPcaTo) !== Number(targetOwnerId));
    return !!(patient.lockRnEnabled && Number(patient.lockRnTo) !== Number(targetOwnerId));
  }

  function buildInitialOwners(input) {
    const owners = cloneOwners(input.owners).map((owner) => ({ ...owner, patients: [] }));
    const patients = cloneJson(input.patients);
    const patientMap = toMapById(patients);
    const prevOwnerByPid = new Map(Object.entries(input.prevOwnerByPid || {}).map(([pid, owner]) => [Number(pid), String(owner || "")]));

    patients.forEach((patient) => {
      const lockField = input.role === "pca" ? "lockPcaEnabled" : "lockRnEnabled";
      const lockToField = input.role === "pca" ? "lockPcaTo" : "lockRnTo";
      if (!patient?.[lockField]) return;
      const owner = owners.find((o) => Number(o.id) === Number(patient?.[lockToField]));
      if (owner) owner.patients.push(Number(patient.id));
    });

    const remaining = patients.filter((patient) => !owners.some((owner) => safeArray(owner.patients).includes(Number(patient.id))));
    remaining.sort((a, b) => patientLoad(b, input.role) - patientLoad(a, input.role));

    remaining.forEach((patient) => {
      let bestIdx = 0;
      let bestState = null;
      owners.forEach((owner, idx) => {
        if (isPinnedToDifferentOwner(patient, owner.id, input.role)) return;
        const trial = cloneOwners(owners);
        trial[idx].patients.push(Number(patient.id));
        const state = evaluateState(trial, patients, input.role, prevOwnerByPid);
        if (compareStates(state, bestState) < 0) {
          bestState = state;
          bestIdx = idx;
        }
      });
      owners[bestIdx].patients.push(Number(patient.id));
    });

    return { owners, patients, prevOwnerByPid };
  }

  function improveOwners(owners, patients, role, prevOwnerByPid, maxPasses) {
    let working = cloneOwners(owners);
    let bestState = evaluateState(working, patients, role, prevOwnerByPid);

    for (let pass = 0; pass < maxPasses; pass++) {
      let improved = false;
      let bestTrialOwners = null;
      let bestTrialState = bestState;

      for (let fromIdx = 0; fromIdx < working.length; fromIdx++) {
        for (const patientId of safeArray(working[fromIdx]?.patients)) {
          const patient = toMapById(patients).get(Number(patientId));
          for (let toIdx = 0; toIdx < working.length; toIdx++) {
            if (toIdx === fromIdx) continue;
            if (isPinnedToDifferentOwner(patient, working[toIdx]?.id, role)) continue;
            const trial = cloneOwners(working);
            if (!movePatient(trial, fromIdx, toIdx, patientId)) continue;
            const trialState = evaluateState(trial, patients, role, prevOwnerByPid);
            if (compareStates(trialState, bestTrialState) < 0) {
              bestTrialOwners = trial;
              bestTrialState = trialState;
              improved = true;
            }
          }
        }
      }

      if (!improved || !bestTrialOwners) break;
      working = bestTrialOwners;
      bestState = bestTrialState;
      if (bestState.hardViolations === 0 && bestState.countSpread <= 1) break;
    }

    return { owners: working, state: bestState };
  }

  function solve(input) {
    const role = input?.role === "pca" ? "pca" : "nurse";
    const seed = buildInitialOwners({ ...input, role });
    const result = improveOwners(seed.owners, seed.patients, role, seed.prevOwnerByPid, Number(input?.maxPasses) || 80);
    return {
      owners: result.owners,
      summary: result.state
    };
  }

  window.assignmentEngineV2 = {
    solve
  };
})();
