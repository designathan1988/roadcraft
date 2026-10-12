import {
  BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { ClipFrames } from '../citizenBake';
import { PACKED_BONE_FLOATS } from '../citizenPalette';

/**
 * A crowd's animation on the GPU, as GPU Gems 3, chapter 2 ("Animated Crowd
 * Rendering") lays it out: every frame of every clip of a body class baked
 * once into one texture, three texels a bone (the affine rows, the
 * translation in their last components), read with exact fetches.
 *
 * Its reader is the palette pass (`PalettePass`): each bone of each person
 * blended from up to four clips between two frames and moved to that
 * person's own joints (`proceduralCrowd.ts` `refit`, the same sums, walking
 * up the bone's parents) - written to a float render target the skinning
 * reads. Nothing of it is worked out in JavaScript, nothing of it is uploaded
 * a frame but four numbers a play.
 */

/** Texels a bone takes in the animation texture (twelve floats). */
export const ATLAS_TEXELS = 3;
/** Plays blended per person in the palette pass (a rider's are four). */
export const PLAYS = 4;
/** Texels of a person's row of plays: one a play, then (variant, override, resting). */
const PLAY_TEXELS = PLAYS + 1;

export interface ClassAnimation {
  /** Frames of every clip, a row each: `bones * 3` texels across. */
  readonly atlas: DataTexture;
  /** A clip's first row in the atlas. */
  rowOf(clip: string): number;
  readonly bones: number;
}

/** The class's clips in one texture, in the order given. */
export function buildClassAnimation(clips: Readonly<Record<string, ClipFrames>>, bones: number): ClassAnimation {
  const packed = bones * PACKED_BONE_FLOATS;
  const rowsOf = (clip: ClipFrames): number => Math.round(clip.data.length / packed);
  let rows = 0;
  const start = new Map<string, number>();
  for (const [name, clip] of Object.entries(clips)) { start.set(name, rows); rows += rowsOf(clip); }
  const width = bones * ATLAS_TEXELS;
  // Twelve floats a bone are exactly three RGBA texels: each row is the clip's frame as baked.
  const pixels = new Float32Array(width * 4 * Math.max(1, rows));
  for (const [name, clip] of Object.entries(clips)) pixels.set(clip.data.subarray(0, rowsOf(clip) * packed), start.get(name)! * width * 4);
  const atlas = new DataTexture(pixels, width, Math.max(1, rows), RGBAFormat, FloatType);
  atlas.minFilter = atlas.magFilter = NearestFilter;
  atlas.needsUpdate = true;
  return { atlas, rowOf: (clip) => start.get(clip) ?? 0, bones };
}

/** A packed bone of row `row` as a mat4 (GLSL), from a sampler named `atlas`. */
export function atlasBoneGlsl(name: string, atlas: string): string {
  return `
mat4 ${name}(int row, int bone) {
  vec4 a = texelFetch(${atlas}, ivec2(bone * ${ATLAS_TEXELS}, row), 0);
  vec4 b = texelFetch(${atlas}, ivec2(bone * ${ATLAS_TEXELS} + 1, row), 0);
  vec4 c = texelFetch(${atlas}, ivec2(bone * ${ATLAS_TEXELS} + 2, row), 0);
  return mat4(vec4(a.xyz, 0.0), vec4(a.w, b.xy, 0.0), vec4(b.zw, c.x, 0.0), vec4(c.yzw, 1.0));
}`;
}

/** One play of a person in the palette pass: an atlas row, the fraction to the next row, its weight. */
export interface PalettePlay {
  readonly row: number;
  readonly t: number;
  readonly weight: number;
}

export interface PalettePass {
  /** The bone palettes, a row a person (`bones * 4` texels: mat4 columns), for the skinning to read. */
  readonly texture: Texture;
  readonly capacity: number;
  /** What person `row` plays this frame, the body variant whose joints they have; null plays: a palette of their own (`setOverride`). */
  setPlays(row: number, plays: readonly PalettePlay[] | null, variant: number): void;
  /** Person `row` is not drawn this frame: their row is not worked out (off the screen costs nothing). */
  rest(row: number): void;
  /** A palette worked out on the CPU for a person (held by a ragdoll, wounded, a limb lost). */
  setOverride(row: number, palette: Float32Array): void;
  /** Rows 0..`rows` worked out on the GPU. */
  render(renderer: WebGLRenderer, rows: number): void;
  /** Room for `capacity` rows; the rows written so far are kept. */
  grow(capacity: number): void;
  dispose(): void;
}

/**
 * The palette pass of a body class: a quad drawn into a float target, a
 * texel a column of a bone of a person.
 *
 * `joints`: a texture of `bones` texels a row, a body variant a row, each
 * bone's head moved for that body (`crowdBodies.ts`).
 */
export function createPalettePass(anim: ClassAnimation, parent: Int16Array, joints: () => Texture, capacity: number): PalettePass {
  const bones = anim.bones;
  const width = bones * 4;
  let depth = 0;
  for (let i = 0; i < bones; i++) {
    let d = 0, j = parent[i]!;
    while (j >= 0) { d++; j = parent[j]!; }
    depth = Math.max(depth, d);
  }
  let rows = capacity;
  let plays = new Float32Array(PLAY_TEXELS * 4 * rows);
  let playTexture = rowsTexture(plays, PLAY_TEXELS, rows);
  let override = new Float32Array(width * 4 * rows);
  let overrideTexture = rowsTexture(override, width, rows);
  let target = makeTarget(width, rows);
  /** Rows of plays written since the last upload; past a few, the whole (small) texture goes up at once. */
  const dirty = new Set<number>();
  let dirtyAll = false;
  const overrideRows = new Set<number>();

  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    defines: { BONES: bones, MAX_DEPTH: Math.max(1, depth), PLAYS },
    uniforms: {
      uAtlas: { value: anim.atlas },
      uPlays: { value: playTexture },
      uJoints: { value: joints() },
      uOverride: { value: overrideTexture },
      uParent: { value: Array.from(parent) },
    },
    vertexShader: /* glsl */`
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
      precision highp float;
      precision highp int;
      precision highp sampler2D;
      uniform sampler2D uAtlas;
      uniform sampler2D uPlays;
      uniform sampler2D uJoints;
      uniform sampler2D uOverride;
      uniform int uParent[BONES];
      out highp vec4 outColor;
      ${atlasBoneGlsl('atlasBone', 'uAtlas')}
      mat4 blended(int person, int bone) {
        mat4 m = mat4(0.0);
        for (int k = 0; k < PLAYS; k++) {
          vec4 p = texelFetch(uPlays, ivec2(k, person), 0);
          if (p.z <= 0.0) continue;
          int r = int(p.x + 0.5);
          m += p.z * ((1.0 - p.y) * atlasBone(r, bone) + p.y * atlasBone(r + 1, bone));
        }
        return m;
      }
      vec3 jointOf(int variant, int bone) { return texelFetch(uJoints, ivec2(bone, variant), 0).xyz; }
      void main() {
        ivec2 at = ivec2(gl_FragCoord.xy);
        int bone = at.x / 4;
        int column = at.x - bone * 4;
        int person = at.y;
        vec4 meta = texelFetch(uPlays, ivec2(${PLAYS}, person), 0);
        if (meta.z > 0.5) { outColor = vec4(0.0); return; }
        if (meta.y > 0.5) { outColor = texelFetch(uOverride, at, 0); return; }
        int variant = int(meta.x + 0.5);
        mat4 m = blended(person, bone);
        // The bone moved to this body's joints (proceduralCrowd.ts refit):
        // its head carried by every parent's turn up to the root.
        vec3 shift = vec3(0.0);
        int cur = bone;
        for (int s = 0; s < MAX_DEPTH; s++) {
          int p = uParent[cur];
          if (p < 0) break;
          shift += mat3(blended(person, p)) * (jointOf(variant, cur) - jointOf(variant, p));
          cur = p;
        }
        shift += jointOf(variant, cur);
        m[3].xyz += shift - mat3(m) * jointOf(variant, bone);
        outColor = m[column];
      }`,
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new BufferGeometry();
  quad.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new Mesh(quad, material);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  return {
    get texture() { return target.texture; },
    get capacity() { return rows; },
    setPlays(row, list, variant) {
      const o = row * PLAY_TEXELS * 4;
      for (let k = 0; k < PLAYS; k++) {
        const p = list?.[k];
        plays[o + k * 4] = p ? p.row : 0;
        plays[o + k * 4 + 1] = p ? p.t : 0;
        plays[o + k * 4 + 2] = p ? p.weight : 0;
        plays[o + k * 4 + 3] = 0;
      }
      plays[o + PLAYS * 4] = variant;
      plays[o + PLAYS * 4 + 1] = list ? 0 : 1;
      plays[o + PLAYS * 4 + 2] = 0;
      dirty.add(row);
    },
    rest(row) {
      const o = row * PLAY_TEXELS * 4 + PLAYS * 4 + 2;
      if (plays[o] === 1) return;
      plays[o] = 1;
      dirty.add(row);
    },
    setOverride(row, palette) {
      override.set(palette.subarray(0, width * 4), row * width * 4);
      overrideRows.add(row);
    },
    render(renderer, used) {
      const n = Math.min(rows, Math.max(0, used));
      if (n === 0) return;
      material.uniforms['uJoints']!.value = joints();
      if (dirtyAll || dirty.size) {
        // Each update range is one row of the image in three (WebGLTextures.js):
        // a range a row while few changed, the whole texture (80 bytes a person) otherwise.
        playTexture.clearUpdateRanges();
        if (!dirtyAll && dirty.size <= 8) for (const row of dirty) playTexture.addUpdateRange(row * PLAY_TEXELS * 4, PLAY_TEXELS * 4);
        playTexture.needsUpdate = true;
        dirty.clear();
        dirtyAll = false;
      }
      if (overrideRows.size) {
        overrideTexture.clearUpdateRanges();
        for (const row of overrideRows) overrideTexture.addUpdateRange(row * width * 4, width * 4);
        overrideTexture.needsUpdate = true;
        overrideRows.clear();
      }
      const previous = renderer.getRenderTarget();
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      target.viewport.set(0, 0, width, n);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(previous);
      renderer.autoClear = autoClear;
    },
    grow(capacity) {
      if (capacity <= rows) return;
      const nextPlays = new Float32Array(PLAY_TEXELS * 4 * capacity);
      nextPlays.set(plays);
      plays = nextPlays;
      playTexture.dispose();
      playTexture = rowsTexture(plays, PLAY_TEXELS, capacity);
      const nextOverride = new Float32Array(width * 4 * capacity);
      nextOverride.set(override);
      override = nextOverride;
      overrideTexture.dispose();
      overrideTexture = rowsTexture(override, width, capacity);
      target.dispose();
      target = makeTarget(width, capacity);
      material.uniforms['uPlays']!.value = playTexture;
      material.uniforms['uOverride']!.value = overrideTexture;
      rows = capacity;
      dirtyAll = true;
    },
    dispose() {
      target.dispose();
      playTexture.dispose();
      overrideTexture.dispose();
      material.dispose();
      quad.dispose();
    },
  };
}

function rowsTexture(pixels: Float32Array, texels: number, rows: number): DataTexture {
  const texture = new DataTexture(pixels, texels, rows, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function makeTarget(width: number, rows: number): WebGLRenderTarget {
  return new WebGLRenderTarget(width, rows, {
    type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
}
