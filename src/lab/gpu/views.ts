import {
  AdditiveBlending, AlwaysDepth, NeverDepth, Color, DataTexture, LinearFilter, LinearMipmapLinearFilter, MeshBasicMaterial, NearestFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace,
  type Material, type Scene, type WebGLProgramParametersWithUniforms, type WebGLRenderer,
} from 'three';

/** THE LAB'S DEBUG VIEWS.
 * Overdraw, wireframe and flat normals are drawn with each object's OWN material, changed (`substitute`, called by the probe for every draw of the scene pass): most of the game's materials place their vertices in their own shader code (`onBeforeCompile`, 31 files), which one material over the whole scene (`scene.overrideMaterial`) leaves out - the town vanished under it. The change is a stand-in made with `Object.create(material)` (its uniforms, its textures, its `onBeforeCompile` shared), the fragment's colour replaced at the end of `main`, its program keyed apart (`customProgramCacheKey`).
 * UV and mips need the object's uv in the fragment: one material over the scene (`scene.overrideMaterial`, three r186 `WebGLRenderer.render`), so an object placed by its own shader is missing from them. */

export type DebugView = 'none' | 'overdraw' | 'wireframe' | 'normals' | 'uv' | 'mips';

export const DEBUG_VIEWS: readonly { readonly id: DebugView; readonly label: string; readonly title: string }[] = [
  { id: 'none', label: 'Normal', title: 'The scene with its own materials' },
  { id: 'overdraw', label: 'Overdraw', title: 'Each fragment adds a little colour, with no depth test: the brightest is drawn the most times' },
  { id: 'wireframe', label: 'Wireframe', title: 'The edges of the triangles (each object material in wireframe)' },
  { id: 'normals', label: 'Flat normals', title: 'The normal of each face, from the derivatives of the view position (the one the object shader computed)' },
  { id: 'uv', label: 'UV', title: 'A checker on the texture coordinates (one material over the whole scene: what the object shader places disappears)' },
  { id: 'mips', label: 'Mips', title: 'One colour per mip level, red is level 0 (one material over the whole scene: what the object shader places disappears)' },
];

export interface DebugViews {
  readonly current: DebugView;
  set(view: DebugView): void;
  /** Whether draws are to be substituted (the probe hooked in for it). */
  readonly substituting: boolean;
  /** The material a draw of the scene pass uses under the view (the probe's draw hook); the same when the view changes nothing; null: not drawn (a material whose colour cannot be replaced - a raw shader's sky drawn as itself covered the whole overdraw). */
  substitute(material: Material): Material | null;
  dispose(): void;
}

/** A checker of `size` (a power of two), every mip level given, coloured by its level when `colourLevels`. */
function checkerTexture(size: number, colourLevels: boolean): DataTexture {
  const levels: { data: Uint8Array; width: number; height: number }[] = [];
  const tint = new Color();
  for (let s = size, level = 0; s >= 1; s >>= 1, level++) {
    const data = new Uint8Array(s * s * 4);
    tint.setHSL(Math.min(0.7, level * 0.1), 1, 0.5);
    const cell = Math.max(1, s / 8);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const dark = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 0.55 : 1;
        const i = (y * s + x) * 4;
        data[i] = (colourLevels ? tint.r : 1) * dark * 255;
        data[i + 1] = (colourLevels ? tint.g : 1) * dark * 255;
        data[i + 2] = (colourLevels ? tint.b : 1) * dark * 255;
        data[i + 3] = 255;
      }
    }
    levels.push({ data, width: s, height: s });
  }
  const texture = new DataTexture(levels[0]!.data, size, size, RGBAFormat);
  // Levels given: uploaded as they are, none generated (three r186 `WebGLTextures` with `mipmaps` on a DataTexture).
  texture.mipmaps = levels as unknown as typeof texture.mipmaps;
  texture.generateMipmaps = false;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = colourLevels ? LinearFilter : NearestFilter;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.name = colourLevels ? 'lab:mips' : 'lab:uv';
  texture.needsUpdate = true;
  return texture;
}

/** `code` put at the very end of the shader's `main` (its last brace). */
const atEnd = (shader: string, code: string): string => {
  const end = shader.lastIndexOf('}');
  return end < 0 ? shader : `${shader.slice(0, end)}\n${code}\n${shader.slice(end)}`;
};
const OVERDRAW = 'gl_FragColor = vec4(0.12, 0.05, 0.015, 1.0);';
const NORMAL = 'gl_FragColor = vec4(normalize(cross(dFdx(vLabView), dFdy(vLabView))) * 0.5 + 0.5, 1.0);';
const VIEW_POSITION = '{ vec4 labView = inverse(projectionMatrix) * gl_Position; vLabView = labView.xyz / labView.w; }';

/** Whether a material's fragment can be recoloured: three's own GLSL (where gl_FragColor is defined), one output. */
function recolourable(material: Material): boolean {
  const m = material as Material & { isRawShaderMaterial?: boolean; glslVersion?: string | null; fragmentShader?: string };
  if (m.isRawShaderMaterial || m.glslVersion === '300 es') return false;
  return !m.fragmentShader?.includes('layout(');
}

export function createDebugViews(scene: Scene, reversedDepth: boolean, changed: (view: DebugView) => void): DebugViews {
  const overrides = new Map<DebugView, Material>();
  const textures: DataTexture[] = [];
  /** The stand-ins of the current view, by the material they stand for. */
  let standIns = new WeakMap<Material, Material>();
  let made: Material[] = [];
  let current: DebugView = 'none';
  let before: Material | null = null;

  const override = (view: DebugView): Material | null => {
    if (view !== 'uv' && view !== 'mips') return null;
    const known = overrides.get(view);
    if (known) return known;
    const texture = checkerTexture(view === 'uv' ? 256 : 512, view === 'mips');
    textures.push(texture);
    const m = new MeshBasicMaterial({ map: texture });
    m.name = `lab:${view}`;
    overrides.set(view, m);
    return m;
  };

  const standIn = (original: Material, view: DebugView): Material => {
    const m = Object.create(original) as Material;
    // Its own listeners: three's `dispose` listener of the stand-in is not put on the original's.
    (m as unknown as { _listeners: unknown })._listeners = {};
    m.name = `${original.name}:lab-${view}`;
    if (view === 'wireframe') {
      (m as Material & { wireframe: boolean }).wireframe = true;
      return m;
    }
    const compile = original.onBeforeCompile;
    const key = original.customProgramCacheKey;
    m.customProgramCacheKey = () => `${key.call(original)}|lab:${view}`;
    if (view === 'overdraw') {
      m.blending = AdditiveBlending;
      m.transparent = true;
      // Every fragment passes, its depth still written (the last one's): the chain's passes read the scene's depth, and with none the clouds' pass painted the air over every pixel. DO NOT turn the test off for it: with the depth test disabled the depth buffer is not written (OpenGL ES 3.0, 4.1.5).
      m.depthTest = true;
      // r186 `WebGLState` maps every depth function to its reverse on a reversed depth buffer (`ReversedDepthFuncs`: Always to Never): Never asked there to get Always.
      m.depthFunc = reversedDepth ? NeverDepth : AlwaysDepth;
      m.depthWrite = true;
    }
    m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, gl: WebGLRenderer) => {
      compile.call(original, shader, gl);
      if (view === 'overdraw') { shader.fragmentShader = atEnd(shader.fragmentShader, OVERDRAW); return; }
      // The view position from the clip position the shader wrote, whatever code placed the vertex (the game's own included).
      shader.vertexShader = `varying vec3 vLabView;\n${atEnd(shader.vertexShader, VIEW_POSITION)}`;
      shader.fragmentShader = `varying vec3 vLabView;\n${atEnd(shader.fragmentShader, NORMAL)}`;
    };
    return m;
  };

  const dropStandIns = (): void => {
    // Their programs let go (three's `dispose` listener on each).
    for (const m of made) m.dispose();
    made = [];
    standIns = new WeakMap();
  };

  const views: DebugViews = {
    get current() { return current; },
    get substituting() { return current === 'overdraw' || current === 'wireframe' || current === 'normals'; },
    set(view) {
      if (view === current) return;
      const mine = overrides.get(current) ?? null;
      // The scene's own override kept: put back when ours goes (null as a rule).
      if (!mine || scene.overrideMaterial !== mine) before = scene.overrideMaterial;
      dropStandIns();
      current = view;
      scene.overrideMaterial = override(view) ?? before;
      changed(view);
    },
    substitute(material) {
      if (!views.substituting) return material;
      if (current !== 'wireframe' && !recolourable(material)) return null;
      let m = standIns.get(material);
      if (!m) {
        m = standIn(material, current);
        standIns.set(material, m);
        made.push(m);
      }
      return m;
    },
    dispose() {
      views.set('none');
      for (const m of overrides.values()) m.dispose();
      for (const t of textures) t.dispose();
      overrides.clear();
    },
  };
  return views;
}
