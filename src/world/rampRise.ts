import type { SegmentId } from './ids';
import { m } from './units';

/** How high the walking surface stands over a dropped kerb (`curbRamps.ts`), from the ramps near a point alone. */

/** A dropped kerb: at each end of every zebra the footway ramps down to the carriageway (`curbRamps.ts`). */
export interface CurbRamp {
  /** The middle of the ramp's foot, on the kerb face (the carriageway's edge). */
  readonly x: number;
  readonly y: number;
  /** Along the street. */
  readonly tx: number;
  readonly ty: number;
  /** Across the street, from the carriageway into the footway. */
  readonly nx: number;
  readonly ny: number;
  /** Half the ramp's width along the street (half the zebra's). */
  readonly half: number;
  /** How far into the footway the slope runs, to the footway's full height. */
  readonly run: number;
  /** Length of each flared side along the street. */
  readonly flare: number;
  /** The street whose zebra it serves. */
  readonly segment: SegmentId;
  readonly structure: string;
}

/** A ramp as plain data, every field its own (`rampData`): what a message's clone keeps of it (a road tile's job, `roadTileMesh.ts`). */
export type CurbRampData = { -readonly [K in keyof CurbRamp]: CurbRamp[K] };

/** DO NOT keep a ramp as an object of nine boxed numbers (~170 B a ramp, two a zebra, 2026-10-21): its numbers in one run, read through getters (a class: a message's clone of it keeps no getter, it crosses as `rampData`). */
class PackedRamp implements CurbRamp {
  constructor(readonly segment: SegmentId, readonly structure: string, private readonly v: readonly number[]) {}
  get x(): number { return this.v[0]!; }
  get y(): number { return this.v[1]!; }
  get tx(): number { return this.v[2]!; }
  get ty(): number { return this.v[3]!; }
  get nx(): number { return this.v[4]!; }
  get ny(): number { return this.v[5]!; }
  get half(): number { return this.v[6]!; }
  get run(): number { return this.v[7]!; }
  get flare(): number { return this.v[8]!; }
}

/** A ramp kept compact (`PackedRamp`) from its fields. */
export const rampOf = (r: CurbRamp): CurbRamp => new PackedRamp(r.segment, r.structure, [r.x, r.y, r.tx, r.ty, r.nx, r.ny, r.half, r.run, r.flare]);

/** A ramp's fields as plain data (`CurbRampData`). */
export const rampData = (r: CurbRamp): CurbRampData =>
  ({ x: r.x, y: r.y, tx: r.tx, ty: r.ty, nx: r.nx, ny: r.ny, half: r.half, run: r.run, flare: r.flare, segment: r.segment, structure: r.structure });

/** How far onto the carriageway a ramp still answers, so a walker's step off it is level. */
const ROAD_REACH = m(0.6);
/** Bucket size of the lookup grid. */
export const RAMP_CELL = m(20);
/** A grid cell's key as a number: `walkingRise` is asked for every walker drawn every frame */
export const rampCellKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

/** Calls `visit` with the key of every cell a ramp reaches. */
export function rampCells(r: CurbRamp, visit: (key: number) => void): void {
  const reach = r.half + r.flare + r.run;
  for (let cx = Math.floor((r.x - reach) / RAMP_CELL); cx <= Math.floor((r.x + reach) / RAMP_CELL); cx++) {
    for (let cy = Math.floor((r.y - reach) / RAMP_CELL); cy <= Math.floor((r.y + reach) / RAMP_CELL); cy++) visit(rampCellKey(cx, cy));
  }
}

/** The ramps filed by the cells they reach. */
export function rampGrid(ramps: readonly CurbRamp[]): Map<number, CurbRamp[]> {
  const grid = new Map<number, CurbRamp[]>();
  for (const r of ramps) rampCells(r, (key) => { const list = grid.get(key); if (list) list.push(r); else grid.set(key, [r]); });
  return grid;
}

/** The walking surface's share of the footway's rise at (x, y), from the ramps filed in its cell of `grid` (`walkingRise`). */
export function rampRiseIn(grid: ReadonlyMap<number, readonly CurbRamp[]>, x: number, y: number, onFootway: boolean, structure: string): number {
  const list = grid.get(rampCellKey(Math.floor(x / RAMP_CELL), Math.floor(y / RAMP_CELL)));
  let share = onFootway ? 1 : 0;
  if (!list) return share;
  let inside = false;
  let low = 1;
  for (const r of list) {
    if (r.structure !== structure) continue;
    const dx = x - r.x, dy = y - r.y;
    const u = Math.abs(dx * r.tx + dy * r.ty);
    const v = dx * r.nx + dy * r.ny;
    if (u > r.half + r.flare || v > r.run || v < -ROAD_REACH) continue;
    inside = true;
    let f = v <= 0 ? 0 : v / r.run;
    if (u > r.half) f = Math.max(f, (u - r.half) / r.flare);
    low = Math.min(low, Math.min(1, f));
  }
  if (inside) share = low;
  return share;
}
