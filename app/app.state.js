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

  window.admitQueue       = Array.isArray(window.admitQueue)       ? window.admitQueue       : [];
  window.dischargeHistory = Array.isArray(window.dischargeHistory) ? window.dischargeHistory : [];

  window.pcaShift        = typeof window.pcaShift === "string" ? window.pcaShift : "day";
  window.nextQueueId     = typeof window.nextQueueId === "number" ? window.nextQueueId : 1;
  window.nextDischargeId = typeof window.nextDischargeId === "number" ? window.nextDischargeId : 1;

  // ============ MULTI-UNIT CORE ============
  // These are the minimal "spine" fields needed for unit switching + settings propagation.
  window.availableUnits = Array.isArray(window.availableUnits) ? window.availableUnits : [];
  window.activeUnitId = typeof window.activeUnitId === "string" ? window.activeUnitId : (window.activeUnitId || null);
  window.activeUnitRole = typeof window.activeUnitRole === "string" ? window.activeUnitRole : (window.activeUnitRole || null);
  window.unitSettings = (window.unitSettings && typeof window.unitSettings === "object") ? window.unitSettings : null;

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

  // eslint-disable-next-line no-var
  var availableUnits = window.availableUnits;
  // eslint-disable-next-line no-var
  var activeUnitId = window.activeUnitId;
  // eslint-disable-next-line no-var
  var activeUnitRole = window.activeUnitRole;
  // eslint-disable-next-line no-var
  var unitSettings = window.unitSettings;

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

  // ============ UNIT BED LABEL MAPPING ============
  // Keeps patient.id 1..32 stable, updates patient.room labels from unitSettings.beds[0..31]
  function applyUnitBedMapping(settings) {
    const beds = settings && Array.isArray(settings.beds) ? settings.beds : null;
    if (!beds) return;

    if (beds.length !== 32) {
      console.warn("[unit] beds must be length 32. Got:", beds.length);
      return;
    }

    if (!Array.isArray(patients)) patients = [];
    if (patients.length !== 32) return; // must already be ensured

    for (let i = 0; i < 32; i++) {
      const p = patients[i];
      if (!p) continue;
      p.room = String(beds[i]);
    }

    window.patients = patients;
  }

  // Canonical: always have 32 rooms with stable IDs.
  // IMPORTANT: even if we already have 32 patients, we still apply bed mapping if unitSettings.beds exists.
  function ensureDefaultPatients() {
    if (!Array.isArray(patients)) patients = [];

    const existingById = new Map();
    patients.forEach(p => {
      if (p && typeof p.id === "number") existingById.set(p.id, p);
    });

    const next = [];
    for (let i = 1; i <= 32; i++) {
      if (existingById.has(i)) {
        const p = existingById.get(i);

        // If missing, default to "occupied" to avoid silently flipping workflow
        if (typeof p.isEmpty !== "boolean") p.isEmpty = false;
        if (typeof p.recentlyDischarged !== "boolean") p.recentlyDischarged = false;

        // If room missing, set a placeholder; mapping may overwrite below
        if (!p.room) p.room = String(i);

        next.push(p);
      } else {
        next.push(makeEmptyPatient(i, i));
      }
    }

    patients = next;
    window.patients = patients;

    // Apply unit bed labels if available (this is the critical fix)
    if (unitSettings && typeof unitSettings === "object") {
      applyUnitBedMapping(unitSettings);
    }
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
        // multi-unit spine
        activeUnitId: activeUnitId || null,
        activeUnitRole: activeUnitRole || null,
        unitSettings: unitSettings || null,
        availableUnits: Array.isArray(availableUnits) ? availableUnits : [],

        // existing state
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

      // multi-unit spine
      activeUnitId = data.activeUnitId || null;
      activeUnitRole = data.activeUnitRole || null;
      unitSettings = (data.unitSettings && typeof data.unitSettings === "object") ? data.unitSettings : null;
      availableUnits = Array.isArray(data.availableUnits) ? data.availableUnits : [];

      window.activeUnitId = activeUnitId;
      window.activeUnitRole = activeUnitRole;
      window.unitSettings = unitSettings;
      window.availableUnits = availableUnits;

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

      // Ensure 32 and apply bed mapping if settings exist
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

      // Also keep local references aligned for multi-unit spine
      activeUnitId = window.activeUnitId;
      activeUnitRole = window.activeUnitRole;
      unitSettings = window.unitSettings;
      availableUnits = window.availableUnits;

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

  // ============ UNIT SETTINGS APPLY (minimal hook) ============
  // This is intentionally conservative: it updates globals and triggers renders.
  function applyUnitSettings(nextSettings) {
    unitSettings = nextSettings || null;
    window.unitSettings = unitSettings;

    // If settings include beds, apply immediately
    ensureDefaultPatients(); // ensures 32 then applies mapping
    applyUnitBedMapping(unitSettings);

    // Optional hooks other files can implement
    if (typeof window.onUnitSettingsApplied === "function") {
      try { window.onUnitSettingsApplied(unitSettings); } catch (e) { console.warn("onUnitSettingsApplied error", e); }
    }

    // Re-render typical surfaces
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.renderQueueList === "function") window.renderQueueList();

    saveState();
  }

  // ============ ACTIVE UNIT SETTER (loads settings) ============
  async function setActiveUnit(unitId, role) {
    if (!unitId) {
      activeUnitId = null;
      activeUnitRole = null;
      window.activeUnitId = activeUnitId;
      window.activeUnitRole = activeUnitRole;
      applyUnitSettings(null);
      saveState();
      return { ok: true };
    }

    activeUnitId = String(unitId);
    activeUnitRole = role ? String(role) : (activeUnitRole || null);

    window.activeUnitId = activeUnitId;
    window.activeUnitRole = activeUnitRole;

    // Load unit_settings for this unit (if sb is available)
    if (window.sb && window.sb.getUnitSettings) {
      const { row, error } = await window.sb.getUnitSettings(activeUnitId);
      if (error) {
        console.warn("[unit] Failed to load unit_settings", error);
        saveState();
        return { ok: false, error };
      }
      applyUnitSettings(row);
      return { ok: true, settings: row };
    }

    saveState();
    return { ok: true, settings: null };
  }

  // ============ LOAD MEMBERSHIPS (optional convenience) ============
  async function refreshMyUnits() {
    if (!window.sb || !window.sb.myUnitMemberships) {
      return { ok: false, error: new Error("Supabase not configured") };
    }

    const { data, error } = await window.sb.myUnitMemberships();
    if (error) return { ok: false, error };

    const mapped = (data || [])
      .map(r => ({
        unit_id: r.unit_id,
        role: r.role,
        unit: r.units ? { id: r.units.id, name: r.units.name, code: r.units.code } : null
      }))
      .filter(x => x.unit_id && x.unit);

    availableUnits = mapped;
    window.availableUnits = availableUnits;

    if (!activeUnitId && mapped.length) {
      const first = mapped[0];
      await setActiveUnit(first.unit_id, first.role);
    } else {
      saveState();
    }

    return { ok: true, rows: mapped };
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
  window.getRoomNumber = window.getRoomNumber || function getRoomNumber(p) {
    if (!p) return 9999;
    const roomVal = (typeof p === "object") ? (p.room ?? p.id ?? "") : p;
    const s = String(roomVal).trim();
    const m = s.match(/\d+/);
    return m ? Number(m[0]) : 9999;
  };

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

  // multi-unit exports
  window.applyUnitSettings = applyUnitSettings;
  window.setActiveUnit = setActiveUnit;
  window.refreshMyUnits = refreshMyUnits;

  // Also expose legacy bare global resetAllPatients if other scripts call it directly
  if (typeof resetAllPatients === "undefined") {
    // eslint-disable-next-line no-var
    var resetAllPatients = window.resetAllPatients;
  }
})();