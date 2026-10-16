/** The part of three's bundled ktx-parse (`examples/jsm/libs`, Don McCurdy's KTX 2.0 reader and writer) the surface bake uses. */
declare module 'three/examples/jsm/libs/ktx-parse.module.js' {
  export interface KTX2Sample {
    bitOffset: number;
    /** The bit length minus one. */
    bitLength: number;
    /** The channel id in the low four bits, its qualifiers (`KHR_DF_SAMPLE_DATATYPE_*`) in the high four. */
    channelType: number;
    samplePosition: [number, number, number, number];
    sampleLower: number;
    sampleUpper: number;
  }
  export interface KTX2DataFormatDescriptorBasicFormat {
    vendorId: number;
    descriptorType: number;
    versionNumber: number;
    colorModel: number;
    colorPrimaries: number;
    transferFunction: number;
    flags: number;
    texelBlockDimension: [number, number, number, number];
    bytesPlane: [number, number, number, number, number, number, number, number];
    samples: KTX2Sample[];
  }
  export interface KTX2Level {
    levelData: Uint8Array;
    uncompressedByteLength: number;
  }
  export interface KTX2Container {
    vkFormat: number;
    typeSize: number;
    pixelWidth: number;
    pixelHeight: number;
    pixelDepth: number;
    layerCount: number;
    faceCount: number;
    levelCount: number;
    supercompressionScheme: number;
    /** Level 0, the largest, first. */
    levels: KTX2Level[];
    dataFormatDescriptor: KTX2DataFormatDescriptorBasicFormat[];
    keyValue: Record<string, string | Uint8Array>;
    globalData: unknown;
  }
  export function createDefaultContainer(): KTX2Container;
  export function read(data: Uint8Array): KTX2Container;
  export function write(container: KTX2Container, options?: { keepWriter?: boolean }): Uint8Array;
  export const VK_FORMAT_UNDEFINED: number;
  export const VK_FORMAT_R8G8B8A8_UNORM: number;
  export const VK_FORMAT_R8G8B8A8_SRGB: number;
  export const KHR_SUPERCOMPRESSION_NONE: number;
  export const KHR_SUPERCOMPRESSION_ZSTD: number;
  export const KHR_DF_MODEL_RGBSDA: number;
  export const KHR_DF_PRIMARIES_BT709: number;
  export const KHR_DF_TRANSFER_LINEAR: number;
  export const KHR_DF_TRANSFER_SRGB: number;
  export const KHR_DF_CHANNEL_RGBSDA_RED: number;
  export const KHR_DF_CHANNEL_RGBSDA_GREEN: number;
  export const KHR_DF_CHANNEL_RGBSDA_BLUE: number;
  export const KHR_DF_CHANNEL_RGBSDA_ALPHA: number;
  export const KHR_DF_SAMPLE_DATATYPE_LINEAR: number;
}
