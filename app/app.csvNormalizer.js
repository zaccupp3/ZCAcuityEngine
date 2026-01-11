// app/app.csvNormalizer.js
// ---------------------------------------------------------
// CSV NORMALIZER (structured + worksheet-export friendly)
//
// RN:
// ✅ Parse RN assignment grid blocks: RN / ROOM # / ACTY / NOTES (repeated across page)
// ✅ Ignore Nursing Buddies + other non-assignment sections (via column boundary, NOT early stop)
// ✅ Avoid accidentally adding header labels as patient rows
// ✅ Include bottom RN blocks even when Nursing Buddies appears on same row
// ✅ Support split RN names across consecutive rows (e.g., "Melodie" then "Lacson")
// ✅ Expand room tokens like 213A/B → 213A + 213B
//
// PCA:
// ✅ Parse PCA rows even if the CSV shifts columns:
//   name + count appear somewhere in first few columns, rooms to the right
// ✅ Filter out non-room tokens (dates, "DAYS", etc.)
// ✅ Stop parsing PCAs once RN header begins
//
// Leadership (additive, do-no-harm):
// ✅ Parse Charge / Mentor / CTA from flexible label search
// ✅ Supports inline "Charge: Alex" etc.
// ✅ Supports name far-right or several rows below
// ✅ Day-shift fix: allows trailing employee IDs like "#1000869" by stripping them
// ✅ Output: parsed.leadership + parsed.leadershipMeta({confident,found})
// ✅ Confidence rule: require ≥2 of 3 roles detected
//
// Output shape:
// { rns:[{name, rooms:[{room, levelOfCare, notes:[]}]}], pcas:[{name,count,rooms:[]}], leadership?:{...}, leadershipMeta?:{...}, meta:{...}, warnings?:[] }
// ---------------------------------------------------------

(function () {
  if (window.__csvNormalizerLoaded) return;
  window.__csvNormalizerLoaded = true;

  const BUILD = "csvNormalizer-v12-leadershipStripIds-safe";
  console.log("[csvNormalizer] loaded:", BUILD);

  const MAX_RNS = 8;

  const STOP_PHRASES = ["nursing buddies", "pca with", "rn with"];
  const HARD_STOP_PHRASES = ["room availability"];

  function norm(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }
  function lower(s) {
    return norm(s).toLowerCase();
  }
  function isBlankRow(row) {
    return !Array.isArray(row) || row.every((c) => !norm(c));
  }
  function rowText(row) {
    return (row || []).map((c) => lower(c)).join(" ");
  }
  function rowHasHardStop(row) {
    const t = rowText(row);
    return HARD_STOP_PHRASES.some((p) => t.includes(p));
  }

  function findStopColumnIndex(row) {
    if (!Array.isArray(row)) return -1;
    for (let i = 0; i < row.length; i++) {
      const cell = lower(row[i]);
      if (!cell) continue;
      for (const p of STOP_PHRASES) {
        if (cell.includes(p)) return i;
      }
    }
    return -1;
  }

  function isRoomHeaderCell(v) {
    const t = lower(v).replace(/\s+/g, "");
    return !!t && (t === "room" || t.startsWith("room"));
  }
  function isActyHeaderCell(v) {
    const t = lower(v).replace(/\s+/g, "");
    return t === "acty" || t === "acuity" || t.startsWith("acty") || t.startsWith("acuity");
  }
  function isNotesHeaderCell(v) {
    const t = lower(v).replace(/\s+/g, "");
    return t === "notes" || t.startsWith("notes");
  }

  function isLikelyFullName(s) {
    const t = norm(s);
    if (!t) return false;

    const l = lower(t);
    if (l === "rn" || l.includes("room") || l.includes("acty") || l.includes("notes")) return false;

    const noId = t.replace(/\s*#\d+\s*$/g, "").trim();
    const parts = noId.split(/\s+/).filter(Boolean);
    return parts.length >= 2;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cur = "";
    let inQuotes = false;

    const pushCell = () => { row.push(cur); cur = ""; };
    const pushRow = () => { rows.push(row.map((x) => String(x ?? ""))); row = []; };

    const s = String(text || "");
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];

      if (ch === '"') {
        if (inQuotes && s[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
        continue;
      }

      if (!inQuotes && ch === ",") { pushCell(); continue; }

      if (!inQuotes && (ch === "\n" || ch === "\r")) {
        if (ch === "\r" && s[i + 1] === "\n") i++;
        pushCell(); pushRow(); continue;
      }

      cur += ch;
    }

    pushCell(); pushRow();
    return rows;
  }

  function normalizeRoomToken(s) {
    const r = norm(s).toUpperCase();
    if (!r) return "";
    return r.replace(/\s+/g, "").replace(/[^0-9A-Z/]/g, "");
  }

  function expandRooms(roomRaw) {
    const tok = normalizeRoomToken(roomRaw);
    if (!tok) return [];

    const m = tok.match(/^(\d{3})([A-Z])\/([A-Z](?:\/[A-Z])*)$/);
    if (m) {
      const base = m[1];
      const first = m[2];
      const rest = m[3].split("/").filter(Boolean);
      return [base + first, ...rest.map((x) => base + x)];
    }
    return [tok];
  }

  function normalizeLevel(s) {
    const t = lower(s);
    if (!t) return "";
    if (t.includes("tele")) return "Tele";
    if (t === "ms" || t.includes("med") || t.includes("m/s")) return "MS";
    return norm(s);
  }

  function splitNotes(s) {
    const raw = norm(s);
    if (!raw) return [];
    return raw
      .split(/[,;|]+/g)
      .flatMap((x) => String(x || "").split("/"))
      .map((x) => norm(x))
      .filter(Boolean);
  }

  function addRnRoom(map, rnName, roomRaw, level, notes) {
    const name = norm(rnName);
    if (!name) return;

    if (isRoomHeaderCell(roomRaw) || isActyHeaderCell(level) || isNotesHeaderCell((notes || []).join(" "))) return;

    const rooms = expandRooms(roomRaw);
    if (!rooms.length) return;

    if (!map.has(name)) map.set(name, []);
    for (const r of rooms) {
      if (!r) continue;
      const rt = lower(r);
      if (rt === "room" || rt.startsWith("room")) continue;

      map.get(name).push({
        room: r,
        levelOfCare: level || "",
        notes: Array.isArray(notes) ? notes.filter(Boolean) : [],
      });
    }
  }

  function findStructuredHeaderIndex(rows) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || [];
      const cells = row.map((c) => lower(c));
      const hasRN = cells.some((c) => c === "rn");
      const hasRoom = cells.some((c) => c.includes("room"));
      const hasActy = cells.some((c) => c.includes("acty") || c.includes("acuity"));
      if (hasRN && hasRoom && hasActy) return i;
    }
    return -1;
  }

  function parseStructuredSection(rows, headerIdx) {
    const header = rows[headerIdx] || [];
    const blocks = [];

    const headerStopCol = findStopColumnIndex(header);
    const headerColLimit = headerStopCol >= 0 ? headerStopCol : header.length;

    for (let c = 0; c < header.length; c++) {
      if (c >= headerColLimit) break;
      if (lower(header[c]) === "rn") {
        if (c + 3 < headerColLimit) {
          blocks.push({ rnCol: c, roomCol: c + 1, actyCol: c + 2, notesCol: c + 3 });
        }
      }
    }

    if (!blocks.length) return { byRn: new Map(), warnings: ["No RN blocks detected in structured header."] };

    const currentRnByBlock = new Array(blocks.length).fill("");
    const pendingNameByBlock = new Array(blocks.length).fill("");
    const byRn = new Map();
    const warnings = [];

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (rowHasHardStop(row)) break;
      if (isBlankRow(row)) continue;

      const stopCol = findStopColumnIndex(row);
      const colLimit = stopCol >= 0 ? stopCol : row.length;

      for (let b = 0; b < blocks.length; b++) {
        const { rnCol, roomCol, actyCol, notesCol } = blocks[b];
        if (notesCol >= colLimit) continue;

        const rnCell = norm(row[rnCol]);
        const roomCell = norm(row[roomCol]);
        const actyCell = norm(row[actyCol]);
        const notesCell = norm(row[notesCol]);

        if (isRoomHeaderCell(roomCell) || isActyHeaderCell(actyCell) || isNotesHeaderCell(notesCell)) {
          if (rnCell && isLikelyFullName(rnCell)) {
            currentRnByBlock[b] = rnCell;
            pendingNameByBlock[b] = "";
          }
          continue;
        }

        if (rnCell) {
          if (isLikelyFullName(rnCell)) {
            currentRnByBlock[b] = rnCell;
            pendingNameByBlock[b] = "";
          } else {
            if (!roomCell) {
              if (pendingNameByBlock[b]) {
                const joined = (pendingNameByBlock[b] + " " + rnCell).trim();
                if (isLikelyFullName(joined)) {
                  currentRnByBlock[b] = joined;
                  pendingNameByBlock[b] = "";
                } else {
                  pendingNameByBlock[b] = rnCell;
                }
              } else {
                pendingNameByBlock[b] = rnCell;
              }
            }
          }
        }

        const rnName = currentRnByBlock[b];
        if (!rnName) continue;
        if (!roomCell) continue;

        const level = normalizeLevel(actyCell);
        const notes = splitNotes(notesCell);
        addRnRoom(byRn, rnName, roomCell, level, notes);
      }
    }

    const total = Array.from(byRn.values()).reduce((sum, arr) => sum + (arr?.length || 0), 0);
    if (!total) warnings.push("Structured section found, but no RN room rows were extracted.");

    return { byRn, warnings };
  }

  function parseTopGrid(rows, maxRows) {
    const byRn = new Map();
    for (let i = 0; i < Math.min(rows.length, maxRows); i++) {
      const row = rows[i] || [];
      if (rowHasHardStop(row)) break;

      const stopCol = findStopColumnIndex(row);
      const colLimit = stopCol >= 0 ? stopCol : row.length;

      const name = norm(row[0]);
      const roomsBlob = colLimit > 3 ? norm(row[3]) : "";

      if (!name || !roomsBlob) continue;
      if (!isLikelyFullName(name)) continue;

      const rooms = roomsBlob
        .split(/\s+/g)
        .flatMap((x) => expandRooms(x))
        .filter(Boolean);

      for (const room of rooms) addRnRoom(byRn, name, room, "", []);
    }
    return byRn;
  }

  function mergeByRn(into, from) {
    for (const [name, rooms] of from.entries()) {
      if (!into.has(name)) into.set(name, []);
      into.get(name).push(...rooms);
    }
  }

  function capToEightRn(byRn, warnings) {
    const entries = Array.from(byRn.entries());
    if (entries.length > MAX_RNS) warnings.push(`Detected ${entries.length} RNs; capped to first ${MAX_RNS}.`);
    return new Map(entries.slice(0, MAX_RNS));
  }

  // -----------------------------
  // ✅ PCA parsing (column-agnostic)
  // -----------------------------
  function isRoomLikeToken(tok) {
    const t = normalizeRoomToken(tok);
    if (!t) return false;

    const l = t.toLowerCase();
    if (l === "days" || l === "day" || l === "noc" || l === "shift") return false;

    if (t.includes("/") && !/^\d{3}[A-Z]\/[A-Z](?:\/[A-Z])*$/.test(t)) return false;

    if (/^\d{3}[A-Z]?$/.test(t)) return true;
    if (/^\d{3}[A-Z]\/[A-Z](?:\/[A-Z])*$/.test(t)) return true;

    return false;
  }

  function extractRoomsFromCells(cells, startIdx) {
    const out = [];
    for (let i = startIdx; i < cells.length; i++) {
      const cell = norm(cells[i]);
      if (!cell) continue;
      const parts = cell.split(/\s+/g).filter(Boolean);
      for (const p of parts) {
        if (!isRoomLikeToken(p)) continue;
        out.push(...expandRooms(p));
      }
    }
    return out.filter(Boolean);
  }

  function looksLikeRnHeaderRow(row) {
    const cells = (row || []).map((c) => lower(c));
    const hasRN = cells.some((c) => c === "rn");
    const hasRoom = cells.some((c) => c.includes("room"));
    const hasActy = cells.some((c) => c.includes("acty") || c.includes("acuity"));
    return !!(hasRN && hasRoom && hasActy);
  }

  function parsePcas(rows, stopAtHeaderIdx) {
    const warnings = [];
    const pcas = [];

    const end = (typeof stopAtHeaderIdx === "number" && stopAtHeaderIdx >= 0)
      ? stopAtHeaderIdx
      : rows.length;

    for (let i = 0; i < end; i++) {
      const row = rows[i] || [];
      if (rowHasHardStop(row)) break;
      if (isBlankRow(row)) continue;

      if (looksLikeRnHeaderRow(row)) break;

      const maxScan = Math.min(5, row.length);
      let nameIdx = -1;
      let countIdx = -1;

      for (let c = 0; c < maxScan; c++) {
        const v = norm(row[c]);
        if (!v) continue;

        const n = Number(v);
        if (Number.isFinite(n) && n >= 0 && n <= 40) {
          for (let k = c - 1; k >= 0; k--) {
            const nm = norm(row[k]);
            if (!nm) continue;
            if (isRoomLikeToken(nm)) break;
            nameIdx = k;
            countIdx = c;
            break;
          }
          if (nameIdx >= 0) break;
        }
      }

      if (nameIdx < 0 || countIdx < 0) continue;

      const name = norm(row[nameIdx]);
      const countNum = Number(norm(row[countIdx]));
      const count = Number.isFinite(countNum) ? countNum : null;

      const rooms = extractRoomsFromCells(row, countIdx + 1);
      if (!rooms.length) continue;

      if (isRoomLikeToken(name)) continue;

      pcas.push({ name, count, rooms });
    }

    if (!pcas.length) warnings.push("No PCA rows were detected.");
    return { pcas, warnings };
  }

  // -----------------------------
  // ✅ Leadership parsing (ultra-robust)
  // -----------------------------
  function stripTrailingId(raw) {
    let s = String(raw || "").trim();
    if (!s) return "";

    // Common patterns in your CSV:
    // "Garret Gooding #1000869"
    // "Garret Gooding (#1000869)"
    // "Garret Gooding (1000869)"
    s = s.replace(/\s*\(\s*#?\d+\s*\)\s*$/g, "").trim();
    s = s.replace(/\s*#\d+\s*$/g, "").trim();
    return s;
  }

  function normalizePersonName(s) {
    let t = stripTrailingId(s);

    t = t
      .replace(/\s+/g, " ")
      .replace(/[^\w\s.'-]/g, "")
      .trim();

    if (!t) return "";
    if (t.length < 2) return "";

    // If digits remain AFTER stripping trailing id, treat as not a person name
    if (/\d/.test(t)) return "";

    const l = t.toLowerCase();
    if (/\b(room|rm|bed|tele|ms|med\s*surg|medsurg|icu|step\s*down|stepdown|sitter|nih|bg|iso|q2|days|shift|count|rn|pca)\b/.test(l)) return "";

    if (l.includes("charge") && !/\s/.test(l)) return "";
    if (l.includes("mentor") && !/\s/.test(l)) return "";
    if (l === "cta") return "";

    return t;
  }

  function isLeadershipLabel(s) {
    const t = lower(s).trim();
    if (!t) return false;
    return (
      t.includes("charge") || t === "cn" ||
      t.includes("mentor") || t.includes("clinical") || t.includes("coach") ||
      t.includes("cta")
    );
  }

  function labelToKey(label) {
    const t = lower(label);
    if (t.includes("charge") || t === "cn") return "charge";
    if (t.includes("mentor") || t.includes("clinical") || t.includes("coach")) return "mentor";
    if (t.includes("cta")) return "cta";
    return "";
  }

  function extractInlineName(cell, key) {
    const raw = String(cell || "").trim();
    if (!raw) return "";

    const cleaned = raw.replace(/\s+/g, " ").trim();

    const parts = cleaned.split(/\s*[:\-]\s*/);
    if (parts.length >= 2) {
      const maybe = normalizePersonName(parts.slice(1).join(" ").trim());
      if (maybe) return maybe;
    }

    let removed = cleaned;

    if (key === "charge") {
      removed = removed.replace(/charge\s*(nurse|rn)?/i, "");
      removed = removed.replace(/\bcn\b/i, "");
    } else if (key === "mentor") {
      removed = removed.replace(/clinical\s*(mentor|coach)?/i, "");
      removed = removed.replace(/\bmentor\b/i, "");
      removed = removed.replace(/\bcoach\b/i, "");
    } else if (key === "cta") {
      removed = removed.replace(/\bcta\b/i, "");
    }

    removed = removed.replace(/^[\s:.\-]+/, "").trim();
    return normalizePersonName(removed);
  }

  function firstNameInRow(row, skipLabelCol) {
    for (let i = 0; i < row.length; i++) {
      if (i === skipLabelCol) continue;
      const cand = normalizePersonName(row[i]);
      if (cand) return cand;
    }
    return "";
  }

  function extractLeadershipFromGrid(rows) {
    const leadership = { charge: "", mentor: "", cta: "" };
    const maxRows = Math.min(Array.isArray(rows) ? rows.length : 0, 260);

    for (let r = 0; r < maxRows; r++) {
      const row = rows[r] || [];
      if (isBlankRow(row)) continue;
      if (rowHasHardStop(row)) break;

      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (!cell) continue;
        if (!isLeadershipLabel(cell)) continue;

        const key = labelToKey(cell);
        if (!key || leadership[key]) continue;

        let candidate = extractInlineName(cell, key);

        if (!candidate) {
          for (let k = 1; k <= 30; k++) {
            const v = row[c + k];
            const name = normalizePersonName(v);
            if (name) { candidate = name; break; }
          }
        }

        if (!candidate) {
          candidate = firstNameInRow(row, c);
        }

        if (!candidate) {
          for (let dr = 1; dr <= 10; dr++) {
            const rr = rows[r + dr] || [];
            const name = firstNameInRow(rr, -1);
            if (name) { candidate = name; break; }
          }
        }

        if (candidate) leadership[key] = candidate;
      }
    }

    const found = Object.values(leadership).filter(Boolean).length;
    const confident = found >= 2;
    return { leadership, found, confident };
  }

  // -----------------------------
  // Main
  // -----------------------------
  function normalizeCsvText(text, opts) {
    const rows = parseCsv(text);

    const meta = { source: "csv", filename: opts?.filename || null };
    const warnings = [];

    const headerIdx = findStructuredHeaderIndex(rows);
    let byRn = new Map();

    if (headerIdx >= 0) {
      const res = parseStructuredSection(rows, headerIdx);
      byRn = res.byRn;
      warnings.push(...(res.warnings || []));
    } else {
      warnings.push("No structured RN/ROOM#/ACTY/NOTES header found; using top-grid fallback.");
    }

    const extractedCount = Array.from(byRn.values()).reduce((sum, arr) => sum + (arr?.length || 0), 0);
    if (!extractedCount) {
      const fallback = parseTopGrid(rows, 200);
      mergeByRn(byRn, fallback);

      const fallbackCount = Array.from(byRn.values()).reduce((sum, arr) => sum + (arr?.length || 0), 0);
      if (!fallbackCount) warnings.push("Fallback grid parse also produced no assignments.");
    }

    byRn = capToEightRn(byRn, warnings);

    const rns = Array.from(byRn.entries()).map(([name, rooms]) => ({
      name,
      rooms: (rooms || []).filter((rr) => {
        const rt = lower(rr?.room);
        if (!rt) return false;
        if (rt === "room" || rt.startsWith("room")) return false;
        return true;
      }),
    }));

    const pcaRes = parsePcas(rows, headerIdx >= 0 ? headerIdx : null);
    const pcas = pcaRes.pcas || [];
    warnings.push(...(pcaRes.warnings || []));

    let leadership = null;
    let leadershipMeta = null;
    try {
      const lead = extractLeadershipFromGrid(rows);
      const lObj = lead?.leadership || null;
      if (lObj && Object.values(lObj).some(Boolean)) {
        leadership = lObj;
        leadershipMeta = { confident: !!lead?.confident, found: Number(lead?.found || 0) };
      }
    } catch (e) {
      console.warn("[csvNormalizer] leadership extract failed:", e);
    }

    const out = { rns, pcas, meta };
    if (leadership) out.leadership = leadership;
    if (leadershipMeta) out.leadershipMeta = leadershipMeta;
    if (warnings.length) out.warnings = warnings;

    return out;
  }

  window.csvNormalizer = { normalizeCsvText };
})();