import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { anchorPlanet, installPlanet, planetMotion, planetPointInto, rehomeFrom, setPlanetCurvature } from '@render/planet/bend';
import { GroundShadowGrid } from '@render/environment';
import { planetSunInto } from '@world/planet/sun';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { m } from '@world/units';

/**
 * THE SHADOWS STAY ON THE GROUND AS THE VIEW MOVES (the player, 2026-10-10:
 * "rotação onde as sombras não acompanham de modo uniforme";
 * `render/environment.ts` GroundShadowGrid). On the planet the ground moves
 * through three's space under the view (`planet/bend.ts` planetMotion): the
 * shadow map must move with it in whole texels, so a point of the ground
 * lands on the same place of its texel all through a drag - over a piece's
 * border, and as the grid is hung on new ground ahead - and the sun the
 * shadows fall from turns in rare small steps, never a little every frame.
 * Run with `vitest.planet.config.ts`.
 */

installPlanet();

const TEXEL = m(0.3);
const view = new Matrix4();
const centre = new Vector3(), snapped = new Vector3(), sunUsed = new Vector3(), right = new Vector3(), up = new Vector3();
const sun = new Vector3(), eye = new Vector3(), ground = new Vector3();
const drawn = (x: number, y: number, h: number, out: Vector3) => planetPointInto(x, h, -y, out);

/** Where a ground point (atlas x, y) falls in the shadow map's texels, as three sets the map up. */
function texelOf(gx: number, gy: number): { u: number; v: number } {
  eye.copy(snapped).addScaledVector(sunUsed, m(500));
  // The shadow camera as three sets it (`LightShadow.updateMatrices`: lookAt with its `up`).
  view.lookAt(eye, snapped, up).setPosition(eye).invert();
  planetPointInto(gx, 0, -gy, ground).applyMatrix4(view);
  return { u: ground.x / TEXEL, v: ground.y / TEXEL };
}

const wrap = (d: number): number => Math.abs(d - Math.round(d));

/**
 * A drag of `frames` steps of (dx, dy) from the middle of `chart`, rehomed onto
 * the next piece as the view crosses a border (as `isoViewport.ts` does): the
 * most a ground point near the view moved in its texel from one frame to the
 * next, on the frames the sun held still and on all; how often the sun moved.
 */
function drag(k: number, chart: number, frames: number, dx: number, dy: number) {
  setPlanetCurvature(k);
  const grid = new GroundShadowGrid(drawn);
  const c = tileCentre(chart);
  let at = { x: c.x, y: c.y }, home = chart, crossed = 0;
  // Ground points along the way, fixed atlas addresses on the piece they were made on.
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= frames; i += 4) for (const side of [-1, 1]) points.push({ x: c.x + dx * i + side * m(23.7), y: c.y + dy * i - side * m(17.1) });
  const before = new Map<number, { u: number; v: number }>();
  let steady = 0, any = 0, turns = 0;
  const o = new Vector3();
  for (let f = 0; f <= frames; f++) {
    if (f > 0) {
      at = { x: at.x + dx, y: at.y + dy };
      const moved = rehomeFrom(home, at.x, at.y);
      if (moved) { at = { x: moved.x, y: moved.y }; home = moved.tile; crossed++; }
    }
    anchorPlanet(at.x, -at.y);
    const s = planetSunInto(610, { x: 0, y: 0, z: 0 });
    sun.set(s.x, s.y, s.z).transformDirection(planetMotion());
    centre.set(at.x, 0, -at.y);
    const stepsBefore = grid.steps;
    grid.place(centre, at.x, at.y, sun, TEXEL, snapped, sunUsed, right, up);
    // The frames the sun was moved: there the shadows may turn, a little.
    const turned = grid.steps !== stepsBefore;
    if (turned) turns++;
    drawn(at.x, at.y, 0, o);
    // Points of the ground within 60 m of the view's place.
    points.forEach((p, i) => {
      const q = drawn(p.x, p.y, 0, new Vector3());
      if (q.distanceTo(o) > m(60)) { before.delete(i); return; }
      const t = texelOf(p.x, p.y);
      const b = before.get(i);
      if (b) {
        const d = Math.max(wrap(t.u - b.u), wrap(t.v - b.v));
        any = Math.max(any, d);
        if (!turned) steady = Math.max(steady, d);
      }
      before.set(i, t);
    });
  }
  return { steady, any, turns, crossed };
}

describe('the shadow map moved in whole texels of the ground', () => {
  for (const [where, chart] of [
    ['in the middle of a cube face', 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5],
    ['beside a corner of the cube', 3 * TILES_PER_SIDE * TILES_PER_SIDE + 1 * TILES_PER_SIDE + 1],
  ] as const) {
    it(`keeps every point of the ground on its texel through a long drag over a border, ${where}`, () => {
      // 600 m east and a little north, 1.37 m a frame: over a border, the grid hung anew five times.
      for (const k of [1, 0.3, 0.02]) {
        const r = drag(k, chart, 440, m(1.37), m(0.41));
        console.log(`k ${k}: still ${r.steady.toFixed(4)} texel, with the sun's steps ${r.any.toFixed(3)}, ${r.turns} steps, ${r.crossed} borders`);
        expect(r.crossed, `k ${k}`).toBeGreaterThan(0);
        // Between the sun's steps the ground stays on its texels (the bend of
        // the ground about the moving view is a hair at the street).
        expect(r.steady, `k ${k}`).toBeLessThan(0.02);
        // And a sun's step moves the ground within 60 m of the view by what the
        // light itself turned there (0.1 degree is 10 cm at 60 m), no more.
        expect(r.any, `k ${k}`).toBeLessThan(0.4);
      }
    });
  }

  it('turns the sun the shadows fall from in rare steps, none at all from the globe', () => {
    const chart = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5;
    // From the globe the ground turns with the planet, and the sun is fixed over it.
    expect(drag(1, chart, 440, m(1.37), m(0.41)).turns).toBe(0);
    // At the street the ground is drawn flat and the sun turns over it as the
    // view goes round the planet: 600 m is 9 degrees, so some 90 steps of 0.1
    // degree in 440 frames - not one every frame.
    const street = drag(0.02, chart, 440, m(1.37), m(0.41));
    expect(street.turns).toBeGreaterThan(40);
    expect(street.turns).toBeLessThan(140);
  });
});
