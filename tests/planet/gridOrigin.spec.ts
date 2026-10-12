import { describe, expect, it } from 'vitest';
import { PLANET_RADIUS } from '@core/cubeSphere';
import { TILES_PER_SIDE, tileOfDirection, sphereToTileInto } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { atlasToSphereInto } from '@world/planet/charts';
import { GRID_CANDIDATES, GRID_SWITCH_MARGIN, chooseGridOrigin, groundApart } from '@world/planet/gridOrigin';
import { m } from '@world/units';

/**
 * WHERE THE PLANET'S LOCAL GRID HANGS (`world/planet/gridOrigin.ts`; the
 * player, 2026-10-10: "grade local quebrada"): by the map and the place
 * looked at alone, never by the way the view came there. Run with
 * `vitest.planet.config.ts`.
 */

const REACH = PLANET_RADIUS * 0.3;
const home = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5;
const c = tileCentre(home);

/** The atlas point of a unit direction, on the piece that owns it. */
function atlasOf(d: { x: number; y: number; z: number }): { x: number; y: number } {
  const t = tileOfDirection(d);
  const p = sphereToTileInto(t, d, { x: 0, y: 0 });
  const o = tileCentre(t);
  return { x: o.x + p.x, y: o.y + p.y };
}

/** Walks the view along `path`, carrying the origin held, as the game does every quarter second. */
function walk(path: { x: number; y: number }[], saved: { x: number; y: number }[] = [], nodes: { x: number; y: number }[] = []) {
  let held: { x: number; y: number } | null = null;
  for (const at of path) held = chooseGridOrigin(at, saved, nodes, held, REACH).origin;
  return held!;
}

const line = (from: { x: number; y: number }, to: { x: number; y: number }, steps: number) =>
  Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }));

describe('the local grid\'s origin', () => {
  it('leaves no place of the planet out of reach of one, and keeps them apart', () => {
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      // Points spread evenly over the sphere (the Fibonacci lattice).
      const z = 1 - (2 * (i + 0.5)) / 4000, r = Math.sqrt(1 - z * z), phi = i * Math.PI * (3 - Math.sqrt(5));
      const p = atlasOf({ x: Math.cos(phi) * r, y: Math.sin(phi) * r, z });
      worst = Math.max(worst, Math.min(...GRID_CANDIDATES.map((q) => groundApart(p, q))));
    }
    expect(worst).toBeLessThan(REACH - GRID_SWITCH_MARGIN);
    let closest = Infinity;
    for (let i = 0; i < GRID_CANDIDATES.length; i++) for (let j = i + 1; j < GRID_CANDIDATES.length; j++) closest = Math.min(closest, groundApart(GRID_CANDIDATES[i]!, GRID_CANDIDATES[j]!));
    expect(closest).toBeGreaterThan(m(1000));
  });

  it('hangs the same grid over empty land whichever way the view came', () => {
    const there = { x: c.x + m(120), y: c.y - m(80) };
    const fromWest = walk(line({ x: c.x - m(2500), y: c.y }, there, 60));
    const fromNorth = walk(line({ x: c.x, y: c.y + m(2600) }, there, 60));
    const jumped = walk([there]);
    expect(fromWest).toEqual(jumped);
    expect(fromNorth).toEqual(jumped);
  });

  it('gives a town built before origins were kept the same one from anywhere in it', () => {
    const town = [{ x: c.x + m(300), y: c.y + m(200) }, { x: c.x + m(500), y: c.y + m(260) }, { x: c.x + m(420), y: c.y + m(60) }];
    const views = [{ x: c.x + m(250), y: c.y + m(180) }, { x: c.x + m(700), y: c.y + m(400) }, { x: c.x - m(200), y: c.y - m(300) }];
    const picks = views.map((v) => chooseGridOrigin(v, [], town, null, REACH));
    for (const p of picks) {
      expect(p.town).toBe(true);
      expect(p.origin).toEqual(picks[0]!.origin);
    }
  });

  it('keeps a saved origin over a town, and holds on through a view resting between two', () => {
    const saved = [{ x: c.x + m(37), y: c.y - m(12) }];
    expect(chooseGridOrigin({ x: c.x + m(400), y: c.y }, saved, [], null, REACH).origin).toBe(saved[0]);
    // Between the two candidates nearest the piece's middle: wobbling across
    // the line between them by 10 m a step, the grid stays on one.
    const near = [...GRID_CANDIDATES].sort((p, q) => groundApart(p, c) - groundApart(q, c));
    const p = near[0]!, q = near[1]!;
    // On the sphere: the great circle from one to the other, and a point `s` of the way along it.
    const sp = atlasToSphereInto(p.x, p.y, { x: 0, y: 0, z: 0 }), sq = atlasToSphereInto(q.x, q.y, { x: 0, y: 0, z: 0 });
    const along = (s: number) => {
      const d = { x: sp.x * (1 - s) + sq.x * s, y: sp.y * (1 - s) + sq.y * s, z: sp.z * (1 - s) + sq.z * s };
      const l = Math.hypot(d.x, d.y, d.z);
      return atlasOf({ x: d.x / l, y: d.y / l, z: d.z / l });
    };
    const span = groundApart(p, q);
    let held = chooseGridOrigin(along(0.5 - m(100) / span), [], [], null, REACH).origin;
    const first = held;
    let switches = 0;
    for (let i = 0; i < 40; i++) {
      const wobble = (i % 2 ? 1 : -1) * m(10);
      const next = chooseGridOrigin(along(0.5 + wobble / span), [], [], held, REACH).origin;
      if (next !== held) switches++;
      held = next;
    }
    expect(switches).toBe(0);
    expect(held).toBe(first);
  });
});
