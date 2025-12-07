// app/app.authUI.js
// Wires the auth dropdown UI to window.sb (Supabase wrapper)

(function () {
  function $(id) { return document.getElementById(id); }

  const el = {
    // dropdown shell
    menuBtn: $("authMenuBtn"),
    dropdown: $("authDropdown"),
    closeBtn: $("authDropdownClose"),

    // existing auth ids (unchanged)
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

  async function getSessionSafe() {
    try {
      return await window.sb.client.auth.getSession();
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

  async function refreshAuthUI() {
    if (!sbReady()) {
      setStatus("Supabase not ready");
      setMsg("Missing Supabase config (URL / anon key) or library not loaded.");
      showLoggedIn(false);
      if (el.unitRole) el.unitRole.textContent = "unit: — | role: —";
      return;
    }

    const { data, error } = await getSessionSafe();
    if (error) {
      setStatus("Error");
      setMsg(error.message || String(error));
      showLoggedIn(false);
      if (el.unitRole) el.unitRole.textContent = "unit: — | role: —";
      return;
    }

    const session = data?.session || null;
    if (!session) {
      setStatus("Signed out");
      setMsg("");
      showLoggedIn(false);
      if (el.userEmail) el.userEmail.textContent = "";
      if (el.unitRole) el.unitRole.textContent = "unit: — | role: —";
      return;
    }

    setStatus("Signed in");
    showLoggedIn(true);

    const email = session.user?.email || "(no email)";
    if (el.userEmail) el.userEmail.textContent = email;

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
    setMsg("");
  }

  async function sendMagicLink() {
    if (!sbReady()) {
      setMsg("Supabase not ready yet. Refresh and try again.");
      return;
    }

    const email = (el.emailInput?.value || "").trim();
    if (!email) return setMsg("Enter an email first.");

    if (typeof window.sb?.signInWithEmail !== "function") {
      setMsg("Auth helper missing (sb.signInWithEmail). Update app.supabase.js export.");
      return;
    }

    setMsg("Sending magic link...");
    const { error } = await window.sb.signInWithEmail(email);
    if (error) return setMsg(error.message || String(error));

    setMsg("Magic link sent. Check your email.");
  }

  async function doSignOut() {
    if (!sbReady()) return;

    if (typeof window.sb?.signOut !== "function") {
      setMsg("Auth helper missing (sb.signOut). Update app.supabase.js export.");
      return;
    }

    setMsg("Signing out...");
    const { error } = await window.sb.signOut();
    if (error) setMsg(error.message || String(error));
    else setMsg("");

    await refreshAuthUI();
  }

  function wireDropdown() {
    if (el.menuBtn) el.menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDropdown();
    });

    if (el.closeBtn) el.closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeDropdown();
    });

    // Close if click outside
    document.addEventListener("click", (e) => {
      if (!el.dropdown) return;
      if (!el.dropdown.classList.contains("open")) return;

      const clickedInside =
        el.dropdown.contains(e.target) || (el.menuBtn && el.menuBtn.contains(e.target));

      if (!clickedInside) closeDropdown();
    });

    // Close on ESC
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDropdown();
    });
  }

  function wireAuthActions() {
    if (el.btnMagic) el.btnMagic.addEventListener("click", sendMagicLink);
    if (el.btnSignOut) el.btnSignOut.addEventListener("click", doSignOut);

    if (sbReady() && typeof window.sb.client.auth.onAuthStateChange === "function") {
      window.sb.client.auth.onAuthStateChange(() => refreshAuthUI());
    }
  }

  function wire() {
    wireDropdown();
    wireAuthActions();
    refreshAuthUI();
  }

  window.authUI = { refreshAuthUI };
  wire();
})();