import { describe, expect, it, vi } from 'vitest';
import { Frustum, Matrix4, OrthographicCamera, type InstancedMesh } from 'three';
import { Rng } from '@core/rng';
import { Network } from '@world/network';
import { applyLots, planLots } from '@world/lots';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { greenCity, layCity, widenCityFootways } from '@editor/cityGenerator';
import { buildRoadElevation } from '@world/elevation';
import { GROW_MINUTES, type LandscapeKind, snapLandscape } from '@world/landscape';
import type { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { drawnMatrices } from '@render/cellInstances';
import { createSceneryKit } from '@render/scenery';
import { type FurnitureBake, bakeFurniture, createStreetFurniture } from '@render/streetFurnitureLayer';
import { nearCrossingAccess } from '@world/landscape';
import { furnitureProduct } from '@render/furnitureTiles';
import { bakeEveryTile } from '../support/nearTileBakes';

/** The one-point landing query watched (the module as it is otherwise): a bake files the landings once instead. */
vi.mock('@world/landscape', async (actual) => {
  const real = await actual<typeof import('@world/landscape')>();
  return { ...real, nearCrossingAccess: vi.fn(real.nearCrossingAccess) };
});

/** A TILE'S STREET FURNITURE BAKED IN A WORKER (`furnitureTiles.ts`): every tile's bake together draws what the page's layer draws for the whole town */

const kit = createSceneryKit();

/** The generated town, with items of every kind placed over it (some planted, still growing). */
function town(): { doc: RoadDoc; net: Network; box: [number, number, number, number] } {
  const doc = layCity(planCity({ ...DEFAULT_CITY, size: 'small' }));
  widenCityFootways(doc);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  greenCity(doc, net, DEFAULT_CITY.seed);
  if (net.revision !== doc.revision) net.rebuild();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of doc.nodes.values()) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
  const rng = new Rng(0x7f1e);
  const kinds: readonly LandscapeKind[] = ['lamp', 'bench', 'bin', 'tree', 'shrub', 'hydrant', 'postbox', 'phone', 'drain', 'meadow'];
  for (let i = 0; i < 400; i++) {
    const kind = kinds[i % kinds.length]!;
    const at = { x: x0 + rng.float() * (x1 - x0), y: y0 + rng.float() * (y1 - y0) };
    const snap = snapLandscape(net, doc.landscape.values(), kind, at, m(30));
    doc.addLandscape(kind, snap.ok ? snap.at : at, rng.float() < 0.3 ? { planted: Math.floor(rng.float() * 2000) } : {});
  }
  if (net.revision !== doc.revision) net.rebuild();
  return { doc, net, box: [x0, y0, x1, y1] };
}

/** Every instance a layer draws, by mesh, as text: culled to a view over the whole town. */
function drawn(layer: ReturnType<typeof createStreetFurniture>, box: readonly [number, number, number, number]): Map<string, string[]> {
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const camera = new OrthographicCamera(-m(6000), m(6000), m(6000), -m(6000), 1, m(20000));
  camera.position.set(cx, m(5000), -cy);
  camera.lookAt(cx, 0, -cy);
  camera.updateMatrixWorld();
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  layer.cull(new Frustum().setFromProjectionMatrix(view), view);
  const out = new Map<string, string[]>();
  for (const mesh of [...layer.meshes, ...(layer.grass.children as InstancedMesh[])]) {
    const rows: string[] = [];
    const matrices = drawnMatrices(mesh), colours = mesh.instanceColor?.array;
    for (let i = 0; i < mesh.count; i++) {
      rows.push([...matrices.subarray(i * 16, i * 16 + 16), ...(colours ? colours.subarray(i * 3, i * 3 + 3) : [])].map((v) => v.toFixed(3)).join(','));
    }
    if (rows.length) out.set(mesh.name, [...(out.get(mesh.name) ?? []), ...rows].sort());
  }
  return out;
}

describe('a tile\'s street furniture baked in a worker', () => {
  it('files the crossings\' landings once a bake, never asking the roads round each item for them', () => {
    const { doc, net } = town();
    vi.mocked(nearCrossingAccess).mockClear();
    const bake = bakeFurniture(net, buildRoadElevation(net, () => 0), () => 0, doc.landscape.values(), kit.lens, GROW_MINUTES);
    expect(bake.furniture?.size).toBeGreaterThan(0);
    expect(vi.mocked(nearCrossingAccess)).not.toHaveBeenCalled();
  });

  it('every tile\'s bake together draws the page\'s layer of the whole town, the plants sized at the city\'s hour', async () => {
    const { doc, net, box } = town();
    const minutes = GROW_MINUTES / 2 + 37;
    const page = createStreetFurniture(kit);
    page.sync(net, buildRoadElevation(net, () => 0), () => 0, minutes);
    const product = furnitureProduct(page, kit.lens, () => minutes);
    const bakes = await bakeEveryTile(doc, box, 'furniture', product.extra!(0)) as FurnitureBake[];
    expect(bakes.length).toBeGreaterThan(1);
    expect(bakes.some((b) => b.growing)).toBe(true);
    const tiled = createStreetFurniture(kit);
    tiled.setTiled(true);
    for (const bake of bakes) tiled.put(bake);
    const want = drawn(page, box), got = drawn(tiled, box);
    expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
    for (const [name, rows] of want) expect(got.get(name), name).toEqual(rows);
    // A tile taken away takes its instances with it.
    tiled.take(bakes[0]!);
    const less = drawn(tiled, box);
    expect([...less.values()].reduce((n, rows) => n + rows.length, 0)).toBeLessThan([...got.values()].reduce((n, rows) => n + rows.length, 0));
    page.dispose();
    tiled.dispose();
  });

  it('a streamed world lets the page\'s own items go, and makes them again when it closes', () => {
    const { net } = town();
    const layer = createStreetFurniture(kit);
    const elevation = buildRoadElevation(net, () => 0);
    layer.sync(net, elevation, () => 0, 0);
    const before = layer.triangles;
    expect(before).toBeGreaterThan(0);
    layer.setTiled(true);
    expect(layer.sync(net, elevation, () => 0, 0)).toBe(0);
    expect(layer.triangles).toBe(0);
    layer.setTiled(false);
    layer.sync(net, elevation, () => 0, 0);
    expect(layer.triangles).toBe(before);
    layer.dispose();
  });
});
