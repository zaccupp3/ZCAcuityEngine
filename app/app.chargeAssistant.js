// Embedded API-backed charge nurse assistant.
// Sends a privacy-minimized live unit snapshot to /api/charge-assistant.
(function () {
  if (window.__chargeAssistantApiLoaded) return;
  window.__chargeAssistantApiLoaded = true;

  function safeArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function visible(el) {
    if (!el) return false;
    const cs = window.getComputedStyle(el);
    return cs && cs.display !== "none" && cs.visibility !== "hidden";
  }

  function roomLabel(p) {
    try {
      if (typeof window.getRoomLabelForPatient === "function") return String(window.getRoomLabelForPatient(p) || "");
    } catch (_) {}
    return String(p?.room || p?.id || "");
  }

  function patientTags(p) {
    if (!p || p.isEmpty) return [];
    return [
      p.tele ? "Tele" : "",
      p.nih ? "NIH" : "",
      p.emu ? "EMU" : "",
      p.drip || p.drips ? "Drip" : "",
      p.bg || p.bgChecks ? "BG" : "",
      p.tf ? "TF" : "",
      p.ciwa || (!p.cows && p.ciwaCows) ? "CIWA" : "",
      p.cows ? "COWS" : "",
      p.psych ? "Psych" : "",
      p.prns ? "PRNs" : "",
      p.restraint || p.restraints ? "Restraint" : "",
      p.sitter ? "Sitter" : "",
      p.vpo ? "VPO" : "",
      p.isolation || p.iso ? "ISO" : "",
      p.admit || p.admitPca ? "Admit" : "",
      p.lateDc || p.lateDcPca ? "Late DC" : "",
      p.expectedDischarge ? "Expected DC" : "",
      p.chg ? "CHG" : "",
      p.foley ? "Foley" : "",
      p.q2turns || p.q2Turns ? "Q2 Turns" : "",
      p.strictIo || p.heavy ? "Total Care" : "",
      p.feeder || p.feeders ? "Feeder" : ""
    ].filter(Boolean);
  }

  function activePatients() {
    return safeArray(window.patients)
      .filter((p) => p && !p.isEmpty)
      .map((p) => ({
        id: Number(p.id),
        room: roomLabel(p),
        tags: patientTags(p)
      }));
  }

  function ownerRows(owners, role) {
    return safeArray(owners)
      .filter((o) => o && String(o.type || "").toLowerCase() !== "hold" && Number(o.id) !== 0)
      .map((o) => ({
        id: Number(o.id),
        name: String(o.name || ""),
        role,
        type: String(o.type || ""),
        restrictions: o.restrictions || {},
        isSitter: !!o.isSitter,
        sitterRoomPair: String(o.sitterRoomPair || ""),
        patientIds: safeArray(o.patients).map(Number).filter(Number.isFinite),
        rooms: safeArray(o.patients)
          .map((pid) => {
            try {
              const p = typeof window.getPatientById === "function" ? window.getPatientById(pid) : null;
              return p && !p.isEmpty ? roomLabel(p) : "";
            } catch (_) {
              return "";
            }
          })
          .filter(Boolean)
      }));
  }

  function safeRuleMap(owners, role) {
    try {
      if (typeof window.evaluateAssignmentHardRules === "function") {
        return window.evaluateAssignmentHardRules(owners, role);
      }
    } catch (_) {}
    return null;
  }

  function loadHighRiskReport() {
    try {
      if (window.printOncoming && typeof window.printOncoming.collectHighRiskDraftFromUi === "function") {
        return window.printOncoming.collectHighRiskDraftFromUi();
      }
    } catch (_) {}
    try {
      const raw = localStorage.getItem("handoffPacketDraft");
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function getShiftType() {
    const raw = String(document.getElementById("finalizeShiftType")?.value || "").toLowerCase();
    if (raw === "night") return "NOC";
    if (raw === "day") return "DAY";
    return "";
  }

  function buildSnapshot() {
    const currentNurses = safeArray(window.currentNurses);
    const currentPcas = safeArray(window.currentPcas);
    const incomingNurses = safeArray(window.incomingNurses);
    const incomingPcas = safeArray(window.incomingPcas);
    return {
      generatedAt: new Date().toISOString(),
      unit: String(document.getElementById("unitSwitcher")?.selectedOptions?.[0]?.textContent || "6 North"),
      shift: {
        date: String(document.getElementById("finalizeShiftDate")?.value || ""),
        type: getShiftType()
      },
      patients: activePatients(),
      current: {
        nurses: ownerRows(currentNurses, "RN"),
        pcas: ownerRows(currentPcas, "PCA"),
        rnRules: safeRuleMap(currentNurses, "nurse"),
        pcaRules: safeRuleMap(currentPcas, "pca")
      },
      oncoming: {
        nurses: ownerRows(incomingNurses, "RN"),
        pcas: ownerRows(incomingPcas, "PCA"),
        rnRules: safeRuleMap(incomingNurses, "nurse"),
        pcaRules: safeRuleMap(incomingPcas, "pca")
      },
      highRiskReport: loadHighRiskReport()
    };
  }

  function hostShouldShow() {
    return visible(document.getElementById("oncomingAssignmentTab")) || visible(document.getElementById("liveAssignmentTab"));
  }

  function ensurePanel() {
    const host = document.getElementById("globalAssignmentPrintActions");
    if (!host) return null;
    let panel = document.getElementById("chargeAssistantApiPanel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "chargeAssistantApiPanel";
      host.appendChild(panel);
    }
    const shouldShow = hostShouldShow();
    panel.style.display = shouldShow ? "block" : "none";
    if (!shouldShow) {
      panel.dataset.visible = "false";
      return panel;
    }

    const collapsed = window.__chargeAssistantApiCollapsed !== false;
    const hasFocus = panel.contains(document.activeElement);
    const nextCollapsed = collapsed ? "true" : "false";
    if (
      hasFocus &&
      panel.dataset.visible === "true" &&
      panel.dataset.collapsed === nextCollapsed &&
      panel.innerHTML.trim()
    ) {
      return panel;
    }
    if (
      panel.dataset.visible === "true" &&
      panel.dataset.collapsed === nextCollapsed &&
      panel.innerHTML.trim()
    ) {
      return panel;
    }
    panel.dataset.visible = "true";
    panel.dataset.collapsed = nextCollapsed;
    panel.innerHTML = `
      <div class="charge-ai-card">
        <button type="button" class="charge-ai-toggle" aria-expanded="${collapsed ? "false" : "true"}" onclick="window.toggleChargeAIAssistant && window.toggleChargeAIAssistant()">
          <span>${collapsed ? ">" : "v"}</span>
          <span>Charge AI</span>
        </button>
        <div class="charge-ai-body" style="${collapsed ? "display:none;" : "display:block;"}">
          <textarea id="chargeAiQuestion" class="charge-ai-input" rows="3" placeholder="Ask about the current unit flow..."></textarea>
          <div class="charge-ai-actions">
            <button type="button" class="charge-ai-btn" onclick="window.askChargeAIAssistant && window.askChargeAIAssistant()">Ask</button>
            <button type="button" class="charge-ai-btn secondary" onclick="window.askChargeAIAssistant && window.askChargeAIAssistant('Give me the top assignment concerns and the best next move.')">Unit Read</button>
          </div>
          <div id="chargeAiAnswer" class="charge-ai-answer">${escapeHtml(window.__chargeAssistantApiLast || "Ready.")}</div>
        </div>
      </div>
    `;
    return panel;
  }

  window.toggleChargeAIAssistant = function toggleChargeAIAssistant() {
    window.__chargeAssistantApiCollapsed = window.__chargeAssistantApiCollapsed === false ? true : false;
    ensurePanel();
  };

  window.askChargeAIAssistant = async function askChargeAIAssistant(presetQuestion) {
    window.__chargeAssistantApiCollapsed = false;
    ensurePanel();
    const input = document.getElementById("chargeAiQuestion");
    const answerEl = document.getElementById("chargeAiAnswer");
    const question = String(presetQuestion || input?.value || "").trim();
    if (!question) return;
    if (answerEl) answerEl.textContent = "Thinking through the board...";
    try {
      const res = await fetch("/api/charge-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, snapshot: buildSnapshot() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Assistant request failed.");
      window.__chargeAssistantApiLast = data.answer || "";
      if (answerEl) answerEl.textContent = window.__chargeAssistantApiLast || "No answer returned.";
    } catch (err) {
      const msg = err?.message || "Assistant request failed.";
      window.__chargeAssistantApiLast = msg;
      if (answerEl) answerEl.textContent = msg;
    }
  };

  window.refreshChargeAIAssistantPanel = ensurePanel;

  document.addEventListener("click", () => setTimeout(ensurePanel, 0));
  document.addEventListener("DOMContentLoaded", ensurePanel);
  setInterval(ensurePanel, 1000);
})();
