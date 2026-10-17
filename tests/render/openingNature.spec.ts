import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/** THE OPENING DOES NOT WAIT FOR THE NATURE'S KIT AFTER THE WORLD IS IN (`renderer.ts` startNatureTrees, the curtain's `whole`) */
describe('the opening and the nature trees', () => {
  it('starts making the trees\' kit with the first roads, while the world is still being built', () => {
    const source = readFileSync('src/render/renderer.ts', 'utf8');
    const calls = source.split('\n').filter((line) => /startNatureTrees\(\);/.test(line) && !/const startNatureTrees/.test(line));
    expect(calls.length).toBe(1);
    // Not held back by the world's job: the kit reads nothing of the world.
    expect(calls[0]).not.toMatch(/worldJob/);
    expect(calls[0]).toMatch(/roads !== null/);
    // The curtain still waits for the trees themselves.
    expect(source).toMatch(/const whole = [^\n]*natureTreesStarted && !natureTreesPending/);
  });
});
