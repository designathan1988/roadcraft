import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The road system's own folders (docs/VIAS.md): `src/<layer>/roads/` is part
 * of its parent layer and obeys the same dependency order. The lint rule
 * (`eslint.config.js`) reports the aliases; this also follows RELATIVE
 * imports, which the rule cannot see (`../../render/x` from `world/roads/`).
 */
const SRC = join(process.cwd(), 'src');
const LAYERS: Record<string, readonly string[]> = {
  core: ['core'],
  world: ['core', 'world'],
  sim: ['core', 'world', 'sim'],
  view: ['core', 'view'],
  render: ['core', 'world', 'sim', 'view', 'render'],
  editor: ['core', 'world', 'editor'],
  ui: ['core', 'world', 'sim', 'view', 'ui'],
};

function tsFilesUnder(dir: string): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFilesUnder(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** The layer an import specifier lands in, or null for a package. */
function layerOf(file: string, specifier: string): string | null {
  const alias = /^@(\w+)\//.exec(specifier);
  if (alias) return alias[1] ?? null;
  if (specifier.startsWith('@/')) return specifier.slice(2).split('/')[0] ?? null;
  if (!specifier.startsWith('.')) return null;
  const target = relative(SRC, resolve(dirname(file), specifier)).split(sep);
  return target[0] && target[0] !== '..' ? target[0] : null;
}

describe('the road system folders', () => {
  it('import only what their parent layer may', () => {
    const offenders: string[] = [];
    for (const [layer, allowed] of Object.entries(LAYERS)) {
      for (const file of tsFilesUnder(join(SRC, layer, 'roads'))) {
        const body = code(readFileSync(file, 'utf8'));
        for (const match of body.matchAll(/(?:from|import)\s+'([^']+)'/g)) {
          const target = layerOf(file, match[1] as string);
          if (target && target in LAYERS && !allowed.includes(target)) {
            offenders.push(`${relative(SRC, file).split(sep).join('/')} -> ${match[1]}`);
          }
          if (match[1] === 'three' && layer !== 'render') offenders.push(`${relative(SRC, file)} imports three`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares the tuned road figures once, in world/roads/tuning.ts', () => {
    // The figures that used to be scattered must read the tuning, not a literal.
    const reads: [string, RegExp][] = [
      ['world/elevation.ts', /const (GROUND_GRADE|RAMP_GRADE|DECK_GRADE|DECK_TIE|LIFT_ON|LIFT_OFF|MAX_AUTHORED_GRADE) = (?!ROAD_TUNING)/],
      ['world/structures.ts', /TUNNEL_GRADE = (?!ROAD_TUNING)|'(elevated|bridge)'.*clearance: \d/],
      ['world/utilities.ts', /(DEFAULT|MIN|MAX)_POLE_SPACING = (?!ROAD_TUNING)/],
      ['editor/commit.ts', /const (AUTO_TUNNEL_COVER|CROSSING_CLEARANCE) = (?!ROAD_TUNING)/],
      ['editor/editRules.ts', /const (MAX_BUILT_GRADE|PASS_CLEARANCE) = (?!ROAD_TUNING)/],
      ['render/structures.ts', /const spacing = structure === 'bridge' \? \d/],
    ];
    const offenders = reads.filter(([file, literal]) => literal.test(code(readFileSync(join(SRC, file), 'utf8')))).map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
