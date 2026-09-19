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

import { Dict, Name } from "../../src/core/primitives.js";
import {
  GlobalColorSpaceCache,
  LocalColorSpaceCache,
} from "../../src/core/image_utils.js";
import { ImageKind, stringToBytes } from "../../src/shared/util.js";
import { ImageProfiler } from "../../src/core/image_profiler.js";
import { ImageResizer } from "../../src/core/image_resizer.js";
import { JpegImage } from "../../src/core/jpg.js";
import { JpegStream } from "../../src/core/jpeg_stream.js";
import { PDFFunctionFactory } from "../../src/core/function.js";
import { PDFImage } from "../../src/core/image.js";
import { Stream } from "../../src/core/stream.js";
import { XRefMock } from "./test_utils.js";

// Only a JPEG header is needed: `canUseImageDecoder` stops at the SOF marker.
function createJpeg({
  width = 1,
  height = 1,
  numComponents = 3,
  sofMarker = /* SOF0 (Start of Frame, Baseline DCT) = */ 0xffc0,
  appData = null,
} = {}) {
  const bytes = [0xff, 0xd8]; // SOI
  if (appData) {
    const length = appData.length + 2;
    bytes.push(0xff, 0xe1, length >> 8, length & 0xff, ...appData); // APP1
  }
  const sofLength = 8 + 3 * numComponents;
  bytes.push(
    sofMarker >> 8,
    sofMarker & 0xff,
    sofLength >> 8,
    sofLength & 0xff,
    8, // sample precision
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    numComponents
  );
  for (let i = 0; i < numComponents; i++) {
    bytes.push(i + 1, 0x11, 0); // component id, H=1 V=1, quantization table 0
  }
  bytes.push(0xff, 0xd9); // EOI
  return new Uint8Array(bytes);
}

describe("jpeg_stream", function () {
  describe("JpegImage.canUseImageDecoder", function () {
    it("should report the frame dimensions", function () {
      expect(
        JpegImage.canUseImageDecoder(createJpeg({ width: 40000, height: 4000 }))
      ).toEqual({ width: 40000, height: 4000, exifStart: 0, exifEnd: 0 });

      expect(
        JpegImage.canUseImageDecoder(
          createJpeg({ width: 123, height: 45, numComponents: 1 })
        )
      ).toEqual({ width: 123, height: 45, exifStart: 0, exifEnd: 0 });
    });

    it("should report dimensions for each supported SOF marker", function () {
      for (const sofMarker of [
        0xffc0, // Baseline DCT.
        0xffc1, // Extended sequential DCT.
        0xffc2, // Progressive DCT.
      ]) {
        expect(
          JpegImage.canUseImageDecoder(
            createJpeg({ width: 40000, height: 4000, sofMarker })
          )
        )
          .withContext(sofMarker.toString(16))
          .toEqual({ width: 40000, height: 4000, exifStart: 0, exifEnd: 0 });
      }
    });

    it("should report a zero SOF height", function () {
      expect(
        JpegImage.canUseImageDecoder(createJpeg({ width: 40000, height: 0 }))
      ).toEqual({ width: 40000, height: 0, exifStart: 0, exifEnd: 0 });
    });

    it("should report the frame dimensions together with the EXIF-offsets", function () {
      const payload = [1, 2, 3, 4];
      const appData = [...stringToBytes("Exif\x00\x00"), ...payload];

      // SOI (2) + APP1-marker (2) + length (2) + "Exif\x00\x00" (6) = 12.
      expect(
        JpegImage.canUseImageDecoder(
          createJpeg({ width: 40000, height: 4000, appData })
        )
      ).toEqual({
        width: 40000,
        height: 4000,
        exifStart: 12,
        exifEnd: 12 + payload.length,
      });
    });

    it("should reject images that cannot be handled", function () {
      // Four-component JPEGs.
      expect(
        JpegImage.canUseImageDecoder(createJpeg({ numComponents: 4 }))
      ).toBeNull();
      // Three components with ColorTransform = 0.
      expect(
        JpegImage.canUseImageDecoder(createJpeg({ numComponents: 3 }), 0)
      ).toBeNull();
      expect(
        JpegImage.canUseImageDecoder(createJpeg({ numComponents: 3 }), 1)
      ).not.toBeNull();
    });
  });

  describe("getTransferableImage", function () {
    let decoderInits, savedDescriptor, hadImageDecoder, savedImageDecoder;

    beforeEach(function () {
      decoderInits = [];
      hadImageDecoder = "ImageDecoder" in globalThis;
      savedImageDecoder = globalThis.ImageDecoder;
      globalThis.ImageDecoder = class {
        constructor(init) {
          decoderInits.push(init);
        }

        decode() {
          // Simulate a decoder that honours the requested dimensions.
          const { desiredWidth, desiredHeight } = decoderInits.at(-1);
          return Promise.resolve({
            image: { displayWidth: desiredWidth, displayHeight: desiredHeight },
          });
        }

        close() {}
      };
      // Override cached feature detection and restore it after each test.
      savedDescriptor = Object.getOwnPropertyDescriptor(
        JpegStream,
        "canUseImageDecoder"
      );
      Object.defineProperty(JpegStream, "canUseImageDecoder", {
        value: Promise.resolve(true),
        enumerable: true,
        configurable: true,
        writable: false,
      });
    });

    afterEach(function () {
      Object.defineProperty(JpegStream, "canUseImageDecoder", savedDescriptor);
      if (hadImageDecoder) {
        globalThis.ImageDecoder = savedImageDecoder;
      } else {
        delete globalThis.ImageDecoder;
      }
    });

    function createStream(data) {
      return new JpegStream(
        new Stream(data, 0, data.length, Dict.empty),
        data.length,
        null
      );
    }

    it("should not pass any hint for an image that fits", async function () {
      const data = createJpeg({ width: 1024, height: 1024 });
      const image = await createStream(data).getTransferableImage(1024, 1024);

      expect(decoderInits.length).toEqual(1);
      expect(decoderInits[0].desiredWidth).toBeUndefined();
      expect(decoderInits[0].desiredHeight).toBeUndefined();
      expect(image).not.toBeNull();
    });

    it("should request a smaller frame for an oversized image", async function () {
      const width = 40000,
        height = 4000;
      const factor = 2 ** ImageResizer.getReducePower(width, height);
      expect(factor).toBeGreaterThan(1);

      const data = createJpeg({ width, height });
      const image = await createStream(data).getTransferableImage(
        width,
        height
      );

      expect(decoderInits.length).toEqual(1);
      expect(decoderInits[0].desiredWidth).toEqual(Math.ceil(width / factor));
      expect(decoderInits[0].desiredHeight).toEqual(Math.ceil(height / factor));
      expect(image.displayWidth).toEqual(decoderInits[0].desiredWidth);
      expect(image.displayHeight).toEqual(decoderInits[0].desiredHeight);
      expect(
        ImageResizer.needsToBeResized(image.displayWidth, image.displayHeight)
      ).toEqual(false);
    });

    it("should use `ImageDecoder` for a mismatch without resizing", async function () {
      const width = 1024,
        frameHeight = 1030,
        dictionaryHeight = 1024;
      expect(ImageResizer.getReducePower(width, frameHeight)).toEqual(0);

      const data = createJpeg({ width, height: frameHeight });
      const image = await createStream(data).getTransferableImage(
        width,
        dictionaryHeight
      );

      expect(decoderInits.length).toEqual(1);
      expect(decoderInits[0].desiredWidth).toBeUndefined();
      expect(decoderInits[0].desiredHeight).toBeUndefined();
      expect(image).not.toBeNull();
    });

    it("should not use `ImageDecoder` when the SOF dimensions disagree with the image dictionary", async function () {
      // A zero SOF height means that a later DNL marker defines it.
      const dnl = createJpeg({ width: 40000, height: 0 });
      expect(
        await createStream(dnl).getTransferableImage(40000, 4000)
      ).toBeNull();

      // The scan may also simply end before the SOF height (issue15492.pdf).
      const truncated = createJpeg({ width: 10800, height: 65000 });
      expect(
        await createStream(truncated).getTransferableImage(10800, 10320)
      ).toBeNull();

      expect(decoderInits.length).toEqual(0);
    });

    it("should not use `ImageDecoder` for images it cannot handle", async function () {
      const data = createJpeg({ width: 40000, height: 4000, numComponents: 4 });

      expect(
        await createStream(data).getTransferableImage(40000, 4000)
      ).toBeNull();
      expect(decoderInits.length).toEqual(0);
    });

    it("should report why `ImageDecoder` was skipped", async function () {
      const data = createJpeg({ width: 40000, height: 4000, numComponents: 4 });
      const stream = createStream(data);
      await stream.getTransferableImage(40000, 4000);

      expect(stream.backendInfo).toEqual({
        backend: null,
        skipped: [{ backend: "ImageDecoder", reason: "component layout" }],
      });

      const fits = createStream(createJpeg({ width: 1024, height: 1024 }));
      await fits.getTransferableImage(1024, 1024);

      expect(fits.backendInfo).toEqual({
        backend: "ImageDecoder",
        skipped: [],
      });
    });
  });

  describe("decodeImage", function () {
    // 16x16 grayscale and RGB baseline JPEGs.
    const TINY_GRAY =
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9" +
      "PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAAQABABAREA/8QAFgAB" +
      "AQEAAAAAAAAAAAAAAAAAAAYH/8QAFhAAAwAAAAAAAAAAAAAAAAAAABVi/9oACAEBAAA/AJ1L" +
      "ISyaIlkJZP/Z";
    const TINY_RGB =
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9" +
      "PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhC" +
      "Y2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAAR" +
      "CAAQABADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAQF/8QAFRABAQAAAAAAAAAA" +
      "AAAAAAAAABP/xAAUAQEAAAAAAAAAAAAAAAAAAAAF/8QAFhEAAwAAAAAAAAAAAAAAAAAAABVh" +
      "/9oADAMBAAIRAxEAPwDAqVRVKlFEGWlP/9k=";

    function createDecoded(base64, { forceRGBA, forceRGB, reducePower } = {}) {
      const data = stringToBytes(atob(base64));
      const stream = new JpegStream(
        new Stream(data, 0, data.length, Dict.empty),
        data.length,
        null
      );
      stream.drawWidth = 16;
      stream.drawHeight = 16;
      stream.forceRGBA = !!forceRGBA;
      stream.forceRGB = !!forceRGB;
      stream.reducePower = reducePower ?? 0;
      return stream;
    }

    beforeEach(function () {
      // The Wasm decoder is exercised through the reference tests; here the
      // point is that everything still works when it isn't used.
      JpegStream.setOptions({
        isImageDecoderSupported: false,
        useWasm: false,
      });
    });

    afterEach(function () {
      JpegStream.setOptions({
        isImageDecoderSupported: false,
        useWasm: true,
      });
      ImageProfiler.setOptions({ profileImages: false });
      ImageProfiler.clear();
    });

    it("should fall back to `JpegImage`, and say so", async function () {
      const stream = createDecoded(TINY_GRAY);
      const data = await stream.getImageData(0, null);

      expect(data.length).toEqual(16 * 16);
      expect(stream.decodedWidth).toEqual(16);
      expect(stream.decodedHeight).toEqual(16);
      expect(stream.backendInfo).toEqual({
        backend: "JpegImage",
        skipped: [{ backend: "JpegWasm", reason: "disabled" }],
      });
    });

    it("should produce the requested pixel format", async function () {
      const rgba = await createDecoded(TINY_GRAY, {
        forceRGBA: true,
      }).getImageData(0, null);
      expect(rgba.length).toEqual(16 * 16 * 4);
      expect(rgba[0]).toEqual(rgba[1]);
      expect(rgba[1]).toEqual(rgba[2]);
      expect(rgba[3]).toEqual(255);

      const rgb = await createDecoded(TINY_RGB, {
        forceRGB: true,
      }).getImageData(0, null);
      expect(rgb.length).toEqual(16 * 16 * 3);

      const native = await createDecoded(TINY_RGB).getImageData(0, null);
      expect(native.length).toEqual(16 * 16 * 3);
    });

    it("should compose an explicit mask into decoder RGBA output", async function () {
      const bytes = stringToBytes(atob(TINY_RGB));
      const imageDict = new Dict();
      imageDict.set("W", 16);
      imageDict.set("H", 16);
      imageDict.set("BPC", 8);
      imageDict.set("CS", Name.get("DeviceRGB"));
      imageDict.set("F", Name.get("DCTDecode"));
      const image = new JpegStream(
        new Stream(bytes, 0, bytes.length, imageDict),
        bytes.length,
        null
      );

      const maskDict = new Dict();
      maskDict.set("W", 16);
      maskDict.set("H", 16);
      maskDict.set("BPC", 1);
      maskDict.set("IM", true);
      const maskBytes = new Uint8Array(16 * 2);
      maskBytes[0] = 0xff;
      const mask = new Stream(maskBytes, 0, maskBytes.length, maskDict);

      const xref = new XRefMock();
      const pdfImage = new PDFImage({
        xref,
        res: null,
        image,
        mask,
        pdfFunctionFactory: new PDFFunctionFactory({ xref }),
        globalColorSpaceCache: new GlobalColorSpaceCache(),
        localColorSpaceCache: new LocalColorSpaceCache(),
      });
      ImageProfiler.setOptions({ profileImages: true });

      const result = await pdfImage.createImageData(false, false);

      expect(result.kind).toEqual(ImageKind.RGBA_32BPP);
      expect(result.data.length).toEqual(16 * 16 * 4);
      for (let i = 3; i < 8 * 4; i += 4) {
        expect(result.data[i]).toEqual(0);
      }
      expect(result.data[8 * 4 + 3]).toEqual(255);
      expect(ImageProfiler.entries[0].fillRgbBranch).toEqual("decoder-output");
      expect(ImageProfiler.entries[0].backend).toEqual("JpegImage");
    });

    it("should not reduce on the JavaScript path", async function () {
      // `JpegImage` has no reduced-resolution decoding, so the dimensions that
      // come back are the ones the caller must use.
      const stream = createDecoded(TINY_RGB, { reducePower: 2 });
      const data = await stream.getImageData(0, null);

      expect(stream.decodedWidth).toEqual(16);
      expect(stream.decodedHeight).toEqual(16);
      expect(data.length).toEqual(16 * 16 * 3);
    });

    it("should not use the Wasm decoder without dimensions", async function () {
      JpegStream.setOptions({
        isImageDecoderSupported: false,
        useWasm: true,
      });
      const stream = createDecoded(TINY_GRAY);
      stream.drawWidth = stream.drawHeight = undefined;
      await stream.getImageData(0, null);

      expect(stream.backendInfo.skipped).toEqual([
        { backend: "JpegWasm", reason: "unknown dimensions" },
      ]);
    });
  });
});
