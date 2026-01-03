// app/app.patientProfileUI.js
// Upgraded Patient Profile modal:
// - centered
// - draggable
// - RN/PCA tags vertical + aligned
// ✅ Adds RN/PCA attribution on ACUITY_CHANGED when saved from the modal
// This file is meant to load LAST so it overrides any legacy handler.

(function () {
  function safeArray(v) { return Array.isArray(v) ? v : []; }

  function safeGetPatient(id) {
    if (typeof window.getPatientById === "function") return window.getPatientById(id);
    const arr = safeArray(window.patients);
    return arr.find(p => Number(p?.id) === Number(id)) || null;
  }

  function getBedLabel(p) {
    if (typeof window.getRoomLabelForPatient === "function") return window.getRoomLabelForPatient(p);
    return String(p?.room || p?.id || "");
  }

  function canSetGenderSafe(p, g) {
    if (typeof window.canSetGender === "function") return window.canSetGender(p, g);
    if (typeof window.canSetGenderFallback === "function") return window.canSetGenderFallback(p, g);
    return true;
  }

  // ----------------------------
  // Snapshot + diff
  // ----------------------------
  function takeAcuitySnapshot(p) {
    return {
      gender: p.gender || "",
      tele: !!p.tele,
      drip: !!p.drip,
      nih: !!p.nih,
      bg: !!p.bg,
      ciwa: !!p.ciwa,
      restraint: !!p.restraint,
      sitter: !!p.sitter,
      vpo: !!p.vpo,
      isolation: !!p.isolation,
      admit: !!p.admit,
      lateDc: !!p.lateDc,

      chg: !!p.chg,
      foley: !!p.foley,
      q2turns: !!p.q2turns,
      heavy: !!p.heavy,
      feeder: !!p.feeder
    };
  }

  function diffSnapshots(before, after) {
    const changes = [];
    if (!before || !after) return changes;
    Object.keys(after).forEach(k => {
      if (before[k] !== after[k]) changes.push({ key: k, before: before[k], after: after[k] });
    });
    return changes;
  }

  // ----------------------------
  // ✅ Attribution builder (uses your canonical helper if present)
  // ----------------------------
  function getAssignmentContextCompat(patientId) {
    // Best: your canonical helper (already exists per your console output)
    if (typeof window.getAssignmentContextForPatient === "function") {
      try {
        const ctx = window.getAssignmentContextForPatient(patientId);
        if (ctx && typeof ctx === "object") return ctx;
      } catch (_) {}
    }

    // Fallback: try the raw finders
    let rn = null, pca = null;
    try { if (typeof window.findAssignedNurse === "function") rn = window.findAssignedNurse(patientId); } catch {}
    try { if (typeof window.findAssignedPca === "function") pca = window.findAssignedPca(patientId); } catch {}

    return {
      rnId: rn ? rn.id : null,
      pcaId: pca ? pca.id : null,
      rnStaffId: rn ? (rn.staff_id ?? null) : null,
      pcaStaffId: pca ? (pca.staff_id ?? null) : null,
      rnName: rn ? (rn.name || "") : "",
      pcaName: pca ? (pca.name || "") : ""
    };
  }

  function buildAttributionBlock(patientId) {
    const ctx = getAssignmentContextCompat(patientId) || {};
    // normalize / enrich names if missing
    let rnName = ctx.rnName;
    let pcaName = ctx.pcaName;

    // If your ctx does not include names, look them up from the live arrays
    if (!rnName && ctx.rnId != null) {
      const rn = safeArray(window.currentNurses).find(n => Number(n?.id) === Number(ctx.rnId));
      rnName = rn?.name || "";
      if (ctx.rnStaffId == null) ctx.rnStaffId = rn?.staff_id ?? null;
    }
    if (!pcaName && ctx.pcaId != null) {
      const pc = safeArray(window.currentPcas).find(p => Number(p?.id) === Number(ctx.pcaId));
      pcaName = pc?.name || "";
      if (ctx.pcaStaffId == null) ctx.pcaStaffId = pc?.staff_id ?? null;
    }

    // Match your “patient_details” style: top-level fields + nested attribution
    return {
      rnId: ctx.rnId ?? null,
      rnStaffId: ctx.rnStaffId ?? null,
      rnName: rnName || "",
      pcaId: ctx.pcaId ?? null,
      pcaStaffId: ctx.pcaStaffId ?? null,
      pcaName: pcaName || "",
      attribution: {
        affects: { rn: true, pca: true }, // analytics can still decide impact per-tag
        rn: (ctx.rnId != null) ? { id: ctx.rnId, staff_id: ctx.rnStaffId ?? null, name: rnName || "" } : null,
        pca: (ctx.pcaId != null) ? { id: ctx.pcaId, staff_id: ctx.pcaStaffId ?? null, name: pcaName || "" } : null
      }
    };
  }

  function appendAcuityChangedWithStaff(patient, changes, source) {
    if (!patient || !changes || !changes.length) return;
    if (typeof window.appendEvent !== "function") return;

    const staff = buildAttributionBlock(patient.id);

    try {
      window.appendEvent("ACUITY_CHANGED", {
        patientId: Number(patient.id),
        bed: String(patient.room || patient.id || ""),
        changes: changes.slice(),
        source: source || "patient_profile",

        // ✅ staff correlation fields
        rnId: staff.rnId,
        rnStaffId: staff.rnStaffId,
        rnName: staff.rnName,

        pcaId: staff.pcaId,
        pcaStaffId: staff.pcaStaffId,
        pcaName: staff.pcaName,

        // ✅ nested block (optional but useful)
        attribution: staff.attribution
      }, { v: 2, source: "app.patientProfileUI.js" });
    } catch (e) {
      console.warn("[eventLog] ACUITY_CHANGED (profile) failed", e);
    }
  }

  // ----------------------------
  // Modal shell + drag
  // ----------------------------
  let currentProfilePatientId = null;

  function makeDraggable(cardEl, handleEl) {
    if (!cardEl || !handleEl || handleEl.__dragWired) return;
    handleEl.__dragWired = true;

    let dragging = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    handleEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true;

      const rect = cardEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      cardEl.style.transform = "none";
      cardEl.style.left = startLeft + "px";
      cardEl.style.top = startTop + "px";

      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      cardEl.style.left = (startLeft + dx) + "px";
      cardEl.style.top = (startTop + dy) + "px";
    });

    window.addEventListener("mouseup", () => { dragging = false; });
  }

  function ensureModalShell() {
    let modal = document.getElementById("patientProfileModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "patientProfileModal";
      document.body.appendChild(modal);
    }

    modal.classList.add("pp-overlay");
    modal.style.display = "none";

    if (!modal.querySelector(".pp-card")) {
      modal.innerHTML = `
        <div class="pp-card" role="dialog" aria-modal="true">
          <div class="pp-header" id="ppHeader">
            <div class="pp-title" id="profileModalTitle">Patient Profile</div>
            <button class="pp-close" type="button" id="ppCloseBtn">×</button>
          </div>
          <div class="pp-body" id="ppBody"></div>
        </div>
      `;
    }

    const closeBtn = modal.querySelector("#ppCloseBtn");
    if (closeBtn && !closeBtn.__wired) {
      closeBtn.__wired = true;
      closeBtn.addEventListener("click", closePatientProfileModal);
    }

    if (!modal.__wiredOutsideClose) {
      modal.__wiredOutsideClose = true;
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closePatientProfileModal();
      });
    }

    if (!window.__ppEscWired) {
      window.__ppEscWired = true;
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closePatientProfileModal();
      });
    }

    makeDraggable(modal.querySelector(".pp-card"), modal.querySelector(".pp-header"));
    return modal;
  }

  function centerModal(modal) {
    const card = modal?.querySelector(".pp-card");
    if (!card) return;
    card.style.left = "50%";
    card.style.top = "50%";
    card.style.transform = "translate(-50%, -50%)";
  }

  function tagItem(id, label, checked) {
    return `
      <label class="pp-tag">
        <input type="checkbox" id="${id}" ${checked ? "checked" : ""}/>
        <span>${label}</span>
      </label>
    `;
  }

  function openPatientProfileFromRoom(patientId) {
    const p = safeGetPatient(patientId);
    if (!p) return;

    if (p.isEmpty) {
      alert("This bed is EMPTY. Uncheck Empty Bed on the Patient Details tab to admit/edit.");
      return;
    }

    currentProfilePatientId = Number(patientId);

    // Capture BEFORE snapshot on open
    try {
      window.__profileBeforeSnapshot = takeAcuitySnapshot(p);
      window.__profileBeforePatientId = Number(p.id);
    } catch (_) {
      window.__profileBeforeSnapshot = null;
      window.__profileBeforePatientId = null;
    }

    const modal = ensureModalShell();
    const titleEl = modal.querySelector("#profileModalTitle");
    const bodyEl = modal.querySelector("#ppBody");

    if (titleEl) titleEl.textContent = `Patient Profile — Bed ${getBedLabel(p) || "?"}`;

    const rnItems = [
      ["profTele", "Tele", !!p.tele],
      ["profDrip", "Drip", !!p.drip],
      ["profNih", "NIH", !!p.nih],
      ["profBg", "BG", !!(p.bg || p.bgChecks)],
      ["profCiwa", "CIWA/COWS", !!(p.ciwa || p.cows || p.ciwaCows)],
      ["profRestraint", "Restraint", !!(p.restraint || p.restraints)],
      ["profSitter", "Sitter", !!p.sitter],
      ["profVpo", "VPO", !!p.vpo],
      ["profIso", "Isolation", !!(p.isolation || p.iso)],
      ["profAdmit", "Admit", !!p.admit],
      ["profLateDc", "Late DC", !!(p.lateDc || p.lateDC || p.latedc)],
    ];

    const pcaItems = [
      ["profTelePca", "Tele", !!p.tele],
      ["profIsoPca", "Isolation", !!(p.isolation || p.iso)],
      ["profAdmitPca", "Admit", !!p.admit],
      ["profLateDcPca", "Late DC", !!(p.lateDc || p.lateDC || p.latedc)],
      ["profChg", "CHG", !!p.chg],
      ["profFoley", "Foley", !!p.foley],
      ["profQ2", "Q2 Turns", !!(p.q2turns || p.q2Turns)],
      ["profHeavy", "Heavy", !!p.heavy],
      ["profFeeder", "Feeder", !!(p.feeder || p.feeders)],
    ];

    if (bodyEl) {
      bodyEl.innerHTML = `
        <div class="pp-row">
          <div class="pp-label">Gender:</div>
          <select id="profGender">
            <option value="" ${!p.gender ? "selected" : ""}>-</option>
            <option value="M" ${p.gender === "M" ? "selected" : ""}>M</option>
            <option value="F" ${p.gender === "F" ? "selected" : ""}>F</option>
            <option value="X" ${p.gender === "X" ? "selected" : ""}>X</option>
          </select>
        </div>

        <div class="pp-grid">
          <div class="pp-col">
            <h4>RN Acuity Tags</h4>
            <div class="pp-taglist">
              ${rnItems.map(x => tagItem(x[0], x[1], x[2])).join("")}
            </div>
          </div>

          <div class="pp-col">
            <h4>PCA Acuity Tags</h4>
            <div class="pp-taglist">
              ${pcaItems.map(x => tagItem(x[0], x[1], x[2])).join("")}
            </div>
          </div>
        </div>

        <div class="pp-actions">
          <button class="btn" type="button" id="ppCancelBtn">Cancel</button>
          <button class="btn btn-primary" type="button" id="ppSaveBtn">Save</button>
        </div>
      `;
    }

    const cancelBtn = modal.querySelector("#ppCancelBtn");
    if (cancelBtn) cancelBtn.onclick = closePatientProfileModal;

    const saveBtn = modal.querySelector("#ppSaveBtn");
    if (saveBtn) saveBtn.onclick = savePatientProfile;

    modal.style.display = "flex";
    centerModal(modal);
  }

  function closePatientProfileModal() {
    const modal = document.getElementById("patientProfileModal");
    if (modal) modal.style.display = "none";
    currentProfilePatientId = null;

    window.__profileBeforeSnapshot = null;
    window.__profileBeforePatientId = null;
  }

  function savePatientProfile() {
    if (currentProfilePatientId == null) return;

    const p = safeGetPatient(currentProfilePatientId);
    if (!p) return closePatientProfileModal();

    const before =
      (window.__profileBeforeSnapshot && Number(window.__profileBeforePatientId) === Number(p.id))
        ? window.__profileBeforeSnapshot
        : takeAcuitySnapshot(p);

    const gSel = document.getElementById("profGender");
    const newGender = gSel ? gSel.value : "";

    if (newGender && !canSetGenderSafe(p, newGender)) {
      alert("Roommate has a different gender. Mixed-gender room not allowed for this bed.");
      return;
    }
    p.gender = newGender || "";

    const getCheck = (id) => {
      const el = document.getElementById(id);
      return !!(el && el.checked);
    };

    // Shared tags (apply to both sides)
    p.tele = getCheck("profTele") || getCheck("profTelePca");
    p.isolation = getCheck("profIso") || getCheck("profIsoPca");
    p.iso = p.isolation;
    p.admit = getCheck("profAdmit") || getCheck("profAdmitPca");
    p.lateDc = getCheck("profLateDc") || getCheck("profLateDcPca");

    // RN-only tags
    p.drip = getCheck("profDrip");
    p.nih = getCheck("profNih");
    p.bg = getCheck("profBg");
    p.bgChecks = p.bg;

    p.ciwa = getCheck("profCiwa");
    p.cows = p.ciwa;
    p.ciwaCows = p.ciwa;

    p.restraint = getCheck("profRestraint");
    p.sitter = getCheck("profSitter");
    p.vpo = getCheck("profVpo");

    // PCA-only tags
    p.chg = getCheck("profChg");
    p.foley = getCheck("profFoley");
    p.q2turns = getCheck("profQ2");
    p.q2Turns = p.q2turns;
    p.heavy = getCheck("profHeavy");
    p.feeder = getCheck("profFeeder");

    p.isEmpty = false;
    p.recentlyDischarged = false;

    // AFTER + diff + log with staff attribution
    try {
      const after = takeAcuitySnapshot(p);
      const changes = diffSnapshots(before, after);
      appendAcuityChangedWithStaff(p, changes, "patient_profile");
    } catch (e) {
      console.warn("[eventLog] profile acuity logging failed", e);
    }

    if (typeof window.saveState === "function") window.saveState();

    // Central refresh if available
    if (typeof window.refreshUI === "function") {
      try { window.refreshUI(); } catch {}
    } else {
      try { if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles(); } catch {}
      try { if (typeof window.renderPatientList === "function") window.renderPatientList(); } catch {}
      try { if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments(); } catch {}
      try { if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput(); } catch {}
      try { if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput(); } catch {}
    }

    closePatientProfileModal();
  }

  // Override globally (key)
  window.openPatientProfileFromRoom = openPatientProfileFromRoom;
  window.closePatientProfileModal = closePatientProfileModal;
  window.savePatientProfile = savePatientProfile;

  console.log("[patientProfileUI] upgraded modal loaded (override active, staff attribution enabled)");
})();