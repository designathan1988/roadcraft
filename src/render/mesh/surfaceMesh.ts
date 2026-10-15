import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  type Material,
} from 'three';

import type { MultiPoly } from '@core/clipper';
import { type PieceShape, type SkirtRing, type SurfaceShape, type TileRect, surfaceShape } from './tileShape';

export { clipToRect, type TileRect } from './tileShape';

/**
 * Turns a clipped surface band into a solid, watertight mesh.
 *
 * ## The two failures this module exists to prevent
 *
 * **Chords under the ground.** A deck vertex reads the height field only AT
 * ITSELF, and the triangle between two vertices is a straight chord. If that
 * chord is long and the surface it follows is curved, the chord dives beneath
 * the surface: the terrain cuts the road into plates. Densifying only the
 * polygon OUTLINE does not fix it, because ear clipping happily draws a single
 * triangle straight across a 60-unit boulevard. The fix is to refine the
 * TRIANGULATION until no edge is longer than `maxEdge`.
 *
 * **Cracks from a T-junction.** Refining each triangle on its own splits an
 * edge that its neighbour leaves whole, and the two no longer meet: a hairline
 * of background shows through. The refinement below is therefore done with
 * shared, cached edge midpoints and the standard red/green rule — a triangle
 * with one, two or three marked edges is split into two, three or four — so
 * every shared edge is split identically from both sides and no T-junction can
 * ever appear.
 */

export type HeightFn = (x: number, y: number) => number;
/** `u` runs across the surface and `v` along it, both in world units. */
export type UvFn = (x: number, y: number, out: [number, number]) => void;
/**
 * The UV of (x, y), in the frame of whichever road is nearest to (pickX, pickY)
 * rather than to the point itself. See `uvFrame` below.
 */
export type UvFrameFn = (x: number, y: number, pickX: number, pickY: number, out: [number, number]) => void;
/** Writes a linear RGB tint for one vertex. */
export type TintFn = (x: number, y: number, out: [number, number, number]) => void;

export interface SurfaceMeshOptions {
  readonly name: string;
  readonly polygons: MultiPoly;
  /** Height of the visible top face. */
  readonly top: HeightFn;
  /**
   * Height of the bottom face of the skirt drawn down from the boundary.
   *
   * Omitted for a surface that lies flush on the ground. Supplied for anything
   * that stands proud of it — a kerb, a raised deck — so the edge is a solid
   * face instead of an infinitely thin sheet seen edge-on.
   */
  readonly bottom?: HeightFn;
  readonly material: Material;
  /** Longest triangle edge, in world units, before it is refined. */
  readonly maxEdge: number;
  readonly uv: UvFn;
  /**
   * Keeps every triangle inside ONE texture frame.
   *
   * Road UVs are laid in the frame of the nearest road, which is what makes
   * slabs and aggregate run along the street. At a junction corner the nearest
   * road changes between two vertices of the same triangle, and the triangle
   * then interpolates from one road's coordinates to the other's: tens of
   * texture tiles squeezed across a metre, which is the zigzag smear a player
   * saw in every footway corner. A triangle whose UV edges disagree with its
   * real edges by more than a factor of two is detected here and given its own
   * vertices, all framed by the road nearest its centroid - so the worst that
   * can happen is a clean joint where two roads' paving meets, which is what a
   * real corner looks like anyway.
   *
   * `uvWorld` is the world size of one UV unit, needed to compare the two.
   */
  readonly uvFrame?: UvFrameFn;
  readonly uvWorld?: number;
  /**
   * Per-vertex tint, multiplied into the material's colour.
   *
   * This is what lets ONE asphalt mesh carry a residential street's grey and a
   * boulevard's near-black: the alternative is a mesh per class, which means a
   * junction polygon belonging to two classes at once and a draw call for each.
   */
  readonly tint?: TintFn;
  /**
   * Per-vertex place in the road's cross-section, for the material's marks
   * along its edges (the grime of the gutter, the wheel tracks, the footway's
   * edges): three numbers, linear across the road so they interpolate
   * exactly (`roadSurfaces.ts`). Written (0, -1, 0) - none - when absent.
   */
  readonly section?: TintFn;
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
  /** Extra UV scale for the skirt, so its texture is not stretched. */
  readonly skirtUvScale?: number;
}

/** Vertex and index streams of a mesh under construction. */
interface Streams {
  readonly positions: number[];
  readonly normals: number[];
  readonly uvs: number[];
  readonly colors: number[];
  readonly sections: number[];
  readonly indices: number[];
}

const streams = (): Streams => ({ positions: [], normals: [], uvs: [], colors: [], sections: [], indices: [] });

/** One build's options and the scratch its callbacks write into. */
interface Context {
  /** Its polygons are not read here: their shape is (`tileShape.ts`). */
  readonly options: Omit<SurfaceMeshOptions, 'polygons'>;
  readonly uv: [number, number];
  /** White until a tint writes it, so an untinted surface is written white. */
  readonly rgb: [number, number, number];
  /** The cross-section's three numbers (`section`), none until written. */
  readonly cut: [number, number, number];
}

export function buildSurfaceMesh(options: SurfaceMeshOptions): Mesh | null {
  const context: Context = { options, uv: [0, 0], rgb: [1, 1, 1], cut: [0, -1, 0] };

  // Compact pieces first (`tileShape.ts` `splitToSpan`), then ear clipping inside each.
  const out = streams();
  const shape = surfaceShape(options.polygons, options.maxEdge, options.bottom !== undefined);
  for (const piece of shape.pieces) meshPiece(piece, context, out);
  if (shape.skirts) meshSkirts(shape.skirts, context, out);

  const { positions, normals, uvs, colors, sections, indices } = out;
  if (indices.length === 0) return null;
  // Only the top face was given a placeholder normal; recomputing just those
  // vertices keeps the skirt's hard edges while the surface itself is smooth.
  smoothTopNormals(positions, normals, indices);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  // Always present, white when no tint was asked for: a material that declares
  // `vertexColors` requires the attribute, and it is cheaper to write three
  // ones than to keep two variants of every road material.
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('roadSection', new Float32BufferAttribute(sections, 3));
  geometry.setIndex(indices);
  return finish(geometry, options);
}

export function finish(geometry: BufferGeometry,
  options: Pick<SurfaceMeshOptions, 'name' | 'material' | 'castShadow' | 'receiveShadow'>): Mesh {
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  const mesh = new Mesh(geometry, options.material);
  mesh.name = options.name;
  mesh.castShadow = options.castShadow ?? false;
  mesh.receiveShadow = options.receiveShadow ?? true;
  return mesh;
}

/**
 * The top face of one compact piece (`tileShape.ts` `pieceShape`): one read of
 * the height, texture frame and tint per vertex.
 */
function meshPiece(piece: PieceShape, context: Context, out: Streams): void {
  const { options, uv: scratch, rgb, cut } = context;
  const { top, uv, tint, section } = options;
  const { positions, normals, uvs, colors, sections, indices } = out;
  const { xy, tris, flip } = piece;
  const base = positions.length / 3;
  for (let i = 0; i < xy.length / 2; i++) {
    const x = xy[i * 2] as number;
    const y = xy[i * 2 + 1] as number;
    positions.push(x, top(x, y), -y);
    uv(x, y, scratch);
    uvs.push(scratch[0], scratch[1]);
    normals.push(0, 1, 0);
    if (tint) tint(x, y, rgb);
    colors.push(rgb[0], rgb[1], rgb[2]);
    if (section) section(x, y, cut);
    sections.push(cut[0], cut[1], cut[2]);
  }
  // World Y is mirrored into three's Z. That reflection flips handedness, so
  // a ring that is counter-clockwise on the map comes out clockwise in the
  // scene: taken in order, the triangle's normal points UP, which is what a
  // top face needs. A clockwise ring is emitted the other way round.
  for (let i = 0; i < tris.length; i += 3) {
    let a = base + (tris[i] as number);
    let b = base + (tris[i + 1] as number);
    let c = base + (tris[i + 2] as number);
    if (options.uvFrame && options.uvWorld && !uvConsistent(positions, uvs, a, b, c, options.uvWorld)) {
      const cx = (positions[a * 3]! + positions[b * 3]! + positions[c * 3]!) / 3;
      const cy = -(positions[a * 3 + 2]! + positions[b * 3 + 2]! + positions[c * 3 + 2]!) / 3;
      const fresh: number[] = [];
      for (const v of [a, b, c]) {
        const x = positions[v * 3]!;
        const y = -positions[v * 3 + 2]!;
        positions.push(x, positions[v * 3 + 1]!, -y);
        options.uvFrame(x, y, cx, cy, scratch);
        uvs.push(scratch[0], scratch[1]);
        normals.push(0, 1, 0);
        colors.push(colors[v * 3]!, colors[v * 3 + 1]!, colors[v * 3 + 2]!);
        sections.push(sections[v * 3]!, sections[v * 3 + 1]!, sections[v * 3 + 2]!);
        fresh.push(positions.length / 3 - 1);
      }
      [a, b, c] = fresh as [number, number, number];
    }
    if (flip) indices.push(a, c, b);
    else indices.push(a, b, c);
  }
}

/**
 * The walls hung from a surface's outline down to `bottom`, along the edges of
 * its shape (`tileShape.ts` `skirtShape`).
 */
function meshSkirts(skirts: readonly SkirtRing[], context: Context, out: Streams): void {
  const { options, rgb } = context;
  const { top, tint } = options;
  const bottom = options.bottom;
  if (!bottom) return;
  const { positions, normals, uvs, colors, sections, indices } = out;
  const scale = options.skirtUvScale ?? 1;
  for (const { flip, edges } of skirts) {
    let run = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const ax = edges[e] as number;
      const ay = edges[e + 1] as number;
      const bx = edges[e + 2] as number;
      const by = edges[e + 3] as number;
      const span = Math.hypot(bx - ax, by - ay);
      const sign = flip ? -1 : 1;
      const nx = (sign * (by - ay)) / span;
      const nz = (sign * (bx - ax)) / span;
      const topA = top(ax, ay);
      const topB = top(bx, by);
      const lowA = bottom(ax, ay);
      const lowB = bottom(bx, by);
      const side = positions.length / 3;
      positions.push(ax, topA, -ay, bx, topB, -by, bx, lowB, -by, ax, lowA, -ay);
      if (tint) tint((ax + bx) / 2, (ay + by) / 2, rgb);
      for (let n = 0; n < 4; n++) colors.push(rgb[0], rgb[1], rgb[2]);
      // A skirt has no place in the section: none.
      for (let n = 0; n < 4; n++) sections.push(0, -1, 0);
      // Written rather than averaged, so a kerb keeps its hard edge instead
      // of smearing into the surface above it.
      for (let n = 0; n < 4; n++) normals.push(nx, 0, nz);
      const u0 = run / scale;
      const u1 = (run + span) / scale;
      uvs.push(u0, topA / scale, u1, topB / scale, u1, lowB / scale, u0, lowA / scale);
      run += span;
      // Wound so the face looks the same way as the normal written above.
      if (flip) indices.push(side, side + 1, side + 2, side, side + 2, side + 3);
      else indices.push(side, side + 2, side + 1, side, side + 3, side + 2);
    }
  }
}

// ------------------------------------------------------------------ tiles

/**
 * One tile's worth of a surface: its top faces and the skirts along its part
 * of the outline, ready to be copied into the surface's mesh (`mergeTiles`).
 */
export interface Tile {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly colors: Float32Array;
  readonly sections: Float32Array;
  /** Local to the tile. */
  readonly indices: Uint32Array;
}

/**
 * Builds one tile of a surface: the top faces of `options.polygons` (already
 * cut to `rect`), and the skirts along every edge of their outline except the
 * edges the cut itself made, which are interior to the whole surface.
 */
export function meshTile(options: SurfaceMeshOptions, rect: TileRect): Tile {
  return meshTileShape(surfaceShape(options.polygons, options.maxEdge, options.bottom !== undefined, rect), options);
}

/**
 * One tile of a surface from its shape (`tileShape.ts`, made here or by a worker, `roadTile.worker.ts`):
 * each vertex's height, frame, tint and place in the section read here, as `meshTile` does.
 */
export function meshTileShape(shape: SurfaceShape, options: Omit<SurfaceMeshOptions, 'polygons'>): Tile {
  const context: Context = { options, uv: [0, 0], rgb: [1, 1, 1], cut: [0, -1, 0] };
  const out = streams();
  for (const piece of shape.pieces) meshPiece(piece, context, out);
  // No vertex is shared with another tile, so the smoothing is the one the
  // whole mesh would get.
  smoothTopNormals(out.positions, out.normals, out.indices);
  if (shape.skirts) meshSkirts(shape.skirts, context, out);
  return {
    positions: new Float32Array(out.positions),
    normals: new Float32Array(out.normals),
    uvs: new Float32Array(out.uvs),
    colors: new Float32Array(out.colors),
    sections: new Float32Array(out.sections),
    indices: new Uint32Array(out.indices),
  };
}

/**
 * Whether a triangle's UV edges have the lengths its world edges say they
 * should. A road frame is (almost) an isometry, so a ratio far from one means
 * the three vertices were framed by different roads.
 */
function uvConsistent(
  positions: readonly number[],
  uvs: readonly number[],
  a: number,
  b: number,
  c: number,
  uvWorld: number,
): boolean {
  const edge = (p: number, q: number): boolean => {
    const world = Math.hypot(positions[p * 3]! - positions[q * 3]!, positions[p * 3 + 2]! - positions[q * 3 + 2]!);
    if (world < 1e-3) return true;
    const texture = Math.hypot(uvs[p * 2]! - uvs[q * 2]!, uvs[p * 2 + 1]! - uvs[q * 2 + 1]!) * uvWorld;
    const ratio = texture / world;
    return ratio > 0.5 && ratio < 2;
  };
  return edge(a, b) && edge(b, c) && edge(c, a);
}

/**
 * Recomputes normals for the up-facing vertices only, in place.
 *
 * `computeVertexNormals` would average a kerb's vertical face into the footway
 * above it and round off every edge in the scene. The skirt already carries an
 * exact normal, so only the vertices that were flagged as flat-up are solved
 * here, and they are solved by area-weighted accumulation like any smooth
 * surface.
 */
function smoothTopNormals(
  positions: readonly number[],
  normals: number[],
  indices: readonly number[],
): void {
  const flat = new Set<number>();
  for (let i = 0; i < normals.length; i += 3) {
    if (normals[i] === 0 && normals[i + 1] === 1 && normals[i + 2] === 0) flat.add(i / 3);
  }
  if (flat.size === 0) return;
  const acc = new Float64Array(normals.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] as number;
    const b = indices[t + 1] as number;
    const c = indices[t + 2] as number;
    if (!flat.has(a) || !flat.has(b) || !flat.has(c)) continue;
    const ax = positions[a * 3] as number;
    const ay = positions[a * 3 + 1] as number;
    const az = positions[a * 3 + 2] as number;
    const ux = (positions[b * 3] as number) - ax;
    const uy = (positions[b * 3 + 1] as number) - ay;
    const uz = (positions[b * 3 + 2] as number) - az;
    const vx = (positions[c * 3] as number) - ax;
    const vy = (positions[c * 3 + 1] as number) - ay;
    const vz = (positions[c * 3 + 2] as number) - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const index of [a, b, c]) {
      acc[index * 3] = (acc[index * 3] as number) + nx;
      acc[index * 3 + 1] = (acc[index * 3 + 1] as number) + ny;
      acc[index * 3 + 2] = (acc[index * 3 + 2] as number) + nz;
    }
  }
  for (const index of flat) {
    const x = acc[index * 3] as number;
    const y = acc[index * 3 + 1] as number;
    const z = acc[index * 3 + 2] as number;
    const length = Math.hypot(x, y, z);
    if (length < 1e-9) continue;
    normals[index * 3] = x / length;
    normals[index * 3 + 1] = y / length;
    normals[index * 3 + 2] = z / length;
  }
}

export function disposeMesh(mesh: Mesh): void {
  mesh.geometry.dispose();
}
