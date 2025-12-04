// app/app.modals.js
// ---------------------------------------------------------
// SHIM ONLY (Fix #4)
// ---------------------------------------------------------
// Patient Profile modal logic is owned by app.patientsAcuity.js.
// Discharge History modal logic is owned by app.assignmentsDrag.js.
//
// This file intentionally does NOT define:
//   - window.openPatientProfileFromRoom
//   - window.closePatientProfileModal
//   - window.savePatientProfile
//
// Keeping this file as a no-op avoids "silent overrides" and
// preserves index.html script references.

(function () {
  // Intentionally empty.
  // You may keep this log during development; remove if you want.
  console.log("app.modals.js loaded (shim). Modal logic handled elsewhere.");
})();
