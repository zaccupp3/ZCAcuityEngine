// app/app.explanations.js
// ---------------------------------------------------------
// Plain-language explanations for:
// - Unit overview ("how's it going today?")
// - Per-owner lightbulb explanations (RN + PCA)
// - Rule-flag "!" badge HTML with hover tooltip listing exact broken rules
// - Simple swap recommendation (uses suggestBestSwap if available)
//
// Depends on:
// - window.evaluateAssignmentHardRules
// - window.suggestBestSwap
// - patient getters
// - (optional) drivers summary helpers:
//    - window.getRnDriversSummaryFromPatientIds(ids)
//    - window.getPcaDriversSummaryFromPatientIds(ids)
// - (optional) load score helpers:
//    - window.getNurseLoadScore(owner)
//    - window.getPcaLoadScore(owner)
// - (optional) prev-owner helpers (from your assignmentsrender.js):
//    - window.getPrevRnNameForPatient(patientId)
//    - window.getPrevPcaNameForPatient(patientId)
// ---------------------------------------------------------

(function () {
  function safeArray(v) { return Array.isArray(v) ? v : []; }

  function getPatient(id) {
    if (typeof window.getPatientById === "function") return window.getPatientById(id);
    return null;
  }

  function uniq(arr) {
    const s = new Set();
    (arr || []).forEach(v => { if (v) s.add(v); });
    return Array.from(s);
  }

  function countTagAcrossPatients(patientIds, tagKeys) {
    let c = 0;
    for (const id of safeArray(patientIds)) {
      const p = getPatient(id);
      if (!p || p.isEmpty) continue;
      for (const k of tagKeys) {
        if (p[k]) { c++; break; }
      }
    }
    return c;
  }

  // Flexible tag-key sets (matches your pattern)
  const RN_KEYS = {
    drip: ["drip", "drips"],
    nih: ["nih"],
    bg: ["bg", "bgChecks"],
    ciwa: ["ciwa", "cows", "ciwaCows"],
    restraint: ["restraint", "restraints"],
    sitter: ["sitter"],
    vpo: ["vpo"],
    isolation: ["isolation", "iso"],
    admit: ["admit"],
    lateDc: ["lateDc", "lateDC", "latedc"]
  };

  const PCA_KEYS = {
    tele: ["tele", "telePca"],
    chg: ["chg"],
    foley: ["foley"],
    q2turns: ["q2turns", "q2Turns"],
    feeder: ["feeder", "feeders"],
    heavy: ["heavy"],
    isolation: ["isolation", "iso", "isoPca"],
    admit: ["admit", "admitPca"],
    lateDc: ["lateDc", "lateDcPca", "lateDC", "latedc"]
  };

  function summarizeOwner(owner, role) {
    const ids = safeArray(owner?.patients);
    const keys = (role === "pca") ? PCA_KEYS : RN_KEYS;

    const summary = {};
    for (const tag in keys) summary[tag] = countTagAcrossPatients(ids, keys[tag]);
    summary.patientCount = ids.length;
    return summary;
  }

  function getDriversSummary(ids, role) {
    try {
      if (role === "pca" && typeof window.getPcaDriversSummaryFromPatientIds === "function") {
        return window.getPcaDriversSummaryFromPatientIds(ids) || "";
      }
      if (role !== "pca" && typeof window.getRnDriversSummaryFromPatientIds === "function") {
        return window.getRnDriversSummaryFromPatientIds(ids) || "";
      }
    } catch (_) {}
    return "";
  }

  function getLoadScore(owner, role) {
    try {
      if (role === "pca" && typeof window.getPcaLoadScore === "function") return Number(window.getPcaLoadScore(owner) || 0);
      if (role !== "pca" && typeof window.getNurseLoadScore === "function") return Number(window.getNurseLoadScore(owner) || 0);
    } catch (_) {}
    return null; // if not available
  }

  function computeTeamLoadStats(ownersAll, role) {
    const scores = [];
    safeArray(ownersAll).forEach(o => {
      const s = getLoadScore(o, role);
      if (typeof s === "number") scores.push(s);
    });
    if (!scores.length) return null;

    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sorted = scores.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    return { avg, med };
  }

  function loadTone(owner, ownersAll, role) {
    const s = getLoadScore(owner, role);
    const stats = computeTeamLoadStats(ownersAll, role);
    if (s == null || !stats) return "";

    // Keep it simple: "lighter / average / heavier"
    const delta = s - stats.avg;
    if (delta >= 6) return "This one is heavier than average, but still within a fair spread for tonight.";
    if (delta <= -6) return "This one is lighter than average — nice buffer if anything pops off.";
    return "This one looks pretty middle-of-the-pack for load.";
  }

  function countReportSources(patientIds, role) {
    // Uses prev-owner name lookup if present (from assignmentsrender.js)
    const getter = (role === "pca") ? window.getPrevPcaNameForPatient : window.getPrevRnNameForPatient;
    if (typeof getter !== "function") return null;

    const names = [];
    safeArray(patientIds).forEach(pid => {
      const n = getter(pid);
      if (n) names.push(n);
    });
    return uniq(names).length;
  }

  function reportSourcesTone(n) {
    if (n == null) return "";
    if (n <= 1) return "Report should be smooth — mostly single-source.";
    if (n === 2) return "Report should be manageable — split across 2 sources.";
    return `Report will be a little more “mixed” — pulling from ${n} sources.`;
  }

  function flagsToTooltip(ev) {
    const v = safeArray(ev?.violations);
    const w = safeArray(ev?.warnings);

    const lines = [];
    v.forEach(x => {
      lines.push(`AVOIDABLE: ${x.tag} (${x.mine} > ${x.limit})`);
    });
    w.forEach(x => {
      lines.push(`UNAVOIDABLE: ${x.tag} (${x.mine} > ${x.limit})`);
    });

    return lines.join(" • ");
  }

  // ✅ “!” badge HTML with hover tooltip naming exact broken rules
  function buildRuleBangBadgeHTML(ev) {
    const v = safeArray(ev?.violations);
    const w = safeArray(ev?.warnings);

    if (!v.length && !w.length) return "";

    // Red if any avoidable violation, yellow if only unavoidable warnings
    const isBad = v.length > 0;
    const klass = isBad ? "flag-bad" : "flag-warn";

    // Tooltip explicitly lists which rule(s) were broken
    const title = flagsToTooltip(ev) || (isBad ? "Rule break detected" : "Unavoidable stacking detected");

    return `<span class="icon-btn ${klass}" title="${escapeHtml(title)}" aria-label="Rule flags">!</span>`;
  }

  // Escape for title="" safety
  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function buildUnitOverviewText(rnOwners, pcaOwners) {
    const rnAll = safeArray(rnOwners).flatMap(o => safeArray(o.patients));
    const pcaAll = safeArray(pcaOwners).flatMap(o => safeArray(o.patients));

    const rnCounts = {};
    for (const tag in RN_KEYS) rnCounts[tag] = countTagAcrossPatients(rnAll, RN_KEYS[tag]);

    const pcaCounts = {};
    for (const tag in PCA_KEYS) pcaCounts[tag] = countTagAcrossPatients(pcaAll, PCA_KEYS[tag]);

    // RN themes (only >0)
    const rnThemes = [];
    if (rnCounts.bg) rnThemes.push("BG checks are a big theme");
    if (rnCounts.drip) rnThemes.push("a few drips running");
    if (rnCounts.sitter || rnCounts.vpo) rnThemes.push("sitters/VPO coverage in the mix");
    if (rnCounts.nih) rnThemes.push("NIH patients to watch");
    if (rnCounts.ciwa) rnThemes.push("CIWA/COWS in rotation");
    if (rnCounts.isolation) rnThemes.push("isolation rooms to work around");
    if (rnCounts.admit) rnThemes.push("admits still active");
    if (rnCounts.lateDc) rnThemes.push("late DCs can change flow");

    // PCA themes (only >0)
    const pcaThemes = [];
    if (pcaCounts.heavy) pcaThemes.push("heavy/total care is present");
    if (pcaCounts.q2turns) pcaThemes.push("Q2 turns on the board");
    if (pcaCounts.feeder) pcaThemes.push("feeders taking time");
    if (pcaCounts.chg) pcaThemes.push("CHG to balance");
    if (pcaCounts.foley) pcaThemes.push("foley care spread out");
    if (pcaCounts.isolation) pcaThemes.push("iso adds friction for tasks");
    if (pcaCounts.tele) pcaThemes.push("tele patients are widespread");

    const rnLine = rnThemes.length ? `RN: ${rnThemes.slice(0, 3).join(", ")}.` : "RN: fairly standard overall.";
    const pcaLine = pcaThemes.length ? `PCA: ${pcaThemes.slice(0, 3).join(", ")}.` : "PCA: fairly standard overall.";

    const busyScore = rnThemes.length + pcaThemes.length;
    const opener =
      busyScore >= 5 ? "Unit check-in: this looks like a higher-acuity shift overall."
      : busyScore >= 3 ? "Unit check-in: this looks like a moderately busy shift."
      : "Unit check-in: this looks like a steady shift.";

    return `${opener} ${rnLine} ${pcaLine}`;
  }

  function buildOwnerLightbulbText(owner, ownersAll, role, ev) {
    const ids = safeArray(owner?.patients);
    const s = summarizeOwner(owner, role);

    const drivers = getDriversSummary(ids, role);
    const reportSources = countReportSources(ids, role);

    const v = safeArray(ev?.violations);
    const w = safeArray(ev?.warnings);

    // “What’s on this assignment” (short + relevant)
    const highlights = [];
    if (role !== "pca") {
      if (s.drip) highlights.push(`${s.drip} drip`);
      if (s.nih) highlights.push(`${s.nih} NIH`);
      if (s.bg) highlights.push(`${s.bg} BG`);
      if (s.ciwa) highlights.push(`${s.ciwa} CIWA/COWS`);
      if ((s.sitter || 0) + (s.vpo || 0)) highlights.push(`${(s.sitter || 0) + (s.vpo || 0)} sitter/VPO`);
      if (s.isolation) highlights.push(`${s.isolation} iso`);
    } else {
      if (s.heavy) highlights.push(`${s.heavy} heavy`);
      if (s.q2turns) highlights.push(`${s.q2turns} Q2 turns`);
      if (s.feeder) highlights.push(`${s.feeder} feeder`);
      if (s.chg) highlights.push(`${s.chg} CHG`);
      if (s.foley) highlights.push(`${s.foley} foley`);
      if (s.isolation) highlights.push(`${s.isolation} iso`);
      if (s.tele) highlights.push(`${s.tele} tele`);
    }

    const whatLine = highlights.length
      ? `Quick read: ${highlights.slice(0, 4).join(", ")}.`
      : "Quick read: nothing jumps out — pretty standard mix.";

    // Drivers line (if present)
    const driversLine = drivers ? `Top drivers: ${drivers}.` : "";

    // Rule line: avoidable vs unavoidable
    let rulesLine = "";
    if (v.length) {
      // name the top 1–2 avoidable rule breaks
      const top = v.slice(0, 2).map(x => `${x.tag} (${x.mine}>${x.limit})`).join(", ");
      rulesLine = `Rule check: avoidable stacking on ${top}. This is worth adjusting if you have time.`;
    } else if (w.length) {
      const top = w.slice(0, 2).map(x => `${x.tag} (${x.mine}>${x.limit})`).join(", ");
      rulesLine = `Rule check: some stacking (${top}), but it looks unavoidable based on unit totals.`;
    } else {
      rulesLine = "Rule check: looks clean — no obvious rule breaks.";
    }

    // Report sources line
    const reportLine = reportSources != null
      ? `Report: ${reportSources} source${reportSources === 1 ? "" : "s"}. ${reportSourcesTone(reportSources)}`
      : "";

    // Load tone
    const loadLine = loadTone(owner, ownersAll, role);

    // Recommendation: only mention if best-swap involves this owner AND we have a rule issue
    let recLine = "";
    if ((v.length || w.length) && typeof window.suggestBestSwap === "function") {
      try {
        const best = window.suggestBestSwap(ownersAll, role);
        const myName = owner?.name || owner?.label || "";
        if (best && best.ok && best.found && (best.ownerA === myName || best.ownerB === myName)) {
          // Keep it practical
          const from = (best.ownerA === myName) ? best.patientFromA : best.patientFromB;
          const to   = (best.ownerA === myName) ? best.patientFromB : best.patientFromA;
          recLine = `Quick tweak: consider swapping patient ${from} ↔ ${to}. It improves rule pressure without changing headcount.`;
        } else if (v.length) {
          recLine = "Quick tweak: a small swap can usually fix this without blowing up report sources.";
        }
      } catch (_) {}
    }

    // Final output: professional, short, charge-facing
    return [whatLine, driversLine, rulesLine, reportLine, loadLine, recLine].filter(Boolean).join(" ");
  }

  // Public API ------------------------------------------------

  window.explain = {
    unitOverview(rnOwners, pcaOwners) {
      return buildUnitOverviewText(rnOwners, pcaOwners);
    },

    // returns the plain-language text for the lightbulb
    perOwner(owner, ownersAll, role) {
      if (typeof window.evaluateAssignmentHardRules !== "function") {
        return "Explain: rules engine not loaded.";
      }
      const key = owner?.name || owner?.label || "owner";
      const map = window.evaluateAssignmentHardRules(ownersAll, role);
      const ev = map ? map[key] : null;
      return buildOwnerLightbulbText(owner, ownersAll, role, ev);
    },

    // ✅ returns "!" badge html for the owner (put this near the lightbulb)
    ownerRuleBadgeHTML(owner, ownersAll, role) {
      if (typeof window.evaluateAssignmentHardRules !== "function") return "";
      const key = owner?.name || owner?.label || "owner";
      const map = window.evaluateAssignmentHardRules(ownersAll, role);
      const ev = map ? map[key] : null;
      return buildRuleBangBadgeHTML(ev);
    },

    // best overall swap (existing)
    bestSwap(owners, role) {
      if (typeof window.suggestBestSwap !== "function") return null;
      const res = window.suggestBestSwap(owners, role);
      return res && res.ok && res.found ? res : null;
    }
  };
})();