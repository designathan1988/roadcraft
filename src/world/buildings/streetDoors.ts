import type { Vec2 } from '@core/vec2';
import { m } from '../units';
import { localFootprint } from './footprints';
import { facadeBays, worldToLocal } from './geometry';
import { pointInPolygon } from '@core/polygon';
import type { BayComponent, Building } from './types';

/**
 * The doors of a building that open straight onto the street: a shop or a
 * bar built up to the footway (a lot with no front garden or forecourt,
 * `editor/lotPlan.ts` front 'street'), whose front door is the people's way
 * in - there is no gate in front of it, so the way through a lot to its door
 * (`sim/agents/lotDoors.ts`, from a people's gate) never found it.
 *
 * A door of the ground floor on the front face (the side the lot fronts the
 * street with, local -y) with nothing of the building in front of it: no lot
 * laid there (a forecourt, a garden), no block. Its threshold is on the
 * facade line; a person steps out of it onto the footway along its normal.
 * World units; the doors in the order of the facade's bays.
 */
export interface StreetDoor {
  /** The middle of the threshold, on the facade line. */
  readonly x: number;
  readonly y: number;
  /** Outward unit normal: the way out onto the street. */
  readonly nx: number;
  readonly ny: number;
  readonly width: number;
  /** The building's own floor at the door, above its ground floor (a block at a floor of its own). */
  readonly z: number;
}

/** The ways a person goes in and out by (a garage's or a loading bay's door is a vehicle's). */
const PEOPLE_DOORS: ReadonlySet<BayComponent> = new Set<BayComponent>(['door', 'doubleDoor']);

/** How far out from the door its foot is looked for, clear of the building and its lots. */
const STEP_OUT = m(0.6);

export function streetDoors(b: Building): StreetDoor[] {
  const out: StreetDoor[] = [];
  const rings = b.volumes.filter((v) => v.mode !== 'void' && v.mode !== 'intersect').map((v) => localFootprint(v));
  for (const bay of facadeBays(b)) {
    if (bay.level !== 0 || bay.side !== 0 || !PEOPLE_DOORS.has(bay.component)) continue;
    const foot: Vec2 = worldToLocal(b, { x: bay.x + bay.nx * STEP_OUT, y: bay.y + bay.ny * STEP_OUT });
    // Something of the building in front of it - a forecourt, a garden, a
    // porch block - means the door is reached through the lot, by its gate.
    if (rings.some((ring) => pointInPolygon(foot, ring))) continue;
    out.push({ x: bay.x, y: bay.y, nx: bay.nx, ny: bay.ny, width: bay.width, z: bay.z });
  }
  return out;
}
