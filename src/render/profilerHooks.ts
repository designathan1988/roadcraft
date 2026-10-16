import { BufferGeometry, Material, Texture, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { profiler } from '@core/profiler';

/** The profiler's hooks into three and WebGL (`core/profiler.ts`) */
/** Set on `BufferGeometry.prototype` once the prototypes are wrapped: they are wrapped once. */
const HOOKED = Symbol('profiler hooks');

export function hookProfiler(renderer: WebGLRenderer): void {
  const marked = BufferGeometry.prototype as unknown as Record<symbol, boolean>;
  if (marked[HOOKED]) return;
  marked[HOOKED] = true;
  wrap(BufferGeometry.prototype, 'dispose', () => profiler.count('dispose.geometry'));
  wrap(Material.prototype, 'dispose', () => profiler.count('dispose.material'));
  wrap(Texture.prototype, 'dispose', () => profiler.count('dispose.texture'));
  wrap(WebGLRenderTarget.prototype, 'dispose', () => profiler.count('dispose.target'));

  // A geometry is built when it is first given its positions.
  const built = new WeakSet<BufferGeometry>();
  const setAttribute = BufferGeometry.prototype.setAttribute;
  BufferGeometry.prototype.setAttribute = function (this: BufferGeometry, name, attribute) {
    if (name === 'position' && !built.has(this)) { built.add(this); profiler.count('build.geometry'); }
    return setAttribute.call(this, name, attribute);
  } as typeof setAttribute;

  // What goes to the GPU, on this renderer's context only.
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const bytesOf = (data: unknown): number => (data && typeof data === 'object' && 'byteLength' in data ? Number((data as ArrayBufferView).byteLength) : typeof data === 'number' ? data : 0);
  const bufferData = gl.bufferData.bind(gl) as (...a: unknown[]) => void;
  (gl as unknown as { bufferData: (...a: unknown[]) => void }).bufferData = (...a: unknown[]): void => {
    // Closed (the HUD hidden, the default): nothing worked out per call.
    if (profiler.enabled) profiler.count('upload.buffer', bytesOf(a[1]));
    bufferData(...a);
  };
  const bufferSubData = gl.bufferSubData.bind(gl) as (...a: unknown[]) => void;
  (gl as unknown as { bufferSubData: (...a: unknown[]) => void }).bufferSubData = (...a: unknown[]): void => {
    if (!profiler.enabled) { bufferSubData(...a); return; }
    const view = a[2] as ArrayBufferView | undefined;
    const length = typeof a[4] === 'number' && view && 'BYTES_PER_ELEMENT' in view ? a[4] * Number((view as Float32Array).BYTES_PER_ELEMENT) : bytesOf(view);
    profiler.count('upload.buffer', length);
    bufferSubData(...a);
  };
  for (const name of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'compressedTexImage2D'] as const) {
    const original = (gl[name] as (...a: unknown[]) => void).bind(gl);
    (gl as unknown as Record<string, (...a: unknown[]) => void>)[name] = (...a: unknown[]): void => {
      if (!profiler.enabled) { original(...a); return; }
      // The pixels' bytes: a typed array's own, or an image's width × height as RGBA8.
      const source = a.find((v) => v !== null && typeof v === 'object');
      const bytes = source === undefined ? 0 : ArrayBuffer.isView(source) ? source.byteLength
        : 'width' in source && 'height' in source ? Number(source.width) * Number(source.height) * 4 : 0;
      profiler.count('upload.texture', bytes);
      original(...a);
    };
  }
}

function wrap<T extends object, K extends keyof T>(proto: T, key: K, before: () => void): void {
  const original = proto[key] as unknown as (...a: unknown[]) => unknown;
  (proto as Record<K, unknown>)[key] = function (this: unknown, ...a: unknown[]) {
    before();
    return original.apply(this, a);
  };
}
