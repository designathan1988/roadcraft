import {
  Box3,
  BufferAttribute,
  DynamicDrawUsage,
  Frustum,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Vector3,
  Vector4,
  WebGLCoordinateSystem,
  type OrthographicCamera,
  type PerspectiveCamera,
} from 'three';
import { LOD_LEVELS, LOD_NODE, LOD_PATCH, type LandLevels } from './terrainLevels';
import { m } from '@world/units';

/** A TERRAIN PLATE DRAWN BY ITS DISTANCE: CDLOD (Strugar, "Continuous Distance-Dependent Level of Detail for Rendering Heightmaps", JGT 2010) */

/** How far short of its reach a level's morph ends, and how far past the last reach the next one starts: the GPU's float distances against the page's. */
const LOD_MARGIN = m(1);
/** How far a plate's rim hangs down where it meets another plate, drawn at its own level (the far patches' skirt, `flatAtlas.ts`). */
const LOD_SKIRT = m(30);
/** The screen error a level may make, pixels (Strugar's LOD ranges; Ulrich's chunked LOD screen-space error). */
const LOD_PIXELS = 1;

/** A plate's grid as the levels read it: cells a side, their size and the plate's half side (`terrain.ts`). */
export interface LandGrid {
  readonly seg: number;
  readonly cell: number;
  readonly half: number;
}

/** The patch's cells, four corners each (cell x, cell y, role 0-3), and their two triangles over roles (0, 1, 2) and (0, 2, 3): the shader turns
 *  the roles round the cell by one where the cell splits along its other diagonal (`landVertex`), so the triangles are the ones six corners a cell
 *  drew, from four ([meshoptimizer: vertex reuse](https://github.com/zeux/meshoptimizer); CDLOD's indexed grid,
 *  [Strugar 2010](https://github.com/fstrugar/CDLOD/blob/master/cdlod_paper_latest.pdf)). DO NOT go back to six: a third more corners read the land. */
function patchCells(): { position: BufferAttribute; index: BufferAttribute } {
  const data = new Uint8Array(LOD_PATCH * LOD_PATCH * 4 * 3);
  const index = new Uint16Array(LOD_PATCH * LOD_PATCH * 6);
  let o = 0, k = 0, v = 0;
  for (let j = 0; j < LOD_PATCH; j++) {
    for (let i = 0; i < LOD_PATCH; i++) {
      for (let role = 0; role < 4; role++) { data[o++] = i; data[o++] = j; data[o++] = role; }
      for (const r of [0, 1, 2, 0, 2, 3]) index[k++] = v + r;
      v += 4;
    }
  }
  return { position: new BufferAttribute(data, 3), index: new BufferAttribute(index, 1) };
}

/** A rim's strip along ONE side, both ways round: (corner k along the side, 0, 6 + bottom); the side is the instance's (`aLodPatch.w` >> 4,
 *  `LandLod.add`), one instance a side that hangs. DO NOT lay the four sides in one model: on a patch at the plate's edge three of them hung
 *  nothing and were 120 of its 160 triangles. */
function patchRim(): { position: BufferAttribute; index: BufferAttribute } {
  const data = new Uint8Array((LOD_PATCH + 1) * 2 * 3);
  let o = 0;
  for (let k = 0; k <= LOD_PATCH; k++) for (const bottom of [0, 1]) { data[o++] = k; data[o++] = 0; data[o++] = 6 + bottom; }
  const index = new Uint16Array(LOD_PATCH * 12);
  let i = 0;
  for (let k = 0; k < LOD_PATCH; k++) {
    const top0 = k * 2, bottom0 = top0 + 1, top1 = top0 + 2, bottom1 = top0 + 3;
    for (const v of [top0, bottom0, top1, top1, bottom0, bottom1, top0, top1, bottom0, top1, bottom1, bottom0]) index[i++] = v;
  }
  return { position: new BufferAttribute(data, 3), index: new BufferAttribute(index, 1) };
}

/** A patch's level in `aLodPatch.w`; a rim's side above it (`LandLod.add`). */
const LEVEL_BITS = 15, SIDE_SHIFT = 4;

/** The vertex shader's part: the patch placed, its corners read from the land's texels and morphed by their distance (`terrain.ts` sets `landP`, `landN`, `landUv`). */
export function lodVertexGlsl(grid: LandGrid): string {
  const f = (v: number): string => v.toFixed(6);
  return /* glsl */ `
    uniform highp sampler2D uLand;
    uniform vec2 uLodMorph[${LOD_LEVELS}];
    uniform vec4 uLodSkirt;
    attribute vec4 aLodPatch;
    varying vec3 vLandAtlas;
    vec3 landP;
    vec3 landN;
    vec2 landUv;
    vec4 landTexel(ivec2 c) { return texelFetch(uLand, clamp(c, ivec2(0), ivec2(${grid.seg})), 0); }
    vec3 landNormal(vec4 t) { return vec3(t.x, sqrt(max(0.0, 1.0 - t.x * t.x - t.y * t.y)), t.y); }
    vec3 landPoint(ivec2 c, float h) { return vec3(float(c.x) * ${f(grid.cell)} - ${f(grid.half)}, h, float(c.y) * ${f(grid.cell)} - ${f(grid.half)}); }
    // A corner of the patch, moved towards the next level's by its own distance (Strugar's morphVertex: an odd corner onto the even one before it).
    float landCorner(ivec2 g, out vec3 p, out vec3 n) {
      ivec2 origin = ivec2(aLodPatch.xy);
      int step = int(aLodPatch.z);
      ivec2 c = origin + g * step;
      vec4 t = landTexel(c);
      p = landPoint(c, t.w);
      n = landNormal(t);
      vec2 morph = uLodMorph[int(aLodPatch.w) & ${LEVEL_BITS}];
      float k = clamp((distance(p + uTileOrigin, cameraPosition) - morph.x) * morph.y, 0.0, 1.0);
      ivec2 odd = g & 1;
      if (k > 0.0 && odd != ivec2(0)) {
        ivec2 to = origin + (g - odd) * step;
        vec4 u = landTexel(to);
        p = mix(p, landPoint(to, u.w), k);
        n = mix(n, landNormal(u), k);
      }
      return k;
    }
    void landVertex() {
      ivec3 v = ivec3(position);
      if (v.z < 4) {
        vec3 pa, pb, pc, pd, na, nb, nc, nd;
        float k = landCorner(v.xy, pa, na) + landCorner(v.xy + ivec2(0, 1), pb, nb) + landCorner(v.xy + ivec2(1, 1), pc, nc) + landCorner(v.xy + ivec2(1, 0), pd, nd);
        // Level 0 unmorphed: the diagonal the page chose (\`cellDiagonal\`, what \`renderedHeightAt\` reads); else the same rule on the corners as they stand.
        bool flip = aLodPatch.w == 0.0 && k == 0.0 ? landTexel(ivec2(aLodPatch.xy) + v.xy).z > 0.5 : abs(pa.y - pc.y) + 0.5 < abs(pb.y - pd.y);
        // Triangles over roles (0, 1, 2) and (0, 2, 3): (a, b, c) and (a, c, d); turned by one, (b, c, d) and (b, d, a) along the other diagonal.
        int corner = flip ? v.z : (v.z + 1) & 3;
        landP = corner == 0 ? pa : corner == 1 ? pb : corner == 2 ? pc : pd;
        landN = corner == 0 ? na : corner == 1 ? nb : corner == 2 ? nc : nd;
      } else {
        int side = int(aLodPatch.w) >> ${SIDE_SHIFT};
        // West, east, north, south: x = 0, x = LOD_PATCH, y = 0, y = LOD_PATCH.
        ivec2 g = side < 2 ? ivec2(side == 0 ? 0 : ${LOD_PATCH}, v.x) : ivec2(v.x, side == 2 ? 0 : ${LOD_PATCH});
        landCorner(g, landP, landN);
        if (v.z == 7) landP.y -= uLodSkirt[side];
      }
      landUv = vec2((landP.x + ${f(grid.half)}) / ${f(2 * grid.half)}, 1.0 - (landP.z + ${f(grid.half)}) / ${f(2 * grid.half)});
    }
  `;
}

/** The fragment shader's part: the full ground under the drawn point, as the finest level would have drawn it (height, normal), whatever level drew it. */
export function lodFragmentGlsl(grid: LandGrid): string {
  const f = (v: number): string => v.toFixed(6);
  return /* glsl */ `
    varying vec3 vLandAtlas;
    uniform highp sampler2D uLand;
    uniform vec3 uTileOrigin;
    vec3 vTerrainWorld;
    vec3 vTerrainAtlas;
    vec3 vTerrainNormal;
    vec3 landNormal(vec4 t) { return vec3(t.x, sqrt(max(0.0, 1.0 - t.x * t.x - t.y * t.y)), t.y); }
    // The cell under the point split along its own diagonal, as \`cellHeight\` (world/groundPatch.ts) reads it.
    void landSurface() {
      vec3 local = vLandAtlas - uTileOrigin;
      vec2 g = (local.xz + ${f(grid.half)}) / ${f(grid.cell)};
      ivec2 i = clamp(ivec2(floor(g)), ivec2(0), ivec2(${grid.seg - 1}));
      vec2 f = g - vec2(i);
      vec4 a = texelFetch(uLand, i, 0);
      vec4 b = texelFetch(uLand, i + ivec2(0, 1), 0);
      vec4 c = texelFetch(uLand, i + ivec2(1, 1), 0);
      vec4 d = texelFetch(uLand, i + ivec2(1, 0), 0);
      float u = f.x, v = f.y;
      vec4 w = a.z > 0.5
        ? (u >= v ? vec4(1.0 - u, 0.0, v, u - v) : vec4(1.0 - v, v - u, u, 0.0))
        : (u + v <= 1.0 ? vec4(1.0 - u - v, v, 0.0, u) : vec4(0.0, 1.0 - u, u + v - 1.0, 1.0 - v));
      float h = dot(w, vec4(a.w, b.w, c.w, d.w));
      vTerrainNormal = w.x * landNormal(a) + w.y * landNormal(b) + w.z * landNormal(c) + w.w * landNormal(d);
      vTerrainWorld = vec3(local.x, h, local.z);
      vTerrainAtlas = vec3(vLandAtlas.x, h + uTileOrigin.y, vLandAtlas.z);
    }
  `;
}

const box = new Box3();
const eye = new Vector3();
const frustum = new Frustum();
const viewProjection = new Matrix4();

/** A plate's ground as patches of one grid, chosen each frame from the camera (Strugar's `LODSelect`): one draw for the ground, one for its rim. */
export class LandLod {
  readonly geometry = new InstancedBufferGeometry();
  readonly rimGeometry = new InstancedBufferGeometry();
  /** Per level, where its morph starts and 1 / its length (the shader's `uLodMorph`). */
  readonly morph = new Float32Array(LOD_LEVELS * 2);
  /** How far the rim hangs on the west, east, north and south (0: a side that hangs none). */
  readonly skirt: Vector4;
  private readonly reach = new Float64Array(LOD_LEVELS);
  private readonly patches: InstancedBufferAttribute;
  private readonly rims: InstancedBufferAttribute;
  private count = 0;
  private rimCount = 0;
  /** The first patch and rim this selection wrote anew (Infinity: none). */
  private patchesFrom = Infinity;
  private rimsFrom = Infinity;

  constructor(
    private readonly levels: LandLevels,
    private readonly grid: LandGrid,
    private readonly origin: { readonly x: number; readonly y: number },
    rim: { readonly west: boolean; readonly east: boolean; readonly north: boolean; readonly south: boolean },
  ) {
    const most = (grid.seg / LOD_PATCH) ** 2;
    const cells = patchCells(), rimStrip = patchRim();
    this.patches = new InstancedBufferAttribute(new Float32Array(most * 4), 4).setUsage(DynamicDrawUsage);
    this.rims = new InstancedBufferAttribute(new Float32Array((4 * grid.seg) / LOD_PATCH * 4), 4).setUsage(DynamicDrawUsage);
    // The patch's grid is a plate's own (1.8 kB, its rim 1.4 kB): no buffer shared between plates to outlive one.
    this.geometry.setAttribute('position', cells.position);
    this.geometry.setIndex(cells.index);
    this.geometry.setAttribute('aLodPatch', this.patches);
    this.rimGeometry.setAttribute('position', rimStrip.position);
    this.rimGeometry.setIndex(rimStrip.index);
    this.rimGeometry.setAttribute('aLodPatch', this.rims);
    this.geometry.instanceCount = 0;
    this.rimGeometry.instanceCount = 0;
    this.skirt = new Vector4(rim.west ? LOD_SKIRT : 0, rim.east ? LOD_SKIRT : 0, rim.north ? LOD_SKIRT : 0, rim.south ? LOD_SKIRT : 0);
  }

  /** The patches the camera needs, nearest levels where its error would show; returns how many. */
  select(camera: PerspectiveCamera | OrthographicCamera, pixels: number): number {
    this.ranges(camera, pixels);
    camera.getWorldPosition(eye);
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection, WebGLCoordinateSystem, camera.reversedDepth);
    this.count = 0;
    this.rimCount = 0;
    this.patchesFrom = Infinity;
    this.rimsFrom = Infinity;
    this.visit(LOD_LEVELS - 1, 0, 0);
    // DO NOT send the patches every frame: only from the first one that differs from what was sent (a still camera sends none).
    for (const [attribute, count, from, geometry] of [[this.patches, this.count, this.patchesFrom, this.geometry], [this.rims, this.rimCount, this.rimsFrom, this.rimGeometry]] as const) {
      geometry.instanceCount = count;
      if (from >= count) continue;
      // A range not sent yet kept whole: its instances past this count are not sent again when the count grows back.
      const pending = attribute.updateRanges[0];
      const start = pending ? Math.min(pending.start, from * 4) : from * 4, end = pending ? Math.max(pending.start + pending.count, count * 4) : count * 4;
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(start, end - start);
      attribute.needsUpdate = true;
    }
    return this.count;
  }

  /** Each level's reach and morph: a level gives way to the next only where the next one's error is under `LOD_PIXELS`. */
  private ranges(camera: PerspectiveCamera | OrthographicCamera, pixels: number): void {
    const worst = this.levels.worst;
    const last = LOD_LEVELS - 1;
    const never = 1e30;
    if ((camera as OrthographicCamera).isOrthographicCamera) {
      // One level over the whole plate: the coarsest whose error stays under a pixel at the screen's scale.
      const ortho = camera as OrthographicCamera;
      const pixel = (ortho.top - ortho.bottom) / ortho.zoom / Math.max(1, pixels);
      let use = 0;
      while (use < last && worst[use + 1]! <= pixel * LOD_PIXELS) use++;
      for (let level = 0; level <= last; level++) {
        this.reach[level] = level >= use ? Infinity : -1;
        this.morph[level * 2] = never;
        this.morph[level * 2 + 1] = 0;
      }
      return;
    }
    const persp = camera as PerspectiveCamera;
    // Pixels a metre spans at a metre's distance.
    const perMetre = (pixels * persp.zoom) / (2 * Math.tan((persp.fov * Math.PI) / 360));
    const span = this.levels.hi(last, 0, 0) - this.levels.lo(last, 0, 0);
    let end = 0;
    for (let level = 0; level < last; level++) {
      const side = (LOD_NODE << level) * this.grid.cell;
      // Every point of a node the last level drew lies within its reach and the node's diagonal: none of this level's corners morphs there (Strugar's granularity limit).
      const below = side / 2;
      const after = level === 0 ? 0 : end + Math.hypot(below, below, span) + LOD_MARGIN;
      const start = Math.max((worst[level + 1]! * perMetre) / LOD_PIXELS, after);
      end = start + side + LOD_MARGIN;
      this.reach[level] = end;
      this.morph[level * 2] = start;
      this.morph[level * 2 + 1] = 1 / side;
    }
    this.reach[last] = Infinity;
    this.morph[last * 2] = never;
    this.morph[last * 2 + 1] = 0;
  }

  /** A node's box in the world (three's axes) into `box`, and how far the eye stands from it. */
  private boxOf(level: number, nx: number, ny: number): number {
    const span = (LOD_NODE << level) * this.grid.cell;
    const x0 = this.origin.x - this.grid.half + nx * span;
    const z0 = -this.origin.y - this.grid.half + ny * span;
    box.min.set(x0, this.levels.lo(level, nx, ny), z0);
    box.max.set(x0 + span, this.levels.hi(level, nx, ny), z0 + span);
    return box.distanceToPoint(eye);
  }

  /** Strugar's `LODSelect`: false when the node is beyond its level's reach and its parent must draw its area. */
  private visit(level: number, nx: number, ny: number): boolean {
    const distance = this.boxOf(level, nx, ny);
    if (distance > this.reach[level]!) return false;
    if (!frustum.intersectsBox(box)) return true;
    if (level === 0 || distance > this.reach[level - 1]!) {
      for (let q = 0; q < 4; q++) this.add(level, nx, ny, q);
      return true;
    }
    for (let q = 0; q < 4; q++) if (!this.visit(level - 1, nx * 2 + (q & 1), ny * 2 + (q >> 1))) this.add(level, nx, ny, q);
    return true;
  }

  /** Quarter `q` of a node drawn as one patch of its level, when it is in view. */
  private add(level: number, nx: number, ny: number, q: number): void {
    const cx = nx * 2 + (q & 1), cy = ny * 2 + (q >> 1);
    if (level > 0) {
      this.boxOf(level - 1, cx, cy);
      if (!frustum.intersectsBox(box)) return;
    }
    const step = 1 << level;
    const x = cx * LOD_PATCH * step, y = cy * LOD_PATCH * step;
    /** Written only where it differs from what the buffer holds; the first such index kept (`select`). */
    const write = (attribute: InstancedBufferAttribute, k: number, w: number): boolean => {
      const a = attribute.array as Float32Array;
      if (a[k * 4] === x && a[k * 4 + 1] === y && a[k * 4 + 2] === step && a[k * 4 + 3] === w) return false;
      a[k * 4] = x; a[k * 4 + 1] = y; a[k * 4 + 2] = step; a[k * 4 + 3] = w;
      return true;
    };
    if (write(this.patches, this.count, level) && this.count < this.patchesFrom) this.patchesFrom = this.count;
    this.count++;
    // A rim for each side of the plate this patch lies on that hangs a skirt: its side above its level.
    const end = LOD_PATCH * step, seg = this.grid.seg, s = this.skirt;
    const hangs = [x === 0 && s.x > 0, x + end === seg && s.y > 0, y === 0 && s.z > 0, y + end === seg && s.w > 0];
    for (let side = 0; side < 4; side++) {
      if (!hangs[side]) continue;
      if (write(this.rims, this.rimCount, level + (side << SIDE_SHIFT)) && this.rimCount < this.rimsFrom) this.rimsFrom = this.rimCount;
      this.rimCount++;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.rimGeometry.dispose();
  }
}
