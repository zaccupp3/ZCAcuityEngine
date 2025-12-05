// app/app.supabase.js
// Supabase client + small helpers for auth + unit access

// 1) Add this to index.html BEFORE app.init.js (so it's ready at boot):
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
// <script src="app/app.supabase.js"></script>

(function () {
  // Put these in Replit Secrets or Vercel env later.
  // For quick local testing you can paste them here, but DON'T commit real keys.
  const SUPABASE_URL = window.SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "";

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn("[supabase] Missing SUPABASE_URL / SUPABASE_ANON_KEY. Set window.SUPABASE_URL and window.SUPABASE_ANON_KEY.");
    window.supabaseClient = null;
    return;
  }

  // Create client
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  window.supabaseClient = client;

  // ---- Auth helpers ----
  async function sbGetSession() {
    return client.auth.getSession();
  }

  async function sbSignInWithEmail(email) {
    // Magic link (passwordless) starter
    return client.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin
      }
    });
  }

  async function sbSignOut() {
    return client.auth.signOut();
  }

  // ---- Units + membership ----
  async function sbMyUnitMemberships() {
    // With RLS, user only sees their own memberships
    return client
      .from("unit_members")
      .select("unit_id, role, units:unit_id ( id, name, code )");
  }

  async function sbGetUser() {
    const { data, error } = await client.auth.getUser();
    return { user: data?.user || null, error };
  }

  async function sbMyUnitProfile() {
    // returns { unit_id, role, units: {id,name,code} } or null if none
    const { data, error } = await client
      .from("unit_members")
      .select("unit_id, role, units:unit_id ( id, name, code )")
      .order("created_at", { ascending: false })
      .limit(1);

    return { row: (data && data[0]) ? data[0] : null, error };
  }
  
  // Expose
  window.sb = {
    client,
    getSession: sbGetSession,
    signInWithEmail: sbSignInWithEmail,
    signOut: sbSignOut,

    // already had:
    myUnitMemberships: sbMyUnitMemberships,

    // ADD these:
    getUser: sbGetUser,
    myUnitProfile: sbMyUnitProfile,
  };