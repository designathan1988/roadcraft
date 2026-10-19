import { poseMatrices } from '@render/buildings/partPose';
import { describe, expect, it } from 'vitest';
import { Box3, BufferAttribute, BufferGeometry, DataUtils, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial, Sphere } from 'three';

import { emitChunk, kitBoxes } from '@render/buildings/buildingMesh';
import { SHELL_GRID_STEP, SHELL_PIECE, cellArrays } from '@render/buildings/cellArrays';
import { PART_KINDS, createBuildingKit } from '@render/buildings/kit';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';

/** A BATCH'S BOUNDS WORKED OUT WITH ITS ARRAYS ARE THREE'S (`cellArrays.ts`) */
const groundAt = (x: number, y: number): number => x * 0.02 - y * 0.01;

describe('a batch as arrays', () => {
  const kit = createBuildingKit();
  const chunks = BLUEPRINTS.map((bp, i) => emitChunk({ ...JSON.parse(JSON.stringify(bp.body)), id: i + 1, x: (i % 7) * m(70), y: Math.floor(i / 7) * m(70), rotation: 0.3 * i } as Building, groundAt));
  const arrays = cellArrays(chunks, { parts: PART_KINDS, shells: true, furniture: true, ghost: false, dim: false }, kitBoxes(kit));

  it("holds each instance's tint in half floats, 6 bytes, the chunks' tints to a part in a thousand", () => {
    let tinted = 0;
    for (const kind of PART_KINDS) {
      const part = arrays.parts[kind];
      if (!part?.instanceColor) continue;
      expect(part.instanceColor, kind).toBeInstanceOf(Uint16Array);
      expect(part.instanceColor.byteLength).toBe(part.count * 6);
      let at = 0;
      for (const chunk of chunks) {
        const batch = chunk.parts[kind];
        for (let k = 0; k < batch.count * 3; k++) {
          const was = batch.colours ? batch.colours[k]! : 1;
          expect(Math.abs(DataUtils.fromHalfFloat(part.instanceColor[at * 3 + k]!) - was)).toBeLessThanOrEqual(Math.max(was, 1e-3) / 1000);
        }
        at += batch.count;
      }
      tinted++;
    }
    expect(tinted).toBeGreaterThan(3);
  });

  it("has three's bounds for its shell", () => {
    expect(arrays.shells.length).toBeGreaterThan(0);
    for (const shell of arrays.shells) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(shell.position, 3));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      const b = shell.bounds;
      expect([...b.slice(0, 6)]).toEqual([g.boundingBox!.min.x, g.boundingBox!.min.y, g.boundingBox!.min.z, g.boundingBox!.max.x, g.boundingBox!.max.y, g.boundingBox!.max.z]);
      expect([...b.slice(6)]).toEqual([g.boundingSphere!.center.x, g.boundingSphere!.center.y, g.boundingSphere!.center.z, g.boundingSphere!.radius]);
    }
  });

  it('pieces its shell by detail cell when given one for each chunk: no piece holds two cells, every triangle kept', () => {
    // The chunks laid 70 m apart: a 64 m detail cell by column and row.
    const groups = chunks.map((_c, i) => `${Math.floor(((i % 7) * m(70)) / m(64))},${Math.floor((Math.floor(i / 7) * m(70)) / m(64))}`);
    const take = { parts: [], shells: true, furniture: false, ghost: false, dim: false } as const;
    const whole = cellArrays(chunks, take, kitBoxes(kit)).shells;
    const pieced = cellArrays(chunks, take, kitBoxes(kit), groups).shells;
    const cells = new Set(groups);
    expect(pieced.length).toBeGreaterThanOrEqual(cells.size);
    expect(pieced.length).toBeGreaterThan(whole.length);
    const tris = (list: typeof whole): number => list.reduce((n, p) => n + p.index.length / 3, 0);
    expect(tris(pieced)).toBe(tris(whole));
    // Each piece's box no wider than a few buildings of one cell: far under the whole batch's.
    const span = (p: (typeof whole)[number]): number => Math.max(p.bounds[3]! - p.bounds[0]!, p.bounds[5]! - p.bounds[2]!);
    const widest = Math.max(...whole.map(span));
    for (const p of pieced) expect(span(p)).toBeLessThan(widest);
    // The panes pieced the same way: each detail cell's run, every pane once, each run's box inside the batch's.
    const glassTake = { parts: ['glass'] as const, shells: false, furniture: false, ghost: false, dim: false };
    const glass = cellArrays(chunks, { ...glassTake, parts: [...glassTake.parts] }, kitBoxes(kit), groups).parts.glass!;
    expect(glass.pieces!.length).toBeGreaterThan(1);
    let next = 0;
    for (const p of glass.pieces!) {
      expect(p.start).toBe(next);
      next += p.count;
      for (let k = 0; k < 3; k++) expect(p.bounds[k]!).toBeGreaterThanOrEqual(glass.bounds[k]! - 1e-6);
      for (let k = 3; k < 6; k++) expect(p.bounds[k]!).toBeLessThanOrEqual(glass.bounds[k]! + 1e-6);
    }
    expect(next).toBe(glass.count);
    const plain = cellArrays(chunks, { ...glassTake, parts: [...glassTake.parts] }, kitBoxes(kit)).parts.glass!;
    expect(plain.pieces).toBeUndefined();
    // The same panes, in another order: every pose of one is a pose of the other.
    const posesOf = (a: Float32Array): string[] => Array.from({ length: a.length / 8 }, (_v, i) => Array.from(a.subarray(i * 8, i * 8 + 8)).join()).sort();
    expect(posesOf(glass.poses)).toEqual(posesOf(plain.poses));
    // The same chunks and groups make the same pieces (the lost context's refill).
    const again = cellArrays(chunks, take, kitBoxes(kit), groups).shells;
    expect(again.map((p) => p.index.length)).toEqual(pieced.map((p) => p.index.length));
  });

  it('cuts its shell into pieces of whole buildings with 16-bit indices, every triangle kept', () => {
    const verticesOf = (list: typeof chunks): number => list.reduce((n, c) => n + Object.values(c.shells).reduce((k, s) => k + s.position.length / 3, 0), 0);
    // Enough buildings to pass two pieces' vertices.
    const many = Array.from({ length: Math.ceil((SHELL_PIECE * 2) / verticesOf(chunks)) + 1 }, () => chunks).flat();
    const made = verticesOf(many);
    const triangles = many.reduce((n, c) => n + Object.values(c.shells).reduce((k, s) => k + s.index.length / 3, 0), 0);
    expect(made).toBeGreaterThan(SHELL_PIECE * 2);
    const pieces = cellArrays(many, { parts: [], shells: true, furniture: false, ghost: false, dim: false }, kitBoxes(kit)).shells;
    expect(pieces.length).toBeGreaterThan(1);
    let vertices = 0, drawn = 0;
    for (const piece of pieces) {
      const n = piece.position.length / 3;
      vertices += n;
      drawn += piece.index.length / 3;
      // No building larger than a piece here: each piece's indices 16 bits, the primitive restart index never among them.
      expect(n).toBeLessThanOrEqual(SHELL_PIECE);
      expect(piece.index).toBeInstanceOf(Uint16Array);
      let most = 0;
      for (const i of piece.index) most = Math.max(most, i);
      expect(most).toBeLessThan(Math.min(n, 0xffff));
    }
    expect(vertices).toBe(made);
    expect(drawn).toBe(triangles);
  });

  it("has three's bounds for every instanced batch", () => {
    const parts = Object.entries(arrays.parts);
    expect(parts.length).toBeGreaterThan(5);
    for (const [kind, part] of parts) {
      const mesh = new InstancedMesh(kit.geometry[kind as keyof typeof kit.geometry], new MeshBasicMaterial(), part!.count);
      // The matrices the GPU makes from the poses (`partPose.ts`).
      mesh.instanceMatrix = new InstancedBufferAttribute(poseMatrices(part!.poses, part!.count), 16);
      mesh.computeBoundingBox();
      const box = mesh.boundingBox!;
      const sphere = box.getBoundingSphere(new Sphere());
      const b = part!.bounds;
      expect([...b.slice(0, 6)], kind).toEqual([box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]);
      expect([...b.slice(6)], kind).toEqual([sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius]);
      expect(new Box3().copy(box).isEmpty()).toBe(false);
    }
  });
});

describe("the far level's shells on their cell's grid", () => {
  it('put every point within half a step of its float, a point shared by two pieces the same point, in 8 bytes for 12', () => {
    const kit = createBuildingKit();
    // A row of blocks side by side, back to back on their lot lines: corners shared between buildings, at the far level.
    // Eight rows of eight, more points than one piece holds (`SHELL_PIECE`): corners shared across pieces too.
    const row = Array.from({ length: 64 }, (_, i) => ({ ...JSON.parse(JSON.stringify(BLUEPRINTS[3]!.body)), id: i + 1, x: 10 + (i % 8) * 18, y: 20 + Math.floor(i / 8) * 12, rotation: 0 }) as Building);
    const chunks = row.map((b) => emitChunk(b, groundAt, undefined, groundAt, undefined, true));
    const take = { parts: [], shells: true, furniture: false, ghost: false, dim: false } as const;
    const floats = cellArrays(chunks, take, kitBoxes(kit)).shells;
    const grid = cellArrays(chunks, { ...take, grid: [0, 0] }, kitBoxes(kit)).shells;
    expect(grid.length).toBe(floats.length);
    expect(grid.length).toBeGreaterThan(1);
    let shared = 0;
    const pointAt = new Map<string, string>(), pieceOf = new Map<string, number>();
    let acrossPieces = 0;
    grid.forEach((piece, k) => {
      const place = piece.place!;
      expect(place.step).toBe(SHELL_GRID_STEP);
      expect(piece.position).toBeInstanceOf(Uint16Array);
      const f = floats[k]!.position as Float32Array, q = piece.position as Uint16Array;
      expect(q.byteLength / (f.length / 3)).toBe(8);
      const span = place.step * 65535;
      for (let v = 0; v < f.length / 3; v++) {
        // As the GPU reads it: normalised, then the mesh's matrix (scale, then origin), in floats.
        const at = [place.x, place.y, place.z].map((o, c) => Math.fround(Math.fround(Math.fround(q[v * 4 + c]! / 65535) * Math.fround(span)) + Math.fround(o)));
        for (let c = 0; c < 3; c++) expect(Math.abs(at[c]! - f[v * 3 + c]!)).toBeLessThanOrEqual(SHELL_GRID_STEP / 2 + 1e-4);
        // A point laid twice (a corner of two blocks, of two buildings) is one point of the grid, bit for bit.
        const key = [f[v * 3], f[v * 3 + 1], f[v * 3 + 2]].join(), got = at.join();
        const was = pointAt.get(key);
        if (was !== undefined) { expect(got).toBe(was); shared++; if (pieceOf.get(key) !== k) acrossPieces++; } else { pointAt.set(key, got); pieceOf.set(key, k); }
      }
    });
    expect(shared).toBeGreaterThan(100);
    // And across pieces: a point of one piece laid again in another, the same point.
    expect(acrossPieces).toBeGreaterThan(0);
    kit.dispose();
  });
});
