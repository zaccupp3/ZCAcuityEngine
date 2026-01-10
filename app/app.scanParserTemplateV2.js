// app/app.scanParserTemplateV2.js
// ---------------------------------------------------------
// SCAN PARSER TEMPLATE V2 — 2 South (layout-aware)
//
// This revision fixes PCA/RN cross-contamination:
// ✅ PCA parsing is restricted to TOP region (PCA table area)
// ✅ RN parsing (anchors + bands) is restricted to BOTTOM region (RN grid)
// ✅ Prevents short garbage anchors like "AB" from becoming RN names
// ✅ Leadership parsing remains text-based (robust)
//
// Output:
//  {
//    meta: { chargeNurse, resourceRn, cta, unitLabel, dateLabel },
//    pcas: [{ name, count, rooms[] }],
//    rns:  [{ name, rooms: [{ room, levelOfCare, notes[] }] }]
//  }
// ---------------------------------------------------------

(function () {
  if (window.__scanParserTemplateV2Loaded) return;
  window.__scanParserTemplateV2Loaded = true;

  const VALID_ROOM_RE = /^2(0\d|1\d|2[0-8])[AB]?$/; // 200–228
  const ROOM_CANDIDATE_RE = /\b2[0-9OIL]{2}[A-B8]?\b/gi;

  const STOP_WORDS = new Set([
    "RN","ROOM","ROOMS","NOTES","ACUITY","TELE","MS","MED","SURG",
    "CHARGE","NURSE","MENTOR","CLINICAL","CTA","RESOURCE",
    "SHIFT","NOC","DAY","NIGHT",
    "SITTER","ISO","BG","NIH","ADMIT","DRIP","Q2","HEAVY","TF",
    "EDG","PCA","PCAS"
  ]);

  const CARE_WORDS = [
    { re: /\btele\b/i, tok: "Tele" },
    { re: /\bms\b/i, tok: "MS" },
    { re: /\bmed\s*surg\b/i, tok: "MS" },
    { re: /\bmed-surg\b/i, tok: "MS" },
  ];

  const NOTE_TAGS = [
    { re: /\biso\b/i, tag: "ISO" },
    { re: /\bsitter\b/i, tag: "SITTER" },
    { re: /\bbg\b/i, tag: "BG" },
    { re: /\bnih\b/i, tag: "NIH" },
    { re: /\badmit\b/i, tag: "ADMIT" },
    { re: /\bdrip\b/i, tag: "DRIP" },
    { re: /\bq2\b/i, tag: "Q2" },
    { re: /\bheavy\b/i, tag: "HEAVY" },
    { re: /\btf\b/i, tag: "TF" },
    { re: /\btele\b/i, tag: "TELE" },
    { re: /\bms\b/i, tag: "MS" },
  ];

  function norm(s) {
    return String(s || "").replace(/[|]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function uniq(arr) {
    const set = new Set();
    const out = [];
    for (const a of arr || []) {
      const k = String(a);
      if (!set.has(k)) { set.add(k); out.push(a); }
    }
    return out;
  }

  function normalizeToken(raw) {
    let t = String(raw || "").toUpperCase().trim();
    t = t.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, "");
    t = t.replace(/O/g, "0");
    t = t.replace(/[IL]/g, "1");
    if (/^\d{3}8$/.test(t)) t = t.slice(0, 3) + "B";
    return t;
  }

  function extractRoomsFromText(raw) {
    const candidates = String(raw || "").match(ROOM_CANDIDATE_RE) || [];
    const rooms = candidates
      .map(normalizeToken)
      .map((t) => (t.endsWith("8") ? t.slice(0, -1) + "B" : t))
      .filter((t) => VALID_ROOM_RE.test(t));
    return uniq(rooms);
  }

  function toCareTokenFromText(s) {
    const t = norm(s);
    for (const c of CARE_WORDS) if (c.re.test(t)) return c.tok;
    return null;
  }

  function extractNoteTagsFromText(s) {
    const t = norm(s);
    const tags = [];
    for (const m of NOTE_TAGS) if (m.re.test(t)) tags.push(m.tag);
    return uniq(tags);
  }

  function deriveDims(ocr, words) {
    let width = ocr?.width ?? ocr?.imageWidth ?? ocr?.w ?? null;
    let height = ocr?.height ?? ocr?.imageHeight ?? ocr?.h ?? null;

    if ((!width || !height) && Array.isArray(words) && words.length) {
      let maxX = 0, maxY = 0;
      for (const w of words) {
        if (w?.x1 != null) maxX = Math.max(maxX, w.x1);
        if (w?.y1 != null) maxY = Math.max(maxY, w.y1);
      }
      if (!width && maxX > 100) width = maxX;
      if (!height && maxY > 100) height = maxY;
    }
    return { width, height };
  }

  function wordsInBox(words, box) {
    return (words || []).filter((w) => {
      if (!w || w.x0 == null || w.y0 == null || w.x1 == null || w.y1 == null) return false;
      const cx = (w.x0 + w.x1) / 2;
      const cy = (w.y0 + w.y1) / 2;
      return cx >= box.x0 && cx <= box.x1 && cy >= box.y0 && cy <= box.y1;
    });
  }

  function groupWordsIntoLines(words, tol = 14) {
    const ws = (words || []).filter((w) => w && w.text && w.y0 != null).slice();
    ws.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

    const lines = [];
    for (const w of ws) {
      const y = w.y0;
      let line = lines.length ? lines[lines.length - 1] : null;
      if (!line || Math.abs(line.y - y) > tol) {
        line = { y, words: [] };
        lines.push(line);
      }
      line.words.push(w);
    }

    for (const line of lines) {
      line.words.sort((a, b) => (a.x0 ?? 0) - (b.x0 ?? 0));
      line.text = norm(line.words.map((w) => w.text).join(" "));
      line.y0 = Math.min(...line.words.map(w => w.y0));
      line.y1 = Math.max(...line.words.map(w => w.y1));
      line.x0 = Math.min(...line.words.map(w => w.x0));
      line.x1 = Math.max(...line.words.map(w => w.x1));
    }
    return lines;
  }

  function cleanAlphaToken(t) {
    const s = String(t || "").replace(/[^A-Za-z()]/g, "").trim();
    if (!s) return "";
    const up = s.replace(/[()]/g, "").toUpperCase();
    if (STOP_WORDS.has(up)) return "";
    if (s.replace(/[()]/g, "").length <= 1) return "";
    return s;
  }

  function isPlausiblePersonName(name) {
    const n = norm(name);
    if (!n) return false;

    // Remove parentheses token from count check
    const parts = n.split(/\s+/).filter(Boolean);
    const alphaParts = parts.filter(p => !/^\([A-Za-z]{2,6}\)$/.test(p));

    // Require either: 2 alpha tokens (First Last) OR one long token (>=5)
    if (alphaParts.length >= 2) return true;
    if (alphaParts.length === 1 && alphaParts[0].replace(/[^A-Za-z]/g, "").length >= 5) return true;

    return false;
  }

  // Leadership from text
  function parseLeadership(text) {
    const t = String(text || "");

    const rx = (label) =>
      new RegExp(
        String(label)
          .replace(/\s+/g, "\\s*")
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "\\s*[:\\-]?\\s*([A-Za-z]+(?:\\s+[A-Za-z]+){0,2})",
        "i"
      );

    const out = { chargeNurse: null, resourceRn: null, cta: null };

    const mCharge = t.match(rx("Charge Nurse"));
    const mMentor = t.match(rx("Clinical Mentor")) || t.match(rx("Mentor"));
    const mCta = t.match(rx("CTA"));

    if (mCharge) out.chargeNurse = norm(mCharge[1]);
    if (mMentor) out.resourceRn = norm(mMentor[1]);
    if (mCta) out.cta = norm(mCta[1]);

    return out;
  }

  // PCA parsing restricted to TOP region lines
  function parsePcasFromWordsAndText(text, words, width, height) {
    // Your rule: bottom half is RN grid. So PCA must be top portion.
    const TOP_MAX_Y = height * 0.42;

    const topWords = (words || []).filter(w => (w.y0 ?? 0) <= TOP_MAX_Y);
    const lines = groupWordsIntoLines(topWords, 14);

    const out = [];
    const seen = new Set();

    for (const line of lines) {
      const rooms = extractRoomsFromText(line.text);
      if (rooms.length < 2) continue;

      // Count token often present in PCA table (1–9)
      const countMatch = line.text.match(/\b([1-9])\b/);
      const count = countMatch ? parseInt(countMatch[1], 10) : rooms.length;

      // Name = before count or before first room token
      let namePart = line.text;
      if (countMatch && countMatch.index != null) {
        namePart = line.text.slice(0, countMatch.index);
      } else {
        const idx = line.text.indexOf(rooms[0]);
        if (idx > 0) namePart = line.text.slice(0, idx);
      }

      const nameTokens = namePart.split(/\s+/).map(cleanAlphaToken).filter(Boolean);
      if (!nameTokens.length) continue;

      const name = nameTokens.length >= 2 ? `${nameTokens[0]} ${nameTokens[1]}` : nameTokens[0];
      if (!isPlausiblePersonName(name)) continue;

      const key = `${name.toUpperCase()}|${rooms.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ name: norm(name), count, rooms });
    }

    out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return out;
  }

  // RN parsing using name anchors + x bands restricted to BOTTOM region
  function buildRoomWords(words) {
    return (words || [])
      .map((w) => ({ ...w, roomTok: normalizeToken(w.text) }))
      .filter((w) => VALID_ROOM_RE.test(w.roomTok));
  }

  function computeBandRanges(sortedAnchors, width) {
    const ranges = [];
    for (let i = 0; i < sortedAnchors.length; i++) {
      const a = sortedAnchors[i];
      const prev = sortedAnchors[i - 1] || null;
      const next = sortedAnchors[i + 1] || null;

      const left = prev ? (prev.cx + a.cx) / 2 : 0;
      const right = next ? (a.cx + next.cx) / 2 : width;

      ranges.push({ ...a, bandLeft: left, bandRight: right });
    }
    return ranges;
  }

  function findRnAnchors(words, width, height) {
    // User rule: bottom half is RN grid (for this 2 South layout)
    const yMin = height * 0.45;
    const yMax = height * 0.95;

    const candidates = (words || [])
      .filter((w) => w && w.text && w.x0 != null && w.y0 != null && w.x1 != null && w.y1 != null)
      .filter((w) => w.y0 >= yMin && w.y0 <= yMax)
      .map((w) => ({ ...w, t: cleanAlphaToken(w.text) }))
      .filter((w) => w.t)
      .filter((w) => ((w.x0 + w.x1) / 2) <= width * 0.45);

    if (!candidates.length) return [];

    // Cluster by x-center
    const sorted = candidates.slice().sort((a, b) => ((a.x0 + a.x1) / 2) - ((b.x0 + b.x1) / 2));
    const clusters = [];
    const xTol = width * 0.04;

    for (const w of sorted) {
      const cx = (w.x0 + w.x1) / 2;
      let placed = false;
      for (const c of clusters) {
        if (Math.abs(cx - c.cx) <= xTol) {
          c.words.push(w);
          c.cx = (c.cx * (c.words.length - 1) + cx) / c.words.length;
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ cx, words: [w] });
    }

    const anchors = [];

    for (const cl of clusters) {
      const byY = cl.words.slice().sort((a, b) => a.y0 - b.y0);
      const yGroups = [];
      const yTol = 22;

      for (const w of byY) {
        let g = yGroups.length ? yGroups[yGroups.length - 1] : null;
        if (!g || Math.abs(g.y - w.y0) > yTol) {
          g = { y: w.y0, words: [] };
          yGroups.push(g);
        }
        g.words.push(w);
      }

      for (const g of yGroups) {
        const toks = g.words
          .sort((a, b) => a.x0 - b.x0)
          .map((w) => w.t)
          .filter(Boolean);

        if (!toks.length) continue;

        // Build name: first two tokens + optional "(EDG)"
        const paren = toks.find((t) => /^\([A-Za-z]{2,6}\)$/.test(t)) || null;
        const alpha = toks.filter(t => !/^\([A-Za-z]{2,6}\)$/.test(t));

        let name = "";
        if (alpha.length >= 2) {
          name = `${alpha[0]} ${alpha[1]}`;
        } else if (alpha.length === 1) {
          name = alpha[0];
        }
        if (paren) name = `${name} ${paren}`.trim();

        name = norm(name);
        if (!isPlausiblePersonName(name)) continue;

        const xs = g.words.map((w) => (w.x0 + w.x1) / 2);
        const ys = g.words.map((w) => (w.y0 + w.y1) / 2);
        const ax = xs.reduce((s, v) => s + v, 0) / xs.length;
        const ay = ys.reduce((s, v) => s + v, 0) / ys.length;

        anchors.push({ name, cx: ax, cy: ay });
      }
    }

    // De-dupe
    const final = [];
    const seen = new Set();
    for (const a of anchors) {
      const key = `${a.name.toUpperCase()}|${Math.round(a.cx / 20)}|${Math.round(a.cy / 30)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      final.push(a);
    }

    final.sort((a, b) => a.cx - b.cx);

    // RN grid typically 8; cap but keep order
    return final.slice(0, 10);
  }

  function assignRoomsToBands(roomWords, bands) {
    const map = new Map();
    for (let i = 0; i < bands.length; i++) map.set(i, []);

    for (const rw of roomWords) {
      const cx = (rw.x0 + rw.x1) / 2;
      let idx = -1;
      for (let i = 0; i < bands.length; i++) {
        if (cx >= bands[i].bandLeft && cx < bands[i].bandRight) { idx = i; break; }
      }
      if (idx >= 0) map.get(idx).push(rw);
    }

    for (const [i, arr] of map.entries()) {
      const seen = new Set();
      const out = [];
      for (const rw of arr) {
        if (seen.has(rw.roomTok)) continue;
        seen.add(rw.roomTok);
        out.push(rw);
      }
      map.set(i, out);
    }

    return map;
  }

  function parseCareAndNotesForRoom(words, width, height, band, roomWord) {
    const rx0 = roomWord.x0;
    const ry0 = roomWord.y0;
    const ry1 = roomWord.y1;

    const box = {
      x0: clamp(rx0 - 10, band.bandLeft, band.bandRight),
      x1: clamp(rx0 + width * 0.26, band.bandLeft, band.bandRight),
      y0: clamp(ry0 - 22, 0, height),
      y1: clamp(ry1 + 30, 0, height),
    };

    const w = wordsInBox(words, box);
    const txt = norm(w.map((x) => x.text).join(" "));

    const care = toCareTokenFromText(txt);

    // notes: also handle OCR slash tokens like "Iso/BG", "Sitter/BG/TF"
    const notes = extractNoteTagsFromText(txt.replace(/\//g, " "));

    return { care: care || null, notes: notes || [] };
  }

  function parseRnsFromWords(ocr, words) {
    const { width, height } = deriveDims(ocr, words);
    if (!width || !height) return [];

    // Only allow RN rooms from bottom half if that rule holds for this layout
    const RN_MIN_Y = height * 0.42;

    const roomWords = buildRoomWords(words).filter(rw => (rw.y0 ?? 0) >= RN_MIN_Y);
    if (!roomWords.length) return [];

    const anchors = findRnAnchors(words, width, height);
    if (!anchors.length) {
      // fallback: one RN bucket
      const seen = new Set();
      const rooms = [];
      for (const rw of roomWords) {
        if (seen.has(rw.roomTok)) continue;
        seen.add(rw.roomTok);
        rooms.push({ room: rw.roomTok, levelOfCare: null, notes: [] });
      }
      rooms.sort((a, b) => String(a.room).localeCompare(String(b.room), undefined, { numeric: true }));
      return rooms.length ? [{ name: "RN", rooms }] : [];
    }

    const bands = computeBandRanges(anchors, width);
    const bandRooms = assignRoomsToBands(roomWords, bands);

    const rns = [];
    const claimedGlobal = new Set();

    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      const rw = bandRooms.get(i) || [];
      if (!rw.length) continue;

      const rooms = [];
      for (const roomWord of rw) {
        const room = roomWord.roomTok;
        if (claimedGlobal.has(room)) continue;

        const { care, notes } = parseCareAndNotesForRoom(words, width, height, b, roomWord);

        rooms.push({ room, levelOfCare: care, notes });
        claimedGlobal.add(room);
      }

      if (!rooms.length) continue;

      rooms.sort((a, b) => String(a.room).localeCompare(String(b.room), undefined, { numeric: true }));
      rns.push({ name: b.name || "RN", rooms });
    }

    return rns;
  }

  function parse(ocrOrText) {
    if (typeof ocrOrText === "string") {
      const leadership = parseLeadership(ocrOrText);
      const pcas = [];
      const allRooms = extractRoomsFromText(ocrOrText);
      return {
        meta: { ...leadership, unitLabel: null, dateLabel: null },
        pcas,
        rns: allRooms.length
          ? [{ name: "RN", rooms: allRooms.map((r) => ({ room: r, levelOfCare: null, notes: [] })) }]
          : [],
      };
    }

    const ocr = ocrOrText || {};
    const text = String(ocr.text || "");
    const wordsRaw = Array.isArray(ocr.words) ? ocr.words : [];

    const words = wordsRaw
      .filter((w) => w && w.text && w.x0 != null && w.y0 != null && w.x1 != null && w.y1 != null)
      .map((w) => ({ ...w, text: String(w.text) }));

    const { width, height } = deriveDims(ocr, words);
    const leadership = parseLeadership(text);

    const pcas = (width && height)
      ? parsePcasFromWordsAndText(text, words, width, height)
      : [];

    const rns = parseRnsFromWords(ocr, words);

    return {
      meta: { ...leadership, unitLabel: null, dateLabel: null },
      pcas,
      rns,
    };
  }

  window.scanParserTemplateV2 = { parse };
})();