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
 * Builds the decode-only libjpeg-turbo WebAssembly module used by
 * `src/core/jpeg_wasm.js`.
 *
 * Requires Emscripten (`emcc`, `emcmake`), CMake and Git on the PATH:
 *
 *   node external/libjpeg/build.mjs            # wasm + JS fallback
 *   node external/libjpeg/build.mjs --no-fallback
 *   node external/libjpeg/build.mjs --source /path/to/libjpeg-turbo
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import path from "path";

const LIBJPEG_TURBO_REPO = "https://github.com/libjpeg-turbo/libjpeg-turbo.git";
const LIBJPEG_TURBO_TAG = "3.1.3";

const here = import.meta.dirname;
const workDir = path.join(here, ".build");

const args = process.argv.slice(2);
const noFallback = args.includes("--no-fallback");
const sourceIndex = args.indexOf("--source");
const sourceDir =
  sourceIndex === -1
    ? path.join(workDir, "libjpeg-turbo")
    : path.resolve(args[sourceIndex + 1]);
const buildDir = path.join(workDir, "libjpeg-turbo-build");

function run(command, commandArgs, cwd = here) {
  console.log(`> ${command} ${commandArgs.join(" ")}`);
  execFileSync(command, commandArgs, { cwd, stdio: "inherit" });
}

if (!existsSync(sourceDir)) {
  run("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    LIBJPEG_TURBO_TAG,
    LIBJPEG_TURBO_REPO,
    sourceDir,
  ]);
}

// The bundled SIMD implementations are x86 assembly and NEON intrinsics, so
// neither applies here; the scalar build is what the wasm target compiles.
run("emcmake", [
  "cmake",
  "-S",
  sourceDir,
  "-B",
  buildDir,
  "-G",
  "Unix Makefiles",
  "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
  "-DENABLE_SHARED=0",
  "-DENABLE_STATIC=1",
  "-DWITH_SIMD=0",
  "-DWITH_TURBOJPEG=0",
  "-DWITH_ARITH_ENC=0",
]);
run("emmake", ["make", "jpeg-static", "-j8"], buildDir);

const commonFlags = [
  path.join(here, "pdfjs_jpeg.c"),
  path.join(buildDir, "libjpeg.a"),
  `-I${buildDir}`,
  `-I${sourceDir}`,
  `-I${path.join(sourceDir, "src")}`,
  "-O3",
  "-flto",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sENVIRONMENT=web,worker",
  "-sEXPORTED_FUNCTIONS=_jpeg_decode,_malloc,_free",
  "-sEXPORTED_RUNTIME_METHODS=writeArrayToMemory",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sMALLOC=emmalloc",
  "-sFILESYSTEM=0",
  "-sINVOKE_RUN=0",
  "-sEXIT_RUNTIME=0",
  "-sSUPPORT_LONGJMP=emscripten",
  "-sTEXTDECODER=2",
  "-sINCOMING_MODULE_JS_API=instantiateWasm,locateFile",
  "--closure",
  "0",
];

run("emcc", [
  ...commonFlags,
  // `wasm2js` cannot lower SIMD, so only the wasm build enables it.
  "-msimd128",
  "-sEXPORT_NAME=LibJpeg",
  "-o",
  path.join(here, "libjpeg.js"),
]);

if (!noFallback) {
  run("emcc", [
    ...commonFlags,
    "-sWASM=0",
    "-sEXPORT_NAME=LibJpegNoWasm",
    "-o",
    path.join(here, "libjpeg_nowasm_fallback.js"),
  ]);
}

console.log("Done.");
