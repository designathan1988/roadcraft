import { describe, expect, it } from 'vitest';
import { lowPolyTreeParts } from '@render/lowPolyTrees';

/** VEG-08: the trees' pictures take copies of the near trees' models instead of growing them again: a model grown twice from one seed is the same, so the copy is that model. */
describe('a low-poly tree grown from a seed', () => {
  it('is the same every time it is grown, attribute for attribute', () => {
    for (const kind of ['oak', 'cypress', 'palm'] as const) {
      const a = lowPolyTreeParts(kind, 0x7ee5), b = lowPolyTreeParts(kind, 0x7ee5);
      for (const name of Object.keys(a.body.attributes)) expect(Array.from(b.body.getAttribute(name).array)).toEqual(Array.from(a.body.getAttribute(name).array));
      const copy = a.body.clone();
      expect(Array.from(copy.getAttribute('position').array)).toEqual(Array.from(a.body.getAttribute('position').array));
      expect(b.cards === null).toBe(a.cards === null);
    }
  });
});
