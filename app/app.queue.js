// app/app.queue.js
// ---------------------------------------------------------
// Admit Queue + Queue Assign Modal + Pre-Admit Tags (WORKING)
// PLUS: Capacity-aware RN/PCA dropdowns (filters out full staff)
// ---------------------------------------------------------

(function () {
  let activeQueueAssignId = null;
  let activeDraftQueueId = null;

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

  // =========================================================
  // Capacity helpers (edit defaults here if desired)
  // =========================================================
  function getNurseMaxPatients(nurse) {
    // RN: 4 patients max (day + night)
    return 4;
  }

  function getPcaMaxPatients(pca) {
    // PCA: 8 max day, 9 max night
    const shift = (typeof window.pcaShift === "string" ? window.pcaShift : "day");
    return shift === "night" ? 9 : 8;
  }

  function countActiveAssignedPatients(owner) {
    // Only count real, non-empty patients
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

  // =========================================================
  // Queue List
  // =========================================================
  function renderQueueList() {
    const el = byId("queueList");
    if (!el) return;

    const q = safeArray(window.admitQueue);
    if (!q.length) {
      el.innerHTML = `<div style="opacity:0.7;padding:8px 0;">No admits in queue.</div>`;
      return;
    }

    el.innerHTML = q.map(item => {
      const name = item?.name || item?.label || "Admit";
      const tags = (item?.preAdmitTagsText || "").trim();
      return `
        <div class="queue-item">
          <div class="queue-item-header">
            <div class="queue-item-title"><strong>${name}</strong></div>
            <div class="queue-item-actions">
              <button class="queue-btn" onclick="openQueueAssignModal(${item.id})">Assign</button>
              <button class="queue-btn" onclick="editQueuedAdmitName(${item.id})">Edit Name</button>
              <button class="queue-btn" onclick="openAdmitDraftModal(${item.id})">Pre-Admit Tags</button>
              <button class="queue-btn" onclick="removeQueuedAdmit(${item.id})">Remove</button>
            </div>
          </div>
          ${tags ? `<div class="queue-item-tags"><strong>Pre-admit:</strong> ${tags}</div>` : ""}
        </div>
      `;
    }).join("");
  }

  function promptAddAdmit() {
    const name = prompt("Admit name (can be edited anytime until placed):", "Admit");
    if (name == null) return;

    const id = (typeof window.nextQueueId === "number" ? window.nextQueueId : 1);

    const item = {
      id,
      name: String(name || "Admit"),
      createdAt: Date.now(),
      preAdmit: {
        gender: "",

        // RN-ish
        tele: false, drip: false, nih: false, bg: false, ciwa: false,
        restraint: false, sitter: false, vpo: false, isolation: false, lateDc: false,

        // PCA-ish
        chg: false, foley: false, q2turns: false, heavy: false, feeder: false
      },
      preAdmitTagsText: ""
    };

    window.admitQueue = safeArray(window.admitQueue);
    window.admitQueue.push(item);
    window.nextQueueId = id + 1;

    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();
  }

  function removeQueuedAdmit(id) {
    window.admitQueue = safeArray(window.admitQueue).filter(x => x && x.id !== id);
    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();
  }

  function editQueuedAdmitName(id) {
    const q = safeArray(window.admitQueue);
    const item = q.find(x => x && x.id === id);
    if (!item) return;

    const next = prompt("Edit admit name:", item.name || "Admit");
    if (next == null) return;

    item.name = String(next || "Admit");
    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();
  }

  // =========================================================
  // Queue Assign Modal
  // =========================================================
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

    const qItem = safeArray(window.admitQueue).find(x => x && x.id === queueId);
    const label = qItem?.name || qItem?.label || "Admit";
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

    // ✅ FILTER RNs by capacity
    const allRns = safeArray(window.currentNurses);
    const availableRns = allRns.filter(n => !isRnAtCapacity(n));

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

    // ✅ FILTER PCAs by capacity
    const allPcas = safeArray(window.currentPcas);
    const availablePcas = allPcas.filter(p => !isPcaAtCapacity(p));

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

  function applyPreAdmitToPatient(targetPatient, queueItem) {
    if (!targetPatient || !queueItem) return;
    const draft = (queueItem.preAdmit && typeof queueItem.preAdmit === "object") ? queueItem.preAdmit : null;
    if (!draft) return;

    if (typeof draft.gender === "string" && draft.gender) targetPatient.gender = draft.gender;

    const keys = [
      "tele","drip","nih","bg","ciwa","restraint","sitter","vpo","isolation","lateDc",
      "chg","foley","q2turns","heavy","feeder"
    ];
    keys.forEach(k => { if (typeof draft[k] === "boolean") targetPatient[k] = draft[k]; });
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

    const q = safeArray(window.admitQueue);
    const item = q.find(x => x && x.id === queueId);
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

    const rn = safeArray(window.currentNurses).find(n => Number(n.id) === rnId);
    const pca = safeArray(window.currentPcas).find(p => Number(p.id) === pcaId);

    // ✅ Re-check capacity at confirm time (prevents race conditions)
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

    // Activate bed
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
    window.admitQueue = q.filter(x => x && x.id !== queueId);

    // Save + refresh
    if (typeof window.saveState === "function") window.saveState();
    renderQueueList();
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();

    closeQueueAssignModal();
  }

  // =========================================================
  // Pre-Admit Tags Modal (wired)
  // =========================================================
  function openAdmitDraftModal(queueId) {
    const modal = byId("admitDraftModal");
    if (!modal) return alert("admitDraftModal not found in index.html");

    activeDraftQueueId = queueId;
    const item = safeArray(window.admitQueue).find(x => x && x.id === queueId);
    if (!item) return;

    if (!item.preAdmit || typeof item.preAdmit !== "object") {
      item.preAdmit = {
        gender: "",
        tele:false, drip:false, nih:false, bg:false, ciwa:false, restraint:false, sitter:false, vpo:false, isolation:false, lateDc:false,
        chg:false, foley:false, q2turns:false, heavy:false, feeder:false
      };
    }

    const d = item.preAdmit;

    const genderSel = byId("admitDraftGender");
    if (genderSel) genderSel.value = d.gender || "";

    const set = (id, val) => { const el = byId(id); if (el) el.checked = !!val; };

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

    const item = safeArray(window.admitQueue).find(x => x && x.id === queueId);
    if (!item) return;

    if (!item.preAdmit || typeof item.preAdmit !== "object") item.preAdmit = {};
    const d = item.preAdmit;

    const genderSel = byId("admitDraftGender");
    d.gender = (genderSel && typeof genderSel.value === "string") ? genderSel.value : "";

    const get = (id) => !!(byId(id) && byId(id).checked);

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

  // =========================================================
  // Expose
  // =========================================================
  window.renderQueueList = renderQueueList;
  window.promptAddAdmit = promptAddAdmit;
  window.removeQueuedAdmit = removeQueuedAdmit;
  window.editQueuedAdmitName = editQueuedAdmitName;

  window.openQueueAssignModal = openQueueAssignModal;
  window.closeQueueAssignModal = closeQueueAssignModal;
  window.confirmQueueAssign = confirmQueueAssign;

  window.openAdmitDraftModal = openAdmitDraftModal;
  window.closeAdmitDraftModal = closeAdmitDraftModal;
  window.saveAdmitDraftFromModal = saveAdmitDraftFromModal;
})();