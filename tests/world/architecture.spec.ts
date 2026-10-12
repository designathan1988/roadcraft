import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { madeToMeasure } from '@world/buildings/procedural';
import { STYLES, columnComponent, columnsFor } from '@world/buildings/architecture';
import { m } from '@world/units';
import { componentAt, type Volume } from '@world/buildings/types';
import type { BlueprintBody } from '@world/buildings/blueprints';

/**
 * Detectors for the classes of ugliness the player rejected in the grown
 * buildings (2026-10-09): blocks stacked in two skins ("prédios
 * empilhados"), openings that do not stand over each other, a city of one
 * style, flat roofs laid with tiles, a moulding at every floor of everything.
 */

type Use = 'residential' | 'commercial' | 'industrial';
const KINDS: readonly [Use, 'low' | 'medium' | 'high', number, number][] = [
  ['residential', 'low', 12, 18], ['residential', 'medium', 24, 26], ['residential', 'high', 28, 30],
  ['commercial', 'low', 14, 20], ['commercial', 'medium', 20, 24], ['commercial', 'high', 30, 30], ['industrial', 'medium', 30, 40],
];

function sample(n: number): { use: Use; density: string; body: BlueprintBody; form: string }[] {
  const out: { use: Use; density: string; body: BlueprintBody; form: string }[] = [];
  const rng = new Rng(2026);
  for (const [use, density, W, D] of KINDS) {
    for (let k = 0; k < n; k++) {
      const made = madeToMeasure(use, density, { W, D, character: k % 5 === 0 ? 7 : k }, rng);
      out.push({ use, density, body: made.body, form: made.signature.form });
    }
  }
  return out;
}

const wallOf = (b: BlueprintBody, v: Volume): number | undefined => (v.materials?.wall ?? b.materials?.wall)?.colour;
/** Does `top` stand on `under` (its base on `under`'s roof, its plan overlapping)? */
const standsOn = (top: Volume, under: Volume): boolean =>
  top.base === under.base + under.storeys.length && top.x < under.x + under.w && top.x + top.w > under.x && top.y < under.y + under.d && top.y + top.d > under.y;

describe('architectural styles of the grown buildings', () => {
  const all = sample(40);

  it('never stacks a block in another skin on a block of the building', () => {
    for (const { body, form } of all) {
      const solid = body.volumes.filter((v) => !v.open);
      for (const top of solid) for (const under of solid) {
        if (top === under || !standsOn(top, under)) continue;
        expect(wallOf(body, top), form).toBe(wallOf(body, under));
      }
    }
  });

  it('stands every opening of the body over the one below (columns, not bays at random)', () => {
    for (const { body, form } of all) {
      for (const v of body.volumes) {
        if (v.open || v.storeys.length < 4) continue;
        const n = v.facadeGeometry?.[0]?.bays;
        if (!n) continue;
        // The body: from the first floor to the floor under the top one.
        const rows = v.storeys.slice(v.base === 0 ? 1 : 0, -1).map((s) => Array.from({ length: n }, (_, i) => componentAt(s.facade, 0, i)).join(','));
        expect(new Set(rows).size, form).toBeLessThanOrEqual(1);
      }
    }
  });

  it('draws a city of many styles, each kind from several', () => {
    const styles = (use: Use, density: string): Set<string> =>
      new Set(all.filter((s) => s.use === use && s.density === density).map((s) => s.form.split(':').pop()!));
    expect(styles('residential', 'low').size).toBeGreaterThanOrEqual(4);
    expect(styles('residential', 'medium').size).toBeGreaterThanOrEqual(5);
    expect(styles('residential', 'high').size).toBeGreaterThanOrEqual(4);
    expect(styles('commercial', 'low').size).toBeGreaterThanOrEqual(5);
    expect(styles('commercial', 'high').size).toBeGreaterThanOrEqual(3);
  });

  it('lays no flat roof with tiles', () => {
    for (const { body, form } of all) {
      for (const v of body.volumes) {
        if (v.open || (v.roof !== 'flat' && v.roof !== 'terrace')) continue;
        const roof = v.materials?.roof ?? body.materials?.roof;
        expect(roof?.finish === 'tile' || roof?.finish === 'slate', form).toBe(false);
      }
    }
  });

  it('draws a moulding at every floor only on the styles that have one', () => {
    const every = all.filter(({ body }) => body.volumes.some((v) => !v.open && v.dress?.lines === 'every'));
    expect(every.length).toBeLessThan(all.length * 0.25);
    for (const { body } of all) for (const v of body.volumes) if (!v.open) expect(v.dress, 'every block dressed').toBeDefined();
  });

  it('shares a facade into symmetric columns about a middle axis', () => {
    expect(columnsFor(m(15), 3)).toBe(5);
    expect(columnsFor(m(10.5), 3)).toBe(3);
    expect(columnsFor(m(6), 3)).toBe(2);
    const rhythm = STYLES.contemporary.rhythms[0]!;
    for (const n of [3, 5, 7, 9]) {
      const row = Array.from({ length: n }, (_, i) => columnComponent(rhythm, i, n));
      expect(row).toEqual([...row].reverse());
    }
  });
});
