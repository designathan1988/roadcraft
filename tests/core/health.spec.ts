import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameTimer, HealthLog, frameStats, percentile, systemsOf } from '@core/health';

/** Sets what `performance.now()` answers. */
function clockAt(ms: number): void {
  vi.spyOn(performance, 'now').mockReturnValue(ms);
}

afterEach(() => vi.restoreAllMocks());

describe('HealthLog', () => {
  it('writes what broke with its context, newest first', () => {
    const log = new HealthLog();
    clockAt(1000);
    log.record('error', 'broken', 'failed A', { context: 'tool road' });
    log.record('slow-frame', 'slow', 'Long frame: drawing', { ms: 80, systems: [['drawing', 70]] });
    const [latest, first] = log.latest(5);
    expect(latest?.message).toBe('Long frame: drawing');
    expect(latest?.systems).toEqual([['drawing', 70]]);
    expect(first?.context).toBe('tool road');
  });

  it('counts a repeat of the same failure on one entry, keeping the longest time', () => {
    const log = new HealthLog();
    clockAt(1000);
    log.record('slow-frame', 'slow', 'Long frame: simulation', { ms: 60 });
    clockAt(2000);
    log.record('slow-frame', 'slow', 'Long frame: simulation', { ms: 90 });
    clockAt(3000);
    log.record('slow-frame', 'slow', 'Long frame: simulation', { ms: 70 });
    expect(log.latest(5)).toHaveLength(1);
    expect(log.latest(1)[0]).toMatchObject({ count: 3, ms: 90 });
    // Long after, it is a new entry.
    clockAt(60_000);
    log.record('slow-frame', 'slow', 'Long frame: simulation', { ms: 55 });
    expect(log.latest(5)).toHaveLength(2);
  });

  it('says broken, slow or ok for the last 30 s, and never counts an earlier session', () => {
    const log = new HealthLog();
    clockAt(1000);
    expect(log.status()).toBe('ok');
    log.record('slow-frame', 'slow', 'Long frame: drawing', { ms: 70 });
    expect(log.status()).toBe('slow');
    log.record('error', 'broken', 'failed');
    expect(log.status()).toBe('broken');
    clockAt(40_000);
    expect(log.status()).toBe('ok');

    const next = new HealthLog();
    next.restore(log.toJSON());
    expect(next.latest(5).every((e) => e.earlier)).toBe(true);
    expect(next.status()).toBe('ok');
  });
});

describe('FrameTimer', () => {
  it('gives each system the time since the last mark, and finds the frames of a span', () => {
    const timer = new FrameTimer();
    timer.begin(100);
    timer.mark('simulation', 104);
    timer.mark('drawing', 160);
    timer.mark('panels', 161);
    const frame = timer.end(161);
    expect([...frame.systems]).toEqual([['simulation', 4], ['drawing', 56], ['panels', 1]]);
    timer.begin(200);
    timer.mark('simulation', 203);
    timer.end(203);
    expect(timer.between(150, 170)).toHaveLength(1);
    expect(systemsOf(timer.between(0, 300))).toEqual([['drawing', 56], ['simulation', 7], ['panels', 1]]);
  });
});

describe('FrameTimer keeps a stretch of time, not a count', () => {
  it('keeps every frame of the last 30 s (240 frames lost the first second of a 5 s window)', () => {
    const timer = new FrameTimer();
    // 10 s at 60 Hz: 600 frames, all kept.
    for (let i = 0; i < 600; i++) { timer.begin(i * 16.7); timer.end(i * 16.7 + 5); }
    expect(timer.recent().length).toBe(600);
    // 40 s on: the frames older than 30 s let go.
    for (let i = 600; i < 2400; i++) { timer.begin(i * 16.7); timer.end(i * 16.7 + 5); }
    expect(timer.recent()[0]!.end).toBeGreaterThanOrEqual(2399 * 16.7 + 5 - 30_000);
  });
});

describe('frameStats', () => {
  it('takes percentiles by nearest rank: always one of the values, the 100th the largest', () => {
    const values = [15, 20, 35, 40, 50];
    expect(percentile(values, 50)).toBe(35);
    expect(percentile(values, 95)).toBe(50);
    expect(percentile(values, 100)).toBe(50);
    expect(percentile(values, 1)).toBe(15);
    expect(percentile([], 50)).toBe(0);
  });

  it('sums up the frames per system, a system absent from a frame counting as 0 ms there', () => {
    const timer = new FrameTimer();
    const frame = (start: number, sim: number, draw: number, overlay?: number): void => {
      timer.begin(start);
      timer.mark('simulation', start + sim);
      timer.mark('drawing', start + sim + draw);
      if (overlay !== undefined) timer.mark('overlay', start + sim + draw + overlay);
      timer.end(start + sim + draw + (overlay ?? 0));
    };
    frame(0, 2, 8);
    frame(100, 3, 10, 1);
    frame(200, 4, 60);
    const stats = frameStats(timer.recent());
    expect(stats.frames).toBe(3);
    expect(stats.long).toBe(1);
    expect(stats.total).toEqual({ p50: 14, p95: 64, max: 64 });
    expect(stats.systems['drawing']).toEqual({ p50: 10, p95: 60, max: 60 });
    expect(stats.systems['overlay']).toEqual({ p50: 0, p95: 1, max: 1 });
  });
});
