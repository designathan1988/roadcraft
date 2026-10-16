import { describe, expect, it } from 'vitest';
import { SimClient } from '@sim/host/simClient';
import type { ToSim } from '@sim/host/protocol';
import { RoadDoc, type TileRecords } from '@world/doc';
import { TILE, edgeNodeId, tileIdBase, tileKey } from '@world/tiles';
import { m } from '@world/units';

/** THE WORKER'S COPY HOLDS THE ACTIVE REGION ONLY (`SimClient.setActive`, `activeChanged`): a tile of the kept ring is let go to the meso's tables, taken back when it is active again; an edit in the ring is not sent */

const RUN = { traffic: true, pedestrians: true, maxShare: 1 };
type Delta = Extract<ToSim, { type: 'delta' }>;

const empty = (key: number): TileRecords => ({
  key, version: 1, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [],
  lotKeys: [], landscape: [], barriers: [], paint: [], trees: [], elements: [],
  next: { node: tileIdBase(key), segment: tileIdBase(key), pole: tileIdBase(key), span: tileIdBase(key), building: tileIdBase(key), lot: tileIdBase(key), landscape: tileIdBase(key), barrier: tileIdBase(key) },
});

/** Two tiles side by side, a road from the middle of each to the edge node they share (as `tests/world/docTiles.spec.ts`). */
function twoTiles(): { a: TileRecords; b: TileRecords; edge: number } {
  const ka = tileKey(0, 0), kb = tileKey(1, 0);
  const edge = edgeNodeId(TILE, m(500))!;
  const edgeNode = { id: edge, x: TILE, y: m(500) };
  const na = { id: tileIdBase(ka), x: m(500), y: m(500) };
  const nb = { id: tileIdBase(kb), x: TILE + m(500), y: m(500) };
  const a: TileRecords = { ...empty(ka), nodes: [na], borrowedNodes: [edgeNode], segments: [{ id: tileIdBase(ka) + 1, a: na.id, b: edge, type: 1, curve: null }] };
  const b: TileRecords = { ...empty(kb), nodes: [nb, edgeNode], segments: [{ id: tileIdBase(kb) + 1, a: edge, b: nb.id, type: 1, curve: null }] };
  return { a, b, edge };
}

const keysOf = (delta: Delta): string[] => delta.delta.records.map((r) => `${r.part}:${r.id}:${r.value === undefined ? 'gone' : 'here'}`);

describe("the worker's copy of the active region", () => {
  it('lets a tile go when it leaves the region (its shared edge node kept), skips edits in the ring, and takes the tile back', () => {
    const doc = new RoadDoc();
    const sent: ToSim[] = [];
    const client = new SimClient(doc);
    (client as unknown as { worker: { postMessage(message: ToSim): void } }).worker = { postMessage: (message) => sent.push(message) };
    const { a, b, edge } = twoTiles();
    const active = new Set([a.key, b.key]);
    client.setActive((key) => active.has(key));
    doc.loadTile(a); client.tile('loaded', a.key);
    doc.loadTile(b); client.tile('loaded', b.key);
    client.frame(0.1, false, RUN);
    // The first frame sends the whole map (both tiles active: nothing let go).
    expect(sent.filter((message) => message.type === 'load')).toHaveLength(1);
    expect(sent.filter((message) => message.type === 'tile').map((message) => (message as { event: string }).event)).toEqual(['loaded', 'loaded']);
    // Tile b leaves the active region: its road and its own node go, the edge node stays (a's road ends on it).
    sent.length = 0;
    active.delete(b.key);
    client.activeChanged([b.key]);
    expect(sent.map((message) => message.type)).toEqual(['tile', 'delta']);
    expect(sent[0]).toEqual({ type: 'tile', event: 'letGo', key: b.key, version: 0 });
    const gone = keysOf(sent[1] as Delta);
    expect(gone).toContain(`segments:${b.segments[0]!.id}:gone`);
    expect(gone).toContain(`nodes:${b.nodes[0]!.id}:gone`);
    expect(gone).not.toContain(`nodes:${edge}:gone`);
    // The edge node sent again with a's road alone among its legs.
    const kept = (sent[1] as Delta).delta.records.find((r) => r.part === 'nodes' && r.id === edge)!;
    expect((kept.value as { incident: number[] }).incident).toEqual([a.segments[0]!.id]);
    // An edit in the ring (a road laid in tile b) is not sent; one in tile a is.
    sent.length = 0;
    const p = doc.addNode({ x: TILE + m(200), y: m(200) }), q = doc.addNode({ x: TILE + m(300), y: m(200) });
    const ring = doc.addSegment(p.id, q.id, 1)!;
    client.frame(0.1, false, RUN);
    expect(sent.filter((message) => message.type === 'delta').flatMap((message) => keysOf(message as Delta))).toEqual([]);
    const r = doc.addNode({ x: m(200), y: m(200) }), s = doc.addNode({ x: m(300), y: m(200) });
    const road = doc.addSegment(r.id, s.id, 1)!;
    client.frame(0.1, false, RUN);
    const here = sent.filter((message) => message.type === 'delta').flatMap((message) => keysOf(message as Delta));
    expect(here).toContain(`segments:${road.id}:here`);
    expect(here).toContain(`nodes:${r.id}:here`);
    // Tile b active again: its roads (the one laid meanwhile too) and nodes come, then the tile event (the worker reads its buildings).
    sent.length = 0;
    active.add(b.key);
    client.activeChanged([b.key]);
    expect(sent.map((message) => message.type)).toEqual(['delta', 'tile']);
    const back = keysOf(sent[0] as Delta);
    expect(back).toContain(`segments:${b.segments[0]!.id}:here`);
    expect(back).toContain(`segments:${ring.id}:here`);
    expect(back).toContain(`nodes:${edge}:here`);
    const whole = (sent[0] as Delta).delta.records.find((r) => r.part === 'nodes' && r.id === edge)!;
    expect([...(whole.value as { incident: number[] }).incident].sort()).toEqual([a.segments[0]!.id, b.segments[0]!.id].sort());
    expect(sent[1]).toEqual({ type: 'tile', event: 'loaded', key: b.key, version: 0 });
    // A tile loaded outside the region is not the worker's.
    sent.length = 0;
    client.tile('loaded', tileKey(5, 5));
    expect(sent).toEqual([]);
  });
});
