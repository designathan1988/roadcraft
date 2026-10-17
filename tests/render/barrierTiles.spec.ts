import { describe, expect, it } from 'vitest';
import { Frustum, type InstancedMesh, Matrix4, OrthographicCamera } from 'three';
import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import type { BarrierKind } from '@world/barriers';
import { TILE } from '@world/tiles';
import { m } from '@world/units';
import { drawnMatrices } from '@render/cellInstances';
import { type BarrierBake, type Barriers, createBarriers } from '@render/barriers';
import { bakeEveryTile } from '../support/nearTileBakes';

/** A TILE'S BARRIERS BAKED IN A WORKER (`barrierTiles.ts`): every tile's bake together draws what the page's layer draws for the whole map */

/** Every piece a layer draws, by mesh, as text: culled to a view over the map. */
function drawn(layer: Barriers): Map<string, string[]> {
  const camera = new OrthographicCamera(-m(4000), m(4000), m(4000), -m(4000), 1, m(20000));
  camera.position.set(0, m(5000), 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  layer.cull(new Frustum().setFromProjectionMatrix(view), view);
  const out = new Map<string, string[]>();
  layer.group.traverse((o) => {
    const mesh = o as InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    const matrices = drawnMatrices(mesh);
    const rows: string[] = [];
    for (let i = 0; i < mesh.count; i++) rows.push([...matrices.subarray(i * 16, i * 16 + 16)].map((v) => v.toFixed(3)).join(','));
    if (rows.length) out.set(mesh.name, [...(out.get(mesh.name) ?? []), ...rows].sort());
  });
  return out;
}

describe('a tile\'s barriers baked in a worker', () => {
  it('every tile\'s bake together draws the page\'s layer, a run crossing a tile\'s edge whole and once', async () => {
    const doc = new RoadDoc();
    const rng = new Rng(0xba11);
    const kinds: readonly BarrierKind[] = ['fence', 'wall', 'hedge', 'guardrail', 'railing'];
    for (let i = 0; i < 60; i++) {
      // Round the corner of four tiles, many reaching over an edge.
      let x = (rng.float() - 0.5) * TILE * 1.6, y = (rng.float() - 0.5) * TILE * 1.6;
      const points = [{ x, y }];
      for (let k = 0; k < 3; k++) { x += (rng.float() - 0.5) * m(160); y += (rng.float() - 0.5) * m(160); points.push({ x, y }); }
      doc.addBarrier(kinds[i % kinds.length]!, points);
    }
    const ground = (): number => 0;
    const page = createBarriers();
    page.sync(doc, ground);
    const bakes = await bakeEveryTile(doc, [-TILE, -TILE, TILE, TILE], 'barriers', undefined, ['rest']) as BarrierBake[];
    expect(bakes.length).toBeGreaterThan(1);
    const tiled = createBarriers();
    tiled.setTiled(true);
    for (const bake of bakes) tiled.put(bake);
    expect(tiled.triangles).toBe(page.triangles);
    const want = drawn(page), got = drawn(tiled);
    expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
    for (const [name, rows] of want) expect(got.get(name), name).toEqual(rows);
    for (const bake of bakes) tiled.take(bake);
    expect(tiled.triangles).toBe(0);
    // The page's own let go in a streamed world.
    page.setTiled(true);
    expect(page.triangles).toBe(0);
    expect(page.sync(doc, ground)).toBe(0);
    page.dispose();
    tiled.dispose();
  });
});
