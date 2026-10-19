import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PointLight } from 'three';
import { createBlast } from '@render/blast';
import type { Exhaust } from '@render/exhaust';

/** A hydrant broken by a blast (`actionsWiring.ts` calls `geyser` with no duration) */

let saved: unknown;

beforeAll(() => {
  saved = (globalThis as { document?: unknown }).document;
  // The soot's canvas (node has none): a 2D context that draws nothing.
  const context = {
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {},
    set fillStyle(_: unknown) {}, set strokeStyle(_: unknown) {}, set lineWidth(_: unknown) {},
  };
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
});

afterAll(() => {
  (globalThis as { document?: unknown }).document = saved;
});

describe('blast geyser', () => {
  it('ends a broken hydrant\'s jet and lets it go', () => {
    let bursts = 0;
    const exhaust = { burst: () => { bursts++; } } as unknown as Exhaust;
    const blast = createBlast(exhaust, new PointLight());
    const world = { groundAt: () => 0 };
    // As the blast wiring calls it: no duration given.
    blast.geyser(10, 20, 0);
    blast.update(1 / 60, world);
    expect(blast.active()).toBe(true);
    expect(bursts).toBeGreaterThan(0);
    // Ten minutes of play.
    for (let frame = 0; frame < 60 * 600; frame++) blast.update(1 / 60, world);
    expect(blast.active()).toBe(false);
    const after = bursts;
    for (let frame = 0; frame < 60; frame++) blast.update(1 / 60, world);
    expect(bursts).toBe(after);
    blast.dispose();
  });

  it('never keeps a jet asked to run for ever', () => {
    const blast = createBlast({ burst: () => {} } as unknown as Exhaust, new PointLight());
    const world = { groundAt: () => 0 };
    blast.geyser(0, 0, 0, Infinity);
    for (let frame = 0; frame < 60 * 600; frame++) blast.update(1 / 60, world);
    expect(blast.active()).toBe(false);
    blast.dispose();
  });
});

describe('the blast and the GPU (AGT-01, AGT-02)', () => {
  it("puts an explosion's flash light out within seconds, not after ~100 s of decay to underflow", () => {
    const exhaust = { burst: () => {} } as unknown as Exhaust;
    const light = new PointLight();
    const blast = createBlast(exhaust, light);
    const world = { groundAt: () => 0 };
    blast.explode(0, 0, 0, 8, 'road');
    blast.update(1 / 60, world);
    expect(light.intensity).toBeGreaterThan(0);
    // Five seconds on: dark (the renderer then leaves the eight point lights out of every shader).
    for (let frame = 0; frame < 60 * 5; frame++) blast.update(1 / 60, world);
    expect(light.intensity).toBe(0);
  });

  it('says a fire or a hydrant casts nothing moving (the cascades kept), debris in flight does', () => {
    const exhaust = { burst: () => {} } as unknown as Exhaust;
    const blast = createBlast(exhaust, new PointLight());
    const world = { groundAt: () => 0 };
    blast.burn(0, 0, 0, 2, 40);
    blast.geyser(10, 0, 0);
    blast.update(1 / 60, world);
    expect(blast.active()).toBe(true);
    expect(blast.casting()).toBe(false);
    blast.explode(0, 0, 0, 8, 'building');
    blast.update(1 / 60, world);
    expect(blast.casting()).toBe(true);
  });
});
