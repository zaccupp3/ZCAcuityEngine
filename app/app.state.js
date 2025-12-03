// app/app.state.js
// Core app state + storage + exports (via getters/setters so window refs never go stale)

const STORAGE_KEY = "nurse_pca_assigner_state_v4";

// Fixed unit rooms (32)
const ROOM_CODES = [
  "200A", "200B",
  "201A", "201B",
  "202A", "202B",
  "203A", "203B",
  "204A", "204B",
  "205",
  "207",
  "209",
  "211",
  "213A", "213B",
  "214A", "214B",
  "215A", "215B",
  "216A", "216B",
  "217A", "217B",
  "218A", "218B",
  "219A", "219B",
  "220A", "220B",
  "221A", "221B"
];

// Staff & patient arrays
let currentNurses   = [];
let currentPcas     = [];
let incomingNurses  = [];
let incomingPcas    = [];
let patients        = [];

// PCA shift
let pcaShift = "day";

// LIVE features (Discharges + Admit Queue)
let dischargeHistory = []; // { patientId, nurseId, pcaId, timestamp, ...optional }
let nextDischargeId  = 1;

let admitQueue = [];     // { id, label, createdAt }
let nextQueueId = 1;

// =========================
// Basic Helpers
// =========================

function defaultRestrictions(oldRestriction) {
  return {
    noNih: oldRestriction === "noNih",
    noIso: false
  };
}

function makeEmptyPatient(id, roomCode) {
  return {
    id,
    room: roomCode || "",
    gender: "", // "M", "F", "X" or ""
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
    chg: false,
    foley: false,
    q2turns: false,
    heavy: false,
    feeder: false,
    reviewed: false,
    isEmpty: true,
    recentlyDischarged: false
  };
}

function ensureDefaultPatients() {
  if (patients.length === ROOM_CODES.length) return;
  patients = ROOM_CODES.map((code, idx) => makeEmptyPatient(idx + 1, code));
}

// Sorting helper (stable room ordering)
function getRoomNumber(p) {
  const roomStr = String(p.room || "").toUpperCase().trim();
  const idx = ROOM_CODES.indexOf(roomStr);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

// Roommate helper for A/B rooms
function findRoomMate(patient) {
  const roomStr = String(patient.room || "").toUpperCase().trim();
  const match = roomStr.match(/^(\d+)([AB])$/);
  if (!match) return null;

  const base = match[1];
  const suffix = match[2] === "A" ? "B" : "A";
  const partnerRoom = base + suffix;

  return patients.find(pt => pt.room === partnerRoom && !pt.isEmpty) || null;
}

function canSetGender(patient, newGender) {
  if (!newGender) return true;
  const mate = findRoomMate(patient);
  if (!mate) return true;
  if (!mate.gender) return true;
  return mate.gender === newGender;
}

// =========================
// Recently Discharged helper (the “missing 2 patients” fix)
// =========================
function clearRecentlyDischargedFlags() {
  ensureDefaultPatients();
  patients.forEach(p => {
    if (p.recentlyDischarged) p.recentlyDischarged = false;
  });

  if (typeof saveState === "function") saveState();
  if (typeof window.renderPatientList === "function") window.renderPatientList();
  if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
  if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
  if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
  if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
}
window.clearRecentlyDischargedFlags = clearRecentlyDischargedFlags;

// =========================
// Admit Queue helpers
// =========================

function addToAdmitQueue(label = "New Admit") {
  admitQueue.unshift({
    id: nextQueueId++,
    label,
    createdAt: Date.now()
  });

  if (typeof saveState === "function") saveState();
  if (typeof window.renderQueueList === "function") window.renderQueueList();
}

function removeFromAdmitQueue(queueId) {
  admitQueue = admitQueue.filter(q => q.id !== queueId);

  if (typeof saveState === "function") saveState();
  if (typeof window.renderQueueList === "function") window.renderQueueList();
}

window.addToAdmitQueue = addToAdmitQueue;
window.removeFromAdmitQueue = removeFromAdmitQueue;

// =========================
// Local Storage
// =========================

function saveState() {
  try {
    const data = {
      pcaShift,

      currentNurses: currentNurses.map((n, i) => ({
        id: n.id ?? i + 1,
        name: n.name,
        type: n.type,
        restrictions: n.restrictions || defaultRestrictions()
      })),
      incomingNurses: incomingNurses.map((n, i) => ({
        id: n.id ?? i + 1,
        name: n.name,
        type: n.type,
        restrictions: n.restrictions || defaultRestrictions()
      })),
      currentPcas: currentPcas.map((p, i) => ({
        id: p.id ?? i + 1,
        name: p.name,
        restrictions: p.restrictions || { noIso: false }
      })),
      incomingPcas: incomingPcas.map((p, i) => ({
        id: p.id ?? i + 1,
        name: p.name,
        restrictions: p.restrictions || { noIso: false }
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
      return;
    }

    const data = JSON.parse(raw);

    if (data.pcaShift === "day" || data.pcaShift === "night") {
      pcaShift = data.pcaShift;
    }

    function buildNurseArray(src, prefixLabel) {
      if (!Array.isArray(src)) return [];
      return src.map((n, i) => {
        const restrictions = n.restrictions || defaultRestrictions(n.restriction);
        const type = n.type || "tele";
        return {
          id: n.id ?? i + 1,
          name: n.name || `${prefixLabel} ${i + 1}`,
          type,
          restrictions: {
            noNih: !!restrictions.noNih,
            noIso: !!restrictions.noIso
          },
          maxPatients: type === "tele" ? 4 : 5,
          patients: n.patients || []
        };
      });
    }

    function buildPcaArray(src, prefixLabel) {
      if (!Array.isArray(src)) return [];
      const max = pcaShift === "day" ? 8 : 9;
      return src.map((p, i) => ({
        id: p.id ?? i + 1,
        name: p.name || `${prefixLabel} ${i + 1}`,
        restrictions: { noIso: !!(p.restrictions && p.restrictions.noIso) },
        maxPatients: max,
        patients: p.patients || []
      }));
    }

    currentNurses  = buildNurseArray(data.currentNurses,  "Current RN");
    incomingNurses = buildNurseArray(data.incomingNurses, "Incoming RN");
    currentPcas    = buildPcaArray(data.currentPcas,      "Current PCA");
    incomingPcas   = buildPcaArray(data.incomingPcas,     "Incoming PCA");

    ensureDefaultPatients();
    if (Array.isArray(data.patients) && data.patients.length === ROOM_CODES.length) {
      patients = data.patients.map((p, i) => ({
        ...makeEmptyPatient(i + 1, ROOM_CODES[i]),
        ...p,
        id: i + 1,
        reviewed: !!p.reviewed,
        isEmpty: !!p.isEmpty,
        recentlyDischarged: !!p.recentlyDischarged,
        gender: p.gender || ""
      }));
    }

    dischargeHistory = Array.isArray(data.dischargeHistory) ? data.dischargeHistory : [];
    nextDischargeId  = typeof data.nextDischargeId === "number" ? data.nextDischargeId : 1;

    admitQueue = Array.isArray(data.admitQueue) ? data.admitQueue : [];
    nextQueueId = typeof data.nextQueueId === "number" ? data.nextQueueId : 1;

  } catch (e) {
    console.warn("Unable to load state", e);
    ensureDefaultPatients();
  }
}

// =========================
// Exports to window (safe: getters/setters)
// =========================

window.ensureDefaultPatients = ensureDefaultPatients;
window.saveState = saveState;
window.loadStateFromStorage = loadStateFromStorage;

window.defaultRestrictions = defaultRestrictions;
window.canSetGender = canSetGender;
window.getRoomNumber = getRoomNumber;

window.ROOM_CODES = ROOM_CODES;

// IMPORTANT: export mutable state as live getters/setters
Object.defineProperty(window, "patients", {
  get: () => patients,
  set: (v) => { patients = v; }
});

Object.defineProperty(window, "currentNurses", {
  get: () => currentNurses,
  set: (v) => { currentNurses = v; }
});

Object.defineProperty(window, "currentPcas", {
  get: () => currentPcas,
  set: (v) => { currentPcas = v; }
});

Object.defineProperty(window, "incomingNurses", {
  get: () => incomingNurses,
  set: (v) => { incomingNurses = v; }
});

Object.defineProperty(window, "incomingPcas", {
  get: () => incomingPcas,
  set: (v) => { incomingPcas = v; }
});

Object.defineProperty(window, "dischargeHistory", {
  get: () => dischargeHistory,
  set: (v) => { dischargeHistory = v; }
});

Object.defineProperty(window, "nextDischargeId", {
  get: () => nextDischargeId,
  set: (v) => { nextDischargeId = v; }
});

Object.defineProperty(window, "admitQueue", {
  get: () => admitQueue,
  set: (v) => { admitQueue = v; }
});

Object.defineProperty(window, "nextQueueId", {
  get: () => nextQueueId,
  set: (v) => { nextQueueId = v; }
});

Object.defineProperty(window, "pcaShift", {
  get: () => pcaShift,
  set: (v) => { pcaShift = v; }
});
