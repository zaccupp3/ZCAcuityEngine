// app/app.authGate.js
// ---------------------------------------------------------
// Full-page login gate (Email+Password) + Demo Environment.
// Shows before app usage, then hides once user is authed.
// Requires:
// - window.supabase (from app.supabase.js)
// - your normal init/render still runs; this just gates visibility
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
  }

  function hideGate() {
    if (!gate) return;
    gate.classList.remove("show");
  }

  function setAppVisible(isVisible) {
    // If you want to hide EVERYTHING behind it, you can optionally dim the body.
    // Keeping simple: gate is an overlay.
    document.body.style.overflow = isVisible ? "" : "hidden";
  }

  async function getSession() {
    try {
      const sb = window.supabase;
      if (!sb?.auth?.getSession) return null;
      const { data } = await sb.auth.getSession();
      return data?.session || null;
    } catch {
      return null;
    }
  }

  async function onLogin() {
    const email = (emailEl?.value || "").trim();
    const password = pwEl?.value || "";

    if (!email || !password) {
      setMsg("Enter email + password.", "error");
      return;
    }

    // “Remember me”:
    // Supabase JS will persist by default; we can force session-only by clearing on unload,
    // but simplest approach: if unchecked, we sign out on tab close.
    // We'll implement a session-only marker.
    try {
      localStorage.removeItem("__sessionOnly");
      if (!rememberEl?.checked) localStorage.setItem("__sessionOnly", "1");
    } catch {}

    setMsg("Signing in…");

    try {
      const sb = window.supabase;
      if (!sb?.auth?.signInWithPassword) {
        setMsg("Supabase auth not ready.", "error");
        return;
      }

      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        setMsg(error.message || "Login failed.", "error");
        return;
      }

      // Success
      setMsg("Logged in. Loading your unit…", "ok");

      hideGate();
      setAppVisible(true);

      // If you have a unit bootstrap function, call it here.
      // (You mentioned unit membership + RLS are already working.)
      if (typeof window.afterAuthRoute === "function") {
        await window.afterAuthRoute(data?.session);
      }
    } catch (e) {
      setMsg("Login error. Check console.", "error");
      console.error(e);
    }
  }

  async function onForgot() {
    const email = (emailEl?.value || "").trim();
    if (!email) {
      setMsg("Enter your email first.", "error");
      return;
    }
    try {
      const sb = window.supabase;
      if (!sb?.auth?.resetPasswordForEmail) {
        setMsg("Reset not available yet.", "error");
        return;
      }

      // IMPORTANT: set this to your deployed URL (Vercel) + hash route if you use it.
      // This should point to a page that handles the recovery flow.
      const redirectTo = window.location.origin + window.location.pathname + "#reset";

      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
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
    // Mark demo mode and route into app without auth.
    try {
      localStorage.setItem("__demoMode", "1");
    } catch {}

    hideGate();
    setAppVisible(true);

    // Optional: load demo unit / demo dataset
    if (typeof window.loadDemoEnvironment === "function") {
      window.loadDemoEnvironment();
    }
  }

  function setupSessionOnlyBehavior() {
    // If Remember Me unchecked, sign out when tab/window closes.
    window.addEventListener("beforeunload", async () => {
      try {
        if (localStorage.getItem("__sessionOnly") !== "1") return;
        const sb = window.supabase;
        if (sb?.auth?.signOut) await sb.auth.signOut();
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

    // Enter submits
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

    // Demo mode shortcut
    try {
      if (localStorage.getItem("__demoMode") === "1") {
        hideGate();
        setAppVisible(true);
        if (typeof window.loadDemoEnvironment === "function") window.loadDemoEnvironment();
        return;
      }
    } catch {}

    // If already authed, skip gate
    const session = await getSession();
    if (session) {
      hideGate();
      setAppVisible(true);
      if (typeof window.afterAuthRoute === "function") {
        await window.afterAuthRoute(session);
      }
      return;
    }

    // Otherwise show login gate
    setAppVisible(false);
    showGate();
  }

  // Boot after DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootGate);
  } else {
    bootGate();
  }
})();