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

/** The patch's cells, six corners each for two triangles along the diagonal the shader picks: (cell x, cell y, role 0-5). */
function patchCells(): BufferAttribute {
  const data = new Uint8Array(LOD_PATCH * LOD_PATCH * 6 * 3);
  let o = 0;
  for (let j = 0; j < LOD_PATCH; j++) for (let i = 0; i < LOD_PATCH; i++) for (let role = 0; role < 6; role++) { data[o++] = i; data[o++] = j; data[o++] = role; }
  return new BufferAttribute(data, 3);
}

/** The patch's rim: on each side a strip hung from its edge corners, both ways round: (corner x, corner y, 6 + side * 2 + bottom). */
function patchRim(): BufferAttribute {
  const data = new Uint8Array(4 * LOD_PATCH * 12 * 3);
  let o = 0;
  const put = (x: number, y: number, role: number): void => { data[o++] = x; data[o++] = y; data[o++] = role; };
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k < LOD_PATCH; k++) {
      // West, east, north, south: x = 0, x = LOD_PATCH, y = 0, y = LOD_PATCH.
      const at = (t: number): readonly [number, number] => side === 0 ? [0, t] : side === 1 ? [LOD_PATCH, t] : side === 2 ? [t, 0] : [t, LOD_PATCH];
      const [ax, ay] = at(k), [bx, by] = at(k + 1);
      const top = 6 + side * 2, bottom = top + 1;
      put(ax, ay, top); put(ax, ay, bottom); put(bx, by, top);
      put(bx, by, top); put(ax, ay, bottom); put(bx, by, bottom);
      put(ax, ay, top); put(bx, by, top); put(ax, ay, bottom);
      put(bx, by, top); put(bx, by, bottom); put(ax, ay, bottom);
    }
  }
  return new BufferAttribute(data, 3);
}


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
      vec2 morph = uLodMorph[int(aLodPatch.w)];
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
      if (v.z < 6) {
        vec3 pa, pb, pc, pd, na, nb, nc, nd;
        float k = landCorner(v.xy, pa, na) + landCorner(v.xy + ivec2(0, 1), pb, nb) + landCorner(v.xy + ivec2(1, 1), pc, nc) + landCorner(v.xy + ivec2(1, 0), pd, nd);
        // Level 0 unmorphed: the diagonal the page chose (\`cellDiagonal\`, what \`renderedHeightAt\` reads); else the same rule on the corners as they stand.
        bool flip = aLodPatch.w == 0.0 && k == 0.0 ? landTexel(ivec2(aLodPatch.xy) + v.xy).z > 0.5 : abs(pa.y - pc.y) + 0.5 < abs(pb.y - pd.y);
        // (a, b, d) and (b, c, d), or (a, b, c) and (a, c, d) along the other diagonal.
        int corner = v.z == 2 ? (flip ? 2 : 3) : v.z == 3 ? (flip ? 0 : 1) : v.z == 4 ? 2 : v.z == 5 ? 3 : v.z;
        landP = corner == 0 ? pa : corner == 1 ? pb : corner == 2 ? pc : pd;
        landN = corner == 0 ? na : corner == 1 ? nb : corner == 2 ? nc : nd;
      } else {
        int side = (v.z - 6) >> 1;
        landCorner(v.xy, landP, landN);
        ivec2 at = ivec2(aLodPatch.xy);
        int end = int(aLodPatch.z) * ${LOD_PATCH};
        bool rim = side == 0 ? at.x == 0 : side == 1 ? at.x + end == ${grid.seg} : side == 2 ? at.y == 0 : at.y + end == ${grid.seg};
        if (rim && ((v.z - 6) & 1) == 1) landP.y -= uLodSkirt[side];
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
  /** How far the rim hangs on the west, east, north and south (0: the map's own rim, where the slab stands). */
  readonly skirt: Vector4;
  private readonly reach = new Float64Array(LOD_LEVELS);
  private readonly patches: InstancedBufferAttribute;
  private readonly rims: InstancedBufferAttribute;
  private count = 0;
  private rimCount = 0;

  constructor(
    private readonly levels: LandLevels,
    private readonly grid: LandGrid,
    private readonly origin: { readonly x: number; readonly y: number },
    rim: { readonly west: boolean; readonly east: boolean; readonly north: boolean; readonly south: boolean },
  ) {
    const most = (grid.seg / LOD_PATCH) ** 2;
    this.patches = new InstancedBufferAttribute(new Float32Array(most * 4), 4).setUsage(DynamicDrawUsage);
    this.rims = new InstancedBufferAttribute(new Float32Array((4 * grid.seg) / LOD_PATCH * 4), 4).setUsage(DynamicDrawUsage);
    // The patch's grid is a plate's own (1.8 kB, its rim 1.4 kB): no buffer shared between plates to outlive one.
    this.geometry.setAttribute('position', patchCells());
    this.geometry.setAttribute('aLodPatch', this.patches);
    this.rimGeometry.setAttribute('position', patchRim());
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
    this.visit(LOD_LEVELS - 1, 0, 0);
    for (const [attribute, count, geometry] of [[this.patches, this.count, this.geometry], [this.rims, this.rimCount, this.rimGeometry]] as const) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, count * 4);
      attribute.needsUpdate = true;
      geometry.instanceCount = count;
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
    const write = (attribute: InstancedBufferAttribute, k: number): void => {
      const a = attribute.array as Float32Array;
      a[k * 4] = x; a[k * 4 + 1] = y; a[k * 4 + 2] = step; a[k * 4 + 3] = level;
    };
    write(this.patches, this.count++);
    const end = LOD_PATCH * step, seg = this.grid.seg, s = this.skirt;
    if ((x === 0 && s.x > 0) || (x + end === seg && s.y > 0) || (y === 0 && s.z > 0) || (y + end === seg && s.w > 0)) write(this.rims, this.rimCount++);
  }

  dispose(): void {
    this.geometry.dispose();
    this.rimGeometry.dispose();
  }
}
