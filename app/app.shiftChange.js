// app/app.shiftChange.js
// ---------------------------------------------------------
// Shift Finalize / Publish (FOUNDATION-LOCKED)
//
// Writes (via window.sb helpers):
// - shift_snapshots (UPSERT/INSERT-ONLY depending on wrapper) ✅ full patient state
// - staff_shift_metrics (UPSERT/INSERT-ONLY batch)
// - analytics_shift_metrics (UPSERT/INSERT-ONLY)
//
// GUARANTEES:
// - Snapshots persist complete patient truth
// - Analytics are patient-deduped, unit-level
// - Future backfills + re-scoring are safe
// ---------------------------------------------------------

(function () {
  const $ = (id) => document.getElementById(id);
  const safeArray = (v) => (Array.isArray(v) ? v : []);

  const VERSION = "shiftChange_v2026-01-13_empties";
  function log(...args) { console.log("[shiftChange]", ...args); }

  function getActiveUnitId() {
    return window.activeUnitId ? String(window.activeUnitId) : "";
  }

  function canWrite() {
    const r = String(window.activeUnitRole || "").toLowerCase();
    return r === "owner" || r === "admin" || r === "charge";
  }

  function sbReady() {
    return !!(window.sb && window.sb.client && window.sb.__ready);
  }

  function clampDateStr(s) {
    if (!s || typeof s !== "string") return "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
    return s;
  }

  function getShiftDate() {
    const el = $("finalizeShiftDate");
    return clampDateStr(el?.value) || new Date().toISOString().slice(0, 10);
  }

  function getShiftType() {
    const el = $("finalizeShiftType");
    const v = String(el?.value || "");
    return v === "day" || v === "night" ? v : "day";
  }

  function setMsg(msg, isError = false) {
    const el = $("finalizeStatusMsg");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isError ? "#b91c1c" : "#0f172a";
  }

  async function getUserIdSafe() {
    try {
      const { data } = await window.sb.client.auth.getSession();
      return data?.session?.user?.id || null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------
  // EMPTY BED INFERENCE (SAFE, FINALIZE-ONLY)
  // ---------------------------------------------------------
  function inferEmptyBedsFromAssignments() {
    const patients = safeArray(window.patients);
    if (!patients.length) return;

    // Collect all patient IDs referenced by RN assignments
    const referenced = new Set();
    safeArray(window.incomingNurses).forEach(rn => {
      safeArray(rn?.patients).forEach(pid => referenced.add(Number(pid)));
    });

    let inferred = 0;

    patients.forEach(p => {
      if (!p || p.isEmpty) return;

      const pid = Number(p.id);
      if (!pid) return;

      // If NOT referenced by any RN, infer EMPTY
      if (!referenced.has(pid)) {
        p.isEmpty = true;
        p.recentlyDischarged = false;
        inferred++;
      }
    });

    if (inferred) {
      log(`Inferred ${inferred} empty beds at finalize`);
    }
  }

  // ---------------------------------------------------------
  // Patients
  // ---------------------------------------------------------
  function activePatients() {
    return safeArray(window.patients).filter(p => p && !p.isEmpty);
  }

  // ---------------------------------------------------------
  // FINALIZE (publishAll)
  // ---------------------------------------------------------
  async function publishAll() {
    const unit_id = getActiveUnitId();

    if (!canWrite()) {
      setMsg("Cannot finalize: your role does not allow publishing.", true);
      return { ok: false };
    }
    if (!unit_id) {
      setMsg("Cannot finalize: activeUnitId is missing.", true);
      return { ok: false };
    }
    if (!sbReady()) {
      setMsg("Cannot finalize: Supabase client not ready (sbReady=false).", true);
      return { ok: false };
    }

    // 🔐 Normalize patient state BEFORE snapshot
    inferEmptyBedsFromAssignments();

    const shift_date = getShiftDate();
    const shift_type = getShiftType();
    const created_by = await getUserIdSafe();

    const pts = activePatients();
    const admits = safeArray(window.admitQueue).length;
    const discharges = safeArray(window.dischargeHistory).length;

    // --- SNAPSHOT
    {
      const res = await window.sb.upsertShiftSnapshot({
        unit_id,
        shift_date,
        shift_type,
        status: "published",
        state: {
          total_pts: pts.length,
          admits,
          discharges,
          patients: JSON.parse(JSON.stringify(window.patients || []))
        },
        created_by
      });

      if (res?.error) {
        setMsg("Finalize failed: shift snapshot error", true);
        return { ok: false, error: res.error };
      }
    }

    // --- ANALYTICS
    {
      const res = await window.sb.upsertAnalyticsShiftMetrics({
        unit_id,
        shift_date,
        shift_type,
        created_by,
        metrics: {
          version: 2,
          totals: { total_pts: pts.length, admits, discharges }
        }
      });

      if (res?.error) {
        setMsg("Finalize failed: analytics error", true);
        return { ok: false, error: res.error };
      }
    }

    // --- STAFF METRICS
    {
      const rows = [];

      for (const rn of safeArray(window.incomingNurses)) {
        const patient_ids = safeArray(rn.patients).map(Number);
        const ensured = await window.sb.ensureUnitStaff(unit_id, "RN", rn.name);
        if (!ensured?.row?.id) continue;

        rows.push({
          unit_id,
          shift_date,
          shift_type,
          staff_id: ensured.row.id,
          staff_name: rn.name,
          role: "RN",
          patients_assigned: patient_ids.length,
          workload_score: window.getNurseLoadScore?.(rn) || 0,
          details: { patient_ids },
          created_by
        });
      }

      const res = await window.sb.upsertStaffShiftMetrics(rows);
      if (res?.error) {
        setMsg("Finalize failed: staff metrics error", true);
        return { ok: false, error: res.error };
      }
    }

    setMsg("Finalize complete ✅");
    return { ok: true };
  }

  async function handleFinalize() {
    const btn = $("btnFinalizeShift");
    try {
      if (btn) btn.disabled = true;
      const res = await publishAll();
      if (res.ok && typeof window.finalizeShiftChange === "function") {
        window.finalizeShiftChange();
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    const btn = $("btnFinalizeShift");
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        handleFinalize();
      });
    }
  });

  window.shiftChange = { publishAll };
  log("loaded", VERSION);
})();