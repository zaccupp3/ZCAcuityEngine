// app/app.authGate.js
// ---------------------------------------------------------
// Full-page login gate (static HTML in index.html).
// The ONLY gate. Controls visibility until authed.
// Uses window.sb (Supabase wrapper) as canonical,
// but also tolerates window.supabaseClient alias.
//
// Username-only support:
// - If user types something WITHOUT "@", treat it as a username and map to
//   "<username>@cupp.invalid" before calling Supabase Auth.
// ---------------------------------------------------------

(function () {
  const $ = (id) => document.getElementById(id);

  const gate = $("authGate");
  const msg = $("authGateMsg");
  const emailEl = $("authEmail");
  const pwEl = $("authPassword");
  const rememberEl = $("authRemember");

  const loginBtn = $("authLoginBtn");
  const demoBtn = $("authDemoBtn");
  const forgotBtn = $("authForgot");
  const togglePwBtn = $("authTogglePw");

  function setMsg(text, kind) {
    if (!msg) return;
    msg.textContent = text || "";
    msg.classList.remove("error", "ok");
    if (kind) msg.classList.add(kind);
  }

  function showGate() {
    if (!gate) return;
    gate.classList.add("show");
    document.body.style.overflow = "hidden";
  }

  function hideGate() {
    if (!gate) return;
    gate.classList.remove("show");
    document.body.style.overflow = "";
  }

  function getClient() {
    return window.sb?.client || window.supabaseClient || null;
  }

  function sbReady() {
    const c = getClient();
    return !!(c && c.auth);
  }

  async function waitForSupabase(maxMs = 8000) {
    const start = Date.now();
    while (!sbReady()) {
      if (Date.now() - start > maxMs) return false;
      await new Promise(r => setTimeout(r, 50));
    }
    return true;
  }

  async function getSession() {
    try {
      const c = getClient();
      if (!c?.auth) return null;
      const { data } = await c.auth.getSession();
      return data?.session || null;
    } catch {
      return null;
    }
  }

  // -----------------------------
  // Username -> hidden email mapping
  // -----------------------------
  const USERNAME_EMAIL_DOMAIN = "cupp.invalid";

  function normalizeIdentifier(raw) {
    return String(raw || "").trim();
  }

  function looksLikeEmail(id) {
    const s = String(id || "").trim();
    if (!s.includes("@")) return false;
    const parts = s.split("@");
    if (parts.length !== 2) return false;
    if (!parts[0]) return false;
    if (!parts[1] || !parts[1].includes(".")) return false;
    return true;
  }

  function toUsernameEmail(identifier) {
    const base = String(identifier || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9._-]/g, "");

    if (!base) return "";
    if (base.includes("@")) return base;
    return `${base}@${USERNAME_EMAIL_DOMAIN}`;
  }

  function identifierToEmail(identifierRaw) {
    const id = normalizeIdentifier(identifierRaw);
    if (!id) return "";
    if (looksLikeEmail(id)) return id;
    return toUsernameEmail(id);
  }

  async function onLogin() {
    const identifier = (emailEl?.value || "").trim();
    const password = pwEl?.value || "";

    if (!identifier || !password) {
      setMsg("Enter username/email + password.", "error");
      return;
    }

    const email = identifierToEmail(identifier);
    if (!email) {
      setMsg("Enter a valid username/email.", "error");
      return;
    }

    try {
      localStorage.removeItem("__sessionOnly");
      if (!rememberEl?.checked) localStorage.setItem("__sessionOnly", "1");
      localStorage.removeItem("__demoMode");
    } catch {}

    setMsg("Signing in…");

    const ok = await waitForSupabase(8000);
    if (!ok) {
      setMsg("Supabase not ready yet. Refresh and try again.", "error");
      return;
    }

    try {
      if (typeof window.sb?.signInWithPassword !== "function") {
        setMsg("Auth helper missing (sb.signInWithPassword).", "error");
        return;
      }

      const { error } = await window.sb.signInWithPassword(email, password);
      if (error) {
        setMsg(error.message || "Login failed.", "error");
        return;
      }

      setMsg("Logged in. Loading…", "ok");
      hideGate();

      // Let dropdown refresh itself cleanly
      if (window.authUI && typeof window.authUI.refreshAuthUI === "function") {
        try { await window.authUI.refreshAuthUI(); } catch {}
      }

      // Optional post-auth hook
      if (typeof window.afterAuthRoute === "function") {
        const session = await getSession();
        await window.afterAuthRoute(session);
      }
    } catch (e) {
      console.error(e);
      setMsg("Login error. Check console.", "error");
    }
  }

  async function onForgot() {
    const identifier = (emailEl?.value || "").trim();
    if (!identifier) {
      setMsg("Enter your username/email first.", "error");
      return;
    }

    const email = identifierToEmail(identifier);
    if (!email) {
      setMsg("Enter a valid username/email.", "error");
      return;
    }

    const ok = await waitForSupabase(8000);
    if (!ok) {
      setMsg("Supabase not ready yet. Refresh and try again.", "error");
      return;
    }

    try {
      setMsg("Sending password reset email…");

      const c = getClient();
      const { error } = await c.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin
      });

      if (error) {
        setMsg(error.message || "Could not send reset email.", "error");
        return;
      }

      setMsg("Reset email sent. Check inbox.", "ok");
    } catch (e) {
      console.error(e);
      setMsg("Reset error. Check console.", "error");
    }
  }

  function onDemo() {
    try {
      localStorage.setItem("__demoMode", "1");
      localStorage.removeItem("__sessionOnly");
      window.demoMode = true;
    } catch {}

    hideGate();

    if (window.authUI && typeof window.authUI.refreshAuthUI === "function") {
      try { window.authUI.refreshAuthUI(); } catch {}
    }

    if (typeof window.loadDemoEnvironment === "function") {
      window.loadDemoEnvironment();
    }
  }

  function setupSessionOnlyBehavior() {
    window.addEventListener("beforeunload", async () => {
      try {
        if (localStorage.getItem("__sessionOnly") !== "1") return;
        if (!sbReady()) return;
        if (window.sb?.signOut) await window.sb.signOut();
      } catch {}
    });
  }

  function wireUI() {
    if (loginBtn) loginBtn.addEventListener("click", onLogin);
    if (demoBtn) demoBtn.addEventListener("click", onDemo);
    if (forgotBtn) forgotBtn.addEventListener("click", onForgot);

    if (togglePwBtn && pwEl) {
      togglePwBtn.addEventListener("click", () => {
        pwEl.type = (pwEl.type === "password") ? "text" : "password";
      });
    }

    [emailEl, pwEl].forEach(el => {
      if (!el) return;
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") onLogin();
      });
    });
  }

  async function bootGate() {
    wireUI();
    setupSessionOnlyBehavior();

    // Demo shortcut
    try {
      if (localStorage.getItem("__demoMode") === "1") {
        window.demoMode = true;
        hideGate();
        if (typeof window.loadDemoEnvironment === "function") window.loadDemoEnvironment();
        return;
      }
    } catch {}

    // Wait briefly so we don't flash errors
    await waitForSupabase(8000);

    const session = await getSession();
    if (session) {
      hideGate();
      if (window.authUI && typeof window.authUI.refreshAuthUI === "function") {
        try { await window.authUI.refreshAuthUI(); } catch {}
      }
      if (typeof window.afterAuthRoute === "function") {
        await window.afterAuthRoute(session);
      }
      return;
    }

    showGate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootGate);
  } else {
    bootGate();
  }
})();