import type { Aabb } from '@core/aabb';
import { Digest } from '@core/digest';
import { Polyline } from '@core/polyline';
import type { SegmentId } from './ids';
import { ROAD_GROUND_CLEARANCE, type RoadStructure } from './structures';
import { m } from './units';

/**
 * THE READS OF THE ROADS' HEIGHT FIELD (`elevation.ts`): the height, the road
 * nearest a point and its texture frame, from the solved profiles alone. Pure
 * (no page, no three): the same code answers on the page, over every road of
 * the map, and in the road tile workers (`render/roadTileMesh.ts`), over the
 * roads near a batch of tiles handed over as typed arrays (`packField`), so
 * the two read the same numbers bit for bit.
 */

/** Softness of the blend between neighbouring profiles, in world units. */
export const BLEND_TAU = m(1);
/**
 * A road this much farther than the nearest one weighs under the blend's
 * 1e-4 cut for sure (exp(-9.26) < 9.6e-5): skipped without its exponential.
 */
const BLEND_SKIP = BLEND_TAU * (Math.log(1e4) + 0.05);
/**
 * How far from a road its own profile is the whole answer.
 *
 * Comfortably past the widest casing (a boulevard's is 31.5) and past the reach
 * of any junction ring, so every vertex of every road surface is decided by the
 * road and never by the ground beside it.
 */
export const PROFILE_REACH = m(24);
/**
 * How far out the road's influence fades to nothing.
 *
 * Beyond `PROFILE_REACH` the answer eases from the road's deck to the terrain,
 * reaching the terrain exactly here. Without that easing the field simply
 * STOPPED at the last road it could find and jumped to the ground: measured on
 * a cross over a hill, an 8.8-unit step a few tens of units off the kerb. No
 * road surface reaches that far today, but a field with a cliff in it is a
 * mesh waiting to tear, and the fade costs one smoothstep per query.
 */
export const PROFILE_FADE = m(44);
/** Side of the spatial index's cells, world units. */
export const INDEX_CELL = m(25.6);

/** What a query reads of one road's solved profile. */
export interface FieldProfile {
  readonly id: SegmentId;
  readonly structure: RoadStructure;
  /** A player-authored vertical alignment, independent of legacy structure modes. */
  readonly manualVertical: boolean;
  /** The class index the road was drawn with, for per-class surface tinting. */
  readonly type: number;
  /** Half the casing width — how far this road's surface reaches sideways. */
  readonly half: number;
  /** Central reservation width, zero when the class has none. */
  readonly median: number;
  /** Authored footway width, including the kerb: the wider side's. */
  readonly sidewalk: number;
  /** Each side's footway, left and right of a -> b (docs/source/VIAS.md V1). */
  readonly sidewalkLeft: number;
  readonly sidewalkRight: number;
  readonly line: Polyline;
  readonly length: number;
  readonly step: number;
  /** Deck height at station `i`, i.e. at arc `i * step`. */
  readonly h: ArrayLike<number>;
  readonly bbox: Aabb;
}

export interface RoadSample {
  /** Distance along the nearest road, in world units. */
  readonly along: number;
  /** Signed offset across it. */
  readonly across: number;
  /** Class index of that road, or -1 when there is no road near the point. */
  readonly type: number;
  /** Half the casing width of that road. */
  readonly half: number;
  /** Its central reservation width. */
  readonly median: number;
  /** Its actual footway width, including the kerb. Optional for older query adapters. */
  readonly sidewalk?: number;
  /** Each side's footway, left and right of a -> b, when they differ. */
  readonly sidewalkLeft?: number;
  readonly sidewalkRight?: number;
  /** The segment the point was read off. */
  readonly segment?: SegmentId;
}

/** The reads of the field a road surface makes per vertex (`render/roadSurfaceReads.ts`). */
export interface RoadReads {
  /**
   * Deck height of the road surface at a world point.
   *
   * `structures` restricts the answer to one structural level, which is what a
   * render pass wants: the ground pass must not read the elevated deck that
   * flies over it. With no filter every road is considered.
   */
  at(x: number, y: number, structures?: ReadonlySet<RoadStructure>, includeManual?: boolean): number;
  /** Deck height on one specific segment — what an agent riding it stands on. */
  onSegment(segment: SegmentId, x: number, y: number): number;
  /**
   * Everything a surface needs to know about the road nearest a point.
   *
   * `along` and `across` are road-local coordinates: surface textures are laid
   * in that frame rather than in world axes, so asphalt grain runs along the
   * carriageway and a kerb's joints run along the kerb, whatever direction the
   * road happens to point. `type` is the class index, which is what lets one
   * asphalt mesh carry a residential street's grey and an avenue's near-black
   * in the same draw call.
   */
  roadAt(x: number, y: number, structures?: ReadonlySet<RoadStructure>, includeManual?: boolean): RoadSample;
  /**
   * Texture coordinates of (x, y) in the frame of the road nearest to
   * (pickX, pickY), continued in a straight line past the road's ends.
   *
   * `roadAt` answers "which road is this point on", and past the end of a
   * centreline its `across` is a RADIAL distance and its `along` is stuck at
   * the end - right for clearances, and the fan of streaks in every junction
   * corner when used as a texture frame. This extends the frame linearly
   * instead, and lets the caller pick the road from a different point, so a
   * whole triangle can be framed by one road (see `uvFrame` in
   * `render/mesh/tileMesh.ts`).
   */
  surfaceFrameAt(
    x: number,
    y: number,
    structures: ReadonlySet<RoadStructure> | undefined,
    pickX: number,
    pickY: number,
    includeManual?: boolean,
    segment?: SegmentId,
    /**
     * Lay `along` at the true length of each line parallel to the road
     * (docs/source/VIAS.md V1, no stretch on a curve), restarting every `panel`
     * units of road: a pattern keeps its size on the inside and the outside
     * of a bend, with a joint at each panel's edge, as paving is laid.
     */
    panel?: number,
  ): { along: number; across: number };
  /**
   * Runs `work` with every point it reads remembered, so a point asked again
   * (another surface's vertex there, a skirt's top and bottom) is not searched
   * again; forgotten when `work` ends. The answers are the same numbers.
   */
  remembering?<T>(work: () => T): T;
}

/** 0 below `a`, 1 above `b`, smooth in between. */
export function smoothstep(a: number, b: number, value: number): number {
  const u = Math.min(1, Math.max(0, (value - a) / Math.max(1e-6, b - a)));
  return u * u * (3 - 2 * u);
}

/** Linear read of a profile at an arc position — continuous, never stepped. */
export function heightAtArc(profile: { readonly h: ArrayLike<number>; readonly step: number }, s: number): number {
  const { h, step } = profile;
  const at = Math.min(h.length - 1, Math.max(0, s / step));
  const low = Math.floor(at);
  const high = Math.min(h.length - 1, low + 1);
  const a = h[low] as number;
  const b = h[high] as number;
  return a + (b - a) * (at - low);
}

// ------------------------------------------------------------ spatial index

const cellKeyOf = (x: number, y: number): number => x * 73_856_093 + y * 19_349_663;

/**
 * A uniform grid over the segments' influence boxes.
 *
 * The query runs once per mesh vertex — hundreds of thousands of times on a
 * large map — and a linear scan over every segment made the rebuild quadratic in
 * the size of the network. The grid makes it proportional to the number of roads
 * that actually reach the point, which is a handful.
 *
 * Built over the roads near some rectangles only (a worker's, `packField`), the
 * same profiles in the same order, it answers a point of those rectangles with
 * the very list the whole map's index gives: every road filed in a cell of
 * theirs is among them. `answers` holds those cells; a point elsewhere throws.
 */
export class SpatialIndex<P extends { readonly bbox: Aabb }> {
  private readonly cell = INDEX_CELL;
  private readonly buckets = new Map<number, P[]>();
  private readonly oversized: P[] = [];
  private readonly oversizedSet = new Set<P>();
  /** By a set: asked for every profile of the build (`profileSummaries`). */
  isOversized(profile: P): boolean {
    return this.oversizedSet.has(profile);
  }
  private readonly all: readonly P[];

  constructor(profiles: readonly P[], private readonly answers?: ReadonlySet<number>) {
    this.all = profiles;
    for (const profile of profiles) {
      const box = profile.bbox;
      const x0 = Math.floor(box.minX / this.cell);
      const x1 = Math.floor(box.maxX / this.cell);
      const y0 = Math.floor(box.minY / this.cell);
      const y1 = Math.floor(box.maxY / this.cell);
      // A pathological box (a road across the whole map) would fill the grid;
      // those stay in the fallback list instead of being spread over it.
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
        this.oversized.push(profile);
        this.oversizedSet.add(profile);
        continue;
      }
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = cellKeyOf(x, y);
          const bucket = this.buckets.get(key);
          if (bucket) bucket.push(profile);
          else this.buckets.set(key, [profile]);
        }
      }
    }
  }

  /** Digest of every profile `near` can return for a point of the rectangle, in its order; a profile `of` gives null for is left out. */
  digest(minX: number, minY: number, maxX: number, maxY: number, of: (profile: P) => number | null): number {
    // The same reading with or without buckets: a network with no bucketed
    // road (empty, or every road oversized) read differently, so its first
    // bucketed road changed every block of the map (docs/source/performance.md #10).
    const digest = new Digest();
    for (let x = Math.floor(minX / this.cell); x <= Math.floor(maxX / this.cell); x++) {
      for (let y = Math.floor(minY / this.cell); y <= Math.floor(maxY / this.cell); y++) {
        const key = cellKeyOf(x, y);
        digest.add(key);
        for (const profile of this.buckets.get(key) ?? EMPTY) {
          const value = of(profile);
          if (value !== null) digest.add(value);
        }
      }
    }
    digest.add(-1);
    for (const profile of this.oversized) {
      const value = of(profile);
      if (value !== null) digest.add(value);
    }
    return digest.value();
  }

  /**
   * Every profile `near` can return for a point of the rectangles, and the
   * cells that holds for (`answers` of an index built over them alone).
   */
  meeting(rects: readonly (readonly [number, number, number, number])[]): { profiles: Set<P>; cells: number[] } {
    const profiles = new Set<P>(this.oversized);
    const cells = new Set<number>();
    for (const [minX, minY, maxX, maxY] of rects) {
      for (let x = Math.floor(minX / this.cell); x <= Math.floor(maxX / this.cell); x++) {
        for (let y = Math.floor(minY / this.cell); y <= Math.floor(maxY / this.cell); y++) {
          const key = cellKeyOf(x, y);
          if (cells.has(key)) continue;
          cells.add(key);
          for (const profile of this.buckets.get(key) ?? EMPTY) profiles.add(profile);
        }
      }
    }
    return { profiles, cells: [...cells] };
  }

  near(x: number, y: number): readonly P[] {
    const key = cellKeyOf(Math.floor(x / this.cell), Math.floor(y / this.cell));
    // DO NOT answer a point the roads handed over do not cover: its list could lack a road.
    if (this.answers && !this.answers.has(key)) throw new Error(`the road field was not handed the roads at (${x}, ${y})`);
    if (this.buckets.size === 0) return this.all;
    const bucket = this.buckets.get(key);
    if (this.oversized.length === 0) return bucket ?? EMPTY;
    return bucket ? [...bucket, ...this.oversized] : this.oversized;
  }
}

const EMPTY: readonly never[] = Object.freeze([]);

// ------------------------------------------------------------ point memo

/** A coordinate's bits, to hash it: one per table. */
interface HashScratch {
  readonly f64: Float64Array;
  readonly u32: Uint32Array;
}
const hashScratch = (): HashScratch => {
  const f64 = new Float64Array(1);
  return { f64, u32: new Uint32Array(f64.buffer) };
};

/** The slot of (x, y) in an open-addressed table of `mask + 1` slots, probing over `xs`/`ys` (entries + 1 in `slots`). */
function slotOf(hash: HashScratch, slots: Int32Array, xs: Float64Array, ys: Float64Array, x: number, y: number): number {
  const { f64, u32 } = hash;
  f64[0] = x + 0;
  let h = Math.imul(u32[0]! ^ Math.imul(u32[1]!, 0x27d4eb2d), 0x9e3779b1);
  f64[0] = y + 0;
  h = Math.imul(h ^ u32[0]! ^ Math.imul(u32[1]!, 0x85ebca6b), 0xc2b2ae35);
  const mask = slots.length - 1;
  let at = (h ^ (h >>> 15)) & mask;
  for (;;) {
    const e = slots[at]! - 1;
    if (e < 0 || (xs[e] === x && ys[e] === y)) return at;
    at = (at + 1) & mask;
  }
}

/**
 * What the height field found at each point of one piece of work
 * (`RoadReads.remembering`), keyed by the point's exact coordinates: open
 * addressing over typed arrays, grown by doubling and never evicting, emptied
 * as a whole by `clear`.
 */
class PointMemo<R> {
  private readonly hash = hashScratch();
  private slots = new Int32Array(1 << 12);
  private xs: Float64Array = new Float64Array(1 << 11);
  private ys: Float64Array = new Float64Array(1 << 11);
  s: Float64Array = new Float64Array(1 << 11);
  distance: Float64Array = new Float64Array(1 << 11);
  height: Float64Array = new Float64Array(1 << 11);
  manual: Uint8Array = new Uint8Array(1 << 11);
  roads: (R | null)[] = [];
  structures: (ReadonlySet<RoadStructure> | undefined)[] = [];
  private size = 0;

  /** The entry of (x, y), or -1. */
  find(x: number, y: number): number {
    return this.slots[slotOf(this.hash, this.slots, this.xs, this.ys, x, y)]! - 1;
  }

  put(x: number, y: number, structures: ReadonlySet<RoadStructure> | undefined, includeManual: boolean,
    road: R | null, s: number, distance: number, height: number): void {
    let at = slotOf(this.hash, this.slots, this.xs, this.ys, x, y);
    let e = this.slots[at]! - 1;
    if (e >= 0) {
      // Asked with other filters: the first answer stays (DO NOT overwrite and evict it).
      if (this.structures[e] !== structures || this.manual[e] !== (includeManual ? 1 : 0)) return;
    } else {
      if ((this.size + 1) * 2 > this.slots.length) {
        this.grow();
        at = slotOf(this.hash, this.slots, this.xs, this.ys, x, y);
      }
      e = this.size++;
      if (e >= this.xs.length) this.growEntries();
      this.slots[at] = e + 1;
      this.xs[e] = x;
      this.ys[e] = y;
    }
    this.structures[e] = structures;
    this.manual[e] = includeManual ? 1 : 0;
    this.roads[e] = road;
    this.s[e] = s;
    this.distance[e] = distance;
    this.height[e] = height;
  }

  /** Forgets every point; keeps the arrays, sized for the largest piece of work so far. */
  clear(): void {
    if (this.size === 0) return;
    this.slots.fill(0);
    this.roads.length = 0;
    this.structures.length = 0;
    this.size = 0;
  }

  private grow(): void {
    this.slots = new Int32Array(this.slots.length * 2);
    for (let e = 0; e < this.size; e++) this.slots[slotOf(this.hash, this.slots, this.xs, this.ys, this.xs[e]!, this.ys[e]!)] = e + 1;
  }

  private growEntries(): void {
    const n = this.xs.length * 2;
    const f64 = (a: Float64Array): Float64Array => { const b = new Float64Array(n); b.set(a); return b; };
    this.xs = f64(this.xs);
    this.ys = f64(this.ys);
    this.s = f64(this.s);
    this.distance = f64(this.distance);
    this.height = f64(this.height);
    const manual = new Uint8Array(n);
    manual.set(this.manual);
    this.manual = manual;
  }
}

/**
 * Heights of the ground at exact points, handed over by the page (a road tile
 * worker's terrain, `render/roadTileMesh.ts`): open addressing as `PointMemo`.
 */
export class PointHeights {
  private readonly hash = hashScratch();
  private slots = new Int32Array(1 << 12);
  private xs: Float64Array = new Float64Array(1 << 11);
  private ys: Float64Array = new Float64Array(1 << 11);
  private hs: Float64Array = new Float64Array(1 << 11);
  private size = 0;

  get count(): number {
    return this.size;
  }

  /** The height at (x, y), or undefined when none was given. */
  get(x: number, y: number): number | undefined {
    const e = this.slots[slotOf(this.hash, this.slots, this.xs, this.ys, x, y)]! - 1;
    return e < 0 ? undefined : this.hs[e]!;
  }

  /** Whether (x, y) is held; adds it with `height` when it is not. */
  add(x: number, y: number, height: number): boolean {
    let at = slotOf(this.hash, this.slots, this.xs, this.ys, x, y);
    if (this.slots[at]! > 0) return true;
    if ((this.size + 1) * 2 > this.slots.length) {
      this.slots = new Int32Array(this.slots.length * 2);
      for (let e = 0; e < this.size; e++) this.slots[slotOf(this.hash, this.slots, this.xs, this.ys, this.xs[e]!, this.ys[e]!)] = e + 1;
      at = slotOf(this.hash, this.slots, this.xs, this.ys, x, y);
    }
    const e = this.size++;
    if (e >= this.xs.length) {
      const n = this.xs.length * 2;
      const f64 = (a: Float64Array): Float64Array => { const b = new Float64Array(n); b.set(a); return b; };
      this.xs = f64(this.xs);
      this.ys = f64(this.ys);
      this.hs = f64(this.hs);
    }
    this.slots[at] = e + 1;
    this.xs[e] = x;
    this.ys[e] = y;
    this.hs[e] = height;
    return false;
  }
}

// ------------------------------------------------------------ the field

/**
 * The reads of a solved field over `profiles` (`index` built over them, in
 * that order). `terrainAt` is read only where no road has the whole say.
 */
export function roadField<P extends FieldProfile>(
  index: SpatialIndex<P>,
  byId: ReadonlyMap<SegmentId, P>,
  terrainAt: (x: number, y: number) => number,
): Required<RoadReads> {
  const hit = { s: 0, distance: 0 };
  const sampleProfile = (profile: P, x: number, y: number): number => {
    profile.line.closestInto(x, y, hit);
    return heightAtArc(profile, hit.s);
  };

  const distances: number[] = [];
  const arcs: number[] = [];
  const picked: P[] = [];

  /**
   * The last point asked about, and what was found there: the nearest road,
   * the arc length and distance to it, and the blended height.
   *
   * A mesh vertex asks the same point up to five times in a row - the height
   * of the band's top and of its skirt, the texture frame, the class tint - and
   * every one of those used to repeat the whole nearest-road search. The
   * answers are the same numbers, so the last point is remembered. The
   * elevation is immutable once built, so the memo can never be stale.
   */
  const last = {
    x: NaN,
    y: NaN,
    structures: undefined as ReadonlySet<RoadStructure> | undefined,
    includeManual: true,
    road: null as P | null,
    s: 0,
    distance: Infinity,
    /** NaN until the height itself has been asked for at this point. */
    height: NaN,
  };
  /**
   * Every point asked while `remembering` runs, with what `last` holds for it.
   * A road tile's vertex is asked again and again, not only in a row: by each
   * surface sharing it (the asphalt's edge is the kerb's), by both edges of a
   * skirt and its top and bottom, by the pieces either side of a cut. One
   * remembered point was 5.5 million height reads for 3.1 million points in
   * a 2,560 m city (2026-10-15). Emptied when the work ends: it holds one tile's
   * points, never the map's. DO NOT keep it across `remembering` calls, nor cap
   * it and evict (CLAUDE.md: a capped cache that evicts and recomputes).
   */
  const memo = new PointMemo<P>();
  let memoOn = false;
  const remembers = (x: number, y: number, structures: ReadonlySet<RoadStructure> | undefined,
    includeManual: boolean): boolean => {
    if (last.x === x && last.y === y && last.structures === structures && last.includeManual === includeManual) return true;
    if (!memoOn) return false;
    const e = memo.find(x, y);
    if (e < 0 || memo.structures[e] !== structures || memo.manual[e] !== (includeManual ? 1 : 0)) return false;
    last.x = x;
    last.y = y;
    last.structures = structures;
    last.includeManual = includeManual;
    last.road = memo.roads[e]!;
    last.s = memo.s[e]!;
    last.distance = memo.distance[e]!;
    last.height = memo.height[e]!;
    return true;
  };
  const remember = (x: number, y: number, structures: ReadonlySet<RoadStructure> | undefined,
    includeManual: boolean, road: P | null, s: number, distance: number, height: number): void => {
    last.x = x;
    last.y = y;
    last.structures = structures;
    last.includeManual = includeManual;
    last.road = road;
    last.s = s;
    last.distance = distance;
    last.height = height;
    if (memoOn) memo.put(x, y, structures, includeManual, road, s, distance, height);
  };

  /** The road nearest a point, out of the structural levels asked for; its arc and distance in `last`. */
  const nearest = (
    x: number,
    y: number,
    structures?: ReadonlySet<RoadStructure>,
    includeManual = true,
  ): P | null => {
    if (remembers(x, y, structures, includeManual)) return last.road;
    let best: P | null = null;
    let bestDistance = Infinity;
    let bestS = 0;
    for (const profile of index.near(x, y)) {
      if (structures && !structures.has(profile.structure)) continue;
      if (!includeManual && profile.manualVertical) continue;
      profile.line.closestInto(x, y, hit);
      if (hit.distance < bestDistance) {
        bestDistance = hit.distance;
        best = profile;
        bestS = hit.s;
      }
    }
    remember(x, y, structures, includeManual, best, bestS, bestDistance, NaN);
    return best;
  };

  /** The height at a point from the `found` candidates just measured. */
  const blend = (x: number, y: number, best: number, found: number): number => {
    // The ground is read only where it is used: under a road's full authority
    // (every vertex of its surface) it is not. DO NOT read it first for all.
    if (found === 0) return terrainAt(x, y) + ROAD_GROUND_CLEARANCE;
    // How much the roads have to say here at all: everything within
    // `PROFILE_REACH`, nothing past `PROFILE_FADE`, eased in between.
    const authority = 1 - smoothstep(PROFILE_REACH, PROFILE_FADE, best);
    if (authority <= 0) return terrainAt(x, y) + ROAD_GROUND_CLEARANCE;
    let sum = 0;
    let weight = 0;
    for (let i = 0; i < found; i++) {
      // Surely under the cut below: no exponential for a road that cannot count.
      if ((distances[i] as number) - best > BLEND_SKIP) continue;
      const w = Math.exp(-((distances[i] as number) - best) / BLEND_TAU);
      if (w < 1e-4) continue;
      sum += w * heightAtArc(picked[i] as P, arcs[i] as number);
      weight += w;
    }
    if (weight <= 0) return terrainAt(x, y) + ROAD_GROUND_CLEARANCE;
    const road = sum / weight;
    return authority >= 1 ? road : road * authority + (terrainAt(x, y) + ROAD_GROUND_CLEARANCE) * (1 - authority);
  };

  const query = (x: number, y: number, structures?: ReadonlySet<RoadStructure>, includeManual = true): number => {
    if (remembers(x, y, structures, includeManual) && !Number.isNaN(last.height)) return last.height;
    const candidates = index.near(x, y);
    let best = Infinity;
    let road: P | null = null;
    let roadS = 0;
    let found = 0;
    for (const profile of candidates) {
      if (structures && !structures.has(profile.structure)) continue;
      if (!includeManual && profile.manualVertical) continue;
      profile.line.closestInto(x, y, hit);
      distances[found] = hit.distance;
      arcs[found] = hit.s;
      picked[found] = profile;
      found++;
      if (hit.distance < best) {
        best = hit.distance;
        road = profile;
        roadS = hit.s;
      }
    }
    const height = blend(x, y, best, found);
    remember(x, y, structures, includeManual, road, roadS, best, height);
    return height;
  };

  return {
    at: query,
    remembering(work) {
      if (memoOn) return work();
      memoOn = true;
      try {
        return work();
      } finally {
        memoOn = false;
        memo.clear();
      }
    },
    onSegment(segment, x, y) {
      const profile = byId.get(segment);
      if (!profile) return terrainAt(x, y) + ROAD_GROUND_CLEARANCE;
      return sampleProfile(profile, x, y);
    },
    roadAt(x, y, structures, includeManual = true) {
      const best = nearest(x, y, structures, includeManual);
      if (!best) return { along: y, across: x, type: -1, half: 0, median: 0 };
      const { s, distance } = last;
      // Signed offset, so the two halves of a carriageway do not mirror the
      // texture into a seam down the centre line.
      const frame = best.line.sampleAt(s);
      const sign = Math.sign((x - frame.p.x) * frame.n.x + (y - frame.p.y) * frame.n.y) || 1;
      return {
        along: s,
        across: distance * sign,
        type: best.type,
        half: best.half,
        median: best.median,
        sidewalk: best.sidewalk,
        ...(best.sidewalkLeft !== best.sidewalkRight ? { sidewalkLeft: best.sidewalkLeft, sidewalkRight: best.sidewalkRight } : {}),
        segment: best.id,
      };
    },
    surfaceFrameAt(x, y, structures, pickX, pickY, includeManual = true, segment, panel) {
      const best = segment === undefined
        ? nearest(pickX, pickY, structures, includeManual)
        : byId.get(segment);
      if (!best) return { along: y, across: x };
      let s = segment === undefined ? last.s : 0;
      if (segment !== undefined) {
        best.line.closestInto(pickX, pickY, hit);
        s = hit.s;
      }
      if (pickX !== x || pickY !== y) {
        best.line.closestInto(x, y, hit);
        s = hit.s;
      }
      const frame = best.line.sampleAt(s);
      const dx = x - frame.p.x;
      const dy = y - frame.p.y;
      const across = dx * frame.n.x + dy * frame.n.y;
      let along = s + dx * frame.t.x + dy * frame.t.y;
      if (panel !== undefined && panel > 0) {
        // A line `across` to the left of a curve is shorter than the
        // centreline by `across` times the turn: d(along) = (1 - across k) ds.
        // Integrated from the panel's start, the turn since then times the
        // offset comes off (a centreline U stretches the inside of a bend and
        // squeezes the outside; GameDev.net, "spline based road geometry UV
        // mapping"). Within a panel only, so the shear it brings never builds up.
        const start = Math.floor(Math.max(0, Math.min(best.length, s)) / panel) * panel;
        const t0 = best.line.sampleAt(start).t;
        const turn = Math.atan2(t0.x * frame.t.y - t0.y * frame.t.x, t0.x * frame.t.x + t0.y * frame.t.y);
        along -= across * turn;
      }
      return { along, across };
    },
  };
}

// ------------------------------------------------------------ handed over

/** Figures per profile in `FieldData.numbers`. */
const STRIDE = 13;

/**
 * The profiles a batch of road tiles reads, as typed arrays handed to a worker
 * (MDN, "Transferable objects"): only the roads near its tiles (`packField`),
 * never the map's.
 */
export interface FieldData {
  readonly ids: Float64Array;
  readonly structures: readonly RoadStructure[];
  /** Per profile: manual, type, half, median, sidewalk, left, right, length, step, box (4). */
  readonly numbers: Float64Array;
  /** Where each profile's line ends in `lines`, and its heights in `heights`. */
  readonly lineEnds: Uint32Array;
  readonly lines: Float64Array;
  readonly heightEnds: Uint32Array;
  readonly heights: Float64Array;
  /** The index cells the profiles answer for (`SpatialIndex.meeting`). */
  readonly cells: Float64Array;
}

/** `profiles` (in the field's own order) as `FieldData`, its arrays fresh: the buffers to hand over in `transfer`. */
export function packField(profiles: readonly FieldProfile[], cells: readonly number[]): { data: FieldData; transfer: ArrayBuffer[] } {
  let lineLength = 0;
  let heightLength = 0;
  for (const p of profiles) { lineLength += p.line.xy.length; heightLength += p.h.length; }
  const ids = new Float64Array(profiles.length);
  const numbers = new Float64Array(profiles.length * STRIDE);
  const lineEnds = new Uint32Array(profiles.length);
  const lines = new Float64Array(lineLength);
  const heightEnds = new Uint32Array(profiles.length);
  const heights = new Float64Array(heightLength);
  const structures: RoadStructure[] = [];
  let atLine = 0;
  let atHeight = 0;
  profiles.forEach((p, i) => {
    ids[i] = p.id;
    structures.push(p.structure);
    const o = i * STRIDE;
    numbers[o] = p.manualVertical ? 1 : 0;
    numbers[o + 1] = p.type;
    numbers[o + 2] = p.half;
    numbers[o + 3] = p.median;
    numbers[o + 4] = p.sidewalk;
    numbers[o + 5] = p.sidewalkLeft;
    numbers[o + 6] = p.sidewalkRight;
    numbers[o + 7] = p.length;
    numbers[o + 8] = p.step;
    numbers[o + 9] = p.bbox.minX;
    numbers[o + 10] = p.bbox.minY;
    numbers[o + 11] = p.bbox.maxX;
    numbers[o + 12] = p.bbox.maxY;
    lines.set(p.line.xy, atLine);
    atLine += p.line.xy.length;
    lineEnds[i] = atLine;
    for (let k = 0; k < p.h.length; k++) heights[atHeight + k] = p.h[k]!;
    atHeight += p.h.length;
    heightEnds[i] = atHeight;
  });
  const data: FieldData = { ids, structures, numbers, lineEnds, lines, heightEnds, heights, cells: Float64Array.from(cells) };
  return { data, transfer: [ids, numbers, lineEnds, lines, heightEnds, heights, data.cells].map((array) => array.buffer as ArrayBuffer) };
}

/** The profiles of `FieldData`, in its order. */
export function unpackField(data: FieldData): FieldProfile[] {
  const out: FieldProfile[] = [];
  let atLine = 0;
  let atHeight = 0;
  for (let i = 0; i < data.ids.length; i++) {
    const o = i * STRIDE;
    const n = data.numbers;
    const line = Polyline.fromFlat(data.lines.subarray(atLine, data.lineEnds[i]!));
    const h = data.heights.subarray(atHeight, data.heightEnds[i]!);
    atLine = data.lineEnds[i]!;
    atHeight = data.heightEnds[i]!;
    out.push({
      id: data.ids[i]! as SegmentId,
      structure: data.structures[i]!,
      manualVertical: n[o] === 1,
      type: n[o + 1]!,
      half: n[o + 2]!,
      median: n[o + 3]!,
      sidewalk: n[o + 4]!,
      sidewalkLeft: n[o + 5]!,
      sidewalkRight: n[o + 6]!,
      length: n[o + 7]!,
      step: n[o + 8]!,
      bbox: { minX: n[o + 9]!, minY: n[o + 10]!, maxX: n[o + 11]!, maxY: n[o + 12]! },
      line,
      h,
    });
  }
  return out;
}

/** The field over `FieldData`, answering for its cells alone. */
export function fieldOf(data: FieldData, terrainAt: (x: number, y: number) => number): Required<RoadReads> {
  const profiles = unpackField(data);
  const index = new SpatialIndex(profiles, new Set(data.cells));
  return roadField(index, new Map(profiles.map((p) => [p.id, p])), terrainAt);
}
