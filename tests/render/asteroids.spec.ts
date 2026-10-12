import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';

import { PLANET_RADIUS } from '@core/cubeSphere';
import { createAsteroids } from '../../src/render/planet/asteroids';

/**
 * THE ASTEROIDS MOVE (`render/planet/asteroids.ts`, PL32): a swarm in orbit
 * round the planet - the field's middle goes round, the rocks shear past each
 * other and drift on their relative orbits - never a block hung in space; and
 * the flight's collisions read where the rocks are now, not where they were
 * at the last sort.
 */
describe('the asteroid field', () => {
  const field = createAsteroids();
  const camera = new PerspectiveCamera();
  const identity = new Matrix4();

  const snapshot = (): Vector3[] => {
    const out: Vector3[] = [];
    const at = field.centre.clone();
    // The rocks nearest the field's middle, by index-stable sampling: several probes round it.
    for (const d of [[0, 0, 0], [3000, 0, 0], [0, 3000, 0], [0, 0, 3000], [-3000, 0, 0]]) {
      for (const rock of field.nearest(at.clone().add(new Vector3(...d)), 6)) out.push(rock.centre.clone());
    }
    return out;
  };

  it('goes round the planet: its middle moves some hundreds of metres a second', () => {
    field.update(camera, identity, 0);
    const a = field.centre.clone();
    field.update(camera, identity, 10);
    const b = field.centre.clone();
    const speed = a.distanceTo(b) / 10;
    console.log(`field's middle ${speed.toFixed(0)} m/s at ${(a.length() / PLANET_RADIUS).toFixed(1)} radii`);
    expect(speed).toBeGreaterThan(100);
    expect(speed).toBeLessThan(2000);
    // Round the planet, not away from it.
    expect(Math.abs(a.length() - b.length())).toBeLessThan(1);
  });

  it('shears and drifts: neighbouring rocks move past each other, a few metres a second', () => {
    field.update(camera, identity, 0);
    const near = field.nearest(field.centre, 6).map((r) => r.centre.clone());
    expect(near.length).toBeGreaterThan(1);
    // Two rocks' separation now and 30 s on (found again as the nearest to where each went).
    const before = near[0]!.clone().sub(near[1]!);
    const motion = (field.centre.clone());
    field.update(camera, identity, 30);
    const moved = field.centre.clone().sub(motion);
    const a = field.nearest(near[0]!.clone().add(moved), 1)[0]!.centre.clone();
    const b = field.nearest(near[1]!.clone().add(moved), 1)[0]!.centre.clone();
    const relative = a.sub(b).sub(before).length() / 30;
    console.log(`two neighbours drift apart at ${relative.toFixed(2)} m/s`);
    expect(relative).toBeGreaterThan(0.05);
    expect(relative).toBeLessThan(60);
  });

  it('answers the flight with where the rocks are now', () => {
    field.update(camera, identity, 0);
    const first = snapshot();
    field.update(camera, identity, 0.1);
    const second = snapshot();
    // In a tenth of a second (no new sort) the rocks found have moved with the field.
    const shift = first[0]!.distanceTo(second[0]!);
    expect(shift).toBeGreaterThan(5);
  });

  it('carries a ship among its rocks with it, and lets go of it out of the field', () => {
    field.update(camera, identity, 0);
    const a = field.centre.clone();
    field.update(camera, identity, 1);
    const along = field.centre.clone().sub(a);
    const drift = field.driftAt(field.centre, new Vector3());
    // Inside: the swarm's own speed, along its motion.
    expect(drift.length()).toBeCloseTo(along.length(), -1);
    expect(drift.clone().normalize().dot(along.clone().normalize())).toBeGreaterThan(0.99);
    // Far out of it: nothing.
    expect(field.driftAt(field.centre.clone().multiplyScalar(0.5), new Vector3()).length()).toBe(0);
  });
});
