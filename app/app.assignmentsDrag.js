// app/app.assignmentsDrag.js
// ---------------------------------------------------------
// Drag & drop + Discharge Bin + Discharge History modal
// Works for LIVE and Oncoming (incoming)
// ---------------------------------------------------------

let dragCtx = null; // { context: 'live'|'incoming', role: 'nurse'|'pca', ownerId, patientId }

// -----------------------------
// Helpers
// -----------------------------

function getStaffArray(context, role) {
  if (context === "live") return role === "nurse" ? currentNurses : currentPcas;
  return role === "nurse" ? incomingNurses : incomingPcas;
}

function findOwner(context, role, ownerId) {
  const arr = getStaffArray(context, role);
  return (arr || []).find(o => o.id === ownerId) || null;
}

function ensureArray(obj, key) {
  if (!obj) return;
  if (!Array.isArray(obj[key])) obj[key] = [];
}

// Central refresh (preferred). Falls back to local rerender list if not defined.
function rerenderAllBoards() {
  if (typeof window.refreshUI === "function") {
    window.refreshUI();
    return;
  }

  // Fallback (older versions)
  if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
  if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
  if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
  if (typeof window.renderPatientList === "function") window.renderPatientList();
  if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
  if (typeof saveState === "function") saveState();
  if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
}

// -----------------------------
// ROW DRAG / DROP
// -----------------------------

function onRowDragStart(event, context, role, ownerId, patientId) {
  dragCtx = { context, role, ownerId, patientId };
  if (event && event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(patientId));
  }
}

function onRowDragOver(event) {
  if (!dragCtx) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function onRowDrop(event, context, role, newOwnerId) {
  event.preventDefault();
  if (!dragCtx) return;

  if (dragCtx.context !== context || dragCtx.role !== role) {
    dragCtx = null;
    return;
  }

  const fromOwner = findOwner(dragCtx.context, dragCtx.role, dragCtx.ownerId);
  const toOwner = findOwner(context, role, newOwnerId);
  if (!fromOwner || !toOwner) {
    dragCtx = null;
    return;
  }

  ensureArray(fromOwner, "patients");
  ensureArray(toOwner, "patients");

  const pid = dragCtx.patientId;

  const idx = fromOwner.patients.indexOf(pid);
  if (idx !== -1) fromOwner.patients.splice(idx, 1);
  if (!toOwner.patients.includes(pid)) toOwner.patients.push(pid);

  dragCtx = null;
  rerenderAllBoards();
}

function onRowDragEnd() {
  dragCtx = null;
}

// -----------------------------
// DISCHARGE BIN
// -----------------------------

if (!Array.isArray(window.dischargeHistory)) window.dischargeHistory = [];

function updateDischargeCount() {
  const el = document.getElementById("dischargeCount");
  if (!el) return;
  el.textContent = Array.isArray(window.dischargeHistory) ? window.dischargeHistory.length : 0;
}

function onDischargeDragOver(event) {
  if (!dragCtx) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function onDischargeDrop(event) {
  event.preventDefault();
  if (!dragCtx) return;

  if (dragCtx.context !== "live") {
    dragCtx = null;
    return;
  }

  const { patientId } = dragCtx;

  // Capture BOTH RN and PCA assignments at discharge time
  const rnOwner =
    currentNurses.find(n => Array.isArray(n.patients) && n.patients.includes(patientId)) || null;
  const pcOwner =
    currentPcas.find(p => Array.isArray(p.patients) && p.patients.includes(patientId)) || null;

  // Remove from BOTH lists
  if (rnOwner) {
    ensureArray(rnOwner, "patients");
    const idx = rnOwner.patients.indexOf(patientId);
    if (idx !== -1) rnOwner.patients.splice(idx, 1);
  }
  if (pcOwner) {
    ensureArray(pcOwner, "patients");
    const idx = pcOwner.patients.indexOf(patientId);
    if (idx !== -1) pcOwner.patients.splice(idx, 1);
  }

  const patient = getPatientById(patientId);
  if (patient) {
    patient.recentlyDischarged = true;
    patient.isEmpty = true;
  }

  window.dischargeHistory.unshift({
    patientId,
    nurseId: rnOwner ? rnOwner.id : null,
    pcaId: pcOwner ? pcOwner.id : null,
    timestamp: Date.now()
  });

  dragCtx = null;
  rerenderAllBoards();
}

// -----------------------------
// DISCHARGE HISTORY MODAL
// -----------------------------

function openDischargeHistoryModal() {
  const modal = document.getElementById("dischargeHistoryModal");
  const body = document.getElementById("dischargeHistoryBody");
  if (!modal || !body) return;

  const history = Array.isArray(window.dischargeHistory) ? window.dischargeHistory : [];

  if (!history.length) {
    body.innerHTML = `<div style="padding:10px;opacity:0.7;">No discharges yet.</div>`;
  } else {
    let html = "";
    history.forEach((entry, i) => {
      const p = getPatientById(entry.patientId);
      if (!p) return;
      const t = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "";

      html += `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #eee;">
          <div>
            <div><strong>${p.room || ""}</strong> ${p.name ? ` - ${p.name}` : ""}</div>
            <div style="font-size:12px;opacity:0.75;">${t}</div>
          </div>
          <button onclick="window.reinstateDischargedPatient(${i})">Reinstate</button>
        </div>
      `;
    });
    body.innerHTML = html;
  }

  modal.style.display = "flex";
}

function closeDischargeHistoryModal() {
  const modal = document.getElementById("dischargeHistoryModal");
  if (modal) modal.style.display = "none";
}

// -----------------------------
// REINSTATE
// -----------------------------

function reinstateDischargedPatient(index) {
  const history = window.dischargeHistory;
  if (!Array.isArray(history)) return;
  if (index < 0 || index >= history.length) return;

  const entry = history[index];
  const patient = getPatientById(entry.patientId);

  if (!patient) {
    history.splice(index, 1);
    if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
    openDischargeHistoryModal();
    return;
  }

  patient.isEmpty = false;
  patient.recentlyDischarged = false;

  if (entry.nurseId != null) {
    const n = currentNurses.find(v => v.id === entry.nurseId);
    if (n) {
      ensureArray(n, "patients");
      if (!n.patients.includes(patient.id)) n.patients.push(patient.id);
    }
  }

  if (entry.pcaId != null) {
    const pc = currentPcas.find(v => v.id === entry.pcaId);
    if (pc) {
      ensureArray(pc, "patients");
      if (!pc.patients.includes(patient.id)) pc.patients.push(patient.id);
    }
  }

  history.splice(index, 1);
  if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();

  rerenderAllBoards();
  openDischargeHistoryModal();
}

// -----------------------------
// Expose handlers globally
// -----------------------------
window.onRowDragStart = onRowDragStart;
window.onRowDragOver = onRowDragOver;
window.onRowDrop = onRowDrop;
window.onRowDragEnd = onRowDragEnd;

window.onDischargeDragOver = onDischargeDragOver;
window.onDischargeDrop = onDischargeDrop;

window.updateDischargeCount = updateDischargeCount;
window.openDischargeHistoryModal = openDischargeHistoryModal;
window.closeDischargeHistoryModal = closeDischargeHistoryModal;
window.reinstateDischargedPatient = reinstateDischargedPatient;