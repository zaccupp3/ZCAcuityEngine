// app/app.supabase.js
// Supabase client + helpers for auth + unit access + settings + shift publishing
// + UNIT STATE (shared board) + REALTIME subscription

(function () {
  const SUPABASE_URL = window.SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "";

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn("[supabase] Missing SUPABASE_URL / SUPABASE_ANON_KEY.");
    window.sb = { client: null };
    return;
  }

  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

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

  // Magic link (existing)
  async function sbSignInWithEmail(email) {
    return client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    });
  }

  // ✅ NEW: Email + Password sign in
  async function sbSignInWithPassword(email, password) {
    return client.auth.signInWithPassword({ email, password });
  }

  // ✅ NEW: Email + Password sign up
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
  // Expose API
  // ------------------------

  window.sb = {
    client,

    // auth
    getSession: sbGetSession,
    getUser: sbGetUser,
    signInWithEmail: sbSignInWithEmail,
    signInWithPassword: sbSignInWithPassword,   // ✅ new
    signUpWithPassword: sbSignUpWithPassword,   // ✅ new
    signOut: sbSignOut,

    // membership
    myUnitMemberships: sbMyUnitMemberships,
    myUnitProfile: sbMyUnitProfile,

    // settings
    getUnitSettings: sbGetUnitSettings,
    upsertUnitSettings: sbUpsertUnitSettings,

    // publishing + analytics
    insertShiftSnapshot: sbInsertShiftSnapshot,
    insertAnalyticsShiftMetrics: sbInsertAnalyticsShiftMetrics
  };
})();

window.afterAuthRoute = async function (session) {
  // 1) fetch memberships (your RLS should enforce what they can see)
  // 2) choose activeUnitId
  // 3) re-render / init normally

  // Placeholder:
  if (typeof window.setActiveUnitFromMembership === "function") {
    await window.setActiveUnitFromMembership();
  }

  if (typeof window.renderAll === "function") window.renderAll();
};

// ---------------------------------------------------------
// Unit State (cloud) helpers (matches app.init.js expectations)
// Required by app.init.js:
// - sb.getUnitState(unitId) -> { row, error }
// - sb.upsertUnitState(payload) -> { row, error }
// - sb.subscribeUnitState(unitId, onChange) -> channel-like with unsubscribe()
// ---------------------------------------------------------

(function () {
  if (!window.sb) window.sb = {};
  const sb = window.sb;

  const UNIT_STATE_TABLE = "unit_state"; // expects columns: unit_id, state (jsonb), version (int), updated_by, updated_at

  function hasClient() {
    return !!(sb.client && typeof sb.client.from === "function");
  }

  function safeUnitId(unitId) {
    return unitId ? String(unitId) : null;
  }

  // --------
  // GET ROW
  // --------
  sb.getUnitState = async function (unitId) {
    const uid = safeUnitId(unitId);
    if (!uid) return { row: null, error: new Error("Missing unitId") };

    if (!hasClient()) return { row: null, error: new Error("Supabase client not ready") };

    try {
      const { data, error } = await sb.client
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
  };

  // ------------
  // UPSERT ROW
  // ------------
  sb.upsertUnitState = async function (payload) {
    if (!hasClient()) return { row: null, error: new Error("Supabase client not ready") };
    if (!payload || !payload.unit_id) return { row: null, error: new Error("Missing payload.unit_id") };

    const uid = String(payload.unit_id);

    // Ensure updated_at always exists for ordering/debugging
    const next = {
      ...payload,
      unit_id: uid,
      updated_at: payload.updated_at || new Date().toISOString()
    };

    try {
      // Requires a UNIQUE constraint on unit_id for onConflict to work as intended
      const { data, error } = await sb.client
        .from(UNIT_STATE_TABLE)
        .upsert(next, { onConflict: "unit_id" })
        .select("*")
        .single();

      if (error) return { row: null, error };
      return { row: data || null, error: null };
    } catch (e) {
      return { row: null, error: e };
    }
  };

  // -----------------------
  // REALTIME SUBSCRIPTION
  // -----------------------
  // Supports:
  //   sb.subscribeUnitState(unitId, (payload) => {})
  // Returns object with unsubscribe()
  sb.subscribeUnitState = function (unitId, onChange) {
    const uid = safeUnitId(unitId);
    if (!uid) {
      console.warn("[cloud] subscribeUnitState: missing unitId");
      return { unsubscribe() {} };
    }

    if (!hasClient() || typeof sb.client.channel !== "function") {
      console.warn("[cloud] subscribeUnitState: realtime not ready");
      return { unsubscribe() {} };
    }

    // kill old channel if exists
    try {
      if (sb.__unitStateChannel && typeof sb.__unitStateChannel.unsubscribe === "function") {
        sb.__unitStateChannel.unsubscribe();
      }
    } catch {}

    const channel = sb.client
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

    sb.__unitStateChannel = channel;

    return {
      unsubscribe() {
        try { channel.unsubscribe(); } catch {}
      }
    };
  };
})();