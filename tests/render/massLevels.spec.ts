import { describe, expect, it } from 'vitest';
import type { Mesh, Object3D } from 'three';

import { type CellMass, cellMass } from '@render/buildings/cellArrays';
import type { CellEnv, CellPool } from '@render/buildings/cellPool';
import { type CellEntry, type CellJob, type CellResult, type JobKind, runCellJob } from '@render/buildings/cellWork';
import { createBuildingKit } from '@render/buildings/kit';
import { createMassCells } from '@render/buildings/massCells';
import { MassLevels } from '@render/buildings/massLevels';
import { plateOf, tileOf } from '@render/buildings/levelKeys';
import { CELL_DETAIL, PLATE_DETAIL, TILE_DETAIL, emitMassing } from '@render/buildings/massing';
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
  it('is chosen by what it leaves out on the screen, hides its cells, and gives way to them near', () => {
    const kit = createBuildingKit();
    const far = createMassCells(kit, CELL);
    far.land('0,0', masses(m(10), m(10)));
    far.land('1,0', masses(CELL + m(10), m(10)));
    far.landLevel(tileOf(0, 0), masses(m(10), m(10), m(4)));
    far.landLevel(plateOf(0, 0), masses(m(10), m(10), m(10)));
    // The cells' meshes in the order they landed.
    const cellMesh = (key: string): Mesh => meshNamed(far.group, 'building-massing')[key === '0,0' ? 0 : 1]!;
    const tile = meshNamed(far.group, 'building-massing-tile')[0]!;
    const plate = meshNamed(far.group, 'building-massing-plate')[0]!;
    const look = (orthoPx: number, near: boolean | ReadonlySet<string> = false): void => far.choose(m(128), m(128), m(500), 1000, orthoPx, near);

    // Close: the cells, near; no level drawn.
    look(2);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(far.near('0,0')).toBe(true);
    expect(tile.visible).toBe(false);
    expect(plate.visible).toBe(false);
    // A tile's 4 m under 2 px (0.3 px a metre): the tile, its cells hidden and far.
    look(0.3);
    expect(far.coarse(tileOf(0, 0))).toBe(true);
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(tile.visible).toBe(true);
    expect(plate.visible).toBe(false);
    for (const key of ['0,0', '1,0']) {
      expect(far.near(key)).toBe(false);
      expect(cellMesh(key).visible).toBe(false);
    }
    expect([...far.nearKeys()]).toEqual([]);
    // Hysteresis: a tile drawn stays drawn up to its 2 px (4 m at 0.45 px is 1.8 px).
    look(0.45);
    expect(far.coarse(tileOf(0, 0))).toBe(true);
    // The plate's 10 m under 2 px: the plate alone, the tile hidden under it.
    look(0.1);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(plate.visible).toBe(true);
    expect(tile.visible).toBe(false);
    expect(cellMesh('0,0').visible).toBe(false);
    // A cell held near (cut open, edited): neither its tile nor its plate stands in for it.
    look(0.1, new Set(['0,0']));
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(far.near('0,0')).toBe(true);
    // Back close: the cells again, their masses shown (no detail landed for them).
    look(2);
    expect(plate.visible).toBe(false);
    expect(tile.visible).toBe(false);
    expect(far.near('1,0')).toBe(true);
    expect(cellMesh('1,0').visible).toBe(true);
    // Refined from a tile not drawn: hysteresis the other way (4 m at 0.45 px is 1.8 px, over 0.85 of 2).
    look(0.45);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    // A level with no mass never stands in for its cells.
    far.landLevel(tileOf(0, 0), null);
    look(0.3);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(cellMesh('1,0').visible).toBe(true);
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

  it("is made by the cells' job for its kind, merged, with its error", () => {
    // A building drawn by its masses (a signature one is drawn by its own body, `signature.ts`).
    const plain = BLUEPRINTS.findIndex((_, i) => !drawsSignature(building(i, 0, 0)));
    const b = building(plain, m(10), m(10));
    const job = (kind: JobKind): CellJob => ({
      id: 1, kind, cell: 'x', paved: false, boxes: { parts: {}, furniture: {} } as unknown as CellJob['boxes'],
      entries: [{ key: '1', sig: 1, digest: 1, record: JSON.stringify(b) }, { key: '2', sig: 2, digest: 1, record: JSON.stringify({ ...b, id: 2, x: m(80) }) }],
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
      for (const a of asked) if (running.delete(a.id)) a.done({ batch: null, details: [], summaries: [], mass: null });
    };
    return { pool, asked, answer };
  }
  const env = { groundAt: flat, naturalAt: flat } as CellEnv;
  const entries = (...keys: string[]): CellEntry[] => keys.map((key, i) => ({ key, sig: i + 1, digest: 7 }));

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
    expect(keys).toEqual(['massPlate p:0,0', 'massPlate p:1,0', 'massTile t:-1,0', 'massTile t:0,0', 'massTile t:1,0'].sort());
    // A tile is made of its cells' buildings; a plate of its tiles'.
    expect(asked.find((a) => a.key === 't:0,0')!.entries.map((e) => e.key).sort()).toEqual(['a', 'b', 'c']);
    expect(asked.find((a) => a.key === 'p:0,0')!.entries.map((e) => e.key).sort()).toEqual(['a', 'b', 'c', 'e']);
    expect(levels.asking).toBe(5);
    answer();
    expect(levels.asking).toBe(0);
    expect(landed.length).toBe(5);

    asked.length = 0;
    // One cell changed: its tile and plate alone.
    levels.touch('5,0', entries('d', 'f'));
    // The same buildings on the same ground (the town filed again): nothing.
    levels.touch('0,0', entries('a', 'b'));
    levels.flush(env);
    expect(asked.map((a) => a.key).sort()).toEqual(['p:1,0', 't:1,0']);
    // Changed again before it came: the older job cancelled, the newer one asked.
    levels.touch('5,0', entries('d'));
    levels.flush(env);
    expect(levels.asking).toBe(2);

    // Its last building gone: the tile and plate are removed, not asked.
    asked.length = 0;
    levels.touch('5,0', null);
    levels.flush(env);
    expect(asked).toEqual([]);
    expect(removed.sort()).toEqual(['p:1,0', 't:1,0']);
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
    // The plates asked, the tiles only planned: a plate stands for them from afar.
    expect(asked.map((a) => a.key).sort()).toEqual(['p:0,0', 'p:1,0']);
    expect(planned.sort()).toEqual(['p:0,0', 'p:1,0', 't:0,0', 't:1,0']);
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
  });
});
