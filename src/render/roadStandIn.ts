import earcut from 'earcut';
import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial } from 'three';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { Level } from '@world/roadTypes';
import { pullTowardEye } from './depthConvention';

/** A ROAD JUST BUILT, DRAWN ON THE PAGE IN THE NEXT FRAME UNTIL THE WORLD'S BUILD OF ITS COMMIT LANDS (`renderer.ts` worldSteps): its casing and its carriageway, and the junctions at its ends, from the network the commit solved
 *  - DO NOT leave a road built invisible until the world's build lands: the coarse in place until the fine comes, as every level does. */

/** THE MEAN LINEAR ALBEDO OF EACH BAKED STREET TEXTURE (`bake/roadRecipes.ts`), every texel as stored (sRGB bytes) and read (linear): constants, worked out once from the recipes. */
export const STREET_MEANS: Readonly<Record<'asphalt' | 'footway' | 'kerb' | 'verge', readonly [number, number, number]>> = {
  asphalt: [0.040666, 0.041456, 0.044698],
  footway: [0.210044, 0.208119, 0.195658],
  kerb: [0.338651, 0.331236, 0.316671],
  verge: [0.029413, 0.070144, 0.010057],
};

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

/** THE ROADS JUST BUILT, BY THE COMMIT THEY CAME WITH, until the world's build of that commit lands. */
export class RoadStandIn {
  readonly group = new Group();
  private readonly casing = standInMaterial(STREET_MEANS.footway, 2);
  private readonly asphalt = standInMaterial(STREET_MEANS.asphalt, 3);
  /** Each commit's stand-in meshes by the network revision it made: let go once a build of that revision landed (`landed`). DO NOT keep only the last commit's: each edit starts the world's build again, and the roads of every commit before it were drawn nowhere until the last build landed (two blocks laid one road a second, jogador-vazio 08-10). */
  private readonly byRevision = new Map<number, Mesh[]>();

  constructor() {
    this.group.name = 'road-stand-ins';
  }

  /** The roads `segments` drawn now (the commit's network solved, of network revision `revision`): their outlines, and the junctions at their ends whose every road is one of them.
   *  - DO NOT draw a road or a junction that was there before (a street the new one meets, split at the new junction): it is drawn already, and the stand-in's flat tone covered it until the build came (via2 37/40). */
  show(net: Network, heights: StandInHeights, segments: Iterable<SegmentId>, revision: number): void {
    const only = new Set(segments);
    const casingParts = { positions: [] as number[], indices: [] as number[] };
    const asphaltParts = { positions: [] as number[], indices: [] as number[] };
    const nodes = new Set<NodeId>();
    for (const id of only) {
      const ribbon = net.ribbons.get(id);
      const segment = net.doc.segment(id);
      if (!ribbon || !segment) continue;
      const height = (x: number, y: number): number => heights.onSegment(id, x, y);
      const casing = ribbon.rings[Level.Casing], asphalt = ribbon.rings[Level.Asphalt];
      if (casing) fill(casing.flatten(), height, casingParts);
      if (asphalt) fill(asphalt.flatten(), height, asphaltParts);
      nodes.add(segment.a);
      nodes.add(segment.b);
    }
    for (const id of nodes) {
      const levels = net.junctions.get(id);
      const node = net.doc.node(id);
      if (!levels || !node || !node.incident.every((s) => only.has(s))) continue;
      const height = (x: number, y: number): number => heights.at(x, y);
      const casing = levels.get(Level.Casing), asphalt = levels.get(Level.Asphalt);
      if (casing) fill(casing.ring.flatten(), height, casingParts);
      if (asphalt) fill(asphalt.ring.flatten(), height, asphaltParts);
    }
    const meshes = [meshOf(casingParts, this.casing, 1), meshOf(asphaltParts, this.asphalt, 2)].filter((m): m is Mesh => m !== null);
    if (!meshes.length) return;
    const kept = this.byRevision.get(revision);
    if (kept) kept.push(...meshes); else this.byRevision.set(revision, meshes);
    for (const mesh of meshes) this.group.add(mesh);
  }

  /** The commits whose stand-ins wait for the world's build (`show`). */
  get revisions(): readonly number[] {
    return [...this.byRevision.keys()];
  }

  /** A build of the world landed, of network revision `revision`: every commit it holds (made at that revision or before) let go, the later ones kept. */
  landed(revision: number): void {
    for (const [key, meshes] of [...this.byRevision]) {
      if (key > revision) continue;
      this.byRevision.delete(key);
      for (const mesh of meshes) { this.group.remove(mesh); mesh.geometry.dispose(); }
    }
  }

  /** Every stand-in let go (another map, the diary read from nothing). */
  clear(): void {
    this.landed(Infinity);
  }

  dispose(): void {
    this.clear();
    this.casing.dispose();
    this.asphalt.dispose();
  }
}
