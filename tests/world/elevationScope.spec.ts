import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layCity } from '@editor/cityGenerator';
import { largeCityPlan } from '@world/cityGen/largeCity';
import { smallCityPlan } from '@world/cityGen/smallCity';
import { RoadDoc } from '@world/doc';
import { FLAT_GROUND, type RoadElevation, SURFACE_READ_REACH, buildRoadElevation, pendingOrder, roadsToRead } from '@world/elevation';
import { Network } from '@world/network';
import { TerrainIndex, sampleTerrainHeight } from '@world/terrain';
import { m } from '@world/units';

/**
 * THE ROADS' HEIGHTS SOLVED ROUND THE VIEW FIRST, THE REST AFTER (`elevation.ts` `SolveScope`): an opening's solve of a region and its
 * margin answers every read inside the region as the whole solve does, and the rest taken a share at a time ends bit for bit on the
 * whole solve - every road's heights and every node's - on level ground and on relief, for the small and the large city.
 */

type Ground = (x: number, y: number) => number;

/** Every road's solved profile (its heights, line and look as a digest) and every node's height. */
function lines(net: Network, elevation: RoadElevation): string[] {
  const out: string[] = [];
  const summaries = elevation.summaries!();
  for (const id of [...summaries.keys()].sort((a, b) => a - b)) out.push(`profile ${id} ${summaries.get(id)!.digest}`);
  for (const id of [...net.doc.nodes.keys()].sort((a, b) => a - b)) out.push(`node ${id} ${elevation.nodeHeight(id)}`);
  return out;
}

const built = (doc: RoadDoc): Network => {
  const net = new Network(doc.clone());
  net.rebuild({ full: true });
  return net;
};

/** The opening's region round the middle of the roads: a square of `half` a side's half, solved with `margin` round it. */
function middle(doc: RoadDoc): { x: number; y: number } {
  let sx = 0, sy = 0;
  for (const n of doc.nodes.values()) { sx += n.x; sy += n.y; }
  return { x: sx / doc.nodes.size, y: sy / doc.nodes.size };
}

/** What the tiles of a region read of each solve (`RoadElevation.digest`, as the road surfaces key a tile): the same, tile by tile. */
function sameReads(a: RoadElevation, b: RoadElevation, region: readonly [number, number, number, number]): number {
  const side = m(76.8);
  let tiles = 0;
  for (let x = region[0]; x < region[2]; x += side) {
    for (let y = region[1]; y < region[3]; y += side) {
      expect(b.digest(x, y, x + side, y + side, SURFACE_READ_REACH)).toBe(a.digest(x, y, x + side, y + side, SURFACE_READ_REACH));
      tiles++;
    }
  }
  return tiles;
}

/** The whole solve, and the scoped one completed a share at a time, nearest the region first, as the renderer does it (`pendingOrder`). */
function scopedThenCompleted(doc: RoadDoc, ground: Ground, half: number, margin: number, share: number): void {
  const whole = buildRoadElevation(built(doc), ground);
  const net = built(doc);
  const c = middle(doc);
  const shown: [number, number, number, number] = [c.x - half, c.y - half, c.x + half, c.y + half];
  const region: [number, number, number, number] = [shown[0] - margin, shown[1] - margin, shown[2] + margin, shown[3] + margin];
  // Off level ground the stations are listed for the region only, never for the map.
  if (ground !== FLAT_GROUND) expect(roadsToRead(net, ground, null, null, { region }).length).toBeLessThan(net.ribbons.size);
  else expect(roadsToRead(net, ground, null)).toEqual([]);
  let elevation = buildRoadElevation(net, ground, null, undefined, null, { region });
  const total = net.ribbons.size;
  expect(elevation.pending).toBeGreaterThan(0);
  expect(elevation.pending).toBeLessThan(total);
  // What the opening shows reads the whole solve's heights already: every tile meeting the shown square, a tile past its edge.
  const tile = m(76.8);
  expect(sameReads(whole, elevation, [shown[0] - tile, shown[1] - tile, shown[2] + tile, shown[3] + tile])).toBeGreaterThan(4);
  // The rest, a share at a time, nearest the region first.
  const order = pendingOrder(net, elevation.pendingRoads!(), c.x, c.y);
  let shares = 0;
  for (let at = 0; at < order.length; at += share) {
    const before = elevation.pending!;
    elevation = buildRoadElevation(net, ground, elevation, undefined, null, { roads: order.slice(at, at + share) });
    expect(elevation.pending).toBe(Math.max(0, before - share));
    shares++;
  }
  expect(shares).toBeGreaterThan(1);
  expect(elevation.pending).toBe(0);
  expect(lines(net, elevation)).toEqual(lines(net, whole));
}

describe('the roads\' heights solved round the view first, the rest after', () => {
  it('end on the whole solve: the small city on level ground', () => {
    scopedThenCompleted(layCity(smallCityPlan(7)), FLAT_GROUND, m(80), m(320), 40);
  });

  it('end on the whole solve: the large city on level ground', () => {
    scopedThenCompleted(layCity(largeCityPlan(7)), FLAT_GROUND, m(700), m(320), 400);
  });

  it('end on the whole solve: the large city on relief', () => {
    const ground: Ground = (x, y) => 6 * Math.sin(x / 210) + 4 * Math.cos(y / 170) + 2 * Math.sin((x + y) / 90);
    scopedThenCompleted(layCity(largeCityPlan(7)), ground, m(700), m(320), 400);
  });

  it('end on the whole solve: a town on its relief, with bridges, decks and tunnels', () => {
    const doc = RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/parking-town.json', 'utf8')));
    // Raised and sunken roads carry their nodes' heights farther than a road at grade.
    const ids = [...doc.segments.keys()].sort((a, b) => a - b);
    ids.forEach((id, i) => { if (i % 7 === 3) doc.setSegmentStructure(id, i % 2 ? 'elevated' : 'tunnel'); else if (i % 11 === 5) doc.setSegmentStructure(id, 'bridge'); });
    const index = new TerrainIndex(doc.terrainStamps, 0, doc.terrainRelief);
    const ground: Ground = (x, y) => sampleTerrainHeight(index, x, y);
    let minX = Infinity, maxX = -Infinity;
    for (const n of doc.nodes.values()) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); }
    // The region a fifth of the town, its margin as the renderer's: the rest a handful of roads at a time.
    scopedThenCompleted(doc, ground, (maxX - minX) / 10, m(320), 7);
  });
});
