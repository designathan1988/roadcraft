import { describe, expect, it } from 'vitest';
import { Box3, type BufferGeometry } from 'three';

import { ERROR_PIXELS, LEVEL_ERRORS, LEVELS, levelFor, partLevels } from '@render/vehicleLevels';
import { levelBuffers, partLevelArrays } from '@render/partLevelsWork';
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

  it('are made off the page from copies of the part (welded, simplified, creased), every array sent moved', async () => {
    const model = buildCarModel(archetypeById('hatch'), 'hatch');
    for (const [geometry, weld] of [[model.shell, 'smooth'], [model.trim, 'boxes']] as const) {
      const position = geometry.getAttribute('position').array;
      const index = geometry.getIndex()!.array;
      const copy = { array: position.slice(), itemSize: 3, normalized: false };
      const colour = geometry.getAttribute('color');
      const normal = geometry.getAttribute('normal');
      const made = partLevelArrays({
        position: copy, color: colour ? { array: colour.array.slice(), itemSize: colour.itemSize, normalized: colour.normalized } : null,
        normal: normal ? { array: normal.array.slice(), itemSize: 3, normalized: false } : null, index: (index as Uint32Array).slice(),
      }, weld);
      // The part's own arrays untouched; the levels the page puts together are the same ones.
      expect(geometry.getAttribute('position').array).toBe(position);
      const levels = await partLevels(geometry, weld);
      made.levels.forEach((l, i) => {
        const level = levels[i + 1];
        if (l === null) expect(level).toBeNull();
        else if (l === 'same') expect(level).toBe(levels[i]);
        // Or the finer one again where it sheds too little (`SHED`).
        else if (level !== levels[i]) expect(triangles(level!)).toBe(l.index ? l.index.length / 3 : l.position!.array.length / 9);
      });
      const moved = new Set(levelBuffers(made));
      for (const l of made.levels) if (l && l !== 'same') {
        if (l.index) expect(moved.has(l.index.buffer as ArrayBuffer)).toBe(true);
        if (l.position) expect(moved.has(l.position.array.buffer as ArrayBuffer)).toBe(true);
      }
    }
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
    const coarse = levels[levels.length - 1]!;
    expect(triangles(coarse)).toBeLessThan(triangles(tyre) * 0.2);
    expect(coarse.getAttribute('normal')).toBeDefined();
    expect(coarse.getAttribute('color')).toBeDefined();
  });

  it('draws a coarser level of its own only where each vehicle sheds a draw worth of triangles', async () => {
    const model = buildCarModel(archetypeById('hatch'), 'hatch');
    for (const [geometry, weld] of [[model.shell, 'smooth'], [model.glass, 'smooth'], [model.trim, 'boxes'], [model.interior, 'boxes'], [tyreGeometry(), 'boxes']] as const) {
      const levels = await partLevels(geometry, weld);
      let finer = triangles(levels[0]!);
      for (let k = 1; k < levels.length; k++) {
        const level = levels[k];
        if (!level || level === levels[k - 1]) continue;
        expect(finer - triangles(level)).toBeGreaterThanOrEqual(64);
        finer = triangles(level);
      }
    }
    // A car's glazing: the whole and one coarse level, not six levels a few triangles apart.
    const glass = await partLevels(model.glass, 'smooth');
    expect(new Set(glass.filter((g) => g)).size).toBe(2);
  });
});
