import { BufferGeometry, Float32BufferAttribute, Uint16BufferAttribute } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import { simplifyIndex } from './lodWorker';
import { lodPool } from './lodPool';

/**
 * The crowd's levels of detail (`proceduralCrowd.ts`), from its own meshes.
 *
 * A level is chosen by how tall a person is on the screen, H pixels, so that
 * a triangle facing the camera covers some 16 pixels or more - between the
 * floor of one 2 x 2 quad and the 32 pixels a primitive PowerVR's guide asks
 * for ("avoid small triangle sizes … especially dipping below 32 pixels per
 * primitive"): a body's visible area is about H x H/4 over half its
 * triangles, so T <= H² / 32.
 *
 *   level 0  H >= 40   the whole model (its hair never more than its body)
 *   level 1  20..40    about 4 800 triangles
 *   level 2  8..20     about 1 440
 *   level 3  3..8      about 330: one merged mesh a class and outfit, the hair apart
 *   none     < 3       not drawn
 *
 * The bands are the person's height as a share of the screen, as an engine
 * sets a LOD Group's transitions (Unity, "Transition (% Screen Size)"), and
 * they are set by what each level LOSES, not by triangles alone: the far mesh
 * has no texture (one colour a vertex), so it is for a person too small to
 * show a face or a print. The triangle rule alone put it on everybody up to
 * 150 px - every person at every playable zoom (58 px at the usual one) -
 * and the player asked why the pedestrians looked like rubbish (2026-10-08).
 * Then the whole model began at 100 px, and at the street view the player
 * plays at (people 60-80 px tall) everybody was level 1 - no lashes, no
 * mouth, a faceted body: "the detail must not appear only when the zoom is
 * rubbed in their faces". As Unity's "Set to Camera" does it, the closest
 * level covers the height a person has in the view in use. The cost is held
 * by the caps below, not by the bands.
 *
 * Every level of a piece is an index buffer over the same vertices
 * (meshoptimizer for the meshes; hair cards, which a simplifier cannot merge,
 * chosen card by card), so a piece's vertex data is on the GPU once.
 */
export const LEVEL_PIXELS = [40, 20, 8, 3] as const;
/** Levels drawn: 0..3. */
export const LEVELS = 4;
/** Hysteresis: a person goes back up a level only this far past its edge. */
const HYSTERESIS = 0.1;
/**
 * The closest levels' safety caps: past them, the people smallest on the
 * screen go one level down (a street-level camera in a packed square).
 */
export const LEVEL_CAPS = [30, 120] as const;

/** The level for a person `pixels` tall on the screen, given the one they had (-1: none). */
export function levelFor(pixels: number, was: number): number {
  for (let level = 0; level < LEVELS; level++) {
    // Moving to a closer level than now needs the margin.
    const edge = LEVEL_PIXELS[level]!;
    const need = level < was || was < 0 ? edge * (1 + HYSTERESIS) : edge;
    if (pixels >= need) return level;
  }
  return -1;
}

/** What a piece is, for its triangle budget at each level. */
export type PieceRole = 'skin' | 'outfit' | 'garment' | 'shoes' | 'hair' | 'brows' | 'lashes' | 'mouth' | 'accessory';

/** The body's triangles at level 0: no hair costs more. */
export const SKIN_TRIANGLES_LEVEL0 = 26756;

/**
 * Triangles a piece keeps at each level (Infinity: all of it; 0: not drawn
 * there). At level 3 the skin, the outfit and the shoes are the far mesh
 * (`FAR_TRIANGLES`); the hair and the accessories stay pieces of their own.
 * No hair costs more than the body at the same level.
 */
export const LEVEL_TRIANGLES: Readonly<Record<PieceRole, readonly [number, number, number, number]>> = {
  skin: [Infinity, 2000, 600, 0],
  outfit: [Infinity, 1200, 400, 0],
  // Trousers or a skirt worn under a separate top.
  garment: [Infinity, 900, 300, 0],
  shoes: [Infinity, 300, 80, 0],
  hair: [SKIN_TRIANGLES_LEVEL0, 1000, 300, 120],
  brows: [Infinity, 100, 0, 0],
  lashes: [Infinity, 0, 0, 0],
  mouth: [Infinity, 0, 0, 0],
  accessory: [Infinity, 200, 60, 60],
};
/** Of the skin's triangles, the eyes' - simplified apart: as part of the body they were the first to go. */
export const EYE_TRIANGLES = [Infinity, 200, 40, 0] as const;
/** The far mesh (level 3): the skin left uncovered by the clothes, the outfit, and any garment under it. */
export const FAR_TRIANGLES = { skin: 120, outfit: 90, garment: 60 } as const;

export const lodReady: Promise<void> = MeshoptSimplifier.ready.catch(() => {});

function positionsOf(geometry: BufferGeometry): Float32Array {
  const position = geometry.getAttribute('position');
  const out = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    out[i * 3] = position.getX(i); out[i * 3 + 1] = position.getY(i); out[i * 3 + 2] = position.getZ(i);
  }
  return out;
}

/**
 * `indices` (triangles of `geometry`) simplified to about `triangles`
 * triangles over the same vertices; the indices themselves when they are
 * within it, null when the simplifier cannot run.
 */
export function simplifiedIndex(geometry: BufferGeometry, triangles: number, indices?: Uint32Array): Uint32Array | null {
  const source = indices ?? (geometry.getIndex() ? Uint32Array.from(geometry.getIndex()!.array as ArrayLike<number>) : null);
  if (!source || !geometry.getAttribute('position')) return null;
  if (!Number.isFinite(triangles) || source.length <= triangles * 3) return source;
  return simplifyIndex(source, positionsOf(geometry), triangles);
}

/**
 * `simplifiedIndex` done by the simplifier worker (`lodPool.ts`): the same
 * result, off the main thread - each new piece's levels were 2-14 ms of a
 * frame. Here, as before, where there is no worker.
 */
export async function simplifiedIndexAway(geometry: BufferGeometry, triangles: number, indices?: Uint32Array): Promise<Uint32Array | null> {
  const source = indices ?? (geometry.getIndex() ? Uint32Array.from(geometry.getIndex()!.array as ArrayLike<number>) : null);
  if (!source || !geometry.getAttribute('position')) return null;
  if (!Number.isFinite(triangles) || source.length <= triangles * 3) return source;
  const pool = lodPool();
  if (!pool || !MeshoptSimplifier.supported) return simplifiedIndex(geometry, triangles, indices);
  // A copy goes: the worker takes what it is sent, and the caller may still use its own.
  return pool.index({ positions: positionsOf(geometry), index: source.slice(), triangles });
}

/** The triangles of `index` whose three vertices pass `keep`. */
export function filterTriangles(index: ArrayLike<number>, keep: (v: number) => boolean): Uint32Array {
  const out: number[] = [];
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t]!, b = index[t + 1]!, c = index[t + 2]!;
    if (keep(a) && keep(b) && keep(c)) out.push(a, b, c);
  }
  return Uint32Array.from(out);
}

/** Hair cards chosen for a budget: the index of the kept cards, and how much each is widened to keep the hair's cover. */
export interface CardSelection {
  readonly index: Uint32Array;
  readonly widen: number;
}

/**
 * A hairstyle's cards (each a connected run of quads), and the cards kept
 * for each budget: the largest first, widened about their own middle by
 * √(area of all / area kept) - at most 1.6 - so the hair keeps its cover
 * (the widening is the vertex shader's: `aCard`, each vertex's card middle).
 * Over the same vertices, so the selection holds for every class's fit.
 */
export function cardSelections(geometry: BufferGeometry, budgets: readonly number[]): { cardOf: Int32Array; selections: (CardSelection | null)[] } {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  const count = position.count;
  const cardOf = new Int32Array(count).fill(-1);
  if (!index) return { cardOf, selections: budgets.map(() => null) };
  const tris = index.count / 3;
  // Cards: the triangles joined by shared vertices (union-find).
  const parent = new Int32Array(count).map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  for (let t = 0; t < tris; t++) {
    const a = find(index.getX(t * 3)), b = find(index.getX(t * 3 + 1));
    parent[b] = a;
    parent[find(index.getX(t * 3 + 2))] = a;
  }
  const roots = new Map<number, number>();
  for (let v = 0; v < count; v++) {
    const r = find(v);
    let id = roots.get(r);
    if (id === undefined) { id = roots.size; roots.set(r, id); }
    cardOf[v] = id;
  }
  const cards: { tris: number[]; area: number }[] = Array.from({ length: roots.size }, () => ({ tris: [], area: 0 }));
  let total = 0;
  for (let t = 0; t < tris; t++) {
    const i0 = index.getX(t * 3), i1 = index.getX(t * 3 + 1), i2 = index.getX(t * 3 + 2);
    const ax = position.getX(i1) - position.getX(i0), ay = position.getY(i1) - position.getY(i0), az = position.getZ(i1) - position.getZ(i0);
    const bx = position.getX(i2) - position.getX(i0), by = position.getY(i2) - position.getY(i0), bz = position.getZ(i2) - position.getZ(i0);
    const area = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    const card = cards[cardOf[i0]!]!;
    card.tris.push(t);
    card.area += area;
    total += area;
  }
  const sorted = [...cards].sort((p, q) => q.area - p.area);
  const selections = budgets.map((budget): CardSelection | null => {
    if (budget <= 0) return null;
    if (!Number.isFinite(budget) || tris <= budget) return { index: Uint32Array.from(index.array as ArrayLike<number>), widen: 1 };
    const out: number[] = [];
    let kept = 0, area = 0;
    for (const card of sorted) {
      if (kept + card.tris.length > budget && kept > 0) break;
      for (const t of card.tris) out.push(index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2));
      kept += card.tris.length;
      area += card.area;
    }
    return { index: Uint32Array.from(out), widen: Math.min(1.6, Math.sqrt(total / Math.max(1e-9, area))) };
  });
  return { cardOf, selections };
}

/** Each vertex's card middle (`cardSelections`), for the widening in the vertex shader. */
export function cardCentres(geometry: BufferGeometry, cardOf: Int32Array): Float32Array {
  const position = geometry.getAttribute('position');
  let cards = 0;
  for (let v = 0; v < cardOf.length; v++) cards = Math.max(cards, cardOf[v]! + 1);
  const sum = new Float64Array(cards * 4);
  for (let v = 0; v < position.count; v++) {
    const c = cardOf[v]!;
    if (c < 0) continue;
    sum[c * 4] = sum[c * 4]! + position.getX(v);
    sum[c * 4 + 1] = sum[c * 4 + 1]! + position.getY(v);
    sum[c * 4 + 2] = sum[c * 4 + 2]! + position.getZ(v);
    sum[c * 4 + 3] = sum[c * 4 + 3]! + 1;
  }
  const out = new Float32Array(position.count * 3);
  for (let v = 0; v < position.count; v++) {
    const c = cardOf[v]!;
    if (c < 0) { out[v * 3] = position.getX(v); out[v * 3 + 1] = position.getY(v); out[v * 3 + 2] = position.getZ(v); continue; }
    const n = Math.max(1, sum[c * 4 + 3]!);
    out[v * 3] = sum[c * 4]! / n; out[v * 3 + 1] = sum[c * 4 + 1]! / n; out[v * 3 + 2] = sum[c * 4 + 2]! / n;
  }
  return out;
}

/**
 * The region of the far mesh a vertex belongs to (`proceduralCrowd.ts`): the
 * skin and the shoes take the person's colour, the outfit its own dyed with
 * the person's dye, another garment its own.
 */
export const REGION = { skin: 0, outfit: 1, shoes: 2, garment: 3 } as const;

/** A part of the far mesh: some triangles of a geometry, simplified to `triangles`, and the colour of each vertex. */
export interface FarPart {
  readonly geometry: BufferGeometry;
  readonly indices: Uint32Array;
  readonly region: number;
  readonly triangles: number;
  /** A vertex's own colour (linear RGB), multiplied by the person's in the shader; white without. */
  readonly colour?: (v: number) => readonly [number, number, number];
}

/**
 * The far mesh of a class and outfit (level 3): the skin the outfit leaves
 * bare and the outfit, each simplified, merged into one geometry; `aFar` a
 * vertex is its own colour and its region (skin below `ankle` is the
 * shoes'). Only what the far skinning reads is kept: position, normal,
 * skinIndex, skinWeight, aRefs, aRefW.
 */
export function farMesh(parts: readonly FarPart[], ankle: number): BufferGeometry | null {
  const keep = ['position', 'normal', 'skinIndex', 'skinWeight', 'aRefs', 'aRefW'];
  const pieces: BufferGeometry[] = [];
  for (const part of parts) {
    const index = simplifiedIndex(part.geometry, part.triangles, part.indices);
    if (!index || !index.length) continue;
    // Only the vertices the simplified index uses, renumbered.
    const remap = new Map<number, number>();
    const order: number[] = [];
    const out: number[] = [];
    for (const v of index) {
      let n = remap.get(v);
      if (n === undefined) { n = order.length; remap.set(v, n); order.push(v); }
      out.push(n);
    }
    const g = new BufferGeometry();
    for (const name of keep) {
      const attribute = part.geometry.getAttribute(name);
      if (!attribute) return null;
      const size = attribute.itemSize;
      const values = new Float32Array(order.length * size);
      order.forEach((v, i) => { for (let c = 0; c < size; c++) values[i * size + c] = attribute.getComponent(v, c); });
      g.setAttribute(name, name === 'skinIndex' ? new Uint16BufferAttribute(Uint16Array.from(values), size) : new Float32BufferAttribute(values, size));
    }
    const position = g.getAttribute('position');
    const far = new Float32Array(order.length * 4);
    order.forEach((v, i) => {
      const [r, gr, b] = part.colour?.(v) ?? [1, 1, 1];
      far[i * 4] = r; far[i * 4 + 1] = gr; far[i * 4 + 2] = b;
      far[i * 4 + 3] = part.region === REGION.skin && position.getY(i) < ankle ? REGION.shoes : part.region;
    });
    g.setAttribute('aFar', new Float32BufferAttribute(far, 4));
    g.setIndex(out);
    pieces.push(g);
  }
  if (!pieces.length) return null;
  const merged = mergeGeometries(pieces, false);
  for (const p of pieces) p.dispose();
  if (!merged) return null;
  merged.computeBoundingSphere();
  return merged;
}

const sortedWeights = new WeakSet<object>();
/**
 * Sorts each vertex's four bone weights largest first, in place: the far
 * levels skin with the first two only (renormalised), and the close ones
 * read all four, so their result is the same.
 */
export function sortSkinWeights(geometry: BufferGeometry): void {
  const index = geometry.getAttribute('skinIndex');
  const weight = geometry.getAttribute('skinWeight');
  if (!index || !weight || sortedWeights.has(weight)) return;
  const pairs: [number, number][] = [[0, 0], [0, 0], [0, 0], [0, 0]];
  for (let v = 0; v < index.count; v++) {
    for (let k = 0; k < 4; k++) { pairs[k]![0] = index.getComponent(v, k); pairs[k]![1] = weight.getComponent(v, k); }
    pairs.sort((a, b) => b[1] - a[1]);
    for (let k = 0; k < 4; k++) { index.setComponent(v, k, pairs[k]![0]); weight.setComponent(v, k, pairs[k]![1]); }
  }
  index.needsUpdate = true;
  weight.needsUpdate = true;
  sortedWeights.add(weight);
}
