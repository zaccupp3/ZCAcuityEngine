// app/app.staffing.js
// Handles RN/PCA staffing for "Staffing Details" tab
// and keeps current/incoming arrays in sync with the UI.

// -------------------------
// Global state (reuse if already defined)
// -------------------------
window.currentNurses = window.currentNurses || [];
window.incomingNurses = window.incomingNurses || [];
window.currentPcas   = window.currentPcas   || [];
window.incomingPcas  = window.incomingPcas  || [];
window.pcaShift      = window.pcaShift || "day"; // "day" | "night"

// Basic restriction helper (same as your old script)
function defaultRestrictions(oldRestriction) {
  return {
    noNih: oldRestriction === "noNih",
    noIso: false
  };
}

// -------------------------
// RN SETUP – CURRENT / INCOMING
// -------------------------

// Build Current RN roster based on dropdown count
window.setupCurrentNurses = function () {
  const sel = document.getElementById("currentNurseCount");
  let count = parseInt(sel.value, 10);
  if (isNaN(count) || count < 1) count = 1;
  if (count > 8) count = 8;
  sel.value = count;

  const old = currentNurses;
  currentNurses = [];
  for (let i = 0; i < count; i++) {
    const prev = old[i];
    const prevRestrictions =
      prev?.restrictions || defaultRestrictions(prev?.restriction);
    const type = prev?.type || "tele";
    currentNurses.push({
      id: i + 1,
      name: prev?.name || `Current RN ${i + 1}`,
      type,
      restrictions: {
        noNih: !!prevRestrictions.noNih,
        noIso: !!prevRestrictions.noIso
      },
      maxPatients: type === "tele" ? 4 : 5,
      patients: prev?.patients || []
    });
  }

  renderCurrentNurseList();
  if (typeof renderLiveAssignments === "function") {
    renderLiveAssignments();
  }
  if (typeof saveState === "function") {
    saveState();
  }
};

// Build Oncoming RN roster
window.setupIncomingNurses = function () {
  const sel = document.getElementById("incomingNurseCount");
  let count = parseInt(sel.value, 10);
  if (isNaN(count) || count < 1) count = 1;
  if (count > 8) count = 8;
  sel.value = count;

  const old = incomingNurses;
  incomingNurses = [];
  for (let i = 0; i < count; i++) {
    const prev = old[i];
    const prevRestrictions =
      prev?.restrictions || defaultRestrictions(prev?.restriction);
    const type = prev?.type || "tele";
    incomingNurses.push({
      id: i + 1,
      name: prev?.name || `Incoming RN ${i + 1}`,
      type,
      restrictions: {
        noNih: !!prevRestrictions.noNih,
        noIso: !!prevRestrictions.noIso
      },
      maxPatients: type === "tele" ? 4 : 5,
      patients: prev?.patients || []
    });
  }

  renderIncomingNurseList();
  if (typeof renderAssignmentOutput === "function") {
    renderAssignmentOutput();
  }
  if (typeof saveState === "function") {
    saveState();
  }
};

// Render Current RN list into #currentNurseList
window.renderCurrentNurseList = function () {
  const container = document.getElementById("currentNurseList");
  if (!container) return;
  container.innerHTML = "";

  currentNurses.forEach((n, index) => {
    const r = n.restrictions || defaultRestrictions();
    container.innerHTML += `
      <div class="nurseRow">
        <label>
          Name:
          <input type="text" value="${n.name}"
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

// Render Incoming RN list into #incomingNurseList
window.renderIncomingNurseList = function () {
  const container = document.getElementById("incomingNurseList");
  if (!container) return;
  container.innerHTML = "";

  incomingNurses.forEach((n, index) => {
    const r = n.restrictions || defaultRestrictions();
    container.innerHTML += `
      <div class="nurseRow">
        <label>
          Name:
          <input type="text" value="${n.name}"
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
// (called from the inputs rendered above)
// -------------------------

window.updateCurrentNurseType = function (index, value) {
  const n = currentNurses[index];
  if (!n) return;
  n.type = value;
  n.maxPatients = value === "tele" ? 4 : 5;
  if (typeof renderLiveAssignments === "function") {
    renderLiveAssignments();
  }
  if (typeof saveState === "function") saveState();
};

window.updateIncomingNurseType = function (index, value) {
  const n = incomingNurses[index];
  if (!n) return;
  n.type = value;
  n.maxPatients = value === "tele" ? 4 : 5;
  if (typeof renderAssignmentOutput === "function") {
    renderAssignmentOutput();
  }
  if (typeof saveState === "function") saveState();
};

window.updateCurrentNurseName = function (index, value) {
  const n = currentNurses[index];
  if (!n) return;
  n.name = value || `Current RN ${index + 1}`;
  if (typeof renderLiveAssignments === "function") {
    renderLiveAssignments();
  }
  if (typeof saveState === "function") saveState();
};

window.updateIncomingNurseName = function (index, value) {
  const n = incomingNurses[index];
  if (!n) return;
  n.name = value || `Incoming RN ${index + 1}`;
  if (typeof renderAssignmentOutput === "function") {
    renderAssignmentOutput();
  }
  if (typeof saveState === "function") saveState();
};

window.updateCurrentNurseRestriction = function (index, key, checked) {
  const n = currentNurses[index];
  if (!n) return;
  if (!n.restrictions) n.restrictions = defaultRestrictions();
  n.restrictions[key] = checked;
  if (typeof renderLiveAssignments === "function") {
    renderLiveAssignments();
  }
  if (typeof saveState === "function") saveState();
};

window.updateIncomingNurseRestriction = function (index, key, checked) {
  const n = incomingNurses[index];
  if (!n) return;
  if (!n.restrictions) n.restrictions = defaultRestrictions();
  n.restrictions[key] = checked;
  if (typeof renderAssignmentOutput === "function") {
    renderAssignmentOutput();
  }
  if (typeof saveState === "function") saveState();
};

// -------------------------
// PCA SETUP – CURRENT / INCOMING
// -------------------------

// Shift selector:
window.updatePcaShift = function (value) {
  pcaShift = value === "night" ? "night" : "day";
  const max = pcaShift === "day" ? 8 : 9;

  currentPcas.forEach((p) => (p.maxPatients = max));
  incomingPcas.forEach((p) => (p.maxPatients = max));

  if (typeof renderLiveAssignments === "function") {
    renderLiveAssignments();
  }
  if (typeof renderPcaAssignmentOutput === "function") {
    renderPcaAssignmentOutput();
  }
  if (typeof saveState === "function") saveState();
};

window.setupCurrentPcas = function () {
  const sel = document.getElementById("currentPcaCount");
  let count = parseInt(sel.value, 10);
  if (isNaN(count) || count < 1) count = 1;
  if (count > 6) count = 6;
  sel.value = count;

  const old = currentPcas;
  const max = pcaShift === "day" ? 8 : 9;
  currentPcas = [];
  for (let i = 0; i < count; i++) {
    const prev = old[i];
    currentPcas.push({
      id: i + 1,
      name: prev?.name || `Current PCA ${i + 1}`,
      restrictions: { noIso: !!(prev && prev.restrictions && prev.restrictions.noIso) },
      maxPatients: max,
      patients: prev?.patients || []
    });
  }

  renderCurrentPcaList();
  if (typeof renderLiveAssignments === "function") {
    renderLiveAssignments();
  }
  if (typeof saveState === "function") saveState();
};

window.setupIncomingPcas = function () {
  const sel = document.getElementById("incomingPcaCount");
  let count = parseInt(sel.value, 10);
  if (isNaN(count) || count < 1) count = 1;
  if (count > 6) count = 6;
  sel.value = count;

  const old = incomingPcas;
  const max = pcaShift === "day" ? 8 : 9;
  incomingPcas = [];
  for (let i = 0; i < count; i++) {
    const prev = old[i];
    incomingPcas.push({
      id: i + 1,
      name: prev?.name || `Incoming PCA ${i + 1}`,
      restrictions: { noIso: !!(prev && prev.restrictions && prev.restrictions.noIso) },
      maxPatients: max,
      patients: prev?.patients || []
    });
  }

  renderIncomingPcaList();
  if (typeof renderPcaAssignmentOutput === "function") {
    renderPcaAssignmentOutput();
  }
  if (typeof saveState === "function") saveState();
};

// Renderers for PCA lists

window.renderCurrentPcaList = function () {
  const container = document.getElementById("currentPcaList");
  if (!container) return;
  container.innerHTML = "";

  currentPcas.forEach((p, index) => {
    const r = p.restrictions || { noIso: false };
    container.innerHTML += `
      <div class="pcaRow">
        <label>
          Name:
          <input type="text" value="${p.name}"
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

  incomingPcas.forEach((p, index) => {
    const r = p.restrictions || { noIso: false };
    container.innerHTML += `
      <div class="pcaRow">
        <label>
          Name:
          <input type="text" value="${p.name}"
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

// PCA update helpers
window.updateCurrentPcaName = function (index, value) {
  const p = currentPcas[index];
  if (!p) return;
  p.name = value || `Current PCA ${index + 1}`;
  if (typeof renderLiveAssignments === "function") {
    renderLiveAssignments();
  }
  if (typeof saveState === "function") saveState();
};

window.updateIncomingPcaName = function (index, value) {
  const p = incomingPcas[index];
  if (!p) return;
  p.name = value || `Incoming PCA ${index + 1}`;
  if (typeof renderPcaAssignmentOutput === "function") {
    renderPcaAssignmentOutput();
  }
  if (typeof saveState === "function") saveState();
};

window.updateCurrentPcaRestriction = function (index, checked) {
  const p = currentPcas[index];
  if (!p) return;
  if (!p.restrictions) p.restrictions = { noIso: false };
  p.restrictions.noIso = checked;
  if (typeof renderLiveAssignments === "function") {
    renderLiveAssignments();
  }
  if (typeof saveState === "function") saveState();
};

window.updateIncomingPcaRestriction = function (index, checked) {
  const p = incomingPcas[index];
  if (!p) return;
  if (!p.restrictions) p.restrictions = { noIso: false };
  p.restrictions.noIso = checked;
  if (typeof renderPcaAssignmentOutput === "function") {
    renderPcaAssignmentOutput();
  }
  if (typeof saveState === "function") saveState();
};
