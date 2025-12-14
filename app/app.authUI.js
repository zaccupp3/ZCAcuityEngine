// app/app.authUI.js
// Wires the auth dropdown UI to window.sb (Supabase wrapper)
// Also refreshes unit memberships + active unit + role pill for multi-unit demo flows.
// CLOUD UNIT STATE:
// - After login/memberships: load unit_state from cloud and subscribe realtime.

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
      const p = window.sb.client.auth.getSession();
      const t = new Promise((_, rej) => setTimeout(() => rej(new Error("getSession timed out")), 3500));
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

  // Keep the little auth pill accurate to ACTIVE UNIT
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

  // After auth, refresh memberships + ensure active unit is set and settings loaded
  async function refreshMembershipsAndUnit() {
    if (!sbReady()) return { ok: false, error: new Error("Supabase not ready") };
    if (typeof window.refreshMyUnits !== "function") {
      return { ok: false, error: new Error("refreshMyUnits missing (app.state.js not loaded?)") };
    }

    const res = await window.refreshMyUnits();
    if (!res?.ok) return res;

    const rows = Array.isArray(window.availableUnits) ? window.availableUnits : [];

    // If we have an activeUnitId, align role from memberships and load settings via setActiveUnit
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
    // Load + subscribe cloud unit_state if available
    if (!window.activeUnitId) return;

    if (!window.cloudSync) return;
    if (typeof window.cloudSync.loadUnitStateFromCloud === "function") {
      try {
        const res = await window.cloudSync.loadUnitStateFromCloud(window.activeUnitId);
        // If no row exists yet, seed (charge/admin/owner will publish through wrapped saveState)
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

    // After cloud applied, refresh UI
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

      // Stop realtime if any
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

    // Preferred path: refresh memberships and set active unit + settings
    try {
      const r = await refreshMembershipsAndUnit();
      if (!r?.ok) console.warn("[auth] refreshMembershipsAndUnit not ok", r?.error);
    } catch (e) {
      console.warn("[auth] refreshMembershipsAndUnit failed", e);
    }

    // Fallback: if memberships didn't populate, at least show most recent membership
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

    // ✅ Cloud load + realtime subscription for active unit
    await syncCloudForActiveUnit();

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

    // Stop realtime if any
    if (window.cloudSync && typeof window.cloudSync.unsubscribeUnitState === "function") {
      try { window.cloudSync.unsubscribeUnitState(); } catch {}
    }

    if (el.userEmail) el.userEmail.textContent = "";
    if (el.unitRole) el.unitRole.textContent = "unit: — | role: —";
    showLoggedIn(false);

    if (typeof window.onAuthRoleChanged === "function") {
      try { window.onAuthRoleChanged(); } catch (_) {}
    }

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
    if (el.btnSignOut) el.btnSignOut.addEventListener("click", doSignOut);

    if (sbReady() && typeof window.sb.client.auth.onAuthStateChange === "function") {
      window.sb.client.auth.onAuthStateChange(async () => {
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