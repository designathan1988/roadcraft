import type { Vec2 } from '@core/vec2';
import { chartAt, directionOnChart } from './planet/charts';
import type { Network } from './network';
import type { SegmentId } from './ids';
import { m } from './units';
import { LANDSCAPE_RADIUS, type LandscapeKind, crossingAccesses, footwayAt, medianAt, onCrossingAccess } from './landscape';

export { TREE_PIT } from './section';

/**
 * Where every piece of street furniture stands.
 *
 * This used to be written twice: once in `render/scenery.ts`, which drew the
 * lamps, bins and benches, and once, by hand and "at the same positions", in
 * the simulation's pedestrian obstacles (today the footway graph,
 * `sim/peds/sidewalk.ts`).
 * Two copies of a layout drift - adding a street tree to one would have put a
 * tree on the pavement that people walked straight through. It is one list now,
 * derived from the document and the network, and both read it.
 *
 * Positions only. Heights belong to the road field and are the renderer's to
 * look up; the simulation walks in plan.
 */

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
  /**
   * Set for a seat: the way somebody sitting on it faces. A bench by the kerb
   * turns its back on the traffic and faces the footway, as on a street.
   */
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

/**
 * Everything standing on the footways: the items the player placed with the
 * landscaping tool (`landscape.ts`), each on the footway under it. Nothing is
 * generated along the streets any more (the player's order of 2026-10-05).
 * An item whose footway has gone (its road demolished or moved away) is not
 * listed: it is neither drawn nor walked round until a footway is under it again.
 */
export function streetFurniture(net: Network): FurnitureItem[] {
  const items: FurnitureItem[] = [];
  for (const placed of net.doc.landscape.values()) {
    // Long grass on open ground is drawn by the grass field, not walked round.
    const kind = FURNITURE_OF[placed.kind];
    if (!kind) continue;
    const hit = footwayAt(net, placed, STAND_REACH);
    if (!hit) {
      // A tree or shrub in a planted median (docs/VIAS.md V7): nobody walks there.
      const median = kind === 'streetTree' || kind === 'shrub' ? medianAt(net, placed, m(0.3)) : null;
      if (median) {
        const own = chartAt(placed.x, placed.y);
        items.push({ kind, x: placed.x, y: placed.y, segment: median.segment,
          along: directionOnChart(median.chart, own, median.frame.p, median.frame.t),
          outward: directionOnChart(median.chart, own, median.frame.p, median.frame.n),
          on: 'median', radius: LANDSCAPE_RADIUS[placed.kind], seed: hash01(placed.id, 0x5eed),
          ...(placed.planted !== undefined ? { planted: placed.planted } : {}) });
      }
      continue;
    }
    // The road's frame turned onto the item's own chart (on the planet the
    // road's ribbon can be kept on the next piece's, turned against it).
    const own = chartAt(placed.x, placed.y);
    const outward = directionOnChart(hit.chart, own, hit.frame.p, { x: hit.frame.n.x * hit.side, y: hit.frame.n.y * hit.side });
    const base = {
      kind,
      x: placed.x,
      y: placed.y,
      segment: hit.segment,
      along: directionOnChart(hit.chart, own, hit.frame.p, hit.frame.t),
      outward,
      on: 'footway' as const,
      radius: LANDSCAPE_RADIUS[placed.kind],
      seed: hash01(placed.id, 0x5eed),
      ...(placed.planted !== undefined ? { planted: placed.planted } : {}),
    };
    if (kind === 'bench') {
      // A bench by the kerb turns its back on the traffic and faces the footway.
      items.push({ ...base, halfLength: m(0.9), halfWidth: m(0.26), faces: outward });
    } else {
      items.push(base);
    }
  }
  // Nothing stands in a zebra's landing (`crossingAccesses`): a crossing
  // built after an item was placed hides it rather than block the crossing.
  const accesses = crossingAccesses(net);
  return items.filter((item) => !onCrossingAccess(net, accesses, item.segment, item.x, item.y, item.radius));
}

/** The items a person on the footway has to walk around. */
export const blocksPedestrians = (item: FurnitureItem): boolean => item.on === 'footway';
