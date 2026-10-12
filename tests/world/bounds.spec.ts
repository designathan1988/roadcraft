import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { MAP_MARGIN, WORLD_HALF, clampToMap, insideMap } from '@world/bounds';
import { FLAT_WORLD } from '@world/flatEarth';
import { casingHalf, roadProfile } from '@world/roadTypes';

/**
 * NOTHING LEAVES THE MAP.
 *
 * The ground is finite - the whole flat Earth's plates (`world/flatEarth.ts`,
 * some 24 x 12 km) - and anything built past its rim stands on nothing: a road hanging in the void, its footway with it, and the
 * lamps, bins and poles that hang off the road going too.
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
  it('holds a node inside the plate wherever it is asked for', () => {
    const doc = new RoadDoc();
    const far = doc.addNode({ x: WORLD_HALF * 4, y: -WORLD_HALF * 9 });

    expect(insideMap({ x: far.x, y: far.y })).toBe(true);
    expect(far.x).toBeCloseTo(FLAT_WORLD.maxX - MAP_MARGIN, 6);
    expect(far.y).toBeCloseTo(FLAT_WORLD.minY + MAP_MARGIN, 6);
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

    doc.moveNode(b.id, { x: WORLD_HALF * 3, y: 0 });
    const moved = doc.node(b.id);
    expect(moved).toBeDefined();
    expect(insideMap({ x: moved!.x, y: moved!.y })).toBe(true);
  });

  it('holds a pole run that is drawn off the edge', () => {
    const doc = new RoadDoc();
    const pole = doc.addPole({ x: -WORLD_HALF * 2, y: WORLD_HALF * 2 });
    expect(insideMap({ x: pole.x, y: pole.y })).toBe(true);
  });

  it('keeps the whole WIDTH of a road on the plate, not only its centreline', () => {
    // A centreline exactly on the rim still puts half a carriageway, a footway
    // and a casing over the void. The margin exists for that, and this is the
    // test that says so with the real widths rather than with a guess.
    const doc = new RoadDoc();
    const widest = 3;
    const a = doc.addNode({ x: WORLD_HALF * 2, y: FLAT_WORLD.maxY - 400 });
    const b = doc.addNode({ x: WORLD_HALF * 2, y: WORLD_HALF * 2 });
    doc.addSegment(a.id, b.id, widest);

    const net = new Network(doc);
    net.rebuild();

    const half = casingHalf(roadProfile(widest, undefined, 'both'));
    expect(MAP_MARGIN).toBeGreaterThan(half);

    for (const ribbon of net.ribbons.values()) {
      const box = ribbon.full.bbox;
      const reach = casingHalf(ribbon.road);
      expect(box.minX - reach).toBeGreaterThanOrEqual(FLAT_WORLD.minX);
      expect(box.maxX + reach).toBeLessThanOrEqual(FLAT_WORLD.maxX);
      expect(box.minY - reach).toBeGreaterThanOrEqual(FLAT_WORLD.minY);
      expect(box.maxY + reach).toBeLessThanOrEqual(FLAT_WORLD.maxY);
    }
  });

  it('survives a round trip through the save format', () => {
    const doc = new RoadDoc();
    doc.addNode({ x: WORLD_HALF * 5, y: 0 });
    doc.addPole({ x: 0, y: WORLD_HALF * 5 });

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
    const at = clampToMap({ x: WORLD_HALF * 3, y: 100 });
    expect(at.y).toBe(100);
    expect(at.x).toBe(FLAT_WORLD.maxX - MAP_MARGIN);
  });

  it('is the whole flat Earth: a road can be built kilometres from the old plate', () => {
    // The player, 2026-10-11: "no modo plano tem que ter o mapa completo do
    // mesmo tamanho que é no globo". The old 1.92 km plate is one of many.
    const doc = new RoadDoc();
    const node = doc.addNode({ x: 9000, y: -4000 });
    expect(node.x).toBe(9000);
    expect(node.y).toBe(-4000);
    expect(FLAT_WORLD.maxX - FLAT_WORLD.minX).toBeGreaterThan(20_000);
  });
});
