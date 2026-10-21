import { describe, expect, it } from 'vitest';
import { DataArrayTexture, DataTexture, FloatType, RGBAFormat } from 'three';
import { stageTexels, type TexelPart } from '@render/stagedTexels';

/** A DATA TEXTURE'S TEXELS ON THE PAGE ONLY WHILE THREE SENDS THEM (`render/stagedTexels.ts`) */

/** What three r186 does at a send (`WebGLTextures.uploadTexture`): reads `image.data`, more than once, then calls `onUpdate`. */
function send(texture: DataTexture | DataArrayTexture): ArrayBufferView {
  const first = texture.image.data as ArrayBufferView;
  const again = texture.image.data as ArrayBufferView;
  expect(again).toBe(first);
  texture.onUpdate?.(texture);
  return first;
}

describe('texels staged for a send', () => {
  it('fills the whole texture from its truth at a send, once a send, and keeps no array of its own', () => {
    const texture = new DataTexture(null, 8, 8, RGBAFormat, FloatType);
    const parts: TexelPart[] = [];
    stageTexels(texture, Float32Array, 8 * 8 * 4, 4, (into, part) => { parts.push(part); into.fill(parts.length); });
    texture.needsUpdate = true;
    const sent = send(texture) as Float32Array;
    expect(parts).toEqual([{ layers: null, box: null }]);
    expect(sent.length).toBe(8 * 8 * 4);
    expect(sent[17]).toBe(1);
    // A context restored sends it again: filled again from the truth.
    expect((send(texture) as Float32Array)[3]).toBe(2);
  });

  it('works out only the rows three sends, as a box', () => {
    const texture = new DataTexture(null, 16, 16, RGBAFormat, FloatType);
    let box: TexelPart['box'] = null;
    stageTexels(texture, Float32Array, 16 * 16 * 4, 4, (_into, part) => { box = part.box; });
    for (let y = 3; y <= 6; y++) texture.addUpdateRange((y * 16 + 5) * 4, (9 - 5 + 1) * 4);
    texture.needsUpdate = true;
    send(texture);
    expect(box).toEqual({ x0: 5, x1: 9, y0: 3, y1: 6 });
  });

  it('works out only the layers three sends of an array', () => {
    const texture = new DataArrayTexture(null, 4, 4, 3);
    let layers: TexelPart['layers'] = null;
    stageTexels(texture, Uint8Array, 4 * 4 * 4 * 3, 4, (_into, part) => { layers = part.layers; });
    texture.addLayerUpdate(2);
    texture.needsUpdate = true;
    send(texture);
    expect(layers).toEqual([2]);
  });

  it('shares one staging array between the textures of a size: never one a plate', () => {
    const a = new DataTexture(null, 8, 8, RGBAFormat, FloatType), b = new DataTexture(null, 8, 8, RGBAFormat, FloatType);
    stageTexels(a, Float32Array, 256, 4, (into) => into.fill(1));
    stageTexels(b, Float32Array, 256, 4, (into) => into.fill(2));
    a.needsUpdate = true;
    b.needsUpdate = true;
    const sentA = send(a);
    const sentB = send(b) as Float32Array;
    expect(sentB).toBe(sentA);
    expect(sentB[0]).toBe(2);
  });

  it('sends an array it holds, and lets it go once sent', () => {
    const texture = new DataTexture(null, 2, 2, RGBAFormat, FloatType);
    const staged = stageTexels(texture, Float32Array, 16, 4, (into) => into.fill(7));
    const own = new Float32Array(16).fill(3);
    staged.hold(own);
    texture.needsUpdate = true;
    staged.letGoWhenSent();
    // Not sent yet: still held.
    expect(staged.held).toBe(own);
    expect(send(texture)).toBe(own);
    expect(staged.held).toBeNull();
    // Already sent: let go at once.
    staged.hold(own);
    staged.letGoWhenSent();
    expect(staged.held).toBeNull();
    texture.needsUpdate = true;
    expect((send(texture) as Float32Array)[0]).toBe(7);
  });

  it('makes an array of its own for each send, unshared, and lets it go once sent', () => {
    const a = new DataTexture(null, 8, 8, RGBAFormat, FloatType), b = new DataTexture(null, 8, 8, RGBAFormat, FloatType);
    let fills = 0;
    stageTexels(a, Float32Array, 256, 4, (into) => { fills++; into.fill(1); }, { shared: false });
    stageTexels(b, Float32Array, 256, 4, (into) => into.fill(2), { shared: false });
    a.needsUpdate = true;
    b.needsUpdate = true;
    const sentA = send(a) as Float32Array;
    const sentB = send(b) as Float32Array;
    expect(sentB).not.toBe(sentA);
    expect(sentA[0]).toBe(1);
    expect(fills).toBe(1);
    // Sent: the next read (a context restored) is a new array, filled again.
    const again = send(a) as Float32Array;
    expect(again).not.toBe(sentA);
    expect(again[255]).toBe(1);
    expect(fills).toBe(2);
  });

  it('keeps an onUpdate given before it', () => {
    const texture = new DataTexture(null, 2, 2, RGBAFormat, FloatType);
    let calls = 0;
    texture.onUpdate = () => { calls++; };
    stageTexels(texture, Float32Array, 16, 4, () => {});
    texture.needsUpdate = true;
    send(texture);
    expect(calls).toBe(1);
  });
});
