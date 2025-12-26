// app/app.shiftChange.js
// ---------------------------------------------------------
// FINALIZE / SHIFT CHANGE (Dec 2025)
// - Publish a shift snapshot to Supabase (shift_snapshots) ✅ UPSERT
// - Publish analytics metrics (analytics_shift_metrics) ✅ UPSERT
// - Publish staff-level metrics (staff_shift_metrics) ✅ UPSERT batch
// - Then promote Oncoming -> Current (your existing workflow)
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

  function safeArray(v) { return Array.isArray(v) ? v : []; }

  function computeTopTagsFromPatients(patients) {
    const counts = {};
    const add = (k) => { if (!k) return; counts[k] = (counts[k] || 0) + 1; };

    safeArray(patients).forEach(p => {
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
    const list = safeArray(patients);
    return list.filter(p => p && !p.isEmpty).length;
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

  // -------------------------
  // Staff metrics helpers
  // -------------------------
  function countTagsForPatient(p) {
    const out = {};
    const add = (k) => { out[k] = (out[k] || 0) + 1; };

    if (!p || p.isEmpty) return out;

    if (p.tele) add("tele");
    if (p.drip) add("drip");
    if (p.nih) add("nih");
    if (p.bg) add("bg");
    if (p.ciwa) add("ciwa");
    if (p.restraint) add("restraint");
    if (p.sitter) add("sitter");
    if (p.vpo) add("vpo");
    if (p.isolation) add("isolation");
    if (p.admit) add("admit");
    if (p.lateDc) add("lateDc");

    if (p.chg) add("chg");
    if (p.foley) add("foley");
    if (p.q2turns) add("q2turns");
    if (p.heavy) add("heavy");
    if (p.feeder) add("feeder");

    return out;
  }

  function mergeCounts(a, b) {
    const out = { ...(a || {}) };
    Object.keys(b || {}).forEach(k => out[k] = (out[k] || 0) + (b[k] || 0));
    return out;
  }

  function sumPatientsAssigned(owner) {
    return safeArray(owner?.patients).filter(Boolean).length;
  }

  function getPatientObjectsForOwner(owner) {
    const ids = safeArray(owner?.patients);
    const getter = (typeof window.getPatientById === "function")
      ? window.getPatientById
      : (id) => safeArray(window.patients).find(p => Number(p?.id) === Number(id)) || null;

    return ids.map(id => getter(id)).filter(p => p && !p.isEmpty);
  }

  function getHardEvalCountsForOwner(owner, ownersAll, role) {
    // If your hard-rule evaluator exists, use it; otherwise return 0/0.
    try {
      if (typeof window.evaluateAssignmentHardRules !== "function") return { v: 0, w: 0 };
      const map = window.evaluateAssignmentHardRules(ownersAll, role);
      if (!map) return { v: 0, w: 0 };

      const key = owner?.name || owner?.label || null;
      const entry = (key && map[key]) ? map[key] : null;
      const v = Array.isArray(entry?.violations) ? entry.violations.length : 0;
      const w = Array.isArray(entry?.warnings) ? entry.warnings.length : 0;
      return { v, w };
    } catch {
      return { v: 0, w: 0 };
    }
  }

  async function ensureStaffId(unitId, role, staffName) {
    // staff_shift_metrics.staff_id is uuid -> we map via unit_staff.id
    if (!window.sb || typeof window.sb.ensureUnitStaff !== "function") return { id: null, error: new Error("Missing sb.ensureUnitStaff") };
    const r = (String(role || "").toUpperCase() === "PCA") ? "PCA" : "RN";
    const { row, error } = await window.sb.ensureUnitStaff(unitId, r, staffName);
    return { id: row?.id || null, error };
  }

  async function publishStaffShiftMetrics(unitId, shift_date, shift_type, created_by) {
    if (typeof window.sb.upsertStaffShiftMetrics !== "function") {
      console.warn("[finalize] sb.upsertStaffShiftMetrics missing");
      return { ok: true, rows: [] }; // don't block finalize
    }

    const rows = [];

    const rnOwners = Array.isArray(window.incomingNurses) ? window.incomingNurses : [];
    const pcaOwners = Array.isArray(window.incomingPcas) ? window.incomingPcas : [];

    // RN rows
    for (const rn of rnOwners) {
      const staff_name = String(rn?.name || "").trim() || `RN ${rn?.id || ""}`.trim();
      const { id: staff_id } = await ensureStaffId(unitId, "RN", staff_name);

      const pts = getPatientObjectsForOwner(rn);
      const tag_counts = pts.reduce((acc, p) => mergeCounts(acc, countTagsForPatient(p)), {});
      const workload_score = (typeof window.getNurseLoadScore === "function") ? (Number(window.getNurseLoadScore(rn)) || 0) : 0;

      const { v, w } = getHardEvalCountsForOwner(rn, rnOwners, "nurse");

      rows.push({
        unit_id: unitId,
        shift_date,
        shift_type,
        staff_id,
        staff_name,
        role: "RN",
        patients_assigned: pts.length,
        workload_score,
        hard_violations: v,
        hard_warnings: w,
        tag_counts,
        details: {
          patient_ids: safeArray(rn?.patients).slice(),
          drivers: (typeof window.getRnDriversSummaryFromPatientIds === "function")
            ? window.getRnDriversSummaryFromPatientIds(rn?.patients || [])
            : null
        },
        created_by
      });
    }

    // PCA rows
    for (const pc of pcaOwners) {
      const staff_name = String(pc?.name || "").trim() || `PCA ${pc?.id || ""}`.trim();
      const { id: staff_id } = await ensureStaffId(unitId, "PCA", staff_name);

      const pts = getPatientObjectsForOwner(pc);
      const tag_counts = pts.reduce((acc, p) => mergeCounts(acc, countTagsForPatient(p)), {});
      const workload_score = (typeof window.getPcaLoadScore === "function") ? (Number(window.getPcaLoadScore(pc)) || 0) : 0;

      const { v, w } = getHardEvalCountsForOwner(pc, pcaOwners, "pca");

      rows.push({
        unit_id: unitId,
        shift_date,
        shift_type,
        staff_id,
        staff_name,
        role: "PCA",
        patients_assigned: pts.length,
        workload_score,
        hard_violations: v,
        hard_warnings: w,
        tag_counts,
        details: {
          patient_ids: safeArray(pc?.patients).slice(),
          drivers: (typeof window.getPcaDriversSummaryFromPatientIds === "function")
            ? window.getPcaDriversSummaryFromPatientIds(pc?.patients || [])
            : null
        },
        created_by
      });
    }

    // If staff_id is null for any row (should be rare), we still upsert;
    // but your DB might require staff_id NOT NULL. If it is NOT NULL, we should filter.
    const filtered = rows.filter(r => !!r.staff_id);
    if (!filtered.length) {
      console.warn("[finalize] no staff rows to write (missing staff_id?)");
      return { ok: true, rows: [] };
    }

    const res = await window.sb.upsertStaffShiftMetrics(filtered);
    if (res?.error) {
      console.warn("[finalize] staff metrics upsert failed", res.error);
      // don't hard-block finalize; we want snapshot to still publish
      return { ok: false, error: res.error, rows: [] };
    }
    return { ok: true, rows: res.rows || [] };
  }

  // -------------------------
  // Publish snapshot + analytics + staff metrics
  // -------------------------
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
    if (typeof window.sb.upsertShiftSnapshot !== "function") {
      setMsg("Missing sb.upsertShiftSnapshot(). Check app/app.supabase.js.", true);
      return { ok: false, reason: "missing_helper" };
    }

    const shift_date = getFinalizeDate();
    const shift_type = getFinalizeShiftType();
    const total_pts = computeTotalPatients(window.patients);
    const { admits, discharges } = computeAdmitDischargeCountsFromState();
    const top_tags = computeTopTagsFromPatients(window.patients);
    const created_by = await getUserIdSafe();

    const currentChargeName = ($("currentChargeName")?.value || "").trim();

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

    const { row, error } = await window.sb.upsertShiftSnapshot(payload);
    if (error) {
      setMsg(`Publish failed: ${error.message || String(error)}`, true);
      return { ok: false, error };
    }

    // Analytics UPSERT (optional)
    if (typeof window.sb.upsertAnalyticsShiftMetrics === "function") {
      try {
        const metricsPayload = {
          unit_id: unitId,
          shift_date,
          shift_type,
          created_by,
          metrics: { version: 1, total_pts, admits, discharges, top_tags }
        };
        await window.sb.upsertAnalyticsShiftMetrics(metricsPayload);
      } catch (e) {
        console.warn("[finalize] analytics upsert failed", e);
      }
    }

    // Staff metrics UPSERT (optional but we want it)
    setMsg("Publishing staff metrics…");
    await publishStaffShiftMetrics(unitId, shift_date, shift_type, created_by);

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
      ? "Publishes snapshot + analytics + staff metrics, then swaps Live ← Oncoming"
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