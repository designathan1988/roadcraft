import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EN } from '@ui/i18n/en';
import { isTerrainMode } from '@world/terrain';
import { TOOLS } from '@editor/toolMachine';

/** Keys the CODE asks for exist. */
const root = fileURLToPath(new URL('../../src', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') ? [path] : [];
  });
const sources = walk(root).filter((path) => !path.includes(`${join('ui', 'i18n')}`));

const defined = (key: string): boolean => key in EN || `${key}.one` in EN;

/** Functions whose first argument is a dictionary key. */
const KEY_CALLS = /\b(?:t|plural|flashHint|flash|notify|menuNote)\(\s*'([a-z][\w-]*(?:\.[\w-]+)+)'/g;

describe('keys used in code', () => {
  it('every literal key passed to a translation call is defined', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const path of sources) {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(KEY_CALLS)) {
        seen++;
        const key = match[1] as string;
        if (!defined(key)) missing.push(`${key} (${path.slice(root.length + 1)})`);
      }
    }
    expect(seen).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });

  it('every tool has its desktop hint, and every terrain brush its own', () => {
    const tools = TOOLS;
    expect(tools.length).toBeGreaterThan(6);
    const missing: string[] = [];
    for (const tool of tools) {
      // The Builder derives its hint from its own state (buildingsWiring).
      if (tool === 'building' || tool === 'terrain') continue;
      if (!defined(`hint.${tool}`)) missing.push(`hint.${tool}`);
    }
    for (const mode of ['raise', 'lower', 'flatten', 'river']) {
      expect(isTerrainMode(mode)).toBe(true);
      if (!defined(`hint.terrain.${mode}`)) missing.push(`hint.terrain.${mode}`);
    }
    for (const alignment of ['curve', 'free']) {
      if (!defined(`hint.road.${alignment}`)) missing.push(`hint.road.${alignment}`);
    }
    expect(missing).toEqual([]);
  });

  it('every traced run the Builder can arm has a hint', () => {
    const wiring = readFileSync(join(root, 'buildingsWiring.ts'), 'utf8');
    // The run ids and the element kind each one lays: `id === 'wallRun' ? 'wall' : ...`.
    const choice = /const kind = (id === '\w+Run'[^;]+);/.exec(wiring)?.[1] ?? '';
    const kinds = new Set([...choice.matchAll(/'(\w+)'/g)].map((m) => m[1] as string).filter((k) => !k.endsWith('Run')));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    const missing = [...kinds].filter((kind) => !defined(`hint.builder.run.${kind}`));
    expect(missing).toEqual([]);
  });

  /** Every key of the dictionaries is one the game can ask for */
  it('every key of the dictionaries is asked for by the code', () => {
    const pages = [...sources, fileURLToPath(new URL('../../index.html', import.meta.url))];
    const text = pages.map((path) => readFileSync(path, 'utf8')).join('\n');
    const quoted = new Set([...text.matchAll(/['"`]([\w.-]+)['"`]/g)].map((m) => m[1] as string));
    const escape = (s: string): string => s.replace(/[.-]/g, (c) => `\\${c}`);
    const built = [...text.matchAll(/`([\w.-]*(?:\$\{[^}`]*\}[\w.-]*)+)`/g)]
      .map((m) => m[1] as string)
      // A template with no word of its own (`${prefix}.${tool}`) would stand for any key.
      .filter((template) => template.includes('.') && /[a-z]/i.test(template.replace(/\$\{[^}]*\}/g, '')))
      .map((template) => new RegExp(`^${template.split(/\$\{[^}]*\}/).map(escape).join('([\\w.-]+?)')}$`));
    // What one `${...}` may stand for: one segment, a number (`fx.${key}.${v}` with v 0.25, the shortest fill first), or a dotted text the code itself writes or builds
    const fills = (part: string): boolean => !part.includes('.') || /^\d+\.\d+$/.test(part) || quoted.has(part)
      || built.some((pattern) => pattern.exec(part)?.slice(1).every((inner) => !inner.includes('.')) ?? false);
    const asked = (key: string): boolean => quoted.has(key)
      || built.some((pattern) => pattern.exec(key)?.slice(1).every(fills) ?? false);
    const PLURAL = /\.(zero|one|two|few|many|other)$/;
    const unused = Object.keys(EN).filter((key) => !asked(key) && !asked(key.replace(PLURAL, '')));
    expect(built.length).toBeGreaterThan(50);
    expect(unused).toEqual([]);
  });
});
