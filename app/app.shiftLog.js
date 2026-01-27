// New File 1: app/app.shiftLog.js
// ---------------------------------------------------------
// ShiftLog = collect + normalize + query the raw events (local + Supabase).
//
// - Listens to: "cupp:audit_event" (emitted when appendEvent() runs)
// - Hydrates from: public.audit_events (Supabase) so history survives refresh
// - Dedupes by id
// - Stores fast in-memory cache
// - Exposes API:
//     window.shiftLog.list({ from, to, types, unitId, limit })
//     window.shiftLog.latest()
//     window.shiftLog.count({ from, to, types, unitId })
//     window.shiftLog.hydrate({ from, to, unitId, limit })
//     window.shiftLog.clear()
//
// Key rule: Facts layer only. No burden tiers/durations. No UI.
// ---------------------------------------------------------

(function () {
  if (window.shiftLog && window.shiftLog.__ready) return;

  const _byId = new Map();     // id -> normalized event
  let _ordered = [];           // normalized events sorted by ts asc
  let _lastHydrateKey = null;  // simple guard against repeated identical hydrates

  function nowMs() { return Date.now(); }

  function getSupabaseClient() {
    // Support common wrappers you’ve used across the app.
    return (
      window.supabaseClient ||
      window.sb ||
      window.supabase ||
      window._supabase ||
      window.__supabase ||
      null
    );
  }

  function getActiveUnitId() {
    return (
      window.activeUnitId ||
      (window.unitState && (window.unitState.activeUnitId || window.unitState.unit_id || window.unitState.unitId)) ||
      window.unit_id ||
      null
    );
  }

  function toMs(x) {
    if (x == null) return null;
    if (typeof x === "number") return x;
    if (x instanceof Date) return x.getTime();
    const t = Date.parse(x);
    return Number.isFinite(t) ? t : null;
  }

  function safeStr(v) {
    return (v == null) ? "" : String(v);
  }

  function extractRoom(payload) {
    if (!payload) return "";
    return (
      payload.room ||
      payload.toRoom ||
      payload.bed ||
      payload.patientRoom ||
      payload.roomNumber ||
      payload.roomNum ||
      ""
    );
  }

  function extractNames(payload) {
    const rn =
      payload.rnName ||
      payload.rn_name ||
      payload.rn ||
      (payload.attribution && (payload.attribution.rnName || payload.attribution.rn_name)) ||
      "";
    const pca =
      payload.pcaName ||
      payload.pca_name ||
      payload.pca ||
      (payload.attribution && (payload.attribution.pcaName || payload.attribution.pca_name)) ||
      "";
    return { rnName: safeStr(rn), pcaName: safeStr(pca) };
  }

  function normalizeRawEvent(raw) {
    // Accepts either:
    // - Supabase row: { id, created_at, event_type, payload, unit_id }
    // - Event bus detail: { id/uuid, type/event_type, ts/created_at, payload, unitId/unit_id }
    const payload = raw && raw.payload ? raw.payload : (raw && raw.data ? raw.data : (raw || {}));

    const id =
      raw.id ||
      raw.uuid ||
      (payload && (payload.id || payload.uuid || payload.eventId)) ||
      null;

    const type =
      raw.event_type ||
      raw.type ||
      (payload && (payload.event_type || payload.type)) ||
      "EVENT";

    const unitId =
      raw.unit_id ||
      raw.unitId ||
      (payload && (payload.unit_id || payload.unitId)) ||
      getActiveUnitId() ||
      null;

    const tsMs =
      toMs(raw.created_at) ||
      toMs(raw.ts) ||
      toMs(payload && (payload.created_at || payload.ts)) ||
      nowMs();

    const room = extractRoom(payload);
    const names = extractNames(payload);

    return {
      id,
      ts: tsMs,
      iso: new Date(tsMs).toISOString(),
      type: safeStr(type),
      unitId: unitId ? safeStr(unitId) : null,
      room: safeStr(room),
      rnName: names.rnName,
      pcaName: names.pcaName,
      payload: payload || {}
    };
  }

  function rebuildOrderedIfNeeded() {
    // Maintain _ordered sorted by ts ascending
    _ordered = Array.from(_byId.values())
      .sort((a, b) => (a.ts - b.ts) || safeStr(a.id).localeCompare(safeStr(b.id)));
  }

  function upsertNormalized(evNorm) {
    if (!evNorm || !evNorm.id) return { added: false, reason: "missing_id" };

    if (_byId.has(evNorm.id)) {
      // If duplicate, keep the “better” one (prefer earlier timestamp if differs),
      // but generally treat as idempotent.
      const prev = _byId.get(evNorm.id);
      const merged = {
        ...prev,
        ...evNorm,
        payload: { ...(prev.payload || {}), ...(evNorm.payload || {}) }
      };
      _byId.set(evNorm.id, merged);
      return { added: false, reason: "duplicate" };
    }

    _byId.set(evNorm.id, evNorm);
    return { added: true };
  }

  function emitUpdated(meta) {
    try {
      const detail = meta || {};
      window.dispatchEvent(new CustomEvent("cupp:shiftlog_updated", { detail }));
    } catch (_) {}
  }

  function ingestRaw(raw, source = "unknown") {
    const norm = normalizeRawEvent(raw);
    const res = upsertNormalized(norm);
    if (res.added) {
      // Insert into ordered list in-place (cheap insertion) to avoid full rebuild each event.
      // Since events usually come in chronological order, this is fast.
      const idx = _ordered.length;
      if (idx === 0 || _ordered[idx - 1].ts <= norm.ts) {
        _ordered.push(norm);
      } else {
        // rare out-of-order insert
        let i = _ordered.findIndex(e => e.ts > norm.ts);
        if (i < 0) i = _ordered.length;
        _ordered.splice(i, 0, norm);
      }
      emitUpdated({ source, id: norm.id, type: norm.type, ts: norm.ts });
    }
  }

  // Live stream: listen to existing event bus
  window.addEventListener("cupp:audit_event", (e) => {
    if (!e || !e.detail) return;
    ingestRaw(e.detail, "bus");
  });

  async function hydrate(opts = {}) {
    const sb = getSupabaseClient();
    const unitId = opts.unitId || getActiveUnitId();
    if (!sb) return { ok: false, reason: "missing_supabase" };
    if (!unitId) return { ok: false, reason: "missing_unitId" };

    const fromMs = toMs(opts.from) ?? (nowMs() - 12 * 60 * 60 * 1000);
    const toMsVal = toMs(opts.to) ?? nowMs();
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(5000, opts.limit)) : 1000;

    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(toMsVal).toISOString();

    const hydrateKey = `${unitId}|${fromIso}|${toIso}|${limit}`;
    if (_lastHydrateKey === hydrateKey) {
      return { ok: true, reason: "cached_hydrate", added: 0 };
    }
    _lastHydrateKey = hydrateKey;

    // NOTE: to avoid requiring additional indexes or “to” filtering,
    // we use gte(from) and limit. If you want strict [from,to], add lte(to).
    let q = sb
      .from("audit_events")
      .select("id, created_at, event_type, payload, unit_id")
      .eq("unit_id", unitId)
      .gte("created_at", fromIso)
      .order("created_at", { ascending: true })
      .limit(limit);

    // Optional strict upper bound (safe):
    if (opts.to != null) {
      q = q.lte("created_at", toIso);
    }

    const { data, error } = await q;
    if (error) return { ok: false, reason: "query_error", error };

    let added = 0;
    for (const row of (data || [])) {
      const norm = normalizeRawEvent(row);
      const res = upsertNormalized(norm);
      if (res.added) added++;
    }

    if (added > 0) rebuildOrderedIfNeeded();
    emitUpdated({ source: "hydrate", added, fromIso, toIso, unitId });

    return { ok: true, added, count: _ordered.length };
  }

  function list(opts = {}) {
    const unitId = opts.unitId || getActiveUnitId();
    const fromMs = toMs(opts.from);
    const toMsVal = toMs(opts.to);
    const types = Array.isArray(opts.types) ? opts.types.map(String) : null;
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(10000, opts.limit)) : null;

    let out = _ordered;

    if (unitId) out = out.filter(e => e.unitId === String(unitId));
    if (fromMs != null) out = out.filter(e => e.ts >= fromMs);
    if (toMsVal != null) out = out.filter(e => e.ts <= toMsVal);
    if (types && types.length) out = out.filter(e => types.includes(e.type));

    if (limit != null && out.length > limit) {
      // Return most recent `limit` while preserving chronological order.
      out = out.slice(out.length - limit);
    }

    return out.slice(); // copy
  }

  function latest(opts = {}) {
    const arr = list({ ...opts, limit: 1 });
    return arr.length ? arr[arr.length - 1] : null;
  }

  function count(opts = {}) {
    return list(opts).length;
  }

  function clear() {
    _byId.clear();
    _ordered = [];
    _lastHydrateKey = null;
    emitUpdated({ source: "clear" });
  }

  window.shiftLog = {
    __ready: true,
    hydrate,
    list,
    latest,
    count,
    clear
  };
})();