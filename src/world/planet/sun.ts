import type { Vec3 } from '@core/cubeSphere';
import { tileToSphereInto } from '@core/planetTiles';
import { atlasToTileInto, type TileLocal } from './atlas';

/**
 * THE PLANET'S SUN: fixed over the planet, turning round its axis (the
 * planet frame's z, through the faces 2 and 5) once a day; the camera moves
 * round the planet, the sun does not move with it. At noon (720) it stands
 * over face 0's centre (+x), in the morning over its east (+y), with a little
 * tilt so the poles see it too.
 *
 * The time it makes at a place is the hour angle (PVEducation, "Solar Time":
 * 15 degrees an hour, noon where it stands overhead): what the sky shows
 * there and what the clock reads while the view looks there.
 */
const SUN_TILT = 0.22;

/** The sun's direction in the planet's own frame (unit) at a time of day (minutes), into `out`. */
export function planetSunInto(minutes: number, out: Vec3): Vec3 {
  const sigma = (-(minutes - 720) / 1440) * Math.PI * 2;
  const x = Math.cos(sigma), y = Math.sin(sigma), z = SUN_TILT;
  const l = Math.hypot(x, y, z);
  out.x = x / l; out.y = y / l; out.z = z / l;
  return out;
}

const local: TileLocal = { tile: 0, x: 0, y: 0 };
const at: Vec3 = { x: 0, y: 0, z: 0 };

/** The time the sun makes at an atlas point (minutes, 0..1440), at a time of the planet's day (minutes). */
export function planetLocalMinutes(minutes: number, x: number, y: number): number {
  atlasToTileInto(x, y, local);
  tileToSphereInto(local.tile, local.x, local.y, at);
  // The sun's longitude (the tilt does not move it).
  const sigma = (-(minutes - 720) / 1440) * Math.PI * 2;
  let delta = (Math.atan2(at.y, at.x) - sigma) / (Math.PI * 2);
  delta -= Math.round(delta);
  return ((720 + delta * 1440) % 1440 + 1440) % 1440;
}
