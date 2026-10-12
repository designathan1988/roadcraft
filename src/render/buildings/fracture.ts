import {
  BufferAttribute,
  BufferGeometry,
  Matrix3,
  Matrix4,
  Sphere,
  Vector3,
  type Material,
} from 'three';

import type { Finish } from '@world/buildings/materials';
import { m } from '@world/units';
import type { BuildingChunk } from './buildingMesh';
import type { BuildingKit, PartKind } from './kit';

/**
 * Pre-fracturing a building's own meshes (Voronoi fracture, as destructible
 * objects are prepared in games: Grönberg, "Real-time Mesh Destruction System
 * for a Video Game"; the chunk-and-graph approach of fracturing tools).
 *
 * The building's shell - every wall, roof, cornice, as drawn, with its own
 * colours and textures - is subdivided until no triangle is larger than a
 * fragment, and every triangle goes to the Voronoi cell (a jittered grid of
 * seeds) its centre is in. The windows, doors and other parts go whole to the
 * cell their centre is in. Each cell is one fragment: a mesh of exactly the
 * pieces of the building it covers, with the building's own materials, given
 * a wall's thickness (a back face and sides along every cut, in the grey of
 * broken masonry) so a piece that comes loose is solid. Floor slabs are added
 * inside, storey by storey, so a broken building shows its floors.
 *
 * Put back together the fragments ARE the building, so nothing changes on
 * screen until a blow takes some of them away.
 */

/** Edge of a Voronoi cell: the size of a fragment. */
export const FRAGMENT = m(2.8);
/** Longest triangle edge after subdivision. */
const MAX_EDGE = m(1.4);
/** Thickness given to a wall fragment. */
const WALL = m(0.28);
/** The grey of broken masonry, on the cut faces. */
const BROKEN = [0.46, 0.44, 0.41] as const;

/** What a ruin knows of each fragment besides its vertices (which are in the ruin's buffer, `StillData`). */
export interface Fragment {
  /** Centre in three's space (y up), standing. */
  readonly centre: readonly [number, number, number];
  /** Radius of the fragment round its centre. */
  readonly radius: number;
  /** Lowest point, three's y. */
  readonly low: number;
  /** Fragments it is joined to. */
  readonly neighbours: readonly number[];
}

interface Tri {
  /** 3 vertices x (pos 3, normal 3, colour 3, uv 2) = 33 numbers. */
  readonly v: number[];
  readonly material: number;
  /** Whether it is part of the shell (gets thickness) or a whole part. */
  readonly solid: boolean;
  /** For a part: the id of its instance, so it stays whole. */
  readonly group: number;
}

const STRIDE = 12;

function lerp(a: number[], ai: number, b: number[], bi: number, out: number[]): void {
  for (let k = 0; k < STRIDE; k++) out.push((a[ai + k]! + b[bi + k]!) / 2);
}

/** Splits a triangle along its longest edge until every edge is under `max`. */
function subdivide(v: number[], max: number, out: number[][]): void {
  const stack = [v];
  while (stack.length) {
    const t = stack.pop()!;
    const d = (i: number, j: number): number => Math.hypot(t[i * STRIDE]! - t[j * STRIDE]!, t[i * STRIDE + 1]! - t[j * STRIDE + 1]!, t[i * STRIDE + 2]! - t[j * STRIDE + 2]!);
    const e = [d(0, 1), d(1, 2), d(2, 0)];
    const longest = e.indexOf(Math.max(...e));
    if (e[longest]! <= max || out.length > 200_000) { out.push(t); continue; }
    const i = longest, j = (longest + 1) % 3, k = (longest + 2) % 3;
    const mid: number[] = [];
    lerp(t, i * STRIDE, t, j * STRIDE, mid);
    const vi = t.slice(i * STRIDE, i * STRIDE + STRIDE), vj = t.slice(j * STRIDE, j * STRIDE + STRIDE), vk = t.slice(k * STRIDE, k * STRIDE + STRIDE);
    stack.push([...vi, ...mid, ...vk], [...mid, ...vj, ...vk]);
  }
}

/**
 * The fragments of one building, from its drawn chunk. `floor` is its ground
 * floor's height; `storeys` the heights (three's y, absolute) of its floor slabs
 * with the footprints they span, for the interior.
 */
/** What a fracture needs, as plain arrays (so it can run in a worker, `fracture.worker.ts`). */
export interface FractureInput {
  readonly shells: readonly { mat: number; position: Float32Array; normal: Float32Array; colour: Float32Array; uv: Float32Array; index: Uint32Array; decay: Float32Array }[];
  /** Instanced parts (windows, doors, furniture): their model, non-indexed, and each instance's matrix. */
  readonly parts: readonly { mat: number; position: Float32Array; normal: Float32Array; uv: Float32Array | null; colour: Float32Array | null;
    instColours: Float32Array | null; matrices: Float32Array; count: number }[];
  readonly slabMat: number;
  readonly slabs: readonly { corners: readonly (readonly [number, number, number])[]; y: number }[];
  readonly seed: number;
}

/** A fragment as arrays, vertices round its centre: gathered into its ruin's buffer (`mergeFragments`). */
export interface FragmentData {
  readonly centre: readonly [number, number, number];
  readonly position: Float32Array; readonly normal: Float32Array; readonly colour: Float32Array; readonly uv: Float32Array; readonly decay: Float32Array;
  readonly groups: readonly { material: number; start: number; count: number }[];
  readonly radius: number;
  readonly low: number;
  readonly neighbours: number[];
}

/** A kit model's vertices as plain arrays, made once per model. */
const MODEL_ARRAYS = new WeakMap<BufferGeometry, { position: Float32Array; normal: Float32Array; uv: Float32Array | null; colour: Float32Array | null }>();
function modelArrays(source: BufferGeometry): { position: Float32Array; normal: Float32Array; uv: Float32Array | null; colour: Float32Array | null } {
  let known = MODEL_ARRAYS.get(source);
  if (!known) {
    const geo = source.index ? source.toNonIndexed() : source;
    const arr = (name: string): Float32Array | null => { const at = geo.getAttribute(name); return at ? Float32Array.from(at.array as ArrayLike<number>) : null; };
    known = { position: arr('position')!, normal: arr('normal')!, uv: arr('uv'), colour: arr('color') };
    if (geo !== source) geo.dispose();
    MODEL_ARRAYS.set(source, known);
  }
  return known;
}

/** The arrays of a building's chunk and kit a fracture reads, and the materials its fragments are drawn with. */
export function prepareFracture(
  chunk: BuildingChunk,
  kit: BuildingKit,
  slabs: readonly { readonly corners: readonly Vector3[]; readonly y: number }[],
  seed: number,
  furniture?: Partial<Record<string, { matrices: Float32Array; count: number }>>,
): { input: FractureInput; materials: Material[] } {
  const materials: Material[] = [];
  const index = new Map<Material, number>();
  const materialIndex = (mat: Material): number => {
    let i = index.get(mat);
    if (i === undefined) { i = materials.length; materials.push(mat); index.set(mat, i); }
    return i;
  };
  const shells: FractureInput['shells'][number][] = [];
  for (const [finish, part] of Object.entries(chunk.shells) as [Finish, NonNullable<BuildingChunk['shells'][Finish]>][]) {
    shells.push({ mat: materialIndex(kit.shell[finish]), position: part.position, normal: part.normal, colour: part.colour, uv: part.uv, index: part.index, decay: part.decay });
  }
  const parts: FractureInput['parts'][number][] = [];
  const model = (source: BufferGeometry, mat: number, batch: { matrices: Float32Array; count: number; colours?: Float32Array | null }): void => {
    const arrays = modelArrays(source);
    parts.push({ mat, ...arrays, instColours: batch.colours ?? null, matrices: batch.matrices, count: batch.count });
  };
  for (const [kind, batch] of Object.entries(chunk.parts) as [PartKind, BuildingChunk['parts'][PartKind]][]) {
    if (!batch.count || kind === 'water') continue;
    model(kit.geometry[kind], materialIndex(kit.material[kind]), batch);
  }
  if (furniture) {
    const fk = kit.furniture();
    const mat = materialIndex(fk.material);
    for (const [kind, batch] of Object.entries(furniture)) {
      const source = (fk.geometry as Record<string, BufferGeometry>)[kind];
      if (batch && batch.count && source) model(source, mat, batch);
    }
  }
  return {
    input: { shells, parts, slabMat: materialIndex(kit.shell.concrete), seed,
      slabs: slabs.map((sl) => ({ corners: sl.corners.map((c) => [c.x, c.y, c.z] as const), y: sl.y })) },
    materials,
  };
}

/**
 * Every fragment of a building in one buffer, in world space (three's, y up),
 * one draw group per material: the ruin's still mesh (`destruction.ts`), static
 * batching as Unity's manual "Draw call batching" describes it. `slots` holds,
 * per fragment, triples (start in the buffer, vertex count, material), so a
 * piece knocked loose is blanked in place and its own geometry made from its
 * ranges while it flies, and a piece landed written back, uploading only its
 * own range (three's `BufferAttribute.addUpdateRange`). The vertices are
 * nowhere else: kept per fragment as well, every ruin held them twice for
 * good. Pure arrays: made in the worker.
 */
export interface StillData {
  readonly position: Float32Array; readonly normal: Float32Array; readonly colour: Float32Array; readonly uv: Float32Array; readonly decay: Float32Array;
  readonly groups: readonly { material: number; start: number; count: number }[];
  readonly slots: readonly Int32Array[];
  readonly fragments: readonly Fragment[];
}

/**
 * A fragment's own geometry, round its centre, from its ranges in the ruin's
 * buffer as they stand (the piece about to fly is still where it stood): one
 * draw group per range, by its material.
 */
export function fragmentGeometry(data: StillData, index: number): BufferGeometry {
  const slots = data.slots[index]!;
  const [cx, cy, cz] = data.fragments[index]!.centre;
  let total = 0;
  for (let s = 0; s < slots.length; s += 3) total += slots[s + 1]!;
  const position = new Float32Array(total * 3), normal = new Float32Array(total * 3), colour = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2), decay = new Float32Array(total);
  const g = new BufferGeometry();
  let at = 0;
  for (let s = 0; s < slots.length; s += 3) {
    const start = slots[s]!, count = slots[s + 1]!;
    for (let i = start; i < start + count; i++, at++) {
      position[at * 3] = data.position[i * 3]! - cx; position[at * 3 + 1] = data.position[i * 3 + 1]! - cy; position[at * 3 + 2] = data.position[i * 3 + 2]! - cz;
    }
    normal.set(data.normal.subarray(start * 3, (start + count) * 3), (at - count) * 3);
    colour.set(data.colour.subarray(start * 3, (start + count) * 3), (at - count) * 3);
    uv.set(data.uv.subarray(start * 2, (start + count) * 2), (at - count) * 2);
    decay.set(data.decay.subarray(start, start + count), at - count);
    g.addGroup(at - count, count, slots[s + 2]!);
  }
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('normal', new BufferAttribute(normal, 3));
  g.setAttribute('color', new BufferAttribute(colour, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('aDecay', new BufferAttribute(decay, 1));
  g.boundingSphere = new Sphere(new Vector3(), data.fragments[index]!.radius);
  return g;
}

export function mergeFragments(data: readonly FragmentData[]): StillData {
  let total = 0, materials = 0;
  for (const f of data) for (const g of f.groups) { total += g.count; materials = Math.max(materials, g.material + 1); }
  const position = new Float32Array(total * 3), normal = new Float32Array(total * 3), colour = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2), decay = new Float32Array(total);
  const slots = data.map(() => [] as number[]);
  const groups: { material: number; start: number; count: number }[] = [];
  let at = 0;
  for (let material = 0; material < materials; material++) {
    const first = at;
    data.forEach((f, fi) => {
      const [cx, cy, cz] = f.centre;
      for (const g of f.groups) {
        if (g.material !== material) continue;
        slots[fi]!.push(at, g.count, material);
        for (let i = g.start; i < g.start + g.count; i++, at++) {
          position[at * 3] = f.position[i * 3]! + cx; position[at * 3 + 1] = f.position[i * 3 + 1]! + cy; position[at * 3 + 2] = f.position[i * 3 + 2]! + cz;
          normal[at * 3] = f.normal[i * 3]!; normal[at * 3 + 1] = f.normal[i * 3 + 1]!; normal[at * 3 + 2] = f.normal[i * 3 + 2]!;
          colour[at * 3] = f.colour[i * 3]!; colour[at * 3 + 1] = f.colour[i * 3 + 1]!; colour[at * 3 + 2] = f.colour[i * 3 + 2]!;
          uv[at * 2] = f.uv[i * 2]!; uv[at * 2 + 1] = f.uv[i * 2 + 1]!;
          decay[at] = f.decay[i]!;
        }
      }
    });
    if (at > first) groups.push({ material, start: first, count: at - first });
  }
  return { position, normal, colour, uv, decay, groups, slots: slots.map((s) => Int32Array.from(s)),
    fragments: data.map((f) => ({ centre: f.centre, radius: f.radius, low: f.low, neighbours: f.neighbours })) };
}

/** The fracture itself, pure arrays in and out: run in a worker. */
export function fractureData(input: FractureInput): FragmentData[] {
  const tris: Tri[] = [];
  let wear = 0, wearN = 0;
  for (const part of input.shells) for (const d of part.decay) { wear += d; wearN++; }
  const bDecay = wearN ? wear / wearN : 0;
  for (const part of input.shells) {
    const mat = part.mat;
    const { position: p, normal: n, colour: c, uv, index: idx, decay: dk } = part;
    const vert = (i: number): number[] => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!, n[i * 3]!, n[i * 3 + 1]!, n[i * 3 + 2]!, c[i * 3]!, c[i * 3 + 1]!, c[i * 3 + 2]!, uv[i * 2]!, uv[i * 2 + 1]!, dk[i] ?? 0];
    for (let t = 0; t < idx.length; t += 3) {
      const out: number[][] = [];
      subdivide([...vert(idx[t]!), ...vert(idx[t + 1]!), ...vert(idx[t + 2]!)], MAX_EDGE, out);
      for (const v of out) tris.push({ v, material: mat, solid: true, group: -1 });
    }
  }
  let group = 0;
  const m4 = new Matrix4(), a = new Vector3(), nv = new Vector3(), nm3 = new Matrix3();
  for (const part of input.parts) {
    const { position: gp, normal: gn, uv: guv, colour: gc, instColours, matrices, count, mat } = part;
    const verts = gp.length / 3;
    for (let k = 0; k < count; k++) {
      m4.fromArray(matrices, k * 16);
      nm3.getNormalMatrix(m4);
      const ic = instColours ? [instColours[k * 3]!, instColours[k * 3 + 1]!, instColours[k * 3 + 2]!] : null;
      for (let t = 0; t < verts; t += 3) {
        const v: number[] = [];
        for (let q = 0; q < 3; q++) {
          const i = t + q;
          a.set(gp[i * 3]!, gp[i * 3 + 1]!, gp[i * 3 + 2]!).applyMatrix4(m4);
          nv.set(gn[i * 3]!, gn[i * 3 + 1]!, gn[i * 3 + 2]!).applyMatrix3(nm3).normalize();
          const col = ic ?? (gc ? [gc[i * 3]!, gc[i * 3 + 1]!, gc[i * 3 + 2]!] : [1, 1, 1]);
          v.push(a.x, a.y, a.z, nv.x, nv.y, nv.z, col[0]!, col[1]!, col[2]!, guv ? guv[i * 2]! : 0, guv ? guv[i * 2 + 1]! : 0, bDecay);
        }
        tris.push({ v, material: mat, solid: false, group });
      }
      group++;
    }
  }
  // ---- the floor slabs inside, in the concrete finish
  const slabMat = input.slabMat;
  for (const slab of input.slabs) {
    const [c0, c1, c2, c3] = slab.corners as [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
    for (const [top, ny] of [[slab.y, 1], [slab.y - m(0.25), -1]] as const) {
      const vtx = (c: readonly [number, number, number]): number[] => [c[0], top, c[2], 0, ny, 0, 0.62, 0.6, 0.57, c[0] * 0.3, c[2] * 0.3, bDecay];
      const quad = ny > 0 ? [[c0, c1, c2], [c0, c2, c3]] : [[c0, c2, c1], [c0, c3, c2]];
      for (const [p0, p1, p2] of quad) {
        const out: number[][] = [];
        subdivide([...vtx(p0!), ...vtx(p1!), ...vtx(p2!)], MAX_EDGE, out);
        for (const v of out) tris.push({ v, material: slabMat, solid: false, group: -1 });
      }
    }
  }
  if (!tris.length) return [];

  // ---- Voronoi cells: a jittered grid of seeds
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (const t of tris) for (let q = 0; q < 3; q++) {
    minX = Math.min(minX, t.v[q * STRIDE]!); minY = Math.min(minY, t.v[q * STRIDE + 1]!); minZ = Math.min(minZ, t.v[q * STRIDE + 2]!);
  }
  let s = input.seed >>> 0 || 1;
  const rand = (): number => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s / 4_294_967_296; };
  const jitter = new Map<string, Vector3>();
  const seedOf = (i: number, j: number, k: number): Vector3 => {
    const key = `${i},${j},${k}`;
    let p = jitter.get(key);
    if (!p) {
      p = new Vector3(minX + (i + 0.15 + rand() * 0.7) * FRAGMENT, minY + (j + 0.15 + rand() * 0.7) * FRAGMENT, minZ + (k + 0.15 + rand() * 0.7) * FRAGMENT);
      jitter.set(key, p);
    }
    return p;
  };
  const cellOf = (x: number, y: number, z: number): string => {
    const i0 = Math.floor((x - minX) / FRAGMENT), j0 = Math.floor((y - minY) / FRAGMENT), k0 = Math.floor((z - minZ) / FRAGMENT);
    let best = '', bd = Infinity;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      const p = seedOf(i0 + di, j0 + dj, k0 + dk);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2;
      if (d < bd) { bd = d; best = `${i0 + di},${j0 + dj},${k0 + dk}`; }
    }
    return best;
  };
  const centroid = (t: Tri): [number, number, number] => [
    (t.v[0]! + t.v[STRIDE]! + t.v[2 * STRIDE]!) / 3, (t.v[1]! + t.v[STRIDE + 1]! + t.v[2 * STRIDE + 1]!) / 3, (t.v[2]! + t.v[STRIDE + 2]! + t.v[2 * STRIDE + 2]!) / 3,
  ];
  // A part goes whole to the cell of its first triangle's centre.
  const groupCell = new Map<number, string>();
  const cells = new Map<string, Tri[]>();
  for (const t of tris) {
    let cell: string;
    if (t.group >= 0) {
      cell = groupCell.get(t.group) ?? cellOf(...centroid(t));
      groupCell.set(t.group, cell);
    } else cell = cellOf(...centroid(t));
    const list = cells.get(cell);
    if (list) list.push(t); else cells.set(cell, [t]);
  }

  // ---- each cell to a solid fragment
  const keys = [...cells.keys()];
  const vkey = (x: number, y: number, z: number): string => `${Math.round(x * 200)},${Math.round(y * 200)},${Math.round(z * 200)}`;
  const vertexCells = new Map<string, Set<number>>();
  const fragments: FragmentData[] = [];
  keys.forEach((cell, fi) => {
    const list = cells.get(cell)!;
    const pos: number[] = [], nor: number[] = [], col: number[] = [], uvs: number[] = [], dec: number[] = [];
    const groups: { material: number; start: number; count: number }[] = [];
    let cx = 0, cy = 0, cz = 0, nverts = 0;
    for (const t of list) for (let q = 0; q < 3; q++) { cx += t.v[q * STRIDE]!; cy += t.v[q * STRIDE + 1]!; cz += t.v[q * STRIDE + 2]!; nverts++; }
    cx /= nverts; cy /= nverts; cz /= nverts;
    let radius = 0, low = Infinity;
    const push = (x: number, y: number, z: number, n: readonly number[], c: readonly number[], u: number, w: number, d = bDecay): void => {
      pos.push(x - cx, y - cy, z - cz); nor.push(n[0]!, n[1]!, n[2]!); col.push(c[0]!, c[1]!, c[2]!); uvs.push(u, w); dec.push(d);
      radius = Math.max(radius, Math.hypot(x - cx, y - cy, z - cz)); low = Math.min(low, y);
    };
    // Grouped by material, for the mesh's draw groups.
    const byMat = new Map<number, Tri[]>();
    for (const t of list) { const l = byMat.get(t.material); if (l) l.push(t); else byMat.set(t.material, [t]); }
    for (const [mat, mtris] of byMat) {
      const start = pos.length / 3;
      // Edges used once inside the fragment: the cut, which gets a side.
      const edges = new Map<string, number>();
      const ek = (t: Tri, i: number, j: number): string => {
        const a1 = vkey(t.v[i * STRIDE]!, t.v[i * STRIDE + 1]!, t.v[i * STRIDE + 2]!), b1 = vkey(t.v[j * STRIDE]!, t.v[j * STRIDE + 1]!, t.v[j * STRIDE + 2]!);
        return a1 < b1 ? `${a1}|${b1}` : `${b1}|${a1}`;
      };
      for (const t of mtris) if (t.solid) for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) { const k = ek(t, i, j); edges.set(k, (edges.get(k) ?? 0) + 1); }
      for (const t of mtris) {
        const v = t.v;
        for (let q = 0; q < 3; q++) {
          const o = q * STRIDE;
          push(v[o]!, v[o + 1]!, v[o + 2]!, [v[o + 3]!, v[o + 4]!, v[o + 5]!], [v[o + 6]!, v[o + 7]!, v[o + 8]!], v[o + 9]!, v[o + 10]!, v[o + 11]!);
          const key = vkey(v[o]!, v[o + 1]!, v[o + 2]!);
          let set = vertexCells.get(key);
          if (!set) vertexCells.set(key, set = new Set());
          set.add(fi);
        }
        if (!t.solid) continue;
        // The wall's thickness: its back face, in broken masonry.
        const back = (q: number): [number, number, number] => [v[q * STRIDE]! - v[q * STRIDE + 3]! * WALL, v[q * STRIDE + 1]! - v[q * STRIDE + 4]! * WALL, v[q * STRIDE + 2]! - v[q * STRIDE + 5]! * WALL];
        const nb = [-v[3]!, -v[4]!, -v[5]!];
        for (const q of [0, 2, 1]) { const b = back(q); push(b[0], b[1], b[2], nb, BROKEN, v[q * STRIDE + 9]!, v[q * STRIDE + 10]!); }
        // A side along every cut edge.
        for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
          if (edges.get(ek(t, i, j)) !== 1) continue;
          const pi = [v[i * STRIDE]!, v[i * STRIDE + 1]!, v[i * STRIDE + 2]!], pj = [v[j * STRIDE]!, v[j * STRIDE + 1]!, v[j * STRIDE + 2]!];
          const bi = back(i), bj = back(j);
          const ex = pj[0]! - pi[0]!, ey = pj[1]! - pi[1]!, ez = pj[2]! - pi[2]!;
          const sn = new Vector3(ey * v[5]! - ez * v[4]!, ez * v[3]! - ex * v[5]!, ex * v[4]! - ey * v[3]!).normalize();
          const sideN = [sn.x, sn.y, sn.z];
          push(pi[0]!, pi[1]!, pi[2]!, sideN, BROKEN, 0, 0); push(bi[0], bi[1], bi[2], sideN, BROKEN, 0, 1); push(pj[0]!, pj[1]!, pj[2]!, sideN, BROKEN, 1, 0);
          push(pj[0]!, pj[1]!, pj[2]!, sideN, BROKEN, 1, 0); push(bi[0], bi[1], bi[2], sideN, BROKEN, 0, 1); push(bj[0], bj[1], bj[2], sideN, BROKEN, 1, 1);
        }
      }
      groups.push({ material: mat, start, count: pos.length / 3 - start });
    }
    fragments.push({ centre: [cx, cy, cz], position: Float32Array.from(pos), normal: Float32Array.from(nor), colour: Float32Array.from(col),
      uv: Float32Array.from(uvs), decay: Float32Array.from(dec), groups, radius, low, neighbours: [] });
  });
  // Joined where they share a vertex of the original surface.
  const links = fragments.map(() => new Set<number>());
  for (const set of vertexCells.values()) {
    if (set.size < 2) continue;
    const ids = [...set];
    for (const x of ids) for (const y of ids) if (x !== y) links[x]!.add(y);
  }
  links.forEach((set, i) => fragments[i]!.neighbours.push(...set));
  return fragments;
}
