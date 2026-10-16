import { clamp } from '@core/scalar';
import type { Vec2 } from '@core/vec2';
import { WORLD_REACH } from './tiles';
import { m } from './units';

/** THE WORLD'S PLATES: an unbounded grid of 2,048 m squares of ground, plate (pi, pj) centred on (pi, pj) x PLATE_SIZE (CLAUDE.md, "Streaming world") */

/** A plate's side: it holds 2 x 2 tiles of 1,024 m (`tiles.ts`), their edges on its centre lines and its own. */
export const PLATE_SIZE = m(2_048);
const PLATE_HALF = PLATE_SIZE / 2;

/** Plates each way from the origin a key can name: one past the tiles' reach, so every point with a tile has a plate. */
const PLATE_REACH = Math.ceil(WORLD_REACH / PLATE_SIZE) + 1;
const KEY_SIDE = PLATE_REACH * 2;

/** A plate's column and row: its centre is (pi, pj) x PLATE_SIZE. */
export interface PlateIJ {
  readonly pi: number;
  readonly pj: number;
}

/** One square plate of ground: its key, its centre and half its side. */
export interface PlateRegion {
  readonly key: number;
  readonly cx: number;
  readonly cy: number;
  readonly half: number;
}

/** The plate column of a coordinate: a point on an edge is the plate's whose low edge it is (as `tiles.ts` tileIJ). */
const plateIndex = (v: number): number => Math.floor(v / PLATE_SIZE + 0.5);

/** The plate a point lies in. */
export const plateIJ = (x: number, y: number): PlateIJ => ({ pi: plateIndex(x), pj: plateIndex(y) });

/** A plate's key: its column and row packed in one number (each shifted to be positive). */
export function plateKey(pi: number, pj: number): number {
  if (pi < -PLATE_REACH || pi >= PLATE_REACH || pj < -PLATE_REACH || pj >= PLATE_REACH) throw new Error(`plate ${pi},${pj} is past the world's reach`);
  return (pi + PLATE_REACH) * KEY_SIDE + (pj + PLATE_REACH);
}

/** The column and row of a plate's key. */
export function plateOfKey(key: number): PlateIJ {
  return { pi: Math.floor(key / KEY_SIDE) - PLATE_REACH, pj: (key % KEY_SIDE) - PLATE_REACH };
}

/** A plate column held to the keys' reach: only a point past the world's edge (an infinite ray's) is moved, onto its last plate. */
const inReach = (i: number): number => clamp(i, -PLATE_REACH, PLATE_REACH - 1);

/** The key of the plate a point lies in, anywhere (no map to hold it to: the world's reach alone). */
export const plateOf = (x: number, y: number): number => plateKey(inReach(plateIndex(x)), inReach(plateIndex(y)));

/** A plate's square by its key. */
export function plateRegion(key: number): PlateRegion {
  const { pi, pj } = plateOfKey(key);
  return { key, cx: pi * PLATE_SIZE, cy: pj * PLATE_SIZE, half: PLATE_HALF };
}

/** The plate a point lies in, as its square. */
export const regionAt = (x: number, y: number): PlateRegion => plateRegion(plateOf(x, y));

/** The plates a rectangle [minX, minY, maxX, maxY] reaches (its edges included), row by row. */
export function platesOver(rect: readonly [number, number, number, number]): number[] {
  const out: number[] = [];
  const i0 = inReach(plateIndex(rect[0])), i1 = inReach(plateIndex(rect[2])), j0 = inReach(plateIndex(rect[1])), j1 = inReach(plateIndex(rect[3]));
  for (let pj = j0; pj <= j1; pj++) for (let pi = i0; pi <= i1; pi++) out.push(plateKey(pi, pj));
  return out;
}

/** The plates within `ring` plates of plate (pi, pj) each way, the nearest ring first: a square of (2 ring + 1)^2. */
export function platesAround(pi: number, pj: number, ring: number): number[] {
  const out: number[] = [plateKey(pi, pj)];
  for (let r = 1; r <= ring; r++) {
    for (let d = -r; d <= r; d++) out.push(plateKey(pi + d, pj - r), plateKey(pi + d, pj + r));
    for (let d = -r + 1; d <= r - 1; d++) out.push(plateKey(pi - r, pj + d), plateKey(pi + r, pj + d));
  }
  return out;
}

/** How far from the origin anything stands, each way: a plate inside the tiles' reach, so every point's tile and plate have a key. */
export const WORLD_HALF = WORLD_REACH - PLATE_SIZE;

/** Whether a point is within the world's reach (`margin` inside it). */
export const insideWorld = (p: Vec2, margin = 0): boolean =>
  Math.abs(p.x) <= WORLD_HALF - margin && Math.abs(p.y) <= WORLD_HALF - margin;

/** The nearest point to `p` within the world's reach: only a file's broken number lies past it. */
export const clampToWorld = (p: Vec2, margin = 0): Vec2 => ({
  x: clamp(p.x, -WORLD_HALF + margin, WORLD_HALF - margin),
  y: clamp(p.y, -WORLD_HALF + margin, WORLD_HALF - margin),
});


