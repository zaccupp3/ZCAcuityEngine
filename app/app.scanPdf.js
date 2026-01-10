// app/app.scanPdf.js
// ---------------------------------------------------------
// PDF → CANVAS + TEXT helper (PDF.js)
//
// Exposes:
//  - window.scanPdf.renderUrlToCanvas(pdfUrl, { scale, pageNumber })
//  - window.scanPdf.extractUrlText(pdfUrl, { pageNumber })
//  - window.scanPdf.getPageSize(pdfUrl, { scale, pageNumber })
//  - window.scanPdf.isPdfUrl(url)
//
// Requires:
//  - PDF.js loaded before this file (but we also try to auto-detect it)
//
// Notes:
//  - Uses legacy/global build patterns and normalizes to window.pdfjsLib
//  - Ensures GlobalWorkerOptions.workerSrc is set
// ---------------------------------------------------------

(function () {
  if (window.__scanPdfLoaded) return;
  window.__scanPdfLoaded = true;

  const DEFAULT_WORKER_SRC =
    "https://unpkg.com/pdfjs-dist@4.10.38/legacy/build/pdf.worker.min.js";

  function getPdfJsCandidate() {
    // Most common global (what your code expects)
    if (window.pdfjsLib) return window.pdfjsLib;

    // Some builds expose under this key
    if (window["pdfjs-dist/build/pdf"]) return window["pdfjs-dist/build/pdf"];

    // Occasionally seen with bundlers
    if (window.pdfjs) return window.pdfjs;

    return null;
  }

  function assertPdfJs() {
    const lib = getPdfJsCandidate();
    if (!lib) {
      // Helpful debug output (won't crash older browsers)
      try {
        console.error("[scanPdf] PDF.js not found. Globals present:", {
          pdfjsLib: !!window.pdfjsLib,
          "pdfjs-dist/build/pdf": !!window["pdfjs-dist/build/pdf"],
          pdfjs: !!window.pdfjs,
        });
      } catch (_) {}

      throw new Error(
        "pdfjsLib missing. Ensure PDF.js is loaded before app.scanPdf.js (pdf.min.js), and not blocked by CSP/network."
      );
    }

    // Normalize: always publish as window.pdfjsLib so the rest of the app is consistent.
    window.pdfjsLib = lib;

    // Ensure worker is set (safe no-op if already set)
    try {
      if (!window.pdfjsLib.GlobalWorkerOptions) {
        // Some builds should always have this; if not, it's still useful to warn.
        console.warn("[scanPdf] pdfjsLib.GlobalWorkerOptions missing; worker may fail.");
      } else if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = DEFAULT_WORKER_SRC;
      }
    } catch (e) {
      console.warn("[scanPdf] Unable to set PDF workerSrc:", e);
    }

    return window.pdfjsLib;
  }

  function isPdfUrl(url) {
    const u = String(url || "").toLowerCase();
    // blob: URLs often won't include .pdf; this is a best-effort heuristic
    return u.includes(".pdf") || u.includes("application/pdf") || u.startsWith("blob:");
  }

  async function loadPdfDocFromUrl(pdfUrl) {
    const pdfjsLib = assertPdfJs();
    const url = String(pdfUrl || "");
    if (!url) throw new Error("Missing pdfUrl");

    // Some environments require withCredentials; leaving false by default.
    const loadingTask = pdfjsLib.getDocument({ url });
    return await loadingTask.promise;
  }

  async function renderPdfDocToCanvas(pdfDoc, opts = {}) {
    const scale = opts.scale ?? 2.75;
    const pageNumber = opts.pageNumber ?? 1;

    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  async function renderUrlToCanvas(pdfUrl, opts = {}) {
    const pdfDoc = await loadPdfDocFromUrl(pdfUrl);
    return await renderPdfDocToCanvas(pdfDoc, opts);
  }

  // Extract text items with positions so we can do region-based parsing
  // Returns: { pageNumber, items: [{ str, x, y, w, h, fontName, fontSize }], raw }
  async function extractPdfDocText(pdfDoc, opts = {}) {
    const pageNumber = opts.pageNumber ?? 1;
    const page = await pdfDoc.getPage(pageNumber);

    // viewport scale=1 gives "PDF space" coordinates; we can normalize later
    const viewport = page.getViewport({ scale: 1 });

    const textContent = await page.getTextContent();
    const items = [];

    for (const it of textContent.items || []) {
      const str = String(it.str || "").trim();
      if (!str) continue;

      // PDF.js provides transform matrix; we can approximate a bbox.
      // transform = [a, b, c, d, e, f]
      // e,f correspond roughly to x,y in viewport space.
      const t = it.transform || [1, 0, 0, 1, 0, 0];
      const x = t[4];
      const y = t[5];

      // Width/height estimates
      const w = typeof it.width === "number" ? it.width : 0;
      const h = typeof it.height === "number" ? it.height : 0;

      const fontName = it.fontName || "";
      const fontSize = h || 0;

      // Note: PDF coordinate origin differs; keeping raw viewport space for parser.
      items.push({ str, x, y, w, h, fontName, fontSize });
    }

    return {
      pageNumber,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
      items,
      raw: textContent,
    };
  }

  async function extractUrlText(pdfUrl, opts = {}) {
    const pdfDoc = await loadPdfDocFromUrl(pdfUrl);
    return await extractPdfDocText(pdfDoc, opts);
  }

  async function getPageSize(pdfUrl, opts = {}) {
    const scale = opts.scale ?? 1;
    const pageNumber = opts.pageNumber ?? 1;
    const pdfDoc = await loadPdfDocFromUrl(pdfUrl);
    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    return { pageNumber, width: viewport.width, height: viewport.height, scale };
  }

  // Debug helper: can be called from console to verify PDF.js presence fast.
  function debugStatus() {
    const lib = getPdfJsCandidate();
    return {
      hasPdfjs: !!lib,
      normalizedPdfjsLib: !!window.pdfjsLib,
      workerSrc: window.pdfjsLib?.GlobalWorkerOptions?.workerSrc || null,
    };
  }

  window.scanPdf = {
    isPdfUrl,
    renderUrlToCanvas,
    extractUrlText,
    getPageSize,
    debugStatus,
  };
})();