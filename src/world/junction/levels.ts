import { Ring } from '@core/ring';
import { COARSE_EPS } from '@core/scalar';
import { RecentCache } from '@core/recentCache';
import type { NodeId, SegmentId } from '../ids';
import type { ChangeRect } from '../changes';
import { Level, type RoadType, SURFACE_LEVELS, type SurfaceLevel, halfWidth, sideHalfWidth, symmetric } from '../roadTypes';
import type { Junction } from './build';
import { type Leg, legOf, packLegs, unpackLegs } from './legs';
import { type Corner, packCorners, unpackCorners } from './corners';
import { legTongue, nodeCap, nodeCentre } from './polygon';
import { baseTrims, deriveFromLegs } from './derive';

/**
 * A NODE'S JUNCTION AT EVERY SURFACE LEVEL, KEPT SMALL (`Network.junctions`).
 *
 * DO NOT keep every level of every junction whole - its legs, corners, outline, tongues and rings four times over (~1.7 KB a building
 * of the network, 2026-10-22): the carriageway is kept (what the traffic, the trims and the squeezes read), its tongues and rings
 * made from its legs when asked (`LeanJunction`); every outer level that is the carriageway carried out to its own edge
 * (`junction/derive.ts`) is kept as the one set of leg frames all those levels share (`frames`), and made again from them - reading
 * no document, so the same whatever the document holds by then - when asked, the latest asked held (`RecentCache`). The casing's
 * outline is kept as well (the network's far level draws it for every junction of the map, `render/networkFarRoads.ts`), and the
 * box of every ring of every level (`bounds`), worked out when the junction was solved. A level the carriageway could not be carried
 * out to (built on its own, `buildJunction`) is kept whole.
 */

/** How many outer levels made again are held, per level: the junctions of the cells being drawn and walked. */
const HELD_LEVELS = 512;
/** How many carriageways' tongues and rings made again are held. */
const HELD_RINGS = 1024;

/** A frame's numbers in `JunctionLevels.frames`: the carriageway's leg it is (its index), then its origin, direction, normal, angle and road length. */
const FRAME = 9;
const BASE = 0, OX = 1, OY = 2, DX = 3, DY = 4, NX = 5, NY = 6, ANG = 7, LENGTH = 8;

const EMPTY_RINGS: readonly Ring[] = Object.freeze([]) as readonly Ring[];

/** A carriageway's tongues and rings made again from its legs, trims and outline (`LeanJunction`). */
const madeRings = new RecentCache<LeanJunction, { readonly tongues: readonly Ring[]; readonly rings: readonly Ring[] }>(HELD_RINGS);
/** The outer levels made again (`JunctionLevels.get`), one cache a level. */
const madeCasing = new RecentCache<JunctionLevels, Junction | null>(HELD_LEVELS);
const madeSidewalk = new RecentCache<JunctionLevels, Junction | null>(HELD_LEVELS);
const madeCurb = new RecentCache<JunctionLevels, Junction | null>(HELD_LEVELS);
const madeAt = (level: SurfaceLevel): RecentCache<JunctionLevels, Junction | null> =>
  level === Level.Casing ? madeCasing : level === Level.Sidewalk ? madeSidewalk : madeCurb;

/** The tongues and rings `buildJunctionRing` and `deriveJunctionLevel` lay round a junction's outline: one tongue a leg cut back, a cap where every leg leaves on one side. */
function fill(legs: readonly Leg[], trims: readonly number[], ring: Ring): { readonly tongues: readonly Ring[]; readonly rings: readonly Ring[] } {
  const tongues = legs.map((leg, i) => legTongue(leg, trims[i] as number)).filter((r): r is Ring => r !== null);
  const cap = nodeCap(legs, nodeCentre(legs));
  return { tongues, rings: [ring, ...tongues, ...(cap ? [cap] : [])] };
}

/** A junction whose tongues and rings are made when asked (`fill`), or kept as they came when they are of another form (a turning circle, a taper, a merge). */
class LeanJunction implements Junction {
  constructor(
    readonly nodeId: NodeId,
    readonly level: SurfaceLevel,
    readonly legs: readonly Leg[],
    readonly corners: readonly Corner[],
    readonly trims: readonly number[],
    readonly ring: Ring,
    readonly usedHullFallback: boolean,
    readonly transition: boolean,
    /** Its tongues and rings when they are not the ones `fill` makes (`filled`). */
    readonly keptRings: { readonly tongues: readonly Ring[]; readonly rings: readonly Ring[] } | null,
  ) {}

  get tongues(): readonly Ring[] {
    return (this.keptRings ?? madeRings.get(this, made)).tongues;
  }

  get rings(): readonly Ring[] {
    return (this.keptRings ?? madeRings.get(this, made)).rings;
  }
}

const made = (j: LeanJunction): { readonly tongues: readonly Ring[]; readonly rings: readonly Ring[] } => fill(j.legs, j.trims, j.ring);

/** Whether a junction's tongues and rings are the ones `fill` makes from it (checked by identity and count, never assumed). */
function filled(j: Junction): boolean {
  if (j.legs.length < 2) return false;
  let cut = 0;
  for (const trim of j.trims) if (trim > COARSE_EPS) cut++;
  const { tongues, rings } = j;
  if (tongues.length !== cut || rings[0] !== j.ring) return false;
  for (let k = 0; k < cut; k++) if (rings[k + 1] !== tongues[k]) return false;
  const capped = nodeCap(j.legs, nodeCentre(j.legs)) !== null;
  return rings.length === 1 + cut + (capped ? 1 : 0);
}

/** A junction kept small (`LeanJunction`). */
export function leanJunction(j: Junction): Junction {
  if (j instanceof LeanJunction) return j;
  const kept = filled(j) ? null
    : j.tongues.length === 0 && j.rings.length === 0 ? { tongues: EMPTY_RINGS, rings: EMPTY_RINGS } : { tongues: j.tongues, rings: j.rings };
  return new LeanJunction(j.nodeId, j.level, j.legs, j.corners, j.trims, j.ring, j.usedHullFallback, j.transition, kept);
}

/** A leg at `level` from a frame of `frames` (`JunctionLevels.frames`) and the carriageway's leg of the same road: `buildLegs`'s numbers, the same. */
function legAt(frames: readonly number[], k: number, base: Leg, level: SurfaceLevel): Leg {
  const rt = base.road;
  const startsHere = base.plusSide === 'left';
  const hwLeft = sideHalfWidth(rt, level, startsHere ? 'left' : 'right');
  const hwRight = sideHalfWidth(rt, level, startsHere ? 'right' : 'left');
  return legOf({
    seg: base.seg, far: base.far,
    origin: { x: frames[k + OX]!, y: frames[k + OY]! }, dir: { x: frames[k + DX]!, y: frames[k + DY]! },
    nrm: { x: frames[k + NX]!, y: frames[k + NY]! }, ang: frames[k + ANG]!,
    hw: symmetric(rt) ? halfWidth(rt, level) : Math.max(hwLeft, hwRight), hwLeft, hwRight,
    plusSide: base.plusSide, hwSidewalk: base.hwSidewalk, length: frames[k + LENGTH]!, typeIndex: base.typeIndex,
    direction: base.direction, approaching: base.approaching, road: rt, shift: base.shift,
  });
}

/** Whether two legs carry the same numbers and road. */
function sameLeg(a: Leg, b: Leg): boolean {
  return a.seg === b.seg && a.far === b.far && a.origin.x === b.origin.x && a.origin.y === b.origin.y && a.dir.x === b.dir.x &&
    a.dir.y === b.dir.y && a.nrm.x === b.nrm.x && a.nrm.y === b.nrm.y && a.ang === b.ang && a.hw === b.hw && a.hwLeft === b.hwLeft &&
    a.hwRight === b.hwRight && a.plusSide === b.plusSide && a.hwSidewalk === b.hwSidewalk && a.length === b.length &&
    a.typeIndex === b.typeIndex && a.direction === b.direction && a.approaching === b.approaching && a.road === b.road && a.shift === b.shift;
}

/** A ring as its run of numbers (`Ring.run`): what a message's clone keeps of it (a class's methods are not cloned, `structuredClone`). */
export type RingRun = ReturnType<Ring['run']>;
const runOf = (r: Ring): RingRun => r.run();

/** A junction as runs of numbers, for another thread (`NetworkBake`): its legs and corners packed (`packLegs`, `packCorners`), its rings as runs. */
export interface JunctionData {
  readonly nodeId: NodeId;
  readonly level: SurfaceLevel;
  readonly legs: readonly number[];
  readonly corners: readonly number[];
  readonly trims: readonly number[];
  readonly ring: RingRun;
  readonly usedHullFallback: boolean;
  readonly transition: boolean;
  /** Its tongues and rings when they are not the ones `fill` makes. */
  readonly kept: { readonly tongues: readonly RingRun[]; readonly rings: readonly RingRun[] } | null;
}

function junctionData(j: Junction, roads: RoadType[]): JunctionData {
  const kept = (leanJunction(j) as LeanJunction).keptRings;
  return {
    nodeId: j.nodeId, level: j.level, legs: packLegs(j.legs, roads), corners: packCorners(j.corners), trims: j.trims, ring: runOf(j.ring),
    usedHullFallback: j.usedHullFallback, transition: j.transition,
    kept: kept ? { tongues: kept.tongues.map(runOf), rings: kept.rings.map(runOf) } : null,
  };
}

function junctionOf(d: JunctionData, roads: readonly RoadType[]): Junction {
  const kept = d.kept ? { tongues: d.kept.tongues.map(Ring.fromRun), rings: d.kept.rings.map(Ring.fromRun) } : null;
  return new LeanJunction(d.nodeId, d.level, unpackLegs(d.legs, roads), unpackCorners(d.corners), d.trims, Ring.fromRun(d.ring), d.usedHullFallback,
    d.transition, kept);
}

/** A node's levels as plain data (`JunctionLevels.data`, `fromData`). */
export interface JunctionLevelsData {
  readonly carriageway: JunctionData | null;
  readonly present: number;
  readonly derived: number;
  readonly frames: readonly number[] | null;
  readonly kept: readonly JunctionData[];
  readonly casingRing: RingRun | null;
  /** The legs' road profiles (`packLegs`). */
  readonly roads: readonly RoadType[];
  readonly bounds: ChangeRect | null;
}

const bit = (level: SurfaceLevel): number => 1 << level;

/** Every ring a node's junctions put on any level; null for none. */
function boundsOf(byLevel: ReadonlyMap<SurfaceLevel, Junction>): ChangeRect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const junction of byLevel.values()) {
    for (const ring of junction.rings) {
      if (ring.isEmpty) continue;
      const r = ring.bbox;
      x0 = Math.min(x0, r.minX); y0 = Math.min(y0, r.minY); x1 = Math.max(x1, r.maxX); y1 = Math.max(y1, r.maxY);
    }
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

/** A node's junction at each surface level, read as the map of them it stands for (in `SURFACE_LEVELS` order). */
export class JunctionLevels implements ReadonlyMap<SurfaceLevel, Junction> {
  private constructor(
    /** The carriageway's junction (`Level.Asphalt`), when there is one. */
    private readonly carriageway: Junction | null,
    /** The levels there are (`bit`), and those of them made from the carriageway (`frames`). */
    private readonly present: number,
    private readonly derived: number,
    /** The legs of every derived level as numbers, in their own order (`FRAME` a leg). */
    private readonly frames: readonly number[] | null,
    /** The outer levels built on their own, kept whole, in level order. */
    private readonly kept: readonly Junction[],
    /** The casing's outline, kept when it is a derived level (`ringAt`). */
    private readonly casingRing: Ring | null,
    /** The box of every ring of every level, worked out as solved. */
    readonly bounds: ChangeRect | null,
  ) {}

  static readonly EMPTY = new JunctionLevels(null, 0, 0, null, [], null, null);

  /** A node's levels as one solve made them, `derived` naming those carried out from the carriageway. */
  static of(byLevel: ReadonlyMap<SurfaceLevel, Junction>, derived: ReadonlySet<SurfaceLevel>): JunctionLevels {
    if (byLevel.size === 0) return JunctionLevels.EMPTY;
    const asphalt = byLevel.get(Level.Asphalt);
    const carriageway = asphalt ? leanJunction(asphalt) : null;
    let present = 0, derivedBits = 0;
    let frames: number[] | null = null;
    const kept: Junction[] = [];
    let casingRing: Ring | null = null;
    for (const [level, j] of byLevel) {
      present |= bit(level);
      if (level === Level.Asphalt) continue;
      if (carriageway && derived.has(level)) {
        // The frames from the first level carried out; every one after must read back from them, number for number, or is kept whole.
        frames ??= framesOf(carriageway, j.legs);
        if (frames && sameLegs(legsFrom(frames, carriageway, level), j.legs)) {
          derivedBits |= bit(level);
          if (level === Level.Casing) casingRing = j.ring;
          continue;
        }
      }
      kept.push(leanJunction(j));
    }
    return new JunctionLevels(carriageway, present, derivedBits, derivedBits ? frames : null, kept, casingRing, boundsOf(byLevel));
  }

  static fromData(d: JunctionLevelsData): JunctionLevels {
    if (d.present === 0) return JunctionLevels.EMPTY;
    return new JunctionLevels(d.carriageway ? junctionOf(d.carriageway, d.roads) : null, d.present, d.derived, d.frames,
      d.kept.map((k) => junctionOf(k, d.roads)), d.casingRing ? Ring.fromRun(d.casingRing) : null, d.bounds);
  }

  data(): JunctionLevelsData {
    const roads: RoadType[] = [];
    return {
      carriageway: this.carriageway ? junctionData(this.carriageway, roads) : null, present: this.present, derived: this.derived, frames: this.frames,
      kept: this.kept.map((k) => junctionData(k, roads)), casingRing: this.casingRing ? runOf(this.casingRing) : null, bounds: this.bounds, roads,
    };
  }

  get size(): number {
    let n = 0;
    for (const level of SURFACE_LEVELS) if (this.present & bit(level)) n++;
    return n;
  }

  has(level: SurfaceLevel): boolean {
    return (this.present & bit(level)) !== 0;
  }

  get(level: SurfaceLevel): Junction | undefined {
    if (!(this.present & bit(level))) return undefined;
    if (level === Level.Asphalt) return this.carriageway ?? undefined;
    if (this.derived & bit(level)) return madeAt(level).get(this, (owner) => owner.make(level)) ?? undefined;
    return this.kept.find((j) => j.level === level);
  }

  /** A derived level made again from the frames and the carriageway (`deriveFromLegs`). */
  private make(level: SurfaceLevel): Junction | null {
    return deriveFromLegs(this.carriageway!, level, this.legsAt(level));
  }

  /** A level's legs, without making the level (`elevation.ts` reads the casing's widths at every junction). */
  legsAt(level: SurfaceLevel): readonly Leg[] {
    if (!(this.present & bit(level))) return [];
    if (level === Level.Asphalt) return this.carriageway!.legs;
    if (this.derived & bit(level)) return legsFrom(this.frames!, this.carriageway!, level);
    return this.kept.find((j) => j.level === level)!.legs;
  }

  /** A level's outline, without making the level when it is kept (the carriageway's, the casing's). */
  ringAt(level: SurfaceLevel): Ring | undefined {
    if (level === Level.Asphalt) return this.carriageway?.ring;
    if (level === Level.Casing && this.casingRing && this.derived & bit(level)) return this.casingRing;
    return this.get(level)?.ring;
  }

  /** Each level's legs' roads and trims, in level order (`networkBuild.ts` reconciles a road's ends from them), without making a level. */
  forEachTrim(visit: (level: SurfaceLevel, seg: SegmentId, trim: number) => void): void {
    for (const level of SURFACE_LEVELS) {
      if (!(this.present & bit(level))) continue;
      if (this.derived & bit(level)) {
        // A derived level's trims are the carriageway's by road (`deriveFromLegs`), its legs those of the frames.
        const trimOf = baseTrims(this.carriageway!);
        const frames = this.frames!, legs = this.carriageway!.legs;
        for (let k = 0; k < frames.length; k += FRAME) {
          const seg = legs[frames[k + BASE]!]!.seg;
          visit(level, seg, trimOf.get(seg) as number);
        }
        continue;
      }
      const j = level === Level.Asphalt ? this.carriageway! : this.kept.find((k) => k.level === level)!;
      j.legs.forEach((leg, i) => visit(level, leg.seg, j.trims[i] as number));
    }
  }

  *keys(): MapIterator<SurfaceLevel> {
    for (const level of SURFACE_LEVELS) if (this.present & bit(level)) yield level;
  }

  *values(): MapIterator<Junction> {
    for (const level of this.keys()) yield this.get(level)!;
  }

  *entries(): MapIterator<[SurfaceLevel, Junction]> {
    for (const level of this.keys()) yield [level, this.get(level)!];
  }

  [Symbol.iterator](): MapIterator<[SurfaceLevel, Junction]> {
    return this.entries();
  }

  forEach(visit: (value: Junction, key: SurfaceLevel, map: ReadonlyMap<SurfaceLevel, Junction>) => void): void {
    for (const [level, j] of this.entries()) visit(j, level, this);
  }
}

/** The frames of `legs` (a derived level's), each with the carriageway's leg of its road; null when a road has none there. */
function framesOf(carriageway: Junction, legs: readonly Leg[]): number[] | null {
  const out: number[] = [];
  for (const leg of legs) {
    const index = carriageway.legs.findIndex((l) => l.seg === leg.seg);
    if (index < 0) return null;
    out.push(index, leg.origin.x, leg.origin.y, leg.dir.x, leg.dir.y, leg.nrm.x, leg.nrm.y, leg.ang, leg.length);
  }
  return out;
}

function legsFrom(frames: readonly number[], carriageway: Junction, level: SurfaceLevel): Leg[] {
  const out: Leg[] = [];
  for (let k = 0; k < frames.length; k += FRAME) out.push(legAt(frames, k, carriageway.legs[frames[k + BASE]!]!, level));
  return out;
}

function sameLegs(a: readonly Leg[], b: readonly Leg[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameLeg(a[i]!, b[i]!)) return false;
  return true;
}
