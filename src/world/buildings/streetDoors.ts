import type { Vec2 } from '@core/vec2';
import { m } from '../units';
import { localFootprint } from './footprints';
import { GB_NX, GB_NY, GB_SIDE, GB_WIDTH, GB_X, GB_Y, GB_Z, GROUND_BAY_STRIDE, groundBayComponent, groundBays, worldToLocal } from './geometry';
import { pointInPolygon } from '@core/polygon';
import type { BayComponent, Building } from './types';

/** The doors of a building that open straight onto the street: a shop or a bar built up to the footway */
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
  // The ground storey's bays packed (`groundBays`), kept by record: no bay list worked out again.
  const bays = groundBays(b);
  for (let i = 0, o = 0; o < bays.length; i++, o += GROUND_BAY_STRIDE) {
    if (bays[o + GB_SIDE] !== 0 || !PEOPLE_DOORS.has(groundBayComponent(bays, i))) continue;
    const x = bays[o + GB_X]!, y = bays[o + GB_Y]!, nx = bays[o + GB_NX]!, ny = bays[o + GB_NY]!;
    const foot: Vec2 = worldToLocal(b, { x: x + nx * STEP_OUT, y: y + ny * STEP_OUT });
    // Something of the building in front of it - a forecourt, a garden, a porch block
    if (rings.some((ring) => pointInPolygon(foot, ring))) continue;
    out.push({ x, y, nx, ny, width: bays[o + GB_WIDTH]!, z: bays[o + GB_Z]! });
  }
  return out;
}
