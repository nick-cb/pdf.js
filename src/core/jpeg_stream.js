/* Copyright 2012 Mozilla Foundation
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

import { convertCmykToRgb, convertCmykToRgba, JpegImage } from "./jpg.js";
import { FeatureTest, shadow, warn } from "../shared/util.js";
import { JpegWasmFormat, JpegWasmImage } from "./jpeg_wasm.js";
import { DecodeStream } from "./decode_stream.js";
import { Dict } from "./primitives.js";
import { ImageResizer } from "./image_resizer.js";

/**
 * For JPEG's we use a library to decode these images and the stream behaves
 * like all the other DecodeStreams.
 */
class JpegStream extends DecodeStream {
  static #isImageDecoderSupported = FeatureTest.isImageDecoderSupported;

  static #useWasm = true;

  /**
   * The dimensions the last decode produced; they differ from
   * `drawWidth`/`drawHeight` only after a reduced-resolution decode.
   */
  decodedWidth = 0;

  decodedHeight = 0;

  /** Which decoder produced `buffer`, and why the earlier ones were skipped. */
  backendInfo = null;

  /**
   * Requests a `1 / 2 ** reducePower` decode; only the Wasm decoder honors it.
   */
  reducePower = 0;

  constructor(stream, maybeLength, params) {
    super(maybeLength);

    this.stream = stream;
    this.dict = stream.dict;
    this.maybeLength = maybeLength;
    this.params = params;
  }

  static get canUseImageDecoder() {
    return shadow(
      this,
      "canUseImageDecoder",
      this.#isImageDecoderSupported
        ? ImageDecoder.isTypeSupported("image/jpeg")
        : Promise.resolve(false)
    );
  }

  static setOptions({ isImageDecoderSupported = false, useWasm = true }) {
    this.#isImageDecoderSupported = isImageDecoderSupported;
    this.#useWasm = useWasm;
  }

  get bytes() {
    // If `this.maybeLength` is null, we'll get the entire stream.
    return shadow(this, "bytes", this.stream.getBytes(this.maybeLength));
  }

  ensureBuffer(requested) {
    // No-op, since `this.readBlock` will always parse the entire image and
    // directly insert all of its data into `this.buffer`.
  }

  readBlock(decoderOptions) {
    // The synchronous path always uses the JavaScript decoder; the Wasm one is
    // only reachable through `getImageData`, which may await it.
    this.#decodeWithJs(null, [], decoderOptions);
  }

  get isAsyncDecoder() {
    return true;
  }

  get jpegOptions() {
    const jpegOptions = { colorTransform: undefined };

    // Fetching the 'ColorTransform' entry, if it exists.
    if (this.params instanceof Dict) {
      const colorTransform = this.params.get("ColorTransform");
      if (Number.isInteger(colorTransform)) {
        jpegOptions.colorTransform = colorTransform;
      }
    }
    return shadow(this, "jpegOptions", jpegOptions);
  }

  #skipUselessBytes(data) {
    // Some images may contain 'junk' before the SOI (start-of-image) marker.
    // Note: this seems to mainly affect inline images.
    for (let i = 0, ii = data.length - 1; i < ii; i++) {
      if (data[i] === 0xff && data[i + 1] === 0xd8) {
        if (i > 0) {
          data = data.subarray(i);
        }
        break;
      }
    }
    return data;
  }

  #store(data, width, height, backend, skipped) {
    this.buffer = data;
    this.bufferLength = data.length;
    this.decodedWidth = width;
    this.decodedHeight = height;
    this.backendInfo = { backend, skipped };
    this.eof = true;

    return this.buffer;
  }

  #decodeWithJs(bytes, skipped = [], decoderOptions = null) {
    if (this.eof) {
      return this.buffer;
    }
    const start =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    let succeeded = false;
    try {
      bytes = this.#skipUselessBytes(bytes || this.bytes);

      const jpegImage = new JpegImage(this.jpegOptions);
      jpegImage.parse(bytes);
      const data = jpegImage.getData({
        width: this.drawWidth,
        height: this.drawHeight,
        forceRGBA: this.forceRGBA,
        forceRGB: this.forceRGB,
      });
      succeeded = true;
      return this.#store(
        data,
        this.drawWidth,
        this.drawHeight,
        "JpegImage",
        skipped
      );
    } finally {
      decoderOptions?.profile?.(
        succeeded
          ? "decoder: JPEG / JavaScript"
          : "decoder attempt: JPEG / JavaScript (failed)",
        start,
        typeof performance !== "undefined" ? performance.now() : Date.now()
      );
    }
  }

  /**
   * Decodes through libjpeg-turbo, asking it for the final pixel format -- and,
   * when a reduction was requested, the final size -- so that no separate
   * conversion or resampling pass is needed.
   * @param {Uint8Array} bytes
   * @returns {Promise<object>} `{ data, width, height }`, or `{ data: null,
   *   reason }` when the image has to go through {@linkcode JpegImage}.
   */
  async #decodeWithWasm(bytes) {
    const { colorTransform } = this.jpegOptions;
    const wantsRgba = this.forceRGBA;
    const wantsRgb = this.forceRGB;
    const params = {
      colorTransform: colorTransform ?? -1,
      reducePower: this.reducePower,
      // A frame that disagrees with the image dictionary needs the resampling
      // that only `JpegImage` does.
      expectedWidth: this.drawWidth,
      expectedHeight: this.drawHeight,
    };
    const decoder = JpegWasmImage.instance;
    let format = JpegWasmFormat.NATIVE;
    if (wantsRgba) {
      format = JpegWasmFormat.RGBA32;
    } else if (wantsRgb) {
      format = JpegWasmFormat.RGB24;
    }

    let result = await decoder.decode(bytes, {
      ...params,
      format,
    });
    if (!result.data && (wantsRgba || wantsRgb)) {
      // CMYK is the one case libjpeg won't convert to RGB: PDF.js owns that
      // conversion, so take the components and do it here.
      const cmyk = await decoder.decode(bytes, {
        ...params,
        format: JpegWasmFormat.CMYK32,
      });
      if (cmyk.data) {
        cmyk.data = wantsRgba
          ? convertCmykToRgba(cmyk.data)
          : convertCmykToRgb(cmyk.data);
        result = cmyk;
      }
    }
    if (!result.data) {
      warn(`JpegStream: Wasm decoding skipped: ${result.reason}.`);
    }
    return result;
  }

  async decodeImage(bytes, _length, decoderOptions = null) {
    if (this.eof) {
      return this.buffer;
    }
    const skipped = [];

    if (!JpegStream.#useWasm) {
      skipped.push({ backend: "JpegWasm", reason: "disabled" });
    } else if (!(this.drawWidth > 0 && this.drawHeight > 0)) {
      // Nothing to validate the frame against, e.g. an image used as a mask.
      skipped.push({ backend: "JpegWasm", reason: "unknown dimensions" });
    } else {
      bytes = this.#skipUselessBytes(bytes || this.bytes);
      const start =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      let result;
      try {
        result = await this.#decodeWithWasm(bytes);
      } finally {
        decoderOptions?.profile?.(
          result?.data
            ? "decoder: JPEG / Wasm"
            : "decoder attempt: JPEG / Wasm (failed)",
          start,
          typeof performance !== "undefined" ? performance.now() : Date.now()
        );
      }

      if (result.data) {
        return this.#store(
          result.data,
          result.width,
          result.height,
          "JpegWasm",
          skipped
        );
      }
      skipped.push({ backend: "JpegWasm", reason: result.reason });
    }
    return this.#decodeWithJs(bytes, skipped, decoderOptions);
  }

  get canAsyncDecodeImageFromBuffer() {
    return this.stream.isAsync;
  }

  async getTransferableImage(width, height, profile = null) {
    if (!(await JpegStream.canUseImageDecoder)) {
      this.backendInfo = {
        backend: null,
        skipped: [{ backend: "ImageDecoder", reason: "unsupported" }],
      };
      return null;
    }
    const jpegOptions = this.jpegOptions;
    let decoder, decodeStart, skipReason;
    try {
      // TODO: If the stream is Flate & DCT we could try to just pipe the
      // the DecompressionStream into the ImageDecoder: it'll avoid the
      // intermediate ArrayBuffer.
      const bytes =
        (this.canAsyncDecodeImageFromBuffer &&
          (await this.stream.asyncGetBytes())) ||
        this.bytes;
      if (!bytes) {
        skipReason = "no data";
        return null;
      }
      let data = this.#skipUselessBytes(bytes);
      const useImageDecoder = JpegImage.canUseImageDecoder(
        data,
        jpegOptions.colorTransform
      );
      if (!useImageDecoder) {
        skipReason = "component layout";
        return null;
      }
      const { width: frameWidth, height: frameHeight } = useImageDecoder;
      const reducePower = ImageResizer.getReducePower(frameWidth, frameHeight);
      if (
        (frameWidth !== width || frameHeight !== height) &&
        (reducePower || !frameHeight)
      ) {
        // Only downscale when the SOF and image dictionary dimensions match.
        skipReason = "dimension mismatch";
        return null;
      }
      if (useImageDecoder.exifStart) {
        // Replace the entire EXIF-block with dummy data, to ensure that a
        // non-default EXIF orientation won't cause the image to be rotated
        // when using `ImageDecoder` (fixes bug1942064.pdf).
        //
        // Copy the data first, to avoid modifying the original PDF document.
        data = data.slice();
        data.fill(0x00, useImageDecoder.exifStart, useImageDecoder.exifEnd);
      }
      const init = {
        data,
        type: "image/jpeg",
        preferAnimation: false,
      };
      // Request reduced dimensions; ImageDecoder treats them as best-effort.
      if (reducePower) {
        const factor = 2 ** reducePower;
        init.desiredWidth = Math.ceil(frameWidth / factor);
        init.desiredHeight = Math.ceil(frameHeight / factor);
      }
      decoder = new ImageDecoder(init);

      decodeStart =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      const image = (await decoder.decode()).image;
      this.backendInfo = { backend: "ImageDecoder", skipped: [] };
      profile?.(
        "decoder: JPEG / ImageDecoder",
        decodeStart,
        typeof performance !== "undefined" ? performance.now() : Date.now()
      );
      return image;
    } catch (reason) {
      if (decodeStart !== undefined) {
        profile?.(
          "decoder attempt: JPEG / ImageDecoder (failed)",
          decodeStart,
          typeof performance !== "undefined" ? performance.now() : Date.now()
        );
      }
      warn(`getTransferableImage - failed: "${reason}".`);
      skipReason = `${reason}`;
      return null;
    } finally {
      decoder?.close();

      if (skipReason !== undefined) {
        this.backendInfo = {
          backend: null,
          skipped: [{ backend: "ImageDecoder", reason: skipReason }],
        };
      }
    }
  }

  get isImageStream() {
    return true;
  }
}

export { JpegStream };
