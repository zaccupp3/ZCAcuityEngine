const fs = require("fs");
const path = require("path");
const vm = require("vm");
const scenarios = require("./assignmentEngineV2Scenarios");

function loadScriptIntoSandbox(filePath, sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(filePath, "utf8"), sandbox);
}

function makeSandbox() {
  const sandbox = {
    console,
    window: {},
    globalThis: null
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  return sandbox;
}

function summarizeOwners(owners) {
  return owners.map((owner) => ({
    name: owner.name,
    count: Array.isArray(owner.patients) ? owner.patients.length : 0,
    patients: owner.patients
  }));
}

const sandbox = makeSandbox();
loadScriptIntoSandbox(path.join(__dirname, "..", "app", "app.assignmentEngineV2.js"), sandbox);

scenarios.forEach((scenario) => {
  const result = sandbox.window.assignmentEngineV2.solve({
    role: scenario.role,
    owners: scenario.owners,
    patients: scenario.patients,
    prevOwnerByPid: scenario.prevOwnerByPid,
    maxPasses: 120
  });

  console.log(`\n=== ${scenario.name} ===`);
  console.log(JSON.stringify({
    summary: result.summary,
    owners: summarizeOwners(result.owners)
  }, null, 2));
});
