// app/app.queue.js
// Admit Queue rendering + assign-admit-to-empty-bed lifecycle

function renderQueueList() {
  const el = document.getElementById("queueList");
  if (!el) return;

  const q = Array.isArray(window.admitQueue) ? window.admitQueue : [];

  if (!q.length) {
    el.innerHTML = `<div style="opacity:.7;padding:8px;">No admits in queue.</div>`;
    return;
  }

  el.innerHTML = q.map(item => {
    const t = item.createdAt ? new Date(item.createdAt).toLocaleTimeString() : "";
    return `
      <div class="queue-item" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px;border:1px solid #eee;border-radius:8px;margin-bottom:8px;">
        <div>
          <div><strong>${item.label || "Admit"}</strong></div>
          <div style="font-size:12px;opacity:.7;">${t}</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button onclick="window.assignAdmitFromQueue(${item.id})">Assign to Empty Bed</button>
          <button onclick="window.removeFromAdmitQueue(${item.id})" style="opacity:.8;">Remove</button>
        </div>
      </div>
    `;
  }).join("");
}

// Pick an empty bed and activate it for an admit.
// Minimal version: choose the first empty bed in room order.
// (Later: we can do a modal to select which room.)
function assignAdmitFromQueue(queueId) {
  if (!Array.isArray(window.admitQueue)) return;

  const item = window.admitQueue.find(x => x.id === queueId);
  if (!item) return;

  if (!Array.isArray(window.patients)) return;

  // Must be truly empty (isEmpty === true). We also ignore recently discharged
  // only if you want to block those; typically you WANT to allow re-occupy.
  const empties = window.patients
    .filter(p => p && p.isEmpty)
    .sort((a, b) => window.getRoomNumber(a) - window.getRoomNumber(b));

  if (!empties.length) {
    alert("No empty beds available. Discharge a patient or mark a room empty first.");
    return;
  }

  const bed = empties[0];

  // Activate bed with an Admit flag
  bed.isEmpty = false;
  bed.recentlyDischarged = false;
  bed.admit = true;

  // Optional: clear gender for new admit until assigned
  // bed.gender = "";

  // Remove from queue
  window.removeFromAdmitQueue(queueId);

  if (typeof window.saveState === "function") window.saveState();
  if (typeof window.renderPatientList === "function") window.renderPatientList();
  if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
  if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
  if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
  if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();

  // Optionally re-run LIVE assignment to include the new admit automatically:
  // if (typeof window.populateLiveAssignment === "function") window.populateLiveAssignment(false);
}

window.renderQueueList = renderQueueList;
window.assignAdmitFromQueue = assignAdmitFromQueue;
