import { describe, expect, it } from 'vitest';
import { importClosure } from '../../scripts/vite/cook-plugin';

/** The import closure the derived caches are fingerprinted by */
describe('the import closure a fingerprint reads', () => {
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
