import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, GLBufferAttribute, HalfFloatType, Mesh, MeshStandardMaterial, ShaderMaterial, WebGLRenderTarget } from 'three';
import { chosenBackend } from '@render/gpu/backendChoice';
import { createCompatibility } from '@render/gpu/compatibility';
import { comparePictures, halfToFloat, toDisplay } from '@render/gpu/imageCompare';

/** The WebGPU renderer's stage 1 (`MIGRACAO-WEBGPU.md`): the key, what it may draw, and the comparison's numbers. */

describe('the renderer chosen', () => {
  it('is WebGL without the key, and where the browser has no WebGPU', () => {
    expect(chosenBackend('', true)).toBe('webgl');
    expect(chosenBackend('?gpu=webgl', true)).toBe('webgl');
    expect(chosenBackend('?gpu=webgpu', false)).toBe('webgl');
    expect(chosenBackend('?city=7&gpu=webgpu', true)).toBe('webgpu');
  });
});

describe('what the WebGPU renderer can draw as it stands', () => {
  const triangle = (): BufferGeometry => new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));

  it('draws three\'s own materials', () => {
    expect(createCompatibility().drawable(new Mesh(triangle(), new MeshStandardMaterial()))).toBeNull();
  });

  it('leaves out a patched material, a shader material, a WebGL buffer and a texture WebGL drew, each named', () => {
    const verdicts = createCompatibility();
    const patched = new MeshStandardMaterial();
    patched.onBeforeCompile = () => {};
    expect(verdicts.drawable(new Mesh(triangle(), patched))).toBe('onBeforeCompile (MeshStandardMaterial)');
    expect(verdicts.drawable(new Mesh(triangle(), new ShaderMaterial()))).toBe('ShaderMaterial');
    const buffered = triangle().setAttribute('aWebGl', new GLBufferAttribute({} as WebGLBuffer, 0x1406, 1, 4, 3) as never);
    expect(verdicts.drawable(new Mesh(buffered, new MeshStandardMaterial()))).toBe('GLBufferAttribute (aWebGl)');
    const drawn = new MeshStandardMaterial({ map: new WebGLRenderTarget(4, 4, { type: HalfFloatType }).texture });
    expect(verdicts.drawable(new Mesh(triangle(), drawn))).toBe('map drawn by WebGL');
    const hooked = new Mesh(triangle(), new MeshStandardMaterial());
    hooked.onBeforeRender = () => {};
    expect(verdicts.drawable(hooked)).toBe('onBeforeRender hook');
    expect(verdicts.drawable(new Mesh(triangle(), [new MeshStandardMaterial(), new ShaderMaterial()]))).toBe('ShaderMaterial');
  });
});

describe('the pictures compared', () => {
  it('reads half floats', () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0x3800)).toBe(0.5);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0)).toBe(0);
  });

  it('puts both through the same film curve, flipping a picture read bottom row first', () => {
    // Two pixels, one above the other: black over white (1.0 linear).
    const half = new Uint16Array([0, 0, 0, 0x3c00, 0x3c00, 0x3c00, 0x3c00, 0x3c00]);
    const asRead = toDisplay(half, 1, 2, false);
    const flipped = toDisplay(half, 1, 2, true);
    expect([...asRead.slice(0, 3)]).toEqual([0, 0, 0]);
    // three's ACES of 1.0, through sRGB: bright, not clipped white.
    expect(asRead[4]).toBeGreaterThan(200);
    expect(asRead[4]).toBeLessThan(255);
    expect([...flipped.slice(4, 7)]).toEqual([0, 0, 0]);
  });

  it('gives the mean difference and the share over the threshold', () => {
    const a = new Uint8ClampedArray([10, 10, 10, 255, 100, 100, 100, 255, 0, 0, 0, 255, 50, 50, 50, 255]);
    const b = new Uint8ClampedArray([10, 10, 10, 255, 100, 120, 100, 255, 4, 0, 0, 255, 50, 50, 50, 255]);
    const d = comparePictures(a, b, 8);
    expect(d.mean).toBe(6);
    expect(d.over).toBe(25);
    expect(d.max).toBe(20);
    expect(d.image[4]).toBe(80);
    expect(comparePictures(a, a).over).toBe(0);
  });
});
