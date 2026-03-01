// app/app.liveAssignments.js
// ---------------------------------------------------------
// LIVE Assignment engine + rendering (Current shift only)
//
// PATCH (Jan 2026 -> refined):
// - Admit Queue is mounted higher INSIDE the LIVE page (near Print LIVE)
// - Inline queue uses app.queue.js canonical API when present (do-no-harm fallback)
// - Queue renders HORIZONTALLY above RN tiles (scrollable)
// - Discharge Bin accepts drop ANYWHERE within the bin card
//
// ✅ NEW (v11.4):
// - Discharge Bin is FIXED (does not scroll) and never reserves layout space
// - Discharge Bin shows ONLY on LIVE Assignment tab
// - Restore RN/PCA per-card remove "X" (never on HOLD card)
// - HOLD bucket ("Needs to be assigned") is NOT a real staff card:
//   - Only shows when there are unassigned active patients
//   - Always captures orphaned patients if an RN/PCA is removed
//   - Patients in HOLD can be dragged to staff (since HOLD lives in arrays with id=0)
// - Add RN / Add PCA buttons live near RN and PCA rows in LIVE
// - Hide legacy Admit Queue section between RN and PCA (keep only inline horizontal queue)
//
// ✅ PATCH (Jan 2026 - Staffing sync contract):
// - When LIVE adds/removes RN/PCA, also sync Staffing Details lists + totals
//   so Staffing Details reflects the new staff immediately.
//
// ✅ PATCH (Jan 2026 - Option A UI):
// - Move "+ Add RN" and "+ Add PCA" INTO the section header bars,
//   directly adjacent to "Current RN Assignments" / "Current PCA Assignments".
// - Do-no-harm: also hide any legacy/floating Add buttons inside LIVE that
//   are not inside our header hosts.
//
// ✅ PATCH (Feb 2026 - performance hardening):
// - Remove repeated Discharge Bin re-render loops (RAF/timeout duplication)
// - Single-flight mount loop only (ensureDischargeBinMountedSoon)
// - Never call updateDischargeCount from render paths
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
  function isDischargeBinTabActive() {
    const activeTarget = document.querySelector(".tabButton.active[data-target]")?.getAttribute("data-target");
    if (activeTarget) {
      return activeTarget === "liveAssignmentTab" || activeTarget === "oncomingAssignmentTab";
    }

    const isVisible = (id) => {
      const el = document.getElementById(id);
      if (!el) return false;
      const cs = window.getComputedStyle(el);
      if (!cs) return false;
      return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
    };

    return isVisible("liveAssignmentTab") || isVisible("oncomingAssignmentTab");
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
      role === "pca"
        ? { greenMax: 14, yellowMax: 22, redMax: 32 }
        : { greenMax: 10, yellowMax: 16, redMax: 26 };

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

  function getRoomPairKeyForSitter(p) {
    const room = String(p?.room || p?.id || "").trim();
    const m = room.match(/^(\d+)/);
    return m ? m[1] : room;
  }

  function applyPcaSitterDesignations(pcas, activePatients) {
    const owners = safeArray(pcas);
    const pts = safeArray(activePatients);
    const pinned = new Set();

    owners.forEach((pca) => {
      const pair = String(pca?.sitterRoomPair || "").trim();
      const isSitterPca = !!pca?.isSitter && !!pair;
      if (!isSitterPca) return;

      const hits = pts
        .filter((p) => p && !p.isEmpty && !!p.sitter && getRoomPairKeyForSitter(p) === pair)
        .sort((a, b) => getRoomNumberSafe(a) - getRoomNumberSafe(b))
        .slice(0, 2)
        .map((p) => Number(p.id))
        .filter(Number.isFinite);

      pca.patients = Array.from(new Set(hits));
      pca.maxPatients = 2;
      pca.patients.forEach((id) => pinned.add(id));
    });

    return pinned;
  }

  // -----------------------------
  // HOLD bucket helpers (id=0)
  // -----------------------------
  function isHoldOwner(owner) {
    if (!owner) return false;
    if (owner.isHold === true) return true;
    const name = String(owner.name || "");
    const type = String(owner.type || "");
    if (Number(owner.id) === 0) return true;
    if (/needs\s*to\s*be\s*assigned/i.test(name)) return true;
    if (/hold/i.test(type)) return true;
    return false;
  }

  function ensureHoldOwnerForRole(role) {
    const key = role === "pca" ? "currentPcas" : "currentNurses";
    const arr = safeArray(window[key]);

    const id0 = arr.find((x) => Number(x?.id) === 0);
    if (id0 && !isHoldOwner(id0)) {
      const maxId = arr.reduce((m, x) => Math.max(m, Number(x?.id) || 0), 0);
      id0.id = maxId + 1;
    }

    let hold = arr.find((x) => isHoldOwner(x));
    if (!hold) {
      hold = {
        id: 0,
        name: role === "pca" ? "Needs to be assigned (PCA)" : "Needs to be assigned (HOLD)",
        type: "HOLD",
        isHold: true,
        patients: [],
      };
      arr.unshift(hold);
    } else {
      hold.id = 0;
      hold.isHold = true;
      hold.type = "HOLD";
      hold.patients = safeArray(hold.patients);
      const idx = arr.indexOf(hold);
      if (idx > 0) {
        arr.splice(idx, 1);
        arr.unshift(hold);
      }
    }

    window[key] = arr;
    return hold;
  }

  function computeAssignedIds(role) {
    const key = role === "pca" ? "currentPcas" : "currentNurses";
    const owners = safeArray(window[key]).filter((o) => o && !isHoldOwner(o));
    const set = new Set();
    owners.forEach((o) => {
      safeArray(o.patients).forEach((id) => set.add(Number(id)));
    });
    return set;
  }

  function syncHoldPatients(role) {
    const hold = ensureHoldOwnerForRole(role);
    const active = getActivePatientsForLive().map((p) => Number(p.id));
    const activeSet = new Set(active);

    const assigned = computeAssignedIds(role);
    const unassigned = active.filter((id) => !assigned.has(id));

    hold.patients = unassigned.filter((id) => activeSet.has(id));
    return hold;
  }

  // -----------------------------
  // ✅ Staffing Details sync (from LIVE adds/removes)
  // -----------------------------
  function countNonHoldOwners(arr) {
    return safeArray(arr).filter((o) => o && !isHoldOwner(o)).length;
  }

  function setSelectValueIfPresent(selectId, value) {
    const sel = document.getElementById(selectId);
    if (!sel) return false;
    try {
      const v = String(value);
      sel.value = v;
      return sel.value === v;
    } catch {
      return false;
    }
  }

  function syncStaffingDetailsFromLive(role) {
    try {
      if (role === "nurse") {
        const rnCount = countNonHoldOwners(window.currentNurses);
        setSelectValueIfPresent("currentNurseCount", rnCount);

        if (typeof window.setupCurrentNurses === "function") {
          try {
            window.setupCurrentNurses(rnCount);
          } catch {
            try {
              window.setupCurrentNurses();
            } catch {}
          }
          return;
        }

        if (typeof window.renderCurrentNurseList === "function") {
          window.renderCurrentNurseList();
          return;
        }
      }

      if (role === "pca") {
        const pcaCount = countNonHoldOwners(window.currentPcas);
        setSelectValueIfPresent("currentPcaCount", pcaCount);

        if (typeof window.setupCurrentPcas === "function") {
          try {
            window.setupCurrentPcas(pcaCount);
          } catch {
            try {
              window.setupCurrentPcas();
            } catch {}
          }
          return;
        }

        if (typeof window.renderCurrentPcaList === "function") {
          window.renderCurrentPcaList();
          return;
        }
      }
    } catch (e) {
      console.warn("[LIVE->Staffing sync] failed", e);
    }
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

    try {
      if (typeof window.addAdmitToQueue === "function") {
        window.addAdmitToQueue(name);
        return true;
      }
    } catch (e) {
      console.warn("[queue] addAdmitToQueue failed", e);
    }

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
    try {
      if (typeof window.renderAdmitQueueList === "function") {
        window.renderAdmitQueueList();
        return;
      }
    } catch (e) {
      console.warn("[queue] renderAdmitQueueList failed", e);
    }

    try {
      if (typeof window.renderQueueList === "function") {
        window.renderQueueList();
        return;
      }
    } catch (e) {
      console.warn("[queue] renderQueueList failed", e);
    }
  }

  function ensureAdmitQueueInlineHost(liveTabEl, nurseContainerEl) {
    if (!liveTabEl) return;

    const existingTargets = Array.from(document.querySelectorAll("#queueList"));
    existingTargets.forEach((el) => {
      const insideOurHost = !!el.closest("#admitQueueInlineHost");
      if (!insideOurHost) {
        try {
          el.remove();
        } catch (_) {}
      }
    });

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

    if (nurseContainerEl && nurseContainerEl.parentNode) {
      if (nurseContainerEl.previousSibling !== host) {
        nurseContainerEl.parentNode.insertBefore(host, nurseContainerEl);
      }
    } else {
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

    callQueueRender();
  }

  // -----------------------------
  // Hide legacy Admit Queue panel between RN and PCA (LIVE only)
  // -----------------------------
  function hideLegacyAdmitQueuePanel() {
    const ids = [
      "admitQueuePanel",
      "admitQueueContainer",
      "legacyAdmitQueue",
      "admitQueueSection",
      "admitQueueTabPanel",
    ];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el && !el.closest("#admitQueueInlineHost")) {
        el.style.display = "none";
      }
    });

    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,div,span"))
      .filter((el) => {
        const t = (el.textContent || "").trim();
        return t && t.toLowerCase() === "admit queue";
      })
      .filter((el) => !el.closest("#admitQueueInlineHost"));

    headings.forEach((h) => {
      const block = h.closest("section, .panel, .card, .container, div") || h;
      if (block && !block.closest("#admitQueueInlineHost")) {
        if (document.getElementById("liveAssignmentTab")?.contains(block)) {
          block.style.display = "none";
        }
      }
    });

    const btns = Array.from(document.querySelectorAll("button, a"))
      .filter((b) => ((b.textContent || "").trim().toLowerCase() === "+ add admit"))
      .filter((b) => !b.closest("#admitQueueInlineHost"));
    btns.forEach((b) => {
      const block = b.closest("section, .panel, .card, .container, div") || b;
      if (block && document.getElementById("liveAssignmentTab")?.contains(block)) {
        block.style.display = "none";
      }
    });
  }

  // -----------------------------
  // ✅ Add / Remove RN/PCA in LIVE
  // -----------------------------
  function nextOwnerId(arr) {
    const maxId = safeArray(arr).reduce((m, x) => Math.max(m, Number(x?.id) || 0), 0);
    return maxId + 1;
  }

  function addOwnerFallback(role) {
    const key = role === "pca" ? "currentPcas" : "currentNurses";
    const arr = safeArray(window[key]);

    const label = role === "pca" ? "PCA name (Current shift):" : "RN name (Current shift):";
    const suggested =
      role === "pca"
        ? `Current PCA ${arr.filter((o) => !isHoldOwner(o)).length + 1}`
        : `Current RN ${arr.filter((o) => !isHoldOwner(o)).length + 1}`;
    const name = String(prompt(label, suggested) || "").trim();
    if (!name) return;

    ensureHoldOwnerForRole(role);

    const fresh = safeArray(window[key]);
    const id = nextOwnerId(fresh);

    const newOwner =
      role === "pca"
        ? { id, name, type: "PCA", patients: [] }
        : { id, name, type: "RN", patients: [] };

    fresh.push(newOwner);
    window[key] = fresh;

    try {
      syncStaffingDetailsFromLive(role === "pca" ? "pca" : "nurse");
    } catch {}

    try {
      if (typeof window.saveState === "function") window.saveState();
    } catch {}
    try {
      if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    } catch {}
  }

  function handleAddOwner(role) {
    try {
      if (role === "pca" && typeof window.promptAddPCA === "function") {
        const out = window.promptAddPCA();
        try {
          syncStaffingDetailsFromLive("pca");
        } catch {}
        return out;
      }
      if (role === "nurse" && typeof window.promptAddRN === "function") {
        const out = window.promptAddRN();
        try {
          syncStaffingDetailsFromLive("nurse");
        } catch {}
        return out;
      }
      if (role === "nurse" && typeof window.promptAddCurrentRN === "function") {
        const out = window.promptAddCurrentRN();
        try {
          syncStaffingDetailsFromLive("nurse");
        } catch {}
        return out;
      }
      if (role === "pca" && typeof window.promptAddCurrentPCA === "function") {
        const out = window.promptAddCurrentPCA();
        try {
          syncStaffingDetailsFromLive("pca");
        } catch {}
        return out;
      }
    } catch {}

    addOwnerFallback(role === "pca" ? "pca" : "nurse");
  }

  function removeOwner(role, ownerId) {
    const rid = Number(ownerId);
    if (!rid || rid === 0) return;

    const key = role === "pca" ? "currentPcas" : "currentNurses";
    const arr = safeArray(window[key]);

    const hold = ensureHoldOwnerForRole(role === "pca" ? "pca" : "nurse");

    const idx = arr.findIndex((o) => Number(o?.id) === rid);
    if (idx === -1) return;

    const victim = arr[idx];
    const pts = safeArray(victim?.patients).map((x) => Number(x)).filter(Boolean);

    const merged = safeArray(hold.patients).concat(pts);
    hold.patients = Array.from(new Set(merged));

    arr.splice(idx, 1);

    const holdIdx = arr.findIndex((o) => isHoldOwner(o));
    if (holdIdx > 0) {
      const h = arr.splice(holdIdx, 1)[0];
      arr.unshift(h);
    }

    window[key] = arr;

    try {
      syncHoldPatients(role === "pca" ? "pca" : "nurse");
    } catch {}

    try {
      syncStaffingDetailsFromLive(role === "pca" ? "pca" : "nurse");
    } catch {}

    try {
      if (typeof window.saveState === "function") window.saveState();
    } catch {}
    try {
      if (typeof window.renderLiveAssignments === "function") window.renderLiveAssignments();
    } catch {}
  }

  window.removeLiveOwner = removeOwner;

  // -----------------------------
  // Option A: Header controls + hide any legacy Add buttons in LIVE
  // -----------------------------
  function findHeadingByExactText(root, textLower) {
    const nodes = Array.from(root.querySelectorAll("h1,h2,h3,h4,div,span"));
    return nodes.find((el) => (el.textContent || "").trim().toLowerCase() === textLower) || null;
  }

  function hideLegacyLiveAddButtons() {
    const liveTabEl = document.getElementById("liveAssignmentTab");
    if (!liveTabEl) return;

    const btns = Array.from(liveTabEl.querySelectorAll("button, a"));
    const isAddRnText = (t) => {
      const s = String(t || "").trim().toLowerCase();
      return s === "+ add rn" || s === "add rn" || s === "+ add nurse" || s === "add nurse";
    };
    const isAddPcaText = (t) => {
      const s = String(t || "").trim().toLowerCase();
      return s === "+ add pca" || s === "add pca";
    };

    btns.forEach((b) => {
      if (!b) return;
      if (b.closest("#liveRnHeaderControlsHost") || b.closest("#livePcaHeaderControlsHost")) return;

      const txt = (b.textContent || "").trim();
      if (!isAddRnText(txt) && !isAddPcaText(txt)) return;

      const wrap = b.closest(".floating-actions, .actions, .toolbar, .panel, .card, div") || b;
      try {
        const w = (wrap.getBoundingClientRect && wrap.getBoundingClientRect().width) || 0;
        if (w && w > 420) b.style.display = "none";
        else wrap.style.display = "none";
      } catch {
        b.style.display = "none";
      }
    });
  }

  // -----------------------------
  // Header controls hosts (Option A)
  // -----------------------------
  function ensureRnHeaderControlsHost() {
    const liveTabEl = document.getElementById("liveAssignmentTab");
    if (!liveTabEl) return;

    const heading = findHeadingByExactText(liveTabEl, "current rn assignments");
    if (!heading) return;

    let row = document.getElementById("liveRnHeaderRow");
    if (!row) {
      row = document.createElement("div");
      row.id = "liveRnHeaderRow";
      row.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:12px;margin: 6px 0 10px 0;flex-wrap:wrap;";
      heading.parentNode.insertBefore(row, heading);
      row.appendChild(heading);
    } else {
      if (heading.parentNode !== row) {
        try {
          row.insertBefore(heading, row.firstChild);
        } catch {}
      }
    }

    let left = document.getElementById("liveRnHeaderLeft");
    if (!left) {
      left = document.createElement("div");
      left.id = "liveRnHeaderLeft";
      left.style.cssText = "display:flex;align-items:center;gap:10px;min-width:240px;flex-wrap:wrap;";
      row.insertBefore(left, row.firstChild);
      left.appendChild(heading);
    } else {
      if (heading.parentNode !== left) {
        try {
          left.insertBefore(heading, left.firstChild);
        } catch {}
      }
    }

    let host = document.getElementById("liveRnHeaderControlsHost");
    if (!host) {
      host = document.createElement("div");
      host.id = "liveRnHeaderControlsHost";
      host.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;";
      left.appendChild(host);
    }

    let right = document.getElementById("liveRnHeaderRight");
    if (!right) {
      right = document.createElement("div");
      right.id = "liveRnHeaderRight";
      right.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;";
      row.appendChild(right);
    }

    host.innerHTML = `
      <button id="liveAddRnBtn" type="button"
        style="border:1px solid rgba(15,23,42,0.18);background:#fff;color:#111;padding:10px 12px;border-radius:12px;cursor:pointer;font-weight:900;box-shadow:0 6px 18px rgba(0,0,0,0.08);">
        + Add RN
      </button>
    `;

    right.innerHTML = ``;

    const btnAdd = document.getElementById("liveAddRnBtn");
    if (btnAdd && !btnAdd.__wired) {
      btnAdd.__wired = true;
      btnAdd.addEventListener("click", () => handleAddOwner("nurse"));
    }
  }

  function ensurePcaHeaderControlsHost() {
    const liveTabEl = document.getElementById("liveAssignmentTab");
    if (!liveTabEl) return;

    const heading = findHeadingByExactText(liveTabEl, "current pca assignments");
    if (!heading) return;

    let row = document.getElementById("livePcaHeaderRow");
    if (!row) {
      row = document.createElement("div");
      row.id = "livePcaHeaderRow";
      row.style.cssText =
        "display:flex;align-items:center;gap:10px;margin: 18px 0 10px 0;flex-wrap:wrap;";
      heading.parentNode.insertBefore(row, heading);
      row.appendChild(heading);
    } else {
      if (heading.parentNode !== row) {
        try {
          row.insertBefore(heading, row.firstChild);
        } catch {}
      }
    }

    let host = document.getElementById("livePcaHeaderControlsHost");
    if (!host) {
      host = document.createElement("div");
      host.id = "livePcaHeaderControlsHost";
      host.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;";
      row.appendChild(host);
    }

    host.innerHTML = `
      <button id="liveAddPcaBtn" type="button"
        style="border:1px solid rgba(15,23,42,0.18);background:#fff;color:#111;padding:10px 12px;border-radius:12px;cursor:pointer;font-weight:900;box-shadow:0 6px 18px rgba(0,0,0,0.08);">
        + Add PCA
      </button>
    `;

    const btnAdd = document.getElementById("liveAddPcaBtn");
    if (btnAdd && !btnAdd.__wired) {
      btnAdd.__wired = true;
      btnAdd.addEventListener("click", () => handleAddOwner("pca"));
    }
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
    }
  }

  // -----------------------------
  // ✅ Discharge Bin (LIVE-only, never disappears, first-load safe)
  // -----------------------------
  function positionGlobalTopRightToolsNaturally() {
    const tools = document.getElementById("globalTopRightTools");
    if (!tools) return;

    // Stable fixed position prevents drift while toggling tabs.
    tools.style.position = "fixed";
    tools.style.right = "18px";
    tools.style.left = "auto";
    tools.style.bottom = "auto";
    tools.style.width = "auto";
    tools.style.display = "flex";
    tools.style.justifyContent = "flex-end";
    tools.style.padding = "0";
    tools.style.margin = "0";
    tools.style.boxSizing = "border-box";
    tools.style.pointerEvents = "none";
    tools.style.zIndex = "50";

    tools.style.top = "84px";
  }

  function ensureGlobalDischargeBinHost() {
    // Preferred wrapper (exists after header mounts)
    const tools = document.getElementById("globalTopRightTools");
    if (tools) {
      positionGlobalTopRightToolsNaturally();
    }

    // Prefer a real host inside the wrapper if possible
    let host = document.getElementById("globalDischargeBinHost");
    if (!host && tools) {
      host = document.createElement("div");
      host.id = "globalDischargeBinHost";
      tools.appendChild(host);
    }

    // Fallback host for first-load (fixed top-right so user always sees it)
    if (!host) {
      host = document.getElementById("globalDischargeBinHost__fallback");
      if (!host) {
        host = document.createElement("div");
        host.id = "globalDischargeBinHost__fallback";
        document.body.appendChild(host);
      }

      host.style.position = "fixed";
      host.style.top = "10px";
      host.style.right = "18px";
      host.style.zIndex = "999";
      host.style.pointerEvents = "auto";
      host.style.margin = "0";
      host.style.padding = "0";
    } else {
      // Host lives within wrapper; wrapper controls overlay positioning
      host.style.position = "relative";
      host.style.top = "0px";
      host.style.right = "0px";
      host.style.left = "0px";
      host.style.bottom = "0px";
      host.style.zIndex = "10";
      host.style.pointerEvents = "auto";
      host.style.margin = "0";
      host.style.padding = "0";
    }

    return host;
  }

  function hideGlobalDischargeBin() {
    const host =
      document.getElementById("globalDischargeBinHost") ||
      document.getElementById("globalDischargeBinHost__fallback");
    if (!host) return;
    host.style.display = "none";
    host.innerHTML = "";
  }

  function renderGlobalDischargeBin() {
    const host = ensureGlobalDischargeBinHost();
    if (!host) return;

    // ----------------------------------------
    // 1️⃣ Re-home into real tools wrapper if needed (bounded retries)
    // ----------------------------------------
    const tools = document.getElementById("globalTopRightTools");
    if (!tools) {
      const tries = Number(host.__rehomingTries || 0);
      if (tries < 8) {
        host.__rehomingTries = tries + 1;
        setTimeout(() => {
          try {
            renderGlobalDischargeBin();
          } catch (e) {
            window.__lastDischargeBinError = e;
            console.warn("[DischargeBin] renderGlobalDischargeBin failed:", e);
          }
        }, 0);
      }
    } else {
      try {
        positionGlobalTopRightToolsNaturally();
      } catch {}
    }

    // ----------------------------------------
    // 2️⃣ Remove any legacy spacer (prevent layout gaps)
    // ----------------------------------------
    const legacySpacer =
      document.getElementById("liveDischargeSpacer") ||
      document.getElementById("dischargeBinSpacer") ||
      document.getElementById("globalDischargeBinSpacer");

    if (legacySpacer) {
      legacySpacer.style.height = "0px";
      legacySpacer.style.minHeight = "0px";
      legacySpacer.style.margin = "0";
      legacySpacer.style.padding = "0";
    }

    // ----------------------------------------
    // 3️⃣ Handle first-paint visibility race (bounded retries)
    // ----------------------------------------
    if (!isDischargeBinTabActive()) {
      const vTries = Number(host.__visibleTries || 0);

      if (vTries < 4) {
        host.__visibleTries = vTries + 1;
        setTimeout(() => {
          try {
            renderGlobalDischargeBin();
          } catch (e) {
            window.__lastDischargeBinError = e;
            console.warn("[DischargeBin] renderGlobalDischargeBin failed:", e);
          }
        }, 0);
      }

      hideGlobalDischargeBin();
      return;
    }

    // Reset retry counters once successfully visible
    host.__visibleTries = 0;
    host.__rehomingTries = 0;

    host.style.display = "block";

    // ----------------------------------------
    // 4️⃣ Render card (pure render; no count update)
    // ----------------------------------------
    host.innerHTML = `
      <div
        id="dischargeBinCard"
        class="assignment-card discharge-card"
        style="
          width: 220px;
          height: 170px;
          border-radius: 16px;
          box-shadow: 0 10px 24px rgba(0,0,0,0.12);
          overflow:hidden;
          background:#fff;
        "
      >
        <div class="assignment-header discharge-card-header"
             style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
          <div><strong>Discharge Bin</strong></div>
          <button onclick="clearRecentlyDischargedFlags()" style="font-size:12px;">Clear</button>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;">
          <div style="font-size:12px;">
            <strong>Recent:</strong> <span id="dischargeCount">0</span>
          </div>
          <button onclick="openDischargeHistoryModal()" style="font-size:12px;">History</button>
        </div>

        <div
          id="dischargeDropZone"
          class="discharge-drop-zone"
          ondragover="onDischargeDragOver(event)"
          ondrop="onDischargeDrop(event)"
          style="
            margin:0 12px 12px 12px;
            height: 70px;
            border-radius:14px;
            display:flex;
            align-items:center;
            justify-content:center;
            text-align:center;
            font-size:12px;
          "
        >
          Drag here to discharge patient
        </div>
      </div>
    `;

    // ----------------------------------------
    // 5️⃣ Harden drop target
    // ----------------------------------------
    try {
      hardenDischargeBinDropTarget();
    } catch {}
  }

  // -----------------------------
  // Populate live
  // -----------------------------
  function populateLiveAssignment(randomize = false) {
    ensureHoldOwnerForRole("nurse");
    ensureHoldOwnerForRole("pca");

    const currentNursesAll = safeArray(window.currentNurses);
    const currentPcasAll = safeArray(window.currentPcas);
    const currentNurses = currentNursesAll.filter((n) => n && !isHoldOwner(n));
    const currentPcas = currentPcasAll.filter((p) => p && !isHoldOwner(p));

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

    currentNurses.forEach((n) => (n.patients = []));
    currentPcas.forEach((p) => (p.patients = []));

    if (typeof window.distributePatientsEvenly === "function") {
      window.distributePatientsEvenly(currentNurses, list, { randomize, role: "nurse" });
      const pinnedToSitterPcas = applyPcaSitterDesignations(currentPcas, list);
      const pcaPool = list.filter((p) => !pinnedToSitterPcas.has(Number(p?.id)));
      const openPcas = currentPcas.filter((p) => !(p?.isSitter && String(p?.sitterRoomPair || "").trim()));
      if (openPcas.length) {
        window.distributePatientsEvenly(openPcas, pcaPool, { randomize, role: "pca" });
      }
    } else {
      // Fallback only: assignmentRules not loaded. Prefer loading app.assignmentRules.js so load-balanced distribution runs.
      list.forEach((p, i) => {
        const rn = currentNurses[i % currentNurses.length];
        rn.patients = safeArray(rn.patients);
        rn.patients.push(p.id);
      });
      const pinnedToSitterPcas = applyPcaSitterDesignations(currentPcas, list);
      const pcaPool = list.filter((p) => !pinnedToSitterPcas.has(Number(p?.id)));
      const openPcas = currentPcas.filter((p) => !(p?.isSitter && String(p?.sitterRoomPair || "").trim()));
      pcaPool.forEach((p, i) => {
        if (!openPcas.length) return;
        const pc = openPcas[i % openPcas.length];
        pc.patients = safeArray(pc.patients);
        pc.patients.push(p.id);
      });
    }

    const holdRn = ensureHoldOwnerForRole("nurse");
    const holdPca = ensureHoldOwnerForRole("pca");

    window.currentNurses = [holdRn].concat(currentNurses);
    window.currentPcas = [holdPca].concat(currentPcas);

    try {
      syncHoldPatients("nurse");
    } catch {}
    try {
      syncHoldPatients("pca");
    } catch {}

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

    // NOTE: discharge count updates are intentionally NOT render-driven here.
    // They should be handled by commit points / central refresh pipeline.
  }

  function ensureDischargeBinMountedSoon() {
    // Avoid stacking multiple loops
    if (window.__dcBinMountLoopActive) return;
    window.__dcBinMountLoopActive = true;

    let tries = 0;
    const maxTries = 20; // bounded
    const tickDelay = 50;

    const loop = () => {
      tries++;

      try {
        if (typeof isDischargeBinTabActive === "function" && isDischargeBinTabActive()) {
          const card = document.getElementById("dischargeBinCard");
          if (!card) {
            try {
              renderGlobalDischargeBin();
            } catch (e) {
              window.__lastDischargeBinError = e;
              console.warn("[DischargeBin] mount loop render failed:", e);
            }
          }
        }
      } catch {}

      const hasCardNow = !!document.getElementById("dischargeBinCard");
      if (hasCardNow || tries >= maxTries) {
        window.__dcBinMountLoopActive = false;
        return;
      }

      setTimeout(loop, tickDelay);
    };

    setTimeout(loop, 0);
  }

  // -----------------------------
  // Live render
  // -----------------------------
  function renderLiveAssignments() {
    const nurseContainer = document.getElementById("liveNurseAssignments");
    const pcaContainer = document.getElementById("livePcaAssignments");
    if (!nurseContainer || !pcaContainer) return;

    try {
      hideLegacyAdmitQueuePanel();
    } catch {}

    const liveTabEl = document.getElementById("liveAssignmentTab");

    // Header controls near RN and PCA sections (Option A)
    ensureRnHeaderControlsHost();
    ensurePcaHeaderControlsHost();

    try {
      hideLegacyLiveAddButtons();
    } catch {}

    // Build queue first so bin positioning can reference it
    ensureAdmitQueueInlineHost(liveTabEl, nurseContainer);

    // Single-flight: schedule bin mount (do NOT spam renderGlobalDischargeBin directly)
    ensureDischargeBinMountedSoon();

    const holdRn = syncHoldPatients("nurse");
    const holdPca = syncHoldPatients("pca");

    const currentNursesAll = safeArray(window.currentNurses);
    const currentPcasAll = safeArray(window.currentPcas);
    const realNurses = currentNursesAll.filter((n) => n && !isHoldOwner(n));
    const realPcas = currentPcasAll.filter((p) => p && !isHoldOwner(p));

    nurseContainer.innerHTML = "";
    pcaContainer.innerHTML = "";

    const rnEvalMap = getRuleEvalMap(realNurses, "nurse");
    const pcaEvalMap = getRuleEvalMap(realPcas, "pca");

    const holdRnPts = safeArray(holdRn?.patients)
      .map((id) => getPatientByIdSafe(id))
      .filter((p) => p && !p.isEmpty)
      .sort((a, b) => getRoomNumberSafe(a) - getRoomNumberSafe(b));

    if (holdRnPts.length) {
      let rows = "";
      holdRnPts.forEach((p) => {
        rows += `
          <tr
            draggable="true"
            ondragstart="onRowDragStart(event, 'live', 'nurse', 0, ${p.id})"
            ondragend="onRowDragEnd(event)"
            ondblclick="openPatientProfileFromRoom(${p.id})"
          >
            <td>${p.room || ""}</td>
            <td>${p.tele ? "Tele" : "MS"}</td>
            <td>${typeof window.rnTagString === "function" ? window.rnTagString(p) : ""}</td>
          </tr>
        `;
      });

      nurseContainer.innerHTML += `
        <div class="assignment-card" style="border-left:6px solid rgba(100,116,139,0.85); opacity:0.95;">
          <div class="assignment-header">
            <div>
              <strong>${escapeHtml(holdRn.name)}</strong>
            </div>
            <div style="font-weight:700;">Patients: ${holdRnPts.length} | Load Score: 0</div>
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
              ondrop="onRowDrop(event, 'live', 'nurse', 0)"
            >
              ${rows}
            </tbody>
          </table>

          ${buildEmptyDropZoneHtml("live", "nurse", 0, "HOLD")}
        </div>
      `;
    }

    realNurses.forEach((nurse) => {
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

      const removeBtn = `
        <button
          type="button"
          title="Remove RN"
          onclick="removeLiveOwner('nurse', ${Number(nurse.id)})"
          style="
            border:0;
            background:rgba(15,23,42,0.08);
            color:#111;
            width:28px;
            height:28px;
            border-radius:10px;
            cursor:pointer;
            font-weight:900;
            line-height:28px;
            text-align:center;
          "
        >×</button>
      `;

      nurseContainer.innerHTML += `
        <div class="assignment-card ${escapeHtml(loadClass)}" style="${accentStyle}">
          <div class="assignment-header" style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <div>
              <div style="display:flex;align-items:flex-start;gap:10px;">
                <div>
                  <strong>${escapeHtml(nurse.name)}</strong> (${escapeHtml(String(nurse.type || "").toUpperCase())})
                </div>
                <div class="icon-row">${ruleIcon}</div>
              </div>
              <div>Patients: ${pts.length} | Load Score: ${loadScore}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${removeBtn}
            </div>
          </div>

          <table class="assignment-table">
            <thead>
              <tr>
                <th>Room</th>
                <th>Level</th>
                <th>Acuity Notes</th>
              </tr>
            </thead>
            <tbody ondragover="onRowDragOver(event)" ondrop="onRowDrop(event, 'live', 'nurse', ${nurse.id})">
              ${rows}
            </tbody>
          </table>

          ${emptyDrop}
        </div>
      `;
    });

    nurseContainer.innerHTML += `<div id="rnGridSlot9" class="rn-grid-slot-9"></div>`;

    const holdPcaPts = safeArray(holdPca?.patients)
      .map((id) => getPatientByIdSafe(id))
      .filter((p) => p && !p.isEmpty)
      .sort((a, b) => getRoomNumberSafe(a) - getRoomNumberSafe(b));

    if (holdPcaPts.length) {
      let rows = "";
      holdPcaPts.forEach((p) => {
        rows += `
          <tr
            draggable="true"
            ondragstart="onRowDragStart(event, 'live', 'pca', 0, ${p.id})"
            ondragend="onRowDragEnd(event)"
            ondblclick="openPatientProfileFromRoom(${p.id})"
          >
            <td>${p.room || ""}</td>
            <td>${p.tele ? "Tele" : "MS"}</td>
            <td>${typeof window.pcaTagString === "function" ? window.pcaTagString(p) : ""}</td>
          </tr>
        `;
      });

      pcaContainer.innerHTML += `
        <div class="assignment-card" style="border-left:6px solid rgba(100,116,139,0.85); opacity:0.95;">
          <div class="assignment-header">
            <div>
              <strong>${escapeHtml(holdPca.name)}</strong>
            </div>
            <div style="font-weight:700;">Patients: ${holdPcaPts.length} | Load Score: 0</div>
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
              ondrop="onRowDrop(event, 'live', 'pca', 0)"
            >
              ${rows}
            </tbody>
          </table>

          ${buildEmptyDropZoneHtml("live", "pca", 0, "HOLD")}
        </div>
      `;
    }

    realPcas.forEach((pca) => {
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
      const sitterPair = String(pca?.sitterRoomPair || "").trim();
      const isSitterPca = !!pca?.isSitter && !!sitterPair;
      const sitterRoomsLabel = isSitterPca ? `${sitterPair}A, ${sitterPair}B` : "";
      const titleRole = isSitterPca ? "Sitter" : "PCA";

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

      const removeBtn = `
        <button
          type="button"
          title="Remove PCA"
          onclick="removeLiveOwner('pca', ${Number(pca.id)})"
          style="
            border:0;
            background:rgba(15,23,42,0.08);
            color:#111;
            width:28px;
            height:28px;
            border-radius:10px;
            cursor:pointer;
            font-weight:900;
            line-height:28px;
            text-align:center;
          "
        >×</button>
      `;

      pcaContainer.innerHTML += `
        <div class="assignment-card ${escapeHtml(loadClass)}" style="${accentStyle}">
          <div class="assignment-header" style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <div>
              <div style="display:flex;align-items:flex-start;gap:10px;">
                <div>
                  <strong>${escapeHtml(pca.name)}</strong> (${titleRole})${isSitterPca ? ` ${pts.length} | ${escapeHtml(sitterRoomsLabel)}` : ``}
                </div>
                <div class="icon-row">${ruleIcon}</div>
              </div>
              <div>${isSitterPca ? `Load Score: ${loadScore}` : `Patients: ${pts.length} | Load Score: ${loadScore}`}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${removeBtn}
            </div>
          </div>

          <table class="assignment-table">
            <thead>
              <tr>
                <th>Room</th>
                <th>Level</th>
                <th>Acuity Notes</th>
              </tr>
            </thead>
            <tbody ondragover="onRowDragOver(event)" ondrop="onRowDrop(event, 'live', 'pca', ${pca.id})">
              ${rows}
            </tbody>
          </table>

          ${emptyDrop}
        </div>
      `;
    });

    // ✅ Mount Shift Narrative button next to Import Assignment button (LIVE header)
    try {
      window.shiftReport?.mountButtonNextToImport?.();
      setTimeout(() => {
        try {
          window.shiftReport?.mountButtonNextToImport?.();
        } catch {}
      }, 0);
    } catch {}
  }

  function autoPopulateLiveAssignments() {
    try {
      if (typeof window.ensureDefaultPatients === "function") window.ensureDefaultPatients();
    } catch {}

    ensureHoldOwnerForRole("nurse");
    ensureHoldOwnerForRole("pca");

    const currentNursesAll = safeArray(window.currentNurses);
    const currentPcasAll = safeArray(window.currentPcas);

    const anyAssigned =
      currentNursesAll.some((n) => n && !isHoldOwner(n) && safeArray(n.patients).length > 0) ||
      currentPcasAll.some((p) => p && !isHoldOwner(p) && safeArray(p.patients).length > 0);

    if (anyAssigned) return;

    const activePatients = safeArray(window.patients).filter((p) => p && !p.isEmpty);
    if (!activePatients.length) return;

    populateLiveAssignment(false);
  }

  window.populateLiveAssignment = populateLiveAssignment;
  window.autoPopulateLiveAssignments = autoPopulateLiveAssignments;
  window.renderLiveAssignments = renderLiveAssignments;

  // ✅ Debug/diagnostics exports (no behavior change)
  window.renderGlobalDischargeBin = renderGlobalDischargeBin;
  window.ensureGlobalDischargeBinHost = ensureGlobalDischargeBinHost;
  window.hideGlobalDischargeBin = hideGlobalDischargeBin;
  window.syncDischargeBinVisibility = function syncDischargeBinVisibility() {
    try {
      if (isDischargeBinTabActive()) renderGlobalDischargeBin();
      else hideGlobalDischargeBin();
    } catch {}
  };

  window.__liveAssignmentsBuild = "v11.4.5-perfDischargeBinSingleFlight";
})();


