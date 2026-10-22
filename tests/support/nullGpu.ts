import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CompressedArrayTexture, CompressedTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat, RepeatWrapping,
  SRGBColorSpace, UnsignedByteType, WebGLRenderer, type CompressedPixelFormat, type WebGLRendererParameters,
} from 'three';
import { read } from 'three/examples/jsm/libs/ktx-parse.module.js';

import { primeSurfaceTextures } from '@render/surfaceTextures';

/**
 * A GPU THAT DRAWS NOTHING: three's own WebGLRenderer, whole, on a WebGL2 context that takes every call and does nothing with it.
 * Everything three does on the CPU runs as in the game (the render lists, the culling, the programs' parameters, the shadow passes, the
 * render targets, `info.render.calls` and `triangles`); only the GPU is missing. The same way the three.js forum feeds a context of its
 * own to the renderer (`new WebGLRenderer({ context })`, discourse.threejs.org "unit testing with headless-gl and WebGL 2"), without
 * a native GL: the context is a Proxy (MDN `WebGL2RenderingContext`), its constants numbered by name, its queries answered as a
 * WebGL2 GPU would (three r186 `WebGLCapabilities`, `WebGLState`, `WebGLExtensions`, `WebGLProgram`).
 * The extensions a timer or a parallel compile would use are ABSENT (`EXT_disjoint_timer_query_webgl2`, `KHR_parallel_shader_compile`):
 * the GPU timer stands down, and every program is ready at once (three's `compileAsync` resolves on its first check).
 */

/** A WebGL2 constant's number by name: the same name, the same number, every run (insertion order is the order three asks). */
const constants = new Map<string, number>();
const names = new Map<number, string>();
/** Real values where three or the game compare with literals or do arithmetic on them. */
const KNOWN: Record<string, number> = {
  NO_ERROR: 0, NONE: 0, ZERO: 0, ONE: 1, FALSE: 0, TRUE: 1,
  POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
  TEXTURE0: 0x84c0,
  FLOAT: 0x1406, INT: 0x1404, UNSIGNED_INT: 0x1405, BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403, HALF_FLOAT: 0x140b,
};
function constant(name: string): number {
  let value = constants.get(name);
  if (value === undefined) {
    value = KNOWN[name] ?? 0x20000 + constants.size;
    constants.set(name, value);
    if (!names.has(value)) names.set(value, name);
  }
  return value;
}

/** What a WebGL2 GPU answers `getParameter` with, by the constant's name. */
const PARAMETERS: Record<string, unknown> = {
  VERSION: 'WebGL 2.0 (null GPU)',
  SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 3.00 (null GPU)',
  VENDOR: 'Roadcraft', RENDERER: 'Null GPU', UNMASKED_RENDERER_WEBGL: 'Null GPU', UNMASKED_VENDOR_WEBGL: 'Roadcraft',
  MAX_TEXTURE_SIZE: 16384, MAX_CUBE_MAP_TEXTURE_SIZE: 16384, MAX_RENDERBUFFER_SIZE: 16384, MAX_3D_TEXTURE_SIZE: 2048,
  MAX_ARRAY_TEXTURE_LAYERS: 2048, MAX_TEXTURE_IMAGE_UNITS: 16, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
  MAX_VERTEX_ATTRIBS: 16, MAX_VERTEX_UNIFORM_VECTORS: 4096, MAX_FRAGMENT_UNIFORM_VECTORS: 1024, MAX_VARYING_VECTORS: 30,
  MAX_SAMPLES: 4, SAMPLES: 4, MAX_DRAW_BUFFERS: 8, MAX_COLOR_ATTACHMENTS: 8, MAX_UNIFORM_BUFFER_BINDINGS: 72,
  MAX_UNIFORM_BLOCK_SIZE: 65536, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 16, MAX_VIEWPORT_DIMS: new Int32Array([16384, 16384]),
  UNIFORM_BUFFER_OFFSET_ALIGNMENT: 256, MAX_CLIENT_WAIT_TIMEOUT_WEBGL: 0,
  UNPACK_ROW_LENGTH: 0, UNPACK_IMAGE_HEIGHT: 0, UNPACK_SKIP_PIXELS: 0, UNPACK_SKIP_ROWS: 0, UNPACK_SKIP_IMAGES: 0, UNPACK_ALIGNMENT: 4,
};

/** The extensions this GPU has: the float targets, anisotropy, the renderer's name. No timer, no parallel compile (see above). */
const EXTENSIONS = [
  'EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_float_blend', 'OES_texture_float_linear',
  'EXT_texture_filter_anisotropic', 'WEBGL_debug_renderer_info', 'WEBGL_lose_context', 'EXT_texture_norm16',
  // The reversed depth buffer the scene asks for (`reversedDepthBuffer`, three r186 `WebGLCapabilities.reversedDepthBuffer`).
  'EXT_clip_control',
];

/** An object whose every upper-case property is a constant and every other a function that does nothing. */
function extensionObject(): object {
  return new Proxy({ loseContext() {}, restoreContext() {} }, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in target) return (target as Record<string, unknown>)[key];
      return /^[A-Z0-9_]+$/.test(key) ? constant(key) : () => undefined;
    },
  });
}

interface NullCanvasLike { width: number; height: number }

/** A WebGL2 context on `canvas` that accepts every call and draws nothing. */
export function nullWebGl2(canvas: NullCanvasLike, attributes: WebGLContextAttributes = {}): WebGL2RenderingContext {
  const contextAttributes = {
    alpha: attributes.alpha ?? true, antialias: attributes.antialias ?? true, depth: attributes.depth ?? true,
    stencil: attributes.stencil ?? false, premultipliedAlpha: true, preserveDrawingBuffer: false,
    powerPreference: attributes.powerPreference ?? 'default', failIfMajorPerformanceCaveat: false, desynchronized: false,
  };
  const extensions = new Map<string, object>();
  let handles = 0;
  const handle = (): object => ({ nullGpuHandle: ++handles });
  const methods: Record<string, (...args: never[]) => unknown> = {
    getContextAttributes: () => contextAttributes,
    isContextLost: () => false,
    getError: () => 0,
    getParameter: (p: number) => {
      const name = names.get(p) ?? '';
      if (name === 'VIEWPORT' || name === 'SCISSOR_BOX') return new Int32Array([0, 0, canvas.width, canvas.height]);
      if (name === 'IMPLEMENTATION_COLOR_READ_FORMAT') return constant('RGBA');
      if (name === 'IMPLEMENTATION_COLOR_READ_TYPE') return constant('UNSIGNED_BYTE');
      return PARAMETERS[name] ?? 0;
    },
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    getSupportedExtensions: () => [...EXTENSIONS],
    getExtension: (name: string) => {
      if (!EXTENSIONS.includes(name)) return null;
      let extension = extensions.get(name);
      if (!extension) extensions.set(name, extension = extensionObject());
      return extension;
    },
    // Every compile and link succeeds, and a program has no active attribute or uniform to look up.
    getShaderParameter: () => true,
    getProgramParameter: (_program: never, p: number) => {
      const name = names.get(p) ?? '';
      return name === 'ACTIVE_UNIFORMS' || name === 'ACTIVE_ATTRIBUTES' || name === 'ACTIVE_UNIFORM_BLOCKS' ? 0 : true;
    },
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getShaderSource: () => '',
    getAttribLocation: () => -1,
    getUniformLocation: () => null,
    getUniformBlockIndex: () => 0xffffffff,
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'),
    clientWaitSync: () => constant('CONDITION_SATISFIED'),
    getSyncParameter: () => constant('SIGNALED'),
    getQueryParameter: () => 0,
    getInternalformatParameter: () => new Int32Array([4]),
    isEnabled: () => false,
    isProgram: () => true,
    isShader: () => true,
    isTexture: () => true,
    isBuffer: () => true,
    isFramebuffer: () => true,
  };
  const target = { canvas, get drawingBufferWidth() { return canvas.width; }, get drawingBufferHeight() { return canvas.height; }, drawingBufferColorSpace: 'srgb' };
  return new Proxy(target, {
    get(t, key) {
      if (typeof key !== 'string') return undefined;
      if (key in t) return (t as Record<string, unknown>)[key];
      if (/^[A-Z0-9_]+$/.test(key)) return constant(key);
      const method = methods[key];
      if (method) return method;
      // Every object made (buffers, textures, programs, framebuffers, queries, syncs, vertex arrays) is a handle of its own.
      if (key.startsWith('create') || key === 'fenceSync') return handle;
      return () => undefined;
    },
    set() { return true; },
  }) as unknown as WebGL2RenderingContext;
}

/** The renderer the scene is given in place of three's on a real GPU (`createSceneRenderer`'s `makeRenderer`): three's own, on the null context. */
export function nullRenderer(parameters: WebGLRendererParameters): WebGLRenderer {
  const canvas = parameters.canvas as unknown as NullCanvasLike;
  const attributes: WebGLContextAttributes = {
    alpha: parameters.alpha ?? false, antialias: parameters.antialias ?? false, depth: parameters.depth ?? true,
    stencil: parameters.stencil ?? false, powerPreference: parameters.powerPreference ?? 'default',
  };
  return new WebGLRenderer({ ...parameters, context: nullWebGl2(canvas, attributes) });
}

/** A 2D context that draws nothing (the textures the game paints: signs, soot, leaves). */
function null2d(canvas: NullCanvasLike): CanvasRenderingContext2D {
  const gradient = { addColorStop() {} };
  const methods: Record<string, (...args: never[]) => unknown> = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createConicGradient: () => gradient,
    createPattern: () => ({ setTransform() {} }),
    measureText: (text: string) => ({ width: String(text).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: String(text).length * 6, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    createImageData: (w: number | ImageData, h?: number) => {
      const width = typeof w === 'number' ? w : w.width, height = typeof w === 'number' ? h ?? 1 : w.height;
      return { width, height, data: new Uint8ClampedArray(Math.max(1, width * height * 4)) };
    },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    isPointInPath: () => false,
    getLineDash: () => [],
  };
  const state: Record<string, unknown> = { canvas };
  return new Proxy(state, {
    get(t, key) {
      if (typeof key !== 'string') return undefined;
      if (key in t) return t[key];
      return methods[key] ?? (() => undefined);
    },
    set(t, key, value) { if (typeof key === 'string') t[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

/** A canvas: a size, a style, listeners kept nowhere, and the null contexts. */
export class NullCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  readonly style: Record<string, string> = {};
  private context2d: CanvasRenderingContext2D | null = null;
  private gl: WebGL2RenderingContext | null = null;
  constructor(width = 300, height = 150) {
    this.width = width;
    this.height = height;
    this.clientWidth = width;
    this.clientHeight = height;
  }
  getContext(kind: string, attributes?: WebGLContextAttributes): unknown {
    if (kind === '2d') return (this.context2d ??= null2d(this));
    if (kind === 'webgl2') return (this.gl ??= nullWebGl2(this, attributes));
    return null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean { return true; }
  setAttribute(): void {}
  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number; x: number; y: number } {
    return { left: 0, top: 0, x: 0, y: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight };
  }
  toDataURL(): string { return 'data:,'; }
  toBlob(done: (blob: Blob | null) => void): void { done(null); }
  transferToImageBitmap(): object { return { width: this.width, height: this.height, close() {} }; }
}

/** An image: loaded at once (a turn later), one pixel, its texels never read (SMAA's lookup tables, three's `ImageLoader`). */
export class NullImage {
  width = 1;
  height = 1;
  naturalWidth = 1;
  naturalHeight = 1;
  complete = false;
  crossOrigin: string | null = null;
  decoding = 'auto';
  onload: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  private source = '';
  get src(): string { return this.source; }
  set src(value: string) {
    this.source = value;
    setTimeout(() => {
      this.complete = true;
      const event = { type: 'load', target: this };
      this.onload?.(event);
      for (const listener of this.listeners.get('load') ?? []) listener(event);
    }, 0);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }
  decode(): Promise<void> { return Promise.resolve(); }
}

/** The page's globals the scene reads, as light as they come; `restore` puts back what was there.
 *  `root`: the project, where a fetch of the page's own address (`/cooked/...`, `/public/models/...`, `/models/...`) reads its file. */
export function installNullPage(width: number, height: number, root: string): { restore(): void } {
  const g = globalThis as Record<string, unknown>;
  const kept = new Map<string, unknown>();
  const put = (key: string, value: unknown): void => {
    if (!kept.has(key)) kept.set(key, Object.getOwnPropertyDescriptor(g, key));
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
  };
  const element = (): object => ({ style: {}, appendChild() {}, removeChild() {}, remove() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {}, toggle() {} } });
  put('document', {
    createElement: (tag: string) => (tag === 'canvas' ? new NullCanvas() : tag === 'img' ? new NullImage() : element()),
    createElementNS: (_ns: string, tag: string) => (tag === 'canvas' ? new NullCanvas() : tag === 'img' ? new NullImage() : element()),
    addEventListener() {}, removeEventListener() {},
    body: element(), documentElement: element(), hidden: false, visibilityState: 'visible',
  });
  // The window: the page's size and listeners kept nowhere; anything else (the timers) the global's own.
  const own: Record<string, unknown> = { innerWidth: width, innerHeight: height, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  put('window', new Proxy(own, { get: (t, key) => (typeof key === 'string' && key in t ? t[key] : (g as Record<string | symbol, unknown>)[key]) }));
  put('OffscreenCanvas', NullCanvas);
  put('Image', NullImage);
  // The page's own files read from the project, as the dev server serves them (the root, then `public/`); anything else is the network's.
  const networkFetch = globalThis.fetch;
  put('fetch', (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('/')) return networkFetch(input, init);
    const path = decodeURIComponent(url.split(/[?#]/)[0]!);
    for (const file of [join(root, path), join(root, 'public', path)]) {
      if (existsSync(file) && statSync(file).isFile()) return Promise.resolve(new Response(readFileSync(file)));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  // A path the 2D context fills: nothing kept (`lowPolyTrees.ts` leaves).
  put('Path2D', class { moveTo() {} lineTo() {} quadraticCurveTo() {} bezierCurveTo() {} arc() {} ellipse() {} rect() {} closePath() {} addPath() {} });
  return {
    restore() {
      for (const [key, descriptor] of kept) {
        if (descriptor) Object.defineProperty(g, key, descriptor as PropertyDescriptor);
        else delete g[key];
      }
    },
  };
}

/**
 * The baked surfaces (`cooked/surfaces`, as `surfaceBakeClient.ts` reads them) put in place before the scene is made, as `main.ts`
 * primes them: each file's header read for its size, its levels and its layers, its texels never decoded - the null GPU reads none.
 * The same names, kinds (a layered texture or not), sizes and settings the game's materials are made with.
 */
export function primeCookedSurfaces(root: string): void {
  const folder = join(root, 'cooked', 'surfaces');
  const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as { textures: { name: string; file: string; use: string }[] };
  const format = RGBAFormat as unknown as CompressedPixelFormat;
  const loaded = new Map<string, CompressedTexture>();
  for (const entry of manifest.textures) {
    const container = read(new Uint8Array(readFileSync(join(folder, entry.file))));
    const width = container.pixelWidth, height = container.pixelHeight;
    const mipmaps = container.levels.map((_level, i) => ({ data: new Uint8Array(4), width: Math.max(1, width >> i), height: Math.max(1, height >> i) }));
    const texture = container.layerCount > 1
      ? new CompressedArrayTexture(mipmaps, width, height, container.layerCount, format, UnsignedByteType)
      : new CompressedTexture(mipmaps, width, height, format, UnsignedByteType);
    texture.colorSpace = entry.use === 'color' ? SRGBColorSpace : NoColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = false;
    texture.name = entry.name;
    texture.needsUpdate = true;
    loaded.set(entry.name, texture);
  }
  // Texels let go are never asked back: the null GPU uploads nothing.
  primeSurfaceTextures(loaded, () => {});
}
