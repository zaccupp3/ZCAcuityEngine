// script.js
// Tabs + Support Role Persistence

(function () {
  function showTab(sectionId) {
    const sections = document.querySelectorAll(".tab-section");
    sections.forEach((sec) => {
      sec.style.display = sec.id === sectionId ? "block" : "none";
    });

    const buttons = document.querySelectorAll(".tabButton");
    buttons.forEach((btn) => btn.classList.remove("active"));

    const activeBtn = document.querySelector(`.tabButton[data-target="${sectionId}"]`);
    if (activeBtn) activeBtn.classList.add("active");
  }

  // Expose for any legacy inline calls that still exist
  window.showTab = function (sectionId, buttonEl) {
    showTab(sectionId);
  };

  function wireTabs() {
    const buttons = document.querySelectorAll(".tabButton[data-target]");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-target");
        if (target) showTab(target);
      });
    });

    // Default to Staffing tab if none active
    const active = document.querySelector(".tabButton.active[data-target]");
    const defaultTarget = active?.getAttribute("data-target") || "staffingTab";
    showTab(defaultTarget);
  }

  function supportRolePersistence() {
    const ids = [
      "currentChargeName",
      "currentMentorName",
      "currentCtaName",
      "incomingChargeName",
      "incomingMentorName",
      "incomingCtaName",
    ];

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

  function init() {
    wireTabs();
    supportRolePersistence();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();