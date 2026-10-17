import { describe, expect, it } from 'vitest';
import { type InstancedMesh, type Mesh, MeshBasicMaterial, type Object3D } from 'three';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { TILE } from '@world/tiles';
import { m } from '@world/units';
import type { SceneMaterials } from '@render/materials';
import { type StructureParts, buildStructureDetails, structureMeshes } from '@render/structures';
import { bakeEveryTile } from '../support/nearTileBakes';

/** A TILE'S ROAD STRUCTURES BAKED IN A WORKER (`structureTiles.ts`): every tile's bake together is what the page's structures draw for the whole map */

const fakeMaterials = (): SceneMaterials => {
  const mat = new MeshBasicMaterial();
  return { concrete: mat, parapet: mat, verge: mat, scale: { deck: 8, verge: 8 } } as unknown as SceneMaterials;
};

/** Every instance and every triangle drawn under `root`, by mesh, as sorted text. */
function picture(roots: readonly Object3D[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const put = (name: string, rows: string[]): void => { out.set(name, [...(out.get(name) ?? []), ...rows].sort()); };
  for (const root of roots) {
    root.traverse((o) => {
      const mesh = o as InstancedMesh;
      if (mesh.isInstancedMesh) {
        const a = mesh.instanceMatrix.array as Float32Array;
        const rows: string[] = [];
        for (let i = 0; i < mesh.count; i++) rows.push([...a.subarray(i * 16, i * 16 + 16)].map((v) => v.toFixed(3)).join(','));
        put(mesh.name, rows);
      } else if ((o as Mesh).isMesh) {
        const g = (o as Mesh).geometry, p = g.getAttribute('position'), index = g.index!;
        const rows: string[] = [];
        for (let t = 0; t < index.count; t += 3) {
          const corners = [0, 1, 2].map((k) => { const v = index.getX(t + k); return [p.getX(v), p.getY(v), p.getZ(v)].map((x) => x.toFixed(3)).join(' '); });
          rows.push(corners.join('|'));
        }
        put(o.name, rows);
      }
    });
  }
  return out;
}

describe('a tile\'s road structures baked in a worker', () => {
  it('every tile\'s bake together is the page\'s piers, crossbeams, abutments and parapets, a viaduct over a tile\'s edge once', async () => {
    const doc = new RoadDoc();
    // A viaduct and a bridge across the edge between tiles, ramps down to the ground at their ends, a road under the viaduct.
    const node = (x: number, y: number) => doc.addNode({ x, y }).id;
    const w = node(-m(500), m(200)), wv = node(-m(300), m(200)), ev = node(m(300), m(200)), e = node(m(500), m(200));
    doc.addSegment(w, wv, 2);
    doc.setSegmentStructure(doc.addSegment(wv, ev, 2)!.id, 'elevated');
    doc.addSegment(ev, e, 2);
    const s = node(m(150), -m(400)), n = node(m(150), m(700));
    doc.addSegment(s, n, 1);
    const bw = node(-m(600), TILE + m(300)), be = node(m(200), TILE + m(320));
    doc.setSegmentStructure(doc.addSegment(be, bw, 1)!.id, 'bridge');
    const net = new Network(doc);
    net.rebuild();
    const flat = (): number => 0;
    const materials = fakeMaterials();
    const page = buildStructureDetails(net, buildRoadElevation(net, flat), flat, materials, new MeshBasicMaterial());
    const bakes = await bakeEveryTile(doc, [-m(600), -m(500), m(600), TILE + m(800)], 'structures', { deckTile: materials.scale.deck }, ['roads']) as StructureParts[];
    expect(bakes.length).toBeGreaterThan(1);
    const drawn = bakes.map((parts) => structureMeshes(parts, materials, new MeshBasicMaterial()).group);
    const want = picture([page.group]);
    expect(want.get('structure-piers')?.length ?? 0).toBeGreaterThan(5);
    expect(want.get('structure-parapets')?.length ?? 0).toBeGreaterThan(10);
    const got = picture(drawn);
    expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
    for (const [name, rows] of want) expect(got.get(name), name).toEqual(rows);
  });
});
