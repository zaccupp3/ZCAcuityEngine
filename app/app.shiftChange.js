// app/app.shiftChange.js
// ---------------------------------------------------------
// FINALIZE / SHIFT CHANGE (Dec 2025)
// - Publish a shift snapshot to Supabase (shift_snapshots)
// - Optionally publish analytics metrics (analytics_shift_metrics)
// - Then promote Oncoming -> Current (your existing workflow)
// - Guards: role-based, active unit required, SB ready
// ---------------------------------------------------------

(function () {
  const $ = (id) => document.getElementById(id);

  let __finalizeInFlight = false;

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

    setMsg("Snapshot published. Finalizing shift change…");
    return { ok: true, row };
  }

  async function handleFinalizeClick() {
    const btn = $("btnFinalizeShift");

    // ✅ Single-flight guard (prevents double submit)
    if (__finalizeInFlight) return;
    __finalizeInFlight = true;

    try {
      if (btn) btn.disabled = true;

      const pub = await publishShiftSnapshot();
      if (!pub.ok) return;

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
    } finally {
      __finalizeInFlight = false;
      // re-enable based on eligibility rules
      updateFinalizeButtonState();
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

    const ok = !!unitId && canWriteRole(role) && sbReady() && !__finalizeInFlight;
    btn.disabled = !ok;

    btn.style.opacity = ok ? "1" : "0.55";
    btn.title = ok
      ? "Publishes Oncoming snapshot + analytics, then swaps Live ← Oncoming"
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