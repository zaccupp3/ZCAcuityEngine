// app/app.shiftChange.js
// Promote Oncoming -> Current (true shift change)

(function () {
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj || null));
  }

  function $(id) { return document.getElementById(id); }

  function setSelectValue(id, value) {
    const el = $(id);
    if (el) el.value = String(value);
  }

  function setStatus(msg, isError = false) {
    const el = $("finalizeStatusMsg");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isError ? "#b91c1c" : "";
  }

  function roleAllowsFinalize() {
    // If you track role on window.activeUnitRole (you do in app.state.js), use it.
    // Otherwise allow (demo-friendly).
    const r = String(window.activeUnitRole || "").toLowerCase();
    if (!r) return true;
    return ["owner", "admin", "charge"].includes(r);
  }

  function readFinalizeInputs() {
    const dateVal = ($("finalizeShiftDate")?.value || "").trim();
    const typeVal = ($("finalizeShiftType")?.value || "day").trim();

    // If user didn’t pick a date, default to today (local)
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const fallback = `${yyyy}-${mm}-${dd}`;

    return {
      shift_date: dateVal || fallback,
      shift_type: (typeVal === "night" ? "night" : "day"),
    };
  }

  // Main action: promote incoming to current
  async function finalizeShiftChange() {
    setStatus("");

    // Guardrails
    if (!window.activeUnitId) {
      alert("Select a unit first.");
      return;
    }
    if (!roleAllowsFinalize()) {
      alert("Finalize is restricted to owner/admin/charge for this unit.");
      return;
    }
    if (!Array.isArray(window.incomingNurses) || !Array.isArray(window.incomingPcas)) {
      alert("Incoming staff not ready.");
      return;
    }

    const incomingHasStaff =
      (window.incomingNurses || []).length > 0 || (window.incomingPcas || []).length > 0;

    if (!incomingHasStaff) {
      const ok = confirm("Oncoming staff lists look empty. Finalize anyway?");
      if (!ok) return;
    }

    setStatus("Finalizing shift change…");

    // Optional: if you later add snapshot publishing, this is where it would go.
    // (We’ll keep it local-only for now so it always works.)
    const meta = readFinalizeInputs();
    console.log("[shift-change] meta:", meta);

    // --- 1) Promote INCOMING -> CURRENT (deep copy) ---
    const promotedRNs = (incomingNurses || []).map((n, i) => ({
      id: i + 1,
      name: n?.name || `Current RN ${i + 1}`,
      type: n?.type || "tele",
      restrictions: clone(n?.restrictions) || { noNih: false, noIso: false },
      maxPatients: (n?.type || "tele") === "tele" ? 4 : 5,
      patients: Array.isArray(n?.patients) ? n.patients.slice() : []
    }));

    const promotedPCAs = (incomingPcas || []).map((p, i) => ({
      id: i + 1,
      name: p?.name || `Current PCA ${i + 1}`,
      restrictions: clone(p?.restrictions) || { noIso: false },
      maxPatients: window.pcaShift === "night" ? 9 : 8,
      patients: Array.isArray(p?.patients) ? p.patients.slice() : []
    }));

    // IMPORTANT: keep BOTH the bare globals and window.* in sync
    currentNurses = promotedRNs;
    currentPcas = promotedPCAs;
    window.currentNurses = currentNurses;
    window.currentPcas = currentPcas;

    // --- 2) Update staffing dropdowns for CURRENT ---
    setSelectValue("currentNurseCount", currentNurses.length || 1);
    setSelectValue("currentPcaCount", currentPcas.length || 1);

    // --- 3) Clear INCOMING workspace (fresh defaults, no patients) ---
    incomingNurses = [];
    incomingPcas = [];
    window.incomingNurses = incomingNurses;
    window.incomingPcas = incomingPcas;

    // Rebuild incoming lists using your existing setup functions (creates default names/types)
    const nextIncomingRnCount = Math.max(1, Math.min(8, currentNurses.length || 1));
    const nextIncomingPcaCount = Math.max(1, Math.min(6, currentPcas.length || 1));

    setSelectValue("incomingNurseCount", nextIncomingRnCount);
    setSelectValue("incomingPcaCount", nextIncomingPcaCount);

    if (typeof window.setupIncomingNurses === "function") window.setupIncomingNurses();
    if (typeof window.setupIncomingPcas === "function") window.setupIncomingPcas();

    // --- 4) Re-render everything ---
    if (typeof window.renderCurrentNurseList === "function") window.renderCurrentNurseList();
    if (typeof window.renderCurrentPcaList === "function") window.renderCurrentPcaList();

    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();

    // --- 5) Persist locally ---
    if (typeof window.saveState === "function") window.saveState();

    setStatus("✅ Shift change complete. Oncoming is now Live.");
    console.log("[shift-change] Finalized. Incoming promoted to current.");
  }

  // Expose (optional; useful for debugging)
  window.finalizeShiftChange = finalizeShiftChange;

  // Wire button
  function wire() {
    const btn = $("btnFinalizeShift");
    if (btn) btn.addEventListener("click", finalizeShiftChange);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();