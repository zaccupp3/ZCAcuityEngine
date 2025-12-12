// app/app.init.js
// Central bootstrap for the entire app.
// Runs once on DOMContentLoaded, sets up staffing, patients, and initial renders.

window.addEventListener("DOMContentLoaded", async () => {
  console.log("APP INIT: Starting initialization…");

  // Ensure base patient structure exists
  ensureDefaultPatients();

  // Load state from localStorage (staff, patients, shift, activeUnitId if present)
  loadStateFromStorage();

  // -----------------------------------------------------
  // MULTI-UNIT BOOTSTRAP (minimal wiring for demo)
  // - loads memberships -> availableUnits
  // - ensures activeUnitId is set
  // - loads/apply unit_settings for activeUnitId (best-effort)
  // -----------------------------------------------------
  if (window.sb && window.refreshMyUnits && typeof window.refreshMyUnits === "function") {
    try {
      const res = await window.refreshMyUnits();
      if (!res?.ok) console.warn("[init] refreshMyUnits not ok", res?.error);
    } catch (e) {
      console.warn("[init] refreshMyUnits failed", e);
    }
  } else {
    console.warn("[init] Supabase not configured or refreshMyUnits missing (offline/demo mode).");
  }

  // If activeUnitId exists but unitSettings isn't loaded yet, try loading now.
  // (Also supports the case where memberships didn't load but unit selection is persisted.)
  if (window.activeUnitId && window.setActiveUnit && typeof window.setActiveUnit === "function") {
    try {
      // don't override role if already set; setActiveUnit will keep it
      await window.setActiveUnit(window.activeUnitId, window.activeUnitRole || null);
    } catch (e) {
      console.warn("[init] setActiveUnit failed", e);
    }
  }

  // Cache dropdown elements
  const currentNurseCountSel = document.getElementById("currentNurseCount");
  const incomingNurseCountSel = document.getElementById("incomingNurseCount");
  const currentPcaCountSel = document.getElementById("currentPcaCount");
  const incomingPcaCountSel = document.getElementById("incomingPcaCount");

  // -----------------------------------------------------
  // CURRENT RNs
  // -----------------------------------------------------
  if (!currentNurses.length) {
    if (currentNurseCountSel) currentNurseCountSel.value = 4;
    setupCurrentNurses();
  } else {
    if (currentNurseCountSel) currentNurseCountSel.value = currentNurses.length;
    renderCurrentNurseList();
  }

  // -----------------------------------------------------
  // INCOMING RNs
  // -----------------------------------------------------
  if (!incomingNurses.length) {
    if (incomingNurseCountSel) incomingNurseCountSel.value = 4;
    setupIncomingNurses();
  } else {
    if (incomingNurseCountSel) incomingNurseCountSel.value = incomingNurses.length;
    renderIncomingNurseList();
  }

  // -----------------------------------------------------
  // CURRENT PCAs
  // -----------------------------------------------------
  if (!currentPcas.length) {
    if (currentPcaCountSel) currentPcaCountSel.value = 2;
    setupCurrentPcas();
  } else {
    if (currentPcaCountSel) currentPcaCountSel.value = currentPcas.length;
    renderCurrentPcaList();
  }

  // -----------------------------------------------------
  // INCOMING PCAs
  // -----------------------------------------------------
  if (!incomingPcas.length) {
    if (incomingPcaCountSel) incomingPcaCountSel.value = 2;
    setupIncomingPcas();
  } else {
    if (incomingPcaCountSel) incomingPcaCountSel.value = incomingPcas.length;
    renderIncomingPcaList();
  }

  // -----------------------------------------------------
  // PCA shift selector (day/night)
  // -----------------------------------------------------
  const shiftSel = document.getElementById("pcaShift");
  if (shiftSel) shiftSel.value = pcaShift;

  // -----------------------------------------------------
  // AUTOFILL LIVE ASSIGNMENT (NEW!)
  // -----------------------------------------------------
  // This spreads all active patients across current RNs & PCAs
  // ONLY IF the live board is empty (so we don't overwrite work).
  if (typeof autoPopulateLiveAssignments === "function") {
    autoPopulateLiveAssignments();
  }

  // -----------------------------------------------------
  // INITIAL PAGE RENDERS
  // -----------------------------------------------------
  renderPatientList();
  updateAcuityTiles();
  renderLiveAssignments();
  renderAssignmentOutput();
  renderPcaAssignmentOutput();
  if (typeof window.renderQueueList === "function") window.renderQueueList();

  // -----------------------------------------------------
  // TAB FIX – ensure correct initial tab is active
  // -----------------------------------------------------
  const firstTabBtn = document.querySelector('.tabButton[data-target="staffingTab"]');
  if (typeof showTab === "function" && firstTabBtn) {
    showTab("staffingTab", firstTabBtn);
  }

  console.log("APP INIT: Initialization complete.");
});