// app/app.state.js
// ---------------------------------------------------------
// Core app state + storage + shared helpers
// Canonical storage is on window.*, but we ALSO expose legacy bare globals
// (currentNurses, incomingNurses, etc.) because other files still reference them.
//
// MULTI-UNIT UPDATE:
// - Persist a separate workspace per unit in localStorage.
// - Switching units saves the current unit workspace and loads the next unit workspace.
// - Room labels (patient.room) are updated from unitSettings.beds without wiping acuity/tags.
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
  window.availableUnits = Array.isArray(window.availableUnits) ? window.availableUnits : [];
  window.activeUnitId = typeof window.activeUnitId === "string" ? window.activeUnitId : (window.activeUnitId || null);
  window.activeUnitRole = typeof window.activeUnitRole === "string" ? window.activeUnitRole : (window.activeUnitRole || null);
  window.unitSettings = (window.unitSettings && typeof window.unitSettings === "object") ? window.unitSettings : null;

  // ---------------------------------------------------------
  // LEGACY BARE GLOBALS (CRITICAL)
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

  // ============ STORAGE KEYS ============
  // META = cross-unit settings like "active unit", cached memberships, etc.
  const META_KEY = "cupp_assignment_engine_meta_v1";

  // UNIT WORKSPACE = per-unit board state (patients/staff/queue/etc.)
  function unitKey(unitId) {
    const id = unitId ? String(unitId) : "local";
    return `cupp_assignment_engine_unit_${id}_v1`;
  }

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

  // Apply unit bed labels without wiping tags:
  // We keep patient.id stable 1..32 and just overwrite patient.room.
  function applyBedsToPatientRooms() {
    const beds = Array.isArray(unitSettings?.beds) ? unitSettings.beds : null;
    if (!beds || beds.length < 1) return;

    // Ensure 32 patients exist first
    ensureDefaultPatients();

    for (let i = 0; i < 32; i++) {
      const p = patients[i];
      if (!p) continue;
      const label = beds[i] != null ? String(beds[i]) : String(i + 1);
      p.room = label;
    }

    window.patients = patients;
  }

  // Canonical: always have 32 rooms with stable IDs.
  // Note: this creates patients if missing; it DOES NOT force any unit bed labels.
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

        // Default room label if missing (will be overwritten by applyBedsToPatientRooms if unitSettings.beds exists)
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
    applyBedsToPatientRooms();

    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();

    saveState();
  }

  // ============ UNIT SETTINGS APPLY (minimal hook) ============
  function applyUnitSettings(nextSettings) {
    unitSettings = nextSettings || null;
    window.unitSettings = unitSettings;

    // Update room labels from settings (without wiping patient tags)
    applyBedsToPatientRooms();

    if (typeof window.onUnitSettingsApplied === "function") {
      try { window.onUnitSettingsApplied(unitSettings); } catch (e) { console.warn("onUnitSettingsApplied error", e); }
    }

    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.renderQueueList === "function") window.renderQueueList();

    saveState();
  }

  // ============ STORAGE HELPERS ============

  function defaultRestrictions() {
    return {
      noMales: false,
      noFemales: false,
      noTele: false,
      noMS: false,
      noFloat: false
    };
  }

  function saveMeta() {
    try {
      const meta = {
        activeUnitId: activeUnitId || null,
        activeUnitRole: activeUnitRole || null,
        unitSettings: unitSettings || null, // cached copy for fast boot (real source is DB)
        availableUnits: Array.isArray(availableUnits) ? availableUnits : []
      };
      localStorage.setItem(META_KEY, JSON.stringify(meta));
    } catch (e) {
      console.warn("Unable to save meta", e);
    }
  }

  function saveState() {
    try {
      // Save workspace for CURRENT unit
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

      localStorage.setItem(unitKey(activeUnitId), JSON.stringify(data));

      // Save cross-unit meta too
      saveMeta();
    } catch (e) {
      console.warn("Unable to save state", e);
    }
  }

  function loadMeta() {
    try {
      const raw = localStorage.getItem(META_KEY);
      if (!raw) return false;

      const meta = JSON.parse(raw);

      activeUnitId = meta.activeUnitId || null;
      activeUnitRole = meta.activeUnitRole || null;
      unitSettings = (meta.unitSettings && typeof meta.unitSettings === "object") ? meta.unitSettings : null;
      availableUnits = Array.isArray(meta.availableUnits) ? meta.availableUnits : [];

      window.activeUnitId = activeUnitId;
      window.activeUnitRole = activeUnitRole;
      window.unitSettings = unitSettings;
      window.availableUnits = availableUnits;

      return true;
    } catch (e) {
      console.warn("Unable to load meta", e);
      return false;
    }
  }

  function loadUnitWorkspace(unitId) {
    try {
      const raw = localStorage.getItem(unitKey(unitId));
      if (!raw) return false;

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

      dischargeHistory = Array.isArray(data.dischargeHistory) ? data.dischargeHistory : [];
      window.dischargeHistory = dischargeHistory;

      nextDischargeId = typeof data.nextDischargeId === "number" ? data.nextDischargeId : 1;
      window.nextDischargeId = nextDischargeId;

      admitQueue = Array.isArray(data.admitQueue) ? data.admitQueue : [];
      window.admitQueue = admitQueue;

      nextQueueId = typeof data.nextQueueId === "number" ? data.nextQueueId : 1;
      window.nextQueueId = nextQueueId;

      // Re-bind bare globals
      currentNurses = window.currentNurses;
      incomingNurses = window.incomingNurses;
      currentPcas = window.currentPcas;
      incomingPcas = window.incomingPcas;
      patients = window.patients;
      admitQueue = window.admitQueue;
      dischargeHistory = window.dischargeHistory;

      return true;
    } catch (e) {
      console.warn("Unable to load unit workspace", e);
      return false;
    }
  }

  function loadStateFromStorage() {
    // 1) Load meta (active unit + cached settings + memberships)
    loadMeta();

    // 2) Load the workspace for the active unit (or "local" if none)
    const ok = loadUnitWorkspace(activeUnitId);

    // 3) Ensure canonical patients exist and apply bed labels if known
    ensureDefaultPatients();
    applyBedsToPatientRooms();

    return ok;
  }

  function initFromStorageOrDefaults() {
    loadStateFromStorage();
    ensureDefaultPatients();
    applyBedsToPatientRooms();

    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.renderQueueList === "function") window.renderQueueList();
    if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();

    // Best-effort: if we have an activeUnitId but unitSettings is missing, load settings from Supabase.
    if (window.activeUnitId && (!window.unitSettings || typeof window.unitSettings !== "object")) {
      setTimeout(() => {
        setActiveUnit(window.activeUnitId, window.activeUnitRole).catch(e => console.warn("setActiveUnit init load failed", e));
      }, 0);
    }
  }

  // ============ ACTIVE UNIT SETTER (save current -> load next -> load settings) ============
  async function setActiveUnit(nextUnitId, role) {
    // Save workspace for current unit before switching
    saveState();

    if (!nextUnitId) {
      activeUnitId = null;
      activeUnitRole = null;
      window.activeUnitId = activeUnitId;
      window.activeUnitRole = activeUnitRole;
      applyUnitSettings(null);
      saveMeta();
      return { ok: true };
    }

    activeUnitId = String(nextUnitId);
    activeUnitRole = role ? String(role) : (activeUnitRole || null);

    window.activeUnitId = activeUnitId;
    window.activeUnitRole = activeUnitRole;

    // Load workspace for new unit (if exists); otherwise start clean for that unit
    const loaded = loadUnitWorkspace(activeUnitId);
    if (!loaded) {
      // Clean slate for this unit (but keep system defaults)
      currentNurses = [];
      incomingNurses = [];
      currentPcas = [];
      incomingPcas = [];
      admitQueue = [];
      dischargeHistory = [];
      nextQueueId = 1;
      nextDischargeId = 1;
      pcaShift = "day";

      window.currentNurses = currentNurses;
      window.incomingNurses = incomingNurses;
      window.currentPcas = currentPcas;
      window.incomingPcas = incomingPcas;
      window.admitQueue = admitQueue;
      window.dischargeHistory = dischargeHistory;
      window.nextQueueId = nextQueueId;
      window.nextDischargeId = nextDischargeId;
      window.pcaShift = pcaShift;

      patients = [];
      window.patients = patients;
      ensureDefaultPatients();
    } else {
      ensureDefaultPatients();
    }

    // Load unit_settings from Supabase (if available)
    if (window.sb && window.sb.getUnitSettings) {
      const { row, error } = await window.sb.getUnitSettings(activeUnitId);
      if (error) {
        console.warn("[unit] Failed to load unit_settings", error);
        // Still apply any cached settings so the UI doesn't look broken
        applyBedsToPatientRooms();
        saveState();
        return { ok: false, error };
      }
      applyUnitSettings(row);
    } else {
      // Offline / no sb: still apply cached
      applyBedsToPatientRooms();
      saveState();
    }

    return { ok: true };
  }

  // ============ LOAD MEMBERSHIPS ============
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

    // If no active unit yet, pick the newest membership
    if (!activeUnitId && mapped.length) {
      const first = mapped[0];
      await setActiveUnit(first.unit_id, first.role);
    } else {
      saveMeta();
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