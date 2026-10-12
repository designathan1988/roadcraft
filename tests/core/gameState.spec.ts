import { describe, expect, it, vi } from 'vitest';
import { GameState } from '@core/gameState';

const fresh = (wake = vi.fn()) => ({ state: new GameState({ tool: 'inspect', paused: false, speed: 1 }, wake), wake });
/** Lets the queued microtasks (the automatic flush) run. */
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('GameState', () => {
  it('writes a change down with its cause, and nothing when the value is the same', () => {
    const { state } = fresh();
    expect(state.set('tool', 'road', 'ferramenta escolhida')).toBe(true);
    expect(state.set('tool', 'road', 'de novo')).toBe(false);
    expect(state.values.tool).toBe('road');
    expect(state.latest(5).map((c) => [c.key, c.from, c.to, c.cause])).toEqual([['tool', 'inspect', 'road', 'ferramenta escolhida']]);
  });

  it('tells a watcher once, after the code that changed the state, only its keys, without a frame', async () => {
    const { state, wake } = fresh();
    const told = vi.fn();
    state.watch(['paused', 'speed'], told);
    state.set('paused', true, 'pausa');
    state.set('tool', 'road', 'ferramenta');
    state.set('speed', 3, 'velocidade');
    expect(told).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledTimes(1);
    await settle();
    expect(told).toHaveBeenCalledTimes(1);
    expect((told.mock.calls[0]![0] as { key: string }[]).map((c) => c.key)).toEqual(['paused', 'speed']);
    state.flush();
    expect(told).toHaveBeenCalledTimes(1);
  });

  it('tells what a watcher sets in a later flush, not inside the one telling it', async () => {
    const { state } = fresh();
    const second = vi.fn();
    state.watch(['tool'], () => { state.set('speed', 2, 'reação'); });
    state.watch(['speed'], second);
    state.set('tool', 'road', 'ferramenta');
    state.flush();
    expect(second).not.toHaveBeenCalled();
    await settle();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps telling the others when a watcher throws, and throws its error on its own', async () => {
    const { state } = fresh();
    const after = vi.fn();
    const thrown: unknown[] = [];
    const queue = globalThis.queueMicrotask;
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((fn) => queue(() => { try { fn(); } catch (e) { thrown.push(e); } }));
    state.watch(['tool'], () => { throw new Error('painel quebrado'); });
    state.watch(['tool'], after);
    state.set('tool', 'road', 'ferramenta');
    await settle();
    spy.mockRestore();
    expect(after).toHaveBeenCalledTimes(1);
    expect(thrown.map((e) => (e as Error).message)).toEqual(['painel quebrado']);
  });

  it('stops telling a watcher that went away', async () => {
    const { state } = fresh();
    const told = vi.fn();
    const stop = state.watch(['tool'], told);
    stop();
    state.set('tool', 'road', 'ferramenta');
    await settle();
    expect(told).not.toHaveBeenCalled();
  });

  it('tells null when more changed than the ring keeps', () => {
    const { state } = fresh();
    const told = vi.fn();
    state.watch(['speed'], told);
    for (let i = 1; i <= 600; i++) state.set('speed', i, 'muitas');
    state.flush();
    expect(told).toHaveBeenCalledWith(null);
  });
});
