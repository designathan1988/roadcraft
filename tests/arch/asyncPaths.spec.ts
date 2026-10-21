import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** THE HEAVY WORK STAYS OFF THE FRAME (2026-10-15) */
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
    // The topology caught up in the simulation's worker (`simHost.ts`), never in the page's frame.
    expect(frame).not.toMatch(/topology\.step\(/);
    expect(read('src/sim/host/simHost.ts')).toMatch(/this\.topology\.step\(sim,/);
  });

  it('builds the world sliced, its roads shaped by the tile workers', () => {
    const renderer = read('src/render/renderer.ts');
    expect(renderer).toMatch(/worldJob = worldSteps\([^;]*, started, true, [^;]*\);/);
    expect(renderer).not.toMatch(/const sliced = /);
    expect(renderer).toMatch(/roadSurfaceSteps\([\s\S]{0,200}sliced \? roadTiles : null,[^)]*\)/);
  });

  it('holds no layer of buildings', () => {
    for (const path of ['src/main.ts', 'src/render/renderer.ts']) expect(read(path)).not.toMatch(/holdBuildings|buildingsHeld/);
  });

  it('reads the diary for the parked cars through the sweep', () => {
    const agents = read('src/render/agents.ts');
    const deck = agents.slice(agents.indexOf('const deckHolds'), agents.indexOf('const deckHolds') + 1200);
    expect(deck.length).toBeGreaterThan(0);
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
    // Through the writer's lane, its buffers handed over (`DerivedWriterLane`, under its ceiling of bytes in flight).
    expect(keep).toMatch(/tileWrites\.post\(tilesPrefix, \[\[key, bundle\]\], buffers, /);
    const surfaces = read('src/render/roadSurfaces.ts');
    expect(surfaces.indexOf('reuse?.keep?.(')).toBeGreaterThan(surfaces.indexOf('mergeMs +='));
  });
});

describe('the workers', () => {
  for (const worker of ['src/render/roadTile.worker.ts', 'src/conflictTable.worker.ts', 'src/render/derivedWriter.worker.ts', 'src/bays.worker.ts', 'src/render/groundShape.worker.ts',
    'src/render/landStroke.worker.ts']) {
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
      .toEqual(['src/editor/growthReplica.ts']);
  });
});

describe('the growth of the buildings', () => {
  // A building grown was designed on the page, in the frame: 28.6 s of a 2,560 m city's 120 s of work, the town stuttering as it grew (2026-10-15). The city's growth and the zones' ask the growth's worker (`growthFeed.ts`).
  const main = read('src/main.ts');
  it('designs no building of a city or a zone on the page', () => {
    for (const name of ['growZones', 'growthAnswered']) {
      expect(bodyOf(main, name), name).not.toMatch(/growOnLot\(|designOnLot\(/);
    }
    expect(bodyOf(main, 'growZones')).toMatch(/growth\.ask\(lotRefused, /);
    expect(main).toMatch(/new GrowthPool\(\(answer\) => growthAnswered\(answer\)/);
    expect(main).toMatch(/new GrowthSession\(growthPool, /);
    // Not even a probe grows on the page: `growTimed` asks the worker as the game does (report UI-15 g: it timed `growOnLot` on the page).
    expect(main).not.toMatch(/growOnLot\(/);
    expect(main).not.toMatch(/designOnLot/);
  });

  it('lays no city frame by frame on the page: a generated city is the small city of 2.0, built whole and put in as one map', () => {
    // A round city was laid on the page 100 ms a frame (`GROW_SLICE_MS`, `layoutSteps`); the small city is built whole (`editor/smallCityMap.ts`) and put in at once (the player, 2026-10-18: no city by tiles).
    expect(main).not.toMatch(/layCity\(|planCity\(|zoneCity\(|GROW_SLICE_MS = /);
    expect(main).toMatch(/generateCity: \(options[^]{0,400}?openSmallCity\(/);
  });

  it('the pool posts to the growth worker, and the page writes only what it answers', () => {
    const pool = read('src/growthPool.ts');
    expect(pool).toMatch(/jobPort\('growth'\)/);
    const feed = read('src/editor/growthFeed.ts');
    expect(feed).not.toMatch(/(designOnLot|growOnLot)\(/);
    // Asked again when the document moved: checked against it before it is written.
    expect(feed.slice(feed.indexOf('  receive('), feed.indexOf('  private lotOpen('))).toMatch(/moved && validateBuilding\(/);
  });
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


describe('the bays of the lots', () => {
  it('are asked of the workers in the game, worked out on the page only by a world without them', () => {
    // The simulation's worker has the pool (`bayPool.ts`), on the page's `bays` lanes it was handed (`jobPool.ts` jobChannel), its own only without them.
    const host = read('src/sim/host/simHost.ts');
    expect(host).toMatch(/this\.bayPool = new BayPool\(this\.lanes\?\.bays\.length \? this\.lanes\.bays : null\);/);
    expect(host).toMatch(/useBayWorkers\(sim, this\.bayPool\);/);
    expect(read('src/main.ts')).toMatch(/jobChannel\(service, \(\) => sim\.laneLost\(service\)\)/);
    expect(read('src/bayPool.ts')).toMatch(/this\.ports \? portWorker\(this\.ports\[k\]!\) : jobPort\('bays'\)/);
    const parking = read('src/sim/agents/parking.ts');
    // A lot looked at is asked of the workers when the world has them; `bayRows` on the page only without.
    expect(bodyOf(parking, 'baysNow')).toMatch(/lookAtLot\([^;]*workers \? asked : null\);/);
    expect(bodyOf(parking, 'baysNow')).toMatch(/workers\.work\(asks\)/);
    expect([...parking.matchAll(/bayRows\(/g)].length).toBe(1);
    const look = bodyOf(parking, 'lookAtLot');
    expect(look).toMatch(/if \(!asked\) \{\s*book\.known\.set\(b\.id, \{ lot, key, bays: bayRows\(pageReads\(w, walls\), b\) \}\);/);
    expect(look).toMatch(/asked\.push\(/);
  });
});

describe('the road tiles made off the page', () => {
  it('are shaped and meshed in the workers, and taken as they come on the page', () => {
    // The worker meshes: every vertex's reads are in the modules it reaches, over the roads handed to it.
    expect([...reach('src/render/roadTile.worker.ts')]).toEqual(expect.arrayContaining([
      'src/render/roadTileMesh.ts', 'src/render/mesh/tileMesh.ts', 'src/render/roadSurfaceReads.ts', 'src/world/roadField.ts']));
    // The page takes a served tile's arrays as they are: DO NOT read its vertices again here.
    const surfaces = read('src/render/roadSurfaces.ts');
    const buildAll = surfaces.slice(surfaces.indexOf('const buildAll = function*'), surfaces.indexOf('/** The tiles built afresh this pass'));
    expect(buildAll).toMatch(/const bundle = made \? made\[k - from\]! : reading\(\(\) => tileBundle\(/);
    expect(buildAll).not.toMatch(/bundleOf|meshTileShape|tileShapes/);
    // The pool hands the tiles and answers the ground; it neither shapes nor meshes.
    expect(read('src/render/roadTilePool.ts')).not.toMatch(/meshTileShape\(|tileShapes\(|passSurfaces\(/);
  });
});

describe('the ground and the paving a building cell reads', () => {
  it('are read by the cell workers off shared memory and the roads handed to them, never asked of the page', () => {
    expect([...reach('src/render/buildings/cell.worker.ts')]).toEqual(expect.arrayContaining(['src/world/paving.ts', 'src/world/roadField.ts', 'src/render/sharedGround.ts']));
    const pool = read('src/render/buildings/cellPool.ts');
    // One queue for the pool's workers, the job written when a worker takes it, the roads near the cell packed with it.
    expect(pool).toMatch(/asked\.ticket = submitJob\(\{/);
    // To a job process (`to.sharesMemory` false) the ground goes cut to the plates around the cell (`groundAround`).
    expect(pool).toMatch(/write: \(to\) => \{ asked\.sent = true; return this\.write\(asked, to\.sharesMemory\); \}/);
    expect(pool).toMatch(/const ground = around \? groundAround\(whole, around\) : whole;/);
    expect(pool).toMatch(/asked\.env\.pavedAt\.pack!\(asked\.rect\)/);
    expect(pool).not.toMatch(/readings|'need'/);
    expect(read('src/render/buildings/cell.worker.ts')).toMatch(/runCellJob\(job, workerReads\(job(, \w+)?\)\)/);
    // The plates keep their corners in the shared buffers themselves, and the drawn ground carries them.
    const atlas = read('src/render/flatAtlas.ts');
    expect(atlas).toMatch(/createTerrainSurface\(anisotropy, \{ x: p\.cx, y: p\.cy \}, p\.key, p\.mesh, share\.open\(p\.key\)\)/);
    expect(atlas).toMatch(/renderedHeightAt: Object\.assign\([^\n]*\{ share \}\)/);
    // The renderer's paving packs its roads for a cell.
    expect(read('src/render/renderer.ts')).toMatch(/const pavedHeightAt: PavingSource = Object\.assign\(/);
  });
});
