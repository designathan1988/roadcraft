import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importClosure } from '../../scripts/vite/cook-plugin';

/** A file reached only by an import for its effect, or only through the `@/` alias, is code the bake runs: a change to it must change the fingerprint. */
describe('the import closure follows every way a file is reached', () => {
  it('through an import for its effect alone and through `@/`', () => {
    const root = mkdtempSync(join(tmpdir(), 'cook-closure-'));
    try {
      mkdirSync(join(root, 'src', 'lib'), { recursive: true });
      writeFileSync(join(root, 'src', 'entry.ts'), "import './effect';\nimport { b } from '@/lib/named';\nexport const a = b;\n");
      writeFileSync(join(root, 'src', 'effect.ts'), 'export {};\n');
      writeFileSync(join(root, 'src', 'lib', 'named.ts'), 'export const b = 1;\n');
      const at = root.replace(/\\/g, '/').length + 1;
      const closure = importClosure(root, 'src/entry.ts').map((file) => file.replace(/\\/g, '/').slice(at));
      expect(closure).toEqual(['src/effect.ts', 'src/entry.ts', 'src/lib/named.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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
