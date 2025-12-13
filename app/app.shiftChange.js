// app/app.shiftChange.js
// Shift change: Promote Oncoming -> Current, keep patients the same.
// Also moves Leadership Team "incoming" -> "current" and clears incoming leadership fields.

(function () {
  function deepClone(x) {
    return JSON.parse(JSON.stringify(x ?? null));
  }

  function setVal(id, v) {
    const el = document.getElementById(id);
    if (el) el.value = v == null ? "" : String(v);
  }

  function getVal(id) {
    const el = document.getElementById(id);
    return el ? String(el.value || "").trim() : "";
  }

  function syncGlobals() {
    // Canonical arrays live on window.*
    window.currentNurses = Array.isArray(window.currentNurses) ? window.currentNurses : [];
    window.incomingNurses = Array.isArray(window.incomingNurses) ? window.incomingNurses : [];
    window.currentPcas = Array.isArray(window.currentPcas) ? window.currentPcas : [];
    window.incomingPcas = Array.isArray(window.incomingPcas) ? window.incomingPcas : [];

    // Keep legacy bare globals in sync (these exist because app.state.js declares them with var)
    if (typeof currentNurses !== "undefined") currentNurses = window.currentNurses;
    if (typeof incomingNurses !== "undefined") incomingNurses = window.incomingNurses;
    if (typeof currentPcas !== "undefined") currentPcas = window.currentPcas;
    if (typeof incomingPcas !== "undefined") incomingPcas = window.incomingPcas;
  }

  function promoteIncomingToCurrentStaff() {
    const incRNs = Array.isArray(window.incomingNurses) ? window.incomingNurses : [];
    const incPCAs = Array.isArray(window.incomingPcas) ? window.incomingPcas : [];

    // Promote RNs
    const promotedRNs = incRNs.map((n, i) => {
      const type = n?.type || "tele";
      return {
        id: i + 1,
        name: (n?.name || "").trim() || `Current RN ${i + 1}`,
        type,
        restrictions: deepClone(n?.restrictions) || { noNih: false, noIso: false },
        maxPatients: type === "tele" ? 4 : 5,
        patients: Array.isArray(n?.patients) ? n.patients.slice() : []
      };
    });

    // Promote PCAs
    const promotedPCAs = incPCAs.map((p, i) => ({
      id: i + 1,
      name: (p?.name || "").trim() || `Current PCA ${i + 1}`,
      restrictions: deepClone(p?.restrictions) || { noIso: false },
      maxPatients: window.pcaShift === "night" ? 9 : 8,
      patients: Array.isArray(p?.patients) ? p.patients.slice() : []
    }));

    window.currentNurses = promotedRNs;
    window.currentPcas = promotedPCAs;

    // Reset incoming workspace (fresh, empty patient assignments)
    window.incomingNurses = promotedRNs.map((n, i) => ({
      id: i + 1,
      name: `Incoming RN ${i + 1}`,
      type: n.type || "tele",
      restrictions: deepClone(n.restrictions) || { noNih: false, noIso: false },
      maxPatients: (n.type || "tele") === "tele" ? 4 : 5,
      patients: []
    }));

    window.incomingPcas = promotedPCAs.map((p, i) => ({
      id: i + 1,
      name: `Incoming PCA ${i + 1}`,
      restrictions: deepClone(p.restrictions) || { noIso: false },
      maxPatients: window.pcaShift === "night" ? 9 : 8,
      patients: []
    }));

    syncGlobals();

    // Update staffing dropdown counts to match arrays
    setVal("currentNurseCount", window.currentNurses.length || 1);
    setVal("currentPcaCount", window.currentPcas.length || 1);
    setVal("incomingNurseCount", window.incomingNurses.length || 1);
    setVal("incomingPcaCount", window.incomingPcas.length || 1);
  }

  function promoteIncomingLeadershipToCurrent() {
    // incoming -> current
    const incCharge = getVal("incomingChargeName");
    const incMentor = getVal("incomingMentorName");
    const incCta = getVal("incomingCtaName");

    if (incCharge) setVal("currentChargeName", incCharge);
    if (incMentor) setVal("currentMentorName", incMentor);
    if (incCta) setVal("currentCtaName", incCta);

    // clear incoming leadership fields
    setVal("incomingChargeName", "");
    setVal("incomingMentorName", "");
    setVal("incomingCtaName", "");

    // keep your existing localStorage persistence behavior (script.js listens to input events)
    // so we also manually write to localStorage to avoid needing a user keystroke:
    try {
      localStorage.setItem("supportRole:currentChargeName", getVal("currentChargeName"));
      localStorage.setItem("supportRole:currentMentorName", getVal("currentMentorName"));
      localStorage.setItem("supportRole:currentCtaName", getVal("currentCtaName"));

      localStorage.setItem("supportRole:incomingChargeName", "");
      localStorage.setItem("supportRole:incomingMentorName", "");
      localStorage.setItem("supportRole:incomingCtaName", "");
    } catch (_) {}
  }

  function rerenderAll() {
    if (typeof window.renderCurrentNurseList === "function") window.renderCurrentNurseList();
    if (typeof window.renderIncomingNurseList === "function") window.renderIncomingNurseList();
    if (typeof window.renderCurrentPcaList === "function") window.renderCurrentPcaList();
    if (typeof window.renderIncomingPcaList === "function") window.renderIncomingPcaList();

    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();

    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
  }

  // Public API: call this on shift change
  window.finalizeShiftChange = function finalizeShiftChange() {
    // Basic guardrails
    if (!Array.isArray(window.incomingNurses) || !Array.isArray(window.incomingPcas)) {
      alert("Incoming staff not ready.");
      return;
    }

    promoteIncomingToCurrentStaff();
    promoteIncomingLeadershipToCurrent();
    rerenderAll();

    if (typeof window.saveState === "function") window.saveState();

    console.log("[shift-change] Complete: Oncoming promoted to Current; patients preserved; oncoming reset.");
  };
})();