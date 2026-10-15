import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * THE HEAVY WORK STAYS OFF THE FRAME (2026-10-15): what kept a generated
 * city's work on the page, held its layers, or let the workers never run,
 * checked in the code itself so it cannot come back unseen:
 * - the frame never rebuilds the traffic's topology after `net.rebuild()`:
 *   `TopologyCatchUp` brings it up, its turns and pairs in the workers;
 * - the world's rebuild is always the sliced job (`worldSteps(..., true)`),
 *   never run to its end in one frame, and its roads get the tile workers;
 * - nothing holds the buildings' layer (`holdBuildings`);
 * - the parked cars read the diary through the sweep, never `touches` per car;
 * - the workers import pure modules only: no three, no page (their output is
 *   checked byte for byte against the page's in tests/render/roadTileWorkers,
 *   tests/world/turnPlan and the conflict specs).
 */
const read = (path: string): string => readFileSync(path, 'utf8');

/** The body of `function name(` in a source, by its braces. */
function bodyOf(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  expect(at, `function ${name}`).toBeGreaterThan(-1);
  const open = source.indexOf('{', source.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

describe('the frame and the world rebuild', () => {
  it('leaves the topology to TopologyCatchUp after the network is rebuilt in a frame', () => {
    const frame = bodyOf(read('src/main.ts'), 'frame');
    const at = frame.indexOf('net.rebuild();');
    expect(at).toBeGreaterThan(-1);
    const block = frame.slice(at, frame.indexOf('}', at));
    expect(block).not.toMatch(/rebuildSimulationTopology|rebuildTopology|rebuildVehicleTopology/);
    expect(frame).toMatch(/topology\.step\(sim,/);
  });

  it('builds the world sliced, its roads shaped by the tile workers', () => {
    const renderer = read('src/render/renderer.ts');
    expect(renderer).toMatch(/worldJob = worldSteps\([^;]*, true\);/);
    expect(renderer).not.toMatch(/const sliced = /);
    expect(renderer).toMatch(/roadSurfaceSteps\([\s\S]{0,200}sliced \? roadTiles : null\)/);
  });

  it('holds no layer of buildings', () => {
    for (const path of ['src/main.ts', 'src/render/renderer.ts']) expect(read(path)).not.toMatch(/holdBuildings|buildingsHeld/);
  });

  it('reads the diary for the parked cars through the sweep', () => {
    const agents = read('src/render/agents.ts');
    const deck = agents.slice(agents.indexOf('const offRoadDeck'), agents.indexOf('const offRoadDeck') + 1200);
    expect(deck).toMatch(/offRoadSweep!\.touches\(/);
    expect(deck).not.toMatch(/changes\.touches\(/);
  });
});

const ALIASES: [string, string][] = [['@core/', 'src/core/'], ['@world/', 'src/world/'], ['@sim/', 'src/sim/'], ['@render/', 'src/render/'],
  ['@view/', 'src/view/'], ['@editor/', 'src/editor/'], ['@ui/', 'src/ui/'], ['@people/', 'src/people/'], ['@/', 'src/']];
function resolve(from: string, spec: string): string | null {
  const bare = spec.split('?')[0]!;
  const alias = ALIASES.find(([key]) => bare.startsWith(key));
  const base = alias ? alias[1] + bare.slice(alias[0].length) : bare.startsWith('.') ? join(dirname(from), bare) : null;
  if (!base) return bare;
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (candidate.endsWith('.ts') && existsSync(candidate) && statSync(candidate).isFile()) return candidate.split('\\').join('/');
  }
  return null;
}
/** Every module a worker reaches, `src/` files and bare packages. */
function reach(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    for (const f of ts.preProcessFile(read(file), true, true).importedFiles) {
      // Type-only imports carry nothing to the worker.
      const line = read(file).split('\n').find((l) => l.includes(`'${f.fileName}'`)) ?? '';
      if (/^import type /.test(line.trim())) continue;
      const to = resolve(file, f.fileName);
      if (!to || seen.has(to)) continue;
      seen.add(to);
      if (to.endsWith('.ts')) queue.push(to);
    }
  }
  return seen;
}

describe('the road tiles kept for a later session', () => {
  it('are handed to the writer worker, not copied on the page, once their blocks are merged', () => {
    const renderer = read('src/render/renderer.ts');
    const keep = renderer.slice(renderer.indexOf('keep: (key, bundle) =>'), renderer.indexOf('keep: (key, bundle) =>') + 900);
    expect(keep).toMatch(/tileWriter\.postMessage\(\{ prefix: tilesPrefix, entries: \[\[key, bundle\]\] \}, buffers\)/);
    const surfaces = read('src/render/roadSurfaces.ts');
    expect(surfaces.indexOf('reuse?.keep?.(')).toBeGreaterThan(surfaces.indexOf('mergeMs +='));
  });
});

describe('the workers', () => {
  for (const worker of ['src/render/roadTile.worker.ts', 'src/conflictTable.worker.ts', 'src/render/derivedWriter.worker.ts']) {
    it(`${worker} reaches pure modules only`, () => {
      const modules = [...reach(worker)];
      expect(modules.filter((m) => m === 'three' || m.startsWith('three/'))).toEqual([]);
      expect(modules.filter((m) => /src\/(main|render\/renderer|ui\/|view\/|editor\/)/.test(m))).toEqual([]);
    });
  }

  it('src/growth.worker.ts reaches pure modules only: the growth\'s design, never a tool, the page or the drawing', () => {
    const modules = [...reach('src/growth.worker.ts')];
    expect(modules.filter((m) => m === 'three' || m.startsWith('three/'))).toEqual([]);
    expect(modules.filter((m) => /src\/(main|growthPool|render\/|ui\/|view\/|sim\/|people\/)/.test(m))).toEqual([]);
    // Of the editor, the growth's pure part alone (the lot planned, the building made for it, checked).
    expect(modules.filter((m) => m.startsWith('src/editor/')).sort())
      .toEqual(['src/editor/growthReplica.ts', 'src/editor/lotBoundaryRuns.ts', 'src/editor/lotPlan.ts', 'src/editor/zoning.ts']);
  });
});

describe('the growth of the buildings', () => {
  // A building grown was designed on the page, in the frame: 28.6 s of a
  // 2,560 m city's 120 s of work, the town stuttering as it grew (2026-10-15).
  // The city's growth and the zones' ask the growth's worker (`growthFeed.ts`).
  const main = read('src/main.ts');
  it('designs no building of a city or a zone on the page', () => {
    for (const name of ['growCity', 'askCity', 'growZones', 'growthAnswered']) {
      expect(bodyOf(main, name), name).not.toMatch(/growOnLot\(|designOnLot\(/);
    }
    expect(bodyOf(main, 'askCity')).toMatch(/growth\.ask\(lotTool\.refused, /);
    expect(bodyOf(main, 'growZones')).toMatch(/growth\.ask\(lotRefused, /);
    expect(main).toMatch(/new GrowthPool\(\(answer\) => growthAnswered\(answer\)/);
    expect(main).toMatch(/new GrowthSession\(growthPool, /);
    // On the page only the probe that times `growOnLot` itself (`growTimed`) calls it.
    const calls = [...main.matchAll(/growOnLot\(/g)].map((m) => main.lastIndexOf('\n', m.index));
    expect(calls.map((at) => main.slice(at, at + 40).trim().split(':')[0])).toEqual(['growTimed']);
    expect(main).not.toMatch(/designOnLot/);
  });

  it('the pool posts to the growth worker, and the page writes only what it answers', () => {
    const pool = read('src/growthPool.ts');
    expect(pool).toMatch(/new Worker\(new URL\('\.\/growth\.worker\.ts', import\.meta\.url\), \{ type: 'module' \}\)/);
    const feed = read('src/editor/growthFeed.ts');
    expect(feed).not.toMatch(/(designOnLot|growOnLot)\(/);
    // Asked again when the document moved: checked against it before it is written.
    expect(bodyOf(feed.replace('  receive(', 'function receive('), 'receive')).toMatch(/moved && validateBuilding\(/);
  });
});
