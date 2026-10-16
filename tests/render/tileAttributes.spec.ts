import { MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { meshTileShape } from '@render/mesh/tileMesh';
import { mergeTiles } from '@render/mesh/surfaceTiles';
import { marksRoadSection } from '@render/mesh/roadEdges';
import type { SurfaceShape } from '@render/mesh/tileShape';

/** A ROAD STRIP CARRIES ONLY WHAT ITS SURFACE WRITES (`tileMesh.ts` meshPiece): no colour without a tint, no section without one; a material that reads them gets the one value they would have had */

/** Two triangles side by side and a skirt along one edge. */
const shape: SurfaceShape = {
  pieces: [{ xy: Float64Array.from([0, 0, 4, 0, 4, 4, 0, 4]), tris: Uint32Array.from([0, 1, 2, 0, 2, 3]), flip: false }],
  skirts: [{ flip: false, edges: Float64Array.from([0, 0, 4, 0]) }],
};
const base = { top: (): number => 1, bottom: (): number => 0, uv: (x: number, y: number, out: [number, number]): void => { out[0] = x; out[1] = y; } };

describe('a road strip and its attributes', () => {
  it('carries no colour or section without a tint or a section, and a block reading them gets white and no section', () => {
    const plain = meshTileShape(shape, base);
    expect(plain.colors).toHaveLength(0);
    expect(plain.sections).toHaveLength(0);
    const reading = new MeshBasicMaterial({ vertexColors: true });
    marksRoadSection(reading);
    const block = mergeTiles([plain], { name: 'kerb', material: reading }, () => [plain])!;
    const color = block.geometry.getAttribute('color').array as Float32Array;
    const section = block.geometry.getAttribute('roadSection').array as Float32Array;
    expect(color.length).toBe(plain.positions.length);
    expect([...color].every((c) => c === 1)).toBe(true);
    for (let i = 0; i < section.length; i += 3) expect([section[i], section[i + 1], section[i + 2]]).toEqual([0, -1, 0]);
    // A block whose material reads neither has neither.
    const bare = mergeTiles([plain], { name: 'kerb', material: new MeshBasicMaterial() }, () => [plain])!;
    expect(bare.geometry.getAttribute('color')).toBeUndefined();
    expect(bare.geometry.getAttribute('roadSection')).toBeUndefined();
  });

  it('carries what a tint and a section write, on every vertex, skirts included', () => {
    const painted = meshTileShape(shape, {
      ...base,
      tint: (x: number, _y: number, out: [number, number, number]): void => { out[0] = x / 4; out[1] = 0.5; out[2] = 1; },
      section: (_x: number, y: number, out: [number, number, number]): void => { out[0] = 1; out[1] = y; out[2] = 0; },
    });
    const vertices = painted.positions.length / 3;
    expect(painted.colors).toHaveLength(vertices * 3);
    expect(painted.sections).toHaveLength(vertices * 3);
  });
});
