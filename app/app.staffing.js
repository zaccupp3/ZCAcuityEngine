// app/app.staffing.js
// Handles RN/PCA staffing for "Staffing Details" tab
// and keeps current/incoming arrays in sync with the UI.
//
// IMPORTANT:
// - app.state.js owns the core arrays and exposes live getters/setters on window.
// - Do NOT reinitialize window.currentNurses/currentPcas/etc in this file.
// - Just read/write currentNurses/currentPcas/incomingNurses/incomingPcas directly.
// - CRITICAL FIX: whenever we mutate/replace arrays, we ALSO mirror them back onto window.*
//   so saveState() persists the true source of truth.
//
// ✅ NEW (Dec 2025):
// - Staff directory typeahead (unit_staff)
// - Autocomplete suggestions for RN/PCA name fields
// - Auto-create staff record on name commit (blur/change)
// - Roles are STRICT: "RN" or "PCA"
//
// ✅ NEW (Jan 2026):
// - Two separate +/- widgets: one for CURRENT, one for ONCOMING (no toggle slider)
// - Decrement is allowed ONLY when the last staff being removed has 0 patients assigned
// - Hold bucket protection (LIVE "Needs to be assigned"): never renders in Staffing Details,
//   and never becomes the template for rebuilding staff arrays.
//
// ✅ CHANGE (Jan 2026 - Staffing UI v2):
// - PCA Shift dropdown removed from Staffing Totals (handled in HTML layout v2).
// - This file no longer depends on #pcaShift.
// - updatePcaShift is kept as a safe no-op for backward compatibility (do-no-harm).

(function () {
  // 🔎 BUILD STAMP (debug)
  window.__staffingBuild = "staffing-plusminus-debug-v7-no-pcashift";
  console.log("[staffing] build loaded:", window.__staffingBuild);

  // ✅ Max caps (used by +/- adjust logic)
  // Keep in sync with your setup functions:
  // - RNs: min 5, max 10
  // - PCAs: min 3, max 8
  // - Sitters max 7
  const MIN_RN = 5;
  const MIN_PCA = 3;
  const MAX_RN = 10;
  const MAX_PCA = 8;
  const MAX_SITTER = 7;

  // ✅ PCA max-patient cap (shift dropdown removed; keep stable default)
  // If you later want this dynamic again, do it via state/config, not a Staffing UI select.
  const PCA_MAX_PATIENTS_DEFAULT = 8;

  // ---------------------------------------------------------
  // ✅ Warning modal API (for “cannot lower totals”)
  // ---------------------------------------------------------
  window.showStaffingWarnModal = function (title, body) {
    try {
      const modal = document.getElementById("staffingWarnModal");
      const t = document.getElementById("staffingWarnTitle");
      const b = document.getElementById("staffingWarnBody");
      if (t) t.textContent = String(title || "Unable to lower staffing");
      if (b) b.textContent = String(body || "This change is blocked by current assignment state.");
      if (modal) modal.style.display = "block";
    } catch (_) {}
  };

  window.closeStaffingWarnModal = function () {
    try {
      const modal = document.getElementById("staffingWarnModal");
      if (modal) modal.style.display = "none";
    } catch (_) {}
  };

  function fmtStaffingTime(d) {
    try {
      const dt = (d instanceof Date) ? d : new Date(d);
      return dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch (_) {
      return "";
    }
  }

  function setStaffingTotalsStatus(pillId, state, metaText) {
    try {
      const pill = document.getElementById(pillId);
      if (!pill) return;
      const dot = pill.querySelector && pill.querySelector(".staffing-status-dot");
      const textEl = pill.querySelector && pill.querySelector(".staffing-status-text");
      const metaEl = pill.querySelector && pill.querySelector(".staffing-status-meta");

      let dotColor = "#22c55e";
      let label = "Updated";
      if (state === "updating") { dotColor = "#fbbf24"; label = "Updating"; }
      else if (state === "error") { dotColor = "#ef4444"; label = "Error"; }

      if (dot) dot.style.background = dotColor;
      if (textEl) textEl.textContent = label;
      if (metaEl) metaEl.textContent = metaText || "";
      if (!textEl && pill) pill.textContent = label;
    } catch (_) {}
  }

  // Use the canonical restriction helper from app.state.js if present
  const getDefaultRestrictions =
    (typeof window.defaultRestrictions === "function")
      ? window.defaultRestrictions
      : function defaultRestrictionsFallback(oldRestriction) {
          return { noNih: oldRestriction === "noNih", noIso: false };
        };

  function syncWindowRefs() {
    // Keep window.* synchronized with legacy bare globals
    window.currentNurses = currentNurses;
    window.incomingNurses = incomingNurses;
    window.currentPcas = currentPcas;
    window.incomingPcas = incomingPcas;
    window.currentSitters = currentSitters;
    window.incomingSitters = incomingSitters;

    // Back-compat: some legacy code may read window.pcaShift.
    // The Staffing UI no longer owns/changes it, but we keep whatever exists.
    try {
      if (typeof window.pcaShift === "undefined" && typeof pcaShift !== "undefined") {
        window.pcaShift = pcaShift;
      }
    } catch (_) {}
  }

  function safeArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function safeInt(n, fallback) {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : fallback;
  }

  function clamp(n, min, max) {
    n = safeInt(n, min);
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function isHoldBucketStaff(o) {
    if (!o) return false;
    if (Number(o.id) === 0) return true;
    if (o.__hold) return true;
    if (String(o.type || "").toLowerCase() === "hold") return true;
    if (String(o.name || "").trim().toLowerCase() === "needs to be assigned") return true;
    return false;
  }

  function filterOutHoldBuckets(list) {
    return safeArray(list).filter((x) => !isHoldBucketStaff(x));
  }

  function getHoldBucket(list) {
    return safeArray(list).find(isHoldBucketStaff) || null;
  }

  function refreshAllViews() {
    try {
      if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    } catch {}
    try {
      if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
    } catch {}
    try {
      if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
    } catch {}
    try {
      if (typeof window.renderSitterAssignmentOutput === "function") window.renderSitterAssignmentOutput();
    } catch {}
    // Unit Pulse hooks vary by build; call best-effort if present
    try {
      if (typeof window.renderUnitPulse === "function") window.renderUnitPulse();
      else if (window.unitPulse && typeof window.unitPulse.render === "function") window.unitPulse.render();
      else if (typeof window.refreshUnitPulse === "function") window.refreshUnitPulse();
    } catch {}
  }

  function reflectLegacySelects() {
    const cn = filterOutHoldBuckets(currentNurses).length;
    const inN = filterOutHoldBuckets(incomingNurses).length;
    const cp = filterOutHoldBuckets(currentPcas).length;
    const ip = filterOutHoldBuckets(incomingPcas).length;
    const cs = filterOutHoldBuckets(currentSitters).length;
    const is = filterOutHoldBuckets(incomingSitters).length;

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      try {
        el.value = String(val);
      } catch (_) {}
    };

    if (cn) set("currentNurseCount", cn);
    if (inN) set("incomingNurseCount", inN);
    if (cp) set("currentPcaCount", cp);
    if (ip) set("incomingPcaCount", ip);
    if (cs) set("currentSitterCount", cs);
    if (is) set("incomingSitterCount", is);
  }

  function roomPairKeyFromRoomLabel(room) {
    const m = String(room || "").trim().toUpperCase().match(/^(\d+)/);
    return m ? m[1] : "";
  }

  function getSitterRoomPairOptions() {
    const pts = safeArray(window.patients);
    const byPair = new Map();

    pts.forEach((p) => {
      const room = String(p?.room || "").trim().toUpperCase();
      if (!room) return;
      const key = roomPairKeyFromRoomLabel(room);
      if (!key) return;
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key).push(room);
    });

    return Array.from(byPair.entries())
      .map(([key, rooms]) => {
        const uniq = Array.from(new Set(rooms)).sort();
        const label = uniq.length >= 2 ? `${uniq[0]}/${uniq[1]}` : `${uniq[0] || key}`;
        return { key, label };
      })
      .sort((a, b) => Number(a.key) - Number(b.key));
  }

  function canDecrementByLastHasNoPatients(listRaw, minCount, label) {
    const list = filterOutHoldBuckets(listRaw);
    const min = safeInt(minCount, 1);
    if (list.length <= min) {
      return { ok: false, reason: `${label || "Staff"} cannot go below ${min}.` };
    }

    const last = list[list.length - 1];
    const pts = safeArray(last?.patients);
    if (pts.length > 0) {
      return { ok: false, reason: "Cannot remove: last staff has patients assigned." };
    }
    return { ok: true };
  }

  // -------------------------
  // RN SETUP – CURRENT / INCOMING
  // -------------------------

  window.setupCurrentNurses = function (countOverride) {
    setStaffingTotalsStatus("currentStaffingTotalsStatus", "updating");
    try {
      const sel = document.getElementById("currentNurseCount");
      let count =
        (typeof countOverride === "number" && Number.isFinite(countOverride))
          ? countOverride
          : safeInt(sel && sel.value, MIN_RN);

      count = clamp(count, MIN_RN, MAX_RN);
      if (sel) sel.value = count;

      const oldRaw = safeArray(currentNurses);
      const old = filterOutHoldBuckets(oldRaw);
      const hold = getHoldBucket(oldRaw);

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

      currentNurses = hold ? [hold, ...next] : next;
      syncWindowRefs();
      reflectLegacySelects();

      window.renderCurrentNurseList();
      refreshAllViews();
      if (typeof window.saveState === "function") window.saveState();
      const meta = fmtStaffingTime(new Date()) ? " @ " + fmtStaffingTime(new Date()) : "";
      setStaffingTotalsStatus("currentStaffingTotalsStatus", "updated", meta);
    } catch (err) {
      setStaffingTotalsStatus("currentStaffingTotalsStatus", "error", (err && err.message) || "Error");
    }
  };

  window.setupIncomingNurses = function (countOverride) {
    setStaffingTotalsStatus("incomingStaffingTotalsStatus", "updating");
    try {
      const sel = document.getElementById("incomingNurseCount");
      let count =
        (typeof countOverride === "number" && Number.isFinite(countOverride))
          ? countOverride
          : safeInt(sel && sel.value, MIN_RN);

      count = clamp(count, MIN_RN, MAX_RN);
      if (sel) sel.value = count;

      const old = filterOutHoldBuckets(incomingNurses);
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
      reflectLegacySelects();

      window.renderIncomingNurseList();
      refreshAllViews();
      if (typeof window.saveState === "function") window.saveState();
      const meta = fmtStaffingTime(new Date()) ? " @ " + fmtStaffingTime(new Date()) : "";
      setStaffingTotalsStatus("incomingStaffingTotalsStatus", "updated", meta);
    } catch (err) {
      setStaffingTotalsStatus("incomingStaffingTotalsStatus", "error", (err && err.message) || "Error");
    }
  };

  window.renderCurrentNurseList = function () {
    const container = document.getElementById("currentNurseList");
    if (!container) return;
    container.innerHTML = "";

    filterOutHoldBuckets(currentNurses).forEach((n, index) => {
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

    filterOutHoldBuckets(incomingNurses).forEach((n, index) => {
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
  function getCurrentNurseByFilteredIndex(index) {
    const list = filterOutHoldBuckets(currentNurses);
    return list[index] || null;
  }
  function getIncomingNurseByFilteredIndex(index) {
    const list = filterOutHoldBuckets(incomingNurses);
    return list[index] || null;
  }

  window.updateCurrentNurseType = function (index, value) {
    const n = getCurrentNurseByFilteredIndex(index);
    if (!n) return;
    n.type = value;
    n.maxPatients = value === "tele" ? 4 : 5;
    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingNurseType = function (index, value) {
    const n = getIncomingNurseByFilteredIndex(index);
    if (!n) return;
    n.type = value;
    n.maxPatients = value === "tele" ? 4 : 5;
    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateCurrentNurseName = function (index, elOrValue) {
    const n = getCurrentNurseByFilteredIndex(index);
    if (!n) return;

    const el = (elOrValue && typeof elOrValue === "object") ? elOrValue : null;
    const value = el ? el.value : elOrValue;

    n.name = String(value || "").trim() || `Current RN ${index + 1}`;
    n.staff_id = el ? (String(el.dataset.staffId || "").trim() || null) : (n.staff_id || null);

    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingNurseName = function (index, elOrValue) {
    const n = getIncomingNurseByFilteredIndex(index);
    if (!n) return;

    const el = (elOrValue && typeof elOrValue === "object") ? elOrValue : null;
    const value = el ? el.value : elOrValue;

    n.name = String(value || "").trim() || `Incoming RN ${index + 1}`;
    n.staff_id = el ? (String(el.dataset.staffId || "").trim() || null) : (n.staff_id || null);

    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateCurrentNurseRestriction = function (index, key, checked) {
    const n = getCurrentNurseByFilteredIndex(index);
    if (!n) return;
    if (!n.restrictions) n.restrictions = getDefaultRestrictions();
    n.restrictions[key] = !!checked;

    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingNurseRestriction = function (index, key, checked) {
    const n = getIncomingNurseByFilteredIndex(index);
    if (!n) return;
    if (!n.restrictions) n.restrictions = getDefaultRestrictions();
    n.restrictions[key] = !!checked;

    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  // -------------------------
  // PCA SETUP – CURRENT / INCOMING
  // -------------------------

  // Back-compat: old UI used this. New v2 layout removes the dropdown.
  // Keep as safe no-op so nothing breaks if something still calls it.
  window.updatePcaShift = function (_value) {
    try {
      // No longer owned here. If someone still wants a different cap,
      // do it via config/state (future) — not a UI shift toggle.
      filterOutHoldBuckets(currentPcas).forEach(p => {
        if (!Number.isFinite(Number(p.maxPatients))) p.maxPatients = PCA_MAX_PATIENTS_DEFAULT;
      });
      filterOutHoldBuckets(incomingPcas).forEach(p => {
        if (!Number.isFinite(Number(p.maxPatients))) p.maxPatients = PCA_MAX_PATIENTS_DEFAULT;
      });
      syncWindowRefs();
      refreshAllViews();
      if (typeof window.saveState === "function") window.saveState();
    } catch (_) {}
  };

  window.setupCurrentPcas = function (countOverride) {
    setStaffingTotalsStatus("currentStaffingTotalsStatus", "updating");
    try {
      const sel = document.getElementById("currentPcaCount");
      let count =
        (typeof countOverride === "number" && Number.isFinite(countOverride))
          ? countOverride
          : safeInt(sel && sel.value, MIN_PCA);

      count = clamp(count, MIN_PCA, MAX_PCA);
      if (sel) sel.value = count;

      const oldRaw = safeArray(currentPcas);
      const old = filterOutHoldBuckets(oldRaw);
      const hold = getHoldBucket(oldRaw);

      const next = [];
      for (let i = 0; i < count; i++) {
        const prev = old[i];
        const prevMax = Number(prev?.maxPatients);
        const maxPatients = Number.isFinite(prevMax) ? prevMax : PCA_MAX_PATIENTS_DEFAULT;

        next.push({
          id: i + 1,
          staff_id: prev?.staff_id || null,
          name: prev?.name || `Current PCA ${i + 1}`,
          restrictions: { noIso: !!(prev && prev.restrictions && prev.restrictions.noIso) },
          isSitter: !!prev?.isSitter,
          sitterRoomPair: String(prev?.sitterRoomPair || ""),
          maxPatients,
          patients: Array.isArray(prev?.patients) ? prev.patients.slice() : []
        });
      }

      currentPcas = hold ? [hold, ...next] : next;
      syncWindowRefs();
      reflectLegacySelects();

      window.renderCurrentPcaList();
      refreshAllViews();
      if (typeof window.saveState === "function") window.saveState();
      const meta = fmtStaffingTime(new Date()) ? " @ " + fmtStaffingTime(new Date()) : "";
      setStaffingTotalsStatus("currentStaffingTotalsStatus", "updated", meta);
    } catch (err) {
      setStaffingTotalsStatus("currentStaffingTotalsStatus", "error", (err && err.message) || "Error");
    }
  };

  window.setupIncomingPcas = function (countOverride) {
    setStaffingTotalsStatus("incomingStaffingTotalsStatus", "updating");
    try {
      const sel = document.getElementById("incomingPcaCount");
      let count =
        (typeof countOverride === "number" && Number.isFinite(countOverride))
          ? countOverride
          : safeInt(sel && sel.value, MIN_PCA);

      count = clamp(count, MIN_PCA, MAX_PCA);
      if (sel) sel.value = count;

      const old = filterOutHoldBuckets(incomingPcas);
      const next = [];

      for (let i = 0; i < count; i++) {
        const prev = old[i];
        const prevMax = Number(prev?.maxPatients);
        const maxPatients = Number.isFinite(prevMax) ? prevMax : PCA_MAX_PATIENTS_DEFAULT;

        next.push({
          id: i + 1,
          staff_id: prev?.staff_id || null,
          name: prev?.name || `Incoming PCA ${i + 1}`,
          restrictions: { noIso: !!(prev && prev.restrictions && prev.restrictions.noIso) },
          isSitter: !!prev?.isSitter,
          sitterRoomPair: String(prev?.sitterRoomPair || ""),
          maxPatients,
          patients: Array.isArray(prev?.patients) ? prev.patients.slice() : []
        });
      }

      incomingPcas = next;
      syncWindowRefs();
      reflectLegacySelects();

      window.renderIncomingPcaList();
      refreshAllViews();
      if (typeof window.saveState === "function") window.saveState();
      const meta = fmtStaffingTime(new Date()) ? " @ " + fmtStaffingTime(new Date()) : "";
      setStaffingTotalsStatus("incomingStaffingTotalsStatus", "updated", meta);
    } catch (err) {
      setStaffingTotalsStatus("incomingStaffingTotalsStatus", "error", (err && err.message) || "Error");
    }
  };

  window.renderCurrentPcaList = function () {
    const container = document.getElementById("currentPcaList");
    if (!container) return;
    container.innerHTML = "";

    const roomPairs = getSitterRoomPairOptions();
    filterOutHoldBuckets(currentPcas).forEach((p, index) => {
      const r = p.restrictions || { noIso: false };
      const isSitter = !!p.isSitter;
      const selectedPair = String(p.sitterRoomPair || "");
      const pairOptions = roomPairs.map((opt) => `<option value="${opt.key}" ${opt.key === selectedPair ? "selected" : ""}>${opt.label}</option>`).join("");
      const sitterRoomPairControl = isSitter ? `
          <label>
            Sitter Room Pair:
            <select onchange="updateCurrentPcaSitterRoom(${index}, this.value)">
              <option value="">Select room pair</option>
              ${pairOptions}
            </select>
          </label>
      ` : ``;
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
            <label class="restrictionOption">
              <input type="checkbox" ${isSitter ? "checked" : ""}
                     onchange="updateCurrentPcaSitter(${index}, this.checked)"> Sitter Assignment
            </label>
          </div>
          ${sitterRoomPairControl}
        </div>
      `;
    });
  };

  window.renderIncomingPcaList = function () {
    const container = document.getElementById("incomingPcaList");
    if (!container) return;
    container.innerHTML = "";

    const roomPairs = getSitterRoomPairOptions();
    filterOutHoldBuckets(incomingPcas).forEach((p, index) => {
      const r = p.restrictions || { noIso: false };
      const isSitter = !!p.isSitter;
      const selectedPair = String(p.sitterRoomPair || "");
      const pairOptions = roomPairs.map((opt) => `<option value="${opt.key}" ${opt.key === selectedPair ? "selected" : ""}>${opt.label}</option>`).join("");
      const sitterRoomPairControl = isSitter ? `
          <label>
            Sitter Room Pair:
            <select onchange="updateIncomingPcaSitterRoom(${index}, this.value)">
              <option value="">Select room pair</option>
              ${pairOptions}
            </select>
          </label>
      ` : ``;
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
            <label class="restrictionOption">
              <input type="checkbox" ${isSitter ? "checked" : ""}
                     onchange="updateIncomingPcaSitter(${index}, this.checked)"> Sitter Assignment
            </label>
          </div>
          ${sitterRoomPairControl}
        </div>
      `;
    });
  };

  function getCurrentPcaByFilteredIndex(index) {
    const list = filterOutHoldBuckets(currentPcas);
    return list[index] || null;
  }
  function getIncomingPcaByFilteredIndex(index) {
    const list = filterOutHoldBuckets(incomingPcas);
    return list[index] || null;
  }

  window.updateCurrentPcaName = function (index, elOrValue) {
    const p = getCurrentPcaByFilteredIndex(index);
    if (!p) return;

    const el = (elOrValue && typeof elOrValue === "object") ? elOrValue : null;
    const value = el ? el.value : elOrValue;

    p.name = String(value || "").trim() || `Current PCA ${index + 1}`;
    p.staff_id = el ? (String(el.dataset.staffId || "").trim() || null) : (p.staff_id || null);

    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingPcaName = function (index, elOrValue) {
    const p = getIncomingPcaByFilteredIndex(index);
    if (!p) return;

    const el = (elOrValue && typeof elOrValue === "object") ? elOrValue : null;
    const value = el ? el.value : elOrValue;

    p.name = String(value || "").trim() || `Incoming PCA ${index + 1}`;
    p.staff_id = el ? (String(el.dataset.staffId || "").trim() || null) : (p.staff_id || null);

    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateCurrentPcaRestriction = function (index, checked) {
    const p = getCurrentPcaByFilteredIndex(index);
    if (!p) return;
    if (!p.restrictions) p.restrictions = { noIso: false };
    p.restrictions.noIso = !!checked;

    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingPcaRestriction = function (index, checked) {
    const p = getIncomingPcaByFilteredIndex(index);
    if (!p) return;
    if (!p.restrictions) p.restrictions = { noIso: false };
    p.restrictions.noIso = !!checked;

    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateCurrentPcaSitter = function (index, checked) {
    const p = getCurrentPcaByFilteredIndex(index);
    if (!p) return;
    p.isSitter = !!checked;
    if (!p.isSitter) p.sitterRoomPair = "";
    syncWindowRefs();
    window.renderCurrentPcaList();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingPcaSitter = function (index, checked) {
    const p = getIncomingPcaByFilteredIndex(index);
    if (!p) return;
    p.isSitter = !!checked;
    if (!p.isSitter) p.sitterRoomPair = "";
    syncWindowRefs();
    window.renderIncomingPcaList();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateCurrentPcaSitterRoom = function (index, roomPair) {
    const p = getCurrentPcaByFilteredIndex(index);
    if (!p) return;
    p.sitterRoomPair = String(roomPair || "").trim();
    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingPcaSitterRoom = function (index, roomPair) {
    const p = getIncomingPcaByFilteredIndex(index);
    if (!p) return;
    p.sitterRoomPair = String(roomPair || "").trim();
    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  // -------------------------
  // SITTER SETUP - CURRENT / INCOMING
  // -------------------------
  window.setupCurrentSitters = function (countOverride) {
    setStaffingTotalsStatus("currentStaffingTotalsStatus", "updating");
    try {
      const sel = document.getElementById("currentSitterCount");
      let count =
        (typeof countOverride === "number" && Number.isFinite(countOverride))
          ? countOverride
          : safeInt(sel && sel.value, 1);

      count = clamp(count, 1, MAX_SITTER);
      if (sel) sel.value = count;

      const old = filterOutHoldBuckets(currentSitters);
      const next = [];
      for (let i = 0; i < count; i++) {
        const prev = old[i];
        next.push({
          id: i + 1,
          staff_id: prev?.staff_id || null,
          name: prev?.name || `Current Sitter ${i + 1}`,
          maxPatients: 2,
          patients: Array.isArray(prev?.patients) ? prev.patients.slice() : []
        });
      }

      currentSitters = next;
      syncWindowRefs();
      reflectLegacySelects();

      window.renderCurrentSitterList();
      refreshAllViews();
      if (typeof window.saveState === "function") window.saveState();
      const meta = fmtStaffingTime(new Date()) ? " @ " + fmtStaffingTime(new Date()) : "";
      setStaffingTotalsStatus("currentStaffingTotalsStatus", "updated", meta);
    } catch (err) {
      setStaffingTotalsStatus("currentStaffingTotalsStatus", "error", (err && err.message) || "Error");
    }
  };

  window.setupIncomingSitters = function (countOverride) {
    setStaffingTotalsStatus("incomingStaffingTotalsStatus", "updating");
    try {
      const sel = document.getElementById("incomingSitterCount");
      let count =
        (typeof countOverride === "number" && Number.isFinite(countOverride))
          ? countOverride
          : safeInt(sel && sel.value, 1);

      count = clamp(count, 1, MAX_SITTER);
      if (sel) sel.value = count;

      const old = filterOutHoldBuckets(incomingSitters);
      const next = [];
      for (let i = 0; i < count; i++) {
        const prev = old[i];
        next.push({
          id: i + 1,
          staff_id: prev?.staff_id || null,
          name: prev?.name || `Incoming Sitter ${i + 1}`,
          maxPatients: 2,
          patients: Array.isArray(prev?.patients) ? prev.patients.slice() : []
        });
      }

      incomingSitters = next;
      syncWindowRefs();
      reflectLegacySelects();

      window.renderIncomingSitterList();
      refreshAllViews();
      if (typeof window.saveState === "function") window.saveState();
      const meta = fmtStaffingTime(new Date()) ? " @ " + fmtStaffingTime(new Date()) : "";
      setStaffingTotalsStatus("incomingStaffingTotalsStatus", "updated", meta);
    } catch (err) {
      setStaffingTotalsStatus("incomingStaffingTotalsStatus", "error", (err && err.message) || "Error");
    }
  };

  window.renderCurrentSitterList = function () {
    const container = document.getElementById("currentSitterList");
    if (!container) return;
    container.innerHTML = "";

    filterOutHoldBuckets(currentSitters).forEach((s, index) => {
      container.innerHTML += `
        <div class="pcaRow">
          <label>
            Name:
            <input type="text"
                   data-staff-role="SITTER"
                   value="${(s.name || "").replace(/"/g, "&quot;")}"
                   onchange="updateCurrentSitterName(${index}, this)">
          </label>
        </div>
      `;
    });
  };

  window.renderIncomingSitterList = function () {
    const container = document.getElementById("incomingSitterList");
    if (!container) return;
    container.innerHTML = "";

    filterOutHoldBuckets(incomingSitters).forEach((s, index) => {
      container.innerHTML += `
        <div class="pcaRow">
          <label>
            Name:
            <input type="text"
                   data-staff-role="SITTER"
                   value="${(s.name || "").replace(/"/g, "&quot;")}"
                   onchange="updateIncomingSitterName(${index}, this)">
          </label>
        </div>
      `;
    });
  };

  function getCurrentSitterByFilteredIndex(index) {
    const list = filterOutHoldBuckets(currentSitters);
    return list[index] || null;
  }
  function getIncomingSitterByFilteredIndex(index) {
    const list = filterOutHoldBuckets(incomingSitters);
    return list[index] || null;
  }

  window.updateCurrentSitterName = function (index, elOrValue) {
    const s = getCurrentSitterByFilteredIndex(index);
    if (!s) return;
    const el = (elOrValue && typeof elOrValue === "object") ? elOrValue : null;
    const value = el ? el.value : elOrValue;

    s.name = String(value || "").trim() || `Current Sitter ${index + 1}`;
    s.staff_id = el ? (String(el.dataset.staffId || "").trim() || null) : (s.staff_id || null);
    s.maxPatients = 2;

    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.updateIncomingSitterName = function (index, elOrValue) {
    const s = getIncomingSitterByFilteredIndex(index);
    if (!s) return;
    const el = (elOrValue && typeof elOrValue === "object") ? elOrValue : null;
    const value = el ? el.value : elOrValue;

    s.name = String(value || "").trim() || `Incoming Sitter ${index + 1}`;
    s.staff_id = el ? (String(el.dataset.staffId || "").trim() || null) : (s.staff_id || null);
    s.maxPatients = 2;

    syncWindowRefs();
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  // =========================================================
  // ✅ Staffing Controls API (used by +/- UI)
  // =========================================================
  function adjustArray(shift, role, delta) {
    const s = String(shift || "").toLowerCase();
    const r = String(role || "").toUpperCase();
    const d = safeInt(delta, 0);
    if (!d) return { ok: false, reason: "No change." };

    const isRn = r === "RN";
    const isPca = r === "PCA";
    const isSitter = r === "SITTER";
    if (!isRn && !isPca && !isSitter) return { ok: false, reason: "Invalid role." };

    const isIncoming = (s === "incoming" || s === "oncoming");
    const max = isRn ? MAX_RN : (isPca ? MAX_PCA : MAX_SITTER);

    if (isIncoming) {
      const list = isRn ? incomingNurses : (isPca ? incomingPcas : incomingSitters);
      const count = filterOutHoldBuckets(list).length || 0;

      const min = isRn ? MIN_RN : (isPca ? MIN_PCA : 1);
      if (d < 0) {
        const chk = canDecrementByLastHasNoPatients(list, min, isRn ? "RNs" : (isPca ? "PCAs" : "Sitters"));
        if (!chk.ok) return chk;
      }
      const nextCount = clamp(count + d, min, max);
      if (nextCount === count) return { ok: false, reason: "Limit reached." };

      if (isRn) window.setupIncomingNurses(nextCount);
      else if (isPca) window.setupIncomingPcas(nextCount);
      else window.setupIncomingSitters(nextCount);

      return { ok: true, count: nextCount };
    }

    // CURRENT
    const list = isRn ? currentNurses : (isPca ? currentPcas : currentSitters);
    const count = filterOutHoldBuckets(list).length || 0;

    const min = isRn ? MIN_RN : (isPca ? MIN_PCA : 1);
    if (d < 0) {
      const chk = canDecrementByLastHasNoPatients(list, min, isRn ? "RNs" : (isPca ? "PCAs" : "Sitters"));
      if (!chk.ok) return chk;
    }
    const nextCount = clamp(count + d, min, max);
    if (nextCount === count) return { ok: false, reason: "Limit reached." };

    if (isRn) window.setupCurrentNurses(nextCount);
    else if (isPca) window.setupCurrentPcas(nextCount);
    else window.setupCurrentSitters(nextCount);

    return { ok: true, count: nextCount };
  }

  window.staffingControls = {
    adjust: adjustArray,
    getCounts: () => ({
      current: {
        rn: filterOutHoldBuckets(currentNurses).length,
        pca: filterOutHoldBuckets(currentPcas).length,
        sitter: filterOutHoldBuckets(currentSitters).length
      },
      incoming: {
        rn: filterOutHoldBuckets(incomingNurses).length,
        pca: filterOutHoldBuckets(incomingPcas).length,
        sitter: filterOutHoldBuckets(incomingSitters).length
      }
    })
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
      /^current\s+(rn|pca|sitter)\s+\d+$/i.test(n) ||
      /^incoming\s+(rn|pca|sitter)\s+\d+$/i.test(n) ||
      /^rn\s*\d+$/i.test(n) ||
      /^pca\s*\d+$/i.test(n) ||
      /^sitter\s*\d+$/i.test(n)
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

    const attrRole = String(el.getAttribute("data-staff-role") || "").toUpperCase();
    const role = (attrRole === "PCA" || attrRole === "SITTER") ? "PCA" : "RN";
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
    ["currentNurseList", "incomingNurseList", "currentPcaList", "incomingPcaList", "currentSitterList", "incomingSitterList"].forEach(id => {
      const root = document.getElementById(id);
      if (!root) return;
      root.querySelectorAll('input[type="text"][data-staff-role]').forEach(wireInput);
    });
  }

  // Wrap render/setup functions so after they rebuild DOM, we wire inputs
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
    "setupCurrentSitters",
    "setupIncomingSitters",
    "renderCurrentNurseList",
    "renderIncomingNurseList",
    "renderCurrentPcaList",
    "renderIncomingPcaList",
    "renderCurrentSitterList",
    "renderIncomingSitterList"
  ].forEach(wrap);

  window.staffTypeahead = { rescan, ensureStaff };

  // =========================================================
  // ✅ Delegated +/- wiring (kept)
  // - If UI includes data-staff-ctrl buttons, we still support it
  // - When blocked, we show the warning modal instead of silent console
  // =========================================================

  if (!window.oncomingUnassigned) {
    window.oncomingUnassigned = { rn: [], pca: [], sitter: [] }; // patient ids
  }

  function uniq(arr) {
    const out = [];
    const seen = new Set();
    (Array.isArray(arr) ? arr : []).forEach(x => {
      const k = String(x);
      if (!seen.has(k)) { seen.add(k); out.push(x); }
    });
    return out;
  }

  function refreshAfterStaffingChange(shift) {
    try { if (typeof window.saveState === "function") window.saveState(); } catch (_) {}

    if (shift === "current") {
      try { if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments(); } catch (_) {}
      try { if (typeof window.renderUnitPulseTab === "function") window.renderUnitPulseTab(); } catch (_) {}
    } else {
      try {
        if (typeof window.renderOncomingAll === "function") window.renderOncomingAll();
        else {
          if (typeof window.renderAssignmentOutput === "function") window.renderAssignmentOutput();
          if (typeof window.renderPcaAssignmentOutput === "function") window.renderPcaAssignmentOutput();
          if (typeof window.renderSitterAssignmentOutput === "function") window.renderSitterAssignmentOutput();
        }
      } catch (_) {}
    }
  }

  function moveIncomingRemovedOwnerPatientsToUnassigned(roleUpper, ownerObj) {
    const ids = safeArray(ownerObj && ownerObj.patients);
    if (!ids.length) return;

    const key = (roleUpper === "PCA") ? "pca" : "rn";
    window.oncomingUnassigned[key] = uniq(safeArray(window.oncomingUnassigned[key]).concat(ids));
    ownerObj.patients = [];
  }

  function decrementIncomingSafely(roleUpper) {
    if (roleUpper === "RN") {
      const arr = safeArray(window.incomingNurses);
      if (arr.length <= MIN_RN) return { ok: false, reason: `Incoming RNs cannot go below ${MIN_RN}.` };

      const last = arr[arr.length - 1];
      moveIncomingRemovedOwnerPatientsToUnassigned("RN", last);

      if (typeof window.setupIncomingNurses === "function") {
        window.setupIncomingNurses(arr.length - 1);
      } else if (window.staffingControls?.adjust) {
        window.staffingControls.adjust("incoming", "RN", -1);
      }
      return { ok: true };
    }

    const arr = safeArray(window.incomingPcas);
    if (arr.length <= MIN_PCA) return { ok: false, reason: `Incoming PCAs cannot go below ${MIN_PCA}.` };

    const last = arr[arr.length - 1];
    moveIncomingRemovedOwnerPatientsToUnassigned("PCA", last);

    if (typeof window.setupIncomingPcas === "function") {
      window.setupIncomingPcas(arr.length - 1);
    } else if (window.staffingControls?.adjust) {
      window.staffingControls.adjust("incoming", "PCA", -1);
    }
    return { ok: true };
  }

  function incrementShift(roleUpper, shiftLower) {
    if (!window.staffingControls?.adjust) return { ok: false, reason: "staffingControls missing." };
    const res = window.staffingControls.adjust(shiftLower, roleUpper, +1);
    return res && res.ok ? { ok: true } : { ok: false, reason: res?.reason || "Unable to increment." };
  }

  function wireStaffingPlusMinusDelegatedOnce() {
    const root =
      document.getElementById("staffingTab") ||
      document.getElementById("staffingDetailsTab") ||
      document.querySelector(".tab-section#staffingTab");

    if (!root || root.__staffingPlusMinusDelegated) return;
    root.__staffingPlusMinusDelegated = true;

    root.addEventListener("click", (e) => {
      const btn = e.target?.closest?.('button[data-staff-ctrl="1"]');
      if (!btn) return;

      const shift = String(btn.dataset.shift || "").toLowerCase(); // current | incoming
      const role = String(btn.dataset.role || "").toUpperCase();   // RN | PCA
      const delta = parseInt(btn.dataset.delta || "0", 10);

      if (!shift || !role || !delta) return;

      if (shift === "current" && delta < 0) {
        window.showStaffingWarnModal(
          "Cannot lower Current staff here",
          "Current decrement is blocked in Staffing Details. Remove staff via the LIVE board (X) workflow so patients aren’t orphaned."
        );
        return;
      }

      if (shift === "incoming" && delta < 0) {
        const out = decrementIncomingSafely(role);
        if (!out.ok) {
          window.showStaffingWarnModal("Unable to lower Oncoming staff", out.reason || "This change is blocked.");
          return;
        }
        refreshAfterStaffingChange("incoming");
        return;
      }

      if (delta > 0) {
        const out = incrementShift(role, shift);
        if (!out.ok) {
          window.showStaffingWarnModal("Unable to increase staffing", out.reason || "This change is blocked.");
          return;
        }
        refreshAfterStaffingChange(shift);
      }
    });
  }

  window.addEventListener("DOMContentLoaded", () => {
    setTimeout(wireStaffingPlusMinusDelegatedOnce, 250);
  });

  // ---------------------------------------------------------
  // ✅ Remove old injected “Staffing Totals” panels if we’re on layout v2
  // (Prevents duplicates + UI fighting)
  // ---------------------------------------------------------
  function isStaffingLayoutV2() {
    try {
      return !!document.querySelector('#staffingTab [data-staffing-layout="v2"]');
    } catch (_) {
      return false;
    }
  }

  function attachStaffingTotalsChangeListeners() {
    if (window.__staffingTotalsListenersAttached) return;
    const curRn = document.getElementById("currentNurseCount");
    const curPca = document.getElementById("currentPcaCount");
    const curSitter = document.getElementById("currentSitterCount");
    const incRn = document.getElementById("incomingNurseCount");
    const incPca = document.getElementById("incomingPcaCount");
    const incSitter = document.getElementById("incomingSitterCount");
    if (curRn) {
      const h = () => { if (typeof window.setupCurrentNurses === "function") window.setupCurrentNurses(); };
      curRn.addEventListener("input", h);
      curRn.addEventListener("change", h);
    }
    if (curPca) {
      const h = () => { if (typeof window.setupCurrentPcas === "function") window.setupCurrentPcas(); };
      curPca.addEventListener("input", h);
      curPca.addEventListener("change", h);
    }
    if (curSitter) curSitter.addEventListener("change", () => { if (typeof window.setupCurrentSitters === "function") window.setupCurrentSitters(); });
    if (incRn) {
      const h = () => { if (typeof window.setupIncomingNurses === "function") window.setupIncomingNurses(); };
      incRn.addEventListener("input", h);
      incRn.addEventListener("change", h);
    }
    if (incPca) {
      const h = () => { if (typeof window.setupIncomingPcas === "function") window.setupIncomingPcas(); };
      incPca.addEventListener("input", h);
      incPca.addEventListener("change", h);
    }
    if (incSitter) incSitter.addEventListener("change", () => { if (typeof window.setupIncomingSitters === "function") window.setupIncomingSitters(); });
    window.__staffingTotalsListenersAttached = true;
  }

  function clearNames(list, makeDefault) {
    filterOutHoldBuckets(list).forEach((s, idx) => {
      s.name = makeDefault(idx + 1);
      s.staff_id = null;
    });
  }

  window.clearCurrentRnNames = function () {
    clearNames(currentNurses, (n) => `Current RN ${n}`);
    syncWindowRefs();
    try { window.renderCurrentNurseList && window.renderCurrentNurseList(); } catch (_) {}
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.clearIncomingRnNames = function () {
    clearNames(incomingNurses, (n) => `Incoming RN ${n}`);
    syncWindowRefs();
    try { window.renderIncomingNurseList && window.renderIncomingNurseList(); } catch (_) {}
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.clearCurrentPcaNames = function () {
    clearNames(currentPcas, (n) => `Current PCA ${n}`);
    syncWindowRefs();
    try { window.renderCurrentPcaList && window.renderCurrentPcaList(); } catch (_) {}
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  window.clearIncomingPcaNames = function () {
    clearNames(incomingPcas, (n) => `Incoming PCA ${n}`);
    syncWindowRefs();
    try { window.renderIncomingPcaList && window.renderIncomingPcaList(); } catch (_) {}
    refreshAllViews();
    if (typeof window.saveState === "function") window.saveState();
  };

  function clearLeadershipFields(ids) {
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = "";
      try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) {}
      try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
    });
    if (typeof window.saveState === "function") window.saveState();
  }

  window.clearCurrentLeadershipTeam = function () {
    clearLeadershipFields(["currentChargeName", "currentMentorName", "currentCtaName"]);
  };

  window.clearIncomingLeadershipTeam = function () {
    clearLeadershipFields(["incomingChargeName", "incomingMentorName", "incomingCtaName"]);
  };

  // Keep these light touches:
  window.addEventListener("DOMContentLoaded", () => {
    setTimeout(rescan, 400);
    setTimeout(reflectLegacySelects, 520);
    attachStaffingTotalsChangeListeners();

    // If legacy builds try to inject panels, we simply do nothing by not installing them.
    if (!isStaffingLayoutV2()) {
      // (No-op: previously you were installing two panels + observers here.
      // We intentionally skip that on v2 layout to avoid duplicates.)
    }
  });
})();
