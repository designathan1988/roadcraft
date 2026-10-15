import { describe, expect, it } from 'vitest';
import { Machine, type StateSpec } from '@core/statechart';

/** The SCXML semantics the machine promises (docs/research/controllers.md). */
type E = { type: 'go'; to?: string } | { type: 'ping' } | { type: 'chain' } | { type: 'up' } | { type: 'reset' };

function machine(log: string[]) {
  const ctx = { log };
  const spec = (id: string, extra: Partial<StateSpec<typeof ctx, E>> = {}): StateSpec<typeof ctx, E> => ({
    entry: (_e, c) => c.log.push(`enter ${id}`),
    exit: (_e, c) => c.log.push(`exit ${id}`),
    ...extra,
  });
  let m: Machine<typeof ctx, E> | null = null;
  m = new Machine<typeof ctx, E>('test', {
    root: spec('root', { initial: 'a', on: { ping: [{ actions: (_e, c) => c.log.push('root ping') }], reset: [{ target: 'b' }] } }),
    a: spec('a', {
      parent: 'root',
      on: {
        ping: [{ guard: () => false, actions: (_e, c) => c.log.push('never') }, { actions: (_e, c) => c.log.push('a ping') }, { actions: (_e, c) => c.log.push('second') }],
        go: [{ target: (e) => (e.type === 'go' && e.to) || 'b', actions: (_e, c) => c.log.push('go actions') }],
        chain: [{ target: 'b', actions: () => { m!.send({ type: 'ping' }); log.push('after send inside'); } }],
        up: [{ target: 'root' }],
      },
    }),
    b: spec('b', { parent: 'root', on: { go: [{ target: 'b' }] } }),
  }, 'root', ctx, () => 0);
  return m;
}

describe('the statechart', () => {
  it('enters from the top down at the start, into the initial child', () => {
    const log: string[] = [];
    const m = machine(log);
    expect(m.state).toBe('a');
    expect(log).toEqual(['enter root', 'enter a']);
    expect(m.in('root')).toBe(true);
  });

  it('asks the innermost state first, and within it the first transition whose guard holds', () => {
    const log: string[] = [];
    const m = machine(log);
    log.length = 0;
    m.send({ type: 'ping' });
    expect(log).toEqual(['a ping']);
  });

  it('exits, then runs the transition, then enters; the shared parent stays', () => {
    const log: string[] = [];
    const m = machine(log);
    log.length = 0;
    m.send({ type: 'go', to: 'b' });
    expect(log).toEqual(['exit a', 'go actions', 'enter b']);
    expect(m.state).toBe('b');
  });

  it('leaves and re-enters a state on a transition to itself', () => {
    const log: string[] = [];
    const m = machine(log);
    m.send({ type: 'go', to: 'b' });
    log.length = 0;
    m.send({ type: 'go' });
    expect(log).toEqual(['exit b', 'enter b']);
  });

  it('leaves and re-enters the parent on a transition from a child to that parent (SCXML findLCCA)', () => {
    const log: string[] = [];
    const m = machine(log);
    log.length = 0;
    m.send({ type: 'up' });
    expect(log).toEqual(['exit a', 'exit root', 'enter root', 'enter a']);
    expect(m.state).toBe('a');
  });

  it('leaves and re-enters the state that declares an external transition to its own child', () => {
    const log: string[] = [];
    const m = machine(log);
    log.length = 0;
    m.send({ type: 'reset' });
    expect(log).toEqual(['exit a', 'exit root', 'enter root', 'enter b']);
    expect(m.state).toBe('b');
  });

  it('falls back on the parent when the child has no transition for the event', () => {
    const log: string[] = [];
    const m = machine(log);
    m.send({ type: 'go', to: 'b' });
    log.length = 0;
    m.send({ type: 'ping' });
    expect(log).toEqual(['root ping']);
  });

  it('runs to completion: an event sent during a transition waits for it to finish', () => {
    const log: string[] = [];
    const m = machine(log);
    log.length = 0;
    m.send({ type: 'chain' });
    expect(log).toEqual(['exit a', 'after send inside', 'enter b', 'root ping']);
  });

  it('writes every transition down, newest first', () => {
    const log: string[] = [];
    const m = machine(log);
    m.send({ type: 'go', to: 'b' });
    m.send({ type: 'ping' });
    expect(m.latest(2).map((r) => `${r.from}-${r.event}-${r.to}`)).toEqual(['b-ping-b', 'a-go-b']);
  });

  it('refuses a target that is not a state', () => {
    const m = machine([]);
    expect(() => m.send({ type: 'go', to: 'nowhere' })).toThrow(/no state nowhere/);
  });
});
