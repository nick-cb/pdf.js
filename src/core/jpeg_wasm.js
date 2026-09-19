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

import { shadow, warn } from "../shared/util.js";
import LibJpeg from "../../external/libjpeg/libjpeg.js";
import { WasmImage } from "./wasm_image.js";

/**
 * Output pixel formats; must match the `FORMAT_*` constants in
 * `external/libjpeg/pdfjs_jpeg.c`.
 * @enum {number}
 */
const JpegWasmFormat = {
  /** Gray8, RGB24 or CMYK32, depending on the number of components. */
  NATIVE: 0,
  GRAY8: 1,
  RGB24: 2,
  RGBA32: 3,
  CMYK32: 4,
};

/**
 * Decoder status codes; must match the `STATUS_*` constants in
 * `external/libjpeg/pdfjs_jpeg.c`.
 * @enum {number}
 */
const JpegWasmStatus = {
  OK: 0,
  ERROR: 1,
  UNSUPPORTED: 2,
  DIMENSIONS: 3,
  OOM: 4,
};

/**
 * The largest reduced-IDCT power the decoder offers, i.e. a `1 / 8` decode;
 * must match `MAX_REDUCE_POWER` in `external/libjpeg/pdfjs_jpeg.c`.
 */
const MAX_REDUCE_POWER = 3;

const STATUS_REASONS = [
  "ok",
  "decoder error",
  "unsupported image",
  "unexpected dimensions",
  "allocation failed",
];

/**
 * libjpeg-turbo, compiled to WebAssembly: several times faster than
 * {@linkcode JpegImage}, and able to produce the final pixel format -- and,
 * through the reduced-resolution IDCT, the final size -- directly.
 *
 * Every decode reports either pixels or a reason; a reason means the caller
 * must fall back to {@linkcode JpegImage}, which is the only decoder that
 * handles every input PDF.js has ever accepted.
 */
class JpegWasmImage extends WasmImage {
  _filename = "libjpeg.wasm";

  _noWasmFilename = "libjpeg_nowasm_fallback.js";

  /** Set once loading has failed, so it isn't attempted per image. */
  #unavailable = false;

  static get instance() {
    return shadow(
      this,
      "instance",
      new JpegWasmImage(/* trackInstance = */ true)
    );
  }

  /**
   * @param {Uint8Array} bytes - The JPEG data.
   * @param {object} params
   * @param {number} [params.format] - One of {@linkcode JpegWasmFormat}.
   * @param {number} [params.colorTransform] - The `/ColorTransform` value from
   *   the image dictionary, or `-1` when it's absent.
   * @param {number} [params.reducePower] - Requests a `1 / 2 ** reducePower`
   *   reduced-IDCT decode, clamped to {@linkcode MAX_REDUCE_POWER}; the result
   *   reports the dimensions actually used.
   * @param {number} [params.expectedWidth] - The image dictionary width, used
   *   to refuse images whose frame disagrees with the PDF data.
   * @param {number} [params.expectedHeight] - The image dictionary height.
   * @param {number} [params.maxPixels] - Refuses larger images outright.
   * @returns {Promise<object>} `{ data, width, height, components, format }`,
   *   or `{ data: null, reason }` when the image must go through
   *   {@linkcode JpegImage} instead.
   */
  async decode(
    bytes,
    {
      format = JpegWasmFormat.NATIVE,
      colorTransform = -1,
      reducePower = 0,
      expectedWidth = 0,
      expectedHeight = 0,
      maxPixels = 0,
    } = {}
  ) {
    if (this.#unavailable) {
      return { data: null, reason: "decoder unavailable" };
    }
    let module;
    try {
      module = await this._getModule(LibJpeg);
    } catch (ex) {
      warn(`JpegWasmImage.decode - loading failed: "${ex}".`);
    }
    if (!module) {
      // Nothing about the failure is image-specific, so don't retry it.
      this.#unavailable = true;
      return { data: null, reason: "decoder unavailable" };
    }
    let ptr = 0;

    try {
      ptr = module._malloc(bytes.length);
      if (!ptr) {
        return { data: null, reason: "allocation failed" };
      }
      module.writeArrayToMemory(bytes, ptr);

      const status = module._jpeg_decode(
        ptr,
        bytes.length,
        format,
        colorTransform,
        Math.min(reducePower, MAX_REDUCE_POWER),
        expectedWidth,
        expectedHeight,
        maxPixels
      );
      const { imageData, imageInfo, errorMessages } = module;
      module.imageData = module.imageInfo = null;
      delete module.errorMessages;

      if (status !== JpegWasmStatus.OK || !imageData || !imageInfo) {
        const reason =
          errorMessages?.join(", ") || STATUS_REASONS[status] || "error";
        return { data: null, reason };
      }
      if (imageInfo.truncated) {
        // libjpeg invents the missing rows, `JpegImage` invents different ones;
        // keep the long-standing appearance of a truncated file.
        return { data: null, reason: "truncated image" };
      }
      return {
        data: imageData,
        width: imageInfo.width,
        height: imageInfo.height,
        components: imageInfo.components,
        format: imageInfo.format,
        warnings: imageInfo.warnings,
        reason: null,
      };
    } catch (ex) {
      warn(`JpegWasmImage.decode - failed: "${ex}".`);
      return { data: null, reason: `${ex}` };
    } finally {
      if (ptr) {
        module._free(ptr);
      }
      // A decode that threw may have left these behind.
      module.imageData = module.imageInfo = null;
    }
  }
}

export { JpegWasmFormat, JpegWasmImage, JpegWasmStatus, MAX_REDUCE_POWER };
