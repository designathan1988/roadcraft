import { describe, expect, it } from 'vitest';
import { RoadDoc, type TileRecords } from '@world/doc';
import type { Change } from '@world/changes';
import { tileIdBase, tileKey } from '@world/tiles';
import { m } from '@world/units';

/** A ROAD ENTRY OF THE DIARY TELLS ITS NODES FROM ITS SEGMENTS (plan A5): within a tile both are counted from `tileIdBase`, so one id may name a node and a segment */

const lastRoads = (doc: RoadDoc): Change => doc.changes.since(0, ['roads'])!.at(-1)!;

describe("the diary's road entries", () => {
  it('names a segment and its two ends apart', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: 0 }), b = doc.addNode({ x: m(50), y: 0 });
    const s = doc.addSegment(a.id, b.id, 1)!;
    const entry = lastRoads(doc);
    expect(entry.segments).toEqual([s.id]);
    expect([...entry.nodes!].sort()).toEqual([a.id, b.id].sort());
    // `ids` stays their union, for the readers by id of every kind.
    expect(new Set(entry.ids)).toEqual(new Set([s.id, a.id, b.id]));
  });

  it("keeps a tile's node and segment of the same id apart as the tile comes in", () => {
    const key = tileKey(0, 0), base = tileIdBase(key);
    const tile: TileRecords = {
      key, version: 1,
      // Node `base` and segment `base`: the same number, two records.
      nodes: [{ id: base, x: m(10), y: m(10) }, { id: base + 1, x: m(60), y: m(10) }], borrowedNodes: [],
      segments: [{ id: base, a: base, b: base + 1, type: 1 } as never], poles: [], borrowedPoles: [], poleSpans: [],
      buildings: [], lots: [], lotKeys: [], landscape: [], barriers: [], paint: [], trees: [], elements: [],
      next: { node: base + 2, segment: base + 1, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
    };
    const doc = new RoadDoc();
    doc.loadTile(tile);
    const entry = lastRoads(doc);
    expect(entry.segments).toEqual([base]);
    expect([...entry.nodes!].sort()).toEqual([base, base + 1]);
  });
});
