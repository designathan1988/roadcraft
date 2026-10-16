import { Rng, type RngState } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { type Signature, bodySignature, madeToMeasure, signatureDistance } from '@world/buildings/procedural';
import type { BlueprintBody } from '@world/buildings/blueprints';
import type { Era } from '@world/buildings/architecture';
import { METERS_PER_UNIT } from '@world/units';
import { driveSide as driveSideOf, furnishLot, garageRamp, lotKind, planLot, yardRamp } from './lotPlan';
import { MAX_ELEMENTS, type Building, type BuildingElement, type BuildingId, type Volume } from '@world/buildings/types';
import { type RoadReach, type SiteContext, type SiteReads, siteOf, validateOn } from '@world/buildings/validate';
import type { NeighbourSource } from '@world/buildings/neighbours';
import type { RoadDoc } from '@world/doc';
import { m, stepsIn } from '@world/units';
import type { ZoneDensity } from '@world/zones';
import { type Lot, lotBuildFrame, lotCentre } from '@world/lots';
import { MIN_SIZE, buildingBounds } from '@world/buildings/geometry';
import { intersection } from '@core/clipper';
import { pointInPolygon } from '@core/polygon';
import { Level, halfWidth } from '@world/roadTypes';
import { rectAround, type ChangeRect } from '@world/changes';
import { MAX_PROJECTION } from '@world/buildings/types';
import { groundElements } from '@world/buildings/elements';
import { AREA_EPS, overlapArea, validOutline } from '@world/buildings/footprints';
import { THRESHOLD } from '@world/buildings/foundation';
import { garageUnder, stepToSlope } from '@world/buildings/splitLevel';

const BOUNDARY_PARTS = new Set(['wall', 'fence', 'hedge', 'railing']);
const JOINT = 0;
/** A lot's side in metres, to the millimetre, for the plans made in metres (`planLot`, `madeToMeasure`, `furnishLot`). */
const metresOf = (units: number): number => Math.round(units * METERS_PER_UNIT * 1000) / 1000;

/** A site a building is grown on: what its checks read, and the id the building will take (its draft's). */
export interface GrowthSite extends SiteReads {
  readonly nextId: BuildingId;
}

/** The document's site for a building grown now. */
const growthSiteOf = (ctx: SiteContext): GrowthSite => ({ ...siteOf(ctx), nextId: ctx.doc.buildings.nextId });

/** A grown building checked on its site, its boundary meeting the neighbours': where a piece of its wall or fence stands against a neighbour's own building or boundary - the neighbour's wall already closes that stretch, as on any party line - the piece is left out and the building checked again. The boundary is closed whole on the lot's own side (`lotPlan.ts`), and a neighbour standing on the line was refused the whole building for it. The record that stands, or null; nothing is written. */
function placed(site: GrowthSite, record: Omit<Building, 'id'>): Omit<Building, 'id'> | null {
  const first = validateOn(site, { ...record, id: site.nextId } as Building);
  if (first === null) return record;
  if (first !== 'building') return null;
  const probe = { ...record, id: -1 } as unknown as Building;
  const box = buildingBounds(probe, m(2));
  const theirs: (readonly Vec2[])[] = [];
  // The buildings by place (`BuildingStore.near`), not the town; the same box test. Their footprints and ground elements, worked out once per record (`neighbours.ts`), not their projections.
  for (const o of site.neighbours.near(box.minX, box.minY, box.maxX, box.maxY)) {
    const ob = o.bounds;
    if (ob.minX > box.maxX || ob.maxX < box.minX || ob.minY > box.maxY || ob.maxY < box.minY) continue;
    for (let k = 0; k < o.obstacles.length; k++) if (k < o.footprints || k >= o.footprints + o.projections) theirs.push(o.obstacles[k]!.ring);
  }
  const elements = (record.elements ?? []).filter((e) => {
    if (!BOUNDARY_PARTS.has(e.kind)) return true;
    const ring = groundElements({ ...probe, elements: [e] }, -m(0.05))[0];
    return !ring || !theirs.some((c) => overlapArea(ring, c as Vec2[]) > AREA_EPS);
  });
  if (elements.length === (record.elements ?? []).length) return null;
  const again = { ...record, elements };
  return validateOn(site, { ...again, id: site.nextId } as Building) === null ? again : null;
}

/** The growth's version (`version.ts`). */
export { LOT_PLAN_VERSION } from './version';

/** The ground floor a grown building on a lot will have: its street's paving along the lot's front (`street`, a try's points, `trySites`), and a threshold over it (`foundation.ts` `floorOver`). With no paving to read, the land at the front less the drop the roads shape it by. */
function streetFloor(pavedAt: ((x: number, y: number) => number) | undefined, street: readonly Vec2[], local: (lx: number, ly: number) => Vec2, ground: (x: number, y: number) => number): number {
  let best = -Infinity;
  if (pavedAt) {
    for (const p of street) {
      const h = pavedAt(p.x, p.y);
      if (Number.isFinite(h)) best = Math.max(best, h);
    }
  }
  if (Number.isFinite(best)) return best + THRESHOLD;
  const p = local(0, m(0.5));
  return ground(p.x, p.y) + m(0.6);
}

/** Grows one building on a zoned lot without one (`world/lots.ts`): the lot is planned first - front, sides, back - and the building made for the envelope the plan leaves, as on a grid lot (`growOnce`), but on the lot the player drew: its front middle, its facing, its width and depth. */
/** Candidates made for a lot, the least like its neighbours kept (Mitchell's best candidate). */
const CANDIDATES = 4;
/** How far round a lot the buildings it should not look like are read: the 100 m of the rule it answers (`tests/world/variety.spec.ts`; at 90 m a twin 95 m off went unseen). */
export const LIKE_REACH = m(100);
/** How far beyond a footway's edge a point still counts as on the street, for a corner lot (`cornerOf`). */
const STREET_MARGIN = m(0.6);
/** How near the last building grown an open lot must be to grow next (the street filling along). */
export const GROW_ON_REACH = m(70);

/** How far `a` is from `b`. */
function apart(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The buildings round a point: each one's signature (worked out once per record, `neighbours.ts`) and how far it stands. */
function nearSignatures(neighbours: NeighbourSource, at: Vec2): { signature: Signature; distance: number }[] {
  const out: { signature: Signature; distance: number }[] = [];
  for (const b of neighbours.near(at.x - LIKE_REACH, at.y - LIKE_REACH, at.x + LIKE_REACH, at.y + LIKE_REACH)) {
    const d = apart(b, at);
    if (d < LIKE_REACH) out.push({ signature: b.signature, distance: d });
  }
  return out;
}

/** How unlike its surroundings a building would be: its least distance in looks to any of them, a building farther away counting as more unlike (a twin across the town is no twin). */
function unlikeness(body: Building | Omit<Building, 'id' | 'x' | 'y' | 'rotation'>, near: readonly { signature: Signature; distance: number }[]): number {
  const mine = bodySignature(body);
  let least = Infinity;
  for (const n of near) least = Math.min(least, signatureDistance(mine, n.signature) + 2.5 * (n.distance / LIKE_REACH));
  return least;
}

/** Storeys of the buildings beside a lot's front (within its width and a little), tallest block each. */
function neighbourStoreys(neighbours: NeighbourSource, anchor: Vec2, width: number): number[] {
  const out: number[] = [];
  const reach = width + m(12);
  for (const b of neighbours.near(anchor.x - reach, anchor.y - reach, anchor.x + reach, anchor.y + reach)) {
    if (apart(b, anchor) > reach) continue;
    if (b.storeys > 0) out.push(b.storeys);
  }
  return out;
}

/** The side of a lot (`left`: along -u from the front's middle) with a street just beyond it over most of its depth: a corner lot. Undefined for none, or with no network to read. */
function cornerOf(net: RoadReach | null, anchor: Vec2, u: Vec2, n: Vec2, width: number, depth: number): 'left' | 'right' | undefined {
  if (!net) return undefined;
  // The ribbons filed round the point (`Network.ribbonsMeeting`): a ribbon within its footway and the margin of it has its box, which holds the footway, within the margin of the point. Not every ribbon of the map, filtered for each lot grown.
  const onStreet = (p: Vec2): boolean => net.ribbonsMeeting([p.x - STREET_MARGIN, p.y - STREET_MARGIN, p.x + STREET_MARGIN, p.y + STREET_MARGIN]).some((r) => {
    if (net.doc.segment(r.id)?.structure !== 'ground') return false;
    const bb = r.full.bbox, reach = halfWidth(r.road, Level.Sidewalk) + STREET_MARGIN;
    if (p.x < bb.minX - reach || p.x > bb.maxX + reach || p.y < bb.minY - reach || p.y > bb.maxY + reach) return false;
    return r.full.distanceTo(p) < reach;
  });
  for (const [side, sign] of [['left', -1], ['right', 1]] as const) {
    const along = sign * (width / 2 + m(2));
    const hits = [0.35, 0.65].filter((k) => onStreet({ x: anchor.x + u.x * along + n.x * depth * k, y: anchor.y + u.y * along + n.y * depth * k })).length;
    if (hits === 2) return side;
  }
  return undefined;
}

/** The street side and the quarter a lot belongs to, for its building's style (`world/buildings/architecture.ts`): `character` the same for the lots of one side of a street within some 60 m (one frontage reads as one), `era` the same over a quarter of about 220 m - its period, old towards the middle of the map more often, new towards the edges. */
function quarterOf(anchor: Vec2, n: Vec2): { character: number; era: Era } {
  const hash = (a: number, b: number, c: number): number => {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x3c6ef372);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return (h ^ (h >>> 13)) >>> 0;
  };
  const facing = Math.round(Math.atan2(n.y, n.x) / (Math.PI / 2));
  const cx = anchor.x, cy = anchor.y;
  const central = Math.hypot(anchor.x, anchor.y) < m(450);
  const character = hash(Math.floor(stepsIn(cx, 60)), Math.floor(stepsIn(cy, 60)), facing + 11);
  const q = hash(Math.floor(stepsIn(cx, 220)), Math.floor(stepsIn(cy, 220)), 5) / 4_294_967_296;
  const era: Era = central ? (q < 0.5 ? 0 : q < 0.8 ? 1 : 2) : (q < 0.15 ? 0 : q < 0.5 ? 1 : 2);
  return { character, era };
}

/** A handful of tries, each a building made: a few milliseconds apiece (`designOnLot`). */
const TRIES = [
  { front: 0, side: 0, shrink: 1 }, { front: m(1.5), side: 0, shrink: 1 }, { front: m(3), side: m(1), shrink: 0.9 },
  { front: m(3), side: m(1), shrink: 0.75 }, { front: m(4), side: m(1.5), shrink: 0.6 }, { front: m(4), side: m(1.5), shrink: 0.45 },
] as const;

/** One try's site on a lot: the lot as the try takes it (its width and depth, world units and metres), its front middle set back by the try's front margin, the lot's frame there (`local`: x along the front, y back into it) and the points its street's paving is read at (`streetFloor`). The same for every density of the lot; worked out by the page too, which reads the paving there for the growth's worker (`streetPointsOf`). */
interface TrySite {
  readonly t: (typeof TRIES)[number];
  readonly lotW: number;
  readonly lotD: number;
  readonly W: number;
  readonly D: number;
  readonly anchor: Vec2;
  readonly local: (lx: number, ly: number) => Vec2;
  readonly street: readonly Vec2[];
}

/** A lot's frame (`lotBuildFrame`) with its axes: `u` along the front, `n` back into it. */
function frameOf(lot: Pick<Lot, 'corners'>): ReturnType<typeof lotBuildFrame> & { readonly u: Vec2; readonly n: Vec2 } {
  const frame = lotBuildFrame(lot);
  const u = { x: Math.cos(frame.rotation), y: Math.sin(frame.rotation) };
  return { ...frame, u, n: { x: -u.y, y: u.x } };
}

function trySites(frame: ReturnType<typeof frameOf>): TrySite[] {
  const { u, n } = frame;
  return TRIES.map((t) => {
    const lotW = (frame.width - JOINT - 2 * t.side) * t.shrink;
    const lotD = (frame.depth - m(0.3) - t.front) * t.shrink;
    // The lot's front middle, set back by the try's front margin.
    const anchor = { x: frame.anchor.x + n.x * t.front, y: frame.anchor.y + n.y * t.front };
    const local = (lx: number, ly: number): Vec2 => ({ x: anchor.x + u.x * lx + n.x * ly, y: anchor.y + u.y * lx + n.y * ly });
    // Set back from the lot's front, the street is still read beyond the lot, not beyond the plan.
    const street = [-0.3, 0, 0.3].map((k) => local(lotW * k, -t.front - m(0.6)));
    return { t, lotW, lotD, W: metresOf(lotW), D: metresOf(lotD), anchor, local, street };
  });
}

/** Every point a lot's growth reads its street's paving at (`streetFloor`): what the page reads for the growth's worker. */
export function streetPointsOf(lot: Pick<Lot, 'corners'>): Vec2[] {
  return trySites(frameOf(lot)).flatMap((site) => site.street);
}

/** How far round a lot what it is built and checked against is read: its ground, its roads, the buildings it meets. */
const LOT_READ_MARGIN = m(16);

/** Where a lot's growth reads the document (`designOnLot`): `lot`, the lot and its frame with a margin - its ground, the roads and the buildings its tries are checked against; `around`, the buildings its looks and height are chosen against (`LIKE_REACH` round its front). What the page sends the growth's worker for it (`editor/growthFeed.ts`). */
export function growthReachOf(lot: Pick<Lot, 'corners'>): { readonly lot: ChangeRect; readonly around: ChangeRect } {
  const frame = frameOf(lot);
  const { u, n, anchor } = frame;
  const half = frame.width / 2;
  const box = rectAround([
    ...lot.corners,
    { x: anchor.x - u.x * half, y: anchor.y - u.y * half }, { x: anchor.x + u.x * half, y: anchor.y + u.y * half },
    { x: anchor.x - u.x * half + n.x * frame.depth, y: anchor.y - u.y * half + n.y * frame.depth },
    { x: anchor.x + u.x * half + n.x * frame.depth, y: anchor.y + u.y * half + n.y * frame.depth },
  ], LOT_READ_MARGIN + MAX_PROJECTION)!;
  return { lot: box, around: [anchor.x - LIKE_REACH, anchor.y - LIKE_REACH, anchor.x + LIKE_REACH, anchor.y + LIKE_REACH] };
}

/** The lot a building grows on next, and the stream it is made with. */
export interface LotPick {
  readonly lot: Lot;
  readonly rng: Rng;
}

/** The stream the next building is made with, its first draw the open lot drawn at random (of `count`): seeded by the id the building will take, so a city zoned the same way grows the same way. */
export function lotStream(seed: number, nextId: number, count: number): { readonly rng: Rng; readonly drawn: number } {
  const rng = new Rng((seed ^ Math.imul(nextId, 0x9e3779b1)) >>> 0);
  return { rng, drawn: rng.int(0, count - 1) };
}

/** The open lot nearest the last building grown, within `GROW_ON_REACH` (the street fills along), or null: none so near. `near`: the open lots that may be (a superset), in the lots' order. */
export function nearestLot(near: Iterable<Lot>, last: Vec2): Lot | null {
  let best = GROW_ON_REACH, lot: Lot | null = null;
  // Nearer by a millimetre at least: two lots as near (a street's two sides) are told apart by the list's order, not by rounding - which took one at 0.4 m a unit and the other at 1.
  for (const l of near) {
    const d = apart(lotCentre(l), last);
    if (d < best - m(0.001)) { best = d; lot = l; }
  }
  return lot;
}

/** The lot the next building grows on (`growOnLot`): the open lot nearest the last building grown, when one is near (the street fills along), a lot at random otherwise; null when none is open, `refused` set aside. */
export function pickLot(doc: RoadDoc, refused: Set<number>, seed: number): LotPick | null {
  // The open lots kept by the document (`world/openLots.ts`): the lot drawn, the last grown and the ones round it without reading every lot.
  const open = doc.openLots;
  const count = open.count(refused);
  if (!count) return null;
  const { rng, drawn } = lotStream(seed, doc.buildings.nextId, count);
  // The street fills along: the open lot nearest the last building grown, when one is near (the player sees the street they zoned fill in, one house after the next); anywhere else, a lot at random.
  const last = open.lastGrown();
  const lot = (last ? nearestLot(open.near(last, GROW_ON_REACH), last) : null) ?? open.at(drawn);
  return { lot, rng };
}

/** WHAT A GROWN BUILDING IS (the city-game's rule: a building is a few numbers and a versioned generator, `LOT_PLAN_VERSION`): the choices `designOnLot` made for it on its lot, from which `replayOnLot` makes the very same record again without its neighbours, its roads or its paving. */
export interface GrownChoice {
  /** The stream at the start of the try that stood (`Rng.state`). */
  readonly state: RngState;
  /** Of the lot's densities (its own, then each lower) and of `TRIES`. */
  readonly density: number;
  readonly attempt: number;
  /** A street along a side (`cornerOf`): 0 none, 1 left, 2 right. */
  readonly corner: 0 | 1 | 2;
  /** Candidates made and the one kept (`unlikeness` against the buildings round it). */
  readonly made: number;
  readonly kept: number;
  /** The storeys beside the lot's front its envelope read (`neighbourStoreys`). */
  readonly neighbours: readonly number[];
  /** Its ground floor over the street (`streetFloor`), world units; NaN when its try read none. */
  readonly floor: number;
  /** 1 when its front was carried out to the street (`reachStreet`), 0 when the plan as laid stood. */
  readonly reach: 0 | 1;
  /** The boundary pieces left out against a neighbour's (`placed`), by their place in its elements. */
  readonly dropped: readonly number[];
}

/** A try's body as made: its parts, the plan as laid before it was carried to the street, the lot in its frame, the candidates made and kept, the floor read. */
interface Tried {
  readonly body: BlueprintBody;
  readonly bare: { volumes: Volume[]; elements: BuildingElement[] | undefined } | null;
  readonly ring: Vec2[];
  readonly made: number;
  readonly kept: number;
  readonly floor: number;
}

/** One try on a lot made whole (`designOnLot`): the plan laid, the candidates made and one kept, the yards furnished, carried to the street and fitted to the lot; null when the try has no room or its yards cannot be furnished. Unchecked against the site: the same inputs make the same body. */
function tryOnLot(lot: Lot, frame: ReturnType<typeof frameOf>, density: ZoneDensity, at: TrySite, rng: Rng, corner: 'left' | 'right' | undefined, neighbours: readonly number[],
  ground: ((x: number, y: number) => number) | null | undefined, floorOf: (street: readonly Vec2[], local: (lx: number, ly: number) => Vec2) => number,
  pick: { readonly near: readonly { signature: Signature; distance: number }[] } | { readonly made: number; readonly kept: number }): Tried | null {
  const use = lot.use!;
  const { u, n } = frame;
  const { t, lotW, W, D, anchor, local, street } = at;
  if (W < 4 || D < 4) return null;
  const plan = planLot(lotKind(use, density), W, D, rng, corner);
  const env = plan.building;
  const driveSide = plan.left.use === 'drive' || plan.left.use === 'drivePath' ? 'left' as const
    : plan.right.use === 'drive' || plan.right.use === 'drivePath' ? 'right' as const : undefined;
  const envelope = {
    W: env.x1 - env.x0, D: env.y1 - env.y0,
    backDoor: plan.back.use !== 'none' && plan.back.use !== 'loading',
    ...quarterOf(frame.anchor, n),
    ...(driveSide ? { driveSide } : {}),
    neighbours: [...neighbours],
  };
  // Of a few candidates, the one least like the buildings round it (Mitchell's best candidate, in the space of what a building looks like): drawn at random, a street still came out with twins side by side. Replayed: as many made, the same kept.
  let made = madeToMeasure(use, density, envelope, rng);
  let count = 1, kept = 0;
  if ('near' in pick) {
    if (pick.near.length) {
      let score = unlikeness(made.body, pick.near);
      for (let k = 1; k < CANDIDATES; k++) {
        const other = madeToMeasure(use, density, envelope, rng);
        const s = unlikeness(other.body, pick.near);
        if (s > score) { score = s; made = other; kept = k; }
      }
      count = CANDIDATES;
    }
  } else {
    for (let k = 1; k < pick.made; k++) {
      const other = madeToMeasure(use, density, envelope, rng);
      if (k === pick.kept) made = other;
    }
    count = pick.made;
    kept = pick.kept;
  }
  const body = made.body;
  const dx = m(env.x0 - W / 2), dy = m(env.y0);
  for (const v of body.volumes) { v.x += dx; v.y += dy; }
  for (const e of body.elements ?? []) { e.x += dx; e.y += dy; }
  for (const c of body.cores ?? []) { c.x += dx; c.y += dy; }
  for (const v of body.volumes) {
    if (v.outline) continue;
    const x0 = Math.max(v.x, -lotW / 2), x1 = Math.min(v.x + v.w, lotW / 2);
    if (x1 - x0 > m(1)) { v.x = x0; v.w = x1 - x0; }
  }
  // How the land falls or rises from the street to the middle of the back yard, metres: a yard on a hillside is terraced (`furnishLot`).
  const yardY = m(D - plan.back.depth / 2);
  // The building follows its hillside (`splitLevel.ts`): its back a half or a whole storey from the street floor where the ground under it calls for it, as CityEngine moves each footprint to the terrain before the ground is graded round it. A car park or a loading yard behind goes to the back's level with it, its ground counted in the choice, and only as far as its drive can reach as a ramp (`yardRamp`): the drive from the street is level behind the gate, then a ramp no steeper than its traffic takes.
  let split: { y: number; lift: number } | undefined;
  let garage: { x: number; y: number; w: number } | undefined;
  let landAt: ((x: number, y: number) => number) | undefined;
  let floorRead = Number.NaN;
  const yardBack = plan.back.use === 'parking' || plan.back.use === 'loading';
  const ramp = yardBack ? yardRamp(plan) : null;
  if (ground && (!yardBack || ramp)) {
    const floor = floorRead = floorOf(street, local);
    // The natural ground about the street floor at a point of the lot (metres, the lot's frame).
    landAt = (x, y) => { const p = local(m(x - W / 2), m(y)); return (ground(p.x, p.y) - floor) * METERS_PER_UNIT; };
    const step = stepToSlope(body, {
      groundAt: (lx, ly) => { const p = local(lx, ly); return ground(p.x, p.y); },
      floor, x0: m(env.x0 - W / 2), x1: m(env.x1 - W / 2),
      ...(ramp ? { yard: { x0: m(-W / 2), y0: m(ramp.end), x1: m(W / 2), y1: m(D) }, maxLift: m(ramp.grade * (ramp.end - ramp.start)) } : {}),
    });
    if (step) split = { y: step.y / m(1), lift: step.lift / m(1) };
    // A house a whole storey down its hillside, with a drive: its garage in the lower ground floor, on the drive's side (`garageUnder`), when the drive can go down that far as a ramp (`garageRamp`) and the garden has room for the apron before the door.
    const way = step && step.steps === -2 ? garageRamp(plan) : null;
    const side = driveSideOf(plan);
    const hasGarage = body.volumes.some((v) => v.storeys.some((s) => Object.values(s.facade.bays ?? {}).includes('garageDoor') || s.facade.fill === 'garageDoor'));
    if (step && way && side && !hasGarage && plan.back.depth >= 7 && -step.lift <= m(way.grade * (way.end - way.start))) {
      const door = garageUnder(body, side);
      if (door) garage = { x: door.x / m(1) + W / 2, y: door.y / m(1), w: door.w / m(1) };
    }
  }
  // How the land falls across the back zone, from its front to the lot's back (a car park keeps a little of it).
  const backFall = ground && plan.back.depth > 0
    ? (ground(local(0, m(D - 0.5)).x, local(0, m(D - 0.5)).y) - ground(local(0, m(D - plan.back.depth)).x, local(0, m(D - plan.back.depth)).y)) * METERS_PER_UNIT
    : undefined;
  const hill = ground && plan.back.depth > 0
    ? { yard: (ground(anchor.x + n.x * yardY, anchor.y + n.y * yardY) - ground(anchor.x + n.x * m(0.5), anchor.y + n.y * m(0.5))) * METERS_PER_UNIT, ...(split ? { split } : {}), ...(backFall !== undefined ? { backFall } : {}), ...(garage ? { garage } : {}), ...(landAt ? { landAt } : {}) }
    : split ? { yard: split.lift, split } : undefined;
  if (!furnishLot(body, plan, made, rng, hill)) return null;
  // The lot in the building's frame: x along the front, y back into it.
  const ring = lot.corners.map((c) => ({ x: (c.x - anchor.x) * u.x + (c.y - anchor.y) * u.y, y: (c.x - anchor.x) * n.x + (c.y - anchor.y) * n.y }));
  // Set back from the street (a try's margin), its front still reaches the street (`reachStreet`); the plan as laid is kept in case that is refused.
  const bare = t.front > 0 ? structuredClone({ volumes: body.volumes, elements: body.elements }) : null;
  if (bare) reachStreet(body, t.front, lotW);
  fitToLot(body, ring);
  return { body, bare, ring, made: count, kept, floor: floorRead };
}

/** The lot's densities tried in turn: its own, then each lower. */
const densitiesOf = (lot: Lot): ZoneDensity[] => (lot.density === 'high' ? ['high', 'medium', 'low'] : lot.density === 'medium' ? ['medium', 'low'] : ['low']);

/** The building grown on a lot (`pickLot`), checked on its site, or null when nothing fits it. Writes nothing: it reads the site (`GrowthSite`) - the document's on the page, the growth's worker's off it (`editor/growthReplica.ts`) - and the same site and stream make the same record on either side. `choice`, when given, is filled with what makes it again (`replayOnLot`). @perItem Runs once a building grown: nothing it reaches may walk the map. */
export function designOnLot(site: GrowthSite, lot: Lot, rng: Rng, choice?: { value?: GrownChoice }): Omit<Building, 'id'> | null {
  const frame = frameOf(lot);
  // Every zoned lot gets a building, whatever its size or shape (the player, 2026-10-05: "tem que aparecer sempre"). The building first made for the whole lot; refused (its front over a corner's curved footway, a side over a neighbour, a slope), it is made again set back from the front and the sides, then narrower and shallower, then a density lower - until one fits.
  const { u, n } = frame;
  // A corner lot: a street along one of its sides too (the building then looks onto it, `planLot`).
  const corner = cornerOf(site.net, frame.anchor, u, n, frame.width, frame.depth);
  const densities = densitiesOf(lot);
  const sites = trySites(frame);
  // Read once, not a try: a try writes to the document only when it succeeds, and then returns, so the buildings round the lot are the same for all.
  const neighbours = neighbourStoreys(site.neighbours, frame.anchor, frame.width);
  const near = nearSignatures(site.neighbours, frame.anchor);
  const ground = site.groundAt;
  const floorOf = (street: readonly Vec2[], local: (lx: number, ly: number) => Vec2): number => streetFloor(site.pavedAt, street, local, ground!);
  for (let di = 0; di < densities.length; di++) for (let ti = 0; ti < sites.length; ti++) {
    const state = choice ? rng.state() : null;
    const tried = tryOnLot(lot, frame, densities[di]!, sites[ti]!, rng, corner, neighbours, ground, floorOf, { near });
    if (!tried) continue;
    const { body, bare, ring } = tried;
    const anchor = sites[ti]!.anchor;
    const atLot = (): Omit<Building, 'id'> => ({ ...body, x: anchor.x, y: anchor.y, rotation: frame.rotation }) as Omit<Building, 'id'>;
    let reach: 0 | 1 = 1;
    let stands = placed(site, atLot());
    if (!stands && bare) {
      // Refused with it (over a curved footway, a neighbour's yard): the plan alone, as before.
      body.volumes = bare.volumes;
      if (bare.elements) body.elements = bare.elements;
      else delete body.elements;
      fitToLot(body, ring);
      reach = 0;
      stands = placed(site, atLot());
    }
    if (!stands) continue;
    if (choice) {
      const left = new Set(stands.elements ?? []);
      choice.value = {
        state: state!, density: di, attempt: ti, corner: corner === 'left' ? 1 : corner === 'right' ? 2 : 0, made: tried.made, kept: tried.kept,
        neighbours: [...neighbours], floor: tried.floor, reach,
        dropped: (body.elements ?? []).flatMap((e, k) => (left.has(e) ? [] : [k])),
      };
    }
    return stands;
  }
  return null;
}

/** The record `designOnLot` made on a lot, made again from its choices (`GrownChoice`) alone: the same try with the same stream, the same candidate kept, the same pieces left out - no neighbour, road or paving read. `ground`: the land it was made on (a generated tile's is flat). Null when the choices do not make a building on this lot (another lot, another generator). */
export function replayOnLot(lot: Lot, choice: GrownChoice, ground: (x: number, y: number) => number): Omit<Building, 'id'> | null {
  const frame = frameOf(lot);
  const density = densitiesOf(lot)[choice.density];
  const at = trySites(frame)[choice.attempt];
  if (!density || !at) return null;
  const tried = tryOnLot(lot, frame, density, at, Rng.fromState(choice.state), choice.corner === 1 ? 'left' : choice.corner === 2 ? 'right' : undefined,
    choice.neighbours, ground, () => choice.floor, { made: choice.made, kept: choice.kept });
  if (!tried) return null;
  const { body, bare, ring } = tried;
  if (bare && choice.reach === 0) {
    body.volumes = bare.volumes;
    if (bare.elements) body.elements = bare.elements;
    else delete body.elements;
    fitToLot(body, ring);
  }
  const record = { ...body, x: at.anchor.x, y: at.anchor.y, rotation: frame.rotation } as Omit<Building, 'id'>;
  if (!choice.dropped.length) return record;
  const gone = new Set(choice.dropped);
  return { ...record, elements: (record.elements ?? []).filter((_, k) => !gone.has(k)) };
}

/** A building grown on its lot written in the document: the record added (as checked, `designOnLot`), the lot naming it (`OpenLots.grew`). Returns its id. @perItem Runs once a building grown: nothing it reaches may walk the map. */
export function commitGrown(doc: RoadDoc, lot: Lot, record: Omit<Building, 'id'>): number {
  const id = doc.buildings.add(record).id as number;
  const where = rectAround(lot.corners);
  doc.openLots.grew(lot, id, where ? [where] : null, 'building grew on its lot');
  return id;
}

/** Grows one building on a zoned lot without one (`world/lots.ts`), here on the page: the lot picked (`pickLot`), the building designed for it on the document's own site (`designOnLot`) and written (`commitGrown`); the lot set aside when nothing fits it. The city's growth and the zones' run the same steps with the design in a worker (`editor/growthFeed.ts`); this is the same growth in one call, for a probe and the specs. @perItem Runs once a building grown: nothing it reaches may walk the map. */
export function growOnLot(ctx: SiteContext, refused: Set<number>, seed: number, choice?: { value?: GrownChoice }): number | null {
  const pick = pickLot(ctx.doc, refused, seed);
  if (!pick) return null;
  const record = designOnLot(growthSiteOf(ctx), pick.lot, pick.rng, choice);
  if (record) return commitGrown(ctx.doc, pick.lot, record);
  ctx.doc.openLots.refuse(pick.lot, refused);
  return null;
}


const BOUNDARY_KINDS = new Set(['wall', 'fence', 'hedge', 'railing', 'gate']);

/** A plan set back `front` from its lot's front (a try's margin, `growOnLot`) carried out to the street: each surface along the plan's front - the forecourt, the garden, the drive - laid on across the strip, and paving where none is (a building up to the plan's front). Left bare, the strip hid the street from the building: with no paving in reach, its ground floor stood on its highest ground (`foundation.ts` `floorOver`), and up a hillside street a shop stood 4-5.6 m over the footway on a stone plinth. A shopfront has its entrance at the footway's grade (form-based codes: Fircrest's shopfront frontage, Santa Clara's first floor at 0 ft). */
function reachStreet(body: { volumes: Volume[]; elements?: BuildingElement[] }, front: number, width: number): void {
  // The surfaces along the plan's front, at the street's floor (a drive's ramp keeps its own run: a strip is laid before it instead).
  const along = body.volumes.filter((v) => v.open && !v.outline && Math.abs(v.y) < m(0.05)
    && v.ramp === undefined && !v.terrace);
  const covered: [number, number][] = [];
  for (const v of along) {
    v.y -= front;
    v.d += front;
    covered.push([v.x, v.x + v.w]);
  }
  // And the paths from the gate, out to the footway.
  for (const el of body.elements ?? []) {
    if (el.kind !== 'pavement' || el.facing % 2 !== 0 || Math.abs(el.y - el.d / 2) > m(0.05)) continue;
    el.y -= front / 2;
    el.d += front;
  }
  covered.sort((a, b) => a[0] - b[0]);
  // Paving across the rest of the front, as deep as a surface may be (it runs under the plan's front edge where the strip is narrower).
  let next = Math.max(0, ...body.volumes.map((v) => v.id)) + 1;
  const lay = (x0: number, x1: number): void => {
    if (x1 - x0 < MIN_SIZE) return;
    body.volumes.push({ id: next++, x: x0, y: -front, w: x1 - x0, d: Math.max(front, MIN_SIZE), base: 0,
      roof: 'flat', storeys: [{ facade: { fill: 'wall' } }], open: 'paving' } as Volume);
  };
  let x = -width / 2;
  for (const [a, b] of covered) {
    lay(x, Math.min(a, width / 2));
    x = Math.max(x, b);
  }
  lay(x, width / 2);
}

/** A grown building made to its lot's own shape (the player, 2026-10-05: "as construções devem seguir o formato dos lotes"). The plan was laid on the lot's front rectangle; on a lot of another shape - a polygon, a curved side, a lot narrowing or widening at the back: - the ground of the whole lot is laid as a lawn (an open block with the lot's own outline), the plan's surfaces clipped to the lot over it; - the boundary (walls, fences, hedges) is taken off the rectangle and run along the lot's own sides, all but the front; - whatever of the plan falls outside the lot (a tree, a shed, a bench, a surface) is left out. A rectangular lot is left as planned. */
function fitToLot(body: { volumes: Volume[]; elements?: BuildingElement[] }, ring: readonly Vec2[]): void {
  const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let area = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i]!, q = ring[(i + 1) % ring.length]!; area += p.x * q.y - q.x * p.y; }
  if (ring.length === 4 && Math.abs(area / 2) > (x1 - x0) * (y1 - y0) * 0.97) return;
  const inside = (p: Vec2): boolean => pointInPolygon(p, ring as Vec2[]);
  const elements = (body.elements ??= []);
  // The boundary's kind and height, from the plan's own.
  const old = elements.filter((e) => BOUNDARY_KINDS.has(e.kind) && e.kind !== 'gate');
  const front = elements.filter((e) => BOUNDARY_KINDS.has(e.kind) && Math.abs(e.y) < m(1.2));
  const kind = (old.find((e) => Math.abs(e.y) >= m(1.2))?.kind ?? old[0]?.kind ?? 'fence') as BuildingElement['kind'];
  const height = old.find((e) => e.kind === kind)?.h ?? m(1.4);
  const thick = kind === 'fence' ? m(0.12) : kind === 'hedge' ? m(0.7) : m(0.2);
  // Everything off the lot, and the side and back boundary, out.
  const kept = elements.filter((e) => (front.includes(e)) || (!BOUNDARY_KINDS.has(e.kind) && inside({ x: e.x, y: e.y })));
  let nextId = Math.max(0, ...elements.map((e) => e.id)) + 1;
  // The new boundary along every side but the front (side 0), in pieces of 20 m at most.
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const full = Math.hypot(b.x - a.x, b.y - a.y);
    if (full < m(0.5) + thick) continue;
    // Short of each corner by half its thickness: a square-ended piece met a corner not quite square (a lot cut to a street a degree off its block) a few millimetres over the line, into the neighbour's yard, and the neighbour - or this lot - was refused (the bare corner lots).
    const ux = (b.x - a.x) / full, uy = (b.y - a.y) / full;
    const len = full - thick;
    const sx = a.x + ux * thick / 2, sy = a.y + uy * thick / 2;
    const pieces = Math.ceil(stepsIn(len, 20));
    const angle = Math.atan2(uy, ux);
    // Set in by half its thickness, so it stands on the lot's side of the line.
    const nx = -uy * thick / 2, ny = ux * thick / 2;
    for (let k = 0; k < pieces; k++) {
      const t = ((k + 0.5) / pieces) * len;
      kept.push({ id: nextId++, kind, x: sx + ux * t + nx, y: sy + uy * t + ny, facing: 0, w: len / pieces, d: thick, z: 0, h: height, angle });
    }
  }
  elements.splice(0, elements.length, ...kept.slice(0, MAX_ELEMENTS));
  // Surfaces clipped to the lot; volumes of the building itself kept where they stand on it.
  const clip = (poly: Vec2[]): Vec2[] => {
    // The lot may be any simple polygon (cut back to a bent street, round a corner): a boolean intersection, the largest piece kept. Clipping by each side's half-plane is right only for a convex lot.
    let best: Vec2[] = [], bestArea = 0;
    for (const piece of intersection([[poly.map((p) => [p.x, p.y])]], [[ring.map((p) => [p.x, p.y])]])) {
      const r = (piece[0] ?? []).map(([x, y]) => ({ x: x!, y: y! }));
      let a = 0;
      for (let i = 0; i < r.length; i++) { const p = r[i]!, q = r[(i + 1) % r.length]!; a += p.x * q.y - q.x * p.y; }
      if (Math.abs(a) > bestArea) { bestArea = Math.abs(a); best = a < 0 ? r.reverse() : r; }
    }
    return best;
  };
  const asOutline = (v: Volume, poly: readonly Vec2[]): void => {
    const px = poly.map((p) => p.x), py = poly.map((p) => p.y);
    v.x = Math.min(...px); v.y = Math.min(...py); v.w = Math.max(...px) - v.x; v.d = Math.max(...py) - v.y;
    v.outline = poly.map((p) => ({ x: (p.x - v.x) / (v.w || 1), y: (p.y - v.y) / (v.d || 1) }));
  };
  const volumes: Volume[] = [];
  const nextVolume = Math.max(0, ...body.volumes.map((v) => v.id)) + 1;
  // The lawn under everything, the lot's own shape - laid first, drawn under the rest.
  const lawnTemplate = body.volumes.find((v) => v.open);
  // A surface cut to a sliver (under 2 m across, or an outline the model cannot hold) is left out: kept, it made the whole building invalid and the lot was left bare.
  const sound = (v: Volume): boolean => v.w >= MIN_SIZE && v.d >= MIN_SIZE && (!v.outline || validOutline(v.outline));
  if (lawnTemplate) {
    const lawn: Volume = { ...JSON.parse(JSON.stringify(lawnTemplate)) as Volume, id: nextVolume, open: 'grass' };
    asOutline(lawn, [...ring]);
    if (sound(lawn)) volumes.push(lawn);
  }
  for (const v of body.volumes) {
    const ringOf = v.outline ? v.outline.map((p) => ({ x: v.x + p.x * v.w, y: v.y + p.y * v.d }))
      : [{ x: v.x, y: v.y }, { x: v.x + v.w, y: v.y }, { x: v.x + v.w, y: v.y + v.d }, { x: v.x, y: v.y + v.d }];
    if (v.open) {
      const cut = clip(ringOf);
      if (cut.length < 3) continue;
      if (cut.length !== 4 || !ringOf.every((p) => inside({ x: p.x * 0.999 + (v.x + v.w / 2) * 0.001, y: p.y * 0.999 + (v.y + v.d / 2) * 0.001 }))) asOutline(v, cut);
      if (sound(v)) volumes.push(v);
    } else if (ringOf.some((p) => inside(p)) || inside({ x: v.x + v.w / 2, y: v.y + v.d / 2 })) volumes.push(v);
  }
  body.volumes.splice(0, body.volumes.length, ...volumes);
}
