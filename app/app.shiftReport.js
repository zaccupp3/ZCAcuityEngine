// app/app.shiftReport.js
// ---------------------------------------------------------
// ShiftReport = turn normalized events into a readable narrative + summary UI.
//
// - Pulls ONLY from window.shiftLog (keeps layers clean)
// - Does not query Supabase directly
// - Renders a modal report (Phase 0 UI)
// - Can mount a button next to "Import Assignment to LIVE (Photo)" on LIVE page
// - Live refresh while open via "cupp:shiftlog_updated"
//
// Key rule: interpretation layer; can change without risking the ledger.
// ---------------------------------------------------------

(function () {
  if (window.shiftReport && window.shiftReport.__ready) return;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    }[m]));
  }

  function toMs(x) {
    if (x == null) return null;
    if (typeof x === "number") return x;
    if (x instanceof Date) return x.getTime();
    const t = Date.parse(x);
    return Number.isFinite(t) ? t : null;
  }

  function fmtTime(tsMs) {
    const d = new Date(tsMs);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function getRoomLabel(ev) {
    // Your ACUITY_CHANGED payload uses bed:"216B" often.
    const p = ev?.payload || {};
    const r = ev?.room ?? p.room ?? p.bed ?? p.bedLabel ?? "—";
    return String(r || "—");
  }

  function getNames(ev) {
    const rn = (ev && ev.rnName) ? String(ev.rnName).trim() : "";
    const pca = (ev && ev.pcaName) ? String(ev.pcaName).trim() : "";
    return { rn, pca };
  }

  // ---------------------------------------
  // Canonical tag role resolution (do-no-harm)
  // ---------------------------------------
  function normKey(k) {
    return String(k || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[_-]/g, "");
  }

  // Try to reuse existing canonical knowledge in your app if present.
  // Fallback to a conservative default map ONLY if nothing else exists.
  function getRoleForTagKey(rawKey) {
    const key = normKey(rawKey);

    // 1) If your app exposes a classifier, use it
    //    (common patterns we’ve seen: window.getTagRole, window.getAcuityTagRole, etc.)
    const candidates = [
      "getAcuityTagRole",
      "getTagRole",
      "acuityTagRole",
      "tagRoleForKey"
    ];
    for (const fnName of candidates) {
      const fn = window[fnName];
      if (typeof fn === "function") {
        try {
          const out = fn(rawKey);
          const s = String(out || "").toLowerCase();
          if (s.includes("rn") || s.includes("nurse")) return "RN";
          if (s.includes("pca") || s.includes("tech") || s.includes("cna")) return "PCA";
          if (s.includes("both") || s.includes("shared")) return "SHARED";
        } catch {}
      }
    }

    // 2) If your app exposes sets/arrays of keys, use those
    //    (support a few common names)
    const pickSet = (name) => {
      const v = window[name];
      if (v instanceof Set) return v;
      if (Array.isArray(v)) return new Set(v.map(normKey));
      return null;
    };

    const rnOnly =
      pickSet("RN_ONLY_TAGS") ||
      pickSet("rnOnlyTags") ||
      pickSet("rnOnlyKeys") ||
      pickSet("RN_TAG_KEYS") ||
      null;

    const pcaOnly =
      pickSet("PCA_ONLY_TAGS") ||
      pickSet("pcaOnlyTags") ||
      pickSet("pcaOnlyKeys") ||
      pickSet("PCA_TAG_KEYS") ||
      null;

    const shared =
      pickSet("SHARED_TAGS") ||
      pickSet("sharedTags") ||
      pickSet("sharedKeys") ||
      null;

    if (shared && shared.has(key)) return "SHARED";
    if (rnOnly && rnOnly.has(key)) return "RN";
    if (pcaOnly && pcaOnly.has(key)) return "PCA";

    // 3) Conservative fallback (only used if no canonical helpers exist)
    //    Keep this minimal and safe. (You can expand later.)
    const FALLBACK_SHARED = new Set(["tele", "isolation", "iso"]);
    const FALLBACK_RN = new Set(["drip", "nih", "bg", "tf", "ciwa", "cows", "ciwacows", "restraint", "sitter", "vpo"]);
    const FALLBACK_PCA = new Set(["q2turns", "q2", "strictio", "heavy", "feeder", "foley", "chg", "latedc", "admit"]);

    if (FALLBACK_SHARED.has(key)) return "SHARED";
    if (FALLBACK_RN.has(key)) return "RN";
    if (FALLBACK_PCA.has(key)) return "PCA";

    // Unknown: treat as shared so we don't hide impact incorrectly
    return "SHARED";
  }

  // ---------------------------------------
  // Change formatting
  // ---------------------------------------
  function prettyTagName(rawKey) {
    // turn ciwaCows -> CIWA/COWS, q2Turns -> Q2 Turns, lateDc -> Late DC, etc.
    const k = String(rawKey || "").trim();
    if (!k) return "Tag";
    const nk = normKey(k);

    const SPECIAL = {
      ciwa: "CIWA/COWS",
      cows: "CIWA/COWS",
      ciwacows: "CIWA/COWS",
      q2turns: "Q2 Turns",
      latedc: "Late DC",
      bg: "BG",
      tf: "TF",
      nih: "NIH",
      tele: "Tele",
      iso: "Isolation",
      isolation: "Isolation",
      chg: "CHG",
      vpo: "VPO",
      strictio: "Strict I/O",
      heavy: "Strict I/O"
    };
    if (SPECIAL[nk]) return SPECIAL[nk];

    // Otherwise: split camelCase-ish
    const spaced = k
      .replace(/[_-]/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim();

    // Title case-ish
    return spaced
      .split(/\s+/)
      .map(w => w.length <= 3 ? w.toUpperCase() : (w[0].toUpperCase() + w.slice(1)))
      .join(" ");
  }

  function collectDeltasFromChangesArray(changesArr) {
    const deltas = { RN: { added: [], removed: [] }, PCA: { added: [], removed: [] }, SHARED: { added: [], removed: [] } };
    const arr = Array.isArray(changesArr) ? changesArr : [];
    for (const ch of arr) {
      const key = ch?.key ?? ch?.tag ?? ch?.flag ?? ch?.field;
      if (!key) continue;

      const before = !!ch.before;
      const after = !!ch.after;

      // Only report actual toggles
      if (before === after) continue;

      const role = getRoleForTagKey(key); // RN / PCA / SHARED
      const bucket = (role === "RN" || role === "PCA") ? role : "SHARED";
      const name = prettyTagName(key);

      if (after === true) deltas[bucket].added.push(name);
      else deltas[bucket].removed.push(name);
    }
    return deltas;
  }

  function collectDeltasFromChangesObject(changesObj) {
    // supports: { rn:{added,removed}, pca:{added,removed}, shared:{added,removed} }
    const deltas = { RN: { added: [], removed: [] }, PCA: { added: [], removed: [] }, SHARED: { added: [], removed: [] } };
    const o = (changesObj && typeof changesObj === "object") ? changesObj : null;
    if (!o) return deltas;

    const push = (bucket, list, prefix) => {
      const arr = Array.isArray(list) ? list.filter(Boolean) : [];
      arr.forEach(x => {
        const name = prettyTagName(x);
        if (prefix === "+") deltas[bucket].added.push(name);
        else deltas[bucket].removed.push(name);
      });
    };

    if (o.rn) {
      push("RN", o.rn.added, "+");
      push("RN", o.rn.removed, "−");
    }
    if (o.pca) {
      push("PCA", o.pca.added, "+");
      push("PCA", o.pca.removed, "−");
    }
    if (o.shared) {
      push("SHARED", o.shared.added, "+");
      push("SHARED", o.shared.removed, "−");
    }

    return deltas;
  }

  function summarizeDeltas(deltas) {
    const parts = [];
    const fmt = (bucket, label) => {
      const a = deltas[bucket]?.added || [];
      const r = deltas[bucket]?.removed || [];
      const chunk = []
        .concat(a.map(x => `+${x}`))
        .concat(r.map(x => `−${x}`))
        .filter(Boolean);
      if (chunk.length) parts.push(`${label}: ${chunk.join(", ")}`);
    };
    fmt("RN", "RN");
    fmt("PCA", "PCA");
    fmt("SHARED", "Shared");
    return parts.join(" • ");
  }

  function impactedRolesFromDeltas(deltas) {
    const hasRN = (deltas.RN.added.length || deltas.RN.removed.length) > 0;
    const hasPCA = (deltas.PCA.added.length || deltas.PCA.removed.length) > 0;
    const hasShared = (deltas.SHARED.added.length || deltas.SHARED.removed.length) > 0;

    if (hasShared) return ["BOTH"];
    if (hasRN && hasPCA) return ["BOTH"];
    if (hasRN) return ["RN"];
    if (hasPCA) return ["PCA"];
    return null;
  }

  function normalizeRoleToken(x) {
    const s = String(x || "").trim().toUpperCase();
    if (!s) return "";
    if (s === "RN" || s === "NURSE") return "RN";
    if (s === "PCA" || s === "TECH" || s === "CNA") return "PCA";
    if (s === "BOTH" || s === "RN+PCA" || s === "RN_PCA") return "BOTH";
    if (s === "SHARED") return "BOTH";
    return s;
  }

  function rolesFromPayload(ev, deltasMaybe) {
    const p = ev?.payload || {};

    // Prefer explicit roles if present
    if (Array.isArray(p.impactedRoles) && p.impactedRoles.length) {
      const norm = p.impactedRoles.map(normalizeRoleToken).filter(Boolean);
      if (norm.includes("BOTH")) return ["BOTH"];
      const out = [];
      if (norm.includes("RN")) out.push("RN");
      if (norm.includes("PCA")) out.push("PCA");
      return out.length ? out : null;
    }

    if (p.roleImpact) {
      const rt = normalizeRoleToken(p.roleImpact);
      if (rt === "BOTH") return ["BOTH"];
      if (rt === "RN") return ["RN"];
      if (rt === "PCA") return ["PCA"];
    }

    // If we computed deltas, derive roles from them (this overrides coarse affects flags)
    if (deltasMaybe) {
      const derived = impactedRolesFromDeltas(deltasMaybe);
      if (derived && derived.length) return derived;
    }

    // DO-NO-HARM fallback: if affects exists, use it, but ONLY if we have no delta
    const affects = p?.attribution?.affects;
    if (affects && typeof affects === "object") {
      const rn = !!affects.rn || !!affects.RN || !!affects.nurse;
      const pca = !!affects.pca || !!affects.PCA || !!affects.tech;
      if (rn && pca) return ["BOTH"];
      if (rn) return ["RN"];
      if (pca) return ["PCA"];
    }

    return null;
  }

  function whoForRoles(ev, roles) {
    const { rn, pca } = getNames(ev);
    if (!roles || !roles.length) {
      if (rn && pca) return `RN ${rn} & PCA ${pca}`;
      if (rn) return `RN ${rn}`;
      if (pca) return `PCA ${pca}`;
      return "—";
    }
    const showBoth = roles.includes("BOTH");
    const showRN = showBoth || roles.includes("RN");
    const showPCA = showBoth || roles.includes("PCA");
    const parts = [];
    if (showRN && rn) parts.push(`RN ${rn}`);
    if (showPCA && pca) parts.push(`PCA ${pca}`);
    return parts.length ? parts.join(" & ") : "—";
  }

  // ---------------------------------------
  // Action text
  // ---------------------------------------
  function actionText(ev) {
    const type = (ev && ev.type) ? String(ev.type) : "EVENT";
    const p = (ev && ev.payload) ? ev.payload : {};

    if (type === "ACUITY_CHANGED") {
      // ✅ Handle BOTH shapes:
      // - payload.changes: Array<{key,before,after}>
      // - payload.changes: { rn:{added,removed}, pca:{...}, shared:{...} }
      let deltas = null;

      if (Array.isArray(p.changes)) deltas = collectDeltasFromChangesArray(p.changes);
      else if (p.changes && typeof p.changes === "object") deltas = collectDeltasFromChangesObject(p.changes);

      const summary = deltas ? summarizeDeltas(deltas) : "";

      if (summary) return summary;

      // Fallback to legacy simple flag/value if present
      const flag = p.flag || p.tag || p.field || p.key || "acuity";
      const onOff =
        (p.value === true || p.enabled === true) ? "added" :
        (p.value === false || p.enabled === false) ? "removed" :
        "changed";
      return `${prettyTagName(flag)} ${onOff}`;
    }

    if (type === "ADMIT_PLACED" || type === "ADMIT") return "Admit placed";
    if (type === "DISCHARGE" || type === "PATIENT_DISCHARGED") return "Discharge";
    if (type === "ASSIGNMENT_MOVED") return "Assignment moved";
    if (type === "ADMIT_ADDED_TO_QUEUE") return "Admit added to queue";
    if (type === "ADMIT_REMOVED_FROM_QUEUE") return "Admit removed from queue";
    if (type === "PRE_ADMIT_TAGS_UPDATED") return "Pre-admit tags updated";

    return type;
  }

  function classify(ev) {
    const type = (ev && ev.type) ? String(ev.type) : "EVENT";
    if (type === "ADMIT_PLACED" || type === "ADMIT" || type === "ADMIT_ADDED_TO_QUEUE" || type === "ADMIT_REMOVED_FROM_QUEUE") return "admissions";
    if (type === "DISCHARGE" || type === "PATIENT_DISCHARGED") return "discharges";
    if (type === "ACUITY_CHANGED") return "acuity";
    if (type === "ASSIGNMENT_MOVED") return "moves";
    return "other";
  }

  function ensureModal() {
    let modal = document.getElementById("shiftReportModal");
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = "shiftReportModal";
    modal.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.35);
      display: none; align-items: center; justify-content: center; z-index: 9999;
    `;

    modal.innerHTML = `
      <div style="
        width: min(980px, 94vw);
        height: min(78vh, 760px);
        background: white;
        border-radius: 14px;
        overflow: hidden;
        box-shadow: 0 10px 30px rgba(0,0,0,0.25);
        display:flex; flex-direction:column;
      ">
        <div style="padding: 12px 14px; display:flex; align-items:center; justify-content:space-between; border-bottom: 1px solid #e7e7e7;">
          <div style="display:flex; gap:10px; align-items:baseline;">
            <div style="font-weight:800;">Shift Narrative Timeline</div>
            <div id="shiftReportWindowLabel" style="opacity:0.7; font-size:12px;"></div>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <button id="shiftReportRefreshBtn" style="border:0; background:#f2f2f2; border-radius:10px; padding:6px 10px; cursor:pointer;">Refresh</button>
            <button id="shiftReportCloseBtn" style="border:0; background:#f2f2f2; border-radius:10px; padding:6px 10px; cursor:pointer;">Close</button>
          </div>
        </div>

        <div style="padding: 10px 14px; border-bottom: 1px solid #f0f0f0;">
          <div id="shiftReportSummary" style="display:flex; gap:14px; flex-wrap:wrap; font-size:12px;"></div>
        </div>

        <div id="shiftReportBody" style="padding: 12px 14px; overflow:auto; font-family: ui-sans-serif, system-ui; font-size: 13px;"></div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector("#shiftReportCloseBtn").onclick = () => { modal.style.display = "none"; };
    modal.querySelector("#shiftReportRefreshBtn").onclick = () => { renderCurrent(); };

    modal.onclick = (e) => { if (e.target === modal) modal.style.display = "none"; };

    return modal;
  }

  function getDefaultWindow() {
    const to = Date.now();
    const from = to - 12 * 60 * 60 * 1000;
    return { from, to };
  }

  function buildSummary(events) {
    const counts = { admissions: 0, discharges: 0, acuity: 0, moves: 0, other: 0 };
    for (const ev of events) counts[classify(ev)]++;

    const total = events.length;

    return [
      { k: "Total", v: total },
      { k: "Admissions", v: counts.admissions },
      { k: "Discharges", v: counts.discharges },
      { k: "Acuity changes", v: counts.acuity },
      { k: "Assignment moves", v: counts.moves },
      { k: "Other", v: counts.other }
    ];
  }

  function roleChipHtml(label, text) {
    return `
      <span style="
        display:inline-flex; align-items:center; gap:6px;
        padding:5px 10px;
        border-radius:999px;
        border:1px solid rgba(15,23,42,0.10);
        background: rgba(248,250,252,0.98);
        font-size:12px;
        font-weight:800;
        white-space:nowrap;
      ">
        <span style="opacity:0.7;">${escapeHtml(label)}</span>
        <span>${escapeHtml(text)}</span>
      </span>
    `;
  }

  function renderTimeline(events) {
    return events.map(ev => {
      const t = fmtTime(ev.ts);
      const r = getRoomLabel(ev);

      // For acuity, compute deltas once so roles can be derived properly
      let deltas = null;
      if (ev?.type === "ACUITY_CHANGED") {
        const p = ev.payload || {};
        if (Array.isArray(p.changes)) deltas = collectDeltasFromChangesArray(p.changes);
        else if (p.changes && typeof p.changes === "object") deltas = collectDeltasFromChangesObject(p.changes);
      }

      const roles = rolesFromPayload(ev, deltas);
      const impactText = whoForRoles(ev, roles);
      const names = getNames(ev);

      const showBoth = roles && roles.includes("BOTH");
      const showRN = roles && (showBoth || roles.includes("RN"));
      const showPCA = roles && (showBoth || roles.includes("PCA"));

      let chips = "";
      if (roles && (showRN || showPCA)) {
        if (showRN && names.rn) chips += roleChipHtml("RN", names.rn);
        if (showPCA && names.pca) chips += roleChipHtml("PCA", names.pca);
        if (!chips) chips = roleChipHtml("Impact", impactText);
      } else {
        chips = roleChipHtml("Impact", impactText);
      }

      const txt = actionText(ev);

      return `
        <div style="display:flex; gap:12px; align-items:flex-start; padding:8px 0; border-bottom:1px solid #f0f0f0;">
          <div style="
            min-width:84px;
            font-size:12px;
            font-weight:900;
            opacity:0.75;
            padding-top:6px;
          ">
            ${escapeHtml(t)}
          </div>

          <div style="
            flex:1;
            border:1px solid rgba(15,23,42,0.08);
            border-radius:14px;
            background: rgba(255,255,255,0.96);
            box-shadow: 0 6px 18px rgba(0,0,0,0.06);
            padding:10px 12px;
          ">
            <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start; flex-wrap:wrap;">
              <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                <span style="
                  display:inline-flex; align-items:center;
                  padding:6px 10px;
                  border-radius:999px;
                  background:#f7f7f7;
                  border:1px solid #ededed;
                  font-weight:900;
                  font-size:12px;
                ">${escapeHtml(r)}</span>

                <span style="font-weight:900; font-size:13px;">${escapeHtml(txt || String(ev.type || "EVENT"))}</span>
              </div>

              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                ${chips}
              </div>
            </div>
          </div>
        </div>
      `;
    }).join("");
  }

  function setWindowLabel(modal, fromMs, toMsVal) {
    const el = modal.querySelector("#shiftReportWindowLabel");
    const from = new Date(fromMs);
    const to = new Date(toMsVal);
    const label = `${from.toLocaleDateString()} ${from.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})} → ${to.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})}`;
    el.textContent = label;
  }

  function setSummary(modal, summaryPairs) {
    const host = modal.querySelector("#shiftReportSummary");
    host.innerHTML = summaryPairs.map(x => {
      return `
        <div style="background:#f7f7f7; border:1px solid #ededed; border-radius:999px; padding:6px 10px;">
          <span style="font-weight:700;">${escapeHtml(x.k)}:</span>
          <span style="margin-left:6px;">${escapeHtml(x.v)}</span>
        </div>
      `;
    }).join("");
  }

  function getShiftLogSafe() {
    return (window.shiftLog && window.shiftLog.__ready) ? window.shiftLog : null;
  }

  let _currentWindow = null;
  let _liveRefreshBound = false;

  function renderCurrent() {
    const modal = ensureModal();
    const body = modal.querySelector("#shiftReportBody");
    body.innerHTML = `<div style="opacity:0.7;">Loading…</div>`;

    const shiftLog = getShiftLogSafe();
    if (!shiftLog) {
      body.innerHTML = `<div style="color:#b00;">shiftLog not loaded. Ensure app/app.shiftLog.js loads before shiftReport.</div>`;
      return;
    }

    const w = _currentWindow || getDefaultWindow();
    const fromMs = toMs(w.from) ?? getDefaultWindow().from;
    const toMsVal = toMs(w.to) ?? getDefaultWindow().to;

    const events = shiftLog.list({ from: fromMs, to: toMsVal });

    setWindowLabel(modal, fromMs, toMsVal);
    setSummary(modal, buildSummary(events));
    body.innerHTML = events.length
      ? renderTimeline(events)
      : `<div style="opacity:0.7;">No events in this window.</div>`;
  }

  async function open(opts = {}) {
    const modal = ensureModal();
    modal.style.display = "flex";

    _currentWindow = {
      from: opts.from ?? getDefaultWindow().from,
      to: opts.to ?? getDefaultWindow().to
    };

    const shiftLog = getShiftLogSafe();
    if (shiftLog && typeof shiftLog.hydrate === "function") {
      await shiftLog.hydrate({ from: _currentWindow.from, to: _currentWindow.to, limit: 1500 });
    }

    renderCurrent();

    if (!_liveRefreshBound) {
      _liveRefreshBound = true;
      window.addEventListener("cupp:shiftlog_updated", () => {
        const m = document.getElementById("shiftReportModal");
        if (!m || m.style.display === "none") return;
        renderCurrent();
      });
    }
  }

  function close() {
    const modal = document.getElementById("shiftReportModal");
    if (modal) modal.style.display = "none";
  }

  function mountButtonNextToImport() {
    const buttons = Array.from(document.querySelectorAll("button"));
    const importBtn = buttons.find(b => /Import Assignment to LIVE/i.test(b.textContent || ""));
    if (!importBtn) return { ok: false, reason: "import_button_not_found" };

    if (document.getElementById("shiftReportOpenBtn")) return { ok: true, reason: "already_mounted" };

    const btn = document.createElement("button");
    btn.id = "shiftReportOpenBtn";
    btn.type = "button";
    btn.textContent = "Shift Log";
    btn.className = importBtn.className || "";
    btn.style.marginLeft = "8px";
    btn.onclick = () => window.shiftReport?.open?.();

    importBtn.insertAdjacentElement("afterend", btn);
    return { ok: true };
  }

  window.shiftReport = {
    __ready: true,
    open,
    close,
    mountButtonNextToImport
  };
})();
