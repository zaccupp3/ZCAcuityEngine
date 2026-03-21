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
  const ANALYTICS_TAG_KEYS = ["tele", "drip", "nih", "bg", "ciwa", "restraint", "sitter", "vpo", "isolation", "admit", "lateDc"];

  function sbReady() {
    return !!(window.sb && window.sb.client && window.sb.__ready);
  }

  function activeUnitId() {
    return window.activeUnitId ? String(window.activeUnitId) : "";
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

  function makeShiftWindow(shiftDate, shiftType) {
    const day = String(shiftDate || "").trim();
    const type = String(shiftType || "day").toLowerCase();
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
    const profiles = new Map();

    safeArray(state.staff_profiles).forEach((profile) => {
      const role = String(profile?.role || "").toUpperCase() === "PCA" ? "PCA" : "RN";
      profiles.set(staffProfileKey(role, profile), createProfile(role, profile));
    });

    if (profiles.size) return profiles;

    const currentAssignment = state.current_assignment && typeof state.current_assignment === "object" ? state.current_assignment : {};
    safeArray(currentAssignment.nurses).forEach((owner) => {
      const patientIds = safeArray(owner?.patients).map(Number).filter(Number.isFinite);
      profiles.set(staffProfileKey("RN", owner), createProfile("RN", {
        id: owner?.id,
        staff_id: owner?.staff_id,
        name: owner?.name,
        patients_assigned: patientIds.length,
        details: { patient_ids: patientIds }
      }));
    });
    safeArray(currentAssignment.pcas).forEach((owner) => {
      const patientIds = safeArray(owner?.patients).map(Number).filter(Number.isFinite);
      profiles.set(staffProfileKey("PCA", owner), createProfile("PCA", {
        id: owner?.id,
        staff_id: owner?.staff_id,
        name: owner?.name,
        patients_assigned: patientIds.length,
        details: { patient_ids: patientIds }
      }));
    });

    return profiles;
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
      shift_type: snapshot.shift_type,
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

  async function backfillUnitShiftMetrics(unitId, options = {}) {
    const uid = String(unitId || activeUnitId() || "").trim();
    if (!uid) throw new Error("Missing unit_id");
    if (!sbReady()) throw new Error("Supabase not ready");
    if (!canWrite()) throw new Error("Your role cannot backfill metrics");

    const limitSnapshots = Number(options.limitSnapshots) || 5000;
    const limitEvents = Number(options.limitEvents) || 30000;
    const fromDate = String(options.fromDate || "").trim();
    const toDate = String(options.toDate || "").trim();

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
      eventQuery = eventQuery.lte("created_at", `${toDate}T23:59:59`);
    }

    const [snapRes, eventRes] = await Promise.all([snapshotQuery, eventQuery]);
    if (snapRes.error) throw snapRes.error;
    if (eventRes.error) throw eventRes.error;

    const snapshots = safeArray(snapRes.data).filter((row) => row && row.shift_date && row.shift_type);
    const events = safeArray(eventRes.data);

    let analyticsUpserts = 0;
    let staffUpserts = 0;
    const warnings = [];

    for (const snapshot of snapshots) {
      const shiftEvents = filterEventsForShift(events, snapshot);
      const analyticsPayload = analyticsPayloadFromSnapshot(snapshot, shiftEvents);
      const analyticsRes = await window.sb.upsertAnalyticsShiftMetrics(analyticsPayload);
      if (analyticsRes?.error) {
        if (isSchemaColumnError(analyticsRes.error)) {
          warnings.push(`Analytics skipped for ${snapshot.shift_date} ${snapshot.shift_type}: ${String(analyticsRes.error?.message || analyticsRes.error)}`);
        } else {
          throw analyticsRes.error;
        }
      } else {
        analyticsUpserts += 1;
      }

      const profiles = mergeEventMetricsIntoProfiles(baselineProfilesFromSnapshot(snapshot), shiftEvents);
      const rows = [];

      for (const profile of Array.from(profiles.values())) {
        const role = profile.role === "PCA" ? "PCA" : "RN";
        const displayName = String(profile.name || "").trim();
        if (!displayName) continue;
        const ensured = await window.sb.ensureUnitStaff(uid, role, displayName);
        if (!ensured?.row?.id) continue;

        rows.push({
          unit_id: uid,
          shift_date: snapshot.shift_date,
          shift_type: snapshot.shift_type,
          staff_id: ensured.row.id,
          staff_name: displayName,
          role,
          patients_assigned: Number(profile.patients_assigned) || safeArray(profile.details.patient_ids).length,
          workload_score: Number(profile.workload_score) || 0,
          details: {
            ...profile.details,
            backfilled: true,
            backfill_source: "shift_snapshots+audit_events",
            shift_snapshot_id: snapshot.id || null,
            live_shift_key: String(snapshot?.state?.live_shift_key || "")
          }
        });
      }

      if (rows.length) {
        const staffRes = await window.sb.upsertStaffShiftMetrics(rows);
        if (staffRes?.error) throw staffRes.error;
        staffUpserts += rows.length;
      }
    }

    return {
      ok: true,
      unit_id: uid,
      shifts_processed: snapshots.length,
      analytics_upserts: analyticsUpserts,
      staff_upserts: staffUpserts,
      warnings
    };
  }

  window.shiftBackfill = window.shiftBackfill || {};
  window.shiftBackfill.backfillUnitShiftMetrics = backfillUnitShiftMetrics;
})();
