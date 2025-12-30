// app/app.shiftChange.js
// ---------------------------------------------------------
// Shift Finalize / Publish
// - Writes shift_snapshots (UPSERT)
// - Writes staff_shift_metrics (UPSERT batch)  ✅ role-scoped tag_counts
// - Writes analytics_shift_metrics (UPSERT)    ✅ UNIT-deduped tag_counts for Unit Pulse
// - Then calls window.finalizeShiftChange() to promote Incoming -> Live
//
// FIX (Dec 2025):
// - Staff tag_counts are ROLE-SCOPED to match the UI:
//   RN:  Tele, Drip, NIH, BG, CIWA/COWS, Restraint, Sitter, VPO, ISO, Admit, Late DC
//   PCA: Tele, CHG, Foley, Q2, Heavy, Feeder, ISO, Admit, Late DC
// - Tele is counted for PCA (role-scoped) ✅
// - UnitPulse/analytics tag_counts are patient-deduped ✅ (tele won't double)
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

  function activePatientIds() {
    return activePatients()
      .map(p => Number(p?.id))
      .filter(n => Number.isFinite(n));
  }

  // -------------------------
  // ✅ ROLE-SCOPED TAG KEYS
  // IMPORTANT: these must match your patient boolean property names
  // (based on what your DB is showing: tele/drip/bg/ciwa/sitter/etc.)
  // -------------------------
  const RN_KEYS = [
    "tele", "drip", "nih", "bg", "ciwa", "cows", "restraint", "sitter", "vpo",
    "iso", "admit", "lateDc"
  ];

  const PCA_KEYS = [
    "tele", "chg", "foley", "q2", "heavy", "feeder",
    "iso", "admit", "lateDc"
  ];

  function countTagsFromPatients(patientIds, keys) {
    const counts = {};
    safeArray(keys).forEach(k => counts[k] = 0);

    safeArray(patientIds).forEach(pid => {
      const p = getPatientByIdSafe(pid);
      if (!p || p.isEmpty) return;

      safeArray(keys).forEach(k => {
        if (p[k]) counts[k] += 1;
      });
    });

    // drop zeros
    Object.keys(counts).forEach(k => {
      if (!counts[k]) delete counts[k];
    });

    return counts;
  }

  function countTagsForRole(patientIds, role) {
    const r = String(role || "").toUpperCase();
    const keys = (r === "RN") ? RN_KEYS : (r === "PCA") ? PCA_KEYS : [];
    return countTagsFromPatients(patientIds, keys);
  }

  // ✅ UNIT-DEDUPED tags for Unit Pulse (no double counting tele)
  function countUnitTagCountsDedup() {
    // union of RN+PCA keys (dedup)
    const keys = Array.from(new Set([ ...RN_KEYS, ...PCA_KEYS ]));
    // use active patient list ONCE (dedup by patient)
    const pids = activePatientIds();
    return countTagsFromPatients(pids, keys);
  }

  function topTagsString(tagCounts, limit = 10) {
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

    // ---- shift snapshot payload (minimal but useful)
    const ptsActive = activePatients();
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
        admits: Array.isArray(window.admitQueue) ? window.admitQueue.length : 0,
        discharges: Array.isArray(window.dischargeHistory) ? window.dischargeHistory.length : 0
      },
      created_by
    };

    setMsg("Publishing shift snapshot…");
    const snap = await window.sb.upsertShiftSnapshot(snapshotPayload);
    if (snap?.error) {
      setMsg(`Snapshot publish failed: ${snap.error.message || String(snap.error)}`, true);
      return { ok: false };
    }

    // ---- staff metrics rows
    const rows = [];
    const rnOwners = safeArray(window.incomingNurses);
    const pcaOwners = safeArray(window.incomingPcas);

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
        tag_counts: countTagsForRole(patient_ids, "PCA"), // ✅ PCA tags (Tele included)
        details: { drivers, patient_ids },
        created_by
      });
    }

    setMsg("Publishing staff metrics…");
    const sm = await window.sb.upsertStaffShiftMetrics(rows);
    if (sm?.error) {
      console.warn("[finalize] staff metrics upsert failed", sm.error);
      setMsg("Snapshot published, but staff metrics failed (see console).", true);
      // keep going; snapshot still succeeded
    }

    // ---- ✅ analytics (write AFTER counts exist)
    if (typeof window.sb.upsertAnalyticsShiftMetrics === "function") {
      try {
        const unitTagCounts = countUnitTagCountsDedup(); // ✅ no double counting tele
        const rnUnitTagCounts = countTagsFromPatients(activePatientIds(), RN_KEYS);
        const pcaUnitTagCounts = countTagsFromPatients(activePatientIds(), PCA_KEYS);

        await window.sb.upsertAnalyticsShiftMetrics({
          unit_id,
          shift_date,
          shift_type,
          created_by,
          metrics: {
            version: 2,
            totals: {
              total_pts: ptsActive.length,
              admits: Array.isArray(window.admitQueue) ? window.admitQueue.length : 0,
              discharges: Array.isArray(window.dischargeHistory) ? window.dischargeHistory.length : 0
            },
            // UnitPulse will read this:
            tag_counts: unitTagCounts,
            top_tags: topTagsString(unitTagCounts, 10),

            // Future: split views if you want them
            tag_counts_rn: rnUnitTagCounts,
            tag_counts_pca: pcaUnitTagCounts
          }
        });
      } catch (e) {
        console.warn("[finalize] analytics upsert failed", e);
      }
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