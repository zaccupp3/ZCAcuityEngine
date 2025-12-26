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
// ✅ NEW (THIS UPDATE):
// - upsertStaffShiftMetrics(rows[]) helper (anti-duplicate)

(function () {
  const SUPABASE_URL = window.SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "";

  // supabase-js UMD exposes `window.supabase` as the library (with createClient)
  const supabaseLib = window.supabase;

  // Always keep a stable sb object reference
  window.sb = window.sb || {};

  function markNotReady(reason) {
    console.warn(reason);
    window.sb.client = null;
    window.supabaseClient = null;
    // optional marker for debugging
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

  // If client already exists, reuse it (prevents accidental double-init)
  let client = window.sb.client;
  if (!client) {
    client = supabaseLib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  }

  // Canonical + alias (same object)
  window.sb.client = client;
  window.supabaseClient = client;

  // optional marker for debugging / readiness checks
  window.sb.__ready = true;

  // ------------------------
  // Small helpers
  // ------------------------
  function normName(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function safeRole(role) {
    const r = String(role || "").trim().toUpperCase();
    return (r === "RN" || r === "PCA") ? r : "";
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
    const { data, error } = await client
      .from("unit_settings")
      .upsert(payload, { onConflict: "unit_id" })
      .select("*")
      .single();

    return { row: data || null, error };
  }

  // ------------------------
  // Shift publishing + analytics
  // ------------------------
  async function sbInsertShiftSnapshot(payload) {
    const { data, error } = await client
      .from("shift_snapshots")
      .insert(payload)
      .select("*")
      .single();

    return { row: data || null, error };
  }

  async function sbInsertAnalyticsShiftMetrics(payload) {
    const { data, error } = await client
      .from("analytics_shift_metrics")
      .insert(payload)
      .select("*")
      .single();

    return { row: data || null, error };
  }

  // ------------------------
  // ✅ Staff metrics (batch UPSERT - anti-duplicate)
  // Requires a unique constraint/index on:
  // (unit_id, shift_date, shift_type, role, staff_id)
  // ------------------------
  async function sbUpsertStaffShiftMetrics(rows) {
    const payload = Array.isArray(rows) ? rows : [];
    if (!payload.length) return { rows: [], error: null };

    const { data, error } = await client
      .from("staff_shift_metrics")
      .upsert(payload, { onConflict: "unit_id,shift_date,shift_type,role,staff_id" })
      .select("*");

    return { rows: Array.isArray(data) ? data : [], error };
  }

  // ------------------------
  // ✅ Unit Staff helpers (for autosuggest + de-dupe)
  // Table columns confirmed:
  // id, unit_id, role, display_name, display_name_norm, is_active, created_at
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

    return { rows: Array.isArray(data) ? data : [], error };
  }

  async function sbSearchUnitStaff(unitId, role, q, limit = 10) {
    const uid = String(unitId || "");
    const r = safeRole(role);
    const query = normName(q);
    if (!uid || !r) return { rows: [], error: new Error("Missing unitId or invalid role (RN/PCA)") };
    if (!query) return { rows: [], error: null };

    // Search against display_name_norm (NOT normalized_name)
    const { data, error } = await client
      .from("unit_staff")
      .select("id, unit_id, role, display_name, display_name_norm, is_active, created_at")
      .eq("unit_id", uid)
      .eq("role", r)
      .eq("is_active", true)
      .ilike("display_name_norm", `%${query}%`)
      .order("display_name", { ascending: true })
      .limit(Number(limit) || 10);

    return { rows: Array.isArray(data) ? data : [], error };
  }

  async function sbEnsureUnitStaff(unitId, role, displayName) {
    const uid = String(unitId || "");
    const r = safeRole(role);
    const dn = String(displayName || "").trim();
    const dnNorm = normName(dn);

    if (!uid || !r) return { row: null, error: new Error("Missing unitId or invalid role (RN/PCA)") };
    if (!dn) return { row: null, error: new Error("Missing displayName") };

    // 1) try find existing by normalized name
    const found = await client
      .from("unit_staff")
      .select("id, unit_id, role, display_name, display_name_norm, is_active, created_at")
      .eq("unit_id", uid)
      .eq("role", r)
      .eq("display_name_norm", dnNorm)
      .limit(1);

    if (found.error) return { row: null, error: found.error };
    if (Array.isArray(found.data) && found.data[0]) return { row: found.data[0], error: null };

    // 2) insert new
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
  const UNIT_STATE_TABLE = "unit_state"; // expects: unit_id, state(jsonb), version(int), updated_by, updated_at

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

    const next = {
      ...payload,
      unit_id: uid,
      updated_at: payload.updated_at || new Date().toISOString()
    };

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

    // kill old channel if exists (store it on sb, which is now stable)
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
          try {
            if (typeof onChange === "function") onChange(payload);
          } catch (e) {
            console.warn("[cloud] onChange handler error", e);
          }
        }
      )
      .subscribe();

    window.sb.__unitStateChannel = channel;

    return {
      unsubscribe() {
        try { channel.unsubscribe(); } catch {}
      }
    };
  }

  // ------------------------
  // Expose API (extend sb; do NOT replace it)
  // ------------------------
  Object.assign(window.sb, {
    // client
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

    // publishing + analytics
    insertShiftSnapshot: sbInsertShiftSnapshot,
    insertAnalyticsShiftMetrics: sbInsertAnalyticsShiftMetrics,

    // ✅ staff metrics (UPSERT)
    upsertStaffShiftMetrics: sbUpsertStaffShiftMetrics,

    // ✅ staff directory
    listUnitStaff: sbListUnitStaff,
    searchUnitStaff: sbSearchUnitStaff,
    ensureUnitStaff: sbEnsureUnitStaff,

    // unit state
    getUnitState: sbGetUnitState,
    upsertUnitState: sbUpsertUnitState,
    subscribeUnitState: sbSubscribeUnitState
  });

  // Ensure alias always matches canonical (paranoia / future-proofing)
  window.supabaseClient = window.sb.client;

  // ------------------------
  // Optional post-auth hook
  // ------------------------
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