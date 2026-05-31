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

  // -------------------------------------
  // 5) Always-on lightweight performance probe
  // -------------------------------------
  window.__perfProbe = window.__perfProbe || {
    enabled: true,
    maxSamples: 300,
    samples: {},
    wrapped: {},
    lastReport: null
  };

  function __perfNow() {
    try { return performance.now(); } catch (_) { return Date.now(); }
  }

  function __perfRecord(name, ms, meta) {
    const probe = window.__perfProbe;
    if (!probe || probe.enabled === false) return;
    const key = String(name || "unknown");
    const list = probe.samples[key] = probe.samples[key] || [];
    list.push({
      ms: Math.max(0, Number(ms) || 0),
      at: Date.now(),
      meta: meta || null
    });
    while (list.length > (Number(probe.maxSamples) || 300)) list.shift();
  }

  function __perfStats(list) {
    const rows = (Array.isArray(list) ? list : []).map((x) => Number(x?.ms) || 0).sort((a, b) => a - b);
    const n = rows.length;
    const pick = (p) => n ? rows[Math.min(n - 1, Math.max(0, Math.floor((n - 1) * p)))] : 0;
    const avg = n ? rows.reduce((sum, x) => sum + x, 0) / n : 0;
    return {
      n,
      avg: Number(avg.toFixed(1)),
      p50: Number(pick(0.50).toFixed(1)),
      p75: Number(pick(0.75).toFixed(1)),
      p95: Number(pick(0.95).toFixed(1)),
      max: Number((n ? rows[n - 1] : 0).toFixed(1))
    };
  }

  window.perfReport = window.perfReport || function perfReport() {
    const probe = window.__perfProbe || {};
    const out = {};
    Object.keys(probe.samples || {}).sort().forEach((name) => {
      out[name] = __perfStats(probe.samples[name]);
    });
    probe.lastReport = out;
    try { console.table(out); } catch (_) { console.log(out); }
    return out;
  };

  window.perfReset = window.perfReset || function perfReset() {
    window.__perfProbe.samples = {};
    return true;
  };

  window.perfRecord = window.perfRecord || __perfRecord;

  function __perfWrap(name, owner, fnName, opts = {}) {
    const probe = window.__perfProbe;
    if (!probe || !owner || typeof owner[fnName] !== "function") return false;
    const key = `${name}:${fnName}`;
    if (probe.wrapped[key]) return true;
    const original = owner[fnName];
    if (original.__perfWrapped) {
      probe.wrapped[key] = true;
      return true;
    }

    const wrapped = function perfWrappedFunction() {
      const t0 = __perfNow();
      let result;
      try {
        result = original.apply(this, arguments);
      } catch (e) {
        __perfRecord(name, __perfNow() - t0, { error: true });
        throw e;
      }

      const finish = () => {
        const dt = __perfNow() - t0;
        __perfRecord(name, dt);
        if (Number(opts.warnMs) && dt > Number(opts.warnMs)) {
          try { console.warn(`[perf] ${name} took ${dt.toFixed(1)}ms`); } catch (_) {}
        }
      };

      if (result && typeof result.then === "function") {
        return result.finally(finish);
      }

      finish();
      if (opts.nextPaint) {
        try {
          requestAnimationFrame(() => {
            __perfRecord(`${name}:to_next_paint`, __perfNow() - t0);
          });
        } catch (_) {}
      }
      return result;
    };
    wrapped.__perfWrapped = true;
    wrapped.__perfOriginal = original;
    owner[fnName] = wrapped;
    probe.wrapped[key] = true;
    return true;
  }

  function installPerfProbeWrappers() {
    const targets = [
      ["saveState", window, "saveState", { warnMs: 80 }],
      ["requestGlobalRefresh", window, "requestGlobalRefresh", { warnMs: 120, nextPaint: true }],
      ["refreshUI", window, "refreshUI", { warnMs: 120, nextPaint: true }],
      ["renderPatientList", window, "renderPatientList", { warnMs: 80 }],
      ["updateAcuityTiles", window, "updateAcuityTiles", { warnMs: 50 }],
      ["renderLiveAssignments", window, "renderLiveAssignments", { warnMs: 100 }],
      ["renderAssignmentOutput", window, "renderAssignmentOutput", { warnMs: 100 }],
      ["renderPcaAssignmentOutput", window, "renderPcaAssignmentOutput", { warnMs: 100 }],
      ["renderSitterAssignmentOutput", window, "renderSitterAssignmentOutput", { warnMs: 60 }],
      ["onRowDrop", window, "onRowDrop", { warnMs: 120, nextPaint: true }],
      ["openPatientProfile", window, "openPatientProfileFromRoom", { warnMs: 80, nextPaint: true }],
      ["savePatientProfile", window, "savePatientProfile", { warnMs: 120, nextPaint: true }]
    ];
    targets.forEach(([name, owner, fnName, opts]) => {
      try { __perfWrap(name, owner, fnName, opts); } catch (_) {}
    });
  }

  window.installPerfProbeWrappers = installPerfProbeWrappers;
  window.perfMeasureImprovement = window.perfMeasureImprovement || function perfMeasureImprovement() {
    const report = window.perfReport();
    const full =
      report["requestGlobalRefresh:to_next_paint"]?.p50 ||
      report["refreshUI:to_next_paint"]?.p50 ||
      report.requestGlobalRefresh?.p50 ||
      report.refreshUI?.p50 ||
      0;
    const live = report.renderLiveAssignments?.p50 || 0;
    const rn = report.renderAssignmentOutput?.p50 || 0;
    const pca = report.renderPcaAssignmentOutput?.p50 || 0;
    const profile = report.savePatientProfile?.p50 || 0;
    const targetedMove = Math.max(live, rn, pca);
    const movePaint = report["onRowDrop:to_next_paint"]?.p50 || report.onRowDrop?.p50 || 0;
    const profilePaint = report["savePatientProfile:to_next_paint"]?.p50 || report.savePatientProfile?.p50 || 0;
    return {
      currentMoveP50: report.onRowDrop?.p50 || 0,
      currentMovePaintP50: report["onRowDrop:to_next_paint"]?.p50 || 0,
      currentMoveRatePerSecond: movePaint ? Number((1000 / movePaint).toFixed(2)) : 0,
      fullRefreshP50: full,
      targetedRenderP50: targetedMove,
      estimatedMoveSavingsMs: full && targetedMove ? Number(Math.max(0, full - targetedMove).toFixed(1)) : 0,
      profileSaveP50: profile,
      profileSavePaintP50: profilePaint,
      profileSaveRatePerSecond: profilePaint ? Number((1000 / profilePaint).toFixed(2)) : 0,
      note: "Collect 5-10 patient moves and profile saves, then run perfMeasureImprovement() again."
    };
  };

  installPerfProbeWrappers();
  setTimeout(installPerfProbeWrappers, 0);
  setTimeout(installPerfProbeWrappers, 750);
  setTimeout(installPerfProbeWrappers, 2000);
  setTimeout(installPerfProbeWrappers, 11000);

  console.log("[guardrails] loaded", {
    DEBUG_RENDER: window.DEBUG_RENDER,
    hasWireOnce: typeof window.__wireOnce === "function",
    hasRequestRefreshAllUI: typeof window.requestRefreshAllUI === "function",
    perfProbe: "run perfReport() after moving patients / saving profiles",
  });
})();
