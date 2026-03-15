// app/app.assignmentEngineV3.js
// Multi-seed + beam-search sidecar optimizer.

(function () {
  function safeArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function cloneJson(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function cloneOwners(owners) {
    return safeArray(owners).map((owner) => ({
      ...owner,
      patients: safeArray(owner?.patients).slice()
    }));
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
      if (p.isolation || p.isoPca || p.iso) score += 3;
      if (p.admit || p.admitPca) score += 3;
      if (p.lateDc || p.lateDcPca) score += 2;
      if (p.telePca || p.tele) score += 1;
      if (p.chg) score += 3;
      if (p.foley) score += 3;
      if (p.q2turns || p.q2Turns) score += 4;
      if (p.feeder || p.feeders) score += 3;
      if (p.strictIo || p.heavy) score += 2;
      return score;
    }
    let score = 0;
    if (p.tele) score += 1;
    if (p.nih) score += 4;
    if (p.drip || p.drips) score += 5;
    if (p.bg || p.bgChecks) score += 2;
    if (p.ciwa || p.cows || p.ciwaCows) score += 4;
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
    return { minTarget, maxTarget: minTarget + (remainder > 0 ? 1 : 0) };
  }

  function dischargeLimit(owner, role) {
    const count = safeArray(owner?.patients).length;
    if (role === "pca") return Math.floor(count / 2);
    return 3;
  }

  function reportSourceLimit(count) {
    if (count >= 4) return 3;
    if (count === 3) return 2;
    if (count === 2) return 2;
    if (count === 1) return 1;
    return 0;
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

  function tagCount(owner, patientMap, role, def) {
    return safeArray(owner?.patients).reduce((sum, pid) => {
      const patient = patientMap.get(Number(pid));
      if (!patient) return sum;
      return sum + (def.keys.some((k) => !!patient[k]) ? 1 : 0);
    }, 0);
  }

  function evaluateOwner(owner, owners, patientMap, role) {
    const limits = LIMITS[role] || LIMITS.nurse;
    const violations = [];
    const count = safeArray(owner?.patients).length;
    const targets = countTargets(owners);
    if (count < targets.minTarget || count > targets.maxTarget) {
      violations.push({ tag: "countBalance", mine: count, limit: `${targets.minTarget}-${targets.maxTarget}` });
    }

    const expectedDischarges = safeArray(owner?.patients).reduce((sum, pid) => {
      const patient = patientMap.get(Number(pid));
      return sum + (patient?.expectedDischarge ? 1 : 0);
    }, 0);
    if (expectedDischarges > dischargeLimit(owner, role)) {
      violations.push({ tag: "expectedDischarge", mine: expectedDischarges });
    }

    Object.entries(limits).forEach(([tag, def]) => {
      const mine = tagCount(owner, patientMap, role, def);
      if (mine > def.limit) violations.push({ tag, mine, limit: def.limit });
    });

    return { violations };
  }

  function continuityLossForOwner(owner, prevOwnerByPid) {
    const expected = String(owner?.name || "");
    return safeArray(owner?.patients).reduce((sum, pid) => sum + ((prevOwnerByPid.get(Number(pid)) === expected) ? 0 : 1), 0);
  }

  function evaluateState(owners, patients, role, prevOwnerByPid) {
    const patientMap = toMapById(patients);
    const ownerEvals = safeArray(owners).map((owner) => evaluateOwner(owner, owners, patientMap, role));
    const counts = safeArray(owners).map((owner) => safeArray(owner?.patients).length);
    const loads = safeArray(owners).map((owner) => safeArray(owner?.patients).reduce((sum, pid) => sum + patientLoad(patientMap.get(Number(pid)), role), 0));
    const reports = safeArray(owners).map((owner) => reportSourcesForOwner(owner, prevOwnerByPid));
    const reportTotal = reports.reduce((sum, n) => sum + n, 0);
    const reportOverflow = safeArray(owners).reduce((sum, owner, idx) => {
      const allowed = reportSourceLimit(safeArray(owner?.patients).length);
      return sum + Math.max(0, reports[idx] - allowed);
    }, 0);
    const hardViolations = ownerEvals.reduce((sum, ev) => sum + safeArray(ev.violations).length, 0);
    const roomOverflow = roomOverflowForOwners(owners, patientMap, role);
    const walk = safeArray(owners).reduce((sum, owner) => sum + roomSpreadForOwner(owner, patientMap), 0);
    const continuityLoss = safeArray(owners).reduce((sum, owner) => sum + continuityLossForOwner(owner, prevOwnerByPid), 0);
    const maxCount = counts.length ? Math.max(...counts) : 0;
    const minCount = counts.length ? Math.min(...counts) : 0;
    const maxLoad = loads.length ? Math.max(...loads) : 0;
    const minLoad = loads.length ? Math.min(...loads) : 0;

    return {
      hardViolations,
      countSpread: maxCount - minCount,
      dischargeOverflow: safeArray(owners).reduce((sum, owner) => {
        const count = safeArray(owner?.patients).reduce((n, pid) => n + (patientMap.get(Number(pid))?.expectedDischarge ? 1 : 0), 0);
        return sum + Math.max(0, count - dischargeLimit(owner, role));
      }, 0),
      roomOverflow,
      reportOverflow,
      reportTotal,
      loadSpread: maxLoad - minLoad,
      walk,
      continuityLoss
    };
  }

  function compareStates(a, b) {
    if (!b) return -1;
    const tupleA = [a.hardViolations, a.countSpread, a.dischargeOverflow, a.loadSpread, a.reportOverflow, a.reportTotal, a.roomOverflow, a.walk, a.continuityLoss];
    const tupleB = [b.hardViolations, b.countSpread, b.dischargeOverflow, b.loadSpread, b.reportOverflow, b.reportTotal, b.roomOverflow, b.walk, b.continuityLoss];
    for (let i = 0; i < tupleA.length; i++) {
      if (tupleA[i] !== tupleB[i]) return tupleA[i] - tupleB[i];
    }
    return 0;
  }

  function isPinnedToDifferentOwner(patient, targetOwnerId, role) {
    if (!patient) return false;
    if (role === "pca") return !!(patient.lockPcaEnabled && Number(patient.lockPcaTo) !== Number(targetOwnerId));
    return !!(patient.lockRnEnabled && Number(patient.lockRnTo) !== Number(targetOwnerId));
  }

  function buildSeedOwners(input, strategy) {
    const owners = cloneOwners(input.owners).map((owner) => ({ ...owner, patients: [] }));
    const patients = cloneJson(input.patients);
    const prevOwnerByPid = new Map(Object.entries(input.prevOwnerByPid || {}).map(([pid, owner]) => [Number(pid), String(owner || "")]));

    patients.forEach((patient) => {
      const lockField = input.role === "pca" ? "lockPcaEnabled" : "lockRnEnabled";
      const lockToField = input.role === "pca" ? "lockPcaTo" : "lockRnTo";
      if (!patient?.[lockField]) return;
      const owner = owners.find((o) => Number(o.id) === Number(patient?.[lockToField]));
      if (owner) owner.patients.push(Number(patient.id));
    });

    const remaining = patients.filter((patient) => !owners.some((owner) => safeArray(owner.patients).includes(Number(patient.id))));
    if (strategy === "room") {
      remaining.sort((a, b) => (getRoomNumber(a) || 9999) - (getRoomNumber(b) || 9999));
    } else if (strategy === "continuity") {
      remaining.sort((a, b) => {
        const pa = prevOwnerByPid.get(Number(a.id)) ? 0 : 1;
        const pb = prevOwnerByPid.get(Number(b.id)) ? 0 : 1;
        return pa - pb || patientLoad(b, input.role) - patientLoad(a, input.role);
      });
    } else if (strategy === "report") {
      remaining.sort((a, b) => {
        const pa = String(prevOwnerByPid.get(Number(a.id)) || "");
        const pb = String(prevOwnerByPid.get(Number(b.id)) || "");
        return pa.localeCompare(pb) || ((getRoomNumber(a) || 9999) - (getRoomNumber(b) || 9999));
      });
    } else {
      remaining.sort((a, b) => patientLoad(b, input.role) - patientLoad(a, input.role));
    }

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

  function keyForOwners(owners) {
    return safeArray(owners).map((owner) => safeArray(owner?.patients).slice().sort((a, b) => a - b).join(",")).join("|");
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

  function topOwnerIndexesByLoad(state, count) {
    const spreadCount = Math.max(1, Number(count) || 1);
    const loads = safeArray(state?.owners || []).map((owner, idx) => ({ idx, load: owner.load }));
    const heavy = loads.slice().sort((a, b) => b.load - a.load).slice(0, spreadCount).map((x) => x.idx);
    const light = loads.slice().sort((a, b) => a.load - b.load).slice(0, spreadCount).map((x) => x.idx);
    return Array.from(new Set([...heavy, ...light]));
  }

  function topOwnerIndexesByPressure(summaries, count) {
    const spreadCount = Math.max(1, Number(count) || 1);
    const byPressure = safeArray(summaries)
      .map((owner) => ({
        idx: owner.idx,
        pressure: (owner.load * 3) + (owner.reportSources * 2) + owner.roomSpread
      }))
      .sort((a, b) => b.pressure - a.pressure)
      .slice(0, spreadCount)
      .map((entry) => entry.idx);
    return byPressure;
  }

  function ownerSummaries(owners, patients, role, prevOwnerByPid) {
    const patientMap = toMapById(patients);
    return safeArray(owners).map((owner) => ({
      idx: safeArray(owners).indexOf(owner),
      load: safeArray(owner?.patients).reduce((sum, pid) => sum + patientLoad(patientMap.get(Number(pid)), role), 0),
      reportSources: reportSourcesForOwner(owner, prevOwnerByPid),
      roomSpread: roomSpreadForOwner(owner, patientMap)
    }));
  }

  function generateTrials(entry, patients, role, prevOwnerByPid) {
    const working = entry.owners;
    const patientMap = toMapById(patients);
    const summaries = ownerSummaries(working, patients, role, prevOwnerByPid);
    const focusOwners = topOwnerIndexesByLoad({ owners: summaries }, 3);
    const pressureOwners = topOwnerIndexesByPressure(summaries, role === "pca" ? 4 : 3);
    const targetOwners = Array.from(new Set([...(focusOwners || []), ...(pressureOwners || [])]));
    const usableOwners = targetOwners.length ? targetOwners : summaries.map((s) => s.idx);
    const next = [];

    usableOwners.forEach((fromIdx) => {
      const fromOwner = working[fromIdx];
      const rankedPatients = safeArray(fromOwner?.patients).slice().sort((a, b) => {
        const pa = patientLoad(patientMap.get(Number(a)), role);
        const pb = patientLoad(patientMap.get(Number(b)), role);
        return pb - pa;
      });
      for (const patientId of rankedPatients) {
        const patient = patientMap.get(Number(patientId));
        usableOwners.forEach((toIdx) => {
          if (toIdx === fromIdx) return;
          if (isPinnedToDifferentOwner(patient, working[toIdx]?.id, role)) return;
          const trial = cloneOwners(working);
          if (!movePatient(trial, fromIdx, toIdx, patientId)) return;
          next.push(trial);
        });
      }
    });

    // Two-step follow-up for the worst spread cases.
    if ((entry.state?.loadSpread || 0) >= (role === "pca" ? 8 : 8)) {
      const heavyIdx = summaries.slice().sort((a, b) => b.load - a.load)[0]?.idx;
      const lightIdx = summaries.slice().sort((a, b) => a.load - b.load)[0]?.idx;
      if (heavyIdx != null && lightIdx != null && heavyIdx !== lightIdx) {
        for (const patientId of safeArray(working[heavyIdx]?.patients)) {
          const patient = patientMap.get(Number(patientId));
          if (isPinnedToDifferentOwner(patient, working[lightIdx]?.id, role)) continue;
          const first = cloneOwners(working);
          if (!movePatient(first, heavyIdx, lightIdx, patientId)) continue;
          const firstSummaries = ownerSummaries(first, patients, role, prevOwnerByPid);
          const secondHeavy = firstSummaries.slice().sort((a, b) => b.load - a.load)[0]?.idx;
          const secondLight = firstSummaries.slice().sort((a, b) => a.load - b.load)[0]?.idx;
          if (secondHeavy == null || secondLight == null || secondHeavy === secondLight) {
            next.push(first);
            continue;
          }
          for (const followId of safeArray(first[secondHeavy]?.patients)) {
            const followPatient = patientMap.get(Number(followId));
            if (isPinnedToDifferentOwner(followPatient, first[secondLight]?.id, role)) continue;
            const second = cloneOwners(first);
            if (!movePatient(second, secondHeavy, secondLight, followId)) continue;
            next.push(second);
          }
          next.push(first);
        }
      }
    }

    return next;
  }

  function refineWithBeam(seedOwners, patients, role, prevOwnerByPid, maxPasses) {
    const beamWidth = 10;
    const seen = new Set();
    let beam = [{ owners: cloneOwners(seedOwners), state: evaluateState(seedOwners, patients, role, prevOwnerByPid) }];
    let best = beam[0];
    seen.add(keyForOwners(best.owners));

    for (let pass = 0; pass < maxPasses; pass++) {
      const nextBeam = [];
      beam.forEach((entry) => {
        generateTrials(entry, patients, role, prevOwnerByPid).forEach((trial) => {
          const key = keyForOwners(trial);
          if (seen.has(key)) return;
          seen.add(key);
          const state = evaluateState(trial, patients, role, prevOwnerByPid);
          nextBeam.push({ owners: trial, state });
        });
      });

      if (!nextBeam.length) break;
      nextBeam.sort((a, b) => compareStates(a.state, b.state));
      beam = nextBeam.slice(0, beamWidth);
      if (compareStates(beam[0].state, best.state) < 0) best = beam[0];
      if (best.state.hardViolations === 0 && best.state.countSpread <= 1 && best.state.dischargeOverflow <= 0 && best.state.roomOverflow <= 0 && best.state.reportOverflow <= 0) break;
    }

    return best;
  }

  function solve(input) {
    const role = input?.role === "pca" ? "pca" : "nurse";
    const maxPasses = Math.max(40, Number(input?.maxPasses) || 120);
    const strategies = ["load", "room", "continuity", "report"];
    let best = null;

    strategies.forEach((strategy) => {
      const seed = buildSeedOwners({ ...input, role }, strategy);
      const refined = refineWithBeam(seed.owners, seed.patients, role, seed.prevOwnerByPid, Math.max(12, Math.floor(maxPasses / 6)));
      if (!best || compareStates(refined.state, best.state) < 0) {
        best = { ...refined, strategy };
      }
    });

    return {
      owners: best ? best.owners : cloneOwners(input?.owners || []),
      summary: best ? { ...best.state, strategy: best.strategy, engine: "Engine V3" } : { engine: "Engine V3" }
    };
  }

  window.assignmentEngineV3 = { solve };
})();
