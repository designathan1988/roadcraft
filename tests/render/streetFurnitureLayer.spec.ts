import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, OrthographicCamera, type Camera, type InstancedMesh, type Object3D } from 'three';

import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation, type RoadElevation } from '@world/elevation';
import { snapLandscape, GROW_MINUTES, type LandscapeKind } from '@world/landscape';
import type { ChangeRect } from '@world/changes';
import type { SegmentId } from '@world/ids';
import { m } from '@world/units';
import { drawnMatrices, posesOf } from '@render/cellInstances';
import { createSceneryKit } from '@render/scenery';
import { createStreetFurniture, furnitureProduct, meadowProduct } from '@render/streetFurnitureLayer';
import { lookProps, propView } from '@render/propCells';
import { proveIncremental } from '../support/derivedEquivalence';

/** THE STREET FURNITURE ON THE SPINE (`streetFurnitureLayer.ts`) */

const span = m(500);
const kit = createSceneryKit();

/** The document, its network and its roads' heights, kept up as the renderer keeps them. */
class Town {
  readonly doc = new RoadDoc();
  readonly net = new Network(this.doc);
  elevation: RoadElevation;
  private seen = 0;
  readonly groundAt = (): number => 0;
  constructor() {
    const rng = new Rng(11);
    for (let i = 0; i < 6; i++) this.road(rng);
    this.net.rebuild();
    this.elevation = buildRoadElevation(this.net, () => 0);
    this.seen = this.doc.changes.version;
  }
  get changes() { return this.doc.changes; }
  road(rng: Rng): void {
    const a = this.doc.addNode({ x: rng.float() * span, y: rng.float() * span });
    const b = this.doc.addNode({ x: a.x + (rng.float() - 0.5) * m(160), y: a.y + (rng.float() - 0.5) * m(160) });
    this.doc.addSegment(a.id, b.id, 1 + Math.floor(rng.float() * 3));
  }
  /** After an edit: the network rebuilt and the roads' heights solved, written as the renderer writes them (where the roads moved). */
  settle(): void {
    if (this.net.revision !== this.doc.revision) this.net.rebuild();
    const roads = this.doc.changes.since(this.seen, ['roads']);
    if (roads === null || roads.length) {
      this.elevation = buildRoadElevation(this.net, () => 0);
      const rects: ChangeRect[] | null = roads === null || roads.some((e) => e.rects === null) ? null
        : roads.flatMap((e) => e.rects!.map((r): ChangeRect => [r[0] - m(5), r[1] - m(5), r[2] + m(5), r[3] + m(5)]));
      this.doc.changes.record('elevation', rects);
    }
    this.seen = this.doc.changes.version;
  }
}

const KINDS: readonly LandscapeKind[] = ['lamp', 'bench', 'bin', 'tree', 'shrub', 'hydrant', 'postbox', 'phone', 'drain', 'meadow'];

const edits = [
  // An item placed where the tool would put it (on a footway), or anywhere.
  (town: Town, rng: Rng) => {
    const kind = KINDS[Math.floor(rng.float() * KINDS.length)]!;
    const at = { x: rng.float() * span, y: rng.float() * span };
    const snap = snapLandscape(town.net, town.doc.landscape.values(), kind, at, m(30));
    town.doc.addLandscape(kind, snap.ok ? snap.at : at, rng.float() < 0.3 ? { planted: Math.floor(rng.float() * 2000) } : {});
    town.settle();
  },
  (town: Town, rng: Rng) => {
    const ids = [...town.doc.landscape.keys()];
    if (ids.length) town.doc.removeLandscape(ids[Math.floor(rng.float() * ids.length)]!);
    town.settle();
  },
  (town: Town, rng: Rng) => { town.road(rng); town.settle(); },
  (town: Town, rng: Rng) => {
    const ids = [...town.doc.segments.keys()];
    if (ids.length > 2) town.doc.removeSegment(ids[Math.floor(rng.float() * ids.length)]! as SegmentId);
    town.settle();
  },
];

/** A camera over the town from straight above, `half` world units half high. */
function over(half: number): Camera {
  const camera = new OrthographicCamera(-half, half, half, -half, 1, m(20000));
  camera.position.set(span / 2, m(5000), -span / 2);
  camera.lookAt(span / 2, 0, -span / 2);
  camera.updateMatrixWorld();
  return camera;
}

/** The layer brought to a camera's view (`lookProps`, every cell and block it wants placed) and culled to it. */
function seen(layer: ReturnType<typeof createStreetFurniture>, camera: Camera): void {
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const frustum = new Frustum().setFromProjectionMatrix(view);
  for (let i = 0; i < 100; i++) {
    lookProps([layer.layer], propView(camera, frustum, 540, 0));
    if (!layer.layer.busy) break;
  }
  layer.cull(frustum, view);
}

/**
 * Every instance a layer draws, by mesh, as text: seen from over the whole town (every thing a far batch's, `propCells.ts`) and from
 * close over its middle (the near cells' and the far batches' both).
 */
function drawn(layer: ReturnType<typeof createStreetFurniture>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [view, camera] of [['whole', over(m(4000))], ['close', over(m(150))]] as const) {
    seen(layer, camera);
    for (const mesh of [...layer.meshes, ...(layer.grass.children as InstancedMesh[])]) {
      // A far block the view does not want is hidden (its group): it draws nothing.
      let shown = true;
      for (let o: Object3D | null = mesh; o; o = o.parent) shown &&= o.visible;
      if (!shown) continue;
      const rows: string[] = [];
      const matrices = drawnMatrices(mesh), colours = mesh.instanceColor?.array;
      for (let i = 0; i < mesh.count; i++) {
        rows.push([...matrices.subarray(i * 16, i * 16 + 16), ...(colours ? colours.subarray(i * 3, i * 3 + 3) : [])].join(','));
      }
      const name = `${view} ${mesh.name}`;
      if (rows.length) out.set(name, [...(out.get(name) ?? []), ...rows].sort());
    }
  }
  return out;
}

describe('the street furniture kept from the diary', () => {
  it('is, item by item, the furniture made from nothing at every step', () => {
    proveIncremental({ source: new Town(), make: () => furnitureProduct(kit), edits, steps: 80, seed: 0xf0e1 });
  });

  it('lays the long grass item by item as it is laid from nothing', () => {
    proveIncremental({ source: new Town(), make: () => meadowProduct(kit), edits, steps: 60, seed: 0x6a55 });
  });

  it('draws the instances a layer made from nothing draws, as the plants grow', () => {
    const town = new Town();
    const rng = new Rng(0xbe7c);
    for (let i = 0; i < 150; i++) edits[0]!(town, rng);
    const kept = createStreetFurniture(kit);
    let minutes = 0;
    let compared = 0;
    for (let step = 0; step < 80; step++) {
      edits[Math.floor(rng.float() * edits.length)]!(town, rng);
      // The city's clock runs on, some steps past a whole growing.
      minutes += rng.float() < 0.2 ? GROW_MINUTES / 3 : rng.float() * 90;
      kept.sync(town.net, town.elevation, town.groundAt, minutes);
      const fresh = createStreetFurniture(kit);
      fresh.sync(town.net, town.elevation, town.groundAt, minutes);
      const want = drawn(fresh), got = drawn(kept);
      expect([...got.keys()].sort(), `step ${step}: meshes`).toEqual([...want.keys()].sort());
      for (const [name, rows] of want) {
        expect(got.get(name), `step ${step}: ${name}`).toEqual(rows);
        compared += rows.length;
      }
      fresh.dispose();
    }
    expect(compared).toBeGreaterThan(1_000);
    kept.dispose();
  });

  it('is the furniture and the grass made from nothing when items come in batches (one diary entry each)', () => {
    // As the city generator places its furniture (`RoadDoc.addLandscapeMany`): one entry naming its items.
    const batch = (town: Town, rng: Rng): void => {
      const n = 1 + Math.floor(rng.float() * 30);
      town.doc.addLandscapeMany(Array.from({ length: n }, () => {
        const kind = KINDS[Math.floor(rng.float() * KINDS.length)]!;
        const at = { x: rng.float() * span, y: rng.float() * span };
        const snap = snapLandscape(town.net, town.doc.landscape.values(), kind, at, m(30));
        return { kind, at: snap.ok ? snap.at : at };
      }));
      town.settle();
    };
    proveIncremental({ source: new Town(), make: () => furnitureProduct(kit), edits: [...edits, batch, batch], steps: 60, seed: 0xba7c });
    proveIncremental({ source: new Town(), make: () => meadowProduct(kit), edits: [...edits, batch, batch], steps: 40, seed: 0xba7d });
  });

  it('compiles ahead every store as the layer draws it', () => {
    const town = new Town();
    const rng = new Rng(0x3a);
    for (let i = 0; i < 400; i++) edits[0]!(town, rng);
    const layer = createStreetFurniture(kit);
    layer.sync(town.net, town.elevation, town.groundAt, 0);
    // The near cells' meshes and the far batches both (`propCells.ts`).
    seen(layer, over(m(4000)));
    seen(layer, over(m(150)));
    const warmed = layer.warm();
    const warm = new Map(warmed.map((mesh) => [mesh.name, mesh]));
    const drawn = [...layer.meshes, ...(layer.grass.children as InstancedMesh[])];
    expect(drawn.length).toBeGreaterThan(8);
    expect(drawn.some((mesh) => mesh.name.endsWith('-far-cells'))).toBe(true);
    // What three keys a program by: the geometry's attributes (the model's and the poses'), the material, the instancing and its colours, the shadow's depth material.
    for (const mesh of drawn) {
      // A far batch is drawn by a store's own programs: its body's, or its plants' pictures'.
      const ahead = warm.get(mesh.name.replace(/-far-cells$/, ''))
        ?? warmed.find((w) => w.material === mesh.material && w.customDepthMaterial === mesh.customDepthMaterial && !!w.instanceColor === !!mesh.instanceColor);
      expect(ahead, mesh.name).toBeDefined();
      expect(Object.keys(ahead!.geometry.attributes).sort(), mesh.name).toEqual(Object.keys(mesh.geometry.attributes).sort());
      expect(ahead!.geometry.getAttribute('position'), mesh.name).toBe(mesh.geometry.getAttribute('position'));
      expect(posesOf(ahead!).format, mesh.name).toBe(posesOf(mesh).format);
      expect(ahead!.material, mesh.name).toBe(mesh.material);
      expect(ahead!.customDepthMaterial, mesh.name).toBe(mesh.customDepthMaterial);
      expect(!!ahead!.instanceColor, mesh.name).toBe(!!mesh.instanceColor);
      expect([ahead!.castShadow, ahead!.receiveShadow], mesh.name).toEqual([mesh.castShadow, mesh.receiveShadow]);
    }
    layer.dispose();
  });

  it('places again only the items an edit reached', () => {
    const town = new Town();
    const rng = new Rng(3);
    for (let i = 0; i < 300; i++) edits[0]!(town, rng);
    const product = furnitureProduct(kit);
    product.refresh(town);
    const at = [...town.doc.landscape.values()][0]!;
    town.doc.addLandscape('bench', { x: at.x + m(1), y: at.y });
    town.settle();
    product.refresh(town);
    // The bench and its neighbours within the landscaping's rectangle, not the town's 300.
    expect(product.work.last).toBeLessThan(20);
    product.refresh(town);
    expect(product.work.last).toBe(0);
  });
});
