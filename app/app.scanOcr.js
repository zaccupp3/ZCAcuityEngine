// app/app.scanOcr.js
// ---------------------------------------------------------
// SCAN OCR — robust image load -> canvas preprocessing -> tesseract
//
// Key upgrades for small table text:
// ✅ grayscale + binarize (threshold)
// ✅ optional sharpen (unsharp mask-lite)
// ✅ stronger tesseract settings (PSM 6)
// ✅ returns words with bbox
//
// NEW:
// ✅ accepts either imageUrl (string) OR an HTMLCanvasElement
// ---------------------------------------------------------

(function () {
  if (window.__scanOcrLoaded) return;
  window.__scanOcrLoaded = true;

  function isCanvas(x) {
    return x && typeof x === "object" && x.nodeName === "CANVAS";
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(new Error("Failed to load image: " + url));
      img.src = url;
    });
  }

  function canvasFromImage(img) {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return c;
  }

  function ensureMinWidth(canvas, minWidth) {
    if (!minWidth) return canvas;
    if (canvas.width >= minWidth) return canvas;

    const scale = minWidth / canvas.width;
    const w = Math.round(canvas.width * scale);
    const h = Math.round(canvas.height * scale);

    const c2 = document.createElement("canvas");
    c2.width = w;
    c2.height = h;
    const ctx2 = c2.getContext("2d");
    ctx2.imageSmoothingEnabled = true;
    ctx2.imageSmoothingQuality = "high";
    ctx2.drawImage(canvas, 0, 0, w, h);
    return c2;
  }

  function binarizeAndSharpen(canvas, opts = {}) {
    const threshold = opts.threshold ?? 160; // tune if needed
    const doSharpen = opts.sharpen !== false;

    const c = document.createElement("canvas");
    c.width = canvas.width;
    c.height = canvas.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(canvas, 0, 0);

    const imgData = ctx.getImageData(0, 0, c.width, c.height);
    const d = imgData.data;

    // grayscale + threshold
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const gray = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
      const v = gray >= threshold ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);

    if (!doSharpen) return c;

    // unsharp mask-lite (very mild)
    const out = ctx.getImageData(0, 0, c.width, c.height);
    const o = out.data;

    // 3x3 kernel sharpen
    // [ 0 -1  0
    //  -1  5 -1
    //   0 -1  0 ]
    const w = c.width, h = c.height;
    const src = new Uint8ClampedArray(o); // copy
    const idx = (x, y) => (y * w + x) * 4;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = idx(x, y);
        const c0 = src[i]; // grayscale so any channel works
        const up = src[idx(x, y - 1)];
        const dn = src[idx(x, y + 1)];
        const lf = src[idx(x - 1, y)];
        const rt = src[idx(x + 1, y)];

        let v = 5 * c0 - up - dn - lf - rt;
        v = clamp(v, 0, 255);

        o[i] = o[i + 1] = o[i + 2] = v;
        o[i + 3] = 255;
      }
    }

    ctx.putImageData(out, 0, 0);
    return c;
  }

  async function runTesseract(canvas) {
    if (!window.Tesseract) throw new Error("Tesseract missing on window");

    const {
      data: { text, words },
    } = await window.Tesseract.recognize(canvas, "eng", {
      logger: () => {}, // quiet
    });

    // Normalize bbox fields into x0,y0,x1,y1 for parser
    const normWords = (words || [])
      .filter((w) => w && w.text && w.bbox)
      .map((w) => ({
        text: w.text,
        x0: w.bbox.x0,
        y0: w.bbox.y0,
        x1: w.bbox.x1,
        y1: w.bbox.y1,
        conf: w.confidence,
      }));

    return {
      text: text || "",
      words: normWords,
      width: canvas.width,
      height: canvas.height,
    };
  }

  async function runOcr(source, opts = {}) {
    try {
      const minWidth = opts.minWidth ?? 3200;

      let baseCanvas;
      if (typeof source === "string") {
        const img = await loadImage(source);
        baseCanvas = canvasFromImage(img);
      } else if (isCanvas(source)) {
        baseCanvas = source;
      } else {
        throw new Error("runOcr expects an imageUrl string or a canvas element");
      }

      // upscale first
      let c = ensureMinWidth(baseCanvas, minWidth);

      // then preprocess
      c = binarizeAndSharpen(c, {
        threshold: opts.threshold ?? 160,
        sharpen: opts.sharpen ?? true,
      });

      // OCR
      const out = await runTesseract(c);
      return out;
    } catch (e) {
      console.error("[scanocr] failed:", e);
      throw e;
    }
  }

  window.scanOcr = { runOcr };
})();