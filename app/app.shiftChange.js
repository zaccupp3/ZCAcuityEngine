// app/app.shiftChange.js
// ---------------------------------------------------------
// Shift Finalize / Publish (FOUNDATION-LOCKED)
//
// Writes:
// - shift_snapshots (UPSERT)  ✅ now includes FULL patient state
// - staff_shift_metrics (UPSERT batch)
// - analytics_shift_metrics (UPSERT)
//
// GUARANTEES:
// - Snapshots persist complete patient truth
// - Analytics are patient-deduped, unit-level
// - Future backfills + re-scoring are safe
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
    return clampDateStr(el?.value) || new Date().toISOString().slice(0, 10);
  }

  function getShiftType() {
    const el = $("finalizeShiftType");
    const v = String(el?.value || "");
    return v === "day" || v === "night" ? v : "day";
  }

  function setMsg(msg, isError = false) {
    const el = $("finalizeStatusMsg");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isError ? "#b91c1c" : "#0f172a";
  }

  async function getUserIdSafe() {
    try {
      const { data } = await window.sb.client.auth.getSession();
      return data?.session?.user?.id || null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------
  // Patients
  // ---------------------------------------------------------
  function activePatients() {
    return safeArray(window.patients).filter(p => p && !p.isEmpty);
  }

  // ---------------------------------------------------------
  // TAG NORMALIZATION (single source of truth)
  // ---------------------------------------------------------
  const TAG_ALIASES = {
    tele: ["tele"],
    drip: ["drip"],
    nih: ["nih"],
    bg: ["bg"],
    ciwa: ["ciwa", "ciwa_cows"],
    cows: ["cows"],
    restraint: ["restraint"],
    sitter: ["sitter"],
    vpo: ["vpo"],
    iso: ["iso", "isolation"],
    admit: ["admit"],
    late_dc: ["late_dc", "lateDc", "lateDC"],
    chg: ["chg"],
    foley: ["foley"],
    q2: ["q2", "q2turns"],
    heavy: ["heavy"],
    feeder: ["feeder"]
  };

  function hasTag(p, key) {
    return (TAG_ALIASES[key] || [key]).some(k => !!p?.[k]);
  }

  // ---------------------------------------------------------
  // ROLE-SCOPED TAG COUNTS (staff metrics)
  // ---------------------------------------------------------
  const RN_KEYS = ["tele","drip","nih","bg","ciwa","cows","restraint","sitter","vpo","iso","admit","late_dc"];
  const PCA_KEYS = ["tele","chg","foley","q2","heavy","feeder","iso","admit","late_dc"];

  function countTagsForRole(patientIds, role) {
    const keys = role === "RN" ? RN_KEYS : PCA_KEYS;
    const counts = {};
    keys.forEach(k => counts[k] = 0);

    patientIds.forEach(pid => {
      const p = window.patients.find(x => Number(x?.id) === Number(pid));
      if (!p || p.isEmpty) return;
      keys.forEach(k => { if (hasTag(p, k)) counts[k]++; });
    });

    Object.keys(counts).forEach(k => { if (!counts[k]) delete counts[k]; });
    return counts;
  }

  // ---------------------------------------------------------
  // UNIT-WIDE TAG COUNTS (analytics, patient-deduped)
  // ---------------------------------------------------------
  const SHIFT_WIDE_KEYS = Array.from(new Set([...RN_KEYS, ...PCA_KEYS]));

  function countTagsShiftWide() {
    const counts = {};
    SHIFT_WIDE_KEYS.forEach(k => counts[k] = 0);

    activePatients().forEach(p => {
      SHIFT_WIDE_KEYS.forEach(k => { if (hasTag(p, k)) counts[k]++; });
    });

    Object.keys(counts).forEach(k => { if (!counts[k]) delete counts[k]; });
    return counts;
  }

  function buildTopTags(tagCounts, limit = 12) {
    return Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");
  }

  // ---------------------------------------------------------
  // FINALIZE
  // ---------------------------------------------------------
  async function publishAll() {
    if (!canWrite() || !sbReady()) {
      setMsg("Cannot finalize shift.", true);
      return { ok: false };
    }

    const unit_id = getActiveUnitId();
    const shift_date = getShiftDate();
    const shift_type = getShiftType();
    const created_by = await getUserIdSafe();

    const pts = activePatients();
    const admits = safeArray(window.admitQueue).length;
    const discharges = safeArray(window.dischargeHistory).length;

    // --- SNAPSHOT (FULL STATE PERSISTED)
    await window.sb.upsertShiftSnapshot({
      unit_id,
      shift_date,
      shift_type,
      status: "published",
      state: {
        total_pts: pts.length,
        admits,
        discharges,
        patients: JSON.parse(JSON.stringify(window.patients))
      },
      created_by
    });

    // --- ANALYTICS (v2, rebuildable)
    const tag_counts = countTagsShiftWide();
    await window.sb.upsertAnalyticsShiftMetrics({
      unit_id,
      shift_date,
      shift_type,
      created_by,
      metrics: {
        version: 2,
        totals: { total_pts: pts.length, admits, discharges },
        tag_counts,
        top_tags: buildTopTags(tag_counts)
      }
    });

    // --- STAFF METRICS
    const rows = [];

    for (const rn of safeArray(window.incomingNurses)) {
      const patient_ids = safeArray(rn.patients).map(Number);
      const ensured = await window.sb.ensureUnitStaff(unit_id, "RN", rn.name);
      if (!ensured?.row?.id) continue;

      rows.push({
        unit_id, shift_date, shift_type,
        staff_id: ensured.row.id,
        staff_name: rn.name,
        role: "RN",
        patients_assigned: patient_ids.length,
        workload_score: window.getNurseLoadScore?.(rn) || 0,
        tag_counts: countTagsForRole(patient_ids, "RN"),
        details: { patient_ids },
        created_by
      });
    }

    for (const pca of safeArray(window.incomingPcas)) {
      const patient_ids = safeArray(pca.patients).map(Number);
      const ensured = await window.sb.ensureUnitStaff(unit_id, "PCA", pca.name);
      if (!ensured?.row?.id) continue;

      rows.push({
        unit_id, shift_date, shift_type,
        staff_id: ensured.row.id,
        staff_name: pca.name,
        role: "PCA",
        patients_assigned: patient_ids.length,
        workload_score: window.getPcaLoadScore?.(pca) || 0,
        tag_counts: countTagsForRole(patient_ids, "PCA"),
        details: { patient_ids },
        created_by
      });
    }

    await window.sb.upsertStaffShiftMetrics(rows);
    setMsg("Finalize complete ✅");
    return { ok: true };
  }

  async function handleFinalize() {
    const btn = $("btnFinalizeShift");
    try {
      if (btn) btn.disabled = true;
      const res = await publishAll();
      if (res.ok && window.finalizeShiftChange) window.finalizeShiftChange();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    const btn = $("btnFinalizeShift");
    if (btn) btn.addEventListener("click", e => {
      e.preventDefault();
      handleFinalize();
    });
  });
})();