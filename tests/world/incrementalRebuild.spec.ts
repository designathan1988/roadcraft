import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RoadDoc, type TileRecords } from '@world/doc';
import { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import { TILE, edgeNodeId, tileIdBase, tileKey } from '@world/tiles';
import { m } from '@world/units';
import { derivedLines, laneletLines, networkLines } from './support/roadDigest';
import { FLAT_GROUND, type RoadElevation, buildRoadElevation } from '@world/elevation';
import { TerrainIndex, sampleTerrainHeight } from '@world/terrain';
import { commitRoadPath, moveNodeChecked } from '@editor/commit';
import { guardRoadEdit } from '@editor/editRules';
import { findAnchor } from '@editor/snap';
import { restoreSnapshot } from '@editor/history';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate, loadFixtures } from '../fuzz/support/runner';

/** THE ORACLE of the incremental rebuild: after every edit, the network the game keeps */

function elevationLines(doc: RoadDoc, elevation: RoadElevation): string[] {
  const out: string[] = [];
  const summaries = elevation.summaries!();
  for (const id of [...summaries.keys()].sort((a, b) => a - b)) out.push(`profile ${id} ${summaries.get(id)!.digest}`);
  for (const id of [...doc.nodes.keys()].sort((a, b) => a - b)) out.push(`node ${id} ${elevation.nodeHeight(id)}`);
  return out;
}

/** Each crossing's place, which the network keeps across rebuilds (`Network.forgetCrossings`). */
function crossingLines(net: Network): string[] {
  const out: string[] = [];
  for (const node of [...net.doc.nodes.keys()].sort((a, b) => a - b)) {
    for (const seg of [...net.doc.node(node)!.incident].sort((a, b) => a - b)) out.push(`crossing ${seg}:${node} ${net.crosswalkDistanceAt(seg, node)}`);
  }
  return out;
}

/** The game's network and solve, against ones built from nothing. */
function expectSameAsFull(doc: RoadDoc, net: Network, elevation: RoadElevation, ground: (x: number, y: number) => number, where: string): void {
  const fresh = new Network(doc.clone());
  fresh.rebuild({ full: true });
  expect(networkLines(net), `network after ${where}`).toEqual(networkLines(fresh));
  expect(crossingLines(net), `crossings after ${where}`).toEqual(crossingLines(fresh));
  expect(laneletLines(doc, net), `lanelets after ${where}`).toEqual(laneletLines(fresh.doc, fresh));
  expect(elevationLines(doc, elevation), `heights after ${where}`).toEqual(elevationLines(doc, buildRoadElevation(fresh, ground)));
}

/** A tile of three by three streets 256 m apart, its middle row out to a node on each side edge: the west one its own, the east one its neighbour's (`edgeNodeId`). */
function gridTile(i: number): TileRecords {
  const key = tileKey(i, 0), base = tileIdBase(key), x0 = i * TILE;
  const at = (c: number, r: number): number => base + r * 3 + c;
  const nodes: TileRecords['nodes'][number][] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) nodes.push({ id: at(c, r), x: x0 + m(256) * (c + 1), y: m(256) * (r + 1) });
  const west = { id: edgeNodeId(x0, m(512))!, x: x0, y: m(512) };
  const east = { id: edgeNodeId(x0 + TILE, m(512))!, x: x0 + TILE, y: m(512) };
  const segments: TileRecords['segments'][number][] = [];
  const road = (a: number, b: number): void => { segments.push({ id: base + 100 + segments.length, a, b, type: 1, curve: null }); };
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) road(at(c, r), at(c + 1, r));
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) road(at(c, r), at(c, r + 1));
  road(west.id, at(0, 1));
  road(at(2, 1), east.id);
  return {
    key, version: 1, nodes: [...nodes, west], borrowedNodes: [east], segments, poles: [], borrowedPoles: [], poleSpans: [],
    buildings: [], lots: [], lotKeys: [], landscape: [], barriers: [], paint: [], trees: [], elements: [],
    next: { node: base + 9, segment: base + 100 + segments.length, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
  };
}

describe('incremental network and height rebuild', () => {
  // One test per sequence and per fixture: each in well under a second, the whole in no single test's 10 s.
  for (let seed = 1; seed <= 8; seed++) it(`equals a full rebuild after every op of fuzz sequence ${seed}`, () => {
    {
      const ops = generate(seed, 24);
      const state = freshState();
      let elevation = buildRoadElevation(state.net, FLAT_GROUND);
      for (let i = 0; i < ops.length; i++) {
        let changed: boolean;
        try { changed = applyOp(state, ops[i]!); } catch { break; }
        if (!changed) continue;
        elevation = buildRoadElevation(state.net, FLAT_GROUND, elevation);
        expectSameAsFull(state.doc, state.net, elevation, FLAT_GROUND, `seed ${seed} op ${i} (${ops[i]!.op})`);
      }
    }
  });

  for (const fixture of loadFixtures()) it(`equals a full rebuild over the fuzz fixture ${fixture.name}`, () => {
    {
      const state = freshState();
      let elevation = buildRoadElevation(state.net, FLAT_GROUND);
      fixture.ops.forEach((op, i) => {
        let changed: boolean;
        try { changed = applyOp(state, op); } catch { return; }
        if (!changed) return;
        elevation = buildRoadElevation(state.net, FLAT_GROUND, elevation);
        expectSameAsFull(state.doc, state.net, elevation, FLAT_GROUND, `${fixture.name} op ${i}`);
      });
    }
  });

  it('equals a full rebuild on the test town, over its terrain, through the edits a player makes', () => {
    const doc = RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/parking-town.json', 'utf8')));
    const net = new Network(doc);
    net.rebuild({ full: true });
    const index = new TerrainIndex(doc.terrainStamps, 0, doc.terrainRelief);
    const ground = (x: number, y: number): number => sampleTerrainHeight(index, x, y);
    let elevation = buildRoadElevation(net, ground);
    const settle = (where: string): void => {
      if (net.revision !== doc.revision) net.rebuild();
      elevation = buildRoadElevation(net, ground, elevation);
      expectSameAsFull(doc, net, elevation, ground, where);
    };
    const ids = [...doc.segments.keys()].sort((a, b) => a - b);
    for (const pick of [0.15, 0.5, 0.85]) {
      const id = ids[Math.floor(pick * ids.length)] as SegmentId;
      const line = net.polylines.get(doc, id);
      const frame = line.sampleAt(line.length / 2);
      const start = findAnchor(doc, net, frame.p, 1);
      const end = { x: frame.p.x + frame.n.x * 150, y: frame.p.y + frame.n.y * 150 };
      const before = doc.toJSON();
      const result = commitRoadPath(doc, net, start, { kind: 'free', at: end }, 1,
        [{ start: { at: start.at, heightOffset: 0 }, end: { at: end, heightOffset: 0 }, curve: null }], null, undefined, ground,
        { groundSolve: elevation });
      const done = result.committed;
      // The tunnel test's solve, started from the game's, offered to the renderer: the full solve's.
      if (result.elevation) {
        const fresh = new Network(doc.clone());
        fresh.rebuild({ full: true });
        expect(elevationLines(doc, result.elevation), `offered heights after the road out of ${id}`)
          .toEqual(elevationLines(doc, buildRoadElevation(fresh, ground)));
        elevation = result.elevation;
      }
      settle(`road out of ${id}`);
      if (done) {
        restoreSnapshot(doc, before, net);
        settle(`undo of the road out of ${id}`);
      }
    }
    const node = [...doc.nodes.values()].find((n) => n.incident.length === 3)!;
    moveNodeChecked(doc, net, node.id, { x: node.x + 6, y: node.y + 4 });
    settle(`move of node ${node.id}`);
    const retyped = ids[Math.floor(ids.length / 3)] as SegmentId;
    guardRoadEdit(doc, net, (doc) => { doc.setSegmentType(retyped, (doc.requireSegment(retyped).type + 1) % 4); return true; });
    settle(`retype of ${retyped}`);
    const raised = [...doc.nodes.values()].find((n) => n.incident.length === 2)!;
    doc.setNodeHeightOffset(raised.id, raised.heightOffset + 10);
    settle(`node ${raised.id} raised`);
  });

  it('equals a full rebuild with tiles loaded from the highest key down, and leaves what it filed before where it was', () => {
    const doc = new RoadDoc();
    const net = new Network(doc);
    net.rebuild();
    let elevation = buildRoadElevation(net, FLAT_GROUND);
    for (const i of [2, 1, 0]) {
      const ribbons = [...net.ribbons.keys()], junctions = [...net.junctions.keys()];
      doc.loadTile(gridTile(i));
      net.rebuild();
      // Lower ids come after: the ribbons and junctions already filed stay first, in their order (the region is not laid out again).
      expect([...net.ribbons.keys()].slice(0, ribbons.length), `ribbons after tile ${i}`).toEqual(ribbons);
      const kept = junctions.filter((id) => net.junctions.has(id));
      expect([...net.junctions.keys()].slice(0, kept.length), `junctions after tile ${i}`).toEqual(kept);
      elevation = buildRoadElevation(net, FLAT_GROUND, elevation);
      expectSameAsFull(doc, net, elevation, FLAT_GROUND, `tile ${i} loaded`);
      const fresh = new Network(doc.clone());
      fresh.rebuild({ full: true });
      expect(derivedLines(net), `derived after tile ${i} loaded`).toEqual(derivedLines(fresh));
    }
    expect(net.ribbons.size).toBe(3 * 14);
    expect(net.junctions.size).toBeGreaterThan(9);
  });
});
