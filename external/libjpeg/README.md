## What this is

A decode-only [libjpeg-turbo](https://libjpeg-turbo.org/) build, used by
`src/core/jpeg_wasm.js` as the JPEG backend between `ImageDecoder` (preferred,
but only usable when a browser-decoded frame preserves the PDF's own colour
semantics) and `JpegImage` (`src/core/jpg.js`, the fallback that handles every
input PDF.js has ever accepted).

`pdfjs_jpeg.c` is the wrapper: it mirrors `JpegImage`'s colour-space decisions
exactly, exposes the reduced-resolution IDCT, and writes the pixels straight
into a JavaScript array in the final format the caller needs.

## Build

Requires Emscripten (`emcc`, `emcmake`), CMake and Git on the PATH:

```
node external/libjpeg/build.mjs
```

The libjpeg-turbo source is cloned into `external/libjpeg/.build/` (gitignored);
`--source <dir>` reuses an existing checkout and `--no-fallback` skips the
`wasm2js` build. The outputs, all committed, are `libjpeg.js` (the Emscripten
glue), `libjpeg.wasm` and `libjpeg_nowasm_fallback.js`.

## Choices worth knowing

- **libjpeg-turbo, not mozjpeg.** mozjpeg is a libjpeg-turbo fork whose work is
  on the *encoder*; its decoder is the same code, in a larger binary.
- **Scalar, plus `-msimd128`.** libjpeg-turbo's own SIMD is x86 assembly and
  NEON intrinsics, neither of which applies to a wasm target, so only the
  compiler's autovectorization is in play. Measured against `JpegImage` on
  baseline, progressive, 4:4:4, grayscale, CMYK and 3000x3000 images, the
  decode is 3.4x to 5.4x faster.
- **`do_fancy_upsampling` is off.** `JpegImage` replicates subsampled chroma
  rather than interpolating it; with fancy upsampling on, the two decoders
  disagree by up to 16 per sample on chroma edges, and with it off by at most 3
  -- which is the fixed-point-versus-float rounding difference, and is what the
  reference tests tolerate.
- **12- and 16-bit JPEGs are refused**, and fall back to `JpegImage`.
- **A truncated frame is refused.** libjpeg invents the missing rows and
  `JpegImage` invents different ones; rather than change what a truncated file
  looks like, such an image is decoded again by `JpegImage`.

## Licensing

[libjpeg-turbo](https://github.com/libjpeg-turbo/libjpeg-turbo) is covered by
the IJG License (`LICENSE_LIBJPEG_TURBO_IJG`) for the libjpeg API library, which
is what is built here, and the Modified BSD License (`LICENSE_LIBJPEG_TURBO`)
for the build system. `pdfjs_jpeg.c` and `build.mjs` are part of PDF.js and are
covered by its Apache 2.0 license.
