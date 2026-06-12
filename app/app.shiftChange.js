// app/app.shiftChange.js
// ---------------------------------------------------------
// Shift Finalize / Publish
//
// Writes:
// - shift_snapshots
// - analytics_shift_metrics
// - staff_shift_metrics
//
// Finalize contract:
// - Capture LIVE shift data from current RN/PCA assignments
// - Attribute admits / discharges / acuity changes / assignment moves per staff
// - Store unit-level live-shift totals
// - After successful publish, promote Oncoming -> Live
// ---------------------------------------------------------

(function () {
  const $ = (id) => document.getElementById(id);
  const safeArray = (v) => (Array.isArray(v) ? v : []);
  const ANALYTICS_TAG_KEYS = ["tele", "drip", "nih", "bg", "ciwa", "emu", "restraint", "sitter", "vpo", "isolation", "admit", "lateDc"];

  const VERSION = "shiftChange_v2026-03-20_live_finalize_profiles";
  function log(...args) { console.log("[shiftChange]", ...args); }

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

  function ensureFinalizeConfirmHost() {
    let host = $("shiftFinalizeConfirmHost");
    if (host) return host;
    host = document.createElement("div");
    host.id = "shiftFinalizeConfirmHost";
    host.style.cssText = "position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(15,23,42,.35);z-index:10000;padding:16px;";
    host.innerHTML = `
      <div style="width:min(100%,480px);background:#fff;border-radius:18px;box-shadow:0 24px 60px rgba(15,23,42,.28);padding:18px;">
        <div style="font-size:18px;font-weight:900;color:#0f172a;">Confirm Shift Finalize</div>
        <div style="margin-top:8px;font-size:13px;line-height:1.5;color:#475569;">
          Type <strong>Shift Change</strong> to finalize the current LIVE assignment data, store it in Supabase, and then promote the oncoming assignment into LIVE for the next shift.
        </div>
        <input id="shiftFinalizeConfirmInput" type="text" autocomplete="off" style="margin-top:14px;width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid rgba(15,23,42,.16);border-radius:12px;font-size:14px;" placeholder="Type Shift Change" />
        <div id="shiftFinalizeConfirmHint" style="margin-top:8px;font-size:12px;color:#64748b;">LIVE/current data is what gets stored. Oncoming becomes LIVE only after save succeeds.</div>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
          <button id="shiftFinalizeConfirmCancel" type="button">Cancel</button>
          <button id="shiftFinalizeConfirmSubmit" type="button">Finalize Shift</button>
        </div>
      </div>
    `;
    document.body.appendChild(host);
    return host;
  }

  function requestShiftChangeConfirmation() {
    const host = ensureFinalizeConfirmHost();
    const input = $("shiftFinalizeConfirmInput");
    const hint = $("shiftFinalizeConfirmHint");
    const cancelBtn = $("shiftFinalizeConfirmCancel");
    const submitBtn = $("shiftFinalizeConfirmSubmit");
    if (!host || !input || !cancelBtn || !submitBtn) return Promise.resolve(false);
    return new Promise((resolve) => {
      const cleanup = (result) => {
        host.style.display = "none";
        input.value = "";
        document.removeEventListener("keydown", onKeyDown, true);
        cancelBtn.onclick = null;
        submitBtn.onclick = null;
        resolve(result);
      };
      const onKeyDown = (event) => {
        if (host.style.display === "none") return;
        if (event.key === "Escape") {
          event.preventDefault();
          cleanup(false);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          submitBtn.click();
        }
      };
      cancelBtn.onclick = () => cleanup(false);
      submitBtn.onclick = () => {
        const normalizedConfirm = String(input.value || "")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ");
        if (normalizedConfirm !== "shift change") {
          if (hint) hint.textContent = 'Type "Shift Change" to confirm.';
          if (hint) hint.style.color = "#b91c1c";
          input.focus();
          input.select();
          return;
        }
        cleanup(true);
      };
      if (hint) {
        hint.textContent = "LIVE/current data is what gets stored. Oncoming becomes LIVE only after save succeeds.";
        hint.style.color = "#64748b";
      }
      host.style.display = "flex";
      document.addEventListener("keydown", onKeyDown, true);
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    });
  }

  async function getUserIdSafe() {
    try {
      const { data } = await window.sb.client.auth.getSession();
      return data?.session?.user?.id || null;
    } catch {
      return null;
    }
  }

  function deepClone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function normalizeName(name) {
    return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function isHoldOwner(owner) {
    if (!owner) return false;
    if (Number(owner.id) === 0) return true;
    if (owner.__hold) return true;
    if (String(owner.type || "").toLowerCase() === "hold") return true;
    return String(owner.name || "").trim().toLowerCase() === "needs to be assigned";
  }

  function stableStaffId(owner) {
    return owner?.staff_id || owner?.staffId || owner?.staffID || owner?.id || null;
  }

  function makeShiftKey() {
    const t = Date.now();
    const r = Math.random().toString(36).slice(2, 10);
    return `live_${t}_${r}`;
  }

  function getEventType(ev) {
    return String(ev?.type || ev?.event_type || "").trim().toUpperCase();
  }

  function getEventPayload(ev) {
    const payload = ev?.payload;
    return payload && typeof payload === "object" ? payload : {};
  }

  function getLiveShiftEvents() {
    const all = safeArray(window.eventLog || window.auditEvents);
    const shiftKey = String(window.liveShiftKey || "").trim();
    if (!shiftKey) return all;
    return all.filter((ev) => String(ev?.shiftKey || "").trim() === shiftKey);
  }

  function activePatients() {
    return safeArray(window.patients).filter((p) => p && !p.isEmpty);
  }

  function buildAnalyticsTagCounts(patients) {
    const out = {};
    safeArray(patients).forEach((p) => {
      if (!p || p.isEmpty) return;
      ANALYTICS_TAG_KEYS.forEach((key) => {
        if (p[key]) out[key] = (out[key] || 0) + 1;
      });
    });
    return out;
  }

  function inferEmptyBedsFromAssignments() {
    const patients = safeArray(window.patients);
    if (!patients.length) return;

    const referenced = new Set();
    safeArray(window.currentNurses).forEach((rn) => {
      safeArray(rn?.patients).forEach((pid) => referenced.add(Number(pid)));
    });

    let inferred = 0;

    patients.forEach((p) => {
      if (!p || p.isEmpty) return;
      const pid = Number(p.id);
      if (!pid) return;
      if (!referenced.has(pid)) {
        p.isEmpty = true;
        p.recentlyDischarged = false;
        inferred++;
      }
    });

    if (inferred) log(`Inferred ${inferred} empty beds at finalize`);
  }

  function buildOwnerIndexes(owners) {
    const byStaffId = new Map();
    const byLocalId = new Map();
    const byName = new Map();
    safeArray(owners).forEach((owner) => {
      if (!owner) return;
      const sid = stableStaffId(owner);
      const localId = owner.id;
      const name = normalizeName(owner.name);
      if (sid != null) byStaffId.set(String(sid), owner);
      if (localId != null) byLocalId.set(String(localId), owner);
      if (name) byName.set(name, owner);
    });
    return { byStaffId, byLocalId, byName };
  }

  function resolveOwnerFromRef(indexes, ref) {
    if (!ref || typeof ref !== "object") return null;

    const sid = ref.staffId ?? ref.staff_id ?? ref.rnStaffId ?? ref.pcaStaffId ?? ref.rn_staff_id ?? ref.pca_staff_id;
    const localId = ref.id ?? ref.rnId ?? ref.pcaId ?? ref.rn_id ?? ref.pca_id;
    const name = ref.name ?? ref.rnName ?? ref.pcaName ?? ref.rn_name ?? ref.pca_name;

    if (sid != null && indexes.byStaffId.has(String(sid))) return indexes.byStaffId.get(String(sid));
    if (localId != null && indexes.byLocalId.has(String(localId))) return indexes.byLocalId.get(String(localId));

    const norm = normalizeName(name);
    if (norm && indexes.byName.has(norm)) return indexes.byName.get(norm);
    return null;
  }

  function createStaffProfile(role, owner) {
    const patient_ids = safeArray(owner?.patients).map(Number).filter(Number.isFinite);
    const patient_rooms = patient_ids
      .map((pid) => safeArray(window.patients).find((p) => Number(p?.id) === Number(pid)))
      .filter(Boolean)
      .map((p) => String(p.room || p.id || ""));
    const expected_discharges = patient_ids
      .map((pid) => safeArray(window.patients).find((p) => Number(p?.id) === Number(pid)))
      .filter((p) => p && !p.isEmpty && !!p.expectedDischarge)
      .length;

    return {
      role,
      owner,
      patient_ids,
      patient_rooms,
      expected_discharges,
      admits: 0,
      discharges: 0,
      acuity_changes: 0,
      assignment_changes: 0,
      event_count: 0
    };
  }

  function buildLiveStaffProfiles() {
    const currentRn = safeArray(window.currentNurses).filter((owner) => owner && !isHoldOwner(owner));
    const currentPca = safeArray(window.currentPcas).filter((owner) => owner && !isHoldOwner(owner));
    const profiles = new Map();

    function keyFor(role, owner) {
      return `${role}|${String(stableStaffId(owner) || owner?.id || normalizeName(owner?.name))}`;
    }

    currentRn.forEach((owner) => profiles.set(keyFor("RN", owner), createStaffProfile("RN", owner)));
    currentPca.forEach((owner) => profiles.set(keyFor("PCA", owner), createStaffProfile("PCA", owner)));

    const rnIndexes = buildOwnerIndexes(currentRn);
    const pcaIndexes = buildOwnerIndexes(currentPca);

    function touchProfile(role, ref, mutate) {
      const indexes = role === "RN" ? rnIndexes : pcaIndexes;
      const owner = resolveOwnerFromRef(indexes, ref);
      if (!owner) return;
      const profile = profiles.get(keyFor(role, owner));
      if (!profile) return;
      mutate(profile);
      profile.event_count += 1;
    }

    getLiveShiftEvents().forEach((ev) => {
      const type = getEventType(ev);
      const payload = getEventPayload(ev);

      if (type === "ADMIT_PLACED") {
        touchProfile("RN", { staffId: payload.rn_staff_id, id: payload.rn_id, name: payload.rn_name }, (p) => { p.admits += 1; });
        touchProfile("PCA", { staffId: payload.pca_staff_id, id: payload.pca_id, name: payload.pca_name }, (p) => { p.admits += 1; });
        return;
      }

      if (type === "PATIENT_DISCHARGED") {
        touchProfile("RN", {
          staffId: payload.rnStaffId ?? payload.rn_staff_id,
          id: payload.nurse?.id ?? payload.rnId ?? payload.nurseId,
          name: payload.nurse?.name ?? payload.rnName ?? payload.nurseName
        }, (p) => { p.discharges += 1; });
        touchProfile("PCA", {
          staffId: payload.pcaStaffId ?? payload.pca_staff_id,
          id: payload.pca?.id ?? payload.pcaId,
          name: payload.pca?.name ?? payload.pcaName
        }, (p) => { p.discharges += 1; });
        return;
      }

      if (type === "ASSIGNMENT_MOVED") {
        const roleHint = String(payload.roleLabel || payload.role || "").toUpperCase();
        if (roleHint.includes("RN") || roleHint.includes("NURSE")) {
          touchProfile("RN", { staffId: payload.fromStaffId ?? payload.from_staff_id, id: payload.fromOwner?.id, name: payload.fromOwner?.name }, (p) => { p.assignment_changes += 1; });
          touchProfile("RN", { staffId: payload.toStaffId ?? payload.to_staff_id, id: payload.toOwner?.id, name: payload.toOwner?.name }, (p) => { p.assignment_changes += 1; });
        } else if (roleHint.includes("PCA")) {
          touchProfile("PCA", { staffId: payload.fromStaffId ?? payload.from_staff_id, id: payload.fromOwner?.id, name: payload.fromOwner?.name }, (p) => { p.assignment_changes += 1; });
          touchProfile("PCA", { staffId: payload.toStaffId ?? payload.to_staff_id, id: payload.toOwner?.id, name: payload.toOwner?.name }, (p) => { p.assignment_changes += 1; });
        }
        return;
      }

      if (type === "ACUITY_CHANGED") {
        const attribution = payload.attribution && typeof payload.attribution === "object" ? payload.attribution : {};
        const affects = attribution.affects || {};

        if (affects.affectsRn || payload.rnStaffId || payload.rn_staff_id || payload.rnId || payload.rn_id) {
          touchProfile("RN", attribution.rn || {
            staffId: payload.rnStaffId ?? payload.rn_staff_id,
            id: payload.rnId ?? payload.rn_id,
            name: payload.rnName ?? payload.rn_name
          }, (p) => { p.acuity_changes += 1; });
        }

        if (affects.affectsPca || payload.pcaStaffId || payload.pca_staff_id || payload.pcaId || payload.pca_id) {
          touchProfile("PCA", attribution.pca || {
            staffId: payload.pcaStaffId ?? payload.pca_staff_id,
            id: payload.pcaId ?? payload.pca_id,
            name: payload.pcaName ?? payload.pca_name
          }, (p) => { p.acuity_changes += 1; });
        }
      }
    });

    return Array.from(profiles.values());
  }

  function buildUnitEventSummary() {
    const summary = {
      event_count: 0,
      admits: 0,
      discharges: 0,
      acuity_changes: 0,
      assignment_changes: 0
    };

    getLiveShiftEvents().forEach((ev) => {
      summary.event_count += 1;
      const type = getEventType(ev);
      if (type === "ADMIT_PLACED") summary.admits += 1;
      else if (type === "PATIENT_DISCHARGED") summary.discharges += 1;
      else if (type === "ACUITY_CHANGED") summary.acuity_changes += 1;
      else if (type === "ASSIGNMENT_MOVED") summary.assignment_changes += 1;
    });

    if (!summary.discharges) summary.discharges = safeArray(window.dischargeHistory).length;
    return summary;
  }

  function getLeadershipSnapshot() {
    const read = (id) => String($(id)?.value || "").trim();
    return {
      current: {
        charge: read("currentChargeName"),
        mentor: read("currentMentorName"),
        cta: read("currentCtaName"),
        pcaResource: read("currentPcaResourceName")
      },
      incoming: {
        charge: read("incomingChargeName"),
        mentor: read("incomingMentorName"),
        cta: read("incomingCtaName"),
        pcaResource: read("incomingPcaResourceName")
      }
    };
  }

  function assignLeadershipFromIncoming() {
    const pairs = [
      ["currentChargeName", "incomingChargeName"],
      ["currentMentorName", "incomingMentorName"],
      ["currentCtaName", "incomingCtaName"],
      ["currentPcaResourceName", "incomingPcaResourceName"]
    ];
    pairs.forEach(([currentId, incomingId]) => {
      const currentEl = $(currentId);
      const incomingEl = $(incomingId);
      if (currentEl && incomingEl) currentEl.value = incomingEl.value || "";
    });
  }

  function beginNextLiveShiftContext() {
    safeArray(window.patients).forEach((patient) => {
      if (!patient) return;
      patient.recentlyDischarged = false;
    });
    window.dischargeHistory = [];
    window.nextDischargeId = 1;
    window.liveShiftKey = makeShiftKey();
    window.eventLog = [];
    window.auditEvents = window.eventLog;
    if (typeof window.appendEvent === "function") {
      window.appendEvent("SHIFT_LIVE_STARTED", {
        mode: "live",
        pcaShift: window.pcaShift || "day",
        source: "finalize_shift_change"
      }, {
        v: 1,
        source: "app.shiftChange.js"
      });
    }
  }

  function promoteOncomingToCurrent() {
    window.currentNurses = deepClone(safeArray(window.incomingNurses));
    window.currentPcas = deepClone(safeArray(window.incomingPcas));
    window.currentSitters = deepClone(safeArray(window.incomingSitters));
    assignLeadershipFromIncoming();
    beginNextLiveShiftContext();

    if (typeof window.saveState === "function") window.saveState();
    if (typeof window.refreshUI === "function") window.refreshUI();
    if (window.cloudSync && typeof window.cloudSync.publishUnitStateNow === "function") {
      void window.cloudSync.publishUnitStateNow("finalize_shift_change");
    }
  }

  async function requireShiftChangeConfirmation() {
    const ok = await requestShiftChangeConfirmation();
    if (!ok) {
      setMsg('Finalize cancelled: type "Shift Change" to confirm.', true);
      return false;
    }
    return true;
  }

  async function publishAll() {
    const unit_id = getActiveUnitId();

    if (!canWrite()) {
      setMsg("Cannot finalize: your role does not allow publishing.", true);
      return { ok: false };
    }
    if (!unit_id) {
      setMsg("Cannot finalize: activeUnitId is missing.", true);
      return { ok: false };
    }
    if (!sbReady()) {
      setMsg("Cannot finalize: Supabase client not ready (sbReady=false).", true);
      return { ok: false };
    }

    inferEmptyBedsFromAssignments();

    const shift_date = getShiftDate();
    const shift_type = getShiftType();
    const created_by = await getUserIdSafe();

    const pts = activePatients();
    const liveProfiles = buildLiveStaffProfiles();
    const unitEventSummary = buildUnitEventSummary();
    const tag_counts = buildAnalyticsTagCounts(pts);
    const leadership = getLeadershipSnapshot();
    let analyticsWarning = "";

    {
      const res = await window.sb.upsertShiftSnapshot({
        unit_id,
        shift_date,
        shift_type,
        status: "published",
        state: {
          total_pts: pts.length,
          admits: unitEventSummary.admits,
          discharges: unitEventSummary.discharges,
          acuity_changes: unitEventSummary.acuity_changes,
          assignment_changes: unitEventSummary.assignment_changes,
          live_shift_key: String(window.liveShiftKey || ""),
          patients: deepClone(window.patients || []),
          current_assignment: {
            nurses: deepClone(window.currentNurses || []),
            pcas: deepClone(window.currentPcas || []),
            sitters: deepClone(window.currentSitters || [])
          },
          oncoming_assignment: {
            nurses: deepClone(window.incomingNurses || []),
            pcas: deepClone(window.incomingPcas || []),
            sitters: deepClone(window.incomingSitters || [])
          },
          leadership,
          staff_profiles: liveProfiles.map((profile) => ({
            role: profile.role,
            name: profile.owner?.name || "",
            staff_id: stableStaffId(profile.owner) || null,
            local_owner_id: profile.owner?.id ?? null,
            patients_assigned: profile.patient_ids.length,
            workload_score: profile.role === "RN"
              ? (window.getNurseLoadScore?.(profile.owner) || 0)
              : (window.getPcaLoadScore?.(profile.owner) || 0),
            details: {
              patient_ids: profile.patient_ids,
              patient_rooms: profile.patient_rooms,
              expected_discharges: profile.expected_discharges,
              admits: profile.admits,
              discharges: profile.discharges,
              acuity_changes: profile.acuity_changes,
              assignment_changes: profile.assignment_changes,
              event_count: profile.event_count
            }
          }))
        },
        created_by
      });

      if (res?.error) {
        setMsg("Finalize failed: shift snapshot error", true);
        return { ok: false, error: res.error };
      }
    }

    {
      const res = await window.sb.upsertAnalyticsShiftMetrics({
        unit_id,
        shift_date,
        shift_type,
        created_by,
        total_pts: pts.length,
        admits: unitEventSummary.admits,
        discharges: unitEventSummary.discharges,
        tag_counts,
        metrics: {
          version: 3,
          live_shift_key: String(window.liveShiftKey || ""),
          totals: {
            total_pts: pts.length,
            admits: unitEventSummary.admits,
            discharges: unitEventSummary.discharges,
            acuity_changes: unitEventSummary.acuity_changes,
            assignment_changes: unitEventSummary.assignment_changes,
            event_count: unitEventSummary.event_count
          },
          tag_counts,
          staff_counts: {
            rn: liveProfiles.filter((profile) => profile.role === "RN").length,
            pca: liveProfiles.filter((profile) => profile.role === "PCA").length
          }
        }
      });

      if (res?.error) {
        const errMsg = String(res.error?.message || res.error || "analytics error");
        analyticsWarning = errMsg;
      }
    }

    {
      const rows = [];

      for (const profile of liveProfiles) {
        const role = profile.role === "PCA" ? "PCA" : "RN";
        const owner = profile.owner;
        const ensured = await window.sb.ensureUnitStaff(unit_id, role, owner?.name || `${role} Staff`);
        if (!ensured?.row?.id) continue;

        rows.push({
          unit_id,
          shift_date,
          shift_type,
          staff_id: ensured.row.id,
          staff_name: owner?.name || ensured.row.display_name || `${role} Staff`,
          role,
          patients_assigned: profile.patient_ids.length,
          workload_score: role === "RN"
            ? (window.getNurseLoadScore?.(owner) || 0)
            : (window.getPcaLoadScore?.(owner) || 0),
          details: {
            patient_ids: profile.patient_ids,
            patient_rooms: profile.patient_rooms,
            expected_discharges: profile.expected_discharges,
            admits: profile.admits,
            discharges: profile.discharges,
            acuity_changes: profile.acuity_changes,
            assignment_changes: profile.assignment_changes,
            event_count: profile.event_count,
            live_shift_key: String(window.liveShiftKey || ""),
            local_owner_id: owner?.id ?? null
          },
          created_by
        });
      }

      const res = await window.sb.upsertStaffShiftMetrics(rows);
      if (res?.error) {
        setMsg("Finalize failed: staff metrics error", true);
        return { ok: false, error: res.error };
      }
    }

    setMsg("Finalize complete ✅");
    return { ok: true };
  }

  async function handleFinalize() {
    const btn = $("btnFinalizeShift");
    try {
      if (!(await requireShiftChangeConfirmation())) return;
      if (btn) btn.disabled = true;
      const res = await publishAll();
      if (res.ok && typeof window.finalizeShiftChange === "function") {
        window.finalizeShiftChange();
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.finalizeShiftChange = window.finalizeShiftChange || function finalizeShiftChange() {
    promoteOncomingToCurrent();
  };

  window.addEventListener("DOMContentLoaded", () => {
    const btn = $("btnFinalizeShift");
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        handleFinalize();
      });
    }
  });

  window.shiftChange = { publishAll };
  log("loaded", VERSION);
})();
