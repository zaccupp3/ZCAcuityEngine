// app/app.shiftBackfill.js
// ---------------------------------------------------------
// Historical metrics backfill
//
// Rebuilds:
// - analytics_shift_metrics
// - staff_shift_metrics
//
// Durable inputs:
// - shift_snapshots
// - audit_events
//
// Goals:
// - prevent historical value loss when finalize/storage shape evolves
// - allow older shifts to be re-scored from canonical stored data
// ---------------------------------------------------------

(function () {
  if (window.__shiftBackfillLoaded) return;
  window.__shiftBackfillLoaded = true;

  const safeArray = (v) => (Array.isArray(v) ? v : []);
  const ANALYTICS_TAG_KEYS = ["tele", "drip", "nih", "bg", "ciwa", "cows", "psych", "prns", "emu", "restraint", "sitter", "vpo", "isolation", "admit", "lateDc"];

  function sbReady() {
    return !!(window.sb && window.sb.client && window.sb.__ready);
  }

  function activeUnitId() {
    return window.activeUnitId ? String(window.activeUnitId) : "";
  }

  async function getUserIdSafe() {
    try {
      const res = await window.sb?.client?.auth?.getUser?.();
      return res?.data?.user?.id || null;
    } catch (_) {
      return null;
    }
  }

  function normalizeShiftType(shiftType) {
    const type = String(shiftType || "day").trim().toLowerCase();
    if (type === "day" || type.includes("day")) return "day";
    if (type === "night" || type === "noc" || type.includes("night") || type.includes("noc")) return "night";
    return type || "day";
  }

  function addDaysYmd(date, days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return "";
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + Number(days || 0));
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function canWrite() {
    const r = String(window.activeUnitRole || "").toLowerCase();
    return r === "owner" || r === "admin" || r === "charge";
  }

  function eventType(ev) {
    return String(ev?.event_type || ev?.type || "").trim().toUpperCase();
  }

  function eventPayload(ev) {
    const payload = ev?.payload;
    return payload && typeof payload === "object" ? payload : {};
  }

  function normalizeName(name) {
    return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function staffProfileKey(role, ref) {
    const sid = ref?.staff_id || ref?.staffId || ref?.staffID || null;
    const localId = ref?.local_owner_id ?? ref?.id ?? null;
    const name = normalizeName(ref?.name);
    return `${role}|${String(sid || localId || name || "unknown")}`;
  }

  function stableStaffId(owner) {
    return owner?.staff_id || owner?.staffId || owner?.staffID || null;
  }

  function isHoldOwner(owner) {
    if (!owner) return false;
    const name = normalizeName(owner.name);
    if (Number(owner.id) === 0) return true;
    if (owner.__hold) return true;
    if (String(owner.type || "").toLowerCase() === "hold") return true;
    return name === "needs to be assigned" ||
      /^incoming\s+(rn|pca)\s*\d*$/.test(name) ||
      /^current\s+(rn|pca)\s*\d*$/.test(name) ||
      /^oncoming\s+(rn|pca)\s*\d*$/.test(name);
  }

  function shiftRank(shiftType) {
    return normalizeShiftType(shiftType) === "day" ? 1 : 2;
  }

  function getNextShiftIdentity(shiftDate, shiftType) {
    const type = normalizeShiftType(shiftType) === "night" ? "night" : "day";
    return {
      shift_date: type === "night" ? addDaysYmd(shiftDate, 1) : shiftDate,
      shift_type: type === "night" ? "day" : "night"
    };
  }

  function makeShiftWindow(shiftDate, shiftType) {
    const day = String(shiftDate || "").trim();
    const type = normalizeShiftType(shiftType);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { startMs: 0, endMs: 0 };

    const start = new Date(`${day}T07:00:00`);
    const nightStart = new Date(`${day}T19:00:00`);
    if (type === "day") {
      return { startMs: start.getTime(), endMs: nightStart.getTime() };
    }
    const nextMorning = new Date(nightStart.getTime() + 12 * 60 * 60 * 1000);
    return { startMs: nightStart.getTime(), endMs: nextMorning.getTime() };
  }

  function eventMs(ev) {
    const raw = ev?.ts || ev?.created_at || ev?.timestamp || null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : 0;
  }

  function filterEventsForShift(events, snapshot) {
    const state = snapshot?.state && typeof snapshot.state === "object" ? snapshot.state : {};
    const liveShiftKey = String(state.live_shift_key || "").trim();
    if (liveShiftKey) {
      const byKey = safeArray(events).filter((ev) => String(ev?.shift_key || ev?.shiftKey || "").trim() === liveShiftKey);
      if (byKey.length) return byKey;
    }

    const windowRange = makeShiftWindow(snapshot?.shift_date, snapshot?.shift_type);
    return safeArray(events).filter((ev) => {
      const ms = eventMs(ev);
      return ms >= windowRange.startMs && ms < windowRange.endMs;
    });
  }

  function tagCountsFromPatients(patients) {
    const out = {};
    safeArray(patients).forEach((p) => {
      if (!p || p.isEmpty) return;
      ANALYTICS_TAG_KEYS.forEach((key) => {
        if (p[key]) out[key] = (out[key] || 0) + 1;
      });
    });
    return out;
  }

  function rnPatientScore(p) {
    let score = 0;
    if (!p || p.isEmpty) return 0;
    score += 1;
    if (p?.drip) score += 3;
    if (p?.nih) score += 3;
    if (p?.bg) score += 3;
    if (p?.tf) score += 2;
    if (p?.ciwa) score += 3;
    if (p?.cows) score += 3;
    if (p?.psych) score += 3;
    if (p?.prns) score += 3;
    if (p?.emu) score += 3;
    if (p?.restraint) score += 3;
    if (p?.sitter) score += 3;
    if (p?.vpo) score += 3;
    if (p?.isolation) score += 1;
    if (p?.admit) score += 3;
    if (p?.lateDc) score += 1;
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
    let bonus = 0;
    if (p.sitter && p.restraint) bonus += 3;
    const behavior = !!(p.ciwa || p.cows || p.ciwaCows || p.psych || p.prns);
    if (behavior && p.sitter) bonus += 3;
    if (p.emu && p.sitter) bonus += 3;
    if (p.drip && behavior) bonus += 3;
    if (p.drip && p.emu) bonus += 3;
    if (p.drip && p.sitter) bonus += 4;
    if (p.nih && p.bg) bonus += 2;
    return bonus;
  }

  function rnStackingBonus(patients) {
    let bg = 0, iso = 0, drip = 0, behavior = 0, emu = 0, sitter = 0, vpo = 0;
    safeArray(patients).forEach((p) => {
      if (!p || p.isEmpty) return;
      if (p.bg) bg += 1;
      if (p.isolation) iso += 1;
      if (p.drip) drip += 1;
      if (p.ciwa || p.cows || p.ciwaCows || p.psych || p.prns) behavior += 1;
      if (p.emu) emu += 1;
      if (p.sitter) sitter += 1;
      if (p.vpo) vpo += 1;
    });
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

  function pcaStackingBonus(patients) {
    return 0;
  }

  function workloadScoreForStarter(role, patients) {
    const pts = safeArray(patients).filter((p) => p && !p.isEmpty);
    if (role === "PCA") return pts.reduce((sum, p) => sum + pcaPatientScore(p), 0) + pcaStackingBonus(pts);
    return pts.reduce((sum, p) => sum + rnPatientScore(p) + rnComboBonus(p), 0) + rnStackingBonus(pts);
  }

  function recalcProfileWorkload(profile, patients) {
    const patientById = new Map(safeArray(patients).map((p) => [Number(p?.id), p]));
    const patientIds = safeArray(profile?.details?.patient_ids).map(Number).filter(Number.isFinite);
    const assignedPatients = patientIds.map((pid) => patientById.get(pid)).filter((p) => p && !p.isEmpty);
    if (!assignedPatients.length) return profile;
    profile.patients_assigned = assignedPatients.length;
    profile.workload_score = workloadScoreForStarter(profile.role, assignedPatients);
    profile.details = {
      ...(profile.details || {}),
      patient_rooms: assignedPatients.map((p) => String(p.room || p.id || "")).filter(Boolean),
      analytics_scoring_version: "2026-07-01-current",
      recalculated_from_snapshot: true
    };
    return profile;
  }

  function createProfile(role, ref) {
    return {
      role,
      name: String(ref?.name || "").trim(),
      staff_id: ref?.staff_id || ref?.staffId || ref?.staffID || null,
      local_owner_id: ref?.local_owner_id ?? ref?.id ?? null,
      patients_assigned: Number(ref?.patients_assigned) || 0,
      workload_score: Number(ref?.workload_score) || 0,
      details: {
        patient_ids: safeArray(ref?.details?.patient_ids || ref?.patient_ids).map(Number).filter(Number.isFinite),
        patient_rooms: safeArray(ref?.details?.patient_rooms || ref?.patient_rooms).map((v) => String(v || "")).filter(Boolean),
        expected_discharges: Number(ref?.details?.expected_discharges ?? ref?.expected_discharges) || 0,
        admits: Number(ref?.details?.admits ?? ref?.admits) || 0,
        discharges: Number(ref?.details?.discharges ?? ref?.discharges) || 0,
        acuity_changes: Number(ref?.details?.acuity_changes ?? ref?.acuity_changes) || 0,
        assignment_changes: Number(ref?.details?.assignment_changes ?? ref?.assignment_changes) || 0,
        event_count: Number(ref?.details?.event_count ?? ref?.event_count) || 0
      }
    };
  }

  function baselineProfilesFromSnapshot(snapshot) {
    const state = snapshot?.state && typeof snapshot.state === "object" ? snapshot.state : {};
    const patients = safeArray(state.patients);
    const profiles = new Map();

    safeArray(state.staff_profiles).forEach((profile) => {
      const role = String(profile?.role || "").toUpperCase() === "PCA" ? "PCA" : "RN";
      if (isHoldOwner({ name: profile?.name || profile?.staff_name, id: profile?.local_owner_id })) return;
      profiles.set(staffProfileKey(role, profile), recalcProfileWorkload(createProfile(role, profile), patients));
    });

    if (profiles.size) return profiles;

    const currentAssignment = state.current_assignment && typeof state.current_assignment === "object" ? state.current_assignment : {};
    safeArray(currentAssignment.nurses).forEach((owner) => {
      if (isHoldOwner(owner)) return;
      const patientIds = safeArray(owner?.patients).map(Number).filter(Number.isFinite);
      profiles.set(staffProfileKey("RN", owner), recalcProfileWorkload(createProfile("RN", {
        id: owner?.id,
        staff_id: owner?.staff_id,
        name: owner?.name,
        patients_assigned: patientIds.length,
        details: { patient_ids: patientIds }
      }), patients));
    });
    safeArray(currentAssignment.pcas).forEach((owner) => {
      if (isHoldOwner(owner)) return;
      const patientIds = safeArray(owner?.patients).map(Number).filter(Number.isFinite);
      profiles.set(staffProfileKey("PCA", owner), recalcProfileWorkload(createProfile("PCA", {
        id: owner?.id,
        staff_id: owner?.staff_id,
        name: owner?.name,
        patients_assigned: patientIds.length,
        details: { patient_ids: patientIds }
      }), patients));
    });

    return profiles;
  }

  function starterProfilesFromSnapshot(snapshot) {
    const state = snapshot?.state && typeof snapshot.state === "object" ? snapshot.state : {};
    const oncoming = state.oncoming_assignment && typeof state.oncoming_assignment === "object" ? state.oncoming_assignment : {};
    const patients = safeArray(state.patients);
    const patientById = new Map(patients.map((p) => [Number(p?.id), p]));
    const sourceShiftType = normalizeShiftType(snapshot?.shift_type);
    const next = getNextShiftIdentity(snapshot?.shift_date, sourceShiftType);
    if (!next.shift_date || !next.shift_type) return null;

    const makeProfiles = (role, owners) => safeArray(owners)
      .filter((owner) => owner && !isHoldOwner(owner) && String(owner.name || "").trim())
      .map((owner) => {
        const patientIds = safeArray(owner.patients).map(Number).filter(Number.isFinite);
        const assignedPatients = patientIds.map((pid) => patientById.get(Number(pid))).filter((p) => p && !p.isEmpty);
        const patientRooms = assignedPatients.map((p) => String(p.room || p.id || "")).filter(Boolean);
        return {
          role,
          name: String(owner.name || "").trim(),
          staff_id: stableStaffId(owner),
          local_owner_id: owner?.id ?? null,
          patients_assigned: assignedPatients.length,
          workload_score: workloadScoreForStarter(role, assignedPatients),
          details: {
            patient_ids: patientIds,
            patient_rooms: patientRooms,
            expected_discharges: assignedPatients.filter((p) => !!p.expectedDischarge).length,
            admits: 0,
            discharges: 0,
            acuity_changes: 0,
            assignment_changes: 0,
            event_count: 0,
            starter_only: true,
            projected_full_shift: true,
            starter_source: "backfill_oncoming_assignment",
            source_shift_date: snapshot?.shift_date || "",
            source_shift_type: sourceShiftType,
            shift_snapshot_id: snapshot?.id || null,
            live_shift_key: String(state.live_shift_key || ""),
            local_owner_id: owner?.id ?? null
          }
        };
      });

    const profiles = makeProfiles("RN", oncoming.nurses).concat(makeProfiles("PCA", oncoming.pcas));
    if (!profiles.length) return null;

    return {
      shift_date: next.shift_date,
      shift_type: next.shift_type,
      patients,
      tag_counts: tagCountsFromPatients(patients),
      profiles,
      metrics: {
        version: 4,
        backfilled: true,
        starter_only: true,
        projected_full_shift: true,
        starter_source: "backfill_oncoming_assignment",
        source_shift_date: snapshot?.shift_date || "",
        source_shift_type: sourceShiftType,
        shift_snapshot_id: snapshot?.id || null
      }
    };
  }

  function touchProfile(map, role, ref, mutate) {
    if (!ref) return;
    const key = staffProfileKey(role, ref);
    if (!map.has(key)) map.set(key, createProfile(role, ref));
    const profile = map.get(key);
    mutate(profile);
    profile.details.event_count = Number(profile.details.event_count || 0) + 1;
  }

  function mergeEventMetricsIntoProfiles(profiles, events) {
    safeArray(events).forEach((ev) => {
      const type = eventType(ev);
      const payload = eventPayload(ev);

      if (type === "ADMIT_PLACED") {
        touchProfile(profiles, "RN", { staff_id: payload.rn_staff_id, id: payload.rn_id, name: payload.rn_name }, (p) => { p.details.admits += 1; });
        touchProfile(profiles, "PCA", { staff_id: payload.pca_staff_id, id: payload.pca_id, name: payload.pca_name }, (p) => { p.details.admits += 1; });
        return;
      }

      if (type === "PATIENT_DISCHARGED") {
        touchProfile(profiles, "RN", {
          staff_id: payload.rnStaffId ?? payload.rn_staff_id,
          id: payload.nurse?.id ?? payload.rnId ?? payload.nurseId,
          name: payload.nurse?.name ?? payload.rnName ?? payload.nurseName
        }, (p) => { p.details.discharges += 1; });
        touchProfile(profiles, "PCA", {
          staff_id: payload.pcaStaffId ?? payload.pca_staff_id,
          id: payload.pca?.id ?? payload.pcaId,
          name: payload.pca?.name ?? payload.pcaName
        }, (p) => { p.details.discharges += 1; });
        return;
      }

      if (type === "ASSIGNMENT_MOVED") {
        const roleHint = String(payload.roleLabel || payload.role || "").toUpperCase();
        if (roleHint.includes("RN") || roleHint.includes("NURSE")) {
          touchProfile(profiles, "RN", { staff_id: payload.fromStaffId ?? payload.from_staff_id, id: payload.fromOwner?.id, name: payload.fromOwner?.name }, (p) => { p.details.assignment_changes += 1; });
          touchProfile(profiles, "RN", { staff_id: payload.toStaffId ?? payload.to_staff_id, id: payload.toOwner?.id, name: payload.toOwner?.name }, (p) => { p.details.assignment_changes += 1; });
        } else if (roleHint.includes("PCA")) {
          touchProfile(profiles, "PCA", { staff_id: payload.fromStaffId ?? payload.from_staff_id, id: payload.fromOwner?.id, name: payload.fromOwner?.name }, (p) => { p.details.assignment_changes += 1; });
          touchProfile(profiles, "PCA", { staff_id: payload.toStaffId ?? payload.to_staff_id, id: payload.toOwner?.id, name: payload.toOwner?.name }, (p) => { p.details.assignment_changes += 1; });
        }
        return;
      }

      if (type === "ACUITY_CHANGED") {
        const attribution = payload.attribution && typeof payload.attribution === "object" ? payload.attribution : {};
        const affects = attribution.affects || {};
        if (affects.affectsRn || payload.rnStaffId || payload.rn_staff_id || payload.rnId || payload.rn_id) {
          touchProfile(profiles, "RN", attribution.rn || {
            staff_id: payload.rnStaffId ?? payload.rn_staff_id,
            id: payload.rnId ?? payload.rn_id,
            name: payload.rnName ?? payload.rn_name
          }, (p) => { p.details.acuity_changes += 1; });
        }
        if (affects.affectsPca || payload.pcaStaffId || payload.pca_staff_id || payload.pcaId || payload.pca_id) {
          touchProfile(profiles, "PCA", attribution.pca || {
            staff_id: payload.pcaStaffId ?? payload.pca_staff_id,
            id: payload.pcaId ?? payload.pca_id,
            name: payload.pcaName ?? payload.pca_name
          }, (p) => { p.details.acuity_changes += 1; });
        }
      }
    });

    return profiles;
  }

  function analyticsPayloadFromSnapshot(snapshot, events) {
    const state = snapshot?.state && typeof snapshot.state === "object" ? snapshot.state : {};
    const patients = safeArray(state.patients);
    const totals = state.total_pts != null
      ? Number(state.total_pts)
      : patients.filter((p) => p && !p.isEmpty).length;
    const tag_counts = state.tag_counts && typeof state.tag_counts === "object"
      ? state.tag_counts
      : tagCountsFromPatients(patients);

    let admits = 0;
    let discharges = 0;
    let acuity_changes = 0;
    let assignment_changes = 0;

    safeArray(events).forEach((ev) => {
      const type = eventType(ev);
      if (type === "ADMIT_PLACED") admits += 1;
      else if (type === "PATIENT_DISCHARGED") discharges += 1;
      else if (type === "ACUITY_CHANGED") acuity_changes += 1;
      else if (type === "ASSIGNMENT_MOVED") assignment_changes += 1;
    });

    admits = admits || Number(state.admits) || 0;
    discharges = discharges || Number(state.discharges) || 0;

    return {
      unit_id: snapshot.unit_id,
      shift_date: snapshot.shift_date,
      shift_type: normalizeShiftType(snapshot.shift_type),
      total_pts: totals,
      admits,
      discharges,
      tag_counts,
      metrics: {
        version: 3,
        backfilled: true,
        live_shift_key: String(state.live_shift_key || ""),
        totals: {
          total_pts: totals,
          admits,
          discharges,
          acuity_changes,
          assignment_changes,
          event_count: safeArray(events).length
        },
        tag_counts
      }
    };
  }

  function isSchemaColumnError(error) {
    const msg = String(error?.message || error || "").toLowerCase();
    return msg.includes("column") && msg.includes("schema cache");
  }

  function isRlsError(error) {
    const msg = String(error?.message || error || "").toLowerCase();
    return msg.includes("row-level security") || msg.includes("rls");
  }

  async function backfillUnitShiftMetrics(unitId, options = {}) {
    const uid = String(unitId || activeUnitId() || "").trim();
    if (!uid) throw new Error("Missing unit_id");
    if (!sbReady()) throw new Error("Supabase not ready");
    if (!canWrite()) throw new Error("Your role cannot backfill metrics");

    const limitSnapshots = Number(options.limitSnapshots) || 5000;
    const limitEvents = Number(options.limitEvents) || 30000;
    const fromDate = String(options.fromDate || "").trim();
    const toDate = String(options.toDate || "").trim();
    const createdBy = await getUserIdSafe();

    let snapshotQuery = window.sb.client
      .from("shift_snapshots")
      .select("*")
      .eq("unit_id", uid)
      .order("shift_date", { ascending: true })
      .limit(limitSnapshots);

    let eventQuery = window.sb.client
      .from("audit_events")
      .select("id,unit_id,shift_key,created_at,ts,event_type,payload")
      .eq("unit_id", uid)
      .order("created_at", { ascending: true })
      .limit(limitEvents);

    if (fromDate) {
      snapshotQuery = snapshotQuery.gte("shift_date", fromDate);
      eventQuery = eventQuery.gte("created_at", `${fromDate}T00:00:00`);
    }
    if (toDate) {
      snapshotQuery = snapshotQuery.lte("shift_date", toDate);
      eventQuery = eventQuery.lte("created_at", `${addDaysYmd(toDate, 1) || toDate}T07:00:00`);
    }

    const [snapRes, eventRes] = await Promise.all([snapshotQuery, eventQuery]);
    if (snapRes.error) throw snapRes.error;
    if (eventRes.error) throw eventRes.error;

    const snapshots = safeArray(snapRes.data)
      .filter((row) => row && row.shift_date && row.shift_type)
      .sort((a, b) => String(a.shift_date || "").localeCompare(String(b.shift_date || "")) || (shiftRank(a.shift_type) - shiftRank(b.shift_type)));
    const events = safeArray(eventRes.data);

    let analyticsUpserts = 0;
    let staffUpserts = 0;
    let starterAnalyticsUpserts = 0;
    let starterStaffUpserts = 0;
    const warnings = [];

    for (const snapshot of snapshots) {
      const shiftEvents = filterEventsForShift(events, snapshot);
      const analyticsPayload = analyticsPayloadFromSnapshot(snapshot, shiftEvents);
      if (createdBy) analyticsPayload.created_by = createdBy;
      const analyticsRes = await window.sb.upsertAnalyticsShiftMetrics(analyticsPayload);
      if (analyticsRes?.error) {
        if (isSchemaColumnError(analyticsRes.error) || isRlsError(analyticsRes.error)) {
          warnings.push(`Analytics skipped for ${snapshot.shift_date} ${snapshot.shift_type}: ${String(analyticsRes.error?.message || analyticsRes.error)}`);
        } else {
          throw analyticsRes.error;
        }
      } else {
        analyticsUpserts += 1;
      }

      const profiles = mergeEventMetricsIntoProfiles(baselineProfilesFromSnapshot(snapshot), shiftEvents);
      const snapshotPatients = safeArray(snapshot?.state?.patients);
      const rows = [];

      for (const profile of Array.from(profiles.values())) {
        const role = profile.role === "PCA" ? "PCA" : "RN";
        const displayName = String(profile.name || "").trim();
        if (!displayName) continue;
        if (isHoldOwner({ name: displayName, id: profile.local_owner_id })) continue;
        const ensured = await window.sb.ensureUnitStaff(uid, role, displayName);
        if (!ensured?.row?.id) continue;
        const currentProfile = recalcProfileWorkload(profile, snapshotPatients);

        rows.push({
          unit_id: uid,
          shift_date: snapshot.shift_date,
          shift_type: normalizeShiftType(snapshot.shift_type),
          staff_id: ensured.row.id,
          staff_name: displayName,
          role,
          patients_assigned: Number(currentProfile.patients_assigned) || safeArray(currentProfile.details.patient_ids).length,
          workload_score: workloadScoreForStarter(role, safeArray(currentProfile.details.patient_ids).map((pid) => {
            const patientById = new Map(snapshotPatients.map((p) => [Number(p?.id), p]));
            return patientById.get(Number(pid));
          }).filter((p) => p && !p.isEmpty)) || Number(currentProfile.workload_score) || 0,
          details: {
            ...currentProfile.details,
            backfilled: true,
            backfill_source: "shift_snapshots+audit_events",
            shift_snapshot_id: snapshot.id || null,
            live_shift_key: String(snapshot?.state?.live_shift_key || "")
          },
          created_by: createdBy || undefined
        });
      }

      if (rows.length) {
        const staffRes = await window.sb.upsertStaffShiftMetrics(rows);
        if (staffRes?.error) throw staffRes.error;
        staffUpserts += rows.length;
      }

      const starter = starterProfilesFromSnapshot(snapshot);
      if (starter) {
        const totalPts = safeArray(starter.patients).filter((p) => p && !p.isEmpty).length;
        const starterAnalyticsPayload = {
          unit_id: uid,
          shift_date: starter.shift_date,
          shift_type: starter.shift_type,
          total_pts: totalPts,
          admits: 0,
          discharges: 0,
          tag_counts: starter.tag_counts,
          metrics: {
            ...starter.metrics,
            totals: {
              total_pts: totalPts,
              admits: 0,
              discharges: 0,
              acuity_changes: 0,
              assignment_changes: 0,
              event_count: 0
            },
            tag_counts: starter.tag_counts,
            staff_counts: {
              rn: starter.profiles.filter((profile) => profile.role === "RN").length,
              pca: starter.profiles.filter((profile) => profile.role === "PCA").length
            }
          },
          created_by: createdBy || undefined
        };
        const starterAnalyticsRes = await window.sb.upsertAnalyticsShiftMetrics(starterAnalyticsPayload);
        if (starterAnalyticsRes?.error) {
          if (isSchemaColumnError(starterAnalyticsRes.error) || isRlsError(starterAnalyticsRes.error)) {
            warnings.push(`Starter analytics skipped for ${starter.shift_date} ${starter.shift_type}: ${String(starterAnalyticsRes.error?.message || starterAnalyticsRes.error)}`);
          } else {
            throw starterAnalyticsRes.error;
          }
        } else {
          starterAnalyticsUpserts += 1;
        }

        const starterRows = [];
        for (const profile of starter.profiles) {
          const displayName = String(profile.name || "").trim();
          if (!displayName) continue;
          const ensured = await window.sb.ensureUnitStaff(uid, profile.role, displayName);
          if (!ensured?.row?.id) continue;
          const starterPatientById = new Map(safeArray(starter.patients).map((p) => [Number(p?.id), p]));
          const starterAssigned = safeArray(profile.details?.patient_ids).map((pid) => starterPatientById.get(Number(pid))).filter((p) => p && !p.isEmpty);
          starterRows.push({
            unit_id: uid,
            shift_date: starter.shift_date,
            shift_type: starter.shift_type,
            staff_id: ensured.row.id,
            staff_name: displayName,
            role: profile.role,
            patients_assigned: starterAssigned.length || Number(profile.patients_assigned) || 0,
            workload_score: workloadScoreForStarter(profile.role, starterAssigned) || Number(profile.workload_score) || 0,
            details: {
              ...profile.details,
              analytics_scoring_version: "2026-07-01-current",
              recalculated_from_snapshot: !!starterAssigned.length
            },
            created_by: createdBy || undefined
          });
        }
        if (starterRows.length) {
          const starterStaffRes = await window.sb.upsertStaffShiftMetrics(starterRows);
          if (starterStaffRes?.error) throw starterStaffRes.error;
          starterStaffUpserts += starterRows.length;
        }
      }
    }

    return {
      ok: true,
      unit_id: uid,
      shifts_processed: snapshots.length,
      analytics_upserts: analyticsUpserts,
      staff_upserts: staffUpserts,
      starter_analytics_upserts: starterAnalyticsUpserts,
      starter_staff_upserts: starterStaffUpserts,
      warnings
    };
  }

  window.shiftBackfill = window.shiftBackfill || {};
  window.shiftBackfill.backfillUnitShiftMetrics = backfillUnitShiftMetrics;
})();
