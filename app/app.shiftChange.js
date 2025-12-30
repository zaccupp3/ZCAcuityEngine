// app/app.shiftChange.js
// ---------------------------------------------------------
// Shift Finalize / Publish
// - Writes shift_snapshots (UPSERT)
// - Writes staff_shift_metrics (UPSERT batch)
// - Writes analytics_shift_metrics (UPSERT)
//
// FIX (Dec 2025 / v2):
// ✅ Staff tag_counts remain ROLE-SCOPED (matches UI):
//    RN:  Tele, Drip, NIH, BG, CIWA/COWS, Restraint, Sitter, VPO, ISO, Admit, Late DC
//    PCA: Tele, CHG, Foley, Q2, Heavy, Feeder, ISO, Admit, Late DC
// ✅ Analytics shift metrics now stores:
//    - metrics.tag_counts      => UNIT-wide, patient-deduped (Tele NOT double-counted)
//    - metrics.rn_tag_counts   => RN role scope (Tele counted for RN workload)
//    - metrics.pca_tag_counts  => PCA role scope (Tele counted for PCA workload)
// ---------------------------------------------------------

(function () {
  const $ = (id) => document.getElementById(id);
  const safeArray = (v) => (Array.isArray(v) ? v : []);

  function getActiveUnitId() {
    return window.activeUnitId ? String(window.activeUnitId) : "";
  }

  function canWrite() {
    const r = String(window.activeUnitRole || "").toLowerCase();
    return r === "owner" || r === "admin" || r === "charge";
  }

  function sbReady() {
    return !!(window.sb && window.sb.client && window.sb.__ready);
  }

  function clampDateStr(s) {
    if (!s || typeof s !== "string") return "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
    return s;
  }

  function getShiftDate() {
    const el = $("finalizeShiftDate");
    const v = el ? clampDateStr(el.value) : "";
    return v || new Date().toISOString().slice(0, 10);
  }

  function getShiftType() {
    const el = $("finalizeShiftType");
    const v = el ? String(el.value || "") : "";
    return (v === "day" || v === "night") ? v : "day";
  }

  function setMsg(msg, isError = false) {
    const el = $("finalizeStatusMsg");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isError ? "#b91c1c" : "#0f172a";
    el.style.opacity = "0.85";
  }

  async function getUserIdSafe() {
    try {
      const { data } = await window.sb.client.auth.getSession();
      return data?.session?.user?.id || null;
    } catch {
      return null;
    }
  }

  // -------------------------
  // Patient helpers
  // -------------------------
  function getPatientByIdSafe(pid) {
    try {
      if (typeof window.getPatientById === "function") return window.getPatientById(pid);
    } catch {}
    const pts = safeArray(window.patients);
    return pts.find(p => Number(p?.id) === Number(pid)) || null;
  }

  function activePatients() {
    return safeArray(window.patients).filter(p => p && !p.isEmpty);
  }

  // -------------------------
  // ✅ Tag keys (UI exact)
  // Store in analytics as these canonical keys:
  // RN:  tele, drip, nih, bg, ciwa, cows, restraint, sitter, vpo, iso, admit, late_dc
  // PCA: tele, chg, foley, q2, heavy, feeder, iso, admit, late_dc
  // -------------------------
  const RN_KEYS = [
    "tele", "drip", "nih", "bg", "ciwa", "cows",
    "restraint", "sitter", "vpo", "iso", "admit", "late_dc"
  ];

  const PCA_KEYS = [
    "tele", "chg", "foley", "q2", "heavy", "feeder",
    "iso", "admit", "late_dc"
  ];

  const UNIT_KEYS = Array.from(new Set([...RN_KEYS, ...PCA_KEYS]));

  function truthy(v) {
    return !!v;
  }

  // Map patient fields to canonical keys
  function patientHasTag(p, key) {
    if (!p) return false;

    switch (key) {
      case "iso":
        return truthy(p.iso) || truthy(p.ISO) || truthy(p.isolation) || truthy(p.Isolation);
      case "late_dc":
        return truthy(p.late_dc) || truthy(p.lateDc) || truthy(p.lateDC) || truthy(p.LateDC);
      case "q2":
        return truthy(p.q2) || truthy(p.q2turns) || truthy(p.q2Turns) || truthy(p.Q2);
      case "ciwa":
        return truthy(p.ciwa) || truthy(p.CIWA);
      case "cows":
        return truthy(p.cows) || truthy(p.COWS);
      default:
        // most are stored as simple booleans (tele, drip, nih, bg, restraint, sitter, vpo, chg, foley, heavy, feeder, admit)
        return truthy(p[key]) || truthy(p[String(key).toUpperCase()]);
    }
  }

  // -------------------------
  // ROLE-SCOPED TAG COUNTS (per staff, used by staff_shift_metrics)
  // -------------------------
  function countTagsForRole(patientIds, role) {
    const r = String(role || "").toUpperCase();
    const keys = (r === "RN") ? RN_KEYS : (r === "PCA") ? PCA_KEYS : [];
    const counts = {};

    safeArray(patientIds).forEach(pid => {
      const p = getPatientByIdSafe(pid);
      if (!p || p.isEmpty) return;

      keys.forEach(k => {
        if (patientHasTag(p, k)) counts[k] = (counts[k] || 0) + 1;
      });
    });

    return counts;
  }

  // -------------------------
  // ✅ UNIT-wide tag_counts (patient-deduped)
  // Each patient contributes at most 1 count per tag.
  // This prevents Tele double-counting on Unit Pulse.
  // -------------------------
  function countTagsUnitWideDeduped() {
    const counts = {};
    const pts = activePatients();

    pts.forEach(p => {
      UNIT_KEYS.forEach(k => {
        if (patientHasTag(p, k)) counts[k] = (counts[k] || 0) + 1;
      });
    });

    return counts;
  }

  // patient-deduped within a ROLE’s covered patients (RN vs PCA)
  function countTagsForRoleAcrossOwners(owners, role) {
    const set = new Set();
    safeArray(owners).forEach(o => {
      safeArray(o?.patients).forEach(pid => {
        const n = Number(pid);
        if (Number.isFinite(n)) set.add(n);
      });
    });
    return countTagsForRole(Array.from(set), role);
  }

  function toTopTagsString(tagCounts, limit = 10) {
    const entries = Object.entries(tagCounts || {})
      .map(([k, v]) => ({ k, v: Number(v) || 0 }))
      .filter(x => x.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, limit);
    return entries.map(x => `${x.k}:${x.v}`).join(", ");
  }

  // -------------------------
  // Hard rule eval helper
  // -------------------------
  function ruleEvalForOwner(owners, roleKey, owner) {
    // roleKey is what your rules engine expects: "nurse" or "pca"
    try {
      if (typeof window.evaluateAssignmentHardRules !== "function") return { violations: [], warnings: [] };
      const map = window.evaluateAssignmentHardRules(owners, roleKey);
      if (!map || typeof map !== "object") return { violations: [], warnings: [] };

      const key = owner?.name || owner?.label || null;
      if (key && map[key]) return map[key];

      if (key) {
        const foundKey = Object.keys(map).find(k => String(k).toLowerCase() === String(key).toLowerCase());
        if (foundKey) return map[foundKey];
      }
    } catch {}
    return { violations: [], warnings: [] };
  }

  // -------------------------
  // Publish: shift_snapshots + staff_shift_metrics + analytics_shift_metrics
  // -------------------------
  async function publishAll() {
    const unit_id = getActiveUnitId();
    if (!unit_id) { setMsg("No active unit selected.", true); return { ok: false }; }
    if (!canWrite()) { setMsg("Finalize requires owner/admin/charge on the active unit.", true); return { ok: false }; }
    if (!sbReady()) { setMsg("Supabase not ready.", true); return { ok: false }; }

    if (typeof window.sb.upsertShiftSnapshot !== "function") {
      setMsg("Missing sb.upsertShiftSnapshot() in app.supabase.js", true);
      return { ok: false };
    }
    if (typeof window.sb.upsertStaffShiftMetrics !== "function") {
      setMsg("Missing sb.upsertStaffShiftMetrics() in app.supabase.js", true);
      return { ok: false };
    }
    if (typeof window.sb.ensureUnitStaff !== "function") {
      setMsg("Missing sb.ensureUnitStaff() (needed to get staff_id UUIDs).", true);
      return { ok: false };
    }

    const shift_date = getShiftDate();
    const shift_type = getShiftType();
    const created_by = await getUserIdSafe();

    const ptsActive = activePatients();
    const admitsCount = Array.isArray(window.admitQueue) ? window.admitQueue.length : 0;
    const dischargesCount = Array.isArray(window.dischargeHistory) ? window.dischargeHistory.length : 0;

    // Owners (oncoming/incoming)
    const rnOwners = safeArray(window.incomingNurses);
    const pcaOwners = safeArray(window.incomingPcas);

    // ✅ Compute analytics tag maps BEFORE writing analytics
    // Unit-wide (patient-deduped) — fixes Tele double-count in Unit Pulse
    const unitTagCounts = countTagsUnitWideDeduped();
    // Role-scoped totals (patient-deduped within each role’s covered patients)
    const rnRoleTotals = countTagsForRoleAcrossOwners(rnOwners, "RN");
    const pcaRoleTotals = countTagsForRoleAcrossOwners(pcaOwners, "PCA");

    // ---- shift snapshot payload (minimal but useful)
    const snapshotPayload = {
      unit_id,
      shift_date,
      shift_type,
      status: "published",
      state: {
        unit_id,
        shift_date,
        shift_type,
        total_pts: ptsActive.length,
        admits: admitsCount,
        discharges: dischargesCount
      },
      created_by
    };

    setMsg("Publishing shift snapshot…");
    const snap = await window.sb.upsertShiftSnapshot(snapshotPayload);
    if (snap?.error) {
      setMsg(`Snapshot publish failed: ${snap.error.message || String(snap.error)}`, true);
      return { ok: false };
    }

    // ---- analytics shift metrics (UPSERT)
    if (typeof window.sb.upsertAnalyticsShiftMetrics === "function") {
      try {
        await window.sb.upsertAnalyticsShiftMetrics({
          unit_id,
          shift_date,
          shift_type,
          created_by,
          metrics: {
            version: 2,
            totals: {
              totalPts: ptsActive.length,
              admits: admitsCount,
              discharges: dischargesCount
            },
            // ✅ Unit Pulse should use this (patient-deduped)
            tag_counts: unitTagCounts,
            // ✅ Workload views can use these if desired
            rn_tag_counts: rnRoleTotals,
            pca_tag_counts: pcaRoleTotals,
            // Optional convenience string (UnitPulse already supports strings too)
            top_tags: toTopTagsString(unitTagCounts, 10)
          }
        });
      } catch (e) {
        console.warn("[finalize] analytics upsert failed", e);
      }
    }

    // ---- staff metrics rows
    const rows = [];

    // RN rows
    for (const rn of rnOwners) {
      const staff_name = String(rn?.name || "").trim() || `Incoming RN ${rn?.id ?? ""}`.trim();
      const ensured = await window.sb.ensureUnitStaff(unit_id, "RN", staff_name);
      if (ensured?.error || !ensured?.row?.id) {
        console.warn("[finalize] ensureUnitStaff RN failed", ensured?.error);
        continue;
      }

      const patient_ids = safeArray(rn?.patients).map(Number).filter(n => Number.isFinite(n));
      const workload_score = (typeof window.getNurseLoadScore === "function")
        ? (Number(window.getNurseLoadScore(rn)) || 0)
        : 0;

      const drivers = (typeof window.getRnDriversSummaryFromPatientIds === "function")
        ? String(window.getRnDriversSummaryFromPatientIds(patient_ids) || "")
        : "";

      const ev = ruleEvalForOwner(rnOwners, "nurse", rn);

      rows.push({
        unit_id,
        shift_date,
        shift_type,
        staff_id: ensured.row.id,
        staff_name,
        role: "RN",
        patients_assigned: patient_ids.length,
        workload_score,
        hard_violations: safeArray(ev?.violations).length,
        hard_warnings: safeArray(ev?.warnings).length,
        tag_counts: countTagsForRole(patient_ids, "RN"),
        details: { drivers, patient_ids },
        created_by
      });
    }

    // PCA rows
    for (const pca of pcaOwners) {
      const staff_name = String(pca?.name || "").trim() || `Incoming PCA ${pca?.id ?? ""}`.trim();
      const ensured = await window.sb.ensureUnitStaff(unit_id, "PCA", staff_name);
      if (ensured?.error || !ensured?.row?.id) {
        console.warn("[finalize] ensureUnitStaff PCA failed", ensured?.error);
        continue;
      }

      const patient_ids = safeArray(pca?.patients).map(Number).filter(n => Number.isFinite(n));
      const workload_score = (typeof window.getPcaLoadScore === "function")
        ? (Number(window.getPcaLoadScore(pca)) || 0)
        : 0;

      const drivers = (typeof window.getPcaDriversSummaryFromPatientIds === "function")
        ? String(window.getPcaDriversSummaryFromPatientIds(patient_ids) || "")
        : "";

      const ev = ruleEvalForOwner(pcaOwners, "pca", pca);

      rows.push({
        unit_id,
        shift_date,
        shift_type,
        staff_id: ensured.row.id,
        staff_name,
        role: "PCA",
        patients_assigned: patient_ids.length,
        workload_score,
        hard_violations: safeArray(ev?.violations).length,
        hard_warnings: safeArray(ev?.warnings).length,
        tag_counts: countTagsForRole(patient_ids, "PCA"),
        details: { drivers, patient_ids },
        created_by
      });
    }

    setMsg("Publishing staff metrics…");
    const sm = await window.sb.upsertStaffShiftMetrics(rows);
    if (sm?.error) {
      console.warn("[finalize] staff metrics upsert failed", sm.error);
      setMsg("Snapshot published, but staff metrics failed (see console).", true);
      // Don’t hard-fail; snapshot still succeeded
    }

    setMsg("Publish complete ✅ Promoting Oncoming → Live…");
    return { ok: true };
  }

  async function handleFinalize() {
    const btn = $("btnFinalizeShift");
    try {
      if (btn) btn.disabled = true;

      const res = await publishAll();
      if (!res.ok) {
        if (btn) btn.disabled = false;
        return;
      }

      if (typeof window.finalizeShiftChange === "function") {
        window.finalizeShiftChange();
      } else {
        console.warn("[finalize] window.finalizeShiftChange missing");
      }

      try { if (typeof window.saveState === "function") window.saveState(); } catch {}

      setMsg("Finalize complete ✅ (published + promoted).");
    } catch (e) {
      console.warn("[finalize] error", e);
      setMsg(`Finalize error: ${String(e)}`, true);
      if (btn) btn.disabled = false;
    }
  }

  function wire() {
    const btn = $("btnFinalizeShift");
    if (!btn || btn.__wiredFinalize) return;
    btn.__wiredFinalize = true;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      handleFinalize();
    });
  }

  window.addEventListener("DOMContentLoaded", () => {
    wire();

    const d = $("finalizeShiftDate");
    if (d && !clampDateStr(d.value)) d.value = new Date().toISOString().slice(0, 10);

    const t = $("finalizeShiftType");
    if (t && !t.value) t.value = "day";
  });
})();