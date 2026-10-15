import { DepthTexture, FloatType, HalfFloatType, RedFormat, UnsignedByteType, WebGLRenderTarget } from 'three';
import { describe, expect, it } from 'vitest';

import { renderTargetBytes, renderTargetsBytes } from '@render/targetBytes';

/** THE FIGURES OF docs/AUDITORIA-2026-10-15.md 4.1, from the code that counts them. */
describe('renderTargetBytes', () => {
  it('counts the scene target: half-float colour and float depth, eight samples, at 2880 x 1620', () => {
    const w = 2880, h = 1620;
    const target = new WebGLRenderTarget(w, h, { type: HalfFloatType, depthTexture: new DepthTexture(w, h, FloatType), samples: 8 });
    const pixels = w * h;
    // Colour: resolved 8 B + 8 samples of 8 B; depth: resolved 4 B + 8 samples of 4 B.
    expect(renderTargetBytes(target)).toBe(pixels * 8 * 9 + pixels * 4 * 9);
    // The audit's figure: 298.6 + 149.3 MB of samples and 56 MB resolved, about 504 MB.
    expect(Math.round(renderTargetBytes(target) / 1e6)).toBe(504);
  });

  it('counts a plain half-float target with no depth as width x height x 8', () => {
    const target = new WebGLRenderTarget(100, 50, { type: HalfFloatType, depthBuffer: false });
    expect(renderTargetBytes(target)).toBe(100 * 50 * 8);
  });

  it('counts a single-channel byte target and a depth render buffer', () => {
    const mask = new WebGLRenderTarget(10, 10, { type: UnsignedByteType, format: RedFormat, depthBuffer: false });
    expect(renderTargetBytes(mask)).toBe(100);
    const withDepth = new WebGLRenderTarget(10, 10, { type: UnsignedByteType, depthBuffer: true });
    expect(renderTargetBytes(withDepth)).toBe(100 * 4 + 100 * 4);
  });

  it('counts a shared target once', () => {
    const a = new WebGLRenderTarget(10, 10, { type: UnsignedByteType, depthBuffer: false });
    expect(renderTargetsBytes([a, a, null, undefined])).toBe(400);
  });
});
