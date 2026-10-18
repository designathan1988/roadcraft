import {
  DataTexture, NearestFilter, RGBAIntegerFormat, UnsignedIntType, Vector2, Vector4,
  type Material, type WebGLProgramParametersWithUniforms,
} from 'three';
import type { Vec2 } from '@core/vec2';
import type { ChangeJournal, ChangeKind, ChangeRect } from '@world/changes';
import { PLATE_SIZE, plateOf, plateRegion } from '@world/bounds';
import type { ActiveTiles } from './activeTiles';
import {
  DASH, GAP, FLAG_BUTT, FLAG_DASHED, FLAG_LEVEL, FLAG_FILL, FLAG_INSIDE, FLAG_STROKE, LOT_CELL, LotLattice, TEXTURE_WIDTH, TILE_CELLS, type LatticeShape,
} from './lotLattice';

/** DO NOT go back to geometry laid on the ground per lot; DO NOT hand every lot over again when one changes */
export interface LotOverlayInput {
  /** The shapes by group (a lot's, a proposed lot's, the gesture's). */
  readonly groups: ReadonlyMap<string, LotOverlayGroup>;
  /** The groups made, changed or dropped (no longer in `groups`) since `reader` last asked; null: all of them (its first time). */
  changedFor(reader: object): Iterable<string> | null;
}

/** One group's shapes and its place in the drawing order: in each of the polygons, the lines and the dots, a higher rank over a lower. */
export interface LotOverlayGroup extends LotOverlayShapes {
  /** Under `MAX_RANK` (2^29; one over is drawn as the last under it). */
  readonly rank: number;
}

/** A group's rank stays under this: every shape's order is then an exact double. */
const MAX_RANK = 2 ** 29;
/** A shape's order: its band (polygons, lines, dots), its group's rank, its place in the group. */
const BAND = 2 ** 45;
const RANK = 2 ** 16;

/** What is drawn of one group. */
interface LotOverlayShapes {
  readonly polygons: readonly {
    readonly corners: readonly Vec2[];
    readonly fill: number | null;
    readonly fillAlpha: number;
    readonly line: number;
    readonly lineAlpha: number;
    /** Line width, metres on the ground. */
    readonly width: number;
    /** A lot with a building: its yard's paving and paths - the building's own parts, not the ground - are coloured too */
    readonly built?: boolean;
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

/** Half the lattice's smallest frame: a plate and the ring round it (6,144 m a side), over the active region's 3 x 3 tiles wherever its middle is on the plate */
const FRAME_HALF = PLATE_SIZE * 1.5;

/** Half the frame stood on a plate's centre (cx, cy) that holds [x0, y0, x1, y1]: the smallest by whole plates, never one sized to a map */
export function frameHalfFor(cx: number, cy: number, x0: number, y0: number, x1: number, y1: number): number {
  const reach = Math.max(cx - x0, x1 - cx, cy - y0, y1 - cy);
  return Math.max(FRAME_HALF, PLATE_SIZE * (Math.ceil(reach / PLATE_SIZE - 0.5) + 0.5));
}

/** The world's lattice cells each way a level's key holds (`createLotOverlay` `cellKey`): past the world's reach (`world/bounds.ts` WORLD_HALF, 2^25 m) in cells of 8 m. */
const CELL_SHIFT = 2 ** 23;
const CELL_SIDE = 2 * CELL_SHIFT;

/** Shared by every ground material (`applyLotOverlay`), set by the overlay: the lattice's texture and its frame */
const UNIFORMS = {
  uLots: { value: EMPTY },
  uLotsGrid: { value: new Vector4(0, LOT_CELL, Math.ceil((2 * FRAME_HALF) / LOT_CELL), 0) },
  // The lattice's frame's low corner (world x, y): it stands where the lots are (`createLotOverlay`), anywhere on the world.
  uLotsCorner: { value: new Vector2(-FRAME_HALF, -FRAME_HALF) },
  uLotsTiles: { value: Math.ceil(Math.ceil((2 * FRAME_HALF) / LOT_CELL) / TILE_CELLS) },
};

/** The shader's frame set to a lattice's: its corner, its cells and its tiles a side. */
function frameUniforms(lattice: LotLattice): void {
  UNIFORMS.uLotsCorner.value.set(lattice.x0, lattice.y0);
  UNIFORMS.uLotsGrid.value.z = lattice.cellsPerSide;
  UNIFORMS.uLotsTiles.value = lattice.tilesPerSide;
}

/** How far above or below a built lot's ground level a building's level surface is still its yard (metres) */
const LEVEL_REACH = 0.75;
/** A building's surface facing up at least this much (world normal's y): a wall's never is. */
const FACING_UP = 0.9;

const LOT_PARS = /* glsl */ `
  uniform highp usampler2D uLots;
  uniform vec4 uLotsGrid;
  uniform float uLotsTiles;
  uniform vec2 uLotsCorner;
  uvec4 lotTexel(uint a) { return texelFetch(uLots, ivec2(int(a & ${TEXTURE_WIDTH - 1}u), int(a >> ${Math.log2(TEXTURE_WIDTH)}u)), 0); }
  float lotCross(vec2 u, vec2 v) { return u.x * v.y - u.y * v.x; }
  vec3 lotLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
  vec4 lotColour(uint c) {
    vec4 v = vec4(uvec4(c, c >> 8u, c >> 16u, c >> 24u) & 255u) / 255.0;
    return vec4(lotLinear(v.rgb), v.a);
  }
  // The lots over \`base\` at world point w (x, y), dw/dx and dw/dy the
  // pixel's footprint Nehab & Hoppe 2008: parity for inside, the nearest edge's distance scaled to pixels for the
  // \`building\`: a building's level surface at world height \`height\`: only
  // the built lots whose ground level is within LEVEL_REACH of it draw there (the yard's paving, not a flat roof).
  vec3 lotOver(vec3 base, vec2 w, vec2 dx, vec2 dy, float height, bool building) {
    vec2 g = (w - uLotsCorner) / uLotsGrid.y;
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
    // Cell-local, as the edges are stored: the cell's centre is (c + 0.5) cells from the frame's corner.
    vec2 p = (w - uLotsCorner) - (vec2(c) + 0.5) * uLotsGrid.y;
    // Premultiplied, each over the ones before: every fill under every stroke.
    vec4 fills = vec4(0.0), strokes = vec4(0.0);
    for (uint r = 0u; r < count; r++) {
      uvec4 h = lotTexel(at);
      at += 1u;
      uint n = h.z & 1023u;
      uint flags = (h.z >> 10u) & 63u;
      float hw = unpackHalf2x16(h.z >> 16u).x;
      bool levelled = (flags & ${FLAG_LEVEL}u) != 0u;
      float level = 0.0;
      if (levelled) { level = uintBitsToFloat(lotTexel(at).x); at += 1u; }
      if (building && (!levelled || abs(height - level) > ${LEVEL_REACH.toFixed(3)})) { at += n; continue; }
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

/** Makes a material colour the lots into itself */
export function applyLotOverlay(material: Material, options: { readonly world?: string; readonly building?: boolean } = {}): void {
  const { world, building = false } = options;
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  const varying = world ?? 'vLotWorld';
  const declare = `${world ? '' : 'varying vec3 vLotWorld;'}\n${building ? 'varying float vLotUp;' : ''}`;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, UNIFORMS);
    if (!world || building) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${declare}`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          {
            vec4 lotWorld = vec4(transformed, 1.0);
            vec3 lotNormal = objectNormal;
            #ifdef USE_BATCHING
              lotWorld = batchingMatrix * lotWorld;
              lotNormal = mat3(batchingMatrix) * lotNormal;
            #endif
            #ifdef USE_INSTANCING
              lotWorld = instanceMatrix * lotWorld;
              lotNormal = mat3(instanceMatrix) * lotNormal;
            #endif
            ${world ? '' : 'vLotWorld = (modelMatrix * lotWorld).xyz;'}
            // The surface's own normal in the world, not the normal map's:
            // a wall is a wall however its bricks are bumped.
            ${building ? 'vLotUp = normalize(mat3(modelMatrix) * lotNormal).y;' : ''}
          }`);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${declare}\n${LOT_PARS}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if (uLotsGrid.w > 0.5) {
          // World (x, y): three's z is the world's -y.
          vec2 lotW = vec2(${varying}.x, -${varying}.z);
          vec2 lotDx = dFdx(lotW), lotDy = dFdy(lotW);
          ${building
            ? `if (vLotUp > ${FACING_UP.toFixed(2)}) gl_FragColor.rgb = lotOver(gl_FragColor.rgb, lotW, lotDx, lotDy, ${varying}.y, true);`
            : 'gl_FragColor.rgb = lotOver(gl_FragColor.rgb, lotW, lotDx, lotDy, 0.0, false);'}
        }`);
  };
  // Keyed by what the code put in depends on (the varying read, the walls left out), not by the material's name: DO NOT make one program a material of the same shader (the asphalt and the raised asphalt, the kerb and the deck were two each; three r186 runs onBeforeCompile for each material before its program is looked up, so each keeps its own uniforms).
  material.customProgramCacheKey = () => `${previousKey()}-lots-${world ?? 'own'}${building ? '-walls' : ''}`;
}

/** What one shape of a group is, its key: the same key, the same shape; `band` 0 polygons, 1 lines, 2 dots. */
type Keyed = { key: string; band: number; make(order: number): LatticeShape };

/** A group's shapes, keyed, in drawing order: the polygons, then the lines, then the dots. */
function shapesOf(input: LotOverlayShapes, levelOf: (where: string, points: readonly Vec2[]) => number): Keyed[] {
  const out: Keyed[] = [];
  for (const poly of input.polygons) {
    const ring = poly.corners;
    if (ring.length < 3) continue;
    const fill = poly.fill === null ? 0 : rgba(poly.fill, poly.fillAlpha);
    const line = rgba(poly.line, poly.lineAlpha);
    if (!fill && !line) continue;
    const where = ring.map((q) => `${q.x},${q.y}`).join(';');
    const level = poly.built ? levelOf(where, ring) : undefined;
    out.push({
      key: `p|${fill}|${line}|${poly.width}|${level ?? ''}|${where}`, band: 0,
      make: (order) => {
        const edges = new Float64Array(ring.length * 4);
        ring.forEach((q, i) => { const r = ring[(i + 1) % ring.length]!; edges.set([q.x, q.y, r.x, r.y], i * 4); });
        return { edges, fill, line, halfWidth: poly.width / 2, dashed: false, butt: false, order, ...(level === undefined ? {} : { level }) };
      },
    });
  }
  for (const l of input.lines) {
    // A line of no length drew nothing as a ribbon, and draws nothing here.
    if (l.a.x === l.b.x && l.a.y === l.b.y) continue;
    const line = rgba(l.colour, 1);
    // A line or a dot is drawn over a yard's paving too (a lot's front, its arrow)
    const where = `${l.a.x},${l.a.y};${l.b.x},${l.b.y}`;
    const level = levelOf(where, [l.a, l.b]);
    out.push({
      key: `l|${line}|${l.width}|${l.dashed ? 1 : 0}|${level}|${where}`, band: 1,
      make: (order) => ({ edges: Float64Array.of(l.a.x, l.a.y, l.b.x, l.b.y), fill: 0, line, halfWidth: l.width / 2, dashed: l.dashed, butt: true, order, level }),
    });
  }
  for (const d of input.points) {
    const line = rgba(d.colour, 1);
    const where = `${d.p.x},${d.p.y}`;
    const level = levelOf(where, [d.p]);
    out.push({
      key: `o|${line}|${d.radius}|${level}|${where}`, band: 2,
      make: (order) => ({ edges: Float64Array.of(d.p.x, d.p.y, d.p.x, d.p.y), fill: 0, line, halfWidth: d.radius, dashed: false, butt: false, order, level }),
    });
  }
  return out;
}

/** What moves the ground a built lot's level is read from (`surfaceHeightAt`): its level is read again there. */
const GROUND_KINDS: readonly ChangeKind[] = ['terrain', 'roads', 'ground', 'elevation', 'surfaces'];

/** The box round a group's shapes; null for none. */
function groupBox(g: LotOverlayShapes): ChangeRect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (q: Vec2): void => { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); };
  for (const p of g.polygons) for (const q of p.corners) grow(q);
  for (const l of g.lines) { grow(l.a); grow(l.b); }
  for (const d of g.points) grow(d.p);
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

/** `groundAt`: the ground's height (`surfaceHeightAt`), read once for each built lot, at its middle; `active`, the streamed world's active tiles: a group wholly on the kept ring round them is not drawn (`activeTiles.ts`; none, every group). */
export function createLotOverlay(groundAt: (x: number, y: number) => number = () => 0, active?: ActiveTiles) {
  /** The lattice, its frame over the lots drawn (`frameFor`): stood again only when they leave it. */
  let lattice = new LotLattice(FRAME_HALF);
  frameUniforms(lattice);
  let texture: DataTexture | null = null;
  /** The input drawn now, and this overlay's place in its changes (`LotOverlayInput.changedFor`). */
  let shown: LotOverlayInput | null = null;
  const reader = {};
  /** Where the active tiles moved since the last `set`: the groups there laid or taken away. */
  const moves = active?.reader();
  /** Whether a group is laid: one reaching an active tile, whole (a lot astride the region's edge keeps its every shape). */
  const laid = (g: LotOverlayShapes): boolean => {
    if (!active) return true;
    const box = groupBox(g);
    return box === null || active.meets(box);
  };
  /** The shapes in the lattice by group, then by key (a list: the same shape twice is two). */
  let held = new Map<string, Map<string, LatticeShape[]>>();
  /** The diary's serial the levels were read at. */
  let groundSeen = -1;
  /** The ground levels read, by where the shape is: each read once, not on every pointer move of the Zoning tool */
  const levels = new Map<string, number>();
  /** The levels read, and the groups that read them, by the lattice cell of the point they were read at: found by place. */
  const levelsByCell = new Map<number, Set<string>>();
  const groupsByCell = new Map<number, Set<string>>();
  /** A lattice cell's key on the world's own grid of `LOT_CELL` (not the frame's: a level read stays filed when the frame moves). */
  const cellKey = (ix: number, iy: number): number => (ix + CELL_SHIFT) * CELL_SIDE + (iy + CELL_SHIFT);
  const cellOf = (x: number, y: number): number => cellKey(Math.floor(x / LOT_CELL), Math.floor(y / LOT_CELL));
  /** The group whose shapes are being made (`remake`): the one a level read belongs to. */
  let making = '';
  /** A shape's ground level: the ground at its points' mean (a built lot's: under its building, its pad), to the centimetre. */
  const levelOf = (where: string, points: readonly Vec2[]): number => {
    let x = 0, y = 0;
    for (const q of points) { x += q.x; y += q.y; }
    x /= points.length; y /= points.length;
    const cell = cellOf(x, y);
    let groups = groupsByCell.get(cell);
    if (!groups) groupsByCell.set(cell, groups = new Set());
    groups.add(making);
    const known = levels.get(where);
    if (known !== undefined) return known;
    const level = Math.round(groundAt(x, y) * 100) / 100;
    levels.set(where, level);
    let set = levelsByCell.get(cell);
    if (!set) levelsByCell.set(cell, set = new Set());
    set.add(where);
    return level;
  };
  /** The levels read where the ground moved, forgotten: the groups that read them ('all' with no rectangles). */
  const forgetLevels = (entries: readonly { readonly rects: readonly ChangeRect[] | null }[] | null): Set<string> | 'all' => {
    const groups = new Set<string>();
    if (levels.size === 0) return groups;
    if (entries === null || entries.some((e) => e.rects === null)) {
      levels.clear();
      levelsByCell.clear();
      groupsByCell.clear();
      return 'all';
    }
    for (const { rects } of entries) {
      for (const [x0, y0, x1, y1] of rects!) {
        const cx0 = Math.floor(x0 / LOT_CELL), cx1 = Math.floor(x1 / LOT_CELL);
        const cy0 = Math.floor(y0 / LOT_CELL), cy1 = Math.floor(y1 / LOT_CELL);
        const forget = (cell: number): void => {
          const set = levelsByCell.get(cell);
          if (set) { for (const where of set) levels.delete(where); levelsByCell.delete(cell); }
          for (const name of groupsByCell.get(cell) ?? []) groups.add(name);
          groupsByCell.delete(cell);
        };
        if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > groupsByCell.size) {
          // A rectangle of more cells than cells read: the cells read looked at, not its every cell.
          for (const cell of [...groupsByCell.keys()]) {
            const cx = Math.floor(cell / CELL_SIDE) - CELL_SHIFT, cy = (cell % CELL_SIDE) - CELL_SHIFT;
            if (cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1) forget(cell);
          }
          continue;
        }
        for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) forget(cellKey(cx, cy));
      }
    }
    return groups;
  };

  /** A group's shapes laid again (gone when `given` is undefined or not `laid`): a shape with the same key kept as it is. */
  const remake = (name: string, given: LotOverlayGroup | undefined): void => {
    const old = held.get(name);
    const group = given && laid(given) ? given : undefined;
    if (!group) {
      if (old) for (const list of old.values()) for (const shape of list) lattice.remove(shape);
      held.delete(name);
      return;
    }
    making = name;
    const kept = new Map<string, LatticeShape[]>();
    shapesOf(group, levelOf).forEach((s, i) => {
      const order = s.band * BAND + Math.min(group.rank, MAX_RANK - 1) * RANK + i;
      let shape = old?.get(s.key)?.pop();
      // A kept shape in another place of the order: its cells written again, in the new order.
      if (shape && shape.order !== order) { lattice.remove(shape); shape.order = order; lattice.add(shape); }
      if (!shape) { shape = s.make(order); lattice.add(shape); }
      let list = kept.get(s.key);
      if (!list) kept.set(s.key, list = []);
      list.push(shape);
    });
    if (old) for (const list of old.values()) for (const shape of list) lattice.remove(shape);
    if (kept.size) held.set(name, kept); else held.delete(name);
  };

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

  /** Whether a named group laid is not wholly in the frame: only then the frame is stood again over them all (the groups held are in it). */
  const leaves = (input: LotOverlayInput, names: Iterable<string>): boolean => {
    const side = 2 * lattice.half;
    for (const name of names) {
      const g = input.groups.get(name);
      const box = g ? groupBox(g) : null;
      if (!box || (active && !active.meets(box))) continue;
      if (box[0] < lattice.x0 || box[1] < lattice.y0 || box[2] > lattice.x0 + side || box[3] > lattice.y0 + side) return true;
    }
    return false;
  };

  /** The frame stood again over the lots drawn when they left it, on the plate under their middle (`world/bounds.ts`): every shape laid anew in it. */
  const standFrame = (input: LotOverlayInput): boolean => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const g of input.groups.values()) {
      const box = groupBox(g);
      // Over the groups laid only (`laid`): one wholly on the kept ring is not drawn.
      if (!box || (active && !active.meets(box))) continue;
      x0 = Math.min(x0, box[0]); y0 = Math.min(y0, box[1]); x1 = Math.max(x1, box[2]); y1 = Math.max(y1, box[3]);
    }
    if (!(x0 <= x1)) return false;
    const side = 2 * lattice.half;
    if (x0 >= lattice.x0 && y0 >= lattice.y0 && x1 <= lattice.x0 + side && y1 <= lattice.y0 + side) return false;
    const centre = plateRegion(plateOf((x0 + x1) / 2, (y0 + y1) / 2));
    lattice.clear();
    lattice = new LotLattice(frameHalfFor(centre.cx, centre.cy, x0, y0, x1, y1), 16, centre.cx, centre.cy);
    held = new Map();
    frameUniforms(lattice);
    return true;
  };

  return {
    /** The lattice: for the tests, the work an edit cost. */
    get lattice() { return lattice; },
    /** Draws `input` (null: no lots) into the ground from the next frame. */
    set(input: LotOverlayInput | null, changes?: ChangeJournal): void {
      let moved: Set<string> | 'all' = new Set();
      if (changes && changes.version !== groundSeen) {
        const entries = groundSeen < 0 ? null : changes.since(groundSeen, GROUND_KINDS);
        groundSeen = changes.version;
        moved = forgetLevels(entries);
      }
      // The active tiles' moves: nothing to lay while hidden (every group is laid anew when shown again).
      const flipped = moves ? moves.take() : [];
      if (!input) {
        if (!shown && held.size === 0) return;
        shown = null;
        lattice.clear();
        held = new Map();
        UNIFORMS.uLotsGrid.value.w = 0;
        upload();
        return;
      }
      const changed = input.changedFor(reader);
      // Another input than the one drawn, or one that cannot say what changed: every group, a shape with the same key kept.
      const whole = input !== shown || changed === null || moved === 'all' || flipped === null;
      let names: Set<string> | null = null;
      if (!whole) {
        // DO NOT walk every group: only those the input or the ground say changed (it is set every frame, `main.ts` drawOverlayScreen; it walked the whole zoned city's groups each frame to stand its frame).
        names = new Set(changed);
        for (const name of moved) names.add(name);
        // And those of the tiles that came into the active region or left it: a look at each group's box once a tile is crossed, never at a pointer move.
        if (flipped.length) {
          for (const [name, group] of input.groups) {
            const box = groupBox(group);
            if (box && flipped.some((r) => r[0] <= box[2] && r[2] >= box[0] && r[1] <= box[3] && r[3] >= box[1])) names.add(name);
          }
        }
        if (names.size === 0) return;
      }
      // The frame stood again over lots that left it (looked for over every group only when a named one left it): every group laid anew in it.
      const restood = (names === null || leaves(input, names)) && standFrame(input);
      if (names === null || restood) {
        shown = input;
        for (const name of [...held.keys()]) if (!input.groups.has(name)) remake(name, undefined);
        for (const [name, group] of input.groups) remake(name, group);
      } else {
        for (const name of names) remake(name, input.groups.get(name));
      }
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
