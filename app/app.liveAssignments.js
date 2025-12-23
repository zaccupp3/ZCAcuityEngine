// app/app.liveAssignments.js
// ---------------------------------------------------------
// LIVE Assignment engine + rendering (Current shift only)
//
// Adds:
// - ! rule flag icon (yellow warning vs red violation) based on hard-rule checks
//   Hover shows EXACT rule(s) that are stacked + counts.
// - ✅ Empty-owner drop zones (RN + PCA):
//   If an owner has 0 patients, show a visible "Drop here" zone
//   so the owner can receive patients again.
// - ✅ Discharge Bin restored (slot 9 fallback injection)
//
// Depends on:
// - window.evaluateAssignmentHardRules (app.assignmentRules.js)
// - Drag handlers in app/app.assignmentsDrag.js:
//   onRowDragStart / onRowDragEnd / onRowDragOver / onRowDrop
// - Discharge handlers (wherever you defined them):
//   onDischargeDragOver / onDischargeDrop / clearRecentlyDischargedFlags / openDischargeHistoryModal
// ---------------------------------------------------------

(function () {
  // -----------------------------
  // Small utils (safe + no deps)
  // -----------------------------
  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function safeArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function getRoomNumberSafe(p) {
    try {
      if (typeof window.getRoomNumber === "function") return window.getRoomNumber(p);
    } catch {}
    const m = String(p?.room || "").match(/(\d+)/);
    return m ? Number(m[1]) : 9999;
  }

  function getPatientByIdSafe(id) {
    try {
      if (typeof window.getPatientById === "function") return window.getPatientById(id);
    } catch {}
    return null;
  }

  function getActivePatientsForLive() {
    try { if (typeof window.ensureDefaultPatients === "function") window.ensureDefaultPatients(); } catch {}
    return safeArray(window.patients).filter(p => p && !p.isEmpty);
  }

  // -----------------------------
  // Rule flag helpers
  // -----------------------------
  function getRuleEvalMap(ownersAll, role) {
    try {
      if (typeof window.evaluateAssignmentHardRules === "function") {
        return window.evaluateAssignmentHardRules(ownersAll, role);
      }
    } catch (e) {
      console.warn("[live rules] evaluateAssignmentHardRules failed", e);
    }
    return null;
  }

  function getOwnerEval(owner, evalMap) {
    if (!owner || !evalMap) return null;

    const key = owner?.name || owner?.label || null;
    if (key && evalMap[key]) return evalMap[key];

    if (key) {
      const keys = Object.keys(evalMap);
      const found = keys.find(k => String(k).toLowerCase() === String(key).toLowerCase());
      if (found) return evalMap[found];
    }

    return null;
  }

  function buildRuleTitle(ownerEval, roleLabel) {
    if (!ownerEval) return "";

    const v = safeArray(ownerEval.violations);
    const w = safeArray(ownerEval.warnings);
    if (!v.length && !w.length) return "";

    const parts = [];
    if (v.length) parts.push(`Avoidable rule breaks (${v.length})`);
    if (w.length) parts.push(`Unavoidable stacks (${w.length})`);

    const detail = [];
    v.forEach(x => {
      const line = x?.message || `${roleLabel} rule: ${x?.tag} stacked (${x?.mine} > ${x?.limit})`;
      detail.push(line);
    });
    w.forEach(x => {
      const line = x?.message || `${roleLabel} stack (likely unavoidable): ${x?.tag} (${x?.mine} > ${x?.limit})`;
      detail.push(line);
    });

    const header = parts.join(" • ");
    const body = detail.length ? ` • ${detail.join(" • ")}` : "";
    return `${header}${body}`;
  }

  function buildRuleIconHtml(ownerEval, roleLabel) {
    if (!ownerEval) return "";

    const v = safeArray(ownerEval.violations);
    const w = safeArray(ownerEval.warnings);
    if (!v.length && !w.length) return "";

    const cls = v.length ? "flag-bad" : "flag-warn";
    const title = buildRuleTitle(ownerEval, roleLabel);
    return `<button class="icon-btn ${cls}" type="button" title="${escapeHtml(title)}">!</button>`;
  }

  // -----------------------------
  // ✅ Empty-owner drop zone (LIVE)
  // -----------------------------
  function buildEmptyDropZoneHtml(boardKey, role, ownerId, label) {
    return `
      <div
        class="empty-live-drop"
        ondragover="onRowDragOver(event)"
        ondrop="onRowDrop(event, '${boardKey}', '${role}', ${Number(ownerId)})"
        style="
          margin:10px 12px 12px 12px;
          padding:14px 12px;
          border:1px dashed rgba(15,23,42,0.25);
          border-radius:12px;
          text-align:center;
          font-size:12px;
          opacity:0.75;
          user-select:none;
        "
        title="Drop a patient here"
      >
        Drop a patient here to assign to this ${escapeHtml(label)}
      </div>
    `;
  }

  // -----------------------------
  // ✅ Discharge Bin injection fallback
  // -----------------------------
  function injectDischargeBinFallback() {
    const slot = document.getElementById("rnGridSlot9");
    if (!slot) return;

    if (document.getElementById("dischargeBinCard")) return;

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

  // -----------------------------
  // Live populate
  // -----------------------------
  function populateLiveAssignment(randomize = false) {
    try { if (typeof window.ensureDefaultPatients === "function") window.ensureDefaultPatients(); } catch {}

    const currentNurses = safeArray(window.currentNurses);
    const currentPcas = safeArray(window.currentPcas);

    if (!currentNurses.length || !currentPcas.length) {
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
    else list.sort((a, b) => getRoomNumberSafe(a) - getRoomNumberSafe(b));

    currentNurses.forEach(n => { n.patients = []; });
    currentPcas.forEach(p => { p.patients = []; });

    if (typeof window.distributePatientsEvenly === "function") {
      window.distributePatientsEvenly(currentNurses, list, { randomize, role: "nurse" });
      window.distributePatientsEvenly(currentPcas, list, { randomize, role: "pca" });
    } else {
      list.forEach((p, i) => {
        const rn = currentNurses[i % currentNurses.length];
        rn.patients = safeArray(rn.patients);
        rn.patients.push(p.id);
      });
      list.forEach((p, i) => {
        const pc = currentPcas[i % currentPcas.length];
        pc.patients = safeArray(pc.patients);
        pc.patients.push(p.id);
      });
    }

    window.currentNurses = currentNurses;
    window.currentPcas = currentPcas;

    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    try { if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles(); } catch {}
    try { if (typeof window.renderPatientList === "function") window.renderPatientList(); } catch {}
    try { if (typeof window.saveState === "function") window.saveState(); } catch {}
    try { if (typeof window.updateDischargeCount === "function") window.updateDischargeCount(); } catch {}
  }

  // -----------------------------
  // Live render
  // -----------------------------
  function renderLiveAssignments() {
    const nurseContainer = document.getElementById("liveNurseAssignments");
    const pcaContainer = document.getElementById("livePcaAssignments");
    if (!nurseContainer || !pcaContainer) return;

    const currentNurses = safeArray(window.currentNurses);
    const currentPcas = safeArray(window.currentPcas);

    nurseContainer.innerHTML = "";
    pcaContainer.innerHTML = "";

    const rnEvalMap = getRuleEvalMap(currentNurses, "nurse");
    const pcaEvalMap = getRuleEvalMap(currentPcas, "pca");

    // ---- RNs ----
    currentNurses.forEach((nurse) => {
      const pts = safeArray(nurse.patients)
        .map(id => getPatientByIdSafe(id))
        .filter(p => p && !p.isEmpty)
        .sort((a, b) => getRoomNumberSafe(a) - getRoomNumberSafe(b));

      const loadScore = (typeof window.getNurseLoadScore === "function") ? window.getNurseLoadScore(nurse) : 0;
      const loadClass = (typeof window.getLoadClass === "function") ? window.getLoadClass(loadScore, "nurse") : "";

      const ownerEval = getOwnerEval(nurse, rnEvalMap);
      const ruleIcon = buildRuleIconHtml(ownerEval, "RN");

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
            <td>${typeof window.rnTagString === "function" ? window.rnTagString(p) : ""}</td>
          </tr>
        `;
      });

      const emptyDrop = (!pts.length)
        ? buildEmptyDropZoneHtml("live", "nurse", nurse.id, "RN")
        : "";

      nurseContainer.innerHTML += `
        <div class="assignment-card ${loadClass}">
          <div class="assignment-header">
            <div style="display:flex;align-items:flex-start;gap:10px;">
              <div>
                <strong>${nurse.name}</strong> (${String(nurse.type || "").toUpperCase()})
              </div>
              <div class="icon-row">
                ${ruleIcon}
              </div>
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
              ondrop="onRowDrop(event, 'live', 'nurse', ${nurse.id})"
            >
              ${rows}
            </tbody>
          </table>

          ${emptyDrop}
        </div>
      `;
    });

    // ✅ Always append the 9th slot placeholder AFTER RN cards render
    nurseContainer.innerHTML += `<div id="rnGridSlot9" class="rn-grid-slot-9"></div>`;

    // ✅ Try the official helper first (if present)
    if (typeof window.ensureDischargeBinInRnGrid === "function") {
      try {
        window.ensureDischargeBinInRnGrid();
      } catch (e) {
        console.warn("[discharge] ensureDischargeBinInRnGrid failed, using fallback", e);
        injectDischargeBinFallback();
      }
    } else {
      // ✅ Fallback injection (restores your old behavior)
      injectDischargeBinFallback();
    }

    // ---- PCAs ----
    currentPcas.forEach((pca) => {
      const pts = safeArray(pca.patients)
        .map(id => getPatientByIdSafe(id))
        .filter(p => p && !p.isEmpty)
        .sort((a, b) => getRoomNumberSafe(a) - getRoomNumberSafe(b));

      const loadScore = (typeof window.getPcaLoadScore === "function") ? window.getPcaLoadScore(pca) : 0;
      const loadClass = (typeof window.getLoadClass === "function") ? window.getLoadClass(loadScore, "pca") : "";

      const ownerEval = getOwnerEval(pca, pcaEvalMap);
      const ruleIcon = buildRuleIconHtml(ownerEval, "PCA");

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
            <td>${typeof window.pcaTagString === "function" ? window.pcaTagString(p) : ""}</td>
          </tr>
        `;
      });

      const emptyDrop = (!pts.length)
        ? buildEmptyDropZoneHtml("live", "pca", pca.id, "PCA")
        : "";

      pcaContainer.innerHTML += `
        <div class="assignment-card ${loadClass}">
          <div class="assignment-header">
            <div style="display:flex;align-items:flex-start;gap:10px;">
              <div>
                <strong>${pca.name}</strong> (PCA)
              </div>
              <div class="icon-row">
                ${ruleIcon}
              </div>
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
              ondrop="onRowDrop(event, 'live', 'pca', ${pca.id})"
            >
              ${rows}
            </tbody>
          </table>

          ${emptyDrop}
        </div>
      `;
    });

    try { if (typeof window.updateDischargeCount === "function") window.updateDischargeCount(); } catch {}
  }

  function autoPopulateLiveAssignments() {
    try { if (typeof window.ensureDefaultPatients === "function") window.ensureDefaultPatients(); } catch {}

    const currentNurses = safeArray(window.currentNurses);
    const currentPcas = safeArray(window.currentPcas);

    const anyAssigned =
      currentNurses.some(n => safeArray(n.patients).length > 0) ||
      currentPcas.some(p => safeArray(p.patients).length > 0);

    if (anyAssigned) return;

    const activePatients = safeArray(window.patients).filter(p => p && !p.isEmpty);
    if (!activePatients.length) return;

    populateLiveAssignment(false);
  }

  // Expose globals
  window.populateLiveAssignment = populateLiveAssignment;
  window.autoPopulateLiveAssignments = autoPopulateLiveAssignments;
  window.renderLiveAssignments = renderLiveAssignments;

  // Signature to verify the correct file is loaded
  window.__liveAssignmentsBuild = "emptyDropZone+dischargeBinFallback-v2";
})();