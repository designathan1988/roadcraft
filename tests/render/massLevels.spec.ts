import { refOf } from '@world/buildings/recordTable';
import { describe, expect, it } from 'vitest';
import type { Mesh, Object3D } from 'three';

import { type CellMass, cellMass } from '@render/buildings/cellArrays';
import type { CellEnv, CellPool } from '@render/buildings/cellPool';
import { type CellEntry, type CellJob, type CellResult, type JobKind, runCellJob } from '@render/buildings/cellWork';
import { createBuildingKit } from '@render/buildings/kit';
import { createMassCells } from '@render/buildings/massCells';
import type { PackedEntries } from '@render/buildings/chunk';
import { MassLevels } from '@render/buildings/massLevels';
import { plateOf, tileOf } from '@render/buildings/levelKeys';
import { CELL_DETAIL, PLATE_DETAIL, TILE_DETAIL, emitMassing, emitMassingLevels } from '@render/buildings/massing';
import { drawsSignature } from '@render/buildings/signature';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';

/** THE BUILDINGS' TILES (L2) AND PLATES (L3): chosen by their error on the screen, in place of their cells, asked again only where a cell changed */
const CELL = m(256);
const flat = (): number => 0;

function building(index: number, x: number, y: number): Building {
  const bp = BLUEPRINTS[index % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), id: index + 1, x, y, rotation: 0 } as Building;
}

/** The masses of a few buildings in a cell, with the error a level says it left out. */
function masses(x: number, y: number, error = 0): CellMass {
  const chunks = [0, 1, 2].map((i) => emitMassing(building(i, x + i * m(40), y + m(20)), flat)!);
  return { ...cellMass(chunks)!, error };
}

const meshNamed = (root: Object3D, name: string): Mesh[] => {
  const out: Mesh[] = [];
  root.traverse((o) => { if (o.name === name && (o as Mesh).isMesh) out.push(o as Mesh); });
  return out;
};

describe('a tile or a plate of masses drawn in place of its cells', () => {
  it('lets nothing go for a coarser choice a frame tried and did not keep: the masses neither leave the scene nor are asked again (the still view, `__stillLog`)', () => {
    const kit = createBuildingKit();
    const released: string[] = [];
    const far = createMassCells(kit, CELL, (key) => released.push(key));
    far.land('0,0', masses(m(10), m(10)));
    far.land('1,0', masses(CELL + m(10), m(10)));
    far.planLevel(tileOf(0, 0));
    const choose = (orthoPx: number): void => far.choose(m(128), m(128), m(500), 1000, orthoPx, false);
    choose(2);
    far.landLevel(tileOf(0, 0), masses(m(10), m(10), m(4)));
    far.landLevel(plateOf(0, 0), masses(m(10), m(10), m(10)));
    choose(2);
    far.settle();
    const before = meshNamed(far.group, 'building-massing');
    expect(before).toHaveLength(2);
    let removed = 0;
    far.group.addEventListener('childremoved', () => { removed++; });
    // The frame's error scales tried: a coarse one (the tile, then the plate whole), and the one kept, close.
    for (let frame = 0; frame < 10; frame++) {
      choose(0.3);
      choose(0.1);
      choose(2);
      far.settle();
    }
    expect(removed).toBe(0);
    expect(released).toEqual([]);
    expect(meshNamed(far.group, 'building-massing')).toEqual(before);
    expect(meshNamed(far.group, 'building-massing-tile')).toHaveLength(1);
    // Kept coarse at the frame's end: let go then.
    choose(0.3);
    far.settle();
    expect(released.sort()).toEqual(['0,0', '1,0']);
    far.dispose();
  });

  it('is chosen by what it leaves out on the screen, hides its cells, and gives way to them near', () => {
    const kit = createBuildingKit();
    const released: string[] = [];
    const far = createMassCells(kit, CELL, (key) => released.push(key));
    far.land('0,0', masses(m(10), m(10)));
    far.land('1,0', masses(CELL + m(10), m(10)));
    far.planLevel(tileOf(0, 0));
    // A frame's choice, and its end (`settle`): what it left unexposed or unwanted let go.
    const look = (orthoPx: number, near: boolean | ReadonlySet<string> = false): void => { far.choose(m(128), m(128), m(500), 1000, orthoPx, near); far.settle(); };
    // Close first: the plate refined, so its tile is wanted and its masses taken.
    look(2);
    far.landLevel(tileOf(0, 0), masses(m(10), m(10), m(4)));
    far.landLevel(plateOf(0, 0), masses(m(10), m(10), m(10)));
    // A cell's mesh by where it stands.
    const cellMesh = (key: string): Mesh | undefined => meshNamed(far.group, 'building-massing').find((mesh) => (mesh.geometry.boundingBox!.min.x < CELL) === (key === '0,0'));
    const tile = meshNamed(far.group, 'building-massing-tile')[0]!;
    const plate = meshNamed(far.group, 'building-massing-plate')[0]!;

    // Close: the cells, near; no level drawn.
    look(2);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(far.near('0,0')).toBe(true);
    expect(tile.visible).toBe(false);
    expect(plate.visible).toBe(false);
    // A tile's 4 m under 2 px (0.3 px a metre): the tile, its cells far and their masses let go (neither drawn nor wanted).
    look(0.3);
    expect(far.coarse(tileOf(0, 0))).toBe(true);
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(tile.visible).toBe(true);
    expect(plate.visible).toBe(false);
    for (const key of ['0,0', '1,0']) {
      expect(far.near(key)).toBe(false);
      expect(cellMesh(key)).toBeUndefined();
    }
    expect(released.sort()).toEqual(['0,0', '1,0']);
    expect([...far.nearKeys()]).toEqual([]);
    // Hysteresis: a tile drawn stays drawn up to its 2 px (4 m at 0.45 px is 1.8 px).
    look(0.45);
    expect(far.coarse(tileOf(0, 0))).toBe(true);
    // The plate's 10 m under 2 px: the plate alone, the tile under it let go.
    released.length = 0;
    look(0.1);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(plate.visible).toBe(true);
    expect(meshNamed(far.group, 'building-massing-tile')).toEqual([]);
    expect(released).toEqual([tileOf(0, 0)]);
    expect(far.wanted(tileOf(0, 0))).toBe(false);
    // A tile coming while its plate stands for it: never uploaded.
    released.length = 0;
    far.landLevel(tileOf(0, 0), masses(m(10), m(10), m(4)));
    expect(meshNamed(far.group, 'building-massing-tile')).toEqual([]);
    expect(released).toEqual([tileOf(0, 0)]);
    // A cell held near (cut open, edited): neither its tile nor its plate stands in for it.
    look(0.1, new Set(['0,0']));
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(far.near('0,0')).toBe(true);
    // Back close: the cells again, their masses asked again and shown (no detail landed for them).
    look(2);
    expect(plate.visible).toBe(false);
    expect(far.near('1,0')).toBe(true);
    expect([...far.exposedCells()].sort()).toEqual(['0,0', '1,0']);
    far.land('0,0', masses(m(10), m(10)));
    far.land('1,0', masses(CELL + m(10), m(10)));
    look(2);
    expect(cellMesh('1,0')!.visible).toBe(true);
    // Refined from a tile not drawn: hysteresis the other way (4 m at 0.45 px is 1.8 px, over 0.85 of 2).
    far.landLevel(tileOf(0, 0), masses(m(10), m(10), m(4)));
    look(0.45);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    // A level with no mass never stands in for its cells.
    far.landLevel(tileOf(0, 0), null);
    look(0.3);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(cellMesh('1,0')!.visible).toBe(true);
    far.dispose();
    kit.dispose();
  });

  it('refining, the plate drawn stands until its tile has come, and the tile until its cells have (no hole)', () => {
    const kit = createBuildingKit();
    const far = createMassCells(kit, CELL);
    far.planLevel(tileOf(0, 0));
    far.plan('0,0', 0, m(30));
    const look = (orthoPx: number): void => far.choose(m(128), m(128), m(500), 1000, orthoPx, false);
    far.landLevel(plateOf(0, 0), masses(m(10), m(10), m(10)));
    look(0.1);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    // Nearer: the tile is wanted and has not come; the plate stays drawn meanwhile.
    look(0.3);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    expect(far.waiting).toBeGreaterThan(0);
    far.landLevel(tileOf(0, 0), masses(m(10), m(10), m(4)));
    look(0.3);
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(far.coarse(tileOf(0, 0))).toBe(true);
    // Close: the cell's masses not come, the tile stands; once come, the cell.
    look(2);
    expect(far.coarse(tileOf(0, 0))).toBe(true);
    expect([...far.exposedCells()]).toEqual(['0,0']);
    far.land('0,0', masses(m(10), m(10)));
    look(2);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(far.near('0,0')).toBe(true);
    far.dispose();
    kit.dispose();
  });

  it('leaves out more the higher its level, and says how much', () => {
    let cell = 0, tile = 0, plate = 0, tileError = 0, plateError = 0;
    for (let i = 0; i < BLUEPRINTS.length; i++) {
      const b = building(i, 0, 0);
      const c = emitMassing(b, flat, undefined, flat, false, undefined, CELL_DETAIL);
      const t = emitMassing(b, flat, undefined, flat, false, undefined, TILE_DETAIL);
      const p = emitMassing(b, flat, undefined, flat, false, undefined, PLATE_DETAIL);
      if (!c) continue;
      expect(c.error).toBe(0);
      expect(t!.error).toBeLessThanOrEqual(TILE_DETAIL.drop);
      expect(p!.error).toBeLessThanOrEqual(PLATE_DETAIL.drop);
      expect(t!.index.length).toBeLessThanOrEqual(c.index.length);
      expect(p!.index.length).toBeLessThanOrEqual(t!.index.length);
      cell += c.index.length; tile += t!.index.length; plate += p!.index.length;
      tileError = Math.max(tileError, t!.error); plateError = Math.max(plateError, p!.error);
    }
    expect(tile).toBeLessThan(cell);
    expect(plate).toBeLessThan(tile);
    expect(tileError).toBeGreaterThan(0);
    expect(plateError).toBeGreaterThanOrEqual(tileError);
  });

  it("walks a building once for a tile's and a plate's masses where they answer alike, each the same as walked alone", () => {
    let shared = 0, apart = 0;
    for (let i = 0; i < BLUEPRINTS.length; i++) {
      for (const turn of [0, 0.7]) {
        const b = { ...building(i, 0, 0), rotation: turn };
        const [t, p] = emitMassingLevels(b, flat, undefined, flat, undefined, TILE_DETAIL, PLATE_DETAIL);
        expect(t).toEqual(emitMassing(b, flat, undefined, flat, false, undefined, TILE_DETAIL));
        expect(p).toEqual(emitMassing(b, flat, undefined, flat, false, undefined, PLATE_DETAIL));
        if (t && t === p) shared++; else apart++;
      }
    }
    // Both ways met: some buildings' plate masses their tile's own, some walked again.
    expect(shared).toBeGreaterThan(0);
    expect(apart).toBeGreaterThan(0);
  });

  it("is made by the cells' job for its kind, merged, with its error", () => {
    // A building drawn by its masses (a signature one is drawn by its own body, `signature.ts`).
    const plain = BLUEPRINTS.findIndex((_, i) => !drawsSignature(building(i, 0, 0)));
    const b = building(plain, m(10), m(10));
    const job = (kind: JobKind): CellJob => ({
      id: 1, kind, cell: 'x', paved: false, boxes: { parts: {}, furniture: {} } as unknown as CellJob['boxes'],
      entries: [{ key: '1', sig: 1, digest: 1, record: refOf(b) }, { key: '2', sig: 2, digest: 1, record: refOf({ ...b, id: 2 as Building['id'], x: m(80) }) }],
    });
    const mass = (kind: JobKind): CellMass => {
      const reply = runCellJob(job(kind), { groundAt: flat, naturalAt: flat });
      if (reply.kind !== 'done') throw new Error(reply.kind);
      return reply.result.mass!;
    };
    const cell = mass('mass'), tile = mass('massTile'), plate = mass('massPlate');
    expect(cell.error).toBe(0);
    expect(tile.index.length).toBeLessThanOrEqual(cell.index.length);
    expect(plate.index.length).toBeLessThanOrEqual(tile.index.length);
    expect(plate.error).toBeGreaterThanOrEqual(tile.error);
  });
});

describe('the tiles and plates asked of the workers', () => {
  /** A pool that keeps what it is asked and answers when told. */
  function fakePool(): { pool: CellPool; asked: { kind: JobKind; key: string; entries: readonly CellEntry[] }[]; answer: () => void } {
    const asked: { kind: JobKind; key: string; entries: readonly CellEntry[]; done: (r: CellResult) => void; id: number }[] = [];
    const running = new Set<number>();
    let next = 1;
    const pool = {
      run(kind: JobKind, cell: string, entries: readonly CellEntry[], _env: CellEnv, done: (r: CellResult) => void) {
        const id = next++;
        asked.push({ kind, key: cell, entries, done, id });
        running.add(id);
        return id;
      },
      cancel(id: number) { running.delete(id); },
      isRunning(id: number) { return running.has(id); },
    } as unknown as CellPool;
    const answer = (): void => {
      for (const a of asked) if (running.delete(a.id)) a.done({ batch: null, parts: null, summaries: [], mass: null });
    };
    return { pool, asked, answer };
  }
  const env = { groundAt: flat, naturalAt: flat } as CellEnv;
  /** A cell's buildings packed (`PackedEntries`), each named by a letter: its id the letter's code. */
  const entries = (...keys: string[]): PackedEntries => ({ ids: Float64Array.from(keys, (key) => key.charCodeAt(0)), sigs: Float64Array.from(keys, (_key, i) => i + 1), digest: 7 });
  const named = (list: readonly CellEntry[]): string[] => list.map((e) => String.fromCharCode(Number(e.key))).sort();

  it('a change in one cell asks again its tile and its plate only, once for every cell touched', () => {
    const { pool, asked, answer } = fakePool();
    const landed: string[] = [], removed: string[] = [];
    const levels = new MassLevels(pool, (key) => landed.push(key), (key) => removed.push(key), () => {}, () => true);
    levels.touch('0,0', entries('a', 'b'));
    levels.touch('1,1', entries('c'));
    levels.touch('5,0', entries('d'));
    levels.touch('-1,0', entries('e'));
    levels.flush(env);
    const keys = asked.map((a) => `${a.kind} ${a.key}`).sort();
    // And the base over each plate's square, asked at once (`massBase.ts`).
    expect(keys).toEqual(['massBase b:0,0', 'massBase b:1,0', 'massPlate p:0,0', 'massPlate p:1,0', 'massTile t:-1,0', 'massTile t:0,0', 'massTile t:1,0'].sort());
    // A tile is made of its cells' buildings; a plate of its tiles'.
    expect(named(asked.find((a) => a.key === 't:0,0')!.entries)).toEqual(['a', 'b', 'c']);
    expect(named(asked.find((a) => a.key === 'p:0,0')!.entries)).toEqual(['a', 'b', 'c', 'e']);
    expect(named(asked.find((a) => a.key === 'b:0,0')!.entries)).toEqual(['a', 'b', 'c', 'e']);
    expect(levels.asking).toBe(7);
    answer();
    expect(levels.asking).toBe(0);
    // The bases land by their own way (`landBase`).
    expect(landed.length).toBe(5);

    asked.length = 0;
    // One cell changed: its tile and plate alone.
    levels.touch('5,0', entries('d', 'f'));
    // The same buildings on the same ground (the town filed again): nothing.
    levels.touch('0,0', entries('a', 'b'));
    levels.flush(env);
    expect(asked.map((a) => a.key).sort()).toEqual(['b:1,0', 'p:1,0', 't:1,0']);
    // Changed again before it came: the older job cancelled, the newer one asked.
    levels.touch('5,0', entries('d'));
    levels.flush(env);
    expect(levels.asking).toBe(3);

    // Its last building gone: the tile and plate are removed, not asked.
    asked.length = 0;
    levels.touch('5,0', null);
    levels.flush(env);
    expect(asked).toEqual([]);
    expect(removed.sort()).toEqual(['b:1,0', 'p:1,0', 't:1,0']);
    expect(levels.asking).toBe(0);
  });

  it('asks a tile only once the view wants it (its plate refined), and every plate at once', () => {
    const { pool, asked, answer } = fakePool();
    const planned: string[] = [];
    const wanted = new Set<string>();
    const levels = new MassLevels(pool, () => {}, () => {}, (key) => planned.push(key), (key) => wanted.has(key));
    levels.touch('0,0', entries('a'));
    levels.touch('5,0', entries('b'));
    levels.flush(env);
    // The plates and the bases asked, the tiles only planned: a plate stands for them from afar.
    expect(asked.map((a) => a.key).sort()).toEqual(['b:0,0', 'b:1,0', 'p:0,0', 'p:1,0']);
    expect(planned.sort()).toEqual(['b:0,0', 'b:1,0', 'p:0,0', 'p:1,0', 't:0,0', 't:1,0']);
    answer();
    asked.length = 0;
    levels.pump(env);
    expect(asked).toEqual([]);
    // The eye comes near one plate: its tile asked, the other still not.
    wanted.add('t:0,0');
    levels.pump(env);
    expect(asked.map((a) => a.key)).toEqual(['t:0,0']);
    levels.pump(env);
    expect(asked.length).toBe(1);
    // Its masses let go (its plate drawn whole again, `massCells.ts`): asked again only once wanted again.
    answer();
    asked.length = 0;
    wanted.delete('t:0,0');
    levels.release('t:0,0');
    levels.pump(env);
    expect(asked).toEqual([]);
    wanted.add('t:0,0');
    levels.pump(env);
    expect(asked.map((a) => a.key)).toEqual(['t:0,0']);
  });
});

describe('a tile or a plate drawn before some of its buildings came in', () => {
  it('stands for none of them: its cells are not drawn by it until it is made again with them', () => {
    const kit = createBuildingKit();
    const far = createMassCells(kit, CELL, () => {});
    far.land('0,0', masses(m(10), m(10)));
    far.planLevel(plateOf(0, 0));
    far.landLevel(plateOf(0, 0), masses(m(10), m(10), m(10)));
    // From afar: the plate drawn in place of its cells.
    far.choose(m(128), m(128), m(500), 1000, 0.1, false);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    // A cell come in under it (a tile loaded): no mesh of its own, the plate standing in its place.
    far.plan('1,1');
    expect(far.drawn('1,1')).toBe(true);
    // The plate's mesh of older buildings (`MassLevels.outdated`): drawing nothing of the cell.
    expect(far.drawn('1,1', (level) => level !== plateOf(0, 0))).toBe(false);
    far.dispose();
    kit.dispose();
  });

  it('is never coarsened into while outdated: the cells keep their masses until it is made again', () => {
    const kit = createBuildingKit();
    let stale = true;
    const far = createMassCells(kit, CELL, () => {}, (level) => !(stale && level === plateOf(0, 0)));
    far.planLevel(tileOf(0, 0));
    // Close first: the cells asked and drawn with their masses.
    far.choose(m(128), m(128), m(500), 1000, 2, false);
    far.land('0,0', masses(m(10), m(10)));
    far.land('1,0', masses(CELL + m(10), m(10)));
    far.landLevel(plateOf(0, 0), masses(m(10), m(10), m(10)));
    far.choose(m(128), m(128), m(500), 1000, 2, false);
    // From afar, the plate made before its cells' buildings changed: not drawn in their place, their masses kept and drawn.
    far.choose(m(128), m(128), m(500), 1000, 0.1, false);
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(meshNamed(far.group, 'building-massing').length).toBe(2);
    expect(far.drawn('0,0', (level) => !(stale && level === plateOf(0, 0)))).toBe(true);
    expect(far.waiting).toBeGreaterThan(0);
    // Made again: the plate stands for them.
    stale = false;
    far.choose(m(128), m(128), m(500), 1000, 0.1, false);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    // A cell's masses hidden under it draw nothing: drawn by the plate only while it is current.
    expect(far.drawn('0,0', (level) => level !== plateOf(0, 0))).toBe(false);
    far.dispose();
    kit.dispose();
  });

  it('is outdated from the change of a cell under it until its masses are made again', () => {
    const answers: ((result: CellResult) => void)[] = [];
    // A pool whose jobs wait for the test.
    const pool = {
      run: (_kind: JobKind, _key: string, _list: readonly CellEntry[], _env: CellEnv, done: (result: CellResult) => void) => answers.push(done),
      isRunning: () => true,
      cancel: () => {},
    } as unknown as CellPool;
    const levels = new MassLevels(pool, () => {}, () => {}, () => {}, () => false);
    expect(levels.outdated(plateOf(0, 0))).toBe(false);
    levels.touch('0,0', { ids: Float64Array.of(1), sigs: Float64Array.of(1), digest: 0 });
    expect(levels.outdated(plateOf(0, 0))).toBe(true);
    levels.flush({ groundAt: flat, naturalAt: flat });
    expect(levels.outdated(plateOf(0, 0))).toBe(true);
    // Its base and its plate answered (the base is asked first, `massBase.ts`).
    for (const done of answers.splice(0)) done({ mass: null } as CellResult);
    expect(levels.outdated(plateOf(0, 0))).toBe(false);
  });
});

