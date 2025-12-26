// app/app.supabase.js
// Supabase client + helpers for auth + unit access + settings + shift publishing
// + UNIT STATE (shared board) + REALTIME subscription
// + UNIT STAFF DIRECTORY (typeahead + ensure staff)
// ----------------------------------------------------
// GOAL:
// - Create exactly ONE Supabase client
// - Expose it consistently as:
//     window.sb.client (canonical)
//     window.supabaseClient (alias, same object)
// - NEVER replace window.sb object (only extend it)
//   so other modules never end up with stale references.

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
  window.sb.__ready = true;

  function hasClient() {
    return !!(client && typeof client.from === "function");
  }

  function safeStr(x) {
    return (x == null) ? "" : String(x);
  }

  // IMPORTANT: roles must be "RN" or "PCA"
  function normalizeRole(role) {
    const r = safeStr(role).trim().toUpperCase();
    return (r === "RN" || r === "PCA") ? r : "";
  }

  function normalizeName(s) {
    return safeStr(s)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^a-z0-9 \-']/g, "");
  }

  function looksLikeMissingColumn(err) {
    const msg = safeStr(err?.message || err);
    return /column .* does not exist/i.test(msg) || /PGRST\d+/i.test(msg);
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
  // Unit State (cloud) helpers
  // ------------------------
  const UNIT_STATE_TABLE = "unit_state"; // expects: unit_id, state(jsonb), version(int), updated_by, updated_at

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

  // ----------------------------------------------------
  // ✅ Unit Staff Directory helpers (schema tolerant)
  // Table: unit_staff
  // Expected (ideal) columns:
  //  - id (uuid)
  //  - unit_id (uuid)
  //  - role ("RN" | "PCA")
  //  - display_name (text)
  //  - normalized_name (text)  [optional]
  //  - is_active (bool)        [optional]
  //  - created_at (timestamptz)
  //
  // If your schema differs, these functions auto-fallback
  // so you stop seeing 400s.
  // ----------------------------------------------------

  async function sbListUnitStaff(unitId, role, limit = 50) {
    const uid = safeUnitId(unitId);
    const r = normalizeRole(role);
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));

    if (!uid) return { rows: [], error: new Error("Missing unitId") };
    if (!r) return { rows: [], error: new Error('Role must be "RN" or "PCA"') };
    if (!hasClient()) return { rows: [], error: new Error("Supabase client not ready") };

    // Attempt 1: full schema
    let q = client
      .from("unit_staff")
      .select("id, unit_id, role, display_name, normalized_name, is_active, created_at")
      .eq("unit_id", uid)
      .eq("role", r)
      .eq("is_active", true)
      .order("display_name", { ascending: true })
      .limit(lim);

    let res = await q;
    if (!res.error) return { rows: Array.isArray(res.data) ? res.data : [], error: null };

    // Fallback if missing columns (normalized_name / is_active / display_name)
    if (!looksLikeMissingColumn(res.error)) {
      return { rows: [], error: res.error };
    }

    // Attempt 2: minimal schema (no is_active / normalized_name)
    q = client
      .from("unit_staff")
      .select("id, unit_id, role, display_name, created_at")
      .eq("unit_id", uid)
      .eq("role", r)
      .order("display_name", { ascending: true })
      .limit(lim);

    res = await q;
    if (!res.error) return { rows: Array.isArray(res.data) ? res.data : [], error: null };

    // Attempt 3: ultra-minimal (if display_name isn't the column name, select *)
    q = client
      .from("unit_staff")
      .select("*")
      .eq("unit_id", uid)
      .eq("role", r)
      .limit(lim);

    res = await q;
    return { rows: Array.isArray(res.data) ? res.data : [], error: res.error || null };
  }

  async function sbSearchUnitStaff(unitId, role, query, limit = 10) {
    const uid = safeUnitId(unitId);
    const r = normalizeRole(role);
    const qstr = safeStr(query).trim();
    const lim = Math.max(1, Math.min(50, Number(limit) || 10));

    if (!uid) return { rows: [], error: new Error("Missing unitId") };
    if (!r) return { rows: [], error: new Error('Role must be "RN" or "PCA"') };
    if (!qstr) return { rows: [], error: null };
    if (!hasClient()) return { rows: [], error: new Error("Supabase client not ready") };

    // Prefer searching normalized_name if it exists, else ilike display_name
    const norm = normalizeName(qstr);

    // Attempt 1: normalized_name ilike
    let res = await client
      .from("unit_staff")
      .select("id, unit_id, role, display_name, normalized_name, is_active, created_at")
      .eq("unit_id", uid)
      .eq("role", r)
      .eq("is_active", true)
      .ilike("normalized_name", `%${norm}%`)
      .order("display_name", { ascending: true })
      .limit(lim);

    if (!res.error) return { rows: Array.isArray(res.data) ? res.data : [], error: null };
    if (!looksLikeMissingColumn(res.error)) return { rows: [], error: res.error };

    // Attempt 2: display_name ilike (no normalized/is_active)
    res = await client
      .from("unit_staff")
      .select("id, unit_id, role, display_name, created_at")
      .eq("unit_id", uid)
      .eq("role", r)
      .ilike("display_name", `%${qstr}%`)
      .order("display_name", { ascending: true })
      .limit(lim);

    return { rows: Array.isArray(res.data) ? res.data : [], error: res.error || null };
  }

  async function sbEnsureUnitStaff(unitId, role, displayName) {
    const uid = safeUnitId(unitId);
    const r = normalizeRole(role);
    const dn = safeStr(displayName).trim();
    const norm = normalizeName(dn);

    if (!uid) return { row: null, error: new Error("Missing unitId") };
    if (!r) return { row: null, error: new Error('Role must be "RN" or "PCA"') };
    if (!dn) return { row: null, error: new Error("Missing displayName") };
    if (!hasClient()) return { row: null, error: new Error("Supabase client not ready") };

    // Try find by normalized_name (best) then fall back to display_name
    let findRes = await client
      .from("unit_staff")
      .select("id, unit_id, role, display_name, normalized_name, is_active, created_at")
      .eq("unit_id", uid)
      .eq("role", r)
      .eq("normalized_name", norm)
      .limit(1);

    if (!findRes.error && Array.isArray(findRes.data) && findRes.data[0]) {
      return { row: findRes.data[0], error: null };
    }

    // If missing normalized_name column, try display_name exact match
    if (findRes.error && looksLikeMissingColumn(findRes.error)) {
      findRes = await client
        .from("unit_staff")
        .select("id, unit_id, role, display_name, created_at")
        .eq("unit_id", uid)
        .eq("role", r)
        .eq("display_name", dn)
        .limit(1);

      if (!findRes.error && Array.isArray(findRes.data) && findRes.data[0]) {
        return { row: findRes.data[0], error: null };
      }
    } else if (findRes.error) {
      // Other error type
      return { row: null, error: findRes.error };
    }

    // Insert: attempt full payload first, then fallback minimal
    let insertRes = await client
      .from("unit_staff")
      .insert({
        unit_id: uid,
        role: r,
        display_name: dn,
        normalized_name: norm,
        is_active: true
      })
      .select("*")
      .single();

    if (!insertRes.error) return { row: insertRes.data || null, error: null };

    if (!looksLikeMissingColumn(insertRes.error)) {
      return { row: null, error: insertRes.error };
    }

    // Fallback insert: minimal fields only
    insertRes = await client
      .from("unit_staff")
      .insert({
        unit_id: uid,
        role: r,
        display_name: dn
      })
      .select("*")
      .single();

    return { row: insertRes.data || null, error: insertRes.error || null };
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

    // unit state
    getUnitState: sbGetUnitState,
    upsertUnitState: sbUpsertUnitState,
    subscribeUnitState: sbSubscribeUnitState,

    // ✅ staff directory
    listUnitStaff: sbListUnitStaff,
    searchUnitStaff: sbSearchUnitStaff,
    ensureUnitStaff: sbEnsureUnitStaff
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