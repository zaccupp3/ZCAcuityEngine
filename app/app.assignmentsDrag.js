// app/app.assignmentsDrag.js
// ---------------------------------------------------------
// Drag & drop + Discharge Bin + Discharge History modal
// Works for LIVE and Oncoming (incoming)
//
// NEW (Dec 2025):
// - Enforce "Locked to RN" continuity on ONCOMING RN drag/drop.
//   If a patient is locked to an incoming RN, dropping onto a different RN
//   will prompt to unlock + move, or cancel.
//
// UPDATED (Jan 2026 - Event payload tolerance):
// - ASSIGNMENT_MOVED now includes BOTH camelCase + snake_case staff id fields
// - Adds patientId at top-level for easier joins/filters
// - Discharge/Reinstate events include staff id fields for RN/PCA when available
// ---------------------------------------------------------

let dragCtx = null; // { context: 'live'|'incoming', role: 'nurse'|'pca'|'sitter', ownerId, patientId }

// -----------------------------
// Canonical globals
// -----------------------------
if (!Array.isArray(window.dischargeHistory)) window.dischargeHistory = [];
if (typeof window.nextDischargeId !== "number") window.nextDischargeId = 1;

// -----------------------------
// Helpers
// -----------------------------

function syncWindowRefs() {
  // Ensure window.* and legacy bare globals stay aligned
  // so app.state.js saveState() persists the correct arrays.
  try {
    if (Array.isArray(window.currentNurses)) currentNurses = window.currentNurses;
    if (Array.isArray(window.currentPcas)) currentPcas = window.currentPcas;
    if (Array.isArray(window.incomingNurses)) incomingNurses = window.incomingNurses;
    if (Array.isArray(window.incomingPcas)) incomingPcas = window.incomingPcas;
    if (Array.isArray(window.currentSitters)) currentSitters = window.currentSitters;
    if (Array.isArray(window.incomingSitters)) incomingSitters = window.incomingSitters;
    if (Array.isArray(window.patients)) patients = window.patients;

    window.currentNurses = currentNurses;
    window.currentPcas = currentPcas;
    window.incomingNurses = incomingNurses;
    window.incomingPcas = incomingPcas;
    window.currentSitters = Array.isArray(currentSitters) ? currentSitters : (window.currentSitters || []);
    window.incomingSitters = Array.isArray(incomingSitters) ? incomingSitters : (window.incomingSitters || []);
    window.patients = patients;

    window.admitQueue = Array.isArray(window.admitQueue) ? window.admitQueue : admitQueue;
    window.dischargeHistory = window.dischargeHistory || dischargeHistory;
    window.nextQueueId = typeof nextQueueId === "number" ? nextQueueId : window.nextQueueId;
    window.nextDischargeId =
      typeof window.nextDischargeId === "number" ? window.nextDischargeId : 1;
  } catch (e) {
    // no-op
  }
}

function getStaffArray(context, role) {
  if (context === "live") {
    if (role === "nurse") return Array.isArray(window.currentNurses) ? window.currentNurses : currentNurses;
    if (role === "sitter") return Array.isArray(window.currentSitters) ? window.currentSitters : (typeof currentSitters !== "undefined" ? currentSitters : []);
    return Array.isArray(window.currentPcas) ? window.currentPcas : currentPcas;
  }
  if (role === "nurse") return Array.isArray(window.incomingNurses) ? window.incomingNurses : incomingNurses;
  if (role === "sitter") return Array.isArray(window.incomingSitters) ? window.incomingSitters : (typeof incomingSitters !== "undefined" ? incomingSitters : []);
  return Array.isArray(window.incomingPcas) ? window.incomingPcas : incomingPcas;
}

function findOwner(context, role, ownerId) {
  const arr = getStaffArray(context, role);
  return (arr || []).find((o) => Number(o?.id) === Number(ownerId)) || null;
}

function ensureArray(obj, key) {
  if (!obj) return;
  if (!Array.isArray(obj[key])) obj[key] = [];
}

function roomPairKeyFromPatient(p) {
  const room = String(p?.room || "").trim();
  const m = room.match(/^(\d+)/);
  return m ? m[1] : room;
}

// Prefer stable staff_id if present; fall back to local numeric id.
function stableStaffId(owner) {
  if (!owner) return null;
  return owner.staff_id || owner.staffId || owner.staffID || owner.id || null;
}

// Analytics-friendly role label (optional but helpful)
function eventRoleLabel(role) {
  if (role === "nurse") return "RN";
  if (role === "pca") return "PCA";
  if (role === "sitter") return "SITTER";
  return String(role || "");
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
  if (typeof window.renderSitterAssignmentOutput === "function") window.renderSitterAssignmentOutput();
  if (typeof window.renderPatientList === "function") window.renderPatientList();
  if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
  if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
}

// Persist helper (centralized)
function persistAndRefresh() {
  syncWindowRefs();
  if (typeof window.saveState === "function") window.saveState();
  rerenderAllBoards();
}

// -----------------------------
// ✅ Event log helpers (LIVE only; append-only)
// -----------------------------
function canLogEvents() {
  return typeof window.appendEvent === "function";
}

function safePatientSummary(patientId) {
  try {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return { patientId };
    return {
      patientId: p.id,
      room: p.room || "",
      name: p.name || "",
      isEmpty: !!p.isEmpty
    };
  } catch {
    return { patientId };
  }
}

function safeOwnerSummary(owner) {
  if (!owner) return null;
  return {
    id: owner.id ?? null,
    name: owner.name || "",
    staffId: stableStaffId(owner)
  };
}

// -----------------------------
// RN Lock helpers (local, no dependency on assignmentsrender.js load order)
// Stored on patient record for persistence:
// - patient.lockRnEnabled (bool)
// - patient.lockRnTo (incoming RN id)
// -----------------------------
function getPatientSafe(patientId) {
  try {
    if (typeof window.getPatientById === "function") return window.getPatientById(patientId);
  } catch {}
  // fallback: scan patients array if needed
  try {
    const pts = Array.isArray(window.patients) ? window.patients : [];
    return pts.find(p => Number(p?.id) === Number(patientId)) || null;
  } catch {
    return null;
  }
}

function getRnLockMeta(patientId) {
  const p = getPatientSafe(patientId);
  if (!p) return { enabled: false, rnId: null };
  const enabled = !!p.lockRnEnabled;
  const rnId = (p.lockRnTo !== undefined && p.lockRnTo !== null) ? Number(p.lockRnTo) : null;
  return { enabled, rnId: Number.isFinite(rnId) ? rnId : null };
}

function unlockRn(patientId) {
  const p = getPatientSafe(patientId);
  if (!p) return;
  p.lockRnEnabled = false;
  p.lockRnTo = null;
}

function ownerNameForIncomingRn(rnId) {
  try {
    const arr = Array.isArray(window.incomingNurses) ? window.incomingNurses : [];
    const rn = arr.find(n => Number(n.id) === Number(rnId));
    return rn?.name || `RN ${rnId}`;
  } catch {
    return `RN ${rnId}`;
  }
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

  if (dragCtx.context !== context) {
    dragCtx = null;
    return;
  }

  // Allow only PCA<->Sitter cross-role drops in the same context.
  // RN cross-role drops are blocked to keep RN assignment independent.
  // Cross-role drop adds assignment in the target role without removing source-role ownership.
  const isCrossRole = dragCtx.role !== role;
  if (isCrossRole) {
    const fromRole = String(dragCtx.role || "");
    const toRole = String(role || "");
    const allowed =
      (fromRole === "pca" && toRole === "sitter") ||
      (fromRole === "sitter" && toRole === "pca");
    if (!allowed) {
      dragCtx = null;
      return;
    }
  }

  const fromOwner = isCrossRole ? null : findOwner(dragCtx.context, dragCtx.role, dragCtx.ownerId);
  const toOwner = findOwner(context, role, newOwnerId);
  if ((!isCrossRole && !fromOwner) || !toOwner) {
    dragCtx = null;
    return;
  }

  if (fromOwner) ensureArray(fromOwner, "patients");
  ensureArray(toOwner, "patients");

  const pid = Number(dragCtx.patientId);
  const fromIdNum = isCrossRole ? NaN : Number(dragCtx.ownerId);
  const toIdNum = Number(newOwnerId);
  if (!Number.isFinite(pid) || (!isCrossRole && !Number.isFinite(fromIdNum)) || !Number.isFinite(toIdNum)) {
    dragCtx = null;
    return;
  }

  if (!isCrossRole && fromIdNum === toIdNum) {
    dragCtx = null;
    return;
  }

  // Sitter manual moves must obey sitter constraints.
  if (role === "sitter") {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(pid) : null;
    if (!p || !p.sitter) {
      alert("Only patients with the Sitter acuity tag can be assigned to a Sitter.");
      dragCtx = null;
      return;
    }

    const roomPairKey = roomPairKeyFromPatient(p);
    const toPids = (toOwner.patients || []).map((x) => Number(x)).filter(Number.isFinite);
    if (toPids.length >= 2) {
      alert("Sitter assignment is capped at 2 patients.");
      dragCtx = null;
      return;
    }

    if (toPids.length > 0) {
      const first = (typeof window.getPatientById === "function") ? window.getPatientById(toPids[0]) : null;
      const firstKey = roomPairKeyFromPatient(first);
      if (firstKey && roomPairKey && firstKey !== roomPairKey) {
        alert("Sitters must stay within the same room pair (e.g., 213A/213B).");
        dragCtx = null;
        return;
      }
    }
  }

  // ✅ RN lock enforcement ONLY for ONCOMING RN board
  if (context === "incoming" && role === "nurse") {
    const meta = getRnLockMeta(pid);

    // If locked to a specific RN and destination RN differs -> prompt
    if (meta.enabled && meta.rnId && Number(meta.rnId) !== Number(newOwnerId)) {
      const lockedName = ownerNameForIncomingRn(meta.rnId);
      const destName = ownerNameForIncomingRn(newOwnerId);

      const ok = confirm(
        `This patient is locked to ${lockedName} for continuity.\n\nMove to ${destName} anyway?\n\nOK = Unlock + Move\nCancel = Keep Locked`
      );

      if (!ok) {
        dragCtx = null;
        return;
      }

      // User chose to override -> unlock then continue
      unlockRn(pid);
    }
  }

  // Remove patient from every owner in this board/role first to avoid duplicate-state bounce-backs.
  const roleOwners = getStaffArray(context, role) || [];
  roleOwners.forEach((owner) => {
    ensureArray(owner, "patients");
    owner.patients = owner.patients.filter((x) => Number(x) !== pid);
  });

  if (fromOwner) {
    const idx = fromOwner.patients.findIndex((x) => Number(x) === pid);
    if (idx !== -1) fromOwner.patients.splice(idx, 1);
  }
  if (!toOwner.patients.some((x) => Number(x) === pid)) toOwner.patients.push(pid);

  // Normalize id types + dedupe to prevent silent reversion on rerender.
  if (fromOwner) {
    fromOwner.patients = Array.from(new Set((fromOwner.patients || []).map((x) => Number(x)).filter(Number.isFinite)));
  }
  toOwner.patients = Array.from(new Set((toOwner.patients || []).map((x) => Number(x)).filter(Number.isFinite)));

  // ✅ LIVE-only event log (oncoming intentionally excluded for Phase 1 scope)
  if (context === "live" && canLogEvents()) {
    try {
      const fromSid = stableStaffId(fromOwner);
      const toSid = stableStaffId(toOwner);

      window.appendEvent("ASSIGNMENT_MOVED", {
        context: "live",

        // Role labels
        role: role,                       // 'nurse'|'pca'
        roleLabel: eventRoleLabel(role),  // 'RN'|'PCA'

        // Patient (keep existing + add top-level patientId for easy joins)
        patientId: pid,
        patient: safePatientSummary(pid),

        // Owner summaries (keep backwards compatible)
        fromOwner: fromOwner ? { id: fromOwner.id, name: fromOwner.name || "" } : null,
        toOwner: { id: toOwner.id, name: toOwner.name || "" },

        // ✅ Staff attribution (camelCase + snake_case for schema tolerance)
        fromStaffId: fromSid,
        toStaffId: toSid,
        from_staff_id: fromSid,
        to_staff_id: toSid,

        // Additional explicit aliases (harmless, but helps mixed readers)
        fromOwnerStaffId: fromSid,
        toOwnerStaffId: toSid
      }, { v: 2, source: "app.assignmentsDrag.js" });
    } catch (e) {
      console.warn("[eventLog] ASSIGNMENT_MOVED failed", e);
    }
  }

  dragCtx = null;

  // ✅ Always persist after every drag/drop so refresh doesn't lose layout.
  persistAndRefresh();
}

function onRowDragEnd() {
  dragCtx = null;
}

// -----------------------------
// DISCHARGE BIN
// -----------------------------

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

  // Discharge only allowed from LIVE context
  if (dragCtx.context !== "live") {
    dragCtx = null;
    return;
  }

  const { patientId } = dragCtx;
  const patientIdNum = Number(patientId);

  // Capture BOTH RN and PCA assignments at discharge time
  const rnOwner =
    currentNurses.find((n) => Array.isArray(n.patients) && n.patients.some((id) => Number(id) === patientIdNum)) || null;
  const pcOwner =
    currentPcas.find((p) => Array.isArray(p.patients) && p.patients.some((id) => Number(id) === patientIdNum)) || null;

  // Remove from BOTH lists
  if (rnOwner) {
    ensureArray(rnOwner, "patients");
    const idx = rnOwner.patients.findIndex((id) => Number(id) === patientIdNum);
    if (idx !== -1) rnOwner.patients.splice(idx, 1);
  }
  if (pcOwner) {
    ensureArray(pcOwner, "patients");
    const idx = pcOwner.patients.findIndex((id) => Number(id) === patientIdNum);
    if (idx !== -1) pcOwner.patients.splice(idx, 1);
  }

  const patient = getPatientById(patientId);
  let patientSummaryBefore = safePatientSummary(patientId);

  if (patient) {
    patient.recentlyDischarged = true;
    patient.isEmpty = true;

    // optional: clear any continuity lock on discharge
    // (keeps things sane if bed turns over)
    patient.lockRnEnabled = false;
    patient.lockRnTo = null;

    // refresh summary after mutation (still useful; isEmpty true)
    patientSummaryBefore = safePatientSummary(patientId);
  }

  const dischargeId = window.nextDischargeId++;

  // Canonical history record
  window.dischargeHistory.unshift({
    id: dischargeId,
    patientId,
    nurseId: rnOwner ? rnOwner.id : null,
    nurseName: rnOwner ? String(rnOwner.name || "") : "",
    pcaId: pcOwner ? pcOwner.id : null,
    pcaName: pcOwner ? String(pcOwner.name || "") : "",
    timestamp: Date.now(),
  });

  // ✅ LIVE-only event log
  if (canLogEvents()) {
    try {
      const rnSid = stableStaffId(rnOwner);
      const pcaSid = stableStaffId(pcOwner);

      window.appendEvent("PATIENT_DISCHARGED", {
        context: "live",
        dischargeId,

        patientId: patientId,
        patient: patientSummaryBefore,

        nurse: rnOwner ? { id: rnOwner.id, name: rnOwner.name || "" } : null,
        pca: pcOwner ? { id: pcOwner.id, name: pcOwner.name || "" } : null,

        // ✅ staff attribution (tolerant aliases)
        rnStaffId: rnSid,
        pcaStaffId: pcaSid,
        rn_staff_id: rnSid,
        pca_staff_id: pcaSid,

        timestamp: Date.now()
      }, { v: 1, source: "app.assignmentsDrag.js" });
    } catch (e) {
      console.warn("[eventLog] PATIENT_DISCHARGED failed", e);
    }
  }

  dragCtx = null;

  // ✅ persist after discharge
  persistAndRefresh();
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
    const rnById = new Map((Array.isArray(window.currentNurses) ? window.currentNurses : []).map((n) => [Number(n?.id), n]));
    const pcaById = new Map((Array.isArray(window.currentPcas) ? window.currentPcas : []).map((p) => [Number(p?.id), p]));
    let html = "";
    history.forEach((entry, i) => {
      const p = getPatientById(entry.patientId);
      if (!p) return;
      const t = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "";
      const rnNow = rnById.get(Number(entry.nurseId));
      const pcaNow = pcaById.get(Number(entry.pcaId));
      const rnName = String(rnNow?.name || entry.nurseName || "").trim();
      const pcaName = String(pcaNow?.name || entry.pcaName || "").trim();
      const staffLine = [rnName ? `RN: ${rnName}` : "", pcaName ? `PCA: ${pcaName}` : ""].filter(Boolean).join(" | ");

      html += `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #eee;">
          <div>
            <div><strong>${p.room || ""}</strong> ${p.name ? ` - ${p.name}` : ""}</div>
            <div style="font-size:12px;opacity:0.75;">${t}</div>
            ${staffLine ? `<div style="font-size:12px;opacity:0.85;">${staffLine}</div>` : ""}
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
    persistAndRefresh();
    return;
  }

  patient.isEmpty = false;
  patient.recentlyDischarged = false;

  if (entry.nurseId != null) {
    const n = currentNurses.find((v) => Number(v?.id) === Number(entry.nurseId));
    if (n) {
      ensureArray(n, "patients");
      if (!n.patients.some((id) => Number(id) === Number(patient.id))) n.patients.push(Number(patient.id));
    }
  }

  if (entry.pcaId != null) {
    const pc = currentPcas.find((v) => Number(v?.id) === Number(entry.pcaId));
    if (pc) {
      ensureArray(pc, "patients");
      if (!pc.patients.some((id) => Number(id) === Number(patient.id))) pc.patients.push(Number(patient.id));
    }
  }

  // ✅ LIVE-only event log (this modal is LIVE discharge history)
  if (canLogEvents()) {
    try {
      // attempt to resolve current owners (post-reinstate)
      const rnOwner =
        currentNurses.find((n) => Array.isArray(n.patients) && n.patients.includes(entry.patientId)) || null;
      const pcOwner =
        currentPcas.find((p) => Array.isArray(p.patients) && p.patients.includes(entry.patientId)) || null;

      const rnSid = stableStaffId(rnOwner) || (entry.nurseId ?? null);
      const pcaSid = stableStaffId(pcOwner) || (entry.pcaId ?? null);

      window.appendEvent("PATIENT_REINSTATED", {
        context: "live",
        dischargeId: entry.id ?? null,

        patientId: entry.patientId,
        patient: safePatientSummary(entry.patientId),

        nurseId: entry.nurseId ?? null,
        pcaId: entry.pcaId ?? null,

        // ✅ staff attribution (tolerant aliases)
        rnStaffId: rnSid,
        pcaStaffId: pcaSid,
        rn_staff_id: rnSid,
        pca_staff_id: pcaSid,

        timestamp: Date.now()
      }, { v: 1, source: "app.assignmentsDrag.js" });
    } catch (e) {
      console.warn("[eventLog] PATIENT_REINSTATED failed", e);
    }
  }

  history.splice(index, 1);

  persistAndRefresh();

  if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
  openDischargeHistoryModal();
}

// ---------------------------------------------------------
// Clear “Recently Discharged” flags (AND reset session counter)
// Intended to be called by the LIVE tab button:
//   <button onclick="clearRecentlyDischargedFlags()">...</button>
// ---------------------------------------------------------

function clearRecentlyDischargedFlags() {
  try {
    const pts = Array.isArray(window.patients) ? window.patients : [];

    // 1) Clear bed-level flags
    let cleared = 0;
    pts.forEach((p) => {
      if (!p) return;

      const had = !!p.recentlyDischarged || !!p.recentlyDischargedFlag;
      if (p.recentlyDischarged) p.recentlyDischarged = false;
      if (p.recentlyDischargedFlag) p.recentlyDischargedFlag = false;
      if (p.dischargedAt) p.dischargedAt = null;

      if (had) cleared++;
    });

    // 2) Reset discharge session tracking
    window.dischargeHistory = [];
    window.nextDischargeId = 1;

    // ✅ LIVE-only event log
    if (canLogEvents()) {
      try {
        window.appendEvent("DISCHARGE_SESSION_RESET", {
          context: "live",
          clearedPatients: cleared,
          timestamp: Date.now()
        }, { v: 1, source: "app.assignmentsDrag.js" });
      } catch (e) {
        console.warn("[eventLog] DISCHARGE_SESSION_RESET failed", e);
      }
    }

    // 3) Persist + re-render
    persistAndRefresh();

    console.log(
      `Cleared recently discharged flags for ${cleared} patient(s). Reset discharge session count/history.`
    );
  } catch (e) {
    console.warn("clearRecentlyDischargedFlags failed:", e);
  }
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

window.clearRecentlyDischargedFlags = clearRecentlyDischargedFlags;
