// app/app.supabase.js
// Supabase client + helpers for auth + unit access + settings + shift publishing
// + UNIT STATE (shared board) + REALTIME subscription
//
// GOAL:
// - Create exactly ONE Supabase client
// - Expose it consistently as:
//     window.sb.client (canonical)
//     window.supabaseClient (alias, same object)
// - NEVER replace window.sb object (only extend it)
//   so other modules never end up with stale references.
//
// ✅ This version:
// - UPSERT shift_snapshots + analytics_shift_metrics WITHOUT select() to avoid RLS-returning edge cases
// - UPSERT staff_shift_metrics (batch) WITHOUT select() to avoid RLS-returning edge cases
// - Keeps ensureUnitStaff and all other helpers intact
// - Ensures only ONE definition per helper (no duplicates)

(function () {
  const BUILD = "supabase_v2026-03-20_analytics_metrics_required_v3";
  const SUPABASE_URL = window.SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "";
  const supabaseLib = window.supabase;

  window.sb = window.sb || {};

  function markNotReady(reason) {
    console.warn(reason);
    window.sb.client = null;
    window.supabaseClient = null;
    window.sb.__ready = false;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    markNotReady("[supabase] Missing SUPABASE_URL / SUPABASE_ANON_KEY.");
    return;
  }
  if (!supabaseLib || typeof supabaseLib.createClient !== "function") {
    markNotReady("[supabase] Supabase library not loaded yet (window.supabase.createClient missing).");
    return;
  }

  let client = window.sb.client;
  if (!client) {
    client = supabaseLib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  }

  window.sb.client = client;
  window.supabaseClient = client;
  window.sb.__ready = true;
  window.sb.__build = BUILD;

  function normName(s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function isFillerStaffName(name) {
    const n = normName(name);
    if (!n) return true;
    return (
      /^incoming\s+(rn|pca)\s*\d*$/.test(n) ||
      /^current\s+(rn|pca)\s*\d*$/.test(n) ||
      /^oncoming\s+(rn|pca)\s*\d*$/.test(n) ||
      /^(noc|day|night)\s+(rn|pca)\s*\d*$/.test(n) ||
      /^(rn|pca)\s*staff$/.test(n) ||
      /^(rn|pca)\s*\d+$/.test(n) ||
      /^unknown\s+staff$/.test(n)
    );
  }

  function safeRole(role) {
    const r = String(role || "").trim().toUpperCase();
    return (r === "RN" || r === "PCA") ? r : "";
  }

  function safeShiftType(shiftType) {
    const s = String(shiftType || "").trim().toLowerCase();
    if (s === "day" || s.includes("day")) return "day";
    if (s === "night" || s === "noc" || s.includes("night") || s.includes("noc")) return "night";
    return s || "day";
  }

  // ------------------------
  // Auth helpers
  // ------------------------
  async function sbGetSession() {
    return client.auth.getSession();
  }

  async function sbGetUser() {
    const { data, error } = await client.auth.getUser();
    return { user: data?.user || null, error };
  }

  async function sbSignInWithEmail(email) {
    return client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    });
  }

  async function sbSignInWithPassword(email, password) {
    return client.auth.signInWithPassword({ email, password });
  }

  async function sbSignUpWithPassword(email, password) {
    return client.auth.signUp({ email, password });
  }

  async function sbSignOut() {
    return client.auth.signOut();
  }

  // ------------------------
  // Units + membership
  // ------------------------
  async function sbMyUnitMemberships() {
    return client
      .from("unit_members")
      .select("unit_id, role, units:unit_id ( id, name, code )")
      .order("created_at", { ascending: false });
  }

  async function sbMyUnitProfile() {
    const { data, error } = await client
      .from("unit_members")
      .select("unit_id, role, units:unit_id ( id, name, code )")
      .order("created_at", { ascending: false })
      .limit(1);

    return { row: data?.[0] || null, error };
  }

  // ------------------------
  // Unit settings
  // ------------------------
  async function sbGetUnitSettings(unitId) {
    const { data, error } = await client
      .from("unit_settings")
      .select("*")
      .eq("unit_id", unitId)
      .limit(1);

    return { row: data?.[0] || null, error };
  }

  async function sbUpsertUnitSettings(payload) {
    const { error } = await client
      .from("unit_settings")
      .upsert(payload, { onConflict: "unit_id" });

    return { ok: !error, error: error || null };
  }

  async function sbEnsureSixNorthUnit() {
    const beds = Array.from({ length: 36 }, (_, idx) => String(41 + idx));
    const { data: userData, error: userError } = await client.auth.getUser();
    const user = userData?.user || null;
    if (userError || !user) return { ok: false, error: userError || new Error("Sign in before creating 6 North.") };

    let unit = null;
    const existing = await client
      .from("units")
      .select("id, name, code")
      .eq("code", "6N")
      .limit(1);
    if (existing.error) return { ok: false, error: existing.error };
    unit = Array.isArray(existing.data) ? existing.data[0] : null;

    if (!unit) {
      const byName = await client
        .from("units")
        .select("id, name, code")
        .eq("name", "6 North")
        .limit(1);
      if (byName.error) return { ok: false, error: byName.error };
      unit = Array.isArray(byName.data) ? byName.data[0] : null;
    }

    if (!unit) {
      const created = await client
        .from("units")
        .insert([{ name: "6 North", code: "6N" }])
        .select("id, name, code")
        .single();
      if (created.error) return { ok: false, error: created.error };
      unit = created.data;
    }

    const membership = { unit_id: unit.id, user_id: user.id, role: "owner" };
    let memberResult = await client
      .from("unit_members")
      .upsert(membership, { onConflict: "unit_id,user_id" });
    if (memberResult.error) {
      memberResult = await client.from("unit_members").insert([membership]);
      const msg = String(memberResult.error?.message || "");
      if (memberResult.error && !/duplicate|violates unique/i.test(msg)) {
        return { ok: false, error: memberResult.error, unit };
      }
    }

    const settingsFull = {
      unit_id: unit.id,
      beds,
      room_schema: {
        kind: "single_rooms",
        beds,
        sharedRooms: false,
        label: "6 North"
      }
    };
    let settings = await sbUpsertUnitSettings(settingsFull);
    if (!settings.ok && /room_schema/i.test(String(settings.error?.message || ""))) {
      settings = await sbUpsertUnitSettings({ unit_id: unit.id, beds });
    }
    if (!settings.ok && /beds/i.test(String(settings.error?.message || ""))) {
      settings = await sbUpsertUnitSettings({ unit_id: unit.id, room_schema: settingsFull.room_schema });
    }
    if (!settings.ok) return { ok: false, error: settings.error, unit };

    return { ok: true, unit, beds };
  }

  // ------------------------
  // Shift publishing + analytics
  // Unique constraints:
  // - shift_snapshots: (unit_id, shift_date, shift_type)
  // - analytics_shift_metrics: (unit_id, shift_date, shift_type)
  // ------------------------
  async function sbUpsertShiftSnapshot(payload) {
    const { error } = await client
      .from("shift_snapshots")
      .upsert(payload, { onConflict: "unit_id,shift_date,shift_type" });

    return { ok: !error, error: error || null };
  }

  async function sbUpsertAnalyticsShiftMetrics(payload) {
    const base = payload && typeof payload === "object" ? payload : {};

    const canonical = {
      unit_id: base.unit_id,
      shift_date: base.shift_date,
      shift_type: safeShiftType(base.shift_type),
      total_pts: Number(base.total_pts ?? base.metrics?.totals?.total_pts ?? 0),
      admits: Number(base.admits ?? base.metrics?.totals?.admits ?? 0),
      discharges: Number(base.discharges ?? base.metrics?.totals?.discharges ?? 0)
    };
    if (base.tag_counts && typeof base.tag_counts === "object") canonical.tag_counts = base.tag_counts;
    const metricsAttempt = {
      unit_id: canonical.unit_id,
      shift_date: canonical.shift_date,
      shift_type: canonical.shift_type,
      metrics: base.metrics && typeof base.metrics === "object"
        ? base.metrics
        : {
            version: 2,
            totals: {
              total_pts: canonical.total_pts,
              admits: canonical.admits,
              discharges: canonical.discharges
            },
            tag_counts: canonical.tag_counts || {}
          }
    };
    if (base.created_by) metricsAttempt.created_by = base.created_by;

    const { error: metricsError } = await client
      .from("analytics_shift_metrics")
      .upsert(metricsAttempt, { onConflict: "unit_id,shift_date,shift_type" });
    if (!metricsError) return { ok: true, error: null };

    let metricsColumnError = metricsError;
    const metricsMsg = String(metricsError?.message || metricsError || "");
    if (/Could not find the 'created_by' column/i.test(metricsMsg)) {
      const retry = { ...metricsAttempt };
      delete retry.created_by;
      const { error: retryError } = await client
        .from("analytics_shift_metrics")
        .upsert(retry, { onConflict: "unit_id,shift_date,shift_type" });
      if (!retryError) return { ok: true, error: null };
      metricsColumnError = retryError;
      if (!/Could not find the 'metrics' column/i.test(String(retryError?.message || retryError || ""))) {
        return { ok: false, error: retryError || null };
      }
    }

    if (!/Could not find the 'metrics' column/i.test(String(metricsColumnError?.message || metricsColumnError || ""))) {
      return { ok: false, error: metricsColumnError || null };
    }

    const legacyAttempt = {
      unit_id: canonical.unit_id,
      shift_date: canonical.shift_date,
      shift_type: canonical.shift_type,
      total_pts: canonical.total_pts,
      admits: canonical.admits,
      discharges: canonical.discharges,
      tag_counts: canonical.tag_counts || {}
    };
    if (base.created_by) legacyAttempt.created_by = base.created_by;

    const { error: legacyError } = await client
      .from("analytics_shift_metrics")
      .upsert(legacyAttempt, { onConflict: "unit_id,shift_date,shift_type" });
    if (legacyError && /Could not find the 'created_by' column/i.test(String(legacyError?.message || legacyError || ""))) {
      const retryLegacy = { ...legacyAttempt };
      delete retryLegacy.created_by;
      const { error: retryLegacyError } = await client
        .from("analytics_shift_metrics")
        .upsert(retryLegacy, { onConflict: "unit_id,shift_date,shift_type" });
      return { ok: !retryLegacyError, error: retryLegacyError || null };
    }

    return { ok: !legacyError, error: legacyError || null };
  }

  // ------------------------
  // Staff metrics (batch UPSERT)
  // Unique constraint:
  // (unit_id, shift_date, shift_type, staff_id, role)
  // ------------------------
  async function sbUpsertStaffShiftMetrics(rows) {
    const payload = Array.isArray(rows)
      ? rows.map((row) => ({
          ...row,
          shift_type: safeShiftType(row?.shift_type)
        }))
      : [];
    if (!payload.length) return { ok: true, error: null };

    const { error } = await client
      .from("staff_shift_metrics")
      .upsert(payload, { onConflict: "unit_id,shift_date,shift_type,staff_id,role" });
    if (error && /Could not find the 'created_by' column/i.test(String(error?.message || error || ""))) {
      const retryPayload = payload.map((row) => {
        const next = { ...row };
        delete next.created_by;
        return next;
      });
      const { error: retryError } = await client
        .from("staff_shift_metrics")
        .upsert(retryPayload, { onConflict: "unit_id,shift_date,shift_type,staff_id,role" });
      return { ok: !retryError, error: retryError || null };
    }

    return { ok: !error, error: error || null };
  }

  // ------------------------
  // Unit Staff helpers (autosuggest + de-dupe)
  // ------------------------
  async function sbListUnitStaff(unitId, role, limit = 50) {
    const uid = String(unitId || "");
    const r = safeRole(role);
    if (!uid || !r) return { rows: [], error: new Error("Missing unitId or invalid role (RN/PCA)") };

    const { data, error } = await client
      .from("unit_staff")
      .select("id, unit_id, role, display_name, display_name_norm, is_active, created_at")
      .eq("unit_id", uid)
      .eq("role", r)
      .eq("is_active", true)
      .order("display_name", { ascending: true })
      .limit(Number(limit) || 50);

    return { rows: Array.isArray(data) ? data.filter((row) => !isFillerStaffName(row.display_name)) : [], error };
  }

  async function sbSearchUnitStaff(unitId, role, q, limit = 10) {
    const uid = String(unitId || "");
    const r = safeRole(role);
    const query = normName(q);
    if (!uid || !r) return { rows: [], error: new Error("Missing unitId or invalid role (RN/PCA)") };
    if (!query) return { rows: [], error: null };

    const { data, error } = await client
      .from("unit_staff")
      .select("id, unit_id, role, display_name, display_name_norm, is_active, created_at")
      .eq("unit_id", uid)
      .eq("role", r)
      .eq("is_active", true)
      .ilike("display_name_norm", `%${query}%`)
      .order("display_name", { ascending: true })
      .limit(Number(limit) || 10);

    return { rows: Array.isArray(data) ? data.filter((row) => !isFillerStaffName(row.display_name)) : [], error };
  }

  async function sbEnsureUnitStaff(unitId, role, displayName) {
    const uid = String(unitId || "");
    const r = safeRole(role);
    const dn = String(displayName || "").trim();
    const dnNorm = normName(dn);

    if (!uid || !r) return { row: null, error: new Error("Missing unitId or invalid role (RN/PCA)") };
    if (!dn) return { row: null, error: new Error("Missing displayName") };
    if (isFillerStaffName(dn)) return { row: null, error: null };

    const found = await client
      .from("unit_staff")
      .select("id, unit_id, role, display_name, display_name_norm, is_active, created_at")
      .eq("unit_id", uid)
      .eq("role", r)
      .eq("display_name_norm", dnNorm)
      .limit(1);

    if (found.error) return { row: null, error: found.error };
    if (Array.isArray(found.data) && found.data[0]) return { row: found.data[0], error: null };

    const ins = await client
      .from("unit_staff")
      .insert([{
        unit_id: uid,
        role: r,
        display_name: dn,
        display_name_norm: dnNorm,
        is_active: true
      }])
      .select("id, unit_id, role, display_name, display_name_norm, is_active, created_at")
      .single();

    return { row: ins.data || null, error: ins.error || null };
  }

  // ------------------------
  // Unit State (cloud) helpers
  // ------------------------
  const UNIT_STATE_TABLE = "unit_state";

  function hasClient() {
    return !!(client && typeof client.from === "function");
  }
  function safeUnitId(unitId) {
    return unitId ? String(unitId) : null;
  }

  async function sbGetUnitState(unitId) {
    const uid = safeUnitId(unitId);
    if (!uid) return { row: null, error: new Error("Missing unitId") };
    if (!hasClient()) return { row: null, error: new Error("Supabase client not ready") };

    try {
      const { data, error } = await client
        .from(UNIT_STATE_TABLE)
        .select("*")
        .eq("unit_id", uid)
        .limit(1)
        .maybeSingle();

      if (error) return { row: null, error };
      return { row: data || null, error: null };
    } catch (e) {
      return { row: null, error: e };
    }
  }

  async function sbUpsertUnitState(payload) {
    if (!hasClient()) return { row: null, error: new Error("Supabase client not ready") };
    if (!payload || !payload.unit_id) return { row: null, error: new Error("Missing payload.unit_id") };

    const uid = String(payload.unit_id);
    const next = { ...payload, unit_id: uid, updated_at: payload.updated_at || new Date().toISOString() };

    try {
      const { data, error } = await client
        .from(UNIT_STATE_TABLE)
        .upsert(next, { onConflict: "unit_id" })
        .select("*")
        .single();

      if (error) return { row: null, error };
      return { row: data || null, error: null };
    } catch (e) {
      return { row: null, error: e };
    }
  }

  function sbSubscribeUnitState(unitId, onChange) {
    const uid = safeUnitId(unitId);
    if (!uid) {
      console.warn("[cloud] subscribeUnitState: missing unitId");
      return { unsubscribe() {} };
    }
    if (!hasClient() || typeof client.channel !== "function") {
      console.warn("[cloud] subscribeUnitState: realtime not ready");
      return { unsubscribe() {} };
    }

    try {
      if (window.sb.__unitStateChannel && typeof window.sb.__unitStateChannel.unsubscribe === "function") {
        window.sb.__unitStateChannel.unsubscribe();
      }
    } catch {}

    const channel = client
      .channel(`unit_state:${uid}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: UNIT_STATE_TABLE, filter: `unit_id=eq.${uid}` },
        (payload) => {
          try { if (typeof onChange === "function") onChange(payload); } catch (e) {
            console.warn("[cloud] onChange handler error", e);
          }
        }
      )
      .subscribe();

    window.sb.__unitStateChannel = channel;

    return { unsubscribe() { try { channel.unsubscribe(); } catch {} } };
  }

  // ------------------------
  // Expose API (extend sb; do NOT replace it)
  // ------------------------
  Object.assign(window.sb, {
    client,

    // auth
    getSession: sbGetSession,
    getUser: sbGetUser,
    signInWithEmail: sbSignInWithEmail,
    signInWithPassword: sbSignInWithPassword,
    signUpWithPassword: sbSignUpWithPassword,
    signOut: sbSignOut,

    // membership
    myUnitMemberships: sbMyUnitMemberships,
    myUnitProfile: sbMyUnitProfile,

    // settings
    getUnitSettings: sbGetUnitSettings,
    upsertUnitSettings: sbUpsertUnitSettings,
    ensureSixNorthUnit: sbEnsureSixNorthUnit,

    // publishing + analytics (UPSERT; no select)
    upsertShiftSnapshot: sbUpsertShiftSnapshot,
    upsertAnalyticsShiftMetrics: sbUpsertAnalyticsShiftMetrics,

    // staff metrics (UPSERT; no select)
    upsertStaffShiftMetrics: sbUpsertStaffShiftMetrics,

    // staff directory
    listUnitStaff: sbListUnitStaff,
    searchUnitStaff: sbSearchUnitStaff,
    ensureUnitStaff: sbEnsureUnitStaff,

    // unit state
    getUnitState: sbGetUnitState,
    upsertUnitState: sbUpsertUnitState,
    subscribeUnitState: sbSubscribeUnitState
  });

  window.supabaseClient = window.sb.client;
  console.log("[supabase] loaded", BUILD);

  window.afterAuthRoute = async function (_session) {
    try {
      if (typeof window.setActiveUnitFromMembership === "function") {
        await window.setActiveUnitFromMembership();
      }
      if (typeof window.renderAll === "function") window.renderAll();
    } catch (e) {
      console.warn("[afterAuthRoute] error", e);
    }
  };
})();
