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
//
// NEW (Dec 2025 - Fixes):
// - MOVE-based count balancer (diff ≤ 1 when possible) for BOTH RN and PCA
// - Scoped rebalance buttons: RN-only and PCA-only (no “other side” impact)
// - Empty-owner drop zone row so empty cards can accept drops
//
// FIX (Jan 2026):
// - Canonicalize state references (incomingNurses/incomingPcas/patients) to avoid drift.
//
// FIX (Jan 2026 - Safe Rebalance Wiring):
// - Rebalance buttons use window.rebalanceOwnersSafely (if available)
// - If applied:false, keep baseline and show "Unable to rebalance safely"
//
// PERF (Jan 2026):
// - Cache Prev RN/PCA owner maps once per render (removes many .find scans)
// - Cache hard-rule eval maps once per render
// ---------------------------------------------------------

if (window.__assignmentsRenderLoaded) {
  // no-op
} else {
  window.__assignmentsRenderLoaded = true;

  // =========================================================
  // ✅ Canonical state accessors (prevents reference drift)
  // =========================================================
  function __getIncomingNurses() {
    const w = window.incomingNurses;
    if (Array.isArray(w)) return w;
    if (Array.isArray(typeof incomingNurses !== "undefined" ? incomingNurses : null)) return incomingNurses;
    return [];
  }

  function __getIncomingPcas() {
    const w = window.incomingPcas;
    if (Array.isArray(w)) return w;
    if (Array.isArray(typeof incomingPcas !== "undefined" ? incomingPcas : null)) return incomingPcas;
    return [];
  }

  function __getPatients() {
    const w = window.patients;
    if (Array.isArray(w)) return w;
    if (Array.isArray(typeof patients !== "undefined" ? patients : null)) return patients;
    return [];
  }

  function __syncIncomingGlobals() {
    const nurses = __getIncomingNurses();
    const pcas = __getIncomingPcas();
    const pts = __getPatients();

    if (!Array.isArray(window.incomingNurses)) window.incomingNurses = nurses;
    if (!Array.isArray(window.incomingPcas)) window.incomingPcas = pcas;
    if (!Array.isArray(window.patients)) window.patients = pts;

    try {
      if (typeof incomingNurses !== "undefined" && incomingNurses !== window.incomingNurses) {
        incomingNurses = window.incomingNurses;
      }
    } catch (_) {}

    try {
      if (typeof incomingPcas !== "undefined" && incomingPcas !== window.incomingPcas) {
        incomingPcas = window.incomingPcas;
      }
    } catch (_) {}

    try {
      if (typeof patients !== "undefined" && patients !== window.patients) {
        patients = window.patients;
      }
    } catch (_) {}
  }

  __syncIncomingGlobals();

  // -----------------------------
  // Helpers: build prev-owner maps ONCE per render (PERF)
  // -----------------------------
  function buildPrevOwnerMaps() {
    const prevRnByPid = new Map();
    const prevPcaByPid = new Map();

    if (Array.isArray(window.currentNurses)) {
      window.currentNurses.forEach(rn => {
        const name = rn?.name || `RN ${rn?.id ?? ""}`;
        (rn?.patients || []).forEach(pid => prevRnByPid.set(Number(pid), name));
      });
    }

    if (Array.isArray(window.currentPcas)) {
      window.currentPcas.forEach(p => {
        const name = p?.name || `PCA ${p?.id ?? ""}`;
        (p?.patients || []).forEach(pid => prevPcaByPid.set(Number(pid), name));
      });
    }

    return { prevRnByPid, prevPcaByPid };
  }

  function uniqueCountFromMap(patientIds, map) {
    const set = new Set();
    (patientIds || []).forEach(pid => {
      const v = map.get(Number(pid));
      if (v) set.add(v);
    });
    return set.size;
  }

  // -----------------------------
  // Backward-compatible helpers (still exposed)
  // -----------------------------
  function getPrevRnNameForPatient(patientId) {
    const pid = Number(patientId);
    if (!pid) return "";
    if (!Array.isArray(window.currentNurses)) return "";
    const owner = window.currentNurses.find(n => Array.isArray(n.patients) && n.patients.includes(pid));
    return owner ? (owner.name || `RN ${owner.id}`) : "";
  }

  function getPrevPcaNameForPatient(patientId) {
    const pid = Number(patientId);
    if (!pid) return "";
    if (!Array.isArray(window.currentPcas)) return "";
    const owner = window.currentPcas.find(p => Array.isArray(p.patients) && p.patients.includes(pid));
    return owner ? (owner.name || `PCA ${owner.id}`) : "";
  }

  window.getPrevRnNameForPatient = getPrevRnNameForPatient;
  window.getPrevPcaNameForPatient = getPrevPcaNameForPatient;

  // -----------------------------
  // Room label helpers
  // -----------------------------
  function getBedLabel(p) {
    if (!p) return "";
    if (typeof window.getRoomLabelForPatient === "function") return window.getRoomLabelForPatient(p);
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

  function cleanupRnPinsAgainstRoster() {
    const roster = __getIncomingNurses();
    const rosterIds = new Set(roster.map(n => Number(n.id)));

    const pts = __getPatients();
    pts.forEach(p => {
      const meta = getPatientLockMeta(p);
      if (!meta.enabled) return;
      if (!rosterIds.has(meta.rnId)) {
        p.lockRnEnabled = false;
        p.lockRnTo = null;
      }
    });
  }

  function applyRnPinsBeforeDistribute(activePatients) {
    const roster = __getIncomingNurses();
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
    return { minTarget: base, maxTarget: base + (remainder > 0 ? 1 : 0) };
  }

  function getMovablePatientIdsFromOwner(owner, role) {
    const ids = Array.isArray(owner?.patients) ? owner.patients.slice() : [];
    if (role !== "nurse") return ids;
    return ids.filter(pid => !isPatientPinnedToIncomingRn(pid, owner.id));
  }

  function tryMovePatient(owners, role, fromOwner, toOwner, patientId) {
    if (!fromOwner || !toOwner) return false;
    if (!Array.isArray(fromOwner.patients)) fromOwner.patients = [];
    if (!Array.isArray(toOwner.patients)) toOwner.patients = [];

    const idx = fromOwner.patients.indexOf(patientId);
    if (idx === -1) return false;

    if (role === "nurse" && isPatientPinnedToIncomingRn(patientId, fromOwner.id)) return false;

    fromOwner.patients.splice(idx, 1);
    if (!toOwner.patients.includes(patientId)) toOwner.patients.push(patientId);
    return true;
  }

  function balanceCountsWithoutCreatingNewAvoidableViolations(owners, role, opts = {}) {
    const maxPasses = typeof opts.maxPasses === "number" ? opts.maxPasses : 60;
    const list = Array.isArray(owners) ? owners : [];
    const n = list.length;
    if (n < 2) return { ok: true, changed: false };

    const assignedSet = new Set();
    list.forEach(o => (Array.isArray(o?.patients) ? o.patients : []).forEach(pid => assignedSet.add(Number(pid))));
    const totalAssigned = assignedSet.size;

    const { minTarget, maxTarget } = computeCountTargets(totalAssigned, n);

    let changed = false;
    let passes = 0;

    while (passes < maxPasses) {
      passes++;

      const counts = list.map(o => (Array.isArray(o?.patients) ? o.patients.length : 0));
      const spread = Math.max(...counts) - Math.min(...counts);
      if (spread <= 1) break;

      const over2 = list
        .map(o => ({ o, c: (Array.isArray(o?.patients) ? o.patients.length : 0) }))
        .sort((a, b) => b.c - a.c);

      const under2 = list
        .map(o => ({ o, c: (Array.isArray(o?.patients) ? o.patients.length : 0) }))
        .sort((a, b) => a.c - b.c);

      const from = over2[0]?.o;
      const to = under2[0]?.o;
      if (!from || !to || from === to) break;

      const movable = getMovablePatientIdsFromOwner(from, role);
      if (!movable.length) break;

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

      const counts2 = list.map(o => (Array.isArray(o?.patients) ? o.patients.length : 0));
      const spread2 = Math.max(...counts2) - Math.min(...counts2);
      if (spread2 <= 1) break;

      const okCaps = counts2.every(c => c >= minTarget && c <= maxTarget);
      if (okCaps) break;

      void maxTarget;
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

  function getOwnerRuleEvalFromMap(owner, map) {
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

  // =========================================================
  // ✅ Status banner helpers
  // =========================================================
  function __ensureBanner(containerId, bannerId) {
    const container = document.getElementById(containerId);
    if (!container) return null;

    let el = document.getElementById(bannerId);
    if (!el) {
      el = document.createElement("div");
      el.id = bannerId;
      el.style.cssText = [
        "display:none",
        "margin:10px 0 14px 0",
        "padding:10px 12px",
        "border-radius:10px",
        "font-size:12px",
        "line-height:1.25",
        "border:1px solid rgba(15,23,42,0.12)",
        "background:rgba(15,23,42,0.03)"
      ].join(";");
      container.prepend(el);
    }
    return el;
  }

  function __setBanner(containerId, bannerId, kind, msg) {
    const el = __ensureBanner(containerId, bannerId);
    if (!el) return;

    const safeMsg = escapeHtml(msg || "");
    if (!safeMsg) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }

    let border = "rgba(15,23,42,0.12)";
    let bg = "rgba(15,23,42,0.03)";
    let title = "Update";

    if (kind === "ok") {
      border = "rgba(16,185,129,0.35)";
      bg = "rgba(16,185,129,0.08)";
      title = "Rebalance applied";
    } else if (kind === "warn") {
      border = "rgba(245,158,11,0.45)";
      bg = "rgba(245,158,11,0.10)";
      title = "Unable to rebalance safely";
    } else if (kind === "bad") {
      border = "rgba(239,68,68,0.45)";
      bg = "rgba(239,68,68,0.10)";
      title = "Blocked";
    }

    el.style.borderColor = border;
    el.style.background = bg;
    el.style.display = "block";
    el.innerHTML = `<strong style="display:block;margin-bottom:4px;">${escapeHtml(title)}</strong>${safeMsg}`;
  }

  function __clearBanners() {
    __setBanner("assignmentOutput", "oncomingStatusRn", "", "");
    __setBanner("pcaAssignmentOutput", "oncomingStatusPca", "", "");
  }

  // =========================================================
  // RN Oncoming Render
  // =========================================================
  function renderAssignmentOutput() {
    __syncIncomingGlobals();

    const container = document.getElementById("assignmentOutput");
    if (!container) return;

    if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

    let html = "";
    const allOwners = __getIncomingNurses();

    // ✅ PERF: build once
    const { prevRnByPid } = buildPrevOwnerMaps();

    // ✅ PERF: rules map once
    const rnRuleMap = safeGetRuleEvalMap(allOwners, "nurse");

    allOwners.forEach(nurse => {
      const pts = (nurse.patients || [])
        .map(pid => getPatientById(pid))
        .filter(p => p && !p.isEmpty)
        .sort(safeSortPatientsForDisplay);

      const loadScore = (typeof getNurseLoadScore === "function") ? getNurseLoadScore(nurse) : 0;
      const loadClass = (typeof getLoadClass === "function") ? getLoadClass(loadScore, "nurse") : "";

      const drivers = (typeof window.getRnDriversSummaryFromPatientIds === "function")
        ? window.getRnDriversSummaryFromPatientIds(nurse.patients || [])
        : "";

      const reportSources = uniqueCountFromMap(nurse.patients || [], prevRnByPid);
      const explainText = safeGetPerOwnerExplain(nurse, allOwners, "nurse") || "";

      const ruleEval = getOwnerRuleEvalFromMap(nurse, rnRuleMap);
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
        html += buildEmptyDropRow(4, "Drop a patient here to assign to this RN");
      }

      pts.forEach(p => {
        const prevName = prevRnByPid.get(Number(p.id)) || "";
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

  // =========================================================
  // PCA Oncoming Render
  // =========================================================
  function renderPcaAssignmentOutput() {
    __syncIncomingGlobals();

    const container = document.getElementById("pcaAssignmentOutput");
    if (!container) return;

    if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

    let html = "";
    const allOwners = __getIncomingPcas();

    // ✅ PERF: build once
    const { prevPcaByPid } = buildPrevOwnerMaps();

    // ✅ PERF: rules map once
    const pcaRuleMap = safeGetRuleEvalMap(allOwners, "pca");

    allOwners.forEach(pca => {
      const pts = (pca.patients || [])
        .map(pid => getPatientById(pid))
        .filter(p => p && !p.isEmpty)
        .sort(safeSortPatientsForDisplay);

      const loadScore = (typeof getPcaLoadScore === "function") ? getPcaLoadScore(pca) : 0;
      const loadClass = (typeof getLoadClass === "function") ? getLoadClass(loadScore, "pca") : "";

      const drivers = (typeof window.getPcaDriversSummaryFromPatientIds === "function")
        ? window.getPcaDriversSummaryFromPatientIds(pca.patients || [])
        : "";

      const reportSources = uniqueCountFromMap(pca.patients || [], prevPcaByPid);
      const explainText = safeGetPerOwnerExplain(pca, allOwners, "pca") || "";

      const ruleEval = getOwnerRuleEvalFromMap(pca, pcaRuleMap);
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
        html += buildEmptyDropRow(4, "Drop a patient here to assign to this PCA");
      }

      pts.forEach(p => {
        const prevName = prevPcaByPid.get(Number(p.id)) || "";
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

  // =========================================================
  // Generator (Oncoming populate + rebalance)
  // =========================================================
  function populateOncomingAssignment(randomize = false) {
    __syncIncomingGlobals();
    __clearBanners();

    if (typeof ensureDefaultPatients === "function") ensureDefaultPatients();

    const nurses = __getIncomingNurses();
    const pcas = __getIncomingPcas();
    const ptsAll = __getPatients();

    if (!nurses.length || !pcas.length) {
      alert("Please set up ONCOMING RNs and PCAs on the Staffing Details tab first.");
      return;
    }

    const activePatients = ptsAll.filter(p => p && !p.isEmpty);
    if (!activePatients.length) {
      alert("No active patients found.");
      return;
    }

    nurses.forEach(n => { n.patients = []; });
    pcas.forEach(p => { p.patients = []; });

    cleanupRnPinsAgainstRoster();

    let list = activePatients.slice();
    if (randomize) list.sort(() => Math.random() - 0.5);
    else list.sort(safeSortPatientsForDisplay);

    const { unlockedPool } = applyRnPinsBeforeDistribute(list);

    if (typeof window.distributePatientsEvenly === "function") {
      window.distributePatientsEvenly(nurses, unlockedPool, { randomize, role: "nurse", preserveExisting: true });
      window.distributePatientsEvenly(pcas, list, { randomize, role: "pca", preserveExisting: true });
    } else {
      alert("ERROR: distributePatientsEvenly is not loaded. Check script order + app.assignmentRules.js loading.");
      console.error("distributePatientsEvenly missing — check index.html script order and app.assignmentRules.js.");
      return;
    }

    // keep these passes reasonable to avoid UI lag
    balanceCountsWithoutCreatingNewAvoidableViolations(nurses, "nurse", { maxPasses: 50 });
    balanceCountsWithoutCreatingNewAvoidableViolations(pcas, "pca", { maxPasses: 50 });

    if (typeof window.repairAssignmentsInPlace === "function") {
      window.repairAssignmentsInPlace(nurses, "nurse", null, { maxIters: 18 });
      window.repairAssignmentsInPlace(pcas, "pca", null, { maxIters: 18 });
    }

    renderAssignmentOutput();
    renderPcaAssignmentOutput();

    if (typeof window.saveState === "function") window.saveState();
    if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
  }

  function __runSafeRebalance(owners, role) {
    if (typeof window.rebalanceOwnersSafely !== "function") {
      if (typeof window.repairAssignmentsInPlace === "function") {
        window.repairAssignmentsInPlace(owners, role, null, { maxIters: 22 });
        return { applied: true, reason: "" };
      }
      return { applied: false, reason: "Rebalance engine not loaded." };
    }

    const res = window.rebalanceOwnersSafely(owners, role);
    if (!res?.applied) return { applied: false, reason: res?.reason || "Unable to rebalance safely." };
    return { applied: true, reason: "" };
  }

  function rebalanceOncomingRnOnly() {
    __syncIncomingGlobals();
    __clearBanners();

    const nurses = __getIncomingNurses();
    const ptsAll = __getPatients();

    try {
      cleanupRnPinsAgainstRoster();
      nurses.forEach(rn => {
        rn.patients = Array.isArray(rn.patients) ? rn.patients : [];
        rn.patients = rn.patients.filter(pid => !isPatientPinnedToIncomingRn(pid, rn.id));
      });
      const active = ptsAll.filter(p => p && !p.isEmpty);
      applyRnPinsBeforeDistribute(active);
    } catch (e) {
      console.warn("[rebalance RN] pin placement pre-pass failed", e);
    }

    const rnRes = __runSafeRebalance(nurses, "nurse");
    __setBanner("assignmentOutput", "oncomingStatusRn", rnRes.applied ? "ok" : "warn",
      rnRes.applied ? "RN rebalance applied." : rnRes.reason
    );

    renderAssignmentOutput();

    if (typeof window.saveState === "function") window.saveState();
    if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
  }

  function rebalanceOncomingPcaOnly() {
    __syncIncomingGlobals();
    __clearBanners();

    const pcas = __getIncomingPcas();
    const pcaRes = __runSafeRebalance(pcas, "pca");

    __setBanner("pcaAssignmentOutput", "oncomingStatusPca", pcaRes.applied ? "ok" : "warn",
      pcaRes.applied ? "PCA rebalance applied." : pcaRes.reason
    );

    renderPcaAssignmentOutput();

    if (typeof window.saveState === "function") window.saveState();
    if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
  }

  function rebalanceOncomingAssignment() {
    __syncIncomingGlobals();
    __clearBanners();

    const nurses = __getIncomingNurses();
    const pcas = __getIncomingPcas();
    const ptsAll = __getPatients();

    try {
      cleanupRnPinsAgainstRoster();
      nurses.forEach(rn => {
        rn.patients = Array.isArray(rn.patients) ? rn.patients : [];
        rn.patients = rn.patients.filter(pid => !isPatientPinnedToIncomingRn(pid, rn.id));
      });
      const active = ptsAll.filter(p => p && !p.isEmpty);
      applyRnPinsBeforeDistribute(active);
    } catch (e) {
      console.warn("[rebalance BOTH] pin placement pre-pass failed", e);
    }

    const rnRes = __runSafeRebalance(nurses, "nurse");
    const pcaRes = __runSafeRebalance(pcas, "pca");

    __setBanner("assignmentOutput", "oncomingStatusRn", rnRes.applied ? "ok" : "warn",
      rnRes.applied ? "RN rebalance applied." : rnRes.reason
    );
    __setBanner("pcaAssignmentOutput", "oncomingStatusPca", pcaRes.applied ? "ok" : "warn",
      pcaRes.applied ? "PCA rebalance applied." : pcaRes.reason
    );

    renderAssignmentOutput();
    renderPcaAssignmentOutput();

    if (typeof window.saveState === "function") window.saveState();
    if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
  }

  // Expose globally (CRITICAL for index.html onclick)
  window.renderAssignmentOutput = renderAssignmentOutput;
  window.renderPcaAssignmentOutput = renderPcaAssignmentOutput;
  window.populateOncomingAssignment = populateOncomingAssignment;
  window.rebalanceOncomingRnOnly = rebalanceOncomingRnOnly;
  window.rebalanceOncomingPcaOnly = rebalanceOncomingPcaOnly;
  window.rebalanceOncomingAssignment = rebalanceOncomingAssignment;
}