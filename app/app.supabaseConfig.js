// app/app.supabaseConfig.js
// Default project credentials can be overridden locally without editing source:
// - localStorage.__supabaseUrl
// - localStorage.__supabaseAnonKey
// - window.setSupabaseConfig(url, anonKey, { persist: true })
(function () {
  const DEFAULT_URL = "https://nzentjlumxxljmwaddkf.supabase.co";
  const DEFAULT_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56ZW50amx1bXh4bGptd2FkZGtmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ4NDc4NjQsImV4cCI6MjA4MDQyMzg2NH0.NOinPC0uH54700DJBwY7COLxNVkwfbem7wBmUZCiHmE";

  function readLocalOverride(key) {
    try {
      return String(localStorage.getItem(key) || "").trim();
    } catch (_) {
      return "";
    }
  }

  function applyConfig(url, anonKey) {
    window.SUPABASE_URL = String(url || "").trim();
    window.SUPABASE_ANON_KEY = String(anonKey || "").trim();
    window.__supabaseConfigSource = {
      url: window.SUPABASE_URL,
      hasAnonKey: !!window.SUPABASE_ANON_KEY
    };
  }

  window.setSupabaseConfig = function setSupabaseConfig(url, anonKey, options = {}) {
    const nextUrl = String(url || "").trim();
    const nextAnonKey = String(anonKey || "").trim();
    const persist = options?.persist !== false;

    if (persist) {
      try {
        if (nextUrl) localStorage.setItem("__supabaseUrl", nextUrl);
        else localStorage.removeItem("__supabaseUrl");

        if (nextAnonKey) localStorage.setItem("__supabaseAnonKey", nextAnonKey);
        else localStorage.removeItem("__supabaseAnonKey");
      } catch (_) {}
    }

    applyConfig(nextUrl || DEFAULT_URL, nextAnonKey || DEFAULT_ANON_KEY);
    return window.__supabaseConfigSource;
  };

  window.clearSupabaseConfigOverride = function clearSupabaseConfigOverride() {
    try {
      localStorage.removeItem("__supabaseUrl");
      localStorage.removeItem("__supabaseAnonKey");
    } catch (_) {}
    applyConfig(DEFAULT_URL, DEFAULT_ANON_KEY);
    return window.__supabaseConfigSource;
  };

  const localUrl = readLocalOverride("__supabaseUrl");
  const localAnonKey = readLocalOverride("__supabaseAnonKey");
  applyConfig(localUrl || DEFAULT_URL, localAnonKey || DEFAULT_ANON_KEY);
})();
