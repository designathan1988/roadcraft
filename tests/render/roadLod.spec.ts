import { readFileSync } from 'node:fs';
import { MeshBasicMaterial, type BufferAttribute, type Mesh } from 'three';
import { describe, expect, it } from 'vitest';

import { COARSE_ERROR } from '@render/mesh/roadLod';
import { FAR_MARGIN, makeFar, makeNear, updateRoadLevels } from '@render/mesh/roadResidency';
import { mergeTiles } from '@render/mesh/surfaceTiles';
import type { Tile } from '@render/mesh/tileMesh';

/**
 * THE FAR LEVEL OF A BLOCK OF ROAD (`mesh/roadLod.ts`, `mesh/roadResidency.ts`): a block near the camera is
 * its own mesh, one far is a simplified one and gives its own buffers back; the block's outer edge does not
 * move, so two blocks of different level meet without a crack; and a block that comes near has its arrays
 * made again. The road surfaces were 1.04 GB of a 2,560 m city's 1.56 GB of geometry, every block at full
 * detail wherever the camera was (2026-10-15).
 */
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
const make = (near: boolean): Mesh => mergeTiles([strip()], options, () => [strip()], { lock, near })!;
const levels = (mesh: Mesh): { coarse: Mesh; full: boolean } => mesh.userData.lod as { coarse: Mesh; full: boolean };
const trianglesOf = (mesh: Mesh): number => (mesh.geometry.index?.count ?? 0) / 3;

describe('a block of road with a far level', () => {
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
  });
});
