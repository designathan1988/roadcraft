import { describe, expect, it, vi } from 'vitest';
import { DynamicResolution } from '@core/dynamicResolution';
import { tierForGpu } from '@core/gpuTier';
import { SampleRing } from '@core/sampleRing';
import { FrameClock } from '@/frameLoop';

/** THE GRAPHICS OPTIONS' ARITHMETIC: the first tier by the GPU's name, the dynamic resolution, the ring read by count. */

describe('tierForGpu', () => {
  it('reads the names ANGLE and Mesa give', () => {
    const cases: [string, string][] = [
      ['ANGLE (Intel, Intel(R) UHD Graphics 770 (0x00004680) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
      ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
      ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
      ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ultra'],
      ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
      ['ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
      ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
      ['ANGLE (NVIDIA, NVIDIA GeForce GTX 960 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
      ['ANGLE (NVIDIA, NVIDIA GeForce MX450 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
      ['ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ultra'],
      ['ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
      ['ANGLE (AMD, AMD Radeon RX 9070 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ultra'],
      ['ANGLE (AMD, Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
      ['ANGLE (AMD, AMD Custom GPU 0405 (radeonsi, vangogh, LLVM 15.0.7, DRM 3.54), OpenGL 4.6)', 'medium'],
      ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'low'],
      ['llvmpipe (LLVM 15.0.7, 256 bits)', 'low'],
      ['Apple M2 Max', 'ultra'],
      ['', 'medium'],
    ];
    for (const [label, tier] of cases) expect(tierForGpu(label), label).toBe(tier);
  });
});

describe('DynamicResolution', () => {
  /** A decision's worth of frames, and the samples left out after a change before them (`SETTLE`). */
  const feeder = (drs: DynamicResolution) => (ms: number): number | null => {
    let last: number | null = null;
    for (let i = 0; i < 35; i++) last = drs.sample(ms, 16.7) ?? last;
    return last;
  };

  it('stays whole while the frames fit, falls when they do not, and rises back by steps', () => {
    const drs = new DynamicResolution(0.5);
    const feed = feeder(drs);
    expect(feed(8)).toBeNull();
    expect(drs.scale).toBe(1);
    // Twice the budget: the pixels a half of it (the linear scale near 0.65), at once, to the step under it.
    expect(feed(33.4)).toBe(0.6);
    // Never under the floor.
    feed(400);
    expect(drs.scale).toBe(0.5);
    // Cheap frames: up a step at a time, never past the whole.
    expect(feed(1) ?? feed(1)).toBe(0.6);
    for (let i = 0; i < 10; i++) feed(1);
    expect(drs.scale).toBe(1);
  });

  it('draws only a few fixed scales, so the targets of the screen are not made again for every small change (JOB-11)', () => {
    const drs = new DynamicResolution(0.5);
    const feed = feeder(drs);
    const seen = new Set<number>();
    for (let k = 0; k < 200; k++) {
      const scale = feed(10 + 15 * Math.abs(Math.sin(k * 0.7)));
      if (scale !== null) seen.add(scale);
    }
    for (const scale of seen) expect([1, 0.9, 0.8, 0.7, 0.6, 0.5]).toContain(scale);
  });

  it('does not breathe on a steady cost between two steps (JOB-11)', () => {
    const drs = new DynamicResolution(0.5);
    const feed = feeder(drs);
    // A cost that wants a scale of about 0.86 at the whole: down to 0.8 once, and there it stays.
    const at1 = (16.7 * 0.85) / 0.86 ** 2;
    let changes = 0;
    for (let k = 0; k < 50; k++) {
      // The cost goes with the pixels drawn.
      if (feed(at1 * drs.scale ** 2) !== null) changes++;
    }
    expect(drs.scale).toBe(0.8);
    expect(changes).toBe(1);
  });

  it('leaves out the samples that come back after a change, which are of the scale before (JOB-11)', () => {
    const drs = new DynamicResolution(0.5);
    for (let i = 0; i < 30; i++) drs.sample(33.4, 16.7);
    expect(drs.scale).toBe(0.6);
    // The late samples of the old, dear frames: they would push it down again.
    for (let i = 0; i < 5; i++) drs.sample(33.4, 16.7);
    for (let i = 0; i < 30; i++) drs.sample(10, 16.7);
    expect(drs.scale).toBe(0.6);
  });

  it('ignores a cost or budget it cannot read', () => {
    const drs = new DynamicResolution();
    for (let i = 0; i < 60; i++) expect(drs.sample(Number.NaN, 16.7)).toBeNull();
    for (let i = 0; i < 60; i++) expect(drs.sample(30, 0)).toBeNull();
  });
});

describe('SampleRing read by count', () => {
  it('names the newest samples past its capacity', () => {
    const ring = new SampleRing(4);
    for (let i = 1; i <= 6; i++) ring.push(i);
    expect(ring.pushed).toBe(6);
    expect([ring.newest(0), ring.newest(1), ring.newest(3)]).toEqual([6, 5, 3]);
  });
});

describe('FrameClock frame limit', () => {
  it('holds the cap on a display faster than it, and lets every frame through without one', () => {
    let pending: ((now: number) => void) | null = null;
    vi.stubGlobal('requestAnimationFrame', (run: (now: number) => void) => { pending = run; return 1; });
    try {
      const drawn: number[] = [];
      const clock = new FrameClock((now) => { drawn.push(now); clock.request(); });
      // A 144 Hz display for one second, capped at 60.
      clock.limit(60);
      clock.request();
      for (let vsync = 1; vsync <= 144; vsync++) pending!(vsync * (1000 / 144));
      expect(drawn.length).toBeGreaterThanOrEqual(59);
      expect(drawn.length).toBeLessThanOrEqual(61);
      // No cap: every display frame drawn.
      drawn.length = 0;
      clock.limit(0);
      for (let vsync = 145; vsync <= 288; vsync++) pending!(vsync * (1000 / 144));
      expect(drawn.length).toBe(144);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
