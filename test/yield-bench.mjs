// Measures how long each uninterrupted slice of an image operator lasts.
// Run from the pdf.js checkout: node <this file> [--reps=3] [--case=name]
import { createHash } from "crypto";
import { createRequire } from "module";
import { performance } from "perf_hooks";

const require = createRequire(import.meta.url);
const napi = require(process.env.NAPI_CANVAS ?? "@napi-rs/canvas");

// Node 22 lacks the upsert proposal pdf.js relies on.
for (const C of [Map, WeakMap]) {
  C.prototype.getOrInsertComputed ??= function (key, fn) {
    if (!this.has(key)) {
      this.set(key, fn(key));
    }
    return this.get(key);
  };
  C.prototype.getOrInsert ??= function (key, value) {
    if (!this.has(key)) {
      this.set(key, value);
    }
    return this.get(key);
  };
}

globalThis.DOMMatrix ??= napi.DOMMatrix;
globalThis.Path2D ??= napi.Path2D;
globalThis.ImageData ??= napi.ImageData;

const [
  { CanvasGraphics },
  { PDFObjects },
  { PageViewport },
  { BaseCanvasFactory },
  { ImageKind, OPS },
] = await Promise.all([
  import("../src/display/canvas.js"),
  import("../src/display/pdf_objects.js"),
  import("../src/display/page_viewport.js"),
  import("../src/display/canvas_factory.js"),
  import("../src/shared/util.js"),
]);

class NodeCanvasFactory extends BaseCanvasFactory {
  _createCanvas(width, height) {
    return napi.createCanvas(width, height);
  }
}

const filterFactory = {
  addFilter: () => "none",
  addHCMFilter: () => "none",
  addAlphaFilter: () => "none",
  addLuminosityFilter: () => "none",
  destroy: () => {},
};

const PAGE_W = 1200;
const PAGE_H = 1600;

function makeGraphics() {
  const canvasFactory = new NodeCanvasFactory({});
  const canvas = napi.createCanvas(PAGE_W, PAGE_H);
  const ctx = canvas.getContext("2d");
  const objs = new PDFObjects();
  const gfx = new CanvasGraphics(
    ctx,
    new PDFObjects(),
    objs,
    canvasFactory,
    filterFactory,
    { optionalContentConfig: { isVisible: () => true } },
    null,
    null,
    null,
    null
  );
  const viewport = new PageViewport({
    viewBox: [0, 0, PAGE_W, PAGE_H],
    userUnit: 1,
    scale: 1,
    rotation: 0,
  });
  gfx.beginDrawing({ viewport, transparency: false, background: "#ffffff" });
  return { gfx, objs, canvas };
}

// --- synthetic image data ---------------------------------------------------
function rgbaData(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = i & 0xff;
    d[i + 1] = (i >> 8) & 0xff;
    d[i + 2] = (i >> 16) & 0xff;
    d[i + 3] = 255;
  }
  return {
    width: w,
    height: h,
    kind: ImageKind.RGBA_32BPP,
    data: d,
    interpolate: false,
  };
}
function rgbData(w, h) {
  const d = new Uint8ClampedArray(w * h * 3 + 4);
  for (let i = 0; i < d.length; i++) {
    d[i] = i & 0xff;
  }
  return {
    width: w,
    height: h,
    kind: ImageKind.RGB_24BPP,
    data: d,
    interpolate: false,
  };
}
function grayData(w, h) {
  const d = new Uint8Array(((w + 7) >> 3) * h);
  for (let i = 0; i < d.length; i++) {
    d[i] = i & 0xff;
  }
  return {
    width: w,
    height: h,
    kind: ImageKind.GRAYSCALE_1BPP,
    data: d,
    interpolate: false,
  };
}
function maskData(w, h) {
  const d = new Uint8Array(((w + 7) >> 3) * h);
  for (let i = 0; i < d.length; i++) {
    d[i] = (i * 37) & 0xff;
  }
  return { width: w, height: h, data: d, interpolate: false, count: 1 };
}

// --- operator lists ---------------------------------------------------------
const PAD = 30;
function opList(entries) {
  const fnArray = [];
  const argsArray = [];
  for (const [fn, args] of entries) {
    fnArray.push(fn);
    argsArray.push(args);
  }
  // Keep the between-operator chunking enabled for the whole run so the
  // baseline yields wherever it can today.
  for (let i = 0; i < PAD; i++) {
    fnArray.push(OPS.save);
    argsArray.push(null);
    fnArray.push(OPS.restore);
    argsArray.push(null);
  }
  return { fnArray, argsArray, lastChunk: true };
}

function drawScale(w, h, targetW, targetH) {
  return [OPS.transform, [targetW, 0, 0, targetH, 10, 10]];
}

// --- driver -----------------------------------------------------------------
function hashCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return createHash("sha1")
    .update(Buffer.from(data.buffer))
    .digest("hex")
    .slice(0, 16);
}

function runSlices(gfx, list) {
  const slices = [];
  let idx = 0;
  let asked = false;
  const cont = () => {
    asked = true;
  };
  for (;;) {
    asked = false;
    const t0 = performance.now();
    idx = gfx.executeOperatorList(list, idx, cont, undefined, null);
    slices.push(performance.now() - t0);
    if (idx === list.argsArray.length) {
      break;
    }
    if (!asked) {
      throw new Error("stalled without asking to continue");
    }
  }
  return slices;
}

function stats(slices) {
  const sorted = [...slices].sort((a, b) => a - b);
  const q = f =>
    sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  const r = x => Math.round(x * 100) / 100;
  return {
    n: slices.length,
    total: r(slices.reduce((a, b) => a + b, 0)),
    max: r(sorted.at(-1)),
    p95: r(q(0.95)),
    p50: r(q(0.5)),
    slices: slices.map(r),
  };
}

// --- cases ------------------------------------------------------------------
const SIZES = [
  [256, 256],
  [512, 512],
  [1024, 1024],
  [2048, 2048],
  [3000, 3000],
  [4096, 4096],
  [8000, 1000],
  [1000, 8000],
];

const cases = [];

function imageCase(name, mk, w, h, targetW, targetH) {
  cases.push({
    name: `${name} ${w}x${h} -> ${targetW}x${targetH}`,
    run() {
      const { gfx, objs, canvas } = makeGraphics();
      objs.resolve("img_0", mk(w, h));
      const slices = runSlices(
        gfx,
        opList([
          drawScale(w, h, targetW, targetH),
          [OPS.paintImageXObject, ["img_0"]],
        ])
      );
      return { slices, canvas };
    },
  });
}

for (const [w, h] of SIZES) {
  imageCase("rgba", rgbaData, w, h, 600, 800);
}
for (const [w, h] of [
  [1024, 1024],
  [2048, 2048],
  [4096, 4096],
]) {
  imageCase("rgb24", rgbData, w, h, 600, 800);
  imageCase("gray1bpp", grayData, w, h, 600, 800);
}
// No downscale: isolates the decode from _scaleImage.
imageCase("rgba-noscale", rgbaData, 2048, 2048, 2048, 2048);
// Under a 2x downscale there are no halving steps at all.
imageCase("rgba-nohalve", rgbaData, 4096, 4096, 2400, 3200);

for (const [w, h] of [
  [512, 512],
  [1024, 1024],
  [2048, 2048],
  [4096, 4096],
]) {
  cases.push({
    name: `mask ${w}x${h} -> 600x800`,
    run() {
      const { gfx, objs, canvas } = makeGraphics();
      objs.resolve("mask_0", maskData(w, h));
      const slices = runSlices(
        gfx,
        opList([
          drawScale(w, h, 600, 800),
          [OPS.paintImageMaskXObject, [{ data: "mask_0", count: 1 }]],
        ])
      );
      return { slices, canvas };
    },
  });
}

for (const count of [50, 200, 800]) {
  cases.push({
    name: `maskGroup ${count} x 64x64`,
    run() {
      const { gfx, canvas } = makeGraphics();
      const images = [];
      for (let i = 0; i < count; i++) {
        const m = maskData(64, 64);
        images.push({
          data: m.data,
          width: 64,
          height: 64,
          interpolate: false,
          transform: [
            20,
            0,
            0,
            20,
            (i % 40) * 25 + 5,
            Math.floor(i / 40) * 25 + 5,
          ],
        });
      }
      const slices = runSlices(
        gfx,
        opList([[OPS.paintImageMaskXObjectGroup, [images]]])
      );
      return { slices, canvas };
    },
  });
}

for (const count of [200, 1000]) {
  cases.push({
    name: `imageRepeat ${count} x 128x128`,
    run() {
      const { gfx, objs, canvas } = makeGraphics();
      objs.resolve("img_0", rgbaData(128, 128));
      const positions = [];
      for (let i = 0; i < count; i++) {
        positions.push((i % 40) * 25 + 5, Math.floor(i / 40) * 12 + 5);
      }
      const slices = runSlices(
        gfx,
        opList([[OPS.paintImageXObjectRepeat, ["img_0", 20, 20, positions]]])
      );
      return { slices, canvas };
    },
  });
}

cases.push({
  name: `transferMap rgba 2048x2048 -> 600x800`,
  run() {
    const { gfx, objs, canvas } = makeGraphics();
    objs.resolve("img_0", rgbaData(2048, 2048));
    const map = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      map[i] = 255 - i;
    }
    const slices = runSlices(
      gfx,
      opList([
        [OPS.setGState, [[["TR", [map]]]]],
        drawScale(2048, 2048, 600, 800),
        [OPS.paintImageXObject, ["img_0"]],
      ])
    );
    return { slices, canvas };
  },
});

// --- main -------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.replace(/^--/, "").split("="))
);
const reps = Number(args.reps ?? 3);
const filter = args.case;
const label = args.label ?? "run";

const out = [];
for (const c of cases) {
  if (filter && !c.name.includes(filter)) {
    continue;
  }
  let best = null;
  let hash = null;
  for (let r = 0; r < reps; r++) {
    const { slices, canvas } = c.run();
    hash ??= hashCanvas(canvas);
    const s = stats(slices);
    if (!best || s.total < best.total) {
      best = s;
    }
    global.gc?.();
  }
  out.push({ case: c.name, hash, ...best });
  process.stderr.write(`. ${c.name}\n`);
}

console.log(JSON.stringify({ label, cases: out }, null, 1));
