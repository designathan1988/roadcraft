import { describe, expect, it } from 'vitest';

import type { InstancedMesh, InterleavedBufferAttribute } from 'three';
import { type BuildingChunk, type PartBatch, assembleBuildingMeshes, emitChunk, shellPartFaces, withShellParts } from '@render/buildings/buildingMesh';
import type { ShellChunk } from '@render/buildings/chunk';
import {
  COLOUR_RANGE, FACADE_BYTES, FACADE_FLOATS, FACADE_GRID, FINISH_ATTRIBUTE, NORMAL_UNIT, PAINT_UNIT, cellArrays, cellBytes, paintShort,
} from '@render/buildings/cellArrays';
import { FACADE_FLIP, FACADE_STREAK } from '@render/buildings/facadeLevel';
import { shellUv } from '@render/buildings/shellParts';
import { PART_KINDS, type PartKind, createBuildingKit } from '@render/buildings/kit';
import { GROUND_ATTRIBUTE, LOOK_FLOATS, NO_GROUND, SHELL_PARTS, SHELL_PART_KINDS } from '@render/buildings/shellParts';
import { FINISHES } from '@world/buildings/materials';
import { growOnLot } from '@world/growth/zoning';
import type { Building } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { Network } from '@world/network';
import { m } from '@world/units';

/** THE FAR LEVEL (L1) IS THE SAME BUILDING: ITS WINDOWS WHERE THE DETAIL HAS ITS PANES, FAR FEWER TRIANGLES (`emitChunk` `far`) */
const groundAt = (x: number, y: number): number => x * 0.031 - y * 0.017 + Math.sin(x * 0.05) * m(0.4);

/** A small town grown on its lots, every use and density. */
function grownTown(): Building[] {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= 2; i++) { ids.push([]); for (let j = 0; j <= 2; j++) ids[i]!.push(doc.addNode({ x: m(120) * (i - 1), y: m(120) * (j - 1) }).id); }
  for (let i = 0; i <= 2; i++) {
    for (let j = 0; j <= 2; j++) {
      if (i < 2) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < 2) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  doc.lots.forEach((l, k) => zoneLots(doc, [l.id], { use: (['residential', 'commercial', 'industrial'] as const)[k % 3]!, density: (['low', 'medium', 'high'] as const)[(k >> 1) % 3]! }));
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  return [...doc.buildings.all()];
}

/** `buildingMesh.ts` `bayHash`, from the numbers the far level's shader reads (`facadeLevel.ts` `facadeBayHash`). */
function bayHash(volume: number, level: number, side: number, index: number, x: number, y: number): number {
  let h = Math.imul(volume + 1, 0x27d4eb2d) ^ Math.imul(level + 7, 0x165667b1) ^ Math.imul(side + 3, 0x3c6ef372) ^ Math.imul(index + 11, 0x85ebca6b);
  h ^= Math.imul(Math.round(x * 7), 0x2c1b3c6d) ^ Math.imul(Math.round(y * 7), 0x297a2d39);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

/** Every part a unit box: the batch's bounds only, not read here. */
const unitBoxes = { parts: Object.fromEntries(PART_KINDS.map((k) => [k, [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]])) as Record<PartKind, number[]>, furniture: {} };

/** A chunk's shell fragments, the far level's runs of bays with them. */
const fragments = (c: BuildingChunk): ShellChunk[] => [...Object.values(c.shells), ...Object.values(c.runs ?? {})];
const triangles = (c: BuildingChunk): number => fragments(c).reduce((n, s) => n + s.index.length / 3, 0);

/** What the far level shows at a pane of the detail: the window grid there, read as the shader reads it, or null where no wall of it lies. */
function farAt(far: BuildingChunk, px: number, py: number, pz: number, nx: number, nz: number): { inside: boolean; kind: number; dark: boolean } | null {
  let best: { inside: boolean; kind: number; dark: boolean } | null = null;
  let bestGap = Infinity;
  for (const s of Object.values(far.runs ?? {})) {
    const { position: p, normalDecay, index, facade, grid, opening } = s;
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t]!, b = index[t + 1]!, c = index[t + 2]!;
      // The face's normal as the GPU reads it.
      const wx = normalDecay[a * 4]! / NORMAL_UNIT, wy = normalDecay[a * 4 + 1]! / NORMAL_UNIT, wz = normalDecay[a * 4 + 2]! / NORMAL_UNIT;
      // A wall facing the pane's way, the pane at or a little behind it.
      if (wx * nx + wz * nz < 0.99 || Math.abs(wy) > 0.01) continue;
      const gap = (px - p[a * 3]!) * nx + (pz - p[a * 3 + 2]!) * nz;
      // A loggia's glazed wall stands a room's edge behind the facade.
      if (gap > 0.02 || gap < -1.6 || Math.abs(gap) >= bestGap) continue;
      // The pane's centre on the wall, by barycentric weights in the wall's plane (along it, up it).
      const qx = px - gap * nx, qz = pz - gap * nz;
      const ax = -nz, az = nx;
      const u = (i: number): number => p[i * 3]! * ax + p[i * 3 + 2]! * az;
      const h = (i: number): number => p[i * 3 + 1]!;
      const qu = qx * ax + qz * az, qh = py;
      const d = (u(b) - u(a)) * (h(c) - h(a)) - (u(c) - u(a)) * (h(b) - h(a));
      if (Math.abs(d) < 1e-9) continue;
      const wb = ((qu - u(a)) * (h(c) - h(a)) - (u(c) - u(a)) * (qh - h(a))) / d;
      const wc = ((u(b) - u(a)) * (qh - h(a)) - (qu - u(a)) * (h(b) - h(a))) / d;
      const wa = 1 - wb - wc;
      if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
      const at = (k: number): number => wa * grid[a * FACADE_GRID + k]! + wb * grid[b * FACADE_GRID + k]! + wc * grid[c * FACADE_GRID + k]!;
      const gu = at(0), gv = at(1), W = facade[a * FACADE_FLOATS]!;
      const raw = grid[a * FACADE_GRID + 2]!, kind = raw & (FACADE_FLIP - 1), key = grid[a * FACADE_GRID + 3]!;
      // The run's direction as the shader works it out: the face's own horizontal on the plan, turned round where flagged.
      const across = Math.hypot(wx, wz), turn = raw & FACADE_FLIP ? -1 : 1;
      const tx = (turn * wz) / across, ty = (turn * wx) / across;
      const o = [0, 1, 2, 3].map((k) => opening[a * FACADE_BYTES + k]! / 255);
      const fu = gu - Math.floor(gu), fv = gv - Math.floor(gv);
      const inside = kind > 0 && fu > o[0]! && fu < o[1]! && fv > o[2]! && fv < o[3]!;
      // The bay's centre on the plan, as the shader finds it.
      const bay = Math.floor(gu), level = Math.floor(gv);
      const cx = qx + tx * W * (bay + 0.5 - gu), cy = -qz + ty * W * (bay + 0.5 - gu);
      const hash = bayHash(Math.floor(key / 4), level, key % 4, bay, cx, cy);
      const dark = kind === 1 ? hash % 20 < 5 : kind === 3 ? hash % 4 === 0 : kind === 4 ? hash % 5 === 0 : false;
      best = { inside, kind, dark };
      bestGap = Math.abs(gap);
    }
  }
  return best;
}

describe('the buildings\' far level', () => {
  const town = grownTown();

  it('is the same building with what stands out of its walls, its openings drawn, far fewer triangles', () => {
    expect(town.length).toBeGreaterThan(20);
    let near = 0, far = 0;
    for (const b of town) {
      const detail = emitChunk(b, groundAt);
      const l1 = emitChunk(b, groundAt, undefined, groundAt, undefined, true);
      // Balconies, awnings, canopies and shutters' leaves stand out of the wall: the far level keeps every one.
      for (const kind of ['railing', 'awning', 'louvre', 'brise', 'glassRail', 'column'] as const) expect(l1.parts[kind].count).toBe(detail.parts[kind].count);
      // What is set into a flattened opening is drawn by the shader.
      for (const kind of ['glass', 'glassDark', 'frame', 'door', 'shutter'] as const) expect(l1.parts[kind].count).toBeLessThanOrEqual(detail.parts[kind].count);
      // Every vertex of a run of bays with openings has its window grid; no other face pays for one, and the detail has none.
      for (const s of Object.values(l1.runs ?? {})) {
        expect(s.facade.length).toBe((s.position.length / 3) * FACADE_FLOATS);
        expect(s.grid.length).toBe((s.position.length / 3) * FACADE_GRID);
        expect(s.opening.length).toBe((s.position.length / 3) * FACADE_BYTES);
        for (let i = 2; i < s.grid.length; i += FACADE_GRID) expect(s.grid[i]! & (FACADE_FLIP - 1)).toBeGreaterThan(0);
      }
      for (const s of [...Object.values(l1.shells), ...Object.values(detail.shells)]) expect('facade' in s).toBe(false);
      expect(detail.runs).toBeUndefined();
      near += triangles(detail);
      far += triangles(l1);
    }
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(near * 0.9);
  });

  it('marks the rain streak under its sills on its runs, for the shader to draw, and lays no streak of its own', () => {
    let streaked = 0;
    for (const b of town) {
      const l1 = emitChunk(b, groundAt, undefined, groundAt, undefined, true);
      for (const s of Object.values(l1.runs ?? {})) {
        for (let i = 2; i < s.grid.length; i += FACADE_GRID) {
          const raw = s.grid[i]!, streak = Math.floor(raw / FACADE_STREAK), kind = raw & (FACADE_FLIP - 1);
          if (streak === 0) continue;
          streaked++;
          // Only an opening with a sill takes one: a window, a sash or wide one, a shuttered one, a french, bay or ribbon window.
          expect([1, 2]).toContain(streak);
          expect([1, 2, 3, 4]).toContain(kind);
        }
      }
      // What is under its error is left out: a mast, the drains, the posts.
      const detail = emitChunk(b, groundAt);
      expect(triangles(l1)).toBeLessThan(triangles(detail));
    }
    expect(streaked).toBeGreaterThan(0);
  });

  it('draws its windows where the detail has its panes, dark where the detail\'s are', () => {
    let panes = 0, found = 0, picked = 0, same = 0;
    for (const b of town) {
      const detail = emitChunk(b, groundAt);
      const l1 = emitChunk(b, groundAt, undefined, groundAt, undefined, true);
      for (const kind of ['glass', 'glassDark'] as const) {
        const batch = detail.parts[kind];
        for (let i = 0; i < batch.count; i++) {
          const mtx = batch.matrices.subarray(i * 16, i * 16 + 16);
          const len = Math.hypot(mtx[8]!, mtx[10]!);
          // A pane's own +Z is its wall's outward normal; panes not standing (none) are left out.
          if (len < 1e-6 || Math.abs(mtx[9]!) > 1e-6) continue;
          panes++;
          const at = farAt(l1, mtx[12]!, mtx[13]!, mtx[14]!, mtx[8]! / len, mtx[10]! / len);
          if (!at?.inside) continue;
          found++;
          // The glass of a window bay: its darker pane picked as emitBay picks it.
          if (at.kind === 1 || at.kind === 3 || at.kind === 4) {
            picked++;
            if (at.dark === (kind === 'glassDark')) same++;
          }
        }
      }
    }
    expect(panes).toBeGreaterThan(100);
    // Panes of doors' fanlights and entrances kept as geometry are the few not in a drawn opening.
    expect(found / panes).toBeGreaterThan(0.9);
    expect(picked).toBeGreaterThan(50);
    expect(same / picked).toBeGreaterThan(0.99);
  });

  it('puts a cell\'s far level together as a plain piece and a piece of runs with their window grid, every finish', () => {
    const chunks = town.slice(0, 6).map((b) => emitChunk(b, groundAt, undefined, groundAt, undefined, true));
    const cell = cellArrays(chunks, { parts: PART_KINDS, shells: true, furniture: false, ghost: false, dim: false }, unitBoxes);
    const plain = cell.shells.filter((s) => !s.facade), runs = cell.shells.filter((s) => s.facade);
    expect(plain.length).toBeGreaterThan(0);
    expect(runs.length).toBeGreaterThan(0);
    for (const s of runs) {
      const vertices = s.position.length / 3;
      expect(s.facade!.length).toBe(vertices * FACADE_FLOATS);
      expect(s.grid!.length).toBe(vertices * FACADE_GRID);
      expect(s.opening!.length).toBe(vertices * FACADE_BYTES);
      expect(s.paint.length).toBe(vertices * 4);
    }
    for (const s of plain) expect(s.grid).toBeUndefined();
    let made = 0, ran = 0;
    for (const c of chunks) {
      for (const part of Object.values(c.shells)) made += part.position.length / 3;
      for (const part of Object.values(c.runs ?? {})) ran += part.position.length / 3;
    }
    const count = (list: typeof plain): number => list.reduce((n, s) => n + s.position.length / 3, 0);
    expect(count(runs)).toBe(ran);
    expect(count(plain)).toBe(made);
    // The runs are a few quads a facade: most of the far level pays no window grid.
    expect(ran).toBeLessThan(made);
  });
});

/** A shell triangle as drawn: its finish, centroid, normal, mean colour, mean uv and wear (three's axes). */
interface Tri { finish: string; c: number[]; n: number[]; rgb: number[]; uv: number[]; decay: number }

function trianglesOf(c: BuildingChunk): Tri[] {
  const out: Tri[] = [];
  for (const [finish, s] of [...Object.entries(c.shells), ...Object.entries(c.runs ?? {})]) {
    const { position: p, normalDecay: nd, paint, index } = s;
    for (let t = 0; t < index.length; t += 3) {
      const v = [index[t]!, index[t + 1]!, index[t + 2]!];
      const mean = (a: ArrayLike<number>, size: number, k: number, unit = 1): number => v.reduce((sum, i) => sum + a[i * size + k]!, 0) / 3 * unit;
      // The uv as the shader works it out from each vertex's place and normal (`shellUv`).
      const uvs = v.map((i) => shellUv(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!, nd[i * 4]! / NORMAL_UNIT, nd[i * 4 + 1]! / NORMAL_UNIT, nd[i * 4 + 2]! / NORMAL_UNIT));
      out.push({
        finish, c: [0, 1, 2].map((k) => mean(p, 3, k)), n: [0, 1, 2].map((k) => nd[v[0]! * 4 + k]! / NORMAL_UNIT),
        rgb: [0, 1, 2].map((k) => mean(paint, 4, k, COLOUR_RANGE / PAINT_UNIT)),
        uv: [0, 1].map((k) => uvs.reduce((sum, u) => sum + u[k]!, 0) / 3), decay: mean(nd, 4, 3, 1 / NORMAL_UNIT),
      });
    }
  }
  return out;
}

/** The triangles of `a` found in `b`: the same finish within a millimetre, the same normal, colour, uv and wear (the wear as a byte carries it to the GPU). */
function unmatched(a: readonly Tri[], b: readonly Tri[]): Tri[] {
  const CELL = 0.01;
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  const grid = new Map<string, Tri[]>();
  for (const t of b) {
    const k = key(Math.floor(t.c[0]! / CELL), Math.floor(t.c[1]! / CELL), Math.floor(t.c[2]! / CELL));
    const list = grid.get(k);
    if (list) list.push(t); else grid.set(k, [t]);
  }
  const close = (x: readonly number[], y: readonly number[], eps: number): boolean => x.every((v, i) => Math.abs(v - y[i]!) <= eps);
  const out: Tri[] = [];
  for (const t of a) {
    const [i, j, k] = t.c.map((x) => Math.floor(x / CELL)) as [number, number, number];
    let found = false;
    for (let di = -1; di <= 1 && !found; di++) for (let dj = -1; dj <= 1 && !found; dj++) for (let dk = -1; dk <= 1 && !found; dk++) {
      const list = grid.get(key(i + di, j + dj, k + dk));
      if (!list) continue;
      const at = list.findIndex((u) => u.finish === t.finish && close(u.c, t.c, m(0.001)) && close(u.n, t.n, 1e-4) && close(u.rgb, t.rgb, 2e-3)
        && close(u.uv, t.uv, 2e-3) && Math.abs(u.decay - t.decay) <= 1 / 65534 + 1e-6);
      if (at < 0) continue;
      list.splice(at, 1);
      found = true;
    }
    if (!found) out.push(t);
  }
  return out;
}

const shellTriangles = triangles;

describe('the lots\' boxes, the shell\'s parts', () => {
  const town = grownTown();

  it('are instances of the shell\'s parts, every face the shell laid for them laid again from the instance alone, the shell far lighter', () => {
    for (const far of [false, true]) {
      let before = 0, after = 0, boxes = 0, others = 0, checked = 0;
      for (const b of town) {
        const was = emitChunk(b, groundAt, undefined, groundAt, undefined, far, false);
        const now = emitChunk(b, groundAt, undefined, groundAt, undefined, far);
        // Laid in the shell, none; every other part the same.
        for (const kind of PART_KINDS) {
          if (SHELL_PARTS.has(kind)) expect(was.parts[kind].count).toBe(0);
          else expect(now.parts[kind].count, kind).toBe(was.parts[kind].count);
        }
        boxes += now.parts.lotBox.count;
        others += now.parts.lotRail.count + now.parts.lotSlab.count;
        before += shellTriangles(was);
        after += shellTriangles(now);
        if (checked >= 30 || SHELL_PART_KINDS.every((k) => now.parts[k].count === 0)) continue;
        checked++;
        // The shell as it was is the shell now with its parts laid in it again: the same triangles, place, colour, finish, uv and wear.
        const laid = withShellParts(now);
        expect(shellTriangles(laid), `building ${b.id}`).toBe(shellTriangles(was));
        const old = trianglesOf(was), again = trianglesOf(laid);
        expect(unmatched(old, again).slice(0, 5), `building ${b.id} ${far ? 'L1' : 'L0'}`).toEqual([]);
        expect(unmatched(again, old).slice(0, 5), `building ${b.id} ${far ? 'L1' : 'L0'}`).toEqual([]);
      }
      expect(boxes).toBeGreaterThan(0);
      expect(others).toBeGreaterThan(0);
      expect(checked).toBeGreaterThan(10);
      // The lots' gates, bins, lamps, fences and element boxes were about half the shells (measured 2026-10-16).
      expect(after, far ? 'L1' : 'L0').toBeLessThan(before * (far ? 0.6 : 0.75));
    }
  });

  it('stand square to their building, their looks a finish id, a wear and a ground each', () => {
    for (const b of town) {
      const chunk = emitChunk(b, groundAt);
      for (const kind of ['lotBox', 'lotSlab'] as const) {
        const batch = chunk.parts[kind];
        expect(batch.looks!.length).toBe(batch.count * LOOK_FLOATS);
        expect(batch.colours!.length).toBe(batch.count * 3);
        for (let i = 0; i < batch.count; i++) {
          const e = batch.matrices.subarray(i * 16, i * 16 + 16);
          // T * Ry * S: the yaw the building's own turn.
          const turn = Math.atan2(-e[2]!, e[0]!) - b.rotation;
          expect(Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)))).toBeLessThan(1e-5);
          const finish = batch.looks![i * LOOK_FLOATS]!;
          expect(Number.isInteger(finish) && finish >= 0 && finish < FINISHES.length).toBe(true);
        }
      }
    }
  });

  it('are drawn by the shell\'s material instanced, reading their looks per instance, faded with the shell', () => {
    const kit = createBuildingKit();
    const chunks = town.map((b) => emitChunk(b, groundAt));
    for (const dim of [false, true]) {
      const meshes = assembleBuildingMeshes(chunks, kit, false, dim);
      const box = meshes.group.children.find((o) => o.name === 'building-lotBox') as InstancedMesh | undefined;
      expect(box).toBeDefined();
      expect(box!.material).toBe(dim ? kit.dimShell : kit.shellMaterial);
      expect(box!.count).toBe(chunks.reduce((n, c) => n + c.parts.lotBox.count, 0));
      for (const name of [FINISH_ATTRIBUTE, 'aDecay', GROUND_ATTRIBUTE]) {
        const a = box!.geometry.getAttribute(name) as InterleavedBufferAttribute;
        expect((a.data as unknown as { isInstancedInterleavedBuffer?: boolean }).isInstancedInterleavedBuffer, name).toBe(true);
      }
      // Its own copy of the model: the kit's stays as it is.
      expect(box!.geometry).not.toBe(kit.geometry.lotBox);
      expect(kit.geometry.lotBox.getAttribute(FINISH_ATTRIBUTE)).toBeUndefined();
      meshes.dispose();
    }
    kit.dispose();
  });
});

/** `SHELL_UV_GLSL` as the GPU runs it: every operation rounded to a 32-bit float, from the place and the normal it reads. */
function glslUv(px: number, py: number, pz: number, nx: number, ny: number, nz: number): [number, number] {
  const f = Math.fround;
  const l = f(Math.sqrt(f(f(f(nx * nx) + f(ny * ny)) + f(nz * nz))));
  const ox = f(nx / l), oy = f(ny / l), oz = f(nz / l);
  const p0 = f(px), p1 = f(-pz), p2 = f(py), n0 = ox, n1 = f(-oz), n2 = oy;
  const across = f(Math.sqrt(f(f(n0 * n0) + f(n1 * n1))));
  const t0 = across > 1e-6 ? f(-n1 / across) : 1, t1 = across > 1e-6 ? f(n0 / across) : 0;
  const b0 = f(-n2 * t1), b1 = f(n2 * t0), b2 = f(f(n0 * t1) - f(n1 * t0));
  return [f(f(p0 * t0) + f(p1 * t1)), f(f(f(p0 * b0) + f(p1 * b1)) + f(p2 * b2))];
}

describe('the shell\'s compact vertex', () => {
  // A sample of the town: every kind of face, within a test's 10 s.
  const town = grownTown().slice(0, 24);
  const take = { parts: [] as PartKind[], shells: true, furniture: false, ghost: false, dim: false };

  it('gets from the shader the planar uv `Shell.face` laid: the same orientation and scale on every face, a phase under float error', () => {
    let checked = 0, offPlane = 0;
    for (const far of [false, true]) {
      const chunks = town.map((b) => emitChunk(b, groundAt, undefined, groundAt, undefined, far));
      for (const { position: p, normalDecay: nd, index } of cellArrays(chunks, take, unitBoxes).shells) for (let t = 0; t < index.length; t += 3) {
        const v = [index[t]!, index[t + 1]!, index[t + 2]!];
        const at = (i: number): number[] => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
        const [a, b, c] = v.map(at) as [number[], number[], number[]];
        const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
        const g = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
        const area = Math.hypot(g[0]!, g[1]!, g[2]!) / 2;
        const edge = Math.max(Math.hypot(u[0]!, u[1]!, u[2]!), Math.hypot(w[0]!, w[1]!, w[2]!));
        // Its plane's own normal, the reference `Shell.face` laid the uv by; thin slivers read it too roughly from 32-bit corners.
        if (area < 0.02 || edge < 0.2) continue;
        const n = [nd[v[0]! * 4]! / NORMAL_UNIT, nd[v[0]! * 4 + 1]! / NORMAL_UNIT, nd[v[0]! * 4 + 2]! / NORMAL_UNIT];
        const len = Math.hypot(g[0]!, g[1]!, g[2]!), sign = g[0]! * n[0]! + g[1]! * n[1]! + g[2]! * n[2]! < 0 ? -1 : 1;
        const exact = g.map((x) => (x / len) * sign);
        if (Math.hypot(exact[0]! - n[0]!, exact[1]! - n[1]!, exact[2]! - n[2]!) > 1e-3) { offPlane++; continue; }
        checked++;
        const diffs = v.map((i) => {
          const [x, y, z] = at(i) as [number, number, number];
          const was = shellUv(x, y, z, exact[0]!, exact[1]!, exact[2]!);
          const now = glslUv(x, y, z, n[0]!, n[1]!, n[2]!);
          const phase = Math.hypot(x, y, z) * 1e-4 + 1e-3;
          expect(Math.abs(now[0] - was[0]), `uv u at ${x}, ${y}, ${z}`).toBeLessThan(phase);
          expect(Math.abs(now[1] - was[1]), `uv v at ${x}, ${y}, ${z}`).toBeLessThan(phase);
          return [now[0] - was[0], now[1] - was[1]] as const;
        });
        // Across the face the difference is one constant: the texture neither turned nor stretched.
        for (const d of diffs) {
          expect(Math.abs(d[0] - diffs[0]![0])).toBeLessThan(2e-4 * edge + 1e-4);
          expect(Math.abs(d[1] - diffs[0]![1])).toBeLessThan(2e-4 * edge + 1e-4);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    // A face laid with a normal off its plane (a softened roof, a turned sliver) took its uv from that normal before as now: the shader reads it in 16 bits.
    expect(offPlane).toBeGreaterThanOrEqual(0);
  });

  it('holds its paint in 16 bits a channel, none past the range, and its finish id whole', () => {
    for (const x of [0, 1e-4, 3e-4, 0.0123, 0.2, 0.5, 0.97, 1, 1.19]) {
      expect(Math.abs((paintShort(x) * COLOUR_RANGE) / PAINT_UNIT - Math.fround(x))).toBeLessThanOrEqual(COLOUR_RANGE / PAINT_UNIT / 2 + 1e-9);
    }
    for (const s of cellArrays(town.map((b) => emitChunk(b, groundAt)), take, unitBoxes).shells) {
      for (let i = 0; i < s.paint.length; i += 4) {
        for (let k = 0; k < 3; k++) expect(s.paint[i + k]!).toBeLessThan(PAINT_UNIT);
        expect(s.paint[i + 3]!).toBeLessThan(FINISHES.length);
      }
    }
  });

  it('is 28 bytes, 52 only on the far level\'s runs of bays with openings (37 and 77 before)', () => {
    for (const far of [false, true]) {
      const s = cellArrays(town.map((b) => emitChunk(b, groundAt, undefined, groundAt, undefined, far)), take, unitBoxes);
      if (far) expect(s.shells.some((p) => p.facade)).toBe(true);
      for (const piece of s.shells) {
        const one = { shells: [piece], parts: {}, furniture: {} };
        expect((cellBytes(one) - piece.index.byteLength) / (piece.position.length / 3)).toBe(piece.facade ? 52 : 28);
      }
    }
  });

  it('shares a vertex between faces alike in every number: a wall\'s pieces round its windows meet in one', () => {
    let wallTriangles = 0, wallVertices = 0;
    for (const b of town) {
      for (const s of fragments(emitChunk(b, groundAt))) {
        const { position: p, normalDecay: nd, paint, index } = s;
        const vertices = p.length / 3;
        // None left twice: the weld found every vertex alike in place, normal, wear, paint and finish.
        const seen = new Set<string>();
        for (let v = 0; v < vertices; v++) {
          seen.add([...p.subarray(v * 3, v * 3 + 3), ...nd.subarray(v * 4, v * 4 + 4), ...paint.subarray(v * 4, v * 4 + 4)].join());
        }
        expect(seen.size).toBe(vertices);
        // The walls (normal level): their triangles and the vertices they use.
        const used = new Set<number>();
        for (let t = 0; t < index.length; t += 3) {
          for (let k = 0; k < 3; k++) expect(index[t + k]!).toBeLessThan(vertices);
          if (Math.abs(nd[index[t]! * 4 + 1]!) > NORMAL_UNIT * 0.01) continue;
          wallTriangles++;
          for (let k = 0; k < 3; k++) used.add(index[t + k]!);
        }
        wallVertices += used.size;
      }
    }
    expect(wallTriangles).toBeGreaterThan(1000);
    // A loose quad takes 4 vertices for its 2 triangles; welded, a wall cut round its windows shares its corners.
    expect(wallVertices / wallTriangles).toBeLessThan(1.8);
  });

  it('welds two boxes side by side where their faces meet alike, never across faces turned another way', () => {
    const none: PartBatch = { matrices: new Float32Array(0), colours: null, count: 0 };
    const parts = Object.fromEntries(PART_KINDS.map((k) => [k, none])) as Record<PartKind, PartBatch>;
    // Two unit boxes on the ground, the second one metre along x: they touch at x = 1.
    const matrices = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0.5, 0.5, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1.5, 0.5, 0.5, 1);
    const id = FINISHES.indexOf('plaster');
    parts.lotBox = { matrices, colours: Float32Array.of(0.6, 0.5, 0.4, 0.6, 0.5, 0.4), count: 2, looks: Float32Array.of(id, 0, NO_GROUND, id, 0, NO_GROUND) };
    const laid = shellPartFaces(parts).plaster!;
    // Five faces of four corners each (no bottom); the fronts, backs and tops of the two share their edge at x = 1, the end faces there face apart.
    expect(laid.index.length / 3).toBe(2 * 5 * 2);
    expect(laid.position.length / 3).toBe(2 * 5 * 4 - 3 * 2);
  });
});
