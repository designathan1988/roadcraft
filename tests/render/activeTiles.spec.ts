import { describe, expect, it } from 'vitest';
import { type InstancedMesh, Matrix4, MeshBasicMaterial, Vector3 } from 'three';
import { ACTIVE_MOVED, ActiveTiles } from '@render/activeTiles';
import { KEEP_CELL } from '@render/candidateKeep';
import { keepCellAt } from '@render/cellKeeps';
import type { SceneMaterials } from '@render/materials';
import { createStructureCells, type StructureCells } from '@render/structureCells';
import { ChangeJournal } from '@world/changes';
import { JournalCursor } from '@world/derived';
import { RoadDoc } from '@world/doc';
import { buildRoadElevation } from '@world/elevation';
import { Network } from '@world/network';
import { TILE, tileKey, tileKeyAt, tileRect } from '@world/tiles';
import { m } from '@world/units';

/** THE STREAMED WORLD'S ACTIVE TILES AS THE NEAR PRODUCTS READ THEM (`render/activeTiles.ts`): the kept ring round them is the far levels' */

/** Active tiles by key, and the predicate the streamer would hand the renderer (`worldStreamer.ts` isActive). */
function region(...keys: number[]): { readonly shown: Set<number>; readonly at: (x: number, y: number) => boolean } {
  const shown = new Set(keys);
  return { shown, at: (x, y) => shown.has(tileKeyAt(x, y)) };
}

describe('the active tiles', () => {
  it('tell each reader where the region moved, each tile once, and everywhere when a world opens or closes', () => {
    const { at } = region(tileKey(0, 0));
    const active = new ActiveTiles();
    const early = active.reader();
    // No streamed world: everything is made near.
    expect(active.has(m(5000), m(-5000))).toBe(true);
    active.set(at, []);
    expect(early.take()).toBeNull();
    const late = active.reader();
    expect(late.pending).toBe(false);
    active.set(at, [tileRect(1, 0)]);
    active.set(at, [tileRect(1, 0), tileRect(0, 1)]);
    expect(late.pending).toBe(true);
    expect(late.take()).toEqual([tileRect(1, 0), tileRect(0, 1)]);
    expect(late.take()).toEqual([]);
    expect(early.take()).toEqual([tileRect(1, 0), tileRect(0, 1)]);
    // As an entry of the diary for a product that reads one, grown as asked.
    active.set(at, [tileRect(2, 0)]);
    expect(late.entries('landscape', 10)).toEqual([
      { serial: -1, kind: 'landscape', rects: [[2 * TILE - 10, -10, 3 * TILE + 10, TILE + 10]], cause: ACTIVE_MOVED, at: 0 },
    ]);
    expect(late.entries('landscape')).toEqual([]);
    active.set(null, []);
    expect(late.take()).toBeNull();
    expect(active.has(m(5000), m(-5000))).toBe(true);
  });

  it('say whether a point, a box and a keep cell are made near', () => {
    const { at } = region(tileKey(0, 0));
    const active = new ActiveTiles();
    active.set(at, []);
    expect(active.has(10, 10)).toBe(true);
    expect(active.has(TILE + 10, 10)).toBe(false);
    // A box astride the active tile's edge meets it; one wholly past it does not.
    expect(active.meets([TILE - 10, 10, TILE + 10, 20])).toBe(true);
    expect(active.meets([TILE + 10, 10, TILE + 20, 20])).toBe(false);
    // The keep cells of the active tile and the cells round it are kept (a tree's shape reads its neighbours'); one further is not.
    expect(active.keepsCell(keepCellAt(TILE - 1, 10))).toBe(true);
    expect(active.keepsCell(keepCellAt(TILE + 1, 10))).toBe(true);
    expect(active.keepsCell(keepCellAt(TILE + KEEP_CELL + 1, 10))).toBe(false);
  });

  it('add to a cursor\'s entries where the region moved since its last read, as one of its first kind', () => {
    const { at } = region(tileKey(0, 0));
    const active = new ActiveTiles();
    active.set(at, []);
    const journal = new ChangeJournal();
    const cursor = new JournalCursor(['trees', 'terrain']);
    expect(active.read(cursor, journal)).toBeNull();
    journal.record('trees', [[1, 1, 2, 2]]);
    active.set(at, [tileRect(1, 0)]);
    const entries = active.read(cursor, journal)!;
    expect(entries.map((e) => e.kind)).toEqual(['trees', 'trees']);
    expect(entries.at(-1)).toMatchObject({ cause: ACTIVE_MOVED, rects: [[TILE - KEEP_CELL, -KEEP_CELL, 2 * TILE + KEEP_CELL, TILE + KEEP_CELL]] });
    expect(active.read(cursor, journal)).toEqual([]);
    // A world closed: everything read again.
    active.set(null, []);
    expect(active.read(cursor, journal)).toBeNull();
  });
});

/** Three raised roads: one on tile (0, 0), one on tile (1, 0), one astride their edge. */
function viaducts(): { net: Network; ground: () => number } {
  const doc = new RoadDoc();
  const raised = (x0: number, y0: number, x1: number, y1: number): void => {
    const a = doc.addNode({ x: x0, y: y0 }), b = doc.addNode({ x: x1, y: y1 });
    doc.setSegmentStructure(doc.addSegment(a.id, b.id, 2)!.id, 'elevated');
  };
  raised(m(100), m(300), m(700), m(300));
  raised(TILE + m(276), m(300), TILE + m(876), m(300));
  raised(m(700), m(700), TILE + m(276), m(700));
  const net = new Network(doc);
  net.rebuild();
  return { net, ground: () => 0 };
}

const fakeMaterials = (): SceneMaterials => {
  const mat = new MeshBasicMaterial();
  return { concrete: mat, parapet: mat, verge: mat, scale: { deck: 8, verge: 8 } } as unknown as SceneMaterials;
};

/** Where the cells' piers stand, as sorted text, and which of the three roads hold some. */
function piersOf(cells: StructureCells): { rows: string[]; roads: string[] } {
  const rows: string[] = [];
  const roads = new Set<string>();
  const matrix = new Matrix4(), at = new Vector3();
  cells.group.traverse((o) => {
    const mesh = o as InstancedMesh;
    if (!mesh.isInstancedMesh || o.name !== 'structure-piers') return;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      at.setFromMatrixPosition(matrix);
      rows.push([...matrix.elements].map((v) => v.toFixed(3)).join(','));
      // World y is three's -z.
      roads.add(-at.z > m(500) ? 'astride' : at.x < TILE ? 'west' : 'east');
    }
  });
  return { rows: rows.sort(), roads: [...roads].sort() };
}

describe('the roads\' structures of the active tiles only', () => {
  it('build the cells whose roads reach an active tile, and take in or let go those of the tiles that come and go', () => {
    const { net, ground } = viaducts();
    const elevation = buildRoadElevation(net, ground);
    const { shown, at } = region(tileKey(0, 0));
    const active = new ActiveTiles();
    active.set(at, []);
    const kept = createStructureCells(fakeMaterials(), undefined, active);
    kept.prepare(net, elevation, ground, null).apply();
    /** A layer built whole for the same tiles. */
    const whole = (): string[] => {
      const fresh = createStructureCells(fakeMaterials(), undefined, active);
      fresh.prepare(net, elevation, ground, null).apply();
      const out = piersOf(fresh).rows;
      fresh.dispose();
      return out;
    };
    expect(piersOf(kept).roads).toEqual(['astride', 'west']);
    expect(piersOf(kept).rows).toEqual(whole());
    // Tile (1, 0) comes in and (0, 0) leaves: the road astride the edge stays, whole.
    shown.add(tileKey(1, 0));
    shown.delete(tileKey(0, 0));
    active.set(at, [tileRect(1, 0), tileRect(0, 0)]);
    // A build replaced halfway (prepared, never put in place) leaves the move to the next.
    kept.prepare(net, elevation, ground, []);
    kept.prepare(net, elevation, ground, []).apply();
    expect(piersOf(kept).roads).toEqual(['astride', 'east']);
    expect(piersOf(kept).rows).toEqual(whole());
    // Neither: nothing of them built here.
    shown.clear();
    active.set(at, [tileRect(1, 0)]);
    kept.prepare(net, elevation, ground, []).apply();
    expect(piersOf(kept).rows).toEqual([]);
    // The world closed: every road's structures again.
    active.set(null, []);
    kept.prepare(net, elevation, ground, []).apply();
    expect(piersOf(kept).roads).toEqual(['astride', 'east', 'west']);
    kept.dispose();
  });
});
