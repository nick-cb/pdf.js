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

import { DecodeStream } from "./decode_stream.js";
import { Dict } from "./primitives.js";
import { JBig2CCITTFaxImage } from "./jbig2_ccittFax.js";
import { shadow } from "../shared/util.js";

class CCITTFaxStream extends DecodeStream {
  constructor(str, maybeLength, params) {
    super(maybeLength);

    this.stream = str;
    this.maybeLength = maybeLength;
    this.dict = str.dict;

    if (!(params instanceof Dict)) {
      params = Dict.empty;
    }

    this.params = {
      K: params.get("K") || 0,
      EndOfLine: !!params.get("EndOfLine"),
      EncodedByteAlign: !!params.get("EncodedByteAlign"),
      Columns: params.get("Columns") || 1728,
      Rows: params.get("Rows") || 0,
      EndOfBlock: !!(params.get("EndOfBlock") ?? true),
      BlackIs1: !!params.get("BlackIs1"),
    };
  }

  get bytes() {
    // If `this.maybeLength` is null, we'll get the entire stream.
    return shadow(this, "bytes", this.stream.getBytes(this.maybeLength));
  }

  get isImageStream() {
    return true;
  }

  get isAsyncDecoder() {
    return true;
  }

  async decodeImage(bytes, length, decoderOptions) {
    if (this.eof) {
      return this.buffer;
    }
    bytes ??= this.stream.isAsync
      ? (await this.stream.asyncGetBytes()) || this.bytes
      : this.bytes;

    const decoder = JBig2CCITTFaxImage.instance;
    const start =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    let succeeded = false;
    try {
      this.buffer = await decoder.decode(
        bytes,
        this.dict.get("W", "Width"),
        this.dict.get("H", "Height"),
        null,
        this.params
      );
      succeeded = true;
    } finally {
      decoderOptions?.profile?.(
        succeeded
          ? `decoder: CCITT Fax / ${decoder.decoderType}`
          : `decoder attempt: CCITT Fax / ${decoder.decoderType} (failed)`,
        start,
        typeof performance !== "undefined" ? performance.now() : Date.now()
      );
    }
    this.bufferLength = this.buffer.length;
    this.eof = true;

    return this.buffer;
  }
}

export { CCITTFaxStream };
