// app/app.authUI.js
// Wires the #authPanel UI to window.sb (Supabase wrapper)

(function () {
  function $(id) { return document.getElementById(id); }

  const el = {
    status: $("authStatus"),
    loggedOut: $("authLoggedOut"),
    loggedIn: $("authLoggedIn"),
    emailInput: $("authEmail"),
    btnMagic: $("btnMagicLink"),
    btnSignOut: $("btnSignOut"),
    userEmail: $("authUserEmail"),
    unitRole: $("authUnitRole"),
    msg: $("authMsg"),
  };

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

  async function refreshAuthUI() {
    if (!window.sb?.client) {
      setStatus("Supabase not ready");
      setMsg("Missing Supabase config (URL / anon key) or library not loaded.");
      showLoggedIn(false);
      return;
    }

    const { data, error } = await window.sb.client.auth.getSession();
    if (error) {
      setStatus("Error");
      setMsg(error.message || String(error));
      showLoggedIn(false);
      return;
    }

    const session = data?.session || null;
    if (!session) {
      setStatus("Signed out");
      setMsg("");
      showLoggedIn(false);
      return;
    }

    setStatus("Signed in");
    showLoggedIn(true);

    const email = session.user?.email || "(no email)";
    if (el.userEmail) el.userEmail.textContent = email;

    // Pull role/unit from unit_members (RLS should restrict to user)
    const prof = await window.sb.myUnitProfile();
    if (prof?.error) {
      if (el.unitRole) el.unitRole.textContent = "unit: — | role: —";
      setMsg(`Membership lookup error: ${prof.error.message || prof.error}`);
      return;
    }

    const row = prof?.row;
    const unitName = row?.units?.name || row?.units?.code || "—";
    const role = row?.role || "—";
    if (el.unitRole) el.unitRole.textContent = `unit: ${unitName} | role: ${role}`;
    setMsg("");
  }

  async function sendMagicLink() {
    const email = (el.emailInput?.value || "").trim();
    if (!email) return setMsg("Enter an email first.");

    setMsg("Sending magic link...");
    const { error } = await window.sb.signInWithEmail(email);
    if (error) return setMsg(error.message || String(error));

    setMsg("Magic link sent. Check your email.");
  }

  async function doSignOut() {
    setMsg("Signing out...");
    const { error } = await window.sb.signOut();
    if (error) setMsg(error.message || String(error));
    else setMsg("");
    await refreshAuthUI();
  }

  function wire() {
    if (el.btnMagic) el.btnMagic.addEventListener("click", sendMagicLink);
    if (el.btnSignOut) el.btnSignOut.addEventListener("click", doSignOut);

    // Keep UI in sync on login/logout events
    window.sb?.client?.auth?.onAuthStateChange((_event, _session) => {
      refreshAuthUI();
    });

    refreshAuthUI();
  }

  window.authUI = { refreshAuthUI };
  wire();
})();