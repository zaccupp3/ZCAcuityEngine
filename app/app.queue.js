// app/app.queue.js
// ---------------------------------------------------------
// Admit Queue + Queue Assign Modal (wired)
// Uses existing modal markup in index.html:
//  - #queueAssignModal
//  - #queueAssignBed, #queueAssignNurse, #queueAssignPca
//  - confirmQueueAssign(), closeQueueAssignModal()
// Buttons in queue list call openQueueAssignModal(id)
// ---------------------------------------------------------

(function () {
  let activeQueueAssignId = null;

  function safeArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function escHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getRoomNumberCompat(p) {
    if (typeof window.getRoomNumber === "function") return window.getRoomNumber(p);
    if (!p) return 9999;
    const s = String(typeof p === "object" ? (p.room ?? p.id ?? "") : p).trim();
    const m = s.match(/\d+/);
    return m ? Number(m[0]) : 9999;
  }

  // -----------------------------
  // Capacity helpers (NEW)
  // -----------------------------

  function getLoad(staffObj) {
    const pts = safeArray(staffObj?.patients);
    return pts.length;
  }

  function getRnMax(n) {
    // Prefer a function if you have one (role-aware / restrictions-aware)
    if (typeof window.getMaxPatientsForNurse === "function") {
      const v = window.getMaxPatientsForNurse(n);
      if (Number.isFinite(v)) return Number(v);
    }

    // Next: global numeric config if you have it
    if (Number.isFinite(window.maxPatientsPerNurse)) return Number(window.maxPatientsPerNurse);

    // Fallback default
    return 4;
  }

  function getPcaMax(p) {
    if (typeof window.getMaxPatientsForPca === "function") {
      const v = window.getMaxPatientsForPca(p);
      if (Number.isFinite(v)) return Number(v);
    }

    if (Number.isFinite(window.maxPatientsPerPca)) return Number(window.maxPatientsPerPca);
    return 8;
  }

  function rnLabel(n) {
    const name = n?.name || `RN ${n?.id ?? ""}`.trim();
    const load = getLoad(n);
    const max = getRnMax(n);
    return `${name} (${load}/${max})`;
  }

  function pcaLabel(p) {
    const name = p?.name || `PCA ${p?.id ?? ""}`.trim();
    const load = getLoad(p);
    const max = getPcaMax(p);
    return `${name} (${load}/${max})`;
  }

  // -----------------------------
  // Queue list UI
  // -----------------------------
  function renderQueueList() {
    const el = byId("queueList");
    if (!el) return;

    const q = safeArray(window.admitQueue);
    if (!q.length) {
      el.innerHTML = `<div style="opacity:0.7;padding:8px 0;">No admits in queue.</div>`;
      return;
    }

    el.innerHTML = q
      .map((item) => {
        const name = item?.name || item?.label || "Admit";
        const tags = (item?.preAdmitTagsText || "").trim();
        return `
        <div class="queue-item">
          <div class="queue-item-header">
            <div class="queue-item-title">
              <strong>${escHtml(name)}</strong>
            </div>
            <div class="queue-item-actions">
              <button class="queue-btn" onclick="openQueueAssignModal(${item.id})">Assign</button>
              <button class="queue-btn" onclick="editQueuedAdmitName(${item.id})">Edit Name</button>
              <button class="queue-btn" onclick="openAdmitDraftModal(${item.id})">Pre-Admit Tags</button>
              <button class="queue-btn" onclick="removeQueuedAdmit(${item.id})">Remove</button>
            </div>
          </div>
          ${tags ? `<div class="queue-item-tags"><strong>Pre-admit:</strong> ${escHtml(tags)}</div>` : ""}
        </div>
      `;
      })
      .join("");
  }

  function promptAddAdmit() {
    const name = prompt("Admit name (can be edited anytime until placed):", "Admit");
    if (name == null) return;

    const item = {
      id: typeof window.nextQueueId === "number" ? window.nextQueueId : 1,
      name: String(name || "Admit"),
      createdAt: Date.now(),
      // Pre-admit draft fields (safe defaults)
      preAdmit: null,
      preAdmitTagsText: "",
    };

    window.admitQueue = safeArray(window.admitQueue);
    window.admitQueue.push(item);
    window.nextQueueId = item.id + 1;

    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();
  }

  function removeQueuedAdmit(id) {
    window.admitQueue = safeArray(window.admitQueue).filter((x) => x && x.id !== id);
    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();
  }

  function editQueuedAdmitName(id) {
    const q = safeArray(window.admitQueue);
    const item = q.find((x) => x && x.id === id);
    if (!item) return;

    const next = prompt("Edit admit name:", item.name || "Admit");
    if (next == null) return;

    item.name = String(next || "Admit");
    renderQueueList();
    if (typeof window.saveState === "function") window.saveState();
  }

  // -----------------------------
  // Queue Assign Modal (wired)
  // -----------------------------
  function openQueueAssignModal(queueId) {
    const modal = byId("queueAssignModal");
    if (!modal) return;

    activeQueueAssignId = queueId;

    // Populate selects
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

    const qItem = safeArray(window.admitQueue).find((x) => x && x.id === queueId);
    const label = qItem?.name || qItem?.label || "Admit";
    if (info) info.textContent = `Assign "${label}" to RN / PCA / bed.`;

    // Beds: only truly empty beds
    const empties = safeArray(window.patients)
      .filter((p) => p && p.isEmpty)
      .sort((a, b) => getRoomNumberCompat(a) - getRoomNumberCompat(b));

    if (bedSel) {
      bedSel.innerHTML = empties.length
        ? empties
            .map((p) => `<option value="${p.id}">Room ${escHtml(p.room || p.id)}</option>`)
            .join("")
        : `<option value="">(No empty beds)</option>`;
      bedSel.disabled = !empties.length;
    }

    // Current RNs (FILTERED BY CAPACITY)
    const rnsAll = safeArray(window.currentNurses);
    const rnsEligible = rnsAll.filter((n) => getLoad(n) < getRnMax(n));

    if (rnSel) {
      rnSel.innerHTML = rnsEligible.length
        ? rnsEligible.map((n) => `<option value="${n.id}">${escHtml(rnLabel(n))}</option>`).join("")
        : `<option value="">(No eligible RNs)</option>`;
      rnSel.disabled = !rnsEligible.length;
    }

    // Current PCAs (FILTERED BY CAPACITY)
    const pcasAll = safeArray(window.currentPcas);
    const pcasEligible = pcasAll.filter((p) => getLoad(p) < getPcaMax(p));

    if (pcaSel) {
      pcaSel.innerHTML = pcasEligible.length
        ? pcasEligible.map((p) => `<option value="${p.id}">${escHtml(pcaLabel(p))}</option>`).join("")
        : `<option value="">(No eligible PCAs)</option>`;
      pcaSel.disabled = !pcasEligible.length;
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

    if (!bedPatientId) {
      alert("Please select an empty bed.");
      return;
    }
    if (!rnId) {
      alert("Please select a receiving RN.");
      return;
    }
    if (!pcaId) {
      alert("Please select a receiving PCA.");
      return;
    }

    const q = safeArray(window.admitQueue);
    const item = q.find((x) => x && x.id === queueId);
    if (!item) {
      alert("That admit is no longer in the queue.");
      closeQueueAssignModal();
      return;
    }

    const bed =
      typeof window.getPatientById === "function"
        ? window.getPatientById(bedPatientId)
        : safeArray(window.patients).find((p) => p && p.id === bedPatientId);

    if (!bed || !bed.isEmpty) {
      alert("Selected bed is not empty anymore. Please re-open and pick an empty bed.");
      hydrateQueueAssignSelects(queueId);
      return;
    }

    // Confirm capacity again at click-time (recheck, in case assignments changed)
    const rn = safeArray(window.currentNurses).find((n) => Number(n.id) === rnId);
    const pca = safeArray(window.currentPcas).find((p) => Number(p.id) === pcaId);

    if (!rn || getLoad(rn) >= getRnMax(rn)) {
      alert("Selected RN is no longer eligible (at max capacity). Please pick a different RN.");
      hydrateQueueAssignSelects(queueId);
      return;
    }
    if (!pca || getLoad(pca) >= getPcaMax(pca)) {
      alert("Selected PCA is no longer eligible (at max capacity). Please pick a different PCA.");
      hydrateQueueAssignSelects(queueId);
      return;
    }

    // 1) Activate bed as admit
    bed.isEmpty = false;
    bed.recentlyDischarged = false;
    bed.admit = true;

    // If you have pre-admit drafts, copy them in safely
    const draft = item.preAdmit && typeof item.preAdmit === "object" ? item.preAdmit : null;
    if (draft) {
      if (draft.gender) bed.gender = draft.gender;

      const keys = [
        "tele",
        "drip",
        "nih",
        "bg",
        "ciwa",
        "restraint",
        "sitter",
        "vpo",
        "isolation",
        "lateDc",
        "chg",
        "foley",
        "q2turns",
        "heavy",
        "feeder",
      ];
      keys.forEach((k) => {
        if (typeof draft[k] === "boolean") bed[k] = draft[k];
      });
    }

    // 2) Assign to RN + PCA lists
    rn.patients = safeArray(rn.patients);
    if (!rn.patients.includes(bed.id)) rn.patients.push(bed.id);

    pca.patients = safeArray(pca.patients);
    if (!pca.patients.includes(bed.id)) pca.patients.push(bed.id);

    // 3) Remove from queue
    window.admitQueue = q.filter((x) => x && x.id !== queueId);

    // 4) Save + rerender sweep
    if (typeof window.saveState === "function") window.saveState();
    if (typeof window.renderQueueList === "function") window.renderQueueList();
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();

    closeQueueAssignModal();
  }

  // -----------------------------
  // Pre-admit modal hook (non-breaking)
  // -----------------------------
  function openAdmitDraftModal(queueId) {
    // If you already implemented this elsewhere, use it
    if (typeof window.openAdmitDraftModalImpl === "function") {
      return window.openAdmitDraftModalImpl(queueId);
    }
    alert("Pre-Admit Tags modal wiring not connected in app.queue.js yet.");
  }

  // -----------------------------
  // Expose (stable public API)
  // -----------------------------
  window.renderQueueList = renderQueueList;
  window.promptAddAdmit = promptAddAdmit;
  window.removeQueuedAdmit = removeQueuedAdmit;
  window.editQueuedAdmitName = editQueuedAdmitName;

  window.openQueueAssignModal = openQueueAssignModal;
  window.closeQueueAssignModal = closeQueueAssignModal;
  window.confirmQueueAssign = confirmQueueAssign;

  window.openAdmitDraftModal = window.openAdmitDraftModal || openAdmitDraftModal;
})();