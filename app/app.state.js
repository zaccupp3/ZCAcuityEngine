// app/app.state.js
// ---------------------------------------------------------
// Core app state + storage + shared helpers
// Canonical storage is on window.*, but we ALSO expose legacy bare globals
// (currentNurses, incomingNurses, etc.) because other files still reference them.
// ---------------------------------------------------------

(function () {
  // ============ GLOBAL ARRAYS / VARS ============

  // Create arrays on window if missing
  window.currentNurses  = Array.isArray(window.currentNurses)  ? window.currentNurses  : [];
  window.incomingNurses = Array.isArray(window.incomingNurses) ? window.incomingNurses : [];
  window.currentPcas    = Array.isArray(window.currentPcas)    ? window.currentPcas    : [];
  window.incomingPcas   = Array.isArray(window.incomingPcas)   ? window.incomingPcas   : [];
  window.patients       = Array.isArray(window.patients)       ? window.patients       : [];

  window.admitQueue       = Array.isArray(window.admitQueue)      ? window.admitQueue      : [];
  window.dischargeHistory = Array.isArray(window.dischargeHistory)? window.dischargeHistory: [];

  window.pcaShift        = typeof window.pcaShift === "string" ? window.pcaShift : "day";
  window.nextQueueId     = typeof window.nextQueueId === "number" ? window.nextQueueId : 1;
  window.nextDischargeId = typeof window.nextDischargeId === "number" ? window.nextDischargeId : 1;

  // ---------------------------------------------------------
  // LEGACY BARE GLOBALS (CRITICAL)
  // ---------------------------------------------------------
  // Other files reference these without window. If they don't exist, the app crashes.
  // We intentionally use var so they become real globals.
  // ---------------------------------------------------------
  // eslint-disable-next-line no-var
  var currentNurses = window.currentNurses;
  // eslint-disable-next-line no-var
  var incomingNurses = window.incomingNurses;
  // eslint-disable-next-line no-var
  var currentPcas = window.currentPcas;
  // eslint-disable-next-line no-var
  var incomingPcas = window.incomingPcas;
  // eslint-disable-next-line no-var
  var patients = window.patients;
  // eslint-disable-next-line no-var
  var admitQueue = window.admitQueue;
  // eslint-disable-next-line no-var
  var dischargeHistory = window.dischargeHistory;
  // eslint-disable-next-line no-var
  var pcaShift = window.pcaShift;
  // eslint-disable-next-line no-var
  var nextQueueId = window.nextQueueId;
  // eslint-disable-next-line no-var
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

  // Canonical: always have 32 rooms with stable IDs.
  function ensureDefaultPatients() {
    if (!Array.isArray(patients)) patients = [];
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

        // If missing, default to "occupied" to avoid silently flipping workflow
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

        currentNurses: (currentNurses || []).map((n, i) => ({
          id: n.id ?? i + 1,
          name: n.name,
          type: n.type,
          restrictions: n.restrictions || defaultRestrictions(),
          patients: Array.isArray(n.patients) ? n.patients.slice() : []
        })),

        incomingNurses: (incomingNurses || []).map((n, i) => ({
          id: n.id ?? i + 1,
          name: n.name,
          type: n.type,
          restrictions: n.restrictions || defaultRestrictions(),
          patients: Array.isArray(n.patients) ? n.patients.slice() : []
        })),

        currentPcas: (currentPcas || []).map((p, i) => ({
          id: p.id ?? i + 1,
          name: p.name,
          restrictions: p.restrictions || { noIso: false },
          patients: Array.isArray(p.patients) ? p.patients.slice() : []
        })),

        incomingPcas: (incomingPcas || []).map((p, i) => ({
          id: p.id ?? i + 1,
          name: p.name,
          restrictions: p.restrictions || { noIso: false },
          patients: Array.isArray(p.patients) ? p.patients.slice() : []
        })),

        patients: (patients || []).map(p => ({ ...p })),

        dischargeHistory: dischargeHistory || [],
        nextDischargeId: typeof nextDischargeId === "number" ? nextDischargeId : 1,

        admitQueue: admitQueue || [],
        nextQueueId: typeof nextQueueId === "number" ? nextQueueId : 1
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

      // Push back onto window (canonical)
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

      // Re-bind bare globals so other files see updated arrays (not stale references)
      currentNurses = window.currentNurses;
      incomingNurses = window.incomingNurses;
      currentPcas = window.currentPcas;
      incomingPcas = window.incomingPcas;
      patients = window.patients;
      admitQueue = window.admitQueue;
      dischargeHistory = window.dischargeHistory;

      return true;
    } catch (e) {
      console.warn("Unable to load state", e);
      ensureDefaultPatients();
      return false;
    }
  }

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
    (patients || []).forEach(p => {
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

  // ============ COMPATIBILITY HELPERS ============

  // Room sorting helper used throughout (patientsAcuity, assignmentsrender, queue, etc.)
  window.getRoomNumber = window.getRoomNumber || function getRoomNumber(p) {
    if (!p) return 9999;
    const roomVal = (typeof p === "object") ? (p.room ?? p.id ?? "") : p;
    const s = String(roomVal).trim();
    const m = s.match(/\d+/);
    return m ? Number(m[0]) : 9999;
  };

  // Some older code calls without window prefix
  if (typeof window.getRoomNumber === "function" && typeof getRoomNumber === "undefined") {
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

  // Also expose legacy bare global resetAllPatients if other scripts call it directly
  if (typeof resetAllPatients === "undefined") {
    // eslint-disable-next-line no-var
    var resetAllPatients = window.resetAllPatients;
  }
})();