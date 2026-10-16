/** PLACED CLOUDS: cumulus the player puts in the sky, moves and takes away, each its own size, height and thickness */

import { m } from './units';

/** The sky's period: the placed clouds repeat every this much each way, so over any part of the unbounded world there are clouds (a sky the size of the old map). */
export const CLOUD_SPAN = m(10_240);

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

/** The most clouds a map keeps the sky draws , all of them the map's own: since 2026-10-07 the sky invents none the player */
export const MAX_PLACED_CLOUDS = 24;

const CLOUD_LIMITS = {
  height: [m(32), m(960)],
  size: [m(24), m(640)],
  density: [0.1, 1],
} as const;

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

/** Clouds spread over the map, as a procedural spawner fills a volume and the placed instances are then edited one by one */
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

/** The cloud the pointer is on: of the clouds whose body */
export function cloudUnder(clouds: readonly PlacedCloud[], at: (height: number) => { x: number; y: number }): PlacedCloud | null {
  // The ray as a line through two of its points, a kilometre of height apart.
  const lo = at(0), hi = at(1000);
  const dx = hi.x - lo.x, dy = hi.y - lo.y, dz = 1000;
  const length = Math.hypot(dx, dy, dz);
  const ux = dx / length, uy = dy / length, uz = dz / length;
  let best: PlacedCloud | null = null;
  let bestEntry = -Infinity;
  for (const cloud of clouds) {
    const cz = cloud.height + cloud.size * 0.4;
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

/** Where to keep a cloud that is to be seen at `seen` now: the wind's drift taken off (`driftedCloud`'s inverse). */
export function undriftedCloud(seen: { readonly x: number; readonly y: number }, drift: { readonly x: number; readonly y: number }): { x: number; y: number } {
  return { x: seen.x - drift.x, y: seen.y - drift.y };
}

/** Where a cloud is now, carried by the wind (`world/weather.ts`): its repeat nearest `about` (where the view looks), thinning away towards the edge of the period round it */
export function driftedCloud(cloud: PlacedCloud, drift: { readonly x: number; readonly y: number },
  about: { readonly x: number; readonly y: number } = { x: 0, y: 0 }): { x: number; y: number; show: number } {
  const span = CLOUD_SPAN;
  const wrap = (v: number): number => ((((v + span / 2) % span) + span) % span) - span / 2;
  const dx = wrap(cloud.x + drift.x - about.x), dy = wrap(cloud.y + drift.y - about.y);
  const x = about.x + dx, y = about.y + dy;
  const out = (Math.max(Math.abs(dx), Math.abs(dy)) - span * 0.36) / (span * 0.12);
  const t = Math.min(1, Math.max(0, out));
  return { x, y, show: 1 - t * t * (3 - 2 * t) };
}
