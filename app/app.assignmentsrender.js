// app/app.assignmentsrender.js
// ---------------------------------------------------------
// Rendering + generator for Oncoming (incoming) assignments ONLY
// Adds "Prev. RN / Prev. PCA" columns by referencing LIVE assignments.
//
// Adds:
// - ! icon (yellow warning vs red violation) based on hard-rule checks
//
// NEW (Dec 2025):
// - RN Continuity Pin (📌) per patient row on ONCOMING RN table
// - Pinned patients stay with that RN across Populate/Rebalance.
//
// NEW (Dec 2025 - Fixes):
// - MOVE-based count balancer (diff ≤ 1 when possible) for BOTH RN and PCA
// - RN-only and PCA-only rebalance buttons removed; Rebalance (Both) + Populate remain.
// - Empty-owner drop zone row so empty cards can accept drops
//
// FIX (Jan 2026):
// - Canonicalize state references (incomingNurses/incomingPcas/patients) to avoid drift.
//
// FIX (Jan 2026 - Safe Rebalance Wiring):
// - Rebalance buttons use window.rebalanceOwnersSafely (if available)
// - If applied:false, keep baseline and show "Unable to rebalance safely"
//
// PERF (Jan 2026 -> refined v2):
// - Cache Prev RN/PCA owner maps ONCE per render cycle (RN+PCA share it)
// - Cache hard-rule eval maps once per render
// - Batch RN+PCA render where possible to reduce duplicate DOM work
// - Replace per-row hover IIFEs with a single lightweight global handler
//
// Rebalance (Jan 2026):
// - Count balancer is report-source aware: when evening counts, prefer moves that
//   don't increase report overflow (4 pts → max 3 sources, 3 pts → max 2).
//
// UI PATCH (Jan 2026 - Oncoming header refresh):
// - Remove lightbulb icons (no 💡 buttons)
// - Show Report sources only in the header metadata row
// - Improve rebalance feedback: banner includes before/after deltas
// - Add in-flight guards to prevent double-click thrash / duplicate apply
// ---------------------------------------------------------

if (window.__assignmentsRenderLoaded) {
  // no-op
} else {
  window.__assignmentsRenderLoaded = true;

  function safeArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function __ownerHeaderControlsHtml(board, role, owner) {
    if (!owner) return "";
    const ownerId = Number(owner.id);
    return `
      <div class="owner-card-controls">
        <button
          type="button"
          class="owner-name-edit-btn"
          title="Rename ${escapeHtml(String(role || "").toUpperCase())}"
          data-owner-edit="1"
          data-board="${escapeHtml(board)}"
          data-role="${escapeHtml(role)}"
          data-owner-id="${ownerId}"
        >Edit</button>
        <button
          type="button"
          class="owner-room-pick-btn"
          title="Assign rooms"
          onclick="window.openLiveRoomPicker && window.openLiveRoomPicker('${escapeHtml(role)}', ${ownerId}, 'incoming')"
        >+</button>
        <span
          class="owner-card-drag-handle"
          draggable="true"
          title="Drag to reposition tile"
          data-owner-drag-handle="1"
          data-board="${escapeHtml(board)}"
          data-role="${escapeHtml(role)}"
          data-owner-id="${ownerId}"
        >::</span>
        ${String(board || "").toLowerCase() === "incoming" ? `
          <button
            type="button"
            class="owner-card-remove-btn"
            title="Remove ${escapeHtml(String(role || "").toUpperCase())}"
            onclick="window.removeStaffOwnerById && window.removeStaffOwnerById('incoming', '${escapeHtml(role)}', ${ownerId})"
          >×</button>
        ` : ``}
      </div>
    `;
  }

  // =========================================================
  // ✅ Canonical state accessors (prevents reference drift)
  // =========================================================
  function __getIncomingNurses() {
    const w = window.incomingNurses;
    if (Array.isArray(w)) return w;
    if (Array.isArray(typeof incomingNurses !== "undefined" ? incomingNurses : null)) return incomingNurses;
    return [];
  }

  function __getIncomingPcas() {
    const w = window.incomingPcas;
    if (Array.isArray(w)) return w;
    if (Array.isArray(typeof incomingPcas !== "undefined" ? incomingPcas : null)) return incomingPcas;
    return [];
  }

  function __getPatients() {
    const w = window.patients;
    if (Array.isArray(w)) return w;
    if (Array.isArray(typeof patients !== "undefined" ? patients : null)) return patients;
    return [];
  }

  function __isOncomingHoldOwner(owner) {
    if (!owner) return false;
    if (owner.isHold || owner.__hold) return true;
    const type = String(owner.type || "").trim().toLowerCase();
    const name = String(owner.name || "").trim().toLowerCase();
    return type === "hold" || name === "needs to be assigned" || name === "needs to be assigned (pca)" || Number(owner.id) === 0;
  }

  function __prevMapLookup(prevMap, patientId) {
    if (!(prevMap instanceof Map)) return "";
    return String(prevMap.get(Number(patientId)) || "");
  }

  function assignmentTeleHeartHtml(patient) {
    return patient?.tele
      ? `<span class="assignment-tele-heart" title="Tele" aria-label="Tele">&#10084;</span>`
      : "";
  }

  function rnRatioBadgeHtmlForPatients(pts) {
    const rows = safeArray(pts).filter((p) => p && !p.isEmpty);
    const hasTele = rows.some((p) => p.tele);
    const hasNih = rows.some((p) => p.nih);
    const hasEmu = rows.some((p) => p.emu);
    const cap = (hasTele || hasNih || hasEmu) ? 4 : 5;
    const reasons = [
      hasNih ? "NIH" : "",
      hasEmu ? "EMU" : "",
      hasTele ? "Tele" : ""
    ].filter(Boolean);
    const reasonText = reasons.length ? ` (${reasons.join("/")})` : "";
    const title = cap === 4
      ? `4:1 required because this RN group has ${reasons.join(", ")}`
      : "5:1 allowed for med-surg-only RN group";
    const exceeded = rows.length > cap;
    const cls = exceeded ? ` ratio-${cap === 4 ? "four" : "five"}` : "";
    return `<span class="rn-ratio-badge${cls}" title="${escapeHtml(title)}">Ratio: ${cap}:1${escapeHtml(reasonText)}</span>`;
  }

  function __getIncomingNursesReal() {
    return __getIncomingNurses().filter((owner) => owner && !__isOncomingHoldOwner(owner));
  }

  function __getIncomingPcasReal() {
    return __getIncomingPcas().filter((owner) => owner && !__isOncomingHoldOwner(owner));
  }

  function __ensureOncomingHoldOwner(role) {
    const key = role === "pca" ? "incomingPcas" : "incomingNurses";
    const label = role === "pca" ? "Needs to be assigned (PCA)" : "Needs to be assigned";
    const arr = safeArray(window[key]);
    const id0 = arr.find((owner) => Number(owner?.id) === 0);

    if (id0 && !__isOncomingHoldOwner(id0)) {
      const maxId = arr.reduce((max, owner) => Math.max(max, Number(owner?.id) || 0), 0);
      id0.id = maxId + 1;
    }

    let hold = arr.find((owner) => __isOncomingHoldOwner(owner));

    if (!hold) {
      hold = {
        id: 0,
        name: label,
        type: "HOLD",
        isHold: true,
        patients: []
      };
      arr.push(hold);
    } else {
      hold.id = 0;
      hold.name = label;
      hold.type = "HOLD";
      hold.isHold = true;
      hold.patients = safeArray(hold.patients);
      const idx = arr.indexOf(hold);
      if (idx > -1 && idx < arr.length - 1) {
        arr.splice(idx, 1);
        arr.push(hold);
      }
    }

    window[key] = arr;
    return hold;
  }

  function __syncOncomingHoldPatients(role) {
    const hold = __ensureOncomingHoldOwner(role);
    const active = __getPatients()
      .filter((p) => p && !p.isEmpty)
      .map((p) => Number(p.id))
      .filter(Number.isFinite);
    const activeSet = new Set(active);
    const assigned = new Set();
    const owners = role === "pca" ? __getIncomingPcasReal() : __getIncomingNursesReal();

    owners.forEach((owner) => {
      safeArray(owner?.patients).forEach((pid) => {
        const n = Number(pid);
        if (Number.isFinite(n)) assigned.add(n);
      });
    });

    hold.patients = active.filter((pid) => activeSet.has(pid) && !assigned.has(pid));

    try {
      window.oncomingUnassigned = window.oncomingUnassigned || { rn: [], pca: [], sitter: [] };
      if (role === "pca") window.oncomingUnassigned.pca = hold.patients.slice();
      else window.oncomingUnassigned.rn = hold.patients.slice();
    } catch (_) {}

    return hold;
  }

  function __buildOncomingHoldCard(role, hold, prevMap) {
    const pts = safeArray(hold?.patients)
      .map((pid) => (typeof window.getPatientById === "function" ? window.getPatientById(pid) : null))
      .filter((p) => p && !p.isEmpty)
      .sort(safeSortPatientsForDisplay);

    if (!pts.length) return "";

    let rows = "";
    pts.forEach((p) => {
      const prevName = firstNameOnly(__prevMapLookup(prevMap, p.id));
      rows += `
        <tr
          draggable="true"
          ondragstart="onRowDragStart(event, 'incoming', '${role}', 0, ${p.id})"
          ondragend="onRowDragEnd(event)"
          ondblclick="openPatientProfileFromRoom(${p.id})"
        >
          <td>${bedCellHtml(p)}</td>
          <td>${assignmentTeleHeartHtml(p)}</td>
          <td>${role === "pca" ? (typeof pcaTagString === "function" ? pcaTagString(p) : "") : (typeof rnTagString === "function" ? rnTagString(p) : "")}</td>
          <td>${escapeHtml(prevName || "-")}</td>
        </tr>
      `;
    });

    if (!pts.length) {
      rows = buildEmptyDropRow(4, role === "pca" ? "Drop a patient here to leave them unassigned for PCA" : "Drop a patient here to leave them unassigned for RN");
    }

    const roleLabel = role === "pca" ? "PCA" : "RN";
    return `
      <div class="assignment-card" style="border-left:6px solid rgba(100,116,139,0.85); opacity:0.97;"
           data-owner-card="1"
           data-board="incoming"
           data-role="${escapeHtml(role)}"
           data-owner-id="0"
           ondragover="window.onOwnerTileDragOver && window.onOwnerTileDragOver(event)"
           ondrop="window.onOwnerTileDrop && window.onOwnerTileDrop(event, 'incoming', '${role}', 0)">
        <div class="assignment-header"
             ondragover="window.onOwnerTileDragOver && window.onOwnerTileDragOver(event)"
             ondrop="window.onOwnerTileDrop && window.onOwnerTileDrop(event, 'incoming', '${role}', 0)">
          <div>
            <strong>${escapeHtml(String(hold?.name || "Needs to be assigned"))}</strong>
          </div>
          <div style="font-weight:700;">Patients: ${pts.length} | ${roleLabel} queue${role === "nurse" ? ` | ${rnRatioBadgeHtmlForPatients(pts)}` : ""}</div>
        </div>
        <table class="assignment-table">
          <thead>
            <tr>
              <th>Bed</th>
              <th>Level</th>
              <th>Acuity Notes</th>
              <th>Prev. ${roleLabel}</th>
            </tr>
          </thead>
          <tbody ondragover="onRowDragOver(event)" ondrop="onRowDrop(event, 'incoming', '${role}', 0)">
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  }

  function __syncIncomingGlobals() {
    const nurses = __getIncomingNurses();
    const pcas = __getIncomingPcas();
    const pts = __getPatients();

    if (!Array.isArray(window.incomingNurses)) window.incomingNurses = nurses;
    if (!Array.isArray(window.incomingPcas)) window.incomingPcas = pcas;
    if (!Array.isArray(window.patients)) window.patients = pts;

    try {
      if (typeof incomingNurses !== "undefined" && incomingNurses !== window.incomingNurses) {
        incomingNurses = window.incomingNurses;
      }
    } catch (_) {}

    try {
      if (typeof incomingPcas !== "undefined" && incomingPcas !== window.incomingPcas) {
        incomingPcas = window.incomingPcas;
      }
    } catch (_) {}

    try {
      if (typeof patients !== "undefined" && patients !== window.patients) {
        patients = window.patients;
      }
    } catch (_) {}
  }

  __syncIncomingGlobals();

  // -----------------------------
  // Helpers: build prev-owner maps ONCE per render cycle (PERF)
  // -----------------------------
  function buildPrevOwnerMaps() {
    const prevRnByPid = new Map();
    const prevPcaByPid = new Map();

    if (Array.isArray(window.currentNurses)) {
      window.currentNurses.forEach(rn => {
        const name = rn?.name || `RN ${rn?.id ?? ""}`;
        (rn?.patients || []).forEach(pid => prevRnByPid.set(Number(pid), name));
      });
    }

    if (Array.isArray(window.currentPcas)) {
      window.currentPcas.forEach(p => {
        const name = p?.name || `PCA ${p?.id ?? ""}`;
        (p?.patients || []).forEach(pid => prevPcaByPid.set(Number(pid), name));
      });
    }

    return { prevRnByPid, prevPcaByPid };
  }

  function uniqueCountFromMap(patientIds, map) {
    const set = new Set();
    (patientIds || []).forEach(pid => {
      const v = map.get(Number(pid));
      if (v) set.add(v);
    });
    return set.size;
  }

  // Report-source helpers (mirror assignmentRules: 4 pts → max 3 sources, 3 pts → max 2)
  // Used by count balancer to prefer moves that don't increase report-source drag.
  function __allowedReportSourcesForCount(ptCount) {
    const n = Number(ptCount) || 0;
    if (n >= 4) return 3;
    if (n === 3) return 2;
    if (n === 2) return 2;
    if (n === 1) return 1;
    return 0;
  }

  function __reportSourcesForOwner(owner, prevMap) {
    if (!prevMap || !owner) return 0;
    const ids = Array.isArray(owner.patients) ? owner.patients : [];
    return uniqueCountFromMap(ids, prevMap);
  }

  function __reportOverflowForOwner(owner, prevMap) {
    const ptCount = Array.isArray(owner?.patients) ? owner.patients.length : 0;
    const allowed = __allowedReportSourcesForCount(ptCount);
    const sources = __reportSourcesForOwner(owner, prevMap);
    return Math.max(0, sources - allowed);
  }

  function __reportOverflowTotal(owners, prevMap) {
    if (!prevMap) return 0;
    return (owners || []).reduce((sum, o) => sum + __reportOverflowForOwner(o, prevMap), 0);
  }

  function __reportSourceTotal(owners, prevMap) {
    if (!prevMap) return 0;
    return (owners || []).reduce((sum, o) => sum + __reportSourcesForOwner(o, prevMap), 0);
  }

  // Render-cycle cache (RN + PCA share)
  // This prevents RN render + PCA render from recomputing maps back-to-back.
  const __renderCycleCache = {
    token: 0,
    prevMaps: null
  };

  function __beginRenderCycle() {
    __renderCycleCache.token = (Number(__renderCycleCache.token) || 0) + 1;
    __renderCycleCache.prevMaps = null;
    return __renderCycleCache.token;
  }

  function __getPrevMapsForCycle() {
    if (__renderCycleCache.prevMaps) return __renderCycleCache.prevMaps;
    __renderCycleCache.prevMaps = buildPrevOwnerMaps();
    return __renderCycleCache.prevMaps;
  }

  // -----------------------------
  // Backward-compatible helpers (still exposed)
  // -----------------------------
  function getPrevRnNameForPatient(patientId) {
    const pid = Number(patientId);
    if (!pid) return "";
    if (!Array.isArray(window.currentNurses)) return "";
    const owner = window.currentNurses.find(n => Array.isArray(n.patients) && n.patients.includes(pid));
    return owner ? (owner.name || `RN ${owner.id}`) : "";
  }

  function getPrevPcaNameForPatient(patientId) {
    const pid = Number(patientId);
    if (!pid) return "";
    if (!Array.isArray(window.currentPcas)) return "";
    const owner = window.currentPcas.find(p => Array.isArray(p.patients) && p.patients.includes(pid));
    return owner ? (owner.name || `PCA ${owner.id}`) : "";
  }

  window.getPrevRnNameForPatient = getPrevRnNameForPatient;
  window.getPrevPcaNameForPatient = getPrevPcaNameForPatient;

  // -----------------------------
  // Room label helpers
  // -----------------------------
  function getBedLabel(p) {
    if (!p) return "";
    if (typeof window.getRoomLabelForPatient === "function") return window.getRoomLabelForPatient(p);
    return String(p.room || p.id || "");
  }

  function isExpectedDischarge(p) {
    return !!(p && !p.isEmpty && p.expectedDischarge);
  }

  function showOncomingDischargeVisuals() {
    return window.__oncomingShowDischargeVisuals !== false;
  }

  function __syncOncomingDischargeVisualToggle() {
    const btn = document.getElementById("oncomingDischargeVisualToggle");
    if (!btn) return;
    const on = showOncomingDischargeVisuals();
    btn.textContent = on ? "DCs On" : "DCs Off";
    btn.setAttribute("data-state", on ? "on" : "off");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Hide expected discharge bed highlights" : "Show expected discharge bed highlights";
  }

  window.toggleOncomingDischargeVisuals = function toggleOncomingDischargeVisuals() {
    window.__oncomingShowDischargeVisuals = !showOncomingDischargeVisuals();
    __syncOncomingDischargeVisualToggle();
    try { renderOncomingAll(); } catch (_) {}
  };

  function bedCellHtml(p, extraHtml = "") {
    const bedLabel = getBedLabel(p);
    const showDischarge = showOncomingDischargeVisuals() && isExpectedDischarge(p);
    const dischargeClass = showDischarge ? " discharge-expected" : "";
    const carBadge = showDischarge
      ? `<span class="expected-discharge-indicator" title="Expected discharge soon" aria-label="Expected discharge soon">&#128663;</span>`
      : "";
    return `<span class="bed-chip${dischargeClass}">${escapeHtml(bedLabel)}${carBadge}${extraHtml}</span>`;
  }

  function safeSortPatientsForDisplay(a, b) {
    const ga = (typeof window.getRoomNumber === "function") ? window.getRoomNumber(a) : 9999;
    const gb = (typeof window.getRoomNumber === "function") ? window.getRoomNumber(b) : 9999;
    if (ga !== gb) return ga - gb;
    return (Number(a?.id) || 0) - (Number(b?.id) || 0);
  }

  const PCA_SPECIAL_MAX_PATIENTS = 4;

  function __isPcaSpecialOwner(owner) {
    return !!owner?.isSitter;
  }

  function __pcaSpecialLabel(owner, pts) {
    if (!__isPcaSpecialOwner(owner)) return "PCA";
    const count = Array.isArray(pts) ? pts.length : safeArray(owner?.patients).length;
    return count >= 3 ? "Mod Assignment" : "Sitter Assignment";
  }

  function __pcaDisplayOwners(owners) {
    return safeArray(owners).slice().sort((a, b) => {
      const sa = __isPcaSpecialOwner(a) ? 1 : 0;
      const sb = __isPcaSpecialOwner(b) ? 1 : 0;
      if (sa !== sb) return sa - sb;
      return (Number(a?.id) || 0) - (Number(b?.id) || 0);
    });
  }

  function __pcaSpecialRoomPairs(owner) {
    return String(owner?.sitterRoomPair || "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function __sitterRoomGroupKey(p) {
    const bed = getBedLabel(p);
    const m = String(bed || "").trim().match(/^(\d+)/);
    return m ? m[1] : String(bed || "");
  }

  function __applyPcaSitterDesignations(pcas, activePatients) {
    const owners = Array.isArray(pcas) ? pcas : [];
    const pts = Array.isArray(activePatients) ? activePatients : [];
    const pinned = new Set();
    const claimedPairs = new Set();
    const claimedPatientIds = new Set();

    owners.forEach((pca) => {
      const pairs = __pcaSpecialRoomPairs(pca);
      if (!__isPcaSpecialOwner(pca) || !pairs.length) return;
      const availablePairs = pairs.filter((pair) => !claimedPairs.has(pair));
      if (!availablePairs.length) {
        pca.patients = [];
        pca.maxPatients = PCA_SPECIAL_MAX_PATIENTS;
        return;
      }

      const hits = pts
        .filter((p) => p && !p.isEmpty && !!p.sitter && availablePairs.includes(__sitterRoomGroupKey(p)))
        .sort(safeSortPatientsForDisplay)
        .slice(0, PCA_SPECIAL_MAX_PATIENTS)
        .map((p) => Number(p.id))
        .filter((id) => Number.isFinite(id) && !claimedPatientIds.has(id));

      pca.patients = Array.from(new Set(hits));
      pca.maxPatients = PCA_SPECIAL_MAX_PATIENTS;
      availablePairs.forEach((pair) => claimedPairs.add(pair));
      pca.patients.forEach((id) => {
        pinned.add(id);
        claimedPatientIds.add(id);
      });
    });

    return pinned;
  }

  function __enforceSitterAssignmentsExclusive(pcas, activePatients) {
    const owners = Array.isArray(pcas) ? pcas : [];
    const pts = Array.isArray(activePatients) ? activePatients : [];
    const pinned = __applyPcaSitterDesignations(owners, pts);
    if (!pinned.size) return pinned;

    owners.forEach((pca) => {
      if (__isPcaSpecialOwner(pca)) return;
      const raw = Array.isArray(pca?.patients) ? pca.patients : [];
      pca.patients = raw
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && !pinned.has(id));
    });
    return pinned;
  }

  function __sanitizeOwnerAssignmentsToActiveBeds(owner, activeIdSet) {
    if (!owner || !activeIdSet) return [];
    const raw = Array.isArray(owner.patients) ? owner.patients : [];
    const cleaned = raw
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && activeIdSet.has(id));
    const unique = Array.from(new Set(cleaned));
    if (!Array.isArray(owner.patients) || owner.patients.length !== unique.length || owner.patients.some((v, i) => Number(v) !== unique[i])) {
      owner.patients = unique;
    }
    return unique;
  }

  // -----------------------------
  // RN / PCA Continuity Pin helpers
  // -----------------------------
  function getPatientLockMeta(p, role = "nurse") {
    if (!p || typeof p !== "object") {
      return role === "pca" ? { enabled: false, pcaId: null } : { enabled: false, rnId: null };
    }
    if (role === "pca") {
      const enabled = !!p.lockPcaEnabled;
      const pcaId = (p.lockPcaTo !== undefined && p.lockPcaTo !== null) ? Number(p.lockPcaTo) : null;
      return { enabled, pcaId: Number.isFinite(pcaId) ? pcaId : null };
    }
    const enabled = !!p.lockRnEnabled;
    const rnId = (p.lockRnTo !== undefined && p.lockRnTo !== null) ? Number(p.lockRnTo) : null;
    return { enabled, rnId: Number.isFinite(rnId) ? rnId : null };
  }

  function isPatientPinnedToIncomingRn(patientId, incomingRnId) {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return false;
    const meta = getPatientLockMeta(p);
    return !!meta.enabled && meta.rnId === Number(incomingRnId);
  }

  function isPatientPinnedToAnyIncomingRn(patientId) {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return false;
    const meta = getPatientLockMeta(p);
    return !!meta.enabled && Number.isFinite(meta.rnId);
  }

  function isPatientPinnedToIncomingPca(patientId, incomingPcaId) {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return false;
    const meta = getPatientLockMeta(p, "pca");
    return !!meta.enabled && meta.pcaId === Number(incomingPcaId);
  }

  function isPatientPinnedToAnyIncomingPca(patientId) {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return false;
    const meta = getPatientLockMeta(p, "pca");
    return !!meta.enabled && Number.isFinite(meta.pcaId);
  }

  function toggleIncomingRnPin(patientId, incomingRnId) {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return;

    const rnId = Number(incomingRnId);
    const meta = getPatientLockMeta(p);

    if (meta.enabled && meta.rnId === rnId) {
      p.lockRnEnabled = false;
      p.lockRnTo = null;
    } else {
      p.lockRnEnabled = true;
      p.lockRnTo = rnId;
    }

    try { if (typeof window.saveState === "function") window.saveState(); } catch {}
    try { if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput(); } catch {}
  }
  window.toggleIncomingRnPin = toggleIncomingRnPin;

  function toggleIncomingPcaPin(patientId, incomingPcaId) {
    const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
    if (!p) return;

    const pcaId = Number(incomingPcaId);
    const meta = getPatientLockMeta(p, "pca");

    if (meta.enabled && meta.pcaId === pcaId) {
      p.lockPcaEnabled = false;
      p.lockPcaTo = null;
    } else {
      p.lockPcaEnabled = true;
      p.lockPcaTo = pcaId;
    }

    try { if (typeof window.saveState === "function") window.saveState(); } catch {}
    try { if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput(); } catch {}
  }
  window.toggleIncomingPcaPin = toggleIncomingPcaPin;

  function clearIncomingAssignmentPins() {
    let cleared = 0;
    __getPatients().forEach((p) => {
      if (!p || typeof p !== "object") return;
      if (p.lockRnEnabled || p.lockRnTo != null) {
        p.lockRnEnabled = false;
        p.lockRnTo = null;
        cleared += 1;
      }
      if (p.lockPcaEnabled || p.lockPcaTo != null) {
        p.lockPcaEnabled = false;
        p.lockPcaTo = null;
        cleared += 1;
      }
    });
    try { if (typeof window.saveState === "function") window.saveState(); } catch {}
    try { if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput(); } catch {}
    try { if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput(); } catch {}
    try {
      if (window.cloudSync && typeof window.cloudSync.noteLocalUnitEdit === "function") {
        window.cloudSync.noteLocalUnitEdit("oncoming_clear_pins");
      }
      if (window.cloudSync && typeof window.cloudSync.publishUnitStateDebounced === "function") {
        window.cloudSync.publishUnitStateDebounced("oncoming_clear_pins");
      }
    } catch {}
    const pill = document.getElementById("oncomingPopulateStatus");
    const text = pill?.querySelector(".staffing-status-text");
    const meta = pill?.querySelector(".staffing-status-meta");
    if (text) text.textContent = cleared ? "Pins cleared" : "No pins";
    if (meta) meta.textContent = cleared ? `${cleared} pin${cleared === 1 ? "" : "s"} removed` : "";
    return cleared;
  }
  window.clearIncomingAssignmentPins = clearIncomingAssignmentPins;

  function unassignIncomingAssignments() {
    __syncIncomingGlobals();
    let cleared = 0;

    const clearRole = (role) => {
      const owners = role === "pca" ? __getIncomingPcasReal() : __getIncomingNursesReal();
      owners.forEach((owner) => {
        const ids = safeArray(owner?.patients).map((pid) => Number(pid)).filter(Number.isFinite);
        cleared += ids.length;
        owner.patients = [];
      });
      __syncOncomingHoldPatients(role);
    };

    const beforeCount = ["nurse", "pca"].reduce((sum, role) => {
      const owners = role === "pca" ? __getIncomingPcasReal() : __getIncomingNursesReal();
      return sum + owners.reduce((roleSum, owner) => roleSum + safeArray(owner?.patients).length, 0);
    }, 0);

    if (beforeCount > 0) {
      try {
        if (typeof window.pushAssignmentUndoSnapshot === "function") {
          window.pushAssignmentUndoSnapshot("incoming", "Unassign all");
        }
      } catch (_) {}
    }

    clearRole("nurse");
    clearRole("pca");
    __syncIncomingGlobals();

    try { if (typeof window.saveState === "function") window.saveState(); } catch (_) {}
    try { renderOncomingAll(); } catch (_) {
      try { if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput(); } catch (__) {}
      try { if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput(); } catch (__) {}
    }
    try {
      if (window.cloudSync && typeof window.cloudSync.noteLocalUnitEdit === "function") {
        window.cloudSync.noteLocalUnitEdit("oncoming_unassign_all");
      }
      if (window.cloudSync && typeof window.cloudSync.publishUnitStateDebounced === "function") {
        window.cloudSync.publishUnitStateDebounced("oncoming_unassign_all");
      }
    } catch (_) {}

    const pill = document.getElementById("oncomingPopulateStatus");
    const text = pill?.querySelector(".staffing-status-text");
    const meta = pill?.querySelector(".staffing-status-meta");
    if (text) text.textContent = beforeCount ? "Unassigned" : "Nothing assigned";
    if (meta) meta.textContent = beforeCount ? `${cleared} assignment${cleared === 1 ? "" : "s"} moved to needs bucket` : "";
    return cleared;
  }
  window.unassignIncomingAssignments = unassignIncomingAssignments;

  function cleanupRnPinsAgainstRoster() {
    const roster = __getIncomingNurses();
    const rosterIds = new Set(roster.map(n => Number(n.id)));

    const pts = __getPatients();
    pts.forEach(p => {
      const meta = getPatientLockMeta(p);
      if (!meta.enabled) return;
      if (!rosterIds.has(meta.rnId)) {
        p.lockRnEnabled = false;
        p.lockRnTo = null;
      }
    });
  }

  function cleanupPcaPinsAgainstRoster() {
    const roster = __getIncomingPcas().filter((p) => !__isPcaSpecialOwner(p));
    const rosterIds = new Set(roster.map((p) => Number(p.id)));

    const pts = __getPatients();
    pts.forEach((p) => {
      const meta = getPatientLockMeta(p, "pca");
      if (!meta.enabled) return;
      if (!rosterIds.has(meta.pcaId)) {
        p.lockPcaEnabled = false;
        p.lockPcaTo = null;
      }
    });
  }

  function applyRnPinsBeforeDistribute(activePatients) {
    const roster = __getIncomingNurses();
    if (!roster.length) return { pinnedAssigned: [], unlockedPool: activePatients || [] };

    const byId = new Map(roster.map(n => [Number(n.id), n]));
    const pinnedAssigned = [];
    const unlockedPool = [];

    (activePatients || []).forEach(p => {
      const meta = getPatientLockMeta(p);
      if (meta.enabled && meta.rnId && byId.has(meta.rnId)) {
        const rn = byId.get(meta.rnId);
        rn.patients = Array.isArray(rn.patients) ? rn.patients : [];
        if (!rn.patients.includes(Number(p.id))) rn.patients.push(Number(p.id));
        pinnedAssigned.push(Number(p.id));
      } else {
        unlockedPool.push(p);
      }
    });

    return { pinnedAssigned, unlockedPool };
  }

  function applyPcaPinsBeforeDistribute(activePatients, owners) {
    const roster = Array.isArray(owners) ? owners : __getIncomingPcas();
    if (!roster.length) return { pinnedAssigned: [], unlockedPool: activePatients || [] };

    const byId = new Map(roster.map((p) => [Number(p.id), p]));
    const pinnedAssigned = [];
    const unlockedPool = [];

    (activePatients || []).forEach((p) => {
      const meta = getPatientLockMeta(p, "pca");
      if (meta.enabled && meta.pcaId && byId.has(meta.pcaId)) {
        const pca = byId.get(meta.pcaId);
        pca.patients = Array.isArray(pca.patients) ? pca.patients : [];
        if (!pca.patients.includes(Number(p.id))) pca.patients.push(Number(p.id));
        pinnedAssigned.push(Number(p.id));
      } else {
        unlockedPool.push(p);
      }
    });

    return { pinnedAssigned, unlockedPool };
  }

  // -----------------------------
  // Guard helpers: avoidable violations + even counts
  // -----------------------------
  function getAvoidableViolationCount(owners, role) {
    try {
      if (typeof window.evaluateAssignmentHardRules !== "function") return 0;
      const map = window.evaluateAssignmentHardRules(owners, role);
      if (!map || typeof map !== "object") return 0;

      let total = 0;
      Object.values(map).forEach(ev => {
        total += (Array.isArray(ev?.violations) ? ev.violations.length : 0);
      });
      return total;
    } catch {
      return 0;
    }
  }

  function computeCountTargets(totalPatients, nOwners) {
    const base = Math.floor(totalPatients / Math.max(1, nOwners));
    const remainder = totalPatients % Math.max(1, nOwners);
    return { minTarget: base, maxTarget: base + (remainder > 0 ? 1 : 0) };
  }

  function getMovablePatientIdsFromOwner(owner, role) {
    const ids = Array.isArray(owner?.patients) ? owner.patients.slice() : [];
    if (role === "nurse") return ids.filter(pid => !isPatientPinnedToAnyIncomingRn(pid));
    if (role === "pca") return ids.filter(pid => !isPatientPinnedToAnyIncomingPca(pid));
    return ids;
  }

  function tryMovePatient(owners, role, fromOwner, toOwner, patientId) {
    if (!fromOwner || !toOwner) return false;
    if (!Array.isArray(fromOwner.patients)) fromOwner.patients = [];
    if (!Array.isArray(toOwner.patients)) toOwner.patients = [];

    const pid = Number(patientId);
    const idx = fromOwner.patients.findIndex((x) => Number(x) === pid);
    if (idx === -1) return false;

    if (role === "nurse" && isPatientPinnedToAnyIncomingRn(pid)) return false;
    if (role === "pca" && isPatientPinnedToAnyIncomingPca(pid)) return false;

    fromOwner.patients.splice(idx, 1);
    safeArray(owners).forEach((owner) => {
      if (!owner || !Array.isArray(owner.patients)) return;
      owner.patients = owner.patients.filter((x) => Number(x) !== pid);
    });
    if (!toOwner.patients.some((x) => Number(x) === pid)) toOwner.patients.push(pid);
    toOwner.patients = Array.from(new Set(toOwner.patients.map((x) => Number(x)).filter(Number.isFinite)));
    return true;
  }

  function isNihPatientId(patientId) {
    try {
      const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
      return !!(p && !p.isEmpty && p.nih);
    } catch {
      return false;
    }
  }

  function countNihForOwner(owner) {
    return safeArray(owner?.patients).filter((pid) => isNihPatientId(pid)).length;
  }

  function rnRatioCapLocal(owner) {
    const hasTeleOrNih = safeArray(owner?.patients).some((pid) => {
      const p = (typeof window.getPatientById === "function") ? window.getPatientById(pid) : null;
      return !!(p && !p.isEmpty && (p.tele || p.nih || p.emu));
    });
    return hasTeleOrNih ? 4 : 5;
  }

  function rnRatioOverflowLocal(owner) {
    return Math.max(0, safeArray(owner?.patients).length - rnRatioCapLocal(owner));
  }

  function nihDistributionScore(owners) {
    const list = safeArray(owners).filter(Boolean);
    const totalNih = list.reduce((sum, owner) => sum + countNihForOwner(owner), 0);
    const targetMax = Math.max(1, Math.ceil(totalNih / Math.max(1, list.length)));
    const counts = list.map((owner) => countNihForOwner(owner));
    return {
      totalNih,
      targetMax,
      overflow: counts.reduce((sum, count) => sum + Math.max(0, count - targetMax), 0),
      max: counts.length ? Math.max(...counts) : 0,
      spread: counts.length ? Math.max(...counts) - Math.min(...counts) : 0,
      ratioOverflow: list.reduce((sum, owner) => sum + rnRatioOverflowLocal(owner), 0)
    };
  }

  function compareNihScore(a, b) {
    const left = [Number(a?.overflow) || 0, Number(a?.ratioOverflow) || 0, Number(a?.max) || 0, Number(a?.spread) || 0];
    const right = [Number(b?.overflow) || 0, Number(b?.ratioOverflow) || 0, Number(b?.max) || 0, Number(b?.spread) || 0];
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return left[i] - right[i];
    }
    return 0;
  }

  function rebalanceNihDistribution(owners, opts = {}) {
    const list = safeArray(owners).filter(Boolean);
    if (list.length < 2) return { changed: false, moves: 0, reason: "Not enough RN owners." };
    let changed = false;
    let moves = 0;
    const maxPasses = Number(opts.maxPasses) || 32;

    for (let pass = 0; pass < maxPasses; pass++) {
      const baseScore = nihDistributionScore(list);
      if (baseScore.totalNih <= 1 || baseScore.overflow <= 0) break;

      let best = null;
      const sources = list
        .filter((owner) => countNihForOwner(owner) > baseScore.targetMax)
        .sort((a, b) => countNihForOwner(b) - countNihForOwner(a));
      const targets = list
        .filter((owner) => countNihForOwner(owner) < baseScore.targetMax)
        .sort((a, b) => countNihForOwner(a) - countNihForOwner(b) || safeArray(a?.patients).length - safeArray(b?.patients).length);

      for (const fromOwner of sources) {
        const movableNih = getMovablePatientIdsFromOwner(fromOwner, "nurse").filter((pid) => isNihPatientId(pid));
        for (const patientId of movableNih) {
          for (const toOwner of targets) {
            if (!toOwner || toOwner === fromOwner) continue;
            const beforeSnap = __snapshotSingleOwnerArrays(list);
            const did = tryMovePatient(list, "nurse", fromOwner, toOwner, patientId);
            if (did) {
              const directScore = nihDistributionScore(list);
              if (compareNihScore(directScore, baseScore) < 0) {
                best = { fromOwner, toOwner, patientId, swapPatientId: null, score: directScore };
              }
            }
            __restoreSingleOwnerArrays(list, beforeSnap);
            if (best) break;

            const swapCandidates = getMovablePatientIdsFromOwner(toOwner, "nurse").filter((pid) => !isNihPatientId(pid));
            for (const swapPatientId of swapCandidates) {
              const swapSnap = __snapshotSingleOwnerArrays(list);
              const didNih = tryMovePatient(list, "nurse", fromOwner, toOwner, patientId);
              const didSwap = didNih && tryMovePatient(list, "nurse", toOwner, fromOwner, swapPatientId);
              if (didSwap) {
                const swapScore = nihDistributionScore(list);
                if (compareNihScore(swapScore, baseScore) < 0) {
                  best = { fromOwner, toOwner, patientId, swapPatientId, score: swapScore };
                }
              }
              __restoreSingleOwnerArrays(list, swapSnap);
              if (best) break;
            }
            if (best) break;
          }
          if (best) break;
        }
        if (best) break;
      }

      if (!best) break;
      const applied = tryMovePatient(list, "nurse", best.fromOwner, best.toOwner, best.patientId);
      if (!applied) break;
      if (best.swapPatientId != null) {
        tryMovePatient(list, "nurse", best.toOwner, best.fromOwner, best.swapPatientId);
      }
      changed = true;
      moves += 1;
    }

    const finalScore = nihDistributionScore(list);
    return { changed, moves, score: finalScore, reason: changed ? `Spread NIH patients across RN groups (${moves} move${moves === 1 ? "" : "s"}).` : "No better NIH distribution found." };
  }

  function isExpectedDischargePatientId(patientId) {
    try {
      const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
      return !!(p && !p.isEmpty && p.expectedDischarge);
    } catch {
      return false;
    }
  }

  function countExpectedDischargesForOwnerLocal(owner) {
    return safeArray(owner?.patients).reduce((sum, pid) => sum + (isExpectedDischargePatientId(pid) ? 1 : 0), 0);
  }

  function expectedDischargeBaseLimitLocal(owner, role) {
    const count = safeArray(owner?.patients).length;
    if (role === "pca") return Math.floor(count / 2);
    return 3;
  }

  function totalExpectedDischargesLocal(owners) {
    return safeArray(owners).reduce((sum, owner) => sum + countExpectedDischargesForOwnerLocal(owner), 0);
  }

  function totalExpectedDischargeCapacityLocal(owners, role) {
    return safeArray(owners).reduce((sum, owner) => sum + expectedDischargeBaseLimitLocal(owner, role), 0);
  }

  function getExpectedDischargeOverflowLocal(owner, role) {
    return Math.max(0, countExpectedDischargesForOwnerLocal(owner) - expectedDischargeBaseLimitLocal(owner, role));
  }

  function getAvoidableExpectedDischargeOverflowLocal(owners, role) {
    const totalOverflow = safeArray(owners).reduce((sum, owner) => sum + getExpectedDischargeOverflowLocal(owner, role), 0);
    const unavoidable = Math.max(0, totalExpectedDischargesLocal(owners) - totalExpectedDischargeCapacityLocal(owners, role));
    return Math.max(0, totalOverflow - unavoidable);
  }

  function countSpreadLocal(owners) {
    const counts = safeArray(owners).map((o) => safeArray(o?.patients).length);
    if (!counts.length) return 0;
    return Math.max(...counts) - Math.min(...counts);
  }

  function roomNumberLocal(patientId) {
    try {
      const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
      if (!p) return null;
      if (typeof window.getRoomNumber === "function") {
        const n = window.getRoomNumber(p);
        return Number.isFinite(n) ? Number(n) : null;
      }
      const raw = String(p?.room || p?.roomNumber || "");
      const m = raw.match(/(\d+)/);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  function roomSpanForOwnerLocal(owner) {
    const rooms = safeArray(owner?.patients)
      .map((pid) => roomNumberLocal(pid))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (rooms.length < 2) return 0;
    return rooms[rooms.length - 1] - rooms[0];
  }

  function roomSpreadOverflowLocal(owners, role) {
    const limit = role === "pca" ? 14 : 10;
    return safeArray(owners).reduce((sum, owner) => {
      const span = roomSpanForOwnerLocal(owner);
      return sum + Math.max(0, span - limit);
    }, 0);
  }

  function rebalanceExpectedDischarges(owners, role, opts = {}) {
    const list = Array.isArray(owners) ? owners.filter(Boolean) : [];
    if (list.length < 2) return { ok: true, changed: false };

    const maxPasses = typeof opts.maxPasses === "number" ? opts.maxPasses : 80;
    const maps = buildPrevOwnerMaps();
    const prevMap = role === "nurse" ? maps.prevRnByPid : maps.prevPcaByPid;
    let changed = false;

    for (let pass = 0; pass < maxPasses; pass++) {
      const baseAvoid = getAvoidableViolationCount(list, role);
      const baseDischargeAvoid = getAvoidableExpectedDischargeOverflowLocal(list, role);
      if (baseDischargeAvoid <= 0) break;

      const baseRoomOverflow = roomSpreadOverflowLocal(list, role);
      const baseReportOverflow = prevMap ? __reportOverflowTotal(list, prevMap) : 0;
      const baseReportTotal = prevMap ? __reportSourceTotal(list, prevMap) : 0;
      const baseSpread = countSpreadLocal(list);
      const overOwners = list
        .map((owner) => ({ owner, overflow: getExpectedDischargeOverflowLocal(owner, role), discharges: countExpectedDischargesForOwnerLocal(owner) }))
        .filter((entry) => entry.overflow > 0)
        .sort((a, b) => b.overflow - a.overflow || b.discharges - a.discharges);

      let best = null;

      for (const sourceEntry of overOwners) {
        const fromOwner = sourceEntry.owner;
        const movableDischarges = getMovablePatientIdsFromOwner(fromOwner, role).filter((pid) => isExpectedDischargePatientId(pid));
        if (!movableDischarges.length) continue;

        const targetOwners = list
          .filter((owner) => owner !== fromOwner)
          .sort((a, b) => {
            const overflowDiff = getExpectedDischargeOverflowLocal(a, role) - getExpectedDischargeOverflowLocal(b, role);
            if (overflowDiff !== 0) return overflowDiff;
            return safeArray(a?.patients).length - safeArray(b?.patients).length;
          });

        for (const patientId of movableDischarges) {
          for (const toOwner of targetOwners) {
            const fromOrig = safeArray(fromOwner.patients).slice();
            const toOrig = safeArray(toOwner.patients).slice();
            const did = tryMovePatient(list, role, fromOwner, toOwner, patientId);
            if (!did) continue;

            const nextAvoid = getAvoidableViolationCount(list, role);
            const nextDischargeAvoid = getAvoidableExpectedDischargeOverflowLocal(list, role);
            const nextRoomOverflow = roomSpreadOverflowLocal(list, role);
            const nextReportOverflow = prevMap ? __reportOverflowTotal(list, prevMap) : 0;
            const nextReportTotal = prevMap ? __reportSourceTotal(list, prevMap) : 0;
            const nextSpread = countSpreadLocal(list);

            fromOwner.patients = fromOrig;
            toOwner.patients = toOrig;

            const improvesDischarge = nextDischargeAvoid < baseDischargeAvoid;
            const avoidsWorseningRules = nextAvoid <= baseAvoid;
            if (!improvesDischarge || !avoidsWorseningRules) continue;

            const candidate = {
              fromOwner,
              toOwner,
              patientId,
              nextAvoid,
              nextDischargeAvoid,
              nextRoomOverflow,
              nextReportTotal,
              nextReportOverflow,
              nextSpread
            };

            if (!best) {
              best = candidate;
              continue;
            }

            if (candidate.nextAvoid !== best.nextAvoid) {
              if (candidate.nextAvoid < best.nextAvoid) best = candidate;
              continue;
            }
            if (candidate.nextDischargeAvoid !== best.nextDischargeAvoid) {
              if (candidate.nextDischargeAvoid < best.nextDischargeAvoid) best = candidate;
              continue;
            }
            if (candidate.nextRoomOverflow !== best.nextRoomOverflow) {
              if (candidate.nextRoomOverflow < best.nextRoomOverflow) best = candidate;
              continue;
            }
            if (candidate.nextReportTotal !== best.nextReportTotal) {
              if (candidate.nextReportTotal < best.nextReportTotal) best = candidate;
              continue;
            }
            if (candidate.nextReportOverflow !== best.nextReportOverflow) {
              if (candidate.nextReportOverflow < best.nextReportOverflow) best = candidate;
              continue;
            }
            if (candidate.nextSpread < best.nextSpread) best = candidate;
          }
        }
      }

      if (!best) break;
      const applied = tryMovePatient(list, role, best.fromOwner, best.toOwner, best.patientId);
      if (!applied) break;
      changed = true;
    }

    return { ok: true, changed };
  }

  function rebalanceSingleMovesStrict(owners, role, opts = {}) {
    const list = Array.isArray(owners) ? owners.filter(Boolean) : [];
    if (list.length < 2) return { ok: true, changed: false };

    const maxPasses = typeof opts.maxPasses === "number" ? opts.maxPasses : 80;
    const maps = buildPrevOwnerMaps();
    const prevMap = role === "nurse" ? maps.prevRnByPid : maps.prevPcaByPid;
    let changed = false;

    for (let pass = 0; pass < maxPasses; pass++) {
      const baseAvoid = getAvoidableViolationCount(list, role);
      const baseDischargeAvoid = getAvoidableExpectedDischargeOverflowLocal(list, role);
      const baseSpread = countSpreadLocal(list);
      const baseRoomOverflow = roomSpreadOverflowLocal(list, role);
      const baseReportOverflow = prevMap ? __reportOverflowTotal(list, prevMap) : 0;
      const baseReportTotal = prevMap ? __reportSourceTotal(list, prevMap) : 0;
      let best = null;

      for (const fromOwner of list) {
        const movable = getMovablePatientIdsFromOwner(fromOwner, role);
        if (!movable.length) continue;

        for (const patientId of movable) {
          for (const toOwner of list) {
            if (!toOwner || toOwner === fromOwner) continue;

            const fromOrig = safeArray(fromOwner.patients).slice();
            const toOrig = safeArray(toOwner.patients).slice();
            const did = tryMovePatient(list, role, fromOwner, toOwner, patientId);
            if (!did) continue;

            const nextAvoid = getAvoidableViolationCount(list, role);
            const nextDischargeAvoid = getAvoidableExpectedDischargeOverflowLocal(list, role);
            const nextSpread = countSpreadLocal(list);
            const nextRoomOverflow = roomSpreadOverflowLocal(list, role);
            const nextReportOverflow = prevMap ? __reportOverflowTotal(list, prevMap) : 0;
            const nextReportTotal = prevMap ? __reportSourceTotal(list, prevMap) : 0;

            fromOwner.patients = fromOrig;
            toOwner.patients = toOrig;

            const improves =
              nextAvoid < baseAvoid ||
              (nextAvoid === baseAvoid && nextDischargeAvoid < baseDischargeAvoid) ||
              (nextAvoid === baseAvoid && nextDischargeAvoid === baseDischargeAvoid && nextSpread < baseSpread) ||
              (nextAvoid === baseAvoid && nextDischargeAvoid === baseDischargeAvoid && nextSpread === baseSpread && nextRoomOverflow < baseRoomOverflow) ||
              (nextAvoid === baseAvoid && nextDischargeAvoid === baseDischargeAvoid && nextSpread === baseSpread && nextRoomOverflow === baseRoomOverflow && nextReportOverflow < baseReportOverflow) ||
              (nextAvoid === baseAvoid && nextDischargeAvoid === baseDischargeAvoid && nextSpread === baseSpread && nextRoomOverflow === baseRoomOverflow && nextReportOverflow === baseReportOverflow && nextReportTotal < baseReportTotal);

            if (!improves) continue;

            const candidate = {
              fromOwner,
              toOwner,
              patientId,
              nextAvoid,
              nextDischargeAvoid,
              nextSpread,
              nextRoomOverflow,
              nextReportTotal,
              nextReportOverflow
            };

            if (!best) {
              best = candidate;
            } else if (candidate.nextAvoid < best.nextAvoid) {
              best = candidate;
            } else if (candidate.nextAvoid === best.nextAvoid && candidate.nextDischargeAvoid < best.nextDischargeAvoid) {
              best = candidate;
            } else if (candidate.nextAvoid === best.nextAvoid && candidate.nextDischargeAvoid === best.nextDischargeAvoid && candidate.nextSpread < best.nextSpread) {
              best = candidate;
            } else if (candidate.nextAvoid === best.nextAvoid && candidate.nextDischargeAvoid === best.nextDischargeAvoid && candidate.nextSpread === best.nextSpread && candidate.nextRoomOverflow < best.nextRoomOverflow) {
              best = candidate;
            } else if (candidate.nextAvoid === best.nextAvoid && candidate.nextDischargeAvoid === best.nextDischargeAvoid && candidate.nextSpread === best.nextSpread && candidate.nextRoomOverflow === best.nextRoomOverflow && candidate.nextReportOverflow < best.nextReportOverflow) {
              best = candidate;
            } else if (candidate.nextAvoid === best.nextAvoid && candidate.nextDischargeAvoid === best.nextDischargeAvoid && candidate.nextSpread === best.nextSpread && candidate.nextRoomOverflow === best.nextRoomOverflow && candidate.nextReportOverflow === best.nextReportOverflow && candidate.nextReportTotal < best.nextReportTotal) {
              best = candidate;
            }

            if (best && best.nextAvoid <= 0 && best.nextDischargeAvoid <= 0 && best.nextSpread <= 1) break;
          }
          if (best && best.nextAvoid <= 0 && best.nextDischargeAvoid <= 0 && best.nextSpread <= 1) break;
        }
        if (best && best.nextAvoid <= 0 && best.nextDischargeAvoid <= 0 && best.nextSpread <= 1) break;
      }

      if (!best) break;
      const applied = tryMovePatient(list, role, best.fromOwner, best.toOwner, best.patientId);
      if (!applied) break;
      changed = true;

      if (best.nextAvoid <= 0 && best.nextDischargeAvoid <= 0 && best.nextSpread <= 1) {
        const checkAvoid = getAvoidableViolationCount(list, role);
        const checkDischargeAvoid = getAvoidableExpectedDischargeOverflowLocal(list, role);
        const checkSpread = countSpreadLocal(list);
        if (checkAvoid <= 0 && checkDischargeAvoid <= 0 && checkSpread <= 1) break;
      }
    }

    return { ok: true, changed };
  }

  function __snapshotSingleOwnerArrays(owners) {
    return safeArray(owners).map((owner) => safeArray(owner?.patients).slice());
  }

  function __debugOwnerSummary(owners) {
    return safeArray(owners).map((owner) => ({
      id: Number(owner?.id),
      name: String(owner?.name || ""),
      count: safeArray(owner?.patients).length,
      patients: safeArray(owner?.patients).slice()
    }));
  }

  function __formatOwnerCounts(summary) {
    return safeArray(summary)
      .map((owner) => `${owner?.name || "Owner"}:${Number(owner?.count) || 0}`)
      .join(" | ");
  }

  function __formatEngineReason(result, fallbackText) {
    if (result?.reason) return String(result.reason);
    if (result?.summary && typeof result.summary === "object") {
      const s = result.summary;
      return [
        typeof s.hardViolations === "number" ? `hard violations ${s.hardViolations}` : "",
        typeof s.countSpread === "number" ? `count spread ${s.countSpread}` : "",
        typeof s.loadSpread === "number" ? `load spread ${s.loadSpread}` : "",
        typeof s.reportOverflow === "number" ? `report overflow ${s.reportOverflow}` : ""
      ].filter(Boolean).join(", ");
    }
    return fallbackText || "No better candidate was accepted.";
  }

  function __nonIdealScore(owners, role, prevMap) {
    const list = Array.isArray(owners) ? owners.filter(Boolean) : [];
    const loads = list.map((owner) => {
      const ids = safeArray(owner?.patients);
      return ids.reduce((sum, pid) => {
        const patient = (typeof window.getPatientById === "function") ? window.getPatientById(pid) : null;
        if (!patient || patient.isEmpty) return sum;
        if (role === "pca") {
          let score = 1;
          if (patient.chg) score += 1;
          if (patient.q2turns || patient.q2Turns) score += 1;
          if (patient.isolation || patient.iso) score += 1;
          if (patient.feeder || patient.feeders) score += 1;
          return sum + score;
        }
        let score = 1;
        if (patient.nih) score += 3;
        if (patient.drip || patient.drips) score += 3;
        if (patient.bg || patient.bgChecks) score += 3;
        if (patient.ciwa || patient.cows || patient.ciwaCows || patient.psych || patient.prns) score += 3;
        if (patient.emu) score += 3;
        if (patient.sitter) score += 3;
        if (patient.restraint || patient.restraints) score += 3;
        if (patient.vpo) score += 3;
        if (patient.admit) score += 3;
        if (patient.tf) score += 2;
        if (patient.isolation || patient.iso) score += 1;
        if (patient.lateDc) score += 1;
        return sum + score;
      }, 0);
    });
    const loadSpread = loads.length ? (Math.max(...loads) - Math.min(...loads)) : 0;
    return {
      violations: getAvoidableViolationCount(list, role),
      dischargeOverflow: getAvoidableExpectedDischargeOverflowLocal(list, role),
      countSpread: countSpreadLocal(list),
      loadSpread,
      roomOverflow: roomSpreadOverflowLocal(list, role),
      reportTotal: prevMap ? __reportSourceTotal(list, prevMap) : 0,
      reportOverflow: prevMap ? __reportOverflowTotal(list, prevMap) : 0
    };
  }

  function __formatNonIdealScore(score) {
    if (!score || typeof score !== "object") return "";
    return `violations ${Number(score.violations) || 0}, discharge ${Number(score.dischargeOverflow) || 0}, spread ${Number(score.countSpread) || 0}, load ${Number(score.loadSpread) || 0}, report ${Number(score.reportOverflow) || 0}, sources ${Number(score.reportTotal) || 0}, room ${Number(score.roomOverflow) || 0}`;
  }

  function __compareNonIdealScore(a, b) {
    const left = [
      Number(a?.violations) || 0,
      Number(a?.dischargeOverflow) || 0,
      Number(a?.countSpread) || 0,
      Number(a?.loadSpread) || 0,
      Number(a?.reportOverflow) || 0,
      Number(a?.reportTotal) || 0,
      Number(a?.roomOverflow) || 0
    ];
    const right = [
      Number(b?.violations) || 0,
      Number(b?.dischargeOverflow) || 0,
      Number(b?.countSpread) || 0,
      Number(b?.loadSpread) || 0,
      Number(b?.reportOverflow) || 0,
      Number(b?.reportTotal) || 0,
      Number(b?.roomOverflow) || 0
    ];
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return left[i] - right[i];
    }
    return 0;
  }

  function __sumNonIdealScores(a, b) {
    return {
      violations: (Number(a?.violations) || 0) + (Number(b?.violations) || 0),
      dischargeOverflow: (Number(a?.dischargeOverflow) || 0) + (Number(b?.dischargeOverflow) || 0),
      countSpread: (Number(a?.countSpread) || 0) + (Number(b?.countSpread) || 0),
      loadSpread: (Number(a?.loadSpread) || 0) + (Number(b?.loadSpread) || 0),
      reportTotal: (Number(a?.reportTotal) || 0) + (Number(b?.reportTotal) || 0),
      reportOverflow: (Number(a?.reportOverflow) || 0) + (Number(b?.reportOverflow) || 0),
      roomOverflow: (Number(a?.roomOverflow) || 0) + (Number(b?.roomOverflow) || 0)
    };
  }

  function __boardQualitySummary(score, role) {
    const items = [];
    if ((Number(score?.violations) || 0) <= 0) items.push(`${role} rules clean`);
    if ((Number(score?.dischargeOverflow) || 0) <= 0) items.push(`${role} discharges clean`);
    if ((Number(score?.countSpread) || 0) <= 0) items.push(`${role} counts balanced`);
    return items.length ? items.join(" | ") : `${role} needs cleanup`;
  }

  function __boardQualityNeeds(score, role) {
    const items = [];
    if ((Number(score?.countSpread) || 0) > 0) items.push("count balance");
    if ((Number(score?.loadSpread) || 0) > (role === "RN" ? 6 : 8)) items.push("fairer acuity/load");
    if ((Number(score?.reportOverflow) || 0) > 0 || (role === "RN" && (Number(score?.reportTotal) || 0) > 24)) items.push("fewer report sources");
    if ((Number(score?.roomOverflow) || 0) > 0) items.push("tighter room clusters");
    if ((Number(score?.violations) || 0) > 0) items.push("rule cleanup");
    return items.slice(0, 2).join(" | ") || "hold this layout";
  }

  function __buildSuggestionBoardSignature(role, owners) {
    const activeIds = __getPatients()
      .filter((p) => p && !p.isEmpty)
      .map((p) => Number(p.id))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    return JSON.stringify({
      role: String(role || ""),
      activeIds,
      owners: safeArray(owners).map((owner) => ({
        id: Number(owner?.id),
        patients: safeArray(owner?.patients).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      }))
    });
  }

  function __patientLabelForSuggestion(patientId) {
    const p = typeof window.getPatientById === "function" ? window.getPatientById(patientId) : null;
    if (!p) return `Patient ${patientId}`;
    const room = getBedLabel(p) || p.room || `Patient ${patientId}`;
    const name = String(p.name || "").trim();
    return name ? `${room} (${name})` : String(room);
  }

  function __metricDeltaText(label, beforeVal, afterVal) {
    const b = Number(beforeVal) || 0;
    const a = Number(afterVal) || 0;
    if (a >= b) return "";
    return `${label} ${b} -> ${a}`;
  }

  function __suggestionBenefits(beforeScore, afterScore) {
    const benefits = [];
    if ((Number(afterScore?.violations) || 0) < (Number(beforeScore?.violations) || 0)) benefits.push("fewer rule conflicts");
    if ((Number(afterScore?.dischargeOverflow) || 0) < (Number(beforeScore?.dischargeOverflow) || 0)) benefits.push("better discharge distribution");
    if ((Number(afterScore?.countSpread) || 0) < (Number(beforeScore?.countSpread) || 0)) benefits.push("better count balance");
    if ((Number(afterScore?.loadSpread) || 0) < (Number(beforeScore?.loadSpread) || 0)) benefits.push("improved acuity distribution");
    if ((Number(afterScore?.reportOverflow) || 0) < (Number(beforeScore?.reportOverflow) || 0) || (Number(afterScore?.reportTotal) || 0) < (Number(beforeScore?.reportTotal) || 0)) benefits.push("fewer handoffs");
    if ((Number(afterScore?.roomOverflow) || 0) < (Number(beforeScore?.roomOverflow) || 0)) benefits.push("tighter room clustering");
    return benefits;
  }

  function __suggestionMetricLines(beforeScore, afterScore) {
    return [
      __metricDeltaText("Violations", beforeScore?.violations, afterScore?.violations),
      __metricDeltaText("Discharge overflow", beforeScore?.dischargeOverflow, afterScore?.dischargeOverflow),
      __metricDeltaText("Count spread", beforeScore?.countSpread, afterScore?.countSpread),
      __metricDeltaText("Load spread", beforeScore?.loadSpread, afterScore?.loadSpread),
      __metricDeltaText("Report overflow", beforeScore?.reportOverflow, afterScore?.reportOverflow),
      __metricDeltaText("Report sources", beforeScore?.reportTotal, afterScore?.reportTotal),
      __metricDeltaText("Room overflow", beforeScore?.roomOverflow, afterScore?.roomOverflow)
    ].filter(Boolean);
  }

  function __weightedSuggestionScore(score) {
    if (!score || typeof score !== "object") return Number.POSITIVE_INFINITY;
    return (
      (Number(score.violations) || 0) * 1000 +
      (Number(score.dischargeOverflow) || 0) * 400 +
      (Number(score.countSpread) || 0) * 120 +
      (Number(score.loadSpread) || 0) * 10 +
      (Number(score.reportOverflow) || 0) * 60 +
      (Number(score.reportTotal) || 0) * 8 +
      (Number(score.roomOverflow) || 0) * 4
    );
  }

  function __buildFallbackCountSuggestions(role, owners, prevMap, beforeScore, beforeWeighted, seen, limit = 8) {
    const list = Array.isArray(owners) ? owners.filter(Boolean) : [];
    if (list.length < 2) return [];

    const byHighCount = list
      .slice()
      .sort((a, b) => safeArray(b?.patients).length - safeArray(a?.patients).length || String(a?.name || "").localeCompare(String(b?.name || "")));
    const byLowCount = list
      .slice()
      .sort((a, b) => safeArray(a?.patients).length - safeArray(b?.patients).length || String(a?.name || "").localeCompare(String(b?.name || "")));

    const candidates = [];
    for (const fromOwner of byHighCount) {
      const movable = getMovablePatientIdsFromOwner(fromOwner, role);
      if (!movable.length) continue;

      for (const toOwner of byLowCount) {
        if (!toOwner || toOwner === fromOwner) continue;
        if (safeArray(fromOwner?.patients).length <= safeArray(toOwner?.patients).length) continue;

        for (const patientId of movable) {
          const beforeSnap = __snapshotSingleOwnerArrays(list);
          const did = tryMovePatient(list, role, fromOwner, toOwner, patientId);
          if (!did) {
            __restoreSingleOwnerArrays(list, beforeSnap);
            continue;
          }

          const afterScore = __nonIdealScore(list, role, prevMap);
          const afterWeighted = __weightedSuggestionScore(afterScore);
          __restoreSingleOwnerArrays(list, beforeSnap);

          const worsensViolations = (Number(afterScore?.violations) || 0) > (Number(beforeScore?.violations) || 0);
          const worsensDischarge = (Number(afterScore?.dischargeOverflow) || 0) > (Number(beforeScore?.dischargeOverflow) || 0);
          const improvesCounts = (Number(afterScore?.countSpread) || 0) < (Number(beforeScore?.countSpread) || 0);
          const improvesOverall = afterWeighted < beforeWeighted;
          if (worsensViolations || worsensDischarge) continue;
          if (!(improvesCounts || improvesOverall)) continue;

          const candidate = {
            role,
            patientId: Number(patientId),
            fromOwnerId: Number(fromOwner?.id),
            toOwnerId: Number(toOwner?.id),
            fromOwnerName: String(fromOwner?.name || ""),
            toOwnerName: String(toOwner?.name || ""),
            patientLabel: __patientLabelForSuggestion(patientId),
            beforeScore,
            afterScore,
            weightedDelta: beforeWeighted - afterWeighted,
            compare: __compareNonIdealScore(afterScore, beforeScore),
            benefits: __suggestionBenefits(beforeScore, afterScore),
            metricLines: __suggestionMetricLines(beforeScore, afterScore),
            signature: __buildSuggestionBoardSignature(role, list)
          };

          const dedupeKey = `${candidate.patientId}:${candidate.fromOwnerId}:${candidate.toOwnerId}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          candidates.push(candidate);
          if (candidates.length >= limit) return candidates;
        }
      }
    }

    return candidates;
  }

  function __findBestSuggestionsForRole(role, owners, prevMap, limit = 8) {
    const list = Array.isArray(owners) ? owners.filter(Boolean) : [];
    if (list.length < 2) return [];

    const beforeScore = __nonIdealScore(list, role, prevMap);
    const beforeWeighted = __weightedSuggestionScore(beforeScore);
    const candidates = [];
    const seen = new Set();

    for (const fromOwner of list) {
      const movable = getMovablePatientIdsFromOwner(fromOwner, role);
      if (!movable.length) continue;

      for (const patientId of movable) {
        for (const toOwner of list) {
          if (!toOwner || toOwner === fromOwner) continue;

          const beforeSnap = __snapshotSingleOwnerArrays(list);
          const did = tryMovePatient(list, role, fromOwner, toOwner, patientId);
          if (!did) {
            __restoreSingleOwnerArrays(list, beforeSnap);
            continue;
          }

          const afterScore = __nonIdealScore(list, role, prevMap);
          const cmp = __compareNonIdealScore(afterScore, beforeScore);
          const afterWeighted = __weightedSuggestionScore(afterScore);
          __restoreSingleOwnerArrays(list, beforeSnap);

          const improvesViolations = (Number(afterScore?.violations) || 0) < (Number(beforeScore?.violations) || 0);
          const improvesDischarge = (Number(afterScore?.dischargeOverflow) || 0) < (Number(beforeScore?.dischargeOverflow) || 0);
          const improvesWeighted = afterWeighted < beforeWeighted;
          const worsensViolations = (Number(afterScore?.violations) || 0) > (Number(beforeScore?.violations) || 0);
          const worsensDischarge = (Number(afterScore?.dischargeOverflow) || 0) > (Number(beforeScore?.dischargeOverflow) || 0);

          if (worsensViolations || worsensDischarge) continue;
          if (!(cmp < 0 || improvesViolations || improvesDischarge || improvesWeighted)) continue;

          const benefits = __suggestionBenefits(beforeScore, afterScore);
          const metricLines = __suggestionMetricLines(beforeScore, afterScore);
          const candidate = {
            role,
            patientId: Number(patientId),
            fromOwnerId: Number(fromOwner?.id),
            toOwnerId: Number(toOwner?.id),
            fromOwnerName: String(fromOwner?.name || ""),
            toOwnerName: String(toOwner?.name || ""),
            patientLabel: __patientLabelForSuggestion(patientId),
            beforeScore,
            afterScore,
            weightedDelta: beforeWeighted - afterWeighted,
            compare: cmp,
            benefits,
            metricLines,
            signature: __buildSuggestionBoardSignature(role, list)
          };

          const dedupeKey = `${candidate.patientId}:${candidate.fromOwnerId}:${candidate.toOwnerId}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          candidates.push(candidate);
        }
      }
    }

    if (!candidates.length) {
      const ruleMap = safeGetRuleEvalMap(list, role);
      const flaggedOwners = list.filter((owner) => {
        const ruleEval = getOwnerRuleEvalFromMap(owner, ruleMap);
        return (ruleEval?.violations?.length || 0) > 0;
      });

      for (const fromOwner of flaggedOwners) {
        const movable = getMovablePatientIdsFromOwner(fromOwner, role);
        if (!movable.length) continue;

        for (const patientId of movable) {
          for (const toOwner of list) {
            if (!toOwner || toOwner === fromOwner) continue;

            const beforeSnap = __snapshotSingleOwnerArrays(list);
            const fromCountBefore = safeArray(fromOwner?.patients).length;
            const toCountBefore = safeArray(toOwner?.patients).length;
            const did = tryMovePatient(list, role, fromOwner, toOwner, patientId);
            if (!did) {
              __restoreSingleOwnerArrays(list, beforeSnap);
              continue;
            }

            const afterScore = __nonIdealScore(list, role, prevMap);
            const afterWeighted = __weightedSuggestionScore(afterScore);
            __restoreSingleOwnerArrays(list, beforeSnap);

            const worsensViolations = (Number(afterScore?.violations) || 0) > (Number(beforeScore?.violations) || 0);
            const worsensDischarge = (Number(afterScore?.dischargeOverflow) || 0) > (Number(beforeScore?.dischargeOverflow) || 0);
            const helpsRules = (Number(afterScore?.violations) || 0) < (Number(beforeScore?.violations) || 0);
            const helpsCounts = fromCountBefore > toCountBefore;
            const helpsOverall = afterWeighted < beforeWeighted;
            if (worsensViolations || worsensDischarge) continue;
            if (!(helpsRules || helpsCounts || helpsOverall)) continue;

            const benefits = __suggestionBenefits(beforeScore, afterScore);
            const metricLines = __suggestionMetricLines(beforeScore, afterScore);
            const candidate = {
              role,
              patientId: Number(patientId),
              fromOwnerId: Number(fromOwner?.id),
              toOwnerId: Number(toOwner?.id),
              fromOwnerName: String(fromOwner?.name || ""),
              toOwnerName: String(toOwner?.name || ""),
              patientLabel: __patientLabelForSuggestion(patientId),
              beforeScore,
              afterScore,
              weightedDelta: beforeWeighted - afterWeighted,
              compare: __compareNonIdealScore(afterScore, beforeScore),
              benefits,
              metricLines,
              signature: __buildSuggestionBoardSignature(role, list)
            };

            const dedupeKey = `${candidate.patientId}:${candidate.fromOwnerId}:${candidate.toOwnerId}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            candidates.push(candidate);
          }
        }
      }
    }

    if (!candidates.length) {
      candidates.push(...__buildFallbackCountSuggestions(role, list, prevMap, beforeScore, beforeWeighted, seen, limit));
    }

    candidates.sort((a, b) => {
      const learnDiff = __suggestionLearningScore(b) - __suggestionLearningScore(a);
      if (learnDiff !== 0) return learnDiff;
      const violationDeltaA = (Number(a.beforeScore?.violations) || 0) - (Number(a.afterScore?.violations) || 0);
      const violationDeltaB = (Number(b.beforeScore?.violations) || 0) - (Number(b.afterScore?.violations) || 0);
      if (violationDeltaA !== violationDeltaB) return violationDeltaB - violationDeltaA;
      const dischargeDeltaA = (Number(a.beforeScore?.dischargeOverflow) || 0) - (Number(a.afterScore?.dischargeOverflow) || 0);
      const dischargeDeltaB = (Number(b.beforeScore?.dischargeOverflow) || 0) - (Number(b.afterScore?.dischargeOverflow) || 0);
      if (dischargeDeltaA !== dischargeDeltaB) return dischargeDeltaB - dischargeDeltaA;
      if ((Number(a.weightedDelta) || 0) !== (Number(b.weightedDelta) || 0)) return (Number(b.weightedDelta) || 0) - (Number(a.weightedDelta) || 0);
      const cmp = __compareNonIdealScore(a.afterScore, b.afterScore);
      if (cmp !== 0) return cmp;
      if (a.benefits.length !== b.benefits.length) return b.benefits.length - a.benefits.length;
      return String(a.fromOwnerName || "").localeCompare(String(b.fromOwnerName || ""));
    });

    return candidates.slice(0, Math.max(1, Number(limit) || 8)).map((candidate) => ({
      ...candidate,
      summary: `${candidate.patientLabel}: move from ${candidate.fromOwnerName || "Owner A"} to ${candidate.toOwnerName || "Owner B"}`,
      impact: candidate.benefits.slice(0, 3).join(" | ") || "Improves board quality"
    }));
  }

  function __getOncomingSuggestions() {
    window.__oncomingSuggestionDismissed = window.__oncomingSuggestionDismissed || {};

    const prevMaps = __getPrevMapsForCycle();
    const { prevRnByPid, prevPcaByPid } = prevMaps || buildPrevOwnerMaps();
    const rnOwners = __getIncomingNursesReal();
    const pcaOwners = __getIncomingPcasReal().filter((p) => !__isPcaSpecialOwner(p));

    const rnSuggestions = __findBestSuggestionsForRole("nurse", rnOwners, prevRnByPid, 8);
    const pcaSuggestions = __findBestSuggestionsForRole("pca", pcaOwners, prevPcaByPid, 8);
    const rnDismissed = new Set(safeArray(window.__oncomingSuggestionDismissed.nurse));
    const pcaDismissed = new Set(safeArray(window.__oncomingSuggestionDismissed.pca));

    return {
      nurse: rnSuggestions.filter((suggestion) => !rnDismissed.has(`${suggestion.patientId}:${suggestion.fromOwnerId}:${suggestion.toOwnerId}`)),
      pca: pcaSuggestions.filter((suggestion) => !pcaDismissed.has(`${suggestion.patientId}:${suggestion.fromOwnerId}:${suggestion.toOwnerId}`))
    };
  }

  const SUGGESTION_FEEDBACK_KEY = "zca_oncoming_suggestion_feedback_v1";

  function __suggestionActionKey(role, patientId, fromOwnerId, toOwnerId) {
    return `${String(role || "")}:${Number(patientId)}:${Number(fromOwnerId)}:${Number(toOwnerId)}`;
  }

  function __suggestionPatternKey(suggestion) {
    const p = typeof window.getPatientById === "function" ? window.getPatientById(suggestion?.patientId) : null;
    const tagParts = [];
    if (p) {
      [
        "tele", "drip", "drips", "nih", "bg", "bgChecks", "ciwa", "cows", "ciwaCows", "psych", "prns", "emu",
        "sitter", "isolation", "iso", "admit", "lateDc", "expectedDischarge",
        "chg", "foley", "q2turns", "q2Turns", "feeder", "heavy"
      ].forEach((key) => {
        if (p[key]) tagParts.push(key);
      });
    }
    const benefits = safeArray(suggestion?.benefits).slice(0, 4).sort();
    return [
      String(suggestion?.role || ""),
      tagParts.sort().join(",") || "no-tags",
      benefits.join(",") || "generic"
    ].join("|");
  }

  function __readSuggestionFeedback() {
    try {
      const raw = localStorage.getItem(SUGGESTION_FEEDBACK_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") {
        parsed.records = safeArray(parsed.records);
        parsed.patterns = parsed.patterns && typeof parsed.patterns === "object" ? parsed.patterns : {};
        return parsed;
      }
    } catch (_) {}
    return { records: [], patterns: {} };
  }

  function __writeSuggestionFeedback(store) {
    try {
      const next = {
        records: safeArray(store?.records).slice(-250),
        patterns: store?.patterns && typeof store.patterns === "object" ? store.patterns : {}
      };
      localStorage.setItem(SUGGESTION_FEEDBACK_KEY, JSON.stringify(next));
    } catch (_) {}
  }

  function __feedbackValue(action) {
    const a = String(action || "");
    if (a === "accepted") return 1;
    if (a === "helpful") return 3;
    if (a === "not_helpful") return -4;
    return 0;
  }

  function __recordSuggestionFeedback(suggestion, action) {
    if (!suggestion) return;
    const store = __readSuggestionFeedback();
    const patternKey = __suggestionPatternKey(suggestion);
    const value = __feedbackValue(action);
    const pattern = store.patterns[patternKey] || { score: 0, accepted: 0, declined: 0, helpful: 0, not_helpful: 0 };
    pattern.score = Number(pattern.score || 0) + value;
    if (action === "accepted") pattern.accepted = Number(pattern.accepted || 0) + 1;
    if (action === "declined") pattern.declined = Number(pattern.declined || 0) + 1;
    if (action === "helpful") pattern.helpful = Number(pattern.helpful || 0) + 1;
    if (action === "not_helpful") pattern.not_helpful = Number(pattern.not_helpful || 0) + 1;
    store.patterns[patternKey] = pattern;
    store.records.push({
      at: new Date().toISOString(),
      action: String(action || ""),
      patternKey,
      actionKey: __suggestionActionKey(suggestion.role, suggestion.patientId, suggestion.fromOwnerId, suggestion.toOwnerId),
      role: suggestion.role,
      patientId: Number(suggestion.patientId),
      fromOwnerId: Number(suggestion.fromOwnerId),
      toOwnerId: Number(suggestion.toOwnerId),
      impact: suggestion.impact || "",
      benefits: safeArray(suggestion.benefits)
    });
    __writeSuggestionFeedback(store);
  }

  function __suggestionLearningScore(suggestion) {
    const store = __readSuggestionFeedback();
    const pattern = store.patterns[__suggestionPatternKey(suggestion)];
    return pattern ? Number(pattern.score || 0) : 0;
  }

  function __findCurrentSuggestion(role, patientId, fromOwnerId, toOwnerId) {
    const activeSuggestions = window.__lastOncomingSuggestions || { nurse: [], pca: [] };
    const list = String(role || "") === "pca" ? activeSuggestions.pca : activeSuggestions.nurse;
    return safeArray(list).find((s) =>
      Number(s?.patientId) === Number(patientId) &&
      Number(s?.fromOwnerId) === Number(fromOwnerId) &&
      Number(s?.toOwnerId) === Number(toOwnerId)
    ) || null;
  }

  function __applySuggestion(role, patientId, fromOwnerId, toOwnerId) {
    const owners = role === "pca" ? __getIncomingPcasReal().filter((p) => !__isPcaSpecialOwner(p)) : __getIncomingNursesReal();
    const fromOwner = owners.find((owner) => Number(owner?.id) === Number(fromOwnerId));
    const toOwner = owners.find((owner) => Number(owner?.id) === Number(toOwnerId));
    if (!fromOwner || !toOwner) return false;

    const suggestion = __findCurrentSuggestion(role, patientId, fromOwnerId, toOwnerId);
    const applied = tryMovePatient(owners, role, fromOwner, toOwner, Number(patientId));
    if (!applied) return false;

    if (suggestion) __recordSuggestionFeedback(suggestion, "accepted");
    window.__oncomingSuggestionDismissed = window.__oncomingSuggestionDismissed || {};
    window.__oncomingSuggestionDismissed[role] = [];
    window.__oncomingSuggestionsCollapsed = true;
    window.__lastOncomingSuggestions = null;
    __suspendOncomingAutoPopulate(7000);
    __suspendCloudRealtimeApply(7000);
    try {
      if (window.cloudSync && typeof window.cloudSync.noteLocalUnitEdit === "function") {
        window.cloudSync.noteLocalUnitEdit("oncoming_suggestion_accept");
      }
    } catch (_) {}
    try { if (typeof window.saveState === "function") window.saveState(); } catch (_) {}
    try { renderOncomingAll(); } catch (_) {}
    try {
      if (window.cloudSync && typeof window.cloudSync.publishUnitStateDebounced === "function") {
        window.cloudSync.publishUnitStateDebounced("oncoming_suggestion_accept");
      }
    } catch (_) {}
    __showOncomingRebalanceToast("ok", `Applied suggestion: ${__patientLabelForSuggestion(patientId)} to ${String(toOwner?.name || "new owner")}.`);
    return true;
  }

  window.acceptOncomingSuggestion = function acceptOncomingSuggestion(role, patientId, fromOwnerId, toOwnerId) {
    __applySuggestion(String(role || ""), Number(patientId), Number(fromOwnerId), Number(toOwnerId));
  };

  window.dismissOncomingSuggestion = function dismissOncomingSuggestion(role) {
    const current = __getOncomingSuggestions();
    const suggestion = String(role || "") === "pca" ? current.pca?.[0] : current.nurse?.[0];
    window.__oncomingSuggestionDismissed = window.__oncomingSuggestionDismissed || {};
    const key = String(role || "");
    const existing = new Set(safeArray(window.__oncomingSuggestionDismissed[key]));
    if (suggestion) existing.add(`${suggestion.patientId}:${suggestion.fromOwnerId}:${suggestion.toOwnerId}`);
    window.__oncomingSuggestionDismissed[key] = Array.from(existing);
    try { renderOncomingAll(); } catch (_) {}
  };

  window.dismissSpecificOncomingSuggestion = function dismissSpecificOncomingSuggestion(role, patientId, fromOwnerId, toOwnerId) {
    const suggestion = __findCurrentSuggestion(role, patientId, fromOwnerId, toOwnerId);
    if (suggestion) __recordSuggestionFeedback(suggestion, "declined");
    window.__oncomingSuggestionDismissed = window.__oncomingSuggestionDismissed || {};
    const key = String(role || "");
    const existing = new Set(safeArray(window.__oncomingSuggestionDismissed[key]));
    existing.add(`${Number(patientId)}:${Number(fromOwnerId)}:${Number(toOwnerId)}`);
    window.__oncomingSuggestionDismissed[key] = Array.from(existing);
    try { renderOncomingAll(); } catch (_) {}
  };

  window.rateOncomingSuggestion = function rateOncomingSuggestion(role, patientId, fromOwnerId, toOwnerId, rating) {
    const suggestion = __findCurrentSuggestion(role, patientId, fromOwnerId, toOwnerId);
    if (!suggestion) return;
    const action = String(rating || "") === "down" ? "not_helpful" : "helpful";
    __recordSuggestionFeedback(suggestion, action);
    if (action === "not_helpful") {
      window.dismissSpecificOncomingSuggestion(role, patientId, fromOwnerId, toOwnerId);
    } else {
      __showOncomingRebalanceToast("ok", "Feedback saved. Similar suggestions will be prioritized when they fit.");
    }
  };

  window.refreshOncomingSuggestions = function refreshOncomingSuggestions() {
    window.__oncomingSuggestionDismissed = { nurse: [], pca: [] };
    window.__lastOncomingSuggestions = null;
    window.__oncomingSuggestionsCollapsed = false;
    try { __renderOncomingQualityPanel({ force: true, forceSuggestions: true, reason: "manual_refresh_suggestions" }); } catch (_) {}
  };

  function __isOncomingTabVisible() {
    const oncomingTab = document.getElementById("oncomingAssignmentTab");
    return !!(oncomingTab && oncomingTab.style.display !== "none");
  }

  function __syncOncomingQualityPanelVisibility() {
    const panel = document.getElementById("oncomingQualityPanel");
    if (!panel) return;
    if (!__isOncomingTabVisible()) {
      panel.style.display = "none";
      panel.innerHTML = "";
      return;
    }
    if (!panel.innerHTML.trim()) return;
    panel.style.display = "block";
  }

  window.toggleOncomingRnSuggestionsPanel = function toggleOncomingRnSuggestionsPanel() {
    window.__oncomingRnSuggestionsCollapsed = window.__oncomingRnSuggestionsCollapsed === false ? true : false;
    try { __renderOncomingQualityPanel(); } catch (_) {}
  };

  window.toggleOncomingPcaSuggestionsPanel = function toggleOncomingPcaSuggestionsPanel() {
    window.__oncomingPcaSuggestionsCollapsed = window.__oncomingPcaSuggestionsCollapsed === false ? true : false;
    try { __renderOncomingQualityPanel(); } catch (_) {}
  };

  window.toggleOncomingSuggestionsPanel = function toggleOncomingSuggestionsPanel() {
    const isOpen = window.__oncomingSuggestionsCollapsed === false;
    window.__oncomingSuggestionsCollapsed = isOpen ? true : false;
    try { __renderOncomingQualityPanel({ force: true, forceSuggestions: true, reason: "suggestions_toggle" }); } catch (_) {}
  };

  function __shouldDeferOncomingQualityPanel() {
    return Date.now() < Number(window.__suspendOncomingQualityUntil || 0);
  }

  function __scheduleOncomingQualityPanel(reason) {
    if (window.__oncomingQualityPanelTimer) clearTimeout(window.__oncomingQualityPanelTimer);
    window.__oncomingQualityPanelTimer = setTimeout(() => {
      window.__oncomingQualityPanelTimer = null;
      if (__shouldDeferOncomingQualityPanel()) {
        __scheduleOncomingQualityPanel(reason || "deferred");
        return;
      }
      try { __renderOncomingQualityPanel({ force: true, reason: reason || "deferred" }); } catch (_) {}
    }, 260);
  }

  function __roomsForAssistant(key) {
    return __getPatients()
      .filter((p) => p && !p.isEmpty && (
        key === "tele" ? !!p.tele :
        key === "nih" ? !!p.nih :
        key === "isolation" ? !!(p.isolation || p.iso) :
        key === "feeder" ? !!(p.feeder || p.feeders) :
        key === "totalCare" ? !!(p.strictIo || p.heavy) :
        false
      ))
      .map((p) => String(typeof window.getRoomLabelForPatient === "function" ? window.getRoomLabelForPatient(p) : (p.room || p.id || "")).replace(/[^\dA-Za-z]/g, ""))
      .filter(Boolean)
      .sort((a, b) => {
        const na = Number((String(a).match(/\d+/) || [9999])[0]);
        const nb = Number((String(b).match(/\d+/) || [9999])[0]);
        return na - nb || String(a).localeCompare(String(b));
      });
  }

  function __ownerMetricLines(owners, role) {
    return safeArray(owners).map((owner) => {
      const pts = safeArray(owner?.patients)
        .map((pid) => (typeof window.getPatientById === "function" ? window.getPatientById(pid) : null))
        .filter((p) => p && !p.isEmpty);
      const tele = pts.filter((p) => p.tele).length;
      const nih = pts.filter((p) => p.nih).length;
      const emu = pts.filter((p) => p.emu).length;
      const rooms = pts.map((p) => String(typeof window.getRoomLabelForPatient === "function" ? window.getRoomLabelForPatient(p) : (p.room || p.id || ""))).join(", ");
      return `${owner?.name || role}: ${pts.length} patients${tele ? `, ${tele} tele` : ""}${nih ? `, ${nih} NIH` : ""}${emu ? `, ${emu} EMU` : ""}${rooms ? ` (${rooms})` : ""}`;
    });
  }

  function __nihAssignmentInsight(nurses) {
    const list = safeArray(nurses);
    const nihRows = list.map((owner) => ({
      owner,
      count: countNihForOwner(owner),
      total: safeArray(owner?.patients).length,
      rooms: safeArray(owner?.patients)
        .filter((pid) => isNihPatientId(pid))
        .map((pid) => {
          const p = typeof window.getPatientById === "function" ? window.getPatientById(pid) : null;
          return p ? String(typeof window.getRoomLabelForPatient === "function" ? window.getRoomLabelForPatient(p) : (p.room || p.id || "")) : "";
        })
        .filter(Boolean)
    }));
    const totalNih = nihRows.reduce((sum, row) => sum + row.count, 0);
    const targetMax = Math.max(1, Math.ceil(totalNih / Math.max(1, list.length)));
    const overloaded = nihRows.filter((row) => row.count > targetMax);
    const available = nihRows.filter((row) => row.count < targetMax && row.total < 4);
    if (!totalNih) return "I do not see any NIH patients marked right now.";
    if (!overloaded.length) {
      return `NIH distribution looks acceptable: ${totalNih} NIH patient${totalNih === 1 ? "" : "s"} across ${list.length} RN groups, target max ${targetMax} per RN. I would still keep any Tele/NIH/EMU RN at 4:1.`;
    }
    const overloadText = overloaded.map((row) => `${row.owner?.name || "RN"} has ${row.count} NIH (${row.rooms.join(", ")})`).join("; ");
    const availableText = available.length
      ? `Good receiving groups: ${available.slice(0, 4).map((row) => `${row.owner?.name || "RN"} (${row.total} pts)`).join(", ")}.`
      : "I do not see an obvious RN under 4 patients without NIH, so I would look for a med-surg swap rather than a simple add.";
    return `I would rebalance the NIH load. ${overloadText}. With ${totalNih} NIH and ${list.length} RNs, the target is no more than ${targetMax} NIH per RN unless staffing makes that impossible. ${availableText} A good move is to move one NIH from the overloaded RN to an RN with no NIH while keeping both groups at 4:1.`;
  }

  function __assistantPatientRows(owner, role) {
    return safeArray(owner?.patients)
      .map((pid) => (typeof window.getPatientById === "function" ? window.getPatientById(pid) : null))
      .filter((p) => p && !p.isEmpty)
      .map((p) => {
        const room = String(typeof window.getRoomLabelForPatient === "function" ? window.getRoomLabelForPatient(p) : (p.room || p.id || "")).trim();
        const score = role === "pca"
          ? (1 + (p.chg ? 1 : 0) + (p.q2turns || p.q2Turns ? 1 : 0) + (p.isolation || p.iso ? 1 : 0) + (p.feeder || p.feeders ? 1 : 0))
          : (1 + (p.nih ? 3 : 0) + (p.drip || p.drips ? 3 : 0) + (p.bg || p.bgChecks ? 3 : 0) + (p.ciwa || p.cows || p.ciwaCows || p.psych || p.prns ? 3 : 0) + (p.emu ? 3 : 0) + (p.sitter ? 3 : 0) + (p.restraint || p.restraints ? 3 : 0) + (p.vpo ? 3 : 0) + (p.admit ? 3 : 0) + (p.tf ? 2 : 0) + (p.isolation || p.iso ? 1 : 0) + (p.lateDc ? 1 : 0));
        const roomNo = roomNumberLocal(p.id);
        return { patient: p, room, roomNo, score };
      })
      .sort((a, b) => (a.roomNo || 9999) - (b.roomNo || 9999) || String(a.room).localeCompare(String(b.room)));
  }

  function __assistantOwnerStats(owners, role) {
    return safeArray(owners).map((owner) => {
      const rows = __assistantPatientRows(owner, role);
      const rooms = rows.map((row) => row.room).filter(Boolean);
      const roomNumbers = rows.map((row) => row.roomNo).filter(Number.isFinite);
      const acuity = rows.reduce((sum, row) => sum + (Number(row.score) || 0), 0);
      const span = roomNumbers.length > 1 ? Math.max(...roomNumbers) - Math.min(...roomNumbers) : 0;
      const tele = rows.filter((row) => row.patient.tele).length;
      const nih = rows.filter((row) => row.patient.nih).length;
      const emu = rows.filter((row) => row.patient.emu).length;
      const discharges = rows.filter((row) => row.patient.expectedDischarge).length;
      const tags = {};
      rows.forEach((row) => {
        __assistantPatientTags(row.patient, role).forEach((tag) => {
          tags[tag] = (tags[tag] || 0) + 1;
        });
      });
      return {
        owner,
        name: String(owner?.name || role || "Owner"),
        count: rows.length,
        acuity,
        span,
        rooms,
        roomNumbers,
        rows,
        tags,
        tele,
        nih,
        emu,
        discharges
      };
    });
  }

  function __assistantPatientTags(p, role) {
    if (!p) return [];
    if (role === "pca") {
      return [
        p.isolation || p.iso ? "ISO" : "",
        p.admit || p.admitPca ? "Admit" : "",
        p.lateDc || p.lateDcPca ? "Late DC" : "",
        p.chg ? "CHG" : "",
        p.foley ? "Foley" : "",
        p.q2turns || p.q2Turns ? "Q2 Turns" : "",
        p.strictIo || p.heavy ? "Total Care" : "",
        p.feeder ? "Feeder" : ""
      ].filter(Boolean);
    }
    return [
      p.tele ? "Tele" : "",
      p.nih ? "NIH" : "",
      p.drip || p.drips ? "Drip" : "",
      p.bg || p.bgChecks ? "BG" : "",
      p.tf ? "TF" : "",
      p.ciwa || (!p.cows && p.ciwaCows) ? "CIWA" : "",
      p.cows ? "COWS" : "",
      p.psych ? "Psych" : "",
      p.prns ? "PRNs" : "",
      p.emu ? "EMU" : "",
      p.restraint || p.restraints ? "Restraint" : "",
      p.sitter ? "Sitter" : "",
      p.vpo ? "VPO" : "",
      p.isolation || p.iso ? "ISO" : "",
      p.admit ? "Admit" : "",
      p.lateDc ? "Late DC" : ""
    ].filter(Boolean);
  }

  function __assistantTagSummary(tags, limit = 4) {
    const rows = Object.keys(tags || {})
      .map((key) => ({ key, n: Number(tags[key]) || 0 }))
      .filter((row) => row.n > 0)
      .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key))
      .slice(0, limit);
    return rows.map((row) => `${row.key} x${row.n}`).join(", ");
  }

  function __assistantTopUnitNeeds(stats) {
    const totals = {};
    safeArray(stats).forEach((s) => {
      Object.keys(s.tags || {}).forEach((key) => {
        totals[key] = (totals[key] || 0) + (Number(s.tags[key]) || 0);
      });
    });
    return __assistantTagSummary(totals, 6) || "routine care needs";
  }

  function __assistantOwnerOneLine(stat, role, ruleEval) {
    const label = role === "pca" ? "PCA" : "RN";
    const rooms = stat.rooms.length ? stat.rooms.join(", ") : "no rooms";
    const tagText = __assistantTagSummary(stat.tags, 5) || "no high-risk tags";
    const ruleText = buildRuleTooltip(ruleEval);
    const ratioNote = role === "nurse" && (stat.tele || stat.nih || stat.emu)
      ? "keep near 4:1"
      : role === "nurse"
        ? "med-surg cap 5"
        : "watch turns/feeders/ISO";
    return `${stat.name}: ${stat.count} ${label} pts, acuity ${stat.acuity}, rooms ${rooms}, span ${stat.span}; ${tagText}; ${ratioNote}${ruleText ? `; flags: ${ruleText}` : ""}.`;
  }

  function __assistantGroupByGroup(owners, role, ruleMap) {
    const stats = __assistantOwnerStats(owners, role);
    if (!stats.length) return role === "pca" ? "No PCA groups are built yet." : "No RN groups are built yet.";
    return stats
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((stat) => __assistantOwnerOneLine(stat, role, getOwnerRuleEvalFromMap(stat.owner, ruleMap)))
      .join(" ");
  }

  function __assistantCompareNamedGroups(rawQuestion, nurses, pcas, rnRuleMap, pcaRuleMap) {
    const q = String(rawQuestion || "").toLowerCase();
    const all = __assistantOwnerStats(nurses, "nurse").map((s) => ({ ...s, role: "nurse", ruleMap: rnRuleMap }))
      .concat(__assistantOwnerStats(pcas, "pca").map((s) => ({ ...s, role: "pca", ruleMap: pcaRuleMap })));
    const genericNames = new Set(["rn", "nurse", "pca", "tech", "assistant"]);
    const named = all.filter((s) => {
      const first = firstNameOnly(s.name).toLowerCase();
      const full = String(s.name || "").toLowerCase();
      if (genericNames.has(first) || genericNames.has(full)) return false;
      return (first && q.includes(first)) || (full && q.includes(full));
    });
    const picks = named.length >= 2 ? named.slice(0, 3) : [];
    if (!picks.length) return "";
    const sorted = picks.slice().sort((a, b) => b.acuity - a.acuity || b.count - a.count);
    const high = sorted[0];
    const low = sorted[sorted.length - 1];
    const details = picks.map((s) => __assistantOwnerOneLine(s, s.role, getOwnerRuleEvalFromMap(s.owner, s.ruleMap))).join(" ");
    return `Comparing those groups directly: ${details} My read is that ${high.name} is heavier than ${low.name} by ${Math.max(0, high.acuity - low.acuity)} acuity point(s) and ${Math.max(0, high.count - low.count)} patient(s). If you are choosing one adjustment, move the lowest-disruption patient from ${high.name} toward ${low.name} only if it does not create a new hard-rule flag or widen the room run.`;
  }

  function __assistantRuleBookText() {
    return [
      "Here are the rules I am using as my charge-nurse lens:",
      "RN counts should stay within one patient when possible.",
      "Any RN group with Tele, NIH, or EMU should generally stay at 4:1; med-surg-only groups can go to 5:1, but not past 5.",
      "Avoid stacking RN limit-one tags unless unavoidable: Drip, NIH, CIWA, COWS, Psych, PRNs, EMU, restraint, sitter, and VPO. NIH and EMU should not be paired unless unit math leaves no better path. BG and TF should be spread instead of clustered.",
      "PCA load score is 1 point per patient plus 1 each for CHG, totals, isolation, and feeders.",
      "Expected discharges should not all land on the same group.",
      "Room spread matters: a numerically fair assignment can still feel bad when one person is stretched across a wide hallway run.",
      "Continuity matters too: when two moves are otherwise similar, prefer fewer report-source changes."
    ].join(" ");
  }

  function __assistantUnitSnapshot(nurses, pcas, rnRuleMap, pcaRuleMap, prevMaps) {
    const pts = __getPatients().filter((p) => p && !p.isEmpty);
    const rnStats = __assistantOwnerStats(nurses, "nurse");
    const pcaStats = __assistantOwnerStats(pcas, "pca");
    const rnScore = __nonIdealScore(nurses, "nurse", prevMaps?.prevRnByPid);
    const pcaScore = __nonIdealScore(pcas, "pca", prevMaps?.prevPcaByPid);
    const rnWarnings = rnStats.reduce((sum, s) => sum + visibleRuleCounts(getOwnerRuleEvalFromMap(s.owner, rnRuleMap)).violations, 0);
    const pcaWarnings = pcaStats.reduce((sum, s) => sum + visibleRuleCounts(getOwnerRuleEvalFromMap(s.owner, pcaRuleMap)).violations, 0);
    const rnNeeds = __assistantTopUnitNeeds(rnStats);
    const pcaNeeds = __assistantTopUnitNeeds(pcaStats);
    const rnCounts = rnStats.map((s) => s.count);
    const pcaCounts = pcaStats.map((s) => s.count);
    const rnSpread = rnCounts.length ? `${Math.min(...rnCounts)}-${Math.max(...rnCounts)}` : "none";
    const pcaSpread = pcaCounts.length ? `${Math.min(...pcaCounts)}-${Math.max(...pcaCounts)}` : "none";
    const rnLoad = rnStats.map((s) => s.acuity);
    const pcaLoad = pcaStats.map((s) => s.acuity);
    const rnLoadSpread = rnLoad.length ? `${Math.min(...rnLoad)}-${Math.max(...rnLoad)}` : "none";
    const pcaLoadSpread = pcaLoad.length ? `${Math.min(...pcaLoad)}-${Math.max(...pcaLoad)}` : "none";
    return `Unit read: ${pts.length} active patients across ${rnStats.length} RN group(s) and ${pcaStats.length} PCA group(s). RN count spread ${rnSpread}, RN acuity spread ${rnLoadSpread}, top RN needs: ${rnNeeds}. PCA count spread ${pcaSpread}, PCA workload spread ${pcaLoadSpread}, top PCA needs: ${pcaNeeds}. Visible rule flags: RN ${rnWarnings}, PCA ${pcaWarnings}. Board-quality score is RN ${Number(rnScore?.total || 0).toFixed(0)} and PCA ${Number(pcaScore?.total || 0).toFixed(0)}; lower is better.`;
  }

  function __assistantPrioritizedFeedback(nurses, pcas, rnRuleMap, pcaRuleMap, prevMaps) {
    const issues = [];
    const rnStats = __assistantOwnerStats(nurses, "nurse");
    const pcaStats = __assistantOwnerStats(pcas, "pca");
    rnStats.forEach((s) => {
      const flags = visibleRuleCounts(getOwnerRuleEvalFromMap(s.owner, rnRuleMap));
      if (flags.violations) issues.push({ weight: 100 + flags.violations, text: `${s.name} has ${flags.violations} RN hard-rule flag(s); fix this before fine-tuning fairness.` });
      if ((s.tele || s.nih || s.emu) && s.count > 4) issues.push({ weight: 90, text: `${s.name} has Tele/NIH/EMU plus ${s.count} patients, so I would bring that group back toward 4:1.` });
      if (s.span > 10) issues.push({ weight: 50 + s.span, text: `${s.name} has the widest RN room run (${s.rooms.join(", ")}), which may feel inefficient even if acuity is acceptable.` });
    });
    pcaStats.forEach((s) => {
      const flags = visibleRuleCounts(getOwnerRuleEvalFromMap(s.owner, pcaRuleMap));
      if (flags.violations) issues.push({ weight: 80 + flags.violations, text: `${s.name} has ${flags.violations} PCA hard-rule flag(s); spread care-heavy tasks before polishing room geography.` });
      if (s.span > 14) issues.push({ weight: 45 + s.span, text: `${s.name} has a wide PCA room run (${s.rooms.join(", ")}), so call-light response may feel stretched.` });
    });
    const rnMove = __assistantSuggestedMove(nurses, "nurse");
    const pcaMove = __assistantSuggestedMove(pcas, "pca");
    const top = issues.sort((a, b) => b.weight - a.weight).slice(0, 3).map((x) => x.text);
    if (rnMove) top.push(rnMove);
    else if (pcaMove) top.push(pcaMove);
    if (!top.length) top.push("I do not see a major rule problem. I would preserve the current board, make only small swaps, and avoid chasing perfect symmetry.");
    return top.join(" ");
  }

  function __assistantConversationalClose(rawQuestion) {
    const q = String(rawQuestion || "").toLowerCase();
    if (q.includes("should") || q.includes("would you") || q.includes("recommend")) {
      return "My recommendation is deliberately practical: solve hard safety constraints first, then make the board feel humane.";
    }
    if (q.includes("why")) {
      return "The reason I am weighting it this way is that staff satisfaction usually tracks felt workload, not just patient count.";
    }
    return "I would treat this as a huddle read, not a command: use it to decide where your next human check should go.";
  }

  function __assistantStylePrefix(seedText) {
    const options = [
      "Charge read:",
      "My take:",
      "Board sense:",
      "Quick charge lens:",
      "Acuity huddle note:"
    ];
    const raw = String(seedText || "") + "|" + safeArray(window.patients).filter((p) => p && !p.isEmpty).length + "|" + Number(window.__chargeAssistantTurn || 0);
    let seed = 0;
    for (let i = 0; i < raw.length; i++) seed = (seed + raw.charCodeAt(i) * (i + 3)) % 997;
    return options[seed % options.length];
  }

  function __assistantBalanceSummary(owners, role, prevMap) {
    const label = role === "pca" ? "PCA" : "RN";
    const stats = __assistantOwnerStats(owners, role);
    if (!stats.length) return `No ${label} groups are available yet.`;

    const counts = stats.map((s) => s.count);
    const acuities = stats.map((s) => s.acuity);
    const maxCount = Math.max(...counts);
    const minCount = Math.min(...counts);
    const maxAcuity = Math.max(...acuities);
    const minAcuity = Math.min(...acuities);
    const heavy = stats.slice().sort((a, b) => b.acuity - a.acuity || b.count - a.count)[0];
    const light = stats.slice().sort((a, b) => a.acuity - b.acuity || a.count - b.count)[0];
    const wide = stats.slice().sort((a, b) => b.span - a.span)[0];
    const score = __nonIdealScore(owners, role, prevMap);
    const lines = [
      `${label} count spread is ${minCount}-${maxCount}; acuity spread is ${minAcuity}-${maxAcuity}.`,
      heavy && light && heavy !== light ? `${heavy.name} is carrying the heavier clinical weight (${heavy.acuity}) while ${light.name} is lighter (${light.acuity}).` : "",
      wide && wide.span > (role === "pca" ? 14 : 10) ? `${wide.name} has the widest room run (${wide.rooms.join(", ")}), so that group may feel choppy even if the count looks fair.` : "",
      Number(score?.violations || 0) > 0 ? `There are ${Number(score.violations)} avoidable rule flag(s) to resolve before I would call this balanced.` : "",
      Number(score?.reportOverflow || 0) > 0 ? `Report-source drag is elevated (${Number(score.reportOverflow)} overflow), so continuity may feel fragmented.` : ""
    ].filter(Boolean);
    return lines.join(" ");
  }

  function __assistantSuggestedMove(owners, role) {
    const stats = __assistantOwnerStats(owners, role);
    if (stats.length < 2) return "";
    const heavy = stats.slice().sort((a, b) => b.acuity - a.acuity || b.count - a.count)[0];
    const light = stats.slice().sort((a, b) => a.acuity - b.acuity || a.count - b.count)[0];
    if (!heavy || !light || heavy === light) return "";
    const candidates = __assistantPatientRows(heavy.owner, role)
      .filter((row) => Number(row.score) > 0)
      .sort((a, b) => Math.abs((heavy.acuity - row.score) - (light.acuity + row.score)) - Math.abs((heavy.acuity) - (light.acuity)));
    const best = candidates[0];
    if (!best) return "";
    const wouldImprove = Math.abs((heavy.acuity - best.score) - (light.acuity + best.score)) < Math.abs(heavy.acuity - light.acuity);
    if (!wouldImprove && heavy.count - light.count < 2) return "";
    return `Creative move to consider: trial ${best.room || "one higher-acuity room"} from ${heavy.name} to ${light.name}, then recheck count, rule flags, and room run before locking it.`;
  }

  function __assistantRoomSpreadSummary(owners, role) {
    const label = role === "pca" ? "PCA" : "RN";
    const limit = role === "pca" ? 14 : 10;
    const stats = __assistantOwnerStats(owners, role);
    const wide = stats.filter((s) => s.span > limit).sort((a, b) => b.span - a.span);
    if (!wide.length) return `${label} room spread looks contained. No group is over the ${limit}-room spread target.`;
    return wide.slice(0, 3).map((s) => `${s.name}: span ${s.span} across ${s.rooms.join(", ")}`).join(" | ");
  }

  function __chargeAssistantAnswer(rawQuestion) {
    const q = String(rawQuestion || "").trim().toLowerCase();
    if (!q) return "Ask me to compare groups, review the whole unit, explain the balancing rules, find room-spread problems, or suggest the next safest move.";
    const nurses = __getIncomingNursesReal();
    const pcas = __getIncomingPcasReal().filter((p) => !__isPcaSpecialOwner(p));
    const pts = __getPatients().filter((p) => p && !p.isEmpty);
    const prevMaps = __getPrevMapsForCycle();
    const prefix = __assistantStylePrefix(rawQuestion);
    const rnRuleMap = safeGetRuleEvalMap(nurses, "nurse");
    const pcaRuleMap = safeGetRuleEvalMap(pcas, "pca");
    const unitSnapshot = () => __assistantUnitSnapshot(nurses, pcas, rnRuleMap, pcaRuleMap, prevMaps);
    const nextSteps = () => __assistantPrioritizedFeedback(nurses, pcas, rnRuleMap, pcaRuleMap, prevMaps);

    if (q.includes("rule") || q.includes("logic") || q.includes("criteria") || q.includes("how are you") || q.includes("why did")) {
      return `${prefix} ${__assistantRuleBookText()} In this exact board: ${unitSnapshot()} ${nextSteps()}`;
    }
    if (q.includes("compare")) {
      const named = __assistantCompareNamedGroups(rawQuestion, nurses, pcas, rnRuleMap, pcaRuleMap);
      if (named) return `${prefix} ${named}`;
      return `${prefix} Group-by-group comparison. RN: ${__assistantGroupByGroup(nurses, "nurse", rnRuleMap)} PCA: ${__assistantGroupByGroup(pcas, "pca", pcaRuleMap)} ${nextSteps()}`;
    }
    if (q.includes("whole unit") || q.includes("unit as a whole") || q.includes("unit needs") || q.includes("huddle") || q.includes("overall")) {
      return `${prefix} ${unitSnapshot()} ${nextSteps()} ${__assistantConversationalClose(rawQuestion)}`;
    }
    if (q.includes("what should") || q.includes("next move") || q.includes("recommend") || q.includes("fix") || q.includes("improve") || q.includes("change")) {
      return `${prefix} ${unitSnapshot()} ${nextSteps()} ${__assistantConversationalClose(rawQuestion)}`;
    }

    if (q.includes("balance") || q.includes("fair") || q.includes("spread") || q.includes("acuity") || q.includes("flow")) {
      const rnSummary = __assistantBalanceSummary(nurses, "nurse", prevMaps?.prevRnByPid);
      const pcaSummary = __assistantBalanceSummary(pcas, "pca", prevMaps?.prevPcaByPid);
      const rnMove = __assistantSuggestedMove(nurses, "nurse");
      const pcaMove = __assistantSuggestedMove(pcas, "pca");
      return `${prefix} ${unitSnapshot()} ${rnSummary} ${pcaSummary} ${rnMove || pcaMove || nextSteps()} ${__assistantConversationalClose(rawQuestion)}`;
    }
    if (q.includes("room")) {
      return `${prefix} ${__assistantRoomSpreadSummary(nurses, "nurse")} ${__assistantRoomSpreadSummary(pcas, "pca")} ${nextSteps()}`;
    }
    if ((q.includes("nih") || q.includes("csc")) && (q.includes("balance") || q.includes("distribut") || q.includes("improve") || q.includes("way") || q.includes("can i") || q.includes("should"))) {
      return `${prefix} ${__nihAssignmentInsight(nurses)}`;
    }
    if (q.includes("tele")) {
      const rooms = __roomsForAssistant("tele");
      return rooms.length ? `Tele rooms: ${rooms.join(", ")}.` : "No tele rooms are currently marked.";
    }
    if (q.includes("nih") || q.includes("csc")) {
      const rooms = __roomsForAssistant("nih");
      return rooms.length ? `CSC/NIH rooms: ${rooms.join(", ")}.` : "No NIH rooms are currently marked.";
    }
    if (q.includes("iso")) {
      const rooms = __roomsForAssistant("isolation");
      return rooms.length ? `Isolation rooms: ${rooms.join(", ")}.` : "No isolation rooms are currently marked.";
    }
    if (q.includes("feed")) {
      const rooms = __roomsForAssistant("feeder");
      return rooms.length ? `Feeder rooms: ${rooms.join(", ")}.` : "No feeder rooms are currently marked.";
    }
    if (q.includes("total") || q.includes("care") || q.includes("strict")) {
      const rooms = __roomsForAssistant("totalCare");
      return rooms.length ? `Total care / strict I&O rooms: ${rooms.join(", ")}.` : "No total care rooms are currently marked.";
    }
    if (q.includes("warning") || q.includes("rule") || q.includes("break")) {
      const flagged = nurses.concat(pcas).map((owner) => {
        const role = nurses.includes(owner) ? "RN" : "PCA";
        const ruleEval = getOwnerRuleEvalFromMap(owner, role === "RN" ? rnRuleMap : pcaRuleMap);
        const tip = buildRuleTooltip(ruleEval);
        return tip ? `${owner.name}: ${tip}` : "";
      }).filter(Boolean);
      return flagged.length ? `${prefix} ${flagged.join(" ")} ${nextSteps()}` : `${prefix} No visible assignment warnings are currently showing. ${unitSnapshot()}`;
    }
    if (q.includes("pca")) {
      return `${prefix} ${__assistantBalanceSummary(pcas, "pca", prevMaps?.prevPcaByPid)} ${__assistantGroupByGroup(pcas, "pca", pcaRuleMap)} ${__assistantSuggestedMove(pcas, "pca") || nextSteps()}`.trim();
    }
    if (q.includes("rn") || q.includes("nurse") || q.includes("load") || q.includes("assignment")) {
      return `${prefix} ${__assistantBalanceSummary(nurses, "nurse", prevMaps?.prevRnByPid)} ${__assistantGroupByGroup(nurses, "nurse", rnRuleMap)} ${__assistantSuggestedMove(nurses, "nurse") || nextSteps()}`.trim();
    }
    return `${prefix} Current census is ${pts.length}. Tele: ${__roomsForAssistant("tele").length}. NIH/CSC: ${__roomsForAssistant("nih").length}. Isolation: ${__roomsForAssistant("isolation").length}. Feeders: ${__roomsForAssistant("feeder").length}. ${unitSnapshot()} ${nextSteps()} ${__assistantConversationalClose(rawQuestion)}`;
  }

  window.askChargeAssistant = function askChargeAssistant() {
    const input = document.getElementById("chargeAssistantInput");
    const output = document.getElementById("chargeAssistantOutput");
    const question = input?.value || "";
    window.__chargeAssistantTurn = Number(window.__chargeAssistantTurn || 0) + 1;
    const answer = __chargeAssistantAnswer(question);
    window.__chargeAssistantLast = { question, answer };
    if (output) output.innerHTML = `<strong>Assistant:</strong> ${escapeHtml(answer)}`;
  };

  window.toggleChargeAssistantPanel = function toggleChargeAssistantPanel() {
    window.__chargeAssistantCollapsed = window.__chargeAssistantCollapsed === false ? true : false;
    try { __renderOncomingQualityPanel(); } catch (_) {}
  };

  function __renderOncomingQualityPanel(opts = {}) {
    const __perfT0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
    const host = document.getElementById("globalAssignmentPrintActions");
    let panel = document.getElementById("oncomingQualityPanel");
    if (!panel && host) {
      panel = document.createElement("div");
      panel.id = "oncomingQualityPanel";
      host.appendChild(panel);
    }
    if (!panel) return;

    if (!opts.force && __shouldDeferOncomingQualityPanel()) {
      __scheduleOncomingQualityPanel(opts.reason || "quality_deferred");
      return;
    }

    if (!__isOncomingTabVisible()) {
      panel.style.display = "none";
      panel.innerHTML = "";
      return;
    }

    if (typeof window.__oncomingSuggestionsCollapsed !== "boolean") window.__oncomingSuggestionsCollapsed = true;
    const suggestionDrawerCollapsed = window.__oncomingSuggestionsCollapsed === true;
    const shouldComputeSuggestions = !suggestionDrawerCollapsed || !!opts.forceSuggestions;
    let activeSuggestions = window.__lastOncomingSuggestions || { nurse: [], pca: [] };
    let topSuggestions = [];
    let totalSuggestions = safeArray(activeSuggestions.nurse).length + safeArray(activeSuggestions.pca).length;

    if (shouldComputeSuggestions) {
      const tSuggest = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
      activeSuggestions = __getOncomingSuggestions();
      window.__lastOncomingSuggestions = activeSuggestions;
      topSuggestions = safeArray(activeSuggestions.nurse)
        .map((suggestion) => ({ ...suggestion, roleLabel: "RN" }))
        .concat(safeArray(activeSuggestions.pca).map((suggestion) => ({ ...suggestion, roleLabel: "PCA" })))
        .sort((a, b) => (Number(b.weightedDelta) || 0) - (Number(a.weightedDelta) || 0))
        .slice(0, 5);
      totalSuggestions = safeArray(activeSuggestions.nurse).length + safeArray(activeSuggestions.pca).length;
      try {
        if (typeof window.perfRecord === "function" && tSuggest) {
          window.perfRecord("oncomingSuggestionsCompute", performance.now() - tSuggest);
        }
      } catch (_) {}
    }

    function renderSuggestionList(items) {
      if (!safeArray(items).length) {
        return `<div class="oncoming-quality-meta" style="margin-top:8px;">No suggestions right now.</div>`;
      }
      return safeArray(items).map((suggestion, idx) => `
        <div class="oncoming-suggestion-item">
          <div class="oncoming-quality-line"><strong>${escapeHtml(suggestion.roleLabel || "Move")} ${idx + 1}:</strong> ${escapeHtml(suggestion.summary)}</div>
          <div class="oncoming-quality-meta">Impact: ${escapeHtml(suggestion.impact)}</div>
          <div class="oncoming-quality-meta">${escapeHtml(suggestion.metricLines.slice(0, 4).join(" | ") || "Improves board quality score")}</div>
          <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
            <button type="button" onclick="window.acceptOncomingSuggestion && window.acceptOncomingSuggestion('${escapeHtml(suggestion.role)}', ${Number(suggestion.patientId)}, ${Number(suggestion.fromOwnerId)}, ${Number(suggestion.toOwnerId)})" style="padding:6px 10px; border-radius:8px; background:#111; color:#fff; border:1px solid #111; font-weight:800;">Apply</button>
            <button type="button" onclick="window.dismissSpecificOncomingSuggestion && window.dismissSpecificOncomingSuggestion('${escapeHtml(suggestion.role)}', ${Number(suggestion.patientId)}, ${Number(suggestion.fromOwnerId)}, ${Number(suggestion.toOwnerId)})" style="padding:6px 10px; border-radius:8px; background:#fff; color:#0f172a; border:1px solid #cbd5e1; font-weight:800;">Decline</button>
            <button type="button" title="Good suggestion" onclick="window.rateOncomingSuggestion && window.rateOncomingSuggestion('${escapeHtml(suggestion.role)}', ${Number(suggestion.patientId)}, ${Number(suggestion.fromOwnerId)}, ${Number(suggestion.toOwnerId)}, 'up')" style="width:32px; height:32px; border-radius:8px; background:#ecfdf5; color:#065f46; border:1px solid #a7f3d0; font-weight:900;">+</button>
            <button type="button" title="Poor suggestion" onclick="window.rateOncomingSuggestion && window.rateOncomingSuggestion('${escapeHtml(suggestion.role)}', ${Number(suggestion.patientId)}, ${Number(suggestion.fromOwnerId)}, ${Number(suggestion.toOwnerId)}, 'down')" style="width:32px; height:32px; border-radius:8px; background:#fff1f2; color:#9f1239; border:1px solid #fecdd3; font-weight:900;">-</button>
          </div>
        </div>
      `).join("");
    }

    panel.style.display = "block";
    panel.style.width = "100%";
    panel.innerHTML = `
      <div class="oncoming-quality-card">
        <button type="button" class="oncoming-quality-toggle" aria-expanded="${suggestionDrawerCollapsed ? "false" : "true"}" onclick="window.toggleOncomingSuggestionsPanel && window.toggleOncomingSuggestionsPanel()">
          <span>${suggestionDrawerCollapsed ? ">" : "v"}</span>
          <span>Suggestions (${shouldComputeSuggestions ? (totalSuggestions ? `${Math.min(totalSuggestions, 5)}${totalSuggestions > 5 ? "+" : ""}` : "0") : "closed"})</span>
        </button>
        <div style="${suggestionDrawerCollapsed ? "display:none;" : "display:block;"}">
          <div class="oncoming-quality-meta" style="margin-top:6px;">Top ${Number(topSuggestions.length) || 0} current move candidates.</div>
          ${renderSuggestionList(topSuggestions)}
          <div style="margin-top:10px;">
            <button type="button" onclick="window.refreshOncomingSuggestions && window.refreshOncomingSuggestions()" style="padding:6px 10px; border-radius:8px; background:#fff; color:#0f172a; border:1px solid #cbd5e1; font-weight:800;">Refresh Suggestions</button>
          </div>
        </div>
      </div>
    `;
    try {
      if (typeof window.perfRecord === "function" && __perfT0) {
        window.perfRecord("oncomingQualityPanel", performance.now() - __perfT0, { reason: opts.reason || "" });
      }
    } catch (_) {}
    return;

    panel.innerHTML = `
      <div class="oncoming-quality-card" style="display:block; width:100%; box-sizing:border-box; background:#fff; border:1px solid #d7dde8; border-radius:12px; padding:10px 12px; box-shadow:0 8px 18px rgba(15,23,42,0.08);">
        <button type="button" class="oncoming-quality-toggle" aria-expanded="${rnCollapsed ? "false" : "true"}" onclick="window.toggleOncomingRnSuggestionsPanel && window.toggleOncomingRnSuggestionsPanel()">
          <span>${rnCollapsed ? "▸" : "▾"}</span>
          <span>Suggested RN Moves</span>
        </button>
        <div style="${rnCollapsed ? "display:none;" : "display:block;"}">
          <div class="oncoming-quality-meta" style="margin-top:6px;">Review and apply RN improvements based on the current board.</div>
          <div class="oncoming-quality-meta" style="margin-top:4px;">Candidates found: ${Number(safeArray(activeSuggestions.nurse).length) || 0}</div>
          ${renderSuggestionList(activeSuggestions.nurse, "RN")}
        </div>
        <div style="margin-top:12px; padding-top:10px; border-top:1px solid #e5e7eb;">
          <button type="button" class="oncoming-quality-toggle" aria-expanded="${pcaCollapsed ? "false" : "true"}" onclick="window.toggleOncomingPcaSuggestionsPanel && window.toggleOncomingPcaSuggestionsPanel()">
            <span>${pcaCollapsed ? "▸" : "▾"}</span>
            <span>Suggested PCA Moves</span>
          </button>
          <div style="${pcaCollapsed ? "display:none;" : "display:block;"}">
            <div class="oncoming-quality-meta" style="margin-top:6px;">Review and apply PCA improvements based on the current board.</div>
            <div class="oncoming-quality-meta" style="margin-top:4px;">Candidates found: ${Number(safeArray(activeSuggestions.pca).length) || 0}</div>
            ${renderSuggestionList(activeSuggestions.pca, "PCA")}
          </div>
        </div>
        <div style="margin-top:10px;">
          <button type="button" onclick="window.refreshOncomingSuggestions && window.refreshOncomingSuggestions()" style="padding:6px 10px; border-radius:8px; background:#fff; color:#0f172a; border:1px solid #cbd5e1; font-weight:800;">Refresh Suggestions</button>
        </div>
      </div>
    `;
    return;

    const prevMaps = __getPrevMapsForCycle();
    const { prevRnByPid, prevPcaByPid } = prevMaps || buildPrevOwnerMaps();
    const nurses = __getIncomingNursesReal();
    const openPcas = __getIncomingPcasReal().filter((p) => !__isPcaSpecialOwner(p));
    const rnScore = __nonIdealScore(nurses, "nurse", prevRnByPid);
    const pcaScore = __nonIdealScore(openPcas, "pca", prevPcaByPid);
    const lastDebug = window.__lastOncomingRebalanceDebug || {};
    const lastAfter = lastDebug.after || {};
    const lastV2 = lastDebug.v2 || {};
    const lastRnV2 = lastV2.rn || null;
    const lastPcaV2 = lastV2.pca || null;
    const lastRnAfterCounts = __formatOwnerCounts(lastAfter.rn);
    const lastPcaAfterCounts = __formatOwnerCounts(lastAfter.pca);
    const lastRnReason = __formatEngineReason(lastRnV2, "No RN candidate accepted.");
    const lastPcaReason = __formatEngineReason(lastPcaV2, "No PCA candidate accepted.");
    const lastRnEngine = String(lastRnV2?.engine || "Engine");
    const lastPcaEngine = String(lastPcaV2?.engine || "Engine");
    const lastClick = lastDebug.clickReceivedAt || lastDebug.startedAt || "";
    const rnSummary = __boardQualitySummary(rnScore, "RN");
    const pcaSummary = __boardQualitySummary(pcaScore, "PCA");
    const rnNeeds = __boardQualityNeeds(rnScore, "RN");
    const pcaNeeds = __boardQualityNeeds(pcaScore, "PCA");
    const collapsed = window.__oncomingQualityPanelCollapsed !== false;
    const detailStyle = collapsed ? "display:none;" : "display:block;";
    const caret = collapsed ? "▸" : "▾";
    const rnCounts = rnNeeds;
    const pcaCounts = pcaNeeds;
    const suggestions = __getOncomingSuggestions();
    const suggestionsCollapsed = window.__oncomingSuggestionsCollapsed !== false;
    const suggestionsCaret = suggestionsCollapsed ? "▸" : "▾";
    const suggestionsDetailStyle = suggestionsCollapsed ? "display:none;" : "display:block;";

    function renderSuggestionList(items, roleLabel) {
      if (!safeArray(items).length) {
        return `<div class="oncoming-quality-meta" style="margin-top:8px;">No ${escapeHtml(roleLabel)} suggestions right now.</div>`;
      }
      return safeArray(items).map((suggestion, idx) => `
        <div style="margin-top:${idx === 0 ? "10px" : "8px"}; padding:10px; border:1px solid #e2e8f0; border-radius:10px; background:#f8fafc;">
          <div class="oncoming-quality-line"><strong>Move ${idx + 1}:</strong> ${escapeHtml(suggestion.summary)}</div>
          <div class="oncoming-quality-meta">Impact: ${escapeHtml(suggestion.impact)}</div>
          <div class="oncoming-quality-meta">${escapeHtml(suggestion.metricLines.slice(0, 4).join(" | ") || "Improves board quality score")}</div>
          <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
            <button type="button" onclick="window.acceptOncomingSuggestion && window.acceptOncomingSuggestion('${escapeHtml(suggestion.role)}', ${Number(suggestion.patientId)}, ${Number(suggestion.fromOwnerId)}, ${Number(suggestion.toOwnerId)})" style="padding:6px 10px; border-radius:8px; background:#111; color:#fff; border:1px solid #111; font-weight:800;">Accept</button>
            <button type="button" onclick="window.dismissSpecificOncomingSuggestion && window.dismissSpecificOncomingSuggestion('${escapeHtml(suggestion.role)}', ${Number(suggestion.patientId)}, ${Number(suggestion.fromOwnerId)}, ${Number(suggestion.toOwnerId)})" style="padding:6px 10px; border-radius:8px; background:#fff; color:#0f172a; border:1px solid #cbd5e1; font-weight:800;">Dismiss</button>
          </div>
        </div>
      `).join("");
    }

    panel.style.display = "block";
    panel.style.width = "100%";
    panel.innerHTML = `
      <div class="oncoming-quality-card" style="display:block; width:100%; box-sizing:border-box; background:#fff; border:1px solid #d7dde8; border-radius:12px; padding:10px 12px; box-shadow:0 8px 18px rgba(15,23,42,0.08);">
        <button type="button" class="oncoming-quality-toggle" aria-expanded="${collapsed ? "false" : "true"}" onclick="window.toggleOncomingQualityPanel && window.toggleOncomingQualityPanel()">
          <span>${caret}</span>
          <span>Board Quality</span>
        </button>
        <div style="${detailStyle}">
        <div class="oncoming-quality-line"><strong>RN:</strong> ${escapeHtml(rnSummary)}</div>
        <div class="oncoming-quality-meta">Focus: ${escapeHtml(rnNeeds)}</div>
        <div class="oncoming-quality-line"><strong>PCA:</strong> ${escapeHtml(pcaSummary)}</div>
        <div class="oncoming-quality-meta">RN counts: ${escapeHtml(rnCounts || "—")}</div>
        <div class="oncoming-quality-meta">PCA counts: ${escapeHtml(pcaCounts || "—")}</div>
        <div class="oncoming-quality-meta">Last path: ${escapeHtml(String(lastDebug.path || "none"))}</div>
        <div class="oncoming-quality-meta">Last click: ${escapeHtml(String(lastClick || "none"))}</div>
        <div class="oncoming-quality-meta">Last RN after: ${escapeHtml(lastRnAfterCounts || "none")}</div>
        <div class="oncoming-quality-meta">Last PCA after: ${escapeHtml(lastPcaAfterCounts || "none")}</div>
        <div class="oncoming-quality-meta">Last RN engine: ${escapeHtml(`${lastRnEngine}: ${String(lastRnReason || "none")}`)}</div>
        <div class="oncoming-quality-meta">Last PCA engine: ${escapeHtml(`${lastPcaEngine}: ${String(lastPcaReason || "none")}`)}</div>
        <div style="margin-top:12px; padding-top:10px; border-top:1px solid #e5e7eb;">
          <button type="button" class="oncoming-quality-toggle" aria-expanded="${suggestionsCollapsed ? "false" : "true"}" onclick="window.toggleOncomingSuggestionsPanel && window.toggleOncomingSuggestionsPanel()">
            <span>${suggestionsCaret}</span>
            <span>Suggested Moves</span>
          </button>
          <div style="${suggestionsDetailStyle}">
            <div class="oncoming-quality-meta" style="margin-top:6px;">Review one move at a time based on the current board.</div>
            ${renderSuggestionCard(legacySuggestions.nurse, "RN")}
            ${renderSuggestionCard(legacySuggestions.pca, "PCA")}
            <div style="margin-top:10px;">
              <button type="button" onclick="window.refreshOncomingSuggestions && window.refreshOncomingSuggestions()" style="padding:6px 10px; border-radius:8px; background:#fff; color:#0f172a; border:1px solid #cbd5e1; font-weight:800;">Refresh Suggestions</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function __restoreSingleOwnerArrays(owners, snapshot) {
    safeArray(owners).forEach((owner, idx) => {
      if (!owner) return;
      owner.patients = safeArray(snapshot?.[idx]).slice();
    });
  }

  function __fullRebuildOwnersForRole(owners, role, activePatients) {
    const list = Array.isArray(owners) ? owners.filter(Boolean) : [];
    const pts = Array.isArray(activePatients) ? activePatients.filter((p) => p && !p.isEmpty) : [];
    if (!list.length || !pts.length) return { changed: false, avoidable: getAvoidableViolationCount(list, role) };

    const before = __snapshotSingleOwnerArrays(list);
    list.forEach((owner) => { owner.patients = []; });

    try {
      if (role === "pca") {
        const { unlockedPool } = applyPcaPinsBeforeDistribute(pts, list);
        if (typeof window.distributePatientsEvenly === "function") {
          window.distributePatientsEvenly(list, unlockedPool, { randomize: false, role: "pca", preserveExisting: true });
        }
      } else {
        const { unlockedPool } = applyRnPinsBeforeDistribute(pts);
        if (typeof window.distributePatientsEvenly === "function") {
          window.distributePatientsEvenly(list, unlockedPool, { randomize: false, role: "nurse", preserveExisting: true });
        }
      }

      rebalanceExpectedDischarges(list, role, { maxPasses: role === "nurse" ? 180 : 120 });
      balanceCountsWithoutCreatingNewAvoidableViolations(list, role, { maxPasses: 80 });
      rebalanceExpectedDischarges(list, role, { maxPasses: role === "nurse" ? 180 : 120 });
      if (typeof window.repairAssignmentsInPlace === "function") {
        window.repairAssignmentsInPlace(list, role, null, { maxIters: role === "nurse" ? 50 : 35 });
      }
      rebalanceExpectedDischarges(list, role, { maxPasses: role === "nurse" ? 180 : 120 });

      const afterAvoidable = getAvoidableViolationCount(list, role);
      const beforeAvoidable = getAvoidableViolationCount(before.map((patients) => ({ patients })), role);
      const changed = JSON.stringify(before) !== JSON.stringify(__snapshotSingleOwnerArrays(list));
      return { changed, avoidable: afterAvoidable, improved: afterAvoidable < beforeAvoidable };
    } catch (e) {
      console.warn("[oncoming rebuild] role rebuild failed", role, e);
      __restoreSingleOwnerArrays(list, before);
      return { changed: false, avoidable: getAvoidableViolationCount(list, role), error: e };
    }
  }

  function __assignMissingPatientsBestEffort(owners, role, activePatients) {
    const list = Array.isArray(owners) ? owners.filter(Boolean) : [];
    const pts = Array.isArray(activePatients) ? activePatients.filter((p) => p && !p.isEmpty) : [];
    if (!list.length || !pts.length || typeof window.distributePatientsEvenly !== "function") {
      return { changed: false, added: 0 };
    }

    const assigned = new Set();
    list.forEach((owner) => {
      owner.patients = safeArray(owner?.patients).filter((pid) => {
        const n = Number(pid);
        if (!Number.isFinite(n) || assigned.has(n)) return false;
        assigned.add(n);
        return true;
      });
    });

    const missing = pts.filter((p) => !assigned.has(Number(p?.id)));
    if (!missing.length) return { changed: false, added: 0 };

    if (role === "pca") {
      const { unlockedPool } = applyPcaPinsBeforeDistribute(missing, list);
      window.distributePatientsEvenly(list, unlockedPool, { randomize: false, role: "pca", preserveExisting: true });
    } else {
      const { unlockedPool } = applyRnPinsBeforeDistribute(missing);
      window.distributePatientsEvenly(list, unlockedPool, { randomize: false, role: "nurse", preserveExisting: true });
    }

    return { changed: true, added: missing.length };
  }

  function __prevMapToObject(prevMap) {
    const out = {};
    if (!(prevMap instanceof Map)) return out;
    prevMap.forEach((value, key) => {
      out[Number(key)] = String(value || "");
    });
    return out;
  }

  function __getPreferredAssignmentEngine() {
    if (window.assignmentEngineV3 && typeof window.assignmentEngineV3.solve === "function") {
      return { label: "Engine V3", solver: window.assignmentEngineV3.solve };
    }
    if (window.assignmentEngineV2 && typeof window.assignmentEngineV2.solve === "function") {
      return { label: "Engine V2", solver: window.assignmentEngineV2.solve };
    }
    return null;
  }

  function __applyEngineV2Solution(owners, patients, role, prevMap, opts = {}) {
    const engine = __getPreferredAssignmentEngine();
    if (!engine) {
      return { applied: false, reason: "No assignment engine loaded." };
    }

    const list = Array.isArray(owners) ? owners.filter(Boolean) : [];
    const pts = Array.isArray(patients) ? patients.filter((p) => p && !p.isEmpty) : [];
    if (!list.length || !pts.length) return { applied: false, reason: "No owners or patients available." };

    const before = __snapshotSingleOwnerArrays(list);
    const beforeAvoid = getAvoidableViolationCount(list, role);
    const beforeDischarge = getAvoidableExpectedDischargeOverflowLocal(list, role);
    const beforeSpread = countSpreadLocal(list);
    const beforeRoomOverflow = roomSpreadOverflowLocal(list, role);
    const beforeReport = prevMap ? __reportOverflowTotal(list, prevMap) : 0;

    try {
      const seedOwners = !!opts.reseedOwners
        ? list.map((owner) => ({
            id: owner.id,
            name: owner.name,
            patients: [],
            isSitter: !!owner?.isSitter,
            sitterRoomPair: owner?.sitterRoomPair || ""
          }))
        : list.map((owner) => ({
            id: owner.id,
            name: owner.name,
            patients: safeArray(owner?.patients).slice(),
            isSitter: !!owner?.isSitter,
            sitterRoomPair: owner?.sitterRoomPair || ""
          }));

      const result = engine.solver({
        role,
        owners: seedOwners,
        patients: pts.map((p) => ({ ...p })),
        prevOwnerByPid: __prevMapToObject(prevMap),
        maxPasses: typeof opts.maxPasses === "number" ? opts.maxPasses : 120
      });

      const solvedOwners = safeArray(result?.owners);
      if (!solvedOwners.length) {
        __restoreSingleOwnerArrays(list, before);
        return { applied: false, reason: `${engine.label} returned no solution.`, engine: engine.label };
      }

      const byId = new Map(solvedOwners.map((owner) => [Number(owner.id), safeArray(owner?.patients).slice()]));
      list.forEach((owner) => {
        owner.patients = byId.has(Number(owner.id)) ? byId.get(Number(owner.id)).slice() : [];
      });

      const afterAvoid = getAvoidableViolationCount(list, role);
      const afterDischarge = getAvoidableExpectedDischargeOverflowLocal(list, role);
      const afterSpread = countSpreadLocal(list);
      const afterRoomOverflow = roomSpreadOverflowLocal(list, role);
      const afterReport = prevMap ? __reportOverflowTotal(list, prevMap) : 0;
      const changed = JSON.stringify(before) !== JSON.stringify(__snapshotSingleOwnerArrays(list));
      const improved =
        afterAvoid < beforeAvoid ||
        (afterAvoid === beforeAvoid && afterDischarge < beforeDischarge) ||
        (afterAvoid === beforeAvoid && afterDischarge === beforeDischarge && afterSpread < beforeSpread) ||
        (afterAvoid === beforeAvoid && afterDischarge === beforeDischarge && afterSpread === beforeSpread && afterRoomOverflow < beforeRoomOverflow) ||
        (afterAvoid === beforeAvoid && afterDischarge === beforeDischarge && afterSpread === beforeSpread && afterRoomOverflow === beforeRoomOverflow && afterReport < beforeReport);

      const cleanEnough = afterAvoid <= 0 && afterDischarge <= 0 && afterSpread <= 1 && afterRoomOverflow <= 0;
      const acceptableByForce =
        !!opts.forceApply &&
        changed &&
        (
          improved ||
          cleanEnough ||
          afterSpread < beforeSpread ||
          afterAvoid < beforeAvoid ||
          afterDischarge < beforeDischarge ||
          afterRoomOverflow < beforeRoomOverflow
        );

      if (!changed || (!improved && !cleanEnough && !acceptableByForce)) {
        __restoreSingleOwnerArrays(list, before);
        return {
          applied: false,
          reason: `${engine.label} did not improve this assignment.`,
          engine: engine.label,
          summary: result?.summary || null,
          metrics: {
            beforeAvoid,
            beforeDischarge,
            beforeSpread,
            beforeRoomOverflow,
            beforeReport,
            afterAvoid,
            afterDischarge,
            afterSpread,
            afterRoomOverflow,
            afterReport,
            changed,
            improved,
            cleanEnough
          }
        };
      }

      return {
        applied: true,
        changed: true,
        engine: engine.label,
        summary: result?.summary || null,
        metrics: {
          beforeAvoid,
          beforeDischarge,
          beforeSpread,
          beforeRoomOverflow,
          beforeReport,
          afterAvoid,
          afterDischarge,
          afterSpread,
          afterRoomOverflow,
          afterReport,
          changed,
          improved,
          cleanEnough,
          acceptableByForce
        }
      };
    } catch (e) {
      console.warn("[assignment engine] solve failed", role, e);
      __restoreSingleOwnerArrays(list, before);
      return { applied: false, reason: `${engine.label} solve failed.`, engine: engine.label };
    }
  }

  function balanceCountsWithoutCreatingNewAvoidableViolations(owners, role, opts = {}) {
    const maxPasses = typeof opts.maxPasses === "number" ? opts.maxPasses : 60;
    const list = Array.isArray(owners) ? owners : [];
    const n = list.length;
    if (n < 2) return { ok: true, changed: false };

    const assignedSet = new Set();
    list.forEach(o => (Array.isArray(o?.patients) ? o.patients : []).forEach(pid => assignedSet.add(Number(pid))));
    const totalAssigned = assignedSet.size;

    const { minTarget, maxTarget } = computeCountTargets(totalAssigned, n);

    // Report-source-aware: prefer moves that don't increase report overflow (fewer handoffs).
    const maps = buildPrevOwnerMaps();
    const prevMap = role === "nurse" ? maps.prevRnByPid : maps.prevPcaByPid;

    let changed = false;
    let passes = 0;

    while (passes < maxPasses) {
      passes++;

      const counts = list.map(o => (Array.isArray(o?.patients) ? o.patients.length : 0));
      const spread = Math.max(...counts) - Math.min(...counts);
      if (spread <= 1) break;

      const over2 = list
        .map(o => ({ o, c: (Array.isArray(o?.patients) ? o.patients.length : 0) }))
        .sort((a, b) => b.c - a.c);

      const under2 = list
        .map(o => ({ o, c: (Array.isArray(o?.patients) ? o.patients.length : 0) }))
        .sort((a, b) => a.c - b.c);

      const from = over2[0]?.o;
      const to = under2[0]?.o;
      if (!from || !to || from === to) break;

      const movable = getMovablePatientIdsFromOwner(from, role);
      if (!movable.length) break;

      const baseViol = getAvoidableViolationCount(list, role);
      const baseReportOverflow = prevMap ? __reportOverflowTotal(list, prevMap) : 0;
      let best = null;

      for (const pid of movable) {
        const fromOrig = from.patients.slice();
        const toOrig = to.patients.slice();

        const did = tryMovePatient(list, role, from, to, pid);
        if (!did) {
          from.patients = fromOrig;
          to.patients = toOrig;
          continue;
        }

        const nextViol = getAvoidableViolationCount(list, role);
        const nextReportOverflow = prevMap ? __reportOverflowTotal(list, prevMap) : 0;

        from.patients = fromOrig;
        to.patients = toOrig;

        if (nextViol > baseViol) continue;

        // Prefer: fewer violations first, then lower report overflow (report-source aware).
        const violScore = baseViol - nextViol;
        const reportScore = baseReportOverflow - nextReportOverflow;
        if (!best) {
          best = { pid, nextViol, nextReportOverflow, violScore, reportScore };
          if (violScore > 0) break;
          continue;
        }
        if (violScore > best.violScore) {
          best = { pid, nextViol, nextReportOverflow, violScore, reportScore };
          if (violScore > 0) break;
          continue;
        }
        if (violScore === best.violScore && nextReportOverflow < best.nextReportOverflow) {
          best = { pid, nextViol, nextReportOverflow, violScore, reportScore };
        }
      }

      if (!best) break;

      const didApply = tryMovePatient(list, role, from, to, best.pid);
      if (!didApply) break;

      changed = true;

      const counts2 = list.map(o => (Array.isArray(o?.patients) ? o.patients.length : 0));
      const spread2 = Math.max(...counts2) - Math.min(...counts2);
      if (spread2 <= 1) break;

      const okCaps = counts2.every(c => c >= minTarget && c <= maxTarget);
      if (okCaps) break;

      void maxTarget;
    }

    return { ok: true, changed, passes };
  }

  // -----------------------------
  // Explanation + rule flag helpers
  // -----------------------------
  function safeGetPerOwnerExplain(owner, ownersAll, role) {
    try {
      if (window.explain && typeof window.explain.perOwner === "function") {
        return window.explain.perOwner(owner, ownersAll, role);
      }
    } catch (e) {
      console.warn("[explain] perOwner failed", e);
    }
    return "";
  }

  function safeGetRuleEvalMap(ownersAll, role) {
    try {
      if (typeof window.evaluateAssignmentHardRules === "function") {
        return window.evaluateAssignmentHardRules(ownersAll, role);
      }
    } catch (e) {
      console.warn("[rules] evaluateAssignmentHardRules failed", e);
    }
    return null;
  }

  function getOwnerRuleEvalFromMap(owner, map) {
    if (!map) return null;

    const key = owner?.name || owner?.label || null;
    if (key && map[key]) return map[key];

    if (key) {
      const keys = Object.keys(map);
      const foundKey = keys.find(k => String(k).toLowerCase() === String(key).toLowerCase());
      if (foundKey) return map[foundKey];
    }
    return null;
  }

  function visibleRuleCounts(ruleEval) {
    const hiddenTags = new Set(["expecteddischarge", "countbalance", "chg", "foley", "q2turns", "feeder", "staffrestriction"]);
    const isVisible = (x) => !hiddenTags.has(String(x?.tag || "").toLowerCase());
    return {
      violations: (Array.isArray(ruleEval?.violations) ? ruleEval.violations : []).filter(isVisible).length,
      warnings: (Array.isArray(ruleEval?.warnings) ? ruleEval.warnings : []).filter(isVisible).length
    };
  }

  function buildRuleTooltip(ruleEval) {
    if (!ruleEval) return "";
    const hiddenTags = new Set(["expecteddischarge", "countbalance", "chg", "foley", "q2turns", "feeder", "staffrestriction"]);
    const isHidden = (x) => hiddenTags.has(String(x?.tag || "").toLowerCase());
    const v = (Array.isArray(ruleEval.violations) ? ruleEval.violations : []).filter((x) => !isHidden(x));
    const w = (Array.isArray(ruleEval.warnings) ? ruleEval.warnings : []).filter((x) => !isHidden(x));
    if (!v.length && !w.length) return "";

    const plainRuleLabel = (x) => {
      const tag = String(x?.tag || "").toLowerCase();
      if (tag === "rnratio") return "Tele/NIH/EMU group exceeds 4 patients";
      if (tag === "rnabsolutemax") return "Med-Surg group exceeds 5 patients";
      if (tag === "nih") return "Multiple NIH patients assigned together";
      if (tag === "nihemu") return "NIH and EMU are paired together";
      if (tag === "drip") return "Multiple drip patients assigned together";
      if (tag === "bg") return "Blood glucose checks are concentrated";
      if (tag === "tf") return "Tube feeds are concentrated";
      if (tag === "ciwa") return "Multiple CIWA/COWS/Psych/PRNs patients assigned together";
      if (tag === "emu") return "Multiple EMU patients assigned together";
      if (tag === "restraint") return "Multiple restraint patients assigned together";
      if (tag === "sitter") return "Multiple sitter patients assigned together";
      if (tag === "vpo") return "Multiple VPO patients assigned together";
      if (tag === "isolation") return "Isolation load is concentrated";
      if (tag === "admit") return "Multiple new admits assigned together";
      if (tag === "latedc") return "Multiple late discharges assigned together";
      if (tag === "report_sources") return "Too many report sources for this assignment";
      return String(x?.message || x?.tag || "Assignment warning");
    };

    const parts = [];
    v.forEach(x => parts.push(`! ${plainRuleLabel(x)}`));
    w.forEach(x => parts.push(`Warning: ${plainRuleLabel(x)}`));
    return parts.join(" | ");
    v.forEach(x => parts.push(`❗ ${x.tag}: ${x.mine} > ${x.limit}`));
    w.forEach(x => parts.push(`⚠ ${x.tag}: ${x.mine} > ${x.limit} (may be unavoidable)`));
    return parts.join(" • ");
  }

  function buildStaffRestrictionIconHtml(ruleEval) {
    const hits = (Array.isArray(ruleEval?.violations) ? ruleEval.violations : [])
      .filter((x) => String(x?.tag || "").toLowerCase() === "staffrestriction");
    if (!hits.length) return "";
    const title = hits.map((x) => x?.message || "Staff restriction mismatch").join(" | ");
    return `<button class="icon-btn staff-restriction-bad" type="button" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">&#9977;</button>`;
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function firstNameOnly(name) {
    const raw = String(name || "").trim();
    if (!raw) return "";
    const noId = raw.replace(/#?\d{4,}/g, "").trim();
    const first = noId.split(/\s+/).filter(Boolean)[0] || "";
    return first || raw;
  }

  // Keep this API (even though we removed 💡 buttons)
  window.__openOwnerExplain = function (btnEl) {
    try {
      const text = btnEl?.getAttribute("data-explain") || btnEl?.title || "";
      if (!text) return;
      alert(text);
    } catch (e) {
      console.warn("__openOwnerExplain failed", e);
    }
  };

  // ✅ Lightweight pin hover handler (replaces per-row IIFEs)
  if (!window.__cuppPinHoverHandler) {
    window.__cuppPinHoverHandler = function (ev, enter) {
      try {
        const tr = ev?.currentTarget || ev?.target;
        if (!tr) return;
        const btn = tr.querySelector && tr.querySelector('button[data-pinbtn="1"]');
        if (!btn) return;

        const pinned = btn.getAttribute("data-pinned") === "1";
        if (pinned) {
          btn.style.opacity = "1";
          btn.style.pointerEvents = "auto";
          return;
        }

        if (enter) {
          btn.style.opacity = "0.55";
          btn.style.pointerEvents = "auto";
        } else {
          btn.style.opacity = "0";
          btn.style.pointerEvents = "none";
        }
      } catch (_) {}
    };
  }

  // -----------------------------
  // ✅ Empty drop-row helper
  // -----------------------------
  function buildEmptyDropRow(colspan, label) {
    return `
      <tr class="empty-drop-row" draggable="false" style="height:48px;">
        <td colspan="${colspan}" style="
          padding:14px 10px;
          text-align:center;
          font-size:12px;
          opacity:0.65;
          border-top:1px dashed rgba(15,23,42,0.12);
        ">
          ${escapeHtml(label || "Drop patients here")}
        </td>
      </tr>
    `;
  }

  // =========================================================
  // ✅ Status banner helpers
  // =========================================================
  function __ensureBanner(containerId, bannerId) {
    const container = document.getElementById(containerId);
    if (!container) return null;

    let el = document.getElementById(bannerId);
    if (!el) {
      el = document.createElement("div");
      el.id = bannerId;
      el.style.cssText = [
        "display:none",
        "margin:10px 0 14px 0",
        "padding:10px 12px",
        "border-radius:10px",
        "font-size:12px",
        "line-height:1.25",
        "border:1px solid rgba(15,23,42,0.12)",
        "background:rgba(15,23,42,0.03)"
      ].join(";");
      container.prepend(el);
    }
    return el;
  }

  function __setBanner(containerId, bannerId, kind, msg) {
    const el = __ensureBanner(containerId, bannerId);
    if (!el) return;

    const safeMsg = escapeHtml(msg || "");
    if (!safeMsg) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }

    let border = "rgba(15,23,42,0.12)";
    let bg = "rgba(15,23,42,0.03)";
    let title = "Update";

    if (kind === "ok") {
      border = "rgba(16,185,129,0.35)";
      bg = "rgba(16,185,129,0.08)";
      title = "Rebalance applied";
    } else if (kind === "warn") {
      border = "rgba(245,158,11,0.45)";
      bg = "rgba(245,158,11,0.10)";
      title = "No safe improvement found";
    } else if (kind === "bad") {
      border = "rgba(239,68,68,0.45)";
      bg = "rgba(239,68,68,0.10)";
      title = "Blocked";
    }

    el.style.borderColor = border;
    el.style.background = bg;
    el.style.display = "block";
    el.innerHTML = `<strong style="display:block;margin-bottom:4px;">${escapeHtml(title)}</strong>${safeMsg}`;
  }

  function __clearBanners() {
    __setBanner("assignmentOutput", "oncomingStatusRn", "", "");
    __setBanner("pcaAssignmentOutput", "oncomingStatusPca", "", "");
  }

  function __showOncomingRebalanceToast(kind, msg) {
    let el = document.getElementById("oncomingRebalanceToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "oncomingRebalanceToast";
      el.style.cssText = [
        "display:none",
        "max-width:100%",
        "padding:10px 12px",
        "border-radius:10px",
        "font-size:12px",
        "line-height:1.3",
        "box-shadow:0 8px 20px rgba(0,0,0,0.12)"
      ].join(";");
      const host = document.getElementById("globalAssignmentPrintActions");
      if (host) host.appendChild(el);
      else document.body.appendChild(el);
    }
    const safe = escapeHtml(msg || "");
    if (!safe) {
      el.style.display = "none";
      el.textContent = "";
      return;
    }

    if (kind === "ok") {
      el.style.background = "rgba(16,185,129,0.95)";
      el.style.color = "#052e1c";
      el.style.border = "1px solid rgba(16,185,129,0.95)";
    } else if (kind === "warn") {
      el.style.background = "rgba(245,158,11,0.95)";
      el.style.color = "#2b1300";
      el.style.border = "1px solid rgba(245,158,11,0.95)";
    } else {
      el.style.background = "rgba(15,23,42,0.95)";
      el.style.color = "#fff";
      el.style.border = "1px solid rgba(15,23,42,0.95)";
    }

    el.innerHTML = safe;
    el.style.display = "block";
    clearTimeout(window.__oncomingRebalanceToastTimer);
    window.__oncomingRebalanceToastTimer = setTimeout(() => {
      if (el) el.style.display = "none";
    }, 4200);
  }

  function __setRebalanceButtonBusy(isBusy) {
    const btn = document.getElementById("btnRebalanceOncomingBoth");
    if (!btn) return;
    btn.disabled = !!isBusy;
    btn.textContent = isBusy ? "Rebalancing..." : "Rebalance (Both)";
    btn.style.opacity = isBusy ? "0.75" : "";
    btn.style.cursor = isBusy ? "progress" : "";
  }

  function __suspendOncomingAutoPopulate(ms) {
    const dur = Math.max(0, Number(ms) || 0);
    window.__oncomingAutoPopulateSuspendUntil = Date.now() + dur;
    clearTimeout(window.__oncomingAutoPopulateTimer);
  }

  function __suspendCloudRealtimeApply(ms) {
    const dur = Math.max(0, Number(ms) || 0);
    window.__cloud = window.__cloud || {};
    window.__cloud.suspendRealtimeApplyUntil = Date.now() + dur;
  }

  function __setOncomingPopulateStatus(state, metaText) {
    const pill = document.getElementById("oncomingPopulateStatus");
    if (!pill) return;

    const dot = pill.querySelector && pill.querySelector(".staffing-status-dot");
    const textEl = pill.querySelector && pill.querySelector(".staffing-status-text");
    const metaEl = pill.querySelector && pill.querySelector(".staffing-status-meta");

    pill.setAttribute("data-state", String(state || ""));

    const isComplete = state === "complete";
    const isRebalancing = state === "rebalancing";
    if (dot) dot.style.background = isComplete ? "#22c55e" : (isRebalancing ? "#2563eb" : "#fbbf24");
    if (textEl) textEl.textContent = isComplete ? "All Patients Populated" : (isRebalancing ? "Rebalancing Assignments" : "Populating");
    if (metaEl) metaEl.textContent = metaText || "";
  }

  function __refreshOncomingPopulateStatus() {
    const ptsAll = __getPatients();
    const active = ptsAll.filter(p => p && !p.isEmpty);
    const total = active.length;
    const realNurses = __getIncomingNursesReal();
    const realPcas = __getIncomingPcasReal();

    const rnSet = new Set();
    const pcaSet = new Set();

    realNurses.forEach(rn => {
      (rn?.patients || []).forEach(pid => rnSet.add(Number(pid)));
    });

    realPcas.forEach(pca => {
      (pca?.patients || []).forEach(pid => pcaSet.add(Number(pid)));
    });

    const populatedCount = active.reduce((sum, p) => {
      const pid = Number(p?.id);
      if (!Number.isFinite(pid)) return sum;
      return sum + (rnSet.has(pid) && pcaSet.has(pid) ? 1 : 0);
    }, 0);

    const allPopulated = total === 0 ? true : populatedCount === total;
    __setOncomingPopulateStatus(allPopulated ? "complete" : "populating", `${populatedCount}/${total}`);

    const assignedCount = active.reduce((sum, p) => {
      const pid = Number(p?.id);
      if (!Number.isFinite(pid)) return sum;
      return sum + (rnSet.has(pid) || pcaSet.has(pid) ? 1 : 0);
    }, 0);
    const hasExistingLayout = assignedCount > 0;
    const canAutoPopulate = !!(realNurses.length && realPcas.length && total > 0 && !hasExistingLayout);
    const suspendedUntil = Number(window.__oncomingAutoPopulateSuspendUntil || 0);
    const autoPopulateSuspended = Date.now() < suspendedUntil;
    if (canAutoPopulate && !autoPopulateSuspended && !allPopulated && !window.__oncomingPopulateInFlight && !window.__oncomingRebalanceBothInFlight) {
      const now = Date.now();
      const last = Number(window.__oncomingAutoPopulateTs || 0);
      if (now - last > 1500) {
        window.__oncomingAutoPopulateTs = now;
        clearTimeout(window.__oncomingAutoPopulateTimer);
        window.__oncomingAutoPopulateTimer = setTimeout(() => {
          try {
            if (!window.__oncomingPopulateInFlight && !window.__oncomingRebalanceBothInFlight) {
              populateOncomingAssignment(false);
            }
          } catch (_) {}
        }, 180);
      }
    }
  }

  // =========================================================
  // ✅ UI helper (Report sources only)
  // =========================================================
  function __buildMetaRowHtml(reportSources) {
    const rs = (reportSources === undefined || reportSources === null) ? "—" : String(reportSources);

    return `
      <div style="
        display:flex;
        align-items:baseline;
        justify-content:flex-end;
        gap:12px;
        width:100%;
        margin-top:2px;
        font-size:12px;
        opacity:0.80;
      ">
        <div style="white-space:nowrap;">
          <strong>Report sources:</strong> ${escapeHtml(rs)}
        </div>
      </div>
    `;
  }

  // =========================================================
  // ✅ Rebalance visibility helpers (before/after deltas)
  // =========================================================
  function __snapshotOwners(owners) {
    const snap = new Map();
    (owners || []).forEach(o => {
      const id = Number(o?.id);
      const pts = Array.isArray(o?.patients) ? o.patients.slice() : [];
      if (Number.isFinite(id)) snap.set(id, pts.map(Number));
    });
    return snap;
  }

  function __restoreOwnersFromSnapshot(owners, snap) {
    (owners || []).forEach((o) => {
      const id = Number(o?.id);
      if (!Number.isFinite(id)) return;
      o.patients = safeArray(snap?.get(id)).slice();
    });
  }

  function __countMovesFromSnapshots(beforeSnap, ownersAfter) {
    try {
      let moves = 0;
      (ownersAfter || []).forEach(o => {
        const id = Number(o?.id);
        const after = Array.isArray(o?.patients) ? o.patients.map(Number) : [];
        const before = beforeSnap?.get(id) || [];
        if (before.length !== after.length) {
          moves += Math.abs(before.length - after.length);
          return;
        }
        // same length: count membership changes
        const b = new Set(before);
        const a = new Set(after);
        let diff = 0;
        before.forEach(pid => { if (!a.has(pid)) diff++; });
        after.forEach(pid => { if (!b.has(pid)) diff++; });
        moves += diff;
      });
      // moves above double-counts across two owners; normalize
      return Math.max(0, Math.round(moves / 2));
    } catch {
      return 0;
    }
  }

  function __reportStatsForOwners(owners, role, prevMap) {
    const list = Array.isArray(owners) ? owners : [];
    const counts = list.map(o => (Array.isArray(o?.patients) ? o.patients.length : 0));
    const maxCount = counts.length ? Math.max(...counts) : 0;
    const minCount = counts.length ? Math.min(...counts) : 0;

    const reportCounts = list.map(o => uniqueCountFromMap(o?.patients || [], prevMap));
    const maxReport = reportCounts.length ? Math.max(...reportCounts) : 0;
    const sumReport = reportCounts.reduce((a, b) => a + (Number(b) || 0), 0);

    const avoid = getAvoidableViolationCount(list, role);

    return {
      minCount,
      maxCount,
      maxReport,
      sumReport,
      avoid
    };
  }

  function __formatDeltaLine(label, before, after) {
    if (before === after) return `${label}: ${before}`;
    return `${label}: ${before} → ${after}`;
  }

  // =========================================================
  // RN Oncoming Render
  // =========================================================
  function __renderAssignmentOutputWithCache(prevMaps) {
    const __perfT0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
    __syncIncomingGlobals();

    const container = document.getElementById("assignmentOutput");
    if (!container) return;
    try {
      if (typeof window.refreshStaffingCountDisplays === "function") window.refreshStaffingCountDisplays();
    } catch {}

    if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

    let html = "";
    try {
    const holdOwner = __syncOncomingHoldPatients("nurse");
    const allOwners = __getIncomingNursesReal();
    const activeIdSet = new Set(
      __getPatients()
        .filter((p) => p && !p.isEmpty)
        .map((p) => Number(p.id))
        .filter(Number.isFinite)
    );

    const { prevRnByPid } = prevMaps || buildPrevOwnerMaps();

    // ✅ PERF: rules map once
    const rnRuleMap = safeGetRuleEvalMap(allOwners, "nurse");

    allOwners.forEach(nurse => {
      const validAssignedIds = __sanitizeOwnerAssignmentsToActiveBeds(nurse, activeIdSet);
      const pts = validAssignedIds
        .map(pid => (typeof window.getPatientById === "function" ? window.getPatientById(pid) : null))
        .filter(p => p && !p.isEmpty)
        .sort(safeSortPatientsForDisplay);

      const loadScore = (typeof getNurseLoadScore === "function") ? getNurseLoadScore(nurse) : 0;
      const loadClass = (typeof getLoadClass === "function") ? getLoadClass(loadScore, "nurse") : "";

      const reportSources = uniqueCountFromMap(nurse.patients || [], prevRnByPid);

      const ruleEval = getOwnerRuleEvalFromMap(nurse, rnRuleMap);
      const visibleRules = visibleRuleCounts(ruleEval);
      const vCount = visibleRules.violations;
      const wCount = visibleRules.warnings;
      const ruleTip = buildRuleTooltip(ruleEval);
      const staffRestrictionIcon = buildStaffRestrictionIconHtml(ruleEval);

      html += `
        <div class="assignment-card ${loadClass}"
             data-owner-card="1"
             data-board="incoming"
             data-role="nurse"
             data-owner-id="${Number(nurse.id)}"
             ondragover="window.onOwnerTileDragOver && window.onOwnerTileDragOver(event)"
             ondrop="window.onOwnerTileDrop && window.onOwnerTileDrop(event, 'incoming', 'nurse', ${Number(nurse.id)})">
          <div class="assignment-header assignment-header--compact"
               ondragover="window.onOwnerTileDragOver && window.onOwnerTileDragOver(event)"
               ondrop="window.onOwnerTileDrop && window.onOwnerTileDrop(event, 'incoming', 'nurse', ${Number(nurse.id)})">
            <div class="assignment-header-top">
              <div class="assignment-header-name-actions">
                <strong class="assignment-staff-name">${escapeHtml(nurse.name)}</strong>
                <div class="assignment-header-actions">
                  ${__ownerHeaderControlsHtml("incoming", "nurse", nurse)}
                </div>
                <div class="assignment-header-icons">
                  ${staffRestrictionIcon}
                  ${
                    (vCount || wCount)
                      ? `<button class="icon-btn ${vCount ? "flag-bad" : "flag-warn"}" type="button"
                          title="${escapeHtml(ruleTip || "Rule flag(s) present")}"
                          style="flex:0 0 auto;">!</button>`
                      : ``
                    }
                </div>
                <span class="assignment-report-source-top"><strong>Report sources:</strong> ${escapeHtml(reportSources == null ? "-" : String(reportSources))}</span>
              </div>
            </div>
            <div class="assignment-header-meta-row">
              <div class="assignment-header-primary-meta">Patients: ${pts.length} | Load Score: ${loadScore}</div>
              <div class="assignment-header-side-meta">${rnRatioBadgeHtmlForPatients(pts)}</div>
            </div>
          </div>

          <table class="assignment-table">
            <thead>
              <tr>
                <th>Bed</th>
                <th>Level</th>
                <th>Acuity Notes</th>
                <th>Prev. RN</th>
              </tr>
            </thead>
            <tbody
              ondragover="onRowDragOver(event)"
              ondrop="onRowDrop(event, 'incoming', 'nurse', ${nurse.id})"
            >
      `;

      if (!pts.length) {
        html += buildEmptyDropRow(4, "Drop a patient here to assign to this RN");
      }

      pts.forEach(p => {
        const prevName = firstNameOnly(__prevMapLookup(prevRnByPid, p.id));

        const pinned = isPatientPinnedToIncomingRn(p.id, nurse.id);
        const draggable = pinned ? "false" : "true";

        const pinControl = `
          <button
            type="button"
            aria-label="Pin patient to this RN"
            title="${escapeHtml(pinned ? "Pinned to this RN (click to unpin)" : "Pin to this RN (preserve on regenerate)")}"
            onclick="window.toggleIncomingRnPin(${p.id}, ${nurse.id})"
            data-pinbtn="1"
            data-pinned="${pinned ? "1" : "0"}"
            style="
              margin-left:8px;
              border:none;
              background:transparent;
              cursor:pointer;
              font-size:14px;
              line-height:1;
              padding:0;
              opacity:${pinned ? "1" : "0"};
              pointer-events:${pinned ? "auto" : "none"};
            "
          >📌</button>
        `;

        html += `
          <tr
            draggable="${draggable}"
            ondragstart="onRowDragStart(event, 'incoming', 'nurse', ${nurse.id}, ${p.id})"
            ondragend="onRowDragEnd(event)"
            ondblclick="openPatientProfileFromRoom(${p.id})"
            onmouseenter="window.__cuppPinHoverHandler(event, true)"
            onmouseleave="window.__cuppPinHoverHandler(event, false)"
            style="${pinned ? "opacity:0.98;" : ""}"
          >
            <td>${bedCellHtml(p, pinControl)}</td>
            <td>${assignmentTeleHeartHtml(p)}</td>
            <td>${typeof rnTagString === "function" ? rnTagString(p) : ""}</td>
            <td>${escapeHtml(prevName || "-")}</td>
          </tr>
        `;
      });

      html += `
            </tbody>
          </table>
        </div>
      `;
    });

    html += __buildOncomingHoldCard("nurse", holdOwner, prevRnByPid);

    } catch (error) {
      console.error("[oncoming render] RN render failed", error);
      html = `<div class="assignment-card" style="border-left:6px solid rgba(239,68,68,0.85);"><div class="assignment-header"><strong>Unable to render incoming RN assignments</strong></div><div style="padding:12px; color:#7f1d1d; font-size:13px;">A rendering error occurred. Check the browser console for details.</div></div>`;
    }

    container.innerHTML = html;
    if (window.bindOwnerCardControls) window.bindOwnerCardControls(container);
    container.ondragover = function (event) {
      if (window.onOwnerTileDragOver) window.onOwnerTileDragOver(event);
    };
    container.ondrop = function (event) {
      if (window.onOwnerTileContainerDrop) window.onOwnerTileContainerDrop(event, "incoming", "nurse");
    };
    try {
      if (typeof window.perfRecord === "function" && __perfT0) {
        window.perfRecord("renderAssignmentOutput:board_only", performance.now() - __perfT0);
      }
    } catch (_) {}
  }

  // =========================================================
  // PCA Oncoming Render
  // =========================================================
  function __renderPcaAssignmentOutputWithCache(prevMaps) {
    const __perfT0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
    __syncIncomingGlobals();

    const container = document.getElementById("pcaAssignmentOutput");
    if (!container) return;
    try {
      if (typeof window.refreshStaffingCountDisplays === "function") window.refreshStaffingCountDisplays();
    } catch {}

    if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

    let html = "";
    try {
    const holdOwner = __syncOncomingHoldPatients("pca");
    const allOwners = __pcaDisplayOwners(__getIncomingPcasReal());
    const activeIdSet = new Set(
      __getPatients()
        .filter((p) => p && !p.isEmpty)
        .map((p) => Number(p.id))
        .filter(Number.isFinite)
    );

    const { prevPcaByPid } = prevMaps || buildPrevOwnerMaps();

    // ✅ PERF: rules map once
    const pcaRuleMap = safeGetRuleEvalMap(allOwners, "pca");

    allOwners.forEach(pca => {
      const validAssignedIds = __sanitizeOwnerAssignmentsToActiveBeds(pca, activeIdSet);
      const pts = validAssignedIds
        .map(pid => (typeof window.getPatientById === "function" ? window.getPatientById(pid) : null))
        .filter(p => p && !p.isEmpty)
        .sort(safeSortPatientsForDisplay);

      const loadScore = (typeof getPcaLoadScore === "function") ? getPcaLoadScore(pca) : 0;
      const loadClass = (typeof getLoadClass === "function") ? getLoadClass(loadScore, "pca") : "";

      const reportSources = uniqueCountFromMap(pca.patients || [], prevPcaByPid);

      const ruleEval = getOwnerRuleEvalFromMap(pca, pcaRuleMap);
      const visibleRules = visibleRuleCounts(ruleEval);
      const vCount = visibleRules.violations;
      const wCount = visibleRules.warnings;
      const ruleTip = buildRuleTooltip(ruleEval);
      const staffRestrictionIcon = buildStaffRestrictionIconHtml(ruleEval);
      const sitterPairs = __pcaSpecialRoomPairs(pca);
      const isSpecialPca = __isPcaSpecialOwner(pca);
      const specialLabel = __pcaSpecialLabel(pca, pts);
      const sitterRoomsLabel = isSpecialPca && sitterPairs.length ? sitterPairs.map((pair) => `${pair}A/${pair}B`).join(", ") : "";
      const printTitle = `${String(pca.name || "PCA").trim()} (${specialLabel})`;

      html += `
        <div class="assignment-card ${loadClass}"
             data-owner-card="1"
             data-board="incoming"
             data-role="pca"
             data-owner-id="${Number(pca.id)}"
             data-print-title="${escapeHtml(printTitle)}"
             ondragover="window.onOwnerTileDragOver && window.onOwnerTileDragOver(event)"
             ondrop="window.onOwnerTileDrop && window.onOwnerTileDrop(event, 'incoming', 'pca', ${Number(pca.id)})">
          <div class="assignment-header assignment-header--compact"
               ondragover="window.onOwnerTileDragOver && window.onOwnerTileDragOver(event)"
               ondrop="window.onOwnerTileDrop && window.onOwnerTileDrop(event, 'incoming', 'pca', ${Number(pca.id)})">
            <div class="assignment-header-top">
              <div class="assignment-header-name-actions">
                <strong class="assignment-staff-name">${escapeHtml(pca.name)}</strong><span class="assignment-staff-role">(${escapeHtml(specialLabel)})${isSpecialPca ? ` ${pts.length}${sitterRoomsLabel ? ` | ${escapeHtml(sitterRoomsLabel)}` : ``}` : ``}</span>
                <div class="assignment-header-actions">
                  ${__ownerHeaderControlsHtml("incoming", "pca", pca)}
                </div>
                <div class="assignment-header-icons">
                  ${staffRestrictionIcon}
                  ${
                    (vCount || wCount)
                      ? `<button class="icon-btn ${vCount ? "flag-bad" : "flag-warn"}" type="button"
                          title="${escapeHtml(ruleTip || "Rule flag(s) present")}"
                          style="flex:0 0 auto;">!</button>`
                      : ``
                    }
                </div>
                <span class="assignment-report-source-top"><strong>Report sources:</strong> ${escapeHtml(reportSources == null ? "-" : String(reportSources))}</span>
              </div>
            </div>
            <div class="assignment-header-meta-row">
              <div class="assignment-header-primary-meta">Patients: ${pts.length} | Load Score: ${loadScore}</div>
            </div>
          </div>

          <table class="assignment-table pca-oncoming-table">
            <thead>
              <tr>
                <th>Bed</th>
                <th>Level</th>
                <th>Acuity Notes</th>
                <th title="Previous PCA">Prev.</th>
              </tr>
            </thead>
            <tbody
              ondragover="onRowDragOver(event)"
              ondrop="onRowDrop(event, 'incoming', 'pca', ${pca.id})"
            >
      `;

      if (!pts.length) {
        html += buildEmptyDropRow(4, "Drop a patient here to assign to this PCA");
      }

      pts.forEach(p => {
        const prevName = firstNameOnly(__prevMapLookup(prevPcaByPid, p.id));
        const pinned = isPatientPinnedToIncomingPca(p.id, pca.id);
        const draggable = pinned ? "false" : "true";
        const pinControl = `
          <button
            type="button"
            aria-label="Pin patient to this PCA"
            title="${escapeHtml(pinned ? "Pinned to this PCA (click to unpin)" : "Pin to this PCA (preserve on regenerate)")}"
            onclick="window.toggleIncomingPcaPin(${p.id}, ${pca.id})"
            data-pinbtn="1"
            data-pinned="${pinned ? "1" : "0"}"
            style="
              margin-left:8px;
              border:none;
              background:transparent;
              cursor:pointer;
              font-size:14px;
              line-height:1;
              padding:0;
              opacity:${pinned ? "1" : "0"};
              pointer-events:${pinned ? "auto" : "none"};
            "
          >📌</button>
        `;

        html += `
          <tr
            draggable="${draggable}"
            ondragstart="onRowDragStart(event, 'incoming', 'pca', ${pca.id}, ${p.id})"
            ondragend="onRowDragEnd(event)"
            ondblclick="openPatientProfileFromRoom(${p.id})"
            onmouseenter="window.__cuppPinHoverHandler(event, true)"
            onmouseleave="window.__cuppPinHoverHandler(event, false)"
            style="${pinned ? "opacity:0.98;" : ""}"
          >
            <td>${bedCellHtml(p, pinControl)}</td>
            <td>${assignmentTeleHeartHtml(p)}</td>
            <td>${typeof pcaTagString === "function" ? pcaTagString(p) : ""}</td>
            <td>${escapeHtml(prevName || "-")}</td>
          </tr>
        `;
      });

      html += `
            </tbody>
          </table>
        </div>
      `;
    });

    html += __buildOncomingHoldCard("pca", holdOwner, prevPcaByPid);

    } catch (error) {
      console.error("[oncoming render] PCA render failed", error);
      html = `<div class="assignment-card" style="border-left:6px solid rgba(239,68,68,0.85);"><div class="assignment-header"><strong>Unable to render incoming PCA assignments</strong></div><div style="padding:12px; color:#7f1d1d; font-size:13px;">A rendering error occurred. Check the browser console for details.</div></div>`;
    }

    container.innerHTML = html;
    if (window.bindOwnerCardControls) window.bindOwnerCardControls(container);
    container.ondragover = function (event) {
      if (window.onOwnerTileDragOver) window.onOwnerTileDragOver(event);
    };
    container.ondrop = function (event) {
      if (window.onOwnerTileContainerDrop) window.onOwnerTileContainerDrop(event, "incoming", "pca");
    };
    try {
      if (typeof window.perfRecord === "function" && __perfT0) {
        window.perfRecord("renderPcaAssignmentOutput:board_only", performance.now() - __perfT0);
      }
    } catch (_) {}
  }

  // Batch render (RN + PCA share the same prev maps)
  function renderOncomingAll() {
    window.__oncomingRenderStats = window.__oncomingRenderStats || { all: 0, rn: 0, pca: 0, quality: 0 };
    window.__oncomingRenderStats.all += 1;
    window.__oncomingRenderStats.lastAllAt = new Date().toISOString();
    __beginRenderCycle();
    __syncOncomingDischargeVisualToggle();
    const prevMaps = __getPrevMapsForCycle();
    __renderAssignmentOutputWithCache(prevMaps);
    window.__oncomingRenderStats.rn += 1;
    __renderPcaAssignmentOutputWithCache(prevMaps);
    window.__oncomingRenderStats.pca += 1;
    __refreshOncomingPopulateStatus();
    if (__shouldDeferOncomingQualityPanel()) {
      __scheduleOncomingQualityPanel("renderOncomingAll");
    } else {
      __renderOncomingQualityPanel();
      window.__oncomingRenderStats.quality += 1;
    }
  }

  // Public render fns (keep API stable)
  function renderAssignmentOutput() {
    window.__oncomingRenderStats = window.__oncomingRenderStats || { all: 0, rn: 0, pca: 0, quality: 0 };
    window.__oncomingRenderStats.rn += 1;
    window.__oncomingRenderStats.lastRnAt = new Date().toISOString();
    __beginRenderCycle();
    __syncOncomingDischargeVisualToggle();
    const prevMaps = __getPrevMapsForCycle();
    __renderAssignmentOutputWithCache(prevMaps);
    __refreshOncomingPopulateStatus();
    if (__shouldDeferOncomingQualityPanel()) {
      __scheduleOncomingQualityPanel("renderAssignmentOutput");
    } else {
      __renderOncomingQualityPanel();
      window.__oncomingRenderStats.quality += 1;
    }
  }

  function renderPcaAssignmentOutput() {
    window.__oncomingRenderStats = window.__oncomingRenderStats || { all: 0, rn: 0, pca: 0, quality: 0 };
    window.__oncomingRenderStats.pca += 1;
    window.__oncomingRenderStats.lastPcaAt = new Date().toISOString();
    __beginRenderCycle();
    __syncOncomingDischargeVisualToggle();
    const prevMaps = __getPrevMapsForCycle();
    __renderPcaAssignmentOutputWithCache(prevMaps);
    __refreshOncomingPopulateStatus();
    if (__shouldDeferOncomingQualityPanel()) {
      __scheduleOncomingQualityPanel("renderPcaAssignmentOutput");
    } else {
      __renderOncomingQualityPanel();
      window.__oncomingRenderStats.quality += 1;
    }
  }

  function renderSitterAssignmentOutput() {
    // Sitter is modeled as a PCA designation; no standalone sitter board.
    __refreshOncomingPopulateStatus();
  }

  // =========================================================
  // Generator (Oncoming populate + rebalance)
  // =========================================================
  function populateOncomingAssignment(randomize = false) {
    if (window.__oncomingPopulateInFlight) return;
    window.__oncomingPopulateInFlight = true;
    __suspendOncomingAutoPopulate(1200);
    __setOncomingPopulateStatus("populating");

    try {
      __syncIncomingGlobals();
      __clearBanners();

      if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

      const nurses = __getIncomingNursesReal();
      const pcas = __getIncomingPcasReal();
      const ptsAll = __getPatients();

      if (!nurses.length || !pcas.length) {
        alert("Please set up ONCOMING RNs and PCAs on the Staffing Details tab first.");
        return;
      }

      const activePatients = ptsAll.filter(p => p && !p.isEmpty);
      if (!activePatients.length) {
        alert("No active patients found.");
        return;
      }

      nurses.forEach(n => { n.patients = []; });
      pcas.forEach(p => { p.patients = []; });

      cleanupRnPinsAgainstRoster();
      cleanupPcaPinsAgainstRoster();

      let list = activePatients.slice();
      if (randomize) list.sort(() => Math.random() - 0.5);
      else list.sort(safeSortPatientsForDisplay);

      const { unlockedPool } = applyRnPinsBeforeDistribute(list);

      if (typeof window.distributePatientsEvenly === "function") {
        window.distributePatientsEvenly(nurses, unlockedPool, { randomize, role: "nurse", preserveExisting: true });
        const pinnedToSitterPcas = __enforceSitterAssignmentsExclusive(pcas, list);
        const openPcas = pcas.filter((p) => !__isPcaSpecialOwner(p));
        const pcaPoolSeed = list.filter((p) => !pinnedToSitterPcas.has(Number(p?.id)));
        const { unlockedPool: pcaPool } = applyPcaPinsBeforeDistribute(pcaPoolSeed, openPcas);
        if (openPcas.length) {
          window.distributePatientsEvenly(openPcas, pcaPool, { randomize, role: "pca", preserveExisting: true });
        }
        const populateNihBalance = rebalanceNihDistribution(nurses, { maxPasses: 36 });
        rebalanceSingleMovesStrict(nurses, "nurse", { maxPasses: 120 });
        if (openPcas.length) rebalanceSingleMovesStrict(openPcas, "pca", { maxPasses: 120 });
        rebalanceExpectedDischarges(nurses, "nurse", { maxPasses: 80 });
        if (openPcas.length) rebalanceExpectedDischarges(openPcas, "pca", { maxPasses: 80 });
      } else {
        alert("ERROR: distributePatientsEvenly is not loaded. Check script order + app.assignmentRules.js loading.");
        console.error("distributePatientsEvenly missing — check index.html script order and app.assignmentRules.js.");
        return;
      }

      // keep these passes reasonable to avoid UI lag
      rebalanceSingleMovesStrict(nurses, "nurse", { maxPasses: 80 });
      balanceCountsWithoutCreatingNewAvoidableViolations(nurses, "nurse", { maxPasses: 50 });
      const openPcasForBalance = pcas.filter((p) => !__isPcaSpecialOwner(p));
      rebalanceSingleMovesStrict(openPcasForBalance, "pca", { maxPasses: 80 });
      balanceCountsWithoutCreatingNewAvoidableViolations(openPcasForBalance, "pca", { maxPasses: 50 });

      if (typeof window.repairAssignmentsInPlace === "function") {
        window.repairAssignmentsInPlace(nurses, "nurse", null, { maxIters: 35 });
        window.repairAssignmentsInPlace(openPcasForBalance, "pca", null, { maxIters: 35 });
      }
      rebalanceNihDistribution(nurses, { maxPasses: 36 });
      __enforceSitterAssignmentsExclusive(pcas, list);
      const populatePrevMaps = buildPrevOwnerMaps();
      __applyEngineV2Solution(nurses, activePatients, "nurse", populatePrevMaps.prevRnByPid, { maxPasses: 160, forceApply: true });
      __applyEngineV2Solution(openPcasForBalance, activePatients, "pca", populatePrevMaps.prevPcaByPid, { maxPasses: 160, forceApply: true });

      // ✅ batched render
      renderOncomingAll();

      if (typeof window.saveState === "function") window.saveState();
      if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
    } finally {
      window.__oncomingPopulateInFlight = false;
    }
  }

  function __runSafeRebalance(owners, role) {
    if (typeof window.rebalanceOwnersSafely !== "function") {
      if (typeof window.repairAssignmentsInPlace === "function") {
        window.repairAssignmentsInPlace(owners, role, null, { maxIters: 22 });
        return { applied: true, reason: "" };
      }
      return { applied: false, reason: "Rebalance engine not loaded." };
    }

    const res = window.rebalanceOwnersSafely(owners, role);
    if (!res?.applied) return { applied: false, reason: res?.reason || "Unable to rebalance safely." };
    return { applied: true, reason: "" };
  }

  function __waitForUiPaint() {
    return new Promise((resolve) => {
      const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
      raf(() => setTimeout(resolve, 0));
    });
  }

  async function rebalanceOncomingAssignment() {
    if (window.__oncomingRebalanceBothInFlight) return;
    window.__oncomingRebalanceBothInFlight = true;
    __setRebalanceButtonBusy(true);
    __suspendOncomingAutoPopulate(5000);
    __suspendCloudRealtimeApply(5000);
    __setOncomingPopulateStatus("rebalancing", "Thinking...");
    await __waitForUiPaint();

    try {
      __syncIncomingGlobals();
      __clearBanners();

      const nurses = __getIncomingNursesReal();
      const pcas = __getIncomingPcasReal();
      const ptsAll = __getPatients();

      // stats baseline (for visibility)
      const prevMaps = __getPrevMapsForCycle();
      const { prevRnByPid, prevPcaByPid } = prevMaps || buildPrevOwnerMaps();

      const beforeSnapRn = __snapshotOwners(nurses);
      const beforeSnapPca = __snapshotOwners(pcas);
      const beforeStatsRn = __reportStatsForOwners(nurses, "nurse", prevRnByPid);
      const beforeStatsPca = __reportStatsForOwners(pcas, "pca", prevPcaByPid);
      const beforeScoreRn = __nonIdealScore(nurses, "nurse", prevRnByPid);
      const beforeScorePca = __nonIdealScore(pcas.filter((p) => !__isPcaSpecialOwner(p)), "pca", prevPcaByPid);
      const baselinePreventableRn = getAvoidableViolationCount(nurses, "nurse");
      const baselinePreventablePca = getAvoidableViolationCount(pcas.filter((p) => !__isPcaSpecialOwner(p)), "pca");
      window.__lastOncomingRebalanceDebug = {
        startedAt: new Date().toISOString(),
        before: {
          rn: __debugOwnerSummary(nurses),
          pca: __debugOwnerSummary(pcas)
        },
        path: "starting"
      };

      try {
        cleanupRnPinsAgainstRoster();
        cleanupPcaPinsAgainstRoster();
        nurses.forEach(rn => {
          rn.patients = Array.isArray(rn.patients) ? rn.patients : [];
          rn.patients = rn.patients.filter(pid => !isPatientPinnedToIncomingRn(pid, rn.id));
        });
        pcas.forEach(pca => {
          pca.patients = Array.isArray(pca.patients) ? pca.patients : [];
          pca.patients = pca.patients.filter(pid => !isPatientPinnedToIncomingPca(pid, pca.id));
        });
        const active = ptsAll.filter(p => p && !p.isEmpty);
        applyRnPinsBeforeDistribute(active);
        const openPcasForPins = pcas.filter((p) => !__isPcaSpecialOwner(p));
        applyPcaPinsBeforeDistribute(active, openPcasForPins);
      } catch (e) {
        console.warn("[rebalance BOTH] pin placement pre-pass failed", e);
      }

      const openPcas = pcas.filter((p) => !__isPcaSpecialOwner(p));
      const activePatients = ptsAll.filter((p) => p && !p.isEmpty);
      const initialAssignedRn = Array.from(beforeSnapRn.values()).reduce((sum, row) => sum + safeArray(row).length, 0);
      const initialAssignedPca = Array.from(beforeSnapPca.values()).reduce((sum, row) => sum + safeArray(row).length, 0);
      const rnQueueFill = __assignMissingPatientsBestEffort(nurses, "nurse", activePatients);
      const pcaPoolForInitialFill = activePatients.filter((p) => !(__getIncomingPcas().some((owner) => __isPcaSpecialOwner(owner) && safeArray(owner?.patients).includes(Number(p?.id)))));
      const pcaQueueFill = __assignMissingPatientsBestEffort(openPcas, "pca", pcaPoolForInitialFill);
      const filledUnassignedPatients =
        rnQueueFill.added > 0 ||
        pcaQueueFill.added > 0 ||
        initialAssignedRn < activePatients.length ||
        (openPcas.length && initialAssignedPca < pcaPoolForInitialFill.length);
      const fastFillMode = !!filledUnassignedPatients;
      const alreadyBalancedEnough =
        !filledUnassignedPatients &&
        baselinePreventableRn <= 0 &&
        baselinePreventablePca <= 0 &&
        countSpreadLocal(nurses) <= 1 &&
        countSpreadLocal(openPcas) <= 1 &&
        roomSpreadOverflowLocal(nurses, "nurse") <= 0 &&
        roomSpreadOverflowLocal(openPcas, "pca") <= 0;
      if (alreadyBalancedEnough) {
        __setBanner(
          "assignmentOutput",
          "oncomingStatusRn",
          "ok",
          `Assignments already meet the core balance rules. No full rebalance was needed. Counts: ${__formatOwnerCounts(window.__lastOncomingRebalanceDebug?.before?.rn)}.`
        );
        __setBanner(
          "pcaAssignmentOutput",
          "oncomingStatusPca",
          "ok",
          `PCA assignments already meet the core balance rules. No full rebalance was needed. Counts: ${__formatOwnerCounts(window.__lastOncomingRebalanceDebug?.before?.pca)}.`
        );
        __showOncomingRebalanceToast("ok", "Assignments already meet core balance rules. No full rebalance was needed.");
        renderOncomingAll();
        if (typeof window.saveState === "function") window.saveState();
        return;
      }
      const strictPasses = fastFillMode ? 28 : 36;
      const dischargePassesRn = fastFillMode ? 36 : 44;
      const dischargePassesPca = fastFillMode ? 30 : 38;
      const countPasses = fastFillMode ? 18 : 22;
      const enginePasses = fastFillMode ? 45 : 55;
      let v2Rn = { applied: false, reason: "Engine V2 deferred to final pass." };
      let v2Pca = { applied: false, reason: "Engine V2 deferred to final pass." };
      window.__lastOncomingRebalanceDebug.v2 = {
        rn: v2Rn,
        pca: v2Pca,
        afterV2: {
          rn: __debugOwnerSummary(nurses),
          pca: __debugOwnerSummary(pcas)
        }
      };

      const nihBalanceRn = rebalanceNihDistribution(nurses, { maxPasses: 36 });
      const strictMoveRn = rebalanceSingleMovesStrict(nurses, "nurse", { maxPasses: strictPasses });
      const strictMovePca = rebalanceSingleMovesStrict(openPcas, "pca", { maxPasses: strictPasses });
      const dischargePassRn = rebalanceExpectedDischarges(nurses, "nurse", { maxPasses: dischargePassesRn });
      const dischargePassPca = rebalanceExpectedDischarges(openPcas, "pca", { maxPasses: dischargePassesPca });
      const rnCountFallback = balanceCountsWithoutCreatingNewAvoidableViolations(nurses, "nurse", { maxPasses: countPasses });
      const pcaCountFallback = balanceCountsWithoutCreatingNewAvoidableViolations(openPcas, "pca", { maxPasses: countPasses });
      let afterPrimaryPreventableRn = getAvoidableViolationCount(nurses, "nurse");
      let afterPrimaryPreventablePca = getAvoidableViolationCount(openPcas, "pca");
      let emergencyRnRebuild = { changed: false, improved: false };
      let emergencyPcaRebuild = { changed: false, improved: false };
      let rnRes = { applied: false, reason: "Heavy rebalance pass skipped; light pass was sufficient." };
      let pcaRes = { applied: false, reason: "Heavy rebalance pass skipped; light pass was sufficient." };
      const pcaPoolForRebuild = activePatients.filter((p) => !(__getIncomingPcas().some((owner) => __isPcaSpecialOwner(owner) && safeArray(owner?.patients).includes(Number(p?.id)))));

      if (afterPrimaryPreventableRn > 0) {
        emergencyRnRebuild = __fullRebuildOwnersForRole(nurses, "nurse", activePatients);
        rnRes = __runSafeRebalance(nurses, "nurse");
        rebalanceExpectedDischarges(nurses, "nurse", { maxPasses: fastFillMode ? 44 : 60 });
        afterPrimaryPreventableRn = getAvoidableViolationCount(nurses, "nurse");
      }
      if (afterPrimaryPreventablePca > 0 && openPcas.length) {
        emergencyPcaRebuild = __fullRebuildOwnersForRole(openPcas, "pca", pcaPoolForRebuild);
        pcaRes = __runSafeRebalance(openPcas, "pca");
        rebalanceExpectedDischarges(openPcas, "pca", { maxPasses: fastFillMode ? 38 : 52 });
        afterPrimaryPreventablePca = getAvoidableViolationCount(openPcas, "pca");
      }
      __enforceSitterAssignmentsExclusive(pcas, ptsAll.filter((p) => p && !p.isEmpty));
      const needsEngineRn =
        afterPrimaryPreventableRn > 0 ||
        countSpreadLocal(nurses) > 1 ||
        roomSpreadOverflowLocal(nurses, "nurse") > 0;
      const needsEnginePca =
        openPcas.length &&
        (
          afterPrimaryPreventablePca > 0 ||
          countSpreadLocal(openPcas) > 1 ||
          roomSpreadOverflowLocal(openPcas, "pca") > 0
        );
      if (needsEngineRn) {
        v2Rn = __applyEngineV2Solution(nurses, activePatients, "nurse", prevRnByPid, { maxPasses: enginePasses, reseedOwners: false, forceApply: true });
      } else {
        v2Rn = { applied: false, reason: "Engine skipped; RN light balance met core rules." };
      }
      if (needsEnginePca) {
        v2Pca = __applyEngineV2Solution(openPcas, activePatients, "pca", prevPcaByPid, { maxPasses: enginePasses, reseedOwners: false, forceApply: true });
      } else {
        v2Pca = { applied: false, reason: "Engine skipped; PCA light balance met core rules." };
      }
      window.__lastOncomingRebalanceDebug.v2 = {
        rn: v2Rn,
        pca: v2Pca,
        afterV2: {
          rn: __debugOwnerSummary(nurses),
          pca: __debugOwnerSummary(pcas)
        }
      };

      const finalPreventableRn = getAvoidableViolationCount(nurses, "nurse");
      const finalPreventablePca = getAvoidableViolationCount(openPcas, "pca");
      const finalRoomOverflowRn = roomSpreadOverflowLocal(nurses, "nurse");
      const finalRoomOverflowPca = roomSpreadOverflowLocal(openPcas, "pca");
      const afterScoreRnAttempt = __nonIdealScore(nurses, "nurse", prevRnByPid);
      const afterScorePcaAttempt = __nonIdealScore(openPcas, "pca", prevPcaByPid);
      const beforeBoardScore = __sumNonIdealScores(beforeScoreRn, beforeScorePca);
      const afterBoardScore = __sumNonIdealScores(afterScoreRnAttempt, afterScorePcaAttempt);
      window.__lastOncomingRebalanceDebug.path = "legacy_fallback";
      window.__lastOncomingRebalanceDebug.after = {
        rn: __debugOwnerSummary(nurses),
        pca: __debugOwnerSummary(pcas),
        finalPreventableRn,
        finalPreventablePca,
        finalRoomOverflowRn,
        finalRoomOverflowPca,
        beforeBoardScore,
        afterBoardScore
      };
      const baselinePreventablePresent = baselinePreventableRn > 0 || baselinePreventablePca > 0;
      const finalCountSpreadRn = countSpreadLocal(nurses);
      const finalCountSpreadPca = countSpreadLocal(openPcas);
      const perfectRuleClean =
        finalPreventableRn <= 0 &&
        finalPreventablePca <= 0 &&
        finalCountSpreadRn <= 1 &&
        finalCountSpreadPca <= 1 &&
        finalRoomOverflowRn <= 0 &&
        finalRoomOverflowPca <= 0;
      const boardCompare = __compareNonIdealScore(afterBoardScore, beforeBoardScore);
      const boardImproved = boardCompare < 0;
      const boardWorse = boardCompare > 0;
      const countStillImbalanced = finalCountSpreadRn > 1 || finalCountSpreadPca > 1;
      const roomStillWide = finalRoomOverflowRn > 0 || finalRoomOverflowPca > 0;
      const sparseBoard = activePatients.length <= Math.max(1, Math.min(nurses.length || 1, openPcas.length || nurses.length || 1));
      const bestEffortRetained = !boardImproved && !boardWorse && !perfectRuleClean;
      const shouldRollback = boardWorse && !sparseBoard && !filledUnassignedPatients;
      if (shouldRollback) {
        __restoreOwnersFromSnapshot(nurses, beforeSnapRn);
        __restoreOwnersFromSnapshot(pcas, beforeSnapPca);
      }

      const afterStatsRn = __reportStatsForOwners(nurses, "nurse", prevRnByPid);
      const afterStatsPca = __reportStatsForOwners(pcas, "pca", prevPcaByPid);
      const afterScoreRn = __nonIdealScore(nurses, "nurse", prevRnByPid);
      const afterScorePca = __nonIdealScore(openPcas, "pca", prevPcaByPid);
      const beforeCountsRnText = __formatOwnerCounts(window.__lastOncomingRebalanceDebug?.before?.rn);
      const afterCountsRnText = __formatOwnerCounts(window.__lastOncomingRebalanceDebug?.after?.rn || __debugOwnerSummary(nurses));
      const beforeCountsPcaText = __formatOwnerCounts(window.__lastOncomingRebalanceDebug?.before?.pca);
      const afterCountsPcaText = __formatOwnerCounts(window.__lastOncomingRebalanceDebug?.after?.pca || __debugOwnerSummary(pcas));
      const v2RnReason = __formatEngineReason(v2Rn, "Engine V2 did not accept a better RN assignment.");
      const v2PcaReason = __formatEngineReason(v2Pca, "Engine V2 did not accept a better PCA assignment.");

      const movesRn = __countMovesFromSnapshots(beforeSnapRn, nurses);
      const movesPca = __countMovesFromSnapshots(beforeSnapPca, pcas);
      const rnApplied = !shouldRollback && !!(nihBalanceRn?.changed || v2Rn?.applied || strictMoveRn?.changed || dischargePassRn?.changed || rnRes.applied || rnCountFallback?.changed || emergencyRnRebuild?.changed || movesRn > 0);
      const pcaApplied = !shouldRollback && !!(v2Pca?.applied || strictMovePca?.changed || dischargePassPca?.changed || pcaRes.applied || pcaCountFallback?.changed || emergencyPcaRebuild?.changed || movesPca > 0);
      const rnBestEffort = !rnApplied && !shouldRollback && (bestEffortRetained || filledUnassignedPatients);
      const pcaBestEffort = !pcaApplied && !shouldRollback && (bestEffortRetained || filledUnassignedPatients);

      const msgOkRn = [
        `Applied ${movesRn} move${movesRn === 1 ? "" : "s"}.`,
        v2Rn?.applied ? "Engine V2 final pass applied." : "",
        nihBalanceRn?.changed ? nihBalanceRn.reason : "",
        strictMoveRn?.changed ? "Direct one-patient RN moves applied." : "",
        emergencyRnRebuild?.changed ? "Escalated to a full discharge-aware RN rebuild." : "",
        (rnCountFallback?.changed && !rnRes.applied) ? "Count-priority balancing applied." : "",
        __formatDeltaLine("Max report sources", beforeStatsRn.maxReport, afterStatsRn.maxReport),
        __formatDeltaLine("Report-source total", beforeStatsRn.sumReport, afterStatsRn.sumReport),
        __formatDeltaLine("Avoidable violations", beforeStatsRn.avoid, afterStatsRn.avoid),
        __formatDeltaLine("Count spread", `${beforeStatsRn.minCount}-${beforeStatsRn.maxCount}`, `${afterStatsRn.minCount}-${afterStatsRn.maxCount}`),
        `Non-ideal score: ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}`,
        `Counts: ${afterCountsRnText}`
      ].filter(Boolean).join(" ");

      const msgOkPca = [
        `Applied ${movesPca} move${movesPca === 1 ? "" : "s"}.`,
        v2Pca?.applied ? "Engine V2 final pass applied." : "",
        strictMovePca?.changed ? "Direct one-patient PCA moves applied." : "",
        emergencyPcaRebuild?.changed ? "Escalated to a full discharge-aware PCA rebuild." : "",
        (pcaCountFallback?.changed && !pcaRes.applied) ? "Count-priority balancing applied." : "",
        __formatDeltaLine("Max report sources", beforeStatsPca.maxReport, afterStatsPca.maxReport),
        __formatDeltaLine("Report-source total", beforeStatsPca.sumReport, afterStatsPca.sumReport),
        __formatDeltaLine("Avoidable violations", beforeStatsPca.avoid, afterStatsPca.avoid),
        __formatDeltaLine("Count spread", `${beforeStatsPca.minCount}-${beforeStatsPca.maxCount}`, `${afterStatsPca.minCount}-${afterStatsPca.maxCount}`),
        `Non-ideal score: ${__formatNonIdealScore(beforeScorePca)} -> ${__formatNonIdealScore(afterScorePca)}`,
        `Counts: ${afterCountsPcaText}`
      ].filter(Boolean).join(" ");

      __setBanner(
        "assignmentOutput",
        "oncomingStatusRn",
        (rnApplied || rnBestEffort) ? "ok" : "warn",
        rnApplied ? msgOkRn : rnBestEffort ? (
          `Best available RN distribution retained. No safer improvement was needed for the current board. Score ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}. Counts: ${afterCountsRnText}.`
        ) : (
          shouldRollback
            ? (baselinePreventablePresent
                ? `No board-quality improvement was found. Existing preventable RN/PCA rule breaks remain unchanged. Score ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}. Before: ${beforeCountsRnText}. After attempt: ${afterCountsRnText}. Engine V2: ${v2RnReason}.`
                : `Rebalance rolled back because it did not improve board quality. Score ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}. Before: ${beforeCountsRnText}. After attempt: ${afterCountsRnText}. Engine V2: ${v2RnReason}.`)
            : `${rnRes.reason || "Unable to rebalance safely."} Score ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}. Before: ${beforeCountsRnText}. After attempt: ${afterCountsRnText}. Engine V2: ${v2RnReason}.`
        )
      );

      __setBanner(
        "pcaAssignmentOutput",
        "oncomingStatusPca",
        (pcaApplied || pcaBestEffort) ? "ok" : "warn",
        pcaApplied ? msgOkPca : pcaBestEffort ? (
          `Best available PCA distribution retained. No safer improvement was needed for the current board. Score ${__formatNonIdealScore(beforeScorePca)} -> ${__formatNonIdealScore(afterScorePca)}. Counts: ${afterCountsPcaText}.`
        ) : (
          shouldRollback
            ? (baselinePreventablePresent
                ? `No board-quality improvement was found. Existing preventable RN/PCA rule breaks remain unchanged. Score ${__formatNonIdealScore(beforeScorePca)} -> ${__formatNonIdealScore(afterScorePca)}. Before: ${beforeCountsPcaText}. After attempt: ${afterCountsPcaText}. Engine V2: ${v2PcaReason}.`
                : `Rebalance rolled back because it did not improve board quality. Score ${__formatNonIdealScore(beforeScorePca)} -> ${__formatNonIdealScore(afterScorePca)}. Before: ${beforeCountsPcaText}. After attempt: ${afterCountsPcaText}. Engine V2: ${v2PcaReason}.`)
            : `${pcaRes.reason || "Unable to rebalance safely."} Score ${__formatNonIdealScore(beforeScorePca)} -> ${__formatNonIdealScore(afterScorePca)}. Before: ${beforeCountsPcaText}. After attempt: ${afterCountsPcaText}. Engine V2: ${v2PcaReason}.`
        )
      );
      __showOncomingRebalanceToast(
        (rnApplied || pcaApplied || rnBestEffort || pcaBestEffort) ? "ok" : "warn",
        (rnApplied || pcaApplied)
          ? `Rebalance complete. RN moves: ${movesRn}. PCA moves: ${movesPca}.`
          : (rnBestEffort || pcaBestEffort)
            ? `Best available distribution retained. No safer move was needed for the current board.`
          : (
              shouldRollback
                ? (baselinePreventablePresent
                    ? `No safe rebalance improvement found. RN score ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}.`
                    : `Rebalance canceled because it did not improve board quality. RN score ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}.`)
                : `No safe rebalance improvement found. RN score ${__formatNonIdealScore(beforeScoreRn)} -> ${__formatNonIdealScore(afterScoreRn)}. Engine V2: ${v2RnReason}.`
            )
      );

      // ✅ batched render
      __suspendOncomingAutoPopulate(5000);
      __suspendCloudRealtimeApply(5000);
      renderOncomingAll();

      if (typeof window.saveState === "function") window.saveState();
      try {
        if (window.cloudSync && typeof window.cloudSync.publishUnitStateNow === "function") {
          void window.cloudSync.publishUnitStateNow("rebalance_apply");
        }
      } catch (_) {}
      if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err || "Unknown rebalance error.");
      try {
        window.__lastOncomingRebalanceDebug = {
          ...(window.__lastOncomingRebalanceDebug || {}),
          error: msg
        };
      } catch (_) {}
      try {
        __setBanner("assignmentOutput", "oncomingStatusRn", "warn", `Rebalance failed: ${msg}`);
        __setBanner("pcaAssignmentOutput", "oncomingStatusPca", "warn", `Rebalance failed: ${msg}`);
        __showOncomingRebalanceToast("warn", `Rebalance failed: ${msg}`);
      } catch (_) {}
      try { console.error("[oncoming rebalance] failed", err); } catch (_) {}
    } finally {
      try {
        window.__lastOncomingRebalanceDebug = {
          ...(window.__lastOncomingRebalanceDebug || {}),
          finishedAt: new Date().toISOString()
        };
      } catch (_) {}
      window.__oncomingRebalanceBothInFlight = false;
      __setRebalanceButtonBusy(false);
      try { __renderOncomingQualityPanel(); } catch (_) {}
      try { __refreshOncomingPopulateStatus(); } catch (_) {}
    }
  }

  function __hookOncomingAutoPopulateSignals() {
    if (window.__oncomingAutoPopulateSignalsHooked) return;
    window.__oncomingAutoPopulateSignalsHooked = true;

    ["renderPatientList", "updateDischargeCount", "updateAcuityTiles"].forEach((fnName) => {
      const original = window[fnName];
      if (typeof original !== "function" || original.__oncomingWrapped) return;
      const wrapped = function () {
        const out = original.apply(this, arguments);
        try { __refreshOncomingPopulateStatus(); } catch (_) {}
        return out;
      };
      wrapped.__oncomingWrapped = true;
      window[fnName] = wrapped;
    });
  }

  __hookOncomingAutoPopulateSignals();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", __hookOncomingAutoPopulateSignals);
  } else {
    setTimeout(__hookOncomingAutoPopulateSignals, 0);
  }

  // Expose globally (CRITICAL for index.html onclick)
  window.renderAssignmentOutput = renderAssignmentOutput;
  window.renderPcaAssignmentOutput = renderPcaAssignmentOutput;
  window.renderSitterAssignmentOutput = renderSitterAssignmentOutput;
  window.renderOncomingAll = renderOncomingAll;

  window.populateOncomingAssignment = populateOncomingAssignment;
  window.rebalanceOncomingAssignment = rebalanceOncomingAssignment;
  window.toggleOncomingQualityPanel = function toggleOncomingQualityPanel() {
    window.__oncomingQualityPanelCollapsed = window.__oncomingQualityPanelCollapsed === false;
    try { __renderOncomingQualityPanel(); } catch (_) {}
  };
  window.triggerOncomingRebalance = async function triggerOncomingRebalance() {
    const nowIso = new Date().toISOString();
    window.__lastOncomingRebalanceDebug = {
      ...(window.__lastOncomingRebalanceDebug || {}),
      clickReceivedAt: nowIso,
      clickCount: Number(window.__lastOncomingRebalanceDebug?.clickCount || 0) + 1,
      buttonTriggered: true
    };

    if (window.__oncomingRebalanceBothInFlight) {
      __showOncomingRebalanceToast("warn", "Rebalance is already running.");
      return;
    }

    __showOncomingRebalanceToast("ok", "Rebalance click received.");
    await rebalanceOncomingAssignment();
  };

  // Version marker
  window.__assignmentsRenderBuild =
    "v2026-01-25__reportSourceAwareCountBalancer";

  document.addEventListener("click", function () {
    setTimeout(() => {
      try { __syncOncomingQualityPanelVisibility(); } catch (_) {}
    }, 0);
  });
  setInterval(() => {
    try { __syncOncomingQualityPanelVisibility(); } catch (_) {}
  }, 500);
}
