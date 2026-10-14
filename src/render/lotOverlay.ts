import {
  DataTexture, NearestFilter, RGBAIntegerFormat, UnsignedIntType, Vector4,
  type Material, type WebGLProgramParametersWithUniforms,
} from 'three';
import type { Vec2 } from '@core/vec2';
import { MAP_HALF } from '@world/bounds';
import {
  DASH, GAP, FLAG_BUTT, FLAG_DASHED, FLAG_FILL, FLAG_INSIDE, FLAG_STROKE, LOT_CELL, LotLattice, TEXTURE_WIDTH, TILE_CELLS, type LatticeShape,
} from './lotLattice';

/**
 * The lots drawn in the scene (`world/lots.ts`, the Zoning tool, and the
 * faint zones with the other tools): coloured into the ground by the
 * ground's own shaders - the terrain, the footways, the kerbs, the verges,
 * the carriageways (`applyLotOverlay`) - from the lots as vector shapes in a
 * lattice (`lotLattice.ts`; Nehab & Hoppe 2008, random-access vector
 * graphics). A pixel of the ground finds its 8 m cell and colours itself
 * from the few shapes listed there: exact at every distance (no texture to
 * pixelate up close or blur), on the ground wherever it drew itself (no
 * lift to float over a slope or sink into it), antialiased by its distance
 * to the nearest edge, and outlines of a constant width in metres.
 *
 * Only the shapes that changed are written again: each is keyed by what it
 * is, and the lattice rewrites the cells it touches. Nothing samples the
 * ground, so a road, a pad or a stroke of the terrain brush redraws no lot.
 *
 * DO NOT go back to geometry laid on the ground per lot (a triangulation
 * subdivided to 3 m with `groundAt` at every vertex): 3.5 million vertices
 * built on the CPU for a town of 1 500 lots, 1.3 s that was then spread over
 * frames (`LAY_SLICE_MS`, a slice of 12 ms a frame) - the cost hidden, not
 * removed (OTIMIZACAO.md item 20).
 */
export interface LotOverlayInput {
  /** Changes whenever anything drawn changes. */
  readonly key: string;
  readonly polygons: readonly {
    readonly corners: readonly Vec2[];
    readonly fill: number | null;
    readonly fillAlpha: number;
    readonly line: number;
    readonly lineAlpha: number;
    /** Line width, metres on the ground. */
    readonly width: number;
  }[];
  readonly lines: readonly { readonly a: Vec2; readonly b: Vec2; readonly colour: number; readonly dashed: boolean; readonly width: number }[];
  readonly points: readonly { readonly p: Vec2; readonly colour: number; readonly radius: number }[];
}

/** A colour (0xRRGGBB, sRGB) and an alpha as the lattice keeps them: RGBA8, red lowest. */
function rgba(colour: number, alpha: number): number {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  if (a === 0) return 0;
  return ((colour >> 16) & 255 | (((colour >> 8) & 255) << 8) | ((colour & 255) << 16) | (a << 24)) >>> 0;
}

/** The lattice's texture when there is nothing: an integer texture still, for the `usampler2D`. */
const EMPTY = new DataTexture(new Uint32Array(4), 1, 1, RGBAIntegerFormat, UnsignedIntType);
EMPTY.internalFormat = 'RGBA32UI';
EMPTY.needsUpdate = true;

/**
 * Shared by every ground material (`applyLotOverlay`), set by the overlay:
 * the lattice's texture and its frame - x the map's half, y the cell, z the
 * cells a side, w on (1) or off (0).
 */
const UNIFORMS = {
  uLots: { value: EMPTY },
  uLotsGrid: { value: new Vector4(MAP_HALF, LOT_CELL, Math.ceil((2 * MAP_HALF) / LOT_CELL), 0) },
  uLotsTiles: { value: Math.ceil(Math.ceil((2 * MAP_HALF) / LOT_CELL) / TILE_CELLS) },
};

const LOT_PARS = /* glsl */ `
  uniform highp usampler2D uLots;
  uniform vec4 uLotsGrid;
  uniform float uLotsTiles;
  uvec4 lotTexel(uint a) { return texelFetch(uLots, ivec2(int(a & ${TEXTURE_WIDTH - 1}u), int(a >> ${Math.log2(TEXTURE_WIDTH)}u)), 0); }
  float lotCross(vec2 u, vec2 v) { return u.x * v.y - u.y * v.x; }
  vec3 lotLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
  vec4 lotColour(uint c) {
    vec4 v = vec4(uvec4(c, c >> 8u, c >> 16u, c >> 24u) & 255u) / 255.0;
    return vec4(lotLinear(v.rgb), v.a);
  }
  // The lots over \`base\` at world point w (x, y), dw/dx and dw/dy the
  // pixel's footprint (Nehab & Hoppe 2008: parity for inside, the nearest
  // edge's distance scaled to pixels for the antialiased edge and the stroke).
  vec3 lotOver(vec3 base, vec2 w, vec2 dx, vec2 dy) {
    vec2 g = (w + uLotsGrid.x) / uLotsGrid.y;
    if (any(lessThan(g, vec2(0.0))) || any(greaterThanEqual(g, vec2(uLotsGrid.z)))) return base;
    ivec2 c = ivec2(g);
    ivec2 t = c / ${TILE_CELLS};
    int tile = t.y * int(uLotsTiles) + t.x;
    uint block = lotTexel(uint(tile >> 2))[tile & 3];
    if (block == 0u) return base;
    int local = (c.y - t.y * ${TILE_CELLS}) * ${TILE_CELLS} + (c.x - t.x * ${TILE_CELLS});
    uint entry = lotTexel(block + uint(local >> 2))[local & 3];
    uint count = entry & 255u;
    if (count == 0u) return base;
    uint at = entry >> 8u;
    if (count == 255u) { count = lotTexel(at).x; at += 1u; }
    // Cell-local, as the edges are stored: the cell's centre is (c + 0.5) cells from the map's corner.
    vec2 p = (w + uLotsGrid.x) - (vec2(c) + 0.5) * uLotsGrid.y;
    // Premultiplied, each over the ones before: every fill under every stroke.
    vec4 fills = vec4(0.0), strokes = vec4(0.0);
    for (uint r = 0u; r < count; r++) {
      uvec4 h = lotTexel(at);
      at += 1u;
      uint n = h.z & 2047u;
      uint flags = (h.z >> 11u) & 31u;
      float hw = unpackHalf2x16(h.z >> 16u).x;
      if ((flags & ${FLAG_BUTT}u) != 0u) {
        // A line with square ends, as a ribbon: across, the band of its
        // width; along, cut at its ends - or at its dash's (dashes of
        // ${DASH} m every ${DASH + GAP} m from its start).
        uvec4 q = lotTexel(at);
        at += n;
        vec2 a = uintBitsToFloat(q.xy), ab = uintBitsToFloat(q.zw) - a;
        float len = length(ab);
        vec2 u = ab / len, nrm = vec2(-u.y, u.x);
        float along = dot(p - a, u), across = abs(dot(p - a, nrm));
        float lo = 0.0, hi = len;
        if ((flags & ${FLAG_DASHED}u) != 0u) {
          float d0 = floor(along / ${(DASH + GAP).toFixed(4)}) * ${(DASH + GAP).toFixed(4)};
          float next = d0 + ${(DASH + GAP).toFixed(4)};
          float d1 = d0 + ${DASH.toFixed(4)};
          if (along > d1 && next < len && next - along < along - d1) { d0 = next; d1 = next + ${DASH.toFixed(4)}; }
          lo = max(d0, 0.0); hi = min(d1, len);
        }
        float mppN = max(length(vec2(dot(dx, nrm), dot(dy, nrm))), 1e-6);
        float mppU = max(length(vec2(dot(dx, u), dot(dy, u))), 1e-6);
        float ds = across / mppN, ws = hw / mppN;
        vec4 s = lotColour(h.y);
        float cover = (smoothstep(-1.0, 1.0, ws - ds) - smoothstep(-1.0, 1.0, -ws - ds))
          * smoothstep(-1.0, 1.0, min(along - lo, hi - along) / mppU) * s.a;
        strokes = vec4(s.rgb * cover, cover) + strokes * (1.0 - cover);
        continue;
      }
      vec2 ref = unpackHalf2x16(h.w);
      bool inside = (flags & ${FLAG_INSIDE}u) != 0u;
      float best = 1e9;
      vec2 dir = vec2(1.0, 0.0);
      vec2 rp = p - ref;
      for (uint e = 0u; e < n; e++) {
        uvec4 q = lotTexel(at + e);
        vec2 a = uintBitsToFloat(q.xy), b = uintBitsToFloat(q.zw);
        vec2 ab = b - a;
        // The way from the reference to the pixel crossing this edge flips the side.
        if (((lotCross(ab, ref - a) > 0.0) != (lotCross(ab, p - a) > 0.0)) && ((lotCross(rp, a - ref) > 0.0) != (lotCross(rp, b - ref) > 0.0))) inside = !inside;
        float len2 = dot(ab, ab);
        float s = len2 > 0.0 ? clamp(dot(p - a, ab) / len2, 0.0, 1.0) : 0.0;
        vec2 v = p - (a + ab * s);
        float d = length(v);
        if (d < best) {
          best = d;
          dir = d > 1e-5 ? v / d : (len2 > 0.0 ? normalize(vec2(-ab.y, ab.x)) : vec2(1.0, 0.0));
        }
      }
      at += n;
      // Metres a pixel across, along the way to the nearest edge (the Jacobian of the view).
      float mpp = max(length(vec2(dot(dx, dir), dot(dy, dir))), 1e-6);
      if ((flags & ${FLAG_FILL}u) != 0u) {
        vec4 f = lotColour(h.x);
        float cover = smoothstep(-1.0, 1.0, (inside ? best : -best) / mpp) * f.a;
        fills = vec4(f.rgb * cover, cover) + fills * (1.0 - cover);
      }
      if ((flags & ${FLAG_STROKE}u) != 0u) {
        // An outline (round at its corners) or a dot.
        vec4 s = lotColour(h.y);
        float ds = best / mpp, ws = hw / mpp;
        float cover = (smoothstep(-1.0, 1.0, ws - ds) - smoothstep(-1.0, 1.0, -ws - ds)) * s.a;
        strokes = vec4(s.rgb * cover, cover) + strokes * (1.0 - cover);
      }
    }
    base = base * (1.0 - fills.a) + fills.rgb;
    return base * (1.0 - strokes.a) + strokes.rgb;
  }
`;

/**
 * Makes a ground material colour the lots into itself: chained after
 * whatever it already does to its shader, its colour blended right after
 * the lighting (`opaque_fragment`), so the lots are unlit paint over the lit
 * ground as the transparent sheets of before were, before tone mapping and
 * fog. `world`: a varying of the material already holding the world
 * position (the terrain's `vTerrainAtlas`), or a varying of its own.
 */
export function applyLotOverlay(material: Material, key: string, world?: string): void {
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  const varying = world ?? 'vLotWorld';
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, UNIFORMS);
    if (!world) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLotWorld;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          {
            vec4 lotWorld = vec4(transformed, 1.0);
            #ifdef USE_BATCHING
              lotWorld = batchingMatrix * lotWorld;
            #endif
            #ifdef USE_INSTANCING
              lotWorld = instanceMatrix * lotWorld;
            #endif
            vLotWorld = (modelMatrix * lotWorld).xyz;
          }`);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${world ? '' : 'varying vec3 vLotWorld;'}\n${LOT_PARS}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if (uLotsGrid.w > 0.5) {
          // World (x, y): three's z is the world's -y.
          vec2 lotW = vec2(${varying}.x, -${varying}.z);
          gl_FragColor.rgb = lotOver(gl_FragColor.rgb, lotW, dFdx(lotW), dFdy(lotW));
        }`);
  };
  material.customProgramCacheKey = () => `${previousKey()}-lots-${key}`;
}

/** What one shape of the input is, its key: the same key, the same shape. */
type Keyed = { key: string; make(order: number): LatticeShape };

/** The input's shapes, keyed, in drawing order: the polygons, then the lines, then the dots. */
function shapesOf(input: LotOverlayInput): Keyed[] {
  const out: Keyed[] = [];
  for (const poly of input.polygons) {
    const ring = poly.corners;
    if (ring.length < 3) continue;
    const fill = poly.fill === null ? 0 : rgba(poly.fill, poly.fillAlpha);
    const line = rgba(poly.line, poly.lineAlpha);
    if (!fill && !line) continue;
    out.push({
      key: `p|${fill}|${line}|${poly.width}|${ring.map((q) => `${q.x},${q.y}`).join(';')}`,
      make: (order) => {
        const edges = new Float64Array(ring.length * 4);
        ring.forEach((q, i) => { const r = ring[(i + 1) % ring.length]!; edges.set([q.x, q.y, r.x, r.y], i * 4); });
        return { edges, fill, line, halfWidth: poly.width / 2, dashed: false, butt: false, order };
      },
    });
  }
  for (const l of input.lines) {
    // A line of no length drew nothing as a ribbon, and draws nothing here.
    if (l.a.x === l.b.x && l.a.y === l.b.y) continue;
    const line = rgba(l.colour, 1);
    out.push({
      key: `l|${line}|${l.width}|${l.dashed ? 1 : 0}|${l.a.x},${l.a.y};${l.b.x},${l.b.y}`,
      make: (order) => ({ edges: Float64Array.of(l.a.x, l.a.y, l.b.x, l.b.y), fill: 0, line, halfWidth: l.width / 2, dashed: l.dashed, butt: true, order }),
    });
  }
  for (const d of input.points) {
    const line = rgba(d.colour, 1);
    out.push({
      key: `o|${line}|${d.radius}|${d.p.x},${d.p.y}`,
      make: (order) => ({ edges: Float64Array.of(d.p.x, d.p.y, d.p.x, d.p.y), fill: 0, line, halfWidth: d.radius, dashed: false, butt: false, order }),
    });
  }
  return out;
}

export function createLotOverlay() {
  const lattice = new LotLattice(MAP_HALF);
  let texture: DataTexture | null = null;
  let key = '';
  /** The shapes in the lattice by key (a list: the same shape twice is two). */
  let held = new Map<string, LatticeShape[]>();

  /** The lattice's writes sent to its texture: in place, or a texture of the new size. */
  const upload = (): void => {
    const { whole, ranges } = lattice.takeUpload();
    const rows = lattice.rows;
    if (!texture || texture.image.height !== rows) {
      texture?.dispose();
      texture = new DataTexture(lattice.data, TEXTURE_WIDTH, rows, RGBAIntegerFormat, UnsignedIntType);
      texture.internalFormat = 'RGBA32UI';
      texture.minFilter = NearestFilter;
      texture.magFilter = NearestFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      UNIFORMS.uLots.value = texture;
      return;
    }
    // A compaction left the size and replaced the array: sent whole.
    texture.image.data = lattice.data;
    if (whole) { texture.clearUpdateRanges(); texture.needsUpdate = true; return; }
    if (!ranges.length) return;
    for (let i = 0; i < ranges.length; i += 2) texture.addUpdateRange(ranges[i]!, ranges[i + 1]!);
    texture.needsUpdate = true;
  };

  return {
    /** The lattice: for the tests, the work an edit cost. */
    lattice,
    /** Draws `input` (null: no lots) into the ground from the next frame. */
    set(input: LotOverlayInput | null): void {
      const next = input?.key ?? '';
      if (next === key) return;
      key = next;
      if (!input) {
        lattice.clear();
        held = new Map();
        UNIFORMS.uLotsGrid.value.w = 0;
        upload();
        return;
      }
      const shapes = shapesOf(input);
      const kept = new Map<string, LatticeShape[]>();
      shapes.forEach((s, order) => {
        const old = held.get(s.key);
        let shape = old?.pop();
        if (shape) shape.order = order;
        else { shape = s.make(order); lattice.add(shape); }
        let list = kept.get(s.key);
        if (!list) kept.set(s.key, list = []);
        list.push(shape);
      });
      for (const list of held.values()) for (const shape of list) lattice.remove(shape);
      held = kept;
      lattice.flush();
      UNIFORMS.uLotsGrid.value.w = lattice.size > 0 ? 1 : 0;
      upload();
    },
    dispose(): void {
      lattice.clear();
      if (texture) { texture.dispose(); texture = null; }
      UNIFORMS.uLots.value = EMPTY;
      UNIFORMS.uLotsGrid.value.w = 0;
    },
  };
}
