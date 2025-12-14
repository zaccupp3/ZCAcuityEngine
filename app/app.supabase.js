// app/app.supabase.js
// Supabase client + helpers for auth + unit access + settings + shift publishing
// + UNIT STATE (shared board) + REALTIME subscription

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

  // ---- BOOT RESTORE (fix: session persists across refresh) ----
  (async function bootRestoreSession() {
    try {
      // If Supabase can read session normally, great.
      const p = client.auth.getSession();
      const t = new Promise((_, rej) =>
        setTimeout(() => rej(new Error("getSession timeout (boot)")), 3500)
      );

      const { data } = await Promise.race([p, t]);
      if (data?.session) return; // already restored

      // Otherwise: restore manually from localStorage
      const key = client.auth.storageKey;
      const raw = JSON.parse(localStorage.getItem(key) || "null");
      if (!raw?.access_token || !raw?.refresh_token) return;

      await client.auth.setSession({
        access_token: raw.access_token,
        refresh_token: raw.refresh_token,
      });
    } catch (e) {
      console.warn("[supabase] bootRestoreSession failed", e);
    }
  })();

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

    const { data, error } = await client
      .from("unit_settings")
      .upsert(payload, { onConflict: "unit_id" })
      .select("*")
      .single();

    return { row: data || null, error };
  }

  // ------------------------
  // ✅ UNIT STATE (shared board)
  // Table: public.unit_state
  // Columns expected:
  //   unit_id (uuid, PK or UNIQUE)
  //   state (jsonb)
  //   version (int)
  //   updated_by (uuid)
  //   updated_at (timestamptz)
  // ------------------------
  async function sbGetUnitState(unitId) {
    if (!unitId) return { row: null, error: new Error("sbGetUnitState: missing unitId") };

    const { data, error } = await client
      .from("unit_state")
      .select("*")
      .eq("unit_id", unitId)
      .limit(1);

    // If no row exists yet, data will be [] and error=null
    const row = Array.isArray(data) && data.length ? data[0] : null;
    return { row, error };
  }

  async function sbUpsertUnitState(payload) {
    // payload: { unit_id, state:<json>, version?:int, updated_by?:uuid }
    if (!payload || !payload.unit_id) {
      return { row: null, error: new Error("sbUpsertUnitState: missing payload.unit_id") };
    }

    const insertPayload = {
      unit_id: payload.unit_id,
      state: payload.state || {},
      version: typeof payload.version === "number" ? payload.version : 1,
      updated_by: payload.updated_by || null
      // updated_at should be server/default
    };

    const { data, error } = await client
      .from("unit_state")
      .upsert(insertPayload, { onConflict: "unit_id" })
      .select("*")
      .single();

    return { row: data || null, error };
  }

  // Realtime subscribe helper
  // Calls onChange(payload) when the unit_state row changes for this unit_id
  function sbSubscribeUnitState(unitId, onChange) {
    if (!unitId) {
      console.warn("[supabase] subscribeUnitState missing unitId");
      return null;
    }
    if (typeof onChange !== "function") {
      console.warn("[supabase] subscribeUnitState requires onChange callback");
      return null;
    }

    // NOTE:
    // Supabase Realtime listens on the "postgres_changes" event.
    // This filters to just this unit row.
    const channel = client
      .channel(`unit_state:${unitId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "unit_state",
          filter: `unit_id=eq.${unitId}`,
        },
        (payload) => {
          try { onChange(payload); } catch (e) { console.warn("[realtime] onChange error", e); }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log(`[realtime] subscribed unit_state:${unitId}`);
        }
      });

    return channel;
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
    if (!payload || (!payload.code && !payload.id)) {
      return { row: null, error: new Error("sbUpsertUnit: provide at least payload.code or payload.id") };
    }

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
    // ✅ unit_state (shared board)
    getUnitState: sbGetUnitState,
    upsertUnitState: sbUpsertUnitState,
    subscribeUnitState: sbSubscribeUnitState,
    // publishing + analytics
    insertShiftSnapshot: sbInsertShiftSnapshot,
    insertAnalyticsShiftMetrics: sbInsertAnalyticsShiftMetrics,
    // env helpers
    upsertUnit: sbUpsertUnit,
  };
})();