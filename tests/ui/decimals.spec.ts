import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';
import { formatDecimal, parseDecimal } from '@ui/i18n';

/**
 * A measure the player reads is written in the interface language's notation:
 * "22,0 m" in Portuguese, "22.0 m" in English. The builder's ghost said
 * "22.0 × 18.0 m" in Portuguese (2026-10-10) and two road panels forced a
 * comma in English; every such text goes through `formatDecimal`.
 */
describe('formatDecimal', () => {
  it('writes the decimal the way the interface language does', () => {
    expect(formatDecimal(22, 1, 'pt-BR')).toBe('22,0');
    expect(formatDecimal(396, 1, 'pt-BR')).toBe('396,0');
    expect(formatDecimal(3.456, 2, 'pt-BR')).toBe('3,46');
    expect(formatDecimal(22, 1, 'en')).toBe('22.0');
    expect(formatDecimal(3.456, 2, 'en')).toBe('3.46');
  });

  it('reads back what the player types, with a comma or a point', () => {
    expect(parseDecimal('3,1')).toBe(3.1);
    expect(parseDecimal('3.1')).toBe(3.1);
    expect(parseDecimal(' 22 ')).toBe(22);
    expect(parseDecimal('3,')).toBe(3);
    expect(parseDecimal(',5')).toBe(0.5);
    expect(parseDecimal('-2,25')).toBe(-2.25);
    expect(parseDecimal('')).toBeNaN();
    expect(parseDecimal('1.234,5')).toBeNaN();
    expect(parseDecimal('abc')).toBeNaN();
  });
});

const SRC = join(process.cwd(), 'src');
// Text the player reads is built in the interface, the overlays and the composition root.
const PLAYER_TEXT = (file: string): boolean =>
  file.startsWith('ui/') || file === 'main.ts' || file === 'buildingsWiring.ts';
// `toFixed` that is not prose: SVG coordinates, probe data, a number input's own value; timings (ms) in the F8/F9 inspectors.
const MACHINE = /="\$\{|dataset\[|input\.value =|d="M/;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFilesUnder(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('measures in player text', () => {
  it('never use toFixed, which always writes a point', () => {
    const offenders: string[] = [];
    for (const path of tsFilesUnder(SRC)) {
      const file = relative(SRC, path).split(sep).join('/');
      if (!PLAYER_TEXT(file)) continue;
      readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (code.includes('.toFixed(') && !MACHINE.test(code) && !/\bms\b/.test(code)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
