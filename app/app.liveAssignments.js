// app/app.liveAssignments.js
// ---------------------------------------------------------
// LIVE Assignment engine + rendering (Current shift only)
// ---------------------------------------------------------

(function () {
  function syncWindowRefs() {
    // Keep window.* synchronized with legacy bare globals
    // (prevents refresh/other modules from reading stale refs)
    window.currentNurses = currentNurses;
    window.currentPcas = currentPcas;
    window.patients = patients;
  }

  function getActivePatientsForLive() {
    if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();
    // LIVE includes everyone not empty. (recentlyDischarged should be handled by isEmpty)
    return (window.patients || patients || []).filter((p) => p && !p.isEmpty);
  }

  function populateLiveAssignment(randomize = false) {
    if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

    if (
      !Array.isArray(currentNurses) ||
      !currentNurses.length ||
      !Array.isArray(currentPcas) ||
      !currentPcas.length
    ) {
      alert("Please set up Current RNs and PCAs on the Staffing Details tab first.");
      return;
    }

    const activePatients = getActivePatientsForLive();
    if (!activePatients.length) {
      alert("No active patients found.");
      return;
    }

    let list = activePatients.slice();
    if (randomize) list.sort(() => Math.random() - 0.5);
    else list.sort((a, b) => getRoomNumber(a) - getRoomNumber(b));

    // Clear existing assignments (MUTATION)
    currentNurses.forEach((n) => {
      n.patients = [];
    });
    currentPcas.forEach((p) => {
      p.patients = [];
    });

    // Prefer shared helper (now load-aware)
    if (typeof window.distributePatientsEvenly === "function") {
      window.distributePatientsEvenly(currentNurses, list, { randomize, role: "nurse" });
      window.distributePatientsEvenly(currentPcas, list, { randomize, role: "pca" });
    } else {
      // Fallback round-robin
      list.forEach((p, i) => {
        const rn = currentNurses[i % currentNurses.length];
        if (!Array.isArray(rn.patients)) rn.patients = [];
        rn.patients.push(p.id);
      });
      list.forEach((p, i) => {
        const pc = currentPcas[i % currentPcas.length];
        if (!Array.isArray(pc.patients)) pc.patients = [];
        pc.patients.push(p.id);
      });
    }

    // ✅ critical: keep window refs aligned before saving/rerendering
    syncWindowRefs();

    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.saveState === "function") window.saveState();
    if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();

    // Optional debug
    try {
      console.log("LIVE populate complete", {
        activePatients: list.length,
        rnAssigned: new Set(currentNurses.flatMap((n) => n.patients || [])).size,
        pcaAssigned: new Set(currentPcas.flatMap((p) => p.patients || [])).size,
      });
    } catch {}
  }

  function renderLiveAssignments() {
    const nurseContainer = document.getElementById("liveNurseAssignments");
    const pcaContainer = document.getElementById("livePcaAssignments");
    if (!nurseContainer || !pcaContainer) return;

    // Clear containers
    nurseContainer.innerHTML = "";
    pcaContainer.innerHTML = "";

    // ---- RNs ----
    currentNurses.forEach((nurse) => {
      const pts = (nurse.patients || [])
        .map((id) => getPatientById(id))
        .filter((p) => p && !p.isEmpty)
        .sort((a, b) => getRoomNumber(a) - getRoomNumber(b));

      const loadScore = typeof getNurseLoadScore === "function" ? getNurseLoadScore(nurse) : 0;
      const loadClass = typeof getLoadClass === "function" ? getLoadClass(loadScore, "nurse") : "";

      let rows = "";
      pts.forEach((p) => {
        rows += `
          <tr
            draggable="true"
            ondragstart="onRowDragStart(event, 'live', 'nurse', ${nurse.id}, ${p.id})"
            ondragend="onRowDragEnd(event)"
            ondblclick="openPatientProfileFromRoom(${p.id})"
          >
            <td>${p.room || ""}</td>
            <td>${p.tele ? "Tele" : "MS"}</td>
            <td>${rnTagString(p)}</td>
          </tr>
        `;
      });

      nurseContainer.innerHTML += `
        <div class="assignment-card ${loadClass}">
          <div class="assignment-header">
            <div><strong>${nurse.name}</strong> (${(nurse.type || "").toUpperCase()})</div>
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
              ondrop="onRowDrop(event, 'live', 'nurse', ${nurse.id})"
            >
              ${rows}
            </tbody>
          </table>
        </div>
      `;
    });

    // ✅ Always append the 9th slot placeholder AFTER RN cards render
    nurseContainer.innerHTML += `<div id="rnGridSlot9" class="rn-grid-slot-9"></div>`;

    // ✅ Inject discharge card into slot 9
    if (typeof window.ensureDischargeBinInRnGrid === "function") {
      window.ensureDischargeBinInRnGrid();
    } else {
      // fallback inline injection if helper isn't defined elsewhere
      const slot = document.getElementById("rnGridSlot9");
      if (slot && !document.getElementById("dischargeBinCard")) {
        slot.innerHTML = `
          <div id="dischargeBinCard" class="assignment-card discharge-card">
            <div class="assignment-header discharge-card-header">
              <div><strong>Discharge Bin</strong></div>
              <button onclick="clearRecentlyDischargedFlags()">Clear “Recently Discharged” Flags</button>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;">
              <div><strong>Recent:</strong> <span id="dischargeCount">0</span> this session</div>
              <button onclick="openDischargeHistoryModal()">View History</button>
            </div>

            <div
              id="dischargeDropZone"
              class="discharge-drop-zone"
              ondragover="onDischargeDragOver(event)"
              ondrop="onDischargeDrop(event)"
              style="margin:0 12px 12px 12px;"
            >
              Drag here to discharge patient
            </div>
          </div>
        `;
      }
    }

    // ---- PCAs ----
    currentPcas.forEach((pca) => {
      const pts = (pca.patients || [])
        .map((id) => getPatientById(id))
        .filter((p) => p && !p.isEmpty)
        .sort((a, b) => getRoomNumber(a) - getRoomNumber(b));

      const loadScore = typeof getPcaLoadScore === "function" ? getPcaLoadScore(pca) : 0;
      const loadClass = typeof getLoadClass === "function" ? getLoadClass(loadScore, "pca") : "";

      let rows = "";
      pts.forEach((p) => {
        rows += `
          <tr
            draggable="true"
            ondragstart="onRowDragStart(event, 'live', 'pca', ${pca.id}, ${p.id})"
            ondragend="onRowDragEnd(event)"
            ondblclick="openPatientProfileFromRoom(${p.id})"
          >
            <td>${p.room || ""}</td>
            <td>${p.tele ? "Tele" : "MS"}</td>
            <td>${pcaTagString(p)}</td>
          </tr>
        `;
      });

      pcaContainer.innerHTML += `
        <div class="assignment-card ${loadClass}">
          <div class="assignment-header">
            <div><strong>${pca.name}</strong> (PCA)</div>
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
              ondrop="onRowDrop(event, 'live', 'pca', ${pca.id})"
            >
              ${rows}
            </tbody>
          </table>
        </div>
      `;
    });

    if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
  }

  function autoPopulateLiveAssignments() {
    if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

    const anyAssigned =
      currentNurses.some((n) => (n.patients || []).length > 0) ||
      currentPcas.some((p) => (p.patients || []).length > 0);

    if (anyAssigned) return;

    const activePatients = (window.patients || patients || []).filter((p) => p && !p.isEmpty);
    if (!activePatients.length) return;

    populateLiveAssignment(false);
  }

  // Expose globals
  window.populateLiveAssignment = populateLiveAssignment;
  window.autoPopulateLiveAssignments = autoPopulateLiveAssignments;
  window.renderLiveAssignments = renderLiveAssignments;
})();