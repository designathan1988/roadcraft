import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameTimer, HealthLog, frameStats, overBudget, percentile, systemsOf } from '@core/health';

/** Sets what `performance.now()` answers. */
function clockAt(ms: number): void {
  vi.spyOn(performance, 'now').mockReturnValue(ms);
}

afterEach(() => vi.restoreAllMocks());

describe('HealthLog', () => {
  it('writes what broke with its context, newest first', () => {
    const log = new HealthLog();
    clockAt(1000);
    log.record('error', 'broken', 'falhou A', { context: 'ferramenta road' });
    log.record('slow-frame', 'slow', 'Quadro longo: desenho', { ms: 80, systems: [['desenho', 70]] });
    const [latest, first] = log.latest(5);
    expect(latest?.message).toBe('Quadro longo: desenho');
    expect(latest?.systems).toEqual([['desenho', 70]]);
    expect(first?.context).toBe('ferramenta road');
  });

  it('counts a repeat of the same failure on one entry, keeping the longest time', () => {
    const log = new HealthLog();
    clockAt(1000);
    log.record('slow-frame', 'slow', 'Quadro longo: simulação', { ms: 60 });
    clockAt(2000);
    log.record('slow-frame', 'slow', 'Quadro longo: simulação', { ms: 90 });
    clockAt(3000);
    log.record('slow-frame', 'slow', 'Quadro longo: simulação', { ms: 70 });
    expect(log.latest(5)).toHaveLength(1);
    expect(log.latest(1)[0]).toMatchObject({ count: 3, ms: 90 });
    // Long after, it is a new entry.
    clockAt(60_000);
    log.record('slow-frame', 'slow', 'Quadro longo: simulação', { ms: 55 });
    expect(log.latest(5)).toHaveLength(2);
  });

  it('says broken, slow or ok for the last 30 s, and never counts an earlier session', () => {
    const log = new HealthLog();
    clockAt(1000);
    expect(log.status()).toBe('ok');
    log.record('slow-frame', 'slow', 'Quadro longo: desenho', { ms: 70 });
    expect(log.status()).toBe('slow');
    log.record('error', 'broken', 'falhou');
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
    timer.mark('simulação', 104);
    timer.mark('desenho', 160);
    timer.mark('painéis', 161);
    const frame = timer.end(161);
    expect([...frame.systems]).toEqual([['simulação', 4], ['desenho', 56], ['painéis', 1]]);
    expect(overBudget(frame).map(([name]) => name)).toEqual(['desenho']);
    timer.begin(200);
    timer.mark('simulação', 203);
    timer.end(203);
    expect(timer.between(150, 170)).toHaveLength(1);
    expect(systemsOf(timer.between(0, 300))).toEqual([['desenho', 56], ['simulação', 7], ['painéis', 1]]);
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
    const frame = (start: number, sim: number, draw: number, minimap?: number): void => {
      timer.begin(start);
      timer.mark('simulação', start + sim);
      timer.mark('desenho', start + sim + draw);
      if (minimap !== undefined) timer.mark('minimapa', start + sim + draw + minimap);
      timer.end(start + sim + draw + (minimap ?? 0));
    };
    frame(0, 2, 8);
    frame(100, 3, 10, 1);
    frame(200, 4, 60);
    const stats = frameStats(timer.recent());
    expect(stats.frames).toBe(3);
    expect(stats.long).toBe(1);
    expect(stats.total).toEqual({ p50: 14, p95: 64, max: 64 });
    expect(stats.systems['desenho']).toEqual({ p50: 10, p95: 60, max: 60 });
    expect(stats.systems['minimapa']).toEqual({ p50: 0, p95: 1, max: 1 });
  });
});
