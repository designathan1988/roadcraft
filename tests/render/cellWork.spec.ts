import { describe, expect, it } from 'vitest';

import { type BuildingChunk, emitChunk, kitBoxes, lotGroundAgain } from '@render/buildings/buildingMesh';
import { type CellArrays, cellArrays } from '@render/buildings/cellArrays';
import { CellPool } from '@render/buildings/cellPool';
import type { CellEntry, CellResult } from '@render/buildings/cellWork';
import { PART_KINDS, createBuildingKit } from '@render/buildings/kit';
import { BATCH_CELL, COARSE_PARTS, DETAIL_CELL, DETAIL_PARTS } from '@render/buildings/layerCells';
import { growOnLot } from '@editor/zoning';
import type { Building } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { Network } from '@world/network';
import { m } from '@world/units';

/**
 * A CELL PUT TOGETHER BY A WORKER IS THE ONE PUT TOGETHER ON THE PAGE, BYTE
 * FOR BYTE (`cellWork.ts`, `cellPool.ts`): the rounds of readings the worker
 * asks the page for, the light seeds of the spaces (hashes), the chunks it
 * keeps from one job of a cell to the next, give what emitting every building
 * on the page and joining them (`cellArrays.ts`) gives - the coarse batch, each
 * detail cell's, and what the page keeps of each building (flags, the lots'
 * ground made again from its recipe, the signature floor). Run through the
 * same `CellWork` a worker runs, on the page.
 */
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
const texts = new Map<string, string>();
const entryOf = (b: Building): CellEntry => { texts.set(String(b.id), JSON.stringify(b)); return { key: String(b.id), sig: b.id, digest: 0 }; };

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
          const chunks = new Map<Building, BuildingChunk>(buildings.map((b) => [b, emitChunk(b, groundAt, paved, naturalAt)]));
          let got: CellResult | null = null;
          pool.run('cell', cell, buildings.map(entryOf), env, (result) => { got = result; });
          expect(got).not.toBeNull();
          const result = got! as CellResult;
          const coarse = cellArrays([...chunks.values()], { parts: PART_KINDS.filter((k) => COARSE_PARTS.has(k)), shells: true, furniture: true, ghost: false, dim: false }, boxes);
          expect(difference(result.batch, coarse), cell).toBe('');
          const details = chunksByCell(buildings, (b) => chunks.get(b)!, DETAIL_CELL);
          expect(result.details.map(([k]) => k)).toEqual([...details.keys()]);
          for (const [k, arrays] of result.details) {
            const here = cellArrays(details.get(k)!, { parts: PART_KINDS.filter((p) => DETAIL_PARTS.has(p)), shells: false, furniture: false, ghost: false, dim: false }, boxes);
            expect(difference(arrays, here), k).toBe('');
          }
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
});
