import { type RecordRef, refOf } from '@world/buildings/recordTable';
import { describe, expect, it } from 'vitest';

import { type BuildingChunk, emitChunk, kitBoxes, lotGroundAgain } from '@render/buildings/buildingMesh';
import { type CellArrays, cellArrays } from '@render/buildings/cellArrays';
import { CellPool } from '@render/buildings/cellPool';
import { PartyWalls } from '@render/buildings/partyWalls';
import { fileParts } from '@render/buildings/partFiling';
import type { CellEntry, CellResult } from '@render/buildings/cellWork';
import { PART_KINDS, createBuildingKit } from '@render/buildings/kit';
import { BATCH_CELL, COARSE_PARTS, DETAIL_CELL, DETAIL_PARTS } from '@render/buildings/layerCells';
import { tileOf } from '@render/buildings/levelKeys';
import { growOnLot } from '@world/growth/zoning';
import type { Building } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { Network } from '@world/network';
import { m } from '@world/units';

/** A CELL PUT TOGETHER BY A WORKER IS THE ONE PUT TOGETHER ON THE PAGE, BYTE FOR BYTE (`cellWork.ts`, `cellPool.ts`) */
const groundAt = (x: number, y: number): number => x * 0.031 - y * 0.017 + Math.sin(x * 0.05) * m(0.4);
const naturalAt = (x: number, y: number): number => groundAt(x, y) - m(0.3) + Math.cos(y * 0.07) * m(0.2);
/** A footway along a band of the map, NaN off it. */
const pavedAt = (x: number, y: number): number => (Math.abs(((y % m(60)) + m(60)) % m(60) - m(30)) < m(4) ? groundAt(x, y) + m(0.15) : NaN);

/** Every array of a batch by its path, as bytes, and its other values. */
function leavesOf(o: unknown, path = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (ArrayBuffer.isView(o)) out.set(path, `${o.constructor.name}:${Buffer.from(o.buffer, o.byteOffset, o.byteLength).toString('base64')}`);
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) leavesOf(v, `${path}.${k}`, out);
  else out.set(path, o);
  return out;
}

/** Where two batches differ, '' when they are the same to the byte. */
function difference(a: CellArrays | null, b: CellArrays | null): string {
  const x = leavesOf(a), y = leavesOf(b);
  for (const path of new Set([...x.keys(), ...y.keys()])) if (!Object.is(x.get(path), y.get(path))) return path || '(root)';
  return '';
}

/** A small town grown on its lots: yards, car parks, terraces. */
function grownTown(): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= 2; i++) { ids.push([]); for (let j = 0; j <= 2; j++) ids[i]!.push(doc.addNode({ x: m(120) * (i - 1), y: m(120) * (j - 1) }).id); }
  for (let i = 0; i <= 2; i++) {
    for (let j = 0; j <= 2; j++) {
      if (i < 2) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < 2) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  doc.lots.forEach((l, k) => zoneLots(doc, [l.id], { use: (['residential', 'commercial', 'industrial'] as const)[k % 3]!, density: 'medium' }));
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  return doc;
}

/** The buildings' chunks by cell, in list order. */
function chunksByCell(buildings: readonly Building[], chunkOf: (b: Building) => BuildingChunk, cellSize: number): Map<string, BuildingChunk[]> {
  const byCell = new Map<string, BuildingChunk[]>();
  for (const b of buildings) {
    const key = `${Math.floor(b.x / cellSize)},${Math.floor(b.y / cellSize)}`;
    const list = byCell.get(key);
    if (list) list.push(chunkOf(b));
    else byCell.set(key, [chunkOf(b)]);
  }
  return byCell;
}

const cellOf = (b: Building): string => `${Math.floor(b.x / BATCH_CELL)},${Math.floor(b.y / BATCH_CELL)}`;
/** The test's records by key: what the pool writes into each job (`CellPool` `text`). */
const texts = new Map<string, RecordRef>();
const entryOf = (b: Building): CellEntry => { texts.set(String(b.id), refOf(b)); return { key: String(b.id), sig: b.id, digest: 0 }; };

describe('a cell put together off the page', () => {
  const kit = createBuildingKit();
  const boxes = kitBoxes(kit);

  for (const paved of [pavedAt, undefined]) {
    it(`is the one put together on the page, byte for byte (${paved ? 'with' : 'without'} paving)`, () => {
      const doc = grownTown();
      const town = [...doc.buildings.all()];
      expect(town.length).toBeGreaterThan(20);
      const pool = new CellPool(() => boxes, (e) => () => texts.get(e.key)!, false);
      const env = { groundAt, naturalAt, ...(paved ? { pavedAt: paved } : {}) };
      /** The cells of `list` both ways: emitted and joined here, and by the pool. */
      const compare = (list: readonly Building[]): void => {
        const byCell = new Map<string, Building[]>();
        for (const b of list) { const c = cellOf(b); byCell.set(c, [...byCell.get(c) ?? [], b]); }
        for (const [cell, buildings] of byCell) {
          // The cell's buildings as one another's neighbours, as the job reads them (`partyWalls.ts`).
          const party = new PartyWalls(buildings, naturalAt, paved);
          const chunks = new Map<Building, BuildingChunk>(buildings.map((b) => [b, emitChunk(b, groundAt, paved, naturalAt, undefined, false, true, party)]));
          let got: CellResult | null = null;
          pool.run('cell', cell, buildings.map(entryOf), env, (result) => { got = result; });
          expect(got).not.toBeNull();
          const result = got! as CellResult;
          // The shells pieced by quadrant (two detail cells a side), as the job pieces them (`cellWork.ts`, `cellArrays` groups).
          const groups = [...chunks.keys()].map((b) => `${Math.floor(b.x / (2 * DETAIL_CELL))},${Math.floor(b.y / (2 * DETAIL_CELL))}`);
          const coarse = cellArrays([...chunks.values()], { parts: PART_KINDS.filter((k) => COARSE_PARTS.has(k)), shells: true, furniture: true, ghost: false, dim: false }, boxes, groups);
          expect(difference(result.batch, coarse), cell).toBe('');
          const details = chunksByCell(buildings, (b) => chunks.get(b)!, DETAIL_CELL);
          // The detail cells' parts as the job filed them by band (`partFiling.ts`): the filing of the batches made here.
          const here = [...details].map(([k, list]) => [k, cellArrays(list, { parts: PART_KINDS.filter((p) => DETAIL_PARTS.has(p)), shells: false, furniture: false, ghost: false, dim: false }, boxes)] as const);
          expect(difference(result.parts as never, fileParts(cell, here, boxes.bandings!) as never), cell).toBe('');
          for (const s of result.summaries) {
            const b = buildings.find((x) => String(x.id) === s.key)!;
            const chunk = chunks.get(b)!;
            expect(s.flags ?? null).toEqual(chunk.flags ?? null);
            expect(s.signatureFloor).toBe(chunk.signatureFloor);
            const again = s.lot ? lotGroundAgain(b, s.lot, paved) : undefined;
            expect(again === undefined).toBe(chunk.lotGround === undefined);
            for (let k = 0; k < 40 && again; k++) {
              const x = b.x + ((k * 7) % 40) - 20, y = b.y + ((k * 13) % 40) - 20;
              expect(again.heightAt(x, y)).toBe(chunk.lotGround!.heightAt(x, y));
            }
          }
        }
      };
      compare(town);
      // One building changed in each of two cells, one gone: the rest kept by the pool, the batches the same.
      const changed = town.slice(0, 2).map((b) => ({ ...b, palette: (b.palette + 3) % 8 }));
      compare([...changed, ...town.slice(3)]);
    });
  }

  it("measures each building's floor once among its jobs, the masses the same byte for byte, and again on other ground", () => {
    const doc = grownTown();
    const town = [...doc.buildings.all()];
    const byCell = new Map<string, Building[]>();
    for (const b of town) { const c = cellOf(b); byCell.set(c, [...byCell.get(c) ?? [], b]); }
    const [cell, buildings] = [...byCell].sort((p, q) => q[1].length - p[1].length)[0]!;
    const [ci, cj] = cell.split(',').map(Number) as [number, number];
    // The natural ground read only for the floors (`floorHeight`): counted.
    let reads = 0;
    const counted = (x: number, y: number): number => { reads++; return naturalAt(x, y); };
    const env = { groundAt, naturalAt: counted, pavedAt };
    const masses = (pool: CellPool, kind: 'mass' | 'massTile', key: string, entries: readonly CellEntry[]): CellResult => {
      let got: CellResult | null = null;
      pool.run(kind, key, entries, env, (result) => { got = result; });
      expect(got).not.toBeNull();
      return got!;
    };
    const entries = buildings.map(entryOf);
    const fresh = new CellPool(() => boxes, (e) => () => texts.get(e.key)!, false);
    reads = 0;
    const alone = masses(fresh, 'mass', cell, entries);
    expect(reads).toBeGreaterThan(0);
    // Its cell's masses once: the floors measured there, handed to its next job.
    const pool = new CellPool(() => boxes, (e) => () => texts.get(e.key)!, false);
    masses(pool, 'mass', cell, entries);
    for (const e of entries) expect(pool.floorKnown(e, true)).not.toBeUndefined();
    reads = 0;
    const after = masses(pool, 'mass', cell, entries);
    expect(reads).toBe(0);
    expect(difference(after.mass as never, alone.mass as never)).toBe('');
    expect(after.floors).toEqual(alone.floors);
    // Its tile's masses stand on the floors handed, and hand none of their own (seen from afar: `cellWork.ts` baseFloor).
    const far = new CellPool(() => boxes, (e) => () => texts.get(e.key)!, false);
    const tile = masses(far, 'massTile', tileOf(ci, cj), entries);
    expect(tile.floors!.every((f) => f === undefined)).toBe(true);
    for (const e of entries) expect(far.floorKnown(e, true)).toBeUndefined();
    // Other ground under the buildings (their digest changed): measured again, never the old floor handed.
    const moved = entries.map((e) => ({ ...e, digest: e.digest + 1 }));
    for (const e of moved) expect(pool.floorKnown(e, true)).toBeUndefined();
    reads = 0;
    masses(pool, 'mass', cell, moved);
    expect(reads).toBeGreaterThan(0);
    // Without the paving, a floor measured on it is not handed.
    for (const e of entries) expect(pool.floorKnown(e, false)).toBeUndefined();
    // Half the buildings gone from the document (a tile let go as the eye walked on): their floors let go, the others' kept.
    const staying = new Set(entries.filter((_, i) => i % 2 === 0).map((e) => e.key));
    pool.forgetFloors((key) => staying.has(key));
    // (The floors kept are those measured last, on the other ground.)
    for (const e of moved) expect(pool.floorKnown(e, true) === undefined, e.key).toBe(!staying.has(e.key));
  });

  for (const paved of [pavedAt, undefined]) {
    it(`summarizes a cell as its buildings laid whole do, none laid (${paved ? 'with' : 'without'} paving)`, () => {
      const town = [...grownTown().buildings.all()];
      const pool = new CellPool(() => boxes, (e) => () => texts.get(e.key)!, false);
      const env = { groundAt, naturalAt, ...(paved ? { pavedAt: paved } : {}) };
      let lots = 0;
      for (const b of town) {
        let got: CellResult | null = null;
        pool.run('summary', cellOf(b), [entryOf(b)], env, (result) => { got = result; });
        const s = (got! as CellResult).summaries[0]!;
        const chunk = emitChunk(b, groundAt, paved, naturalAt);
        expect(s.flags ?? null).toEqual(chunk.flags ?? null);
        expect(s.signatureFloor).toBe(chunk.signatureFloor);
        expect(s.lot).toEqual(chunk.lotGround?.recipe ?? null);
        if (s.lot) lots++;
      }
      expect(lots).toBeGreaterThan(5);
    });
  }
});
