// script.js
// Tabs + Support Role Persistence + Multi-Unit UI + Finalize Shift + Unit Metrics (minimal wiring)
// ✅ Environment tab/page removed — environment is now ONLY the header unit selector (#unitSwitcher)

(function () {
  // -----------------------------
  // Quick Auth Debug Helpers (console)
  // -----------------------------
  // Usage in console:
  //   await window.authDebug()
  //   await window.authDebug(true)   // also tries refreshSession()
  window.authDebug = async function authDebug(doRefresh = false) {
    try {
      if (!window.sb?.client?.auth) {
        console.log("[authDebug] window.sb.client.auth missing");
        return;
      }

      if (doRefresh && typeof window.sb.client.auth.refreshSession === "function") {
        const rr = await window.sb.client.auth.refreshSession();
        console.log("[authDebug] refreshSession()", rr);
      }

      const s = await window.sb.client.auth.getSession();
      console.log("[authDebug] getSession()", s);

      const u = await window.sb.client.auth.getUser();
      console.log("[authDebug] getUser()", u);

      console.log("[authDebug] activeUnitId:", window.activeUnitId, "activeUnitRole:", window.activeUnitRole);
    } catch (e) {
      console.warn("[authDebug] error", e);
    }
  };

  // -----------------------------
  // Tabs
  // -----------------------------
  function showTab(sectionId) {
    if (!canAccessTab(sectionId, window.activeUnitRole)) {
      sectionId = "staffingTab";
    }

    const sections = document.querySelectorAll(".tab-section");
    sections.forEach((sec) => {
      sec.style.display = sec.id === sectionId ? "block" : "none";
    });

    const buttons = document.querySelectorAll(".tabButton");
    buttons.forEach((btn) => btn.classList.remove("active"));

    const activeBtn = document.querySelector(`.tabButton[data-target="${sectionId}"]`);
    if (activeBtn) activeBtn.classList.add("active");

    // lightweight refresh when entering tabs that depend on unit/settings
    if (sectionId === "unitPulseTab") {
      if (typeof window.renderUnitPulseTab === "function") window.renderUnitPulseTab();
    }

    // Keep global discharge bin scoped to tab visibility rules.
    if (typeof window.syncDischargeBinVisibility === "function") {
      window.syncDischargeBinVisibility();
    } else if (typeof window.hideGlobalDischargeBin === "function") {
      const keep =
        sectionId === "liveAssignmentTab" || sectionId === "oncomingAssignmentTab";
      if (!keep) window.hideGlobalDischargeBin();
    }
  }

  // Expose for any legacy inline calls that still exist
  window.showTab = function (sectionId, buttonEl) {
    showTab(sectionId);
  };

  function wireTabs() {
    const buttons = document.querySelectorAll(".tabButton[data-target]");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-target");
        if (target) showTab(target);
      });
    });

    // Default to Staffing tab if none active
    const active = document.querySelector(".tabButton.active[data-target]");
    const defaultTarget = active?.getAttribute("data-target") || "staffingTab";
    showTab(defaultTarget);
  }

  // -----------------------------
  // Support Role Persistence
  // -----------------------------
  function supportRolePersistence() {
    const ids = [
      "currentChargeName",
      "currentMentorName",
      "currentCtaName",
      "incomingChargeName",
      "incomingMentorName",
      "incomingCtaName",
    ];

    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;

      const key = `supportRole:${id}`;
      el.value = localStorage.getItem(key) || "";

      el.addEventListener("input", () => {
        localStorage.setItem(key, el.value || "");
      });
    });
  }

  // -----------------------------
  // Utilities
  // -----------------------------
  function fmtDateYYYYMMDD(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
  }

  function setHTML(id, html) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
  }

  function canFinalizeForRole(role) {
    const r = String(role || "").toLowerCase();
    return r === "owner" || r === "admin" || r === "charge";
  }

  function isOwnerRole(role) {
    return String(role || "").toLowerCase() === "owner";
  }

  function canAccessHighRisk(role) {
    const r = String(role || "").toLowerCase();
    return r === "owner" || r === "admin" || r === "supervisor";
  }

  function canAccessTab(sectionId, role) {
    const target = String(sectionId || "");
    if (target === "highRiskTab") return canAccessHighRisk(role);
    if (target === "unitPulseTab" || target === "unitMetricsTab") return isOwnerRole(role);
    return true;
  }

  // -----------------------------
  // Multi-unit UI wiring (header-only)
  // -----------------------------
  function getUnitLabelFromMembership(m) {
    const name = m?.unit?.name || m?.units?.name || "";
    const code = m?.unit?.code || m?.units?.code || "";
    if (name && code) return `${name} (${code})`;
    return name || code || (m?.unit_id || "");
  }

  function getUnitNameFromMembership(m) {
    const name = (m?.unit?.name || m?.units?.name || "").trim();
    const code = (m?.unit?.code || m?.units?.code || "").trim();
    return name || code || "";
  }

  function refreshHeaderBrandTitle() {
    const el = document.getElementById("brandTitle");
    const activeId = String(window.activeUnitId || "");
    const rows = Array.isArray(window.availableUnits) ? window.availableUnits : [];
    const match = rows.find((r) => String(r?.unit_id || "") === activeId);
    const unitName = getUnitNameFromMembership(match);
    const titleText = unitName ? `${unitName}: Charge Nurse Platform` : "Charge Nurse Platform";

    if (el) el.textContent = titleText;
    document.title = titleText;
  }

  function applyRoleTabVisibility() {
    const role = window.activeUnitRole;
    ["highRiskTab", "unitPulseTab", "unitMetricsTab"].forEach((target) => {
      const btn = document.querySelector(`.tabButton[data-target="${target}"]`);
      const section = document.getElementById(target);
      const hide = !canAccessTab(target, role);

      if (btn) {
        btn.style.display = hide ? "none" : "";
        btn.setAttribute("aria-hidden", hide ? "true" : "false");
      }
      if (section && hide) section.style.display = "none";
    });

    const active = document.querySelector(".tabButton.active[data-target]");
    const activeTarget = active?.getAttribute("data-target") || "staffingTab";
    if (!canAccessTab(activeTarget, role)) {
      showTab("staffingTab");
    }
  }

  function populateUnitSelect(selectEl) {
    if (!selectEl) return;

    const rows = Array.isArray(window.availableUnits) ? window.availableUnits : [];
    const activeId = window.activeUnitId || "";

    // clear
    selectEl.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "—";
    selectEl.appendChild(opt0);

    rows.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.unit_id;
      opt.textContent = getUnitLabelFromMembership(m);
      if (String(m.unit_id) === String(activeId)) opt.selected = true;
      selectEl.appendChild(opt);
    });
  }

  async function activateUnitFromSelection(unitId) {
    const rows = Array.isArray(window.availableUnits) ? window.availableUnits : [];
    const match = rows.find(r => String(r.unit_id) === String(unitId));
    const role = match?.role || null;

    if (typeof window.setActiveUnit === "function") {
      const res = await window.setActiveUnit(unitId, role);
      if (!res?.ok) throw (res?.error || new Error("Failed to set active unit"));
    }

    // refresh auth pill if exists
    if (typeof window.refreshAuthPill === "function") {
      try { window.refreshAuthPill(); } catch (_) {}
    }

    refreshHeaderBrandTitle();

    // If other modules want to react to unit changes, they already do via setActiveUnit / init hooks.
  }

  function wireUnitSwitcherHeaderOnly() {
    const headerSel = document.getElementById("unitSwitcher");
    populateUnitSelect(headerSel);
    refreshHeaderBrandTitle();

    if (headerSel && !headerSel.__cuppBound) {
      headerSel.__cuppBound = true;
      headerSel.addEventListener("change", async () => {
        const unitId = headerSel.value;
        if (!unitId) return;

        try {
          await activateUnitFromSelection(unitId);
        } catch (e) {
          console.warn("[unit] switch failed", e);
          alert("Unable to switch unit (check membership/RLS).");
          // revert UI selection
          populateUnitSelect(headerSel);
        }
      });
    }
  }

  // -----------------------------
  // Finalize / Shift Change
  // -----------------------------
  function buildSnapshotStateFromOncoming() {
    // Minimal, demo-safe snapshot: store the oncoming assignments + current patient details.
    return {
      version: 1,
      captured_at: new Date().toISOString(),
      unit_id: window.activeUnitId || null,

      incomingNurses: Array.isArray(window.incomingNurses) ? window.incomingNurses.map(n => ({
        id: n.id,
        name: n.name,
        type: n.type,
        restrictions: n.restrictions || null,
        patients: Array.isArray(n.patients) ? n.patients.slice() : []
      })) : [],

      incomingPcas: Array.isArray(window.incomingPcas) ? window.incomingPcas.map(p => ({
        id: p.id,
        name: p.name,
        restrictions: p.restrictions || null,
        patients: Array.isArray(p.patients) ? p.patients.slice() : []
      })) : [],

      patients: Array.isArray(window.patients) ? window.patients.map(p => ({ ...p })) : [],

      admitQueue: Array.isArray(window.admitQueue) ? window.admitQueue.map(a => ({ ...a })) : []
    };
  }

  function computeAnalyticsFromLive() {
    const pts = Array.isArray(window.patients) ? window.patients : [];
    const activePatients = pts.filter(p => p && p.isEmpty === false);

    const admits = activePatients.filter(p => p.admit).length;
    const discharges = activePatients.filter(p => p.recentlyDischarged).length;

    const tagList = [
      "tele","drip","nih","bg","ciwa","restraint","sitter","vpo","isolation","admit","lateDc",
      "chg","foley","q2turns","heavy","feeder"
    ];

    const acuity_counts = {};
    activePatients.forEach(p => {
      tagList.forEach(t => {
        if (p && p[t]) acuity_counts[t] = (acuity_counts[t] || 0) + 1;
      });
    });

    Object.keys(acuity_counts).forEach(k => {
      if (!acuity_counts[k]) delete acuity_counts[k];
    });

    const patient_acuity = {};
    activePatients.forEach(p => {
      const tags = tagList.filter(t => !!p[t]);
      patient_acuity[String(p.id)] = tags;
    });

    return {
      version: 1,
      shift_summary: {
        total_patients: activePatients.length,
        admits,
        discharges
      },
      acuity_counts,
      patient_acuity
    };
  }

  function swapLiveWithOncomingAndResetOncoming() {
    window.currentNurses = (Array.isArray(window.incomingNurses) ? window.incomingNurses : []).map(n => ({
      ...n,
      patients: Array.isArray(n.patients) ? n.patients.slice() : []
    }));

    window.currentPcas = (Array.isArray(window.incomingPcas) ? window.incomingPcas : []).map(p => ({
      ...p,
      patients: Array.isArray(p.patients) ? p.patients.slice() : []
    }));

    window.incomingNurses = (Array.isArray(window.incomingNurses) ? window.incomingNurses : []).map(n => ({
      ...n,
      patients: []
    }));

    window.incomingPcas = (Array.isArray(window.incomingPcas) ? window.incomingPcas : []).map(p => ({
      ...p,
      patients: []
    }));

    if (typeof currentNurses !== "undefined") currentNurses = window.currentNurses;
    if (typeof currentPcas !== "undefined") currentPcas = window.currentPcas;
    if (typeof incomingNurses !== "undefined") incomingNurses = window.incomingNurses;
    if (typeof incomingPcas !== "undefined") incomingPcas = window.incomingPcas;

    if (typeof window.saveState === "function") window.saveState();

    if (typeof window.renderCurrentNurseList === "function") window.renderCurrentNurseList();
    if (typeof window.renderCurrentPcaList === "function") window.renderCurrentPcaList();
    if (typeof window.renderIncomingNurseList === "function") window.renderIncomingNurseList();
    if (typeof window.renderIncomingPcaList === "function") window.renderIncomingPcaList();

    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
  }

  async function finalizeShift() {
    const msgId = "finalizeStatusMsg";
    const btn = document.getElementById("btnFinalizeShift");
    const dateEl = document.getElementById("finalizeShiftDate");
    const typeEl = document.getElementById("finalizeShiftType");

    if (!window.activeUnitId) {
      setText(msgId, "❌ No active unit selected. Choose a unit first (top-right Unit dropdown).");
      return;
    }

    if (!canFinalizeForRole(window.activeUnitRole)) {
      setText(msgId, "❌ You do not have permission to finalize (requires owner/admin/charge for this unit).");
      return;
    }

    if (!window.sb || !window.sb.insertShiftSnapshot || !window.sb.insertAnalyticsShiftMetrics) {
      setText(msgId, "❌ Supabase not configured.");
      return;
    }

    const shift_date = (dateEl && dateEl.value) ? dateEl.value : fmtDateYYYYMMDD(new Date());
    const shift_type = (typeEl && typeEl.value) ? typeEl.value : "day";

    setText(msgId, "⏳ Publishing snapshot + analytics…");
    if (btn) btn.disabled = true;

    try {
      const { user } = await window.sb.getUser();
      const created_by = user?.id || null;

      const snapshotState = buildSnapshotStateFromOncoming();
      const snapRes = await window.sb.insertShiftSnapshot({
        unit_id: window.activeUnitId,
        shift_date,
        shift_type,
        status: "published",
        state: snapshotState,
        created_by
      });
      if (snapRes.error) throw snapRes.error;

      const metrics = computeAnalyticsFromLive();
      const metRes = await window.sb.insertAnalyticsShiftMetrics({
        unit_id: window.activeUnitId,
        shift_date,
        shift_type,
        metrics,
        created_by
      });
      if (metRes.error) throw metRes.error;

      swapLiveWithOncomingAndResetOncoming();

      setText(msgId, `✅ Finalized! Snapshot + metrics saved for ${shift_date} (${shift_type}). Live board updated.`);
    } catch (e) {
      console.warn("[finalize] failed", e);
      setText(msgId, "❌ Finalize failed (check RLS permissions + Supabase connectivity).");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function wireFinalizeButton() {
    const btn = document.getElementById("btnFinalizeShift");
    if (!btn) return;

    const dateEl = document.getElementById("finalizeShiftDate");
    if (dateEl && !dateEl.value) dateEl.value = fmtDateYYYYMMDD(new Date());

    if (!btn.__cuppBound) {
      btn.__cuppBound = true;
      btn.addEventListener("click", async () => {
        await finalizeShift();
      });
    }

    const updateBtnAccess = () => {
      const ok = canFinalizeForRole(window.activeUnitRole);
      btn.disabled = !ok;
      btn.style.opacity = ok ? "1" : "0.55";
      btn.title = ok
        ? "Publishes Oncoming snapshot + analytics, then swaps Live ← Oncoming"
        : "Requires owner/admin/charge on the active unit";
    };

    updateBtnAccess();
    window.__updateFinalizeButtonAccess = updateBtnAccess;
  }

  // -----------------------------
  // Unit Metrics (Historic table) — keep existing wiring name for now
  // -----------------------------
  function defaultPulseDates() {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 14);
    return { from: fmtDateYYYYMMDD(from), to: fmtDateYYYYMMDD(to) };
  }

  window.renderUnitPulseTab = function renderUnitPulseTab() {
    const fromEl = document.getElementById("pulseFrom");
    const toEl = document.getElementById("pulseTo");

    const d = defaultPulseDates();
    if (fromEl && !fromEl.value) fromEl.value = d.from;
    if (toEl && !toEl.value) toEl.value = d.to;

    const status = document.getElementById("pulseStatusMsg");
    if (status) {
      if (!window.activeUnitId) status.textContent = "Select an active unit to load metrics.";
      else status.textContent = "";
    }
  };

  function toTableHTML(rows) {
    if (!rows.length) return "<div style='opacity:0.75;'>No results.</div>";

    const header = `
      <tr>
        <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(0,0,0,0.08);">Date</th>
        <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(0,0,0,0.08);">Shift</th>
        <th style="text-align:right; padding:8px; border-bottom:1px solid rgba(0,0,0,0.08);">Total pts</th>
        <th style="text-align:right; padding:8px; border-bottom:1px solid rgba(0,0,0,0.08);">Admits</th>
        <th style="text-align:right; padding:8px; border-bottom:1px solid rgba(0,0,0,0.08);">Discharges</th>
        <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(0,0,0,0.08);">Top acuity tags</th>
      </tr>
    `;

    const body = rows.map(r => {
      const m = r.metrics || {};
      const sum = m.shift_summary || {};
      const counts = m.acuity_counts || {};
      const top = Object.entries(counts)
        .sort((a,b) => (b[1]||0) - (a[1]||0))
        .slice(0, 6)
        .map(([k,v]) => `${k}:${v}`)
        .join(", ");

      return `
        <tr>
          <td style="padding:8px; border-bottom:1px solid rgba(0,0,0,0.06);">${r.shift_date || ""}</td>
          <td style="padding:8px; border-bottom:1px solid rgba(0,0,0,0.06);">${r.shift_type || ""}</td>
          <td style="padding:8px; border-bottom:1px solid rgba(0,0,0,0.06); text-align:right;">${sum.total_patients ?? ""}</td>
          <td style="padding:8px; border-bottom:1px solid rgba(0,0,0,0.06); text-align:right;">${sum.admits ?? ""}</td>
          <td style="padding:8px; border-bottom:1px solid rgba(0,0,0,0.06); text-align:right;">${sum.discharges ?? ""}</td>
          <td style="padding:8px; border-bottom:1px solid rgba(0,0,0,0.06);">${top || "—"}</td>
        </tr>
      `;
    }).join("");

    return `<table style="width:100%; border-collapse:collapse; font-size:13px;">${header}${body}</table>`;
  }

  async function loadPulse() {
    const statusId = "pulseStatusMsg";
    const tableId = "pulseTable";
    const summaryId = "pulseSummary";

    if (!window.activeUnitId) {
      setText(statusId, "❌ No active unit selected.");
      return;
    }
    if (!window.sb || !window.sb.client) {
      setText(statusId, "❌ Supabase not configured.");
      return;
    }

    const fromEl = document.getElementById("pulseFrom");
    const toEl = document.getElementById("pulseTo");
    const typeEl = document.getElementById("pulseShiftType");
    const btn = document.getElementById("btnLoadPulse");

    const from = fromEl?.value || defaultPulseDates().from;
    const to = toEl?.value || defaultPulseDates().to;
    const shiftType = typeEl?.value || "";

    setText(statusId, "⏳ Loading metrics…");
    if (btn) btn.disabled = true;

    try {
      let q = window.sb.client
        .from("analytics_shift_metrics")
        .select("id, unit_id, shift_date, shift_type, metrics, created_at")
        .eq("unit_id", window.activeUnitId)
        .gte("shift_date", from)
        .lte("shift_date", to)
        .order("shift_date", { ascending: false })
        .order("created_at", { ascending: false });

      if (shiftType) q = q.eq("shift_type", shiftType);

      const { data, error } = await q;
      if (error) throw error;

      const rows = Array.isArray(data) ? data : [];
      setHTML(tableId, toTableHTML(rows));

      const totals = rows.reduce((acc, r) => {
        const sum = r?.metrics?.shift_summary || {};
        acc.total_patients += Number(sum.total_patients || 0);
        acc.admits += Number(sum.admits || 0);
        acc.discharges += Number(sum.discharges || 0);
        return acc;
      }, { total_patients: 0, admits: 0, discharges: 0 });

      const n = rows.length || 1;
      setHTML(summaryId, `
        <div><strong>Rows:</strong> ${rows.length}</div>
        <div><strong>Avg total patients:</strong> ${(totals.total_patients / n).toFixed(1)}</div>
        <div><strong>Avg admits:</strong> ${(totals.admits / n).toFixed(1)}</div>
        <div><strong>Avg discharges:</strong> ${(totals.discharges / n).toFixed(1)}</div>
      `);

      setText(statusId, rows.length ? "✅ Loaded." : "✅ No results for this range.");
    } catch (e) {
      console.warn("[metrics] load failed", e);
      setText(statusId, "❌ Load failed (check RLS / connectivity).");
      setHTML(tableId, "");
      setHTML(summaryId, "No data loaded yet.");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function wirePulseButton() {
    const btn = document.getElementById("btnLoadPulse");
    if (!btn) return;
    if (btn.__cuppBound) return;
    btn.__cuppBound = true;

    btn.addEventListener("click", async () => {
      await loadPulse();
    });
  }

  // -----------------------------
  // Membership refresh hook (so UI updates after auth)
  // -----------------------------
  function refreshRoleDrivenUi() {
    if (typeof window.__updateFinalizeButtonAccess === "function") {
      try { window.__updateFinalizeButtonAccess(); } catch (_) {}
    }
    applyRoleTabVisibility();
    refreshHeaderBrandTitle();
  }

  window.onAuthRoleChanged = function onAuthRoleChanged() {
    refreshRoleDrivenUi();
  };

  window.onMembershipsUpdated = function onMembershipsUpdated() {
    wireUnitSwitcherHeaderOnly();
    refreshRoleDrivenUi();
  };

  // -----------------------------
  // Init
  // -----------------------------
  function init() {
    wireTabs();
    supportRolePersistence();

    // Unit UI depends on memberships loaded by app.init.js.
    // We still wire now, then re-wire when memberships update.
    wireUnitSwitcherHeaderOnly();

    wireFinalizeButton();
    wirePulseButton();

    // initial renders
    if (typeof window.renderUnitPulseTab === "function") window.renderUnitPulseTab();

    // If init already populated availableUnits, keep UI synced
    if (Array.isArray(window.availableUnits) && window.availableUnits.length) {
      window.onMembershipsUpdated();
    }
    refreshRoleDrivenUi();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
