// app/app.init.js
// Central bootstrap for the entire app.
// Runs once on DOMContentLoaded, sets up staffing, patients, and initial renders.
//
// CLOUD UNIT STATE (Option A):
// - Canonical board lives in public.unit_state.state (jsonb) per unit_id
// - On boot: load memberships -> set active unit -> load unit_state -> render
// - Realtime: subscribe to unit_state row changes and apply updates
// - Writing: charge/admin/owner publish changes (debounced) via wrapped saveState()
//
// ✅ Adds continuous Sync Status UI:
// - Pending / Syncing / Synced / Error
// - Updates on edit (saveState), on publish start/end, and on realtime apply
//
// ✅ Adds boot-time loading overlay with step-based % (milestones)
// - Avoids “it’s stuck” feeling during session/membership/unit_state/realtime/render
//
// ✅ NEW (Dec 2025):
// - Cloud loop protection (mute publish during remote apply + snapshot dedupe + cooldown)
//   Fixes “publishing every second” feedback loops.
//
// ✅ NEW (EVENT LOG - LIVE ONLY, PHASE 1):
// - Establish a LIVE shift session key (window.liveShiftKey)
// - Provide window.appendEvent helper for append-only audit log
// - Append SHIFT_LIVE_STARTED AFTER unit selection + storage/cloud load for correct unitId/pcaShift
//
// ✅ NEW (UI RELIABILITY):
// - Bind "Clear recently discharged" button click in JS (no reliance on inline onclick)
//
// NOTE: eventLog is local-only for now (NOT included in cloud unit_state snapshot).

window.addEventListener("DOMContentLoaded", async () => {
  console.log("APP INIT: Starting initialization…");

  // -----------------------------
  // ✅ Event Log (LIVE only) bootstrap (helper + session key)
  // -----------------------------
  window.eventLog = Array.isArray(window.eventLog) ? window.eventLog : [];

  function __evtId() {
    try {
      // Best: native UUID (matches audit_events.id uuid type)
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch {}

    // Fallback: valid UUID v4 string format
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function __isoNow() {
    try { return new Date().toISOString(); } catch { return String(Date.now()); }
  }

  function __makeLiveShiftKey() {
    const t = Date.now();
    const r = Math.random().toString(36).slice(2, 10);
    return `live_${t}_${r}`;
  }

  // Canonical append-only helper (other files will call this)
  window.appendEvent = window.appendEvent || function appendEvent(type, payload = {}, meta = {}) {
    try {
      window.eventLog = Array.isArray(window.eventLog) ? window.eventLog : [];

      const evt = {
        id: __evtId(),
        ts: __isoNow(),
        type: String(type || "UNKNOWN"),
        unitId: window.activeUnitId ? String(window.activeUnitId) : null,
        shiftKey: window.liveShiftKey ? String(window.liveShiftKey) : null,
        actor: meta.actor || "local",
        payload: payload && typeof payload === "object" ? payload : { value: payload },
        meta: meta && typeof meta === "object" ? meta : {}
      };

      window.eventLog.push(evt);

      // Persist using existing pattern (debounced)
      try { if (typeof window.markDirty === "function") window.markDirty(); } catch {}

      return evt;
    } catch (e) {
      console.warn("[eventLog] appendEvent failed", e);
      return null;
    }
  };

  // Create a LIVE shiftKey once per boot (MVP)
  if (!window.liveShiftKey || typeof window.liveShiftKey !== "string") {
    window.liveShiftKey = __makeLiveShiftKey();
  }

  // Append SHIFT_LIVE_STARTED once, but ONLY when unitId/pcaShift are settled (called later)
  function appendLiveShiftStartedOnce(context = {}) {
    try {
      window.eventLog = Array.isArray(window.eventLog) ? window.eventLog : [];

      // Dedupe per shiftKey
      const already = window.eventLog.some(e =>
        e && e.type === "SHIFT_LIVE_STARTED" && e.shiftKey === window.liveShiftKey
      );
      if (already) return;

      window.appendEvent("SHIFT_LIVE_STARTED", {
        mode: "live",
        pcaShift: window.pcaShift || "day",
        ...context
      }, {
        v: 1,
        source: "app.init.js"
      });
    } catch (e) {
      console.warn("[eventLog] SHIFT_LIVE_STARTED failed", e);
    }
  }

  // ---- EVENT CAPTURE ARMING (LIVE) ----
  if (typeof window.appendEvent === "function" && typeof window.canLogEvents === "function") {
    try {
      window.canLogEvents(true);
    } catch (_) {}
  }

  // -----------------------------
  // ✅ NEW (PHASE 1.5): Persist events to Supabase (public.audit_events) + offline outbox
  // NOTE: This does NOT change the event model. It only publishes events after appendEvent creates them.
  // -----------------------------
  (function setupAuditEventPublish() {
    // Prevent double attachment if init is ever re-run (defensive).
    if (window.__auditPublishAttached) return;
    window.__auditPublishAttached = true;

    // Ensure window.sb exists
    window.sb = window.sb || {};

    function sbClientReady() {
      return !!(window.sb && window.sb.client);
    }

    function isUuid(v) {
      return typeof v === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
    }

    // Outbox key is per-unit so unit timelines don't mix.
    window.auditOutboxKey = function auditOutboxKey() {
      return `audit_outbox_${window.activeUnitId || "no_unit"}`;
    };

    window.enqueueAuditEvent = function enqueueAuditEvent(evt) {
      try {
        const key = window.auditOutboxKey();
        const outbox = JSON.parse(localStorage.getItem(key) || "[]");
        outbox.push({ evt, queuedAt: new Date().toISOString() });
        localStorage.setItem(key, JSON.stringify(outbox));
      } catch (e) {
        console.warn("[audit] Failed to queue outbox", e);
      }
    };

    // Insert one event into public.audit_events (append-only)
    window.sb.insertAuditEvent = window.sb.insertAuditEvent || async function insertAuditEvent(evt) {
      if (!sbClientReady()) throw new Error("Supabase client not ready (window.sb.client)");

      // ✅ SELF-HEALING UUID:
      // If evt.id is missing or not a UUID (old outbox / old code), replace it so inserts never get stuck.
      const safeId = isUuid(evt?.id) ? evt.id : __evtId();
      if (evt && evt.id !== safeId) {
        try { evt.id = safeId; } catch {}
      }

      // Map your event object -> audit_events row
      const row = {
        id: safeId,                        // uuid (idempotency across retries)
        unit_id: evt.unitId || null,       // uuid
        shift_key: evt.shiftKey || null,   // text
        ts: evt.ts || null,                // timestamptz
        actor: evt.actor || "local",       // text
        event_type: evt.type || "UNKNOWN", // text
        payload: evt.payload || {},        // jsonb
        meta: evt.meta || {}               // jsonb
        // actor_user_id is default auth.uid() on insert (per your schema)
        // created_at is default now()
      };

      const { error } = await window.sb.client
        .from("audit_events")
        .insert(row);

      if (!error) return true;

      // Treat duplicate PK as success (outbox retries)
      const msg = String(error.message || error);
      if (msg.toLowerCase().includes("duplicate")) return true;

      throw error;
    };

    window.flushAuditOutbox = window.flushAuditOutbox || async function flushAuditOutbox({ limit = 50 } = {}) {
      if (!sbClientReady()) return;

      const key = window.auditOutboxKey();
      let outbox = [];
      try { outbox = JSON.parse(localStorage.getItem(key) || "[]"); } catch {}

      if (!Array.isArray(outbox) || outbox.length === 0) return;

      const remaining = [];
      let sent = 0;

      for (const item of outbox) {
        if (sent >= limit) { remaining.push(item); continue; }
        try {
          if (item && item.evt) await window.sb.insertAuditEvent(item.evt);
          sent++;
        } catch (e) {
          remaining.push(item);
        }
      }

      try { localStorage.setItem(key, JSON.stringify(remaining)); } catch {}
    };

    // Wrap appendEvent (best-effort publish; never block UI)
    // IMPORTANT: we keep original appendEvent behavior completely intact.
    const originalAppend = window.appendEvent;
    if (typeof originalAppend === "function" && !window.__auditAppendWrapped) {
      window.__auditAppendWrapped = true;

      window.appendEvent = function patchedAppendEvent(type, payload = {}, meta = {}) {
        const evt = originalAppend(type, payload, meta);

        // Fire-and-forget publish. Never block UI.
        (async () => {
          try {
            if (!evt) return;

            if (sbClientReady() && typeof window.sb.insertAuditEvent === "function") {
              await window.sb.insertAuditEvent(evt);
            } else {
              window.enqueueAuditEvent(evt);
            }
          } catch (e) {
            try { window.enqueueAuditEvent(evt); } catch {}
          }
        })();

        return evt;
      };
    }

    // Flush on network restore
    window.addEventListener("online", () => {
      try { window.flushAuditOutbox({ limit: 100 }).catch(() => {}); } catch {}
    });
  })();

  // -----------------------------
  // Boot loader overlay (step-based %)
  // -----------------------------
  let __bootDone = false;
  let __bootShown = false;

  function bootLoaderShow() {
    const el = document.getElementById("bootLoader");
    if (!el) return;
    el.style.display = "flex";
    __bootShown = true;
  }

  function bootLoaderHide() {
    const el = document.getElementById("bootLoader");
    if (!el) return;
    el.style.display = "none";
  }

  function bootLoaderSet(pct, msg) {
    const bar = document.getElementById("bootLoaderBar");
    const txt = document.getElementById("bootLoaderMsg");
    const p = document.getElementById("bootLoaderPct");
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    if (bar) bar.style.width = `${clamped}%`;
    if (p) p.textContent = `${Math.round(clamped)}%`;
    if (txt && msg) txt.textContent = msg;
  }

  // Don’t flash loader on fast loads: show only if still booting after 200ms
  setTimeout(() => {
    if (__bootDone) return;
    bootLoaderShow();
    bootLoaderSet(5, "Starting…");
  }, 200);

  function bootStep(pct, msg) {
    if (!__bootShown && !__bootDone) bootLoaderShow();
    bootLoaderSet(pct, msg);
  }

  function bootFinish() {
    __bootDone = true;
    if (!__bootShown) return;
    bootLoaderSet(100, "Ready");
    setTimeout(() => bootLoaderHide(), 250);
  }

  window.bootProgress = {
    step: bootStep,
    done: bootFinish
  };

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

  // -----------------------------
  // ✅ Sync status pill UI
  // -----------------------------
  window.__cloud = window.__cloud || {};
  window.__cloud.unitStateVersion =
    typeof window.__cloud.unitStateVersion === "number" ? window.__cloud.unitStateVersion : 0;
  window.__cloud.unitStateChannel = window.__cloud.unitStateChannel || null;

  window.__cloud.sync = window.__cloud.sync || {
    status: "idle",        // idle | pending | syncing | synced | error
    lastSyncedAt: null,    // Date
    lastError: null        // string
  };

  function fmtTime(d) {
    try {
      const dt = (d instanceof Date) ? d : new Date(d);
      return dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return "";
    }
  }

  function ensureSyncPill() {
    if (document.getElementById("syncStatusPill")) return;

    const pill = document.createElement("div");
    pill.id = "syncStatusPill";
    pill.setAttribute("role", "status");
    pill.style.position = "fixed";
    pill.style.right = "14px";
    pill.style.bottom = "14px";
    pill.style.zIndex = "9999";
    pill.style.display = "flex";
    pill.style.alignItems = "center";
    pill.style.gap = "10px";
    pill.style.padding = "10px 12px";
    pill.style.borderRadius = "999px";
    pill.style.border = "1px solid rgba(15, 23, 42, 0.15)";
    pill.style.background = "rgba(255,255,255,0.85)";
    pill.style.backdropFilter = "blur(8px)";
    pill.style.boxShadow = "0 6px 22px rgba(16,24,40,0.12)";
    pill.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    pill.style.fontSize = "12px";
    pill.style.color = "#0f172a";
    pill.style.userSelect = "none";

    pill.innerHTML = `
      <span id="syncDot" style="
        width:10px;height:10px;border-radius:999px;
        background:#94a3b8; display:inline-block;"></span>
      <span id="syncText" style="font-weight:700;">Sync: —</span>
      <span id="syncMeta" style="opacity:0.75;"></span>
    `;

    document.body.appendChild(pill);
  }

  function setSyncUI(status, metaText, errorText) {
    ensureSyncPill();

    const dot = document.getElementById("syncDot");
    const text = document.getElementById("syncText");
    const meta = document.getElementById("syncMeta");
    const pill = document.getElementById("syncStatusPill");

    if (!dot || !text || !meta || !pill) return;

    let dotColor = "#94a3b8"; // slate
    let label = "Sync: —";

    if (status === "pending") { dotColor = "#fbbf24"; label = "Sync: Pending…"; }
    if (status === "syncing") { dotColor = "#3b82f6"; label = "Sync: Syncing…"; }
    if (status === "synced")  { dotColor = "#22c55e"; label = "Sync: Synced"; }
    if (status === "error")   { dotColor = "#ef4444"; label = "Sync: Error"; }

    dot.style.background = dotColor;
    text.textContent = label;
    meta.textContent = metaText || "";
    pill.title = errorText || "";
  }

  function setSyncStatus(nextStatus, opts = {}) {
    window.__cloud.sync.status = nextStatus;
    if (typeof opts.error === "string") window.__cloud.sync.lastError = opts.error;
    if (opts.lastSyncedAt) window.__cloud.sync.lastSyncedAt = opts.lastSyncedAt;

    const last = window.__cloud.sync.lastSyncedAt;
    const lastTxt = last ? `@ ${fmtTime(last)}` : "";

    if (nextStatus === "pending") setSyncUI("pending", "queued");
    else if (nextStatus === "syncing") setSyncUI("syncing", "publishing…");
    else if (nextStatus === "synced") setSyncUI("synced", lastTxt);
    else if (nextStatus === "error") setSyncUI("error", "hover for details", window.__cloud.sync.lastError || "");
    else setSyncUI("idle", lastTxt);
  }

  // Create pill early
  setSyncStatus(window.__cloud.sync.status || "idle");

  // -----------------------------
  // Build a full board snapshot from current window globals
  // -----------------------------
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

    try { if (typeof window.ensureDefaultPatients === "function") window.ensureDefaultPatients(); } catch {}
    try { if (typeof window.applyBedsToPatientRooms === "function") window.applyBedsToPatientRooms(); } catch {}
  }

  // -----------------------------
  // ✅ Cloud loop protection (mute + dedupe + cooldown)
  // -----------------------------
  window.__cloud.mutePublishDepth =
    typeof window.__cloud.mutePublishDepth === "number" ? window.__cloud.mutePublishDepth : 0;

  function withPublishMuted(fn) {
    window.__cloud.mutePublishDepth++;
    try { return fn(); }
    finally { window.__cloud.mutePublishDepth = Math.max(0, window.__cloud.mutePublishDepth - 1); }
  }

  window.__cloud.lastPublishedSnapshotStr = window.__cloud.lastPublishedSnapshotStr || "";
  window.__cloud.lastQueuedSnapshotStr = window.__cloud.lastQueuedSnapshotStr || "";
  window.__cloud.lastPublishAt =
    typeof window.__cloud.lastPublishAt === "number" ? window.__cloud.lastPublishAt : 0;

  function snapshotString() {
    try { return JSON.stringify(snapshotFromWindow()); } catch { return ""; }
  }

  // -----------------------------
  // Cloud sync plumbing
  // -----------------------------
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

    if (window.__cloud.mutePublishDepth > 0) return;

    const snapStr = snapshotString();
    if (snapStr && snapStr === window.__cloud.lastPublishedSnapshotStr) {
      setSyncStatus("synced", { lastSyncedAt: window.__cloud.sync.lastSyncedAt || new Date() });
      return;
    }

    setSyncStatus("syncing");

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

    try {
      const { row, error } = await window.sb.upsertUnitState(payload);
      if (error) {
        console.warn("[cloud] upsertUnitState error", error);
        setSyncStatus("error", { error: error.message || String(error) });
        return;
      }

      window.__cloud.unitStateVersion = (row && typeof row.version === "number") ? row.version : nextVersion;

      if (snapStr) window.__cloud.lastPublishedSnapshotStr = snapStr;
      window.__cloud.lastPublishAt = Date.now();

      setSyncStatus("synced", { lastSyncedAt: new Date() });

      if (reason) console.log(`[cloud] published unit_state (${reason}) v=${window.__cloud.unitStateVersion}`);
    } catch (e) {
      console.warn("[cloud] upsertUnitState exception", e);
      setSyncStatus("error", { error: String(e) });
    }
  }

  function publishUnitStateDebounced(reason = "") {
    if (window.__cloud.mutePublishDepth > 0) return;

    const snapStr = snapshotString();
    if (!snapStr) return;

    if (snapStr === window.__cloud.lastQueuedSnapshotStr && publishTimer) return;
    window.__cloud.lastQueuedSnapshotStr = snapStr;

    publishQueued = true;
    setSyncStatus("pending");

    if (publishTimer) return;

    publishTimer = setTimeout(async () => {
      publishTimer = null;
      if (!publishQueued) return;
      publishQueued = false;

      const now = Date.now();
      const minGapMs = 900;
      if (now - window.__cloud.lastPublishAt < minGapMs) {
        publishUnitStateDebounced(reason || "cooldown");
        return;
      }

      await publishUnitStateNow(reason || "debounced");
    }, 600);
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

    if (!row) return { ok: true, empty: true };

    const cloudState = row.state || row.state_json || row || {};

    withPublishMuted(() => {
      applySnapshotToWindow(cloudState.state || cloudState);
    });

    if (typeof row.version === "number") window.__cloud.unitStateVersion = row.version;
    setSyncStatus("synced", { lastSyncedAt: new Date() });

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

    window.__cloud.unitStateChannel = window.sb.subscribeUnitState(String(unitId), async () => {
      try {
        const { row, error } = await window.sb.getUnitState(String(unitId));
        if (error || !row) return;

        const incomingV = typeof row.version === "number" ? row.version : 0;
        const localV = typeof window.__cloud.unitStateVersion === "number" ? window.__cloud.unitStateVersion : 0;

        if (incomingV > localV) {
          window.__cloud.unitStateVersion = incomingV;

          const st = row.state || row.state_json || row || {};

          withPublishMuted(() => {
            applySnapshotToWindow(st.state || st);
            refreshAllUI();
          });

          setSyncStatus("synced", { lastSyncedAt: new Date() });

          console.log(`[cloud] applied incoming unit_state v=${incomingV}`);
        }
      } catch (e) {
        console.warn("[cloud] realtime apply error", e);
      }
    });
  }

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
  bootStep(10, "Preparing local state…");

  try { if (typeof window.ensureDefaultPatients === "function") window.ensureDefaultPatients(); } catch {}
  try { if (typeof window.loadStateFromStorage === "function") window.loadStateFromStorage(); } catch {}

  if (!window.__cloud.__saveWrapped && typeof window.saveState === "function") {
    const originalSaveState = window.saveState;
    window.saveState = function wrappedSaveState() {
      try { originalSaveState(); } catch {}
      if (window.__cloud.mutePublishDepth > 0) return;
      try { publishUnitStateDebounced("saveState"); } catch {}
    };
    window.__cloud.__saveWrapped = true;
  }

  // -----------------------------
  // MULTI-UNIT BOOTSTRAP
  // -----------------------------
  bootStep(25, "Loading your units…");

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

  bootStep(45, "Selecting active unit…");
  if (window.activeUnitId && window.setActiveUnit && typeof window.setActiveUnit === "function") {
    try {
      await window.setActiveUnit(window.activeUnitId, window.activeUnitRole || null);
    } catch (e) {
      console.warn("[init] setActiveUnit failed", e);
    }
  }

  // ✅ Flush any queued audit events after unit selection (so outbox key uses activeUnitId)
  try {
    if (sbReady() && typeof window.flushAuditOutbox === "function") {
      window.flushAuditOutbox({ limit: 200 }).catch(() => {});
    }
  } catch {}

  // -----------------------------
  // CLOUD LOAD + REALTIME SUBSCRIBE (canonical)
  // -----------------------------
  let __bootSource = "local";
  if (sbReady() && window.activeUnitId) {
    bootStep(65, "Syncing unit state…");
    try {
      const res = await loadUnitStateFromCloud(window.activeUnitId);

      if (res?.ok && res?.empty) {
        console.log("[cloud] No unit_state row found yet; will publish initial state when eligible.");
        publishUnitStateDebounced("seed-if-empty");
      } else if (res?.ok) {
        __bootSource = "cloud";
      }

      bootStep(85, "Connecting realtime…");
      await subscribeUnitState(window.activeUnitId);
    } catch (e) {
      console.warn("[init] cloud load/subscribe failed", e);
    }
  } else {
    bootStep(70, "Offline/demo mode…");
  }

  // ✅ Flush again after cloud setup (helpful if auth/session wasn’t ready earlier)
  try {
    if (sbReady() && typeof window.flushAuditOutbox === "function") {
      window.flushAuditOutbox({ limit: 200 }).catch(() => {});
    }
  } catch {}

  // ✅ Now that unitId + pcaShift are settled, append SHIFT_LIVE_STARTED (once per shiftKey)
  appendLiveShiftStartedOnce({ bootSource: __bootSource });

  // -----------------------------
  // STAFFING INIT (if empty, create defaults)
  // -----------------------------
  bootStep(92, "Preparing staffing & assignments…");

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

  const shiftSel = document.getElementById("pcaShift");
  if (shiftSel) shiftSel.value = pcaShift;

  if (typeof autoPopulateLiveAssignments === "function") {
    autoPopulateLiveAssignments();
  }

  // Initial renders
  bootStep(97, "Rendering UI…");
  refreshAllUI();

  // Tab fix
  const firstTabBtn = document.querySelector('.tabButton[data-target="staffingTab"]');
  if (typeof showTab === "function" && firstTabBtn) {
    showTab("staffingTab", firstTabBtn);
  }

  // -----------------------------
  // ✅ Bind "Clear recently discharged" button reliably
  // -----------------------------
  function bindClearRecentlyDischargedButton() {
    try {
      if (typeof window.clearRecentlyDischargedFlags !== "function") return;

      const btn = [...document.querySelectorAll("[onclick]")]
        .find(el => (el.getAttribute("onclick") || "").trim() === "clearRecentlyDischargedFlags()");

      if (!btn) {
        console.warn("[init] clearRecentlyDischargedFlags button not found to bind");
        return;
      }

      if (btn.__cuppClearBound) return;
      btn.__cuppClearBound = true;

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { window.clearRecentlyDischargedFlags(); } catch (err) { console.warn("clearRecentlyDischargedFlags click failed", err); }
      }, false);

      console.log("[init] Bound clearRecentlyDischargedFlags button");
    } catch (e) {
      console.warn("[init] bindClearRecentlyDischargedButton failed", e);
    }
  }

  bindClearRecentlyDischargedButton();

  bootFinish();
  console.log("APP INIT: Initialization complete.");
});