/**
 * For JPEG's we use a library to decode these images and the stream behaves
 * like all the other DecodeStreams.
 */
export class JpegStream extends DecodeStream {
    static #isImageDecoderSupported: any;
    static #useWasm: boolean;
    static get canUseImageDecoder(): any;
    static setOptions({ isImageDecoderSupported, useWasm }: {
        isImageDecoderSupported?: boolean | undefined;
        useWasm?: boolean | undefined;
    }): void;
    constructor(stream: any, maybeLength: any, params: any);
    /**
     * The dimensions the last decode produced; they differ from
     * `drawWidth`/`drawHeight` only after a reduced-resolution decode.
     */
    decodedWidth: number;
    decodedHeight: number;
    /** Which decoder produced `buffer`, and why the earlier ones were skipped. */
    backendInfo: null;
    /**
     * Requests a `1 / 2 ** reducePower` decode; only the Wasm decoder honors it.
     */
    reducePower: number;
    stream: any;
    dict: any;
    maybeLength: any;
    params: any;
    get bytes(): any;
    ensureBuffer(requested: any): void;
    readBlock(decoderOptions: any): void;
    get jpegOptions(): any;
    decodeImage(bytes: any, _length: any, decoderOptions?: null): Promise<Uint8Array<ArrayBuffer>>;
    get canAsyncDecodeImageFromBuffer(): any;
    getTransferableImage(width: any, height: any, profile?: null): Promise<VideoFrame | null>;
    #private;
}
import { DecodeStream } from "./decode_stream.js";
