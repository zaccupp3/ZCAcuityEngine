// app/app.liveAssignments.js
// ---------------------------------------------------------
// LIVE Assignment engine + rendering (Current shift only)
//
// PATCH (Jan 2026 -> refined):
// - Admit Queue is mounted higher INSIDE the LIVE page (near Print LIVE)
// - Inline queue uses app.queue.js canonical API when present (do-no-harm fallback)
// - Queue renders HORIZONTALLY above RN tiles (scrollable)
// - Discharge Bin accepts drop ANYWHERE within the bin card
// ---------------------------------------------------------

(function () {
  // -----------------------------
  // Small utils (safe + no deps)
  // -----------------------------
  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function safeArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function clamp(n, a, b) {
    const x = Number.isFinite(Number(n)) ? Number(n) : 0;
    return Math.max(a, Math.min(b, x));
  }

  function normalizeBucketFromClass(cls) {
    const c = String(cls || "").toLowerCase();
    if (!c) return "";
    if (c.includes("high") || c.includes("red")) return "red";
    if (c.includes("medium") || c.includes("yellow")) return "yellow";
    if (c.includes("good") || c.includes("green") || c.includes("low")) return "green";
    return "";
  }

  function getThresholdsForLive(role) {
    const live =
      window.liveThresholds && typeof window.liveThresholds === "object"
        ? window.liveThresholds
        : null;
    const ups =
      window.unitPulseState?.thresholds && typeof window.unitPulseState.thresholds === "object"
        ? window.unitPulseState.thresholds
        : null;

    const def =
      role === "pca" ? { greenMax: 14, yellowMax: 22, redMax: 32 } : { greenMax: 10, yellowMax: 16, redMax: 26 };

    const pick = (src) => {
      if (!src) return null;
      if (role === "pca") return src.pca || src.PCA || src.pcas || null;
      return src.nurse || src.rn || src.RN || src.nurses || null;
    };

    const o = pick(live) || pick(ups) || null;
    const merged = { ...def, ...(o && typeof o === "object" ? o : {}) };

    const g = Math.max(0, Number(merged.greenMax) || def.greenMax);
    const y = Math.max(g + 0.1, Number(merged.yellowMax) || def.yellowMax);
    const r = Math.max(y + 0.1, Number(merged.redMax) || def.redMax);

    return { greenMax: g, yellowMax: y, redMax: r };
  }

  function bucketForScore(score, role) {
    const s = Number(score) || 0;
    const t = getThresholdsForLive(role === "pca" ? "pca" : "nurse");
    const x = clamp(s, 0, t.redMax);

    if (x <= t.greenMax) return "green";
    if (x <= t.yellowMax) return "yellow";
    return "red";
  }

  function accentStyleForBucket(bucket) {
    if (bucket === "red") return "border-left:6px solid rgba(239,68,68,0.85);";
    if (bucket === "yellow") return "border-left:6px solid rgba(245,158,11,0.90);";
    return "border-left:6px solid rgba(16,185,129,0.80);";
  }

  function resolveLiveVisual(loadScore, role) {
    let upstreamClass = "";
    try {
      if (typeof window.getLoadClass === "function") {
        upstreamClass = String(window.getLoadClass(loadScore, role) || "").trim();
      }
    } catch {}

    const upstreamBucket = normalizeBucketFromClass(upstreamClass);
    const strictBucket = bucketForScore(loadScore, role);

    const bucket =
      upstreamBucket === "red"
        ? "red"
        : upstreamBucket === "yellow" && strictBucket !== "red"
        ? "yellow"
        : strictBucket;

    return {
      upstreamClass,
      bucket,
      accentStyle: accentStyleForBucket(bucket),
    };
  }

  function getRoomNumberSafe(p) {
    try {
      if (typeof window.getRoomNumber === "function") return window.getRoomNumber(p);
    } catch {}
    const m = String(p?.room || "").match(/(\d+)/);
    return m ? Number(m[1]) : 9999;
  }

  function getPatientByIdSafe(id) {
    try {
      if (typeof window.getPatientById === "function") return window.getPatientById(id);
    } catch {}
    return null;
  }

  function getActivePatientsForLive() {
    try {
      if (typeof window.ensureDefaultPatients === "function") window.ensureDefaultPatients();
    } catch {}
    return safeArray(window.patients).filter((p) => p && !p.isEmpty);
  }

  // -----------------------------
  // Print button helpers
  // -----------------------------
  function openPrintLiveSafe() {
    try {
      if (window.printLive && typeof window.printLive.open === "function") {
        window.printLive.open();
        return;
      }
      alert("Print LIVE is not ready. Ensure app.printLive.js is loaded (script order + refresh).");
    } catch (e) {
      console.error("[live print] open failed:", e);
      alert("Print LIVE failed. See console for details.");
    }
  }
  window.openPrintLive = openPrintLiveSafe;

  // -----------------------------
  // Inline Admit Queue (LIVE)
  // -----------------------------
  function callQueueAddNoPrompt(label) {
    const name = (String(label || "").trim() || "New Admit").slice(0, 80);

    // Preferred canonical API (app.queue.js) — we will implement this there:
    // window.addAdmitToQueue(name)
    try {
      if (typeof window.addAdmitToQueue === "function") {
        window.addAdmitToQueue(name);
        return true;
      }
    } catch (e) {
      console.warn("[queue] addAdmitToQueue failed", e);
    }

    // Back-compat legacy (app.admitQueue.js)
    try {
      if (typeof window.addToAdmitQueue === "function") {
        window.addToAdmitQueue(name);
        return true;
      }
    } catch (e) {
      console.warn("[queue] addToAdmitQueue failed", e);
    }

    return false;
  }

  function callQueueRender() {
    // Preferred canonical render in app.queue.js: window.renderAdmitQueueList()
    try {
      if (typeof window.renderAdmitQueueList === "function") {
        window.renderAdmitQueueList();
        return;
      }
    } catch (e) {
      console.warn("[queue] renderAdmitQueueList failed", e);
    }

    // Back-compat legacy
    try {
      if (typeof window.renderQueueList === "function") {
        window.renderQueueList();
        return;
      }
    } catch (e) {
      console.warn("[queue] renderQueueList failed", e);
    }
  }

  // NEW: Admit queue inline host (dock near Print LIVE, horizontal list)
  function ensureAdmitQueueInlineHost(liveTabEl, nurseContainerEl) {
    if (!liveTabEl) return;

    // Remove any duplicate queueList targets elsewhere (legacy panel usually creates one)
    // Keep the one we control (inside admitQueueInlineHost).
    const existingTargets = Array.from(document.querySelectorAll("#queueList"));
    existingTargets.forEach((el) => {
      const insideOurHost = !!el.closest("#admitQueueInlineHost");
      if (!insideOurHost) {
        try {
          el.remove();
        } catch (_) {}
      }
    });

    // We want the queue bar ABOVE the RN cards, not floating in the title row.
    // So we anchor it at the top of the RN container area when possible.
    const anchor = nurseContainerEl || liveTabEl;

    let host = document.getElementById("admitQueueInlineHost");
    if (!host) {
      host = document.createElement("div");
      host.id = "admitQueueInlineHost";
      host.style.cssText = `
        width:100%;
        margin: 0 0 12px 0;
        pointer-events:auto;
      `;
    }

    // Place host just before the RN container
    if (nurseContainerEl && nurseContainerEl.parentNode) {
      if (nurseContainerEl.previousSibling !== host) {
        nurseContainerEl.parentNode.insertBefore(host, nurseContainerEl);
      }
    } else {
      // Fallback: top of live tab
      if (!liveTabEl.contains(host)) liveTabEl.insertBefore(host, liveTabEl.firstChild);
    }

    host.innerHTML = `
      <div style="
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        padding:10px 12px;
        border-radius:14px;
        border:1px solid rgba(15,23,42,0.10);
        background:rgba(255,255,255,0.92);
        box-shadow: 0 6px 18px rgba(0,0,0,.08);
      ">
        <div style="display:flex;align-items:center;gap:10px;min-width:280px;">
          <div style="font-weight:900;white-space:nowrap;">Admit Queue</div>
          <input id="admitQueueNewLabel" type="text" placeholder="Add admit name…"
            style="padding:9px 10px;border:1px solid rgba(15,23,42,0.15);border-radius:10px;min-width:190px;" />
          <button id="btnAddAdmitQueue" type="button"
            style="border:0;background:#111;color:#fff;padding:10px 12px;border-radius:10px;cursor:pointer;font-weight:900;">
            + Add
          </button>
        </div>

        <div style="flex:1;min-width:0;">
          <div id="queueList" style="
            display:flex;
            gap:10px;
            overflow:auto;
            padding:2px 2px 2px 2px;
            scroll-snap-type:x proximity;
          "></div>
        </div>
      </div>
    `;

    const input = document.getElementById("admitQueueNewLabel");
    const btn = document.getElementById("btnAddAdmitQueue");

    if (btn && !btn.__wired) {
      btn.__wired = true;

      const doAdd = () => {
        const label = (input && input.value ? String(input.value).trim() : "") || "New Admit";
        const ok = callQueueAddNoPrompt(label);
        if (!ok) {
          alert("Admit Queue add is not available yet (queue module not loaded). Check script order / refresh.");
        }
        if (input) input.value = "";
      };

      btn.addEventListener("click", doAdd);

      if (input) {
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            doAdd();
          }
        });
      }
    }

    // Render into this host
    callQueueRender();
  }

  function ensureLivePrintButtonHost(nurseContainer) {
    if (!nurseContainer) return;

    const cs = window.getComputedStyle ? window.getComputedStyle(nurseContainer) : null;
    if (!cs || cs.position === "static") {
      nurseContainer.style.position = "relative";
    }

    let host = document.getElementById("livePrintBtnHost");
    if (!host) {
      host = document.createElement("div");
      host.id = "livePrintBtnHost";
      host.style.cssText = `
        position:absolute;
        top:-44px;
        right:0;
        z-index: 50;
        display:flex;
        gap:10px;
        align-items:center;
        justify-content:flex-end;
        pointer-events:none;
      `;
      nurseContainer.appendChild(host);
    }

    host.innerHTML = `
      <button
        type="button"
        onclick="openPrintLive()"
        style="
          pointer-events:auto;
          border:0;
          background:#111;
          color:#fff;
          padding:10px 12px;
          border-radius:12px;
          cursor:pointer;
          font-weight:800;
          letter-spacing:.01em;
          box-shadow: 0 6px 18px rgba(0,0,0,.14);
        "
        title="Print LIVE assignments"
      >
        Print LIVE
      </button>
    `;
  }

  // -----------------------------
  // Rule flag helpers
  // -----------------------------
  function getRuleEvalMap(ownersAll, role) {
    try {
      if (typeof window.evaluateAssignmentHardRules === "function") {
        return window.evaluateAssignmentHardRules(ownersAll, role);
      }
    } catch (e) {
      console.warn("[live rules] evaluateAssignmentHardRules failed", e);
    }
    return null;
  }

  function getOwnerEval(owner, evalMap) {
    if (!owner || !evalMap) return null;
    const key = owner?.name || owner?.label || null;
    if (key && evalMap[key]) return evalMap[key];
    if (key) {
      const keys = Object.keys(evalMap);
      const found = keys.find((k) => String(k).toLowerCase() === String(key).toLowerCase());
      if (found) return evalMap[found];
    }
    return null;
  }

  function buildRuleTitle(ownerEval, roleLabel) {
    if (!ownerEval) return "";
    const v = safeArray(ownerEval.violations);
    const w = safeArray(ownerEval.warnings);
    if (!v.length && !w.length) return "";

    const parts = [];
    if (v.length) parts.push(`Avoidable rule breaks (${v.length})`);
    if (w.length) parts.push(`Unavoidable stacks (${w.length})`);

    const detail = [];
    v.forEach((x) => detail.push(x?.message || `${roleLabel} rule: ${x?.tag} stacked (${x?.mine} > ${x?.limit})`));
    w.forEach((x) =>
      detail.push(x?.message || `${roleLabel} stack (likely unavoidable): ${x?.tag} (${x?.mine} > ${x?.limit})`)
    );

    const header = parts.join(" • ");
    const body = detail.length ? ` • ${detail.join(" • ")}` : "";
    return `${header}${body}`;
  }

  function buildRuleIconHtml(ownerEval, roleLabel) {
    if (!ownerEval) return "";
    const v = safeArray(ownerEval.violations);
    const w = safeArray(ownerEval.warnings);
    if (!v.length && !w.length) return "";

    const cls = v.length ? "flag-bad" : "flag-warn";
    const title = buildRuleTitle(ownerEval, roleLabel);
    return `<button class="icon-btn ${cls}" type="button" title="${escapeHtml(title)}">!</button>`;
  }

  // -----------------------------
  // Empty-owner drop zone (LIVE)
  // -----------------------------
  function buildEmptyDropZoneHtml(boardKey, role, ownerId, label) {
    return `
      <div
        class="empty-live-drop"
        ondragover="onRowDragOver(event)"
        ondrop="onRowDrop(event, '${boardKey}', '${role}', ${Number(ownerId)})"
        style="
          margin:10px 12px 12px 12px;
          padding:14px 12px;
          border:1px dashed rgba(15,23,42,0.25);
          border-radius:12px;
          text-align:center;
          font-size:12px;
          opacity:0.75;
          user-select:none;
        "
        title="Drop a patient here"
      >
        Drop a patient here to assign to this ${escapeHtml(label)}
      </div>
    `;
  }

  // -----------------------------
  // Discharge Bin: accept drop ANYWHERE in the bin card
  // -----------------------------
  function hardenDischargeBinDropTarget() {
    const card = document.getElementById("dischargeBinCard");
    const zone = document.getElementById("dischargeDropZone");
    if (!card) return;

    const onOver = (e) => {
      try {
        if (typeof window.onDischargeDragOver === "function") window.onDischargeDragOver(e);
        else e.preventDefault();
      } catch {
        e.preventDefault();
      }
    };

    const onDrop = (e) => {
      try {
        if (typeof window.onDischargeDrop === "function") window.onDischargeDrop(e);
      } catch (err) {
        console.warn("[discharge] drop failed", err);
      }
    };

    if (!card.__dropHardened) {
      card.__dropHardened = true;
      card.ondragover = onOver;
      card.ondrop = onDrop;
    }

    if (zone && !zone.__dropHardened) {
      zone.__dropHardened = true;
      zone.ondragover = onOver;
      zone.ondrop = onDrop;
      zone.style.minHeight = "140px";
      zone.style.display = "flex";
      zone.style.alignItems = "center";
      zone.style.justifyContent = "center";
    }
  }

  // -----------------------------
  // Discharge Bin injection fallback
  // -----------------------------
  function injectDischargeBinFallback() {
    const slot = document.getElementById("rnGridSlot9");
    if (!slot) return;
    if (document.getElementById("dischargeBinCard")) return;

    slot.innerHTML = `
      <div id="dischargeBinCard" class="assignment-card discharge-card">
        <div class="assignment-header discharge-card-header">
          <div><strong>Discharge Bin</strong></div>
          <button onclick="clearRecentlyDischargedFlags()">Clear “Recently Discharged” Flags</button>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;">
          <div><strong>Recent:</strong> <span id="dischargeCount">0</span> this session</div>
          <button onclick="openDischargeHistoryModal()">View History</button>
        </div>

        <div
          id="dischargeDropZone"
          class="discharge-drop-zone"
          ondragover="onDischargeDragOver(event)"
          ondrop="onDischargeDrop(event)"
          style="margin:0 12px 12px 12px;"
        >
          Drag here to discharge patient
        </div>
      </div>
    `;

    hardenDischargeBinDropTarget();
  }

  // -----------------------------
  // Live populate
  // -----------------------------
  function populateLiveAssignment(randomize = false) {
    try {
      if (typeof window.ensureDefaultPatients === "function") window.ensureDefaultPatients();
    } catch {}

    const currentNurses = safeArray(window.currentNurses);
    const currentPcas = safeArray(window.currentPcas);

    if (!currentNurses.length || !currentPcas.length) {
      alert("Please set up Current RNs and PCAs on the Staffing Details tab first.");
      return;
    }

    const activePatients = getActivePatientsForLive();
    if (!activePatients.length) {
      alert("No active patients found.");
      return;
    }

    let list = activePatients.slice();
    if (randomize) list.sort(() => Math.random() - 0.5);
    else list.sort((a, b) => getRoomNumberSafe(a) - getRoomNumberSafe(b));

    currentNurses.forEach((n) => {
      n.patients = [];
    });
    currentPcas.forEach((p) => {
      p.patients = [];
    });

    if (typeof window.distributePatientsEvenly === "function") {
      window.distributePatientsEvenly(currentNurses, list, { randomize, role: "nurse" });
      window.distributePatientsEvenly(currentPcas, list, { randomize, role: "pca" });
    } else {
      list.forEach((p, i) => {
        const rn = currentNurses[i % currentNurses.length];
        rn.patients = safeArray(rn.patients);
        rn.patients.push(p.id);
      });
      list.forEach((p, i) => {
        const pc = currentPcas[i % currentPcas.length];
        pc.patients = safeArray(pc.patients);
        pc.patients.push(p.id);
      });
    }

    window.currentNurses = currentNurses;
    window.currentPcas = currentPcas;

    if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    try {
      if (typeof window.updateAcuityTiles === "function") window.updateAcuityTiles();
    } catch {}
    try {
      if (typeof window.renderPatientList === "function") window.renderPatientList();
    } catch {}
    try {
      if (typeof window.saveState === "function") window.saveState();
    } catch {}
    try {
      if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
    } catch {}
  }

  // -----------------------------
  // Live render
  // -----------------------------
  function renderLiveAssignments() {
    const nurseContainer = document.getElementById("liveNurseAssignments");
    const pcaContainer = document.getElementById("livePcaAssignments");
    if (!nurseContainer || !pcaContainer) return;

    const currentNurses = safeArray(window.currentNurses);
    const currentPcas = safeArray(window.currentPcas);

    nurseContainer.innerHTML = "";
    pcaContainer.innerHTML = "";

    // IMPORTANT: print host is positioned relative to the RN container
    ensureLivePrintButtonHost(nurseContainer);

    // IMPORTANT: inline queue should render above RN tiles (scrollable row)
    const liveTabEl = document.getElementById("liveAssignmentTab");
    ensureAdmitQueueInlineHost(liveTabEl, nurseContainer);

    const rnEvalMap = getRuleEvalMap(currentNurses, "nurse");
    const pcaEvalMap = getRuleEvalMap(currentPcas, "pca");

    // ---- RNs ----
    currentNurses.forEach((nurse) => {
      const pts = safeArray(nurse.patients)
        .map((id) => getPatientByIdSafe(id))
        .filter((p) => p && !p.isEmpty)
        .sort((a, b) => getRoomNumberSafe(a) - getRoomNumberSafe(b));

      const loadScore = typeof window.getNurseLoadScore === "function" ? window.getNurseLoadScore(nurse) : 0;

      const vis = resolveLiveVisual(loadScore, "nurse");
      const loadClass = vis.upstreamClass;
      const accentStyle = vis.accentStyle;

      const ownerEval = getOwnerEval(nurse, rnEvalMap);
      const ruleIcon = buildRuleIconHtml(ownerEval, "RN");

      let rows = "";
      pts.forEach((p) => {
        rows += `
          <tr
            draggable="true"
            ondragstart="onRowDragStart(event, 'live', 'nurse', ${nurse.id}, ${p.id})"
            ondragend="onRowDragEnd(event)"
            ondblclick="openPatientProfileFromRoom(${p.id})"
          >
            <td>${p.room || ""}</td>
            <td>${p.tele ? "Tele" : "MS"}</td>
            <td>${typeof window.rnTagString === "function" ? window.rnTagString(p) : ""}</td>
          </tr>
        `;
      });

      const emptyDrop = !pts.length ? buildEmptyDropZoneHtml("live", "nurse", nurse.id, "RN") : "";

      nurseContainer.innerHTML += `
        <div class="assignment-card ${escapeHtml(loadClass)}" style="${accentStyle}">
          <div class="assignment-header">
            <div style="display:flex;align-items:flex-start;gap:10px;">
              <div>
                <strong>${nurse.name}</strong> (${String(nurse.type || "").toUpperCase()})
              </div>
              <div class="icon-row">
                ${ruleIcon}
              </div>
            </div>
            <div>Patients: ${pts.length} | Load Score: ${loadScore}</div>
          </div>

          <table class="assignment-table">
            <thead>
              <tr>
                <th>Room</th>
                <th>Level</th>
                <th>Acuity Notes</th>
              </tr>
            </thead>
            <tbody
              ondragover="onRowDragOver(event)"
              ondrop="onRowDrop(event, 'live', 'nurse', ${nurse.id})"
            >
              ${rows}
            </tbody>
          </table>

          ${emptyDrop}
        </div>
      `;
    });

    nurseContainer.innerHTML += `<div id="rnGridSlot9" class="rn-grid-slot-9"></div>`;

    if (typeof window.ensureDischargeBinInRnGrid === "function") {
      try {
        window.ensureDischargeBinInRnGrid();
      } catch (e) {
        console.warn("[discharge] ensureDischargeBinInRnGrid failed, using fallback", e);
        injectDischargeBinFallback();
      }
    } else {
      injectDischargeBinFallback();
    }

    // Ensure bin is droppable anywhere even if it came from the “real” builder
    try {
      hardenDischargeBinDropTarget();
    } catch (_) {}

    // ---- PCAs ----
    currentPcas.forEach((pca) => {
      const pts = safeArray(pca.patients)
        .map((id) => getPatientByIdSafe(id))
        .filter((p) => p && !p.isEmpty)
        .sort((a, b) => getRoomNumberSafe(a) - getRoomNumberSafe(b));

      const loadScore = typeof window.getPcaLoadScore === "function" ? window.getPcaLoadScore(pca) : 0;

      const vis = resolveLiveVisual(loadScore, "pca");
      const loadClass = vis.upstreamClass;
      const accentStyle = vis.accentStyle;

      const ownerEval = getOwnerEval(pca, pcaEvalMap);
      const ruleIcon = buildRuleIconHtml(ownerEval, "PCA");

      let rows = "";
      pts.forEach((p) => {
        rows += `
          <tr
            draggable="true"
            ondragstart="onRowDragStart(event, 'live', 'pca', ${pca.id}, ${p.id})"
            ondragend="onRowDragEnd(event)"
            ondblclick="openPatientProfileFromRoom(${p.id})"
          >
            <td>${p.room || ""}</td>
            <td>${p.tele ? "Tele" : "MS"}</td>
            <td>${typeof window.pcaTagString === "function" ? window.pcaTagString(p) : ""}</td>
          </tr>
        `;
      });

      const emptyDrop = !pts.length ? buildEmptyDropZoneHtml("live", "pca", pca.id, "PCA") : "";

      pcaContainer.innerHTML += `
        <div class="assignment-card ${escapeHtml(loadClass)}" style="${accentStyle}">
          <div class="assignment-header">
            <div style="display:flex;align-items:flex-start;gap:10px;">
              <div>
                <strong>${pca.name}</strong> (PCA)
              </div>
              <div class="icon-row">
                ${ruleIcon}
              </div>
            </div>
            <div>Patients: ${pts.length} | Load Score: ${loadScore}</div>
          </div>

          <table class="assignment-table">
            <thead>
              <tr>
                <th>Room</th>
                <th>Level</th>
                <th>Acuity Notes</th>
              </tr>
            </thead>
            <tbody
              ondragover="onRowDragOver(event)"
              ondrop="onRowDrop(event, 'live', 'pca', ${pca.id})"
            >
              ${rows}
            </tbody>
          </table>

          ${emptyDrop}
        </div>
      `;
    });

    try {
      if (typeof window.updateDischargeCount === "function") window.updateDischargeCount();
    } catch {}
  }

  function autoPopulateLiveAssignments() {
    try {
      if (typeof window.ensureDefaultPatients === "function") window.ensureDefaultPatients();
    } catch {}

    const currentNurses = safeArray(window.currentNurses);
    const currentPcas = safeArray(window.currentPcas);

    const anyAssigned =
      currentNurses.some((n) => safeArray(n.patients).length > 0) || currentPcas.some((p) => safeArray(p.patients).length > 0);

    if (anyAssigned) return;

    const activePatients = safeArray(window.patients).filter((p) => p && !p.isEmpty);
    if (!activePatients.length) return;

    populateLiveAssignment(false);
  }

  window.populateLiveAssignment = populateLiveAssignment;
  window.autoPopulateLiveAssignments = autoPopulateLiveAssignments;
  window.renderLiveAssignments = renderLiveAssignments;

  window.__liveAssignmentsBuild =
    "admitQueueInlineHostHorizontal+prefersAddAdmitToQueue+dischargeBinDropAnywhere-v9";
})();