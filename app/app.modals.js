// app/app.modals.js
// Patient profile modal: open from double-click, edit tags, save.

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
    const p = getPatientById(patientId);
    if (!p) return;

    currentProfilePatientId = patientId;

    const modal = document.getElementById("patientProfileModal");
    if (!modal) return;

    const titleEl = document.getElementById("profileModalTitle");
    if (titleEl) {
      titleEl.textContent = `Patient Profile – Room ${p.room || ""}`;
    }

    setSelect("profGender", p.gender || "");

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
    const p = getPatientById(currentProfilePatientId);
    if (!p) {
      closePatientProfileModal();
      return;
    }

    const newGender = getSelect("profGender");
    if (newGender !== p.gender) {
      changePatientGender(p.id, newGender);
    }

    const flags = {
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

    Object.entries(flags).forEach(([key, val]) => {
      if (p[key] !== val) {
        togglePatientFlag(p.id, key, val);
      }
    });

    // underlying helpers re-render, but call again defensively:
    if (typeof window.renderPatientList === "function") {
      window.renderPatientList();
    }

    if (typeof window.updateAcuityTiles === "function") {
      window.updateAcuityTiles();
    }

    if (typeof window.renderLiveAssignments === "function") {
      window.renderLiveAssignments();
    }

    if (typeof window.renderAssignmentOutput === "function") {
      window.renderAssignmentOutput();
    }

    if (typeof window.renderPcaAssignmentOutput === "function") {
      window.renderPcaAssignmentOutput();
    }

    if (typeof saveState === "function") {
      saveState();
    }
    closePatientProfileModal();


    function openDischargeHistoryModal() {
      const modal = document.getElementById("dischargeHistoryModal");
      const body  = document.getElementById("dischargeHistoryBody");
      if (!modal || !body) return;

      const history = Array.isArray(window.dischargeHistory) ? window.dischargeHistory : [];

      let html = "";

      history.forEach((entry, i) => {
        const p = getPatientById(entry.patientId);
        if (!p) return;

        const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "";

        html += `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #eee;">
            <div>
              <div><strong>${p.room || ""}</strong> ${p.name ? `- ${p.name}` : ""}</div>
              <div style="font-size:12px;opacity:0.75;">${ts}</div>
            </div>
            <button onclick="reinstateDischargedPatient(${i})">Reinstate</button>
          </div>
        `;
      });

      body.innerHTML = html || `<div style="padding:10px;opacity:0.7;">No discharges yet.</div>`;
      modal.style.display = "flex";
    }

    function closeDischargeHistoryModal() {
      const modal = document.getElementById("dischargeHistoryModal");
      if (!modal) return;
      modal.style.display = "none";
    }

    // expose globally for the HTML onclick=""
    window.openDischargeHistoryModal = openDischargeHistoryModal;
    window.closeDischargeHistoryModal = closeDischargeHistoryModal;


  // Expose globals
  window.openPatientProfileFromRoom = openPatientProfileFromRoom;
  window.closePatientProfileModal = closePatientProfileModal;
  window.savePatientProfile = savePatientProfile;
  window.openDischargeHistoryModal  = openDischargeHistoryModal;
  window.closeDischargeHistoryModal = closeDischargeHistoryModal;
})();