/**
 * Converts CMYK samples to RGB in place, returning a view of the same buffer.
 * @param {Uint8ClampedArray} data
 * @returns {Uint8ClampedArray}
 */
export function convertCmykToRgb(data: Uint8ClampedArray): Uint8ClampedArray;
/**
 * Converts CMYK samples to RGBA in place, returning the same buffer.
 * @param {Uint8ClampedArray} data
 * @returns {Uint8ClampedArray}
 */
export function convertCmykToRgba(data: Uint8ClampedArray): Uint8ClampedArray;
declare const JpegError_base: any;
export class JpegError extends JpegError_base {
    [x: string]: any;
    constructor(msg: any);
}
export class JpegImage {
    static canUseImageDecoder(data: any, colorTransform?: number): {
        width: number;
        height: number;
        exifStart: number;
        exifEnd: number;
    } | null;
    constructor(options: any);
    _colorTransform: any;
    _decodeTransform: any;
    _isSourcePDF: boolean | undefined;
    parse(data: any, { dnlScanLines }?: {
        dnlScanLines?: null | undefined;
    }): any;
    width: any;
    height: any;
    jfif: {
        version: {
            major: any;
            minor: any;
        };
        densityUnits: any;
        xDensity: number;
        yDensity: number;
        thumbWidth: any;
        thumbHeight: any;
        thumbData: any;
    } | null | undefined;
    adobe: {
        version: number;
        flags0: number;
        flags1: number;
        transformCode: any;
    } | null | undefined;
    components: any[] | undefined;
    numComponents: number | undefined;
    get _isColorConversionNeeded(): boolean;
    _convertYccToRgb(data: any): any;
    _convertYccToRgba(data: any, out: any): any;
    _convertYcckToRgb(data: any): Uint8ClampedArray<ArrayBufferLike>;
    _convertYcckToRgba(data: any): Uint8ClampedArray<ArrayBufferLike>;
    _convertYcckToCmyk(data: any): any;
    _convertCmykToRgb(data: any): Uint8ClampedArray<ArrayBufferLike>;
    _convertCmykToRgba(data: any): Uint8ClampedArray<ArrayBufferLike>;
    getData({ width, height, forceRGBA, forceRGB }: {
        width: any;
        height: any;
        forceRGBA?: boolean | undefined;
        forceRGB?: boolean | undefined;
    }, ...args: any[]): any;
    #private;
}
export {};
