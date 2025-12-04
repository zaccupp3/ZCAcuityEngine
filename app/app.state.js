// app/app.state.js
// ---------------------------------------------------------
// Core app state + storage + shared helpers
// ---------------------------------------------------------

// ============ GLOBAL ARRAYS / VARS ============

// Create arrays on window if missing, and bind local vars to them.
// Using `var` here on purpose so other scripts can see them as globals.

window.currentNurses = Array.isArray(window.currentNurses) ? window.currentNurses : [];
window.incomingNurses = Array.isArray(window.incomingNurses) ? window.incomingNurses : [];
window.currentPcas    = Array.isArray(window.currentPcas)    ? window.currentPcas    : [];
window.incomingPcas   = Array.isArray(window.incomingPcas)   ? window.incomingPcas   : [];
window.patients       = Array.isArray(window.patients)       ? window.patients       : [];

window.admitQueue        = Array.isArray(window.admitQueue)        ? window.admitQueue        : [];
window.dischargeHistory  = Array.isArray(window.dischargeHistory)  ? window.dischargeHistory  : [];

window.pcaShift        = typeof window.pcaShift === "string" ? window.pcaShift : "day";
window.nextQueueId     = typeof window.nextQueueId === "number" ? window.nextQueueId : 1;
window.nextDischargeId = typeof window.nextDischargeId === "number" ? window.nextDischargeId : 1;

// Bind bare globals (used by other files)
var currentNurses   = window.currentNurses;
var incomingNurses  = window.incomingNurses;
var currentPcas     = window.currentPcas;
var incomingPcas    = window.incomingPcas;
var patients        = window.patients;
var admitQueue      = window.admitQueue;
var dischargeHistory = window.dischargeHistory;
var pcaShift        = window.pcaShift;
var nextQueueId     = window.nextQueueId;
var nextDischargeId = window.nextDischargeId;

// ============ STORAGE KEY ============

const STORAGE_KEY = "cupp_assignment_engine_v1";

// ============ PATIENT DEFAULTS ============

function makeEmptyPatient(id, roomNumber) {
  return {
    id,
    room: roomNumber != null ? String(roomNumber) : "",
    name: "",
    gender: "",
    // RN tags
    tele: false,
    drip: false,
    nih: false,
    bg: false,
    ciwa: false,
    restraint: false,
    sitter: false,
    vpo: false,
    isolation: false,
    admit: false,
    lateDc: false,
    // PCA tags
    chg: false,
    foley: false,
    q2turns: false,
    heavy: false,
    feeder: false,
    // Workflow flags
    isEmpty: true,
    recentlyDischarged: false,
    reviewed: false
  };
}

// Canonical: make sure we always have 32 rooms with stable IDs.
function ensureDefaultPatients() {
  if (!Array.isArray(patients)) patients = [];
  // If already populated, just make sure IDs/rooms exist.
  if (patients.length >= 32) {
    window.patients = patients;
    return;
  }

  const existingById = new Map();
  patients.forEach(p => {
    if (p && typeof p.id === "number") existingById.set(p.id, p);
  });

  const next = [];
  for (let i = 1; i <= 32; i++) {
    if (existingById.has(i)) {
      const p = existingById.get(i);
      if (!p.room) p.room = String(i);
      if (typeof p.isEmpty !== "boolean") p.isEmpty = false;
      if (typeof p.recentlyDischarged !== "boolean") p.recentlyDischarged = false;
      next.push(p);
    } else {
      next.push(makeEmptyPatient(i, i));
    }
  }

  patients = next;
  window.patients = patients;
}

// Blow away all patient data and recreate the 32-room default grid.
function resetAllPatients() {
  patients = [];
  window.patients = patients;
  ensureDefaultPatients();

  if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
  if (typeof window.renderPatientList === "function") window.renderPatientList();
  if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
  if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
  if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();

  saveState();
}

// ============ STORAGE HELPERS ============

// Fallback RN restrictions if app.staffing.js hasn’t run yet.
function defaultRestrictions() {
  return {
    noMales: false,
    noFemales: false,
    noTele: false,
    noMS: false,
    noFloat: false
  };
}

function saveState() {
  try {
    const data = {
      pcaShift,

      currentNurses: currentNurses.map((n, i) => ({
        id: n.id ?? i + 1,
        name: n.name,
        type: n.type,
        restrictions: n.restrictions || defaultRestrictions(),
        patients: Array.isArray(n.patients) ? n.patients.slice() : []
      })),

      incomingNurses: incomingNurses.map((n, i) => ({
        id: n.id ?? i + 1,
        name: n.name,
        type: n.type,
        restrictions: n.restrictions || defaultRestrictions(),
        patients: Array.isArray(n.patients) ? n.patients.slice() : []
      })),

      currentPcas: currentPcas.map((p, i) => ({
        id: p.id ?? i + 1,
        name: p.name,
        restrictions: p.restrictions || { noIso: false },
        patients: Array.isArray(p.patients) ? p.patients.slice() : []
      })),

      incomingPcas: incomingPcas.map((p, i) => ({
        id: p.id ?? i + 1,
        name: p.name,
        restrictions: p.restrictions || { noIso: false },
        patients: Array.isArray(p.patients) ? p.patients.slice() : []
      })),

      patients: patients.map(p => ({ ...p })),

      dischargeHistory,
      nextDischargeId,

      admitQueue,
      nextQueueId
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("Unable to save state", e);
  }
}

function loadStateFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      ensureDefaultPatients();
      return false;
    }

    const data = JSON.parse(raw);

    pcaShift = data.pcaShift || "day";
    window.pcaShift = pcaShift;

    currentNurses = Array.isArray(data.currentNurses) ? data.currentNurses : [];
    incomingNurses = Array.isArray(data.incomingNurses) ? data.incomingNurses : [];
    currentPcas = Array.isArray(data.currentPcas) ? data.currentPcas : [];
    incomingPcas = Array.isArray(data.incomingPcas) ? data.incomingPcas : [];

    window.currentNurses = currentNurses;
    window.incomingNurses = incomingNurses;
    window.currentPcas = currentPcas;
    window.incomingPcas = incomingPcas;

    patients = Array.isArray(data.patients) ? data.patients : [];
    window.patients = patients;
    ensureDefaultPatients();

    dischargeHistory = Array.isArray(data.dischargeHistory) ? data.dischargeHistory : [];
    window.dischargeHistory = dischargeHistory;
    nextDischargeId = typeof data.nextDischargeId === "number" ? data.nextDischargeId : 1;
    window.nextDischargeId = nextDischargeId;

    admitQueue = Array.isArray(data.admitQueue) ? data.admitQueue : [];
    window.admitQueue = admitQueue;
    nextQueueId = typeof data.nextQueueId === "number" ? data.nextQueueId : 1;
    window.nextQueueId = nextQueueId;

    return true;
  } catch (e) {
    console.warn("Unable to load state", e);
    ensureDefaultPatients();
    return false;
  }
}

// Convenience init called from app.init.js (or you can call manually)
function initFromStorageOrDefaults() {
  loadStateFromStorage();
  ensureDefaultPatients();
  if (typeof window.renderPatientList === "function") window.renderPatientList();
  if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
  if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
  if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
  if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
  if (typeof window.renderQueueList === "function") window.renderQueueList();
  if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
}

// ============ CLEAR “RECENTLY DISCHARGED” ============

function clearRecentlyDischargedFlags() {
  patients.forEach(p => {
    if (!p) return;
    p.recentlyDischarged = false;
  });

  if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
  if (typeof window.renderPatientList === "function") window.renderPatientList();
  if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
  if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
  if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();

  saveState();
}

// ============ HIGH-ACUITY MODAL ============

function openAcuityModal() {
  const modal = document.getElementById("acuityModal");
  const body = document.getElementById("acuityReportBody");
  if (!modal || !body) return;

  if (typeof window.buildHighAcuityText === "function") {
    body.innerHTML = window.buildHighAcuityText();
  } else {
    body.innerHTML = "<p>No high-risk patients flagged.</p>";
  }

  modal.style.display = "flex";
}

function closeAcuityModal() {
  const modal = document.getElementById("acuityModal");
  if (modal) modal.style.display = "none";
}

// ============ ADMIT QUEUE ============

let currentDraftQueueId = null;
let currentAssignQueueId = null;

function renderQueueList() {
  const container = document.getElementById("queueList");
  if (!container) return;

  const list = Array.isArray(admitQueue) ? admitQueue : [];
  if (!list.length) {
    container.innerHTML = `<div style="opacity:0.7;font-size:13px;">No admits queued.</div>`;
    return;
  }

  let html = "";
  list.forEach(item => {
    const name = item.name || "Admit";
    const tags = item.preTags || {};
    const tagPieces = [];

    if (tags.tele) tagPieces.push("Tele");
    if (tags.drip) tagPieces.push("Drip");
    if (tags.nih) tagPieces.push("NIH");
    if (tags.bg) tagPieces.push("BG");
    if (tags.ciwa) tagPieces.push("CIWA/COWS");
    if (tags.restraint) tagPieces.push("Restraint");
    if (tags.sitter) tagPieces.push("Sitter");
    if (tags.vpo) tagPieces.push("VPO");
    if (tags.iso) tagPieces.push("ISO");
    if (tags.lateDc) tagPieces.push("Late DC");
    if (tags.chg) tagPieces.push("CHG");
    if (tags.foley) tagPieces.push("Foley");
    if (tags.q2) tagPieces.push("Q2");
    if (tags.heavy) tagPieces.push("Heavy");
    if (tags.feeder) tagPieces.push("Feeder");

    const tagLabel = tagPieces.length ? tagPieces.join(", ") : "No pre-admit tags";

    html += `
      <div class="queue-item">
        <div class="queue-item-header">
          <div class="queue-item-title">
            <input
              type="text"
              value="${name.replace(/"/g, "&quot;")}"
              onchange="window.renameAdmit(${item.id}, this.value)"
            />
          </div>
        </div>
        <div class="queue-item-tags">
          ${tagLabel}
        </div>
        <div class="queue-item-actions">
          <button class="queue-btn" onclick="window.openQueueAssignModal(${item.id})">Assign</button>
          <button class="queue-btn" onclick="window.openAdmitDraftModal(${item.id})">Pre-Admit Tags</button>
          <button class="queue-btn" onclick="window.removeAdmit(${item.id})">Remove</button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function promptAddAdmit() {
  const name = window.prompt("Admit name / bed request (optional):", "Admit");
  if (name === null) return;

  const item = {
    id: nextQueueId++,
    name: name.trim() || "Admit",
    preTags: {}
  };

  admitQueue.push(item);
  window.admitQueue = admitQueue;
  window.nextQueueId = nextQueueId;

  renderQueueList();
  saveState();
}

// Simple rename inline from the input in each queue item
function renameAdmit(id, newName) {
  const item = admitQueue.find(q => q.id === id);
  if (!item) return;
  item.name = (newName || "").trim() || "Admit";
  saveState();
}

// Remove queue item entirely
function removeAdmit(id) {
  const idx = admitQueue.findIndex(q => q.id === id);
  if (idx === -1) return;
  admitQueue.splice(idx, 1);
  renderQueueList();
  saveState();
}

// ----- Pre-admit tags modal -----

function openAdmitDraftModal(id) {
  const modal = document.getElementById("admitDraftModal");
  if (!modal) return;

  const item = admitQueue.find(q => q.id === id);
  if (!item) return;

  currentDraftQueueId = id;
  const tags = item.preTags || {};
  const gender = item.preGender || "";

  const gSel = document.getElementById("admitDraftGender");
  if (gSel) gSel.value = gender || "";

  // RN pre tags
  document.getElementById("adTele").checked = !!tags.tele;
  document.getElementById("adDrip").checked = !!tags.drip;
  document.getElementById("adNih").checked = !!tags.nih;
  document.getElementById("adBg").checked = !!tags.bg;
  document.getElementById("adCiwa").checked = !!tags.ciwa;
  document.getElementById("adRestraint").checked = !!tags.restraint;
  document.getElementById("adSitter").checked = !!tags.sitter;
  document.getElementById("adVpo").checked = !!tags.vpo;
  document.getElementById("adIso").checked = !!tags.iso;
  document.getElementById("adLateDc").checked = !!tags.lateDc;

  // PCA pre tags
  document.getElementById("adChg").checked = !!tags.chg;
  document.getElementById("adFoley").checked = !!tags.foley;
  document.getElementById("adQ2").checked = !!tags.q2;
  document.getElementById("adHeavy").checked = !!tags.heavy;
  document.getElementById("adFeeder").checked = !!tags.feeder;

  modal.style.display = "flex";
}

function closeAdmitDraftModal() {
  const modal = document.getElementById("admitDraftModal");
  if (modal) modal.style.display = "none";
  currentDraftQueueId = null;
}

function saveAdmitDraftFromModal() {
  if (currentDraftQueueId == null) {
    closeAdmitDraftModal();
    return;
  }
  const item = admitQueue.find(q => q.id === currentDraftQueueId);
  if (!item) {
    closeAdmitDraftModal();
    return;
  }

  const gSel = document.getElementById("admitDraftGender");
  const gender = gSel ? gSel.value : "";

  const tags = {
    tele: !!document.getElementById("adTele").checked,
    drip: !!document.getElementById("adDrip").checked,
    nih: !!document.getElementById("adNih").checked,
    bg: !!document.getElementById("adBg").checked,
    ciwa: !!document.getElementById("adCiwa").checked,
    restraint: !!document.getElementById("adRestraint").checked,
    sitter: !!document.getElementById("adSitter").checked,
    vpo: !!document.getElementById("adVpo").checked,
    iso: !!document.getElementById("adIso").checked,
    lateDc: !!document.getElementById("adLateDc").checked,
    chg: !!document.getElementById("adChg").checked,
    foley: !!document.getElementById("adFoley").checked,
    q2: !!document.getElementById("adQ2").checked,
    heavy: !!document.getElementById("adHeavy").checked,
    feeder: !!document.getElementById("adFeeder").checked
  };

  item.preGender = gender || "";
  item.preTags = tags;

  renderQueueList();
  saveState();
  closeAdmitDraftModal();
}

// ----- Assign modal (still stubbed like before) -----

function openQueueAssignModal(id) {
  const modal = document.getElementById("queueAssignModal");
  if (!modal) return;

  const item = admitQueue.find(q => q.id === id);
  if (!item) return;

  currentAssignQueueId = id;

  const info = document.getElementById("queueAssignInfo");
  if (info) info.textContent =
    `Assign "${item.name || "Admit"}" to RN / PCA / bed. (Prototype – capacity logic coming next.)`;

  // For now we just populate dropdowns very simply.
  const bedSelect = document.getElementById("queueAssignBed");
  const rnSelect = document.getElementById("queueAssignNurse");
  const pcaSelect = document.getElementById("queueAssignPca");

  if (bedSelect) {
    bedSelect.innerHTML = "";
    ensureDefaultPatients();
    const empties = patients.filter(p => p.isEmpty);
    if (!empties.length) {
      bedSelect.innerHTML = `<option value="">No empty beds</option>`;
    } else {
      bedSelect.innerHTML = empties
        .map(p => `<option value="${p.id}">Room ${p.room}</option>`)
        .join("");
    }
  }

  if (rnSelect) {
    rnSelect.innerHTML = (currentNurses || [])
      .map(n => `<option value="${n.id}">${n.name}</option>`)
      .join("");
  }

  if (pcaSelect) {
    pcaSelect.innerHTML = (currentPcas || [])
      .map(p => `<option value="${p.id}">${p.name}</option>`)
      .join("");
  }

  modal.style.display = "flex";
}

function closeQueueAssignModal() {
  const modal = document.getElementById("queueAssignModal");
  if (modal) modal.style.display = "none";
  currentAssignQueueId = null;
}

// For now, just keep the same “not wired yet” behavior
function confirmQueueAssign() {
  alert(
    "Queue Assign Modal logic not wired yet. (Next fix: connect to beds + RN/PCA capacity rules.)"
  );
  closeQueueAssignModal();
}

// ---------------------------------------------------------
// Compatibility helpers (required by app.patientsAcuity.js and others)
// If these were removed during refactors, the UI will crash.
// ---------------------------------------------------------

// Room sorting helper used throughout (patientsAcuity, assignmentsrender, queue, etc.)
window.getRoomNumber = window.getRoomNumber || function getRoomNumber(p) {
  if (!p) return 9999;

  // Accept either patient object or room string/number
  const roomVal = (typeof p === "object") ? (p.room ?? p.id ?? "") : p;
  const s = String(roomVal).trim();

  // Extract first integer found, e.g. "12A" -> 12
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : 9999;
};

// Some older code calls without window prefix
// (Only define if missing to avoid overriding your canonical versions)
if (typeof getRoomNumber === "undefined") {
  // eslint-disable-next-line no-var
  var getRoomNumber = window.getRoomNumber;
}

// ============ EXPORT TO WINDOW ============

window.ensureDefaultPatients = ensureDefaultPatients;
window.resetAllPatients = resetAllPatients;

window.saveState = saveState;
window.loadStateFromStorage = loadStateFromStorage;
window.initFromStorageOrDefaults = initFromStorageOrDefaults;

window.clearRecentlyDischargedFlags = clearRecentlyDischargedFlags;

window.openAcuityModal = openAcuityModal;
window.closeAcuityModal = closeAcuityModal;

window.renderQueueList = renderQueueList;
window.promptAddAdmit = promptAddAdmit;
window.renameAdmit = renameAdmit;
window.removeAdmit = removeAdmit;

window.openAdmitDraftModal = openAdmitDraftModal;
window.closeAdmitDraftModal = closeAdmitDraftModal;
window.saveAdmitDraftFromModal = saveAdmitDraftFromModal;

window.openQueueAssignModal = openQueueAssignModal;
window.closeQueueAssignModal = closeQueueAssignModal;
window.confirmQueueAssign = confirmQueueAssign;