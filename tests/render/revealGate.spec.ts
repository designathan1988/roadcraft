import { afterEach, describe, expect, it, vi } from 'vitest';

import { REVEAL_LIMIT_MS, RevealGate } from '@render/revealGate';
import { FrameClock } from '../../src/frameLoop';

/**
 * A town put together behind the loading curtain is shown whole, never
 * half-built because the clock ran (2026-10-09: generating a city in a pane
 * the browser had stopped drawing lifted the curtain after 60 s on streets
 * with no buildings).
 */
describe('the loading curtain', () => {
  it('is not lifted by the clock while the load gets no frames', () => {
    const gate = new RevealGate();
    gate.begin();
    // A frame every 10 s for 3 minutes (the pane hidden): the town never whole.
    for (let t = 0; t <= 180_000; t += 10_000) expect(gate.step(false, t)).toBe('hold');
    expect(gate.opened).toBe(false);
  });

  it('shows the town in one go once whole, after one frame drawn unseen', () => {
    const gate = new RevealGate();
    gate.begin();
    expect(gate.step(false, 0)).toBe('hold');
    expect(gate.step(true, 16)).toBe('warm');
    expect(gate.step(true, 32)).toBe('show');
    expect(gate.opened).toBe(true);
  });

  it('still lifts after a long working time, so it never stays for ever', () => {
    const gate = new RevealGate();
    gate.begin();
    let t = 0, step = gate.step(false, t);
    while (step === 'hold' && t < REVEAL_LIMIT_MS * 2) step = gate.step(false, (t += 250));
    expect(step).toBe('show');
    expect(t).toBeGreaterThan(REVEAL_LIMIT_MS);
  });
});

describe('the frames of a load', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keep coming when the browser draws no frames', async () => {
    // requestAnimationFrame never answers (a hidden or covered page).
    vi.stubGlobal('requestAnimationFrame', () => 0);
    let frames = 0;
    let loading = true;
    const clock: FrameClock = new FrameClock(() => { frames++; if (frames < 5) clock.request(); else loading = false; }, () => loading);
    clock.request();
    await new Promise((r) => setTimeout(r, 50));
    expect(frames).toBe(5);
  });
});
