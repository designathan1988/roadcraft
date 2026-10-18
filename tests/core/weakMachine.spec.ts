import { describe, expect, it } from 'vitest';
import { WEAK_MACHINE, parseWeakMachine } from '@core/weakMachine';
import { tierForGpu } from '@core/gpuTier';
import { deviceGpuCap } from '@render/gpuLedger';

/** A WEAKER MACHINE PLAYED ON THIS ONE FOR A RUN (`core/weakMachine.ts`, ROADCRAFT_WEAK) */

describe('the weak machine of a run', () => {
  it('is none unless a run asks for it', () => {
    expect(WEAK_MACHINE).toEqual({ threads: null, gpu: null, memoryGB: null, pixelRatio: null });
    expect(parseWeakMachine('')).toEqual(WEAK_MACHINE);
  });

  it('plays the player\'s UHD 770 with 8 GB: the low tier, an integrated GPU\'s share of the memory', () => {
    const weak = parseWeakMachine('uhd770');
    expect(weak.threads).toBe(4);
    expect(weak.pixelRatio).toBe(1);
    expect(tierForGpu(weak.gpu!)).toBe('low');
    // 8 GB x 0.5 x 0.5 at most; at 1920 x 1080 and a ratio of 1, the per-pixel budget under it.
    const cap = deviceGpuCap({ memoryGB: weak.memoryGB, renderer: weak.gpu!, pixels: 1920 * 1080 });
    expect(cap).toBeLessThanOrEqual(2 * 2 ** 30);
    expect(cap).toBeLessThan(deviceGpuCap({ memoryGB: 32, renderer: 'NVIDIA GeForce RTX 3060', pixels: 1920 * 1080 * 1.5 * 1.5 }));
  });

  it('takes a preset with its own values over it, and refuses what no machine is', () => {
    expect(parseWeakMachine('uhd770, threads=8')).toMatchObject({ threads: 8, memoryGB: 8 });
    expect(parseWeakMachine('threads=2,dpr=1.25')).toEqual({ threads: 2, gpu: null, memoryGB: null, pixelRatio: 1.25 });
    expect(() => parseWeakMachine('threads=0')).toThrow();
    expect(() => parseWeakMachine('cores=4')).toThrow();
    expect(() => parseWeakMachine('gtx480')).toThrow();
  });
});
