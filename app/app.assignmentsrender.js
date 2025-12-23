// app/app.assignmentsrender.js
// ---------------------------------------------------------
// Rendering + generator for Oncoming (incoming) assignments ONLY
// Adds "Prev. RN / Prev. PCA" columns by referencing LIVE assignments.
//
// Adds:
// - 💡 Lightbulb icon (plain-language explanation per RN/PCA)
// - ! icon (yellow warning vs red violation) based on hard-rule checks
//
// NEW (Dec 2025):
// - RN Continuity Pin (📌) per patient row on ONCOMING RN table
// - Pinned patients stay with that RN across Populate/Rebalance.
// - UI: pin indicator appears ONLY when pinned;
//       unpinned rows show no icon (pin control appears on row hover).
//
// NEW (Dec 2025 - Fix):
// - Post-pass count balancer for Incoming RN assignments:
//   * aims for even counts (diff ≤ 1 when possible)
//   * NEVER breaks pins
//   * rejects moves that increase avoidable rule violations
// - Optional polish repair pass after balancing
//
// NEW (Dec 2025 - Fix #2):
// - Empty-owner drop zone:
//   If an RN/PCA has 0 patients, we render a single placeholder <tr>
//   so the tbody has real height and can accept drops.
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
// RN Continuity Pin helpers
// Stored on patient record for persistence via unit_state:
// - p.lockRnEnabled (bool)
// - p.lockRnTo (incoming nurse id)
// -----------------------------
function getPatientLockMeta(p) {
  if (!p || typeof p !== "object") return { enabled: false, rnId: null };
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

function toggleIncomingRnPin(patientId, incomingRnId) {
  const p = (typeof window.getPatientById === "function") ? window.getPatientById(patientId) : null;
  if (!p) return;

  const rnId = Number(incomingRnId);
  const meta = getPatientLockMeta(p);

  // toggle:
  // - if pinned to this RN -> unpin
  // - else pin to this RN
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

// Remove invalid pins (RN not on incoming roster)
function cleanupRnPinsAgainstRoster() {
  const roster = Array.isArray(window.incomingNurses) ? window.incomingNurses : [];
  const rosterIds = new Set(roster.map(n => Number(n.id)));

  const pts = Array.isArray(window.patients) ? window.patients : [];
  pts.forEach(p => {
    const meta = getPatientLockMeta(p);
    if (!meta.enabled) return;
    if (!rosterIds.has(meta.rnId)) {
      p.lockRnEnabled = false;
      p.lockRnTo = null;
    }
  });
}

// Pre-assign pinned patients before distributePatientsEvenly
function applyRnPinsBeforeDistribute(activePatients) {
  const roster = Array.isArray(window.incomingNurses) ? window.incomingNurses : [];
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
  // We want counts to be either base or base+1
  return { minTarget: base, maxTarget: base + (remainder > 0 ? 1 : 0) };
}

function getMovablePatientIdsFromOwner(owner, role) {
  const ids = Array.isArray(owner?.patients) ? owner.patients.slice() : [];
  if (role !== "nurse") return ids; // PCA pins later if desired

  // For nurses: pinned patients are NOT movable
  return ids.filter(pid => !isPatientPinnedToIncomingRn(pid, owner.id));
}

function tryMovePatient(owners, role, fromOwner, toOwner, patientId) {
  if (!fromOwner || !toOwner) return false;
  if (!Array.isArray(fromOwner.patients)) fromOwner.patients = [];
  if (!Array.isArray(toOwner.patients)) toOwner.patients = [];

  const idx = fromOwner.patients.indexOf(patientId);
  if (idx === -1) return false;

  // Never move pinned nurse patients
  if (role === "nurse" && isPatientPinnedToIncomingRn(patientId, fromOwner.id)) return false;

  fromOwner.patients.splice(idx, 1);
  if (!toOwner.patients.includes(patientId)) toOwner.patients.push(patientId);
  return true;
}

function balanceCountsWithoutCreatingNewAvoidableViolations(owners, role, opts = {}) {
  const maxPasses = typeof opts.maxPasses === "number" ? opts.maxPasses : 40;
  const list = Array.isArray(owners) ? owners : [];
  const n = list.length;
  if (n < 2) return { ok: true, changed: false };

  const activeCount =
    (Array.isArray(window.patients) ? window.patients : []).filter(p => p && !p.isEmpty).length;

  const { minTarget, maxTarget } = computeCountTargets(activeCount, n);

  let changed = false;
  let passes = 0;

  while (passes < maxPasses) {
    passes++;

    // find over + under
    const over = list
      .map(o => ({ o, c: (Array.isArray(o?.patients) ? o.patients.length : 0) }))
      .filter(x => x.c > maxTarget)
      .sort((a, b) => b.c - a.c);

    const under = list
      .map(o => ({ o, c: (Array.isArray(o?.patients) ? o.patients.length : 0) }))
      .filter(x => x.c < minTarget)
      .sort((a, b) => a.c - b.c);

    // If no strict under/over, we may still have diff > 1 due to pins.
    // Next: allow under to be < maxTarget and over > minTarget to shrink spread.
    let over2 = over;
    let under2 = under;

    if (!over2.length || !under2.length) {
      const counts = list.map(o => (Array.isArray(o?.patients) ? o.patients.length : 0));
      const spread = Math.max(...counts) - Math.min(...counts);
      if (spread <= 1) break;

      over2 = list
        .map(o => ({ o, c: (Array.isArray(o?.patients) ? o.patients.length : 0) }))
        .sort((a, b) => b.c - a.c);
      under2 = list
        .map(o => ({ o, c: (Array.isArray(o?.patients) ? o.patients.length : 0) }))
        .sort((a, b) => a.c - b.c);

      if (!over2.length || !under2.length) break;
    }

    const from = over2[0]?.o;
    const to = under2[0]?.o;
    if (!from || !to || from === to) break;

    const movable = getMovablePatientIdsFromOwner(from, role);
    if (!movable.length) {
      over2.shift();
      if (!over2.length) break;
      continue;
    }

    const baseViol = getAvoidableViolationCount(list, role);
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

      // revert
      from.patients = fromOrig;
      to.patients = toOrig;

      if (nextViol > baseViol) continue;

      const score = baseViol - nextViol;
      if (!best || score > best.score) {
        best = { pid, score, nextViol };
        if (score > 0) break;
      }
    }

    if (!best) break;

    const didApply = tryMovePatient(list, role, from, to, best.pid);
    if (!didApply) break;

    changed = true;
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

function getOwnerRuleEval(owner, ownersAll, role) {
  const map = safeGetRuleEvalMap(ownersAll, role);
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
    const explainText = safeGetPerOwnerExplain(nurse, allOwners, "nurse") || "";

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

    if (!pts.length) {
      // ✅ Keeps the drop target visible even when empty
      html += buildEmptyDropRow(4, "Drop a patient here to assign to this RN");
    }

    pts.forEach(p => {
      const prevName = getPrevRnNameForPatient(p.id);
      const bedLabel = getBedLabel(p);

      const pinned = isPatientPinnedToIncomingRn(p.id, nurse.id);
      const draggable = pinned ? "false" : "true";

      const pinControl = `
        <button
          type="button"
          aria-label="Pin patient to this RN"
          title="${pinned ? "Pinned to this RN (click to unpin)" : "Pin to this RN (preserve on regenerate)"}"
          onclick="window.toggleIncomingRnPin(${p.id}, ${nurse.id})"
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
          data-pinbtn="1"
        >📌</button>
      `;

      html += `
        <tr
          draggable="${draggable}"
          ondragstart="onRowDragStart(event, 'incoming', 'nurse', ${nurse.id}, ${p.id})"
          ondragend="onRowDragEnd(event)"
          ondblclick="openPatientProfileFromRoom(${p.id})"
          onmouseenter="(function(tr){var b=tr.querySelector('button[data-pinbtn]'); if(b && b.style.opacity==='0'){b.style.opacity='0.55'; b.style.pointerEvents='auto';}})(this)"
          onmouseleave="(function(tr){var b=tr.querySelector('button[data-pinbtn]'); if(b && !(${pinned})){b.style.opacity='0'; b.style.pointerEvents='none';}})(this)"
          style="${pinned ? "opacity:0.98;" : ""}"
        >
          <td>${bedLabel} ${pinControl}</td>
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
    const explainText = safeGetPerOwnerExplain(pca, allOwners, "pca") || "";

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

    if (!pts.length) {
      // ✅ Keeps the drop target visible even when empty
      html += buildEmptyDropRow(4, "Drop a patient here to assign to this PCA");
    }

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

  // Clear existing incoming lists
  incomingNurses.forEach(n => { n.patients = []; });
  incomingPcas.forEach(p => { p.patients = []; });

  cleanupRnPinsAgainstRoster();

  let list = activePatients.slice();
  if (randomize) list.sort(() => Math.random() - 0.5);
  else list.sort(safeSortPatientsForDisplay);

  // Pre-place pinned RN continuity, distribute remaining
  const { unlockedPool } = applyRnPinsBeforeDistribute(list);

  if (typeof window.distributePatientsEvenly === "function") {
    window.distributePatientsEvenly(incomingNurses, unlockedPool, { randomize, role: "nurse", preserveExisting: true });
    window.distributePatientsEvenly(incomingPcas, list, { randomize, role: "pca", preserveExisting: true });
  } else {
    alert("ERROR: distributePatientsEvenly is not loaded. Check script order + app.assignmentRules.js loading.");
    console.error("distributePatientsEvenly missing — check index.html script order and app.assignmentRules.js.");
    return;
  }

  // ✅ Post-pass: enforce even counts (without creating new avoidable violations)
  balanceCountsWithoutCreatingNewAvoidableViolations(window.incomingNurses, "nurse", { maxPasses: 60 });

  // ✅ Polish pass: try to eliminate avoidable violations after balancing
  if (typeof window.repairAssignmentsInPlace === "function") {
    window.repairAssignmentsInPlace(window.incomingNurses, "nurse");
    window.repairAssignmentsInPlace(window.incomingPcas, "pca");
  }

  renderAssignmentOutput();
  renderPcaAssignmentOutput();

  if (typeof saveState === "function") saveState();
  if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
}

function rebalanceOncomingAssignment() {
  if (typeof window.repairAssignmentsInPlace === "function") {
    try {
      cleanupRnPinsAgainstRoster();

      // Re-place pins onto correct RN (do not allow them to drift)
      const roster = Array.isArray(window.incomingNurses) ? window.incomingNurses : [];
      roster.forEach(rn => {
        rn.patients = Array.isArray(rn.patients) ? rn.patients : [];
        rn.patients = rn.patients.filter(pid => !isPatientPinnedToIncomingRn(pid, rn.id));
      });

      const active = (Array.isArray(window.patients) ? window.patients : []).filter(p => p && !p.isEmpty);
      applyRnPinsBeforeDistribute(active);
    } catch (e) {
      console.warn("[pins] pre-repair pin placement failed", e);
    }

    window.repairAssignmentsInPlace(window.incomingNurses, "nurse");
    window.repairAssignmentsInPlace(window.incomingPcas, "pca");

    balanceCountsWithoutCreatingNewAvoidableViolations(window.incomingNurses, "nurse", { maxPasses: 80 });

    window.repairAssignmentsInPlace(window.incomingNurses, "nurse");
    window.repairAssignmentsInPlace(window.incomingPcas, "pca");

    renderAssignmentOutput();
    renderPcaAssignmentOutput();

    if (typeof saveState === "function") saveState();
    if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
    return;
  }

  populateOncomingAssignment(false);
}

// Expose globally (CRITICAL for index.html onclick)
window.renderAssignmentOutput = renderAssignmentOutput;
window.renderPcaAssignmentOutput = renderPcaAssignmentOutput;
window.populateOncomingAssignment = populateOncomingAssignment;
window.rebalanceOncomingAssignment = rebalanceOncomingAssignment;

window.getPrevRnNameForPatient = getPrevRnNameForPatient;
window.getPrevPcaNameForPatient = getPrevPcaNameForPatient;