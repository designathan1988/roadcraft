import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { TILE, TILE_COUNTED, edgeNodeId, tileIdBase, tileKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { isStreaming } from '@world/changes';
import { generateBody } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';

/** THE PAGE'S DOCUMENT HOLDS TILES, NOT THE WORLD (`RoadDoc.loadTile`, `unloadTile`, `tileRecords`) */

const empty = (key: number): TileRecords => ({
  key, version: 1, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [],
  lotKeys: [], landscape: [], barriers: [], paint: [], trees: [], elements: [],
  next: { node: tileIdBase(key), segment: tileIdBase(key), pole: tileIdBase(key), span: tileIdBase(key), building: tileIdBase(key), lot: tileIdBase(key), landscape: tileIdBase(key), barrier: tileIdBase(key) },
});

/** Two tiles side by side (0,0) and (1,0), a road from the middle of each to their shared edge, and an edge node both name alike. */
function twoTiles(): { a: TileRecords; b: TileRecords; edge: number } {
  const ka = tileKey(0, 0), kb = tileKey(1, 0);
  const edge = edgeNodeId(TILE, m(500))!;
  const edgeNode = { id: edge, x: TILE, y: m(500) };
  const na = { id: tileIdBase(ka), x: m(500), y: m(500) };
  const nb = { id: tileIdBase(kb), x: TILE + m(500), y: m(500) };
  // The road of tile a ends on the edge node, tile b's: its middle is in a, so a owns it and borrows the edge node (b's own).
  const a: TileRecords = { ...empty(ka), nodes: [na], borrowedNodes: [edgeNode], segments: [{ id: tileIdBase(ka) + 1, a: na.id, b: edge, type: 1, curve: null }] };
  const b: TileRecords = { ...empty(kb), nodes: [nb, edgeNode], segments: [{ id: tileIdBase(kb) + 1, a: edge, b: nb.id, type: 1, curve: null }] };
  return { a, b, edge };
}

describe('the page\'s document by tiles', () => {
  it('joins two tiles on their edge node, whichever comes first, and lets one go without the other\'s roads', () => {
    for (const order of [['a', 'b'], ['b', 'a']] as const) {
      const { a, b, edge } = twoTiles();
      const doc = new RoadDoc();
      const tiles = { a, b };
      for (const k of order) doc.loadTile(tiles[k]);
      expect(doc.nodes.size).toBe(3);
      expect(doc.segments.size).toBe(2);
      expect([...doc.node(edge as never)!.incident].sort()).toEqual([a.segments[0]!.id, b.segments[0]!.id].sort());
      // Tile a goes: its road and node go, the edge node (b's, still used by b's road) stays.
      doc.unloadTile(a.key);
      expect(doc.segments.size).toBe(1);
      expect(doc.nodes.has(edge as never)).toBe(true);
      expect(doc.nodes.has(a.nodes[0]!.id as never)).toBe(false);
      expect(doc.node(edge as never)!.incident).toEqual([b.segments[0]!.id]);
      // Tile b goes too: nothing is left.
      doc.unloadTile(b.key);
      expect(doc.nodes.size).toBe(0);
      expect(doc.segments.size).toBe(0);
    }
  });

  it('keeps an edge node a road of a loaded tile ends on when its own tile goes', () => {
    const { a, b, edge } = twoTiles();
    const doc = new RoadDoc();
    doc.loadTile(a);
    doc.loadTile(b);
    doc.unloadTile(b.key);
    expect(doc.nodes.has(edge as never)).toBe(true);
    expect(doc.segments.size).toBe(1);
  });

  it('writes a tile back as it holds it now, what the player built in it included, ids from its range', () => {
    const { a } = twoTiles();
    const doc = new RoadDoc();
    doc.loadTile(a);
    const p = doc.addNode({ x: m(200), y: m(200) });
    const q = doc.addNode({ x: m(300), y: m(200) });
    const s = doc.addSegment(p.id, q.id, 1)!;
    const base = tileIdBase(a.key);
    for (const id of [p.id, q.id, s.id]) {
      expect(id).toBeGreaterThanOrEqual(base);
      expect(id).toBeLessThan(base + TILE_COUNTED);
    }
    const written = doc.tileRecords(a.key, 2);
    expect(written.version).toBe(2);
    expect(written.nodes.map((n) => n.id).sort()).toEqual([a.nodes[0]!.id, p.id, q.id].sort());
    expect(written.segments.map((x) => x.id).sort()).toEqual([a.segments[0]!.id, s.id].sort());
    expect(written.borrowedNodes.map((n) => n.id)).toEqual([a.borrowedNodes[0]!.id]);
    // Read again elsewhere, the tile is the same.
    const other = new RoadDoc();
    other.loadTile(written);
    expect(other.nodes.size).toBe(4);
    expect(other.segments.size).toBe(2);
  });

  it('hands a tile\'s buildings out as the records it holds, never copies (a record is replaced, never edited)', () => {
    const { a } = twoTiles();
    const doc = new RoadDoc();
    doc.loadTile(a);
    const b = doc.buildings.add({ ...generateBody('residential', m(20), m(20), 2), x: m(400), y: m(400), rotation: 0 } as unknown as Building);
    const written = doc.tileRecords(a.key, 2);
    expect(written.buildings).toHaveLength(1);
    expect(written.buildings[0]).toBe(doc.buildings.get(b.id));
  });

  it('says in the diary that the tiles came and went, apart from the edits', () => {
    const { a } = twoTiles();
    const doc = new RoadDoc();
    const from = doc.changes.version;
    doc.loadTile(a);
    doc.unloadTile(a.key);
    const entries = doc.changes.since(from)!;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(isStreaming)).toBe(true);
  });

  it('never takes a tile in or out during an edit', () => {
    const { a } = twoTiles();
    const doc = new RoadDoc();
    doc.beginEdit();
    expect(() => doc.loadTile(a)).toThrow();
    doc.endEdit();
  });
});

describe('a working copy over loaded tiles', () => {
  it('takes no id of a tile for good when it is let go, and carries its ids on when it is taken back', () => {
    const key = tileKey(0, 0), base = tileIdBase(key);
    const doc = new RoadDoc();
    doc.loadTile(empty(key));
    const at = { x: m(300), y: m(500) };
    // Many dry runs let go: the tile's counters do not move.
    for (let k = 0; k < 50; k++) {
      const work = doc.fork();
      const a = work.addNode(at), b = work.addNode({ x: at.x + m(80), y: at.y });
      expect(a.id).toBe(base);
      work.addSegment(a.id, b.id, 1);
    }
    expect(doc.tileRecords(key, 2).next).toEqual(empty(key).next);
    // One taken back: the next record after it takes the next id.
    const work = doc.fork();
    const a = work.addNode(at), b = work.addNode({ x: at.x + m(80), y: at.y });
    const seg = work.addSegment(a.id, b.id, 1)!;
    doc.takeBack(work);
    expect([a.id, b.id, seg.id]).toEqual([base, base + 1, base]);
    expect(doc.addNode({ x: at.x, y: at.y + m(40) }).id).toBe(base + 2);
    expect(doc.tileRecords(key, 2).next).toMatchObject({ node: base + 3, segment: base + 1 });
    // A copy made after it counts on from there.
    expect(doc.fork().addNode({ x: at.x, y: at.y + m(80) }).id).toBe(base + 3);
  });
});

describe('the streamed world left', () => {
  it('holds no tile after `leaveTiles`: a map put in takes no tile id, and the same tile loads again after', () => {
    const key = tileKey(0, 0), base = tileIdBase(key);
    const doc = new RoadDoc();
    doc.loadTile(empty(key));
    expect(doc.addNode({ x: m(300), y: m(500) }).id).toBe(base);
    doc.leaveTiles();
    expect(doc.hasTile(key)).toBe(false);
    expect(doc.loadedTiles.size).toBe(0);
    doc.replaceWith(new RoadDoc());
    expect(doc.addNode({ x: m(300), y: m(500) }).id).toBeLessThan(base);
    doc.loadTile(empty(key));
    expect(doc.hasTile(key)).toBe(true);
  });
});

describe('the map\'s own allocators in the streamed world', () => {
  it('are written with the world\'s values and taken back by the next session, so an id made where no tile is loaded never repeats', () => {
    const doc = new RoadDoc();
    // No tile loaded here: the map's own allocator hands the ids out.
    const a = doc.addNode({ x: m(10), y: m(10) }), b = doc.addNode({ x: m(90), y: m(10) });
    const seg = doc.addSegment(a.id, b.id, 1)!;
    const values = doc.worldValues();
    expect(values.allocators).toEqual(doc.allocatorMarks());
    // The next session opens the world from its values (`main.ts` openStreamedWorld).
    const next = RoadDoc.fromJSON({ ...new RoadDoc().toJSON(), ...values });
    expect(next.addNode({ x: m(10), y: m(50) }).id).toBeGreaterThan(b.id);
    const c = next.addNode({ x: m(90), y: m(50) });
    expect(next.addSegment(c.id, c.id - 1 as never, 1)!.id).toBeGreaterThan(seg.id);
  });
});

describe('an edge node whose own tile is not loaded', () => {
  it('is not edited through the copy a neighbour borrows (its owner would overwrite the edit), and is once its owner is here', () => {
    const { a, b, edge } = twoTiles();
    const doc = new RoadDoc();
    doc.loadTile(a);
    const id = edge as never;
    const was = { ...doc.requireNode(id) };
    expect(doc.canEditNode(id)).toBe(false);
    expect(doc.moveNode(id, { x: was.x, y: was.y + m(5) })).toBe(false);
    doc.setNodeHeightOffset(id, m(3));
    doc.setNodeControl(id, 'signal');
    expect(doc.requireNode(id)).toMatchObject({ x: was.x, y: was.y, heightOffset: was.heightOffset ?? 0 });
    expect(doc.requireNode(id).control).not.toBe('signal');
    // Its owner comes: the node is edited, and the edit is in the owner's records.
    doc.loadTile(b);
    expect(doc.canEditNode(id)).toBe(true);
    doc.setNodeHeightOffset(id, m(3));
    expect(doc.tileRecords(b.key, 2).nodes.find((n) => n.id === edge)!.heightOffset).toBe(m(3));
  });
});
