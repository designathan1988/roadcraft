import { readFileSync } from 'node:fs';
import { MeshBasicMaterial, type BufferAttribute, type Mesh } from 'three';
import { describe, expect, it } from 'vitest';

import { coarseArrays, levelsOf } from '@render/mesh/roadLod';
import { marksRoadSection } from '@render/mesh/roadEdges';
import { COARSE_ERROR } from '@render/mesh/roadLodPure';
import { FAR_MARGIN, makeFar, makeNear, updateRoadLevels } from '@render/mesh/roadResidency';
import { attachFarLevel, blockArraysOf, cloneBlock, joinBlocks, mergeTiles, splitBlock } from '@render/mesh/surfaceTiles';
import { refillArrays } from '@render/mesh/gpuOnly';
import type { Tile } from '@render/mesh/tileMesh';

/** THE FAR LEVEL OF A BLOCK OF ROAD (`mesh/roadLod.ts`, `mesh/roadResidency.ts`) */
const W = 200, H = 12, STEP = 3.2;

/** A flat road strip W x H (world x, y; the mesh's z = -y) as a lattice a surface's refinement would give. */
function strip(): Tile {
  const nx = Math.floor(W / STEP) + 2, ny = 5;
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = Math.min(W, i * STEP), y = (H * j) / (ny - 1);
    positions.push(x, 0.002 * Math.sin(x / 40), -y);
    uvs.push(x / 4, y / 4);
  }
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) { const a = j * nx + i; indices.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1); }
  const n = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(n * 3).map((_, k) => (k % 3 === 1 ? 1 : 0)),
    uvs: new Float32Array(uvs), colors: new Float32Array(n * 3).fill(1), sections: new Float32Array(n * 3),
    indices: new Uint32Array(indices),
  };
}

const options = { name: 'asphalt', material: new MeshBasicMaterial(), receiveShadow: true } as const;
// A road crossing its block from one side to the other: only its two ends lie on the block's edge.
const lock = [0, -60, W, H + 60] as const;
/** The block with its far level made as a worker makes it (`roadTile.worker.ts`): the arrays copied, simplified, handed back. */
const make = (near: boolean): Mesh => mergeTiles([strip()], options, () => [strip()], {
  lock, near,
  start: (block, arrays) => { const made = coarseArrays(cloneBlock(arrays), lock); if (made) attachFarLevel(block, made, options, [{ source: () => [strip()], lock }], near); },
})!;
const levels = (mesh: Mesh): { coarse: Mesh; full: boolean } => mesh.userData.lod as { coarse: Mesh; full: boolean };
const trianglesOf = (mesh: Mesh): number => (mesh.geometry.index?.count ?? 0) / 3;

describe('a block of road with a far level', () => {
  it('carries the colour and the section only where its material reads them, at both levels', () => {
    const plain = make(true);
    for (const level of [plain, levels(plain).coarse]) {
      expect(level.geometry.getAttribute('color')).toBeUndefined();
      expect(level.geometry.getAttribute('roadSection')).toBeUndefined();
    }
    const reading = new MeshBasicMaterial({ vertexColors: true });
    marksRoadSection(reading);
    const both = { ...options, material: reading };
    const mesh = mergeTiles([strip()], both, () => [strip()], {
      lock, near: true,
      start: (block, arrays) => { const made = coarseArrays(cloneBlock(arrays), lock); if (made) attachFarLevel(block, made, both, [{ source: () => [strip()], lock }], true); },
    })!;
    for (const level of [mesh, levels(mesh).coarse]) {
      expect(level.geometry.getAttribute('color')).toBeDefined();
      expect(level.geometry.getAttribute('roadSection')).toBeDefined();
    }
  });

  it('has a far level a tenth of its size or less, that keeps the block\'s outer edge where it was', () => {
    const mesh = make(true);
    const coarse = levels(mesh).coarse;
    expect(trianglesOf(coarse)).toBeLessThan(trianglesOf(mesh) * 0.1);
    const keyOf = (p: BufferAttribute, i: number): string => `${p.getX(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    const far = new Set<string>();
    const farPosition = coarse.geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < farPosition.count; i++) far.add(keyOf(farPosition, i));
    const position = mesh.geometry.getAttribute('position') as BufferAttribute;
    let onEdge = 0;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = -position.getZ(i);
      if (Math.abs(x) < 1e-3 || Math.abs(x - W) < 1e-3 || y < lock[1] + 1e-3 || y > lock[3] - 1e-3) {
        onEdge++;
        expect(far.has(keyOf(position, i)), `edge vertex ${keyOf(position, i)}`).toBe(true);
      }
    }
    expect(onEdge).toBe(10);
  });

  it('is within the error allowed of the block (a flat road: no vertex of the block is farther than that off the far level\'s plane)', () => {
    const mesh = make(true);
    const coarse = levels(mesh).coarse;
    const heights = (m: Mesh): number[] => { const p = m.geometry.getAttribute('position') as BufferAttribute; return Array.from({ length: p.count }, (_, i) => p.getY(i)); };
    const spread = (h: number[]): number => Math.max(...h) - Math.min(...h);
    expect(spread(heights(coarse))).toBeLessThanOrEqual(spread(heights(mesh)) + COARSE_ERROR);
  });

  it('made near shows its own mesh and hides the far one', () => {
    const mesh = make(true);
    expect(mesh.visible).toBe(true);
    expect(levels(mesh).coarse.visible).toBe(false);
    expect(levels(mesh).full).toBe(true);
  });

  it('made far shows the far level and has no arrays of its own, which are given back when it comes near', () => {
    const mesh = make(false);
    expect(mesh.visible).toBe(false);
    expect(levels(mesh).coarse.visible).toBe(true);
    expect((mesh.geometry.getAttribute('position') as { array: unknown }).array).toBeNull();
    expect((mesh.geometry.index as { array: unknown }).array).toBeNull();
    makeNear(mesh);
    expect(mesh.visible).toBe(true);
    expect(levels(mesh).coarse.visible).toBe(false);
    expect((mesh.geometry.getAttribute('position') as BufferAttribute).array.length).toBe(strip().positions.length);
    makeFar(mesh);
    expect(mesh.visible).toBe(false);
    expect(levels(mesh).coarse.visible).toBe(true);
    expect((mesh.geometry.getAttribute('position') as { array: unknown }).array).toBeNull();
  });
});

describe('a far level on the GPU', () => {
  it('lets go of the arrays its worker made once they are sent, and is made again from the block\'s tiles, never from them', () => {
    let tiles: Tile[] = [strip()];
    let made: ReturnType<typeof coarseArrays> = null;
    const block = mergeTiles([strip()], options, () => tiles, {
      lock, near: false,
      start: (b, arrays) => { made = coarseArrays(cloneBlock(arrays), lock); if (made) attachFarLevel(b, made, options, [{ source: () => tiles, lock }], false); },
    })!;
    const level = levels(block).coarse;
    expect(made).not.toBeNull();
    const kept = made!;
    const position = level.geometry.getAttribute('position') as BufferAttribute;
    // Sent to the GPU: its arrays let go (`gpuOnly`).
    for (const a of [...Object.values(level.geometry.attributes), level.geometry.index!]) (a as unknown as { onUploadCallback: () => void }).onUploadCallback.call(a);
    expect((position as { array: unknown }).array).toBeNull();
    // A lost context: made again from the tiles, the same far level.
    refillArrays(level);
    expect(position.array).not.toBe(kept.position);
    expect(Array.from(position.array)).toEqual(Array.from(kept.position));
    // Tiles that no longer simplify (too small to gain): arrays of its sizes, never the worker's it was made with.
    for (const a of [...Object.values(level.geometry.attributes), level.geometry.index!]) (a as unknown as { onUploadCallback: () => void }).onUploadCallback.call(a);
    tiles = [{ positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 0, -1), normals: Float32Array.of(0, 1, 0, 0, 1, 0, 0, 1, 0), uvs: new Float32Array(6), colors: new Float32Array(0), sections: new Float32Array(0), indices: Uint32Array.of(0, 2, 1) }];
    refillArrays(level);
    expect(position.array).not.toBe(kept.position);
    expect(level.geometry.index!.array).not.toBe(kept.index);
    expect(position.array.length).toBe(kept.position.length);
    expect(level.geometry.index!.array.length).toBe(kept.index.length);
  });
});

describe('a block brought near from the kept tiles', () => {
  it('asks its arrays off the page once and shows the full level when they land; cut on the page only when they are not kept', async () => {
    const mesh = make(false);
    const lv = levels(mesh) as unknown as { bring: (() => Promise<unknown>) | null };
    let asked = 0;
    lv.bring = () => { asked++; return new Promise((done) => setTimeout(() => done(blockArraysOf([strip()], options.material)), 0)); };
    makeNear(mesh);
    expect(asked).toBe(1);
    expect(levels(mesh).full).toBe(false);
    expect(mesh.visible).toBe(false);
    // Asked again while it is under way: nothing more.
    makeNear(mesh);
    updateRoadLevels([mesh], (mesh.userData.lod as { x: number }).x, 0, 500);
    expect(asked).toBe(1);
    await new Promise((done) => setTimeout(done, 0));
    expect(levels(mesh).full).toBe(true);
    expect(mesh.visible).toBe(true);
    expect(levels(mesh).coarse.visible).toBe(false);
    expect((mesh.geometry.getAttribute('position') as BufferAttribute).array.length).toBe(strip().positions.length);
    // Not kept: cut again on the page.
    makeFar(mesh);
    lv.bring = () => Promise.resolve(null);
    makeNear(mesh);
    await new Promise((done) => setTimeout(done, 0));
    expect(levels(mesh).full).toBe(true);
    expect((mesh.geometry.getAttribute('position') as BufferAttribute).array.length).toBe(strip().positions.length);
  });
});

describe('the levels brought up to the camera', () => {
  const block = (x: number): Mesh => { const mesh = make(true); const lv = mesh.userData.lod as { x: number; z: number }; lv.x = x; lv.z = 0; return mesh; };

  it('sends a block far beyond the reach with its margin, and not before', () => {
    const near = block(0), edge = block(500 * FAR_MARGIN - 1), beyond = block(500 * FAR_MARGIN + 1);
    updateRoadLevels([near, edge, beyond], 0, 0, 500);
    expect([near, edge, beyond].map((m) => levels(m).full)).toEqual([true, true, false]);
  });

  it('brings a block near within the reach, the nearest first and a few at a look', () => {
    const blocks = [400, 100, 300, 200, 50].map(block);
    for (const b of blocks) makeFar(b);
    updateRoadLevels(blocks, 0, 0, 500);
    // Three of five: the nearest (50, 100, 200).
    expect(blocks.map((b) => levels(b).full)).toEqual([false, true, false, true, true]);
    updateRoadLevels(blocks, 0, 0, 500);
    expect(blocks.every((b) => levels(b).full)).toBe(true);
  });

  it('does not send a block back and forth on the line (the margin between going far and coming near)', () => {
    const b = block(520);
    updateRoadLevels([b], 0, 0, 500);
    expect(levels(b).full).toBe(true);
    makeFar(b);
    updateRoadLevels([b], 0, 0, 500);
    expect(levels(b).full).toBe(false);
  });
});

describe('the wiring', () => {
  it('has the renderer make the blocks near or far by the camera, and the roads free the far level with the block', () => {
    const renderer = readFileSync('src/render/renderer.ts', 'utf8');
    expect(renderer).toMatch(/near: \(x, y\) => isNear\(x, y, roadFocus\.x, roadFocus\.y, roadFocus\.reach\)/);
    expect(renderer).toMatch(/updateRoadLevels\(blocks, roadFocus\.x, roadFocus\.y, roadFocus\.reach\)/);
    expect(readFileSync('src/render/mesh/surfaceMesh.ts', 'utf8')).toMatch(/coarse\.geometry\.dispose\(\)/);
    // The far level is simplified by the workers: the page asks
    expect(readFileSync('src/render/roadSurfaces.ts', 'utf8')).not.toMatch(/coarseArrays\(/);
    expect(readFileSync('src/render/roadSurfaces.ts', 'utf8')).toMatch(/tiler\.coarsen\.bind\(tiler\)/);
    expect(readFileSync('src/render/roadTile.worker.ts', 'utf8')).toMatch(/coarseArrays\(data\.coarse\.arrays, data\.coarse\.lock\)/);
    // The masses of the far buildings are sent ahead too, so their arrays go (`gpuOnly`): 157 MB of a 2,560 m city.
    const masses = readFileSync('src/render/buildings/massCells.ts', 'utf8');
    expect(masses).toMatch(/void warmLooseAhead\(\[mesh\], priority\);/);
    expect(masses).toMatch(/cancelWarm\(\[cell\.mesh\]\);/);
  });
});

describe('the far levels made by the workers while the roads are built', () => {
  it('are waited for before the roads are put in place, and every block made far is drawn by its far level alone', async () => {
    const { planCity, DEFAULT_CITY } = await import('@world/cityGen/plan');
    const { layCity } = await import('@editor/cityGenerator');
    const { Network } = await import('@world/network');
    const { buildRoadElevation } = await import('@world/elevation');
    const { roadSurfaceSteps } = await import('@render/roadSurfaces');
    const { SurfaceInputs } = await import('@render/roadSurfaceInputs');
    const { levelsOf } = await import('@render/mesh/roadLod');
    const net = new Network(layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' })));
    net.rebuild();
    const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);
    const materials = new Proxy({}, { get: (_t, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : new MeshBasicMaterial() }) as never;
    let asked = 0;
    // The worker, in this process: no tiles off the page (built here), the far levels by a copy and a later answer.
    const tiler = {
      tiles: () => Promise.reject(new Error('the tiles are built here')),
      check: () => {},
      coarsen: (arrays: Parameters<typeof coarseArrays>[0], blockLock: readonly [number, number, number, number]) => {
        asked++;
        return new Promise<ReturnType<typeof coarseArrays>>((done) => setTimeout(() => done(coarseArrays(structuredClone(arrays), blockLock)), 0));
      },
    };
    const reuse = { tiles: new Map(), dependsOn: () => 0, paint: new Map(), chunks: new Map(), inputs: new SurfaceInputs(), near: () => false } as never;
    const steps = roadSurfaceSteps(net, buildRoadElevation(net, ground), materials, ground, reuse, undefined, tiler as never);
    let waited = 0;
    for (;;) {
      const step = steps.next();
      if (step.done) { step.value.adopt(); break; }
      if (step.value === 'wait') { waited++; await new Promise((done) => setTimeout(done, 0)); }
    }
    expect(asked).toBeGreaterThan(20);
    expect(waited).toBeGreaterThan(0);
    const chunks = [...(reuse as { chunks: Map<string, { mesh: Mesh }> }).chunks.values()].map((c) => c.mesh);
    const withLevel = chunks.filter((m) => levelsOf(m)?.coarse);
    expect(withLevel.length).toBeGreaterThan(20);
    for (const mesh of withLevel) {
      const level = levelsOf(mesh)!;
      expect(level.full).toBe(false);
      expect(mesh.visible).toBe(false);
      expect(level.coarse!.visible).toBe(true);
      expect(level.coarse!.parent).toBe(mesh.parent);
      expect((mesh.geometry.getAttribute('position') as { array: unknown }).array).toBeNull();
    }
    // A block too small for a far level stays what it was, drawn at full detail.
    for (const mesh of chunks.filter((m) => !levelsOf(m)?.coarse)) expect(mesh.visible).toBe(true);
  });
});

describe('a block of several surfaces drawn alike (`roadSurfaces.ts` drawGroups)', () => {
  it('cuts back into each surface as its own block was, and joins again to the block', () => {
    const a = strip(), b = strip();
    const block = blockArraysOf([a, b], options.material)!;
    const [first, second] = splitBlock(block, [[a], [b]]);
    // Each piece the arrays its surface alone would have made: what its worker simplified when it was a block of its own.
    for (const piece of [first!, second!]) {
      const own = blockArraysOf([strip()], options.material)!;
      expect(Array.from(piece.position)).toEqual(Array.from(own.position));
      expect(Array.from(piece.index)).toEqual(Array.from(own.index));
      expect(piece.index.constructor).toBe(own.index.constructor);
    }
    const joined = joinBlocks([first!, second!]);
    for (const key of ['position', 'normal', 'uv', 'index'] as const) expect(Array.from(joined[key])).toEqual(Array.from(block[key]));
  });

  it('stays near while any of its surfaces would be near, and goes far once none is', () => {
    const block = mergeTiles([strip()], options, () => [strip()], {
      lock, near: true, also: [[5000, 0, 5200, 10]],
      start: (b, arrays) => { const made = coarseArrays(cloneBlock(arrays), lock); if (made) attachFarLevel(b, made, options, [{ source: () => [strip()], lock }], true); },
    })!;
    // The eye over the other surface's block: the first surface's is far from it, the block stays whole.
    updateRoadLevels([block], 5100, 5, 300);
    expect(levelsOf(block)!.full).toBe(true);
    updateRoadLevels([block], -5000, 0, 300);
    expect(levelsOf(block)!.full).toBe(false);
  });
});
