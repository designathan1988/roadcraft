import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial } from 'three';
import type { SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { Level, ROAD_TYPES } from '@world/roadTypes';
import { jobPort } from '../jobs/jobPool';
import { pullTowardEye } from './depthConvention';
import { buildFarRoadCells, type FarRoadCell, type FarRoadInput } from './networkFarRoadsBuild';
import { STREET_MEANS } from './roadStandIn';
import { ASPHALT_REFERENCE, FOOTWAY_TINT } from './roadTones';

/**
 * EVERY ROAD OF A LARGE CITY AT ITS FAR LEVEL FROM THE FIRST FRAME OF ITS OPENING (`renderer.ts` openingBuild): a large city's opening
 * builds the detailed surfaces of the roads round its view only, the rest filled block by block after the curtain (tens of seconds in
 * which the map showed no street past the opening's view: step-25k 08-map, 2026-10-21). This level is made from the network itself:
 * each road's and junction's real outline (`Network.ribbons`, `Network.junctions`: the carriageway, and the casing its footways and
 * kerbs fill) at its class's colour over the street textures' means (as the blocks' far level paints them), at the solved heights where
 * the opening's solve took the road and on the ground elsewhere, merged a cell at a time in a job worker: O(the outlines' vertices).
 * The area the opening built in detail is cut out of it; it goes whole once the fill's blocks are in (`clear`).
 */

/** What the outlines' heights are read from: the opening's solve (`RoadElevation`), the roads it left for later, the ground. */
export interface FarRoadHeights {
  onSegment(segment: SegmentId, x: number, y: number): number;
  at(x: number, y: number): number;
  pendingRoads?(): SegmentId[];
}

/** The class's tint over the reference the asphalt texture is authored against (`roadSurfaces.ts` CLASS_TINTS), times the texture's mean. */
const ASPHALT_REFERENCE_COLOUR = new Color(ASPHALT_REFERENCE);
const ASPHALT_BY_CLASS: readonly (readonly [number, number, number])[] = ROAD_TYPES.map((type) => {
  const c = new Color(type.color);
  return [STREET_MEANS.asphalt[0] * (c.r / ASPHALT_REFERENCE_COLOUR.r), STREET_MEANS.asphalt[1] * (c.g / ASPHALT_REFERENCE_COLOUR.g), STREET_MEANS.asphalt[2] * (c.b / ASPHALT_REFERENCE_COLOUR.b)];
});
const CASING: readonly [number, number, number] = [STREET_MEANS.footway[0] * FOOTWAY_TINT.pavers[0], STREET_MEANS.footway[1] * FOOTWAY_TINT.pavers[1], STREET_MEANS.footway[2] * FOOTWAY_TINT.pavers[2]];

/** One material a layer: the colours the vertices', pulled over the ground it lies on (the casing under the carriageway, as `roadStandIn.ts` draws them). */
function layerMaterial(steps: number): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0 });
  material.name = 'road-far-network';
  pullTowardEye(material, 1, steps);
  return material;
}

/** @rebuild The outlines of the network, their heights read on the page (`heights`, `groundAt` for the roads the solve left): what the worker fills. Once a scoped opening, the whole map by design: no other level stands for the roads its view left. */
export function farRoadInput(net: Network, heights: FarRoadHeights, groundAt: (x: number, y: number) => number, cell: number, origin: number,
  exclude: readonly [number, number, number, number] | null): { input: FarRoadInput; transfer: ArrayBuffer[] } {
  const points: number[] = [], counts: number[] = [], layers: number[] = [], colors: number[] = [];
  const pending = new Set(heights.pendingRoads?.() ?? []);
  const add = (ring: readonly { readonly x: number; readonly y: number }[], layer: number, colour: readonly [number, number, number], height: (x: number, y: number) => number): void => {
    if (ring.length < 3) return;
    for (const p of ring) points.push(p.x, p.y, height(p.x, p.y));
    counts.push(ring.length);
    layers.push(layer);
    colors.push(colour[0], colour[1], colour[2]);
  };
  const roadAt = (x: number, y: number): number => { const h = heights.at(x, y); return Number.isFinite(h) ? h : groundAt(x, y); };
  for (const [id, ribbon] of net.ribbons) {
    const height = pending.has(id) ? groundAt : (x: number, y: number): number => heights.onSegment(id, x, y);
    const casing = ribbon.rings[Level.Casing], asphalt = ribbon.rings[Level.Asphalt];
    if (casing) add(casing.flatten(), 0, CASING, height);
    if (asphalt) add(asphalt.flatten(), 1, ASPHALT_BY_CLASS[ribbon.typeIndex] ?? STREET_MEANS.asphalt, height);
  }
  for (const [id, levels] of net.junctions) {
    const node = net.doc.node(id);
    if (!node) continue;
    // A junction every road of which the solve left: on the ground, as they are.
    const height = node.incident.length > 0 && node.incident.every((s) => pending.has(s)) ? groundAt : roadAt;
    const casing = levels.get(Level.Casing), asphalt = levels.get(Level.Asphalt);
    if (casing) add(casing.ring.flatten(), 0, CASING, height);
    if (asphalt) {
      const types = node.incident.map((s) => net.ribbons.get(s)?.typeIndex ?? -1).filter((t) => t >= 0);
      add(asphalt.ring.flatten(), 1, ASPHALT_BY_CLASS[types.length ? Math.max(...types) : 0] ?? STREET_MEANS.asphalt, height);
    }
  }
  const input: FarRoadInput = { cell, origin, exclude, points: new Float64Array(points), counts: new Uint32Array(counts), layers: new Uint8Array(layers), colors: new Float32Array(colors) };
  return { input, transfer: [input.points.buffer as ArrayBuffer, input.counts.buffer as ArrayBuffer, input.layers.buffer as ArrayBuffer, input.colors.buffer as ArrayBuffer] };
}

/** The whole network's far roads (see the file's comment). */
export class NetworkFarRoads {
  readonly group = new Group();
  private readonly materials = [layerMaterial(2), layerMaterial(3)] as const;
  private worker: Worker | null = null;
  private asked = 0;
  /** A request not answered yet: the opening waits for it (`pending`). */
  private waiting = false;
  private triangleCount = 0;
  /** Each cell's triangles, by its key (`x,y` on the cells' grid): what the probes count. */
  readonly cells = new Map<string, number>();

  constructor() {
    this.group.name = 'road-far-network';
  }

  /** Whether the level asked is still being made. */
  get pending(): boolean {
    return this.waiting;
  }

  get triangles(): number {
    return this.triangleCount;
  }

  /** The level made for the network as it stands (replacing any), the area `exclude` left to the detailed surfaces. */
  request(net: Network, heights: FarRoadHeights, groundAt: (x: number, y: number) => number, cell: number, origin: number, exclude: readonly [number, number, number, number] | null): void {
    const id = ++this.asked;
    this.waiting = true;
    const { input, transfer } = farRoadInput(net, heights, groundAt, cell, origin, exclude);
    const landed = (cells: readonly FarRoadCell[]): void => { if (id === this.asked) { this.show(cells); this.waiting = false; } };
    const failed = (why: unknown): void => {
      console.warn('[roads] the far roads could not be made off the page; made here', why);
      this.worker = null;
      if (id === this.asked) landed(buildFarRoadCells(input));
    };
    // Where no worker can be made (Node: the specs that open a city), made here.
    if (typeof Worker === 'undefined') { landed(buildFarRoadCells(input)); return; }
    try {
      const worker = this.worker ??= jobPort('roadFar');
      worker.onmessage = (event: MessageEvent<{ id: number; cells?: FarRoadCell[]; error?: string }>) => {
        if (event.data.id !== id) return;
        if (event.data.cells) landed(event.data.cells); else failed(event.data.error);
      };
      worker.onerror = (event) => failed(event.message);
      worker.postMessage({ id, input }, transfer);
    } catch (error) {
      failed(error);
    }
  }

  private show(cells: readonly FarRoadCell[]): void {
    this.clearMeshes();
    for (const c of cells) {
      const g = new BufferGeometry();
      const normals = new Float32Array(c.positions.length);
      for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
      g.setAttribute('position', new BufferAttribute(c.positions, 3));
      g.setAttribute('normal', new BufferAttribute(normals, 3));
      g.setAttribute('color', new BufferAttribute(c.colors, 3));
      g.setIndex(new BufferAttribute(c.positions.length / 3 > 0xffff ? c.indices : new Uint16Array(c.indices), 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const mesh = new Mesh(g, this.materials[c.layer === 0 ? 0 : 1]);
      mesh.name = 'road-far-network';
      mesh.renderOrder = c.layer === 0 ? 1 : 2;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      const n = c.indices.length / 3;
      this.triangleCount += n;
      this.cells.set(c.key, (this.cells.get(c.key) ?? 0) + n);
    }
  }

  private clearMeshes(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      (child as Mesh).geometry.dispose();
    }
    this.cells.clear();
    this.triangleCount = 0;
  }

  /** The level let go: the detailed blocks stand everywhere (the fill landed), or another map opened. */
  clear(): void {
    this.asked++;
    this.waiting = false;
    this.clearMeshes();
  }

  dispose(): void {
    this.clear();
    this.worker?.terminate();
    this.worker = null;
    for (const material of this.materials) material.dispose();
  }
}
