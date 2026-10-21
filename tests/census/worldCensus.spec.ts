import { describe, expect, it } from 'vitest';

import { buildSmallCityMap } from '@editor/smallCityMap';
import { createBuildingLayer } from '@render/buildings/layer';
import { gardenPlants } from '@render/gardens';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';

/**
 * THE WORLD AS THE GAME DERIVES IT, WITHOUT OPENING THE GAME: the small city of seed 7 put through the same code the renderer feeds
 * (the document, the network, the buildings' layer settled at a district view, the gardens, the planted trees), and what each makes
 * counted. Seconds, no GPU, no browser. A system that stops making its part (a layer drawing nothing, trees or gardens gone) shows
 * here as a count that fell; a change made on purpose updates the numbers in the same commit, and says why.
 */
describe('world census', () => {
  it('the small city of seed 7 derives what it derived before', () => {
    const doc = RoadDoc.fromJSON(buildSmallCityMap(7));
    const net = new Network(doc);
    net.rebuild();
    const flat = (): number => 0;

    const layer = createBuildingLayer();
    // A district view over the city's centre: the eye 400 m up, looking down.
    layer.levelOfDetail(0, 0, m(400), 1000, null);
    for (let frame = 0; frame < 5000 && (layer.update(doc, flat, 'g') || layer.pending); frame++) layer.levelOfDetail(0, 0, m(400), 1000, null);
    let meshes = 0;
    layer.group.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) meshes++; });

    const buildings = [...doc.buildings.all()];
    const census = {
      segments: doc.segments.size,
      lots: doc.lots.length,
      buildings: buildings.length,
      plantedTrees: doc.trees.length,
      gardenPlants: gardenPlants(buildings, flat).length,
      layerTriangles: layer.triangles,
      layerMeshes: meshes,
    };
    expect(census).toMatchInlineSnapshot(`
      {
        "buildings": 1348,
        "gardenPlants": 18052,
        "layerMeshes": 252,
        "layerTriangles": 2769725,
        "lots": 1348,
        "plantedTrees": 663,
        "segments": 294,
      }
    `);
    layer.dispose();
  });
});
