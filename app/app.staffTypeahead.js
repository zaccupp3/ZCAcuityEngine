// app/app.staffTypeahead.js
// ---------------------------------------------------------
// STAFF NAME TYPEAHEAD (Unit Staff Directory)
// - Works with your unit_staff table via window.sb.* helpers
// - Adds autocomplete suggestions when typing staff names
// - If user types a new name and leaves the field (blur),
//   it auto-creates it in unit_staff and caches it.
//
// Roles MUST be exactly: "RN" | "PCA"
// We infer role based on which list container the input is inside.
//
// Targets (by container):
// - #currentNurseList, #incomingNurseList  -> RN
// - #currentPcaList,   #incomingPcaList    -> PCA
// - Leadership fields (#currentChargeName, etc) -> RN
// ---------------------------------------------------------

(function () {
  const $ = (id) => document.getElementById(id);

  function sbReady() {
    return !!(window.sb && window.sb.client && window.sb.__ready);
  }

  function activeUnitId() {
    return window.activeUnitId ? String(window.activeUnitId) : "";
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function safeStr(x) {
    return String(x ?? "").trim();
  }

  function normNameForCompare(s) {
    return safeStr(s).toLowerCase().replace(/\s+/g, " ");
  }

  // ---------------------------------------------------------
  // Lightweight UI: suggestion dropdown
  // ---------------------------------------------------------
  function ensureDropdown() {
    let el = document.getElementById("staffTypeaheadDropdown");
    if (el) return el;

    el = document.createElement("div");
    el.id = "staffTypeaheadDropdown";
    el.style.position = "fixed";
    el.style.zIndex = "100000";
    el.style.minWidth = "240px";
    el.style.maxWidth = "420px";
    el.style.maxHeight = "240px";
    el.style.overflowY = "auto";
    el.style.background = "#fff";
    el.style.border = "1px solid rgba(15,23,42,0.18)";
    el.style.borderRadius = "12px";
    el.style.boxShadow = "0 14px 40px rgba(15,23,42,0.18)";
    el.style.display = "none";
    el.style.padding = "6px";
    el.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    el.style.fontSize = "13px";
    el.style.color = "#0f172a";

    document.body.appendChild(el);
    return el;
  }

  function hideDropdown() {
    const el = ensureDropdown();
    el.style.display = "none";
    el.innerHTML = "";
    el.__targetInput = null;
  }

  function positionDropdownForInput(input) {
    const el = ensureDropdown();
    const r = input.getBoundingClientRect();

    const top = Math.min(window.innerHeight - 12, r.bottom + 6);
    const left = Math.min(window.innerWidth - 12, r.left);

    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    el.style.width = `${Math.max(240, Math.min(420, r.width))}px`;
  }

  function renderDropdown(input, items, metaText) {
    const el = ensureDropdown();
    el.__targetInput = input;

    el.innerHTML = "";

    const meta = document.createElement("div");
    meta.textContent = metaText || "";
    meta.style.fontSize = "12px";
    meta.style.opacity = "0.7";
    meta.style.padding = "6px 8px 8px 8px";
    el.appendChild(meta);

    if (!items.length) {
      const empty = document.createElement("div");
      empty.textContent = "No matches. Keep typing to create a new name.";
      empty.style.padding = "10px 8px";
      empty.style.opacity = "0.75";
      el.appendChild(empty);
    } else {
      items.forEach((row) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.style.width = "100%";
        btn.style.textAlign = "left";
        btn.style.border = "0";
        btn.style.background = "transparent";
        btn.style.padding = "10px 10px";
        btn.style.borderRadius = "10px";
        btn.style.cursor = "pointer";

        btn.onmouseenter = () => (btn.style.background = "rgba(15,23,42,0.06)");
        btn.onmouseleave = () => (btn.style.background = "transparent");

        const name = row.display_name || row.name || "—";
        const role = row.role || "—";

        btn.innerHTML = `
          <div style="font-weight:800;">${escapeHtml(name)}</div>
          <div style="font-size:12px; opacity:0.7;">${escapeHtml(role)} • saved</div>
        `;

        btn.onclick = () => {
          try {
            input.value = name;
            input.dataset.staffId = row.id || "";
            input.dataset.staffRole = role || "";
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          } finally {
            hideDropdown();
          }
        };

        el.appendChild(btn);
      });
    }

    positionDropdownForInput(input);
    el.style.display = "block";
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // Close dropdown if click outside
  document.addEventListener("mousedown", (e) => {
    const dd = document.getElementById("staffTypeaheadDropdown");
    if (!dd || dd.style.display === "none") return;
    const t = e.target;
    if (dd.contains(t)) return;
    if (dd.__targetInput && dd.__targetInput.contains && dd.__targetInput.contains(t)) return;
    hideDropdown();
  });

  window.addEventListener("resize", () => {
    const dd = document.getElementById("staffTypeaheadDropdown");
    if (!dd || dd.style.display === "none") return;
    const input = dd.__targetInput;
    if (input) positionDropdownForInput(input);
  });

  // ---------------------------------------------------------
  // Cache per unit+role
  // ---------------------------------------------------------
  const cache = {
    // key: `${unitId}:${role}` -> { rows: [], loadedAt: ts }
    map: new Map()
  };

  function cacheKey(unitId, role) {
    return `${unitId}:${role}`;
  }

  async function ensureCacheLoaded(unitId, role) {
    const key = cacheKey(unitId, role);
    const existing = cache.map.get(key);
    const now = Date.now();

    // refresh cache every 5 minutes
    if (existing && now - (existing.loadedAt || 0) < 5 * 60 * 1000) return existing.rows || [];

    if (!sbReady() || typeof window.sb.listUnitStaff !== "function") return [];

    const res = await window.sb.listUnitStaff(unitId, role, 300);
    if (res?.error) {
      console.warn("[staff-typeahead] listUnitStaff error", res.error);
      return existing?.rows || [];
    }

    const rows = Array.isArray(res?.rows) ? res.rows : [];
    cache.map.set(key, { rows, loadedAt: now });
    return rows;
  }

  function upsertCacheRow(unitId, role, row) {
    const key = cacheKey(unitId, role);
    const existing = cache.map.get(key) || { rows: [], loadedAt: Date.now() };
    const rows = Array.isArray(existing.rows) ? existing.rows.slice() : [];
    const id = row?.id;

    // remove duplicates by id or name
    const nm = normNameForCompare(row?.display_name);
    const filtered = rows.filter((r) => {
      if (id && r?.id === id) return false;
      if (nm && normNameForCompare(r?.display_name) === nm) return false;
      return true;
    });

    filtered.unshift(row);
    cache.map.set(key, { rows: filtered, loadedAt: Date.now() });
  }

  // ---------------------------------------------------------
  // Identify which inputs should get typeahead
  // ---------------------------------------------------------
  const LEADERSHIP_IDS = new Set([
    "currentChargeName",
    "currentMentorName",
    "currentCtaName",
    "incomingChargeName",
    "incomingMentorName",
    "incomingCtaName"
  ]);

  function roleForInput(input) {
    if (!input) return "";

    // Leadership => RN
    if (input.id && LEADERSHIP_IDS.has(input.id)) return "RN";

    // Infer from list container
    const rnContainers = ["currentNurseList", "incomingNurseList"];
    const pcaContainers = ["currentPcaList", "incomingPcaList"];

    for (const id of rnContainers) {
      const wrap = $(id);
      if (wrap && wrap.contains(input)) return "RN";
    }
    for (const id of pcaContainers) {
      const wrap = $(id);
      if (wrap && wrap.contains(input)) return "PCA";
    }

    return "";
  }

  function looksLikeNameField(input) {
    if (!input) return false;
    if (input.tagName !== "INPUT") return false;
    if ((input.type || "").toLowerCase() !== "text") return false;

    // Leadership inputs are definitely name fields
    if (input.id && LEADERSHIP_IDS.has(input.id)) return true;

    // Inside staff lists, we try to avoid tagging restriction fields, etc.
    // Heuristic: placeholder includes "Name" OR id/class includes "name"
    const ph = safeStr(input.placeholder).toLowerCase();
    const idc = `${safeStr(input.id)} ${safeStr(input.className)}`.toLowerCase();

    if (ph.includes("name")) return true;
    if (idc.includes("name")) return true;

    // If it is inside staff list containers and fairly short, treat as name
    const r = roleForInput(input);
    if (r && (input.maxLength === 0 || input.maxLength >= 10)) return true;

    return false;
  }

  // ---------------------------------------------------------
  // Attach behavior (debounced input + blur create)
  // ---------------------------------------------------------
  function attachTypeahead(input) {
    if (!input || input.__staffTypeaheadAttached) return;
    if (!looksLikeNameField(input)) return;

    const role = roleForInput(input);
    if (!role) return;

    input.__staffTypeaheadAttached = true;

    let lastQuery = "";
    let debounceTimer = null;

    input.addEventListener("focus", async () => {
      const unitId = activeUnitId();
      if (!unitId) return;

      // load cache & show a small list when empty query
      await ensureCacheLoaded(unitId, role);

      const q = safeStr(input.value);
      lastQuery = q;

      const rows = await suggest(unitId, role, q, 10);
      renderDropdown(input, rows, `${role} suggestions • unit staff directory`);
    });

    input.addEventListener("input", () => {
      const unitId = activeUnitId();
      if (!unitId) return;

      const q = safeStr(input.value);
      lastQuery = q;

      // if user edits, clear staffId because it might be a different person now
      input.dataset.staffId = "";

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        // if input blurred since timer, don't show
        if (document.activeElement !== input) return;

        const rows = await suggest(unitId, role, lastQuery, 10);
        renderDropdown(input, rows, `${role} suggestions • typing creates new names automatically`);
      }, 180);
    });

    input.addEventListener("keydown", (e) => {
      // Escape closes dropdown
      if (e.key === "Escape") hideDropdown();
    });

    input.addEventListener("blur", async () => {
      // allow click selection to register first
      await sleep(140);

      const unitId = activeUnitId();
      if (!unitId) return;

      hideDropdown();

      const name = safeStr(input.value);
      if (!name) return;

      // If already linked, done
      if (safeStr(input.dataset.staffId)) return;

      // If name exists in cache, bind to it
      const rows = await ensureCacheLoaded(unitId, role);
      const match = rows.find((r) => normNameForCompare(r.display_name) === normNameForCompare(name));
      if (match) {
        input.dataset.staffId = match.id || "";
        input.dataset.staffRole = match.role || role;
        return;
      }

      // Otherwise, create it
      if (!sbReady() || typeof window.sb.upsertUnitStaff !== "function") {
        console.warn("[staff-typeahead] sb.upsertUnitStaff missing or supabase not ready");
        return;
      }

      try {
        const res = await window.sb.upsertUnitStaff({
          unit_id: unitId,
          role,
          display_name: name
        });

        if (res?.error) {
          console.warn("[staff-typeahead] upsertUnitStaff error", res.error);
          return;
        }

        const row = res?.row;
        if (row) {
          input.dataset.staffId = row.id || "";
          input.dataset.staffRole = row.role || role;
          upsertCacheRow(unitId, role, row);
        }
      } catch (err) {
        console.warn("[staff-typeahead] exception creating staff", err);
      }
    });
  }

  async function suggest(unitId, role, query, limit) {
    const q = safeStr(query);
    const cached = await ensureCacheLoaded(unitId, role);

    // If no query, show first N alphabetically from cache
    if (!q) {
      return cached
        .slice()
        .sort((a, b) => safeStr(a.display_name).localeCompare(safeStr(b.display_name)))
        .slice(0, limit);
    }

    // First: local filter for instant feel
    const qn = normNameForCompare(q);
    const local = cached
      .filter((r) => normNameForCompare(r.display_name).includes(qn))
      .slice(0, limit);

    // If we have enough, skip network
    if (local.length >= Math.min(6, limit)) return local;

    // Otherwise: call server search to catch newer rows
    if (sbReady() && typeof window.sb.searchUnitStaff === "function") {
      const res = await window.sb.searchUnitStaff(unitId, role, q, limit);
      if (!res?.error && Array.isArray(res?.rows)) {
        // merge into cache
        res.rows.forEach((row) => upsertCacheRow(unitId, role, row));
        return res.rows.slice(0, limit);
      }
    }

    return local;
  }

  // ---------------------------------------------------------
  // Watch for dynamic renders in staffing lists
  // ---------------------------------------------------------
  function scanAndAttach() {
    const candidates = [];

    // leadership inputs
    LEADERSHIP_IDS.forEach((id) => {
      const el = $(id);
      if (el) candidates.push(el);
    });

    // staff list containers
    const containers = ["currentNurseList", "incomingNurseList", "currentPcaList", "incomingPcaList"];
    containers.forEach((cid) => {
      const wrap = $(cid);
      if (!wrap) return;
      wrap.querySelectorAll("input[type='text']").forEach((inp) => candidates.push(inp));
    });

    candidates.forEach((inp) => attachTypeahead(inp));
  }

  function observeContainer(id) {
    const wrap = $(id);
    if (!wrap) return;

    const obs = new MutationObserver(() => scanAndAttach());
    obs.observe(wrap, { childList: true, subtree: true });
  }

  window.addEventListener("DOMContentLoaded", () => {
    // initial attach
    scanAndAttach();

    // observe dynamic lists (these are re-rendered frequently)
    ["currentNurseList", "incomingNurseList", "currentPcaList", "incomingPcaList"].forEach(observeContainer);

    // Expose debug helper
    window.staffTypeahead = window.staffTypeahead || {};
    window.staffTypeahead.rescan = scanAndAttach;

    console.log("[staff-typeahead] ready");
  });
})();