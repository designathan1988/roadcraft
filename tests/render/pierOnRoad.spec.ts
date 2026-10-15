import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, MeshBasicMaterial, Vector3 } from 'three';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { casingHalf } from '@world/roadTypes';
import { ROAD_TUNING } from '@world/roads/tuning';
import { buildStructureDetails, onAnotherCasing } from '@render/structures';
import type { SceneMaterials } from '@render/materials';
import { m } from '@world/units';

/**
 * A viaduct over a road: no pier of it stands on the road under it. The
 * road under it is one long straight segment, its two nodes far from the
 * viaduct, so the piers fall on the middle of a segment, between its nodes.
 */
function viaductOverRoad() {
  const doc = new RoadDoc();
  const west = doc.addNode({ x: m(-400), y: 0 }), east = doc.addNode({ x: m(400), y: 0 });
  const viaduct = doc.addSegment(west.id, east.id, 2)!;
  doc.setSegmentStructure(viaduct.id, 'elevated');
  // Under a bent of the viaduct (the piers stand every `spacing` from half a spacing in).
  const spacing = ROAD_TUNING.piers.spacingElevated;
  const k = Math.floor(m(400) / spacing);
  const x = m(-400) + spacing * (0.5 + k);
  const south = doc.addNode({ x, y: m(-300) }), north = doc.addNode({ x, y: m(300) });
  const road = doc.addSegment(south.id, north.id, 2)!;
  const net = new Network(doc);
  net.rebuild();
  const ground = (): number => 0;
  const elevation = buildRoadElevation(net, ground);
  return { doc, net, elevation, ground, viaduct: viaduct.id, road: road.id, x };
}

const fakeMaterials = (): SceneMaterials => {
  const mat = new MeshBasicMaterial();
  return { concrete: mat, parapet: mat, verge: mat, scale: { deck: 8, verge: 8 } } as unknown as SceneMaterials;
};

describe('piers of a raised road', () => {
  it('a point in the middle of another road, far from its nodes, is on its casing', () => {
    const { net, viaduct, x } = viaductOverRoad();
    expect(onAnotherCasing(net, viaduct, x, m(2))).toBe(true);
    expect(onAnotherCasing(net, viaduct, x + m(60), m(2))).toBe(false);
  });

  it('none stands on the road under the viaduct', () => {
    const { net, elevation, ground, road, x } = viaductOverRoad();
    const details = buildStructureDetails(net, elevation, ground, fakeMaterials());
    const piers = details.group.getObjectByName('structure-piers') as InstancedMesh | undefined;
    expect(piers).toBeDefined();
    const reach = casingHalf(net.ribbons.get(road)!.road);
    const matrix = new Matrix4(), at = new Vector3();
    const onRoad: number[] = [];
    for (let i = 0; i < piers!.count; i++) {
      piers!.getMatrixAt(i, matrix);
      at.setFromMatrixPosition(matrix);
      // The column's foot: a cylinder of radius 1 to 1.08 (`CylinderGeometry(1, 1.08)`) scaled by its width.
      const foot = Math.hypot(matrix.elements[0]!, matrix.elements[2]!) * 1.08;
      if (Math.abs(at.x - x) < reach + foot) onRoad.push(at.x);
    }
    expect(piers!.count).toBeGreaterThan(4);
    expect(onRoad).toEqual([]);
    details.dispose();
  });
});
