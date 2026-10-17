import { describe, expect, it, vi } from 'vitest';
import { RoadDoc, type TileRecords } from '@world/doc';
import { tileIdBase, tileKey } from '@world/tiles';
import { m } from '@world/units';

/** A TILE PUT IN STRAIGHT FROM ITS RECORDS (plan B2): no document of its own made first, and what is written back is what came in */

function richTile(): TileRecords {
  const key = tileKey(0, 0), base = tileIdBase(key);
  return {
    key, version: 3,
    nodes: [
      { id: base, x: m(100), y: m(100) },
      { id: base + 1, x: m(200), y: m(100), crossing: { kind: 'zebra', segment: base } } as never,
      { id: base + 2, x: m(300), y: m(100) },
    ],
    borrowedNodes: [],
    segments: [{ id: base, a: base, b: base + 1, type: 1 } as never, { id: base + 1, a: base + 1, b: base + 2, type: 1 } as never],
    poles: [{ id: base, x: m(50), y: m(50) }, { id: base + 1, x: m(80), y: m(50), lamp: true }] as never,
    borrowedPoles: [], poleSpans: [{ id: base, a: base, b: base + 1 }] as never,
    buildings: [], lots: [], lotKeys: [],
    landscape: [{ id: base, kind: 'bench', x: m(30), y: m(30) }] as never,
    barriers: [{ id: base, kind: 'fence', points: [{ x: m(10), y: m(10) }, { x: m(40), y: m(10) }] }] as never,
    paint: [{ kind: 'grass', x: m(20), y: m(20), radius: m(5), strength: 1 }],
    trees: [{ x: m(60), y: m(60), height: 8, yaw: 0, seed: 0.3 }],
    elements: [],
    next: { node: base + 3, segment: base + 2, pole: base + 2, span: base + 1, building: base, lot: base, landscape: base + 1, barrier: base + 1 },
  };
}

describe('a tile put in', () => {
  it('is read straight into the document, no document of its own made for it', () => {
    const doc = new RoadDoc();
    const made = vi.spyOn(RoadDoc, 'fromJSON');
    doc.loadTile(richTile());
    expect(made).not.toHaveBeenCalled();
    made.mockRestore();
  });

  it('is written back as it came in: its roads, crossing, wires, bench, fence, paint and tree', () => {
    const tile = richTile();
    const doc = new RoadDoc();
    doc.loadTile(tile);
    const back = doc.tileRecords(tile.key, tile.version);
    expect(back.nodes.map((n) => n.id)).toEqual(tile.nodes.map((n) => n.id));
    expect(back.nodes[1]!.crossing).toEqual({ kind: 'zebra', segment: tile.segments[0]!.id });
    expect(back.segments.map((s) => [s.id, s.a, s.b])).toEqual(tile.segments.map((s) => [s.id, s.a, s.b]));
    expect(back.poles.map((p) => p.id)).toEqual(tile.poles.map((p) => p.id));
    expect(back.poleSpans.map((s) => s.id)).toEqual(tile.poleSpans.map((s) => s.id));
    expect(back.landscape.map((l) => l.id)).toEqual([tile.landscape[0]!.id]);
    expect(back.barriers.map((b) => b.id)).toEqual([tile.barriers[0]!.id]);
    expect(back.paint).toHaveLength(1);
    expect(back.trees).toHaveLength(1);
  });
});
