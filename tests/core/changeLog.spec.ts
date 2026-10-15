import { describe, expect, it } from 'vitest';
import { ChangeLog } from '@core/changeLog';

/** A LOG OF CHANGES WITHOUT A LIMIT OF AGE (`ChangeLog`) */
describe('the change log', () => {
  it('tells a reader 1000 changes behind every change, in order', () => {
    const log = new ChangeLog<number>();
    const token = log.state;
    for (let k = 0; k < 1000; k++) log.push(k);
    expect(log.since(token)).toEqual(Array.from({ length: 1000 }, (_, k) => k));
  });

  it('answers every reader the same after the states no one holds are merged away', () => {
    const log = new ChangeLog<number>();
    const tokens = new Map<number, object>();
    for (let k = 0; k < 400; k++) {
      if (k % 40 === 7) tokens.set(k, log.state);
      log.push(k);
    }
    const held = new Set(tokens.values());
    log.merge((state) => held.has(state));
    for (const [k, token] of tokens) expect(log.since(token), `token ${k}`).toEqual(Array.from({ length: 400 - k }, (_, i) => k + i));
    expect((log as unknown as { entries: unknown[] }).entries.length).toBe(tokens.size);
    expect(log.since(log.state)).toEqual([]);
  });

  it('says everything changed past a change of everything', () => {
    const log = new ChangeLog<number>();
    const token = log.state;
    log.push(1);
    log.push(null);
    log.push(2);
    expect(log.since(token)).toBeNull();
    log.merge(() => false);
    expect(log.since(token)).toBeNull();
  });
});
