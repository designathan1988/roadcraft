import { describe, expect, it } from 'vitest';
import { Box3, type BufferGeometry } from 'three';

import { ERROR_PIXELS, LEVEL_ERRORS, LEVELS, levelFor, partLevels } from '@render/vehicleLevels';
import { buildCarModel } from '@render/carBody';
import { tyreGeometry } from '@render/vehicleModels';
import { archetypeById } from '@sim/vehicles/archetypes';

const triangles = (g: BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/** A vehicle part's levels (`vehicleLevels.ts`): each drawn only where its error is under half a pixel. */
describe('vehicle part levels', () => {
  it('picks the coarsest level whose error stays under the pixel budget', () => {
    for (const pixels of [0.5, 1, 1.75, 2.5, 3, 5, 9, 20, 40, 41, 200]) {
      const level = levelFor(pixels);
      if (level > 0) expect(LEVEL_ERRORS[level - 1]! * pixels).toBeLessThanOrEqual(ERROR_PIXELS);
      if (level < LEVEL_ERRORS.length) expect(LEVEL_ERRORS[level]! * pixels).toBeGreaterThan(ERROR_PIXELS);
    }
    expect(levelFor(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('simplifies a car body within each error, fewer triangles at each coarser level', async () => {
    const model = buildCarModel(archetypeById('hatch'), 'hatch');
    const levels = await partLevels(model.shell, 'smooth');
    expect(levels).toHaveLength(LEVELS);
    expect(levels[0]).toBe(model.shell);
    const whole = new Box3().setFromBufferAttribute(model.shell.getAttribute('position') as never);
    let finer = triangles(model.shell);
    levels.slice(1).forEach((level, i) => {
      expect(level).not.toBeNull();
      const n = triangles(level!);
      expect(n).toBeLessThanOrEqual(finer);
      finer = n;
      // Never larger than the body by more than its error (the simplifier only collapses the body's own vertices).
      level!.computeBoundingBox();
      expect(whole.clone().expandByScalar(LEVEL_ERRORS[i]!).containsBox(level!.boundingBox!)).toBe(true);
    });
    // Where a car is ten pixels long (2.2 px a metre), the body drawn is a small share of the whole one.
    expect(triangles(levels[levelFor(2.2)]!)).toBeLessThan(triangles(model.shell) * 0.15);
  });

  it('simplifies a welded box assembly (a tyre) and gives it normals again', async () => {
    const tyre = tyreGeometry();
    const levels = await partLevels(tyre, 'boxes');
    const coarse = levels[levels.length - 2]!;
    expect(triangles(coarse)).toBeLessThan(triangles(tyre) * 0.2);
    expect(coarse.getAttribute('normal')).toBeDefined();
    expect(coarse.getAttribute('color')).toBeDefined();
  });
});
