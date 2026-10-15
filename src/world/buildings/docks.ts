import type { Vec2 } from '@core/vec2';
import { m } from '../units';
import { localToWorld, solidFootprints, worldToLocal } from './geometry';
import type { Building, BuildingElement } from './types';

/**
 * A works' lorry docks: the wide bays its loading yard is laid with, each
 * square in front of a loading door of the hall (`editor/lotPlan.ts`) - what
 * a lorry is sent to, reverses into and stands in while it is unloaded. A
 * bay wider than a car's (3.2 m, `sim/agents/parking.ts` LORRY_DOCK) is a
 * dock; its door end is the one against the building, its open end the one
 * a lorry backs in from. World units.
 */
export interface LorryDock {
  /** The dock's element (its stall on the yard). */
  readonly element: number;
  /** The middle of its end at the loading door, and of its open end. */
  readonly door: Vec2;
  readonly open: Vec2;
  readonly width: number;
  /** Its height over the building's ground floor (a yard at a level of its own). */
  readonly z: number;
}

/** A stall wider than this is a lorry's, not a car's (`sim/agents/parking.ts`). */
const LORRY_DOCK = m(3.2);
const STALL = m(2.5);

export const isDock = (el: BuildingElement): boolean =>
  el.kind === 'parking' && el.w / Math.max(1, Math.floor(el.w / STALL)) > LORRY_DOCK;

/** Each record's docks, once (a stored record is never changed in place); shared: read only. */
const DOCKS = new WeakMap<Building, LorryDock[]>();

/** A building's lorry docks: asked by the lorries for every yard and every pass (`sim/agents/lorryTraffic.ts`). */
export function lorryDocks(b: Building): LorryDock[] {
  let known = DOCKS.get(b);
  if (!known) DOCKS.set(b, known = docksOf(b));
  return known;
}

function docksOf(b: Building): LorryDock[] {
  const rings = solidFootprints(b).map((ring) => ring.map((p) => worldToLocal(b, p)));
  if (!rings.length) return [];
  const out: LorryDock[] = [];
  for (const el of b.elements ?? []) {
    if (!isDock(el)) continue;
    // Its depth runs along its facing: local y for a dock facing the front or the back.
    const alongY = el.facing === 0 || el.facing === 2;
    const ends: Vec2[] = alongY
      ? [{ x: el.x, y: el.y - el.d / 2 }, { x: el.x, y: el.y + el.d / 2 }]
      : [{ x: el.x - el.d / 2, y: el.y }, { x: el.x + el.d / 2, y: el.y }];
    const near = ends.map((p) => Math.min(...rings.map((ring) => ringDistance(ring, p))));
    const [door, open] = near[0]! <= near[1]! ? [ends[0]!, ends[1]!] : [ends[1]!, ends[0]!];
    out.push({ element: el.id, door: localToWorld(b, door.x, door.y), open: localToWorld(b, open.x, open.y), width: el.w, z: el.z });
  }
  return out;
}

function ringDistance(ring: readonly Vec2[], p: Vec2): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!, c = ring[i]!;
    const dx = c.x - a.x, dy = c.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t));
  }
  return best;
}

