import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/check-refs.mjs` on a small tree written here: a path cited in a
 * comment or a document that does not exist is caught, one that exists (a
 * file or a folder, same case) is not, nor a glob or a template; the
 * historical copies are not read; the baseline only shrinks.
 *
 * The tree's paths are written `~src/...` here and unmarked (`u`) when used,
 * so the check run on this repository does not take them for citations.
 */
const script = fileURLToPath(new URL('../../scripts/check-refs.mjs', import.meta.url));
const u = (s: string): string => s.replace(/~/g, '');

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'check-refs-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, u(path))), { recursive: true });
    writeFileSync(join(root, u(path)), u(text));
  }
  return root;
}

function run(root: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout + r.stderr };
}

const list = (root: string): { file: string; line: number; path: string }[] => JSON.parse(run(root, '--list').out);
const baseline = (root: string): Record<string, number> => JSON.parse(readFileSync(join(root, 'refs.baseline.json'), 'utf8'));
const entry = (file: string, path: string): string => `${u(file)}  ${u(path)}`;

describe('check-refs', () => {
  it('flags a cited path that does not exist and accepts one that does', () => {
    const root = tree({
      '~src/world/a.ts': [
        '// Built as `~src/world/b.ts` does it (~docs/GUIDE.md, section 2).',
        '// The old note: ~docs/GONE.md. Specs in ~tests/world/*.spec.ts.',
        "const url = `~public/models/${'x'}.glb`; // and ~src/World/b.ts, wrong case",
        'export const A = 1;',
      ].join('\n'),
      '~src/world/b.ts': 'export const B = 2;\n',
      '~docs/GUIDE.md': 'See ~src/world and ~scripts/missing.mjs.\n',
      '~docs/source/OLD.md': 'A historical copy citing ~src/never.ts.\n',
    });
    try {
      expect(list(root)).toEqual([
        { file: u('~docs/GUIDE.md'), line: 1, path: u('~scripts/missing.mjs') },
        { file: u('~src/world/a.ts'), line: 2, path: u('~docs/GONE.md') },
        { file: u('~src/world/a.ts'), line: 3, path: u('~src/World/b.ts') },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails on a new broken path and on a fixed one left in the baseline; --update only shrinks', () => {
    const root = tree({ '~src/a.ts': '// see ~docs/ONE.md\n', '~src/b.ts': '// see ~docs/TWO.md\n' });
    try {
      expect(run(root, '--update').code).toBe(0);
      expect(baseline(root)).toEqual({ [entry('~src/a.ts', '~docs/ONE.md')]: 1, [entry('~src/b.ts', '~docs/TWO.md')]: 1 });
      expect(run(root).code).toBe(0);

      writeFileSync(join(root, u('~src/c.ts')), u('// see ~docs/THREE.md\n'));
      const added = run(root);
      expect(added.code).toBe(1);
      expect(added.out).toContain(entry('~src/c.ts', '~docs/THREE.md'));
      expect(run(root, '--update').code).toBe(1);

      rmSync(join(root, u('~src/c.ts')));
      writeFileSync(join(root, u('~src/a.ts')), u('// see ~src/b.ts\n'));
      const fixed = run(root);
      expect(fixed.code).toBe(1);
      expect(fixed.out).toContain(entry('~src/a.ts', '~docs/ONE.md'));
      expect(run(root, '--update').code).toBe(0);
      expect(baseline(root)).toEqual({ [entry('~src/b.ts', '~docs/TWO.md')]: 1 });
      expect(run(root).code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
