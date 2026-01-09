// app/app.patientsAcuity.js
// ---------------------------------------------------------
// Patient grid (Patient Details tab), acuity logic, scoring,
// high-risk tiles, patient profile modal helpers.
//
// ✅ UPDATED (Jan 2026 - Staff Attribution v2):
// - ACUITY_CHANGED events include RN/PCA attribution derived from current assignment
// - Payload now includes: rnId, pcaId, rnStaffId, pcaStaffId, rnName, pcaName, attribution{...}
// - Supports "role impact" flags so analytics can count RN vs PCA effects properly
// - TELE remains a shared single-source-of-truth tag
//
// ✅ UPDATED (Jan 2026 - Role-Specific TELE Scoring v1):
// - TELE has near-zero impact on RN workflow → RN load score ignores TELE
// - TELE has meaningful PCA impact (q4 vitals / workflow volume) → PCA load includes TELE weight
// - UI formatting remains unchanged; this is scoring-only
// ---------------------------------------------------------

(function () {
  // =========================
  // Helpers (canonical)
  // =========================

  function safeArray(v) { return Array.isArray(v) ? v : []; }

  // Version marker for debugging
  window.__patientsAcuityLoaded = "v2_staff_attribution_2026-01-02__role_tele_scoring_2026-01-08";

  function ensurePatientsReady() {
    if (typeof window.ensureDefaultPatients === "function") {
      window.ensureDefaultPatients();
    }
    window.patients = safeArray(window.patients);

    if (window.patients.length !== 32) {
      if (typeof window.resetAllPatients === "function") {
        window.resetAllPatients();
      } else if (typeof window.ensureDefaultPatients === "function") {
        window.ensureDefaultPatients();
      }
    }

    applyRoomSchemaToPatients();
  }

  function getPatientById(id) {
    ensurePatientsReady();
    const num = Number(id);
    return safeArray(window.patients).find(p => p && Number(p.id) === num) || null;
  }

  function getPatientByRoom(roomNum) {
    ensurePatientsReady();
    const n = Number(roomNum);
    return (
      safeArray(window.patients).find(p => p && Number(p.id) === n) ||
      safeArray(window.patients).find(p => p && Number(String(p.room || "").match(/\d+/)?.[0]) === n) ||
      null
    );
  }

  // =========================
  // Assignment lookup (RN/PCA)
  // =========================

  function findAssignedNurse(patientId) {
    // Prefer canonical helpers if they exist
    if (typeof window.findAssignedNurse === "function") {
      try { return window.findAssignedNurse(patientId); } catch {}
    }

    const pid = Number(patientId);
    const nurses = safeArray(window.currentNurses);
    return nurses.find(n => safeArray(n?.patients).includes(pid)) || null;
  }

  function findAssignedPca(patientId) {
    if (typeof window.findAssignedPca === "function") {
      try { return window.findAssignedPca(patientId); } catch {}
    }

    const pid = Number(patientId);
    const pcas = safeArray(window.currentPcas);
    return pcas.find(p => safeArray(p?.patients).includes(pid)) || null;
  }

  function getAssignmentContextForPatient(patientId) {
    const rn = findAssignedNurse(patientId);
    const pca = findAssignedPca(patientId);

    return {
      rnId: rn ? Number(rn.id) : null,
      pcaId: pca ? Number(pca.id) : null,
      rnStaffId: rn ? (rn.staff_id ?? null) : null,
      pcaStaffId: pca ? (pca.staff_id ?? null) : null,
      rnName: rn ? (rn.name || "") : "",
      pcaName: pca ? (pca.name || "") : ""
    };
  }

  // Expose helper (useful for console debugging)
  window.getAssignmentContextForPatient = window.getAssignmentContextForPatient || getAssignmentContextForPatient;

  // =========================
  // Tag impact mapping (RN vs PCA vs Shared)
  // =========================

  const RN_ONLY_KEYS = new Set(["drip","nih","bg","ciwa","restraint","sitter","vpo"]);
  const PCA_ONLY_KEYS = new Set(["chg","foley","q2turns","heavy","feeder"]);
  const SHARED_KEYS = new Set(["tele","isolation","admit","lateDc"]); // shared meaning: affects both RN/PCA analytics

  // Gender isn't really PCA workload; treat as RN-side attribution by default
  const RN_META_KEYS = new Set(["gender"]);

  function computeImpactFromChanges(changes) {
    const list = safeArray(changes);
    let affectsRn = false;
    let affectsPca = false;

    list.forEach(c => {
      const k = String(c?.key || "");
      if (!k) return;

      if (SHARED_KEYS.has(k)) { affectsRn = true; affectsPca = true; return; }
      if (RN_ONLY_KEYS.has(k) || RN_META_KEYS.has(k)) affectsRn = true;
      if (PCA_ONLY_KEYS.has(k)) affectsPca = true;
    });

    return { affectsRn, affectsPca };
  }

  // =========================
  // Event logging helpers (with attribution)
  // =========================

  function appendWithAttribution(type, payload, meta) {
    if (typeof window.appendEvent !== "function") return;

    try {
      const p = payload && typeof payload === "object" ? { ...payload } : { value: payload };

      // Attach attribution if patientId is present
      const pid = (p.patientId != null ? Number(p.patientId) : null);
      if (pid) {
        const ctx = getAssignmentContextForPatient(pid);

        // Determine which roles this change should count toward
        const impact = computeImpactFromChanges(p.changes);

        // Always include ids so schema is stable (even if null)
        p.rnId = ctx.rnId;
        p.pcaId = ctx.pcaId;
        p.rnStaffId = ctx.rnStaffId;
        p.pcaStaffId = ctx.pcaStaffId;
        p.rnName = ctx.rnName;
        p.pcaName = ctx.pcaName;

        // Nested object for analytics friendliness
        p.attribution = {
          affects: impact,
          rn: impact.affectsRn ? { id: ctx.rnId, staff_id: ctx.rnStaffId, name: ctx.rnName } : null,
          pca: impact.affectsPca ? { id: ctx.pcaId, staff_id: ctx.pcaStaffId, name: ctx.pcaName } : null
        };
      }

      // Always pass meta with version/source so you can debug load order
      const nextMeta = Object.assign({ v: 2, source: "app.patientsAcuity.js" }, (meta || {}));
      window.appendEvent(type, p, nextMeta);
    } catch (e) {
      console.warn("[events] appendEvent failed", e);
    }
  }

  function logAcuityChange(patient, key, beforeVal, afterVal, source) {
    if (!patient) return;
    if (beforeVal === afterVal) return;

    appendWithAttribution("ACUITY_CHANGED", {
      patientId: Number(patient.id),
      bed: String(patient.room || patient.id || ""),
      changes: [{ key, before: beforeVal, after: afterVal }],
      source: source || "patient_details"
    });
  }

  function logBulkAcuityChanges(patient, changes, source) {
    if (!patient) return;
    const list = safeArray(changes).filter(Boolean);
    if (!list.length) return;

    appendWithAttribution("ACUITY_CHANGED", {
      patientId: Number(patient.id),
      bed: String(patient.room || patient.id || ""),
      changes: list,
      source: source || "patient_profile"
    });
  }

  function logBedStateChange(patient, beforeEmpty, afterEmpty, source) {
    if (!patient) return;
    if (beforeEmpty === afterEmpty) return;

    appendWithAttribution("BED_STATE_CHANGED", {
      patientId: Number(patient.id),
      bed: String(patient.room || patient.id || ""),
      changes: [{ key: "isEmpty", before: !!beforeEmpty, after: !!afterEmpty }],
      source: source || "patient_details"
    });
  }

  // =========================
  // Room Schema Mapping (NEW)
  // =========================

  function getRoomSchemaBeds() {
    const beds = window.unitSettings?.room_schema?.beds;
    if (!Array.isArray(beds) || !beds.length) return null;
    return beds.map(b => String(b).trim()).filter(Boolean);
  }

  function applyRoomSchemaToPatients() {
    const beds = getRoomSchemaBeds();
    if (!beds) return;

    const pArr = safeArray(window.patients).slice().sort((a, b) => Number(a?.id) - Number(b?.id));

    for (let i = 0; i < 32; i++) {
      const p = pArr[i];
      if (!p) continue;

      const label = beds[i] || String(p.id);
      p.roomIndex = Number(p.id);
      p.room = label;
    }

    window.patients = pArr;
  }

  function getRoomLabelForPatient(p) {
    if (!p) return "";
    return String(p.room || p.id || "");
  }

  function getRoommateId(patientId) {
    const id = Number(patientId);
    if (!id || id < 1) return null;
    return (id % 2 === 0) ? (id - 1) : (id + 1);
  }

  function recomputeIsEmpty(_p) {
    // no-op by design
  }

  function setBedEmptyState(patientId, makeEmpty) {
    const p = getPatientById(patientId);
    if (!p) return;

    const beforeEmpty = !!p.isEmpty;

    if (makeEmpty) {
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

    const afterEmpty = !!p.isEmpty;
    logBedStateChange(p, beforeEmpty, afterEmpty, "patient_details");

    if (typeof window.saveState === "function") window.saveState();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
  }

  // =========================
  // Gender safety helper
  // =========================
  function canSetGenderFallback(patient, newGender) {
    if (typeof window.canSetGender === "function") return window.canSetGender(patient, newGender);

    const roomIndex = Number(patient?.roomIndex || patient?.id || 0);
    if (!roomIndex || !newGender) return true;

    const mateId = getRoommateId(roomIndex);
    if (!mateId) return true;

    const mate = getPatientById(mateId);
    if (!mate || mate.isEmpty) return true;

    const mateGender = (mate.gender || "").trim();
    if (!mateGender) return true;

    return mateGender === newGender;
  }

  // =========================
  // Patient grid handlers
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

    const before = p.gender || "";
    p.gender = value;
    recomputeIsEmpty(p);

    logAcuityChange(p, "gender", before, p.gender || "", "patient_details");

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

    const before = !!p[key];

    // TELE is intentionally shared single-source-of-truth.
    // (If any UI toggles Tele, it just sets p.tele)
    p[key] = checked;

    recomputeIsEmpty(p);

    logAcuityChange(p, String(key), before, !!checked, "patient_details");

    if (typeof window.saveState === "function") window.saveState();
    if (typeof window.renderPatientList === "function") window.renderPatientList();
    if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
  }

  // =========================
  // Patient Details table renderer
  // =========================

  function renderPatientList() {
    ensurePatientsReady();

    const host = document.getElementById("patientList");
    if (!host) return;

    const rows = safeArray(window.patients)
      .slice()
      .sort((a, b) => Number(a?.id) - Number(b?.id))
      .slice(0, 32);

    host.innerHTML = `
      <div class="patient-table-wrap">
        <table class="patient-table">
          <thead>
            <tr>
              <th class="col-room">Bed</th>
              <th>Status</th>
              <th>Gender</th>
              <th>RN Tags</th>
              <th>PCA Tags</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(p => {
              const roomLabel = getRoomLabelForPatient(p);
              const empty = !!p.isEmpty;

              return `
                <tr class="${empty ? "patient-row-empty" : ""}">
                  <td class="col-room">${roomLabel}</td>

                  <td>
                    <div class="status-toggle" role="group" aria-label="Bed ${roomLabel} status">
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
                      ${pcaTag(p, "tele", "Tele")}
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

  // Role-specific weights (centralized so we don't scatter magic numbers)
  const TELE_WEIGHT_RN = 0;  // Tele has minimal RN workflow impact in your unit practice
  const TELE_WEIGHT_PCA = 3; // Tele adds recurring workload (e.g., q4 vitals) for PCAs

  // Keep the original patient score available for any other consumers that might rely on it.
  // Note: This remains a "generic acuity-ish" score.
  function getPatientScore(p) {
    let score = 0;
    if (p.tele) score += 2;
    if (p.drip) score += 6;
    if (p.nih) score += 4;
    if (p.bg) score += 2;
    if (p.ciwa) score += 4;
    if (p.restraint) score += 6;
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

  // RN-specific patient score used for RN load scoring (Tele intentionally de-emphasized)
  function getRnPatientScore(p) {
    let score = 0;

    // TELE: role-specific
    if (p.tele) score += TELE_WEIGHT_RN;

    // RN drivers
    if (p.drip) score += 6;
    if (p.nih) score += 4;
    if (p.bg) score += 2;
    if (p.ciwa) score += 4;
    if (p.restraint) score += 6;
    if (p.sitter) score += 5;
    if (p.vpo) score += 4;
    if (p.isolation) score += 3;
    if (p.admit) score += 4;
    if (p.lateDc) score += 2;

    // NOTE: RN load intentionally does not include PCA-only drivers (chg/foley/q2/heavy/feeder)
    // (They can exist as tags, but RN workflow score here stays RN-centered.)

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

    // RN load score uses RN-specific scoring (Tele weight = 0)
    const base = pts.reduce((sum, p) => sum + getRnPatientScore(p), 0);
    const bonus = computeRnStackingBonus(pts);
    return base + bonus;
  }

  function getPcaLoadScore(pca) {
    const pts = safeArray(pca?.patients)
      .map(id => getPatientById(id))
      .filter(p => p && !p.isEmpty);

    const base = pts.reduce((sum, p) => {
      let score = 0;

      // TELE: role-specific (meaningful for PCA)
      if (p.tele) score += TELE_WEIGHT_PCA;

      // PCA drivers
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
  // Explainability + High-risk tiles (unchanged)
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

    // ✅ Tele added to explainability drivers for PCA since it now impacts PCA load
    const counts = { Tele:0, Heavy:0, Q2:0, ISO:0, CHG:0, Foley:0, Feeder:0, Admit:0, "Late DC":0 };

    ids.forEach(id => {
      const p = getPatientById(id);
      if (!p || p.isEmpty) return;
      if (p.tele) counts.Tele++;
      if (p.heavy) counts.Heavy++;
      if (p.q2turns) counts.Q2++;
      if (p.isolation) counts.ISO++;
      if (p.chg) counts.CHG++;
      if (p.foley) counts.Foley++;
      if (p.feeder) counts.Feeder++;
      if (p.admit) counts.Admit++;
      if (p.lateDc) counts["Late DC"]++;
    });

    const order = ["Tele","Heavy","Q2","ISO","CHG","Foley","Feeder","Admit","Late DC"];
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
    if (p.tele) tags.push("Tele");
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
        .map(p => normalizeRoomLabel(getRoomLabelForPatient(p)))
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
          <div class="acuity-tile-footer">Beds: ${roomsText}</div>
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

      lines.push(`<div><strong>${normalizeRoomLabel(getRoomLabelForPatient(p))}</strong>: ${tags.join(", ")}</div>`);
    });

    if (!lines.length) return "<p>No high-risk patients flagged.</p>";
    return lines.join("");
  }

  // =========================
  // Patient Profile Modal (same UX as your current file)
  // =========================

  let currentProfilePatientId = null;

  function ensureLegacyProfileModalUpgraded() {
    const modal = document.getElementById("patientProfileModal");
    if (!modal) return null;

    modal.classList.add("pp-overlay");
    modal.style.display = "none";

    let card = modal.querySelector(".pp-card");
    if (!card) {
      modal.innerHTML = `
        <div class="pp-card" role="dialog" aria-modal="true">
          <div class="pp-header" id="ppHeader">
            <div class="pp-title" id="profileModalTitle">Patient Profile</div>
            <button class="pp-close" type="button" id="ppCloseBtn">×</button>
          </div>
          <div class="pp-body" id="ppBody"></div>
        </div>
      `;
      card = modal.querySelector(".pp-card");
    }

    const closeBtn = modal.querySelector("#ppCloseBtn");
    if (closeBtn && !closeBtn.__wired) {
      closeBtn.__wired = true;
      closeBtn.addEventListener("click", closePatientProfileModal);
    }

    if (!modal.__wiredOutsideClose) {
      modal.__wiredOutsideClose = true;
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closePatientProfileModal();
      });
    }

    if (!window.__ppEscWired) {
      window.__ppEscWired = true;
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closePatientProfileModal();
      });
    }

    makeDraggable(modal.querySelector(".pp-card"), modal.querySelector(".pp-header"));
    return modal;
  }

  function centerLegacyModal(modal) {
    const card = modal?.querySelector(".pp-card");
    if (!card) return;

    card.style.left = "50%";
    card.style.top = "50%";
    card.style.transform = "translate(-50%, -50%)";
  }

  function makeDraggable(cardEl, handleEl) {
    if (!cardEl || !handleEl || handleEl.__dragWired) return;
    handleEl.__dragWired = true;

    let dragging = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    handleEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
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

    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  function openPatientProfileFromRoom(patientId) {
    const p = getPatientById(patientId);
    if (!p) return;

    if (p.isEmpty) {
      alert("This bed is EMPTY. Uncheck Empty Bed on the Patient Details tab to admit/edit.");
      return;
    }

    currentProfilePatientId = Number(patientId);

    const modal = ensureLegacyProfileModalUpgraded();
    if (!modal) {
      alert("Missing patient profile modal container (#patientProfileModal).");
      return;
    }

    const titleEl = modal.querySelector("#profileModalTitle");
    const bodyEl = modal.querySelector("#ppBody");

    if (titleEl) titleEl.textContent = `Patient Profile — Bed ${getRoomLabelForPatient(p) || "?"}`;

    function item(id, label, checked) {
      return `
        <label class="pp-tag">
          <input type="checkbox" id="${id}" ${checked ? "checked" : ""}/>
          <span>${label}</span>
        </label>
      `;
    }

    const rnItems = [
      ["profTele", "Tele", !!p.tele],
      ["profDrip", "Drip", !!p.drip],
      ["profNih", "NIH", !!p.nih],
      ["profBg", "BG", !!(p.bg || p.bgChecks)],
      ["profCiwa", "CIWA/COWS", !!(p.ciwa || p.cows || p.ciwaCows)],
      ["profRestraint", "Restraint", !!(p.restraint || p.restraints)],
      ["profSitter", "Sitter", !!p.sitter],
      ["profVpo", "VPO", !!p.vpo],
      ["profIso", "Isolation", !!(p.isolation || p.iso)],
      ["profAdmit", "Admit", !!p.admit],
      ["profLateDc", "Late DC", !!(p.lateDc || p.lateDC || p.latedc)],
    ];

    const pcaItems = [
      ["profTelePca", "Tele", !!p.tele],
      ["profIsoPca", "Isolation", !!(p.isolation || p.iso)],
      ["profAdmitPca", "Admit", !!p.admit],
      ["profLateDcPca", "Late DC", !!(p.lateDc || p.lateDC || p.latedc)],
      ["profChg", "CHG", !!p.chg],
      ["profFoley", "Foley", !!p.foley],
      ["profQ2", "Q2 Turns", !!(p.q2turns || p.q2Turns)],
      ["profHeavy", "Heavy", !!p.heavy],
      ["profFeeder", "Feeder", !!(p.feeder || p.feeders)],
    ];

    if (bodyEl) {
      bodyEl.innerHTML = `
        <div class="pp-row">
          <div class="pp-label">Gender:</div>
          <select id="profGender">
            <option value="" ${!p.gender ? "selected" : ""}>-</option>
            <option value="M" ${p.gender === "M" ? "selected" : ""}>M</option>
            <option value="F" ${p.gender === "F" ? "selected" : ""}>F</option>
            <option value="X" ${p.gender === "X" ? "selected" : ""}>X</option>
          </select>
        </div>

        <div class="pp-grid">
          <div class="pp-col">
            <h4>RN Acuity Tags</h4>
            <div class="pp-taglist">
              ${rnItems.map(x => item(x[0], x[1], x[2])).join("")}
            </div>
          </div>

          <div class="pp-col">
            <h4>PCA Acuity Tags</h4>
            <div class="pp-taglist">
              ${pcaItems.map(x => item(x[0], x[1], x[2])).join("")}
            </div>
          </div>
        </div>

        <div class="pp-actions">
          <button class="btn" type="button" id="ppCancelBtn">Cancel</button>
          <button class="btn btn-primary" type="button" id="ppSaveBtn">Save</button>
        </div>
      `;
    }

    const cancelBtn = modal.querySelector("#ppCancelBtn");
    if (cancelBtn) cancelBtn.onclick = closePatientProfileModal;

    const saveBtn = modal.querySelector("#ppSaveBtn");
    if (saveBtn) saveBtn.onclick = savePatientProfile;

    modal.style.display = "flex";
    centerLegacyModal(modal);
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

    const before = {
      gender: p.gender || "",
      tele: !!p.tele, drip: !!p.drip, nih: !!p.nih, bg: !!p.bg,
      ciwa: !!p.ciwa, restraint: !!p.restraint, sitter: !!p.sitter, vpo: !!p.vpo,
      isolation: !!p.isolation, admit: !!p.admit, lateDc: !!p.lateDc,
      chg: !!p.chg, foley: !!p.foley, q2turns: !!p.q2turns, heavy: !!p.heavy, feeder: !!p.feeder
    };

    const gSel = document.getElementById("profGender");
    const newGender = gSel ? gSel.value : "";
    if (newGender && !canSetGenderFallback(p, newGender)) {
      alert("Roommate has a different gender. Mixed-gender room not allowed for this bed.");
      return;
    }
    p.gender = newGender || "";

    const getCheck = (id) => {
      const el = document.getElementById(id);
      return !!(el && el.checked);
    };

    // Shared/Tele is single-source-of-truth:
    p.tele = getCheck("profTele") || getCheck("profTelePca");

    // RN-only
    p.drip = getCheck("profDrip");
    p.nih = getCheck("profNih");
    p.bg = getCheck("profBg");
    p.bgChecks = p.bg;

    p.ciwa = getCheck("profCiwa");
    p.cows = p.ciwa;
    p.ciwaCows = p.ciwa;

    p.restraint = getCheck("profRestraint");
    p.sitter = getCheck("profSitter");
    p.vpo = getCheck("profVpo");

    // Shared
    p.isolation = getCheck("profIso") || getCheck("profIsoPca");
    p.iso = p.isolation;

    p.admit = getCheck("profAdmit") || getCheck("profAdmitPca");
    p.lateDc = getCheck("profLateDc") || getCheck("profLateDcPca");

    // PCA-only
    p.chg = getCheck("profChg");
    p.foley = getCheck("profFoley");
    p.q2turns = getCheck("profQ2");
    p.q2Turns = p.q2turns;
    p.heavy = getCheck("profHeavy");
    p.feeder = getCheck("profFeeder");

    p.isEmpty = false;
    p.recentlyDischarged = false;

    recomputeIsEmpty(p);

    const after = {
      gender: p.gender || "",
      tele: !!p.tele, drip: !!p.drip, nih: !!p.nih, bg: !!p.bg,
      ciwa: !!p.ciwa, restraint: !!p.restraint, sitter: !!p.sitter, vpo: !!p.vpo,
      isolation: !!p.isolation, admit: !!p.admit, lateDc: !!p.lateDc,
      chg: !!p.chg, foley: !!p.foley, q2turns: !!p.q2turns, heavy: !!p.heavy, feeder: !!p.feeder
    };

    const changes = [];
    Object.keys(after).forEach(k => {
      if (before[k] !== after[k]) changes.push({ key: k, before: before[k], after: after[k] });
    });

    logBulkAcuityChanges(p, changes, "patient_profile");

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
  window.getPatientByRoom = getPatientByRoom;

  window.applyRoomSchemaToPatients = applyRoomSchemaToPatients;
  window.getRoomLabelForPatient = getRoomLabelForPatient;

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