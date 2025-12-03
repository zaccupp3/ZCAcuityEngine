// app/app.patientsAcuity.js
// Patient grid, acuity logic, scoring, high-risk tiles,
// oncoming assignment generator, and patient profile helpers.

// =========================
// Helpers
// =========================

function getPatientById(id) {
  return patients.find(p => p.id === id);
}

// Treat isEmpty as a USER/WORKFLOW state (bed empty vs occupied).
// We do NOT want to auto-flip isEmpty just because tags/gender are blank,
// because that breaks the discharge/admit lifecycle.
function recomputeIsEmpty(p) {
  // If bed is explicitly empty, always keep it empty.
  if (p.isEmpty) return;

  // If bed is not empty, we still allow “blank” patients (unknown gender/tags)
  // because they can exist as “occupied but not fully charted yet”.
  // So no automatic switching here.
}

function setBedEmptyState(patientId, makeEmpty) {
  const p = getPatientById(patientId);
  if (!p) return;

  if (makeEmpty) {
    // Clearing patient detail signals when bed becomes empty
    p.gender = "";
    p.tele = false;
    p.drip = false;
    p.nih = false;
    p.bg = false;
    p.ciwa = false;
    p.restraint = false;
    p.sitter = false;
    p.vpo = false;
    p.isolation = false;
    p.admit = false;
    p.lateDc = false;

    p.chg = false;
    p.foley = false;
    p.q2turns = false;
    p.heavy = false;
    p.feeder = false;

    p.reviewed = false;

    p.isEmpty = true;
    // Leaving recentlyDischarged as-is is fine; but if user manually empties,
    // it shouldn’t “stick” them as discharged. Clear it.
    p.recentlyDischarged = false;
  } else {
    // Mark occupied again (admit will fill in details later)
    p.isEmpty = false;
    p.recentlyDischarged = false;
  }

  if (typeof saveState === "function") saveState();
  if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
  if (typeof window.renderPatientList === "function") window.renderPatientList();
  if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
  if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
  if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
}

// =========================
// Patient grid (Patient Details tab)
// =========================

function changePatientGender(id, value) {
  const p = getPatientById(id);
  if (!p) return;

  // If bed is empty, don’t allow setting gender until it’s marked occupied
  if (p.isEmpty) {
    alert("This bed is marked EMPTY. Uncheck Empty Bed first to edit patient details.");
    renderPatientList();
    return;
  }

  if (value && !canSetGender(p, value)) {
    alert("Roommate has a different gender. Mixed-gender room not allowed for this bed.");
    renderPatientList();
    return;
  }

  p.gender = value;
  recomputeIsEmpty(p);
  saveState();

  updateAcuityTiles();
  renderPatientList();
  renderLiveAssignments();
  renderAssignmentOutput();
  renderPcaAssignmentOutput();
}

function togglePatientFlag(id, key, checked) {
  const p = getPatientById(id);
  if (!p) return;

  if (p.isEmpty) {
    alert("This bed is marked EMPTY. Uncheck Empty Bed first to edit patient tags.");
    renderPatientList();
    return;
  }

  p[key] = checked;
  recomputeIsEmpty(p);

  if (typeof window.renderPatientList === "function") window.renderPatientList();
  if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
  if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
  if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
  if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
  if (typeof saveState === "function") saveState();
}

function renderPatientList() {
  ensureDefaultPatients();
  const container = document.getElementById("patientList");
  if (!container) return;

  const sorted = [...patients].sort((a, b) => getRoomNumber(a) - getRoomNumber(b));

  let html = `
    <table>
      <thead>
        <tr>
          <th>Room</th>
          <th>Status</th>
          <th>Gender</th>
          <th>RN Tags</th>
          <th>PCA Tags</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const p of sorted) {
    const statusText = p.isEmpty ? "EMPTY" : "OCCUPIED";
    const statusStyle = p.isEmpty
      ? "opacity:0.7;color:#b00020;font-weight:700;"
      : "opacity:0.9;color:#0a7a2f;font-weight:700;";
    const disabledAttr = p.isEmpty ? "disabled" : "";

    html += `
      <tr ondblclick="openPatientProfileFromRoom(${p.id})">
        <td>${p.room || ""}</td>
        <td style="${statusStyle}">
          <label style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" ${p.isEmpty ? "checked" : ""} onchange="setBedEmptyState(${p.id}, this.checked)">
            ${statusText}
          </label>
        </td>
        <td>
          <select ${disabledAttr} onchange="changePatientGender(${p.id}, this.value)">
            <option value="" ${p.gender === "" ? "selected" : ""}>-</option>
            <option value="F" ${p.gender === "F" ? "selected" : ""}>F</option>
            <option value="M" ${p.gender === "M" ? "selected" : ""}>M</option>
            <option value="X" ${p.gender === "X" ? "selected" : ""}>X</option>
          </select>
        </td>
        <td>
          <label><input ${disabledAttr} type="checkbox" ${p.tele ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'tele', this.checked)"> Tele</label>
          <label><input ${disabledAttr} type="checkbox" ${p.drip ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'drip', this.checked)"> Drip</label>
          <label><input ${disabledAttr} type="checkbox" ${p.nih ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'nih', this.checked)"> NIH</label>
          <label><input ${disabledAttr} type="checkbox" ${p.bg ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'bg', this.checked)"> BG</label>
          <label><input ${disabledAttr} type="checkbox" ${p.ciwa ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'ciwa', this.checked)"> CIWA/COWS</label>
          <label><input ${disabledAttr} type="checkbox" ${p.restraint ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'restraint', this.checked)"> Restraint</label>
          <label><input ${disabledAttr} type="checkbox" ${p.sitter ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'sitter', this.checked)"> Sitter</label>
          <label><input ${disabledAttr} type="checkbox" ${p.vpo ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'vpo', this.checked)"> VPO</label>
          <label><input ${disabledAttr} type="checkbox" ${p.isolation ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'isolation', this.checked)"> ISO</label>
          <label><input ${disabledAttr} type="checkbox" ${p.admit ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'admit', this.checked)"> Admit</label>
          <label><input ${disabledAttr} type="checkbox" ${p.lateDc ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'lateDc', this.checked)"> Late DC</label>
        </td>
        <td>
          <label><input ${disabledAttr} type="checkbox" ${p.chg ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'chg', this.checked)"> CHG</label>
          <label><input ${disabledAttr} type="checkbox" ${p.foley ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'foley', this.checked)"> Foley</label>
          <label><input ${disabledAttr} type="checkbox" ${p.q2turns ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'q2turns', this.checked)"> Q2</label>
          <label><input ${disabledAttr} type="checkbox" ${p.heavy ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'heavy', this.checked)"> Heavy</label>
          <label><input ${disabledAttr} type="checkbox" ${p.feeder ? "checked" : ""} onchange="togglePatientFlag(${p.id}, 'feeder', this.checked)"> Feeder</label>
        </td>
      </tr>
    `;
  }

  html += "</tbody></table>";
  container.innerHTML = html;
}

// =========================
// Scoring & load helpers
// =========================

function getPatientScore(p) {
  let score = 0;
  if (p.tele) score += 2;
  if (p.drip) score += 6;
  if (p.nih) score += 4;
  if (p.bg) score += 2;
  if (p.ciwa) score += 4;
  if (p.restraint) score += 5;
  if (p.sitter) score += 5;
  if (p.vpo) score += 4;
  if (p.isolation) score += 3;
  if (p.admit) score += 4;
  if (p.lateDc) score += 2;

  // PCA tags below still contribute to overall patient “work” a bit on RN side
  if (p.chg) score += 2;
  if (p.foley) score += 3;
  if (p.q2turns) score += 4;
  if (p.heavy) score += 4;
  if (p.feeder) score += 2;
  return score;
}

// Adds “stacking” bumps at the ASSIGNMENT level (RN)
function computeRnStackingBonus(patientsInAssignment) {
  const pts = Array.isArray(patientsInAssignment) ? patientsInAssignment : [];
  if (!pts.length) return 0;

  let bg = 0, iso = 0, drip = 0, ciwa = 0, sitter = 0, vpo = 0;

  pts.forEach(p => {
    if (!p || p.isEmpty) return;
    if (p.bg) bg++;
    if (p.isolation) iso++;
    if (p.drip) drip++;
    if (p.ciwa) ciwa++;
    if (p.sitter) sitter++;
    if (p.vpo) vpo++;
  });

  let bonus = 0;

  // “Stacking” scenarios that should push Yellow/Red per charge reality
  if (bg >= 3) bonus += 4;
  if (iso >= 3) bonus += 4;
  if (drip >= 2) bonus += 6;

  // Combo multipliers
  if (ciwa >= 1 && sitter >= 1) bonus += 4;
  if (vpo >= 1 && ciwa >= 1) bonus += 3;

  return bonus;
}

// Adds “stacking” bumps at the ASSIGNMENT level (PCA)
function computePcaStackingBonus(patientsInAssignment) {
  const pts = Array.isArray(patientsInAssignment) ? patientsInAssignment : [];
  if (!pts.length) return 0;

  let heavy = 0, q2 = 0, iso = 0;

  pts.forEach(p => {
    if (!p || p.isEmpty) return;
    if (p.heavy) heavy++;
    if (p.q2turns) q2++;
    if (p.isolation) iso++;
  });

  let bonus = 0;

  if (heavy >= 2) bonus += 5;
  if (q2 >= 2) bonus += 4;
  if (iso >= 3) bonus += 4;

  if (heavy >= 1 && q2 >= 1) bonus += 3;

  return bonus;
}

function getNurseLoadScore(nurse) {
  const pts = (nurse.patients || [])
    .map(id => getPatientById(id))
    .filter(p => p && !p.isEmpty);

  const base = pts.reduce((sum, p) => sum + getPatientScore(p), 0);
  const bonus = computeRnStackingBonus(pts);

  return base + bonus;
}

function getPcaLoadScore(pca) {
  const pts = (pca.patients || [])
    .map(id => getPatientById(id))
    .filter(p => p && !p.isEmpty);

  const base = pts.reduce((sum, p) => {
    let score = 0;
    if (p.isolation) score += 3;
    if (p.admit) score += 3;
    if (p.lateDc) score += 2;
    if (p.chg) score += 3;
    if (p.foley) score += 3;
    if (p.q2turns) score += 4;
    if (p.heavy) score += 5;
    if (p.feeder) score += 3;
    return sum + score;
  }, 0);

  const bonus = computePcaStackingBonus(pts);

  return base + bonus;
}

// Role-aware thresholds so colors actually match reality
function getLoadClass(score, role = "nurse") {
  const s = Number(score) || 0;
  const r = String(role || "nurse").toLowerCase();

  // Tuned to your examples (Red should be uncommon, Yellow should appear when stacking)
  if (r === "pca") {
    if (s <= 12) return "load-good";
    if (s <= 18) return "load-medium";
    return "load-high";
  }

  // Default: RN thresholds
  if (s <= 14) return "load-good";
  if (s <= 23) return "load-medium";
  return "load-high";
}

// =========================
// Explainability (Drivers) helpers
// =========================

function fmtDriversFromCounts(order, counts) {
  const parts = [];
  order.forEach(k => {
    const v = counts[k] || 0;
    if (v > 0) parts.push(`${k}×${v}`);
  });
  return parts.join(", ");
}

// For RN cards: summarize key drivers across that RN’s assigned patient IDs.
function getRnDriversSummaryFromPatientIds(patientIds) {
  const ids = Array.isArray(patientIds) ? patientIds : [];
  const counts = {
    Drip: 0,
    CIWA: 0,
    Sitter: 0,
    Restraint: 0,
    VPO: 0,
    NIH: 0,
    BG: 0,
    ISO: 0,
    Admit: 0,
    "Late DC": 0
  };

  ids.forEach(id => {
    const p = getPatientById(id);
    if (!p || p.isEmpty) return;
    if (p.drip) counts.Drip++;
    if (p.ciwa) counts.CIWA++;
    if (p.sitter) counts.Sitter++;
    if (p.restraint) counts.Restraint++;
    if (p.vpo) counts.VPO++;
    if (p.nih) counts.NIH++;
    if (p.bg) counts.BG++;
    if (p.isolation) counts.ISO++;
    if (p.admit) counts.Admit++;
    if (p.lateDc) counts["Late DC"]++;
  });

  const order = ["Drip", "CIWA", "Sitter", "Restraint", "VPO", "NIH", "BG", "ISO", "Admit", "Late DC"];
  return fmtDriversFromCounts(order, counts);
}

// For PCA cards: summarize key drivers across that PCA’s assigned patient IDs.
function getPcaDriversSummaryFromPatientIds(patientIds) {
  const ids = Array.isArray(patientIds) ? patientIds : [];
  const counts = {
    Heavy: 0,
    Q2: 0,
    ISO: 0,
    CHG: 0,
    Foley: 0,
    Feeder: 0,
    Admit: 0,
    "Late DC": 0
  };

  ids.forEach(id => {
    const p = getPatientById(id);
    if (!p || p.isEmpty) return;
    if (p.heavy) counts.Heavy++;
    if (p.q2turns) counts.Q2++;
    if (p.isolation) counts.ISO++;
    if (p.chg) counts.CHG++;
    if (p.foley) counts.Foley++;
    if (p.feeder) counts.Feeder++;
    if (p.admit) counts.Admit++;
    if (p.lateDc) counts["Late DC"]++;
  });

  const order = ["Heavy", "Q2", "ISO", "CHG", "Foley", "Feeder", "Admit", "Late DC"];
  return fmtDriversFromCounts(order, counts);
}

function rnTagString(p) {
  const tags = [];
  if (p.ciwa) tags.push("CIWA/COWS");
  if (p.vpo) tags.push("VPO");
  if (p.nih) tags.push("NIH");
  if (p.bg) tags.push("BG");
  if (p.drip) tags.push("Drip");
  if (p.restraint) tags.push("Restraint");
  if (p.sitter) tags.push("Sitter");
  if (p.admit) tags.push("Admit");
  if (p.lateDc) tags.push("Late DC");
  if (p.isolation) tags.push("ISO");
  return tags.join(", ");
}

function pcaTagString(p) {
  const tags = [];
  if (p.isolation) tags.push("ISO");
  if (p.admit) tags.push("Admit");
  if (p.lateDc) tags.push("Late DC");
  if (p.chg) tags.push("CHG");
  if (p.foley) tags.push("Foley");
  if (p.q2turns) tags.push("Q2");
  if (p.heavy) tags.push("Heavy");
  if (p.feeder) tags.push("Feeder");
  return tags.join(", ");
}

// =========================
// High-risk tiles
// =========================

function updateAcuityTiles() {
  const tilesEl = document.getElementById("acuityTiles");
  if (!tilesEl) return;

  const active = patients.filter(p => !p.isEmpty);
  const makeCount = key => active.filter(p => p[key]).length;

  const config = [
    { id: "tele", label: "Tele", count: makeCount("tele") },
    { id: "drip", label: "Drips", count: makeCount("drip") },
    { id: "nih", label: "NIH", count: makeCount("nih") },
    { id: "bg", label: "BG Checks", count: makeCount("bg") },
    { id: "ciwa", label: "CIWA/COWS", count: makeCount("ciwa") },
    { id: "restraint", label: "Restraints", count: makeCount("restraint") },
    { id: "sitter", label: "Sitters", count: makeCount("sitter") },
    { id: "vpo", label: "VPO", count: makeCount("vpo") },
    { id: "isolation", label: "Isolation", count: makeCount("isolation") },
    { id: "admit", label: "Admits", count: makeCount("admit") },
    { id: "lateDc", label: "Late DC", count: makeCount("lateDc") },
    { id: "chg", label: "CHG", count: makeCount("chg") },
    { id: "foley", label: "Foley", count: makeCount("foley") },
    { id: "q2turns", label: "Q2 Turns", count: makeCount("q2turns") },
    { id: "heavy", label: "Heavy", count: makeCount("heavy") },
    { id: "feeder", label: "Feeders", count: makeCount("feeder") }
  ];

  tilesEl.innerHTML = config
    .map(t => `
      <div class="acuity-tile">
        <div class="acuity-tile-title">${t.label}</div>
        <div class="acuity-tile-count">${t.count}</div>
      </div>
    `)
    .join("");
}

function buildHighAcuityText() {
  const lines = [];
  patients.forEach(p => {
    if (p.isEmpty) return;
    const tags = [];
    if (p.drip) tags.push("Drip");
    if (p.nih) tags.push("NIH");
    if (p.ciwa) tags.push("CIWA/COWS");
    if (p.restraint) tags.push("Restraint");
    if (p.sitter) tags.push("Sitter");
    if (p.vpo) tags.push("VPO");
    if (p.isolation) tags.push("ISO");
    if (p.chg) tags.push("CHG");
    if (p.foley) tags.push("Foley");
    if (p.q2turns) tags.push("Q2");
    if (p.heavy) tags.push("Heavy");
    if (p.feeder) tags.push("Feeder");
    if (!tags.length) return;
    lines.push(`<div><strong>${p.room}</strong>: ${tags.join(", ")}</div>`);
  });

  if (!lines.length) return "<p>No high-risk patients flagged.</p>";
  return lines.join("");
}

// =========================
// Patient Profile Modal (local)
// =========================

let currentProfilePatientId = null;

function openPatientProfileFromRoom(patientId) {
  const p = getPatientById(patientId);
  if (!p) return;

  // If empty, quick prompt
  if (p.isEmpty) {
    alert("This bed is EMPTY. Uncheck Empty Bed on the Patient Details tab to admit/edit.");
    return;
  }

  currentProfilePatientId = patientId;

  const titleEl = document.getElementById("profileModalTitle");
  if (titleEl) titleEl.textContent = `Patient Profile – Room ${p.room || "?"}`;

  const gSel = document.getElementById("profGender");
  if (gSel) gSel.value = p.gender || "";

  // RN tags
  document.getElementById("profTele").checked = !!p.tele;
  document.getElementById("profDrip").checked = !!p.drip;
  document.getElementById("profNih").checked = !!p.nih;
  document.getElementById("profBg").checked = !!p.bg;
  document.getElementById("profCiwa").checked = !!p.ciwa;
  document.getElementById("profRestraint").checked = !!p.restraint;
  document.getElementById("profSitter").checked = !!p.sitter;
  document.getElementById("profVpo").checked = !!p.vpo;
  document.getElementById("profIso").checked = !!p.isolation;
  document.getElementById("profAdmit").checked = !!p.admit;
  document.getElementById("profLateDc").checked = !!p.lateDc;

  // PCA tags
  document.getElementById("profTelePca").checked = !!p.tele;
  document.getElementById("profIsoPca").checked = !!p.isolation;
  document.getElementById("profAdmitPca").checked = !!p.admit;
  document.getElementById("profLateDcPca").checked = !!p.lateDc;
  document.getElementById("profChg").checked = !!p.chg;
  document.getElementById("profFoley").checked = !!p.foley;
  document.getElementById("profQ2").checked = !!p.q2turns;
  document.getElementById("profHeavy").checked = !!p.heavy;
  document.getElementById("profFeeder").checked = !!p.feeder;

  const modal = document.getElementById("patientProfileModal");
  if (modal) modal.style.display = "block";
}

function closePatientProfileModal() {
  const modal = document.getElementById("patientProfileModal");
  if (modal) modal.style.display = "none";
  currentProfilePatientId = null;
}

function savePatientProfile() {
  if (currentProfilePatientId == null) return;

  const p = getPatientById(currentProfilePatientId);
  if (!p) {
    closePatientProfileModal();
    return;
  }

  // gender with roommate safety
  const gSel = document.getElementById("profGender");
  const newGender = gSel ? gSel.value : "";
  if (newGender && !canSetGender(p, newGender)) {
    alert("Roommate has a different gender. Mixed-gender room not allowed for this bed.");
    return;
  }
  p.gender = newGender || "";

  // RN tags
  p.tele = document.getElementById("profTele").checked;
  p.drip = document.getElementById("profDrip").checked;
  p.nih = document.getElementById("profNih").checked;
  p.bg = document.getElementById("profBg").checked;
  p.ciwa = document.getElementById("profCiwa").checked;
  p.restraint = document.getElementById("profRestraint").checked;
  p.sitter = document.getElementById("profSitter").checked;
  p.vpo = document.getElementById("profVpo").checked;
  p.isolation = document.getElementById("profIso").checked;
  p.admit = document.getElementById("profAdmit").checked;
  p.lateDc = document.getElementById("profLateDc").checked;

  // PCA tags
  p.chg = document.getElementById("profChg").checked;
  p.foley = document.getElementById("profFoley").checked;
  p.q2turns = document.getElementById("profQ2").checked;
  p.heavy = document.getElementById("profHeavy").checked;
  p.feeder = document.getElementById("profFeeder").checked;

  // profile save implies bed is occupied
  p.isEmpty = false;
  p.recentlyDischarged = false;

  recomputeIsEmpty(p);
  saveState();

  updateAcuityTiles();
  renderPatientList();
  renderLiveAssignments();
  renderAssignmentOutput();
  renderPcaAssignmentOutput();

  closePatientProfileModal();
}

// =========================
// Expose globals
// =========================

window.getPatientById = getPatientById;
window.recomputeIsEmpty = recomputeIsEmpty;
window.setBedEmptyState = setBedEmptyState;

window.changePatientGender = changePatientGender;
window.togglePatientFlag = togglePatientFlag;
window.renderPatientList = renderPatientList;

window.getPatientScore = getPatientScore;
window.getNurseLoadScore = getNurseLoadScore;
window.getPcaLoadScore = getPcaLoadScore;
window.getLoadClass = getLoadClass;

window.getRnDriversSummaryFromPatientIds = getRnDriversSummaryFromPatientIds;
window.getPcaDriversSummaryFromPatientIds = getPcaDriversSummaryFromPatientIds;

window.rnTagString = rnTagString;
window.pcaTagString = pcaTagString;

window.updateAcuityTiles = updateAcuityTiles;
window.buildHighAcuityText = buildHighAcuityText;

window.openPatientProfileFromRoom = openPatientProfileFromRoom;
window.closePatientProfileModal = closePatientProfileModal;
window.savePatientProfile = savePatientProfile;