// app/app.staffTypeahead.js
// ---------------------------------------------------------
// Staff Name Typeahead (RN/PCA)
// Purpose: lightweight UI enhancement only.
// IMPORTANT:
// - This file MUST NOT own app state, persistence, or global reset functions.
// - It MUST NOT overwrite window.clearRecentlyDischargedFlags (owned by app.assignmentsDrag.js).
//
// Current status:
// - Safe shim restored to prevent accidental state-module duplication.
// - You can extend this later with autocomplete for RN/PCA name inputs.
// ---------------------------------------------------------

(function () {
  // Guard against double-load
  if (window.__cuppStaffTypeaheadLoaded) return;
  window.__cuppStaffTypeaheadLoaded = true;

  function noop() {}

  // Public API (optional hooks; safe no-ops if not used)
  window.staffTypeahead = window.staffTypeahead || {
    init: noop,
    attachToInput: noop,
    detach: noop
  };

  // Auto-init on DOM ready (safe)
  document.addEventListener("DOMContentLoaded", () => {
    try {
      if (window.staffTypeahead && typeof window.staffTypeahead.init === "function") {
        window.staffTypeahead.init();
      }
    } catch (e) {
      console.warn("[staffTypeahead] init error", e);
    }
  });
})();