import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { MAP_HALF, MAP_MARGIN, MAP_REGIONS, MAP_SIZE, PLATE_SIZE, clampToMap, insideMap, plateOf, regionAt } from '@world/bounds';
import { casingHalf, roadProfile } from '@world/roadTypes';

/**
 * NOTHING LEAVES THE MAP.
 *
 * The ground is finite - a square about 10 km on a side (`world/bounds.ts`) - and
 * anything built past its rim stands on nothing: a road hanging in the void,
 * its footway with it, and the lamps, bins and poles that hang off the road
 * going too.
 *
 * The vegetation was contained already — it was scattered around the network
 * centre with no reference to the plate, and that was fixed when it was caught
 * planting trees off the end of the world. Everything the PLAYER authors was
 * not: a node could be dropped anywhere the camera could reach.
 *
 * The containment is in `RoadDoc`, at the two points a position enters the
 * document, because a node is what roads, junctions, footways, lanelets and
 * street furniture are all derived from. Holding the node holds all of them,
 * and no later pass has to remember to check.
 */

describe('the map edge', () => {
  it('holds a node inside the map wherever it is asked for', () => {
    const doc = new RoadDoc();
    const far = doc.addNode({ x: MAP_HALF * 4, y: -MAP_HALF * 9 });

    expect(insideMap({ x: far.x, y: far.y })).toBe(true);
    expect(far.x).toBeCloseTo(MAP_HALF - MAP_MARGIN, 6);
    expect(far.y).toBeCloseTo(-MAP_HALF + MAP_MARGIN, 6);
  });

  it('leaves a node that is already on the map exactly where it was asked for', () => {
    const doc = new RoadDoc();
    const node = doc.addNode({ x: 123.5, y: -67.25 });
    expect(node.x).toBe(123.5);
    expect(node.y).toBe(-67.25);
  });

  it('holds a node being dragged off the edge', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: 0 });
    const b = doc.addNode({ x: 300, y: 0 });
    doc.addSegment(a.id, b.id, 1);

    doc.moveNode(b.id, { x: MAP_HALF * 3, y: 0 });
    const moved = doc.node(b.id);
    expect(moved).toBeDefined();
    expect(insideMap({ x: moved!.x, y: moved!.y })).toBe(true);
  });

  it('holds a pole run that is drawn off the edge', () => {
    const doc = new RoadDoc();
    const pole = doc.addPole({ x: -MAP_HALF * 2, y: MAP_HALF * 2 });
    expect(insideMap({ x: pole.x, y: pole.y })).toBe(true);
  });

  it('keeps the whole WIDTH of a road on the map, not only its centreline', () => {
    // A centreline exactly on the rim still puts half a carriageway, a footway
    // and a casing over the void. The margin exists for that, and this is the
    // test that says so with the real widths rather than with a guess.
    const doc = new RoadDoc();
    const widest = 3;
    const a = doc.addNode({ x: MAP_HALF * 2, y: MAP_HALF - 400 });
    const b = doc.addNode({ x: MAP_HALF * 2, y: MAP_HALF * 2 });
    doc.addSegment(a.id, b.id, widest);

    const net = new Network(doc);
    net.rebuild();

    const half = casingHalf(roadProfile(widest, undefined, 'both'));
    expect(MAP_MARGIN).toBeGreaterThan(half);

    for (const ribbon of net.ribbons.values()) {
      const box = ribbon.full.bbox;
      const reach = casingHalf(ribbon.road);
      expect(box.minX - reach).toBeGreaterThanOrEqual(-MAP_HALF);
      expect(box.maxX + reach).toBeLessThanOrEqual(MAP_HALF);
      expect(box.minY - reach).toBeGreaterThanOrEqual(-MAP_HALF);
      expect(box.maxY + reach).toBeLessThanOrEqual(MAP_HALF);
    }
  });

  it('survives a round trip through the save format', () => {
    const doc = new RoadDoc();
    doc.addNode({ x: MAP_HALF * 5, y: 0 });
    doc.addPole({ x: 0, y: MAP_HALF * 5 });

    const restored = RoadDoc.fromJSON(doc.toJSON());
    for (const node of restored.nodes.values()) {
      expect(insideMap({ x: node.x, y: node.y })).toBe(true);
    }
    for (const pole of restored.poles.values()) {
      expect(insideMap({ x: pole.x, y: pole.y })).toBe(true);
    }
  });

  it('clamps to the nearest point rather than to a corner', () => {
    // A drag that runs off ONE edge should build up to that edge, keeping the
    // other coordinate. Clamping both would drag the road sideways.
    const at = clampToMap({ x: MAP_HALF * 3, y: 100 });
    expect(at.y).toBe(100);
    expect(at.x).toBe(MAP_HALF - MAP_MARGIN);
  });

  it('is about 10 km on a side: a road can be built kilometres from the old plate', () => {
    // The player, 2026-10-13: "QUERO 10KM" - five plates of 320 cells of 6.4 m.
    expect(MAP_SIZE).toBe(10_240);
    const doc = new RoadDoc();
    const node = doc.addNode({ x: 4500, y: -4000 });
    expect(node.x).toBe(4500);
    expect(node.y).toBe(-4000);
  });

  it('is laid in plates that tile it, one centred on the origin', () => {
    expect(MAP_REGIONS.length * PLATE_SIZE * PLATE_SIZE).toBe(MAP_SIZE * MAP_SIZE);
    expect(regionAt(0, 0)).toMatchObject({ cx: 0, cy: 0 });
    MAP_REGIONS.forEach((r, i) => {
      expect(plateOf(r.cx, r.cy)).toBe(i);
      expect(plateOf(r.cx + r.half * 0.98, r.cy - r.half * 0.98)).toBe(i);
      expect(Math.abs(r.cx) + r.half).toBeLessThanOrEqual(MAP_HALF);
      expect(Math.abs(r.cy) + r.half).toBeLessThanOrEqual(MAP_HALF);
    });
    // A point off the map belongs to the plate on its edge.
    expect(MAP_REGIONS[plateOf(MAP_HALF * 3, 0)]!.cx).toBe(MAP_HALF - PLATE_SIZE / 2);
  });
});
