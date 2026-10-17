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
import { compilePassAhead } from '../uploads';

/** A crowd's animation on the GPU, as GPU Gems 3, chapter 2 ("Animated Crowd Rendering") lays it out */

/** Texels a bone takes in the animation texture (twelve floats). */
const ATLAS_TEXELS = 3;
/** Plays blended per person in the palette pass (a rider's are four). */
const PLAYS = 4;
/** Texels of a person's row of plays: one a play, then (variant, override, resting); a placed pass's, then the person's matrix (`setPlace`). */
const PLAY_TEXELS = PLAYS + 1;
const PLACE_TEXELS = 4;

export interface ClassAnimation {
  /** Frames of every clip, a row each: `bones * 3` texels across (a new texture once `add` outgrew the room it had). */
  readonly atlas: DataTexture;
  /** A clip's first row in the atlas. */
  rowOf(clip: string): number;
  readonly bones: number;
  /** The atlas's bytes on the GPU. */
  readonly bytes: number;
  /** The atlas's texels made again from the clips and sent up (a WebGL context restored); only for a `gpuOnly` atlas. */
  refill(): void;
  /** A clip baked later laid in after the others, its first row returned: in the room left, only its rows sent up; past it, the room doubled (never for a `gpuOnly` atlas). */
  add(name: string, clip: ClipFrames): number;
}

/** The class's clips in one texture, in the order given; `gpuOnly` lets the texels go once they are on the GPU (the clips keep them). */
export function buildClassAnimation(clips: Readonly<Record<string, ClipFrames>>, bones: number, gpuOnly = false, room = 0): ClassAnimation {
  const packed = bones * PACKED_BONE_FLOATS;
  const rowsOf = (clip: ClipFrames): number => Math.round(clip.data.length / packed);
  let rows = 0;
  const start = new Map<string, number>();
  const laid = new Map<string, ClipFrames>(Object.entries(clips));
  for (const [name, clip] of laid) { start.set(name, rows); rows += rowsOf(clip); }
  const width = bones * ATLAS_TEXELS;
  // `room` rows more than the clips take: the clips baked later go in there (`add`).
  let height = Math.max(1, rows + room);
  // Twelve floats a bone are exactly three RGBA texels: each row is the clip's frame as baked.
  const texels = (): Float32Array => {
    const pixels = new Float32Array(width * 4 * height);
    for (const [name, clip] of laid) pixels.set(clip.data.subarray(0, rowsOf(clip) * packed), start.get(name)! * width * 4);
    return pixels;
  };
  const made = (): DataTexture => {
    const texture = new DataTexture(texels(), width, height, RGBAFormat, FloatType);
    texture.minFilter = texture.magFilter = NearestFilter;
    texture.needsUpdate = true;
    return texture;
  };
  let atlas = made();
  // DO NOT keep the texels: three uploads them once (WebGLTextures.js uploadTexture, then onUpdate), a restore refills them.
  if (gpuOnly) atlas.onUpdate = () => { (atlas.image as { data: Float32Array | null }).data = null; };
  return {
    get atlas() { return atlas; },
    rowOf: (clip) => start.get(clip) ?? 0, bones,
    get bytes() { return width * height * 16; },
    refill() {
      if (!gpuOnly) return;
      (atlas.image as { data: Float32Array | null }).data = texels();
      atlas.needsUpdate = true;
    },
    add(name, clip) {
      if (gpuOnly) throw new Error('a GPU-only atlas keeps no texels to add a clip to');
      const known = start.get(name);
      if (known !== undefined) return known;
      const n = rowsOf(clip);
      const first = rows;
      laid.set(name, clip);
      start.set(name, first);
      rows += n;
      if (rows > height) {
        // Out of room: twice as many rows, the clips laid in again (each clip once, as a vector doubling).
        height = Math.max(rows, height * 2);
        atlas.dispose();
        atlas = made();
        return first;
      }
      // In the room left: its rows written and only they sent up (a range a row, `WebGLTextures.js`).
      (atlas.image.data as Float32Array).set(clip.data.subarray(0, n * packed), first * width * 4);
      for (let r = first; r < first + n; r++) atlas.addUpdateRange(r * width * 4, width * 4);
      atlas.needsUpdate = true;
      return first;
    },
  };
}

/** A packed bone of row `row` as a mat4 (GLSL), from a sampler named `atlas`. */
function atlasBoneGlsl(name: string, atlas: string): string {
  return `
mat4 ${name}(int row, int bone) {
  vec4 a = texelFetch(${atlas}, ivec2(bone * ${ATLAS_TEXELS}, row), 0);
  vec4 b = texelFetch(${atlas}, ivec2(bone * ${ATLAS_TEXELS} + 1, row), 0);
  vec4 c = texelFetch(${atlas}, ivec2(bone * ${ATLAS_TEXELS} + 2, row), 0);
  return mat4(vec4(a.xyz, 0.0), vec4(a.w, b.xy, 0.0), vec4(b.zw, c.x, 0.0), vec4(c.yzw, 1.0));
}`;
}

/** The first pass: a texel a column of a bone of a person, its plays blended (GPU Gems 3, ch. 2); a person at rest or with a palette of their own, nothing. */
export const BLEND_FRAGMENT = /* glsl */`
  precision highp float;
  precision highp int;
  precision highp sampler2D;
  uniform sampler2D uAtlas;
  uniform sampler2D uPlays;
  out highp vec4 outColor;
  ${atlasBoneGlsl('atlasBone', 'uAtlas')}
  void main() {
    ivec2 at = ivec2(gl_FragCoord.xy);
    int bone = at.x / 4;
    int column = at.x - bone * 4;
    int person = at.y;
    vec4 meta = texelFetch(uPlays, ivec2(PLAYS, person), 0);
    if (meta.z > 0.5 || meta.y > 0.5) { outColor = vec4(0.0); return; }
    mat4 m = mat4(0.0);
    for (int k = 0; k < PLAYS; k++) {
      vec4 p = texelFetch(uPlays, ivec2(k, person), 0);
      if (p.z <= 0.0) continue;
      int r = int(p.x + 0.5);
      m += p.z * ((1.0 - p.y) * atlasBone(r, bone) + p.y * atlasBone(r + 1, bone));
    }
    outColor = m[column];
  }`;

/** The second pass: each bone's blend read back (`uBlend`), moved to this body's joints by its parents' blends read back too, never blended again. */
export const REFIT_FRAGMENT = /* glsl */`
  precision highp float;
  precision highp int;
  precision highp sampler2D;
  uniform sampler2D uPlays;
  uniform sampler2D uJoints;
  uniform sampler2D uOverride;
  uniform sampler2D uBlend;
  uniform int uParent[BONES];
  out highp vec4 outColor;
  mat4 blendedAt(int person, int bone) {
    return mat4(texelFetch(uBlend, ivec2(bone * 4, person), 0), texelFetch(uBlend, ivec2(bone * 4 + 1, person), 0),
      texelFetch(uBlend, ivec2(bone * 4 + 2, person), 0), texelFetch(uBlend, ivec2(bone * 4 + 3, person), 0));
  }
  mat3 turnAt(int person, int bone) {
    return mat3(texelFetch(uBlend, ivec2(bone * 4, person), 0).xyz, texelFetch(uBlend, ivec2(bone * 4 + 1, person), 0).xyz,
      texelFetch(uBlend, ivec2(bone * 4 + 2, person), 0).xyz);
  }
  vec3 jointOf(int variant, int bone) { return texelFetch(uJoints, ivec2(bone, variant), 0).xyz; }
  void main() {
    ivec2 at = ivec2(gl_FragCoord.xy);
    int bone = at.x / 4;
    int column = at.x - bone * 4;
    int person = at.y;
    vec4 meta = texelFetch(uPlays, ivec2(PLAYS, person), 0);
    if (meta.z > 0.5) { outColor = vec4(0.0); return; }
    #ifdef PLACED
    // The person's matrix (setPlace): the palette is the bones where the person stands, their pieces drawn without a matrix of their own.
    mat4 place = mat4(texelFetch(uPlays, ivec2(PLAYS + 1, person), 0), texelFetch(uPlays, ivec2(PLAYS + 2, person), 0),
      texelFetch(uPlays, ivec2(PLAYS + 3, person), 0), texelFetch(uPlays, ivec2(PLAYS + 4, person), 0));
    if (meta.y > 0.5) {
      mat4 own = mat4(texelFetch(uOverride, ivec2(bone * 4, person), 0), texelFetch(uOverride, ivec2(bone * 4 + 1, person), 0),
        texelFetch(uOverride, ivec2(bone * 4 + 2, person), 0), texelFetch(uOverride, ivec2(bone * 4 + 3, person), 0));
      outColor = (place * own)[column];
      return;
    }
    #else
    if (meta.y > 0.5) { outColor = texelFetch(uOverride, at, 0); return; }
    #endif
    int variant = int(meta.x + 0.5);
    mat4 m = blendedAt(person, bone);
    // The bone moved to this body's joints (proceduralCrowd.ts refit): its head carried by every parent's turn up to the root.
    vec3 shift = vec3(0.0);
    int cur = bone;
    for (int s = 0; s < MAX_DEPTH; s++) {
      int p = uParent[cur];
      if (p < 0) break;
      shift += turnAt(person, p) * (jointOf(variant, cur) - jointOf(variant, p));
      cur = p;
    }
    shift += jointOf(variant, cur);
    m[3].xyz += shift - mat3(m) * jointOf(variant, bone);
    #ifdef PLACED
    m = place * m;
    #endif
    outColor = m[column];
  }`;

/** One play of a person in the palette pass: an atlas row, the fraction to the next row, its weight. */
interface PalettePlay {
  readonly row: number;
  readonly t: number;
  readonly weight: number;
}

export interface PalettePass {
  /** The bone palettes, a row a person (`bones * 4` texels: mat4 columns), for the skinning to read. */
  readonly texture: Texture;
  readonly capacity: number;
  /** Settles once its program is built (`uploads.ts` compilePassAhead): nobody draws with its palettes before. */
  readonly ready: Promise<void>;
  /** A placed pass (`createPalettePass` placed): person `row`'s matrix this frame, column-major, the bones written where they stand. */
  setPlace(row: number, matrix: ArrayLike<number>): void;
  /** What person `row` plays this frame, the body variant whose joints they have; null plays: a palette of their own (`setOverride`). */
  setPlays(row: number, plays: readonly PalettePlay[] | null, variant: number): void;
  /** Person `row` is not drawn this frame: their row is not blended. */
  rest(row: number): void;
  /** A palette worked out on the CPU for a person (held by a ragdoll, wounded, a limb lost). */
  setOverride(row: number, palette: Float32Array): void;
  /** Rows 0..`rows` worked out on the GPU. */
  render(renderer: WebGLRenderer, rows: number): void;
  /** Room for `capacity` rows; the rows written so far are kept. */
  grow(capacity: number): void;
  dispose(): void;
}

/** The palette pass of a body class: a quad drawn into a float target, a texel a column of a bone of a person; `placed`: each person's matrix applied too (`setPlace`). */
export function createPalettePass(anim: ClassAnimation, parent: Int16Array, joints: () => Texture, capacity: number, placed = false): PalettePass {
  const rowTexels = PLAY_TEXELS + (placed ? PLACE_TEXELS : 0);
  const bones = anim.bones;
  const width = bones * 4;
  let depth = 0;
  for (let i = 0; i < bones; i++) {
    let d = 0, j = parent[i]!;
    while (j >= 0) { d++; j = parent[j]!; }
    depth = Math.max(depth, d);
  }
  let rows = capacity;
  let plays = new Float32Array(rowTexels * 4 * rows);
  let playTexture = rowsTexture(plays, rowTexels, rows);
  let override = new Float32Array(width * 4 * rows);
  let overrideTexture = rowsTexture(override, width, rows);
  let target = makeTarget(width, rows);
  /** Each bone's plays blended, before the refit (`BLEND_FRAGMENT`): the refit reads a parent's turn here instead of blending it again. */
  let blendTarget = makeTarget(width, rows);
  /** Rows of plays written since the last upload; past a few, the whole (small) texture goes up at once. */
  const dirty = new Set<number>();
  let dirtyAll = false;
  const overrideRows = new Set<number>();

  const uniforms = {
    uAtlas: { value: anim.atlas },
    uPlays: { value: playTexture },
    uJoints: { value: joints() },
    uOverride: { value: overrideTexture },
    uParent: { value: Array.from(parent) },
    uBlend: { value: blendTarget.texture },
  };
  const defines: Record<string, number | string> = { BONES: bones, MAX_DEPTH: Math.max(1, depth), PLAYS };
  if (placed) defines['PLACED'] = '';
  const pass = (fragmentShader: string): ShaderMaterial => new ShaderMaterial({
    glslVersion: GLSL3, defines, uniforms, fragmentShader, blending: NoBlending, depthTest: false, depthWrite: false,
    vertexShader: /* glsl */`
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  });
  // Two passes: each bone's plays blended once a person, then each bone refitted from its parents' blends read back.
  const blend = pass(BLEND_FRAGMENT);
  const refit = pass(REFIT_FRAGMENT);
  const quad = new BufferGeometry();
  quad.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const sceneOf = (material: ShaderMaterial): Scene => {
    const mesh = new Mesh(quad, material);
    mesh.frustumCulled = false;
    return new Scene().add(mesh);
  };
  const blendScene = sceneOf(blend), refitScene = sceneOf(refit);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  // DO NOT build them at their first draw: a loop over every bone's parents, a second and more in the frame where the first person of a class came (2026-10-16).
  const ready = Promise.all([compilePassAhead(blendScene, camera, blendTarget), compilePassAhead(refitScene, camera, target)]).then(() => {});

  return {
    ready,
    get texture() { return target.texture; },
    get capacity() { return rows; },
    setPlace(row, matrix) {
      const o = (row * rowTexels + PLAY_TEXELS) * 4;
      for (let i = 0; i < 16; i++) plays[o + i] = matrix[i]!;
      dirty.add(row);
    },
    setPlays(row, list, variant) {
      const o = row * rowTexels * 4;
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
      const o = row * rowTexels * 4 + PLAYS * 4 + 2;
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
      uniforms.uJoints.value = joints();
      // The atlas a clip baked later may have doubled (`ClassAnimation.add`): the pass reads the one there is now.
      uniforms.uAtlas.value = anim.atlas;
      if (dirtyAll || dirty.size) {
        // Each update range is one row of the image in three (WebGLTextures.js)
        playTexture.clearUpdateRanges();
        if (!dirtyAll && dirty.size <= 8) for (const row of dirty) playTexture.addUpdateRange(row * rowTexels * 4, rowTexels * 4);
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
      blendTarget.viewport.set(0, 0, width, n);
      renderer.setRenderTarget(blendTarget);
      renderer.render(blendScene, camera);
      target.viewport.set(0, 0, width, n);
      renderer.setRenderTarget(target);
      renderer.render(refitScene, camera);
      renderer.setRenderTarget(previous);
      renderer.autoClear = autoClear;
    },
    grow(capacity) {
      if (capacity <= rows) return;
      const nextPlays = new Float32Array(rowTexels * 4 * capacity);
      nextPlays.set(plays);
      plays = nextPlays;
      playTexture.dispose();
      playTexture = rowsTexture(plays, rowTexels, capacity);
      const nextOverride = new Float32Array(width * 4 * capacity);
      nextOverride.set(override);
      override = nextOverride;
      overrideTexture.dispose();
      overrideTexture = rowsTexture(override, width, capacity);
      target.dispose();
      target = makeTarget(width, capacity);
      blendTarget.dispose();
      blendTarget = makeTarget(width, capacity);
      uniforms.uPlays.value = playTexture;
      uniforms.uOverride.value = overrideTexture;
      uniforms.uBlend.value = blendTarget.texture;
      rows = capacity;
      dirtyAll = true;
    },
    dispose() {
      target.dispose();
      blendTarget.dispose();
      playTexture.dispose();
      overrideTexture.dispose();
      blend.dispose();
      refit.dispose();
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
