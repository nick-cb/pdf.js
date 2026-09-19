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

import { ImageProfiler } from "../../src/core/image_profiler.js";

describe("image_profiler", function () {
  afterEach(function () {
    ImageProfiler.setOptions({ profileImages: false });
    ImageProfiler.clear();
  });

  it("should record nothing while disabled", function () {
    ImageProfiler.setOptions({ profileImages: false });

    const profile = ImageProfiler.start({ codec: "DCTDecode" });
    profile.skip("ImageDecoder", "mask present");
    profile.backend("JpegWasm");
    profile.timer("decode")();
    profile.set({ reducePower: 1 });
    profile.end({ outputWidth: 10 });

    expect(ImageProfiler.enabled).toEqual(false);
    expect(ImageProfiler.entries).toEqual([]);
  });

  it("should record the backend decisions", function () {
    ImageProfiler.setOptions({ profileImages: true });

    const profile = ImageProfiler.start({ codec: "DCTDecode", width: 100 });
    profile.skip("ImageDecoder", "mask present");
    profile.mergeBackend({
      backend: "JpegWasm",
      skipped: [{ backend: "ImageDecoder", reason: "component layout" }],
    });
    profile.end({ outputWidth: 50 });

    expect(ImageProfiler.entries.length).toEqual(1);
    const [entry] = ImageProfiler.entries;

    expect(entry.codec).toEqual("DCTDecode");
    expect(entry.width).toEqual(100);
    expect(entry.outputWidth).toEqual(50);
    expect(entry.backend).toEqual("JpegWasm");
    expect(entry.skipped).toEqual([
      { backend: "ImageDecoder", reason: "mask present" },
      { backend: "ImageDecoder", reason: "component layout" },
    ]);
    expect(entry.total).toBeGreaterThanOrEqual(0);
  });

  it("should accumulate the time of repeated timers", function () {
    ImageProfiler.setOptions({ profileImages: true });

    const profile = ImageProfiler.start({ codec: "DCTDecode" });
    profile.timer("decode")();
    profile.timer("decode")();
    profile.end();

    const [entry] = ImageProfiler.entries;
    expect(entry.decode).toBeGreaterThanOrEqual(0);
    expect(entry.colorConversion).toBeUndefined();
  });

  it("should ignore anything recorded after the profile ends", function () {
    ImageProfiler.setOptions({ profileImages: true });

    const profile = ImageProfiler.start({ codec: "DCTDecode" });
    profile.end({ outputWidth: 10 });
    profile.set({ outputWidth: 20 });
    profile.backend("JpegImage");

    const [entry] = ImageProfiler.entries;
    expect(entry.outputWidth).toEqual(10);
    expect(entry.backend).toBeNull();
  });
});
