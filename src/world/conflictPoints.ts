import { Digest } from '@core/digest';
import { segSeg } from '@core/intersect';
import type { Vec2 } from '@core/vec2';
import type { Polyline } from '@core/polyline';
import type { NodeId } from './ids';
import type { Connector, ConnectorId, Lanelet, LaneletGraph } from './lanelets';
import { m } from './units';
import { HEADING_CHORD, chordHeading } from './heading';
import { rebuildWork } from './rebuildWork';
import {
  BODY_CLASSES, BODY_ENVELOPE, type BodyClass, HEAVY, type PairMeasurer, SWEEP_STEP, type SweepSamples, pairTable,
} from './conflictTable';

/** Yielded by `ConflictIndex.prepare` while its pairs are measured off the page: nothing to do here until they come back. */
export const WAITING = 'waiting' as const;

export { BODY_CLASSES, BODY_CLASS_NAMES, BODY_ENVELOPE, type BodyClass, HEAVY } from './conflictTable';

/**
 * `cross`: the two centrelines intersect. `merge`: both end in the same lane.
 * `swept`: the centrelines never meet, but the BODIES driven along them do —
 * opposing left turns that pass too close, a bus swinging its tail across the
 * lane beside it.
 */
export type ConflictKind = 'cross' | 'merge' | 'swept';

export function bodyClassOf(length: number, width: number): BodyClass {
  for (const c of BODY_CLASSES) {
    const e = BODY_ENVELOPE[c] as { length: number; width: number };
    if (length <= e.length && width <= e.width) return c;
  }
  return HEAVY;
}

/**
 * Centre-arc interval over which a body of one class on one movement overlaps
 * the swept area of a body of another class on the other movement.
 *
 * Arc positions are of the BODY CENTRE along the movement, measured from the
 * stop line: negative while the centre is still on the approach, beyond the
 * connector length once it is on the exit lane.
 */
export interface Zone {
  readonly enter: number;
  readonly exit: number;
}

export interface ConflictPoint {
  readonly id: number;
  readonly node: NodeId;
  readonly a: ConnectorId;
  readonly b: ConnectorId;
  /** Earliest arc position of the zone along connector `a`, body front. */
  readonly sA: number;
  /** Earliest arc position of the zone along connector `b`, body front. */
  readonly sB: number;
  readonly kind: ConflictKind;
  readonly at: Vec2;
  /**
   * Zone on `a` (or `b`) for a body of class `mine` against a body of class
   * `theirs` on the other movement, or null when those two sizes never touch.
   */
  zone(on: ConnectorId, mine: BodyClass, theirs: BodyClass): Zone | null;
}

export interface ConflictRef {
  readonly point: number;
  /** Earliest front arc position of the zone, for ordering. */
  readonly s: number;
  readonly other: ConnectorId;
  readonly kind: ConflictKind;
  /**
   * Body-centre arc position past which a vehicle of each class has cleared
   * the zone against ANY vehicle on the other movement. -Infinity when that
   * class never touches it.
   */
  readonly exit: readonly number[];
}

/** Two movements out of the same lane: resolved by car-following, not claims. */
export interface Diverge {
  readonly other: ConnectorId;
  /** Centre arc past which a body of class `mine` on the OTHER movement is clear of `theirs` on this one. */
  otherExit(mine: BodyClass, theirs: BodyClass): number;
}

/**
 * How far behind its stop line the front of a waiting body is swept, world
 * units: vehicles stop a few units short of the line, and a long one turning
 * beside them swings over that much of the lane next to it (see `inRange`).
 */
const QUEUE_BACK = m(3.2);

/**
 * Where two movements through a junction physically conflict.
 *
 * This used to be the intersection of two connector CENTRELINES, which is a
 * point on paper and nothing on the road. Measured in seeded traffic on six
 * junction layouts, it missed every conflict that is not a crossing of lines:
 * opposing left turns whose bodies brush as they pass, a bus on a right turn
 * swinging over the left turn beside it, a truck clipping a through movement
 * on a skewed leg — and it released every claim when the REAR passed the
 * crossing point, while the body was still half across the other lane.
 *
 * Each movement is now swept with the real body shape the renderer draws — a
 * rectangle centred on the path and aligned to its tangent — for three size
 * classes, and a zone is the interval of body-centre positions over which that
 * rectangle overlaps the other movement's swept area. Claims are held until
 * the vehicle's centre passes the zone exit for its own size, and a smaller
 * vehicle is only held back by what could actually touch it.
 *
 * Built once per topology version, never per frame. The nesting of the classes
 * (a smaller body at a centre is contained in a larger one at the same centre)
 * is what keeps it cheap: the heavy/heavy overlap is computed first with a
 * spatial grid, and the eight other class pairs only re-test the rectangle
 * pairs that heavy/heavy found.
 */
export class ConflictIndex {
  readonly points: ConflictPoint[] = [];
  /** References held by each connector, sorted by arc position. */
  readonly byConnector = new Map<ConnectorId, ConflictRef[]>();
  /** Sibling movements from the same lane whose bodies overlap near the split. */
  readonly diverges = new Map<ConnectorId, Diverge[]>();
  /** Movements whose zone reaches a body still waiting behind its stop line. */
  readonly queueIntrusions: { a: ConnectorId; b: ConnectorId; mine: BodyClass; theirs: BodyClass }[] = [];

  /**
   * Conflict ids are resources held by live vehicles, so their meaning must
   * survive a topology rebuild.  Array positions are deliberately never
   * recycled: a connector pair that still exists keeps its id, while a new
   * pair receives a fresh one.  `points` may therefore be sparse after edits.
   */
  private readonly idByKey = new Map<string, number>();
  private nextId = 0;

  /**
   * The zones of every pair measured by the previous build, keyed by the two
   * sweeps' sampled geometry.
   *
   * `pairTable` is two thirds of a topology rebuild, and a topology rebuild ran
   * it for every pair of movements at EVERY junction on every edit. Measured on
   * a 144-segment grid: 2.0 s per road drawn, of which the one or two junctions
   * the road actually touched were a few per cent. A pair's zones depend on
   * nothing but its two sweeps, so an unchanged junction now reads back the
   * answer it already had — the same object, so the result is identical — and
   * only the movements whose geometry moved are swept again. Each build keeps
   * exactly the pairs it used, so the cache never outgrows the map.
   */
  private pairCache = new Map<string, CachedPair>();

  /**
   * The sampled frames of the movements, keyed by the three centrelines they
   * are sampled along.
   *
   * `sweepOf` walks the joined path in `SWEEP_STEP` steps, three `sampleAt`
   * calls each (the position, and the two either side that give the heading),
   * and it did that for every connector of every junction on every edit —
   * including the ones whose geometry had not moved. The frame depends on
   * nothing but the three centrelines, so it is kept and the sweep rebuilt
   * around it: the lanelets in the returned sweep are the CURRENT ones.
   */
  private sweepCache = new Map<string, Float64Array>();

  /** Every pair's zones known to this index, kept between sessions by the game (`seed`, `takeMeasured`). */
  private readonly store: KeptZones = { kept: new Map(), fresh: new Map() };

  /**
   * Zones measured in an earlier session (the game keeps them in the
   * browser, `main.ts`): a pair found here is read back, not measured. Every
   * opening measured every pair of the town again - 0.6 s on the test city.
   */
  seed(kept: ReadonlyMap<string, Float64Array | null>): void {
    for (const [key, table] of kept) if (!this.store.kept.has(key)) this.store.kept.set(key, table);
  }

  /** The zones measured since the last call, to be kept (`seed` reads them back next session). */
  takeMeasured(): Map<string, Float64Array | null> {
    const fresh = new Map(this.store.fresh);
    this.store.fresh.clear();
    return fresh;
  }

  /**
   * Measures, a pair at a time, the zones the next `build` of `graph` will
   * need and the caches do not hold yet, and leaves them in the caches; the
   * index itself is not touched. `pairTable` is about a millisecond a pair
   * and a new crossroads has a hundred pairs: done here in slices across
   * frames (`main.ts`), the build that follows reads every pair back and
   * costs a frame of its own no more.
   */
  /** Pairs measured (not read from the caches) by the last `build` and the last `prepare`: for the probes. */
  readonly measured = { build: 0, prepare: 0 };

  *prepare(graph: LaneletGraph, measurer?: PairMeasurer): Generator<void | typeof WAITING, void> {
    this.measured.prepare = 0;
    /** The pairs to measure off the page (`measurer`), each key once. */
    const wanted: { key: string; a: Sweep; shapeA: SweepShape; b: Sweep; shapeB: SweepShape }[] = [];
    const asked = new Set<string>();
    for (const junction of graph.junctions.values()) {
      rebuildWork.conflicts++;
      const ids = junction.connectors.slice().sort();
      const sweeps: { sweep: Sweep; shape: SweepShape }[] = [];
      for (const id of ids) {
        const c = graph.connectors.get(id);
        if (!c) continue;
        const sweep = sweepOf(graph, c, this.sweepCache, this.sweepCache);
        if (sweep) sweeps.push({ sweep, shape: shapeOf(sweep) });
      }
      for (let i = 0; i < sweeps.length; i++) {
        for (let j = i + 1; j < sweeps.length; j++) {
          const a = sweeps[i]!, b = sweeps[j]!;
          const key = `${a.shape.hash}|${b.shape.hash}`;
          const known = this.pairCache.get(key);
          if (known && sameShape(known.a, a.shape) && sameShape(known.b, b.shape)) continue;
          const wasKept = this.store.kept.has(key);
          if (!wasKept && measurer) {
            if (!asked.has(key)) { asked.add(key); wanted.push({ key, a: a.sweep, shapeA: a.shape, b: b.sweep, shapeB: b.shape }); }
            continue;
          }
          this.pairCache.set(key, measurePair(key, a.sweep, a.shape, b.sweep, b.shape, this.store));
          if (wasKept) continue;
          this.measured.prepare++;
          yield;
        }
      }
    }
    if (!measurer || !wanted.length) return;
    // OFF THE PAGE: every new pair at once, across the measurer's workers
    // (`conflictPool.ts`), the same `pairTable` on the same samples, while
    // this thread draws and builds the rest of the town. A pair at a time
    // here, a generated city's 3.4 s of them held its opening (2026-10-14).
    // While they work this yields `WAITING`: the frame's slice ends there.
    const answer: { tables?: readonly (Float64Array | null)[]; failed?: boolean } = {};
    measurer.measure(wanted.map((w) => ({ a: w.a, b: w.b }))).then(
      (tables) => { answer.tables = tables; },
      (error: unknown) => { console.warn('[traffic] the conflict workers failed; the pairs are measured on the page', error); answer.failed = true; },
    );
    while (!answer.tables && !answer.failed) yield WAITING;
    for (let k = 0; k < wanted.length; k++) {
      const w = wanted[k]!;
      const table = answer.tables?.[k];
      this.pairCache.set(w.key, table !== undefined
        ? keepPair(w.key, w.shapeA, w.shapeB, table, this.store)
        : measurePair(w.key, w.a, w.shapeA, w.b, w.shapeB, this.store));
      this.measured.prepare++;
      if (table === undefined) yield;
    }
  }

  build(graph: LaneletGraph): void {
    this.points.length = 0;
    this.byConnector.clear();
    this.diverges.clear();
    this.queueIntrusions.length = 0;
    const previous = this.pairCache;
    const next = new Map<string, CachedPair>();
    const measuredBefore = pairsMeasured;
    const previousSweeps = this.sweepCache;
    const nextSweeps = new Map<string, Float64Array>();

    for (const junction of graph.junctions.values()) {
      rebuildWork.conflicts++;
      const ids = junction.connectors.slice().sort();
      const sweeps = new Map<ConnectorId, Sweep>();
      const shapes = new Map<ConnectorId, SweepShape>();
      for (const id of ids) {
        const c = graph.connectors.get(id);
        if (!c) continue;
        const sweep = sweepOf(graph, c, previousSweeps, nextSweeps);
        if (!sweep) continue;
        sweeps.set(id, sweep);
        shapes.set(id, shapeOf(sweep));
      }

      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = graph.connectors.get(ids[i] as ConnectorId);
          const b = graph.connectors.get(ids[j] as ConnectorId);
          const sa = a && sweeps.get(a.id);
          const sb = b && sweeps.get(b.id);
          if (!a || !b || !sa || !sb) continue;

          const pair = cachedPair(
            previous,
            next,
            sa,
            shapes.get(a.id) as SweepShape,
            sb,
            shapes.get(b.id) as SweepShape,
            this.store,
          );
          const zones = pair.zones;
          if (!zones) continue;

          if (a.fromLane === b.fromLane) {
            pushDiverge(this.diverges, a.id, b.id, zones, false);
            pushDiverge(this.diverges, b.id, a.id, zones, true);
            continue;
          }

          this.recordIntrusions(a.id, b.id, zones);

          let kind: ConflictKind = 'swept';
          let at: Vec2;
          if (a.toLane === b.toLane) {
            kind = 'merge';
            at = sa.path.sampleAt(sa.crossing.length).p;
          } else {
            // Both depend only on the two sweeps, so they are kept with the pair.
            if (pair.crossing === undefined) {
              pair.crossing = firstCrossing(sa.crossing.centre.toPoints(), sb.crossing.centre.toPoints());
            }
            if (pair.crossing) {
              kind = 'cross';
              at = pair.crossing.at;
            } else {
              pair.centre ??= zoneCentre(sa, zones);
              at = pair.centre;
            }
          }
          this.add(junction.node, a.id, b.id, kind, at, zones);
        }
      }
    }

    this.measured.build = pairsMeasured - measuredBefore;
    this.pairCache = next;
    this.sweepCache = nextSweeps;
    // The zones kept from other maps and from roads since undone stay in
    // memory only while they are few next to this map's own.
    if (this.store.kept.size > 4 * next.size + 4096) {
      for (const key of this.store.kept.keys()) if (!next.has(key) && !this.store.fresh.has(key)) this.store.kept.delete(key);
    }
    for (const list of this.byConnector.values()) list.sort((p, q) => p.s - q.s);
  }

  private recordIntrusions(a: ConnectorId, b: ConnectorId, zones: PairZones): void {
    for (const mine of BODY_CLASSES) {
      for (const theirs of BODY_CLASSES) {
        const onA = zones.get(mine, theirs, false);
        if (onA && onA.enter + (BODY_ENVELOPE[mine]?.length ?? 0) / 2 <= 0) {
          this.queueIntrusions.push({ a, b, mine, theirs });
        }
        const onB = zones.get(theirs, mine, true);
        if (onB && onB.enter + (BODY_ENVELOPE[theirs]?.length ?? 0) / 2 <= 0) {
          this.queueIntrusions.push({ a: b, b: a, mine: theirs, theirs: mine });
        }
      }
    }
  }

  private add(
    node: NodeId,
    a: ConnectorId,
    b: ConnectorId,
    kind: ConflictKind,
    at: Vec2,
    zones: PairZones,
  ): void {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    // The key is the connector pair: a pair changing from a line crossing to a
    // swept conflict after an edit is still the same resource.
    const key = `${node}|${lo}|${hi}`;
    let id = this.idByKey.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.idByKey.set(key, id);
    }

    const sA = earliestFront(zones, false);
    const sB = earliestFront(zones, true);
    const point: ConflictPoint = {
      id,
      node,
      a,
      b,
      sA,
      sB,
      kind,
      at,
      zone: (on, mine, theirs) =>
        on === a ? zones.get(mine, theirs, false) : on === b ? zones.get(mine, theirs, true) : null,
    };
    // Assignment rather than push preserves the stable (possibly sparse) id.
    this.points[id] = point;
    pushRef(this.byConnector, a, { point: id, s: sA, other: b, kind, exit: clearExits(zones, false) });
    pushRef(this.byConnector, b, { point: id, s: sB, other: a, kind, exit: clearExits(zones, true) });
  }

  refs(connector: ConnectorId): readonly ConflictRef[] {
    return this.byConnector.get(connector) ?? [];
  }

  divergesOf(connector: ConnectorId): readonly Diverge[] {
    return this.diverges.get(connector) ?? [];
  }

  /** True when the two connectors have at least one conflict point. */
  conflict(a: ConnectorId, b: ConnectorId): boolean {
    for (const r of this.refs(a)) if (r.other === b) return true;
    return false;
  }
}

// ------------------------------------------------------------------ sweeps

/** A movement's sweep (`conflictTable.ts` `SweepSamples`) and the lanelets it was sampled along. */
interface Sweep extends SweepSamples {
  readonly crossing: Lanelet;
  /** Approach, movement and exit joined, parametrised from the stop line. */
  readonly path: { sampleAt(c: number): { p: Vec2; t: Vec2 } };
}

function sweepOf(graph: LaneletGraph, c: Connector,
  previous: Map<string, Float64Array>, next: Map<string, Float64Array>): Sweep | null {
  const inbound = graph.lanelet(c.fromLane);
  const crossing = graph.lanelet(c.lanelet);
  const outbound = graph.lanelet(c.toLane);
  if (!inbound || !crossing || !outbound) return null;

  const path = joinedPath(inbound.centre, crossing.centre, outbound.centre);
  const heavy = BODY_ENVELOPE[HEAVY] as { length: number; width: number };
  // From a heavy body standing a little short of its stop line (`QUEUE_BACK`).
  const c0 = -heavy.length / 2 - QUEUE_BACK;
  const c1 = crossing.length + heavy.length / 2;
  const count = Math.max(2, Math.ceil((c1 - c0) / SWEEP_STEP) + 1);

  // The frame is a function of the three centrelines alone, so a movement
  // whose road was not touched reads back the samples it already had.
  // Each centreline's digest is kept with it (a polyline never changes): the
  // approach lanes are long, and digesting them again for every movement of
  // every junction on every build was most of a build where nothing moved.
  const key = `${new Digest().add(lineDigest(inbound.centre.xy)).add(lineDigest(crossing.centre.xy))
    .add(lineDigest(outbound.centre.xy)).add(count).value()}`;
  let frame = previous.get(key) ?? next.get(key);
  if (!frame) {
    frame = new Float64Array(count * 4);
    for (let i = 0; i < count; i++) {
      const at = c0 + i * SWEEP_STEP;
      const f = path.sampleAt(at);
      // Pointed along the same chord the drawn body is (`HEADING_CHORD`).
      const t = chordHeading(path.sampleAt(at - HEADING_CHORD).p, path.sampleAt(at + HEADING_CHORD).p, f.t);
      frame[i * 4] = f.p.x;
      frame[i * 4 + 1] = f.p.y;
      frame[i * 4 + 2] = t.x;
      frame[i * 4 + 3] = t.y;
    }
  }
  next.set(key, frame);
  let frameLengthSq = FRAME_LENGTHS.get(frame);
  if (!frameLengthSq) {
    frameLengthSq = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const x = frame[i * 4 + 2]!, y = frame[i * 4 + 3]!;
      frameLengthSq[i] = x * x + y * y;
    }
    FRAME_LENGTHS.set(frame, frameLengthSq);
  }
  return { crossing, path, c0, count, length: crossing.length, frame, frameLengthSq, bounds: null, grid: null, range: null };
}

const FRAME_LENGTHS = new WeakMap<Float64Array, Float64Array>();

/** Everything `pairTable` reads from a sweep. Two equal shapes give equal zones. */
interface SweepShape {
  /** Hash of the fields below, for the cache key; equality is still checked in full. */
  readonly hash: string;
  readonly c0: number;
  readonly count: number;
  readonly length: number;
  readonly frame: Float64Array;
  /** The crossing's own centreline, which `firstCrossing` reads between samples. */
  readonly centre: Float64Array;
}

interface CachedPair {
  readonly a: SweepShape;
  readonly b: SweepShape;
  readonly zones: PairZones | null;
  /** Where the two centrelines first cross; undefined until asked. */
  crossing?: { sA: number; sB: number; at: Vec2 } | null;
  /** Middle of the heavy-body zone on `a`; undefined until asked. */
  centre?: Vec2;
}

const LINE_DIGESTS = new WeakMap<Float64Array, number>();
function lineDigest(xy: Float64Array): number {
  let value = LINE_DIGESTS.get(xy);
  if (value === undefined) {
    value = new Digest().addAll(xy).value();
    LINE_DIGESTS.set(xy, value);
  }
  return value;
}

/**
 * The shape of a sweep, kept with its frame: a movement whose frame came back
 * from the cache hands back the same shape object, so its hash is not taken
 * again and a cached pair is confirmed by identity (`sameShape`).
 */
const SHAPES = new WeakMap<Float64Array, SweepShape>();
function shapeOf(s: Sweep): SweepShape {
  const kept = SHAPES.get(s.frame);
  if (kept && kept.centre === s.crossing.centre.xy && kept.count === s.count && kept.c0 === s.c0 && kept.length === s.crossing.length) {
    return kept;
  }
  const shape = measureShape(s);
  SHAPES.set(s.frame, shape);
  return shape;
}

function measureShape(s: Sweep): SweepShape {
  // Only a key: a collision costs a recompute, never a wrong answer, because a
  // hit is confirmed by `sameShape`. It was a plain FNV-1a over the bytes,
  // which mirrored movements beat: negating a double flips only its top bit,
  // a multiply never carries a top bit down, and the flips cancelled in
  // pairs - so in a town laid out symmetrically about the origin every
  // movement shared its key with its mirror image, the two threw each other
  // out of the cache, and every rebuild measured some six hundred pairs
  // again (a third of a second). `Digest` mixes its words.
  const h = new Digest().addAll(s.frame).addAll(s.crossing.centre.xy).value();
  return {
    hash: `${h.toString(36)}:${s.count}:${s.c0}:${s.crossing.length}`,
    c0: s.c0,
    count: s.count,
    length: s.crossing.length,
    frame: s.frame,
    centre: s.crossing.centre.xy,
  };
}

function sameShape(p: SweepShape, q: SweepShape): boolean {
  if (p === q) return true;
  if (p.count !== q.count || p.c0 !== q.c0 || p.length !== q.length) return false;
  return sameValues(p.frame, q.frame) && sameValues(p.centre, q.centre);
}

function sameValues(p: Float64Array, q: Float64Array): boolean {
  if (p === q) return true;
  if (p.length !== q.length) return false;
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
}

/** Pairs measured by `cachedPair` since the module loaded (`ConflictIndex.measured`). */
let pairsMeasured = 0;

/**
 * The zones kept from earlier sessions and those measured in this one, by
 * pair key (`kept`), and the ones measured since they were last taken to be
 * kept (`fresh`): derived data, made once and read back (Unreal's Derived
 * Data Cache: generated when missing and copied into the cache for next time).
 * The key holds both sweeps' digests (53 bits each) with their sample count,
 * start and length.
 */
interface KeptZones {
  readonly kept: Map<string, Float64Array | null>;
  readonly fresh: Map<string, Float64Array | null>;
}

/** A pair measured, or read back from an earlier session. */
function measurePair(key: string, a: Sweep, shapeA: SweepShape, b: Sweep, shapeB: SweepShape, store: KeptZones): CachedPair {
  const kept = store.kept.get(key);
  if (kept !== undefined) return { a: shapeA, b: shapeB, zones: kept && zonesOf(kept) };
  return keepPair(key, shapeA, shapeB, pairTable(a, b), store);
}

/** A pair's table just measured (here or by a worker, `ConflictIndex.prepare`), kept for this session and the next. */
function keepPair(key: string, shapeA: SweepShape, shapeB: SweepShape, table: Float64Array | null, store: KeptZones): CachedPair {
  pairsMeasured++;
  store.kept.set(key, table);
  store.fresh.set(key, table);
  return { a: shapeA, b: shapeB, zones: table && zonesOf(table) };
}

/** A pair's zones, answered from the previous build when neither sweep moved. */
function cachedPair(
  previous: Map<string, CachedPair>,
  next: Map<string, CachedPair>,
  a: Sweep,
  shapeA: SweepShape,
  b: Sweep,
  shapeB: SweepShape,
  store: KeptZones,
): CachedPair {
  const key = `${shapeA.hash}|${shapeB.hash}`;
  const known = next.get(key) ?? previous.get(key);
  if (known && sameShape(known.a, shapeA) && sameShape(known.b, shapeB)) {
    next.set(key, known);
    return known;
  }
  const pair = measurePair(key, a, shapeA, b, shapeB, store);
  next.set(key, pair);
  return pair;
}

/**
 * The approach, the movement and the exit as one arc-length parameter.
 * Beyond either end the path continues straight along its end tangent, so a
 * very short approach still places the tail of a long body somewhere sensible.
 */
function joinedPath(inbound: Polyline, crossing: Polyline, outbound: Polyline) {
  return {
    sampleAt(c: number): { p: Vec2; t: Vec2 } {
      if (c < 0) {
        const s = inbound.length + c;
        if (s >= 0) return inbound.sampleAt(s);
        const f = inbound.sampleAt(0);
        return { p: { x: f.p.x + f.t.x * s, y: f.p.y + f.t.y * s }, t: f.t };
      }
      if (c <= crossing.length) return crossing.sampleAt(c);
      const s = c - crossing.length;
      if (s <= outbound.length) return outbound.sampleAt(s);
      const f = outbound.sampleAt(outbound.length);
      const over = s - outbound.length;
      return { p: { x: f.p.x + f.t.x * over, y: f.p.y + f.t.y * over }, t: f.t };
    },
  };
}

// ------------------------------------------------------------------- zones

interface PairZones {
  /** Zone on `a` (`onB` false) or on `b` (true) for body `mine` against `theirs`. */
  get(mine: BodyClass, theirs: BodyClass, onB: boolean): Zone | null;
}

/**
 * All nine class-pair zones of two movements, or null when even two heavy
 * bodies never touch.
 */
/** A pair's zones over its table (`pairTable`): what is kept between sessions. */
function zonesOf(table: Float64Array): PairZones {
  return {
    get(mine, theirs, onB) {
      const at = onB ? (theirs * 3 + mine) * 4 + 2 : (mine * 3 + theirs) * 4;
      const enter = table[at] as number;
      if (Number.isNaN(enter)) return null;
      // Half a step either side covers the motion between two samples.
      return { enter: enter - SWEEP_STEP / 2, exit: (table[at + 1] as number) + SWEEP_STEP / 2 };
    },
  };
}

/** Earliest body-FRONT arc position at which any class enters the zone. */
function earliestFront(zones: PairZones, onB: boolean): number {
  let best = Infinity;
  for (const mine of BODY_CLASSES) {
    const z = zones.get(mine, HEAVY, onB);
    const half = (BODY_ENVELOPE[mine] as { length: number }).length / 2;
    if (z) best = Math.min(best, z.enter + half);
  }
  return best;
}

/** Per class, the centre past which the body is clear of any other body. */
function clearExits(zones: PairZones, onB: boolean): number[] {
  return BODY_CLASSES.map((mine) => {
    let exit = -Infinity;
    for (const theirs of BODY_CLASSES) {
      const z = zones.get(mine, theirs, onB);
      if (z) exit = Math.max(exit, z.exit);
    }
    return exit;
  });
}

function zoneCentre(a: Sweep, zones: PairZones): Vec2 {
  const z = zones.get(HEAVY, HEAVY, false);
  return a.path.sampleAt(z ? (z.enter + z.exit) / 2 : 0).p;
}

function pushDiverge(
  map: Map<ConnectorId, Diverge[]>,
  self: ConnectorId,
  other: ConnectorId,
  zones: PairZones,
  selfIsB: boolean,
): void {
  const entry: Diverge = {
    other,
    otherExit: (mine, theirs) => zones.get(mine, theirs, !selfIsB)?.exit ?? -Infinity,
  };
  const list = map.get(self);
  if (list) list.push(entry);
  else map.set(self, [entry]);
}

function pushRef(
  map: Map<ConnectorId, ConflictRef[]>,
  key: ConnectorId,
  ref: ConflictRef,
): void {
  const list = map.get(key);
  if (list) list.push(ref);
  else map.set(key, [ref]);
}

/** First intersection between two polylines, with arc positions on each. */
function firstCrossing(
  a: readonly Vec2[],
  b: readonly Vec2[],
): { sA: number; sB: number; at: Vec2 } | null {
  let sA = 0;
  for (let i = 0; i + 1 < a.length; i++) {
    const a0 = a[i] as Vec2;
    const a1 = a[i + 1] as Vec2;
    const segA = Math.hypot(a1.x - a0.x, a1.y - a0.y);

    let sB = 0;
    for (let j = 0; j + 1 < b.length; j++) {
      const b0 = b[j] as Vec2;
      const b1 = b[j + 1] as Vec2;
      const segB = Math.hypot(b1.x - b0.x, b1.y - b0.y);
      const hit = segSeg(a0, a1, b0, b1);
      if (hit) {
        return { sA: sA + hit.t * segA, sB: sB + hit.u * segB, at: hit.point };
      }
      sB += segB;
    }
    sA += segA;
  }
  return null;
}
