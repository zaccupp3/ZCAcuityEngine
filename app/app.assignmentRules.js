// app/app.assignmentRules.js
// Shared helpers for distributing patients across staff.

// owners: array of nurse/PCA objects (must have .patients array)
// patients: array of patient objects or ids
// options: { randomize?: boolean }
window.distributePatientsEvenly = function (owners, patients, options = {}) {
  if (!owners || !owners.length) return;
  if (!patients || !patients.length) return;

  const randomize = !!options.randomize;

  // Work with a clean list of *objects*, ignore nulls.
  const list = patients.filter(Boolean).slice();

  // Caller can pre-sort by room; we only shuffle if asked.
  if (randomize) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
  }

  // Reset all owners.
  owners.forEach(o => {
    if (!o) return;
    o.patients = [];
  });

  // Round-robin: guarantees counts differ by at most 1.
  list.forEach((p, index) => {
    const patientId = typeof p === "object" ? p.id : p;
    const owner = owners[index % owners.length];
    if (!owner) return;
    if (!Array.isArray(owner.patients)) owner.patients = [];
    owner.patients.push(patientId);
  });
};