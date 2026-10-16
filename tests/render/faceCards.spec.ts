import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Color, MeshStandardMaterial, Texture, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';
import { applySkinAppearance, createPersonLayers, type PersonLayers, type SkinAppearance } from '@render/people/skinAppearance';

/** The face's brows and lashes are copied into layers of the person's small array texture (`skinAppearance.ts` `createPersonLayers`). */

const SIZE = 256;
let saved: unknown;

beforeAll(() => {
  saved = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  // A 2D canvas that only has to hand back blank pixels (node has none).
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
    width: number; height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; }
    getContext() {
      return {
        canvas: this,
        clearRect() {}, drawImage() {}, save() {}, restore() {}, setTransform() {},
        getImageData: () => ({ data: new Uint8ClampedArray(SIZE * SIZE * 4) }),
      };
    }
  };
});

afterAll(() => {
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = saved;
});

function faceGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  geometry.setAttribute('skinMask', new BufferAttribute(new Float32Array(3), 1));
  geometry.setAttribute('hairMask', new BufferAttribute(new Float32Array(3), 1));
  return geometry;
}

function card(): Texture {
  return new Texture({ width: SIZE, height: SIZE } as unknown as HTMLImageElement);
}

function appearance(brow: Texture, lash: Texture): SkinAppearance {
  return { texture: new Texture(), eyeTexture: new Texture(), tint: new Color(1, 1, 1), hair: new Color(0.2, 0.1, 0.05),
    browTexture: brow, lashTexture: lash, garments: [], outfitTint: null, beard: 0, makeup: 0 };
}

/** The uniforms a material's program is built with, as three hands them to `onBeforeCompile`. */
function compile(atlas: PersonLayers, skin: SkinAppearance): Record<string, { value: unknown }> {
  const material = new MeshStandardMaterial();
  applySkinAppearance(material, faceGeometry(), skin, atlas);
  const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>\n#include <project_vertex>',
    fragmentShader: '#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <lights_physical_pars_fragment>\n#include <normal_fragment_maps>\n#include <lights_fragment_end>\n#include <alphatest_fragment>' };
  material.onBeforeCompile(shader as unknown as WebGLProgramParametersWithUniforms, {} as WebGLRenderer);
  return shader.uniforms as Record<string, { value: unknown }>;
}

describe('face cards', () => {
  it('gives a released card layer back: a long session of people coming and going never runs out', () => {
    // Each person's brow and lash textures are released when the person leaves (`releaseSkinAppearance` disposes them)
    const atlas = createPersonLayers();
    for (let person = 0; person < 200; person++) {
      const brow = card(), lash = card();
      const uniforms = compile(atlas, appearance(brow, lash));
      expect(uniforms['cardTextures']!.value, `person ${person}`).toEqual([0, 1, 1, 0]);
      brow.dispose();
      lash.dispose();
    }
    // The layers were given back and reused: the array never had to grow.
    expect(atlas.small.uniform.value!.image.depth).toBe(24);
    atlas.dispose();
  });

  it('holds every card alive at once, each in a layer of its own, however many there are', () => {
    const atlas = createPersonLayers();
    const live: Texture[] = [];
    const layers = new Set<number>();
    let array: unknown = null;
    for (let person = 0; person < 40; person++) {
      const brow = card(), lash = card();
      live.push(brow, lash);
      const uniforms = compile(atlas, appearance(brow, lash));
      expect(uniforms['cardTextures']!.value, `person ${person}`).toEqual([0, 1, 1, 0]);
      const at = uniforms['cardLayers']!.value as number[];
      layers.add(at[1]!); layers.add(at[2]!);
      array = uniforms['personLayersSmall']!.value;
    }
    expect(layers.size).toBe(80);
    const depth = (array as { image: { depth: number } }).image.depth;
    for (const layer of layers) expect(layer).toBeLessThan(depth);
    for (const texture of live) texture.dispose();
    atlas.dispose();
  });

  it('sends a grown array whole on its first upload, then only the layers written after', () => {
    // three allocates a new array texture and, with layer updates listed, uploads only those layers
    const atlas = createPersonLayers();
    const live: Texture[] = [];
    let array = atlas.small.uniform.value;
    for (let person = 0; person < 13; person++) {
      const brow = card(), lash = card();
      live.push(brow, lash);
      compile(atlas, appearance(brow, lash));
      array = atlas.small.uniform.value;
    }
    // 26 cards: grown past 24 and never uploaded since.
    expect(array!.image.depth).toBe(48);
    expect(array!.layerUpdates.size).toBe(0);
    // Uploaded (three calls `onUpdate`): the next card is sent as its own layer.
    array!.onUpdate?.(array!);
    const brow = card(), lash = card();
    live.push(brow, lash);
    compile(atlas, appearance(brow, lash));
    expect(atlas.small.uniform.value).toBe(array);
    expect(array!.layerUpdates.size).toBe(2);
    for (const texture of live) texture.dispose();
    atlas.dispose();
  });
});
