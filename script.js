const MAX_PATIENTS = 32;
const STORAGE_KEY = "nurse_assigner_state_v1";

let nurses = [];
let patients = [];
let pcas = [];

/*
HARD RULES (for assignment):

- Tele vs MS:
  * Tele nurse: max 4 pts
  * Med-Surg nurse: up to 4 pts; 5th allowed only if all pts (existing+new) are MS

- Drip / NIH:
  * No nurse may have both drip and NIH across different pts
  * Allowed: only drip, only NIH, or a single combined drip+NIH pt

- Restrictions per nurse (multi-select):
  * No NIH: avoid NIH pts unless absolutely necessary
  * No ISO: avoid Isolation pts unless absolutely necessary

- BG: max 2 per nurse
- Sitter/VPO: max 1 per nurse
- Unit cap: 32 patients

PCAs:
- Stored for display/workflow only (not used in assignment yet)
- Each PCA: Name + restriction "No ISO"
*/

// Helpers for legacy nurse restriction support
function defaultRestrictions(oldRestriction) {
  return {
    noNih: oldRestriction === "noNih",
    noIso: false
  };
}

// -------------------------
// Local Storage Helpers
// -------------------------
function saveState() {
  try {
    const nurseCountSelect = document.getElementById("nurseCount");
    const pcaCountSelect = document.getElementById("pcaCount");

    const data = {
      nurseCount: nurseCountSelect ? nurseCountSelect.value : nurses.length,
      pcaCount: pcaCountSelect ? pcaCountSelect.value : pcas.length,
      nurses: nurses.map((n, i) => ({
        id: n.id ?? i + 1,
        name: n.name,
        type: n.type,
        restrictions: n.restrictions || defaultRestrictions()
      })),
      pcas: pcas.map((p, i) => ({
        id: p.id ?? i + 1,
        name: p.name,
        restrictions: p.restrictions || { noIso: false }
      })),
      patients
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("Unable to save state", e);
  }
}

function loadStateFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    const data = JSON.parse(raw);

    // Nurses
    if (Array.isArray(data.nurses)) {
      nurses = data.nurses.map((n, i) => {
        const restrictions =
          n.restrictions || defaultRestrictions(n.restriction);
        return {
          id: n.id ?? i + 1,
          name: n.name || `Nurse ${i + 1}`,
          type: n.type || "tele",
          restrictions: {
            noNih: !!restrictions.noNih,
            noIso: !!restrictions.noIso
          },
          maxPatients: (n.type || "tele") === "tele" ? 4 : 5,
          patients: []
        };
      });
    }

    // Patients
    if (Array.isArray(data.patients)) {
      patients = data.patients.map((p, i) => ({
        ...makeEmptyPatient(i + 1),
        ...p,
        id: i + 1,
        reviewed: !!p.reviewed
      }));
    }

    // PCAs
    if (Array.isArray(data.pcas)) {
      pcas = data.pcas.map((p, i) => ({
        id: p.id ?? i + 1,
        name: p.name || `PCA ${i + 1}`,
        restrictions: { noIso: !!(p.restrictions && p.restrictions.noIso) }
      }));
    }

    const nurseCountSelect = document.getElementById("nurseCount");
    if (nurseCountSelect && data.nurseCount) {
      nurseCountSelect.value = data.nurseCount;
    }

    const pcaCountSelect = document.getElementById("pcaCount");
    if (pcaCountSelect && data.pcaCount) {
      pcaCountSelect.value = data.pcaCount;
    }

    const pInput = document.getElementById("patientCountInput");
    if (pInput) pInput.value = patients.length || 0;
  } catch (e) {
    console.warn("Unable to load saved state", e);
  }
}

// -------------------------
// Nurse Setup
// -------------------------
function setupNurses() {
  const count = parseInt(document.getElementById("nurseCount").value);
  const oldNurses = nurses;
  nurses = [];

  for (let i = 0; i < count; i++) {
    const prev = oldNurses[i];
    const prevRestrictions =
      prev?.restrictions || defaultRestrictions(prev?.restriction);

    nurses.push({
      id: i + 1,
      name: prev?.name || `Nurse ${i + 1}`,
      type: prev?.type || "tele",
      restrictions: {
        noNih: !!prevRestrictions.noNih,
        noIso: !!prevRestrictions.noIso
      },
      maxPatients: (prev?.type || "tele") === "tele" ? 4 : 5,
      patients: []
    });
  }

  renderNurseList();
  saveState();
}

function renderNurseList() {
  const container = document.getElementById("nurseList");
  if (!container) return;
  container.innerHTML = "";

  nurses.forEach((n, index) => {
    const r = n.restrictions || defaultRestrictions();
    container.innerHTML += `
      <div class="nurseRow">
        <label>
          Name:
          <input type="text" value="${n.name}" 
            onchange="updateNurseName(${index}, this.value)">
        </label>
        <label>
          Type:
          <select onchange="updateNurseType(${index}, this.value)">
            <option value="tele" ${n.type === "tele" ? "selected" : ""}>Tele (max 4)</option>
            <option value="ms" ${n.type === "ms" ? "selected" : ""}>Med-Surg (max 5, MS-only for 5th)</option>
          </select>
        </label>

        <div class="restrictionsGroup">
          <span>Restrictions:</span>
          <label class="restrictionOption">
            <input type="checkbox" ${r.noNih ? "checked" : ""} 
              onchange="updateNurseRestriction(${index}, 'noNih', this.checked)"> No NIH
          </label>
          <label class="restrictionOption">
            <input type="checkbox" ${r.noIso ? "checked" : ""} 
              onchange="updateNurseRestriction(${index}, 'noIso', this.checked)"> No ISO
          </label>
        </div>
      </div>
    `;
  });
}

function updateNurseType(index, value) {
  nurses[index].type = value;
  nurses[index].maxPatients = value === "tele" ? 4 : 5;
  saveState();
}

function updateNurseName(index, value) {
  nurses[index].name = value || `Nurse ${index + 1}`;
  saveState();
}

function updateNurseRestriction(index, key, checked) {
  if (!nurses[index].restrictions) {
    nurses[index].restrictions = defaultRestrictions();
  }
  nurses[index].restrictions[key] = checked;
  saveState();
}

// -------------------------
// PCA Setup
// -------------------------
function setupPcas() {
  const sel = document.getElementById("pcaCount");
  let count = parseInt(sel.value);
  if (isNaN(count) || count < 3) count = 3;
  if (count > 5) count = 5;
  sel.value = count;

  const old = pcas;
  pcas = [];

  for (let i = 0; i < count; i++) {
    const prev = old[i];
    pcas.push({
      id: i + 1,
      name: prev?.name || `PCA ${i + 1}`,
      restrictions: {
        noIso: !!(prev && prev.restrictions && prev.restrictions.noIso)
      }
    });
  }

  renderPcaList();
  saveState();
}

function renderPcaList() {
  const container = document.getElementById("pcaList");
  if (!container) return;
  container.innerHTML = "";

  pcas.forEach((p, index) => {
    const r = p.restrictions || { noIso: false };
    container.innerHTML += `
      <div class="pcaRow">
        <label>
          Name:
          <input type="text" value="${p.name}"
            onchange="updatePcaName(${index}, this.value)">
        </label>
        <div class="restrictionsGroup">
          <span>Restrictions:</span>
          <label class="restrictionOption">
            <input type="checkbox" ${r.noIso ? "checked" : ""} 
              onchange="updatePcaRestriction(${index}, this.checked)"> No ISO
          </label>
        </div>
      </div>
    `;
  });
}

function updatePcaName(index, value) {
  pcas[index].name = value || `PCA ${index + 1}`;
  saveState();
}

function updatePcaRestriction(index, checked) {
  if (!pcas[index].restrictions) {
    pcas[index].restrictions = { noIso: false };
  }
  pcas[index].restrictions.noIso = checked;
  saveState();
}

// -------------------------
// Patient Setup
// -------------------------
function makeEmptyPatient(id) {
  return {
    id,
    room: "",
    tele: false,
    drip: false,
    nih: false,
    bg: false,
    ciwa: false,
    restraint: false,
    sitter: false,
    vpo: false,
    isolation: false,
    reviewed: false
  };
}

function addPatient() {
  if (patients.length >= MAX_PATIENTS) {
    showCapacityModal();
    return;
  }

  const id = patients.length + 1;
  const newPatient = makeEmptyPatient(id);
  patients.push(newPatient);
  renderPatientList();

  const input = document.getElementById("patientCountInput");
  if (input) input.value = patients.length;

  saveState();
}

function applyPatientCount() {
  const input = document.getElementById("patientCountInput");
  let desired = parseInt(input.value);
  if (isNaN(desired) || desired < 0) desired = 0;
  if (desired > MAX_PATIENTS) {
    desired = MAX_PATIENTS;
    showCapacityModal();
  }
  input.value = desired;

  const current = patients.length;

  if (desired > current) {
    for (let i = current; i < desired; i++) {
      patients.push(makeEmptyPatient(i + 1));
    }
  } else if (desired < current) {
    patients = patients.slice(0, desired);
  }

  patients.forEach((p, index) => {
    p.id = index + 1;
  });

  renderPatientList();
  saveState();
}

function updatePatient(id, field, value) {
  const p = patients.find(pt => pt.id === id);
  if (!p || p.reviewed) return;
  p[field] = value;
  saveState();
}

function togglePatientReviewed(id) {
  const p = patients.find(pt => pt.id === id);
  if (!p) return;
  p.reviewed = !p.reviewed;
  renderPatientList();
  saveState();
}

function deletePatient(id) {
  patients = patients.filter(p => p.id !== id);
  patients.forEach((p, idx) => (p.id = idx + 1));

  const input = document.getElementById("patientCountInput");
  if (input) input.value = patients.length;

  nurses.forEach(n => {
    n.patients = n.patients.filter(pt => pt.id !== id);
  });
  renderPatientList();
  renderAssignmentOutput();
  saveState();
}

function renderPatientList() {
  const container = document.getElementById("patientList");
  if (!container) return;
  container.innerHTML = "";

  patients.forEach(p => {
    const disabled = p.reviewed ? "disabled" : "";
    const reviewLabel = p.reviewed ? "Reviewed" : "Review";
    const reviewClass = p.reviewed ? "reviewBtn reviewed" : "reviewBtn";

    container.innerHTML += `
      <div class="patientRow">
        <button class="${reviewClass}" onclick="togglePatientReviewed(${p.id})">${reviewLabel}</button>

        <strong>Patient ${p.id}</strong>
        &nbsp;&nbsp;Room: 
        <input 
          type="text" 
          value="${p.room || ""}" 
          onchange="updatePatient(${p.id}, 'room', this.value)"
          ${disabled}
        >

        <label>
          <input type="checkbox" ${p.tele ? "checked" : ""} 
            onchange="updatePatient(${p.id}, 'tele', this.checked)" ${disabled}> Tele
        </label>
        <label>
          <input type="checkbox" ${p.drip ? "checked" : ""} 
            onchange="updatePatient(${p.id}, 'drip', this.checked)" ${disabled}> Drip
        </label>
        <label>
          <input type="checkbox" ${p.nih ? "checked" : ""} 
            onchange="updatePatient(${p.id}, 'nih', this.checked)" ${disabled}> NIH
        </label>
        <label>
          <input type="checkbox" ${p.bg ? "checked" : ""} 
            onchange="updatePatient(${p.id}, 'bg', this.checked)" ${disabled}> BG
        </label>
        <label>
          <input type="checkbox" ${p.ciwa ? "checked" : ""} 
            onchange="updatePatient(${p.id}, 'ciwa', this.checked)" ${disabled}> CIWA/COWS
        </label>
        <label>
          <input type="checkbox" ${p.restraint ? "checked" : ""} 
            onchange="updatePatient(${p.id}, 'restraint', this.checked)" ${disabled}> Restraint
        </label>
        <label>
          <input type="checkbox" ${p.sitter ? "checked" : ""} 
            onchange="updatePatient(${p.id}, 'sitter', this.checked)" ${disabled}> Sitter
        </label>
        <label>
          <input type="checkbox" ${p.vpo ? "checked" : ""} 
            onchange="updatePatient(${p.id}, 'vpo', this.checked)" ${disabled}> VPO
        </label>
        <label>
          <input type="checkbox" ${p.isolation ? "checked" : ""} 
            onchange="updatePatient(${p.id}, 'isolation', this.checked)" ${disabled}> Isolation
        </label>

        <button class="deleteBtn deleteRight" onclick="deletePatient(${p.id})">Remove</button>
      </div>
    `;
  });
}

// -------------------------
// Modals
// -------------------------
function showCapacityModal() {
  const modal = document.getElementById("capacityModal");
  if (modal) modal.style.display = "block";
}

function hideCapacityModal() {
  const modal = document.getElementById("capacityModal");
  if (modal) modal.style.display = "none";
}

function showAcuityReport() {
  const modal = document.getElementById("acuityModal");
  const body = document.getElementById("acuityReportBody");
  if (!modal || !body) return;

  const buckets = {
    NIH: [],
    Drips: [],
    BG: [],
    "CIWA/COWS": [],
    Restraints: [],
    Sitter: [],
    VPO: [],
    Isolation: []
  };

  patients.forEach(p => {
    const label = p.room ? `Room ${p.room}` : `Patient ${p.id}`;
    if (p.nih) buckets.NIH.push(label);
    if (p.drip) buckets.Drips.push(label);
    if (p.bg) buckets.BG.push(label);
    if (p.ciwa) buckets["CIWA/COWS"].push(label);
    if (p.restraint) buckets.Restraints.push(label);
    if (p.sitter) buckets.Sitter.push(label);
    if (p.vpo) buckets.VPO.push(label);
    if (p.isolation) buckets.Isolation.push(label);
  });

  const order = ["NIH", "Drips", "BG", "CIWA/COWS", "Restraints", "Sitter", "VPO", "Isolation"];

  let html = "";
  order.forEach(tag => {
    const list = buckets[tag];
    const text = list.length ? `${list.length}: ${list.join(", ")}` : "0";
    html += `
      <div class="acuity-line">
        <span class="acuity-label">${tag}:</span>
        <span class="acuity-value">${text}</span>
      </div>
    `;
  });

  body.innerHTML = html;
  modal.style.display = "block";
}

function hideAcuityModal() {
  const modal = document.getElementById("acuityModal");
  if (modal) modal.style.display = "none";
}

// -------------------------
// Demo Mode
// -------------------------
function loadDemoData() {
  nurses = [
    {
      id: 1,
      name: "Zac",
      type: "tele",
      restrictions: { noNih: true, noIso: false },
      maxPatients: 4,
      patients: []
    },
    {
      id: 2,
      name: "Donald",
      type: "tele",
      restrictions: { noNih: false, noIso: false },
      maxPatients: 4,
      patients: []
    },
    {
      id: 3,
      name: "Marki",
      type: "tele",
      restrictions: { noNih: false, noIso: false },
      maxPatients: 4,
      patients: []
    },
    {
      id: 4,
      name: "Dani",
      type: "tele",
      restrictions: { noNih: false, noIso: false },
      maxPatients: 4,
      patients: []
    }
  ];

  const nurseCountSelect = document.getElementById("nurseCount");
  if (nurseCountSelect) nurseCountSelect.value = nurses.length;
  renderNurseList();

  // Example PCAs
  pcas = [
    { id: 1, name: "PCA 1", restrictions: { noIso: false } },
    { id: 2, name: "PCA 2", restrictions: { noIso: false } },
    { id: 3, name: "PCA 3", restrictions: { noIso: false } }
  ];
  const pcaCountSelect = document.getElementById("pcaCount");
  if (pcaCountSelect) pcaCountSelect.value = pcas.length;
  renderPcaList();

  patients = [
    { ...makeEmptyPatient(1),  room: "1",  tele: true, drip: true },
    { ...makeEmptyPatient(2),  room: "2",  tele: true, nih: true },
    { ...makeEmptyPatient(3),  room: "3",  tele: true, bg: true },
    { ...makeEmptyPatient(4),  room: "4",  tele: true, ciwa: true },
    { ...makeEmptyPatient(5),  room: "5",  tele: true, sitter: true },
    { ...makeEmptyPatient(6),  room: "6",  tele: true, vpo: true },
    { ...makeEmptyPatient(7),  room: "7",  tele: true, isolation: true },
    { ...makeEmptyPatient(8),  room: "8",  tele: true, bg: true, ciwa: true },
    { ...makeEmptyPatient(9),  room: "9",  tele: true },
    { ...makeEmptyPatient(10), room: "10", tele: true, nih: true },
    { ...makeEmptyPatient(11), room: "11", tele: true, bg: true },
    { ...makeEmptyPatient(12), room: "12", tele: true, ciwa: true }
  ];
  patients.forEach((p, i) => (p.id = i + 1));

  const pInput = document.getElementById("patientCountInput");
  if (pInput) pInput.value = patients.length;
  renderPatientList();

  saveState();
}

// -------------------------
// Helper: parse room number
// -------------------------
function getRoomNumber(p) {
  if (!p.room) return Number.MAX_SAFE_INTEGER;
  const match = String(p.room).match(/\d+/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return parseInt(match[0], 10);
}

// -------------------------
// HARD RULE CHECKS
// -------------------------
function hasCapacity(nurse, patient) {
  const currentCount = nurse.patients.length;

  if (nurse.type === "tele") {
    return currentCount < 4;
  } else {
    if (currentCount < 4) return true;
    if (currentCount >= 5) return false;
    const allExistingMs = nurse.patients.every(pt => !pt.tele);
    const newIsMs = !patient.tele;
    return allExistingMs && newIsMs;
  }
}

function respectsNoNih(nurse, patient) {
  return !(n.restrictions && n.restrictions.noNih && patient.nih);
}

function respectsNoIso(nurse, patient) {
  return !(n.restrictions && n.restrictions.noIso && patient.isolation);
}

function canAssignTier1DripNih(nurse, patient) {
  let hasDrip = false;
  let hasNih = false;
  let hasCombo = false;

  nurse.patients.forEach(pt => {
    if (pt.drip) hasDrip = true;
    if (pt.nih) hasNih = true;
    if (pt.drip && pt.nih) hasCombo = true;
  });

  const newHasDrip = patient.drip;
  const newHasNih = patient.nih;
  const newHasAny = newHasDrip || newHasNih;
  const newHasCombo = newHasDrip && newHasNih;
  const nurseHasAny = hasDrip || hasNih;

  if (!nurseHasAny) return true;

  if (hasCombo) {
    if (newHasAny) return false;
    return true;
  }

  const currentType = hasDrip ? "drip" : "nih";

  if (!newHasAny) return true;
  if (newHasCombo) return false;

  const newType = newHasDrip ? "drip" : "nih";
  if (newType !== currentType) return false;

  return true;
}

function canAssignBG(nurse, patient) {
  let bgCount = 0;
  nurse.patients.forEach(pt => {
    if (pt.bg) bgCount++;
  });
  if (patient.bg) bgCount++;
  return bgCount <= 2;
}

function canAssignSitterVpo(nurse, patient) {
  let sitterVpoCount = 0;
  nurse.patients.forEach(pt => {
    if (pt.sitter || pt.vpo) sitterVpoCount++;
  });
  if (patient.sitter || patient.vpo) sitterVpoCount++;
  return sitterVpoCount <= 1;
}

function canAssign(nurse, patient) {
  if (!hasCapacity(nurse, patient)) return false;
  if (nurse.restrictions && nurse.restrictions.noNih && patient.nih) return false;
  if (nurse.restrictions && nurse.restrictions.noIso && patient.isolation) return false;
  if (!canAssignTier1DripNih(nurse, patient)) return false;
  if (!canAssignBG(nurse, patient)) return false;
  if (!canAssignSitterVpo(nurse, patient)) return false;
  return true;
}

// -------------------------
// Load & projected score for balancing
// -------------------------
function nurseLoad(nurse) {
  let count = nurse.patients.length;
  let bg = 0;
  let ciwa = 0;
  let restraint = 0;
  let iso = 0;
  let sitterVpo = 0;
  let tier1 = 0;

  nurse.patients.forEach(pt => {
    if (pt.bg) bg++;
    if (pt.ciwa) ciwa++;
    if (pt.restraint) restraint++;
    if (pt.isolation) iso++;
    if (pt.sitter || pt.vpo) sitterVpo++;
    if (pt.drip || pt.nih) tier1++;
  });

  let score = 0;
  score += count * 10;
  if (count > 4) score += (count - 4) * 50;
  score += bg * 8;
  score += sitterVpo * 12;
  score += ciwa * 6;
  score += restraint * 6;
  score += iso * 4;
  score += tier1 * 16;

  return score;
}

function projectedScore(nurse, patient, randomize) {
  const all = [...nurse.patients, patient];

  let count = all.length;
  let bg = 0;
  let ciwa = 0;
  let restraint = 0;
  let iso = 0;
  let sitterVpo = 0;
  let tier1 = 0;
  let nih = 0;

  all.forEach(pt => {
    if (pt.bg) bg++;
    if (pt.ciwa) ciwa++;
    if (pt.restraint) restraint++;
    if (pt.isolation) iso++;
    if (pt.sitter || pt.vpo) sitterVpo++;
    if (pt.drip || pt.nih) tier1++;
    if (pt.nih) nih++;
  });

  let score = 0;
  score += count * 10;
  if (count > 4) score += (count - 4) * 50;
  score += bg * 8;
  score += sitterVpo * 12;
  score += ciwa * 6;
  score += restraint * 6;
  score += iso * 4;
  score += tier1 * 16;

  if (nih >= 2) score += (nih - 1) * 25;
  if (ciwa >= 2) score += (ciwa - 1) * 18;

  score += roomPenalty(nurse, patient);
  score += Math.random() * (randomize ? 5 : 1);

  return score;
}

function roomPenalty(nurse, patient) {
  const r = getRoomNumber(patient);
  if (r === Number.MAX_SAFE_INTEGER) return 0;

  const existing = nurse.patients
    .map(getRoomNumber)
    .filter(v => v !== Number.MAX_SAFE_INTEGER);

  if (existing.length === 0) return 0;

  const minDist = Math.min(...existing.map(v => Math.abs(v - r)));
  return minDist / 2;
}

// -------------------------
// Assignment Engine
// -------------------------
function generateAssignment(randomize = false) {
  if (nurses.length === 0 || patients.length === 0) {
    alert("Please set up nurses and add at least one patient first.");
    return;
  }

  nurses.forEach(n => (n.patients = []));

  let patientOrder = [...patients].sort(
    (a, b) => getRoomNumber(a) - getRoomNumber(b)
  );

  if (randomize) {
    for (let i = patientOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [patientOrder[i], patientOrder[j]] = [patientOrder[j], patientOrder[i]];
    }
  }

  for (const patient of patientOrder) {
    // Tier 1: all rules
    let tier1 = nurses.filter(n => canAssign(n, patient));
    if (tier1.length > 0) {
      assignToBest(tier1, patient, randomize);
      continue;
    }

    // Tier 2: relax drip/NIH mixing only
    let tier2 = nurses.filter(n =>
      hasCapacity(n, patient) &&
      (!n.restrictions || !n.restrictions.noNih || !patient.nih) &&
      (!n.restrictions || !n.restrictions.noIso || !patient.isolation) &&
      canAssignBG(n, patient) &&
      canAssignSitterVpo(n, patient)
    );
    if (tier2.length > 0) {
      assignToBest(tier2, patient, randomize);
      continue;
    }

    // Tier 3: relax NoNih/NoIso (but keep capacity + BG + sitter)
    let tier3 = nurses.filter(n =>
      hasCapacity(n, patient) &&
      canAssignBG(n, patient) &&
      canAssignSitterVpo(n, patient)
    );
    if (tier3.length > 0) {
      assignToBest(tier3, patient, randomize);
      continue;
    }

    // Tier 4: last resort
    const sortedByLoad = [...nurses].sort(
      (a, b) => nurseLoad(a) - nurseLoad(b)
    );
    sortedByLoad[0].patients.push(patient);
  }

  renderAssignmentOutput();
}

// -------------------------
// Global Submit
// -------------------------
function submitAll() {
  saveState();
  if (nurses.length && patients.length) {
    generateAssignment(false);
  }
}

function assignToBest(candidateNurses, patient, randomize) {
  let bestNurse = candidateNurses[0];
  let bestScore = projectedScore(bestNurse, patient, randomize);

  for (const n of candidateNurses.slice(1)) {
    const score = projectedScore(n, patient, randomize);
    if (score < bestScore) {
      bestScore = score;
      bestNurse = n;
    }
  }

  bestNurse.patients.push(patient);
}

// -------------------------
// Tabs
// -------------------------
function showTab(sectionId, btn) {
  const sections = document.querySelectorAll(".tab-section");
  sections.forEach(sec => {
    sec.style.display = sec.id === sectionId ? "block" : "none";
  });

  const actions = document.getElementById("actions");
  if (actions) {
    if (sectionId === "results") {
      actions.classList.add("visible");
    } else {
      actions.classList.remove("visible");
    }
  }

  const tabs = document.querySelectorAll(".tabButton");
  tabs.forEach(t => t.classList.remove("active"));

  if (btn) {
    btn.classList.add("active");
  } else {
    tabs.forEach(t => {
      if (t.dataset.target === sectionId) {
        t.classList.add("active");
      }
    });
  }
}

// -------------------------
// Output
// -------------------------
function renderAssignmentOutput() {
  const container = document.getElementById("assignmentOutput");
  if (!container) return;
  container.innerHTML = "";

  nurses.forEach(n => {
    container.innerHTML += `
      <div class="nurseBlock">
        <h3>${n.name} (${n.type.toUpperCase()})</h3>
        <table>
          <tr>
            <th>Room</th>
            <th>Level</th>
            <th>Acuity Notes</th>
          </tr>
          ${
            n.patients
              .map(p => {
                const level = p.tele ? "Tele" : "MS";
                const notes =
                  [
                    p.drip && "Drip",
                    p.nih && "NIH",
                    p.bg && "BG",
                    p.ciwa && "CIWA/COWS",
                    p.restraint && "Restraint",
                    p.sitter && "Sitter",
                    p.vpo && "VPO",
                    p.isolation && "Isolation"
                  ]
                    .filter(Boolean)
                    .join(", ") || "-";

                return `
                <tr>
                  <td>${p.room || "(no room)"}</td>
                  <td>${level}</td>
                  <td>${notes}</td>
                </tr>
              `;
              })
              .join("")
          }
        </table>
      </div>
    `;
  });
}

// -------------------------
// Init on page load
// -------------------------
function initApp() {
  loadStateFromStorage();

  // Nurses
  if (!nurses.length) {
    const sel = document.getElementById("nurseCount");
    if (sel) sel.value = "4";
    setupNurses();
  } else {
    renderNurseList();
  }

  // PCAs
  if (!pcas.length) {
    const pSel = document.getElementById("pcaCount");
    if (pSel) pSel.value = "3";
    setupPcas();
  } else {
    renderPcaList();
    const pSel = document.getElementById("pcaCount");
    if (pSel) pSel.value = String(pcas.length);
  }

  // Patients
  const pInput = document.getElementById("patientCountInput");
  if (pInput && !patients.length) pInput.value = 0;
  if (patients.length) renderPatientList();

  // default tab: Staffing Details
  const firstTab = document.querySelector(".tabButton");
  if (firstTab) {
    const target = firstTab.dataset.target || "config";
    showTab(target, firstTab);
  }
}

window.addEventListener("load", initApp);
