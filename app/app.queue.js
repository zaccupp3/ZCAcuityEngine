// app/app.queue.js
// ---------------------------------------------------------
// Admit Queue + Queue Assign Modal + Pre-Admit Tags (WORKING)
// Single source of truth for queue behavior.
// - Queue list rendering + add/remove/rename
// - Pre-admit tag drafting (stored on queue item)
// - Assign modal: empty bed selection + capacity-based RN/PCA filtering
// - Confirm-time recheck for bed emptiness + staff capacity
//
// ✅ EVENT LOG (Jan 2026):
// - Logs queue + placement events for auditability:
//   * ADMIT_ADDED_TO_QUEUE
//   * ADMIT_REMOVED_FROM_QUEUE
//   * PRE_ADMIT_TAGS_UPDATED
//   * ADMIT_PLACED (queue -> bed + RN/PCA)
//
// Compatibility:
// - Supports legacy queue item shapes: { preTags, preGender }
// - Exposes legacy function names: renderQueueList, promptAddAdmit, removeAdmit, renameAdmit
//
// PATCH (Jan 2026):
// - Add non-prompt add API: window.addAdmitToQueue(name)
// - Alias: window.addToAdmitQueue -> addAdmitToQueue (LIVE inline button expects it)
// - Horizontal, readable queue tiles in #queueList (wrap + min widths)
// ---------------------------------------------------------

(function () {
  let activeQueueAssignId = null;
  let activeDraftQueueId = null;

  let __preAdmitModal = null; // { overlay, card }

  // --------------------------
  // small helpers
  // --------------------------
  function safeArray(v) { return Array.isArray(v) ? v : []; }
  function byId(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function stableStaffId(owner) {
    if (!owner) return null;
    return owner.staff_id || owner.staffId || owner.staffID || owner.id || null;
  }

  function getRoomNumberCompat(p) {
    if (typeof window.getRoomNumber === "function") return window.getRoomNumber(p);
    if (!p) return 9999;
    const s = String((typeof p === "object") ? (p.room ?? p.id ?? "") : p).trim();
    const m = s.match(/\d+/);
    return m ? Number(m[0]) : 9999;
  }

  function getPatientByIdCompat(id) {
    if (typeof window.getPatientById === "function") return window.getPatientById(id);
    return safeArray(window.patients).find(p => p && Number(p.id) === Number(id)) || null;
  }

  function getQueueItem(queueId) {
    return safeArray(window.admitQueue).find(x => x && Number(x.id) === Number(queueId)) || null;
  }

  function nextQueueId() {
    const cur = (typeof window.nextQueueId === "number" ? window.nextQueueId : 1);
    window.nextQueueId = cur + 1;
    return cur;
  }

  function saveAndRefreshAll() {
    if (typeof window.saveState === "function") window.saveState();
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    renderQueueList();

    try { if (typeof window.refreshUnitPulse === "function") window.refreshUnitPulse(); } catch (_) {}
  }

  // --------------------------
  // ✅ Event log helpers
  // --------------------------
  function ensureEventLog() {
    if (!Array.isArray(window.eventLog)) window.eventLog = [];
  }

  function appendEventCompat(type, payload) {
    if (typeof window.appendEvent === "function") {
      try { window.appendEvent(type, payload); return; } catch (e) { console.warn("appendEvent failed", e); }
    }
    ensureEventLog();
    window.eventLog.push({
      type,
      ts: Date.now(),
      unit_id: window.activeUnitId || null,
      context: "live",
      payload: payload || {}
    });
  }

  // --------------------------
  // Capacity helpers
  // --------------------------
  function getNurseMaxPatients() {
    return 4;
  }

  function getPcaMaxPatients() {
    const shift = (typeof window.pcaShift === "string" ? window.pcaShift : "day");
    return shift === "night" ? 9 : 8;
  }

  function countActiveAssignedPatients(owner) {
    const ids = safeArray(owner?.patients);
    let count = 0;
    ids.forEach(pid => {
      const p = getPatientByIdCompat(pid);
      if (p && !p.isEmpty) count++;
    });
    return count;
  }

  function isRnAtCapacity(nurse) {
    const cur = countActiveAssignedPatients(nurse);
    return cur >= getNurseMaxPatients(nurse);
  }

  function isPcaAtCapacity(pca) {
    const cur = countActiveAssignedPatients(pca);
    return cur >= getPcaMaxPatients(pca);
  }

  // --------------------------
  // Queue item draft schema normalization
  // --------------------------
  function ensurePreAdmitShape(item) {
    if (!item || typeof item !== "object") return;

    if (item.preAdmit && typeof item.preAdmit === "object") {
      item.preAdmit = {
        gender: item.preAdmit.gender || "",
        tele: !!item.preAdmit.tele,
        drip: !!item.preAdmit.drip,
        nih: !!item.preAdmit.nih,
        bg: !!item.preAdmit.bg,
        tf: !!item.preAdmit.tf,
        ciwa: !!item.preAdmit.ciwa,
        cows: !!(item.preAdmit.cows || (!item.preAdmit.ciwa && item.preAdmit.ciwaCows)),
        psych: !!item.preAdmit.psych,
        prns: !!item.preAdmit.prns,
        emu: !!item.preAdmit.emu,
        restraint: !!item.preAdmit.restraint,
        sitter: !!item.preAdmit.sitter,
        vpo: !!item.preAdmit.vpo,
        isolation: !!item.preAdmit.isolation,
        admit: !!item.preAdmit.admit,
        lateDc: !!item.preAdmit.lateDc,

        chg: !!item.preAdmit.chg,
        foley: !!item.preAdmit.foley,
        q2turns: !!item.preAdmit.q2turns,
        strictIo: !!(item.preAdmit.strictIo || item.preAdmit.heavy),
        heavy: !!(item.preAdmit.strictIo || item.preAdmit.heavy),
        feeder: !!item.preAdmit.feeder
      };
      return;
    }

    const legacyTags = (item.preTags && typeof item.preTags === "object") ? item.preTags : {};
    const legacyGender = (typeof item.preGender === "string") ? item.preGender : "";

    item.preAdmit = {
      gender: legacyGender || "",
      tele: !!legacyTags.tele,
      drip: !!legacyTags.drip,
      nih: !!legacyTags.nih,
      bg: !!legacyTags.bg,
      tf: !!legacyTags.tf,
      ciwa: !!legacyTags.ciwa,
      cows: !!(legacyTags.cows || (!legacyTags.ciwa && legacyTags.ciwaCows)),
      psych: !!legacyTags.psych,
      prns: !!legacyTags.prns,
      emu: !!legacyTags.emu,
      restraint: !!legacyTags.restraint,
      sitter: !!legacyTags.sitter,
      vpo: !!legacyTags.vpo,
      isolation: !!legacyTags.iso,
      admit: !!legacyTags.admit,
      lateDc: !!legacyTags.lateDc,

      chg: !!legacyTags.chg,
      foley: !!legacyTags.foley,
      q2turns: !!legacyTags.q2,
      strictIo: !!(legacyTags.strictIo || legacyTags.heavy),
      heavy: !!(legacyTags.strictIo || legacyTags.heavy),
      feeder: !!legacyTags.feeder
    };
  }

  function buildPreAdmitTagsText(draft) {
    if (!draft) return "";
    const out = [];
    const map = [
      ["tele","Tele"],["drip","Drip"],["nih","NIH"],["bg","BG"],["tf","TF"],["ciwa","CIWA"],["cows","COWS"],["psych","Psych"],["prns","PRNs"],["emu","EMU"],
      ["restraint","Restraint"],["sitter","Sitter"],["vpo","VPO"],["isolation","ISO"],["admit","Admit"],["lateDc","Late DC"],
      ["chg","CHG"],["foley","Foley"],["q2turns","Totals"],["strictIo","Strict I/O"],["feeder","Feeder"]
    ];
    map.forEach(([k,label]) => { if (draft[k]) out.push(label); });
    return out.join(", ");
  }

  function applyPreAdmitToPatient(targetPatient, queueItem) {
    if (!targetPatient || !queueItem) return;
    ensurePreAdmitShape(queueItem);

    const d = queueItem.preAdmit;
    if (!d || typeof d !== "object") return;

    if (typeof d.gender === "string" && d.gender) targetPatient.gender = d.gender;

    targetPatient.tele = !!d.tele;
    targetPatient.isolation = !!d.isolation;
    targetPatient.iso = targetPatient.isolation;

    if (typeof d.admit === "boolean") targetPatient.admit = !!d.admit;
    targetPatient.lateDc = !!d.lateDc;

    targetPatient.drip = !!d.drip;
    targetPatient.nih = !!d.nih;
    targetPatient.bg = !!d.bg;
    targetPatient.bgChecks = !!d.bg;
    targetPatient.tf = !!d.tf;
    targetPatient.ciwa = !!d.ciwa;
    targetPatient.cows = !!d.cows;
    targetPatient.psych = !!d.psych;
    targetPatient.prns = !!d.prns;
    targetPatient.ciwaCows = !!(d.ciwa || d.cows);
    targetPatient.emu = !!d.emu;
    targetPatient.restraint = !!d.restraint;
    targetPatient.sitter = !!d.sitter;
    targetPatient.vpo = !!d.vpo;

    targetPatient.chg = !!d.chg;
    targetPatient.foley = !!d.foley;
    targetPatient.q2turns = !!d.q2turns;
    targetPatient.q2Turns = !!d.q2turns;
    targetPatient.strictIo = !!(d.strictIo || d.heavy);
    targetPatient.heavy = targetPatient.strictIo;
    targetPatient.feeder = !!d.feeder;
  }

  // --------------------------
  // Queue list rendering
  // --------------------------
  function ensureQueueListLayout(el) {
    el.style.display = "flex";
    el.style.flexDirection = "column";
    el.style.flexWrap = "nowrap";
    el.style.gap = "6px";
    el.style.alignItems = "stretch";
  }

  function getEmptyBeds() {
    return safeArray(window.patients)
      .filter(p => p && p.isEmpty)
      .sort((a, b) => getRoomNumberCompat(a) - getRoomNumberCompat(b));
  }

  function currentAssignableRns() {
    return safeArray(window.currentNurses)
      .filter(n => n && !isRnAtCapacity(n));
  }

  function currentAssignablePcas() {
    return safeArray(window.currentPcas)
      .filter(p => p && !isPcaAtCapacity(p));
  }

  function renderSelectOptions(items, selectedValue, placeholder, labeler) {
    const selected = String(selectedValue || "");
    const base = `<option value="">${escapeHtml(placeholder)}</option>`;
    const opts = safeArray(items).map(item => {
      const value = String(item?.id || "");
      const label = labeler ? labeler(item) : value;
      return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
    return base + opts;
  }

  function renderQueueList() {
    const el = byId("queueList");
    if (!el) return;

    ensureQueueListLayout(el);

    const q = safeArray(window.admitQueue);
    if (!q.length) {
      el.innerHTML = `<div style="opacity:0.7;padding:6px 0;">No admits in queue.</div>`;
      return;
    }

    el.innerHTML = q.map(item => {
      if (!item) return "";
      ensurePreAdmitShape(item);

      const name = item.name || item.label || "Admit";
      const tagsText =
        (typeof item.preAdmitTagsText === "string" && item.preAdmitTagsText.trim())
          ? item.preAdmitTagsText.trim()
          : buildPreAdmitTagsText(item.preAdmit);

      item.preAdmitTagsText = tagsText;

      const levelText = item.preAdmit?.tele ? "♥" : "?";
      const notesText = tagsText || "?";
      const bedOptions = renderSelectOptions(
        getEmptyBeds(),
        item.targetBedId,
        "Room",
        p => `Room ${p.room || p.id}`
      );
      const rnOptions = renderSelectOptions(
        currentAssignableRns(),
        item.targetRnId,
        "RN",
        n => {
          const cur = countActiveAssignedPatients(n);
          return `${n.name || `RN ${n.id}`} (${cur}/${getNurseMaxPatients(n)})`;
        }
      );
      const pcaOptions = renderSelectOptions(
        currentAssignablePcas(),
        item.targetPcaId,
        "PCA",
        p => {
          const cur = countActiveAssignedPatients(p);
          return `${p.name || `PCA ${p.id}`} (${cur}/${getPcaMaxPatients(p)})`;
        }
      );
      const ready = Number(item.targetBedId || 0) && Number(item.targetRnId || 0) && Number(item.targetPcaId || 0);
      return `
        <div class="queue-item queue-item-row">
          <div class="queue-row-cell queue-row-bed">?</div>
          <div class="queue-row-cell queue-row-level">${escapeHtml(levelText)}</div>
          <div class="queue-row-main">
            <div class="queue-row-name">${escapeHtml(name)}</div>
            <div class="queue-row-notes">${escapeHtml(notesText)}</div>
          </div>
          <select class="queue-row-select" aria-label="Queue room" onchange="setQueuedAdmitDraft(${item.id}, 'targetBedId', this.value)">
            ${bedOptions}
          </select>
          <select class="queue-row-select" aria-label="Queue RN" onchange="setQueuedAdmitDraft(${item.id}, 'targetRnId', this.value)">
            ${rnOptions}
          </select>
          <select class="queue-row-select" aria-label="Queue PCA" onchange="setQueuedAdmitDraft(${item.id}, 'targetPcaId', this.value)">
            ${pcaOptions}
          </select>
          <div class="queue-row-actions">
            <button class="queue-btn queue-place-btn" onclick="placeQueuedAdmitFromDraft(${item.id})" ${ready ? "" : "disabled"}>Place</button>
            <button class="queue-btn" onclick="editQueuedAdmitName(${item.id})">Edit</button>
            <button class="queue-btn" onclick="openAdmitDraftModal(${item.id})">Tags</button>
            <button class="queue-btn" onclick="removeQueuedAdmit(${item.id})">&times;</button>
          </div>
        </div>
      `;
    }).join("");

    if (typeof window.saveState === "function") window.saveState();
  }

  // --------------------------
  // Add (prompt + non-prompt)
  // --------------------------
  function createQueueItem(name) {
    return {
      id: nextQueueId(),
      name: String(name || "Admit"),
      createdAt: Date.now(),
      preAdmit: {
        gender: "",
        tele: false,
        drip: false, nih: false, bg: false, tf: false, ciwa: false, cows: false, psych: false, prns: false, emu: false, restraint: false, sitter: false, vpo: false,
        isolation: false,
        admit: false,
        lateDc: false,
        chg: false, foley: false, q2turns: false, strictIo: false, heavy: false, feeder: false
      },
      preAdmitTagsText: "",
      targetBedId: "",
      targetRnId: "",
      targetPcaId: ""
    };
  }

  function addAdmitToQueue(name) {
    const item = createQueueItem(name);

    window.admitQueue = safeArray(window.admitQueue);
    window.admitQueue.push(item);

    appendEventCompat("ADMIT_ADDED_TO_QUEUE", {
      queue_id: item.id,
      name: item.name
    });

    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();
    return item;
  }

  function promptAddAdmit() {
    const name = prompt("Admit name (can be edited anytime until placed):", "Admit");
    if (name == null) return;
    addAdmitToQueue(String(name || "Admit"));
  }

  function removeQueuedAdmit(id) {
    const item = getQueueItem(id);

    window.admitQueue = safeArray(window.admitQueue).filter(x => x && Number(x.id) !== Number(id));

    appendEventCompat("ADMIT_REMOVED_FROM_QUEUE", {
      queue_id: Number(id),
      name: item?.name || item?.label || ""
    });

    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();
  }

  function editQueuedAdmitName(id) {
    const item = getQueueItem(id);
    if (!item) return;

    const next = prompt("Edit admit name:", item.name || "Admit");
    if (next == null) return;

    item.name = String(next || "Admit");
    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();
  }

  function renameAdmit(id, newName) {
    const item = getQueueItem(id);
    if (!item) return;
    item.name = String(newName || "").trim() || "Admit";
    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();
  }

  function setQueuedAdmitDraft(id, field, value) {
    const item = getQueueItem(id);
    if (!item) return;
    const allowed = new Set(["targetBedId", "targetRnId", "targetPcaId"]);
    if (!allowed.has(String(field || ""))) return;
    item[field] = value ? String(value) : "";
    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();
  }

  function removeAdmit(id) {
    removeQueuedAdmit(id);
  }

  // --------------------------
  // Assign modal
  // --------------------------
  function openQueueAssignModal(queueId) {
    const modal = byId("queueAssignModal");
    if (!modal) return;

    activeQueueAssignId = queueId;
    hydrateQueueAssignSelects(queueId);
    modal.style.display = "flex";
  }

  function closeQueueAssignModal() {
    const modal = byId("queueAssignModal");
    if (modal) modal.style.display = "none";
    activeQueueAssignId = null;
  }

  function hydrateQueueAssignSelects(queueId) {
    const bedSel = byId("queueAssignBed");
    const rnSel = byId("queueAssignNurse");
    const pcaSel = byId("queueAssignPca");
    const info = byId("queueAssignInfo");

    const item = getQueueItem(queueId);
    const label = item?.name || item?.label || "Admit";
    if (info) info.textContent = `Assign "${label}" to RN / PCA / bed.`;

    const empties = getEmptyBeds();

    if (bedSel) {
      bedSel.innerHTML = empties.length
        ? empties.map(p => `<option value="${p.id}">Room ${p.room || p.id}</option>`).join("")
        : `<option value="">(No empty beds)</option>`;
      bedSel.disabled = !empties.length;
    }

    const availableRns = currentAssignableRns();

    if (rnSel) {
      rnSel.innerHTML = availableRns.length
        ? availableRns.map(n => {
            const cur = countActiveAssignedPatients(n);
            const max = getNurseMaxPatients(n);
            return `<option value="${n.id}">${escapeHtml(n.name || `RN ${n.id}`)} (${cur}/${max})</option>`;
          }).join("")
        : `<option value="">(No available RNs)</option>`;
      rnSel.disabled = !availableRns.length;
    }

    const availablePcas = currentAssignablePcas();

    if (pcaSel) {
      pcaSel.innerHTML = availablePcas.length
        ? availablePcas.map(p => {
            const cur = countActiveAssignedPatients(p);
            const max = getPcaMaxPatients(p);
            return `<option value="${p.id}">${escapeHtml(p.name || `PCA ${p.id}`)} (${cur}/${max})</option>`;
          }).join("")
        : `<option value="">(No available PCAs)</option>`;
      pcaSel.disabled = !availablePcas.length;
    }
  }

  function placeQueuedAdmit(queueId, bedPatientId, rnId, pcaId) {
    if (!bedPatientId) return alert("Please select an empty bed.");
    if (!rnId) return alert("Please select a receiving RN.");
    if (!pcaId) return alert("Please select a receiving PCA.");

    const item = getQueueItem(queueId);
    if (!item) {
      alert("That admit is no longer in the queue.");
      return;
    }
    ensurePreAdmitShape(item);

    const bed = getPatientByIdCompat(bedPatientId);
    if (!bed || !bed.isEmpty) {
      alert("Selected bed is not empty anymore. Please re-open and pick an empty bed.");
      hydrateQueueAssignSelects(queueId);
      return;
    }

    const rn = safeArray(window.currentNurses).find(n => n && Number(n.id) === rnId);
    const pca = safeArray(window.currentPcas).find(p => p && Number(p.id) === pcaId);

    if (!rn || isRnAtCapacity(rn)) {
      alert("That RN is now at capacity. Please pick another RN.");
      hydrateQueueAssignSelects(queueId);
      return;
    }
    if (!pca || isPcaAtCapacity(pca)) {
      alert("That PCA is now at capacity. Please pick another PCA.");
      hydrateQueueAssignSelects(queueId);
      return;
    }

    const admitName = item.name || item.label || "Admit";
    const preAdmitSnapshot = item.preAdmit ? { ...item.preAdmit } : null;

    const rnStaffId = stableStaffId(rn);
    const pcaStaffId = stableStaffId(pca);

    bed.isEmpty = false;
    bed.recentlyDischarged = false;
    bed.admit = true;

    applyPreAdmitToPatient(bed, item);

    rn.patients = safeArray(rn.patients);
    if (!rn.patients.includes(bed.id)) rn.patients.push(bed.id);

    pca.patients = safeArray(pca.patients);
    if (!pca.patients.includes(bed.id)) pca.patients.push(bed.id);

    window.admitQueue = safeArray(window.admitQueue).filter(x => x && Number(x.id) !== Number(queueId));

    appendEventCompat("ADMIT_PLACED", {
      queue_id: Number(queueId),
      name: admitName,
      bed_patient_id: Number(bed.id),
      bed_room: bed.room || String(bed.id),

      rn_id: Number(rn.id),
      rn_name: rn.name || `RN ${rn.id}`,
      pca_id: Number(pca.id),
      pca_name: pca.name || `PCA ${pca.id}`,

      rn_staff_id: rnStaffId,
      pca_staff_id: pcaStaffId,

      pre_admit: preAdmitSnapshot
    });

    saveAndRefreshAll();
    closeQueueAssignModal();
  }

  function confirmQueueAssign() {
    const queueId = activeQueueAssignId;
    if (queueId == null) return;

    const bedSel = byId("queueAssignBed");
    const rnSel = byId("queueAssignNurse");
    const pcaSel = byId("queueAssignPca");

    placeQueuedAdmit(
      queueId,
      Number(bedSel?.value || 0),
      Number(rnSel?.value || 0),
      Number(pcaSel?.value || 0)
    );
  }

  function placeQueuedAdmitFromDraft(id) {
    const item = getQueueItem(id);
    if (!item) return;
    placeQueuedAdmit(
      Number(id),
      Number(item.targetBedId || 0),
      Number(item.targetRnId || 0),
      Number(item.targetPcaId || 0)
    );
  }

  // --------------------------
  // Pre-admit tags modal
  // --------------------------
  function destroyPreAdmitModal() {
    try {
      if (__preAdmitModal?.overlay?.parentNode) __preAdmitModal.overlay.parentNode.removeChild(__preAdmitModal.overlay);
    } catch (_) {}
    __preAdmitModal = null;
  }

  function closeAdmitDraftModal() {
    destroyPreAdmitModal();
    activeDraftQueueId = null;
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

  function centerCard(card) {
    if (!card) return;
    card.style.left = "50%";
    card.style.top = "50%";
    card.style.transform = "translate(-50%, -50%)";
  }

  function tagItem(id, label, checked, disabled) {
    return `
      <label class="pp-tag">
        <input type="checkbox" id="${id}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}/>
        <span>${escapeHtml(label)}</span>
      </label>
    `;
  }

  function openAdmitDraftModal(queueId) {
    const item = getQueueItem(queueId);
    if (!item) return;

    activeDraftQueueId = queueId;
    ensurePreAdmitShape(item);
    const d = item.preAdmit || {};

    destroyPreAdmitModal();

    const overlay = document.createElement("div");
    overlay.className = "pp-overlay";
    overlay.style.display = "flex";

    const card = document.createElement("div");
    card.className = "pp-card";
    card.style.position = "fixed";
    card.style.zIndex = "10001";

    card.innerHTML = `
      <div class="pp-header" id="__padHeader">
        <div class="pp-title" id="__padTitle">Pre-Admit Tags</div>
        <button class="pp-close" type="button" id="__padClose">×</button>
      </div>
      <div class="pp-body" id="__padBody"></div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const titleEl = card.querySelector("#__padTitle");
    if (titleEl) titleEl.textContent = `Pre-Admit Tags — ${item.name || "Admit"}`;

    const bodyEl = card.querySelector("#__padBody");
    if (bodyEl) {
      bodyEl.innerHTML = `
        <div class="pp-grid">
          <div class="pp-col">
            <h4>RN Pre-Admit Tags</h4>
            <div class="pp-taglist">
              ${tagItem("__padTele", "Tele", !!d.tele)}
              ${tagItem("__padDrip", "Drip", !!d.drip)}
              ${tagItem("__padNih", "NIH", !!d.nih)}
              ${tagItem("__padBg", "BG", !!d.bg)}
              ${tagItem("__padTf", "TF", !!d.tf)}
              ${tagItem("__padCiwa", "CIWA", !!d.ciwa)}
              ${tagItem("__padCows", "COWS", !!d.cows)}
              ${tagItem("__padPsych", "Psych", !!d.psych)}
              ${tagItem("__padPrns", "PRNs", !!d.prns)}
              ${tagItem("__padEmu", "EMU", !!d.emu)}
              ${tagItem("__padRestraint", "Restraint", !!d.restraint)}
              ${tagItem("__padSitter", "Sitter", !!d.sitter)}
              ${tagItem("__padVpo", "VPO", !!d.vpo)}
              ${tagItem("__padIso", "Isolation", !!d.isolation)}
              ${tagItem("__padAdmit", "Admit", true, true)}
              ${tagItem("__padLateDc", "Late DC", !!d.lateDc)}
            </div>
          </div>

          <div class="pp-col">
            <h4>PCA Pre-Admit Tags</h4>
            <div class="pp-taglist">
              ${tagItem("__padTelePca", "Tele", !!d.tele)}
              ${tagItem("__padIsoPca", "Isolation", !!d.isolation)}
              ${tagItem("__padAdmitPca", "Admit", true, true)}
              ${tagItem("__padLateDcPca", "Late DC", !!d.lateDc)}
              ${tagItem("__padChg", "CHG", !!d.chg)}
              ${tagItem("__padFoley", "Foley", !!d.foley)}
              ${tagItem("__padQ2", "Totals", !!d.q2turns)}
              ${tagItem("__padHeavy", "Strict I/O", !!(d.strictIo || d.heavy))}
              ${tagItem("__padFeeder", "Feeder", !!d.feeder)}
            </div>
          </div>
        </div>

        <div class="pp-actions">
          <button class="btn" type="button" id="__padCancel">Cancel</button>
          <button class="btn btn-primary" type="button" id="__padSave">Save</button>
        </div>
      `;
    }

    const closeBtn = card.querySelector("#__padClose");
    if (closeBtn) closeBtn.onclick = closeAdmitDraftModal;

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeAdmitDraftModal();
    });

    if (!window.__padEscWired) {
      window.__padEscWired = true;
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          if (__preAdmitModal?.overlay) closeAdmitDraftModal();
        }
      });
    }

    function wireMirror(aId, bId) {
      const a = card.querySelector(aId);
      const b = card.querySelector(bId);
      if (!a || !b) return;
      const sync = (src, dst) => { dst.checked = !!src.checked; };
      a.addEventListener("change", () => sync(a, b));
      b.addEventListener("change", () => sync(b, a));
    }
    wireMirror("#__padTele", "#__padTelePca");
    wireMirror("#__padIso", "#__padIsoPca");
    wireMirror("#__padLateDc", "#__padLateDcPca");

    const cancelBtn = card.querySelector("#__padCancel");
    if (cancelBtn) cancelBtn.onclick = closeAdmitDraftModal;

    const saveBtn = card.querySelector("#__padSave");
    if (saveBtn) saveBtn.onclick = saveAdmitDraftFromModal;

    makeDraggable(card, card.querySelector("#__padHeader"));
    centerCard(card);

    __preAdmitModal = { overlay, card };
  }

  function saveAdmitDraftFromModal() {
    const queueId = activeDraftQueueId;
    if (queueId == null) return;

    const item = getQueueItem(queueId);
    if (!item) return;

    ensurePreAdmitShape(item);
    const d = item.preAdmit;

    const card = __preAdmitModal?.card || document;

    const getCheck = (sel) => !!card.querySelector(sel)?.checked;

    d.tele = getCheck("#__padTele") || getCheck("#__padTelePca");
    d.isolation = getCheck("#__padIso") || getCheck("#__padIsoPca");
    d.lateDc = getCheck("#__padLateDc") || getCheck("#__padLateDcPca");

    d.drip = getCheck("#__padDrip");
    d.nih = getCheck("#__padNih");
    d.bg = getCheck("#__padBg");
    d.tf = getCheck("#__padTf");
    d.ciwa = getCheck("#__padCiwa");
    d.cows = getCheck("#__padCows");
    d.psych = getCheck("#__padPsych");
    d.prns = getCheck("#__padPrns");
    d.emu = getCheck("#__padEmu");
    d.restraint = getCheck("#__padRestraint");
    d.sitter = getCheck("#__padSitter");
    d.vpo = getCheck("#__padVpo");

    d.chg = getCheck("#__padChg");
    d.foley = getCheck("#__padFoley");
    d.q2turns = getCheck("#__padQ2");
    d.strictIo = getCheck("#__padHeavy");
    d.heavy = d.strictIo;
    d.feeder = getCheck("#__padFeeder");

    d.admit = false;

    item.preAdmitTagsText = buildPreAdmitTagsText(d);

    appendEventCompat("PRE_ADMIT_TAGS_UPDATED", {
      queue_id: Number(queueId),
      name: item.name || item.label || "Admit",
      tags_text: item.preAdmitTagsText || "",
      pre_admit: { ...d }
    });

    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();

    closeAdmitDraftModal();
  }

  // --------------------------
  // Expose (including LIVE inline expectations)
  // --------------------------
  window.renderQueueList = renderQueueList;
  window.renderAdmitQueueList = renderQueueList;

  window.promptAddAdmit = promptAddAdmit;

  window.addAdmitToQueue = addAdmitToQueue;
  window.addToAdmitQueue = addAdmitToQueue; // ✅ LIVE inline button uses this today

  window.removeQueuedAdmit = removeQueuedAdmit;
  window.editQueuedAdmitName = editQueuedAdmitName;
  window.setQueuedAdmitDraft = setQueuedAdmitDraft;
  window.placeQueuedAdmitFromDraft = placeQueuedAdmitFromDraft;

  window.removeAdmit = removeAdmit;
  window.renameAdmit = renameAdmit;

  window.openQueueAssignModal = openQueueAssignModal;
  window.closeQueueAssignModal = closeQueueAssignModal;
  window.confirmQueueAssign = confirmQueueAssign;

  window.openAdmitDraftModal = openAdmitDraftModal;
  window.closeAdmitDraftModal = closeAdmitDraftModal;
  window.saveAdmitDraftFromModal = saveAdmitDraftFromModal;
})();
