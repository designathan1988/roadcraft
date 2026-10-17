import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { intern, internBuckets } from '@world/buildings/intern';

/** THE INTERNER LETS GO OF A SHAPE'S BUCKET ONCE NO BUILDING HOLDS THE SHAPE (`intern.ts` forgetCollected, run by a FinalizationRegistry) */

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const turns = async (n: number): Promise<void> => { for (let k = 0; k < n; k++) await new Promise((r) => setTimeout(r, 0)); };

describe('the shared shapes of the buildings', () => {
  it('do not keep a bucket for every shape ever made once nothing holds them', async () => {
    const before = internBuckets();
    // Shapes made and dropped, as buildings let go with their tiles (none asked again: their buckets are never visited).
    (() => { for (let i = 0; i < 2000; i++) intern({ kind: 'forget-test', width: i + 0.5 }); })();
    expect(internBuckets()).toBeGreaterThanOrEqual(before + 1900);
    for (let k = 0; k < 6 && internBuckets() > before + 100; k++) { gc(); await turns(5); }
    expect(internBuckets()).toBeLessThan(before + 100);
    // One still held stays shared.
    const kept = intern({ kind: 'forget-test', width: -1 });
    gc(); await turns(5);
    expect(intern({ kind: 'forget-test', width: -1 })).toBe(kept);
  });
});
