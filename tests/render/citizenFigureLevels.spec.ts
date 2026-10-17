import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Color, Group, Matrix4, MeshDepthMaterial, MeshStandardMaterial, type SkinnedMesh } from 'three';
import { type CitizenPart, citizenLookAt, placeFigure } from '@render/riggedCitizens';
import { perM } from '@world/units';

/** EACH COOKED FIGURE AT ITS OWN LEVEL (plan 9.6): a figure near and a figure far of the same body drawn by two meshes, each instance reading its own palette row */
function part(): CitizenPart {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  const coarser = new BufferGeometry();
  coarser.setAttribute('position', geometry.getAttribute('position'));
  return {
    source: { name: 'body', morphTargetInfluences: undefined } as unknown as SkinnedMesh, local: new Matrix4(),
    lods: [geometry, coarser, coarser, coarser], fine: new MeshStandardMaterial(), coarse: new MeshStandardMaterial(), depth: new MeshDepthMaterial(),
    name: 'citizen-test-body', drawn: [],
  };
}

describe('the cooked figures by their own size on the screen', () => {
  it('draws a near and a far figure of one body in two meshes, each instance on the palette row the pass wrote for it', () => {
    const group = new Group();
    const batch = { parts: [part()], resources: new Set<{ dispose(): void }>(), count: 0, lastUsed: 0 };
    const near = citizenLookAt(perM(40)), far = citizenLookAt(perM(2));
    expect(near.level).toBe(0);
    expect(far.level).toBeGreaterThan(0);
    expect(far.band).toBeGreaterThanOrEqual(2);
    for (const look of [far, near, far]) placeFigure(group, batch, look, new Matrix4(), new Color(1, 1, 1), 1);
    expect(batch.count).toBe(3);
    const drawn = batch.parts[0]!.drawn.filter((d) => d !== undefined);
    expect(drawn.length).toBe(2);
    const nearMesh = drawn.find((d) => d.level === 0)!, farMesh = drawn.find((d) => d.level > 0)!;
    expect(nearMesh.count).toBe(1);
    expect(farMesh.count).toBe(2);
    // The rows the palette pass wrote them on, in the order they were drawn.
    expect([...(nearMesh.rows.array as Float32Array).subarray(0, 1)]).toEqual([1]);
    expect([...(farMesh.rows.array as Float32Array).subarray(0, 2)]).toEqual([0, 2]);
    // The far one in the coarse materials (no skin detail), the near one in the fine.
    expect(farMesh.coarse).toBe(true);
    expect(farMesh.mesh.material).toBe(batch.parts[0]!.coarse);
    expect(nearMesh.mesh.material).toBe(batch.parts[0]!.fine);
    expect(group.children.length).toBe(2);
  });

  it('keeps the face and the detail for the zoom they were shown at for the whole view', () => {
    expect([75, 20, 19.75, 5, 4.75, 3, 2.75].map((pxPerM) => citizenLookAt(perM(pxPerM)).band)).toEqual([0, 0, 1, 1, 2, 2, 3]);
    expect(citizenLookAt(perM(20)).level).toBe(0);
  });
});
