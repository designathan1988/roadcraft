import {
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  FloatType,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  RedFormat,
  type Texture,
  UnsignedByteType,
} from 'three';
import type { MultiPoly } from '@core/clipper';
import { m } from '@world/units';

/**
 * GRASS: a field of single blades round the camera, made on the GPU.
 *
 * As Sucker Punch did for Ghost of Tsushima (Eric Wohllaib, "Procedural Grass
 * in Ghost of Tsushima", GDC 2021) and as GodotGrass (2Retr0) does after it:
 * every blade is an instance of one short strip of triangles, and everything
 * about it - where it stands, how tall, which way it faces, how it bends, how
 * the wind moves it - is worked out in the vertex shader from its index and a
 * hash of the ground cell it stands in. Nothing is stored per blade and nothing
 * runs on the CPU per frame but two uniforms: the field follows the camera,
 * snapped to its own spacing, so a blade stays where it grew while the camera
 * moves over it.
 *
 * - Blades gather in clumps (a cellular hash): a clump leans one way, is one
 *   height and one shade, as real tufts are.
 * - The ground under each blade is read from a height texture of the terrain;
 *   a mask texture keeps the field off roads, footways, buildings and lots.
 * - Wind is a slow travelling wave plus a quick flutter at the tips.
 * - Lit as the ground is: the same standard material - sun, sky light,
 *   shadows, fog - with a colour from a dark base to a pale tip and a light
 *   shining through the blade when it stands against the sun.
 * - The field fades out over its last quarter, blade by blade (each blade
 *   shrinks to nothing at its own random distance), so there is no edge.
 */

export interface Grass {
  readonly mesh: Mesh;
  /** The ground's heights over the plate, `side` x `side` samples, rows from the south edge (y = -size/2) north. */
  setHeights(heights: Float32Array, side: number, size: number, centre?: { readonly x: number; readonly y: number }): void;
  /** Where blades may not grow: road surfaces and footprints, in world x/y. */

  /**
   * The ecosystem's ground (`TerrainSurface.ecologyTexture`): the blades go
   * straw-gold and tall in the dry savanna, thin out over bare soil and under
   * a canopy, and darken in the veredas. `season` is the dry season's depth.
   */
  setEcology(texture: Texture, half: number, cell: number, season: { value: number }): void;
  /** Each frame: where the field stands (three's x and z), whether it is drawn at all, the clock. */
  update(x: number, z: number, visible: boolean, seconds: number): void;
  dispose(): void;
}

/** Blades along each side of the field, and their spacing (units). */
const GRID = 300;
const SPACING = m(0.12);
/** Half the field's side: the grass is drawn this far from the camera's focus. */
const RADIUS = (GRID * SPACING) / 2;
/** How far the nearest ring of blades reaches, units. */
export const GRASS_NEAR_REACH = RADIUS;
/** The mask's resolution over the whole plate. */
const MASK_SIDE = 2048;

/**
 * A ring of the field: the near one dense, the far one (from where the near
 * one fades out) sparser with broader blades - the LOD rings of every grass
 * system, crossfaded so neither has an edge.
 */
export interface GrassRing {
  /** Spacing and blade width, times the near ring's. */
  readonly scale: number;
  /** Within this distance the ring has no blades (the nearer ring's ground), units; 0 for the nearest. */
  readonly inner: number;
}

/** A rectangle of the map, [minX, minY, maxX, maxY], world units. */
export type MaskRect = readonly [number, number, number, number];

/**
 * Where grass may grow: white open ground, black under the footways, the
 * buildings and their lots. One for both rings of grass, one channel, and
 * drawn again only where the roads or the buildings changed. It was a
 * 2048-square RGBA canvas per ring, redrawn whole and sent whole after every
 * edit: 2 x 16.8 MB to the graphics card per road drawn (docs/performance.md #30).
 */
export interface GrassMask {
  readonly texture: Texture;
  /** Draws the blocked ground within `rect` (the whole map when null). */
  draw(polys: readonly MultiPoly[], rings: readonly (readonly { x: number; y: number }[])[], size: number, rect: MaskRect | null, centre?: { readonly x: number; readonly y: number }): void;
}

export function createGrassMask(): GrassMask {
  const data = new Uint8Array(MASK_SIDE * MASK_SIDE).fill(255);
  const texture = new DataTexture(data, MASK_SIDE, MASK_SIDE, RedFormat, UnsignedByteType);
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MASK_SIDE;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  return {
    texture,
    draw(polys, rings, size, rect, centre = { x: 0, y: 0 }) {
      // The plate's centre (a planet face's; the origin on the flat map).
      const cx = centre.x, cy = centre.y;
      const k = MASK_SIDE / size, half = size / 2;
      // The rectangle in mask pixels (rows from the north edge), a pixel wider each way.
      let x0 = 0, y0 = 0, x1 = MASK_SIDE, y1 = MASK_SIDE;
      if (rect) {
        x0 = Math.max(0, Math.floor((rect[0] - cx + half) * k) - 1);
        x1 = Math.min(MASK_SIDE, Math.ceil((rect[2] - cx + half) * k) + 1);
        y0 = Math.max(0, Math.floor((half + cy - rect[3]) * k) - 1);
        y1 = Math.min(MASK_SIDE, Math.ceil((half + cy - rect[1]) * k) + 1);
        if (x1 <= x0 || y1 <= y0) return;
      }
      const w = x1 - x0, h = y1 - y0;
      // Only what reaches the rectangle is drawn, in world units.
      const wx0 = cx + x0 / k - half, wx1 = cx + x1 / k - half, wy0 = cy + half - y1 / k, wy1 = cy + half - y0 / k;
      const reaches = (pts: Iterable<{ x: number; y: number } | readonly number[]>): boolean => {
        let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
        for (const p of pts) {
          const x = Array.isArray(p) ? p[0] as number : (p as { x: number }).x;
          const y = Array.isArray(p) ? p[1] as number : (p as { y: number }).y;
          if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y;
        }
        return a <= wx1 && c >= wx0 && b <= wy1 && d >= wy0;
      };
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#fff';
      g.fillRect(x0, y0, w, h);
      g.save();
      g.beginPath();
      g.rect(x0, y0, w, h);
      g.clip();
      // World x/y to mask pixels: x east, y north -> rows from the north edge.
      g.setTransform(k, 0, 0, -k, (half - cx) * k, (half + cy) * k);
      g.fillStyle = '#000';
      for (const multi of polys) {
        for (const poly of multi) {
          if (!poly[0] || !reaches(poly[0] as Iterable<readonly number[]>)) continue;
          g.beginPath();
          for (const ring of poly) {
            ring.forEach(([x, y], i) => (i === 0 ? g.moveTo(x!, y!) : g.lineTo(x!, y!)));
            g.closePath();
          }
          g.fill('evenodd');
        }
      }
      for (const ring of rings) {
        if (!reaches(ring)) continue;
        g.beginPath();
        ring.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
        g.closePath();
        g.fill();
      }
      g.restore();
      // The red channel of those rows into the texture, and only they sent.
      const pixels = g.getImageData(x0, y0, w, h).data;
      for (let r = 0; r < h; r++) {
        const row = (y0 + r) * MASK_SIDE + x0;
        for (let i = 0; i < w; i++) data[row + i] = pixels[(r * w + i) * 4]!;
        // three.js reads the ranges as four components a texel (`updateTexture`).
        if (rect) texture.addUpdateRange(row * 4, w * 4);
      }
      texture.needsUpdate = true;
    },
  };
}

/** No ecosystem: every blade as it always was. */
const blankEcology = (() => {
  const texture = new DataTexture(new Uint8Array(4), 1, 1);
  texture.needsUpdate = true;
  return texture;
})();

export function createGrass(quality: { readonly grassBlades: number }, ring: GrassRing = { scale: 1, inner: 0 }, mask: GrassMask = createGrassMask()): Grass {
  // One blade: four rungs and a tip, x across (-0.5..0.5), y up the blade (0..1).
  const rungs = 4;
  const positions: number[] = [];
  for (let k = 0; k < rungs; k++) {
    const y = k / rungs;
    positions.push(-0.5, y, 0, 0.5, y, 0);
  }
  positions.push(0, 1, 0);
  const index: number[] = [];
  for (let k = 0; k + 1 < rungs; k++) {
    const a = k * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  index.push((rungs - 1) * 2, (rungs - 1) * 2 + 1, rungs * 2);
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(positions.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  geometry.setIndex(index);
  const side = Math.max(60, Math.min(GRID, Math.round(Math.sqrt(quality.grassBlades))));
  geometry.instanceCount = side * side;
  // The field is placed in the shader: bounds big enough never to be culled.
  geometry.boundingSphere = null;

  const heightTexture = new DataTexture(new Float32Array(4), 2, 2, RedFormat, FloatType);
  heightTexture.magFilter = LinearFilter;
  heightTexture.minFilter = LinearFilter;
  heightTexture.needsUpdate = true;
  const uniforms = {
    uGrassOrigin: { value: [0, 0] as [number, number] },
    uGrassFocus: { value: [0, 0] as [number, number] },
    uGrassTime: { value: 0 },
    uGrassSide: { value: side },
    uGrassSpacing: { value: SPACING * (GRID / side) * ring.scale },
    uGrassRadius: { value: RADIUS * ring.scale },
    uGrassInner: { value: ring.inner },
    uGrassScale: { value: ring.scale },
    uGrassHeight: { value: heightTexture as Texture },
    uGrassMask: { value: mask.texture },
    uGrassPlate: { value: [0, 1] as [number, number] },
    // The plate's centre, world x/y (a planet face's; the origin on the flat map).
    uGrassCentre: { value: [0, 0] as [number, number] },
    uGrassEco: { value: blankEcology as Texture },
    // half, cell and corners per side of the ecology grid
    uGrassEcoGrid: { value: [1, 1, 1] as [number, number, number] },
    uGrassSeasonDry: { value: 0 },
  };

  // Matte, and taking less of the sky's light than the ground does: blades lit
  // edge-on caught the sky and read blue.
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: DoubleSide, envMapIntensity: 0.55 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform vec2 uGrassOrigin;
        uniform vec2 uGrassFocus;
        uniform float uGrassTime;
        uniform float uGrassSide;
        uniform float uGrassSpacing;
        uniform float uGrassRadius;
        uniform float uGrassInner;
        uniform float uGrassScale;
        uniform sampler2D uGrassHeight;
        uniform sampler2D uGrassMask;
        uniform vec2 uGrassPlate; // half and size of the plate
        uniform vec2 uGrassCentre; // where the plate's centre stands
        uniform sampler2D uGrassEco;
        uniform vec3 uGrassEcoGrid;
        uniform float uGrassSeasonDry;
        varying vec2 vGrassEco;
        varying float vGrassUp;
        varying vec3 vGrassTint;
        varying float vGrassThrough;
        float grassHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        vec2 grassHash2(vec2 p) { return vec2(grassHash(p), grassHash(p + 17.31)); }
        // The nearest clump centre on a jittered lattice (a cellular hash).
        vec3 grassClump(vec2 p) {
          vec2 cell = floor(p / ${m(2.4).toFixed(3)});
          float best = 1e9; vec2 id = cell;
          for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
            vec2 c = cell + vec2(float(i), float(j));
            vec2 at = (c + grassHash2(c)) * ${m(2.4).toFixed(3)};
            float d = dot(at - p, at - p);
            if (d < best) { best = d; id = c; }
          }
          return vec3(id, sqrt(best));
        }
        // World x/y (y north) to the plate's texture space, as the terrain's paint is read.
        vec2 grassUv(vec2 w) { vec2 p = w - uGrassCentre; return vec2((p.x + uGrassPlate.x) / uGrassPlate.y, (p.y + uGrassPlate.x) / uGrassPlate.y); }`)
      .replace('#include <beginnormal_vertex>', `
        // ---- the blade's place, from its index and the ground cell it stands in
        float gi = float(gl_InstanceID);
        vec2 slot = vec2(mod(gi, uGrassSide), floor(gi / uGrassSide)) - uGrassSide * 0.5;
        vec2 cellPos = uGrassOrigin + slot * uGrassSpacing;
        vec2 cellId = floor(cellPos / uGrassSpacing + 0.5);
        vec2 jitter = grassHash2(cellId) - 0.5;
        vec2 root = cellPos + jitter * uGrassSpacing * 1.6;
        vec3 clump = grassClump(root);
        float clumpH = grassHash(clump.xy + 3.7);
        float r1 = grassHash(cellId + 7.13), r2 = grassHash(cellId + 2.71), r3 = grassHash(cellId + 9.4);
        vec2 uv = grassUv(root);
        float onPlate = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
        float allowed = texture2D(uGrassMask, uv).r * onPlate;
        // Fade out over the field's last quarter, each blade at its own distance.
        float dist = length(root - uGrassFocus);
        float fade = 1.0 - smoothstep(uGrassRadius * (0.55 + 0.3 * r3), uGrassRadius * 0.98, dist);
        // A far ring grows in where the nearer one thins out, each blade at its own distance.
        if (uGrassInner > 0.0) fade *= smoothstep(uGrassInner * (0.5 + 0.35 * r2), uGrassInner * 0.95, dist);
        // Patchy: some ground is barer than other.
        float grassPatch = smoothstep(0.15, 0.55, grassHash(floor(root / ${m(7).toFixed(3)})) * 0.6 + clumpH * 0.6);
        float tall = (${m(0.14).toFixed(3)} + ${m(0.32).toFixed(3)} * (clumpH * 0.7 + r1 * 0.3)) * mix(0.55, 1.0, grassPatch);
        // The ecosystem (world/ecology.ts): R canopy, G dry savanna grass, B wet, A bare.
        vec2 ecoAt = root - uGrassCentre;
        vec4 eco = texture2D(uGrassEco, (vec2(ecoAt.x + uGrassEcoGrid.x, uGrassEcoGrid.x - ecoAt.y) / uGrassEcoGrid.y + 0.5) / uGrassEcoGrid.z);
        float sparse = (1.0 - eco.a * 0.92) * (1.0 - eco.r * 0.55);
        float keep = allowed * fade * step(0.25, allowed) * step(r2 * 0.999, sparse);
        // The savanna's capim stands taller, the more so the drier the season.
        tall *= (1.0 + eco.g * (0.8 + 0.9 * uGrassSeasonDry)) * (1.0 + eco.b * 0.35);
        vGrassEco = vec2(eco.g * mix(0.2, 1.0, uGrassSeasonDry), eco.b);
        tall *= keep;
        float wide = ${m(0.032).toFixed(3)} * uGrassScale * (0.75 + r2 * 0.5) * keep;
        // Facing: round the clump's own lean, spread a little.
        vec2 toCentre = normalize(clump.xy * ${m(2.4).toFixed(3)} - root + 1e-4);
        float facing = atan(toCentre.y, toCentre.x) + (r1 - 0.5) * 2.4;
        vec2 across = vec2(cos(facing), sin(facing));
        vec2 lean = vec2(-across.y, across.x);
        // Wind: a slow wave travelling over the field, and a flutter.
        float wave = sin(dot(root, vec2(0.021, 0.013)) - uGrassTime * 1.3) * 0.5 + 0.5;
        float flutter = sin(uGrassTime * 6.0 + r2 * 40.0) * 0.12;
        float bendTip = (0.35 + clumpH * 0.4) + wave * 0.55 + flutter;
        float t = position.y;
        float bend = bendTip * t * t;
        vec2 windDir = normalize(vec2(0.8, 0.6));
        vec2 sway = lean * bend * 0.6 + windDir * wave * t * t * 0.5;
        float ground = texture2D(uGrassHeight, uv).r;
        float taper = (1.0 - t * 0.85);
        vec2 grassAt = root + across * position.x * wide * taper + sway * tall;
        float up = tall * t * (1.0 - 0.25 * bend);
        vGrassUp = t;
        vGrassTint = vec3(clumpH, r1, grassPatch);
        // Light through the blade, strongest at the tip.
        vGrassThrough = t;
        // Normal: the blade's face, rounded across it and tipped by the bend.
        vec3 faceN = normalize(vec3(lean.x, 0.0, -lean.y));
        vec3 objectNormal = normalize(faceN + vec3(across.x, 0.0, -across.y) * position.x * 0.9 + vec3(0.0, 0.6 + bend, 0.0));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(across.x, 0.0, -across.y);
        #endif`)
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(grassAt.x, ground + up, -grassAt.y);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vGrassUp;
        varying vec3 vGrassTint;
        varying float vGrassThrough;
        varying vec2 vGrassEco;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // Dark at the root, pale green at the tip; clumps a little drier or lusher.
        vec3 grassBase = vec3(0.018, 0.04, 0.014);
        vec3 grassTip = mix(vec3(0.075, 0.15, 0.04), vec3(0.15, 0.17, 0.05), vGrassTint.x * 0.6);
        grassTip = mix(grassTip, vec3(0.06, 0.13, 0.035), vGrassTint.y * 0.35);
        // Straw in the dry savanna (linear values), darker green in the wet.
        vec3 strawBase = vec3(0.07, 0.045, 0.018);
        vec3 strawTip = mix(vec3(0.42, 0.32, 0.12), vec3(0.3, 0.24, 0.1), vGrassTint.y * 0.6);
        grassBase = mix(grassBase, strawBase, vGrassEco.x);
        grassTip = mix(grassTip, strawTip, vGrassEco.x);
        grassTip = mix(grassTip, grassTip * vec3(0.6, 0.85, 0.65), vGrassEco.y);
        diffuseColor.rgb = mix(grassBase, grassTip, smoothstep(0.0, 1.0, vGrassUp));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // Sun through the blade: a warm glow at the tip that does not depend on facing.
        totalEmissiveRadiance += vec3(0.012, 0.018, 0.004) * vGrassThrough * vGrassThrough;`);
  };
  material.customProgramCacheKey = () => 'grass-field-v4';

  const mesh = new Mesh(geometry, material);
  mesh.name = 'grass';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.visible = false;

  return {
    mesh,
    setHeights(heights, n, size, centre = { x: 0, y: 0 }) {
      heightTexture.image = { data: heights, width: n, height: n } as unknown as typeof heightTexture.image;
      heightTexture.needsUpdate = true;
      uniforms.uGrassPlate.value = [size / 2, size];
      uniforms.uGrassCentre.value = [centre.x, centre.y];
    },
    setEcology(texture, half, cell, season) {
      uniforms.uGrassEco.value = texture;
      uniforms.uGrassEcoGrid.value = [half, cell, (texture.image as { width: number }).width];
      uniforms.uGrassSeasonDry = season;
      material.needsUpdate = true;
    },
    update(x, z, visible, seconds) {
      mesh.visible = visible;
      if (!visible) return;
      const s = uniforms.uGrassSpacing.value;
      uniforms.uGrassOrigin.value = [Math.round(x / s) * s, Math.round(-z / s) * s];
      uniforms.uGrassFocus.value = [x, -z];
      uniforms.uGrassTime.value = seconds % 1000;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      heightTexture.dispose();
    },
  };
}
