import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { sideOf } from '@world/docImage';
import { OWNER, TILE, tileKey } from '@world/tiles';
import type { NodeId, SegmentId } from '@world/ids';
import { m } from '@world/units';

/** A TILE'S MEMBERS FROM THE INDEX THE DIARY KEEPS (plan B1): the same nodes and roads a walk of the whole document finds, through additions, moves across a tile's edge and removals */

/** What a walk of every node and road says tile `key` holds (the code before `tileIndex.ts`). */
function walked(doc: RoadDoc, key: number): { nodes: number[]; segments: number[] } {
  const nodes = [...doc.nodes.values()].filter((n) => OWNER.node(n) === key).map((n) => n.id).sort((p, q) => p - q);
  const segments = [...doc.segments.values()].filter((s) => {
    const a = doc.nodes.get(s.a), b = doc.nodes.get(s.b);
    return !!a && !!b && OWNER.segment(a, b) === key;
  }).map((s) => s.id).sort((p, q) => p - q);
  return { nodes, segments };
}
const indexed = (doc: RoadDoc, key: number): { nodes: number[]; segments: number[] } => {
  const t = doc.tileIds(key);
  return { nodes: [...t.nodes].sort((p, q) => p - q), segments: [...t.segments].sort((p, q) => p - q) };
};

describe("a tile's members", () => {
  it('are what a walk of the document finds, edit after edit', () => {
    const doc = new RoadDoc();
    const keys = [tileKey(0, 0), tileKey(1, 0), tileKey(0, 1)];
    const same = (): void => { for (const key of keys) expect(indexed(doc, key)).toEqual(walked(doc, key)); };
    same();
    const a = doc.addNode({ x: m(100), y: m(100) }), b = doc.addNode({ x: m(300), y: m(100) }), c = doc.addNode({ x: m(500), y: m(400) });
    const ab = doc.addSegment(a.id, b.id, 1)!, bc = doc.addSegment(b.id, c.id, 1)!;
    same();
    // A node carried over the tile's edge: it, and the middle of its roads, change tile.
    doc.moveNode(b.id, { x: TILE + m(200), y: m(100) });
    same();
    doc.moveNode(c.id, { x: m(500), y: TILE + m(300) });
    same();
    doc.removeSegment(bc.id as SegmentId);
    same();
    doc.removeNode(c.id as NodeId);
    same();
    // An edit made on a working copy and taken back (a road drawn, `commitDraft`).
    const work = doc.fork();
    const d = work.addNode({ x: m(50), y: TILE + m(50) });
    work.addSegment(a.id, d.id, 1);
    work.moveNode(a.id, { x: m(120), y: m(900) });
    doc.takeBack(work);
    same();
    // Undone: the edit's patch put back.
    doc.beginEdit();
    doc.moveNode(b.id, { x: m(700), y: m(100) });
    const patch = doc.endEdit()!;
    same();
    doc.restore(sideOf(patch, 'before'));
    same();
    expect(indexed(doc, tileKey(1, 0)).nodes).toContain(b.id);
    void ab;
  });
});
