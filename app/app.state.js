// app/app.state.js
// Core app state + storage + shared helpers + Admit Queue + Queue Assign Modal
// Drag & discharge logic: app.assignmentsDrag.js
// Patient grid + scoring: app.patientsAcuity.js
// LIVE assignments: app.liveAssignments.js
// Oncoming rendering/generator: app.assignmentsrender.js

// =========================
// Constants & Data
// =========================

const STORAGE_KEY = "nurse_pca_assigner_state_v4";

// Fixed unit rooms (32)
const ROOM_CODES = [
  "200A", "200B",
  "201A", "201B",
  "202A", "202B",
  "203A", "203B",
  "204A", "204B",
  "205",
  "207",
  "209",
  "211",
  "213A", "213B",
  "214A", "214B",
  "215A", "215B",
  "216A", "216B",
  "217A", "217B",
  "218A", "218B",
  "219A", "219B",
  "220A", "220B",
  "221A", "221B"
];

// Staff & patient arrays
let currentNurses   = [];
let currentPcas     = [];
let incomingNurses  = [];
let incomingPcas    = [];
let patients        = [];

// PCA shift (shared for current & incoming PCAs)
let pcaShift = "day";

// LIVE features
let dischargeHistory = []; // session history for “View History”
let nextDischargeId  = 1;

// Admit queue state
let admitQueue   = [];
let nextQueueId  = 1;

// Modal context (set when opening queue assign modal)
let queueAssignCtx = null; // { queueId, bedId }

// =========================
// Single refresh utility (Stability Hardening)
// =========================

function refreshUI() {
  // Keep this as the ONE place we call renders.
  // Anything can safely call window.refreshUI() without worrying about missing a tab.
  if (typeof window.renderQueueList === "function") window.renderQueueList();
  if (typeof window.renderPatientList === "function") window.renderPatientList();
  if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
  if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
  if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
  if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
  if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
}

// export early
window.refreshUI = refreshUI;

// =========================
// Basic Helpers
// =========================

function defaultRestrictions(oldRestriction) {
  return {
    noNih: oldRestriction === "noNih",
    noIso: false
  };
}

function makeEmptyPatient(id, roomCode) {
  return {
    id,
    room: roomCode || "",
    gender: "", // "M", "F", "X" or ""
    tele: false,
    drip: false,
    nih: false,
    bg: false,
    ciwa: false,
    restraint: false,
    sitter: false,
    vpo: false,
    isolation: false,
    admit: false,
    lateDc: false,
    chg: false,
    foley: false,
    q2turns: false,
    heavy: false,
    feeder: false,
    reviewed: false,
    isEmpty: true,
    recentlyDischarged: false,

    // optional label for display
    name: ""
  };
}

// Get index of room for sorting
function getRoomNumber(p) {
  const roomStr = String(p.room || "").toUpperCase().trim();
  const idx = ROOM_CODES.indexOf(roomStr);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

// Ensure we have 32 fixed patients
function ensureDefaultPatients() {
  if (patients.length === ROOM_CODES.length) return;
  patients = ROOM_CODES.map((code, idx) => makeEmptyPatient(idx + 1, code));
}

// Find roommate (for A/B rooms)
function findRoomMate(patient) {
  const roomStr = String(patient.room || "").toUpperCase().trim();
  const match = roomStr.match(/^(\d+)([AB])$/);
  if (!match) return null; // single rooms
  const base = match[1];
  const suffix = match[2] === "A" ? "B" : "A";
  const partnerRoom = base + suffix;
  return patients.find(pt => pt.room === partnerRoom && !pt.isEmpty);
}

// Enforce no mixed-gender rooms
function canSetGender(patient, newGender) {
  if (!newGender) return true; // unknown is always allowed
  const mate = findRoomMate(patient);
  if (!mate) return true;
  if (!mate.gender) return true;
  return mate.gender === newGender;
}

// =========================
// Admit Queue helpers
// =========================

function getEmptyBeds() {
  ensureDefaultPatients();
  return patients
    .filter(p => !!p.isEmpty)
    .slice()
    .sort((a, b) => getRoomNumber(a) - getRoomNumber(b));
}

// Default admit “draft” acuity object (future-proofed)
function makeDefaultAdmitDraft() {
  return {
    gender: "",
    // RN tags
    tele: false,
    drip: false,
    nih: false,
    bg: false,
    ciwa: false,
    restraint: false,
    sitter: false,
    vpo: false,
    isolation: false,
    lateDc: false,
    // PCA tags
    chg: false,
    foley: false,
    q2turns: false,
    heavy: false,
    feeder: false
  };
}

function coerceAdmitDraft(d) {
  const base = makeDefaultAdmitDraft();
  if (!d || typeof d !== "object") return base;
  return {
    ...base,
    ...d,
    gender: typeof d.gender === "string" ? d.gender : ""
  };
}

// "+ Add Admit" prompt: lets charge nurse name the admit
function promptAddAdmit() {
  const name = window.prompt(
    'Enter admit label (example: "ED Admit - Mr. Smith"):',
    "New Admit"
  );
  if (name == null) return; // cancel
  const trimmed = String(name).trim() || "New Admit";
  addToAdmitQueue(trimmed);
}

// Add new admit to queue (top of list)
function addToAdmitQueue(label = "New Admit") {
  const entry = {
    id: nextQueueId++,
    label: String(label || "New Admit"),
    createdAt: Date.now(),
    admitDraft: makeDefaultAdmitDraft(),
    uiOpen: false // controls inline edit section visibility
  };

  admitQueue.unshift(entry);

  if (typeof saveState === "function") saveState();
  if (typeof window.refreshUI === "function") window.refreshUI();
}

// Remove admit from queue
function removeFromAdmitQueue(queueId) {
  admitQueue = admitQueue.filter(q => q.id !== queueId);

  if (typeof saveState === "function") saveState();
  if (typeof window.refreshUI === "function") window.refreshUI();
}

// Update label anytime until placed
function updateQueuedAdmitLabel(queueId, newLabel) {
  const q = admitQueue.find(x => x.id === queueId);
  if (!q) return;
  q.label = String(newLabel || "").trim() || "New Admit";
  if (typeof saveState === "function") saveState();
  if (typeof window.refreshUI === "function") window.refreshUI();
}

function toggleQueuedAdmitUiOpen(queueId) {
  const q = admitQueue.find(x => x.id === queueId);
  if (!q) return;
  q.uiOpen = !q.uiOpen;
  if (typeof saveState === "function") saveState();
  if (typeof window.refreshUI === "function") window.refreshUI();
}

function updateQueuedAdmitDraft(queueId, key, value) {
  const q = admitQueue.find(x => x.id === queueId);
  if (!q) return;
  q.admitDraft = coerceAdmitDraft(q.admitDraft);

  if (key === "gender") {
    q.admitDraft.gender = String(value || "");
  } else {
    q.admitDraft[key] = !!value;
  }

  if (typeof saveState === "function") saveState();
  // no need to full refresh for every checkbox, but keeps everything synced
  if (typeof window.refreshUI === "function") window.refreshUI();
}

// Called by the queue button: ALWAYS opens modal, no auto-assign
function assignAdmitFromQueue(queueId) {
  openQueueAssignModal(queueId);
}

// =========================
// Capacity helpers (for modal filtering + confirm recheck)
// =========================

function getStaffCapacityCount(staffObj) {
  const arr = Array.isArray(staffObj && staffObj.patients) ? staffObj.patients : [];
  return arr.length;
}

function hasCapacity(staffObj) {
  if (!staffObj) return false;
  const max = Number(staffObj.maxPatients);
  const curr = getStaffCapacityCount(staffObj);
  if (!Number.isFinite(max)) return true; // if undefined, don’t block
  return curr < max;
}

// =========================
// Queue Assign Modal (BED + RN + PCA picker)
// =========================

function openQueueAssignModal(queueId) {
  ensureDefaultPatients();

  const modal    = document.getElementById("queueAssignModal");
  const bedSel   = document.getElementById("queueAssignBed");
  const nurseSel = document.getElementById("queueAssignNurse");
  const pcaSel   = document.getElementById("queueAssignPca");
  const infoEl   = document.getElementById("queueAssignInfo");

  if (!modal || !bedSel || !nurseSel || !pcaSel) {
    console.warn("Missing queueAssignModal / bed / nurse / pca elements in index.html");
    return;
  }

  const entry = admitQueue.find(x => x.id === queueId);
  if (!entry) return;

  const empties = getEmptyBeds();
  if (!empties.length) {
    alert("No empty beds available. Discharge / mark a bed empty first.");
    return;
  }

  // Remember which queue item we’re assigning (bed selected later)
  queueAssignCtx = { queueId, bedId: null };

  // Build Bed dropdown
  bedSel.innerHTML =
    `<option value="">Select Empty Bed…</option>` +
    empties.map(b => `<option value="${b.id}">${b.room}</option>`).join("");

  // Build RN dropdown from CURRENT staff — only those with capacity
  const nurses = Array.isArray(currentNurses) ? currentNurses : [];
  const eligibleNurses = nurses.filter(n => hasCapacity(n));

  nurseSel.innerHTML =
    `<option value="">Select RN…</option>` +
    eligibleNurses.map(n => `<option value="${n.id}">${n.name || `RN ${n.id}`}</option>`).join("");

  // Build PCA dropdown from CURRENT staff — only those with capacity
  const pcas = Array.isArray(currentPcas) ? currentPcas : [];
  const eligiblePcas = pcas.filter(p => hasCapacity(p));

  pcaSel.innerHTML =
    `<option value="">Select PCA…</option>` +
    eligiblePcas.map(p => `<option value="${p.id}">${p.name || `PCA ${p.id}`}</option>`).join("");

  // Info text
  if (infoEl) {
    const bedListPreview = empties.slice(0, 10).map(b => b.room).join(", ");
    infoEl.innerHTML = `
      <div style="margin-bottom:6px;"><strong>Admit:</strong> ${entry.label}</div>
      <div style="opacity:.8;font-size:13px;">
        Empty beds (${empties.length}): ${bedListPreview}${empties.length > 10 ? "…" : ""}
      </div>
      <div style="opacity:.8;font-size:13px;margin-top:6px;">
        Eligible RNs: ${eligibleNurses.length} | Eligible PCAs: ${eligiblePcas.length}
      </div>
      <div style="opacity:.7;font-size:12px;margin-top:6px;">
        Only staff with numeric capacity remaining are shown. Select bed + RN + PCA, then confirm.
      </div>
    `;
  }

  if (!eligibleNurses.length || !eligiblePcas.length) {
    alert("No eligible RN and/or PCA has remaining capacity for an admit. Adjust assignments/staffing first.");
    return;
  }

  modal.style.display = "flex";
}

function closeQueueAssignModal() {
  const modal = document.getElementById("queueAssignModal");
  if (modal) modal.style.display = "none";
  queueAssignCtx = null;
}

// CONFIRM button in modal: places the admit into the SELECTED empty bed + assigns RN/PCA
function confirmQueueAssign() {
  if (!queueAssignCtx) return;

  const queueId = queueAssignCtx.queueId;
  const entry   = admitQueue.find(x => x.id === queueId);
  if (!entry) {
    closeQueueAssignModal();
    return;
  }

  const bedSel   = document.getElementById("queueAssignBed");
  const nurseSel = document.getElementById("queueAssignNurse");
  const pcaSel   = document.getElementById("queueAssignPca");
  if (!bedSel || !nurseSel || !pcaSel) return;

  const bedId   = Number(bedSel.value);
  const nurseId = Number(nurseSel.value);
  const pcaId   = Number(pcaSel.value);

  if (!bedId || !nurseId || !pcaId) {
    alert("Please select an Empty Bed, a Receiving RN, and a Receiving PCA.");
    return;
  }

  ensureDefaultPatients();

  // Find the bed and ensure it's still empty
  const bed = patients.find(p => p.id === bedId) || null;
  if (!bed || !bed.isEmpty) {
    alert("That bed is no longer available. Please reopen the modal and pick another empty bed.");
    return;
  }

  // Find staff
  const rn = (Array.isArray(currentNurses) ? currentNurses : []).find(n => n.id === nurseId) || null;
  const pc = (Array.isArray(currentPcas) ? currentPcas : []).find(p => p.id === pcaId) || null;

  if (!rn || !pc) {
    alert("Receiving RN and PCA must both be valid selections.");
    return;
  }

  // Re-check capacity at confirm-time (stale modal protection)
  if (!hasCapacity(rn)) {
    alert(`${rn.name || "Selected RN"} is now at max capacity. Reopen the modal and choose another RN.`);
    return;
  }
  if (!hasCapacity(pc)) {
    alert(`${pc.name || "Selected PCA"} is now at max capacity. Reopen the modal and choose another PCA.`);
    return;
  }

  // Apply admit placement
  bed.isEmpty = false;
  bed.recentlyDischarged = false;
  bed.admit = true;
  bed.name = entry.label;

  // Apply “incoming admit draft acuity tags” at admit-time
  const d = coerceAdmitDraft(entry.admitDraft);

  // gender (optional)
  if (typeof d.gender === "string") bed.gender = d.gender;

  // RN tags
  bed.tele = !!d.tele;
  bed.drip = !!d.drip;
  bed.nih = !!d.nih;
  bed.bg = !!d.bg;
  bed.ciwa = !!d.ciwa;
  bed.restraint = !!d.restraint;
  bed.sitter = !!d.sitter;
  bed.vpo = !!d.vpo;
  bed.isolation = !!d.isolation;
  bed.lateDc = !!d.lateDc;

  // PCA tags
  bed.chg = !!d.chg;
  bed.foley = !!d.foley;
  bed.q2turns = !!d.q2turns;
  bed.heavy = !!d.heavy;
  bed.feeder = !!d.feeder;

  // Assign bed to RN/PCA
  if (!Array.isArray(rn.patients)) rn.patients = [];
  if (!rn.patients.includes(bed.id)) rn.patients.push(bed.id);

  if (!Array.isArray(pc.patients)) pc.patients = [];
  if (!pc.patients.includes(bed.id)) pc.patients.push(bed.id);

  // Remove from queue
  admitQueue = admitQueue.filter(x => x.id !== queueId);

  // Persist + rerender
  if (typeof saveState === "function") saveState();
  if (typeof window.refreshUI === "function") window.refreshUI();

  closeQueueAssignModal();
}

// =========================
// Queue Render (LIVE tab)
// =========================

function renderQueueList() {
  const el = document.getElementById("queueList");
  if (!el) return;

  const items = Array.isArray(admitQueue) ? admitQueue : [];
  if (!items.length) {
    el.innerHTML = `<div style="opacity:0.65;padding:6px 2px;">No admits in queue.</div>`;
    return;
  }

  el.innerHTML = items
    .map(q => {
      const t = q.createdAt ? new Date(q.createdAt).toLocaleTimeString() : "";
      const safeVal = String(q.label || "").replace(/"/g, "&quot;");
      const d = coerceAdmitDraft(q.admitDraft);
      const open = !!q.uiOpen;

      // Small helper for checkbox row
      const cb = (key, label) => `
        <label style="display:inline-flex;align-items:center;gap:6px;margin-right:10px;margin-bottom:6px;font-size:13px;">
          <input type="checkbox"
            ${d[key] ? "checked" : ""}
            onchange="window.updateQueuedAdmitDraft(${q.id}, '${key}', this.checked)"
          />
          ${label}
        </label>
      `;

      return `
        <div class="queue-row" style="padding:10px;border:1px solid #eee;border-radius:12px;background:#fff;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
            <div style="min-width:240px;flex:1;">
              <div style="font-weight:600;">
                <input
                  value="${safeVal}"
                  style="width: 320px; max-width: 100%; padding: 6px 8px; border-radius: 10px; border: 1px solid #e5e7eb;"
                  onblur="window.updateQueuedAdmitLabel(${q.id}, this.value)"
                  onkeydown="if(event.key==='Enter'){ event.preventDefault(); this.blur(); }"
                />
              </div>
              <div style="font-size:12px;opacity:0.7;margin-top:4px;">${t}</div>
            </div>

            <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
              <button onclick="window.toggleQueuedAdmitUiOpen(${q.id})">
                ${open ? "Hide Tags" : "Edit Tags"}
              </button>
              <button onclick="openQueueAssignModal(${q.id})">Assign to Empty Bed</button>
              <button onclick="removeFromAdmitQueue(${q.id})" style="opacity:.9;">Remove</button>
            </div>
          </div>

          ${open ? `
            <div style="margin-top:10px;padding:10px;border-radius:10px;background:#f8fafc;border:1px solid #e5e7eb;">
              <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
                <label style="font-size:13px;">
                  <strong>Gender:</strong>
                  <select
                    style="margin-left:6px;padding:3px 6px;border-radius:8px;border:1px solid #e5e7eb;"
                    onchange="window.updateQueuedAdmitDraft(${q.id}, 'gender', this.value)"
                  >
                    <option value=""  ${d.gender === ""  ? "selected" : ""}>Unspecified</option>
                    <option value="M" ${d.gender === "M" ? "selected" : ""}>M</option>
                    <option value="F" ${d.gender === "F" ? "selected" : ""}>F</option>
                    <option value="X" ${d.gender === "X" ? "selected" : ""}>X</option>
                  </select>
                </label>
              </div>

              <div style="margin-bottom:6px;font-size:13px;opacity:.8;"><strong>RN Acuity Tags</strong></div>
              <div style="display:flex;flex-wrap:wrap;">
                ${cb("tele","Tele")}
                ${cb("drip","Drip")}
                ${cb("nih","NIH")}
                ${cb("bg","BG")}
                ${cb("ciwa","CIWA")}
                ${cb("restraint","Restraint")}
                ${cb("sitter","Sitter")}
                ${cb("vpo","VPO")}
                ${cb("isolation","ISO")}
                ${cb("lateDc","Late DC")}
              </div>

              <div style="margin-top:8px;margin-bottom:6px;font-size:13px;opacity:.8;"><strong>PCA Task Tags</strong></div>
              <div style="display:flex;flex-wrap:wrap;">
                ${cb("chg","CHG")}
                ${cb("foley","Foley")}
                ${cb("q2turns","Q2 Turns")}
                ${cb("heavy","Heavy")}
                ${cb("feeder","Feeder")}
              </div>

              <div style="margin-top:8px;font-size:12px;opacity:.7;">
                These tags travel with the admit and get copied into the assigned bed when you place them.
              </div>
            </div>
          ` : ``}
        </div>
      `;
    })
    .join("");
}

// Optional helper: clear only the “recentlyDischarged” flags (keep empty beds empty)
// + ALSO clear the session discharge bin count (dischargeHistory) per your request.
function clearRecentlyDischargedFlags() {
  ensureDefaultPatients();

  // 1) Clear patient flags
  patients.forEach(p => {
    if (p && p.recentlyDischarged) p.recentlyDischarged = false;
  });

  // 2) Clear session discharge bin count
  // This is what drives: "Discharge Bin: X recent this session"
  dischargeHistory = [];
  nextDischargeId = 1;

  if (typeof saveState === "function") saveState();
  if (typeof window.refreshUI === "function") window.refreshUI();
}

// =========================
// Local Storage
// =========================

function saveState() {
  try {
    const data = {
      pcaShift,

      currentNurses: currentNurses.map((n, i) => ({
        id: n.id ?? i + 1,
        name: n.name,
        type: n.type,
        restrictions: n.restrictions || defaultRestrictions()
      })),

      incomingNurses: incomingNurses.map((n, i) => ({
        id: n.id ?? i + 1,
        name: n.name,
        type: n.type,
        restrictions: n.restrictions || defaultRestrictions()
      })),

      currentPcas: currentPcas.map((p, i) => ({
        id: p.id ?? i + 1,
        name: p.name,
        restrictions: p.restrictions || { noIso: false }
      })),

      incomingPcas: incomingPcas.map((p, i) => ({
        id: p.id ?? i + 1,
        name: p.name,
        restrictions: p.restrictions || { noIso: false }
      })),

      patients: patients.map(p => ({ ...p })),

      dischargeHistory,
      nextDischargeId,

      admitQueue,
      nextQueueId
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("Unable to save state", e);
  }
}

function loadStateFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      ensureDefaultPatients();
      return;
    }

    const data = JSON.parse(raw);

    if (data.pcaShift === "day" || data.pcaShift === "night") {
      pcaShift = data.pcaShift;
    }

    function buildNurseArray(src, prefixLabel) {
      if (!Array.isArray(src)) return [];
      return src.map((n, i) => {
        const restrictions = n.restrictions || defaultRestrictions(n.restriction);
        const type = n.type || "tele";
        return {
          id: n.id ?? i + 1,
          name: n.name || `${prefixLabel} ${i + 1}`,
          type,
          restrictions: {
            noNih: !!restrictions.noNih,
            noIso: !!restrictions.noIso
          },
          maxPatients: type === "tele" ? 4 : 5,
          patients: n.patients || []
        };
      });
    }

    function buildPcaArray(src, prefixLabel) {
      if (!Array.isArray(src)) return [];
      const max = pcaShift === "day" ? 8 : 9;
      return src.map((p, i) => ({
        id: p.id ?? i + 1,
        name: p.name || `${prefixLabel} ${i + 1}`,
        restrictions: { noIso: !!(p.restrictions && p.restrictions.noIso) },
        maxPatients: max,
        patients: p.patients || []
      }));
    }

    currentNurses  = buildNurseArray(data.currentNurses,  "Current RN");
    incomingNurses = buildNurseArray(data.incomingNurses, "Incoming RN");
    currentPcas    = buildPcaArray(data.currentPcas,      "Current PCA");
    incomingPcas   = buildPcaArray(data.incomingPcas,     "Incoming PCA");

    ensureDefaultPatients();

    if (Array.isArray(data.patients) && data.patients.length === ROOM_CODES.length) {
      patients = data.patients.map((p, i) => ({
        ...makeEmptyPatient(i + 1, ROOM_CODES[i]),
        ...p,
        id: i + 1,
        reviewed: !!p.reviewed,
        isEmpty: !!p.isEmpty,
        recentlyDischarged: !!p.recentlyDischarged,
        gender: p.gender || ""
      }));
    }

    dischargeHistory = Array.isArray(data.dischargeHistory) ? data.dischargeHistory : [];
    nextDischargeId = typeof data.nextDischargeId === "number" ? data.nextDischargeId : 1;

    admitQueue = Array.isArray(data.admitQueue) ? data.admitQueue : [];
    // backfill admitDraft + uiOpen for older saved queue entries
    admitQueue = admitQueue.map(q => ({
      ...q,
      admitDraft: coerceAdmitDraft(q && q.admitDraft),
      uiOpen: !!(q && q.uiOpen)
    }));

    nextQueueId = typeof data.nextQueueId === "number" ? data.nextQueueId : 1;

  } catch (e) {
    console.warn("Unable to load state", e);
    ensureDefaultPatients();
  }
}

// =========================
// Other Modals / Actions
// =========================

function openAcuityModal() {
  const body = document.getElementById("acuityReportBody");
  if (body && typeof buildHighAcuityText === "function") {
    body.innerHTML = buildHighAcuityText();
  }
  const modal = document.getElementById("acuityModal");
  if (modal) modal.style.display = "block";
}

function closeAcuityModal() {
  const modal = document.getElementById("acuityModal");
  if (modal) modal.style.display = "none";
}

// =========================
// Submit All (Patient Details)
// =========================

function submitAll() {
  ensureDefaultPatients();
  saveState();
  // Only touch the ONCOMING board when submitting from Patient Details
  if (typeof window.populateOncomingAssignment === "function") {
    window.populateOncomingAssignment(false);
  }
  alert("Patient details submitted and oncoming assignment generated.");
}

// =========================
// Live state exports & helpers
// =========================

window.ROOM_CODES = ROOM_CODES;

// Live getters/setters so other files always see fresh state
(function () {
  function defineLiveProp(prop, getterFn, setterFn) {
    const existing = Object.getOwnPropertyDescriptor(window, prop);
    if (existing && (typeof existing.get === "function" || typeof existing.set === "function")) {
      return; // don't redefine
    }
    Object.defineProperty(window, prop, {
      configurable: true,
      enumerable: true,
      get: getterFn,
      set: setterFn
    });
  }

  defineLiveProp("patients",         () => patients,         v => { patients = v; });
  defineLiveProp("currentNurses",    () => currentNurses,    v => { currentNurses = v; });
  defineLiveProp("currentPcas",      () => currentPcas,      v => { currentPcas = v; });
  defineLiveProp("incomingNurses",   () => incomingNurses,   v => { incomingNurses = v; });
  defineLiveProp("incomingPcas",     () => incomingPcas,     v => { incomingPcas = v; });
  defineLiveProp("dischargeHistory", () => dischargeHistory, v => { dischargeHistory = v; });
  defineLiveProp("nextDischargeId",  () => nextDischargeId,  v => { nextDischargeId = v; });
  defineLiveProp("pcaShift",         () => pcaShift,         v => { pcaShift = v; });
  defineLiveProp("admitQueue",       () => admitQueue,       v => { admitQueue = v; });
  defineLiveProp("nextQueueId",      () => nextQueueId,      v => { nextQueueId = v; });
})();

// Export helpers / functions to window
window.ensureDefaultPatients = ensureDefaultPatients;
window.saveState = saveState;
window.loadStateFromStorage = loadStateFromStorage;

window.defaultRestrictions = defaultRestrictions;
window.canSetGender = canSetGender;
window.getRoomNumber = getRoomNumber;

window.openAcuityModal = openAcuityModal;
window.closeAcuityModal = closeAcuityModal;

window.submitAll = submitAll;

// Queue helpers
window.promptAddAdmit = promptAddAdmit;
window.addToAdmitQueue = addToAdmitQueue;
window.removeFromAdmitQueue = removeFromAdmitQueue;
window.assignAdmitFromQueue = assignAdmitFromQueue;
window.renderQueueList = renderQueueList;

window.updateQueuedAdmitLabel = updateQueuedAdmitLabel;
window.toggleQueuedAdmitUiOpen = toggleQueuedAdmitUiOpen;
window.updateQueuedAdmitDraft = updateQueuedAdmitDraft;

window.openQueueAssignModal = openQueueAssignModal;
window.closeQueueAssignModal = closeQueueAssignModal;
window.confirmQueueAssign = confirmQueueAssign;

window.clearRecentlyDischargedFlags = clearRecentlyDischargedFlags;