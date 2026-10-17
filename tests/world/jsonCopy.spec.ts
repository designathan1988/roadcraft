import { describe, expect, it } from 'vitest';
import { blueprintByKey } from '@world/buildings/blueprints';
import { type Building, jsonCopy } from '@world/buildings/types';

/** A copy as JSON would make it, without the text (`jsonCopy`, what `cloneBuilding` is) */

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

describe('a copy by the rules of JSON', () => {
  it('makes what the JSON round trip makes, member order and all, sharing nothing', () => {
    const shared = { a: 1 };
    const odd: Record<string, unknown> = {
      z: -0, n: Number.NaN, inf: -Infinity, u: undefined, f: () => 1, s: Symbol('x'), str: 'é', t: true, nil: null,
      arr: [undefined, () => 2, -0, Infinity, 'x', [1, [2]], shared], again: shared, 10: 'ten', 2: 'two',
      when: new Date(0), typed: new Float64Array([1.5, -0]), set: new Set([1]), deep: { x: { y: { z: [{}] } } },
    };
    Object.defineProperty(odd, '__proto__', { value: { p: 1 }, enumerable: true, writable: true, configurable: true });
    const copy = jsonCopy(odd) as Record<string, unknown>;
    expect(JSON.stringify(copy)).toBe(JSON.stringify(roundTrip(odd)));
    expect(copy).toStrictEqual(roundTrip(odd));
    expect(Object.is(copy['z'], 0)).toBe(true);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy['again']).not.toBe(shared);
    expect((copy['arr'] as unknown[])[6]).not.toBe(copy['again']);
  });

  it('copies every blueprint as the round trip does', () => {
    for (const key of ['house', 'tower', 'shop', 'apartment']) {
      const b = blueprintByKey(key)?.body as unknown as Building | undefined;
      if (!b) continue;
      expect(JSON.stringify(jsonCopy(b))).toBe(JSON.stringify(roundTrip(b)));
      expect(jsonCopy(b)).toStrictEqual(roundTrip(b));
    }
  });
});
