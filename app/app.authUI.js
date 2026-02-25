// app/app.authUI.js
// ---------------------------------------------------------
// Auth UI for Supabase (Dropdown only):
// - Top-right dropdown sign in/up, magic link
// - Reset password + Set new password (recovery flow)
// - Signed-in status + memberships + active unit pill
// - Starts cloud sync after auth
//
// NOTE:
// - The ONLY full-screen gate is controlled by app.authGate.js.
// ---------------------------------------------------------

(function () {
  function $(id) { return document.getElementById(id); }

  const el = {
    menuBtn: $("authMenuBtn"),
    dropdown: $("authDropdown"),
    closeBtn: $("authDropdownClose"),

    status: $("authStatus"),
    loggedOut: $("authLoggedOut"),
    loggedIn: $("authLoggedIn"),
    msg: $("authMsg"),

    emailInput: $("authMenuEmail"),
    passwordInput: $("authMenuPassword"),
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

  let sawPasswordRecoveryEvent = false;
  let authListenerAttached = false;

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

  function getClient() {
    return window.sb?.client || window.supabaseClient || null;
  }

  function sbReady() {
    const c = getClient();
    return !!(c && c.auth);
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
      const c = getClient();
      const p = c.auth.getSession();
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

    if (window.activeUnitId && typeof window.setActiveUnit === "function") {
      const match = rows.find(r => String(r.unit_id) === String(window.activeUnitId));
      if (match) await window.setActiveUnit(match.unit_id, match.role || null);
      else await window.setActiveUnit(window.activeUnitId, window.activeUnitRole || null);
    } else {
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
  // Username-only support (maps username -> hidden email)
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

  // Friendly label for shared/demo accounts
  function displayNameForUser(sessionUser) {
    const email = String(sessionUser?.email || "").trim().toLowerCase();
    if (!email) return "";

    // Your specific supervisor shared account
    if (email === "2southsupervisor@cupp.invalid") return "2 South Supervisor";

    // Generic shared accounts in .invalid domain (fallback)
    if (email.endsWith(`@${USERNAME_EMAIL_DOMAIN}`)) {
      const u = email.split("@")[0] || "Shared User";
      // light prettify: 2southsupervisor -> 2southsupervisor (keep safe)
      return u;
    }

    return sessionUser?.email || "";
  }

  // -----------------------------
  // Auth UI refresh (dropdown only)
  // -----------------------------
  async function refreshAuthUI() {
    if (window.demoMode) {
      setStatus("Demo mode");
      setMsg("");
      showLoggedIn(false);
      showRecoveryUI(false);
      return;
    }

    if (!sbReady()) {
      setStatus("Supabase not ready");
      setMsg("");
      showLoggedIn(false);
      showRecoveryUI(false);
      if (el.unitRole) el.unitRole.textContent = "unit: — | role: —";
      return;
    }

    showRecoveryUI(isRecoveryMode());
    if (isRecoveryMode()) openDropdown();

    const { data, error } = await getSessionSafe();

    if (error) {
      setStatus("Auth check delayed");
      setMsg("Auth check is taking longer than expected. Try again or refresh.");
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

      return;
    }

    setStatus("Signed in");
    showLoggedIn(true);

    const label = displayNameForUser(session.user) || "(user)";
    if (el.userEmail) el.userEmail.textContent = label;

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
  // Auth actions (dropdown)
  // -----------------------------
  async function sendMagicLink() {
    if (!sbReady()) return setMsg("Supabase not ready yet. Refresh and try again.");

    const identifier = (el.emailInput?.value || "").trim();
    if (!identifier) return setMsg("Enter a username or email first.");

    const email = identifierToEmail(identifier);
    if (!email) return setMsg("Enter a valid username or email.");

    if (typeof window.sb?.signInWithEmail !== "function") {
      return setMsg("Auth helper missing (sb.signInWithEmail). Update app.supabase.js export.");
    }

    setMsg("Sending magic link...");
    const { error } = await window.sb.signInWithEmail(email);
    if (error) return setMsg(error.message || String(error));

    setMsg("Magic link sent. Check your email.");
  }

  async function signInWithPassword() {
    if (!sbReady()) return setMsg("Supabase not ready yet. Refresh and try again.");

    const identifier = (el.emailInput?.value || "").trim();
    const password = (el.passwordInput?.value || "").trim();
    if (!identifier) return setMsg("Enter a username or email first.");
    if (!password) return setMsg("Enter a password.");

    const email = identifierToEmail(identifier);
    if (!email) return setMsg("Enter a valid username or email.");

    if (typeof window.sb?.signInWithPassword !== "function") {
      return setMsg("Auth helper missing (sb.signInWithPassword). Update app.supabase.js export.");
    }

    setMsg("Signing in...");
    const { error } = await window.sb.signInWithPassword(email, password);
    if (error) return setMsg(error.message || String(error));

    setMsg("");
    await refreshAuthUI();
  }

  async function signUpWithPassword() {
    if (!sbReady()) return setMsg("Supabase not ready yet. Refresh and try again.");

    const identifier = (el.emailInput?.value || "").trim();
    const password = (el.passwordInput?.value || "").trim();
    if (!identifier) return setMsg("Enter a username or email first.");
    if (!password) return setMsg("Enter a password.");

    const email = identifierToEmail(identifier);
    if (!email) return setMsg("Enter a valid username or email.");

    if (typeof window.sb?.signUpWithPassword !== "function") {
      return setMsg("Auth helper missing (sb.signUpWithPassword). Update app.supabase.js export.");
    }

    setMsg("Creating account...");
    const { error } = await window.sb.signUpWithPassword(email, password);
    if (error) return setMsg(error.message || String(error));

    setMsg("Account created. If required, confirm your email, then sign in.");
    await refreshAuthUI();
  }

  async function sendPasswordReset() {
    if (!sbReady()) return setMsg("Supabase not ready yet. Refresh and try again.");

    const identifier = (el.emailInput?.value || "").trim();
    if (!identifier) return setMsg("Enter your username or email first.");

    const email = identifierToEmail(identifier);
    if (!email) return setMsg("Enter a valid username or email.");

    setMsg("Sending password reset email...");
    const c = getClient();
    const { error } = await c.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin
    });
    if (error) return setMsg(error.message || String(error));

    setMsg("Password reset email sent. Open it to set your password.");
  }

  async function setNewPassword() {
    if (!sbReady()) return setMsg("Supabase not ready yet. Refresh and try again.");

    const p1 = (el.newPw1?.value || "").trim();
    const p2 = (el.newPw2?.value || "").trim();

    if (!p1 || p1.length < 8) return setMsg("New password must be at least 8 characters.");
    if (p1 !== p2) return setMsg("Passwords do not match.");

    setMsg("Setting new password...");
    const c = getClient();
    const { error } = await c.auth.updateUser({ password: p1 });
    if (error) return setMsg(error.message || String(error));

    sawPasswordRecoveryEvent = false;
    clearRecoveryHash();
    showRecoveryUI(false);

    if (el.newPw1) el.newPw1.value = "";
    if (el.newPw2) el.newPw2.value = "";

    setMsg("Password set. You can now sign in with username/email + password.");
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

  async function attachAuthListenerWhenReady() {
    if (authListenerAttached) return;

    // Wait up to ~8s for sbReady (in case of load order / slow CDN)
    const start = Date.now();
    while (!sbReady()) {
      if (Date.now() - start > 8000) return;
      await new Promise(r => setTimeout(r, 50));
    }

    const c = getClient();
    if (!c?.auth?.onAuthStateChange) return;

    authListenerAttached = true;

    c.auth.onAuthStateChange(async (event) => {
      if (event === "PASSWORD_RECOVERY") {
        sawPasswordRecoveryEvent = true;
        openDropdown();
        showRecoveryUI(true);
      }
      await refreshAuthUI();
    });
  }

  function wireAuthActions() {
    if (el.btnMagic) el.btnMagic.addEventListener("click", sendMagicLink);
    if (el.btnSignInPw) el.btnSignInPw.addEventListener("click", signInWithPassword);
    if (el.btnSignUpPw) el.btnSignUpPw.addEventListener("click", signUpWithPassword);
    if (el.btnResetPw) el.btnResetPw.addEventListener("click", sendPasswordReset);
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
  }

  function wire() {
    wireDropdown();
    wireAuthActions();

    // Important: attach listener even if sb wasn't ready at first paint
    attachAuthListenerWhenReady();

    refreshAuthUI();
  }

  window.authUI = {
    refreshAuthUI,
    refreshAuthPill
  };

  wire();
})();