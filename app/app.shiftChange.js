// app/app.shiftChange.js
// ---------------------------------------------------------
// FINALIZE / SHIFT CHANGE (Dec 2025)
// - Publish a shift snapshot to Supabase (shift_snapshots)
// - Optionally publish analytics metrics (analytics_shift_metrics)
// - ✅ Publish per-staff metrics (staff_shift_metrics) via UPSERT (anti-duplicate)
// - Then promote Oncoming -> Current (your existing workflow)
// - Guards: role-based, active unit required, SB ready
//
// Notes:
// - Expects button: #btnFinalizeShift
// - Expects inputs: #finalizeShiftDate, #finalizeShiftType
// - Uses window.sb.insertShiftSnapshot / insertAnalyticsShiftMetrics / upsertStaffShiftMetrics if present
// - Uses existing window.finalizeShiftChange() if present (your promote/swap logic)
// ---------------------------------------------------------

(function () {
  const $ = (id) => document.getElementById(id);

  function sbReady() {
    return !!(window.sb && window.sb.client);
  }

  function activeUnitId() {
    return window.activeUnitId ? String(window.activeUnitId) : "";
  }

  function activeRole() {
    return String(window.activeUnitRole || "").toLowerCase();
  }

  function canWriteRole(role) {
    const r = String(role || "").toLowerCase();
    return r === "owner" || r === "admin" || r === "charge";
  }

  function setMsg(msg, isError = false) {
    const node = $("finalizeStatusMsg");
    if (!node) return;
    node.textContent = msg || "";
    node.style.color = isError ? "#b91c1c" : "#0f172a";
    node.style.opacity = "0.85";
  }

  function clampDateStr(s) {
    if (!s || typeof s !== "string") return "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
    return s;
  }

  function getFinalizeDate() {
    const el = $("finalizeShiftDate");
    const v = el ? clampDateStr(el.value) : "";
    if (v) return v;
    return new Date().toISOString().slice(0, 10);
  }

  function getFinalizeShiftType() {
    const el = $("finalizeShiftType");
    const v = el ? String(el.value || "") : "";
    return (v === "day" || v === "night") ? v : "day";
  }

  function computeTopTagsFromPatients(patients) {
    const counts = {};
    const add = (k) => { if (!k) return; counts[k] = (counts[k] || 0) + 1; };

    (Array.isArray(patients) ? patients : []).forEach(p => {
      const obj = p?.acuityTags || p?.tagsObj || null;
      const arr = p?.tags || p?.acuity || null;

      if (obj && typeof obj === "object") {
        Object.keys(obj).forEach(k => { if (obj[k]) add(k); });
      } else if (Array.isArray(arr)) {
        arr.forEach(k => add(String(k)));
      } else {
        ["tele","drip","nih","bg","ciwa","restraint","sitter","vpo","isolation","iso","admit","lateDc","chg","foley","q2","q2turns","heavy","feeder"]
          .forEach(k => { if (p && p[k]) add(k); });
      }
    });

    return Object.entries(counts)
      .sort((a,b) => b[1]-a[1])
      .slice(0, 12)
      .map(([k,v]) => `${k}:${v}`)
      .join(", ");
  }

  function computeTotalPatients(patients) {
    const list = Array.isArray(patients) ? patients : [];
    const nonEmpty = list.filter(p => !p?.isEmpty);
    return nonEmpty.length;
  }

  function computeAdmitDischargeCountsFromState() {
    const admits = Array.isArray(window.admitQueue) ? window.admitQueue.length : 0;
    const discharges = Array.isArray(window.dischargeHistory) ? window.dischargeHistory.length : 0;
    return { admits, discharges };
  }

  async function getUserIdSafe() {
    try {
      const { data } = await window.sb.client.auth.getSession();
      return data?.session?.user?.id || null;
    } catch {
      return null;
    }
  }

  // ------------------------
  // ✅ Build per-staff metrics rows (RN + PCA) for staff_shift_metrics
  // Requires:
  // - unit_staff exists (ensureUnitStaff returns id)
  // - staff_shift_metrics has columns:
  //   unit_id, shift_date, shift_type, role, staff_id, display_name, created_by, metrics(jsonb)
  // ------------------------
  async function buildStaffMetricsRows(unitId, shift_date, shift_type, created_by) {
    const rows = [];

    const canScoreRn = typeof window.getNurseLoadScore === "function";
    const canScorePca = typeof window.getPcaLoadScore === "function";

    // RN rows (ONCOMING board = incomingNurses)
    (Array.isArray(window.incomingNurses) ? window.incomingNurses : []).forEach(n => {
      const name = String(n?.name || "").trim();
      if (!name) return;

      const patientIds = Array.isArray(n.patients) ? n.patients.slice() : [];
      const patient_count = patientIds.length;

      const load_score = canScoreRn ? (window.getNurseLoadScore(n) || 0) : 0;

      const drivers = (typeof window.getRnDriversSummaryFromPatientIds === "function")
        ? window.getRnDriversSummaryFromPatientIds(patientIds)
        : "";

      rows.push({
        unit_id: unitId,
        shift_date,
        shift_type,
        role: "RN",
        staff_id: null,            // filled below
        display_name: name,
        created_by,
        metrics: {
          patient_count,
          load_score,
          drivers,
          patient_ids: patientIds
        }
      });
    });

    // PCA rows (ONCOMING board = incomingPcas)
    (Array.isArray(window.incomingPcas) ? window.incomingPcas : []).forEach(p => {
      const name = String(p?.name || "").trim();
      if (!name) return;

      const patientIds = Array.isArray(p.patients) ? p.patients.slice() : [];
      const patient_count = patientIds.length;

      const load_score = canScorePca ? (window.getPcaLoadScore(p) || 0) : 0;

      const drivers = (typeof window.getPcaDriversSummaryFromPatientIds === "function")
        ? window.getPcaDriversSummaryFromPatientIds(patientIds)
        : "";

      rows.push({
        unit_id: unitId,
        shift_date,
        shift_type,
        role: "PCA",
        staff_id: null,            // filled below
        display_name: name,
        created_by,
        metrics: {
          patient_count,
          load_score,
          drivers,
          patient_ids: patientIds
        }
      });
    });

    // Resolve staff_id via unit_staff de-dupe
    if (window.sb && typeof window.sb.ensureUnitStaff === "function") {
      for (const r of rows) {
        const ensured = await window.sb.ensureUnitStaff(unitId, r.role, r.display_name);
        if (ensured?.row?.id) r.staff_id = ensured.row.id;
      }
    }

    // Only keep rows that have staff_id
    return rows.filter(r => !!r.staff_id);
  }

  async function publishShiftSnapshot() {
    const unitId = activeUnitId();
    const role = activeRole();

    if (!unitId) {
      setMsg("No active unit selected.", true);
      return { ok: false, reason: "no_unit" };
    }
    if (!canWriteRole(role)) {
      setMsg("Finalize requires owner/admin/charge on the active unit.", true);
      return { ok: false, reason: "no_role" };
    }
    if (!sbReady()) {
      setMsg("Supabase not ready (offline/demo mode).", true);
      return { ok: false, reason: "no_sb" };
    }
    if (typeof window.sb.insertShiftSnapshot !== "function") {
      setMsg("Missing sb.insertShiftSnapshot(). Check app/app.supabase.js.", true);
      return { ok: false, reason: "missing_helper" };
    }

    const shift_date = getFinalizeDate();
    const shift_type = getFinalizeShiftType();
    const total_pts = computeTotalPatients(window.patients);
    const { admits, discharges } = computeAdmitDischargeCountsFromState();
    const top_tags = computeTopTagsFromPatients(window.patients);
    const created_by = await getUserIdSafe();

    const currentChargeName = ($("currentChargeName")?.value || "").trim();

    // ✅ Snapshot schema: JSONB state
    const snapshotState = {
      unit_id: unitId,
      shift_date,
      shift_type,
      total_pts,
      admits,
      discharges,
      top_tags,
      charge_name: currentChargeName || null
    };

    const payload = {
      unit_id: unitId,
      shift_date,
      shift_type,
      status: "published",
      state: snapshotState,
      created_by
    };

    setMsg("Publishing shift snapshot…");

    const { row, error } = await window.sb.insertShiftSnapshot(payload);
    if (error) {
      setMsg(`Publish failed: ${error.message || String(error)}`, true);
      return { ok: false, error };
    }

    // Optional analytics write
    if (typeof window.sb.insertAnalyticsShiftMetrics === "function") {
      try {
        const metricsPayload = {
          unit_id: unitId,
          shift_date,
          shift_type,
          created_by,
          metrics: {
            version: 1,
            total_pts,
            admits,
            discharges,
            top_tags
          }
        };
        await window.sb.insertAnalyticsShiftMetrics(metricsPayload);
      } catch (e) {
        console.warn("[finalize] analytics insert failed", e);
      }
    }

    // ✅ NEW: publish per-staff metrics (UPSERT to avoid duplicates)
    if (window.sb && typeof window.sb.upsertStaffShiftMetrics === "function") {
      try {
        const staffRows = await buildStaffMetricsRows(unitId, shift_date, shift_type, created_by);
        if (staffRows.length) {
          const res = await window.sb.upsertStaffShiftMetrics(staffRows);
          if (res?.error) console.warn("[finalize] staff_shift_metrics upsert error", res.error);
        }
      } catch (e) {
        console.warn("[finalize] staff_shift_metrics upsert failed", e);
      }
    } else {
      console.warn("[finalize] sb.upsertStaffShiftMetrics missing (skipping staff metrics publish)");
    }

    setMsg("Snapshot published. Finalizing shift change…");
    return { ok: true, row };
  }

  async function handleFinalizeClick() {
    try {
      const btn = $("btnFinalizeShift");
      if (btn) btn.disabled = true;

      const pub = await publishShiftSnapshot();
      if (!pub.ok) {
        if (btn) btn.disabled = false;
        return;
      }

      if (typeof window.finalizeShiftChange === "function") {
        window.finalizeShiftChange();
      } else {
        console.warn("[finalize] window.finalizeShiftChange missing. No local swap performed.");
      }

      try { if (typeof window.saveState === "function") window.saveState(); } catch {}

      setMsg("Finalize complete ✅ (published + promoted oncoming → current).");

      try { if (window.unitPulse && typeof window.unitPulse.load === "function") window.unitPulse.load(); } catch {}

    } catch (e) {
      console.warn("[finalize] unexpected error", e);
      setMsg(`Finalize error: ${String(e)}`, true);
      const btn = $("btnFinalizeShift");
      if (btn) btn.disabled = false;
    }
  }

  function wireFinalizeButton() {
    const btn = $("btnFinalizeShift");
    if (!btn || btn.__wiredFinalize) return;

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      handleFinalizeClick();
    });

    btn.__wiredFinalize = true;
  }

  function updateFinalizeButtonState() {
    const btn = $("btnFinalizeShift");
    if (!btn) return;

    const unitId = activeUnitId();
    const role = activeRole();

    const ok = !!unitId && canWriteRole(role) && sbReady();
    btn.disabled = !ok;

    btn.style.opacity = ok ? "1" : "0.55";
    btn.title = ok
      ? "Publishes Oncoming snapshot + analytics + staff metrics, then swaps Live ← Oncoming"
      : "Requires owner/admin/charge on the active unit (and Supabase ready).";
  }

  window.shiftFinalize = window.shiftFinalize || {};
  window.shiftFinalize.refresh = updateFinalizeButtonState;

  window.addEventListener("DOMContentLoaded", () => {
    wireFinalizeButton();

    const dateEl = $("finalizeShiftDate");
    if (dateEl && !clampDateStr(dateEl.value)) {
      dateEl.value = new Date().toISOString().slice(0, 10);
    }
    const typeEl = $("finalizeShiftType");
    if (typeEl && !typeEl.value) typeEl.value = "day";

    updateFinalizeButtonState();
    setInterval(updateFinalizeButtonState, 1500);
  });
})();