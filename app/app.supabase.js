// app/app.supabase.js
// Supabase client + helpers for auth + unit access + settings + shift publishing

// 1) Add this to index.html BEFORE app.init.js (so it's ready at boot):
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
// <script src="app/app.supabase.js"></script>

(function () {
  // Put these in Replit Secrets or Vercel env later.
  // For quick local testing you can paste them here, but DON'T commit real keys.
  const SUPABASE_URL = window.SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "";

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn(
      "[supabase] Missing SUPABASE_URL / SUPABASE_ANON_KEY. Set window.SUPABASE_URL and window.SUPABASE_ANON_KEY."
    );
    window.supabaseClient = null;

    // still expose a stub so callers don't explode
    window.sb = {
      client: null,
      getSession: async () => ({ data: null, error: new Error("Supabase not configured") }),
      getUser: async () => ({ user: null, error: new Error("Supabase not configured") }),
    };
    return;
  }

  // Create client
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  window.supabaseClient = client;

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
    // Magic link (passwordless) starter
    return client.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });
  }

  async function sbSignOut() {
    return client.auth.signOut();
  }

  // ------------------------
  // Units + membership
  // ------------------------
  async function sbMyUnitMemberships() {
    // With RLS, user only sees their own memberships
    return client
      .from("unit_members")
      .select("unit_id, role, units:unit_id ( id, name, code )")
      .order("created_at", { ascending: false });
  }

  async function sbMyUnitProfile() {
    // returns { unit_id, role, units: {id,name,code} } or null if none
    const { data, error } = await client
      .from("unit_members")
      .select("unit_id, role, units:unit_id ( id, name, code )")
      .order("created_at", { ascending: false })
      .limit(1);

    return { row: data && data[0] ? data[0] : null, error };
  }

  // ------------------------
  // Unit settings
  // ------------------------
  async function sbGetUnitSettings(unitId) {
    if (!unitId) return { row: null, error: new Error("sbGetUnitSettings: missing unitId") };

    const { data, error } = await client
      .from("unit_settings")
      .select("*")
      .eq("unit_id", unitId)
      .order("updated_at", { ascending: false })
      .limit(1);

    return { row: data && data[0] ? data[0] : null, error };
  }

  async function sbUpsertUnitSettings(payload) {
    // Expects: { unit_id, room_schema, staffing_defaults, enabled_tags, ruleset, updated_by? }
    if (!payload || !payload.unit_id) {
      return { row: null, error: new Error("sbUpsertUnitSettings: missing payload.unit_id") };
    }

    // Assumes you have a UNIQUE constraint on unit_settings.unit_id (recommended).
    // If not, this will insert duplicates; we can adjust later.
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
    // payload:
    // { unit_id, shift_date:'YYYY-MM-DD', shift_type:'day'|'night', status:'published'|'draft', state:<json>, created_by? }
    if (!payload || !payload.unit_id || !payload.shift_date || !payload.shift_type) {
      return { row: null, error: new Error("sbInsertShiftSnapshot: missing required fields") };
    }

    const { data, error } = await client
      .from("shift_snapshots")
      .insert(payload)
      .select("*")
      .single();

    return { row: data || null, error };
  }

  async function sbInsertAnalyticsShiftMetrics(payload) {
    // payload:
    // { unit_id, shift_date:'YYYY-MM-DD', shift_type:'day'|'night', metrics:<json>, created_by? }
    if (!payload || !payload.unit_id || !payload.shift_date || !payload.shift_type) {
      return { row: null, error: new Error("sbInsertAnalyticsShiftMetrics: missing required fields") };
    }

    const { data, error } = await client
      .from("analytics_shift_metrics")
      .insert(payload)
      .select("*")
      .single();

    return { row: data || null, error };
  }

  // ------------------------
  // Optional: units create/upsert helper (for your Environment seeding actions)
  // ------------------------
  async function sbUpsertUnit(payload) {
    // payload: { id?, name, code, ... }
    // This assumes you have a UNIQUE constraint on units.code (recommended) or units.id.
    if (!payload || (!payload.code && !payload.id)) {
      return { row: null, error: new Error("sbUpsertUnit: provide at least payload.code or payload.id") };
    }

    // Prefer onConflict=code if code exists, otherwise onConflict=id
    const onConflict = payload.code ? "code" : "id";

    const { data, error } = await client
      .from("units")
      .upsert(payload, { onConflict })
      .select("*")
      .single();

    return { row: data || null, error };
  }

  // Expose
  window.sb = {
    client,
    // auth
    getSession: sbGetSession,
    getUser: sbGetUser,
    signInWithEmail: sbSignInWithEmail,
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
    // env helpers
    upsertUnit: sbUpsertUnit,
  };
})();