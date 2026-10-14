import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import { buildRoadElevation } from '@world/elevation';
import { TerrainIndex, sampleTerrainHeight } from '@world/terrain';
import { buildModeAt, buildRuns, buildTotals, orderAlong, stationsAlong } from '@world/roads/buildMode';
import { RAISED_LIFT } from '@world/structures';
import { ROAD_TUNING } from '@world/roads/tuning';
import { STATION_STEP, commitRoadPath } from '@editor/commit';
import type { RoadPathPiece } from '@editor/roadPath';
import { m } from '@world/units';

/**
 * THE PREVIEW IS THE BUILD (docs/source/VIAS.md V3): the road tool's preview draws
 * the stations of the dry run (`DraftResult.stations`); the same road
 * committed and solved afresh stands at the same heights and is built the
 * same way at every station.
 */
function world(hill = false): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  if (hill) doc.addTerrainStamp({ x: 700, y: 0, radius: 160, strength: 6, mode: 'raise' });
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

const piece = (x0: number, h0: number, x1: number, h1: number): RoadPathPiece =>
  ({ start: { at: { x: x0, y: 0 }, heightOffset: h0 }, end: { at: { x: x1, y: 0 }, heightOffset: h1 }, curve: null });

function laidStations(doc: RoadDoc, net: Network, before: ReadonlySet<SegmentId>, startX: number) {
  // The ground the road tool lays on (`commit.ts`).
  const index = new TerrainIndex(doc.terrainStamps, 0, doc.terrainRelief);
  const ground = (x: number, y: number): number => sampleTerrainHeight(index, x, y);
  const laid = new Set([...doc.segments.keys()].filter((id) => !before.has(id)));
  return stationsAlong(net, buildRoadElevation(net, ground), ground, orderAlong(doc, laid, { x: startX, y: 0 }), STATION_STEP);
}

describe('the road tool previews what it builds', () => {
  it('a road raised onto piers and back: dry run and build agree at every station', () => {
    const { doc, net } = world();
    const pieces = [piece(0, 0, 200, m(5)), piece(200, m(5), 400, m(5)), piece(400, m(5), 600, 0)];
    const args = [doc, net, { kind: 'free' as const, at: { x: 0, y: 0 } }, { kind: 'free' as const, at: { x: 600, y: 0 } }, 1, pieces, null, undefined, undefined] as const;
    const preview = commitRoadPath(...args, { dryRun: true });
    expect(preview.committed).toBe(true);
    const stations = preview.stations!;
    expect(stations.length).toBeGreaterThan(100);
    const before = new Set(doc.segments.keys());
    expect(commitRoadPath(...args).committed).toBe(true);
    const built = laidStations(doc, net, before, 0);
    expect(built.length).toBe(stations.length);
    built.forEach((b, i) => {
      const p = stations[i]!;
      expect(Math.hypot(b.x - p.x, b.y - p.y)).toBeLessThan(1e-6);
      expect(b.deck).toBeCloseTo(p.deck, 6);
      expect(b.mode).toBe(p.mode);
    });
    const totals = buildTotals(buildRuns(stations));
    expect(totals.bridge).toBeGreaterThan(100);
    expect(totals.embankment).toBeGreaterThan(0);
    expect(totals.ground).toBeGreaterThan(0);
    // The stretches cover the road end to end.
    const sum = Object.values(totals).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(stations[stations.length - 1]!.s, 6);
  });

  it('a road through a hill at grade: the same agreement, with the cutting or tunnel named', () => {
    const { doc, net } = world(true);
    const pieces = [piece(300, 0, 1100, 0)];
    const args = [doc, net, { kind: 'free' as const, at: { x: 300, y: 0 } }, { kind: 'free' as const, at: { x: 1100, y: 0 } }, 1, pieces, null, undefined, undefined] as const;
    const preview = commitRoadPath(...args, { dryRun: true });
    expect(preview.committed).toBe(true);
    const before = new Set(doc.segments.keys());
    expect(commitRoadPath(...args).committed).toBe(true);
    const built = laidStations(doc, net, before, 300);
    expect(built.map((b) => b.mode)).toEqual(preview.stations!.map((p) => p.mode));
    built.forEach((b, i) => expect(b.deck).toBeCloseTo(preview.stations![i]!.deck, 6));
    expect(buildTotals(buildRuns(built)).cutting).toBeGreaterThan(0);
  });
});

describe('the way of building at a point', () => {
  it('reads the thresholds the game builds with', () => {
    const fill = ROAD_TUNING.economy.fillFrom;
    expect(buildModeAt('ground', 0)).toBe('ground');
    expect(buildModeAt('ground', fill)).toBe('embankment');
    expect(buildModeAt('ground', RAISED_LIFT + 0.1)).toBe('bridge');
    expect(buildModeAt('ground', -fill)).toBe('cutting');
    expect(buildModeAt('elevated', 0)).toBe('bridge');
    expect(buildModeAt('tunnel', -40)).toBe('tunnel');
    // A tunnel's approach on fill is not a cutting (no wall stands on an embankment).
    expect(buildModeAt('tunnel', 0)).toBe('ground');
    expect(buildModeAt('tunnel', -ROAD_TUNING.economy.fillFrom)).toBe('cutting');
  });
});
