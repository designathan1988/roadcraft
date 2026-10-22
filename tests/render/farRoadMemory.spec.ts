import { describe, expect, it, vi } from 'vitest';

/** The simplifier's WebAssembly memory, caught as it is made (before `meshoptimizer` is imported): what a baking worker keeps for good. */
const made = vi.hoisted(() => {
  const memories: WebAssembly.Memory[] = [];
  const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (...args: unknown[]) => Promise<WebAssembly.WebAssemblyInstantiatedSource>;
  (WebAssembly as { instantiate: unknown }).instantiate = async (...args: unknown[]) => {
    const result = await instantiate(...args);
    const memory = (result.instance.exports as { memory?: WebAssembly.Memory }).memory;
    if (memory) memories.push(memory);
    return result;
  };
  return { memories };
});

import { MeshoptSimplifier } from 'meshoptimizer';
import { type FarRoadCache, type FarRoadMesh, SIMPLIFY_VERTICES, runFarRoadJob, simplifyInParts } from '@render/farRoadTiles';
import { farKey } from '@render/buildings/farTiles';
import { TILE } from '@world/tiles';

/** THE FAR ROADS' LEVELS SIMPLIFIED IN BATCHES (`farRoadTiles.ts` simplifyInParts): a level of many tiles never grows the simplifier's memory for good */

const Q = 32;
/** A tile's mesh of `pieces` separate flat pads, `side` x `side` vertices each, a metre apart, waving 1 cm (all of it under a level's error). */
function padsMesh(i: number, j: number, pieces: number, side: number): FarRoadMesh {
  const xz: number[] = [], height: number[] = [], index: number[] = [];
  for (let p = 0; p < pieces; p++) {
    const px = (p % 10) * 40 - 200, py = Math.floor(p / 10) * 40 - 200, base = height.length;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      xz.push((px + x) * Q, (py + y) * Q);
      height.push(0.01 * Math.sin(x + y * 3 + p));
    }
    for (let y = 0; y + 1 < side; y++) for (let x = 0; x + 1 < side; x++) {
      const a = base + y * side + x;
      index.push(a, a + 1, a + side, a + 1, a + side + 1, a + side);
    }
  }
  const count = height.length;
  return {
    xz: Int16Array.from(xz), height: Float32Array.from(height), normal: new Int8Array(count * 4).map((_, n) => (n % 4 === 1 ? 127 : 0)),
    color: new Uint8Array(count * 4).fill(200), index: Uint32Array.from(index), ox: (i + 0.5) * TILE, oy: (j + 0.5) * TILE, q: Q,
    bounds: Float64Array.of(i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE, 0, 0), error: 0.25,
  };
}

describe('the far roads simplified in batches', () => {
  it('bakes a level of four dense tiles without growing the simplifier past a batch', async () => {
    await MeshoptSimplifier.ready;
    // Every WebAssembly memory made (the simplifier's among the package's others): only the simplifier's grows here.
    const bytes = (): number => made.memories.reduce((sum, m) => sum + m.buffer.byteLength, 0);
    const kept = new Map<string, unknown>();
    const cache: FarRoadCache = { ready: () => Promise.resolve(true), get: (key) => Promise.resolve(kept.get(key)), put: (key, value) => { kept.set(key, value); return Promise.resolve(); } };
    const quarters = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
    // 4 x 100 pads of 21 x 21: 176,400 vertices, five batches' worth.
    for (const [i, j] of quarters) kept.set(`t:${farKey(0, i, j)}`, { sig: '1', mesh: padsMesh(i, j, 100, 21) });
    const before = bytes();
    const reply = await runFarRoadJob({ node: farKey(1, 0, 0), k: 1, i: 0, j: 0, sig: '1', want: true, prefix: 't:', children: quarters.map(([i, j]) => ({ key: farKey(0, i, j), sig: '1' })) }, cache);
    expect(reply.kind).toBe('far');
    const mesh = reply.kind === 'far' ? reply.payload as FarRoadMesh : null;
    // Every pad kept, each down to a few triangles (flat within the error).
    expect(mesh!.index.length / 3).toBeGreaterThanOrEqual(400 * 2);
    expect(mesh!.index.length / 3).toBeLessThan(400 * 20);
    // One call for all of it grew the memory by 39 MB (the code before); batches of `SIMPLIFY_VERTICES`, by 7.
    expect((bytes() - before) / 1048576).toBeLessThan(12);
  });

  it('simplifies as one call would, pieces never cut', async () => {
    await MeshoptSimplifier.ready;
    const mesh = padsMesh(0, 0, 100, 21);
    const count = mesh.height.length;
    const position = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) { position[v * 3] = mesh.xz[v * 2]! / Q; position[v * 3 + 1] = mesh.height[v]!; position[v * 3 + 2] = -mesh.xz[v * 2 + 1]! / Q; }
    const index = mesh.index as Uint32Array;
    const whole = MeshoptSimplifier.simplify(index, position, 3, 0, 0.25, ['ErrorAbsolute', 'Prune'])[0];
    // A batch far under the pieces' count: each piece in its batch, simplified alone.
    expect(count).toBeGreaterThan(SIMPLIFY_VERTICES);
    const parts = simplifyInParts(index, position, count, 0.25);
    expect(Math.abs(parts.length - whole.length) / whole.length).toBeLessThan(0.02);
    // Each triangle's corners in one pad (441 vertices each).
    for (let t = 0; t < parts.length; t += 3) {
      const pad = Math.floor(parts[t]! / 441);
      expect(Math.floor(parts[t + 1]! / 441)).toBe(pad);
      expect(Math.floor(parts[t + 2]! / 441)).toBe(pad);
    }
  });
});
