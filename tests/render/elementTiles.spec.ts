import { describe, expect, it } from 'vitest';
import { BoxGeometry, Frustum, type InstancedMesh, Matrix4, MeshStandardMaterial, OrthographicCamera, Vector3 } from 'three';
import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import type { ElementKind } from '@world/elements';
import { TILE } from '@world/tiles';
import { m } from '@world/units';
import { drawnMatrices } from '@render/cellInstances';
import { type ElementBake, type ElementKit, type ElementLayer, createElementLayer } from '@render/elements';
import type { Exhaust } from '@render/exhaust';
import { bakeEveryTile } from '../support/nearTileBakes';

/** A TILE'S BRUSH ELEMENTS BAKED IN A WORKER (`elementTiles.ts`): every tile's bake together draws what the page's layer draws for the whole map, and gives off the same effects */

const geometry = new BoxGeometry(1, 1, 1);
geometry.computeBoundingSphere();
const material = new MeshStandardMaterial();
const part = { geometry, material };
/** Three prop kinds, of one and two variants: no files read. */
const kit: ElementKit = {
  models: new Map<ElementKind, { geometry: BoxGeometry; material: MeshStandardMaterial }[][]>([['stones', [[part], [part, part]]], ['grass', [[part]]], ['flowers', [[part], [part]]]]),
  dispose() {},
};

/** Every instance a layer draws, by mesh, as text: culled to a view over the map. */
function drawn(layer: ElementLayer): string[] {
  const camera = new OrthographicCamera(-m(3000), m(3000), m(3000), -m(3000), 1, m(20000));
  camera.position.set(0, m(5000), 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  layer.cull(new Frustum().setFromProjectionMatrix(view), view);
  const out: string[] = [];
  layer.group.traverse((o) => {
    const mesh = o as InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    const matrices = drawnMatrices(mesh);
    for (let i = 0; i < mesh.count; i++) out.push([mesh.name, ...[...matrices.subarray(i * 16, i * 16 + 16)].map((v) => v.toFixed(3))].join(','));
  });
  return out.sort();
}

/** The puffs an effect gives off in a second near the eye. */
function puffs(layer: ElementLayer): number {
  let n = 0;
  const exhaust = { burst: (_x: number, _y: number, _z: number, count: number) => { n += count; } } as unknown as Exhaust;
  layer.emit(1, new Vector3(0, m(10), 0), exhaust);
  return n;
}

describe('a tile\'s brush elements baked in a worker', () => {
  it('every tile\'s bake together draws the page\'s layer and gives off its effects, each element once', async () => {
    const doc = new RoadDoc();
    const rng = new Rng(0xe1e7);
    const kinds: readonly ElementKind[] = ['stones', 'grass', 'flowers', 'stones', 'smoke'];
    // Round the corner of four tiles.
    const items = Array.from({ length: 300 }, (_, k) => ({
      kind: kinds[k % kinds.length]!, x: (rng.float() - 0.5) * TILE, y: (rng.float() - 0.5) * TILE, size: m(0.5) + rng.float() * m(2), yaw: rng.float() * 6.28, seed: rng.float(),
      ...(kinds[k % kinds.length] === 'smoke' ? { intensity: 0.5 } : {}),
    }));
    doc.addElements(items);
    const flat = (): number => 0;
    const page = createElementLayer(kit);
    page.sync(null, doc, flat);
    const bakes = await bakeEveryTile(doc, [-TILE / 2, -TILE / 2, TILE / 2, TILE / 2], 'elements', { layout: page.layout }, ['rest']) as ElementBake[];
    expect(bakes.length).toBe(4);
    const tiled = createElementLayer(kit);
    tiled.setTiled(true);
    for (const bake of bakes) tiled.put(bake);
    const want = drawn(page);
    expect(want.length).toBeGreaterThan(200);
    expect(drawn(tiled)).toEqual(want);
    expect(puffs(tiled)).toBe(puffs(page));
    expect(puffs(page)).toBeGreaterThan(0);
    // The page's own let go in a streamed world; a tile taken away takes its own with it.
    page.setTiled(true);
    expect(drawn(page)).toEqual([]);
    expect(page.sync(null, doc, flat)).toBe(false);
    for (const bake of bakes) tiled.take(bake);
    expect(drawn(tiled)).toEqual([]);
    page.dispose();
    tiled.dispose();
  });
});
