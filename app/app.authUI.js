// app/app.authUI.js
// Auth dropdown UI for Supabase:
// - Magic link + Email/Password sign in/up
// - Reset password email + Set new password (recovery flow)
// - Refresh memberships + active unit + role pill
// - Starts cloud sync after auth
//
// Fixes included:
// ✅ Recovery panel triggers from URL OR PASSWORD_RECOVERY event
// ✅ Longer session timeout to avoid “fake sign-out” when UI is busy

(function () {
  function $(id) { return document.getElementById(id); }

  const el = {
    // dropdown shell
    menuBtn: $("authMenuBtn"),
    dropdown: $("authDropdown"),
    closeBtn: $("authDropdownClose"),

    // auth blocks
    status: $("authStatus"),
    loggedOut: $("authLoggedOut"),
    loggedIn: $("authLoggedIn"),
    msg: $("authMsg"),

    // signed out inputs/buttons
    emailInput: $("authEmail"),
    passwordInput: $("authPassword"),
    btnMagic: $("btnMagicLink"),
    btnSignInPw: $("btnSignInPassword"),
    btnSignUpPw: $("btnSignUpPassword"),
    btnResetPw: $("btnResetPassword"),

    // recovery UI
    recoveryBlock: $("authRecovery"),
    newPw1: $("authNewPassword"),
    newPw2: $("authNewPassword2"),
    btnSetPw: $("btnSetNewPassword"),

    // signed in
    btnSignOut: $("btnSignOut"),
    userEmail: $("authUserEmail"),
    unitRole: $("authUnitRole"),
  };

  // remembers if Supabase explicitly told us we're in recovery
  let sawPasswordRecoveryEvent = false;

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
    // remove tokens/hash from URL after password is set
    try {
      if (window.location.hash) {
        history.replaceState(null, document.title, window.location.pathname + window.location.search);
      }
    } catch {}
  }

  function urlIndicatesRecovery() {
    // Supabase usually returns recovery links in hash
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
      // ✅ longer timeout so we don’t “fake sign out” during UI work
      const t = new Promise((_, rej) => setTimeout(() => rej(new Error("getSession timed out")), 10000));
      return await Promise.race([p, t]);
    } catch (e) {
      return { data: { session: null }, error: e };
    }
  }

  async function getUnitProfileFallback() {
    if (typeof window.sb?.myUnitProfile === "function") {
      return await window.sb.myUnitProfile();
    }

    const { data, error } = await window.sb.client
      .from("unit_members")
      .select("unit_id, role, units:unit_id ( id, name, code )")
      .order("created_at", { ascending: false })
      .limit(1);

    return { row: (data && data[0]) ? data[0] : null, error };
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

    if (window.activeUnitId) {
      const match = rows.find(r => String(r.unit_id) === String(window.activeUnitId));
      if (match && typeof window.setActiveUnit === "function") {
        await window.setActiveUnit(match.unit_id, match.role || null);
      } else if (typeof window.setActiveUnit === "function") {
        await window.setActiveUnit(window.activeUnitId, window.activeUnitRole || null);
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

  async function refreshAuthUI() {
    if (!sbReady()) {
      setStatus("Supabase not ready");
      setMsg("Missing Supabase config (URL / anon key) or library not loaded.");
      showLoggedIn(false);
      showRecoveryUI(false);
      if (el.unitRole) el.unitRole.textContent = "unit: — | role: —";
      return;
    }

    // Show recovery UI if URL or auth event indicates recovery
    showRecoveryUI(isRecoveryMode());
    if (isRecoveryMode()) openDropdown();

    const { data, error } = await getSessionSafe();

    if (error) {
      // ✅ Don’t force a “Signed out” UI just because session fetch timed out
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

    const email = session.user?.email || "(no email)";
    if (el.userEmail) el.userEmail.textContent = email;

    // memberships + active unit
    try {
      const r = await refreshMembershipsAndUnit();
      if (!r?.ok) console.warn("[auth] refreshMembershipsAndUnit not ok", r?.error);
    } catch (e) {
      console.warn("[auth] refreshMembershipsAndUnit failed", e);
    }

    if (!Array.isArray(window.availableUnits) || !window.availableUnits.length) {
      const prof = await getUnitProfileFallback();
      if (prof?.error) {
        if (el.unitRole) el.unitRole.textContent = "unit: — | role: —";
        setMsg(`Membership lookup error: ${prof.error.message || String(prof.error)}`);
        return;
      }
      const row = prof?.row;
      const unitName = row?.units?.name || row?.units?.code || "—";
      const role = row?.role || "—";
      if (el.unitRole) el.unitRole.textContent = `unit: ${unitName} | role: ${role}`;
    } else {
      refreshAuthPill();
    }

    await syncCloudForActiveUnit();
    if (!isRecoveryMode()) setMsg("");
  }

  // ---- Auth actions ----

  async function sendMagicLink() {
    if (!sbReady()) return setMsg("Supabase not ready yet. Refresh and try again.");

    const email = (el.emailInput?.value || "").trim();
    if (!email) return setMsg("Enter an email first.");

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

    const email = (el.emailInput?.value || "").trim();
    const password = (el.passwordInput?.value || "").trim();
    if (!email) return setMsg("Enter an email first.");
    if (!password) return setMsg("Enter a password.");

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

  async function sendPasswordReset() {
    if (!sbReady()) return setMsg("Supabase not ready yet. Refresh and try again.");

    const email = (el.emailInput?.value || "").trim();
    if (!email) return setMsg("Enter your email first.");

    setMsg("Sending password reset email...");
    const { error } = await window.sb.client.auth.resetPasswordForEmail(email, {
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
    const { error } = await window.sb.client.auth.updateUser({ password: p1 });
    if (error) return setMsg(error.message || String(error));

    // success
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

    await refreshAuthUI();
  }

  // ---- Wiring ----

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

    // If URL already indicates recovery, open the dropdown and show it
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