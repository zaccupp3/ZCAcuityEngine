// app/app.patientsAcuity.js
// ---------------------------------------------------------
// Patient grid (Patient Details tab), acuity logic, scoring,
// high-risk tiles, patient profile modal helpers.
//
// CANONICAL SOURCE OF TRUTH:
//   window.patients is an ARRAY of 32 patient objects with stable:
//     - id: 1..32
//     - room: "1".."32"
//   (Owned/initialized by app.state.js via ensureDefaultPatients())
// ---------------------------------------------------------

(function () {
  // =========================
  // Helpers (canonical)
  // =========================

  function safeArray(v) { return Array.isArray(v) ? v : []; }

  function ensurePatientsReady() {
    if (typeof window.ensureDefaultPatients === "function") {
      window.ensureDefaultPatients();
    }
    window.patients = safeArray(window.patients);

    // Hard guarantee: 32 slots, ids 1..32, room strings
    if (window.patients.length !== 32) {
      // If something went sideways, rebuild via state helper if possible
      if (typeof window.resetAllPatients === "function") {
        window.resetAllPatients();
      } else if (typeof window.ensureDefaultPatients === "function") {
        window.ensureDefaultPatients();
      }
    }
  }

  function getPatientById(id) {
    ensurePatientsReady();
    const num = Number(id);
    return safeArray(window.patients).find(p => p && Number(p.id) === num) || null;
  }

  function getPatientByRoom(roomNum) {
    ensurePatientsReady();
    const n = Number(roomNum);
    // Canonical mapping: room == id (string), but we support either match
    return (
      safeArray(window.patients).find(p => p && Number(p.id) === n) ||
      safeArray(window.patients).find(p => p && Number(String(p.room || "").match(/\d+/)?.[0]) === n) ||
      null
    );
  }

  // Treat isEmpty as a USER/WORKFLOW state (bed empty vs occupied).
  // We do NOT auto-flip isEmpty based on blank gender/tags.
  function recomputeIsEmpty(_p) {
    // no-op by design
  }

  function setBedEmptyState(patientId, makeEmpty) {
    const p = getPatientById(patientId);
    if (!p) return;

    if (makeEmpty) {
      // Clearing patient details when bed becomes empty
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
      p.recentlyDischarged = false;
    } else {
      p.isEmpty = false;
      p.recentlyDischarged = false;
    }

    if (typeof window.saveState === "function") window.saveState();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
  }

  // =========================
  // Gender safety helper (if you already have canSetGender elsewhere)
  // =========================
  function canSetGenderFallback(patient, newGender) {
    // If app already defines canSetGender, use it
    if (typeof window.canSetGender === "function") return window.canSetGender(patient, newGender);

    // Otherwise, do a conservative roommate check:
    // Rooms are paired (1&2, 3&4, ...). If roommate has a different gender, block.
    const roomNum = Number(patient?.room || patient?.id || 0);
    if (!roomNum || !newGender) return true;

    const mateRoom = (roomNum % 2 === 0) ? roomNum - 1 : roomNum + 1;
    const mate = getPatientByRoom(mateRoom);
    if (!mate || mate.isEmpty) return true;

    const mateGender = (mate.gender || "").trim();
    if (!mateGender) return true;

    return mateGender === newGender;
  }

  // =========================
  // Patient grid (Patient Details tab)
  // =========================

  function changePatientGender(id, value) {
    const p = getPatientById(id);
    if (!p) return;

    if (p.isEmpty) {
      alert("This bed is marked EMPTY. Uncheck Empty Bed first to edit patient details.");
      renderPatientList();
      return;
    }

    if (value && !canSetGenderFallback(p, value)) {
      alert("Roommate has a different gender. Mixed-gender room not allowed for this bed.");
      renderPatientList();
      return;
    }

    p.gender = value;
    recomputeIsEmpty(p);

    if (typeof window.saveState === "function") window.saveState();

    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
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

    if (typeof window.saveState === "function") window.saveState();
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
  }

  // Canonical Patient Details table renderer (32 rows, unique)
  function renderPatientList() {
    ensurePatientsReady();

    const host = document.getElementById("patientList");
    if (!host) return;

    // Build a stable, sorted list by id 1..32
    const rows = safeArray(window.patients)
      .slice()
      .sort((a, b) => Number(a?.id) - Number(b?.id))
      .slice(0, 32);

    host.innerHTML = `
      <div class="patient-table-wrap">
        <table class="patient-table">
          <thead>
            <tr>
              <th class="col-room">Room</th>
              <th>Status</th>
              <th>Gender</th>
              <th>RN Tags</th>
              <th>PCA Tags</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(p => {
              const roomLabel = String(p.room || p.id || "");
              const empty = !!p.isEmpty;

              return `
                <tr class="${empty ? "patient-row-empty" : ""}">
                  <td class="col-room">${roomLabel}</td>

                  <td>
                    <div class="status-toggle" role="group" aria-label="Room ${roomLabel} status">
                      <button
                        class="status-btn ${!empty ? "active" : ""}"
                        type="button"
                        onclick="window.setBedEmptyState(${p.id}, false)"
                      >In Use</button>
                      <button
                        class="status-btn empty ${empty ? "active" : ""}"
                        type="button"
                        onclick="window.setBedEmptyState(${p.id}, true)"
                      >Empty</button>
                    </div>
                  </td>

                  <td>
                    <select ${empty ? "disabled" : ""} onchange="window.changePatientGender(${p.id}, this.value)">
                      <option value="" ${(!p.gender) ? "selected" : ""}>-</option>
                      <option value="F" ${(p.gender==="F") ? "selected" : ""}>F</option>
                      <option value="M" ${(p.gender==="M") ? "selected" : ""}>M</option>
                      <option value="X" ${(p.gender==="X") ? "selected" : ""}>X</option>
                    </select>
                  </td>

                  <td>
                    <div class="tags-wrap">
                      ${rnTag(p, "tele", "Tele")}
                      ${rnTag(p, "drip", "Drip")}
                      ${rnTag(p, "nih", "NIH")}
                      ${rnTag(p, "bg", "BG")}
                      ${rnTag(p, "ciwa", "CIWA/COWS")}
                      ${rnTag(p, "restraint", "Restraint")}
                      ${rnTag(p, "sitter", "Sitter")}
                      ${rnTag(p, "vpo", "VPO")}
                      ${rnTag(p, "isolation", "ISO")}
                      ${rnTag(p, "admit", "Admit")}
                      ${rnTag(p, "lateDc", "Late DC")}
                    </div>
                  </td>

                  <td>
                    <div class="tags-wrap">
                      ${pcaTag(p, "tele", "Tele")} <!-- synced conceptually, stored on p.tele -->
                      ${pcaTag(p, "chg", "CHG")}
                      ${pcaTag(p, "foley", "Foley")}
                      ${pcaTag(p, "q2turns", "Q2")}
                      ${pcaTag(p, "heavy", "Heavy")}
                      ${pcaTag(p, "feeder", "Feeder")}
                      ${pcaTag(p, "isolation", "ISO")}
                      ${pcaTag(p, "admit", "Admit")}
                      ${pcaTag(p, "lateDc", "Late DC")}
                    </div>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;

    function rnTag(p, key, label) {
      const checked = !!p[key];
      const disabled = p.isEmpty ? "disabled" : "";
      return `
        <label>
          <input type="checkbox" ${disabled} ${checked ? "checked" : ""}
            onchange="window.togglePatientFlag(${p.id}, '${key}', this.checked)"
          />
          ${label}
        </label>
      `;
    }

    function pcaTag(p, key, label) {
      // Tele for PCA mirrors p.tele (single source of truth)
      const actualKey = (key === "tele") ? "tele" : key;
      const checked = !!p[actualKey];
      const disabled = p.isEmpty ? "disabled" : "";
      return `
        <label>
          <input type="checkbox" ${disabled} ${checked ? "checked" : ""}
            onchange="window.togglePatientFlag(${p.id}, '${actualKey}', this.checked)"
          />
          ${label}
        </label>
      `;
    }
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

  function computeRnStackingBonus(patientsInAssignment) {
    const pts = safeArray(patientsInAssignment);
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
    if (bg >= 3) bonus += 4;
    if (iso >= 3) bonus += 4;
    if (drip >= 2) bonus += 6;
    if (ciwa >= 1 && sitter >= 1) bonus += 4;
    if (vpo >= 1 && ciwa >= 1) bonus += 3;

    return bonus;
  }

  function computePcaStackingBonus(patientsInAssignment) {
    const pts = safeArray(patientsInAssignment);
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
    const pts = safeArray(nurse?.patients)
      .map(id => getPatientById(id))
      .filter(p => p && !p.isEmpty);

    const base = pts.reduce((sum, p) => sum + getPatientScore(p), 0);
    const bonus = computeRnStackingBonus(pts);
    return base + bonus;
  }

  function getPcaLoadScore(pca) {
    const pts = safeArray(pca?.patients)
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

  function getLoadClass(score, role = "nurse") {
    const s = Number(score) || 0;
    const r = String(role || "nurse").toLowerCase();

    if (r === "pca") {
      if (s <= 12) return "load-good";
      if (s <= 18) return "load-medium";
      return "load-high";
    }

    if (s <= 14) return "load-good";
    if (s <= 23) return "load-medium";
    return "load-high";
  }

  // =========================
  // Explainability (Drivers)
  // =========================

  function fmtDriversFromCounts(order, counts) {
    const parts = [];
    order.forEach(k => {
      const v = counts[k] || 0;
      if (v > 0) parts.push(`${k}×${v}`);
    });
    return parts.join(", ");
  }

  function getRnDriversSummaryFromPatientIds(patientIds) {
    const ids = safeArray(patientIds);
    const counts = { Drip:0, CIWA:0, Sitter:0, Restraint:0, VPO:0, NIH:0, BG:0, ISO:0, Admit:0, "Late DC":0 };

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

    const order = ["Drip","CIWA","Sitter","Restraint","VPO","NIH","BG","ISO","Admit","Late DC"];
    return fmtDriversFromCounts(order, counts);
  }

  function getPcaDriversSummaryFromPatientIds(patientIds) {
    const ids = safeArray(patientIds);
    const counts = { Heavy:0, Q2:0, ISO:0, CHG:0, Foley:0, Feeder:0, Admit:0, "Late DC":0 };

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

    const order = ["Heavy","Q2","ISO","CHG","Foley","Feeder","Admit","Late DC"];
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

  function normalizeRoomLabel(room) {
    return String(room ?? "").replace(/room\s*/i, "").trim();
  }

  function updateAcuityTiles() {
    ensurePatientsReady();

    const tilesEl = document.getElementById("acuityTiles");
    if (!tilesEl) return;

    const active = safeArray(window.patients).filter(p => p && !p.isEmpty);

    const config = [
      { id: "tele", label: "Tele", key: "tele" },
      { id: "drip", label: "Drips", key: "drip" },
      { id: "nih", label: "NIH", key: "nih" },
      { id: "bg", label: "BG Checks", key: "bg" },
      { id: "ciwa", label: "CIWA/COWS", key: "ciwa" },
      { id: "restraint", label: "Restraints", key: "restraint" },
      { id: "sitter", label: "Sitters", key: "sitter" },
      { id: "vpo", label: "VPO", key: "vpo" },
      { id: "isolation", label: "Isolation", key: "isolation" },
      { id: "admit", label: "Admits", key: "admit" },
      { id: "lateDc", label: "Late DC", key: "lateDc" },
      { id: "chg", label: "CHG", key: "chg" },
      { id: "foley", label: "Foley", key: "foley" },
      { id: "q2turns", label: "Q2 Turns", key: "q2turns" },
      { id: "heavy", label: "Heavy", key: "heavy" },
      { id: "feeder", label: "Feeders", key: "feeder" }
    ];

    const tiles = config.map(t => {
      const rooms = active
        .filter(p => !!p[t.key])
        .map(p => normalizeRoomLabel(p.room))
        .filter(Boolean);

      return { ...t, count: rooms.length, rooms };
    });

    tiles.sort((a, b) => (b.count !== a.count ? b.count - a.count : a.label.localeCompare(b.label)));

    tilesEl.innerHTML = tiles.map(t => {
      const roomsText = t.rooms.length ? t.rooms.join(", ") : "-";
      return `
        <div class="acuity-tile">
          <div class="acuity-tile-title">${t.label}</div>
          <div class="acuity-tile-count">${t.count}</div>
          <div class="acuity-tile-footer">Rooms: ${roomsText}</div>
        </div>
      `;
    }).join("");
  }

  function buildHighAcuityText() {
    ensurePatientsReady();

    const lines = [];
    safeArray(window.patients).forEach(p => {
      if (!p || p.isEmpty) return;

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

      lines.push(`<div><strong>${normalizeRoomLabel(p.room)}</strong>: ${tags.join(", ")}</div>`);
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

    if (p.isEmpty) {
      alert("This bed is EMPTY. Uncheck Empty Bed on the Patient Details tab to admit/edit.");
      return;
    }

    currentProfilePatientId = Number(patientId);

    const titleEl = document.getElementById("profileModalTitle");
    if (titleEl) titleEl.textContent = `Patient Profile – Room ${p.room || "?"}`;

    const gSel = document.getElementById("profGender");
    if (gSel) gSel.value = p.gender || "";

    // RN tags
    const setCheck = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

    setCheck("profTele", p.tele);
    setCheck("profDrip", p.drip);
    setCheck("profNih", p.nih);
    setCheck("profBg", p.bg);
    setCheck("profCiwa", p.ciwa);
    setCheck("profRestraint", p.restraint);
    setCheck("profSitter", p.sitter);
    setCheck("profVpo", p.vpo);
    setCheck("profIso", p.isolation);
    setCheck("profAdmit", p.admit);
    setCheck("profLateDc", p.lateDc);

    // PCA tags
    setCheck("profTelePca", p.tele);
    setCheck("profIsoPca", p.isolation);
    setCheck("profAdmitPca", p.admit);
    setCheck("profLateDcPca", p.lateDc);
    setCheck("profChg", p.chg);
    setCheck("profFoley", p.foley);
    setCheck("profQ2", p.q2turns);
    setCheck("profHeavy", p.heavy);
    setCheck("profFeeder", p.feeder);

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

    const gSel = document.getElementById("profGender");
    const newGender = gSel ? gSel.value : "";
    if (newGender && !canSetGenderFallback(p, newGender)) {
      alert("Roommate has a different gender. Mixed-gender room not allowed for this bed.");
      return;
    }
    p.gender = newGender || "";

    const getCheck = (id) => !!(document.getElementById(id) && document.getElementById(id).checked);

    p.tele = getCheck("profTele");
    p.drip = getCheck("profDrip");
    p.nih = getCheck("profNih");
    p.bg = getCheck("profBg");
    p.ciwa = getCheck("profCiwa");
    p.restraint = getCheck("profRestraint");
    p.sitter = getCheck("profSitter");
    p.vpo = getCheck("profVpo");
    p.isolation = getCheck("profIso");
    p.admit = getCheck("profAdmit");
    p.lateDc = getCheck("profLateDc");

    p.chg = getCheck("profChg");
    p.foley = getCheck("profFoley");
    p.q2turns = getCheck("profQ2");
    p.heavy = getCheck("profHeavy");
    p.feeder = getCheck("profFeeder");

    p.isEmpty = false;
    p.recentlyDischarged = false;

    recomputeIsEmpty(p);

    if (typeof window.saveState === "function") window.saveState();

    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();

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
})();