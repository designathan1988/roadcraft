import { describe, expect, it } from 'vitest';
import { RerootMap } from '@core/rerootMap';

const view = (map: RerootMap<number, string>): [number, string][] => [...map.entries()].sort((a, b) => a[0] - b[0]);

describe('a persistent map by rerooting', () => {
  it('keeps every version as it was, whichever version is derived from next', () => {
    const v0 = new RerootMap<number, string>();
    v0.set(1, 'a');
    v0.set(2, 'b');
    v0.seal();
    const v1 = v0.derive();
    v1.set(1, 'A');
    v1.delete(2);
    v1.set(3, 'c');
    v1.seal();
    // A second branch from the first version: the root moves back to it, then on to the branch.
    const v2 = v0.derive();
    v2.set(2, 'B');
    v2.seal();
    const v3 = v1.derive();
    v3.set(4, 'd');
    v3.seal();
    expect(view(v0)).toEqual([[1, 'a'], [2, 'b']]);
    expect(view(v1)).toEqual([[1, 'A'], [3, 'c']]);
    expect(view(v2)).toEqual([[1, 'a'], [2, 'B']]);
    expect(view(v3)).toEqual([[1, 'A'], [3, 'c'], [4, 'd']]);
    expect([v0.get(2), v1.get(2), v2.get(2), v3.get(2)]).toEqual(['b', undefined, 'B', undefined]);
  });

  it('refuses a write to a version already sealed, and a version derived before it is sealed', () => {
    const v0 = new RerootMap<number, string>();
    expect(() => v0.derive()).toThrow();
    v0.seal();
    expect(() => v0.set(1, 'a')).toThrow();
  });
});
