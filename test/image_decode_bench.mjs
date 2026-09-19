/* Copyright 2026 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Compares the JPEG decoding backends on real files:
 *
 *   node test/image_decode_bench.mjs [--runs 5] <file.jpg> [...]
 *
 * For every file and every output format it reports the time each backend
 * took and the largest per-sample difference between them, which is the
 * number that says whether the Wasm decoder still matches `JpegImage`.
 */

import { Dict } from "../src/core/primitives.js";
import { JpegImage } from "../src/core/jpg.js";
import { JpegStream } from "../src/core/jpeg_stream.js";
import path from "path";
import { readFileSync } from "fs";
import { Stream } from "../src/core/stream.js";
import { WasmImage } from "../src/core/wasm_image.js";

const ROOT = path.join(import.meta.dirname, "..");

const args = process.argv.slice(2);
const runsIndex = args.indexOf("--runs");
const RUNS = runsIndex === -1 ? 5 : Number(args[runsIndex + 1]);
const files = args.filter(
  (arg, i) => arg !== "--runs" && i !== runsIndex + 1 && !arg.startsWith("--")
);

if (!files.length) {
  console.error("Usage: image_decode_bench.mjs [--runs N] <file.jpg> [...]");
  process.exit(1);
}

// `fetch` can't read local files, so hand the wasm binaries over directly.
WasmImage.setOptions({
  useWasm: true,
  useWorkerFetch: false,
  wasmUrl: "",
  handler: {
    async sendWithPromise(_name, { filename }) {
      return new Uint8Array(
        readFileSync(path.join(ROOT, "external/libjpeg", filename))
      );
    },
  },
});

const FORMATS = [
  ["native", {}],
  ["RGB", { forceRGB: true }],
  ["RGBA", { forceRGBA: true }],
];

function decode(bytes, { useWasm, width, height, flags, reducePower = 0 }) {
  JpegStream.setOptions({ isImageDecoderSupported: false, useWasm });

  const stream = new JpegStream(
    new Stream(bytes, 0, bytes.length, Dict.empty),
    bytes.length,
    null
  );
  stream.drawWidth = width;
  stream.drawHeight = height;
  stream.forceRGBA = !!flags.forceRGBA;
  stream.forceRGB = !!flags.forceRGB;
  stream.reducePower = reducePower;
  return stream;
}

async function time(runs, fn) {
  let best = Infinity,
    last;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    last = await fn();
    best = Math.min(best, performance.now() - start);
  }
  return { best, last };
}

function maxDelta(a, b) {
  if (a.length !== b.length) {
    return `length ${a.length} vs ${b.length}`;
  }
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    max = Math.max(max, Math.abs(a[i] - b[i]));
  }
  return max;
}

for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  const probe = new JpegImage({});
  probe.parse(bytes);
  const { width, height } = probe;

  console.log(`\n${path.basename(file)} - ${width}x${height}`);

  for (const [name, flags] of FORMATS) {
    const js = await time(RUNS, async () => {
      const stream = decode(bytes, { useWasm: false, width, height, flags });
      return stream.getImageData(0, null);
    });
    let backend = null;
    const wasm = await time(RUNS, async () => {
      const stream = decode(bytes, { useWasm: true, width, height, flags });
      const data = await stream.getImageData(0, null);
      backend = stream.backendInfo.backend;
      return data;
    });
    const speedup =
      backend === "JpegWasm" ? `${(js.best / wasm.best).toFixed(2)}x` : "-";

    console.log(
      `  ${name.padEnd(7)} JpegImage ${js.best.toFixed(1).padStart(7)}ms   ` +
        `${backend.padEnd(9)} ${wasm.best.toFixed(1).padStart(7)}ms   ` +
        `${speedup.padStart(6)}   max delta ${maxDelta(js.last, wasm.last)}`
    );
  }

  for (const reducePower of [1, 2, 3]) {
    const reduced = await time(RUNS, async () => {
      const stream = decode(bytes, {
        useWasm: true,
        width,
        height,
        flags: { forceRGBA: true },
        reducePower,
      });
      const data = await stream.getImageData(0, null);
      return { data, stream };
    });
    const { stream } = reduced.last;
    console.log(
      `  1/${2 ** reducePower}     ${stream.backendInfo.backend.padEnd(9)} ` +
        `${reduced.best.toFixed(1).padStart(7)}ms   ` +
        `${stream.decodedWidth}x${stream.decodedHeight}`
    );
  }
}
