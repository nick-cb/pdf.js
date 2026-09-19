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

import { info } from "../shared/util.js";

/**
 * A single image's profile; every method is a no-op while profiling is
 * disabled, so call sites don't need to guard themselves.
 */
class ImageProfile {
  #entry = null;

  constructor(entry) {
    this.#entry = entry;
  }

  /**
   * Records why a backend earlier in the preference order wasn't used.
   * @param {string} backend
   * @param {string} reason
   */
  skip(backend, reason) {
    this.#entry?.skipped.push({ backend, reason });
  }

  /**
   * Records the backend that produced the pixels.
   * @param {string} backend
   */
  backend(backend) {
    if (this.#entry) {
      this.#entry.backend = backend;
    }
  }

  /**
   * Starts a named timer; the returned function stops it.
   * @param {string} name
   * @returns {Function} Stops the timer.
   */
  timer(name) {
    if (!this.#entry) {
      return ImageProfiler.noopTimer;
    }
    const start = performance.now();
    return () => {
      const entry = this.#entry;
      if (entry) {
        entry[name] = (entry[name] ?? 0) + (performance.now() - start);
      }
    };
  }

  /**
   * Merges a stream's `backendInfo` into the entry: which decoder produced the
   * pixels, and why the ones preferred over it were skipped.
   * @param {object} [backendInfo]
   */
  mergeBackend(backendInfo) {
    const entry = this.#entry;
    if (!entry || !backendInfo) {
      return;
    }
    if (backendInfo.backend) {
      entry.backend = backendInfo.backend;
    }
    if (backendInfo.skipped?.length) {
      entry.skipped.push(...backendInfo.skipped);
    }
  }

  /**
   * Merges extra fields into the entry.
   * @param {object} fields
   */
  set(fields) {
    if (this.#entry) {
      Object.assign(this.#entry, fields);
    }
  }

  /**
   * Closes the entry; nothing further is recorded for this image.
   * @param {object} [fields]
   */
  end(fields = null) {
    const entry = this.#entry;
    if (!entry) {
      return;
    }
    this.#entry = null;
    if (fields) {
      Object.assign(entry, fields);
    }
    entry.total = performance.now() - entry.start;
    info(`ImageProfiler: ${JSON.stringify(entry)}`);
  }
}

const disabledProfile = new ImageProfile(null);

/**
 * Optional, structured, per-image decoding profiles: which backends were
 * considered, why the earlier ones were skipped, and where the time went.
 *
 * Disabled by default; enabling it costs one `performance.now()` per timer,
 * and disabled it costs a handful of calls on a shared no-op instance.
 */
class ImageProfiler {
  static #enabled = false;

  static #entries = [];

  static noopTimer = () => {};

  /** A profile that records nothing; for skipping the field gathering. */
  static get disabledProfile() {
    return disabledProfile;
  }

  static setOptions({ profileImages = false }) {
    this.#enabled = profileImages;
  }

  static get enabled() {
    return this.#enabled;
  }

  /**
   * Opens a profile for one image.
   * @param {object} fields - The image's static properties, e.g. its codec,
   *   dimensions, color space and mask usage.
   * @returns {ImageProfile}
   */
  static start(fields) {
    if (!this.#enabled) {
      return disabledProfile;
    }
    const entry = {
      ...fields,
      backend: null,
      skipped: [],
      start: performance.now(),
    };
    this.#entries.push(entry);
    return new ImageProfile(entry);
  }

  /**
   * The entries recorded so far, oldest first.
   * @returns {Array<object>}
   */
  static get entries() {
    return this.#entries;
  }

  static clear() {
    this.#entries.length = 0;
  }
}

export { ImageProfile, ImageProfiler };
