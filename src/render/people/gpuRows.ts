import {
  BufferGeometry, DataTexture, Float32BufferAttribute, FloatType, GLSL3, Mesh, NearestFilter, NoBlending, OrthographicCamera,
  RGBAFormat, Scene, ShaderMaterial, Vector2, WebGLRenderTarget, type Texture, type WebGLRenderer,
} from 'three';

/** A float RGBA texture of rows kept on the GPU only: rows go up as they are written, no CPU image of the whole */

/** What is waiting for the next `flush`: rows sent up, or rows copied from one place of the texture to another. */
type Step =
  | { readonly kind: 'write'; readonly row: number; readonly data: Float32Array }
  | { readonly kind: 'copy'; readonly from: number; readonly to: number; readonly count: number };

export interface GpuRows {
  /** The texture the shaders read (another one after `grow`). */
  readonly texture: Texture;
  readonly rows: number;
  /** Texels a row. */
  readonly width: number;
  readonly bytes: number;
  /** `data` (`width * 4` floats a row; a short last row is padded) up at `row`, at the next `flush`. */
  write(row: number, data: Float32Array): void;
  /** `count` rows from `from` copied to `to` on the GPU, at the next `flush`. */
  copy(from: number, to: number, count: number): void;
  /** Room for `rows` rows; the rows on the GPU are carried over there at the next `flush`. */
  grow(rows: number): void;
  /** Every waiting step done, in the order asked. */
  flush(renderer: WebGLRenderer): void;
  /** The GPU's copy is gone (a WebGL context restored): nothing is carried over, the owner writes every row again. */
  reset(): void;
  dispose(): void;
}

let copier: { scene: Scene; camera: OrthographicCamera; material: ShaderMaterial } | null = null;
let warmed = false;
/** One quad drawn into a float target: each texel read from `uFrom`, `uShift` rows lower (made once, shared). */
function copyPass(): NonNullable<typeof copier> {
  if (copier) return copier;
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { uFrom: { value: null }, uShift: { value: 0 } },
    vertexShader: /* glsl */`
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
      precision highp float;
      precision highp int;
      precision highp sampler2D;
      uniform sampler2D uFrom;
      uniform int uShift;
      out highp vec4 outColor;
      void main() {
        ivec2 at = ivec2(gl_FragCoord.xy);
        outColor = texelFetch(uFrom, ivec2(at.x, at.y - uShift), 0);
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
  copier = { scene, camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1), material };
  return copier;
}

function makeTarget(width: number, rows: number): WebGLRenderTarget {
  return new WebGLRenderTarget(width, Math.max(1, rows), {
    type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
}

/** Rows `0..count` of `from` drawn into `into` at row `at` (a quad: exact, float in, float out). */
function drawRows(renderer: WebGLRenderer, from: Texture, into: WebGLRenderTarget, fromRow: number, at: number, count: number): void {
  const pass = copyPass();
  pass.material.uniforms['uFrom']!.value = from;
  pass.material.uniforms['uShift']!.value = at - fromRow;
  into.viewport.set(0, at, into.width, count);
  renderer.setRenderTarget(into);
  renderer.render(pass.scene, pass.camera);
}

/** Whole rows of `width` texels from `data` (its last row padded with zeros). */
export function wholeRows(data: Float32Array, width: number): Float32Array {
  const row = width * 4;
  if (data.length % row === 0 && data.length > 0) return data;
  const out = new Float32Array(Math.max(1, Math.ceil(data.length / row)) * row);
  out.set(data);
  return out;
}

export function createGpuRows(width: number, rows: number): GpuRows {
  let target = makeTarget(width, rows);
  let height = rows;
  /** Whether `target` holds rows on the GPU (flushed into since it was made). */
  let filled = false;
  /** The target grown from, its rows still to be carried over, and how many. */
  let carry: { target: WebGLRenderTarget; rows: number } | null = null;
  /** A target for a copy inside the texture (one cannot be read and drawn into at once). */
  let scratch: WebGLRenderTarget | null = null;
  const steps: Step[] = [];
  const at = new Vector2();

  return {
    get texture() { return target.texture; },
    get rows() { return height; },
    width,
    get bytes() { return width * height * 16; },
    write(row, data) {
      steps.push({ kind: 'write', row, data: wholeRows(data, width) });
    },
    copy(from, to, count) {
      if (from !== to && count > 0) steps.push({ kind: 'copy', from, to, count });
    },
    grow(next) {
      if (next <= height) return;
      // The first target grown from is the one on the GPU; one made since and never flushed holds nothing.
      if (filled && !carry) carry = { target, rows: height };
      else if (target !== carry?.target) target.dispose();
      target = makeTarget(width, next);
      height = next;
      filled = false;
    },
    flush(renderer) {
      if (!carry && !steps.length) return;
      const previous = renderer.getRenderTarget();
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      // The copy's program built with the first rows sent (the crowd's opening), not at the first growth or twin.
      renderer.initRenderTarget(target);
      // Compiled with a float target set: three keys a program by its target (no tone mapping, linear output).
      if (!warmed) { const pass = copyPass(); renderer.setRenderTarget(target); renderer.compile(pass.scene, pass.camera); warmed = true; }
      if (carry) {
        drawRows(renderer, carry.target.texture, target, 0, 0, carry.rows);
        carry.target.dispose();
        carry = null;
      }
      for (const step of steps) {
        if (step.kind === 'write') {
          // A texture never on the GPU is sent from its own data (WebGLRenderer.copyTextureToTexture, the texSubImage2D branch).
          const rowsOf = step.data.length / (width * 4);
          renderer.copyTextureToTexture(new DataTexture(step.data, width, rowsOf, RGBAFormat, FloatType), target.texture, null, at.set(0, step.row));
        } else {
          if (!scratch || scratch.height < step.count) { scratch?.dispose(); scratch = makeTarget(width, step.count); }
          renderer.initRenderTarget(scratch);
          drawRows(renderer, target.texture, scratch, step.from, 0, step.count);
          drawRows(renderer, scratch.texture, target, 0, step.to, step.count);
        }
      }
      steps.length = 0;
      filled = true;
      renderer.setRenderTarget(previous);
      renderer.autoClear = autoClear;
    },
    reset() {
      carry?.target.dispose();
      carry = null;
      steps.length = 0;
      filled = false;
    },
    dispose() {
      carry?.target.dispose();
      carry = null;
      scratch?.dispose();
      scratch = null;
      target.dispose();
      steps.length = 0;
    },
  };
}
