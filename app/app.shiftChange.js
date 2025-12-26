// app/app.shiftChange.js
// ---------------------------------------------------------
// FINALIZE / SHIFT CHANGE (Dec 2025)
// - Publish a shift snapshot to Supabase (shift_snapshots)
// - Optionally publish analytics metrics (analytics_shift_metrics)
// - Then promote Oncoming -> Current (your existing workflow)
// - Guards: role-based, active unit required, SB ready
//
// Notes:
// - Expects button: #btnFinalizeShift
// - Expects inputs: #finalizeShiftDate, #finalizeShiftType
// - Uses window.sb.insertShiftSnapshot / insertAnalyticsShiftMetrics if present
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
    // fallback: today
    return new Date().toISOString().slice(0, 10);
  }

  function getFinalizeShiftType() {
    const el = $("finalizeShiftType");
    const v = el ? String(el.value || "") : "";
    return (v === "day" || v === "night") ? v : "day";
  }

  function computeTopTagsFromPatients(patients) {
    // tolerant: looks for booleans like patient.tele, patient.nih, etc. or tags arrays
    const counts = {};
    const add = (k) => { if (!k) return; counts[k] = (counts[k] || 0) + 1; };

    (Array.isArray(patients) ? patients : []).forEach(p => {
      // common patterns: p.acuityTags = { tele:true, drip:true }, or p.tags = [...]
      const obj = p?.acuityTags || p?.tagsObj || null;
      const arr = p?.tags || p?.acuity || null;

      if (obj && typeof obj === "object") {
        Object.keys(obj).forEach(k => { if (obj[k]) add(k); });
      } else if (Array.isArray(arr)) {
        arr.forEach(k => add(String(k)));
      } else {
        // fallback: check known fields
        ["tele","drip","nih","bg","ciwa","restraint","sitter","vpo","iso","admit","lateDc","chg","foley","q2","heavy","feeder"]
          .forEach(k => { if (p && p[k]) add(k); });
      }
    });

    // stringify "tele:22, nih:6, bg:5"
    return Object.entries(counts)
      .sort((a,b) => b[1]-a[1])
      .slice(0, 12)
      .map(([k,v]) => `${k}:${v}`)
      .join(", ");
  }

  function computeTotalPatients(patients) {
    // count non-empty rooms if your patient array includes empty rooms too
    // heuristic: if p.isEmpty true => exclude, else include
    const list = Array.isArray(patients) ? patients : [];
    const nonEmpty = list.filter(p => !p?.isEmpty);
    // If everything is "nonEmpty" because you store all rooms regardless,
    // this still works fine.
    return nonEmpty.length;
  }

  function computeAdmitDischargeCountsFromState() {
    // We’ll be conservative: use queue/dischargeHistory if present
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

    // optional: capture who the charge was (helpful later)
    const currentChargeName = ($("currentChargeName")?.value || "").trim();

    const payload = {
      unit_id: unitId,
      shift_date,
      shift_type,
      total_pts,
      admits,
      discharges,
      top_tags,
      // optional extra fields (safe even if table ignores them)
      created_by,
      charge_name: currentChargeName || null
    };

    setMsg("Publishing shift snapshot…");

    const { row, error } = await window.sb.insertShiftSnapshot(payload);
    if (error) {
      setMsg(`Publish failed: ${error.message || String(error)}`, true);
      return { ok: false, error };
    }

    // Optional analytics write (only if helper exists)
    if (typeof window.sb.insertAnalyticsShiftMetrics === "function") {
      try {
        const metricsPayload = {
          unit_id: unitId,
          shift_date,
          shift_type,
          total_pts,
          admits,
          discharges,
          // add more later (workload avg, infractions, etc.)
          created_by
        };
        await window.sb.insertAnalyticsShiftMetrics(metricsPayload);
      } catch (e) {
        // don’t fail finalize if analytics insert fails
        console.warn("[finalize] analytics insert failed", e);
      }
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

      // Now do the actual swap/promote logic
      if (typeof window.finalizeShiftChange === "function") {
        window.finalizeShiftChange();
      } else {
        console.warn("[finalize] window.finalizeShiftChange missing. No local swap performed.");
      }

      // Save after swap
      try { if (typeof window.saveState === "function") window.saveState(); } catch {}

      setMsg("Finalize complete ✅ (published + promoted oncoming → current).");

      // refresh unit pulse if present
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

    // keep your existing styling expectations
    btn.style.opacity = ok ? "1" : "0.55";
    btn.title = ok
      ? "Publishes Oncoming snapshot + analytics, then swaps Live ← Oncoming"
      : "Requires owner/admin/charge on the active unit (and Supabase ready).";
  }

  // keep this callable from other modules
  window.shiftFinalize = window.shiftFinalize || {};
  window.shiftFinalize.refresh = updateFinalizeButtonState;

  window.addEventListener("DOMContentLoaded", () => {
    wireFinalizeButton();

    // default finalize fields
    const dateEl = $("finalizeShiftDate");
    if (dateEl && !clampDateStr(dateEl.value)) {
      dateEl.value = new Date().toISOString().slice(0, 10);
    }
    const typeEl = $("finalizeShiftType");
    if (typeEl && !typeEl.value) typeEl.value = "day";

    updateFinalizeButtonState();

    // Re-check eligibility periodically (unit switching / auth changes)
    setInterval(updateFinalizeButtonState, 1500);
  });
})();