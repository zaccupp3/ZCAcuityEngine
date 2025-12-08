// app/app.queue.js
// ---------------------------------------------------------
// Admit Queue + Queue Assign Modal + Pre-Admit Tags (WORKING)
// Single source of truth for queue behavior.
// - Queue list rendering + add/remove/rename
// - Pre-admit tag drafting (stored on queue item)
// - Assign modal: empty bed selection + capacity-based RN/PCA filtering
// - Confirm-time recheck for bed emptiness + staff capacity
//
// Compatibility:
// - Supports legacy queue item shapes: { preTags, preGender }
// - Exposes legacy function names: renderQueueList, promptAddAdmit, removeAdmit, renameAdmit
// ---------------------------------------------------------

(function () {
  let activeQueueAssignId = null;
  let activeDraftQueueId = null;

  // --------------------------
  // small helpers
  // --------------------------
  function safeArray(v) { return Array.isArray(v) ? v : []; }
  function byId(id) { return document.getElementById(id); }

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
  }

  // --------------------------
  // Capacity helpers
  // --------------------------
  function getNurseMaxPatients(nurse) {
    // You currently treat RN max as 4 in live/queue logic.
    // If you want nurse "tele vs ms" to matter, we can pivot to nurse.maxPatients.
    return 4;
  }

  function getPcaMaxPatients(pca) {
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

    // If already using new shape, keep it.
    if (item.preAdmit && typeof item.preAdmit === "object") {
      // ensure keys exist
      item.preAdmit = {
        gender: item.preAdmit.gender || "",
        tele: !!item.preAdmit.tele,
        drip: !!item.preAdmit.drip,
        nih: !!item.preAdmit.nih,
        bg: !!item.preAdmit.bg,
        ciwa: !!item.preAdmit.ciwa,
        restraint: !!item.preAdmit.restraint,
        sitter: !!item.preAdmit.sitter,
        vpo: !!item.preAdmit.vpo,
        isolation: !!item.preAdmit.isolation,
        lateDc: !!item.preAdmit.lateDc,
        chg: !!item.preAdmit.chg,
        foley: !!item.preAdmit.foley,
        q2turns: !!item.preAdmit.q2turns,
        heavy: !!item.preAdmit.heavy,
        feeder: !!item.preAdmit.feeder
      };
      return;
    }

    // Legacy -> new shape bridge
    const legacyTags = (item.preTags && typeof item.preTags === "object") ? item.preTags : {};
    const legacyGender = (typeof item.preGender === "string") ? item.preGender : "";

    item.preAdmit = {
      gender: legacyGender || "",
      tele: !!legacyTags.tele,
      drip: !!legacyTags.drip,
      nih: !!legacyTags.nih,
      bg: !!legacyTags.bg,
      ciwa: !!legacyTags.ciwa,
      restraint: !!legacyTags.restraint,
      sitter: !!legacyTags.sitter,
      vpo: !!legacyTags.vpo,
      isolation: !!legacyTags.iso,   // legacy used "iso"
      lateDc: !!legacyTags.lateDc,

      chg: !!legacyTags.chg,
      foley: !!legacyTags.foley,
      q2turns: !!legacyTags.q2,      // legacy used "q2"
      heavy: !!legacyTags.heavy,
      feeder: !!legacyTags.feeder
    };
  }

  function buildPreAdmitTagsText(draft) {
    if (!draft) return "";
    const out = [];
    if (draft.gender) out.push(`Gender ${draft.gender}`);
    const map = [
      ["tele","Tele"],["drip","Drip"],["nih","NIH"],["bg","BG"],["ciwa","CIWA/COWS"],
      ["restraint","Restraint"],["sitter","Sitter"],["vpo","VPO"],["isolation","ISO"],["lateDc","Late DC"],
      ["chg","CHG"],["foley","Foley"],["q2turns","Q2"],["heavy","Heavy"],["feeder","Feeder"]
    ];
    map.forEach(([k,label]) => { if (draft[k]) out.push(label); });
    return out.join(", ");
  }

  // Copy pre-admit tags into your canonical patient record
  function applyPreAdmitToPatient(targetPatient, queueItem) {
    if (!targetPatient || !queueItem) return;
    ensurePreAdmitShape(queueItem);

    const d = queueItem.preAdmit;
    if (!d || typeof d !== "object") return;

    if (typeof d.gender === "string" && d.gender) targetPatient.gender = d.gender;

    const keys = [
      "tele","drip","nih","bg","ciwa","restraint","sitter","vpo","isolation","lateDc",
      "chg","foley","q2turns","heavy","feeder"
    ];
    keys.forEach(k => {
      if (typeof d[k] === "boolean") targetPatient[k] = d[k];
    });
  }

  // --------------------------
  // Queue list rendering
  // --------------------------
  function renderQueueList() {
    const el = byId("queueList");
    if (!el) return;

    const q = safeArray(window.admitQueue);
    if (!q.length) {
      el.innerHTML = `<div style="opacity:0.7;padding:8px 0;">No admits in queue.</div>`;
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

      // Keep it in sync visually
      item.preAdmitTagsText = tagsText;

      return `
        <div class="queue-item">
          <div class="queue-item-header">
            <div class="queue-item-title"><strong>${String(name).replace(/</g,"&lt;")}</strong></div>
            <div class="queue-item-actions">
              <button class="queue-btn" onclick="openQueueAssignModal(${item.id})">Assign</button>
              <button class="queue-btn" onclick="editQueuedAdmitName(${item.id})">Edit Name</button>
              <button class="queue-btn" onclick="openAdmitDraftModal(${item.id})">Pre-Admit Tags</button>
              <button class="queue-btn" onclick="removeQueuedAdmit(${item.id})">Remove</button>
            </div>
          </div>
          ${tagsText ? `<div class="queue-item-tags"><strong>Pre-admit:</strong> ${String(tagsText).replace(/</g,"&lt;")}</div>` : ""}
        </div>
      `;
    }).join("");

    if (typeof window.saveState === "function") window.saveState();
  }

  function promptAddAdmit() {
    const name = prompt("Admit name (can be edited anytime until placed):", "Admit");
    if (name == null) return;

    const item = {
      id: nextQueueId(),
      name: String(name || "Admit"),
      createdAt: Date.now(),
      preAdmit: {
        gender: "",
        tele: false, drip: false, nih: false, bg: false, ciwa: false,
        restraint: false, sitter: false, vpo: false, isolation: false, lateDc: false,
        chg: false, foley: false, q2turns: false, heavy: false, feeder: false
      },
      preAdmitTagsText: ""
    };

    window.admitQueue = safeArray(window.admitQueue);
    window.admitQueue.push(item);

    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();
  }

  function removeQueuedAdmit(id) {
    window.admitQueue = safeArray(window.admitQueue).filter(x => x && Number(x.id) !== Number(id));
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

  // Legacy compatibility: some code calls renameAdmit(id, "Name")
  function renameAdmit(id, newName) {
    const item = getQueueItem(id);
    if (!item) return;
    item.name = String(newName || "").trim() || "Admit";
    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();
  }

  // Legacy compatibility: some code calls removeAdmit(id)
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

    // Beds: only truly empty beds
    const empties = safeArray(window.patients)
      .filter(p => p && p.isEmpty)
      .sort((a, b) => getRoomNumberCompat(a) - getRoomNumberCompat(b));

    if (bedSel) {
      bedSel.innerHTML = empties.length
        ? empties.map(p => `<option value="${p.id}">Room ${p.room || p.id}</option>`).join("")
        : `<option value="">(No empty beds)</option>`;
      bedSel.disabled = !empties.length;
    }

    // RNs: filter by capacity
    const allRns = safeArray(window.currentNurses);
    const availableRns = allRns.filter(n => n && !isRnAtCapacity(n));

    if (rnSel) {
      rnSel.innerHTML = availableRns.length
        ? availableRns.map(n => {
            const cur = countActiveAssignedPatients(n);
            const max = getNurseMaxPatients(n);
            return `<option value="${n.id}">${n.name || `RN ${n.id}`} (${cur}/${max})</option>`;
          }).join("")
        : `<option value="">(No available RNs)</option>`;
      rnSel.disabled = !availableRns.length;
    }

    // PCAs: filter by capacity
    const allPcas = safeArray(window.currentPcas);
    const availablePcas = allPcas.filter(p => p && !isPcaAtCapacity(p));

    if (pcaSel) {
      pcaSel.innerHTML = availablePcas.length
        ? availablePcas.map(p => {
            const cur = countActiveAssignedPatients(p);
            const max = getPcaMaxPatients(p);
            return `<option value="${p.id}">${p.name || `PCA ${p.id}`} (${cur}/${max})</option>`;
          }).join("")
        : `<option value="">(No available PCAs)</option>`;
      pcaSel.disabled = !availablePcas.length;
    }
  }

  function confirmQueueAssign() {
    const queueId = activeQueueAssignId;
    if (queueId == null) return;

    const bedSel = byId("queueAssignBed");
    const rnSel = byId("queueAssignNurse");
    const pcaSel = byId("queueAssignPca");

    const bedPatientId = Number(bedSel?.value || 0);
    const rnId = Number(rnSel?.value || 0);
    const pcaId = Number(pcaSel?.value || 0);

    if (!bedPatientId) return alert("Please select an empty bed.");
    if (!rnId) return alert("Please select a receiving RN.");
    if (!pcaId) return alert("Please select a receiving PCA.");

    const item = getQueueItem(queueId);
    if (!item) {
      alert("That admit is no longer in the queue.");
      closeQueueAssignModal();
      return;
    }

    const bed = getPatientByIdCompat(bedPatientId);
    if (!bed || !bed.isEmpty) {
      alert("Selected bed is not empty anymore. Please re-open and pick an empty bed.");
      hydrateQueueAssignSelects(queueId);
      return;
    }

    const rn = safeArray(window.currentNurses).find(n => n && Number(n.id) === rnId);
    const pca = safeArray(window.currentPcas).find(p => p && Number(p.id) === pcaId);

    // Re-check capacity at confirm time
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

    // Activate bed + mark as admit
    bed.isEmpty = false;
    bed.recentlyDischarged = false;
    bed.admit = true;

    // Copy pre-admit tags into patient record
    applyPreAdmitToPatient(bed, item);

    // Assign to RN/PCA arrays
    rn.patients = safeArray(rn.patients);
    if (!rn.patients.includes(bed.id)) rn.patients.push(bed.id);

    pca.patients = safeArray(pca.patients);
    if (!pca.patients.includes(bed.id)) pca.patients.push(bed.id);

    // Remove from queue
    window.admitQueue = safeArray(window.admitQueue).filter(x => x && Number(x.id) !== Number(queueId));

    // Save + refresh
    saveAndRefreshAll();
    closeQueueAssignModal();
  }

  // --------------------------
  // Pre-admit tags modal
  // --------------------------
  function openAdmitDraftModal(queueId) {
    const modal = byId("admitDraftModal");
    if (!modal) return alert("admitDraftModal not found in index.html");

    activeDraftQueueId = queueId;

    const item = getQueueItem(queueId);
    if (!item) return;

    ensurePreAdmitShape(item);
    const d = item.preAdmit;

    const genderSel = byId("admitDraftGender");
    if (genderSel) genderSel.value = d.gender || "";

    const set = (id, val) => { const el = byId(id); if (el) el.checked = !!val; };

    // RN pre tags
    set("adTele", d.tele);
    set("adDrip", d.drip);
    set("adNih", d.nih);
    set("adBg", d.bg);
    set("adCiwa", d.ciwa);
    set("adRestraint", d.restraint);
    set("adSitter", d.sitter);
    set("adVpo", d.vpo);
    set("adIso", d.isolation);
    set("adLateDc", d.lateDc);

    // PCA pre tags
    set("adChg", d.chg);
    set("adFoley", d.foley);
    set("adQ2", d.q2turns);
    set("adHeavy", d.heavy);
    set("adFeeder", d.feeder);

    const title = byId("admitDraftTitle");
    if (title) title.textContent = `Pre-Admit Tags – ${item.name || "Admit"}`;

    modal.style.display = "flex";
  }

  function closeAdmitDraftModal() {
    const modal = byId("admitDraftModal");
    if (modal) modal.style.display = "none";
    activeDraftQueueId = null;
  }

  function saveAdmitDraftFromModal() {
    const queueId = activeDraftQueueId;
    if (queueId == null) return;

    const item = getQueueItem(queueId);
    if (!item) return;

    ensurePreAdmitShape(item);
    const d = item.preAdmit;

    const genderSel = byId("admitDraftGender");
    d.gender = (genderSel && typeof genderSel.value === "string") ? genderSel.value : "";

    const get = (id) => !!(byId(id) && byId(id).checked);

    // RN pre tags
    d.tele = get("adTele");
    d.drip = get("adDrip");
    d.nih = get("adNih");
    d.bg = get("adBg");
    d.ciwa = get("adCiwa");
    d.restraint = get("adRestraint");
    d.sitter = get("adSitter");
    d.vpo = get("adVpo");
    d.isolation = get("adIso");
    d.lateDc = get("adLateDc");

    // PCA pre tags
    d.chg = get("adChg");
    d.foley = get("adFoley");
    d.q2turns = get("adQ2");
    d.heavy = get("adHeavy");
    d.feeder = get("adFeeder");

    item.preAdmitTagsText = buildPreAdmitTagsText(d);

    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();

    closeAdmitDraftModal();
  }

  // --------------------------
  // Expose (single source of truth + compatibility)
  // --------------------------
  window.renderQueueList = renderQueueList;
  window.promptAddAdmit = promptAddAdmit;

  // preferred names
  window.removeQueuedAdmit = removeQueuedAdmit;
  window.editQueuedAdmitName = editQueuedAdmitName;

  // legacy names (do not remove)
  window.removeAdmit = removeAdmit;
  window.renameAdmit = renameAdmit;

  window.openQueueAssignModal = openQueueAssignModal;
  window.closeQueueAssignModal = closeQueueAssignModal;
  window.confirmQueueAssign = confirmQueueAssign;

  window.openAdmitDraftModal = openAdmitDraftModal;
  window.closeAdmitDraftModal = closeAdmitDraftModal;
  window.saveAdmitDraftFromModal = saveAdmitDraftFromModal;
})();