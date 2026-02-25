// app/app.guardrails.js
// ----------------------------------------------------
// Global guardrails to prevent silent performance decay
// - wireOnce / intervalOnce / timeoutOnce / rafOnce
// - single-flight refresh wrapper
// - dev-only duplicate listener warnings
// - optional render budget alarms
// ----------------------------------------------------
(function () {
  // Toggle dev diagnostics in console:
  //   window.DEBUG_RENDER = true;
  if (typeof window.DEBUG_RENDER !== "boolean") window.DEBUG_RENDER = false;

  // -----------------------------
  // 1) Idempotent wiring helpers
  // -----------------------------
  window.__wireOnce =
    window.__wireOnce ||
    function __wireOnce(key, fn) {
      const bag = (window.__wired = window.__wired || {});
      if (bag[key]) return false;
      bag[key] = true;
      try {
        fn();
      } catch (e) {
        console.warn("[wireOnce]", key, e);
      }
      return true;
    };

  window.__intervalOnce =
    window.__intervalOnce ||
    function __intervalOnce(key, fn, ms) {
      const bag = (window.__intervals = window.__intervals || {});
      if (bag[key]) return bag[key];
      const id = setInterval(() => {
        try {
          fn();
        } catch (e) {
          if (window.DEBUG_RENDER) console.warn("[intervalOnce]", key, e);
        }
      }, ms);
      bag[key] = id;
      return id;
    };

  window.__timeoutOnce =
    window.__timeoutOnce ||
    function __timeoutOnce(key, fn, ms) {
      const bag = (window.__timeouts = window.__timeouts || {});
      if (bag[key]) return bag[key];
      const id = setTimeout(() => {
        try {
          fn();
        } finally {
          try {
            delete bag[key];
          } catch {}
        }
      }, ms);
      bag[key] = id;
      return id;
    };

  window.__rafOnce =
    window.__rafOnce ||
    function __rafOnce(key, fn) {
      const bag = (window.__rafs = window.__rafs || {});
      if (bag[key]) return bag[key];
      const id = requestAnimationFrame(() => {
        try {
          fn();
        } finally {
          try {
            delete bag[key];
          } catch {}
        }
      });
      bag[key] = id;
      return id;
    };

  // -------------------------------------
  // 2) Single-flight refreshAllUI wrapper
  // -------------------------------------
  window.__refreshSF = window.__refreshSF || {
    inFlight: false,
    queued: false,
    lastReason: null,
  };

  window.requestRefreshAllUI =
    window.requestRefreshAllUI ||
    function requestRefreshAllUI(reason = "unknown") {
      const sf = window.__refreshSF;
      sf.lastReason = reason;

      if (sf.inFlight) {
        sf.queued = true;
        return;
      }

      sf.inFlight = true;
      sf.queued = false;

      // Coalesce bursts to next tick
      setTimeout(() => {
        try {
          if (typeof window.refreshAllUI === "function") {
            window.refreshAllUI();
          }
        } catch (e) {
          console.warn("[requestRefreshAllUI] refreshAllUI failed:", e);
        } finally {
          sf.inFlight = false;
          if (sf.queued) {
            sf.queued = false;
            window.requestRefreshAllUI("queued");
          }
        }
      }, 0);
    };

  // Optional: automatically wrap refreshAllUI callers if you have modules calling it directly
  // (This doesn't change behavior; it just gives you a safer API to use going forward.)

  // -------------------------------------
  // 3) Dev-only duplicate listener warnings
  // -------------------------------------
  if (!window.__listenerRegistryInstalled) {
    window.__listenerRegistryInstalled = true;

    const orig = EventTarget.prototype.addEventListener;
    const reg = (window.__listenerRegistry = window.__listenerRegistry || new WeakMap());

    EventTarget.prototype.addEventListener = function (type, listener, options) {
      try {
        if (window.DEBUG_RENDER) {
          let m = reg.get(this);
          if (!m) {
            m = new Map();
            reg.set(this, m);
          }
          const id = listener; // function identity
          const key = `${type}::${options ? JSON.stringify(options) : ""}`;
          const bucketKey = `${key}`;
          const bucket = m.get(bucketKey) || new Map();
          bucket.set(id, (bucket.get(id) || 0) + 1);
          m.set(bucketKey, bucket);

          if (bucket.get(id) === 2) {
            console.warn("[dup-listener]", type, listener?.name || "(anon)", this);
          }
        }
      } catch {}
      return orig.call(this, type, listener, options);
    };
  }

  // -------------------------------------
  // 4) Dev-only render budget alarms
  // -------------------------------------
  window.__renderBudget = window.__renderBudget || { windowMs: 2000, maxCalls: 12 };
  window.__renderCallLog = window.__renderCallLog || [];

  window.__logRenderCall =
    window.__logRenderCall ||
    function __logRenderCall(name) {
      if (!window.DEBUG_RENDER) return;
      const now = performance.now();
      const log = window.__renderCallLog;
      log.push({ name, t: now });

      const cutoff = now - window.__renderBudget.windowMs;
      while (log.length && log[0].t < cutoff) log.shift();

      const count = log.reduce((acc, x) => (x.name === name ? acc + 1 : acc), 0);
      if (count > window.__renderBudget.maxCalls) {
        console.warn(
          `[render-budget] ${name} called ${count}x in ${window.__renderBudget.windowMs}ms`
        );
      }
    };

  console.log("[guardrails] loaded", {
    DEBUG_RENDER: window.DEBUG_RENDER,
    hasWireOnce: typeof window.__wireOnce === "function",
    hasRequestRefreshAllUI: typeof window.requestRefreshAllUI === "function",
  });
})();