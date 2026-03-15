const fs = require("fs");
const path = require("path");
const vm = require("vm");

function buildSandbox(patients, nurses, pcas = []) {
  const sandbox = {
    console,
    window: {},
    globalThis: null,
    currentNurses: nurses,
    currentPcas: pcas
  };

  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.getPatientById = (id) => patients.find((p) => Number(p.id) === Number(id)) || null;
  sandbox.window.getPatientById = sandbox.getPatientById;
  sandbox.window.currentNurses = sandbox.currentNurses;
  sandbox.window.currentPcas = sandbox.currentPcas;
  sandbox.window.getRnPatientScore = () => 0;
  sandbox.window.getPcaPatientScore = () => 0;
  sandbox.window.getRoomNumber = (p) => {
    const m = String(p?.room || "").match(/(\d+)/);
    return m ? Number(m[1]) : null;
  };
  sandbox.window.getRoomLabelForPatient = (p) => p?.room || "";
  return sandbox;
}

function loadRulesIntoSandbox(sandbox) {
  const rulesPath = path.join(__dirname, "..", "app", "app.assignmentRules.js");
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(rulesPath, "utf8"), sandbox);
}

function summarizeViolations(evalMap) {
  return Object.fromEntries(
    Object.entries(evalMap).map(([owner, ev]) => [
      owner,
      (Array.isArray(ev?.violations) ? ev.violations : []).map((v) => ({
        tag: v.tag,
        mine: v.mine,
        limit: v.limit
      }))
    ])
  );
}

function logScenario(title, payload) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(payload, null, 2));
}

const patients = [
  { id: 1, room: "201A", expectedDischarge: true },
  { id: 2, room: "201B", expectedDischarge: true, nih: true, drip: true, tele: true },
  { id: 3, room: "202B", sitter: true, lateDc: true, tele: true },
  { id: 4, room: "217A", expectedDischarge: true, tele: true },
  { id: 5, room: "219B", expectedDischarge: true, isolation: true },
  { id: 6, room: "204A" },
  { id: 7, room: "209", tele: true },
  { id: 8, room: "215A" },
  { id: 9, room: "217B" },
  { id: 10, room: "204B", drip: true, bg: true, tele: true },
  { id: 11, room: "218A" },
  { id: 12, room: "220B", tele: true }
];

const startingNurses = [
  { id: 1, name: "Incoming RN 1", patients: [1, 2, 3, 4, 5] },
  { id: 2, name: "Incoming RN 2", patients: [6, 7, 8, 9] },
  { id: 3, name: "Incoming RN 3", patients: [10, 11, 12] }
];

const sandboxA = buildSandbox(
  patients,
  JSON.parse(JSON.stringify(startingNurses))
);
loadRulesIntoSandbox(sandboxA);
const beforeA = sandboxA.window.evaluateAssignmentHardRules(sandboxA.currentNurses, "nurse");
const rebalanceResult = sandboxA.window.rebalanceOwnersSafely(sandboxA.currentNurses, "nurse");
const afterA = sandboxA.window.evaluateAssignmentHardRules(sandboxA.currentNurses, "nurse");
logScenario("Current Engine Result", {
  rebalanceResult,
  beforeViolations: summarizeViolations(beforeA),
  afterViolations: summarizeViolations(afterA),
  assignments: sandboxA.currentNurses.map((n) => ({
    name: n.name,
    count: n.patients.length,
    patients: n.patients
  }))
});

const sandboxB = buildSandbox(
  patients,
  JSON.parse(JSON.stringify(startingNurses))
);
loadRulesIntoSandbox(sandboxB);
sandboxB.currentNurses[0].patients = [2, 3, 4, 5];
sandboxB.currentNurses[2].patients = [10, 11, 12, 1];
const afterManual = sandboxB.window.evaluateAssignmentHardRules(sandboxB.currentNurses, "nurse");
logScenario("Known Good Single-Move Solution", {
  afterViolations: summarizeViolations(afterManual),
  assignments: sandboxB.currentNurses.map((n) => ({
    name: n.name,
    count: n.patients.length,
    patients: n.patients
  }))
});
