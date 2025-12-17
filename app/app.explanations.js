// app/app.explanations.js
// ---------------------------------------------------------
// Plain-language explanations for:
// - Unit overview ("how's it going today?")
// - Per-owner lightbulb explanations (RN + PCA)
// - Simple recommendations (swap suggestion)
// Depends on:
// - window.evaluateAssignmentHardRules
// - window.suggestBestSwap
// - patient getters + tag strings (rnTagString / pcaTagString optional)
// ---------------------------------------------------------

(function () {
  function safeArray(v) { return Array.isArray(v) ? v : []; }

  function getPatient(id) {
    if (typeof window.getPatientById === "function") return window.getPatientById(id);
    return null;
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

  // Minimal tag-key sets (matches what you’ve been using)
  const RN_KEYS = {
    drip: ["drip"],
    nih: ["nih"],
    bg: ["bg", "bgChecks"],
    ciwa: ["ciwa", "cows", "ciwaCows"],
    restraint: ["restraint"],
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

  function buildUnitOverviewText(rnOwners, pcaOwners) {
    // keep it casual, “charge nurse” vibe
    const rnAll = safeArray(rnOwners).flatMap(o => safeArray(o.patients));
    const pcaAll = safeArray(pcaOwners).flatMap(o => safeArray(o.patients));

    const rnHot = [];
    const pcaHot = [];

    const rnCounts = {};
    for (const tag in RN_KEYS) rnCounts[tag] = countTagAcrossPatients(rnAll, RN_KEYS[tag]);
    const pcaCounts = {};
    for (const tag in PCA_KEYS) pcaCounts[tag] = countTagAcrossPatients(pcaAll, PCA_KEYS[tag]);

    // RN themes (only mention if >0)
    if (rnCounts.drip) rnHot.push("some drips running");
    if (rnCounts.sitter) rnHot.push("a few sitter/VPO-type patients");
    if (rnCounts.vpo) rnHot.push("VPO coverage in the mix");
    if (rnCounts.bg) rnHot.push("BG checks popping up across the board");
    if (rnCounts.nih) rnHot.push("NIH patients to watch closely");
    if (rnCounts.ciwa) rnHot.push("CIWA/COWS patients in rotation");
    if (rnCounts.isolation) rnHot.push("isolation rooms to work around");
    if (rnCounts.admit) rnHot.push("admits still active");
    if (rnCounts.lateDc) rnHot.push("late DCs floating around");

    // PCA themes (only mention if >0)
    if (pcaCounts.tele) pcaHot.push("tele patients spread out");
    if (pcaCounts.q2turns) pcaHot.push("Q2 turns on the board");
    if (pcaCounts.heavy) pcaHot.push("heavy/total care patients");
    if (pcaCounts.feeder) pcaHot.push("feeders needing extra time");
    if (pcaCounts.chg) pcaHot.push("CHG workload to balance");
    if (pcaCounts.foley) pcaHot.push("foley care to spread out");
    if (pcaCounts.isolation) pcaHot.push("iso adds friction for tasks");
    if (pcaCounts.admit) pcaHot.push("admit support needed");
    if (pcaCounts.lateDc) pcaHot.push("late discharges changing the flow");

    const rnLine = rnHot.length
      ? `RN side: ${rnHot.slice(0, 3).join(", ")}.`
      : "RN side: pretty standard overall.";

    const pcaLine = pcaHot.length
      ? `PCA side: ${pcaHot.slice(0, 3).join(", ")}.`
      : "PCA side: pretty standard overall.";

    return `Unit check-in: today looks like a ${rnHot.length + pcaHot.length >= 4 ? "busier" : "steady"} shift. ${rnLine} ${pcaLine}`;
  }

  function buildOwnerLightbulbText(owner, role, evalObj) {
    const s = summarizeOwner(owner, role);

    const flagsV = safeArray(evalObj?.violations);
    const flagsW = safeArray(evalObj?.warnings);

    // Build “what I see”
    const highlights = [];
    if (role === "nurse") {
      if (s.drip) highlights.push(`${s.drip} drip`);
      if (s.nih) highlights.push(`${s.nih} NIH`);
      if (s.bg) highlights.push(`${s.bg} BG`);
      if (s.ciwa) highlights.push(`${s.ciwa} CIWA/COWS`);
      if (s.sitter || s.vpo) highlights.push(`${(s.sitter || 0) + (s.vpo || 0)} sitter/VPO`);
      if (s.isolation) highlights.push(`${s.isolation} iso`);
      if (s.admit) highlights.push(`${s.admit} admit`);
      if (s.lateDc) highlights.push(`${s.lateDc} late DC`);
    } else {
      if (s.tele) highlights.push(`${s.tele} tele`);
      if (s.q2turns) highlights.push(`${s.q2turns} Q2 turns`);
      if (s.heavy) highlights.push(`${s.heavy} heavy`);
      if (s.feeder) highlights.push(`${s.feeder} feeder`);
      if (s.chg) highlights.push(`${s.chg} CHG`);
      if (s.foley) highlights.push(`${s.foley} foley`);
      if (s.isolation) highlights.push(`${s.isolation} iso`);
      if (s.admit) highlights.push(`${s.admit} admit`);
      if (s.lateDc) highlights.push(`${s.lateDc} late DC`);
    }

    const what = highlights.length
      ? `Quick read: ${highlights.slice(0, 4).join(", ")}.`
      : "Quick read: looks pretty standard.";

    // Build “why it happened”
    let why = "We tried to keep things even while keeping report as clean as possible.";
    if (role === "nurse" && s.bg >= 2) {
      why = "We tried to spread the BG checks out, but some ended up stacked to keep report simpler.";
    }
    if (role === "pca" && (s.heavy || s.q2turns)) {
      why = "We tried to spread heavy/Q2 work out so no one gets slammed for the whole shift.";
    }

    // Flag text
    const flagText = flagsV.length
      ? `Heads up: there’s an avoidable stack (${flagsV[0].tag}). This is a good candidate for a quick swap.`
      : flagsW.length
        ? `Heads up: there’s a stack here, but it may be unavoidable based on the unit totals.`
        : "";

    return `${what} ${why} ${flagText}`.trim();
  }

  // Public API ------------------------------------------------

  window.explain = {
    unitOverview(rnOwners, pcaOwners) {
      return buildUnitOverviewText(rnOwners, pcaOwners);
    },

    perOwner(owner, ownersAll, role) {
      if (typeof window.evaluateAssignmentHardRules !== "function") {
        return "Explain: rules engine not loaded.";
      }
      const key = owner?.name || owner?.label || "owner";
      const map = window.evaluateAssignmentHardRules(ownersAll, role);
      const ev = map ? map[key] : null;
      return buildOwnerLightbulbText(owner, role, ev);
    },

    bestSwap(owners, role) {
      if (typeof window.suggestBestSwap !== "function") return null;
      const res = window.suggestBestSwap(owners, role);
      return res && res.ok && res.found ? res : null;
    }
  };
})();