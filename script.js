// script.js
// Tiny helper for switching tabs.

window.showTab = function (sectionId, buttonEl) {
  const sections = document.querySelectorAll(".tab-section");
  sections.forEach((sec) => {
    sec.style.display = sec.id === sectionId ? "block" : "none";
  });

  const buttons = document.querySelectorAll(".tabButton");
  buttons.forEach((btn) => btn.classList.remove("active"));
  if (buttonEl) {
    buttonEl.classList.add("active");
  }
};