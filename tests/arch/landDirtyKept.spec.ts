import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** A STROKE'S REGION KEPT WHILE THE SOLVE WAITS (TER-01, VIA-01, 2026-10-19) */
/** Comments blanked: a word in a note is not code. */
const code = (path: string): string => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

describe('the land a stroke moved', () => {
  it('is cleared only once the solve runs, never before a wait for the roads\' stations', () => {
    const renderer = code('src/render/renderer.ts');
    const build = renderer.slice(renderer.indexOf('const buildWorld = (net: Network'), renderer.indexOf('const previousElevation = elevation;'));
    // Cleared before the wait, the next frame had no region: the roads solved from nothing and the ground shaped over the whole map.
    expect(build).toMatch(/if \(stationsWait\) return;\s*landDirty = null;\s*$/);
    expect(build.match(/landDirty = null/g)).toHaveLength(1);
  });
});
