// app/app.csvNormalizer.js
// ---------------------------------------------------------
// CSV NORMALIZER (structured + worksheet-export friendly)
//
// Supports TWO common patterns:
//
// (A) Structured table section somewhere in the CSV:
//     RN, ROOM #, ACTY, NOTES, RN, ROOM #, ACTY, NOTES, ...
//     - RN name appears in the RN column, then subsequent rows may omit RN name while listing rooms.
//     - Multiple RN blocks can appear across one row (each block = 4 columns).
//
// (B) Top "RN grid" export:
//     Row like: [RN Name, (blank), count, "201B 203B 209 ..."]
//
// Output (compatible with scanReviewApply render/apply):
//   {
//     rns: [ { name, rooms: [ { room, levelOfCare, notes: [] } ] } ],
//     pcas: [],
//     meta: { source:"csv", filename }
//   }
//
// Notes:
// - ACTY is treated as levelOfCare when it looks like Tele/MS.
// - NOTES can contain multiple tags like "NIH/BG", "NIH, Sitter", etc.
// - Empty rooms can be represented by notes containing "EMPTY" (optional).
// ---------------------------------------------------------

(function () {
  if (window.__csvNormalizerLoaded) return;
  window.__csvNormalizerLoaded = true;

  function norm(s) {
    return String(s || "").trim();
  }
  function lower(s) {
    return norm(s).toLowerCase();
  }
  function isBlankRow(row) {
    return !Array.isArray(row) || row.every((c) => !norm(c));
  }

  // Minimal CSV parser: handles quoted fields and commas.
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cur = "";
    let inQuotes = false;

    const pushCell = () => {
      row.push(cur);
      cur = "";
    };
    const pushRow = () => {
      rows.push(row.map((x) => String(x ?? "")));
      row = [];
    };

    const s = String(text || "");
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];

      if (ch === '"') {
        if (inQuotes && s[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (!inQuotes && ch === ",") {
        pushCell();
        continue;
      }

      if (!inQuotes && (ch === "\n" || ch === "\r")) {
        if (ch === "\r" && s[i + 1] === "\n") i++;
        pushCell();
        pushRow();
        continue;
      }

      cur += ch;
    }

    pushCell();
    pushRow();

    return rows;
  }

  function normalizeRoom(s) {
    const r = norm(s).toUpperCase();
    if (!r) return "";
    return r.replace(/\s+/g, "").replace(/[^0-9A-Z/]/g, "");
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
    // split on commas/semicolons/pipes, but also explode NIH/BG style
    return raw
      .split(/[,;|]+/g)
      .flatMap((x) => String(x || "").split("/"))
      .map((x) => norm(x))
      .filter(Boolean);
  }

  function addRnRoom(map, rnName, room, level, notes) {
    const name = norm(rnName);
    const r = normalizeRoom(room);
    if (!name || !r) return;

    if (!map.has(name)) map.set(name, []);
    map.get(name).push({
      room: r,
      levelOfCare: level || "",
      notes: Array.isArray(notes) ? notes.filter(Boolean) : [],
    });
  }

  // Find the first row that looks like the structured header:
  // contains "RN" and "ROOM" at least once.
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

  // Parse the structured multi-block section.
  // Header row pattern: RN, ROOM #, ACTY, NOTES, RN, ROOM #, ACTY, NOTES, ...
  // Then data rows:
  // - RN name may appear in RN col only on first row of that RN block.
  // - Rooms follow beneath with RN col blank.
  function parseStructuredSection(rows, headerIdx) {
    const header = rows[headerIdx] || [];
    const blocks = [];

    // Discover blocks by scanning for "RN" cells, assuming 4-col blocks (RN, ROOM, ACTY, NOTES)
    for (let c = 0; c < header.length; c++) {
      if (lower(header[c]) === "rn") {
        blocks.push({ rnCol: c, roomCol: c + 1, actyCol: c + 2, notesCol: c + 3 });
      }
    }

    // If no blocks found, bail
    if (!blocks.length) return { byRn: new Map(), warnings: ["No RN blocks detected in structured header."] };

    const currentRnByBlock = new Array(blocks.length).fill("");

    const byRn = new Map();
    const warnings = [];

    // Iterate down until we hit a long blank stretch
    let blankStreak = 0;
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r] || [];

      // Stop if we see many blank rows (end of section)
      if (isBlankRow(row)) {
        blankStreak++;
        if (blankStreak >= 4) break;
        continue;
      }
      blankStreak = 0;

      // If the row contains "Nursing Buddies" or other non-assignment section markers, we can continue,
      // but we should still parse RN blocks if room cells exist.
      const rowText = row.map((c) => lower(c)).join(" ");

      for (let b = 0; b < blocks.length; b++) {
        const { rnCol, roomCol, actyCol, notesCol } = blocks[b];

        const rnCell = norm(row[rnCol]);
        const roomCell = norm(row[roomCol]);
        const actyCell = norm(row[actyCol]);
        const notesCell = norm(row[notesCol]);

        // Update current RN for this block if provided
        if (rnCell) currentRnByBlock[b] = rnCell;

        const rnName = currentRnByBlock[b];
        if (!rnName) continue;

        // Some exports put the RN name row with no rooms; that's fine.
        if (!roomCell) continue;

        const level = normalizeLevel(actyCell);
        const notes = splitNotes(notesCell);

        addRnRoom(byRn, rnName, roomCell, level, notes);
      }

      // Optional: if we've moved past the section and hit another header, stop.
      if (rowText.includes("room availability")) break;
    }

    // If we got nothing, warn.
    const total = Array.from(byRn.values()).reduce((sum, arr) => sum + (arr?.length || 0), 0);
    if (!total) warnings.push("Structured section found, but no RN room rows were extracted.");

    return { byRn, warnings };
  }

  // Fallback: parse the top RN grid lines:
  // col0 = RN name, col3 = rooms blob
  function parseTopGrid(rows, maxRows) {
    const byRn = new Map();
    for (let i = 0; i < Math.min(rows.length, maxRows); i++) {
      const row = rows[i] || [];
      const name = norm(row[0]);
      const roomsBlob = norm(row[3]);

      // Stop if we hit "Room Availability" marker row
      const joined = row.map((c) => lower(c)).join(" ");
      if (joined.includes("room availability")) break;

      if (!name || !roomsBlob) continue;

      const rooms = roomsBlob
        .split(/\s+/g)
        .map((x) => normalizeRoom(x))
        .filter(Boolean);

      for (const room of rooms) {
        addRnRoom(byRn, name, room, "", []);
      }
    }
    return byRn;
  }

  function mergeByRn(into, from) {
    for (const [name, rooms] of from.entries()) {
      if (!into.has(name)) into.set(name, []);
      into.get(name).push(...rooms);
    }
  }

  function normalizeCsvText(text, opts) {
    const rows = parseCsv(text);

    const meta = {
      source: "csv",
      filename: opts?.filename || null,
    };

    const warnings = [];

    // 1) Prefer structured section parsing if present
    const headerIdx = findStructuredHeaderIndex(rows);
    let byRn = new Map();

    if (headerIdx >= 0) {
      const res = parseStructuredSection(rows, headerIdx);
      byRn = res.byRn;
      warnings.push(...(res.warnings || []));
    } else {
      warnings.push("No structured RN/ROOM#/ACTY/NOTES header found; using top-grid fallback.");
    }

    // 2) If structured yielded nothing, try top-grid fallback
    const extractedCount = Array.from(byRn.values()).reduce((sum, arr) => sum + (arr?.length || 0), 0);
    if (!extractedCount) {
      const fallback = parseTopGrid(rows, 40);
      mergeByRn(byRn, fallback);

      const fallbackCount = Array.from(byRn.values()).reduce((sum, arr) => sum + (arr?.length || 0), 0);
      if (!fallbackCount) warnings.push("Fallback grid parse also produced no assignments.");
    }

    // 3) Build output
    const rns = Array.from(byRn.entries()).map(([name, rooms]) => ({
      name,
      rooms,
    }));

    const out = { rns, pcas: [], meta };
    if (warnings.length) out.warnings = warnings;

    return out;
  }

  window.csvNormalizer = { normalizeCsvText };
})();