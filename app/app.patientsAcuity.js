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
    const statusStyle = p.isEmpty ? "opacity:0.7;color:#b00020;font-weight:700;" : "opacity:0.9;color:#0a7a2f;font-weight:700;";
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
  if (p.chg) score += 2;
  if (p.foley) score += 3;
  if (p.q2turns) score += 4;
  if (p.heavy) score += 4;
  if (p.feeder) score += 2;
  return score;
}

function getNurseLoadScore(nurse) {
  return (nurse.patients || []).reduce((sum, id) => {
    const p = getPatientById(id);
    return sum + (p ? getPatientScore(p) : 0);
  }, 0);
}

function getPcaLoadScore(pca) {
  return (pca.patients || []).reduce((sum, id) => {
    const p = getPatientById(id);
    if (!p) return sum;
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
}

function getLoadClass(score) {
  if (score <= 25) return "load-good";
  if (score <= 55) return "load-medium";
  return "load-high";
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
window.rnTagString = rnTagString;
window.pcaTagString = pcaTagString;

window.updateAcuityTiles = updateAcuityTiles;
window.buildHighAcuityText = buildHighAcuityText;

window.openPatientProfileFromRoom = openPatientProfileFromRoom;
window.closePatientProfileModal = closePatientProfileModal;
window.savePatientProfile = savePatientProfile;
