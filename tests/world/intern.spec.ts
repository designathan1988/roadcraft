import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { intern, internedEntries } from '@world/buildings/intern';

/** THE SHAPES THE BUILDINGS SHARE (`intern.ts`): one object for equal members, and no entry kept for a shape collected */

/** The collector, called here (Node: the flag set at run time, the function read from a fresh context). */
setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;

describe('the shared shapes of the buildings', () => {
  it('gives one object for equal members', () => {
    const a = intern({ x: 1.5, y: -2, tag: 'facade' });
    const b = intern({ x: 1.5, y: -2, tag: 'facade' });
    expect(b).toBe(a);
    expect(intern([{ x: 1.5, y: -2, tag: 'facade' }])[0]).toBe(a);
  });

  it('keeps no entry for the shapes no building holds any more: the table falls back once they are collected', async () => {
    const before = internedEntries().entries;
    (() => {
      // Shapes of buildings read and let go, each its own (as a tile's footprints are).
      for (let k = 0; k < 5000; k++) intern({ x: k * 0.37, y: -k * 1.11, part: 'test-only' });
    })();
    expect(internedEntries().entries).toBeGreaterThanOrEqual(before + 5000);
    // Collected, then the registry's callbacks run as tasks (MDN, FinalizationRegistry).
    for (let turn = 0; turn < 20 && internedEntries().entries > before + 50; turn++) {
      collect();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(internedEntries().entries).toBeLessThanOrEqual(before + 50);
  });
});
