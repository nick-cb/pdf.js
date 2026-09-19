/**
 * Output pixel formats; must match the `FORMAT_*` constants in
 * `external/libjpeg/pdfjs_jpeg.c`.
 */
export type JpegWasmFormat = number;
export namespace JpegWasmFormat {
    let NATIVE: number;
    let GRAY8: number;
    let RGB24: number;
    let RGBA32: number;
    let CMYK32: number;
}
/**
 * libjpeg-turbo, compiled to WebAssembly: several times faster than
 * {@linkcode JpegImage}, and able to produce the final pixel format -- and,
 * through the reduced-resolution IDCT, the final size -- directly.
 *
 * Every decode reports either pixels or a reason; a reason means the caller
 * must fall back to {@linkcode JpegImage}, which is the only decoder that
 * handles every input PDF.js has ever accepted.
 */
export class JpegWasmImage extends WasmImage {
    static get instance(): any;
    _filename: string;
    _noWasmFilename: string;
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
    decode(bytes: Uint8Array, { format, colorTransform, reducePower, expectedWidth, expectedHeight, maxPixels, }?: {
        format?: number | undefined;
        colorTransform?: number | undefined;
        reducePower?: number | undefined;
        expectedWidth?: number | undefined;
        expectedHeight?: number | undefined;
        maxPixels?: number | undefined;
    }): Promise<object>;
    #private;
}
/**
 * Decoder status codes; must match the `STATUS_*` constants in
 * `external/libjpeg/pdfjs_jpeg.c`.
 */
export type JpegWasmStatus = number;
export namespace JpegWasmStatus {
    let OK: number;
    let ERROR: number;
    let UNSUPPORTED: number;
    let DIMENSIONS: number;
    let OOM: number;
}
/**
 * The largest reduced-IDCT power the decoder offers, i.e. a `1 / 8` decode;
 * must match `MAX_REDUCE_POWER` in `external/libjpeg/pdfjs_jpeg.c`.
 */
export const MAX_REDUCE_POWER: 3;
import { WasmImage } from "./wasm_image.js";
