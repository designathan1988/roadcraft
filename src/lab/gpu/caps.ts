import type { WebGLRenderer } from 'three';

/** THE CONTEXT'S CAPABILITIES: its limits (`getParameter`, the WebGL 2 names), its extensions (`getSupportedExtensions`), its attributes (`getContextAttributes`) and what three r186 made of them (`renderer.capabilities`). */

export interface CapRow {
  readonly group: string;
  readonly name: string;
  readonly value: string;
}

const LIMITS = [
  'MAX_TEXTURE_SIZE', 'MAX_3D_TEXTURE_SIZE', 'MAX_ARRAY_TEXTURE_LAYERS', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_VIEWPORT_DIMS',
  'MAX_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_TEXTURE_IMAGE_UNITS', 'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_ATTRIBS', 'MAX_VERTEX_UNIFORM_VECTORS',
  'MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS', 'MAX_UNIFORM_BLOCK_SIZE', 'MAX_VERTEX_UNIFORM_BLOCKS', 'MAX_FRAGMENT_UNIFORM_BLOCKS',
  'MAX_COMBINED_UNIFORM_BLOCKS', 'MAX_UNIFORM_BUFFER_BINDINGS', 'MAX_DRAW_BUFFERS', 'MAX_COLOR_ATTACHMENTS', 'MAX_SAMPLES', 'MAX_ELEMENTS_VERTICES',
  'MAX_ELEMENTS_INDICES', 'MAX_TEXTURE_LOD_BIAS', 'MAX_ELEMENT_INDEX', 'MAX_SERVER_WAIT_TIMEOUT', 'ALIASED_LINE_WIDTH_RANGE', 'ALIASED_POINT_SIZE_RANGE',
  'SAMPLES', 'DEPTH_BITS', 'STENCIL_BITS', 'RED_BITS', 'ALPHA_BITS', 'VERSION', 'SHADING_LANGUAGE_VERSION', 'VENDOR', 'RENDERER',
] as const;

const show = (v: unknown): string => (v === null || v === undefined ? '—' : ArrayBuffer.isView(v) ? `[${Array.from(v as unknown as ArrayLike<number>).join(', ')}]` : String(v));

export function readCapabilities(renderer: WebGLRenderer): CapRow[] {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const rows: CapRow[] = [];
  const glNames = gl as unknown as Record<string, number>;
  for (const name of LIMITS) {
    const id = glNames[name];
    if (id === undefined) continue;
    rows.push({ group: 'limite', name, value: show(gl.getParameter(id)) });
  }
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  if (debug) {
    rows.push({ group: 'driver', name: 'UNMASKED_VENDOR', value: show(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) });
    rows.push({ group: 'driver', name: 'UNMASKED_RENDERER', value: show(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) });
  }
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (aniso) rows.push({ group: 'limite', name: 'MAX_TEXTURE_MAX_ANISOTROPY', value: show(gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) });
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; TIMESTAMP_EXT: number; QUERY_COUNTER_BITS_EXT: number } | null;
  if (timer) {
    rows.push({ group: 'limite', name: 'QUERY_COUNTER_BITS (TIME_ELAPSED)', value: show(gl.getQuery(timer.TIME_ELAPSED_EXT, timer.QUERY_COUNTER_BITS_EXT)) });
    rows.push({ group: 'limite', name: 'QUERY_COUNTER_BITS (TIMESTAMP)', value: show(gl.getQuery(timer.TIMESTAMP_EXT, timer.QUERY_COUNTER_BITS_EXT)) });
  }
  for (const [name, value] of Object.entries(gl.getContextAttributes() ?? {})) rows.push({ group: 'atributo', name, value: show(value) });
  for (const name of (gl.getSupportedExtensions() ?? []).sort()) rows.push({ group: 'extensão', name, value: 'sim' });
  const caps = renderer.capabilities as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(caps)) if (typeof value !== 'function') rows.push({ group: 'three', name, value: show(value) });
  rows.push({ group: 'three', name: 'pixelRatio', value: show(renderer.getPixelRatio()) });
  rows.push({ group: 'three', name: 'drawingBuffer', value: `${gl.drawingBufferWidth}×${gl.drawingBufferHeight}` });
  return rows;
}
