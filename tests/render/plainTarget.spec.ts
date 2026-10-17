import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SRGBColorSpace, UnsignedByteType } from 'three';
import { plainTarget } from '@render/postprocess';

/** A quality without the chain on a canvas made for it draws through a target three draws as it draws the canvas (`postprocess.ts` plainChain). */
describe('the target of a quality without the chain', () => {
  it('is drawn as the canvas is: tone mapped and sRGB encoded in each material, 8 bits a channel, stored as written', () => {
    const target = plainTarget(64, 32, 4);
    expect((target as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget).toBe(true);
    expect(target.texture.colorSpace).toBe(SRGBColorSpace);
    expect(target.texture.type).toBe(UnsignedByteType);
    expect(target.texture.internalFormat).toBe('RGBA8');
    expect(target.samples).toBe(4);
    target.dispose();
  });

  it('rests on three drawing such a target with the canvas\'s tone mapping and colour space (r186 WebGLPrograms, WebGLRenderer)', () => {
    const programs = readFileSync('node_modules/three/src/renderers/webgl/WebGLPrograms.js', 'utf8');
    expect(programs).toMatch(/currentRenderTarget === null \|\| currentRenderTarget\.isXRRenderTarget === true/);
    expect(programs).toMatch(/currentRenderTarget\.isXRRenderTarget === true \? currentRenderTarget\.texture\.colorSpace/);
    const renderer = readFileSync('node_modules/three/src/renderers/WebGLRenderer.js', 'utf8');
    expect(renderer).toMatch(/_currentRenderTarget === null \|\| _currentRenderTarget\.isXRRenderTarget === true/);
  });
});
