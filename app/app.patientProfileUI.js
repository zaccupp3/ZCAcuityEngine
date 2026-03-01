// app/app.patientProfileUI.js
// Patient Profile modal HARDENED:
// - fixed overlay rooted at body
// - centered
// - draggable by header
// - vertical aligned RN/PCA tags
// - logs ACUITY_CHANGED with RN/PCA attribution
//
// Important behavior:
// ✅ ALWAYS installs overrides (no early return), so cache / double-load can’t trap you
// ✅ Self-heals if overwritten by later scripts (including script.js)

(function () {
  window.__patientProfileUIBuild = "override-active-jan2026";

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
      tf: !!p.tf,
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
      strictIo: !!(p.strictIo || p.heavy),
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
  // Attribution builder
  // ----------------------------
  function getAssignmentContextCompat(patientId) {
    if (typeof window.getAssignmentContextForPatient === "function") {
      try {
        const ctx = window.getAssignmentContextForPatient(patientId);
        if (ctx && typeof ctx === "object") return ctx;
      } catch (_) {}
    }

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
    let rnName = ctx.rnName;
    let pcaName = ctx.pcaName;

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

    return {
      rnId: ctx.rnId ?? null,
      rnStaffId: ctx.rnStaffId ?? null,
      rnName: rnName || "",
      pcaId: ctx.pcaId ?? null,
      pcaStaffId: ctx.pcaStaffId ?? null,
      pcaName: pcaName || "",
      attribution: {
        affects: { rn: true, pca: true },
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

        rnId: staff.rnId,
        rnStaffId: staff.rnStaffId,
        rnName: staff.rnName,

        pcaId: staff.pcaId,
        pcaStaffId: staff.pcaStaffId,
        pcaName: staff.pcaName,

        attribution: staff.attribution
      }, { v: 3, source: "app.patientProfileUI.js" });
    } catch (e) {
      console.warn("[eventLog] ACUITY_CHANGED (profile) failed", e);
    }
  }

  // ----------------------------
  // Modal shell + drag + HARD STYLES
  // ----------------------------
  let currentProfilePatientId = null;

  function listAvailableBedsForProfile(currentPatientId) {
    const curId = Number(currentPatientId);
    const rows = safeArray(window.patients)
      .filter(p => p && Number(p.id) !== curId && p.isEmpty)
      .sort((a, b) => {
        try {
          if (typeof window.getRoomNumber === "function") {
            return window.getRoomNumber(a) - window.getRoomNumber(b);
          }
        } catch (_) {}
        return Number(a.id) - Number(b.id);
      });
    return rows;
  }

  function makeDraggable(cardEl, handleEl) {
    if (!cardEl || !handleEl || handleEl.__dragWired) return;
    handleEl.__dragWired = true;

    let dragging = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    handleEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const t = e.target;
      if (t && (t.tagName === "BUTTON" || t.closest?.("button"))) return;

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

  function hardStyleOverlay(modal) {
    modal.style.position = "fixed";
    modal.style.inset = "0";
    modal.style.display = "none";
    modal.style.alignItems = "center";
    modal.style.justifyContent = "center";
    modal.style.background = "rgba(15,23,42,0.55)";
    modal.style.zIndex = "10000";
  }

  function hardStyleCard(card) {
    card.style.position = "fixed";
    card.style.left = "50%";
    card.style.top = "50%";
    card.style.transform = "translate(-50%, -50%)";
    card.style.width = "min(920px, 94vw)";
    card.style.maxHeight = "86vh";
    card.style.overflow = "auto";
    card.style.background = "#fff";
    card.style.borderRadius = "18px";
    card.style.boxShadow = "0 18px 48px rgba(0,0,0,.28)";
  }

  function ensureModalShell() {
    let modal = document.getElementById("patientProfileModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "patientProfileModal";
      document.body.appendChild(modal);
    }

    modal.classList.add("pp-overlay");
    hardStyleOverlay(modal);

    if (!modal.querySelector(".pp-card")) {
      modal.innerHTML = `
        <div class="pp-card" role="dialog" aria-modal="true">
          <div class="pp-header" id="ppHeader" style="
            display:flex;align-items:center;justify-content:space-between;
            padding:14px 16px;border-bottom:1px solid rgba(15,23,42,0.10);
          ">
            <div class="pp-title" id="profileModalTitle" style="font-size:18px;font-weight:900;">Patient Profile</div>
            <button class="pp-close" type="button" id="ppCloseBtn" style="
              border:0;background:transparent;font-size:22px;font-weight:900;cursor:pointer;
            ">×</button>
          </div>
          <div class="pp-body" id="ppBody" style="padding:16px;"></div>
        </div>
      `;
    }

    const card = modal.querySelector(".pp-card");
    card.classList.add("pp-card");
    hardStyleCard(card);

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

    makeDraggable(card, modal.querySelector("#ppHeader"));
    return modal;
  }

  function tagItem(id, label, checked) {
    return `
      <label class="pp-tag" style="
        display:flex;align-items:center;gap:10px;
        padding:10px 12px;border-radius:14px;
        border:1px solid rgba(15,23,42,0.10);
        background:rgba(15,23,42,0.03);
      ">
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
      ["profTf", "TF", !!p.tf],
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
      ["profHeavy", "Strict I/O", !!(p.strictIo || p.heavy)],
      ["profFeeder", "Feeder", !!(p.feeder || p.feeders)],
    ];

    if (bodyEl) {
      const bedLabel = getBedLabel(p) || "?";
      bodyEl.innerHTML = `
        <div class="pp-row" style="display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="btn" type="button" id="ppRoomChangeBtn">Room Change</button>
          </div>
        </div>

        <div id="ppRoomChangePanel" style="
          display:none;
          align-items:center;
          gap:10px;
          margin-bottom:12px;
          padding:10px 12px;
          border-radius:12px;
          border:1px solid rgba(15,23,42,0.12);
          background:rgba(248,250,252,0.9);
          flex-wrap:wrap;
        ">
          <div style="font-weight:900;font-size:14px;">Move to:</div>
          <select
            id="ppRoomChangeTarget"
            style="
              min-width:150px;
              padding:8px 10px;
              font-size:14px;
              border-radius:10px;
              border:1px solid rgba(15,23,42,0.18);
            "
          ></select>
          <button class="btn btn-primary" type="button" id="ppRoomChangeConfirm">Confirm</button>
          <button class="btn" type="button" id="ppRoomChangeCancel">Cancel</button>
        </div>

        <div class="pp-grid" style="
          display:grid;
          grid-template-columns: 1fr 1fr;
          gap:18px;
          margin-top:12px;
        ">
          <div class="pp-col">
            <h4>RN Acuity Tags</h4>
            <div class="pp-taglist" style="display:flex;flex-direction:column;gap:10px;">
              ${rnItems.map(x => tagItem(x[0], x[1], x[2])).join("")}
            </div>
          </div>

          <div class="pp-col">
            <h4>PCA Acuity Tags</h4>
            <div class="pp-taglist" style="display:flex;flex-direction:column;gap:10px;">
              ${pcaItems.map(x => tagItem(x[0], x[1], x[2])).join("")}
            </div>
          </div>
        </div>

        <div class="pp-actions" style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
          <button class="btn" type="button" id="ppCancelBtn">Cancel</button>
          <button class="btn btn-primary" type="button" id="ppSaveBtn">Save</button>
        </div>
      `;
    }

    const cancelBtn = modal.querySelector("#ppCancelBtn");
    if (cancelBtn) cancelBtn.onclick = closePatientProfileModal;

    const saveBtn = modal.querySelector("#ppSaveBtn");
    if (saveBtn) saveBtn.onclick = savePatientProfile;

    const roomChangeBtn = modal.querySelector("#ppRoomChangeBtn");
    const roomChangePanel = modal.querySelector("#ppRoomChangePanel");
    const roomChangeSelect = modal.querySelector("#ppRoomChangeTarget");
    const roomChangeConfirm = modal.querySelector("#ppRoomChangeConfirm");
    const roomChangeCancel = modal.querySelector("#ppRoomChangeCancel");

    if (roomChangeBtn && roomChangePanel && roomChangeSelect && roomChangeConfirm && roomChangeCancel) {
      const fromLabel = getBedLabel(p) || "";

      const populateTargets = () => {
        const empties = listAvailableBedsForProfile(p.id);
        if (!empties.length) {
          alert("No empty beds are available for room change.");
          roomChangePanel.style.display = "none";
          return;
        }
        roomChangeSelect.innerHTML = empties
          .map(b => `<option value="${b.id}">${getBedLabel(b) || b.id}</option>`)
          .join("");
        if (!roomChangeSelect.value && empties[0]) {
          roomChangeSelect.value = String(empties[0].id);
        }
      };

      const updateConfirmLabel = () => {
        const targetId = Number(roomChangeSelect.value || 0);
        if (!targetId) return;
        const target = safeArray(window.patients).find(x => x && Number(x.id) === targetId);
        const toLabel = target ? (getBedLabel(target) || target.id) : targetId;
        roomChangeConfirm.textContent = `Move ${fromLabel} to ${toLabel}`;
      };

      roomChangeBtn.onclick = () => {
        populateTargets();
        if (!roomChangeSelect.value) return;
        updateConfirmLabel();
        roomChangePanel.style.display = "flex";
      };

      roomChangeSelect.onchange = () => {
        updateConfirmLabel();
      };

      roomChangeCancel.onclick = () => {
        roomChangePanel.style.display = "none";
      };

      roomChangeConfirm.onclick = () => {
        const targetId = Number(roomChangeSelect.value || 0);
        if (!targetId) return;
        const target = safeArray(window.patients).find(x => x && Number(x.id) === targetId);
        const toLabel = target ? (getBedLabel(target) || target.id) : targetId;
        const msg = `Move ${fromLabel} to ${toLabel}?`;
        if (!window.confirm(msg)) return;

        if (typeof window.movePatientToBed !== "function") {
          alert("Room Change is not available. Please refresh the page and try again.");
          return;
        }

        try {
          const ok = window.movePatientToBed(p.id, targetId);
          if (ok) {
            closePatientProfileModal();
          }
        } catch (e) {
          console.warn("[patientProfileUI] movePatientToBed failed", e);
          alert("Unable to move patient to new bed. See console for details.");
        }
      };
    }

    modal.style.display = "flex";
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

    const getCheck = (id) => !!document.getElementById(id)?.checked;

    p.tele = getCheck("profTele") || getCheck("profTelePca");
    p.isolation = getCheck("profIso") || getCheck("profIsoPca");
    p.iso = p.isolation;
    p.admit = getCheck("profAdmit") || getCheck("profAdmitPca");
    p.lateDc = getCheck("profLateDc") || getCheck("profLateDcPca");

    p.drip = getCheck("profDrip");
    p.nih = getCheck("profNih");
    p.bg = getCheck("profBg");
    p.bgChecks = p.bg;
    p.tf = getCheck("profTf");

    p.ciwa = getCheck("profCiwa");
    p.cows = p.ciwa;
    p.ciwaCows = p.ciwa;

    p.restraint = getCheck("profRestraint");
    p.sitter = getCheck("profSitter");
    p.vpo = getCheck("profVpo");

    p.chg = getCheck("profChg");
    p.foley = getCheck("profFoley");
    p.q2turns = getCheck("profQ2");
    p.q2Turns = p.q2turns;
    p.strictIo = getCheck("profHeavy");
    p.heavy = p.strictIo;
    p.feeder = getCheck("profFeeder");

    p.isEmpty = false;
    p.recentlyDischarged = false;

    try {
      const after = takeAcuitySnapshot(p);
      const changes = diffSnapshots(before, after);
      appendAcuityChangedWithStaff(p, changes, "patient_profile");
    } catch (e) {
      console.warn("[eventLog] profile acuity logging failed", e);
    }

    if (typeof window.saveState === "function") window.saveState();

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

  // ----------------------------
  // Override + self-heal (STRONG)
  // ----------------------------
  function installOverrides() {
    window.openPatientProfileFromRoom = openPatientProfileFromRoom;

    // common legacy aliases
    window.openPatientProfile = (patientId) => openPatientProfileFromRoom(patientId);
    window.openPatientProfileModal = (patientId) => openPatientProfileFromRoom(patientId);

    window.closePatientProfileModal = closePatientProfileModal;
    window.savePatientProfile = savePatientProfile;
  }

  function reassert() {
    if (window.openPatientProfileFromRoom !== openPatientProfileFromRoom) {
      console.warn("[patientProfileUI] openPatientProfileFromRoom overwritten — reasserting");
      installOverrides();
    }
  }

  installOverrides();
  window.__patientProfileUIReassert = reassert;

  // keep reasserting briefly (covers late script overwrites)
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    reassert();
    if (tries >= 20) clearInterval(t);
  }, 500);

  console.log("[patientProfileUI] loaded:", window.__patientProfileUIBuild);
})();
