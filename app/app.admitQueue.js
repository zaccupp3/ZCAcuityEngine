// app/app.admitQueue.js
// Simple Admit Queue: lets you place new patients into empty beds.

if (!Array.isArray(window.admitQueue)) {
  window.admitQueue = []; // { id, label, timestamp }
}

let nextQueueId = 1;

function addToAdmitQueue(label = "New Admit") {
  window.admitQueue.push({
    id: nextQueueId++,
    label,
    timestamp: Date.now()
  });
  renderQueueList();
  if (typeof saveState === "function") saveState();
}

function removeFromAdmitQueue(queueId) {
  window.admitQueue = window.admitQueue.filter(q => q.id !== queueId);
  renderQueueList();
  if (typeof saveState === "function") saveState();
}

function getEmptyBeds() {
  if (!Array.isArray(window.patients)) return [];
  return window.patients
    .filter(p => !!p.isEmpty)
    .sort((a, b) => window.getRoomNumber(a) - window.getRoomNumber(b));
}

function admitToBed(queueId, patientId) {
  const q = window.admitQueue.find(x => x.id === queueId);
  const p = window.getPatientById(patientId);
  if (!q || !p) return;

  // Mark bed occupied + set baseline (optional: set admit tag)
  p.isEmpty = false;
  p.recentlyDischarged = false;
  p.admit = true;

  // Remove from queue
  removeFromAdmitQueue(queueId);

  // Re-render everything
  if (typeof window.renderPatientList === "function") window.renderPatientList();
  if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
  if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
  if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
  if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
  if (typeof saveState === "function") saveState();
}

function renderQueueList() {
  const el = document.getElementById("queueList");
  if (!el) return;

  const queue = Array.isArray(window.admitQueue) ? window.admitQueue : [];
  const empties = getEmptyBeds();

  if (!queue.length) {
    el.innerHTML = `<div style="padding:10px;opacity:0.7;">No admits in queue.</div>`;
    return;
  }

  el.innerHTML = queue.map(q => {
    // Build dropdown of empty beds
    const options = empties.map(b => `<option value="${b.id}">${b.room}</option>`).join("");
    const disabled = empties.length ? "" : "disabled";

    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #eee;">
        <div style="flex:1;">
          <div><strong>${q.label}</strong></div>
          <div style="font-size:12px;opacity:0.7;">${new Date(q.timestamp).toLocaleString()}</div>
        </div>

        <select id="admitBedSel_${q.id}" ${disabled} style="min-width:120px;">
          ${options || `<option value="">No empty beds</option>`}
        </select>

        <button ${disabled} onclick="
          (function(){
            const sel = document.getElementById('admitBedSel_${q.id}');
            if(!sel || !sel.value) return;
            admitToBed(${q.id}, Number(sel.value));
          })()
        ">Admit →</button>

        <button onclick="removeFromAdmitQueue(${q.id})">Remove</button>
      </div>
    `;
  }).join("");
}

// Expose
window.addToAdmitQueue = addToAdmitQueue;
window.renderQueueList = renderQueueList;
window.admitToBed = admitToBed;
window.removeFromAdmitQueue = removeFromAdmitQueue;
