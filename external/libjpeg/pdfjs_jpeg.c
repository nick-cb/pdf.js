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

/*
 * Decode-only libjpeg-turbo wrapper for PDF.js.
 *
 * The colour-space decisions mirror `JpegImage` in `src/core/jpg.js` exactly,
 * since the PDF image dictionary -- not the JPEG metadata -- owns the colour
 * interpretation: `/ColorTransform` overrides the component ids, and CMYK data
 * is handed back untouched for the PDF colour space to interpret.
 */

#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten.h>

#include "jpeglib.h"
#include "jerror.h"

/* Output formats, kept in sync with `JpegWasmFormat` in src/core/jpeg_wasm.js */
#define FORMAT_NATIVE 0
#define FORMAT_GRAY8 1
#define FORMAT_RGB24 2
#define FORMAT_RGBA32 3
#define FORMAT_CMYK32 4

/* Status codes, kept in sync with `JpegWasmStatus` in src/core/jpeg_wasm.js */
#define STATUS_OK 0
#define STATUS_ERROR 1
#define STATUS_UNSUPPORTED 2
#define STATUS_DIMENSIONS 3
#define STATUS_OOM 4

/* Rows copied out of the wasm heap per batch. */
#define ROW_BATCH 16

/* The largest reduced-IDCT power, i.e. a 1/8 decode; matches
 * `MAX_REDUCE_POWER` in src/core/jpeg_wasm.js. */
#define MAX_REDUCE_POWER 3

EM_JS(int, jpegStoreInfo,
      (int width, int height, int components, int format, int size), {
        try {
          Module.imageData = new Uint8ClampedArray(size);
        } catch {
          Module.imageData = null;
          return 0;
        }
        Module.imageInfo = { width, height, components, format };
        return 1;
      });

EM_JS(void, jpegCopyRows, (int ptr, int offset, int length), {
  Module.imageData.set(HEAPU8.subarray(ptr, ptr + length), offset);
});

EM_JS(void, jpegStoreError, (const char *message), {
  (Module.errorMessages ||= []).push(UTF8ToString(message));
});

EM_JS(void, jpegStoreWarnings, (int warnings, int truncated), {
  Module.imageInfo.warnings = warnings;
  Module.imageInfo.truncated = !!truncated;
});

struct pdfjs_error_mgr {
  struct jpeg_error_mgr pub;
  jmp_buf setjmp_buffer;
};

static void pdfjs_error_exit(j_common_ptr cinfo) {
  struct pdfjs_error_mgr *err = (struct pdfjs_error_mgr *)cinfo->err;
  char buffer[JMSG_LENGTH_MAX];

  (*cinfo->err->format_message)(cinfo, buffer);
  jpegStoreError(buffer);

  longjmp(err->setjmp_buffer, 1);
}

/* Set when the data ran out mid-frame, i.e. libjpeg invented the rest of the
 * image; the JavaScript decoder invents something else, so the caller re-runs
 * such an image through it rather than changing what a truncated file looks
 * like. Cosmetic warnings (stray bytes before a marker, and the like) leave
 * the pixels intact and are merely counted. */
static int pdfjs_truncated = 0;

static void pdfjs_emit_message(j_common_ptr cinfo, int msg_level) {
  /* Warnings (corrupt or truncated data) must not abort the decode: libjpeg
   * still produces a usable -- possibly partial -- frame, which is what the
   * JavaScript decoder does for the same input. */
  if (msg_level < 0) {
    cinfo->err->num_warnings++;

    if (cinfo->err->msg_code == JWRN_JPEG_EOF ||
        cinfo->err->msg_code == JWRN_HIT_MARKER) {
      pdfjs_truncated = 1;
    }
  }
}

/* Mirrors `JpegImage.prototype._isColorConversionNeeded`. */
static int color_conversion_needed(j_decompress_ptr cinfo, int color_transform) {
  if (cinfo->saw_Adobe_marker) {
    return cinfo->Adobe_transform != 0;
  }
  if (cinfo->num_components == 3) {
    if (color_transform == 0) {
      return 0;
    }
    if (cinfo->comp_info[0].component_id == 0x52 /* "R" */ &&
        cinfo->comp_info[1].component_id == 0x47 /* "G" */ &&
        cinfo->comp_info[2].component_id == 0x42 /* "B" */) {
      return 0;
    }
    return 1;
  }
  return color_transform == 1;
}

/*
 * Decodes `data` and hands the pixels to JavaScript through `jpegStoreInfo` /
 * `jpegCopyRows`.
 *
 * `expected_width` / `expected_height` are the PDF dictionary dimensions; when
 * non-zero and the frame disagrees, the decode is refused so that the caller
 * can use the JavaScript decoder, which resamples in that case.
 *
 * `reduce_power` requests a 1/2**reduce_power reduced-IDCT decode; the actual
 * dimensions are always reported back through `jpegStoreInfo`.
 */
EMSCRIPTEN_KEEPALIVE
int jpeg_decode(const uint8_t *data, int size, int out_format,
                int color_transform, int reduce_power, int expected_width,
                int expected_height, int max_pixels) {
  struct jpeg_decompress_struct cinfo;
  struct pdfjs_error_mgr jerr;
  JSAMPROW rows[ROW_BATCH];
  uint8_t *volatile batch = NULL;
  volatile int status = STATUS_ERROR;
  volatile int started = 0;
  volatile int created = 0;

  if (!data || size <= 0) {
    return STATUS_ERROR;
  }

  pdfjs_truncated = 0;
  cinfo.err = jpeg_std_error(&jerr.pub);
  jerr.pub.error_exit = pdfjs_error_exit;
  jerr.pub.emit_message = pdfjs_emit_message;

  if (setjmp(jerr.setjmp_buffer)) {
    goto cleanup;
  }
  jpeg_create_decompress(&cinfo);
  created = 1;
  jpeg_mem_src(&cinfo, data, (unsigned long)size);

  if (jpeg_read_header(&cinfo, TRUE) != JPEG_HEADER_OK) {
    goto cleanup;
  }

  int needs_transform = color_conversion_needed(&cinfo, color_transform);
  switch (cinfo.num_components) {
    case 1:
      cinfo.jpeg_color_space = JCS_GRAYSCALE;
      break;
    case 3:
      cinfo.jpeg_color_space = needs_transform ? JCS_YCbCr : JCS_RGB;
      break;
    case 4:
      cinfo.jpeg_color_space = needs_transform ? JCS_YCCK : JCS_CMYK;
      break;
    default:
      status = STATUS_UNSUPPORTED;
      goto cleanup;
  }

  /* Clamp rather than refuse: the caller uses the dimensions reported back,
   * so the largest reduction available is always better than none. */
  if (reduce_power < 0) {
    reduce_power = 0;
  } else if (reduce_power > MAX_REDUCE_POWER) {
    reduce_power = MAX_REDUCE_POWER;
  }
  cinfo.scale_num = 1;
  cinfo.scale_denom = 1 << reduce_power;
  cinfo.do_fancy_upsampling = FALSE;
  cinfo.buffered_image = FALSE;
  /* Progressive scans beyond this point are almost certainly a decompression
   * bomb rather than a real document image. */
  cinfo.mem->max_memory_to_use = 512L * 1024L * 1024L;

  jpeg_calc_output_dimensions(&cinfo);

  int width = (int)cinfo.output_width;
  int height = (int)cinfo.output_height;
  if (width <= 0 || height <= 0) {
    goto cleanup;
  }
  if (expected_width > 0 && expected_height > 0) {
    int factor = 1 << reduce_power;
    /* Ceil-divide, matching how the reduced dimensions are computed in JS. */
    if (width != (expected_width + factor - 1) / factor ||
        height != (expected_height + factor - 1) / factor) {
      status = STATUS_DIMENSIONS;
      goto cleanup;
    }
  }
  /* Guard the allocation: `width * height * out_components` must neither
   * overflow nor exceed the caller's budget. */
  if (max_pixels > 0 && (int64_t)width * height > (int64_t)max_pixels) {
    status = STATUS_DIMENSIONS;
    goto cleanup;
  }

  if (out_format == FORMAT_NATIVE) {
    out_format = cinfo.num_components == 1   ? FORMAT_GRAY8
                 : cinfo.num_components == 3 ? FORMAT_RGB24
                                             : FORMAT_CMYK32;
  }
  int out_components;
  switch (out_format) {
    case FORMAT_GRAY8:
      if (cinfo.num_components != 1) {
        status = STATUS_UNSUPPORTED;
        goto cleanup;
      }
      cinfo.out_color_space = JCS_GRAYSCALE;
      out_components = 1;
      break;
    case FORMAT_RGB24:
    case FORMAT_RGBA32:
      /* libjpeg cannot convert CMYK to RGB; PDF.js applies its own CMYK
       * conversion, so those images must be requested as CMYK32. */
      if (cinfo.num_components == 4) {
        status = STATUS_UNSUPPORTED;
        goto cleanup;
      }
      cinfo.out_color_space =
          out_format == FORMAT_RGB24 ? JCS_RGB : JCS_EXT_RGBA;
      out_components = out_format == FORMAT_RGB24 ? 3 : 4;
      break;
    case FORMAT_CMYK32:
      if (cinfo.num_components != 4) {
        status = STATUS_UNSUPPORTED;
        goto cleanup;
      }
      cinfo.out_color_space = JCS_CMYK;
      out_components = 4;
      break;
    default:
      status = STATUS_UNSUPPORTED;
      goto cleanup;
  }

  int64_t out_size = (int64_t)width * height * out_components;
  if (out_size <= 0 || out_size > (int64_t)INT32_MAX) {
    status = STATUS_OOM;
    goto cleanup;
  }

  if (!jpegStoreInfo(width, height, out_components, out_format,
                     (int)out_size)) {
    status = STATUS_OOM;
    goto cleanup;
  }

  size_t row_size = (size_t)width * out_components;
  batch = (uint8_t *)malloc(row_size * ROW_BATCH);
  if (!batch) {
    status = STATUS_OOM;
    goto cleanup;
  }
  for (int i = 0; i < ROW_BATCH; i++) {
    rows[i] = batch + row_size * i;
  }

  if (!jpeg_start_decompress(&cinfo)) {
    goto cleanup;
  }
  started = 1;

  size_t offset = 0;
  while (cinfo.output_scanline < cinfo.output_height) {
    JDIMENSION read = jpeg_read_scanlines(&cinfo, rows, ROW_BATCH);
    if (read == 0) {
      /* The data ran out without libjpeg noticing; the rest of the frame is
       * whatever `jpegStoreInfo` allocated, so report it as truncated. */
      pdfjs_truncated = 1;
      break;
    }
    jpegCopyRows((int)(intptr_t)batch, (int)offset, (int)(row_size * read));
    offset += row_size * read;
  }
  jpegStoreWarnings((int)cinfo.err->num_warnings, pdfjs_truncated);
  status = STATUS_OK;

cleanup:
  if (started) {
    /* `jpeg_finish_decompress` would error out on a truncated image. */
    jpeg_abort_decompress(&cinfo);
  }
  if (created) {
    jpeg_destroy_decompress(&cinfo);
  }
  free(batch);
  return status;
}
