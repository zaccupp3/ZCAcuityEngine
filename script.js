// script.js
// Tabs + Support Role Persistence + Multi-Unit UI + Finalize Shift + Unit Pulse (minimal demo wiring)

(function () {
  // -----------------------------
  // Tabs
  // -----------------------------
  function showTab(sectionId) {
    const sections = document.querySelectorAll(".tab-section");
    sections.forEach((sec) => {
      sec.style.display = sec.id === sectionId ? "block" : "none";
    });

    const buttons = document.querySelectorAll(".tabButton");
    buttons.forEach((btn) => btn.classList.remove("active"));

    const activeBtn = document.querySelector(`.tabButton[data-target="${sectionId}"]`);
    if (activeBtn) activeBtn.classList.add("active");

    // lightweight refresh when entering tabs that depend on unit/settings
    if (sectionId === "environmentTab") {
      if (typeof window.renderEnvironmentTab === "function") window.renderEnvironmentTab();
    }
    if (sectionId === "unitPulseTab") {
      if (typeof window.renderUnitPulseTab === "function") window.renderUnitPulseTab();
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

  // -----------------------------
  // Multi-unit UI wiring
  // -----------------------------
  function getUnitLabelFromMembership(m) {
    const name = m?.unit?.name || m?.units?.name || "";
    const code = m?.unit?.code || m?.units?.code || "";
    if (name && code) return `${name} (${code})`;
    return name || code || (m?.unit_id || "");
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

    // refresh environment preview
    if (typeof window.renderEnvironmentTab === "function") window.renderEnvironmentTab();
  }

  function wireUnitSwitchers() {
    const headerSel = document.getElementById("unitSwitcher");
    const envSel = document.getElementById("envUnitSelect");
    const btnMakeActive = document.getElementById("btnEnvMakeActive");

    populateUnitSelect(headerSel);
    populateUnitSelect(envSel);

    if (headerSel) {
      headerSel.addEventListener("change", async () => {
        const unitId = headerSel.value;
        if (!unitId) return;
        try {
          await activateUnitFromSelection(unitId);
          // keep env selector in sync
          if (envSel) envSel.value = unitId;
        } catch (e) {
          console.warn("[unit] switch failed", e);
          alert("Unable to switch unit (check membership/RLS).");
          // revert UI selection
          populateUnitSelect(headerSel);
          populateUnitSelect(envSel);
        }
      });
    }

    if (btnMakeActive && envSel) {
      btnMakeActive.addEventListener("click", async () => {
        const unitId = envSel.value;
        if (!unitId) {
          alert("Select a unit first.");
          return;
        }
        try {
          await activateUnitFromSelection(unitId);
          if (headerSel) headerSel.value = unitId;
        } catch (e) {
          console.warn("[unit] activate failed", e);
          alert("Unable to activate unit (check membership/RLS).");
        }
      });
    }
  }

  // Environment tab renderer
  window.renderEnvironmentTab = function renderEnvironmentTab() {
    const unitLabelEl = document.getElementById("envActiveUnitLabel");
    const previewEl = document.getElementById("envSettingsPreview");

    let label = "—";
    const rows = Array.isArray(window.availableUnits) ? window.availableUnits : [];
    const activeId = window.activeUnitId;

    if (activeId) {
      const match = rows.find(r => String(r.unit_id) === String(activeId));
      label = match ? getUnitLabelFromMembership(match) : String(activeId);
    }

    if (unitLabelEl) unitLabelEl.textContent = label;

    if (previewEl) {
      const obj = window.unitSettings || null;
      previewEl.textContent = JSON.stringify(obj || {}, null, 2);
    }

    // keep selects synced with latest
    populateUnitSelect(document.getElementById("unitSwitcher"));
    populateUnitSelect(document.getElementById("envUnitSelect"));
  };

  // -----------------------------
  // Seeding: 2 South (200A–221B)
  // -----------------------------
  function build2SouthRoomSchema_200A_221B() {
    // 200A..221B inclusive (22 numbers * 2 sides = 44 beds) — BUT your app is a 32-bed grid.
    // For demo: we still *store* the schema as provided; mapping to 32 visible rooms can be layered later.
    const beds = [];
    for (let n = 200; n <= 221; n++) {
      beds.push(`${n}A`);
      beds.push(`${n}B`);
    }
    return {
      version: 1,
      unit_type: "medsurg_tele",
      beds,
      notes: "Standard 2 South schema (200A–221B). Stored for demo; app grid mapping handled separately."
    };
  }

  function buildDefaultEnabledTags() {
    // Mirrors your current patient model flags; "enabled_tags" becomes a per-unit configuration later.
    return {
      rn: ["tele", "drip", "nih", "bg", "ciwa", "restraint", "sitter", "vpo", "isolation", "admit", "lateDc"],
      pca: ["chg", "foley", "q2turns", "heavy", "feeder"]
    };
  }

  function buildDefaultRuleset() {
    return {
      version: 1,
      notes: "Baseline ruleset; scoring/explainability will evolve. Current frontend enforces constraints client-side."
    };
  }

  async function seed2South32() {
    if (!window.sb || !window.sb.upsertUnit || !window.sb.upsertUnitSettings) {
      alert("Supabase not configured.");
      return;
    }

    const { user } = await window.sb.getUser();
    const updated_by = user?.id || null;

    // Unit identity (code should be UNIQUE ideally)
    const unitPayload = { name: "2 South", code: "2SOUTH" };
    const u = await window.sb.upsertUnit(unitPayload);
    if (u.error) throw u.error;

    const unit_id = u.row?.id;
    if (!unit_id) throw new Error("Seed failed: unit_id missing from upsertUnit response.");

    const settingsPayload = {
      unit_id,
      room_schema: build2SouthRoomSchema_200A_221B(),
      staffing_defaults: {
        version: 1,
        default_current_rns: 4,
        default_current_pcas: 2,
        default_oncoming_rns: 4,
        default_oncoming_pcas: 2
      },
      enabled_tags: buildDefaultEnabledTags(),
      ruleset: buildDefaultRuleset(),
      updated_by
    };

    const s = await window.sb.upsertUnitSettings(settingsPayload);
    if (s.error) throw s.error;

    // try to activate immediately (only works if you're a member per RLS)
    try {
      // refresh memberships then activate if membership exists
      if (typeof window.refreshMyUnits === "function") await window.refreshMyUnits();
      const rows = Array.isArray(window.availableUnits) ? window.availableUnits : [];
      const mem = rows.find(r => r?.unit?.code === "2SOUTH" || r?.unit_id === unit_id);
      if (mem) {
        await activateUnitFromSelection(mem.unit_id);
        window.renderEnvironmentTab();
      }
    } catch (e) {
      console.warn("[seed] activate after seed failed (likely membership)", e);
    }

    alert("Seed complete: 2 South (200A–221B) unit + settings created/updated.");
  }

  function wireEnvironmentSeedButtons() {
    const b1 = document.getElementById("btnSeed2South32");
    if (b1) b1.addEventListener("click", async () => {
      try {
        await seed2South32();
      } catch (e) {
        console.warn("[seed] failed", e);
        alert("Seed failed (check RLS / unique constraints on units.code and unit_settings.unit_id).");
      }
    });
  }

  // -----------------------------
  // Finalize / Shift Change
  // -----------------------------
  function buildSnapshotStateFromOncoming() {
    // Minimal, demo-safe snapshot: store the oncoming assignments + current patient details.
    // Your oncoming assignments live in incomingNurses / incomingPcas with patients arrays.
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

      // capture queue too for continuity (optional)
      admitQueue: Array.isArray(window.admitQueue) ? window.admitQueue.map(a => ({ ...a })) : []
    };
  }

  function computeAnalyticsFromLive() {
    const pts = Array.isArray(window.patients) ? window.patients : [];
    const activePatients = pts.filter(p => p && p.isEmpty === false);

    // “admit” tag indicates admit
    const admits = activePatients.filter(p => p.admit).length;

    // discharge count: those flagged recentlyDischarged (session)
    const discharges = activePatients.filter(p => p.recentlyDischarged).length;

    // Tag counts (only >0)
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

    // only where >0
    Object.keys(acuity_counts).forEach(k => {
      if (!acuity_counts[k]) delete acuity_counts[k];
    });

    // patient_acuity: { patientId: [tag1, tag2] }
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
    // Replace Live state with Oncoming state:
    // currentNurses/currentPcas <= incomingNurses/incomingPcas (deep copy)
    window.currentNurses = (Array.isArray(window.incomingNurses) ? window.incomingNurses : []).map(n => ({
      ...n,
      patients: Array.isArray(n.patients) ? n.patients.slice() : []
    }));

    window.currentPcas = (Array.isArray(window.incomingPcas) ? window.incomingPcas : []).map(p => ({
      ...p,
      patients: Array.isArray(p.patients) ? p.patients.slice() : []
    }));

    // Reset oncoming workspace (preserve names? For now keep staff list but clear patient allocations)
    window.incomingNurses = (Array.isArray(window.incomingNurses) ? window.incomingNurses : []).map(n => ({
      ...n,
      patients: []
    }));

    window.incomingPcas = (Array.isArray(window.incomingPcas) ? window.incomingPcas : []).map(p => ({
      ...p,
      patients: []
    }));

    // Keep legacy bare globals in sync if they exist
    if (typeof currentNurses !== "undefined") currentNurses = window.currentNurses;
    if (typeof currentPcas !== "undefined") currentPcas = window.currentPcas;
    if (typeof incomingNurses !== "undefined") incomingNurses = window.incomingNurses;
    if (typeof incomingPcas !== "undefined") incomingPcas = window.incomingPcas;

    if (typeof window.saveState === "function") window.saveState();

    // Re-render
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
      setText(msgId, "❌ No active unit selected. Choose a unit first (header dropdown or Environment tab).");
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

      // 1) Publish oncoming snapshot
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

      // 2) Compute analytics from outgoing Live Assignment
      const metrics = computeAnalyticsFromLive();
      const metRes = await window.sb.insertAnalyticsShiftMetrics({
        unit_id: window.activeUnitId,
        shift_date,
        shift_type,
        metrics,
        created_by
      });
      if (metRes.error) throw metRes.error;

      // 3) Swap Live ← Oncoming and reset Oncoming
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

    // default date = today
    const dateEl = document.getElementById("finalizeShiftDate");
    if (dateEl && !dateEl.value) dateEl.value = fmtDateYYYYMMDD(new Date());

    btn.addEventListener("click", async () => {
      await finalizeShift();
    });

    // role-based UI enable/disable
    const updateBtnAccess = () => {
      const ok = canFinalizeForRole(window.activeUnitRole);
      btn.disabled = !ok;
      btn.style.opacity = ok ? "1" : "0.55";
      btn.title = ok
        ? "Publishes Oncoming snapshot + analytics, then swaps Live ← Oncoming"
        : "Requires owner/admin/charge on the active unit";
    };

    updateBtnAccess();
    // if auth UI updates role later, it can call this hook
    window.onAuthRoleChanged = updateBtnAccess;
  }

  // -----------------------------
  // Unit Pulse (minimal table)
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

    // small status
    const status = document.getElementById("pulseStatusMsg");
    if (status) {
      if (!window.activeUnitId) status.textContent = "Select an active unit to load pulse data.";
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

    setText(statusId, "⏳ Loading pulse data…");
    if (btn) btn.disabled = true;

    try {
      // Supabase range: inclusive boundaries – we use gte/lte on shift_date
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

      // summary: averages / totals
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
      console.warn("[pulse] load failed", e);
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
    btn.addEventListener("click", async () => {
      await loadPulse();
    });
  }

  // -----------------------------
  // Membership refresh hook (so UI updates after auth)
  // -----------------------------
  window.onMembershipsUpdated = function onMembershipsUpdated() {
    // called by auth UI or init after refreshMyUnits
    wireUnitSwitchers();
    if (typeof window.renderEnvironmentTab === "function") window.renderEnvironmentTab();
  };

  // -----------------------------
  // Init
  // -----------------------------
  function init() {
    wireTabs();
    supportRolePersistence();

    // Unit UI depends on memberships loaded by app.init.js.
    // We still wire now, then re-wire when memberships update.
    wireUnitSwitchers();
    wireEnvironmentSeedButtons();

    wireFinalizeButton();
    wirePulseButton();

    // initial renders of environment/pulse if needed
    if (typeof window.renderEnvironmentTab === "function") window.renderEnvironmentTab();
    if (typeof window.renderUnitPulseTab === "function") window.renderUnitPulseTab();

    // If init already populated availableUnits, keep UI synced
    // (refreshMyUnits lives in app.state and is called during app.init.js)
    if (Array.isArray(window.availableUnits) && window.availableUnits.length) {
      window.onMembershipsUpdated();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();