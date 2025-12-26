// app/app.staffing.js
// Handles RN/PCA staffing for "Staffing Details" tab
// and keeps current/incoming arrays in sync with the UI.
//
// IMPORTANT:
// - app.state.js owns the core arrays and exposes live getters/setters on window.
// - Do NOT reinitialize window.currentNurses/currentPcas/etc in this file.
// - Just read/write currentNurses/currentPcas/incomingNurses/incomingPcas/pcaShift directly.
// - CRITICAL FIX: whenever we mutate/replace arrays, we ALSO mirror them back onto window.*
//   so saveState() persists the true source of truth.
//
// ✅ NEW (Dec 2025):
// - Staff directory typeahead (unit_staff)
// - Autocomplete suggestions for RN/PCA name fields
// - Auto-create staff record on name commit (blur/change)
// - Roles are STRICT: "RN" or "PCA"
//
// ✅ NEW (THIS UPDATE):
// - Persist staff_id onto each RN/PCA object (n.staff_id / p.staff_id)
// - Name onchange now passes the INPUT element so we can read dataset.staffId
//   from app.staffTypeahead.js selections.

(function () {
  // Use the canonical restriction helper from app.state.js if present
  const getDefaultRestrictions =
    (typeof window.defaultRestrictions === "function")
      ? window.defaultRestrictions
      : function defaultRestrictionsFallback(oldRestriction) {
          // keep your old fallback behavior
          return { noNih: oldRestriction === "noNih", noIso: false };
        };

  function syncWindowRefs() {
    // Keep window.* synchronized with legacy bare globals
    window.currentNurses = currentNurses;
    window.incomingNurses = incomingNurses;
    window.currentPcas = currentPcas;
    window.incomingPcas = incomingPcas;
    window.pcaShift = pcaShift;
  }

  // -------------------------
  // RN SETUP – CURRENT / INCOMING
  // -------------------------

  window.setupCurrentNurses = function () {
    const sel = document.getElementById("currentNurseCount");
    let count = parseInt(sel && sel.value, 10);
    if (isNaN(count) || count < 1) count = 1;
    if (count > 8) count = 8;
    if (sel) sel.value = count;

    const old = Array.isArray(currentNurses) ? currentNurses : [];
    const next = [];

    for (let i = 0; i < count; i++) {
      const prev = old[i];
      const prevRestrictions = prev?.restrictions || getDefaultRestrictions(prev?.restriction);
      const type = prev?.type || "tele";
      next.push({
        id: i + 1,
        staff_id: prev?.staff_id || null,
        name: prev?.name || `Current RN ${i + 1}`,
        type,
        restrictions: {
          noNih: !!prevRestrictions.noNih,
          noIso: !!prevRestrictions.noIso
        },
        maxPatients: type === "tele" ? 4 : 5,
        patients: Array.isArray(prev?.patients) ? prev.patients.slice() : []
      });
    }

    currentNurses = next;
    syncWindowRefs();

    window.renderCurrentNurseList();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.setupIncomingNurses = function () {
    const sel = document.getElementById("incomingNurseCount");
    let count = parseInt(sel && sel.value, 10);
    if (isNaN(count) || count < 1) count = 1;
    if (count > 8) count = 8;
    if (sel) sel.value = count;

    const old = Array.isArray(incomingNurses) ? incomingNurses : [];
    const next = [];

    for (let i = 0; i < count; i++) {
      const prev = old[i];
      const prevRestrictions = prev?.restrictions || getDefaultRestrictions(prev?.restriction);
      const type = prev?.type || "tele";
      next.push({
        id: i + 1,
        staff_id: prev?.staff_id || null,
        name: prev?.name || `Incoming RN ${i + 1}`,
        type,
        restrictions: {
          noNih: !!prevRestrictions.noNih,
          noIso: !!prevRestrictions.noIso
        },
        maxPatients: type === "tele" ? 4 : 5,
        patients: Array.isArray(prev?.patients) ? prev.patients.slice() : []
      });
    }

    incomingNurses = next;
    syncWindowRefs();

    window.renderIncomingNurseList();
    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.renderCurrentNurseList = function () {
    const container = document.getElementById("currentNurseList");
    if (!container) return;
    container.innerHTML = "";

    (Array.isArray(currentNurses) ? currentNurses : []).forEach((n, index) => {
      const r = n.restrictions || getDefaultRestrictions();
      container.innerHTML += `
        <div class="nurseRow">
          <label>
            Name:
            <input type="text"
                   data-staff-role="RN"
                   value="${(n.name || "").replace(/"/g, "&quot;")}"
                   onchange="updateCurrentNurseName(${index}, this)">
          </label>
          <label>
            Type:
            <select onchange="updateCurrentNurseType(${index}, this.value)">
              <option value="tele" ${n.type === "tele" ? "selected" : ""}>Tele (max 4)</option>
              <option value="ms" ${n.type === "ms" ? "selected" : ""}>Med-Surg (max 5)</option>
            </select>
          </label>

          <div class="restrictionsGroup">
            <span>Restrictions:</span>
            <label class="restrictionOption">
              <input type="checkbox" ${r.noNih ? "checked" : ""}
                     onchange="updateCurrentNurseRestriction(${index}, 'noNih', this.checked)"> No NIH
            </label>
            <label class="restrictionOption">
              <input type="checkbox" ${r.noIso ? "checked" : ""}
                     onchange="updateCurrentNurseRestriction(${index}, 'noIso', this.checked)"> No ISO
            </label>
          </div>
        </div>
      `;
    });
  };

  window.renderIncomingNurseList = function () {
    const container = document.getElementById("incomingNurseList");
    if (!container) return;
    container.innerHTML = "";

    (Array.isArray(incomingNurses) ? incomingNurses : []).forEach((n, index) => {
      const r = n.restrictions || getDefaultRestrictions();
      container.innerHTML += `
        <div class="nurseRow">
          <label>
            Name:
            <input type="text"
                   data-staff-role="RN"
                   value="${(n.name || "").replace(/"/g, "&quot;")}"
                   onchange="updateIncomingNurseName(${index}, this)">
          </label>
          <label>
            Type:
            <select onchange="updateIncomingNurseType(${index}, this.value)">
              <option value="tele" ${n.type === "tele" ? "selected" : ""}>Tele (max 4)</option>
              <option value="ms" ${n.type === "ms" ? "selected" : ""}>Med-Surg (max 5)</option>
            </select>
          </label>

          <div class="restrictionsGroup">
            <span>Restrictions:</span>
            <label class="restrictionOption">
              <input type="checkbox" ${r.noNih ? "checked" : ""}
                     onchange="updateIncomingNurseRestriction(${index}, 'noNih', this.checked)"> No NIH
            </label>
            <label class="restrictionOption">
              <input type="checkbox" ${r.noIso ? "checked" : ""}
                     onchange="updateIncomingNurseRestriction(${index}, 'noIso', this.checked)"> No ISO
            </label>
          </div>
        </div>
      `;
    });
  };

  // -------------------------
  // RN UPDATE HELPERS
  // -------------------------

  window.updateCurrentNurseType = function (index, value) {
    const n = currentNurses && currentNurses[index];
    if (!n) return;
    n.type = value;
    n.maxPatients = value === "tele" ? 4 : 5;

    syncWindowRefs();

    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingNurseType = function (index, value) {
    const n = incomingNurses && incomingNurses[index];
    if (!n) return;
    n.type = value;
    n.maxPatients = value === "tele" ? 4 : 5;

    syncWindowRefs();

    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  // ✅ Updated to accept input element OR raw string
  window.updateCurrentNurseName = function (index, elOrValue) {
    const n = currentNurses && currentNurses[index];
    if (!n) return;

    const el = (elOrValue && typeof elOrValue === "object") ? elOrValue : null;
    const value = el ? el.value : elOrValue;

    n.name = String(value || "").trim() || `Current RN ${index + 1}`;
    n.staff_id = el ? (String(el.dataset.staffId || "").trim() || null) : (n.staff_id || null);

    syncWindowRefs();

    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  // ✅ Updated to accept input element OR raw string
  window.updateIncomingNurseName = function (index, elOrValue) {
    const n = incomingNurses && incomingNurses[index];
    if (!n) return;

    const el = (elOrValue && typeof elOrValue === "object") ? elOrValue : null;
    const value = el ? el.value : elOrValue;

    n.name = String(value || "").trim() || `Incoming RN ${index + 1}`;
    n.staff_id = el ? (String(el.dataset.staffId || "").trim() || null) : (n.staff_id || null);

    syncWindowRefs();

    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateCurrentNurseRestriction = function (index, key, checked) {
    const n = currentNurses && currentNurses[index];
    if (!n) return;
    if (!n.restrictions) n.restrictions = getDefaultRestrictions();
    n.restrictions[key] = !!checked;

    syncWindowRefs();

    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingNurseRestriction = function (index, key, checked) {
    const n = incomingNurses && incomingNurses[index];
    if (!n) return;
    if (!n.restrictions) n.restrictions = getDefaultRestrictions();
    n.restrictions[key] = !!checked;

    syncWindowRefs();

    if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  // -------------------------
  // PCA SETUP – CURRENT / INCOMING
  // -------------------------

  window.updatePcaShift = function (value) {
    pcaShift = value === "night" ? "night" : "day";
    const max = pcaShift === "day" ? 8 : 9;

    (Array.isArray(currentPcas) ? currentPcas : []).forEach(p => (p.maxPatients = max));
    (Array.isArray(incomingPcas) ? incomingPcas : []).forEach(p => (p.maxPatients = max));

    syncWindowRefs();

    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.setupCurrentPcas = function () {
    const sel = document.getElementById("currentPcaCount");
    let count = parseInt(sel && sel.value, 10);
    if (isNaN(count) || count < 1) count = 1;
    if (count > 6) count = 6;
    if (sel) sel.value = count;

    const old = Array.isArray(currentPcas) ? currentPcas : [];
    const max = pcaShift === "day" ? 8 : 9;
    const next = [];

    for (let i = 0; i < count; i++) {
      const prev = old[i];
      next.push({
        id: i + 1,
        staff_id: prev?.staff_id || null,
        name: prev?.name || `Current PCA ${i + 1}`,
        restrictions: { noIso: !!(prev && prev.restrictions && prev.restrictions.noIso) },
        maxPatients: max,
        patients: Array.isArray(prev?.patients) ? prev.patients.slice() : []
      });
    }

    currentPcas = next;
    syncWindowRefs();

    window.renderCurrentPcaList();
    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.setupIncomingPcas = function () {
    const sel = document.getElementById("incomingPcaCount");
    let count = parseInt(sel && sel.value, 10);
    if (isNaN(count) || count < 1) count = 1;
    if (count > 6) count = 6;
    if (sel) sel.value = count;

    const old = Array.isArray(incomingPcas) ? incomingPcas : [];
    const max = pcaShift === "day" ? 8 : 9;
    const next = [];

    for (let i = 0; i < count; i++) {
      const prev = old[i];
      next.push({
        id: i + 1,
        staff_id: prev?.staff_id || null,
        name: prev?.name || `Incoming PCA ${i + 1}`,
        restrictions: { noIso: !!(prev && prev.restrictions && prev.restrictions.noIso) },
        maxPatients: max,
        patients: Array.isArray(prev?.patients) ? prev.patients.slice() : []
      });
    }

    incomingPcas = next;
    syncWindowRefs();

    window.renderIncomingPcaList();
    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.renderCurrentPcaList = function () {
    const container = document.getElementById("currentPcaList");
    if (!container) return;
    container.innerHTML = "";

    (Array.isArray(currentPcas) ? currentPcas : []).forEach((p, index) => {
      const r = p.restrictions || { noIso: false };
      container.innerHTML += `
        <div class="pcaRow">
          <label>
            Name:
            <input type="text"
                   data-staff-role="PCA"
                   value="${(p.name || "").replace(/"/g, "&quot;")}"
                   onchange="updateCurrentPcaName(${index}, this)">
          </label>
          <div class="restrictionsGroup">
            <span>Restrictions:</span>
            <label class="restrictionOption">
              <input type="checkbox" ${r.noIso ? "checked" : ""}
                     onchange="updateCurrentPcaRestriction(${index}, this.checked)"> No ISO
            </label>
          </div>
        </div>
      `;
    });
  };

  window.renderIncomingPcaList = function () {
    const container = document.getElementById("incomingPcaList");
    if (!container) return;
    container.innerHTML = "";

    (Array.isArray(incomingPcas) ? incomingPcas : []).forEach((p, index) => {
      const r = p.restrictions || { noIso: false };
      container.innerHTML += `
        <div class="pcaRow">
          <label>
            Name:
            <input type="text"
                   data-staff-role="PCA"
                   value="${(p.name || "").replace(/"/g, "&quot;")}"
                   onchange="updateIncomingPcaName(${index}, this)">
          </label>
          <div class="restrictionsGroup">
            <span>Restrictions:</span>
            <label class="restrictionOption">
              <input type="checkbox" ${r.noIso ? "checked" : ""}
                     onchange="updateIncomingPcaRestriction(${index}, this.checked)"> No ISO
            </label>
          </div>
        </div>
      `;
    });
  };

  // ✅ Updated to accept input element OR raw string
  window.updateCurrentPcaName = function (index, elOrValue) {
    const p = currentPcas && currentPcas[index];
    if (!p) return;

    const el = (elOrValue && typeof elOrValue === "object") ? elOrValue : null;
    const value = el ? el.value : elOrValue;

    p.name = String(value || "").trim() || `Current PCA ${index + 1}`;
    p.staff_id = el ? (String(el.dataset.staffId || "").trim() || null) : (p.staff_id || null);

    syncWindowRefs();

    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  // ✅ Updated to accept input element OR raw string
  window.updateIncomingPcaName = function (index, elOrValue) {
    const p = incomingPcas && incomingPcas[index];
    if (!p) return;

    const el = (elOrValue && typeof elOrValue === "object") ? elOrValue : null;
    const value = el ? el.value : elOrValue;

    p.name = String(value || "").trim() || `Incoming PCA ${index + 1}`;
    p.staff_id = el ? (String(el.dataset.staffId || "").trim() || null) : (p.staff_id || null);

    syncWindowRefs();

    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateCurrentPcaRestriction = function (index, checked) {
    const p = currentPcas && currentPcas[index];
    if (!p) return;
    if (!p.restrictions) p.restrictions = { noIso: false };
    p.restrictions.noIso = !!checked;

    syncWindowRefs();

    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingPcaRestriction = function (index, checked) {
    const p = incomingPcas && incomingPcas[index];
    if (!p) return;
    if (!p.restrictions) p.restrictions = { noIso: false };
    p.restrictions.noIso = !!checked;

    syncWindowRefs();

    if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    if (typeof window.saveState === "function") window.saveState();
  };

  // =========================================================
  // ✅ Existing staff autocomplete + auto-create block (kept)
  // =========================================================

  function sbReady() {
    return !!(window.sb && window.sb.client && typeof window.sb.client.from === "function");
  }
  function unitId() {
    return window.activeUnitId ? String(window.activeUnitId) : "";
  }
  function cleanName(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }
  function isPlaceholderName(name) {
    const n = cleanName(name);
    if (!n) return true;
    return (
      /^current\s+(rn|pca)\s+\d+$/i.test(n) ||
      /^incoming\s+(rn|pca)\s+\d+$/i.test(n) ||
      /^rn\s*\d+$/i.test(n) ||
      /^pca\s*\d+$/i.test(n)
    );
  }

  function ensureDatalist(role) {
    const id = role === "PCA" ? "dlStaffPCA" : "dlStaffRN";
    if (document.getElementById(id)) return id;
    const dl = document.createElement("datalist");
    dl.id = id;
    document.body.appendChild(dl);
    return id;
  }

  function setOptions(role, rows) {
    const id = ensureDatalist(role);
    const dl = document.getElementById(id);
    if (!dl) return;
    dl.innerHTML = "";
    (rows || []).forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.display_name || "";
      dl.appendChild(opt);
    });
  }

  async function suggest(role, q) {
    if (!sbReady() || !unitId()) return [];
    if (typeof window.sb.searchUnitStaff !== "function") return [];
    const query = cleanName(q);
    const res = await window.sb.searchUnitStaff(unitId(), role, query, 12);
    if (res && !res.error && Array.isArray(res.rows)) return res.rows;
    return [];
  }

  async function ensureStaff(role, name) {
    if (!sbReady() || !unitId()) return null;
    if (typeof window.sb.ensureUnitStaff !== "function") return null;

    const nm = cleanName(name);
    if (!nm || isPlaceholderName(nm)) return null;

    const res = await window.sb.ensureUnitStaff(unitId(), role, nm);
    if (res && !res.error) return res.row || null;
    return null;
  }

  function wireInput(el) {
    if (!el || el.__staffWired) return;

    const role = (el.getAttribute("data-staff-role") === "PCA") ? "PCA" : "RN";
    el.setAttribute("list", ensureDatalist(role));
    el.autocomplete = "off";

    let t = null;
    el.addEventListener("input", () => {
      clearTimeout(t);
      const q = el.value;
      t = setTimeout(async () => {
        const rows = await suggest(role, q);
        setOptions(role, rows);
      }, 160);
    });

    async function onCommit() {
      await ensureStaff(role, el.value);
    }
    el.addEventListener("blur", onCommit);
    el.addEventListener("change", onCommit);

    el.__staffWired = true;
  }

  function rescan() {
    // RN fields
    ["currentNurseList", "incomingNurseList", "currentPcaList", "incomingPcaList"].forEach(id => {
      const root = document.getElementById(id);
      if (!root) return;
      root.querySelectorAll('input[type="text"][data-staff-role]').forEach(wireInput);
    });
  }

  // Wrap render/setup functions so after they rebuild DOM, we wire inputs again
  function wrap(fnName) {
    const fn = window[fnName];
    if (typeof fn !== "function" || fn.__staffWrapped) return;

    window[fnName] = function () {
      const out = fn.apply(this, arguments);
      setTimeout(rescan, 0);
      return out;
    };
    window[fnName].__staffWrapped = true;
  }

  [
    "setupCurrentNurses",
    "setupIncomingNurses",
    "setupCurrentPcas",
    "setupIncomingPcas",
    "renderCurrentNurseList",
    "renderIncomingNurseList",
    "renderCurrentPcaList",
    "renderIncomingPcaList"
  ].forEach(wrap);

  // Expose debug hook
  window.staffTypeahead = {
    rescan,
    ensureStaff
  };

  window.addEventListener("DOMContentLoaded", () => {
    setTimeout(rescan, 400);
  });
})();