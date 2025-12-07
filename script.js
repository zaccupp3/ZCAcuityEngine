// script.js
// Tiny helper for switching tabs.

window.showTab = function (sectionId, buttonEl) {
  // 1) show/hide sections
  const sections = document.querySelectorAll(".tab-section");
  sections.forEach((sec) => {
    sec.style.display = sec.id === sectionId ? "block" : "none";
  });

  // 2) set active button
  const buttons = document.querySelectorAll(".tabButton");
  buttons.forEach((btn) => btn.classList.remove("active"));

  // If caller didn't pass "this", find the matching button by data-target
  const fallbackBtn =
    buttonEl ||
    document.querySelector(`.tabButton[data-target="${sectionId}"]`);

  if (fallbackBtn) fallbackBtn.classList.add("active");
};

(function supportRolePersistence() {
  const ids = [
    "currentChargeName",
    "currentMentorName",
    "currentCtaName",
    "incomingChargeName",
    "incomingMentorName",
    "incomingCtaName",
  ];

  function load() {
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;

      const key = `supportRole:${id}`;
      el.value = localStorage.getItem(key) || "";

      el.addEventListener("input", () => {
        localStorage.setItem(key, el.value || "");
      });
    });
  }

  // Load after DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
})();