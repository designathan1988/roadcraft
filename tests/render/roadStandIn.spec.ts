import { describe, expect, it } from 'vitest';
import { type Mesh, Raycaster, Vector3 } from 'three';
import { RoadDoc } from '@world/doc';
import { buildRoadElevation } from '@world/elevation';
import { Network } from '@world/network';
import { tileKeyAt } from '@world/tiles';
import { m } from '@world/units';
import { RoadStandIn } from '@render/roadStandIn';

/** A ROAD JUST BUILT STANDS IN THE SCENE AT ONCE (`roadStandIn.ts`), until its tile's near roads come back from their worker */

describe('a road just built', () => {
  it('is drawn the moment it is committed, its own casing and carriageway at the road\'s height, never the streets it meets, and let go with its tile', () => {
    const doc = new RoadDoc();
    // A crossing: the new street from the middle of an avenue out east.
    const w = doc.addNode({ x: m(100), y: m(200) }), c = doc.addNode({ x: m(300), y: m(200) }), e = doc.addNode({ x: m(500), y: m(200) });
    doc.addSegment(w.id, c.id, 2);
    doc.addSegment(c.id, e.id, 2);
    const n = doc.addNode({ x: m(300), y: m(450) });
    const street = doc.addSegment(c.id, n.id, 1)!;
    const net = new Network(doc);
    net.rebuild();
    const elevation = buildRoadElevation(net, () => m(3));
    const standIn = new RoadStandIn();
    standIn.show(net, elevation, [street.id]);
    // In the scene now: nothing waited for.
    const meshes = standIn.group.children as Mesh[];
    expect(meshes.length).toBeGreaterThan(0);
    expect(standIn.tiles).toEqual([tileKeyAt(m(300), m(325))]);
    // The street's middle covered, at the road's height (world y is three's -z).
    const ray = new Raycaster(new Vector3(m(300), m(50), -m(325)), new Vector3(0, -1, 0));
    const hit = ray.intersectObjects(meshes)[0];
    expect(hit).toBeDefined();
    expect(hit!.point.y).toBeCloseTo(elevation.onSegment(street.id, m(300), m(325)), 3);
    // Never the avenue it meets, nor the crossing they share: their near roads are drawn already.
    const down = (x: number, y: number): number => new Raycaster(new Vector3(x, m(50), -y), new Vector3(0, -1, 0)).intersectObjects(meshes).length;
    expect(down(m(200), m(200))).toBe(0);
    expect(down(m(400), m(200))).toBe(0);
    expect(down(m(300), m(200))).toBe(0);
    // Not looked at for letting go in the frame it came (its near roads not asked of the edit yet); from the next frame on.
    expect(standIn.settled()).toEqual([]);
    standIn.settle();
    expect(standIn.settled()).toEqual(standIn.tiles);
    // Its tile's near roads drawn: let go.
    standIn.drop(standIn.tiles[0]!);
    expect(standIn.group.children.length).toBe(0);
    expect(standIn.tiles).toEqual([]);
  });

  it('on a map the page draws whole keeps every commit not landed, two in a row both drawn, each let go once the build of its revision lands', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(100), y: m(100) }), b = doc.addNode({ x: m(400), y: m(100) });
    const first = doc.addSegment(a.id, b.id, 1)!;
    let net = new Network(doc);
    net.rebuild();
    const standIn = new RoadStandIn();
    standIn.show(net, buildRoadElevation(net, () => 0), [first.id], net.revision);
    const r1 = net.revision;
    // A second road a second later, before the build of the first landed.
    const c = doc.addNode({ x: m(400), y: m(400) });
    const second = doc.addSegment(b.id, c.id, 1)!;
    net = new Network(doc);
    net.rebuild();
    standIn.show(net, buildRoadElevation(net, () => 0), [second.id], doc.revision);
    const r2 = doc.revision;
    const meshes = (): Mesh[] => standIn.group.children as Mesh[];
    const down = (x: number, y: number): number => new Raycaster(new Vector3(x, m(50), -y), new Vector3(0, -1, 0)).intersectObjects(meshes()).length;
    // Both drawn, the first not given up for the second; none filed by tile (nothing of the tiles' near roads lets them go).
    expect(down(m(250), m(100))).toBeGreaterThan(0);
    expect(down(m(400), m(250))).toBeGreaterThan(0);
    expect(standIn.tiles).toEqual([]);
    expect(standIn.revisions).toEqual([r1, r2]);
    // The build of the first revision lands: the first let go, the second kept.
    standIn.landed(r1);
    expect(down(m(250), m(100))).toBe(0);
    expect(down(m(400), m(250))).toBeGreaterThan(0);
    // The build of the second lands: nothing left.
    standIn.landed(r2);
    expect(meshes()).toEqual([]);
  });
});
