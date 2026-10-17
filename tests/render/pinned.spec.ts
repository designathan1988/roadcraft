import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Matrix4, Scene, type Object3D } from 'three';
import { createAgentMeshes } from '@render/agents';
import { createDensityCars } from '@render/densityCars';
import { createTrackPreview, createTransit } from '@render/transit';
import { createRiggedCitizens } from '@render/riggedCitizens';
import { createProceduralCrowd } from '@render/people/proceduralCrowd';

/** R14: what never moves as an object (people, vehicles, trains, far cars: their instances move) is never composed nor multiplied by three's frame */

const pinnedTree = (root: Object3D): Object3D[] => {
  const loose: Object3D[] = [];
  root.traverse((o) => { if (o.matrixAutoUpdate || o.matrixWorldAutoUpdate) loose.push(o); });
  return loose;
};
const IDENTITY = new Matrix4();

describe('objects moved only by their instances', () => {
  beforeAll(() => { vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {} }); vi.stubGlobal('location', { search: '?bodies=cooked' }); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('ask nothing of three each frame, and stand at the origin', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const rigged = createRiggedCitizens();
    const crowd = createProceduralCrowd({ unit: 1 });
    const far = createDensityCars(() => 0);
    const transit = createTransit();
    const preview = createTrackPreview();
    const scene = new Scene();
    const roots: Object3D[] = [...agents.meshes.filter((o) => o.name !== 'rigged-citizens'), rigged.group, crowd.group, far.object, preview.group];
    for (const root of roots) {
      expect(pinnedTree(root).map((o) => o.name || o.type), root.name).toEqual([]);
      scene.add(root);
    }
    const trains = transit.group.getObjectByName('transit-trains')!;
    expect([transit.group.matrixAutoUpdate, trains.matrixAutoUpdate, trains.matrixWorldAutoUpdate]).toEqual([false, false, false]);
    scene.updateMatrixWorld();
    for (const root of roots) root.traverse((o) => expect(o.matrixWorld.equals(IDENTITY)).toBe(true));
    agents.dispose();
    rigged.dispose();
    far.dispose();
  });
});
