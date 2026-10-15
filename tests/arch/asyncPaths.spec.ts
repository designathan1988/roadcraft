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
 * - the ground's cut and fill and the comparison of two solves go to the
 *   ground's worker whenever it is there, never a corner shaped on the page;
 * - the workers import pure modules only: no three, no page (their output is
 *   checked byte for byte against the page's in tests/render/roadTileWorkers,
 *   tests/render/terrainShaping, tests/world/turnPlan and the conflict specs).
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
  for (const worker of ['src/render/roadTile.worker.ts', 'src/conflictTable.worker.ts', 'src/render/derivedWriter.worker.ts', 'src/render/groundShape.worker.ts']) {
    it(`${worker} reaches pure modules only`, () => {
      const modules = [...reach(worker)];
      expect(modules.filter((m) => m === 'three' || m.startsWith('three/'))).toEqual([]);
      expect(modules.filter((m) => /src\/(main|render\/renderer|ui\/|view\/|editor\/)/.test(m))).toEqual([]);
    });
  }
});

describe('the ground cut and filled', () => {
  const renderer = read('src/render/renderer.ts');
  /** The source of `const name = (` up to its closing line. */
  const constBody = (name: string): string => {
    const at = renderer.indexOf(`const ${name} = (`);
    expect(at, name).toBeGreaterThan(-1);
    return renderer.slice(at, renderer.indexOf('\n  };\n', at));
  };

  it('asks the worker for every pass while it is there, and shapes no corner on the page meanwhile', () => {
    const shape = constBody('shapeGround');
    const offPage = shape.indexOf('if (groundWorkers.available || shapings.length) {');
    const here = shape.indexOf('terrain.shapeToRoads(');
    expect(offPage).toBeGreaterThan(-1);
    expect(here).toBeGreaterThan(offPage);
    const branch = shape.slice(offPage, here);
    expect(branch).toMatch(/groundWorkers\.shape\(ask\)/);
    expect(branch).toMatch(/return shaping;\s*\}\s*told\(\);[\s\S]*$/);
    expect(branch).not.toMatch(/shapeCorners|\.shapeAt\(|shapeToRoads/);
    // The page's own pass only once nothing waits for the worker.
    expect(shape.slice(here)).not.toMatch(/shapings\.push/);
  });

  it('puts the passes in place in the order asked, and the world waits for them', () => {
    const land = constBody('landShapes');
    expect(land).toMatch(/shapings\.shift\(\)/);
    expect(land).toMatch(/next\.answers \?\? shapeGroundAsk\(next\.ask\)/);
    const generators = renderer.replace(/function\* /g, 'function ');
    const blocks = bodyOf(generators, 'shapeBlocksSteps');
    expect(blocks).not.toMatch(/BATCH|regions\.slice\(/);
    expect(blocks).toMatch(/while \(!shaping\.landed\) \{ landShapes\(\); if \(shaping\.landed\) break; yield 'wait'; \}/);
    expect(renderer).toMatch(/function\* worldSteps\([\s\S]{0,700}while \(compares\.some\(\(c\) => c && !c\.ready\)\)/);
  });

  it('compares two solves off the page, each block of a solve asked once', () => {
    const compare = constBody('compareSolves');
    expect(compare).toMatch(/groundWorkers\.digest\(job\)/);
    expect(compare).toMatch(/groundReading\.get\(solve\)/);
    expect(renderer).not.toMatch(/const changedBlocks = /);
  });
});

