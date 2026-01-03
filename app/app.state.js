// app/app.state.js
// ---------------------------------------------------------
// Core app state + storage + shared helpers
// Canonical storage is on window.*
// Legacy bare globals are kept in sync (critical for older files).
//
// MULTI-UNIT UPDATE:
// - Persist a separate workspace per unit in localStorage.
// - Switching units saves the current unit workspace and loads the next unit workspace.
// - Room labels (patient.room) are updated from unitSettings.beds without wiping acuity/tags.
// ---------------------------------------------------------
//
// ✅ Persist RN/PCA staff_id through save/load (n.staff_id / p.staff_id)
//
// ✅ NEW (this replacement):
// - Fix broken export block at bottom (incomplete if statement)
// - Add canonical helpers to derive "responsible staff" for a patient at event-time
//   (used later for ACUITY_CHANGED / ADMIT_PLACED / ASSIGNMENT_MOVED payload enrichment).
(function () {
  // ============ GLOBAL ARRAYS / VARS ============
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

  // multi-unit
  window.availableUnits = Array.isArray(window.availableUnits) ? window.availableUnits : [];
  window.activeUnitId   = (typeof window.activeUnitId === "string") ? window.activeUnitId : (window.activeUnitId || null);
  window.activeUnitRole = (typeof window.activeUnitRole === "string") ? window.activeUnitRole : (window.activeUnitRole || null);
  window.unitSettings   = (window.unitSettings && typeof window.unitSettings === "object") ? window.unitSettings : null;

  // ---------------------------------------------------------
  // LEGACY BARE GLOBALS (kept synced)
  // ---------------------------------------------------------
  // eslint-disable-next-line no-var
  var currentNurses, incomingNurses, currentPcas, incomingPcas, patients;
  // eslint-disable-next-line no-var
  var admitQueue, dischargeHistory, pcaShift, nextQueueId, nextDischargeId;
  // eslint-disable-next-line no-var
  var availableUnits, activeUnitId, activeUnitRole, unitSettings;

  function syncFromWindow() {
    currentNurses     = window.currentNurses;
    incomingNurses    = window.incomingNurses;
    currentPcas       = window.currentPcas;
    incomingPcas      = window.incomingPcas;
    patients          = window.patients;

    admitQueue        = window.admitQueue;
    dischargeHistory  = window.dischargeHistory;

    pcaShift          = window.pcaShift;
    nextQueueId       = window.nextQueueId;
    nextDischargeId   = window.nextDischargeId;

    availableUnits    = window.availableUnits;
    activeUnitId      = window.activeUnitId;
    activeUnitRole    = window.activeUnitRole;
    unitSettings      = window.unitSettings;
  }

  function syncToWindow() {
    window.currentNurses     = Array.isArray(currentNurses) ? currentNurses : [];
    window.incomingNurses    = Array.isArray(incomingNurses) ? incomingNurses : [];
    window.currentPcas       = Array.isArray(currentPcas) ? currentPcas : [];
    window.incomingPcas      = Array.isArray(incomingPcas) ? incomingPcas : [];
    window.patients          = Array.isArray(patients) ? patients : [];

    window.admitQueue        = Array.isArray(admitQueue) ? admitQueue : [];
    window.dischargeHistory  = Array.isArray(dischargeHistory) ? dischargeHistory : [];

    window.pcaShift          = typeof pcaShift === "string" ? pcaShift : "day";
    window.nextQueueId       = typeof nextQueueId === "number" ? nextQueueId : 1;
    window.nextDischargeId   = typeof nextDischargeId === "number" ? nextDischargeId : 1;

    window.availableUnits    = Array.isArray(availableUnits) ? availableUnits : [];
    window.activeUnitId      = activeUnitId || null;
    window.activeUnitRole    = activeUnitRole || null;
    window.unitSettings      = unitSettings || null;

    // Re-bind bare globals to the window arrays (so older files keep working)
    syncFromWindow();
  }

  // initial sync
  syncFromWindow();

  // ============ STORAGE KEYS ============
  const META_KEY = "cupp_assignment_engine_meta_v1";
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

      tele: false, drip: false, nih: false, bg: false, ciwa: false, restraint: false, sitter: false,
      vpo: false, isolation: false, admit: false, lateDc: false,

      chg: false, foley: false, q2turns: false, heavy: false, feeder: false,

      isEmpty: true,
      recentlyDischarged: false,
      reviewed: false
    };
  }

  function ensureDefaultPatients() {
    syncFromWindow();
    if (!Array.isArray(patients)) patients = [];
    if (patients.length >= 32) {
      syncToWindow();
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
    syncToWindow();
  }

  function applyBedsToPatientRooms() {
    syncFromWindow();
    const beds = Array.isArray(unitSettings?.beds) ? unitSettings.beds : null;
    if (!beds || beds.length < 1) return;

    ensureDefaultPatients();
    syncFromWindow();

    for (let i = 0; i < 32; i++) {
      const p = patients[i];
      if (!p) continue;
      const label = beds[i] != null ? String(beds[i]) : String(i + 1);
      p.room = label;
    }

    syncToWindow();
  }

  function resetAllPatients() {
    syncFromWindow();
    patients = [];
    syncToWindow();

    ensureDefaultPatients();
    applyBedsToPatientRooms();

    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();

    saveState();
  }

  // ============ UNIT SETTINGS APPLY ============
  function applyUnitSettings(nextSettings) {
    syncFromWindow();
    unitSettings = nextSettings || null;
    syncToWindow();

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
    return { noMales: false, noFemales: false, noTele: false, noMS: false, noFloat: false };
  }

  function saveMeta() {
    try {
      syncFromWindow();
      const meta = {
        activeUnitId: activeUnitId || null,
        activeUnitRole: activeUnitRole || null,
        unitSettings: unitSettings || null,
        availableUnits: Array.isArray(availableUnits) ? availableUnits : []
      };
      localStorage.setItem(META_KEY, JSON.stringify(meta));
    } catch (e) {
      console.warn("Unable to save meta", e);
    }
  }

  function saveState() {
    try {
      // IMPORTANT: always read from window.* (source of truth)
      syncFromWindow();

      const data = {
        pcaShift: window.pcaShift || "day",

        currentNurses: (window.currentNurses || []).map((n, i) => ({
          id: n.id ?? i + 1,
          staff_id: n.staff_id || null,
          name: n.name,
          type: n.type,
          restrictions: n.restrictions || defaultRestrictions(),
          patients: Array.isArray(n.patients) ? n.patients.slice() : []
        })),

        incomingNurses: (window.incomingNurses || []).map((n, i) => ({
          id: n.id ?? i + 1,
          staff_id: n.staff_id || null,
          name: n.name,
          type: n.type,
          restrictions: n.restrictions || defaultRestrictions(),
          patients: Array.isArray(n.patients) ? n.patients.slice() : []
        })),

        currentPcas: (window.currentPcas || []).map((p, i) => ({
          id: p.id ?? i + 1,
          staff_id: p.staff_id || null,
          name: p.name,
          restrictions: p.restrictions || { noIso: false },
          patients: Array.isArray(p.patients) ? p.patients.slice() : []
        })),

        incomingPcas: (window.incomingPcas || []).map((p, i) => ({
          id: p.id ?? i + 1,
          staff_id: p.staff_id || null,
          name: p.name,
          restrictions: p.restrictions || { noIso: false },
          patients: Array.isArray(p.patients) ? p.patients.slice() : []
        })),

        patients: (window.patients || []).map(p => ({ ...p })),

        dischargeHistory: Array.isArray(window.dischargeHistory) ? window.dischargeHistory : [],
        nextDischargeId: typeof window.nextDischargeId === "number" ? window.nextDischargeId : 1,

        admitQueue: Array.isArray(window.admitQueue) ? window.admitQueue : [],
        nextQueueId: typeof window.nextQueueId === "number" ? window.nextQueueId : 1
      };

      localStorage.setItem(unitKey(window.activeUnitId), JSON.stringify(data));
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

      window.activeUnitId   = meta.activeUnitId || null;
      window.activeUnitRole = meta.activeUnitRole || null;
      window.unitSettings   = (meta.unitSettings && typeof meta.unitSettings === "object") ? meta.unitSettings : null;
      window.availableUnits = Array.isArray(meta.availableUnits) ? meta.availableUnits : [];

      syncFromWindow();
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

      window.pcaShift       = data.pcaShift || "day";
      window.currentNurses  = Array.isArray(data.currentNurses) ? data.currentNurses : [];
      window.incomingNurses = Array.isArray(data.incomingNurses) ? data.incomingNurses : [];
      window.currentPcas    = Array.isArray(data.currentPcas) ? data.currentPcas : [];
      window.incomingPcas   = Array.isArray(data.incomingPcas) ? data.incomingPcas : [];

      window.patients         = Array.isArray(data.patients) ? data.patients : [];
      window.dischargeHistory = Array.isArray(data.dischargeHistory) ? data.dischargeHistory : [];
      window.nextDischargeId  = (typeof data.nextDischargeId === "number") ? data.nextDischargeId : 1;

      window.admitQueue     = Array.isArray(data.admitQueue) ? data.admitQueue : [];
      window.nextQueueId    = (typeof data.nextQueueId === "number") ? data.nextQueueId : 1;

      // Sync legacy globals to match window.*
      syncFromWindow();
      return true;
    } catch (e) {
      console.warn("Unable to load unit workspace", e);
      return false;
    }
  }

  function loadStateFromStorage() {
    loadMeta();
    const ok = loadUnitWorkspace(window.activeUnitId);

    ensureDefaultPatients();
    applyBedsToPatientRooms();

    // Ensure bare globals match
    syncFromWindow();
    return ok;
  }

  function initFromStorageOrDefaults() {
    loadStateFromStorage();

    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.renderQueueList === "function") window.renderQueueList();
    if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();

    if (window.activeUnitId && (!window.unitSettings || typeof window.unitSettings !== "object")) {
      setTimeout(() => {
        setActiveUnit(window.activeUnitId, window.activeUnitRole).catch(e => console.warn("setActiveUnit init load failed", e));
      }, 0);
    }
  }

  // ============ ACTIVE UNIT SETTER ============
  async function setActiveUnit(nextUnitId, role) {
    saveState();

    if (!nextUnitId) {
      window.activeUnitId = null;
      window.activeUnitRole = null;
      applyUnitSettings(null);
      saveMeta();
      syncFromWindow();
      return { ok: true };
    }

    window.activeUnitId = String(nextUnitId);
    window.activeUnitRole = role ? String(role) : (window.activeUnitRole || null);

    const loaded = loadUnitWorkspace(window.activeUnitId);
    if (!loaded) {
      window.currentNurses = [];
      window.incomingNurses = [];
      window.currentPcas = [];
      window.incomingPcas = [];
      window.admitQueue = [];
      window.dischargeHistory = [];
      window.nextQueueId = 1;
      window.nextDischargeId = 1;
      window.pcaShift = "day";
      window.patients = [];
      ensureDefaultPatients();
    } else {
      ensureDefaultPatients();
    }

    syncFromWindow();

    if (window.sb && window.sb.getUnitSettings) {
      const { row, error } = await window.sb.getUnitSettings(window.activeUnitId);
      if (error) {
        console.warn("[unit] Failed to load unit_settings", error);
        applyBedsToPatientRooms();
        saveState();
        return { ok: false, error };
      }
      applyUnitSettings(row);
    } else {
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

    window.availableUnits = mapped;

    if (!window.activeUnitId && mapped.length) {
      const first = mapped[0];
      await setActiveUnit(first.unit_id, first.role);
    } else {
      saveMeta();
    }

    syncFromWindow();
    return { ok: true, rows: mapped };
  }

  // ============ CLEAR “RECENTLY DISCHARGED” ============
  // NOTE: This is a legacy fallback. assignmentsDrag.js owns the canonical version now.
  function clearRecentlyDischargedFlags() {
    syncFromWindow();
    (patients || []).forEach(p => {
      if (!p) return;
      p.recentlyDischarged = false;
    });
    syncToWindow();

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

  // ============ STAFF ↔ PATIENT RESOLUTION HELPERS ============
  // These helpers intentionally DO NOT mutate state.
  // They read current assignment arrays and return the "responsible staff at this moment"
  // so event emitters can attach staff to payloads at event-time.

  function normalizePatientId(patientOrId) {
    if (patientOrId == null) return null;
    if (typeof patientOrId === "number") return patientOrId;
    if (typeof patientOrId === "string") {
      const n = Number(patientOrId);
      return Number.isFinite(n) ? n : null;
    }
    if (typeof patientOrId === "object") {
      if (typeof patientOrId.id === "number") return patientOrId.id;
      // fall back to room parsing if id missing
      if (typeof window.getRoomNumber === "function") {
        const maybe = window.getRoomNumber(patientOrId);
        return Number.isFinite(maybe) ? maybe : null;
      }
    }
    return null;
  }

  function listIncludesPatient(list, patientId) {
    if (!Array.isArray(list) || patientId == null) return false;
    // Most common: numeric ids like [1,2,3]
    if (list.includes(patientId)) return true;
    // Defensive: string ids like ["1","2"]
    if (list.includes(String(patientId))) return true;
    // Defensive: objects like [{id:1}] (rare but safe)
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      if (x == null) continue;
      if (typeof x === "number" && x === patientId) return true;
      if (typeof x === "string" && Number(x) === patientId) return true;
      if (typeof x === "object" && typeof x.id === "number" && x.id === patientId) return true;
    }
    return false;
  }

  function findAssignedNurse(patientOrId) {
    const pid = normalizePatientId(patientOrId);
    if (pid == null) return null;
    const nursesArr = Array.isArray(window.currentNurses) ? window.currentNurses : [];
    for (let i = 0; i < nursesArr.length; i++) {
      const n = nursesArr[i];
      if (!n) continue;
      if (listIncludesPatient(n.patients, pid)) return n;
    }
    return null;
  }

  function findAssignedPca(patientOrId) {
    const pid = normalizePatientId(patientOrId);
    if (pid == null) return null;
    const pcasArr = Array.isArray(window.currentPcas) ? window.currentPcas : [];
    for (let i = 0; i < pcasArr.length; i++) {
      const p = pcasArr[i];
      if (!p) continue;
      if (listIncludesPatient(p.patients, pid)) return p;
    }
    return null;
  }

  function getAssignmentContextForPatient(patientOrId) {
    const rn = findAssignedNurse(patientOrId);
    const pca = findAssignedPca(patientOrId);
    return {
      rnId: rn ? (rn.id ?? null) : null,
      pcaId: pca ? (pca.id ?? null) : null,
      rnStaffId: rn ? (rn.staff_id ?? null) : null,
      pcaStaffId: pca ? (pca.staff_id ?? null) : null
    };
  }

  function getResponsibleStaffIdsForPatient(patientOrId) {
    const ctx = getAssignmentContextForPatient(patientOrId);
    // Prefer stable staff_id if present; fall back to local numeric id.
    return {
      rnId: ctx.rnStaffId || ctx.rnId || null,
      pcaId: ctx.pcaStaffId || ctx.pcaId || null
    };
  }

  // Expose helpers for later file updates
  window.findAssignedNurse = window.findAssignedNurse || findAssignedNurse;
  window.findAssignedPca = window.findAssignedPca || findAssignedPca;
  window.getAssignmentContextForPatient = window.getAssignmentContextForPatient || getAssignmentContextForPatient;
  window.getResponsibleStaffIdsForPatient = window.getResponsibleStaffIdsForPatient || getResponsibleStaffIdsForPatient;

  // ============ AUTOSAVE / SAVE-ON-REFRESH SAFETY ============
  let __dirty = false;
  let __saveTimer = null;

  function markDirty() {
    __dirty = true;
    if (__saveTimer) return;
    __saveTimer = setTimeout(() => {
      __saveTimer = null;
      if (!__dirty) return;
      __dirty = false;
      saveState();
    }, 500);
  }

  window.markDirty = markDirty;

  window.addEventListener("beforeunload", () => {
    try { saveState(); } catch (_) {}
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      try { saveState(); } catch (_) {}
    }
  });

  // ============ EXPORT TO WINDOW ============
  window.ensureDefaultPatients = ensureDefaultPatients;
  window.resetAllPatients = resetAllPatients;

  window.saveState = saveState;
  window.loadStateFromStorage = loadStateFromStorage;
  window.initFromStorageOrDefaults = initFromStorageOrDefaults;

  // ✅ IMPORTANT: Do NOT overwrite a newer implementation (assignmentsDrag owns this now).
  // Fix: previously the file ended with an incomplete if statement.
  if (typeof window.clearRecentlyDischargedFlags !== "function") {
    window.clearRecentlyDischargedFlags = clearRecentlyDischargedFlags;
  }

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