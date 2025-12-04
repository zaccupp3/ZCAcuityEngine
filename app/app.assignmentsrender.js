// app/app.assignmentsrender.js
// ---------------------------------------------------------
// Rendering + generator for Oncoming (incoming) assignments ONLY
// Adds "Prev. RN / Prev. PCA" columns by referencing LIVE assignments.
// ---------------------------------------------------------

// -----------------------------
// Helpers: Previous owner lookups (from LIVE board)
// -----------------------------

function getPrevRnNameForPatient(patientId) {
  const pid = Number(patientId);
  if (!pid || !Array.isArray(window.currentNurses)) return "";

  const owner = window.currentNurses.find(n =>
    Array.isArray(n.patients) && n.patients.includes(pid)
  );

  return owner ? (owner.name || `RN ${owner.id}`) : "";
}

function getPrevPcaNameForPatient(patientId) {
  const pid = Number(patientId);
  if (!pid || !Array.isArray(window.currentPcas)) return "";

  const owner = window.currentPcas.find(p =>
    Array.isArray(p.patients) && p.patients.includes(pid)
  );

  return owner ? (owner.name || `PCA ${owner.id}`) : "";
}

// Optional: count unique report sources for an incoming nurse (unique previous RNs)
function getUniquePrevRnCount(patientIds) {
  const set = new Set();
  (patientIds || []).forEach(pid => {
    const name = getPrevRnNameForPatient(pid);
    if (name) set.add(name);
  });
  return set.size;
}

// Optional: count unique report sources for an incoming PCA (unique previous PCAs)
function getUniquePrevPcaCount(patientIds) {
  const set = new Set();
  (patientIds || []).forEach(pid => {
    const name = getPrevPcaNameForPatient(pid);
    if (name) set.add(name);
  });
  return set.size;
}

// -----------------------------
// RN Oncoming Render
// -----------------------------
function renderAssignmentOutput() {
  const container = document.getElementById("assignmentOutput");
  if (!container) return;

  if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

  let html = "";

  incomingNurses.forEach(nurse => {
    const pts = (nurse.patients || [])
      .map(pid => getPatientById(pid))
      .filter(p => p && !p.isEmpty)
      .sort((a, b) => getRoomNumber(a) - getRoomNumber(b));

    const loadScore = (typeof getNurseLoadScore === "function") ? getNurseLoadScore(nurse) : 0;
    const loadClass = (typeof getLoadClass === "function") ? getLoadClass(loadScore, "nurse") : "";

    const drivers = (typeof window.getRnDriversSummaryFromPatientIds === "function")
      ? window.getRnDriversSummaryFromPatientIds(nurse.patients || [])
      : "";

    const reportSources = getUniquePrevRnCount(nurse.patients || []);

    html += `
      <div class="assignment-card ${loadClass}">
        <div class="assignment-header">
          <div>
            <strong>${nurse.name}</strong> (${(nurse.type || "").toUpperCase()})
            ${drivers ? `<div style="font-size:12px;opacity:0.75;margin-top:2px;"><strong>Drivers:</strong> ${drivers}</div>` : ""}
            <div style="font-size:12px;opacity:0.75;margin-top:2px;"><strong>Report sources:</strong> ${reportSources}</div>
          </div>
          <div>Patients: ${pts.length} | Load Score: ${loadScore}</div>
        </div>

        <table class="assignment-table">
          <thead>
            <tr>
              <th>Room</th>
              <th>Level</th>
              <th>Acuity Notes</th>
              <th>Prev. RN</th>
            </tr>
          </thead>
          <tbody
            ondragover="onRowDragOver(event)"
            ondrop="onRowDrop(event, 'incoming', 'nurse', ${nurse.id})"
          >
    `;

    pts.forEach(p => {
      const prevName = getPrevRnNameForPatient(p.id);

      html += `
        <tr
          draggable="true"
          ondragstart="onRowDragStart(event, 'incoming', 'nurse', ${nurse.id}, ${p.id})"
          ondragend="onRowDragEnd(event)"
          ondblclick="openPatientProfileFromRoom(${p.id})"
        >
          <td>${p.room || ""}</td>
          <td>${p.tele ? "Tele" : "MS"}</td>
          <td>${rnTagString(p)}</td>
          <td>${prevName || "-"}</td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>
      </div>
    `;
  });

  container.innerHTML = html;
}

// -----------------------------
// PCA Oncoming Render
// -----------------------------
function renderPcaAssignmentOutput() {
  const container = document.getElementById("pcaAssignmentOutput");
  if (!container) return;

  if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

  let html = "";

  incomingPcas.forEach(pca => {
    const pts = (pca.patients || [])
      .map(pid => getPatientById(pid))
      .filter(p => p && !p.isEmpty)
      .sort((a, b) => getRoomNumber(a) - getRoomNumber(b));

    const loadScore = (typeof getPcaLoadScore === "function") ? getPcaLoadScore(pca) : 0;
    const loadClass = (typeof getLoadClass === "function") ? getLoadClass(loadScore, "pca") : "";

    const drivers = (typeof window.getPcaDriversSummaryFromPatientIds === "function")
      ? window.getPcaDriversSummaryFromPatientIds(pca.patients || [])
      : "";

    const reportSources = getUniquePrevPcaCount(pca.patients || []);

    html += `
      <div class="assignment-card ${loadClass}">
        <div class="assignment-header">
          <div>
            <strong>${pca.name}</strong> (PCA)
            ${drivers ? `<div style="font-size:12px;opacity:0.75;margin-top:2px;"><strong>Drivers:</strong> ${drivers}</div>` : ""}
            <div style="font-size:12px;opacity:0.75;margin-top:2px;"><strong>Report sources:</strong> ${reportSources}</div>
          </div>
          <div>Patients: ${pts.length} | Load Score: ${loadScore}</div>
        </div>

        <table class="assignment-table">
          <thead>
            <tr>
              <th>Room</th>
              <th>Level</th>
              <th>Acuity Notes</th>
              <th>Prev. PCA</th>
            </tr>
          </thead>
          <tbody
            ondragover="onRowDragOver(event)"
            ondrop="onRowDrop(event, 'incoming', 'pca', ${pca.id})"
          >
    `;

    pts.forEach(p => {
      const prevName = getPrevPcaNameForPatient(p.id);

      html += `
        <tr
          draggable="true"
          ondragstart="onRowDragStart(event, 'incoming', 'pca', ${pca.id}, ${p.id})"
          ondragend="onRowDragEnd(event)"
          ondblclick="openPatientProfileFromRoom(${p.id})"
        >
          <td>${p.room || ""}</td>
          <td>${p.tele ? "Tele" : "MS"}</td>
          <td>${pcaTagString(p)}</td>
          <td>${prevName || "-"}</td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>
      </div>
    `;
  });

  container.innerHTML = html;
}

// -----------------------------
// Generator (Oncoming populate + rebalance)
// -----------------------------
function populateOncomingAssignment(randomize = false) {
  if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

  if (!incomingNurses.length || !incomingPcas.length) {
    alert("Please set up ONCOMING RNs and PCAs on the Staffing Details tab first.");
    return;
  }

  const activePatients = patients.filter(p => !p.isEmpty);
  if (!activePatients.length) {
    alert("No active patients found.");
    return;
  }

  incomingNurses.forEach(n => { n.patients = []; });
  incomingPcas.forEach(p => { p.patients = []; });

  let list = activePatients.slice();
  if (randomize) list.sort(() => Math.random() - 0.5);
  else list.sort((a, b) => getRoomNumber(a) - getRoomNumber(b));

  if (typeof window.distributePatientsEvenly === "function") {
    window.distributePatientsEvenly(incomingNurses, list, { randomize });
    window.distributePatientsEvenly(incomingPcas, list, { randomize });
  } else {
    list.forEach((p, i) => {
      const n = incomingNurses[i % incomingNurses.length];
      if (!Array.isArray(n.patients)) n.patients = [];
      n.patients.push(p.id);
    });
    list.forEach((p, i) => {
      const pc = incomingPcas[i % incomingPcas.length];
      if (!Array.isArray(pc.patients)) pc.patients = [];
      pc.patients.push(p.id);
    });
  }

  renderAssignmentOutput();
  renderPcaAssignmentOutput();

  if (typeof saveState === "function") saveState();
  if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
}

function rebalanceOncomingAssignment() {
  populateOncomingAssignment(false);
}

// Expose globally
window.renderAssignmentOutput = renderAssignmentOutput;
window.renderPcaAssignmentOutput = renderPcaAssignmentOutput;
window.populateOncomingAssignment = populateOncomingAssignment;
window.rebalanceOncomingAssignment = rebalanceOncomingAssignment;

// Also expose helpers if you want to use them later
window.getPrevRnNameForPatient = getPrevRnNameForPatient;
window.getPrevPcaNameForPatient = getPrevPcaNameForPatient;