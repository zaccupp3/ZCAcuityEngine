// app/app.assignmentsrender.js
// ---------------------------------------------------------
// Rendering + generator for Oncoming (incoming) assignments ONLY
// Adds "Prev. RN / Prev. PCA" columns by referencing LIVE assignments.
//
// Adds:
// - 💡 Lightbulb icon (plain-language explanation per RN/PCA)
// - ! icon (yellow warning vs red violation) based on hard-rule checks
//   Hover shows WHICH rule(s) and counts (e.g., bg: 3 > 2)
// ---------------------------------------------------------

// -----------------------------
// Helpers: Previous owner lookups (from LIVE board)
// -----------------------------
function getPrevRnNameForPatient(patientId) {
  const pid = Number(patientId);
  if (!pid || !Array.isArray(window.currentNurses)) return "";

  const owner = window.currentNurses.find(n =>
    Array.isArray(n.patients) && n.patients.includes(pid)
  );

  return owner ? (owner.name || `RN ${owner.id}`) : "";
}

function getPrevPcaNameForPatient(patientId) {
  const pid = Number(patientId);
  if (!pid || !Array.isArray(window.currentPcas)) return "";

  const owner = window.currentPcas.find(p =>
    Array.isArray(p.patients) && p.patients.includes(pid)
  );

  return owner ? (owner.name || `PCA ${owner.id}`) : "";
}

function getUniquePrevRnCount(patientIds) {
  const set = new Set();
  (patientIds || []).forEach(pid => {
    const name = getPrevRnNameForPatient(pid);
    if (name) set.add(name);
  });
  return set.size;
}

function getUniquePrevPcaCount(patientIds) {
  const set = new Set();
  (patientIds || []).forEach(pid => {
    const name = getPrevPcaNameForPatient(pid);
    if (name) set.add(name);
  });
  return set.size;
}

// -----------------------------
// Room label helpers
// -----------------------------
function getBedLabel(p) {
  if (!p) return "";
  if (typeof window.getRoomLabelForPatient === "function") {
    return window.getRoomLabelForPatient(p);
  }
  return String(p.room || p.id || "");
}

function safeSortPatientsForDisplay(a, b) {
  const ga = (typeof window.getRoomNumber === "function") ? window.getRoomNumber(a) : 9999;
  const gb = (typeof window.getRoomNumber === "function") ? window.getRoomNumber(b) : 9999;
  if (ga !== gb) return ga - gb;
  return (Number(a?.id) || 0) - (Number(b?.id) || 0);
}

// -----------------------------
// Explanation + rule flag helpers
// -----------------------------
function safeGetPerOwnerExplain(owner, ownersAll, role) {
  try {
    if (window.explain && typeof window.explain.perOwner === "function") {
      // IMPORTANT: explain.perOwner returns a STRING in your app.explanations.js
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

function getOwnerRuleEval(owner, ownersAll, role) {
  const map = safeGetRuleEvalMap(ownersAll, role);
  if (!map) return null;

  const key = owner?.name || owner?.label || null;
  if (key && map[key]) return map[key];

  // fallback: try case-insensitive
  if (key) {
    const keys = Object.keys(map);
    const foundKey = keys.find(k => String(k).toLowerCase() === String(key).toLowerCase());
    if (foundKey) return map[foundKey];
  }

  // final fallback: try to find by index-ish key if engine used owner_#
  // (this is best-effort; usually name keys work)
  return null;
}

function buildRuleTooltip(ruleEval) {
  if (!ruleEval) return "";
  const v = Array.isArray(ruleEval.violations) ? ruleEval.violations : [];
  const w = Array.isArray(ruleEval.warnings) ? ruleEval.warnings : [];
  if (!v.length && !w.length) return "";

  const parts = [];
  v.forEach(x => parts.push(`❗ ${x.tag}: ${x.mine} > ${x.limit}`));
  w.forEach(x => parts.push(`⚠ ${x.tag}: ${x.mine} > ${x.limit} (may be unavoidable)`));
  return parts.join(" • ");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Simple popup for bulb (kept lightweight)
window.__openOwnerExplain = function (btnEl) {
  try {
    const text = btnEl?.getAttribute("data-explain") || btnEl?.title || "";
    if (!text) return;
    alert(text);
  } catch (e) {
    console.warn("__openOwnerExplain failed", e);
  }
};

// -----------------------------
// RN Oncoming Render
// -----------------------------
function renderAssignmentOutput() {
  const container = document.getElementById("assignmentOutput");
  if (!container) return;

  if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

  let html = "";

  const allOwners = Array.isArray(window.incomingNurses) ? window.incomingNurses : [];

  incomingNurses.forEach(nurse => {
    const pts = (nurse.patients || [])
      .map(pid => getPatientById(pid))
      .filter(p => p && !p.isEmpty)
      .sort(safeSortPatientsForDisplay);

    const loadScore = (typeof getNurseLoadScore === "function") ? getNurseLoadScore(nurse) : 0;
    const loadClass = (typeof getLoadClass === "function") ? getLoadClass(loadScore, "nurse") : "";

    const drivers = (typeof window.getRnDriversSummaryFromPatientIds === "function")
      ? window.getRnDriversSummaryFromPatientIds(nurse.patients || [])
      : "";

    const reportSources = getUniquePrevRnCount(nurse.patients || []);

    // ✅ Explanation is a STRING
    const explainText = safeGetPerOwnerExplain(nurse, allOwners, "nurse") || "";

    // ✅ Always use robust lookup for rule eval
    const ruleEval = getOwnerRuleEval(nurse, allOwners, "nurse");
    const vCount = ruleEval?.violations?.length || 0;
    const wCount = ruleEval?.warnings?.length || 0;
    const ruleTip = buildRuleTooltip(ruleEval);

    html += `
      <div class="assignment-card ${loadClass}">
        <div class="assignment-header">
          <div style="display:flex;align-items:flex-start;gap:10px;">
            <div>
              <strong>${nurse.name}</strong> (${(nurse.type || "").toUpperCase()})
              ${drivers ? `<div style="font-size:12px;opacity:0.75;margin-top:2px;"><strong>Drivers:</strong> ${drivers}</div>` : ""}
              <div style="font-size:12px;opacity:0.75;margin-top:2px;"><strong>Report sources:</strong> ${reportSources}</div>
            </div>

            <div class="icon-row">
              <button class="icon-btn icon-bulb" type="button"
                data-explain="${escapeHtml(explainText || "Quick take: trying to keep big acuity tags spread out and keep your report sources as low as possible.")}"
                title="Quick explanation"
                onclick="window.__openOwnerExplain(this)">💡</button>

              ${
                (vCount || wCount)
                  ? `<button class="icon-btn ${vCount ? "flag-bad" : "flag-warn"}" type="button"
                      title="${escapeHtml(ruleTip || "Rule flag(s) present")}">!</button>`
                  : ``
              }
            </div>
          </div>

          <div>Patients: ${pts.length} | Load Score: ${loadScore}</div>
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

    pts.forEach(p => {
      const prevName = getPrevRnNameForPatient(p.id);
      const bedLabel = getBedLabel(p);

      html += `
        <tr
          draggable="true"
          ondragstart="onRowDragStart(event, 'incoming', 'nurse', ${nurse.id}, ${p.id})"
          ondragend="onRowDragEnd(event)"
          ondblclick="openPatientProfileFromRoom(${p.id})"
        >
          <td>${bedLabel}</td>
          <td>${p.tele ? "Tele" : "MS"}</td>
          <td>${rnTagString(p)}</td>
          <td>${prevName || "-"}</td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>
      </div>
    `;
  });

  container.innerHTML = html;
}

// -----------------------------
// PCA Oncoming Render
// -----------------------------
function renderPcaAssignmentOutput() {
  const container = document.getElementById("pcaAssignmentOutput");
  if (!container) return;

  if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

  let html = "";

  const allOwners = Array.isArray(window.incomingPcas) ? window.incomingPcas : [];

  incomingPcas.forEach(pca => {
    const pts = (pca.patients || [])
      .map(pid => getPatientById(pid))
      .filter(p => p && !p.isEmpty)
      .sort(safeSortPatientsForDisplay);

    const loadScore = (typeof getPcaLoadScore === "function") ? getPcaLoadScore(pca) : 0;
    const loadClass = (typeof getLoadClass === "function") ? getLoadClass(loadScore, "pca") : "";

    const drivers = (typeof window.getPcaDriversSummaryFromPatientIds === "function")
      ? window.getPcaDriversSummaryFromPatientIds(pca.patients || [])
      : "";

    const reportSources = getUniquePrevPcaCount(pca.patients || []);

    // ✅ Explanation is a STRING
    const explainText = safeGetPerOwnerExplain(pca, allOwners, "pca") || "";

    // ✅ Always use robust lookup for rule eval
    const ruleEval = getOwnerRuleEval(pca, allOwners, "pca");
    const vCount = ruleEval?.violations?.length || 0;
    const wCount = ruleEval?.warnings?.length || 0;
    const ruleTip = buildRuleTooltip(ruleEval);

    html += `
      <div class="assignment-card ${loadClass}">
        <div class="assignment-header">
          <div style="display:flex;align-items:flex-start;gap:10px;">
            <div>
              <strong>${pca.name}</strong> (PCA)
              ${drivers ? `<div style="font-size:12px;opacity:0.75;margin-top:2px;"><strong>Drivers:</strong> ${drivers}</div>` : ""}
              <div style="font-size:12px;opacity:0.75;margin-top:2px;"><strong>Report sources:</strong> ${reportSources}</div>
            </div>

            <div class="icon-row">
              <button class="icon-btn icon-bulb" type="button"
                data-explain="${escapeHtml(explainText || "Quick take: trying to keep CHG/foley/Q2/heavy/feeders spread evenly, and avoid stacking ISO/admit/late DC when we can.")}"
                title="Quick explanation"
                onclick="window.__openOwnerExplain(this)">💡</button>

              ${
                (vCount || wCount)
                  ? `<button class="icon-btn ${vCount ? "flag-bad" : "flag-warn"}" type="button"
                      title="${escapeHtml(ruleTip || "Rule flag(s) present")}">!</button>`
                  : ``
              }
            </div>
          </div>

          <div>Patients: ${pts.length} | Load Score: ${loadScore}</div>
        </div>

        <table class="assignment-table">
          <thead>
            <tr>
              <th>Bed</th>
              <th>Level</th>
              <th>Acuity Notes</th>
              <th>Prev. PCA</th>
            </tr>
          </thead>
          <tbody
            ondragover="onRowDragOver(event)"
            ondrop="onRowDrop(event, 'incoming', 'pca', ${pca.id})"
          >
    `;

    pts.forEach(p => {
      const prevName = getPrevPcaNameForPatient(p.id);
      const bedLabel = getBedLabel(p);

      html += `
        <tr
          draggable="true"
          ondragstart="onRowDragStart(event, 'incoming', 'pca', ${pca.id}, ${p.id})"
          ondragend="onRowDragEnd(event)"
          ondblclick="openPatientProfileFromRoom(${p.id})"
        >
          <td>${bedLabel}</td>
          <td>${p.tele ? "Tele" : "MS"}</td>
          <td>${pcaTagString(p)}</td>
          <td>${prevName || "-"}</td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>
      </div>
    `;
  });

  container.innerHTML = html;
}

// -----------------------------
// Generator (Oncoming populate + rebalance)
// -----------------------------
function populateOncomingAssignment(randomize = false) {
  if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

  if (!incomingNurses.length || !incomingPcas.length) {
    alert("Please set up ONCOMING RNs and PCAs on the Staffing Details tab first.");
    return;
  }

  const activePatients = patients.filter(p => !p.isEmpty);
  if (!activePatients.length) {
    alert("No active patients found.");
    return;
  }

  incomingNurses.forEach(n => { n.patients = []; });
  incomingPcas.forEach(p => { p.patients = []; });

  let list = activePatients.slice();
  if (randomize) list.sort(() => Math.random() - 0.5);
  else list.sort(safeSortPatientsForDisplay);

  if (typeof window.distributePatientsEvenly === "function") {
    window.distributePatientsEvenly(incomingNurses, list, { randomize, role: "nurse" });
    window.distributePatientsEvenly(incomingPcas, list, { randomize, role: "pca" });
  } else {
    alert("ERROR: distributePatientsEvenly is not loaded. Oncoming assignment would have used round-robin fallback, so generation is blocked. Check script order + app.assignmentRules.js loading.");
    console.error("distributePatientsEvenly missing — check index.html script order and app.assignmentRules.js.");
    return;
  }

  renderAssignmentOutput();
  renderPcaAssignmentOutput();

  if (typeof saveState === "function") saveState();
  if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
}

function rebalanceOncomingAssignment() {
  // NEW: in-place repair (safety + acuity first, then churn, then walking)
  if (typeof window.repairAssignmentsInPlace === "function") {
    window.repairAssignmentsInPlace(window.incomingNurses, "nurse");
    window.repairAssignmentsInPlace(window.incomingPcas, "pca");

    renderAssignmentOutput();
    renderPcaAssignmentOutput();

    if (typeof saveState === "function") saveState();
    if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
    return;
  }

  // Fallback (old behavior)
  populateOncomingAssignment(false);
}

// Expose globally
window.renderAssignmentOutput = renderAssignmentOutput;
window.renderPcaAssignmentOutput = renderPcaAssignmentOutput;
window.populateOncomingAssignment = populateOncomingAssignment;
window.rebalanceOncomingAssignment = rebalanceOncomingAssignment;

window.getPrevRnNameForPatient = getPrevRnNameForPatient;
window.getPrevPcaNameForPatient = getPrevPcaNameForPatient;