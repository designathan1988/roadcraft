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
  it('is drawn the moment it is committed, casing, carriageway and the junctions at its ends, at the road\'s height, and let go with its tile', () => {
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
    // The crossing it starts at too.
    expect(new Raycaster(new Vector3(m(300), m(50), -m(200)), new Vector3(0, -1, 0)).intersectObjects(meshes).length).toBeGreaterThan(0);
    // Not looked at for letting go in the frame it came (its near roads not asked of the edit yet); from the next frame on.
    expect(standIn.settled()).toEqual([]);
    standIn.settle();
    expect(standIn.settled()).toEqual(standIn.tiles);
    // Its tile's near roads drawn: let go.
    standIn.drop(standIn.tiles[0]!);
    expect(standIn.group.children.length).toBe(0);
    expect(standIn.tiles).toEqual([]);
  });
});
