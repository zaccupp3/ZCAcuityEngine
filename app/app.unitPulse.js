// app/app.unitPulse.js
// ---------------------------------------------------------
// UNIT PULSE — Live, shift-specific (time-windowed)
//
// Goals:
// ✅ Staff list driven by current RN/PCA assignments
// ✅ Pull events from Supabase using window.sb.client (avoid REST 400)
// ✅ Time windows: 1/2/4/6/12h (still supported via window.unitPulseState.windowHours)
// ✅ Per-staff GREEN/YELLOW/RED categorization + “Shift Summary” drivers
// ✅ Unit summary: RN / PCA / Overall as categorical distribution bars
//
// NEW (Jan 2026):
// ✅ Replace dial with a tiered LINE GRAPH over time (Green/Yellow/Red bands)
// ✅ X-axis = time (right edge = live now)
// ✅ Line moves up/down based on attributed events (admit / discharge / acuity / reassign)
// ✅ Top summary includes RN avg / PCA avg / Overall avg trend lines
// ✅ Shift Summary becomes a dropdown (expand/collapse per tile)
// ✅ Listens to init event bus "cupp:audit_event" for instant refresh
//
// Attribution rules (kept):
// ✅ Admits/discharges attributed to ALL involved people (RN + PCA assigned to patient)
// ✅ Role-specific acuity changes:
//    - BG-related acuity changes affect RN only (not PCA)
//    - Defaults acuity-change attribution to RN-only unless payload explicitly says PCA
//
// PERF / REFRESH CONTRACT (Jan 2026 - light touch):
// ✅ Remove function-wrapping hooks (saveState/renderLive/appendEvent wrapping) to avoid global fan-out
// ✅ Use event-bus + visibility + optional polling only
// ✅ Coalesce refresh calls (single in-flight; trailing one if changes happen mid-refresh)
// ✅ Skip work when tab hidden or Unit Pulse root not mounted
// ---------------------------------------------------------

(function () {
  if (window.__unitPulseLoaded) return;
  window.__unitPulseLoaded = true;

  const $ = (id) => document.getElementById(id);

  function safeArray(v) { return Array.isArray(v) ? v : []; }

  // ✅ robust converter for NodeList / HTMLCollection / array-like
  function toArray(v) {
    if (Array.isArray(v)) return v;
    try { return Array.from(v || []); } catch { return []; }
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function clamp(n, a, b) {
    const x = Number.isFinite(Number(n)) ? Number(n) : 0;
    return Math.max(a, Math.min(b, x));
  }

  function toIso(ms) {
    try { return new Date(ms).toISOString(); } catch { return ""; }
  }

  function nowMs() { return Date.now(); }

  function msToPrettyDelta(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d`;
  }

  function getActiveUnitIdSafe() {
    return window.activeUnitId || window.__activeUnitId || window.currentUnitId || null;
  }

  function getActiveUnitNameSafe() {
    const candidates = [
      window.activeUnitName,
      window.unitName,
      window.unit?.name,
      window.unit?.label,
      window.unit_settings?.name,
      window.unitSettings?.name,
      window.unitSettings?.unit_name,
      window.unit_settings?.unit_name
    ].map(x => String(x || "").trim()).filter(Boolean);

    if (candidates.length) return candidates[0];

    try {
      const unitId = getActiveUnitIdSafe();
      if (unitId && window.unitNameMap && window.unitNameMap[unitId]) {
        return String(window.unitNameMap[unitId]);
      }
    } catch {}

    const id = String(getActiveUnitIdSafe() || "").trim();
    if (!id) return "Unit";
    return `Unit ${id.slice(0, 6)}…`;
  }

  // -----------------------------
  // Inject minimal CSS once (no style.css edits required)
  // -----------------------------
  function ensureStyles() {
    if (document.getElementById("unitPulseStyles")) return;
    const style = document.createElement("style");
    style.id = "unitPulseStyles";
    style.textContent = `
      .up-wrap{ max-width:1500px; margin:0 auto; }
      .up-top{
        background:rgba(255,255,255,0.88);
        border:1px solid rgba(148,163,184,0.35);
        border-radius:14px;
        box-shadow:0 10px 30px rgba(2,6,23,0.06);
        backdrop-filter:blur(8px);
        padding:12px 12px 10px;
      }
      .up-top-row{ display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }
      .up-title{ font-weight:950; color:#0f172a; font-size:14px; line-height:1.1; }
      .up-sub{ font-size:12px; font-weight:800; color:#475569; margin-top:3px; }
      .up-right{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:flex-end; }
      .up-btn{
        border:0; border-radius:12px; padding:8px 12px;
        font-weight:950; cursor:pointer;
        background:rgba(2,132,199,0.9); color:white;
      }
      .up-btn:hover{ filter:brightness(1.05); }
      .up-help{
        border:1px solid rgba(148,163,184,0.35);
        background:rgba(255,255,255,0.85);
        border-radius:12px; width:34px; height:34px;
        font-weight:950; cursor:pointer;
      }
      .up-meta{ font-size:12px; color:#475569; font-weight:800; white-space:nowrap; }

      .up-summary{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-top:12px; }
      @media (max-width:1000px){ .up-summary{ grid-template-columns:1fr; } }
      .up-kpi{
        background:rgba(255,255,255,0.88);
        border:1px solid rgba(148,163,184,0.35);
        border-radius:14px;
        box-shadow:0 10px 30px rgba(2,6,23,0.06);
        backdrop-filter:blur(8px);
        padding:12px 14px;
      }
      .up-kpi-label{
        font-size:12px; color:#475569; font-weight:950; letter-spacing:0.02em;
        display:flex; align-items:center; justify-content:space-between; gap:10px;
      }
      .up-kpi-sub{ margin-top:6px; font-size:12px; font-weight:850; color:#64748b; }
      .up-dist{ margin-top:10px; }
      .up-distbar{
        width:100%; height:14px; border-radius:999px; overflow:hidden;
        border:1px solid rgba(148,163,184,0.35);
        background:rgba(255,255,255,0.65);
        display:flex;
      }
      .up-dseg{ height:100%; }
      .up-dseg.g{ background:rgba(16,185,129,0.75); }
      .up-dseg.y{ background:rgba(245,158,11,0.80); }
      .up-dseg.r{ background:rgba(239,68,68,0.78); }
      .up-distlegend{
        margin-top:8px; display:flex; align-items:center; justify-content:space-between; gap:10px;
        font-size:12px; font-weight:900; color:#0f172a;
      }
      .up-dot{ display:inline-block; width:10px; height:10px; border-radius:999px; margin-right:6px; vertical-align:-1px; }
      .up-dot.g{ background:rgba(16,185,129,0.75); }
      .up-dot.y{ background:rgba(245,158,11,0.80); }
      .up-dot.r{ background:rgba(239,68,68,0.78); }

      .up-trend{
        margin-top:10px;
        border:1px solid rgba(148,163,184,0.25);
        border-radius:12px;
        background:rgba(255,255,255,0.65);
        overflow:hidden;
      }
      .up-trend svg{ width:100%; height:90px; display:block; }
      .up-trend-note{
        display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;
        padding:8px 10px;
        font-size:12px; font-weight:900; color:#334155;
        border-top:1px solid rgba(148,163,184,0.18);
        background:rgba(248,250,252,0.6);
      }

      .up-section{ margin-top:14px; }
      .up-section-title{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin:8px 2px 10px; }
      .up-section-title h2{ margin:0; font-size:14px; font-weight:950; color:#0f172a; }

      .up-grid{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; align-items:stretch; }
      @media (max-width:1400px){ .up-grid{ grid-template-columns:repeat(3,minmax(0,1fr)); } }
      @media (max-width:1000px){ .up-grid{ grid-template-columns:repeat(2,minmax(0,1fr)); } }
      @media (max-width:650px){ .up-grid{ grid-template-columns:1fr; } }

      .up-tile{
        background:rgba(255,255,255,0.88);
        border:1px solid rgba(148,163,184,0.35);
        border-radius:14px;
        box-shadow:0 10px 30px rgba(2,6,23,0.06);
        backdrop-filter:blur(8px);
        overflow:hidden;
        min-height:300px;
        display:flex; flex-direction:column;
      }
      .up-tile-head{
        background:rgba(226,232,240,0.55);
        padding:10px 12px;
        border-bottom:1px solid rgba(148,163,184,0.25);
        display:flex; align-items:flex-start; justify-content:space-between; gap:10px;
      }
      .up-name{ font-size:14px; font-weight:950; color:#0f172a; line-height:1.1; }
      .up-roleline{ font-size:12px; color:#475569; font-weight:850; margin-top:3px; }
      .up-chip{
        display:inline-flex; align-items:center; justify-content:center;
        padding:5px 10px; border-radius:999px;
        font-size:12px; font-weight:950;
        border:1px solid rgba(148,163,184,0.35);
        background:rgba(255,255,255,0.75);
        color:#0f172a;
        white-space:nowrap; min-width:70px;
      }
      .up-chip.green{ background:rgba(16,185,129,0.14); border-color:rgba(16,185,129,0.35); }
      .up-chip.yellow{ background:rgba(245,158,11,0.18); border-color:rgba(245,158,11,0.38); }
      .up-chip.red{ background:rgba(239,68,68,0.16); border-color:rgba(239,68,68,0.38); }

      .up-body{ padding:10px 12px 12px; flex:1; display:flex; flex-direction:column; }

      .up-metrics{
        display:grid; grid-template-columns:1fr auto;
        gap:8px 10px;
        font-size:12px; font-weight:900; color:#0f172a;
      }
      .up-metrics .k{ opacity:0.85; }
      .up-metrics .v{ color:#334155; font-weight:950; text-align:right; }

      .up-mini{
        margin-top:10px;
        border:1px solid rgba(148,163,184,0.22);
        border-radius:12px;
        background:rgba(255,255,255,0.6);
        overflow:hidden;
      }
      .up-mini svg{ width:100%; height:92px; display:block; }

      .up-sumwrap{ margin-top:10px; }
      .up-sumtoggle{
        width:100%;
        display:flex; align-items:center; justify-content:space-between; gap:10px;
        border:1px solid rgba(148,163,184,0.22);
        background:rgba(248,250,252,0.65);
        border-radius:12px;
        padding:8px 10px;
        cursor:pointer;
        font-size:12px; font-weight:950; color:#0f172a;
      }
      .up-sumtoggle:hover{ filter:brightness(1.02); }
      .up-sumbody{
        margin-top:8px;
        padding-top:8px;
        border-top:1px solid rgba(148,163,184,0.22);
      }
      .up-sumbody ul{
        margin:0; padding-left:16px;
        font-size:12px; font-weight:850;
        color:#334155;
        line-height:1.35;
      }
      .up-empty{ font-size:12px; font-weight:850; color:#64748b; }
    `;
    document.head.appendChild(style);
  }

  // -----------------------------
  // Category + thresholds
  // -----------------------------
  function normalizeCategory(cat) {
    const c = String(cat || "").toLowerCase();
    if (c.includes("high") || c === "red") return "red";
    if (c.includes("medium") || c === "yellow") return "yellow";
    if (c.includes("good") || c === "green") return "green";
    return "green";
  }

  // ✅ allow runtime overrides without touching code
  // window.unitPulseState.thresholds = {
  //   nurse: { greenMax, yellowMax, redMax },
  //   pca:   { greenMax, yellowMax, redMax }
  // }
  function getThresholds(role) {
    const st = window.unitPulseState || {};
    const overrides = st.thresholds || {};

    // Defaults (less forgiving):
    const defaults =
      role === "pca"
        ? { greenMax: 12, yellowMax: 18, redMax: 26 }
        : { greenMax: 8, yellowMax: 13, redMax: 20 };

    const o = (role === "pca" ? overrides.pca : overrides.nurse) || null;
    const merged = { ...defaults, ...(o && typeof o === "object" ? o : {}) };

    const g = Math.max(0, Number(merged.greenMax) || defaults.greenMax);
    const y = Math.max(g + 0.1, Number(merged.yellowMax) || defaults.yellowMax);
    const r = Math.max(y + 0.1, Number(merged.redMax) || defaults.redMax);

    return { greenMax: g, yellowMax: y, redMax: r };
  }

  function getCategoryForScore(loadScore, role) {
    try {
      if (typeof window.getLoadCategory === "function") {
        return normalizeCategory(window.getLoadCategory(loadScore, role));
      }
    } catch {}
    try {
      if (typeof window.getLoadClass === "function") {
        return normalizeCategory(window.getLoadClass(loadScore, role));
      }
    } catch {}

    const s = Number(loadScore) || 0;
    const t = getThresholds(role === "pca" ? "pca" : "nurse");

    if (s <= t.greenMax) return "green";
    if (s <= t.yellowMax) return "yellow";
    return "red";
  }

  // Map a "score" into tier Y (0..3)
  function scoreToTierY(score, role) {
    const t = getThresholds(role);
    const s = clamp(Number(score) || 0, 0, t.redMax);

    if (s <= t.greenMax) {
      const p = (t.greenMax === 0) ? 0 : (s / t.greenMax);
      return 0 + p * 1;
    }
    if (s <= t.yellowMax) {
      const span = Math.max(1e-9, (t.yellowMax - t.greenMax));
      const p = (s - t.greenMax) / span;
      return 1 + p * 1;
    }
    {
      const span = Math.max(1e-9, (t.redMax - t.yellowMax));
      const p = (s - t.yellowMax) / span;
      return 2 + p * 1;
    }
  }

  // -----------------------------
  // Staff list (driven by current assignments)
  // -----------------------------
  function getRoster() {
    const nurses = safeArray(window.currentNurses).map(n => ({
      id: Number(n.id),
      name: n.name || `RN ${n.id}`,
      role: "nurse",
      type: (n.type || "").toUpperCase(),
      patientIds: safeArray(n.patients).map(Number),
    }));

    const pcas = safeArray(window.currentPcas).map(p => ({
      id: Number(p.id),
      name: p.name || `PCA ${p.id}`,
      role: "pca",
      type: "PCA",
      patientIds: safeArray(p.patients).map(Number),
    }));

    return { nurses, pcas };
  }

  function findPatientIdFromRoom(room) {
    const r = String(room || "").trim();
    if (!r) return null;

    const pts = safeArray(window.patients).filter(p => p && !p.isEmpty);
    const found = pts.find(p => String(p.room || "").trim() === r);
    return found ? Number(found.id) : null;
  }

  // -----------------------------
  // Event fetching (Supabase preferred)
  // -----------------------------
  async function fetchEventsSupabase({ unitId, sinceIso }) {
    const sb = window.sb?.client;
    if (!sb || !unitId) return { ok: false, events: [], source: "local" };

    try {
      const { data, error } = await sb
        .from("audit_events")
        .select("*")
        .eq("unit_id", unitId)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(2000);

      if (error) throw error;
      return { ok: true, events: safeArray(data), source: "supabase" };
    } catch (e) {
      console.warn("[Unit Pulse] Supabase fetch failed, falling back to local events", e);
      return { ok: false, events: [], source: "local" };
    }
  }

  function fetchEventsLocal({ sinceMs }) {
    const list = safeArray(window.auditEvents);
    const events = list.filter(ev => {
      const t = Date.parse(ev?.created_at || ev?.ts || ev?.time || ev?.at || "");
      const ms = Number.isFinite(t) ? t : (Number(ev?.t) || 0);
      return ms >= sinceMs;
    });
    return { ok: true, events, source: "local" };
  }

  // -----------------------------
  // Event normalization + attribution
  // -----------------------------
  function pickEventTsMs(ev) {
    const t = Date.parse(ev?.created_at || ev?.timestamp || ev?.ts || ev?.time || ev?.at || "");
    if (Number.isFinite(t)) return t;
    const n = Number(ev?.t);
    return Number.isFinite(n) ? n : 0;
  }

  function getPayload(ev) {
    const p = ev?.payload || ev?.data || ev?.meta || ev?.details || null;
    if (p && typeof p === "object") return p;
    try { if (typeof p === "string") return JSON.parse(p); } catch {}
    return {};
  }

  function getEventAction(ev) {
    return String(ev?.action || ev?.type || ev?.event_type || ev?.kind || "").toLowerCase();
  }

  function getEventKind(ev) {
    const a = getEventAction(ev);
    if (a.includes("admit")) return "admit";
    if (a.includes("discharge") || a.includes("dc")) return "discharge";
    return "";
  }

  function getRoomFromEvent(ev) {
    const p = getPayload(ev);
    return (
      String(p.room || p.bed || p.roomLabel || p.bedLabel || p.patientRoom || ev.room || "").trim()
    );
  }

  function getPatientIdFromEvent(ev) {
    const p = getPayload(ev);
    const direct =
      p.patient_id ?? p.patientId ?? p.pid ?? p.patient?.id ?? p.patient?.patient_id ?? p.patient?.patientId;

    const pid = Number(direct);
    if (Number.isFinite(pid) && pid > 0) return pid;

    const room = getRoomFromEvent(ev);
    const byRoom = findPatientIdFromRoom(room);
    return Number.isFinite(byRoom) ? byRoom : null;
  }

  function getRoleHintFromEvent(ev) {
    const p = getPayload(ev);
    const r = String(p.role || p.ownerRole || ev.role || "").toLowerCase();
    if (r.includes("pca")) return "pca";
    if (r.includes("nurse") || r.includes("rn")) return "nurse";
    return "";
  }

  function getTagTextFromEvent(ev) {
    const p = getPayload(ev);
    const bits = [
      p.tag, p.tags, p.tagKey, p.key, p.field, p.metric, p.change, p.delta, p.note,
      p.newTag, p.addedTag, p.removedTag,
      ev.tag, ev.field
    ];
    const flat = bits
      .map(x => (Array.isArray(x) ? x.join(",") : String(x || "")))
      .join(" | ")
      .toLowerCase();
    return flat;
  }

  function isAcuityChangeEvent(ev) {
    const a = getEventAction(ev);
    if (a.includes("acuity")) return true;
    const p = getPayload(ev);
    const k = String(p?.field || p?.key || "").toLowerCase();
    if (k.includes("acuity") || k.includes("tag")) return true;
    return false;
  }

  function isReassignEvent(ev) {
    const a = getEventAction(ev);
    return a.includes("assign") || a.includes("move") || a.includes("reassign") || a.includes("drag");
  }

  function isBgRelatedAcuity(ev) {
    const t = getTagTextFromEvent(ev);
    return t.includes("bg") || t.includes("blood glucose") || t.includes("accucheck") || t.includes("fsbs");
  }

  function shiftKillerFlagsFromEvent(ev) {
    const t = getTagTextFromEvent(ev);

    return {
      sitter: t.includes("sitter"),
      drip: t.includes("drip") || t.includes("gtt") || t.includes("infus"),
      nih: t.includes("nih"),
      ciwa: t.includes("ciwa") || t.includes("cows"),
      bg: isBgRelatedAcuity(ev),
      iso: t.includes("iso") || t.includes("isolation"),
    };
  }

  function buildChangeLine(ev, nowTs) {
    const ts = pickEventTsMs(ev);
    const delta = msToPrettyDelta(nowTs - ts);

    const room = getRoomFromEvent(ev);
    const kind = getEventKind(ev);

    if (kind === "admit") return `${delta}: ${room || "bed"} admit`;
    if (kind === "discharge") return `${delta}: ${room || "bed"} discharge`;

    if (isAcuityChangeEvent(ev)) {
      if (isBgRelatedAcuity(ev)) return `${delta}: ${room || "bed"} BG acuity change`;
      return `${delta}: ${room || "bed"} acuity change`;
    }

    if (isReassignEvent(ev)) return `${delta}: ${room || "bed"} reassigned`;
    return `${delta}: ${room || "event"} update`;
  }

  // -----------------------------
  // Load score computation (current snapshot)
  // -----------------------------
  function computeLoadScore(staff) {
    try {
      if (staff.role === "nurse" && typeof window.getNurseLoadScore === "function") {
        return Number(window.getNurseLoadScore({ id: staff.id, name: staff.name, type: staff.type, patients: staff.patientIds })) || 0;
      }
      if (staff.role === "pca" && typeof window.getPcaLoadScore === "function") {
        return Number(window.getPcaLoadScore({ id: staff.id, name: staff.name, type: staff.type, patients: staff.patientIds })) || 0;
      }
    } catch {}
    return staff.patientIds.length;
  }

  // -----------------------------
  // Attribution map (includes events list per staff)
  // -----------------------------
  function buildPatientOwnerMaps(nurses, pcas) {
    const byPatient = new Map(); // patientId -> { rnNames:Set, pcaNames:Set }
    function ensure(pid) {
      if (!byPatient.has(pid)) byPatient.set(pid, { rnNames: new Set(), pcaNames: new Set() });
      return byPatient.get(pid);
    }

    nurses.forEach(n => {
      const name = String(n.name || "").trim();
      n.patientIds.forEach(pid => {
        if (!Number.isFinite(pid)) return;
        ensure(pid).rnNames.add(name);
      });
    });

    pcas.forEach(p => {
      const name = String(p.name || "").trim();
      p.patientIds.forEach(pid => {
        if (!Number.isFinite(pid)) return;
        ensure(pid).pcaNames.add(name);
      });
    });

    return byPatient;
  }

  function buildAttribution(windowedEvents, nurses, pcas) {
    const nowTs = nowMs();

    const byName = new Map(); // lowerName -> { admits, discharges, lines[], events[] }
    function touch(name) {
      const key = String(name || "").toLowerCase().trim();
      if (!key) return null;
      if (!byName.has(key)) byName.set(key, { admits: 0, discharges: 0, lines: [], events: [] });
      return byName.get(key);
    }

    const byPatient = buildPatientOwnerMaps(nurses, pcas);

    function addLineTo(name, line, ev) {
      const rec = touch(name);
      if (!rec) return;
      rec.lines.push(line);
      rec.events.push(ev);
    }

    function addKindTo(name, kind) {
      const rec = touch(name);
      if (!rec) return;
      if (kind === "admit") rec.admits += 1;
      if (kind === "discharge") rec.discharges += 1;
    }

    windowedEvents.forEach(ev => {
      const kind = getEventKind(ev);
      const isAcuity = isAcuityChangeEvent(ev);
      const isOther = !kind && !isAcuity && !isReassignEvent(ev);

      if (!kind && !isAcuity && !isReassignEvent(ev) && isOther) return;

      const pid = getPatientIdFromEvent(ev);
      const owners = (pid && byPatient.has(pid)) ? byPatient.get(pid) : null;

      const roleHint = getRoleHintFromEvent(ev);
      const line = buildChangeLine(ev, nowTs);

      // Admit/Discharge: attribute to both RN + PCA owners
      if (kind) {
        if (owners) {
          owners.rnNames.forEach(nm => { addKindTo(nm, kind); addLineTo(nm, line, ev); });
          owners.pcaNames.forEach(nm => { addKindTo(nm, kind); addLineTo(nm, line, ev); });
        } else {
          const p = getPayload(ev);
          const ownerName = String(p.ownerName || p.owner?.name || p.toOwnerName || p.to_owner_name || "").trim();
          if (ownerName) { addKindTo(ownerName, kind); addLineTo(ownerName, line, ev); }
        }
        return;
      }

      // Acuity changes: RN-only by default; BG always RN-only
      if (isAcuity) {
        const rnOnly = isBgRelatedAcuity(ev) || (roleHint && roleHint === "nurse") || (!roleHint);
        const pcaOnly = (roleHint === "pca") && !isBgRelatedAcuity(ev);

        if (owners) {
          if (pcaOnly) {
            owners.pcaNames.forEach(nm => addLineTo(nm, line, ev));
          } else if (rnOnly) {
            owners.rnNames.forEach(nm => addLineTo(nm, line, ev));
          } else {
            owners.rnNames.forEach(nm => addLineTo(nm, line, ev));
          }
        }
        return;
      }

      // Reassign: attribute to both RN + PCA owners
      if (isReassignEvent(ev) && owners) {
        owners.rnNames.forEach(nm => addLineTo(nm, line, ev));
        owners.pcaNames.forEach(nm => addLineTo(nm, line, ev));
      }
    });

    // Keep Shift Summary text trimmed; keep events list full (for chart)
    byName.forEach(rec => {
      rec.lines = safeArray(rec.lines).slice(0, 6);
      rec.events = safeArray(rec.events);
    });

    return byName;
  }

  // -----------------------------
  // Distribution (GREEN/YELLOW/RED)
  // -----------------------------
  function computeCategoryCounts(tiles) {
    const c = { green: 0, yellow: 0, red: 0, total: 0 };
    safeArray(tiles).forEach(t => {
      const cat = normalizeCategory(t?.category);
      if (cat === "red") c.red++;
      else if (cat === "yellow") c.yellow++;
      else c.green++;
      c.total++;
    });
    return c;
  }

  function pct(n, d) {
    if (!d) return 0;
    return Math.round((n / d) * 1000) / 10;
  }

  function distBarHtml(label, counts, rightText) {
    const total = counts.total || 0;
    const g = total ? (counts.green / total) * 100 : 0;
    const y = total ? (counts.yellow / total) * 100 : 0;
    const r = total ? (counts.red / total) * 100 : 0;

    return `
      <div class="up-kpi">
        <div class="up-kpi-label">
          <span>${escapeHtml(label)}</span>
          <span class="up-meta">${escapeHtml(rightText || "")}</span>
        </div>

        <div class="up-dist">
          <div class="up-distbar" title="Distribution of staff categories in this window">
            <div class="up-dseg g" style="width:${Math.max(0, g)}%;"></div>
            <div class="up-dseg y" style="width:${Math.max(0, y)}%;"></div>
            <div class="up-dseg r" style="width:${Math.max(0, r)}%;"></div>
          </div>

          <div class="up-distlegend">
            <span><span class="up-dot g"></span>${counts.green} (${pct(counts.green, total)}%)</span>
            <span><span class="up-dot y"></span>${counts.yellow} (${pct(counts.yellow, total)}%)</span>
            <span><span class="up-dot r"></span>${counts.red} (${pct(counts.red, total)}%)</span>
          </div>
        </div>

        <div class="up-kpi-sub">${total} tiles</div>
      </div>
    `;
  }

  // -----------------------------
  // Event-driven series builder (tiered line over time)
  // -----------------------------
  function getShiftKillerWeights() {
    // Allow overrides:
    // window.unitPulseState.shiftKillerWeights = { sitter, drip, nih, ciwa, bg, iso }
    const st = window.unitPulseState || {};
    const o = (st.shiftKillerWeights && typeof st.shiftKillerWeights === "object") ? st.shiftKillerWeights : {};

    return {
      sitter: Number(o.sitter ?? 1.6),
      drip: Number(o.drip ?? 1.4),
      nih: Number(o.nih ?? 1.2),
      ciwa: Number(o.ciwa ?? 1.3),
      bg: Number(o.bg ?? 1.15),
      iso: Number(o.iso ?? 1.05),
    };
  }

  function weightForEvent(ev, role) {
    const kind = getEventKind(ev);
    const acuity = isAcuityChangeEvent(ev);
    const reassign = isReassignEvent(ev);

    if (kind === "admit") return role === "pca" ? 2.3 : 3.4;
    if (kind === "discharge") return role === "pca" ? -1.2 : -2.2;

    if (acuity) {
      const flags = shiftKillerFlagsFromEvent(ev);
      const k = getShiftKillerWeights();

      let base = role === "pca" ? 0.7 : 1.15;

      if (flags.sitter) base *= k.sitter;
      if (flags.drip) base *= k.drip;
      if (flags.nih) base *= k.nih;
      if (flags.ciwa) base *= k.ciwa;
      if (flags.iso) base *= k.iso;

      if (flags.bg) {
        if (role === "pca") return 0;
        base *= k.bg;
      }

      return clamp(base, -4, 6);
    }

    if (reassign) return 0.5;

    return 0;
  }

  function buildTierSeries({ role, currentScore, events, sinceMs, untilMs, samples = 28 }) {
    const evs = safeArray(events)
      .map(ev => ({ ev, t: pickEventTsMs(ev), w: weightForEvent(ev, role) }))
      .filter(x => Number.isFinite(x.t) && x.t >= sinceMs && x.t <= untilMs && Number.isFinite(x.w) && x.w !== 0)
      .sort((a, b) => a.t - b.t);

    const totalDelta = evs.reduce((sum, x) => sum + x.w, 0);
    const startScore = (Number(currentScore) || 0) - totalDelta;

    const pts = [];
    const span = Math.max(1, untilMs - sinceMs);

    let idx = 0;
    let running = 0;

    for (let i = 0; i < samples; i++) {
      const frac = samples === 1 ? 1 : (i / (samples - 1));
      const t = sinceMs + frac * span;

      while (idx < evs.length && evs[idx].t <= t) {
        running += evs[idx].w;
        idx++;
      }

      const scoreAtT = startScore + running;
      const yTier = scoreToTierY(scoreAtT, role); // 0..3
      pts.push({ t, x: frac, y: clamp(yTier, 0, 3), score: scoreAtT });
    }

    return pts;
  }

  function seriesToSvg({ series, role, width = 600, height = 90 }) {
    const padX = 10;
    const padY = 8;
    const w = width;
    const h = height;

    function xPx(frac) {
      return padX + frac * (w - padX * 2);
    }
    function yPx(tierY) {
      const y = clamp(tierY, 0, 3);
      const innerH = (h - padY * 2);
      return (h - padY) - (y / 3) * innerH;
    }

    const bandH = (h - padY * 2) / 3;

    const pts = safeArray(series);
    const poly = pts.map(p => `${xPx(p.x).toFixed(1)},${yPx(p.y).toFixed(1)}`).join(" ");
    const last = pts.length ? pts[pts.length - 1] : null;

    const stroke = "rgba(15,23,42,0.75)";
    const fillDot = "rgba(15,23,42,0.70)";

    return `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
        <rect x="0" y="${padY}" width="${w}" height="${bandH}" fill="rgba(239,68,68,0.12)"></rect>
        <rect x="0" y="${padY + bandH}" width="${w}" height="${bandH}" fill="rgba(245,158,11,0.12)"></rect>
        <rect x="0" y="${padY + bandH * 2}" width="${w}" height="${bandH}" fill="rgba(16,185,129,0.10)"></rect>

        <line x1="0" y1="${padY + bandH}" x2="${w}" y2="${padY + bandH}" stroke="rgba(148,163,184,0.35)" stroke-width="1"/>
        <line x1="0" y1="${padY + bandH * 2}" x2="${w}" y2="${padY + bandH * 2}" stroke="rgba(148,163,184,0.35)" stroke-width="1"/>

        <polyline points="${poly}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>

        ${
          last
            ? `<circle cx="${xPx(last.x).toFixed(1)}" cy="${yPx(last.y).toFixed(1)}" r="3.2" fill="${fillDot}"></circle>`
            : ``
        }
      </svg>
    `;
  }

  // -----------------------------
  // Tiles
  // -----------------------------
  function buildTile(staff, attributionMap, seriesMap) {
    const loadScore = computeLoadScore(staff);
    const category = getCategoryForScore(loadScore, staff.role);
    const chipClass = category === "green" ? "green" : category === "yellow" ? "yellow" : "red";

    const key = String(staff.name || "").toLowerCase().trim();
    const rec = attributionMap?.get(key) || { admits: 0, discharges: 0, lines: [], events: [] };

    const series = seriesMap?.get(key) || [];

    return {
      staff,
      loadScore,
      category,
      chipClass,
      admits: rec.admits || 0,
      discharges: rec.discharges || 0,
      changes: safeArray(rec.lines),
      series
    };
  }

  // -----------------------------
  // Summary series (average tier line)
  // -----------------------------
  function avgSeriesFromTiles(tiles, role, sinceMs, untilMs, samples) {
    if (!tiles || !tiles.length) return [];

    const N = (tiles[0]?.series || []).length;
    if (!N) return [];

    const out = [];
    for (let i = 0; i < N; i++) {
      let sum = 0;
      let c = 0;
      tiles.forEach(t => {
        const p = t?.series?.[i];
        if (!p) return;
        sum += Number(p.y) || 0;
        c++;
      });
      const y = c ? (sum / c) : 0;
      const frac = N === 1 ? 1 : (i / (N - 1));
      out.push({ x: frac, y, t: sinceMs + frac * (untilMs - sinceMs) });
    }
    return out;
  }

  // -----------------------------
  // Render
  // -----------------------------
  function renderAll(state) {
    ensureStyles();

    const root = $("unitPulseRoot");
    if (!root) return;

    const { hours, eventSource, events, tilesRn, tilesPca, seriesRnAvg, seriesPcaAvg, seriesOverallAvg } = state;

    const unitName = getActiveUnitNameSafe();

    const rnCounts = computeCategoryCounts(tilesRn);
    const pcaCounts = computeCategoryCounts(tilesPca);
    const combined = {
      green: rnCounts.green + pcaCounts.green,
      yellow: rnCounts.yellow + pcaCounts.yellow,
      red: rnCounts.red + pcaCounts.red,
      total: rnCounts.total + pcaCounts.total
    };

    window.unitPulseState = window.unitPulseState || {};
    window.unitPulseState._summaryOpen = window.unitPulseState._summaryOpen || {};
    const openMap = window.unitPulseState._summaryOpen;

    root.innerHTML = `
      <div class="up-wrap">
        <div class="up-top">
          <div class="up-top-row">
            <div>
              <div class="up-title">Unit Pulse</div>
              <div class="up-sub">
                ${escapeHtml(unitName)} • Live workload pulse + recent-change drivers (last ${escapeHtml(String(hours))}h)
              </div>
            </div>

            <div class="up-right">
              <button id="upRefresh" class="up-btn" type="button">Refresh</button>
              <button id="upHelp" class="up-help" type="button" title="What is this?">?</button>
              <div class="up-meta">events: ${escapeHtml(String(events.length))} • source: ${escapeHtml(String(eventSource))}</div>
            </div>
          </div>
        </div>

        <div class="up-summary">
          <div class="up-kpi">
            <div class="up-kpi-label"><span>RN workload</span><span class="up-meta">avg trend</span></div>
            <div class="up-trend">${seriesToSvg({ series: seriesRnAvg, role: "nurse" })}</div>
            <div class="up-trend-note">
              <span>Green → Yellow → Red</span><span>Left: ${hours}h ago • Right: now</span>
            </div>
            <div class="up-dist">${distBarHtml("Distribution", rnCounts, "at-a-glance").replace('<div class="up-kpi">','').replace('</div>','')}</div>
          </div>

          <div class="up-kpi">
            <div class="up-kpi-label"><span>PCA workload</span><span class="up-meta">avg trend</span></div>
            <div class="up-trend">${seriesToSvg({ series: seriesPcaAvg, role: "pca" })}</div>
            <div class="up-trend-note">
              <span>Green → Yellow → Red</span><span>Left: ${hours}h ago • Right: now</span>
            </div>
            <div class="up-dist">${distBarHtml("Distribution", pcaCounts, "at-a-glance").replace('<div class="up-kpi">','').replace('</div>','')}</div>
          </div>

          <div class="up-kpi">
            <div class="up-kpi-label"><span>Overall workload</span><span class="up-meta">avg trend</span></div>
            <div class="up-trend">${seriesToSvg({ series: seriesOverallAvg, role: "nurse" })}</div>
            <div class="up-trend-note">
              <span>Green → Yellow → Red</span><span>Left: ${hours}h ago • Right: now</span>
            </div>
            <div class="up-dist">${distBarHtml("Distribution", combined, "RN + PCA blend").replace('<div class="up-kpi">','').replace('</div>','')}</div>
          </div>
        </div>

        <div class="up-section">
          <div class="up-section-title"><h2>RNs</h2></div>
          ${
            tilesRn.length
              ? `<div class="up-grid">
                  ${tilesRn.map((t) => {
                    const key = `rn:${String(t.staff.name || "").toLowerCase().trim()}`;
                    const isOpen = !!openMap[key];
                    return `
                    <div class="up-tile">
                      <div class="up-tile-head">
                        <div>
                          <div class="up-name">${escapeHtml(t.staff.name)}</div>
                          <div class="up-roleline">RN • Patients: ${t.staff.patientIds.length} • Load: ${t.loadScore}</div>
                        </div>
                        <div class="up-chip ${t.chipClass}">${t.category.toUpperCase()}</div>
                      </div>

                      <div class="up-body">
                        <div class="up-metrics">
                          <div class="k">Admits</div><div class="v">${t.admits}</div>
                          <div class="k">Discharges</div><div class="v">${t.discharges}</div>
                          <div class="k">Patients</div><div class="v">${t.staff.patientIds.length}</div>
                          <div class="k">Load score</div><div class="v">${t.loadScore}</div>
                        </div>

                        <div class="up-mini" title="Workload tier over time (event-driven)">
                          ${seriesToSvg({ series: t.series, role: "nurse" })}
                        </div>

                        <div class="up-sumwrap">
                          <button class="up-sumtoggle" type="button" data-sumkey="${escapeHtml(key)}">
                            <span>Shift Summary (last ${escapeHtml(String(hours))}h)</span>
                            <span>${isOpen ? "▴" : "▾"}</span>
                          </button>

                          ${
                            isOpen
                              ? `<div class="up-sumbody">
                                  ${
                                    t.changes.length
                                      ? `<ul>${t.changes.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
                                      : `<div class="up-empty">No recent changes found for this window.</div>`
                                  }
                                </div>`
                              : ``
                          }
                        </div>
                      </div>
                    </div>
                  `;}).join("")}
                </div>`
              : `<div class="up-empty">No current RNs found. Populate LIVE assignments first.</div>`
          }
        </div>

        <div class="up-section">
          <div class="up-section-title"><h2>PCAs</h2></div>
          ${
            tilesPca.length
              ? `<div class="up-grid">
                  ${tilesPca.map((t) => {
                    const key = `pca:${String(t.staff.name || "").toLowerCase().trim()}`;
                    const isOpen = !!openMap[key];
                    return `
                    <div class="up-tile">
                      <div class="up-tile-head">
                        <div>
                          <div class="up-name">${escapeHtml(t.staff.name)}</div>
                          <div class="up-roleline">PCA • Patients: ${t.staff.patientIds.length} • Load: ${t.loadScore}</div>
                        </div>
                        <div class="up-chip ${t.chipClass}">${t.category.toUpperCase()}</div>
                      </div>

                      <div class="up-body">
                        <div class="up-metrics">
                          <div class="k">Admits</div><div class="v">${t.admits}</div>
                          <div class="k">Discharges</div><div class="v">${t.discharges}</div>
                          <div class="k">Patients</div><div class="v">${t.staff.patientIds.length}</div>
                          <div class="k">Load score</div><div class="v">${t.loadScore}</div>
                        </div>

                        <div class="up-mini" title="Workload tier over time (event-driven)">
                          ${seriesToSvg({ series: t.series, role: "pca" })}
                        </div>

                        <div class="up-sumwrap">
                          <button class="up-sumtoggle" type="button" data-sumkey="${escapeHtml(key)}">
                            <span>Shift Summary (last ${escapeHtml(String(hours))}h)</span>
                            <span>${isOpen ? "▴" : "▾"}</span>
                          </button>

                          ${
                            isOpen
                              ? `<div class="up-sumbody">
                                  ${
                                    t.changes.length
                                      ? `<ul>${t.changes.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
                                      : `<div class="up-empty">No recent changes found for this window.</div>`
                                  }
                                </div>`
                              : ``
                          }
                        </div>
                      </div>
                    </div>
                  `;}).join("")}
                </div>`
              : `<div class="up-empty">No current PCAs found. Populate LIVE assignments first.</div>`
          }
        </div>
      </div>
    `;

    const btn = $("upRefresh");
    const help = $("upHelp");

    if (btn) btn.onclick = () => window.unitPulse.refresh();

    if (help) {
      help.onclick = () => {
        alert(
          "Unit Pulse shows workload tier trends over time (Green → Yellow → Red) and a Shift Summary.\n\n" +
          "Trend lines are event-driven right now (fast + live): admits/discharges/acuity/reassign events push the line up/down.\n\n" +
          "Attribution rules:\n" +
          "• Admits/Discharges → RN + PCA assigned to that patient.\n" +
          "• Acuity changes → RN-only by default.\n" +
          "• BG acuity changes → RN-only (never PCA).\n\n" +
          "Later (with shift snapshots), this can become a true historical score replay."
        );
      };
    }

    // Bind dropdown toggles
    try {
      const toggles = toArray(root.querySelectorAll(".up-sumtoggle"));
      toggles.forEach((btnEl) => {
        if (btnEl.__bound) return;
        btnEl.__bound = true;

        btnEl.addEventListener("click", () => {
          const k = String(btnEl.getAttribute("data-sumkey") || "").trim();
          if (!k) return;

          window.unitPulseState = window.unitPulseState || {};
          window.unitPulseState._summaryOpen = window.unitPulseState._summaryOpen || {};
          window.unitPulseState._summaryOpen[k] = !window.unitPulseState._summaryOpen[k];

          try { window.unitPulse.refresh(); } catch {}
        });
      });
    } catch {}
  }

  // -----------------------------
  // Refresh gating / scheduling (PERF)
  // -----------------------------
  function isPulseMounted() {
    return !!$("unitPulseRoot");
  }

  function isPulseVisible() {
    if (!isPulseMounted()) return false;
    if (document.hidden) return false;
    return true;
  }

  let __upDebounceT = null;
  let __refreshInFlight = false;
  let __refreshQueued = false;
  let __lastScheduleReason = "";

  function scheduleRefresh(reason = "") {
    if (!isPulseMounted()) return;
    if (document.hidden) return;

    __lastScheduleReason = reason || __lastScheduleReason || "scheduleRefresh";

    if (__upDebounceT) clearTimeout(__upDebounceT);
    __upDebounceT = setTimeout(() => {
      __upDebounceT = null;
      try { window.unitPulse.refresh(); } catch (e) { console.warn("[Unit Pulse] scheduled refresh failed", __lastScheduleReason, e); }
    }, 250);
  }

  // -----------------------------
  // Main refresh pipeline
  // -----------------------------
  async function refresh() {
    ensureStyles();

    if (!isPulseVisible()) return;

    // In-flight coalescing: never run multiple refreshes concurrently.
    if (__refreshInFlight) {
      __refreshQueued = true;
      return;
    }
    __refreshInFlight = true;

    try {
      const hours = Number(window.unitPulseState?.windowHours) || 12;
      const sourceMode = String(window.unitPulseState?.sourceMode || "auto");

      const unitId = getActiveUnitIdSafe();
      const sinceMs = nowMs() - (hours * 60 * 60 * 1000);
      const untilMs = nowMs();
      const sinceIso = toIso(sinceMs);

      const roster = getRoster();
      const nurses = roster.nurses;
      const pcas = roster.pcas;

      let eventSource = "local";
      let events = [];

      const wantsSupabase =
        sourceMode === "supabase" ||
        (sourceMode === "auto" && !!window.sb?.client && !!unitId);

      if (wantsSupabase) {
        const r = await fetchEventsSupabase({ unitId, sinceIso });
        if (r.ok) {
          eventSource = "supabase";
          events = r.events;
        } else if (sourceMode === "supabase") {
          eventSource = "supabase (failed → local)";
          events = fetchEventsLocal({ sinceMs }).events;
        } else {
          events = fetchEventsLocal({ sinceMs }).events;
        }
      } else {
        events = fetchEventsLocal({ sinceMs }).events;
      }

      const windowedEvents = safeArray(events).slice().sort((a, b) => pickEventTsMs(b) - pickEventTsMs(a));
      const attribution = buildAttribution(windowedEvents, nurses, pcas);

      const samples = Number(window.unitPulseState?.seriesSamples) || 28;

      const seriesMapRn = new Map();
      nurses.forEach(s => {
        const k = String(s.name || "").toLowerCase().trim();
        const rec = attribution.get(k);
        const currentScore = computeLoadScore(s);
        const series = buildTierSeries({
          role: "nurse",
          currentScore,
          events: rec?.events || [],
          sinceMs,
          untilMs,
          samples
        });
        seriesMapRn.set(k, series);
      });

      const seriesMapPca = new Map();
      pcas.forEach(s => {
        const k = String(s.name || "").toLowerCase().trim();
        const rec = attribution.get(k);
        const currentScore = computeLoadScore(s);
        const series = buildTierSeries({
          role: "pca",
          currentScore,
          events: rec?.events || [],
          sinceMs,
          untilMs,
          samples
        });
        seriesMapPca.set(k, series);
      });

      const tilesRn = nurses.map(s => buildTile(s, attribution, seriesMapRn));
      const tilesPca = pcas.map(s => buildTile(s, attribution, seriesMapPca));

      const seriesRnAvg = avgSeriesFromTiles(tilesRn, "nurse", sinceMs, untilMs, samples);
      const seriesPcaAvg = avgSeriesFromTiles(tilesPca, "pca", sinceMs, untilMs, samples);

      const overallTiles = tilesRn.concat(tilesPca);
      const seriesOverallAvg = avgSeriesFromTiles(overallTiles, "nurse", sinceMs, untilMs, samples);

      if (!isPulseMounted()) return; // tab navigated away mid-refresh

      renderAll({
        hours,
        eventSource,
        events: windowedEvents,
        tilesRn,
        tilesPca,
        seriesRnAvg,
        seriesPcaAvg,
        seriesOverallAvg
      });
    } finally {
      __refreshInFlight = false;

      if (__refreshQueued) {
        __refreshQueued = false;
        // trailing refresh (single) to catch changes that happened mid-flight
        scheduleRefresh("trailing_refresh");
      }
    }
  }

  // -----------------------------
  // Auto-refresh hooks (event-driven only)
  // -----------------------------
  function installAutoHooks() {
    try {
      window.addEventListener("cupp:audit_event", () => scheduleRefresh("cupp:audit_event"));
      window.addEventListener("cupp:state_dirty", () => scheduleRefresh("cupp:state_dirty"));
    } catch {}

    // Compatibility: some modules may still emit these
    try {
      window.addEventListener("unit_state_updated", () => scheduleRefresh("unit_state_updated"));
      window.addEventListener("assignments_updated", () => scheduleRefresh("assignments_updated"));
      window.addEventListener("audit_events_updated", () => scheduleRefresh("audit_events_updated"));
    } catch {}
  }

  // -----------------------------
  // Polling for Supabase source (optional + visibility-gated)
  // -----------------------------
  let __upPollTimer = null;

  function shouldPoll() {
    const unitId = getActiveUnitIdSafe();
    const hasSb = !!window.sb?.client && !!unitId;
    if (!hasSb) return false;

    const mode = String(window.unitPulseState?.sourceMode || "auto");
    if (mode !== "auto" && mode !== "supabase") return false;

    return true;
  }

  function startPolling() {
    if (!shouldPoll()) return;

    const ms = Number(window.unitPulseState?.pollMs) || 10000;

    if (__upPollTimer) clearInterval(__upPollTimer);
    __upPollTimer = setInterval(() => {
      if (!isPulseVisible()) return;
      try { window.unitPulse.refresh(); } catch {}
    }, ms);
  }

  function stopPolling() {
    if (__upPollTimer) clearInterval(__upPollTimer);
    __upPollTimer = null;
  }

  function installVisibilityHooks() {
    try {
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) return;
        scheduleRefresh("visibilitychange");
      });
    } catch {}
  }

  // -----------------------------
  // Boot / public API
  // -----------------------------
  window.unitPulseState = window.unitPulseState || {
    windowHours: 12,
    sourceMode: "auto",
    pollMs: 10000,
    seriesSamples: 28,
    _summaryOpen: {},

    // Optional: tune without code changes
    // thresholds: { nurse:{greenMax:8,yellowMax:13,redMax:20}, pca:{greenMax:12,yellowMax:18,redMax:26} },
    // shiftKillerWeights: { sitter:1.6, drip:1.4, nih:1.2, ciwa:1.3, bg:1.15, iso:1.05 },
  };

  window.unitPulse = window.unitPulse || {};
  window.unitPulse.refresh = refresh;

  installAutoHooks();
  installVisibilityHooks();
  startPolling();

  // Initial render
  setTimeout(() => {
    try { refresh(); } catch (e) { console.warn("[Unit Pulse] initial refresh failed", e); }
  }, 60);

  window.__unitPulseBuild =
    "tieredTrendLines+dropdownShiftSummary+eventBus-v4-perf-coalesce-no-wraps";
})();