import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * THE IMPORT GRAPH, RESOLVED. The ESLint layer rule (`eslint.config.js`) bans
 * the aliases (`@render/...`) a layer may not import; a relative path
 * (`../../render/x`) went through it. Here every import of `src/` is resolved
 * to its file (TypeScript's own `preProcessFile`, as the migration tool did),
 * and two rules hold on the result:
 * - the layer order of CLAUDE.md, whatever the spelling of the import;
 * - no import cycle beyond those the SOURCE brought, listed in
 *   `cycles.baseline.json`, which may only shrink (to empty by stage F4).
 */
const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const ALIASES: readonly [string, string][] = [
  ['@core/', 'src/core/'], ['@world/', 'src/world/'], ['@sim/', 'src/sim/'], ['@render/', 'src/render/'], ['@view/', 'src/view/'],
  ['@editor/', 'src/editor/'], ['@ui/', 'src/ui/'], ['@people/', 'src/people/'], ['@/', 'src/'],
];
/** Each layer and what it may import, itself included (CLAUDE.md; `people` is data under `world`). */
const LAYERS: Readonly<Record<string, readonly string[]>> = {
  core: ['core'],
  people: ['core', 'people'],
  world: ['core', 'people', 'world'],
  sim: ['core', 'people', 'world', 'sim'],
  view: ['core', 'view'],
  render: ['core', 'people', 'world', 'sim', 'view', 'render'],
  editor: ['core', 'people', 'world', 'editor'],
  ui: ['core', 'people', 'world', 'sim', 'view', 'ui'],
};

const posix = (p: string): string => p.split(sep).join('/');
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}
function resolve(from: string, spec: string): string | null {
  const bare = spec.split('?')[0]!;
  const alias = ALIASES.find(([key]) => bare.startsWith(key));
  const base = alias ? join(ROOT, alias[1], bare.slice(alias[0].length)) : bare.startsWith('.') ? join(dirname(from), bare) : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (candidate.endsWith('.ts') && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}
const files = tsFiles(SRC);
const graph = new Map<string, string[]>();
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const specs = ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
  for (const m of text.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) specs.push(m[1]!);
  graph.set(file, specs.map((s) => resolve(file, s)).filter((f): f is string => f !== null));
}
const layerOf = (file: string): string | null => {
  const parts = posix(relative(SRC, file)).split('/');
  return parts.length > 1 ? parts[0]! : null;
};

/** Strongly connected components with more than one file (Tarjan). */
function cycles(): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string): void => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      for (;;) { const w = stack.pop()!; on.delete(w); scc.push(posix(relative(ROOT, w))); if (w === v) break; }
      if (scc.length > 1) out.push(scc.sort());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return out.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

describe('the import graph', () => {
  it('keeps the layer order, relative imports included', () => {
    const wrong: string[] = [];
    for (const [file, targets] of graph) {
      const from = layerOf(file);
      if (!from) continue; // main.ts and the wiring files are the composition root.
      const allowed = LAYERS[from];
      if (!allowed) { wrong.push(`${posix(relative(SRC, file))}: layer "${from}" is not in the table`); continue; }
      for (const target of targets) {
        const to = layerOf(target);
        if (to && !allowed.includes(to)) wrong.push(`${posix(relative(SRC, file))} -> ${posix(relative(SRC, target))}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('adds no import cycle to those the SOURCE brought, and keeps none that is gone', () => {
    const baseline = JSON.parse(readFileSync(join(ROOT, 'tests/arch/cycles.baseline.json'), 'utf8')) as string[][];
    const now = cycles();
    const fits = (scc: string[]): boolean => baseline.some((b) => scc.every((f) => b.includes(f)));
    const grown = now.filter((scc) => !fits(scc));
    const gone = baseline.filter((b) => !now.some((scc) => b.every((f) => scc.includes(f))));
    expect(grown, 'new or larger cycles').toEqual([]);
    expect(gone, 'cycles fixed: take them out of cycles.baseline.json').toEqual([]);
  });
});
