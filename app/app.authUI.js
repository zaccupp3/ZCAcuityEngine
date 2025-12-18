// app/app.authUI.js
// ---------------------------------------------------------
// Auth UI for Supabase:
// - Top-right dropdown (your current UI)
// - Center-screen "Auth Gate" login card when signed out
// - Magic link + Email/Password sign in/up
// - Reset password email + Set new password (recovery flow)
// - Demo Environment button
// - Refresh memberships + active unit + role pill
// - Starts cloud sync after auth
//
// Notes:
// - Center login is generated dynamically (no HTML edits required).
// - Gate auto-hides when signed in.
// ---------------------------------------------------------

(function () {
  function $(id) { return document.getElementById(id); }

  // -----------------------------
  // Dropdown elements (existing)
  // -----------------------------
  const el = {
    menuBtn: $("authMenuBtn"),
    dropdown: $("authDropdown"),
    closeBtn: $("authDropdownClose"),

    status: $("authStatus"),
    loggedOut: $("authLoggedOut"),
    loggedIn: $("authLoggedIn"),
    msg: $("authMsg"),

    emailInput: $("authEmail"),
    passwordInput: $("authPassword"),
    btnMagic: $("btnMagicLink"),
    btnSignInPw: $("btnSignInPassword"),
    btnSignUpPw: $("btnSignUpPassword"),
    btnResetPw: $("btnResetPassword"),

    recoveryBlock: $("authRecovery"),
    newPw1: $("authNewPassword"),
    newPw2: $("authNewPassword2"),
    btnSetPw: $("btnSetNewPassword"),

    btnSignOut: $("btnSignOut"),
    userEmail: $("authUserEmail"),
    unitRole: $("authUnitRole"),
  };

  // remembers if Supabase explicitly told us we're in recovery
  let sawPasswordRecoveryEvent = false;

  // -----------------------------
  // Auth Gate (center card) - NEW
  // -----------------------------
  let gate = null;

  function ensureAuthGate() {
    if (gate) return gate;

    gate = document.createElement("div");
    gate.id = "authGate";
    gate.innerHTML = `
      <div class="auth-gate-backdrop"></div>
      <div class="auth-gate-card" role="dialog" aria-modal="true" aria-label="Sign in">
        <div class="auth-gate-header">
          <div class="auth-gate-title">Welcome Back!</div>
          <div class="auth-gate-sub">Sign in to your account</div>
        </div>

        <div class="auth-gate-body">
          <label class="auth-gate-label">Your Email</label>
          <input id="authGateEmail" class="auth-gate-input" type="email" autocomplete="email" placeholder="you@domain.com" />

          <label class="auth-gate-label" style="margin-top:10px;">Password</label>
          <div class="auth-gate-password">
            <input id="authGatePassword" class="auth-gate-input" type="password" autocomplete="current-password" placeholder="••••••••" />
            <button id="authGateTogglePw" type="button" class="auth-gate-eye" title="Show/Hide password">👁</button>
          </div>

          <div class="auth-gate-row">
            <label class="auth-gate-remember">
              <input id="authGateRemember" type="checkbox" />
              <span>Remember Me</span>
            </label>
            <button id="authGateForgot" type="button" class="auth-gate-link">Forgot Password?</button>
          </div>

          <button id="authGateLogin" type="button" class="auth-gate-primary">Login</button>

          <div class="auth-gate-divider"><span>or</span></div>

          <button id="authGateDemo" type="button" class="auth-gate-secondary">Demo Environment</button>

          <div id="authGateMsg" class="auth-gate-msg"></div>
        </div>
      </div>
    `;

    // Minimal embedded CSS so you don’t have to touch style.css (you can move it later)
    const style = document.createElement("style");
    style.textContent = `
      #authGate { position: fixed; inset: 0; z-index: 9999; display: none; }
      #authGate.show { display: block; }
      .auth-gate-backdrop {
        position:absolute; inset:0;
        background: radial-gradient(1200px 800px at 15% 20%, rgba(142,200,246,0.35), transparent 55%),
                    radial-gradient(900px 600px at 80% 25%, rgba(167,139,250,0.28), transparent 55%),
                    linear-gradient(180deg, rgba(248,250,252,0.95), rgba(241,245,249,0.95));
        backdrop-filter: blur(6px);
      }
      .auth-gate-card{
        position:relative;
        width: min(420px, calc(100% - 32px));
        margin: 8vh auto 0;
        background: rgba(255,255,255,0.92);
        border: 1px solid rgba(15,23,42,0.10);
        border-radius: 18px;
        box-shadow: 0 20px 60px rgba(2,6,23,0.18);
        overflow:hidden;
      }
      .auth-gate-header{
        padding: 18px 18px 10px;
        display:flex; flex-direction:column; gap:4px;
      }
      .auth-gate-title{ font-size: 22px; font-weight: 800; color: #0f172a; }
      .auth-gate-sub{ font-size: 13px; color: rgba(15,23,42,0.65); }
      .auth-gate-body{ padding: 0 18px 18px; }
      .auth-gate-label{ font-size: 12px; font-weight: 700; color:#0f172a; display:block; margin-top: 10px; }
      .auth-gate-input{
        width:100%;
        margin-top:6px;
        border-radius: 12px;
        border: 1px solid rgba(15,23,42,0.15);
        padding: 10px 12px;
        outline:none;
        background: rgba(248,250,252,0.9);
      }
      .auth-gate-input:focus{
        border-color: rgba(142,200,246,0.95);
        box-shadow: 0 0 0 4px rgba(142,200,246,0.25);
        background:#fff;
      }
      .auth-gate-password{ position:relative; }
      .auth-gate-eye{
        position:absolute; right:8px; top:50%; transform:translateY(-50%);
        border:none; background:transparent; cursor:pointer; opacity:0.7;
      }
      .auth-gate-row{
        margin-top: 10px;
        display:flex; align-items:center; justify-content:space-between;
        gap: 10px;
      }
      .auth-gate-remember{ display:flex; align-items:center; gap:8px; font-size: 12px; color:#0f172a; opacity:0.85; }
      .auth-gate-link{
        border:none; background:transparent; cursor:pointer;
        font-size: 12px; font-weight: 800; color: rgba(37,99,235,0.95);
      }
      .auth-gate-primary{
        width:100%;
        margin-top: 12px;
        border:none; cursor:pointer;
        border-radius: 14px;
        padding: 12px 14px;
        font-weight: 900;
        color: white;
        background: linear-gradient(180deg, #111827, #0b1220);
        box-shadow: 0 10px 24px rgba(2,6,23,0.24);
      }
      .auth-gate-secondary{
        width:100%;
        border: 1px solid rgba(15,23,42,0.12);
        cursor:pointer;
        border-radius: 14px;
        padding: 11px 14px;
        font-weight: 900;
        color:#0f172a;
        background: rgba(255,255,255,0.85);
      }
      .auth-gate-divider{
        margin: 14px 0;
        display:flex; align-items:center; gap: 10px;
        color: rgba(15,23,42,0.45);
        font-size: 12px;
      }
      .auth-gate-divider:before, .auth-gate-divider:after{
        content:""; flex:1; height:1px; background: rgba(15,23,42,0.12);
      }
      .auth-gate-divider span{ padding: 0 6px; }
      .auth-gate-msg{
        margin-top: 10px;
        font-size: 12px;
        color: rgba(220,38,38,0.95);
        min-height: 16px;
      }
    `;
    document.head.appendChild(style);

    document.body.appendChild(gate);

    // wire gate actions
    const gateEmail = $("authGateEmail");
    const gatePw = $("authGatePassword");
    const gateToggle = $("authGateTogglePw");
    const gateMsg = $("authGateMsg");

    function setGateMsg(t) {
      if (gateMsg) gateMsg.textContent = t || "";
    }

    if (gateToggle && gatePw) {
      gateToggle.addEventListener("click", () => {
        gatePw.type = gatePw.type === "password" ? "text" : "password";
      });
    }

    const btnLogin = $("authGateLogin");
    if (btnLogin) btnLogin.addEventListener("click", async () => {
      setGateMsg("");
      // copy into dropdown inputs so we reuse the same functions/logic
      if (el.emailInput && gateEmail) el.emailInput.value = gateEmail.value;
      if (el.passwordInput && gatePw) el.passwordInput.value = gatePw.value;
      await signInWithPassword(setGateMsg);
    });

    if (gatePw) {
      gatePw.addEventListener("keydown", async (e) => {
        if (e.key === "Enter") {
          setGateMsg("");
          if (el.emailInput && gateEmail) el.emailInput.value = gateEmail.value;
          if (el.passwordInput && gatePw) el.passwordInput.value = gatePw.value;
          await signInWithPassword(setGateMsg);
        }
      });
    }

    const btnForgot = $("authGateForgot");
    if (btnForgot) btnForgot.addEventListener("click", async () => {
      setGateMsg("");
      if (el.emailInput && gateEmail) el.emailInput.value = gateEmail.value;
      await sendPasswordReset(setGateMsg);
    });

    const btnDemo = $("authGateDemo");
    if (btnDemo) btnDemo.addEventListener("click", async () => {
      // Demo mode = no auth, but allow app usage (you can restrict later)
      // We set a flag and hide the gate.
      try {
        window.demoMode = true;
        setGateMsg("");
        hideAuthGate();
        if (typeof window.onAuthRoleChanged === "function") window.onAuthRoleChanged();
      } catch (e) {
        setGateMsg("Demo mode failed to start. Check console.");
        console.warn("demo mode error", e);
      }
    });

    return gate;
  }

  function showAuthGate() {
    ensureAuthGate();
    if (gate) gate.classList.add("show");
  }

  function hideAuthGate() {
    if (gate) gate.classList.remove("show");
  }

  // -----------------------------
  // Helpers
  // -----------------------------
  function setMsg(text) {
    if (!el.msg) return;
    el.msg.textContent = text || "";
  }

  function setStatus(text) {
    if (el.status) el.status.textContent = `Auth: ${text}`;
  }

  function showLoggedIn(isIn) {
    if (el.loggedIn) el.loggedIn.style.display = isIn ? "flex" : "none";
    if (el.loggedOut) el.loggedOut.style.display = isIn ? "none" : "flex";
  }

  function sbReady() {
    return !!(window.sb && window.sb.client && window.sb.client.auth);
  }

  function openDropdown() {
    if (!el.dropdown) return;
    el.dropdown.classList.add("open");
    if (el.menuBtn) el.menuBtn.setAttribute("aria-expanded", "true");
  }

  function closeDropdown() {
    if (!el.dropdown) return;
    el.dropdown.classList.remove("open");
    if (el.menuBtn) el.menuBtn.setAttribute("aria-expanded", "false");
  }

  function toggleDropdown() {
    if (!el.dropdown) return;
    const isOpen = el.dropdown.classList.contains("open");
    if (isOpen) closeDropdown();
    else openDropdown();
  }

  function showRecoveryUI(show) {
    if (!el.recoveryBlock) return;
    el.recoveryBlock.style.display = show ? "flex" : "none";
  }

  function clearRecoveryHash() {
    try {
      if (window.location.hash) {
        history.replaceState(null, document.title, window.location.pathname + window.location.search);
      }
    } catch {}
  }

  function urlIndicatesRecovery() {
    const h = window.location.hash || "";
    const q = window.location.search || "";
    return (
      h.includes("type=recovery") ||
      h.includes("recovery") ||
      q.includes("type=recovery") ||
      q.includes("recovery")
    );
  }

  function isRecoveryMode() {
    return sawPasswordRecoveryEvent || urlIndicatesRecovery();
  }

  async function getSessionSafe() {
    try {
      const p = window.sb.client.auth.getSession();
      const t = new Promise((_, rej) => setTimeout(() => rej(new Error("getSession timed out")), 10000));
      return await Promise.race([p, t]);
    } catch (e) {
      return { data: { session: null }, error: e };
    }
  }

  function unitLabelFromMembership(m) {
    const u = m?.unit || m?.units || null;
    const name = u?.name || "";
    const code = u?.code || "";
    if (name && code) return `${name} (${code})`;
    return name || code || (m?.unit_id || "—");
  }

  function refreshAuthPill() {
    const rows = Array.isArray(window.availableUnits) ? window.availableUnits : [];
    const activeId = window.activeUnitId;

    let unitLabel = "—";
    let role = window.activeUnitRole || "—";

    if (activeId) {
      const match = rows.find(r => String(r.unit_id) === String(activeId));
      if (match) {
        unitLabel = unitLabelFromMembership(match);
        role = match.role || role;
      } else {
        unitLabel = String(activeId);
      }
    }

    if (el.unitRole) el.unitRole.textContent = `unit: ${unitLabel} | role: ${role}`;

    if (typeof window.onAuthRoleChanged === "function") {
      try { window.onAuthRoleChanged(); } catch (e) { console.warn("onAuthRoleChanged error", e); }
    }
  }

  async function refreshMembershipsAndUnit() {
    if (!sbReady()) return { ok: false, error: new Error("Supabase not ready") };
    if (typeof window.refreshMyUnits !== "function") {
      return { ok: false, error: new Error("refreshMyUnits missing (app.state.js not loaded?)") };
    }

    const res = await window.refreshMyUnits();
    if (!res?.ok) return res;

    const rows = Array.isArray(window.availableUnits) ? window.availableUnits : [];

    // If we already have an activeUnitId, re-assert it (keeps pill consistent)
    if (window.activeUnitId && typeof window.setActiveUnit === "function") {
      const match = rows.find(r => String(r.unit_id) === String(window.activeUnitId));
      if (match) await window.setActiveUnit(match.unit_id, match.role || null);
      else await window.setActiveUnit(window.activeUnitId, window.activeUnitRole || null);
    } else {
      // If no active unit yet, pick the newest membership (simple default)
      const first = rows[0];
      if (first && typeof window.setActiveUnit === "function") {
        await window.setActiveUnit(first.unit_id, first.role || null);
      }
    }

    if (typeof window.onMembershipsUpdated === "function") {
      try { window.onMembershipsUpdated(); } catch (e) { console.warn("onMembershipsUpdated error", e); }
    }

    refreshAuthPill();
    return { ok: true };
  }

  async function syncCloudForActiveUnit() {
    if (!window.activeUnitId) return;
    if (!window.cloudSync) return;

    // NOTE: If sb.getUnitState returns null, that just means "no snapshot yet".
    // It’s not an error. You’ll seed on first publish.

    if (typeof window.cloudSync.loadUnitStateFromCloud === "function") {
      try {
        const res = await window.cloudSync.loadUnitStateFromCloud(window.activeUnitId);
        if (res?.ok && res?.empty && typeof window.cloudSync.publishUnitStateDebounced === "function") {
          window.cloudSync.publishUnitStateDebounced("seed-if-empty");
        }
      } catch (e) {
        console.warn("[auth] cloud load failed", e);
      }
    }

    if (typeof window.cloudSync.subscribeUnitState === "function") {
      try {
        await window.cloudSync.subscribeUnitState(window.activeUnitId);
      } catch (e) {
        console.warn("[auth] cloud subscribe failed", e);
      }
    }

    try { if (typeof window.renderPatientList === "function") window.renderPatientList(); } catch {}
    try { if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles(); } catch {}
    try { if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments(); } catch {}
    try { if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput(); } catch {}
    try { if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput(); } catch {}
    try { if (typeof window.renderQueueList === "function") window.renderQueueList(); } catch {}
    try { if (typeof window.updateDischargeCount === "function") window.updateDischargeCount(); } catch {}
  }

  // -----------------------------
  // Auth UI refresh (controls gate + dropdown)
  // -----------------------------
  async function refreshAuthUI() {
    // Demo mode: user chose demo environment → don’t force login gate
    if (window.demoMode) {
      setStatus("Demo mode");
      setMsg("");
      showLoggedIn(false);
      showRecoveryUI(false);
      hideAuthGate();
      return;
    }

    if (!sbReady()) {
      setStatus("Supabase not ready");
      setMsg("Missing Supabase config (URL / anon key) or library not loaded.");
      showLoggedIn(false);
      showRecoveryUI(false);
      if (el.unitRole) el.unitRole.textContent = "unit: — | role: —";

      // If Supabase isn't ready, show the center login card (with message)
      showAuthGate();
      const gateMsg = $("authGateMsg");
      if (gateMsg) gateMsg.textContent = "Supabase auth not ready.";
      return;
    }

    // Show recovery UI if URL or auth event indicates recovery
    showRecoveryUI(isRecoveryMode());
    if (isRecoveryMode()) openDropdown();

    const { data, error } = await getSessionSafe();

    if (error) {
      setStatus("Auth check delayed");
      setMsg("Auth check is taking longer than expected. Try again or refresh.");
      // still show gate because we don't have a confirmed session
      showAuthGate();
      return;
    }

    const session = data?.session || null;

    if (!session) {
      setStatus("Signed out");
      setMsg("");
      showLoggedIn(false);
      if (el.userEmail) el.userEmail.textContent = "";
      if (el.unitRole) el.unitRole.textContent = "unit: — | role: —";

      if (window.cloudSync && typeof window.cloudSync.unsubscribeUnitState === "function") {
        try { window.cloudSync.unsubscribeUnitState(); } catch {}
      }

      if (typeof window.onAuthRoleChanged === "function") {
        try { window.onAuthRoleChanged(); } catch (_) {}
      }

      // ✅ MAIN FIX: show center-screen login UI when signed out
      showAuthGate();
      return;
    }

    // Signed in
    setStatus("Signed in");
    showLoggedIn(true);
    hideAuthGate(); // ✅ MAIN FIX: remove gate when authed

    const email = session.user?.email || "(no email)";
    if (el.userEmail) el.userEmail.textContent = email;

    // memberships + active unit
    try {
      const r = await refreshMembershipsAndUnit();
      if (!r?.ok) console.warn("[auth] refreshMembershipsAndUnit not ok", r?.error);
    } catch (e) {
      console.warn("[auth] refreshMembershipsAndUnit failed", e);
    }

    refreshAuthPill();
    await syncCloudForActiveUnit();

    if (!isRecoveryMode()) setMsg("");
  }

  // -----------------------------
  // Auth actions (shared by dropdown + gate)
  // -----------------------------
  async function sendMagicLink(setAltMsg) {
    if (!sbReady()) {
      (setAltMsg || setMsg)("Supabase not ready yet. Refresh and try again.");
      return;
    }

    const email = (el.emailInput?.value || "").trim();
    if (!email) return (setAltMsg || setMsg)("Enter an email first.");

    if (typeof window.sb?.signInWithEmail !== "function") {
      return (setAltMsg || setMsg)("Auth helper missing (sb.signInWithEmail). Update app.supabase.js export.");
    }

    (setAltMsg || setMsg)("Sending magic link...");
    const { error } = await window.sb.signInWithEmail(email);
    if (error) return (setAltMsg || setMsg)(error.message || String(error));

    (setAltMsg || setMsg)("Magic link sent. Check your email.");
  }

  async function signInWithPassword(setAltMsg) {
    if (!sbReady()) {
      (setAltMsg || setMsg)("Supabase not ready yet. Refresh and try again.");
      return;
    }

    const email = (el.emailInput?.value || "").trim();
    const password = (el.passwordInput?.value || "").trim();
    if (!email) return (setAltMsg || setMsg)("Enter an email first.");
    if (!password) return (setAltMsg || setMsg)("Enter a password.");

    if (typeof window.sb?.signInWithPassword !== "function") {
      return (setAltMsg || setMsg)("Auth helper missing (sb.signInWithPassword). Update app.supabase.js export.");
    }

    (setAltMsg || setMsg)("Signing in...");
    const { error } = await window.sb.signInWithPassword(email, password);
    if (error) return (setAltMsg || setMsg)(error.message || String(error));

    (setAltMsg || setMsg)("");
    await refreshAuthUI();
  }

  async function signUpWithPassword() {
    if (!sbReady()) return setMsg("Supabase not ready yet. Refresh and try again.");

    const email = (el.emailInput?.value || "").trim();
    const password = (el.passwordInput?.value || "").trim();
    if (!email) return setMsg("Enter an email first.");
    if (!password) return setMsg("Enter a password.");

    if (typeof window.sb?.signUpWithPassword !== "function") {
      return setMsg("Auth helper missing (sb.signUpWithPassword). Update app.supabase.js export.");
    }

    setMsg("Creating account...");
    const { error } = await window.sb.signUpWithPassword(email, password);
    if (error) return setMsg(error.message || String(error));

    setMsg("Account created. If required, confirm your email, then sign in.");
    await refreshAuthUI();
  }

  async function sendPasswordReset(setAltMsg) {
    if (!sbReady()) {
      (setAltMsg || setMsg)("Supabase not ready yet. Refresh and try again.");
      return;
    }

    const email = (el.emailInput?.value || "").trim();
    if (!email) return (setAltMsg || setMsg)("Enter your email first.");

    (setAltMsg || setMsg)("Sending password reset email...");
    const { error } = await window.sb.client.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin
    });
    if (error) return (setAltMsg || setMsg)(error.message || String(error));

    (setAltMsg || setMsg)("Password reset email sent. Open it to set your password.");
  }

  async function setNewPassword() {
    if (!sbReady()) return setMsg("Supabase not ready yet. Refresh and try again.");

    const p1 = (el.newPw1?.value || "").trim();
    const p2 = (el.newPw2?.value || "").trim();

    if (!p1 || p1.length < 8) return setMsg("New password must be at least 8 characters.");
    if (p1 !== p2) return setMsg("Passwords do not match.");

    setMsg("Setting new password...");
    const { error } = await window.sb.client.auth.updateUser({ password: p1 });
    if (error) return setMsg(error.message || String(error));

    sawPasswordRecoveryEvent = false;
    clearRecoveryHash();
    showRecoveryUI(false);

    if (el.newPw1) el.newPw1.value = "";
    if (el.newPw2) el.newPw2.value = "";

    setMsg("Password set. You can now sign in with email + password.");
    await refreshAuthUI();
  }

  async function doSignOut() {
    if (!sbReady()) return;

    if (typeof window.sb?.signOut !== "function") {
      return setMsg("Auth helper missing (sb.signOut). Update app.supabase.js export.");
    }

    setMsg("Signing out...");
    const { error } = await window.sb.signOut();
    if (error) setMsg(error.message || String(error));
    else setMsg("");

    if (window.cloudSync && typeof window.cloudSync.unsubscribeUnitState === "function") {
      try { window.cloudSync.unsubscribeUnitState(); } catch {}
    }

    sawPasswordRecoveryEvent = false;
    showRecoveryUI(false);

    if (el.userEmail) el.userEmail.textContent = "";
    if (el.unitRole) el.unitRole.textContent = "unit: — | role: —";
    showLoggedIn(false);

    if (typeof window.onAuthRoleChanged === "function") {
      try { window.onAuthRoleChanged(); } catch (_) {}
    }

    // show gate again after sign out
    window.demoMode = false;
    await refreshAuthUI();
  }

  // -----------------------------
  // Wiring
  // -----------------------------
  function wireDropdown() {
    if (el.menuBtn) el.menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDropdown();
    });

    if (el.closeBtn) el.closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeDropdown();
    });

    document.addEventListener("click", (e) => {
      if (!el.dropdown) return;
      if (!el.dropdown.classList.contains("open")) return;

      const clickedInside =
        el.dropdown.contains(e.target) || (el.menuBtn && el.menuBtn.contains(e.target));

      if (!clickedInside) closeDropdown();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDropdown();
    });
  }

  function wireAuthActions() {
    if (el.btnMagic) el.btnMagic.addEventListener("click", () => sendMagicLink());
    if (el.btnSignInPw) el.btnSignInPw.addEventListener("click", () => signInWithPassword());
    if (el.btnSignUpPw) el.btnSignUpPw.addEventListener("click", signUpWithPassword);
    if (el.btnResetPw) el.btnResetPw.addEventListener("click", () => sendPasswordReset());
    if (el.btnSetPw) el.btnSetPw.addEventListener("click", setNewPassword);
    if (el.btnSignOut) el.btnSignOut.addEventListener("click", doSignOut);

    if (el.passwordInput) {
      el.passwordInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") signInWithPassword();
      });
    }
    if (el.newPw2) {
      el.newPw2.addEventListener("keydown", (e) => {
        if (e.key === "Enter") setNewPassword();
      });
    }

    if (urlIndicatesRecovery()) {
      openDropdown();
      showRecoveryUI(true);
    }

    if (sbReady() && typeof window.sb.client.auth.onAuthStateChange === "function") {
      window.sb.client.auth.onAuthStateChange(async (event) => {
        if (event === "PASSWORD_RECOVERY") {
          sawPasswordRecoveryEvent = true;
          openDropdown();
          showRecoveryUI(true);
        }
        await refreshAuthUI();
      });
    }
  }

  function wire() {
    wireDropdown();
    wireAuthActions();
    refreshAuthUI();
  }

  window.authUI = {
    refreshAuthUI,
    refreshAuthPill
  };

  wire();
})();