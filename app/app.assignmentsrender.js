// app/app.assignmentsrender.js
// ---------------------------------------------------------
// Rendering + generator for Oncoming (incoming) assignments ONLY
// ---------------------------------------------------------

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

    html += `
      <div class="assignment-card ${loadClass}">
        <div class="assignment-header">
          <div>
            <strong>${nurse.name}</strong> (${(nurse.type || "").toUpperCase()})
            ${drivers ? `<div style="font-size:12px;opacity:0.75;margin-top:2px;"><strong>Drivers:</strong> ${drivers}</div>` : ""}
          </div>
          <div>Patients: ${pts.length} | Load Score: ${loadScore}</div>
        </div>
        <table class="assignment-table">
          <thead>
            <tr>
              <th>Room</th>
              <th>Level</th>
              <th>Acuity Notes</th>
            </tr>
          </thead>
          <tbody
            ondragover="onRowDragOver(event)"
            ondrop="onRowDrop(event, 'incoming', 'nurse', ${nurse.id})"
          >
    `;

    pts.forEach(p => {
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

    html += `
      <div class="assignment-card ${loadClass}">
        <div class="assignment-header">
          <div>
            <strong>${pca.name}</strong> (PCA)
            ${drivers ? `<div style="font-size:12px;opacity:0.75;margin-top:2px;"><strong>Drivers:</strong> ${drivers}</div>` : ""}
          </div>
          <div>Patients: ${pts.length} | Load Score: ${loadScore}</div>
        </div>
        <table class="assignment-table">
          <thead>
            <tr>
              <th>Room</th>
              <th>Level</th>
              <th>Acuity Notes</th>
            </tr>
          </thead>
          <tbody
            ondragover="onRowDragOver(event)"
            ondrop="onRowDrop(event, 'incoming', 'pca', ${pca.id})"
          >
    `;

    pts.forEach(p => {
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
    window.distributePatientsEvenly(incomingNurses, list, { randomize, role: "nurse" });
    window.distributePatientsEvenly(incomingPcas, list, { randomize, role: "pca" });
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