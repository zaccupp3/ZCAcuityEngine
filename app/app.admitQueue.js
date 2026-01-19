// app/app.admitQueue.js
// ---------------------------------------------------------
// Simple Admit Queue: lets you place new patients into empty beds.
//
// UPDATED (Jan 2026):
// - Does NOT create its own standalone panel anymore.
// - Renders into #queueList (mounted by LIVE page into a higher inline host).
// - If #queueList doesn't exist yet, it safely no-ops.
// - Renders admits as compact cards so they can flow horizontally.
// ---------------------------------------------------------

(function () {
  if (!Array.isArray(window.admitQueue)) {
    window.admitQueue = []; // { id, label, timestamp }
  }

  if (typeof window.__nextQueueId !== "number") window.__nextQueueId = 1;

  function safeArray(v) { return Array.isArray(v) ? v : []; }
  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function addToAdmitQueue(label = "New Admit") {
    window.admitQueue.push({
      id: Number(window.__nextQueueId++) || Date.now(),
      label,
      timestamp: Date.now()
    });
    renderQueueList();
    try { if (typeof window.saveState === "function") window.saveState(); } catch (_) {}
  }

  function removeFromAdmitQueue(queueId) {
    window.admitQueue = safeArray(window.admitQueue).filter(q => Number(q.id) !== Number(queueId));
    renderQueueList();
    try { if (typeof window.saveState === "function") window.saveState(); } catch (_) {}
  }

  function getEmptyBeds() {
    if (!Array.isArray(window.patients)) return [];
    return safeArray(window.patients)
      .filter(p => p && !!p.isEmpty)
      .sort((a, b) => {
        try { return window.getRoomNumber(a) - window.getRoomNumber(b); }
        catch { return (Number(a?.id) || 0) - (Number(b?.id) || 0); }
      });
  }

  function admitToBed(queueId, patientId) {
    const q = safeArray(window.admitQueue).find(x => Number(x.id) === Number(queueId));
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!q || !p) return;

    // Mark bed occupied + set baseline
    p.isEmpty = false;
    p.recentlyDischarged = false;
    p.admit = true;

    // Remove from queue
    removeFromAdmitQueue(queueId);

    // Re-render everything
    try { if (typeof window.renderPatientList === "function") window.renderPatientList(); } catch (_) {}
    try { if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles(); } catch (_) {}
    try { if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments(); } catch (_) {}
    try { if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput(); } catch (_) {}
    try { if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput(); } catch (_) {}
    try { if (typeof window.saveState === "function") window.saveState(); } catch (_) {}
  }

  function renderQueueList() {
    const el = document.getElementById("queueList");
    if (!el) return;

    const queue = safeArray(window.admitQueue);
    const empties = getEmptyBeds();

    // Ensure the container is "card lane" friendly even without CSS
    el.style.display = "flex";
    el.style.flexDirection = "row";
    el.style.flexWrap = "nowrap";
    el.style.gap = "10px";
    el.style.overflowX = "auto";
    el.style.paddingBottom = "6px";

    if (!queue.length) {
      el.innerHTML = `<div style="padding:6px 0;opacity:0.7;">No admits in queue.</div>`;
      return;
    }

    el.innerHTML = queue.map(q => {
      const options = empties.map(b => {
        const label = String(b?.room || b?.id || "");
        return `<option value="${Number(b.id)}">${escapeHtml(label)}</option>`;
      }).join("");

      const disabled = empties.length ? "" : "disabled";

      return `
        <div class="queue-item" style="
          flex: 0 0 260px;
          max-width: 260px;
          padding: 10px 10px;
          border-radius: 12px;
          border: 1px solid rgba(15,23,42,0.10);
          background: rgba(255,255,255,0.92);
          box-shadow: 0 6px 18px rgba(0,0,0,.08);
        ">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
            <div style="font-weight:900;">${escapeHtml(q.label || "New Admit")}</div>
            <button
              style="padding:6px 8px;border:1px solid rgba(15,23,42,0.15);border-radius:10px;cursor:pointer;"
              onclick="window.removeFromAdmitQueue(${Number(q.id)})"
              title="Remove"
            >✕</button>
          </div>

          <div style="font-size:12px;opacity:0.7;margin-top:4px;">
            ${new Date(q.timestamp).toLocaleString()}
          </div>

          <div style="display:flex;gap:8px;align-items:center;margin-top:10px;">
            <select id="admitBedSel_${Number(q.id)}" ${disabled}
              style="flex:1;padding:8px 10px;border:1px solid rgba(15,23,42,0.15);border-radius:10px;">
              ${options || `<option value="">No empty beds</option>`}
            </select>

            <button ${disabled}
              style="padding:8px 10px;border:0;border-radius:10px;cursor:pointer;font-weight:900;background:#111;color:#fff;"
              onclick="(function(){
                const sel = document.getElementById('admitBedSel_${Number(q.id)}');
                if(!sel || !sel.value) return;
                window.admitToBed(${Number(q.id)}, Number(sel.value));
              })()"
            >Admit →</button>
          </div>
        </div>
      `;
    }).join("");
  }

  // Expose (canonical)
  window.addToAdmitQueue = addToAdmitQueue;
  window.renderQueueList = renderQueueList;
  window.admitToBed = admitToBed;
  window.removeFromAdmitQueue = removeFromAdmitQueue;
})();