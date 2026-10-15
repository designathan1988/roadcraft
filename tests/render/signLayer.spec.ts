import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Mesh, MeshStandardMaterial } from 'three';

import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation, type RoadElevation } from '@world/elevation';
import { SIGN_TYPES, snapLandscape } from '@world/landscape';
import type { ChangeRect } from '@world/changes';
import type { NodeId, SegmentId } from '@world/ids';
import { m } from '@world/units';
import { createSignLayer, signProduct } from '@render/signLayer';
import { proveIncremental } from '../support/derivedEquivalence';

/**
 * THE SIGNS ON THE SPINE (`signLayer.ts`): the signs kept from the diary are,
 * at every step of random edits - roads drawn and demolished, signs and
 * street names placed one by one and in batches, items taken away, the paint
 * standard changed -, the signs made from nothing; a landscaping entry stands
 * no junction again (its plates do not read the landscaping); and the plate
 * compiled ahead is drawn with the program a sheet's plates are.
 */

const span = m(400);

class Town {
  readonly doc = new RoadDoc();
  readonly net = new Network(this.doc);
  elevation: RoadElevation;
  private seen = 0;
  constructor() {
    const rng = new Rng(7);
    // The regional standard: speed plates past the junctions besides the rules' plates.
    this.doc.setMarkingStyle('br');
    for (let i = 0; i < 24; i++) this.road(rng);
    this.net.rebuild();
    this.elevation = buildRoadElevation(this.net, () => 0);
    this.seen = this.doc.changes.version;
  }
  get changes() { return this.doc.changes; }
  /** A road from a node of the town (a junction) or from anywhere. */
  road(rng: Rng): void {
    const nodes = [...this.doc.nodes.values()];
    const a = nodes.length && rng.float() < 0.8 ? nodes[Math.floor(rng.float() * nodes.length)]!
      : this.doc.addNode({ x: rng.float() * span, y: rng.float() * span });
    const b = this.doc.addNode({ x: a.x + (rng.float() - 0.5) * m(160), y: a.y + (rng.float() - 0.5) * m(160) });
    this.doc.addSegment(a.id as NodeId, b.id, 1 + Math.floor(rng.float() * 3));
  }
  /** After an edit: the network rebuilt and the roads' heights solved, written as the renderer writes them. */
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
  /** A point on a footway near a random point, or the point. */
  spot(rng: Rng): { x: number; y: number } {
    const at = { x: rng.float() * span, y: rng.float() * span };
    const snap = snapLandscape(this.net, this.doc.landscape.values(), 'sign', at, m(40));
    return snap.ok ? snap.at : at;
  }
}

const sign = (town: Town, rng: Rng): { kind: 'sign' | 'streetname'; at: { x: number; y: number }; extra: { signType?: (typeof SIGN_TYPES)[number]; text: string } } =>
  rng.float() < 0.5
    ? { kind: 'sign', at: town.spot(rng), extra: { signType: SIGN_TYPES[Math.floor(rng.float() * SIGN_TYPES.length)]!, text: `${Math.floor(rng.float() * 80)}` } }
    : { kind: 'streetname', at: town.spot(rng), extra: { text: `Rua ${Math.floor(rng.float() * 1000)}` } };

const edits = [
  (town: Town, rng: Rng) => { const s = sign(town, rng); town.doc.addLandscape(s.kind, s.at, s.extra); town.settle(); },
  // A batch, as the city generator places its furniture and names: one entry.
  (town: Town, rng: Rng) => {
    const n = 1 + Math.floor(rng.float() * 12);
    town.doc.addLandscapeMany(Array.from({ length: n }, () => rng.float() < 0.5 ? sign(town, rng) : { kind: 'bench' as const, at: town.spot(rng) }));
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
    if (ids.length > 3) town.doc.removeSegment(ids[Math.floor(rng.float() * ids.length)]! as SegmentId);
    town.settle();
  },
  (town: Town, rng: Rng) => { town.doc.setMarkingStyle(rng.float() < 0.5 ? 'br' : 'classic'); town.settle(); },
];

describe('the signs kept from the diary', () => {
  it('are, key by key, the signs made from nothing at every step', () => {
    proveIncremental({ source: new Town(), make: signProduct, edits, steps: 120, seed: 0x5167 });
  });

  it('stand no junction again for a landscaping entry: only the signs and names it placed', () => {
    const town = new Town();
    const rng = new Rng(0x51);
    for (let i = 0; i < 20; i++) edits[3]!(town, rng);
    const product = signProduct();
    product.refresh(town);
    let junctions = 0;
    for (const [key] of product.entries()) if (key % 2 === 0) junctions++;
    expect(junctions).toBeGreaterThan(3);
    // Benches everywhere: nothing of the signs to stand.
    town.doc.addLandscapeMany(Array.from({ length: 40 }, () => ({ kind: 'bench' as const, at: town.spot(rng) })));
    town.settle();
    product.refresh(town);
    expect(product.work.last).toBe(0);
    // Three names: those three, and no junction.
    town.doc.addLandscapeMany([0, 1, 2].map((i) => ({ kind: 'streetname' as const, at: town.spot(rng), extra: { text: `Rua ${i}` } })));
    town.settle();
    product.refresh(town);
    expect(product.work.last).toBe(3);
  });
});

/** A canvas without a page: the sizes it is given, and a 2D context that draws nothing. */
function fakeCanvas(): { width: number; height: number; getContext: () => unknown } {
  const context: unknown = new Proxy({}, {
    get: (_target, key) => key === 'measureText' ? () => ({ width: 0 }) : () => {},
    set: () => true,
  });
  return { width: 0, height: 0, getContext: () => context };
}

describe('the signs compiled ahead', () => {
  beforeAll(() => { vi.stubGlobal('document', { createElement: () => fakeCanvas() }); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('a post and a plate drawn with the programs of the posts and plates the layer stands', () => {
    const town = new Town();
    const rng = new Rng(0x9a);
    for (let i = 0; i < 20; i++) edits[0]!(town, rng);
    const layer = createSignLayer();
    layer.sync(town.net, town.elevation);
    const drawn = new Map<string, Mesh>();
    layer.group.traverse((o) => { if ((o as Mesh).isMesh) drawn.set(o.name, o as Mesh); });
    const warm = layer.warm();
    expect(new Set(warm.map((w) => w.name))).toEqual(new Set(drawn.keys()));
    // What three keys a program by (`WebGLPrograms.getParameters`): the material's kind and parameters,
    // a map or none, the alpha test, the side, the instancing and its colours, the shadow cast.
    const key = (mesh: Mesh): string => {
      const mat = mesh.material as MeshStandardMaterial;
      const instanced = mesh as Mesh & { isInstancedMesh?: boolean; instanceColor?: unknown };
      return JSON.stringify([mat.type, !!mat.map, mat.alphaTest > 0, mat.side, mat.vertexColors, mat.transparent, mat.roughness, mat.metalness,
        !!instanced.isInstancedMesh, !!instanced.instanceColor, mesh.castShadow, Object.keys(mesh.geometry.attributes).sort()]);
    };
    for (const mesh of warm) expect(key(mesh), mesh.name).toBe(key(drawn.get(mesh.name)!));
    layer.dispose();
  });
});
