import { describe, expect, it } from 'vitest';

import { FINISHES } from '@world/buildings/materials';
import { finishAlbedo } from '@render/buildings/finishes';
import { LOOKS } from '@render/bake/finishRecipes';

/** EACH FINISH FROM AFAR AS THE NEAR PROGRAM LIGHTS IT (`finishes.ts` `finishFar`): the far levels' colours in linear, the glass's mullions not scattering. */

/** The sRGB transfer (IEC 61966-2-1). */
const linear = (c: number): number => (c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

describe('a finish from afar', () => {
  it('scatters as the near program does: in linear, its metal scattering nothing', () => {
    const far = finishAlbedo();
    for (const finish of FINISHES) {
      const look = LOOKS[finish];
      const shade = look.shade(look.size);
      const texel = { r: 0, g: 0, b: 0, h: 0, rough: 0, metal: 0 };
      let sum = 0, n = 0;
      for (let y = 0; y < look.size; y++) {
        for (let x = 0; x < look.size; x++) {
          texel.metal = 0;
          shade(x, y, texel);
          sum += linear(texel.g) * (look.metallic ? 1 - texel.metal : 1);
          n++;
        }
      }
      // Its wear's mean (0.91, none on glass and metal) the only difference.
      const worn = finish === 'glass' || finish === 'metal' ? 1 : 0.91;
      expect(far[finish][1], finish).toBeCloseTo((sum / n) * worn, 4);
    }
  });

  it('keeps the dark glass dark (its panes, not its mullions)', () => {
    // The pane's 0.16 sRGB is 0.022 linear: averaged as bytes with the bright mullions it read 0.28 and the black glass went grey-blue.
    expect(finishAlbedo().glass[1]).toBeLessThan(0.05);
  });
});
