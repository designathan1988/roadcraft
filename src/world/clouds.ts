/**
 * PLACED CLOUDS: cumulus the player puts in the sky, moves and takes away,
 * each its own size, height and thickness - as an editor's cloud actors are
 * placed, moved and scaled one by one (CloudScape Actors for Unreal) - over
 * the clouds the sky makes of itself (Paisagem > Céu e clima). Kept in the
 * document, so they save, load and undo; drawn by the atmosphere pass
 * (`render/postprocess.ts`), which ray-marches each as a heap of puffs.
 */

import { MAP_SIZE } from './bounds';
import { m } from './units';
import { PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { tileOfDirection } from '@core/planetTiles';
import { atlasToSphereInto, onChartOf, sphereToChartInto } from './planet/charts';

export interface PlacedCloud {
  readonly id: number;
  /** Map position under the cloud's middle, world units. */
  readonly x: number;
  readonly y: number;
  /** Height of its flat base over the ground's base level, world units. */
  readonly height: number;
  /** Across, world units (a cumulus about twice as wide as tall). */
  readonly size: number;
  /** 0..1: thin and wispy .. a dense white heap. */
  readonly density: number;
  /** Its turn about the vertical, radians: which way its puffs lie. */
  readonly yaw: number;
}

/**
 * The most clouds a map keeps (the sky draws `MAX_CLOUDS`, all of them the
 * map's own: since 2026-10-07 the sky invents none the player cannot move or
 * take away).
 */
export const MAX_PLACED_CLOUDS = 24;

export const CLOUD_LIMITS = {
  height: [m(32), m(960)],
  size: [m(24), m(640)],
  density: [0.1, 1],
} as const;

/**
 * On the planet a cloud is drawn at this share of the height it is set at.
 * The planet is 3.8 km round, and the sky's clouds stand 450 m up and more
 * (a cumulus's 375 m over that): an eighth to a fifth of its radius, above
 * the air's own top (15 %, `render/planet/air.ts`), so from above the planet
 * they hung in black space beside it and their shadows fell a kilometre off.
 * Brought down to within the air, as the Earth's clouds lie well inside its
 * own; seen from the ground they still stand well over the roofs.
 */
const PLANET_CLOUD_LIFT = 0.45;

/** The height a cloud set at `height` is drawn at (`PLANET_CLOUD_LIFT`). */
export const drawnCloudHeight = (height: number): number => (__PLANET__ ? height * PLANET_CLOUD_LIFT : height);

const clamp = (v: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A placed cloud read from a saved map, kept in range, or null if it is not one. */
export function readCloud(data: unknown): PlacedCloud | null {
  const d = data as Partial<Record<keyof PlacedCloud, unknown>> | null;
  if (!d || !finite(d.id) || !finite(d.x) || !finite(d.y)) return null;
  return {
    id: Math.round(d.id),
    x: d.x,
    y: d.y,
    height: clamp(finite(d.height) ? d.height : m(180), CLOUD_LIMITS.height),
    size: clamp(finite(d.size) ? d.size : m(150), CLOUD_LIMITS.size),
    density: clamp(finite(d.density) ? d.density : 0.8, CLOUD_LIMITS.density),
    yaw: finite(d.yaw) ? d.yaw : 0,
  };
}

/**
 * Clouds spread over the map, as a procedural spawner fills a volume and the
 * placed instances are then edited one by one (Unreal's Procedural Foliage
 * and its Foliage tools): `count` of them, each of about the given size,
 * height and density, varied by `variation` (0..1), kept apart by about
 * their size and off the clouds already there. `random` gives 0..1.
 */
export function scatterClouds(count: number, like: { size: number; height: number; density: number }, variation: number,
  half: number, existing: readonly PlacedCloud[], random: () => number): Omit<PlacedCloud, 'id'>[] {
  const out: Omit<PlacedCloud, 'id'>[] = [];
  const vary = (v: number): number => v * (1 + (random() * 2 - 1) * variation);
  const reach = half * 0.8;
  for (let tries = 0; out.length < count && tries < count * 40; tries++) {
    const size = clamp(vary(like.size), CLOUD_LIMITS.size);
    const x = (random() * 2 - 1) * reach, y = (random() * 2 - 1) * reach;
    const crowded = [...existing, ...out].some((c) => Math.hypot(c.x - x, c.y - y) < (c.size + size) * 0.45);
    if (crowded) continue;
    out.push({
      x, y, size,
      height: clamp(vary(like.height), CLOUD_LIMITS.height),
      density: clamp(vary(like.density), CLOUD_LIMITS.density),
      yaw: random() * Math.PI * 2,
    });
  }
  return out;
}

/**
 * The cloud the pointer is on: of the clouds whose body (a sphere about its
 * heap, `render/postprocess.ts` layOne) the pointer's ray passes through, the
 * one it meets first coming from the camera - a big cloud far behind never
 * steals the click from the one in front (2026-10-07). `at(height)` is where
 * the ray crosses the plane at that height; the camera looks down, so the
 * ray meets higher ground first. Null if the ray misses every cloud.
 */
export function cloudUnder(clouds: readonly PlacedCloud[], at: (height: number) => { x: number; y: number }): PlacedCloud | null {
  if (__PLANET__) return cloudUnderOnPlanet(clouds, at);
  // The ray as a line through two of its points, a kilometre of height apart.
  const lo = at(0), hi = at(1000);
  const dx = hi.x - lo.x, dy = hi.y - lo.y, dz = 1000;
  const length = Math.hypot(dx, dy, dz);
  const ux = dx / length, uy = dy / length, uz = dz / length;
  let best: PlacedCloud | null = null;
  let bestEntry = -Infinity;
  for (const cloud of clouds) {
    const cz = drawnCloudHeight(cloud.height) + cloud.size * 0.4;
    const radius = cloud.size * 0.55;
    // Along the ray (towards the camera) to the point nearest the centre.
    const t = (cloud.x - lo.x) * ux + (cloud.y - lo.y) * uy + cz * uz;
    const px = lo.x + ux * t - cloud.x, py = lo.y + uy * t - cloud.y, pz = uz * t - cz;
    const miss = px * px + py * py + pz * pz;
    if (miss >= radius * radius) continue;
    // Where the ray enters the sphere, measured towards the camera.
    const entry = t + Math.sqrt(radius * radius - miss);
    if (entry > bestEntry) { bestEntry = entry; best = cloud; }
  }
  return best;
}

/**
 * `cloudUnder` on the planet, where "up" is the sphere's and no plane is level
 * everywhere: `at(height)` is where the ray meets the sphere that high
 * (`render/isoViewport.ts` hitAt), written on the chart of the piece it lies
 * on. A cloud is under the pointer when the ray crosses its middle's height
 * within its body's radius of its middle - measured on the cloud's own chart
 * (`onChartOf`: two charts' points are tens of km apart in the atlas). Of
 * those, the highest: the eye looks down on the planet, and its ray meets
 * the higher heap first.
 */
function cloudUnderOnPlanet(clouds: readonly PlacedCloud[], at: (height: number) => { x: number; y: number }): PlacedCloud | null {
  let best: PlacedCloud | null = null;
  let bestHeight = -Infinity;
  for (const cloud of clouds) {
    const cz = drawnCloudHeight(cloud.height) + cloud.size * 0.4;
    const q = onChartOf(at(cz), cloud);
    if (Math.hypot(q.x - cloud.x, q.y - cloud.y) >= cloud.size * 0.55) continue;
    if (cz > bestHeight) { bestHeight = cz; best = cloud; }
  }
  return best;
}

const turned: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * A point of the planet blown `distance` world units east round its axis (the
 * planet frame's z, `world/planet/sun.ts`): the clouds ride a zonal wind,
 * along the parallels, as the trade winds and the westerlies run. Its
 * place is then written on the chart of the piece it has come to, so a cloud
 * crosses from piece to piece as the drawing reads it (each chart's points
 * stay in its cell of the atlas, `planet/charts.ts`). Added to the atlas's
 * own x, it left its piece's cell after a few minutes of wind and jumped
 * to wherever that cell's chart put it.
 */
function blownRoundAxis(x: number, y: number, distance: number): { x: number; y: number } {
  atlasToSphereInto(x, y, turned);
  const a = distance / PLANET_RADIUS, c = Math.cos(a), s = Math.sin(a);
  const tx = turned.x * c - turned.y * s, ty = turned.x * s + turned.y * c;
  turned.x = tx; turned.y = ty;
  return sphereToChartInto(tileOfDirection(turned), turned, { x: 0, y: 0 });
}

/**
 * Where to keep a cloud that is to be seen at `seen` now: the wind's drift
 * taken off (`driftedCloud`'s inverse).
 */
export function undriftedCloud(seen: { readonly x: number; readonly y: number }, drift: { readonly x: number; readonly y: number }): { x: number; y: number } {
  if (__PLANET__) return blownRoundAxis(seen.x, seen.y, -drift.x);
  return { x: seen.x - drift.x, y: seen.y - drift.y };
}

/**
 * Where a cloud is now, carried by the wind (`world/weather.ts`): its place
 * plus how far the wind has blown since the map opened, wrapped round the
 * map so the sky never empties; and how much of it shows (1, thinning away
 * as it nears the edge it wraps round, so it never pops).
 */
export function driftedCloud(cloud: PlacedCloud, drift: { readonly x: number; readonly y: number }): { x: number; y: number; show: number } {
  // On the planet there is no edge to wrap round: the wind carries it on
  // round the planet, east along its parallel (`blownRoundAxis`; the drift's
  // north-south part would herd every cloud to a pole).
  if (__PLANET__) return { ...blownRoundAxis(cloud.x, cloud.y, drift.x), show: 1 };
  const span = MAP_SIZE;
  const wrap = (v: number): number => ((((v + span / 2) % span) + span) % span) - span / 2;
  const x = wrap(cloud.x + drift.x), y = wrap(cloud.y + drift.y);
  const out = (Math.max(Math.abs(x), Math.abs(y)) - span * 0.36) / (span * 0.12);
  const t = Math.min(1, Math.max(0, out));
  return { x, y, show: 1 - t * t * (3 - 2 * t) };
}
