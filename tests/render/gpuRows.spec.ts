import { describe, expect, it } from 'vitest';
import type { DataTexture, Texture, WebGLRenderer, WebGLRenderTarget } from 'three';
import { createGpuRows, wholeRows } from '@render/people/gpuRows';

/** A renderer that keeps each texture's rows as the GPU would (`copyTextureToTexture` from data, the copy quad drawn). */
function fakeGpu(): { renderer: WebGLRenderer; rowsOf(texture: Texture): Map<number, number[]>; calls: string[] } {
  const store = new Map<Texture, Map<number, number[]>>();
  const rowsOf = (texture: Texture): Map<number, number[]> => {
    let rows = store.get(texture);
    if (!rows) { rows = new Map(); store.set(texture, rows); }
    return rows;
  };
  const calls: string[] = [];
  let current: WebGLRenderTarget | null = null;
  const renderer = {
    autoClear: true,
    getRenderTarget: () => current,
    setRenderTarget: (t: WebGLRenderTarget | null) => { current = t; },
    initRenderTarget: () => { calls.push('init'); },
    compile: () => { calls.push('compile'); },
    copyTextureToTexture: (src: DataTexture, dst: Texture, _region: unknown, at: { x: number; y: number }) => {
      calls.push(`write ${at.y}`);
      const { data, width, height } = src.image as { data: Float32Array; width: number; height: number };
      for (let r = 0; r < height; r++) rowsOf(dst).set(at.y + r, [...data.subarray(r * width * 4, (r + 1) * width * 4)]);
    },
    render: (scene: { children: { material: { uniforms: Record<string, { value: unknown }> } }[] }) => {
      const uniforms = scene.children[0]!.material.uniforms;
      const from = uniforms['uFrom']!.value as Texture, shift = uniforms['uShift']!.value as number;
      const into = current!;
      const v = into.viewport;
      calls.push(`draw ${v.y}..${v.y + v.w}`);
      for (let y = v.y; y < v.y + v.w; y++) {
        const row = rowsOf(from).get(y - shift);
        if (row) rowsOf(into.texture).set(y, row); else rowsOf(into.texture).delete(y);
      }
    },
  };
  return { renderer: renderer as unknown as WebGLRenderer, rowsOf, calls };
}

const row = (width: number, value: number): Float32Array => new Float32Array(width * 4).fill(value);

describe('rows kept on the GPU only', () => {
  it('sends each row up once, at the flush, and keeps nothing waiting after it', () => {
    const gpu = fakeGpu();
    const rows = createGpuRows(2, 4);
    rows.write(1, row(2, 7));
    expect(gpu.rowsOf(rows.texture).size).toBe(0);
    rows.flush(gpu.renderer);
    expect(gpu.rowsOf(rows.texture).get(1)).toEqual(Array(8).fill(7));
    const before = gpu.calls.length;
    rows.flush(gpu.renderer);
    expect(gpu.calls.length).toBe(before);
  });

  it('carries the rows on the GPU into a grown texture before the rows written since', () => {
    const gpu = fakeGpu();
    const rows = createGpuRows(2, 2);
    rows.write(0, row(2, 1));
    rows.write(1, row(2, 2));
    rows.flush(gpu.renderer);
    rows.grow(4);
    rows.write(1, row(2, 5));
    rows.write(3, row(2, 3));
    rows.flush(gpu.renderer);
    const now = gpu.rowsOf(rows.texture);
    expect(rows.rows).toBe(4);
    expect(now.get(0)![0]).toBe(1);
    expect(now.get(1)![0]).toBe(5);
    expect(now.get(3)![0]).toBe(3);
  });

  it('grown twice before a flush, carries from the texture that was on the GPU', () => {
    const gpu = fakeGpu();
    const rows = createGpuRows(1, 1);
    rows.write(0, row(1, 9));
    rows.flush(gpu.renderer);
    rows.grow(2);
    rows.grow(8);
    rows.flush(gpu.renderer);
    expect(gpu.rowsOf(rows.texture).get(0)![0]).toBe(9);
  });

  it('copies rows inside the texture through a second target, after the writes before it', () => {
    const gpu = fakeGpu();
    const rows = createGpuRows(1, 6);
    rows.write(0, new Float32Array([1, 1, 1, 1, 2, 2, 2, 2]));
    rows.copy(0, 3, 2);
    rows.flush(gpu.renderer);
    const now = gpu.rowsOf(rows.texture);
    expect(now.get(3)![0]).toBe(1);
    expect(now.get(4)![0]).toBe(2);
  });

  it('after a reset carries nothing over and drops what waited: the owner writes again', () => {
    const gpu = fakeGpu();
    const rows = createGpuRows(1, 2);
    rows.write(0, row(1, 4));
    rows.flush(gpu.renderer);
    rows.grow(4);
    rows.write(1, row(1, 6));
    rows.reset();
    rows.write(2, row(1, 8));
    rows.flush(gpu.renderer);
    expect([...gpu.rowsOf(rows.texture).keys()]).toEqual([2]);
  });

  it('pads a short last row with zeros', () => {
    const padded = wholeRows(new Float32Array([1, 2, 3]), 1);
    expect([...padded]).toEqual([1, 2, 3, 0]);
    const whole = new Float32Array(8);
    expect(wholeRows(whole, 2)).toBe(whole);
  });
});
