import { FloatType, HalfFloatType, RedFormat, RGFormat, UnsignedByteType, UnsignedIntType, UnsignedShortType, type RenderTarget, type Texture } from 'three';

/**
 * THE VIDEO MEMORY OF THE RENDER TARGETS AND SHADOW MAPS, in bytes: what `memoryCounters.ts` cannot see,
 * as they hang from no object of the scene. The scene's target alone (8 samples, half-float colour, float
 * depth) is ~500 MB at 2880 x 1620, and the sun's shadow map 134 MB, both missing from the plan's budget
 * line "alvos de render e sombras" (`core/perfBudget.ts`), which read "não medido" (docs/AUDITORIA-2026-10-15.md 4.1).
 *
 * An ESTIMATE from the sizes three allocates (`WebGLTextures.setupRenderTarget`): each colour attachment
 * once as a texture and, multisampled, `samples` times again as a render buffer; the depth likewise.
 * DO NOT read it as the driver's figure (padding, tiling and compression are the driver's own).
 */

/** Bytes of one texel of a texture: channels by component size. */
export function texelBytesOf(texture: Pick<Texture, 'type' | 'format'>): number {
  const channels = texture.format === RedFormat ? 1 : texture.format === RGFormat ? 2 : 4;
  const component = texture.type === FloatType || texture.type === UnsignedIntType ? 4
    : texture.type === HalfFloatType || texture.type === UnsignedShortType ? 2
      : texture.type === UnsignedByteType ? 1 : 4;
  return channels * component;
}

/** The bytes a render target holds: its textures, their multisampled buffers, and its depth. */
export function renderTargetBytes(target: Pick<RenderTarget, 'width' | 'height' | 'samples' | 'textures' | 'depthBuffer' | 'depthTexture'>): number {
  const pixels = target.width * target.height;
  const samples = Math.max(1, target.samples);
  let bytes = 0;
  for (const texture of target.textures) {
    const texel = texelBytesOf(texture);
    bytes += pixels * texel;
    // Multisampled: the samples live in a render buffer, the texture is what they resolve into.
    if (target.samples > 0) bytes += pixels * texel * samples;
  }
  if (target.depthTexture) {
    const texel = target.depthTexture.type === FloatType ? 4 : target.depthTexture.type === UnsignedShortType ? 2 : 4;
    bytes += pixels * texel;
    if (target.samples > 0) bytes += pixels * texel * samples;
  } else if (target.depthBuffer) {
    // A depth buffer without a texture: a render buffer of 24 bits, padded to 4 bytes.
    bytes += pixels * 4 * samples;
  }
  return bytes;
}

/** The total of several targets, a target shared counted once; null entries are skipped. */
export function renderTargetsBytes(targets: Iterable<Parameters<typeof renderTargetBytes>[0] | null | undefined>): number {
  const seen = new Set<object>();
  let total = 0;
  for (const target of targets) {
    if (!target || seen.has(target)) continue;
    seen.add(target);
    total += renderTargetBytes(target);
  }
  return total;
}
