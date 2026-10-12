import { describe, expect, it } from 'vitest';
import { importClosure } from '../../cook-plugin';

/**
 * The cooked people are used only under the fingerprint of the code that
 * builds them (`cook-plugin.ts`). Hashing whole folders staled every cooked
 * body on an edit to code no body uses - the procedural crowd - and the game
 * built each one during play, 200-550 ms a body (docs/performance.md #7).
 */
describe('the people cook fingerprint', () => {
  const closure = importClosure(process.cwd(), 'src/render/riggedCitizens.ts')
    .map((file) => file.replace(/\\/g, '/').replace(`${process.cwd().replace(/\\/g, '/')}/`, ''));

  it('reads the code that builds a cooked body', () => {
    for (const file of ['src/render/riggedCitizens.ts', 'src/render/citizenBake.ts', 'src/render/citizenWalk.ts',
      'src/render/people/personRig.ts', 'src/render/people/cookedPerson.ts', 'src/people/body/morph.ts']) {
      expect(closure).toContain(file);
    }
  });

  it('does not read code no cooked body is built by', () => {
    for (const file of ['src/render/people/proceduralCrowd.ts', 'src/people/hair/procedural.ts', 'src/render/agents.ts',
      'src/render/renderer.ts']) {
      expect(closure).not.toContain(file);
    }
  });
});
