// app/app.modals.js
// Patient profile modal open/close/save.
// NOTE: Discharge history modal is owned by app.assignmentsDrag.js.
// We intentionally do NOT duplicate discharge modal logic here.

(function () {
  let currentProfilePatientId = null;

  function setCheckbox(id, value) {
    const el = document.getElementById(id);
    if (el) el.checked = !!value;
  }

  function getCheckbox(id) {
    const el = document.getElementById(id);
    return !!(el && el.checked);
  }

  function setSelect(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value || "";
  }

  function getSelect(id) {
    const el = document.getElementById(id);
    return el ? el.value : "";
  }

  function openPatientProfileFromRoom(patientId) {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return;

    // Keep consistent with your Patient Details rules:
    if (p.isEmpty) {
      alert("This bed is EMPTY. Uncheck Empty Bed on Patient Details to admit/edit.");
      return;
    }

    currentProfilePatientId = patientId;

    const modal = document.getElementById("patientProfileModal");
    if (!modal) return;

    const titleEl = document.getElementById("profileModalTitle");
    if (titleEl) titleEl.textContent = `Patient Profile – Room ${p.room || ""}`;

    setSelect("profGender", p.gender || "");

    // RN tags
    setCheckbox("profTele", p.tele);
    setCheckbox("profDrip", p.drip);
    setCheckbox("profNih", p.nih);
    setCheckbox("profBg", p.bg);
    setCheckbox("profCiwa", p.ciwa);
    setCheckbox("profRestraint", p.restraint);
    setCheckbox("profSitter", p.sitter);
    setCheckbox("profVpo", p.vpo);
    setCheckbox("profIso", p.isolation);
    setCheckbox("profAdmit", p.admit);
    setCheckbox("profLateDc", p.lateDc);

    // PCA tags
    setCheckbox("profTelePca", p.tele);
    setCheckbox("profIsoPca", p.isolation);
    setCheckbox("profAdmitPca", p.admit);
    setCheckbox("profLateDcPca", p.lateDc);
    setCheckbox("profChg", p.chg);
    setCheckbox("profFoley", p.foley);
    setCheckbox("profQ2", p.q2turns);
    setCheckbox("profHeavy", p.heavy);
    setCheckbox("profFeeder", p.feeder);

    modal.style.display = "block";
  }

  function closePatientProfileModal() {
    const modal = document.getElementById("patientProfileModal");
    if (modal) modal.style.display = "none";
    currentProfilePatientId = null;
  }

  function savePatientProfile() {
    if (currentProfilePatientId == null) return;
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(currentProfilePatientId) : null;
    if (!p) {
      closePatientProfileModal();
      return;
    }

    // Gender first (uses roommate safety via canSetGender inside changePatientGender)
    const newGender = getSelect("profGender");
    if (typeof window.changePatientGender === "function") {
      if (newGender !== (p.gender || "")) window.changePatientGender(p.id, newGender);
    } else {
      p.gender = newGender || "";
    }

    // Update flags using the canonical toggle function (enforces non-empty rules)
    const nextFlags = {
      tele: getCheckbox("profTele"),
      drip: getCheckbox("profDrip"),
      nih: getCheckbox("profNih"),
      bg: getCheckbox("profBg"),
      ciwa: getCheckbox("profCiwa"),
      restraint: getCheckbox("profRestraint"),
      sitter: getCheckbox("profSitter"),
      vpo: getCheckbox("profVpo"),
      isolation: getCheckbox("profIso"),
      admit: getCheckbox("profAdmit"),
      lateDc: getCheckbox("profLateDc"),
      chg: getCheckbox("profChg"),
      foley: getCheckbox("profFoley"),
      q2turns: getCheckbox("profQ2"),
      heavy: getCheckbox("profHeavy"),
      feeder: getCheckbox("profFeeder")
    };

    if (typeof window.togglePatientFlag === "function") {
      Object.entries(nextFlags).forEach(([key, val]) => {
        if (!!p[key] !== !!val) window.togglePatientFlag(p.id, key, val);
      });
    } else {
      Object.assign(p, nextFlags);
    }

    // Ensure occupied (profile implies bed occupied)
    p.isEmpty = false;
    p.recentlyDischarged = false;

    if (typeof window.saveState === "function") window.saveState();

    // One clean rerender sweep
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();

    closePatientProfileModal();
  }

  // Expose only patient modal functions
  window.openPatientProfileFromRoom = openPatientProfileFromRoom;
  window.closePatientProfileModal = closePatientProfileModal;
  window.savePatientProfile = savePatientProfile;
})();