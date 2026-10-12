import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auditBuildings, auditForms, auditLots, growCity } from './cityAudit';

/**
 * The generated city the player looked at (2026-10-09, seed 20261009, in
 * rectangular blocks, the default style) and two more: every class of defect he reported, counted on the
 * whole town and held at zero (or at what a real town shows).
 */
const CITIES = [
  { seed: 20261009, size: 'small' },
  { seed: 77, size: 'small' },
  { seed: 4242, size: 'small' },
] as const;

describe('generated city', () => {
  for (const options of CITIES) {
    it(`seed ${options.seed}: lots on land, every lot built, no clashes, real roofs`, () => {
      const t0 = performance.now();
      const city = growCity(options);
      const lots = auditLots(city);
      const buildings = auditBuildings(city);
      const forms = auditForms(city);
      // The tally, for a hunt run by hand: CITY_AUDIT_OUT=<file>.
      if (process.env.CITY_AUDIT_OUT) appendFileSync(process.env.CITY_AUDIT_OUT,
        `CIDADE ${options.seed} (${((performance.now() - t0) / 1000).toFixed(1)} s) ${JSON.stringify({ lots, buildings, forms })}
`);
      // 2. Lots on the block's own land, none over another, none giant.
      expect(lots.onPaving, 'lots over the paving').toBe(0);
      expect(lots.overlapping, 'lots over each other').toBe(0);
      expect(lots.huge, 'lots over 2400 m2').toBe(0);
      // 3. Every zoned lot built on; nothing into a neighbour or off its lot.
      expect(buildings.bare, 'zoned lots left bare').toBe(0);
      expect(buildings.clashes, 'buildings run into each other').toBe(0);
      expect(buildings.outOfLot, 'buildings off their lots').toBe(0);
      // 4. Roofs and halls of real proportion.
      expect(forms.wildRoofs, forms.examples.join('; ')).toBe(0);
      expect(forms.badHalls, forms.examples.join('; ')).toBe(0);
    }, 600_000);
  }
});
