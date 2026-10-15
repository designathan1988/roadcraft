import { Color } from 'three';

import { Rng } from '@core/rng';
import type { RoadElevation } from '@world/elevation';
import { m } from '@world/units';

/**
 * Grass you can see blades of: the long grass the player places (Paisagismo
 * > Mato), a clump of instanced tufts and the odd wildflower at each place.
 *
 * The terrain texture is grass from the map zoom. From a few metres, a flat
 * texture is a flat texture, and the ground was the "hard" thing in the scene -
 * a carpet under objects that stood on it. Real turf is never mown to a plane:
 * it grows in tufts, with the odd flower in it.
 *
 * Nothing grows by itself (the player's order of 2026-10-05): the clumps
 * once scattered over open ground and along the roads had no caller left with
 * a budget above nought, and were removed with the scenery that asked for
 * none (`buildScenery`). A clump is a pure function of its item and the
 * ground under it (`grassClump`); the layer keeps each clump's tufts as one
 * run of its instance stores (`streetFurnitureLayer.ts`), made again only
 * when the diary says something under that clump changed.
 */

/** Real turf height, root to tip. */
const TUFT_MIN = m(0.18);
const TUFT_RANGE = m(0.3);
const FLOWER_MIN = m(0.25);
const FLOWER_RANGE = m(0.2);
/** The largest clump's radius (`grassClump`: one to three metres). */
const CLUMP_REACH = m(3);
/** How far round a clump's centre the slope is read (`grassClump`). */
const SLOPE_PROBE = m(1.6);
/** How far round its item a clump reads the ground and the roads: its radius and the slope's probe. */
export const CLUMP_READ_REACH = CLUMP_REACH + SLOPE_PROBE;

export interface Tuft {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly height: number;
  readonly width: number;
  readonly tint: Color;
}

/** A clump's grass: its tufts and its wildflowers. */
export interface Clump {
  readonly tufts: readonly Tuft[];
  readonly flowers: readonly Tuft[];
}

const FLOWER_COLOURS = [0xf6f3e8, 0xf2d24b, 0xb58be0, 0xe8618c, 0xf5a13a].map((hex) => new Color(hex));
const NONE: Clump = { tufts: [], flowers: [] };

/**
 * The clump at a placed item, from its own generator (seeded by its id, so
 * an edit elsewhere moves none of it): the centre is tested against the roads
 * and the slope, then its tufts are laid on the ground as drawn.
 */
export function grassClump(
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  placed: { readonly x: number; readonly y: number; readonly id: number },
): Clump {
  const rng = new Rng(Math.imul(placed.id + 1, 0x9e3779b1) >>> 0);
  const cx = placed.x, cy = placed.y;
  const radius = m(1) + rng.float() * m(2);
  const road = elevation.roadAt(cx, cy);
  if (road.type >= 0 && Math.abs(road.across) < road.half + radius * 0.6 + m(0.32)) return NONE;
  const slope =
    Math.abs(terrainAt(cx + SLOPE_PROBE, cy) - terrainAt(cx - SLOPE_PROBE, cy)) +
    Math.abs(terrainAt(cx, cy + SLOPE_PROBE) - terrainAt(cx, cy - SLOPE_PROBE));
  if (slope > m(2.4)) return NONE;

  const tufts: Tuft[] = [], flowers: Tuft[] = [];
  // Dense enough to read as a patch of long grass. At 16 to 42 blades over
  // a clump several metres wide they were scattered dark specks - dirt on
  // the screen, not grass.
  const count = 90 + Math.floor(rng.float() * 70);
  // Each clump has its own colour: lush, pale, or gone to seed.
  const dry = rng.float();
  // Close to the lawn's own green: the bright lime clumps stood out as stickers.
  const clumpHue = (dry > 0.8 ? new Color(1.05, 0.98, 0.66) : new Color(0.62 + dry * 0.1, 0.8, 0.5)).multiplyScalar(0.62);
  for (let i = 0; i < count; i++) {
    // Denser in the middle of a clump, as grass grows out from a patch.
    const r = radius * Math.sqrt(rng.float()) * (0.4 + rng.float() * 0.6);
    const a = rng.float() * Math.PI * 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    // A tuft at the edge of a clump can still reach a road.
    if (road.type >= 0 && Math.abs(road.across) - r < road.half + m(0.24)) {
      const near = elevation.roadAt(x, y);
      if (near.type >= 0 && Math.abs(near.across) < near.half + m(0.24)) continue;
    }
    const z = terrainAt(x, y) - m(0.02);
    const shade = 0.95 + rng.float() * 0.22;
    const tuft: Tuft = {
      x,
      y,
      z,
      yaw: rng.float() * Math.PI * 2,
      height: TUFT_MIN + rng.float() * TUFT_RANGE * (1 - r / (radius * 1.4)),
      width: 0.9 + rng.float() * 0.6,
      tint: clumpHue.clone().multiplyScalar(shade),
    };
    if (rng.float() < 0.045) {
      flowers.push({
        ...tuft,
        height: FLOWER_MIN + rng.float() * FLOWER_RANGE,
        width: 1,
        tint: (FLOWER_COLOURS[Math.floor(rng.float() * FLOWER_COLOURS.length)] as Color).clone(),
      });
    } else {
      tufts.push(tuft);
    }
  }
  return { tufts, flowers };
}
