import { readFileSync } from 'node:fs';
import { MeshBasicMaterial, type BufferGeometry, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { Digest } from '@core/digest';
import { layCity } from '@editor/cityGenerator';
import type { SceneMaterials } from '@render/materials';
import { marksRoadSection } from '@render/mesh/roadEdges';
import { SurfaceInputs } from '@render/roadSurfaceInputs';
import { FOOTWAY_EDGE_CELL } from '@render/roadSurfaceReads';
import { buildRoadSurfaces, type SurfaceReuse } from '@render/roadSurfaces';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { RoadDoc } from '@world/doc';
import { buildRoadElevation, type RoadElevation } from '@world/elevation';
import { Network } from '@world/network';
import { m } from '@world/units';

/** THE ROAD SURFACES' INPUTS HELD ROUND THE VIEW READ AS THE WHOLE MAP DERIVED (`roadSurfaceInputs.ts` `InputResidency`): every tile a
 *  build visits reads the same rings, digests and colours, whatever was let go before; an edit makes dirty every tile it made dirty. */

/** Every tile of every pass read off both, the held one woken tile by tile as a build visits them. */
function sameReads(whole: SurfaceInputs, held: SurfaceInputs): number {
  let tiles = 0;
  for (const { id } of whole.passList()) {
    const keys = whole.tileKeys(id);
    const heldKeys = held.tileKeys(id);
    for (const key of keys) expect(heldKeys).toContain(key);
    const known = new Set(keys);
    for (const key of heldKeys) {
      held.wakeTile(key);
      expect(held.hasTile(id, key)).toBe(known.has(key));
      if (!known.has(key)) continue;
      const a = whole.reachOf(id, key), b = held.reachOf(id, key);
      expect(b.digest).toBe(a.digest);
      expect(b.colours).toEqual(a.colours);
      tiles++;
    }
  }
  return tiles;
}

/** A stand-in material that reads every attribute a road surface may carry (`roadTiles.spec.ts`). */
function readingAll(): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ vertexColors: true });
  marksRoadSection(material);
  return material;
}
const materials = new Proxy({}, {
  get: (_target, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : readingAll(),
}) as unknown as SceneMaterials;
const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);

function fingerprint(root: Object3D): number {
  const digest = new Digest();
  root.traverse((object) => {
    const geometry = (object as { geometry?: BufferGeometry }).geometry;
    if (!geometry) return;
    digest.addText(object.name);
    for (const name of ['position', 'normal', 'uv', 'color']) digest.addAll(geometry.getAttribute(name).array);
    digest.addAll(geometry.getIndex()!.array);
  });
  return digest.value();
}

function reuseFor(elevation: () => RoadElevation, inputs: SurfaceInputs, eye?: { x: number; y: number }): SurfaceReuse {
  return {
    tiles: new Map(), passes: new Map(), withinMoved: [],
    dependsOn: (minX, minY, maxX, maxY) => elevation().digest(minX, minY, maxX, maxY),
    paint: new Map(), chunks: new Map(), inputs,
    ...(eye ? { inputsEye: () => eye } : {}),
  };
}

describe('road surfaces built from inputs held round the view', () => {
  it('are the surfaces of the whole map derived: opened in a region, filled, edited', () => {
    const doc = RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document);
    const net = new Network(doc);
    net.rebuild();
    let elevation = buildRoadElevation(net, ground);
    // The eye in the east, a budget of a few cells: the west is derived only while it is visited, and let go after.
    const held = reuseFor(() => elevation, new SurfaceInputs(null, { cpuBudget: 128 * 1024, reach: m(300) }), { x: m(1200), y: m(0) });
    held.within = (rect) => (rect[0] + rect[2]) / 2 >= 0;
    buildRoadSurfaces(net, elevation, materials, ground, held);
    // The fill: the region widened over the whole map.
    held.within = () => true;
    held.withinMoved = [[-m(3000), -m(3000), m(3000), m(3000)]];
    const filled = buildRoadSurfaces(net, elevation, materials, ground, held);
    const whole = buildRoadSurfaces(net, elevation, materials, ground, reuseFor(() => elevation, new SurfaceInputs()));
    expect(filled.triangles).toBe(whole.triangles);
    expect(fingerprint(filled.group)).toBe(fingerprint(whole.group));
    const inputs = held.inputs!;
    expect(inputs.cells!.work.evicted).toBeGreaterThan(0);
    // An edit in the west, far from the eye: its roads derived again where it reached, the result the fresh build's.
    const first = [...doc.nodes.values()].sort((a, b) => a.x - b.x)[3]!;
    const far = doc.addNode({ x: first.x + 40, y: first.y - 260 });
    doc.addSegment(first.id, far.id, 2);
    net.rebuild();
    elevation = buildRoadElevation(net, ground);
    const warm = buildRoadSurfaces(net, elevation, materials, ground, held);
    const fresh = buildRoadSurfaces(net, elevation, materials, ground, reuseFor(() => elevation, new SurfaceInputs()));
    expect(warm.built).toBeGreaterThan(0);
    expect(warm.reused).toBeGreaterThan(warm.built * 2);
    expect(warm.triangles).toBe(fresh.triangles);
    expect(fingerprint(warm.group)).toBe(fingerprint(fresh.group));
  });
});

describe('road surface inputs held round the view', () => {
  it('read every tile as the whole map derived, before and after an edit', () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small', radius: m(500) }));
    const net = new Network(doc);
    net.rebuild();
    const whole = new SurfaceInputs();
    whole.refresh(net);
    // A budget far under the town's: cells are let go while the tiles are visited.
    const held = new SurfaceInputs(null, { cpuBudget: 256 * 1024, reach: m(200) });
    held.refresh(net);
    // Nothing derived before a tile is visited.
    expect(held.residentBytes).toBe(0);
    expect(sameReads(whole, held)).toBeGreaterThan(50);
    expect(held.cells!.work.evicted).toBeGreaterThan(0);
    // The footways' outlines a tile's build reads round it.
    for (const { id } of whole.passList()) {
      for (let x = -m(500); x < m(500); x += FOOTWAY_EDGE_CELL * 7) {
        const key = (Math.floor(x / FOOTWAY_EDGE_CELL) + 32768) * 65536 + (Math.floor(x / (2 * FOOTWAY_EDGE_CELL)) + 32768);
        expect(held.footwayEdges(id, key)).toEqual(whole.footwayEdges(id, key));
      }
    }
    // Back to the view: what is held is what is round the eye.
    held.keepNear({ x: 0, y: 0 });
    const near = held.residentBytes;
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(whole.residentBytes * 0.75);

    // An edit: a road through the town, and one taken away.
    let west = Infinity, y = 0;
    for (const node of doc.nodes.values()) if (node.x < west) { west = node.x; y = node.y; }
    const a = doc.addNode({ x: west - m(60), y });
    const b = doc.addNode({ x: west + m(120), y: y + m(30) });
    doc.addSegment(a.id, b.id, 1);
    const gone = [...doc.segments.keys()].sort((p, q) => p - q)[7]!;
    doc.removeSegment(gone);
    net.rebuild();
    // As a build leaves them: nothing dirty.
    for (const inputs of [whole, held]) {
      for (const { id } of inputs.passList()) { const d = inputs.dirtyOf(id); if (d) inputs.settle(id, d.born, [...d.keys]); }
    }
    whole.refresh(net);
    held.refresh(net);
    let dirty = 0;
    for (const { id } of whole.passList()) {
      const heldDirty = new Set(held.dirtyOf(id)?.keys ?? []);
      for (const key of whole.dirtyOf(id)?.keys ?? []) { expect(heldDirty.has(key)).toBe(true); dirty++; }
    }
    expect(dirty).toBeGreaterThan(0);
    expect(sameReads(whole, held)).toBeGreaterThan(50);
  });
});
