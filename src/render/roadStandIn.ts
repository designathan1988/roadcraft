import earcut from 'earcut';
import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial } from 'three';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { Level } from '@world/roadTypes';
import { tileKeyAt } from '@world/tiles';
import { pullTowardEye } from './depthConvention';
import { STREET_MEANS } from './farRoadTiles';

/** A ROAD JUST BUILT, DRAWN ON THE PAGE IN THE NEXT FRAME UNTIL ITS TILE'S NEAR ROADS COME BACK FROM THEIR WORKER (`farRoads.ts`): its casing and its carriageway, and the junctions at its ends, from the network the commit solved; let go tile by tile as each tile's bake is drawn
 *  - DO NOT leave a road built invisible until the worker answers: the edited tile's bake is ~0.6 s on a worker for a dense tile, after a worker is free and before its upload (over 2 s, the player's measure); the coarse in place until the fine comes, as every level does. */

/** What the stand-in reads of the roads' heights (`RoadElevation`). */
export interface StandInHeights {
  onSegment(segment: SegmentId, x: number, y: number): number;
  at(x: number, y: number): number;
}

/** One material each, made once: the mean of the street's texture (`STREET_MEANS`, linear, as the far level paints it; a light slab stood out over the asphalt), a plain standard material (its program the same as every untextured one), pulled over the ground it lies on. */
function standInMaterial(mean: readonly [number, number, number], steps: number): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: new Color().setRGB(mean[0], mean[1], mean[2]), roughness: 0.9, metalness: 0 });
  material.name = 'road-stand-in';
  pullTowardEye(material, 1, steps);
  return material;
}

/** A closed outline (x, y pairs) triangulated and laid at `height`: positions, normals up, indices appended. */
function fill(ring: readonly { readonly x: number; readonly y: number }[], height: (x: number, y: number) => number,
  out: { positions: number[]; indices: number[] }): void {
  if (ring.length < 3) return;
  const flat: number[] = [];
  for (const p of ring) flat.push(p.x, p.y);
  const tris = earcut(flat);
  const base = out.positions.length / 3;
  for (const p of ring) out.positions.push(p.x, height(p.x, p.y), -p.y);
  for (const t of tris) out.indices.push(base + t);
}

/** A mesh of the outlines laid, or null for none. */
function meshOf(parts: { positions: number[]; indices: number[] }, material: MeshStandardMaterial, order: number): Mesh | null {
  if (parts.indices.length === 0) return null;
  const g = new BufferGeometry();
  const positions = new Float32Array(parts.positions);
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setAttribute('normal', new BufferAttribute(normals, 3));
  g.setIndex(new BufferAttribute(positions.length / 3 > 0xffff ? new Uint32Array(parts.indices) : new Uint16Array(parts.indices), 1));
  g.computeBoundingSphere();
  const mesh = new Mesh(g, material);
  mesh.name = 'road-stand-in';
  mesh.renderOrder = order;
  mesh.receiveShadow = true;
  return mesh;
}

/** THE ROADS JUST BUILT, BY THE TILE THEIR MIDDLE IS IN, until each tile's near roads are drawn. */
export class RoadStandIn {
  readonly group = new Group();
  private readonly casing = standInMaterial(STREET_MEANS.footway, 2);
  private readonly asphalt = standInMaterial(STREET_MEANS.asphalt, 3);
  /** Each tile's stand-in meshes. */
  private readonly byTile = new Map<number, Mesh[]>();
  /** The tiles given a stand-in this frame: not looked at for letting go before the near roads were asked of the edit (`settle`). */
  private readonly fresh = new Set<number>();

  constructor() {
    this.group.name = 'road-stand-ins';
  }

  /** The tiles with a road standing in. */
  get tiles(): readonly number[] {
    return [...this.byTile.keys()];
  }

  /** The tiles with a road standing in since an earlier frame: those `done` may let go (`renderer.ts`, after the near roads were chosen). */
  settled(): number[] {
    return [...this.byTile.keys()].filter((tile) => !this.fresh.has(tile));
  }

  /** The frame's stand-ins looked at from the next frame on. */
  settle(): void {
    this.fresh.clear();
  }

  /** The roads `segments` drawn now (the commit's network solved): their outlines, and the junctions at their ends whose every road is one of them, each under the tile its middle is in.
   *  - DO NOT draw a road or a junction that was there before (a street the new one meets, split at the new junction): its near roads are drawn, and the stand-in's flat tone covered them until the bake came (via2 37/40). */
  show(net: Network, heights: StandInHeights, segments: Iterable<SegmentId>): void {
    const only = new Set(segments);
    const byTile = new Map<number, { casing: { positions: number[]; indices: number[] }; asphalt: { positions: number[]; indices: number[] } }>();
    const partsOf = (tile: number) => {
      let parts = byTile.get(tile);
      if (!parts) byTile.set(tile, parts = { casing: { positions: [], indices: [] }, asphalt: { positions: [], indices: [] } });
      return parts;
    };
    const nodes = new Set<NodeId>();
    for (const id of only) {
      const ribbon = net.ribbons.get(id);
      const segment = net.doc.segment(id);
      if (!ribbon || !segment) continue;
      const mid = ribbon.full.sampleAt(ribbon.full.length / 2).p;
      const parts = partsOf(tileKeyAt(mid.x, mid.y));
      const height = (x: number, y: number): number => heights.onSegment(id, x, y);
      const casing = ribbon.rings[Level.Casing], asphalt = ribbon.rings[Level.Asphalt];
      if (casing) fill(casing.flatten(), height, parts.casing);
      if (asphalt) fill(asphalt.flatten(), height, parts.asphalt);
      nodes.add(segment.a);
      nodes.add(segment.b);
    }
    for (const id of nodes) {
      const levels = net.junctions.get(id);
      const node = net.doc.node(id);
      if (!levels || !node || !node.incident.every((s) => only.has(s))) continue;
      const parts = partsOf(tileKeyAt(node.x, node.y));
      const height = (x: number, y: number): number => heights.at(x, y);
      const casing = levels.get(Level.Casing), asphalt = levels.get(Level.Asphalt);
      if (casing) fill(casing.ring.flatten(), height, parts.casing);
      if (asphalt) fill(asphalt.ring.flatten(), height, parts.asphalt);
    }
    for (const [tile, parts] of byTile) {
      const meshes = [meshOf(parts.casing, this.casing, 1), meshOf(parts.asphalt, this.asphalt, 2)].filter((m): m is Mesh => m !== null);
      if (!meshes.length) continue;
      const kept = this.byTile.get(tile);
      if (kept) kept.push(...meshes); else this.byTile.set(tile, meshes);
      this.fresh.add(tile);
      for (const mesh of meshes) this.group.add(mesh);
    }
  }

  /** A tile's near roads drawn (its bake of the edit come): what stood in there let go. */
  drop(tile: number): void {
    const meshes = this.byTile.get(tile);
    if (!meshes) return;
    this.byTile.delete(tile);
    this.fresh.delete(tile);
    for (const mesh of meshes) { this.group.remove(mesh); mesh.geometry.dispose(); }
  }

  /** Every stand-in let go (another map, the diary read from nothing). */
  clear(): void {
    for (const tile of [...this.byTile.keys()]) this.drop(tile);
  }

  dispose(): void {
    this.clear();
    this.casing.dispose();
    this.asphalt.dispose();
  }
}
