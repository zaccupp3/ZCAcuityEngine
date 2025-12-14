// app/app.init.js
// Central bootstrap for the entire app.
// Runs once on DOMContentLoaded, sets up staffing, patients, and initial renders.
//
// CLOUD UNIT STATE (Option A):
// - Canonical board lives in public.unit_state.state (jsonb) per unit_id
// - On boot: load memberships -> set active unit -> load unit_state -> render
// - Realtime: subscribe to unit_state row changes and apply updates
// - Writing: charge/admin/owner publish changes (debounced) via wrapped saveState()

window.addEventListener("DOMContentLoaded", async () => {
  console.log("APP INIT: Starting initialization…");

  // -----------------------------
  // Safe helpers
  // -----------------------------
  function sbReady() {
    return !!(window.sb && window.sb.client);
  }

  function canWriteRole(role) {
    const r = String(role || "").toLowerCase();
    return r === "owner" || r === "admin" || r === "charge";
  }

  function refreshAllUI() {
    try { if (typeof window.renderPatientList === "function") window.renderPatientList(); } catch {}
    try { if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles(); } catch {}
    try { if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments(); } catch {}
    try { if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput(); } catch {}
    try { if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput(); } catch {}
    try { if (typeof window.renderQueueList === "function") window.renderQueueList(); } catch {}
    try { if (typeof window.updateDischargeCount === "function") window.updateDischargeCount(); } catch {}
  }

  // Build a full board snapshot from current window globals
  function snapshotFromWindow() {
    return {
      pcaShift: window.pcaShift || "day",

      currentNurses: Array.isArray(window.currentNurses) ? window.currentNurses : [],
      incomingNurses: Array.isArray(window.incomingNurses) ? window.incomingNurses : [],

      currentPcas: Array.isArray(window.currentPcas) ? window.currentPcas : [],
      incomingPcas: Array.isArray(window.incomingPcas) ? window.incomingPcas : [],

      patients: Array.isArray(window.patients) ? window.patients : [],

      admitQueue: Array.isArray(window.admitQueue) ? window.admitQueue : [],
      nextQueueId: typeof window.nextQueueId === "number" ? window.nextQueueId : 1,

      dischargeHistory: Array.isArray(window.dischargeHistory) ? window.dischargeHistory : [],
      nextDischargeId: typeof window.nextDischargeId === "number" ? window.nextDischargeId : 1
    };
  }

  // Apply a board snapshot into window globals
  function applySnapshotToWindow(state) {
    const s = state && typeof state === "object" ? state : {};

    window.pcaShift = typeof s.pcaShift === "string" ? s.pcaShift : (window.pcaShift || "day");

    window.currentNurses = Array.isArray(s.currentNurses) ? s.currentNurses : [];
    window.incomingNurses = Array.isArray(s.incomingNurses) ? s.incomingNurses : [];

    window.currentPcas = Array.isArray(s.currentPcas) ? s.currentPcas : [];
    window.incomingPcas = Array.isArray(s.incomingPcas) ? s.incomingPcas : [];

    window.patients = Array.isArray(s.patients) ? s.patients : [];

    window.admitQueue = Array.isArray(s.admitQueue) ? s.admitQueue : [];
    window.nextQueueId = typeof s.nextQueueId === "number" ? s.nextQueueId : 1;

    window.dischargeHistory = Array.isArray(s.dischargeHistory) ? s.dischargeHistory : [];
    window.nextDischargeId = typeof s.nextDischargeId === "number" ? s.nextDischargeId : 1;

    // Ensure patient grid is valid and labels stay consistent
    try { if (typeof window.ensureDefaultPatients === "function") window.ensureDefaultPatients(); } catch {}
    try { if (typeof window.applyBedsToPatientRooms === "function") window.applyBedsToPatientRooms(); } catch {}
  }

  // -----------------------------
  // Cloud sync plumbing
  // -----------------------------
  window.__cloud = window.__cloud || {};
  window.__cloud.unitStateVersion = typeof window.__cloud.unitStateVersion === "number" ? window.__cloud.unitStateVersion : 0;
  window.__cloud.unitStateChannel = window.__cloud.unitStateChannel || null;

  let publishTimer = null;
  let publishQueued = false;

  async function publishUnitStateNow(reason = "") {
    if (!sbReady()) return;
    if (!window.activeUnitId) return;

    const role = window.activeUnitRole;
    if (!canWriteRole(role)) return;

    if (typeof window.sb?.upsertUnitState !== "function") {
      console.warn("[cloud] sb.upsertUnitState missing (add to app.supabase.js).");
      return;
    }

    let userId = null;
    try {
      const { data } = await window.sb.client.auth.getSession();
      userId = data?.session?.user?.id || null;
    } catch {}

    const nextVersion = (window.__cloud.unitStateVersion || 0) + 1;
    const payload = {
      unit_id: String(window.activeUnitId),
      state: snapshotFromWindow(),
      version: nextVersion,
      updated_by: userId
    };

    const { row, error } = await window.sb.upsertUnitState(payload);
    if (error) {
      console.warn("[cloud] upsertUnitState error", error);
      return;
    }

    // If DB returns version, keep it; otherwise keep our increment
    window.__cloud.unitStateVersion = (row && typeof row.version === "number") ? row.version : nextVersion;

    if (reason) console.log(`[cloud] published unit_state (${reason}) v=${window.__cloud.unitStateVersion}`);
  }

  function publishUnitStateDebounced(reason = "") {
    publishQueued = true;

    if (publishTimer) return;
    publishTimer = setTimeout(async () => {
      publishTimer = null;
      if (!publishQueued) return;
      publishQueued = false;
      await publishUnitStateNow(reason || "debounced");
    }, 600); // debounce window (tune later)
  }

  async function loadUnitStateFromCloud(unitId) {
    if (!sbReady()) return { ok: false, error: new Error("Supabase not ready") };
    if (!unitId) return { ok: false, error: new Error("Missing unitId") };

    if (typeof window.sb?.getUnitState !== "function") {
      console.warn("[cloud] sb.getUnitState missing (add to app.supabase.js).");
      return { ok: false, error: new Error("sb.getUnitState missing") };
    }

    const { row, error } = await window.sb.getUnitState(String(unitId));
    if (error) return { ok: false, error };

    // If row doesn't exist yet, do not wipe local state. We can publish initial state later.
    if (!row) return { ok: true, empty: true };

    // Apply cloud state
    const cloudState = row.state || {};
    applySnapshotToWindow(cloudState);

    // Track version
    if (typeof row.version === "number") {
      window.__cloud.unitStateVersion = row.version;
    }

    return { ok: true, row };
  }

  function unsubscribeUnitState() {
    try {
      const ch = window.__cloud.unitStateChannel;
      if (ch && typeof ch.unsubscribe === "function") ch.unsubscribe();
    } catch {}
    window.__cloud.unitStateChannel = null;
  }

  async function subscribeUnitState(unitId) {
    if (!sbReady()) return;
    if (!unitId) return;

    if (typeof window.sb?.subscribeUnitState !== "function") {
      console.warn("[cloud] sb.subscribeUnitState missing (add to app.supabase.js).");
      return;
    }

    unsubscribeUnitState();

    // Subscribe and apply changes
    window.__cloud.unitStateChannel = window.sb.subscribeUnitState(String(unitId), async (payload) => {
      try {
        // Some payloads include new row; safest is to re-fetch row for this unit
        const { row, error } = await window.sb.getUnitState(String(unitId));
        if (error || !row) return;

        const incomingV = typeof row.version === "number" ? row.version : 0;
        const localV = typeof window.__cloud.unitStateVersion === "number" ? window.__cloud.unitStateVersion : 0;

        // Only apply if it's newer than what we have
        if (incomingV > localV) {
          window.__cloud.unitStateVersion = incomingV;
          applySnapshotToWindow(row.state || {});
          refreshAllUI();
          console.log(`[cloud] applied incoming unit_state v=${incomingV}`);
        }
      } catch (e) {
        console.warn("[cloud] realtime apply error", e);
      }
    });
  }

  // Expose a minimal API other scripts can call
  window.cloudSync = {
    loadUnitStateFromCloud,
    subscribeUnitState,
    unsubscribeUnitState,
    publishUnitStateNow,
    publishUnitStateDebounced
  };

  // -----------------------------
  // BOOT (do not assume local is canonical)
  // -----------------------------

  // Ensure base patient structure exists (safe defaults)
  try { if (typeof window.ensureDefaultPatients === "function") window.ensureDefaultPatients(); } catch {}

  // IMPORTANT:
  // We still load localStorage as a fallback/boot strap for now,
  // but cloud will overwrite once we fetch unit_state.
  try { if (typeof window.loadStateFromStorage === "function") window.loadStateFromStorage(); } catch {}

  // Wrap saveState() so existing UI actions trigger cloud publish too
  // (This is the fastest way to get “continuous” without refactoring every handler.)
  if (!window.__cloud.__saveWrapped && typeof window.saveState === "function") {
    const originalSaveState = window.saveState;
    window.saveState = function wrappedSaveState() {
      // keep existing behavior (local cache)
      try { originalSaveState(); } catch {}

      // publish to cloud (charge/admin/owner only)
      try { publishUnitStateDebounced("saveState"); } catch {}
    };
    window.__cloud.__saveWrapped = true;
  }

  // -----------------------------
  // MULTI-UNIT BOOTSTRAP
  // -----------------------------
  if (sbReady() && window.refreshMyUnits && typeof window.refreshMyUnits === "function") {
    try {
      const res = await window.refreshMyUnits();
      if (!res?.ok) console.warn("[init] refreshMyUnits not ok", res?.error);
    } catch (e) {
      console.warn("[init] refreshMyUnits failed", e);
    }
  } else {
    console.warn("[init] Supabase not configured or refreshMyUnits missing (offline/demo mode).");
  }

  // Ensure active unit settings are loaded (your existing behavior)
  if (window.activeUnitId && window.setActiveUnit && typeof window.setActiveUnit === "function") {
    try {
      await window.setActiveUnit(window.activeUnitId, window.activeUnitRole || null);
    } catch (e) {
      console.warn("[init] setActiveUnit failed", e);
    }
  }

  // -----------------------------
  // CLOUD LOAD + REALTIME SUBSCRIBE (canonical)
  // -----------------------------
  if (sbReady() && window.activeUnitId) {
    try {
      const res = await loadUnitStateFromCloud(window.activeUnitId);

      // If no row exists yet for this unit, you can seed it from current state (charge/admin/owner only)
      if (res?.ok && res?.empty) {
        console.log("[cloud] No unit_state row found yet; will publish initial state when eligible.");
        publishUnitStateDebounced("seed-if-empty");
      }

      await subscribeUnitState(window.activeUnitId);
    } catch (e) {
      console.warn("[init] cloud load/subscribe failed", e);
    }
  }

  // -----------------------------
  // STAFFING INIT (if empty, create defaults)
  // -----------------------------
  const currentNurseCountSel = document.getElementById("currentNurseCount");
  const incomingNurseCountSel = document.getElementById("incomingNurseCount");
  const currentPcaCountSel = document.getElementById("currentPcaCount");
  const incomingPcaCountSel = document.getElementById("incomingPcaCount");

  if (!currentNurses.length) {
    if (currentNurseCountSel) currentNurseCountSel.value = 4;
    setupCurrentNurses();
  } else {
    if (currentNurseCountSel) currentNurseCountSel.value = currentNurses.length;
    renderCurrentNurseList();
  }

  if (!incomingNurses.length) {
    if (incomingNurseCountSel) incomingNurseCountSel.value = 4;
    setupIncomingNurses();
  } else {
    if (incomingNurseCountSel) incomingNurseCountSel.value = incomingNurses.length;
    renderIncomingNurseList();
  }

  if (!currentPcas.length) {
    if (currentPcaCountSel) currentPcaCountSel.value = 2;
    setupCurrentPcas();
  } else {
    if (currentPcaCountSel) currentPcaCountSel.value = currentPcas.length;
    renderCurrentPcaList();
  }

  if (!incomingPcas.length) {
    if (incomingPcaCountSel) incomingPcaCountSel.value = 2;
    setupIncomingPcas();
  } else {
    if (incomingPcaCountSel) incomingPcaCountSel.value = incomingPcas.length;
    renderIncomingPcaList();
  }

  // PCA shift selector
  const shiftSel = document.getElementById("pcaShift");
  if (shiftSel) shiftSel.value = pcaShift;

  // Autopopulate LIVE assignment if empty
  if (typeof autoPopulateLiveAssignments === "function") {
    autoPopulateLiveAssignments();
  }

  // Initial renders
  refreshAllUI();

  // Tab fix
  const firstTabBtn = document.querySelector('.tabButton[data-target="staffingTab"]');
  if (typeof showTab === "function" && firstTabBtn) {
    showTab("staffingTab", firstTabBtn);
  }

  console.log("APP INIT: Initialization complete.");
});