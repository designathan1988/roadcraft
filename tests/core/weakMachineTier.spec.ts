// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWeakMachine } from '@core/weakMachine';
import { QUALITY } from '@render/quality';

/** THE WEAK MACHINE'S FIRST TIER, THROUGH THE GRAPHICS WIRING: a run playing the player's UHD 770 (`ROADCRAFT_WEAK=uhd770`) starts on `low`, whatever this machine kept. */

vi.mock('@core/weakMachine', async (original) => {
  const real = await original<typeof import('@core/weakMachine')>();
  return { ...real, WEAK_MACHINE: real.parseWeakMachine('uhd770') };
});
// The options dialog is the panel's own business: none built here.
vi.mock('@ui/graphicsPanel', () => ({ createGraphicsPanel: () => ({ open() {} }) }));

describe('the graphics wiring on the weak machine', () => {
  beforeEach(() => window.localStorage.clear());

  it('starts `auto` on the low tier from the UHD 770 named by the run', async () => {
    const { createGraphicsWiring } = await import('@/graphicsWiring');
    const wiring = createGraphicsWiring(() => {});
    expect(parseWeakMachine('uhd770').gpu).toMatch(/UHD Graphics 770/);
    expect(wiring.preset).toBe('auto');
    expect(wiring.level).toBe('low');
    expect(wiring.settings).toEqual(QUALITY.low);
  });

  it('plays the weak machine even where this one kept a higher tier', async () => {
    window.localStorage.setItem('roadcraft.quality', 'ultra');
    const { createGraphicsWiring } = await import('@/graphicsWiring');
    const wiring = createGraphicsWiring(() => {});
    expect(wiring.preset).toBe('auto');
    expect(wiring.level).toBe('low');
  });
});
