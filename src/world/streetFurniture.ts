import type { Vec2 } from '@core/vec2';
import type { Network } from './network';
import type { SegmentId } from './ids';
import { m } from './units';
import { LANDSCAPE_RADIUS, type LandscapeItem, type LandscapeKind, crossingAccesses, crossingAccessTester, footwayAt, medianAt, nearCrossingAccess } from './landscape';

export { TREE_PIT } from './section';

/** Where every piece of street furniture stands. */

export type FurnitureKind =
  | 'lamp'
  | 'bin'
  | 'bench'
  | 'hydrant'
  | 'postbox'
  | 'phone'
  | 'drain'
  | 'streetTree'
  | 'shrub';

export interface FurnitureItem {
  readonly kind: FurnitureKind;
  readonly x: number;
  readonly y: number;
  readonly segment: SegmentId;
  /** Unit tangent of the road at the item. */
  readonly along: Vec2;
  /** Unit normal pointing AWAY from the carriageway, towards the buildings. */
  readonly outward: Vec2;
  /** The surface the item stands on; the renderer adds the kerb's rise (a kerbed median stands as high as a footway). */
  readonly on: 'footway' | 'median';
  /** Plan footprint, for anything that must walk around it. */
  readonly radius: number;
  /** Set for a long thing (a bench): its half extent along `along`. */
  readonly halfLength?: number;
  /** Set for a long thing: its half extent along `outward`. */
  readonly halfWidth?: number;
  /** Set for a seat: the way somebody sitting on it faces. */
  readonly faces?: Vec2;
  /** A per-item number in [0, 1), stable across rebuilds, for variety. */
  readonly seed: number;
  /** When it was planted, city minutes (plants only); absent: fully grown. */
  readonly planted?: number;
}

/** Each placed kind as the furniture the renderer and the walkers know. */
const FURNITURE_OF: Readonly<Partial<Record<LandscapeKind, FurnitureKind>>> = {
  tree: 'streetTree',
  shrub: 'shrub',
  bench: 'bench',
  bin: 'bin',
  lamp: 'lamp',
  hydrant: 'hydrant',
  postbox: 'postbox',
  phone: 'phone',
  drain: 'drain',
};

/** How far off its footway's band a stored item may have drifted and still stand on it. */
const STAND_REACH = m(0.6);

function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

/** One placed item as the furniture standing where it was put: on the footway under it, or */
export function furnitureOf(
  net: Network,
  placed: LandscapeItem,
  onAccess: (segment: SegmentId, x: number, y: number, radius: number) => boolean = (segment, x, y, radius) => nearCrossingAccess(net, segment, x, y, radius),
): FurnitureItem | null {
  // Long grass on open ground is drawn by the grass field, not walked round.
  const kind = FURNITURE_OF[placed.kind];
  if (!kind) return null;
  const item = standing(net, placed, kind);
  return item && !onAccess(item.segment, item.x, item.y, item.radius) ? item : null;
}

/** The furniture an item makes on the footway or the median under it, before the crossings are asked. */
function standing(net: Network, placed: LandscapeItem, kind: FurnitureKind): FurnitureItem | null {
  const hit = footwayAt(net, placed, STAND_REACH);
  if (!hit) {
    // A tree or shrub in a planted median: nobody walks there.
    const median = kind === 'streetTree' || kind === 'shrub' ? medianAt(net, placed, m(0.3)) : null;
    if (!median) return null;
    return { kind, x: placed.x, y: placed.y, segment: median.segment,
      along: { x: median.frame.t.x, y: median.frame.t.y },
      outward: { x: median.frame.n.x, y: median.frame.n.y },
      on: 'median', radius: LANDSCAPE_RADIUS[placed.kind], seed: hash01(placed.id, 0x5eed),
      ...(placed.planted !== undefined ? { planted: placed.planted } : {}) };
  }
  const outward = { x: hit.frame.n.x * hit.side, y: hit.frame.n.y * hit.side };
  const base = {
    kind,
    x: placed.x,
    y: placed.y,
    segment: hit.segment,
    along: { x: hit.frame.t.x, y: hit.frame.t.y },
    outward,
    on: 'footway' as const,
    radius: LANDSCAPE_RADIUS[placed.kind],
    seed: hash01(placed.id, 0x5eed),
    ...(placed.planted !== undefined ? { planted: placed.planted } : {}),
  };
  // A bench by the kerb turns its back on the traffic and faces the footway.
  return kind === 'bench' ? { ...base, halfLength: m(0.9), halfWidth: m(0.26), faces: outward } : base;
}

/** Everything standing on the footways: the items the player placed with the landscaping tool */
export function streetFurniture(net: Network): FurnitureItem[] {
  // The landings filed once for every item (`crossingAccessTester`).
  const onAccess = crossingAccessTester(net, crossingAccesses(net));
  const items: FurnitureItem[] = [];
  for (const placed of net.doc.landscape.values()) {
    const item = furnitureOf(net, placed, onAccess);
    if (item) items.push(item);
  }
  return items;
}
