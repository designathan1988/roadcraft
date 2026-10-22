import { describe, expect, it } from 'vitest';
import { Digest } from '@core/digest';
import type { Ring } from '@core/ring';
import { RoadDoc, type TileRecords } from '@world/doc';
import { Network } from '@world/network';
import { networkWork } from '@world/rebuildWork';
import { TILE, edgeNodeId, tileIdBase, tileKey } from '@world/tiles';
import { m } from '@world/units';
import { bakeTileNetwork } from '@editor/tileStore';

/** A TILE'S JUNCTIONS SOLVED OFF THE PAGE (`networkBuild.ts` NetworkBake): the page's build takes them where the roads are the same, solves the rest, and the network is the one a build from nothing makes */

const empty = (key: number): TileRecords => ({
  key, version: 1, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [],
  lotKeys: [], landscape: [], barriers: [], paint: [], trees: [], elements: [],
  next: { node: tileIdBase(key), segment: tileIdBase(key), pole: tileIdBase(key), span: tileIdBase(key), building: tileIdBase(key), lot: tileIdBase(key), landscape: tileIdBase(key), barrier: tileIdBase(key) },
});

/** Tile a: a crossroads inside it and an avenue out to the edge node it shares with tile b; tile b: the avenue on to a node of its own. */
function twoTiles(): { a: TileRecords; b: TileRecords; crossing: number; edge: number } {
  const ka = tileKey(0, 0), kb = tileKey(1, 0);
  const edge = edgeNodeId(TILE, m(300))!;
  const base = tileIdBase(ka);
  const nodes = [
    { id: base, x: m(300), y: m(300) }, { id: base + 1, x: m(700), y: m(300) }, { id: base + 2, x: m(500), y: m(600) },
    { id: base + 3, x: m(500), y: m(100) }, { id: base + 4, x: m(500), y: m(300) },
  ];
  const seg = (k: number, a: number, b: number, type = 1): TileRecords['segments'][number] => ({ id: base + 10 + k, a, b, type, curve: null });
  const a: TileRecords = {
    ...empty(ka), nodes, borrowedNodes: [{ id: edge, x: TILE, y: m(300) }],
    segments: [seg(0, base, base + 4), seg(1, base + 4, base + 1), seg(2, base + 2, base + 4), seg(3, base + 4, base + 3), seg(4, base + 1, edge, 2)],
  };
  const nb = { id: tileIdBase(kb), x: TILE + m(500), y: m(300) };
  const b: TileRecords = { ...empty(kb), nodes: [nb, { id: edge, x: TILE, y: m(300) }], segments: [{ id: tileIdBase(kb) + 1, a: edge, b: nb.id, type: 2, curve: null }] };
  return { a, b, crossing: base + 4, edge };
}

/** A ring as its points (never its caches, which a ring rebuilt from a bake has not filled yet). */
const points = (r: Ring): number[] => r.flatten().flatMap((p) => [p.x, p.y]);

/** What the network holds, as numbers: every junction's rings and trims, every ribbon's rings, in id order. */
function fingerprint(net: Network): number {
  const d = new Digest();
  for (const id of [...net.junctions.keys()].sort((p, q) => p - q)) {
    for (const [level, j] of [...net.junctions.get(id)!].sort((p, q) => p[0] - q[0])) d.add(id).add(level).addPlain(j.rings.map(points)).addPlain(j.trims).addPlain(points(j.ring));
  }
  for (const id of [...net.ribbons.keys()].sort((p, q) => p - q)) {
    const r = net.ribbons.get(id)!;
    d.add(id).addPlain(Object.values(r.rings).map(points)).addPlain(r.full.xy).addPlain(net.trims.get(id) ?? null);
  }
  return d.value();
}

const built = (work: () => void): number => { const before = networkWork.built; work(); return networkWork.built - before; };

describe("a tile's network baked off the page", () => {
  it('is taken for every node whose roads are the same, the edge node solved on the page, and the network is the one built from nothing', () => {
    const { a, b, edge } = twoTiles();
    // Through the message's clone, as the worker hands it (a function or a class instance in it would throw here).
    const bake = structuredClone(bakeTileNetwork(a));
    expect(bake.nodes.map((n) => n.id).sort((p, q) => p - q)).toEqual(a.nodes.map((n) => n.id).sort((p, q) => p - q));
    expect(bake.segments).toHaveLength(a.segments.length);
    // From nothing: every junction solved here.
    const plain = new RoadDoc();
    plain.loadTile(a);
    const fresh = new Network(plain);
    const solvedFresh = built(() => fresh.rebuild());
    expect(solvedFresh).toBeGreaterThan(0);
    // With the bake: the tile's own nodes taken, only the borrowed edge node (not the tile's to bake) solved.
    const doc = new RoadDoc();
    doc.loadTile(a);
    const net = new Network(doc);
    net.offerBake(bake);
    const taken = networkWork.taken;
    const solved = built(() => net.rebuild());
    expect(networkWork.taken - taken).toBe(a.nodes.length);
    expect(solved).toBeLessThan(solvedFresh);
    expect(fingerprint(net)).toBe(fingerprint(fresh));
    // Tile b comes: the edge node gains a leg and is solved again; the network is still the one from nothing.
    doc.loadTile(b);
    net.rebuild();
    plain.loadTile(b);
    fresh.rebuild();
    expect(doc.node(edge as never)!.incident).toHaveLength(2);
    expect(fingerprint(net)).toBe(fingerprint(fresh));
  });

  it('is taken for a tile of lower key loaded after the higher one, and the network is the one built from nothing', () => {
    const { a, b, edge } = twoTiles();
    const doc = new RoadDoc();
    doc.loadTile(b);
    const net = new Network(doc);
    net.rebuild();
    const ribbons = [...net.ribbons.keys()];
    doc.loadTile(a);
    net.offerBake(structuredClone(bakeTileNetwork(a)));
    const taken = networkWork.taken;
    net.rebuild();
    expect(networkWork.taken - taken).toBe(a.nodes.length);
    expect(doc.node(edge as never)!.incident).toHaveLength(2);
    // The higher tile's ribbons stay first: the lower ids are filed after them, never laid out again in id order.
    expect([...net.ribbons.keys()].slice(0, ribbons.length)).toEqual(ribbons);
    const fresh = new Network(doc.clone());
    fresh.rebuild();
    expect(fingerprint(net)).toBe(fingerprint(fresh));
  });

  it('solves on the page a node whose key is not the bake\'s (a road of another tile on it, an older bake)', () => {
    const { a, crossing } = twoTiles();
    const bake = bakeTileNetwork(a);
    const stale = { ...bake, nodes: bake.nodes.map((n) => (n.id === crossing ? { ...n, key: n.key + 1 } : n)) };
    const doc = new RoadDoc();
    doc.loadTile(a);
    const net = new Network(doc);
    net.offerBake(stale);
    const taken = networkWork.taken;
    const solved = built(() => net.rebuild());
    expect(networkWork.taken - taken).toBe(a.nodes.length - 1);
    expect(solved).toBeGreaterThan(0);
    const plain = new RoadDoc();
    plain.loadTile(a);
    const fresh = new Network(plain);
    fresh.rebuild();
    expect(fingerprint(net)).toBe(fingerprint(fresh));
  });
});
