// app/app.staffing.js
// Handles RN/PCA staffing for "Staffing Details" tab
// and keeps current/incoming arrays in sync with the UI.
//
// IMPORTANT:
// - app.state.js owns the core arrays and exposes live getters/setters on window.
// - Do NOT reinitialize window.currentNurses/currentPcas/etc in this file.
// - Just read/write currentNurses/currentPcas/incomingNurses/incomingPcas/pcaShift directly.

(function () {
  // Use the canonical restriction helper from app.state.js if present
  const getDefaultRestrictions =
    (typeof window.defaultRestrictions === "function")
      ? window.defaultRestrictions
      : function defaultRestrictionsFallback(oldRestriction) {
          return { noNih: oldRestriction === "noNih", noIso: false };
        };

  // -------------------------
  // RN SETUP – CURRENT / INCOMING
  // -------------------------

  window.setupCurrentNurses = function () {
    const sel = document.getElementById("currentNurseCount");
    let count = parseInt(sel && sel.value, 10);
    if (isNaN(count) || count < 1) count = 1;
    if (count > 8) count = 8;
    if (sel) sel.value = count;

    const old = Array.isArray(currentNurses) ? currentNurses : [];
    const next = [];

    for (let i = 0; i < count; i++) {
      const prev = old[i];
      const prevRestrictions = prev?.restrictions || getDefaultRestrictions(prev?.restriction);
      const type = prev?.type || "tele";
      next.push({
        id: i + 1,
        name: prev?.name || `Current RN ${i + 1}`,
        type,
        restrictions: {
          noNih: !!prevRestrictions.noNih,
          noIso: !!prevRestrictions.noIso
        },
        maxPatients: type === "tele" ? 4 : 5,
        patients: Array.isArray(prev?.patients) ? prev.patients.slice() : []
      });
    }

    currentNurses = next;

    window.renderCurrentNurseList();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.setupIncomingNurses = function () {
    const sel = document.getElementById("incomingNurseCount");
    let count = parseInt(sel && sel.value, 10);
    if (isNaN(count) || count < 1) count = 1;
    if (count > 8) count = 8;
    if (sel) sel.value = count;

    const old = Array.isArray(incomingNurses) ? incomingNurses : [];
    const next = [];

    for (let i = 0; i < count; i++) {
      const prev = old[i];
      const prevRestrictions = prev?.restrictions || getDefaultRestrictions(prev?.restriction);
      const type = prev?.type || "tele";
      next.push({
        id: i + 1,
        name: prev?.name || `Incoming RN ${i + 1}`,
        type,
        restrictions: {
          noNih: !!prevRestrictions.noNih,
          noIso: !!prevRestrictions.noIso
        },
        maxPatients: type === "tele" ? 4 : 5,
        patients: Array.isArray(prev?.patients) ? prev.patients.slice() : []
      });
    }

    incomingNurses = next;

    window.renderIncomingNurseList();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.renderCurrentNurseList = function () {
    const container = document.getElementById("currentNurseList");
    if (!container) return;
    container.innerHTML = "";

    (Array.isArray(currentNurses) ? currentNurses : []).forEach((n, index) => {
      const r = n.restrictions || getDefaultRestrictions();
      container.innerHTML += `
        <div class="nurseRow">
          <label>
            Name:
            <input type="text" value="${(n.name || "").replace(/"/g, "&quot;")}"
                   onchange="updateCurrentNurseName(${index}, this.value)">
          </label>
          <label>
            Type:
            <select onchange="updateCurrentNurseType(${index}, this.value)">
              <option value="tele" ${n.type === "tele" ? "selected" : ""}>Tele (max 4)</option>
              <option value="ms" ${n.type === "ms" ? "selected" : ""}>Med-Surg (max 5)</option>
            </select>
          </label>

          <div class="restrictionsGroup">
            <span>Restrictions:</span>
            <label class="restrictionOption">
              <input type="checkbox" ${r.noNih ? "checked" : ""}
                     onchange="updateCurrentNurseRestriction(${index}, 'noNih', this.checked)"> No NIH
            </label>
            <label class="restrictionOption">
              <input type="checkbox" ${r.noIso ? "checked" : ""}
                     onchange="updateCurrentNurseRestriction(${index}, 'noIso', this.checked)"> No ISO
            </label>
          </div>
        </div>
      `;
    });
  };

  window.renderIncomingNurseList = function () {
    const container = document.getElementById("incomingNurseList");
    if (!container) return;
    container.innerHTML = "";

    (Array.isArray(incomingNurses) ? incomingNurses : []).forEach((n, index) => {
      const r = n.restrictions || getDefaultRestrictions();
      container.innerHTML += `
        <div class="nurseRow">
          <label>
            Name:
            <input type="text" value="${(n.name || "").replace(/"/g, "&quot;")}"
                   onchange="updateIncomingNurseName(${index}, this.value)">
          </label>
          <label>
            Type:
            <select onchange="updateIncomingNurseType(${index}, this.value)">
              <option value="tele" ${n.type === "tele" ? "selected" : ""}>Tele (max 4)</option>
              <option value="ms" ${n.type === "ms" ? "selected" : ""}>Med-Surg (max 5)</option>
            </select>
          </label>

          <div class="restrictionsGroup">
            <span>Restrictions:</span>
            <label class="restrictionOption">
              <input type="checkbox" ${r.noNih ? "checked" : ""}
                     onchange="updateIncomingNurseRestriction(${index}, 'noNih', this.checked)"> No NIH
            </label>
            <label class="restrictionOption">
              <input type="checkbox" ${r.noIso ? "checked" : ""}
                     onchange="updateIncomingNurseRestriction(${index}, 'noIso', this.checked)"> No ISO
            </label>
          </div>
        </div>
      `;
    });
  };

  // -------------------------
  // RN UPDATE HELPERS
  // -------------------------

  window.updateCurrentNurseType = function (index, value) {
    const n = currentNurses && currentNurses[index];
    if (!n) return;
    n.type = value;
    n.maxPatients = value === "tele" ? 4 : 5;
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingNurseType = function (index, value) {
    const n = incomingNurses && incomingNurses[index];
    if (!n) return;
    n.type = value;
    n.maxPatients = value === "tele" ? 4 : 5;
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateCurrentNurseName = function (index, value) {
    const n = currentNurses && currentNurses[index];
    if (!n) return;
    n.name = String(value || "").trim() || `Current RN ${index + 1}`;
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingNurseName = function (index, value) {
    const n = incomingNurses && incomingNurses[index];
    if (!n) return;
    n.name = String(value || "").trim() || `Incoming RN ${index + 1}`;
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateCurrentNurseRestriction = function (index, key, checked) {
    const n = currentNurses && currentNurses[index];
    if (!n) return;
    if (!n.restrictions) n.restrictions = getDefaultRestrictions();
    n.restrictions[key] = !!checked;
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingNurseRestriction = function (index, key, checked) {
    const n = incomingNurses && incomingNurses[index];
    if (!n) return;
    if (!n.restrictions) n.restrictions = getDefaultRestrictions();
    n.restrictions[key] = !!checked;
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  // -------------------------
  // PCA SETUP – CURRENT / INCOMING
  // -------------------------

  window.updatePcaShift = function (value) {
    pcaShift = value === "night" ? "night" : "day";
    const max = pcaShift === "day" ? 8 : 9;

    (Array.isArray(currentPcas) ? currentPcas : []).forEach(p => (p.maxPatients = max));
    (Array.isArray(incomingPcas) ? incomingPcas : []).forEach(p => (p.maxPatients = max));

    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.setupCurrentPcas = function () {
    const sel = document.getElementById("currentPcaCount");
    let count = parseInt(sel && sel.value, 10);
    if (isNaN(count) || count < 1) count = 1;
    if (count > 6) count = 6;
    if (sel) sel.value = count;

    const old = Array.isArray(currentPcas) ? currentPcas : [];
    const max = pcaShift === "day" ? 8 : 9;
    const next = [];

    for (let i = 0; i < count; i++) {
      const prev = old[i];
      next.push({
        id: i + 1,
        name: prev?.name || `Current PCA ${i + 1}`,
        restrictions: { noIso: !!(prev && prev.restrictions && prev.restrictions.noIso) },
        maxPatients: max,
        patients: Array.isArray(prev?.patients) ? prev.patients.slice() : []
      });
    }

    currentPcas = next;

    window.renderCurrentPcaList();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.setupIncomingPcas = function () {
    const sel = document.getElementById("incomingPcaCount");
    let count = parseInt(sel && sel.value, 10);
    if (isNaN(count) || count < 1) count = 1;
    if (count > 6) count = 6;
    if (sel) sel.value = count;

    const old = Array.isArray(incomingPcas) ? incomingPcas : [];
    const max = pcaShift === "day" ? 8 : 9;
    const next = [];

    for (let i = 0; i < count; i++) {
      const prev = old[i];
      next.push({
        id: i + 1,
        name: prev?.name || `Incoming PCA ${i + 1}`,
        restrictions: { noIso: !!(prev && prev.restrictions && prev.restrictions.noIso) },
        maxPatients: max,
        patients: Array.isArray(prev?.patients) ? prev.patients.slice() : []
      });
    }

    incomingPcas = next;

    window.renderIncomingPcaList();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.renderCurrentPcaList = function () {
    const container = document.getElementById("currentPcaList");
    if (!container) return;
    container.innerHTML = "";

    (Array.isArray(currentPcas) ? currentPcas : []).forEach((p, index) => {
      const r = p.restrictions || { noIso: false };
      container.innerHTML += `
        <div class="pcaRow">
          <label>
            Name:
            <input type="text" value="${(p.name || "").replace(/"/g, "&quot;")}"
                   onchange="updateCurrentPcaName(${index}, this.value)">
          </label>
          <div class="restrictionsGroup">
            <span>Restrictions:</span>
            <label class="restrictionOption">
              <input type="checkbox" ${r.noIso ? "checked" : ""}
                     onchange="updateCurrentPcaRestriction(${index}, this.checked)"> No ISO
            </label>
          </div>
        </div>
      `;
    });
  };

  window.renderIncomingPcaList = function () {
    const container = document.getElementById("incomingPcaList");
    if (!container) return;
    container.innerHTML = "";

    (Array.isArray(incomingPcas) ? incomingPcas : []).forEach((p, index) => {
      const r = p.restrictions || { noIso: false };
      container.innerHTML += `
        <div class="pcaRow">
          <label>
            Name:
            <input type="text" value="${(p.name || "").replace(/"/g, "&quot;")}"
                   onchange="updateIncomingPcaName(${index}, this.value)">
          </label>
          <div class="restrictionsGroup">
            <span>Restrictions:</span>
            <label class="restrictionOption">
              <input type="checkbox" ${r.noIso ? "checked" : ""}
                     onchange="updateIncomingPcaRestriction(${index}, this.checked)"> No ISO
            </label>
          </div>
        </div>
      `;
    });
  };

  window.updateCurrentPcaName = function (index, value) {
    const p = currentPcas && currentPcas[index];
    if (!p) return;
    p.name = String(value || "").trim() || `Current PCA ${index + 1}`;
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingPcaName = function (index, value) {
    const p = incomingPcas && incomingPcas[index];
    if (!p) return;
    p.name = String(value || "").trim() || `Incoming PCA ${index + 1}`;
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateCurrentPcaRestriction = function (index, checked) {
    const p = currentPcas && currentPcas[index];
    if (!p) return;
    if (!p.restrictions) p.restrictions = { noIso: false };
    p.restrictions.noIso = !!checked;
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingPcaRestriction = function (index, checked) {
    const p = incomingPcas && incomingPcas[index];
    if (!p) return;
    if (!p.restrictions) p.restrictions = { noIso: false };
    p.restrictions.noIso = !!checked;
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };
})();