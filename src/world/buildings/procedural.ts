import type { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { m, stepsIn } from '../units';
import type { BlueprintBody } from './blueprints';
import { type ArchStyle, type Era, type GroundRole, STYLES, composeFacades, paintsOf, stoneBaseOf, styleFor } from './architecture';
import { Model, mat } from './cityBuildings';
import { elementClash } from './elements';
import { GENERIC_SLAB, type MaterialSpec } from './materials';
import { type BayComponent, type Building, type BuildingElement, type BuildingFunction, type RoofKind, type Volume, MIN_PITCH } from './types';

/** Buildings made to measure for a lot, never the same twice. */

export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** What the eye tells two buildings apart by. */
export interface Signature {
  /** The form of the mass (`house:ell`, `flats:u`, `office:setback`...). */
  readonly form: string;
  /** The main wall colour, 0xRRGGBB. */
  readonly colour: number;
  /** The main roof: its kind and colour. */
  readonly roof: string;
  /** Storeys of the tallest block. */
  readonly storeys: number;
}

export interface MadeBuilding {
  /** What the eye tells two buildings apart by: the form of the mass, its wall colour, its roof, its height. */
  readonly signature: Signature;
  readonly fn: BuildingFunction;
  readonly body: BlueprintBody;
  /** The front door's middle, metres along the front from the envelope's left. */
  readonly entrance: number;
  /** A back door's middle (metres from the envelope's left), when it has one. */
  readonly backDoor?: number;
  /** Parts of the envelope it leaves open (metres, envelope frame). */
  readonly free: Rect[];
}

/** What the lot asks of the building. */
export interface Envelope {
  /** Width and depth, metres. */
  readonly W: number;
  readonly D: number;
  /** Where the front door should be (metres from the left), if the lot has a path to it. */
  readonly door?: number;
  /** The yard or car park behind wants a back door. */
  readonly backDoor?: boolean;
  /** The street's family of materials (one per street side), so a street reads as one. */
  readonly character?: number;
  /** The side the lot's drive runs down, if it has one: a garage goes beside it. */
  readonly driveSide?: 'left' | 'right';
  /** Storeys of the buildings either side, if any: a block steps towards them instead of towering over a house. */
  readonly neighbours?: readonly number[];
  /** The era of the quarter the lot is in (`architecture.ts` `Era`): the family of styles its buildings are drawn from. */
  readonly era?: Era;
}

const pickOf = <T>(rng: Rng, list: readonly T[]): T => list[rng.int(0, list.length - 1)] as T;
const between = (rng: Rng, a: number, b: number): number => a + (b - a) * rng.float();
/** Rounds to the 0.5 m the Builder's grid uses. */
const half = (x: number): number => Math.round(x * 2) / 2;

// ---------------------------------------------------------------- colour schemes

/** A colour nudged in hue, saturation and lightness, a little */
function nudge(colour: number, rng: Rng, amount = 1): number {
  const r = ((colour >> 16) & 255) / 255, g = ((colour >> 8) & 255) / 255, b = (colour & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  const h2 = (h + (rng.float() - 0.5) * 0.03 * amount + 1) % 1;
  const s2 = Math.max(0, Math.min(1, s + (rng.float() - 0.5) * 0.1 * amount));
  const l2 = Math.max(0.05, Math.min(0.96, l + (rng.float() - 0.5) * 0.08 * amount));
  const q = l2 < 0.5 ? l2 * (1 + s2) : l2 + s2 - l2 * s2, p = 2 * l2 - q;
  const ch = (t: number): number => {
    const u = (t + 1) % 1;
    const v = u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  };
  return (ch(h2 + 1 / 3) << 16) | (ch(h2) << 8) | ch(h2 - 1 / 3);
}


const BRICKS: readonly MaterialSpec[] = [
  mat('brick', 0xa4563f), mat('brick', 0x8c4a35), mat('brick', 0xb86a4a), mat('brick', 0x9a6a52), mat('brick', 0xc08060),
  mat('brick', 0x7d5444), mat('brick', 0xb59a80),
];
const HARD: readonly MaterialSpec[] = [
  mat('concrete', 0xbcbab3), mat('stone', 0xcfc7b6), mat('ceramic', 0xd8d4cc), mat('concrete', 0xa9aaa5), mat('stone', 0xb9ae98),
  mat('ceramic', 0x9e9a92), mat('stone', 0xd9cdb4),
];
/** Pitched roofs: clay tiles in their reds and browns, slate, fibre-cement and metal sheet. */
const ROOF_TILES: readonly MaterialSpec[] = [
  mat('tile', 0xb5603f), mat('tile', 0x8f4a35), mat('slate', 0x55595e), mat('roofing', 0x6b5a4c), mat('tile', 0x7a3f32),
  mat('slate', 0x3f4a52), mat('tile', 0xa86d4a), mat('tile', 0xc06a45), mat('tile', 0x9c4f3a), mat('roofing', 0x9a9a94),
  mat('metal', 0x4f6b55), mat('metal', 0x6e3b32), mat('tile', 0x6b5f57),
];
/** The clay tile roofs alone: a colonial or a bungalow roof is ceramic. */
export const CLAY: readonly MaterialSpec[] = ROOF_TILES.filter((r) => r.finish === 'tile');
/** A works hall's panel roofs (`works`). */
export const WORKS_ROOFS: readonly number[] = [0x6d7378, 0x8a8f86, 0x5d6870, 0x9a9890, 0x7a4a3a, 0x4f6b55];
const AWNINGS = [0xb8382e, 0x2f6b4f, 0x2f4f7a, 0xd9a43a, 0x6b3f6b, 0x3d3d3d, 0xc7652f, 0x1f5f6b, 0x8a2f3c, 0x3f7f8f, 0x5c6b2f, 0xd06d8a];

/** A roof material, nudged. */
function roofOf(rng: Rng, list: readonly MaterialSpec[]): MaterialSpec {
  const r = pickOf(rng, list);
  return { ...r, colour: nudge(r.colour, rng, 0.5) };
}

/** A second skin of the same style, for the other half of a pair side by side (never a block stacked on another). */
function otherSkin(style: ArchStyle, rng: Rng, wall: MaterialSpec): MaterialSpec {
  for (let k = 0; k < 4; k++) {
    const p = paintsOf(style, rng).wall;
    if (Math.abs(lightness(p.colour) - lightness(wall.colour)) > 0.04 || p.finish !== wall.finish) return p;
  }
  return { ...wall, colour: nudge(wall.colour, rng, 3) };
}

/** Lightness, 0..1, of a colour. */
const lightness = (c: number): number => (Math.max((c >> 16) & 255, (c >> 8) & 255, c & 255) + Math.min((c >> 16) & 255, (c >> 8) & 255, c & 255)) / 510;

// ---------------------------------------------------------------- facade dress

/** Adds a facade part (a canopy, a marquise) unless it would cut into the building. */
function hang(body: BlueprintBody, el: Omit<BuildingElement, 'id'>): void {
  const elements = (body.elements ??= []);
  if (elements.length >= 96) return;
  const draft = { ...el, id: 0 } as BuildingElement;
  if (elementClash({ ...body, id: 0, x: 0, y: 0, rotation: 0 } as Building, draft)) return;
  draft.id = Math.max(0, ...elements.map((e) => e.id)) + 1;
  elements.push(draft);
  (body as { nextElementId?: number }).nextElementId = draft.id + 1;
}

/** The columns a face of a block is shared into (as composed, else on the 3 m module). */
const baysOf = (v: Volume, side: 0 | 1 | 2 | 3 = 0): number =>
  v.facadeGeometry?.[side]?.bays ?? Math.max(1, Math.round(stepsIn(side === 0 || side === 2 ? v.w : v.d, 3)));

/** After the facades are composed: the entrance */
function dressBuilding(body: BlueprintBody, style: ArchStyle, rng: Rng, entrance: number, front: Volume, ground: GroundRole, keep: ReadonlySet<Volume>): void {
  const solid = body.volumes.filter((v) => !v.open && !keep.has(v));
  if (style.stoneBase) {
    const wall = body.materials?.wall;
    if (wall) for (const v of solid) {
      if (v.base !== 0 || v.storeys.length < 2) continue;
      v.storeys[0]!.materials = Object.fromEntries([0, 1, 2, 3].map((s) => [s, stoneBaseOf(v.materials?.wall ?? wall)]));
    }
  }
  if (!keep.has(front)) {
    const across = baysOf(front);
    const bay = Math.max(0, Math.min(across - 1, Math.floor(((entrance - front.x) / front.w) * across)));
    const bw = front.w / across;
    const modern = style.key === 'contemporary' || style.key === 'modernist' || style.key === 'glass' || style.key === 'tropical' || style.key === 'modernHouse';
    if (ground === 'lobby' && modern) {
      // The marquise: a thin slab over the lobby, wider than the door, the entrance read from the street
      const span = Math.min(front.w - m(0.6), bw * (across >= 5 ? 3 : 1) + m(1.2));
      const z = Math.min(body.groundHeight - m(0.45), m(3.6));
      hang(body, { kind: 'canopy', x: front.x + (bay + 0.5) * bw, y: front.y - m(1.2), facing: 0, w: span, d: m(2.4), z, h: m(0.22) });
    } else if (ground !== 'shop' && style.key !== 'colonial' && style.key !== 'colonialHouse' && front.w > m(6) && rng.float() < 0.45) {
      front.reliefs = [...(front.reliefs ?? []), { side: 0, bay0: bay, bay1: bay, storey0: 0, storey1: 0, depth: -m(1.2) }];
    } else if (ground !== 'shop') {
      const z = Math.min(body.groundHeight - m(0.35), m(3.1));
      hang(body, { kind: 'canopy', x: front.x + (bay + 0.5) * bw, y: front.y - m(0.8), facing: 0, w: Math.min(m(4), bw + m(1)), d: m(1.6), z, h: m(0.18) });
    }
  }
  // A tall modern block: its middle columns brought forward the whole body, the same skin
  if (style.key === 'contemporary' || style.key === 'modernist' || style.key === 'tropical' || style.key === 'brick') {
    for (const v of solid) {
      const across = baysOf(v), upper = v.storeys.length;
      if (v.outline || upper < 6 || across < 5 || rng.float() < 0.45) continue;
      const mid = Math.floor(across / 2), spread = across >= 9 ? 1 : 0;
      const lo = v.base === 0 ? 1 : 0;
      for (const side of [0, 2] as const) {
        v.reliefs = [...(v.reliefs ?? []), { side, bay0: mid - spread, bay1: mid + spread, storey0: lo, storey1: upper - 1, depth: m(0.6) }];
      }
    }
  }
  // A deco or classic block of five columns and four floors: its end columns brought forward, a centre and two wings.
  if (style.key === 'artDeco' || style.key === 'colonial') {
    for (const v of solid) {
      const across = baysOf(v), upper = v.storeys.length;
      if (upper < 4 || across < 5) continue;
      const lo = v.base === 0 ? 1 : 0;
      v.reliefs = [...(v.reliefs ?? []),
        { side: 0, bay0: 0, bay1: 0, storey0: lo, storey1: upper - 1, depth: m(0.5) },
        { side: 0, bay0: across - 1, bay1: across - 1, storey0: lo, storey1: upper - 1, depth: m(0.5) }];
    }
  }
}

/** Moves the door of a block's front to the bay holding `x` (units, local). */
function doorAt(v: Volume, x: number, kind: BayComponent): number {
  const across = baysOf(v);
  const bay = Math.max(0, Math.min(across - 1, Math.floor(((x - v.x) / v.w) * across)));
  const f = v.storeys[0]!.facade;
  const bays = Object.fromEntries(Object.entries(f.bays ?? {}).filter(([, c]) => c !== 'door' && c !== 'doubleDoor'));
  f.bays = { ...bays, [`0:${bay}`]: kind };
  return v.x + ((bay + 0.5) * v.w) / across;
}

/** A back door on the rear of the block at the back, near the middle. */
function backDoorOn(v: Volume): number {
  const across = baysOf(v, 2);
  const bay = Math.floor(across / 2);
  const f = v.storeys[0]!.facade;
  f.bays = { ...(f.bays ?? {}), [`2:${bay}`]: 'door' };
  return v.x + ((bay + 0.5) * v.w) / across;
}

/** The signature of a body made: its form, its main wall and roof, its height. */
function signatureOf(form: string, body: BlueprintBody): Signature {
  const solid = body.volumes.filter((v) => !v.open);
  const main = [...solid].sort((p, q) => q.w * q.d - p.w * p.d)[0];
  const wall = main?.materials?.wall ?? body.materials?.wall;
  const roof = main?.materials?.roof ?? body.materials?.roof;
  return {
    form,
    colour: wall?.colour ?? 0,
    roof: `${main?.roof ?? 'flat'}:${roof ? `${roof.finish}${roof.colour}` : ''}`,
    storeys: Math.max(0, ...solid.map((v) => v.base + v.storeys.length)),
  };
}

/** Finishes a body: pitched roofs given their pitch, the facades composed in the style (`architecture.ts`) */
function finish(fn: BuildingFunction, form: string, body: BlueprintBody, env: Envelope, rng: Rng, style: ArchStyle, ground: GroundRole,
  free: Rect[], doorKind: BayComponent = 'door', doorBlock?: Volume, keep: ReadonlySet<Volume> = new Set()): MadeBuilding {
  body.function = fn;
  // Every pitched roof given its pitch (a wing's lean-to left at the default 12 degrees rose a storey over a deep kitchen).
  for (const v of body.volumes) if (v.pitch === undefined) roofShape(v, rng);
  // Tiles and sheet are for a pitched roof: a flat roof under them read as a tiled slab.
  const tiles = body.materials?.roof;
  if (tiles && (tiles.finish === 'tile' || tiles.finish === 'slate' || tiles.finish === 'metal')) {
    const membrane = mat('roofing', nudge(0x74716a, rng, 0.6));
    for (const v of body.volumes) {
      if (!v.open && (v.roof === 'flat' || v.roof === 'terrace') && !v.materials?.roof) v.materials = { ...(v.materials ?? {}), roof: membrane };
    }
  }
  composeFacades(body.volumes.filter((v) => !keep.has(v)), style, rng, ground);
  const solid = body.volumes.filter((v) => !v.open && v.base === 0);
  const front = doorBlock ?? solid.filter((v) => !keep.has(v)).sort((p, q) => p.y - q.y || q.w - p.w)[0] ?? solid[0]!;
  const want = m(env.door ?? env.W / 2);
  const entrance = doorAt(front, Math.max(front.x, Math.min(front.x + front.w, want)), doorKind);
  const backBlock = [...solid].sort((p, q) => q.y + q.d - (p.y + p.d))[0]!;
  const back = env.backDoor ? backDoorOn(backBlock) : undefined;
  dressBuilding(body, style, rng, entrance, front, ground, keep);
  return { signature: signatureOf(form, body), fn, body, entrance: entrance / m(1), ...(back !== undefined ? { backDoor: back / m(1) } : {}), free };
}

/** The most a roof rises over its eaves, metres: a gable or a hip about a storey */
const MAX_ROOF_RISE: Partial<Record<RoofKind, number>> = { gable: 3.2, hip: 3.2, shed: 1.2, sawtooth: 2 };
/** Pitches drawn, degrees, as built: clay tiles 20-35 */
const PITCH: Partial<Record<RoofKind, readonly [number, number]>> = { gable: [20, 35], hip: [20, 32], shed: [5, 14], sawtooth: [22, 30] };

/** Pitch and ridge of a pitched roof, drawn: a gable end to the street one time in three */
function roofShape(v: Volume, rng: Rng, ridgeToStreet = rng.float() < 0.33): void {
  if (v.roof === 'flat' || v.roof === 'terrace') return;
  if (v.roof === 'gable' || v.roof === 'hip') v.ridge = ridgeToStreet ? 'y' : 'x';
  // A lean-to falls across the short way, as one is built
  if (v.roof === 'shed' && v.fall === undefined && v.w < v.d) v.fall = 1;
  const [lo, hi] = PITCH[v.roof] ?? [20, 30];
  const run = v.roof === 'shed' ? ((v.fall ?? 0) % 2 === 0 ? v.d : v.w)
    : v.roof === 'sawtooth' ? Math.min(m(6), v.d) / 2
    : ((v.ridge ? v.ridge === 'x' : v.w >= v.d) ? v.d : v.w) / 2;
  const cap = (Math.atan(m(MAX_ROOF_RISE[v.roof] ?? 3) / Math.max(run, 1e-6)) * 180) / Math.PI;
  if (cap < MIN_PITCH * 0.66) { v.roof = 'flat'; delete v.pitch; delete v.ridge; delete v.fall; return; }
  v.pitch = Math.max(MIN_PITCH, Math.floor(Math.min(between(rng, lo, hi), cap)));
}

/** A tower's plan, normalized to its block: undefined */
function towerShape(rng: Rng): Vec2[] | undefined {
  const r = rng.float();
  if (r < 0.5) return undefined;
  if (r < 0.85) {
    const c = between(rng, 0.14, 0.26);
    return [{ x: c, y: 0 }, { x: 1 - c, y: 0 }, { x: 1, y: c }, { x: 1, y: 1 - c }, { x: 1 - c, y: 1 }, { x: c, y: 1 }, { x: 0, y: 1 - c }, { x: 0, y: c }];
  }
  return Array.from({ length: 16 }, (_, k) => {
    const a = -Math.PI / 2 + (k / 16) * Math.PI * 2;
    return { x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) };
  });
}

// ---------------------------------------------------------------- the kinds

type HouseForm = 'wing' | 'ell' | 'veranda' | 'garage' | 'twin' | 'bungalow';

/** The roof a house style builds, by its weights: a colonial house's parapet, a bungalow's tiles, a modern house's slab. */
function houseRoof(rng: Rng, style: ArchStyle): RoofKind {
  switch (style.key) {
    case 'colonialHouse': return pickOf(rng, ['flat', 'flat', 'gable', 'hip'] as const);
    case 'modernHouse': return pickOf(rng, ['flat', 'flat', 'flat', 'shed'] as const);
    case 'sobrado': return pickOf(rng, ['gable', 'hip', 'flat'] as const);
    default: return pickOf(rng, ['gable', 'hip', 'hip'] as const);
  }
}

/** A house, in one of six forms chosen by case on the envelope and then at random among those that fit */
function house(rng: Rng, env: Envelope): MadeBuilding {
  const { W, D } = env;
  const style = styleFor('house', rng, env.character, env.era);
  const paints = paintsOf(style, rng);
  const roofMat = roofOf(rng, style.key === 'modernHouse' ? ROOF_TILES : CLAY);
  const model = new Model('house', 'residential', rng.int(0, 7)).heights(between(rng, 2.8, 3.3), between(rng, 2.8, 3.1)).look(paints.wall, roofMat, paints.trim);
  const storeys = style.key === 'sobrado' ? 2 : rng.float() < 0.5 ? 2 : 1;
  const roof = houseRoof(rng, style);
  const fill: BayComponent = 'window';
  const w = half(W), d = half(D);
  const forms: HouseForm[] = ['wing', 'veranda'];
  if (W >= 10) forms.push('ell', 'twin');
  if (W >= 11 && env.driveSide) forms.push('garage');
  if (W >= 12 && D <= 14 && style.key === 'bungalow') forms.push('bungalow', 'bungalow');
  const form = pickOf(rng, forms);
  const free: Rect[] = [];
  const keep = new Set<Volume>();
  let doorBlock: Volume | undefined;
  const body = (() => {
    switch (form) {
      case 'ell': {
        const wingW = half(Math.min(w * 0.45, between(rng, 3.5, 5)));
        const step = half(Math.min(d * 0.35, between(rng, 2, 3.5)));
        const left = rng.float() < 0.5;
        const mainD = half(Math.min(d - step, between(rng, 7.5, 10)));
        model.block({ x: 0, y: step, w, d: mainD, storeys, roof, fill });
        model.block({ x: left ? 0 : w - wingW, y: 0, w: wingW, d: step + half(mainD * 0.6), storeys: rng.float() < 0.6 ? storeys : 1, roof: roof === 'flat' ? 'flat' : 'gable', fill });
        // The corner in front of the door: a little paved patio.
        free.push(left ? { x0: wingW, y0: 0, x1: w, y1: step } : { x0: 0, y0: 0, x1: w - wingW, y1: step });
        const b = model.build();
        doorBlock = b.volumes[0];
        roofShape(b.volumes[0]!, rng, false);
        roofShape(b.volumes[1]!, rng, true);
        return b;
      }
      case 'veranda': {
        const deep = half(between(rng, 1.8, 2.6));
        const mainD = half(Math.min(d - deep, between(rng, 8, 11)));
        model.block({ x: 0, y: deep, w, d: mainD, storeys, roof, fill });
        if (d - deep - mainD >= 2.5 && rng.float() < 0.6) {
          const ww = half(Math.max(Math.min(w, 4), w * between(rng, 0.4, 0.6)));
          model.block({ x: rng.float() < 0.5 ? 0 : w - ww, y: deep + mainD, w: ww, d: half(d - deep - mainD), storeys: 1, roof: 'flat', fill: 'window' });
        }
        const b = model.build();
        roofShape(b.volumes[0]!, rng);
        // The veranda: its floor, a roof over it on posts at its front edge.
        const vx0 = m(0.3), vx1 = m(w - 0.3);
        const span = rng.float() < 0.5 ? [vx0, vx1] : [vx0, m(Math.max(3.5, w * 0.6))];
        const vw = span[1]! - span[0]!, cx = (span[0]! + span[1]!) / 2;
        hang(b, { kind: 'pavement', x: cx, y: m(deep / 2), facing: 0, w: vw, d: m(deep), z: 0, h: m(0.15), material: mat('ceramic', nudge(0xb5654a, rng)) });
        hang(b, { kind: 'slab', x: cx, y: m(deep / 2 - 0.05), facing: 0, w: vw + m(0.3), d: m(deep - 0.1), z: b.groundHeight - m(0.2), h: m(0.16), material: paints.trim });
        const posts = Math.max(2, Math.round(stepsIn(vw, 2.6)) + 1);
        for (let k = 0; k < posts; k++) {
          hang(b, { kind: 'pillar', x: span[0]! + m(0.15) + ((vw - m(0.3)) * k) / (posts - 1), y: m(0.2), facing: 0, w: m(0.2), d: m(0.2), z: 0, h: b.groundHeight - m(0.2), material: paints.trim });
        }
        return b;
      }
      case 'garage': {
        const gw = half(between(rng, 3, 3.6));
        const onLeft = env.driveSide === 'left';
        const mainD = half(Math.min(d, between(rng, 8, 10.5)));
        const back = half(between(rng, 0.5, 2));
        model.block({ x: onLeft ? gw : 0, y: 0, w: w - gw, d: mainD, storeys, roof, fill });
        model.block({ x: onLeft ? 0 : w - gw, y: back, w: gw, d: half(Math.min(d - back, 6)), storeys: 1, roof: rng.float() < 0.5 ? 'flat' : 'shed', fill: 'wall', ground: 'wall' });
        const b = model.build();
        doorBlock = b.volumes[0];
        roofShape(b.volumes[0]!, rng);
        // The garage door on its front, its walls the house's.
        const g = b.volumes[1]!;
        g.storeys[0]!.facade.bays = { '0:0': 'garageDoor' };
        g.dress = { lines: 'none', crown: style.dress.crown === 'cornice' ? 'none' : style.dress.crown };
        keep.add(g);
        return b;
      }
      case 'twin': {
        const split = half(w * between(rng, 0.42, 0.58));
        const setback = half(between(rng, 0.8, 2));
        const tallLeft = rng.float() < 0.5;
        const mainD = half(Math.min(d - setback, between(rng, 8, 10)));
        model.block({ x: 0, y: tallLeft ? 0 : setback, w: split, d: mainD, storeys: tallLeft ? 2 : 1, roof, fill });
        model.block({ x: split, y: tallLeft ? setback : 0, w: w - split, d: mainD, storeys: tallLeft ? 1 : 2, roof: houseRoof(rng, style), fill });
        const b = model.build();
        roofShape(b.volumes[0]!, rng);
        roofShape(b.volumes[1]!, rng);
        // Two homes side by side, two paints of the one style.
        b.volumes[1]!.materials = { wall: otherSkin(style, rng, paints.wall) };
        return b;
      }
      case 'bungalow': {
        const mainD = half(Math.min(d, between(rng, 7.5, 10)));
        model.block({ x: 0, y: 0, w, d: mainD, storeys: 1, roof: 'hip', fill });
        const b = model.build();
        roofShape(b.volumes[0]!, rng, false);
        b.volumes[0]!.pitch = Math.round(between(rng, 20, 28));
        return b;
      }
      default: {
        // The main body across the whole width; behind it, the kitchen wing and a terrace beside it.
        const mainD = half(Math.min(d, between(rng, 7.5, 10)));
        model.block({ x: 0, y: 0, w, d: mainD, storeys, roof, fill });
        if (d - mainD >= 2) {
          const ww = half(Math.max(Math.min(w, 4), w * between(rng, 0.45, 0.7)));
          const left = rng.float() < 0.5;
          model.block({ x: left ? 0 : w - ww, y: mainD, w: ww, d: half(d - mainD), storeys: 1,
            roof: pickOf(rng, ['flat', 'shed', roof] as const), fill: 'window' });
          if (w - ww >= 2) free.push(left ? { x0: ww, y0: mainD, x1: w, y1: d } : { x0: 0, y0: mainD, x1: w - ww, y1: d });
        }
        const b = model.build();
        roofShape(b.volumes[0]!, rng);
        return b;
      }
    }
  })();
  const made = finish('house', `house:${form}:${style.key}`, body, env, rng, style, 'house', free, rng.float() < 0.3 ? 'doubleDoor' : 'door', doorBlock, keep);
  return made;
}

/** Recursive setbacks (CityEngine's `RecursiveSetbacks`) */
function setbacks(model: Model, rng: Rng, x: number, y: number, w: number, d: number, base: number, floors: number,
  spec: { roof: RoofKind; shape?: Vec2[] }): void {
  let left = floors, at = base, bx = x, by = y, bw = w, bd = d;
  const scale = between(rng, 0.75, 0.9);
  for (let step = 0; left > 0; step++) {
    const part = left > 6 && step < 3 ? Math.max(3, Math.round(left * pickOf(rng, [0.4, 0.6]))) : left;
    model.block({ x: bx, y: by, w: bw, d: bd, base: at, storeys: part, ...(spec.shape ? { shape: spec.shape } : {}), roof: part === left ? spec.roof : 'terrace' });
    at += part;
    left -= part;
    const nw = half(Math.max(8, bw * scale)), nd = half(Math.max(8, bd * scale));
    bx += half((bw - nw) / 2); by += half((bd - nd) / 2); bw = nw; bd = nd;
  }
}

/** Flats: a bar, an L or a U round a courtyard, stepped at the top; a tower on a podium when high. */
function flats(rng: Rng, env: Envelope, high: boolean): MadeBuilding {
  const { W, D } = env;
  const fn: BuildingFunction = high ? 'residentialTower' : 'apartments';
  const style = styleFor(high ? 'tower' : 'flats', rng, env.character, env.era);
  const paints = paintsOf(style, rng);
  const model = new Model(fn, 'residential', rng.int(0, 7)).heights(between(rng, 3.8, 4.5), between(rng, 2.9, 3.1)).look(paints.wall, roofOf(rng, CLAY), paints.trim);
  // Next to low houses a block keeps nearer their height (a step, not a cliff).
  const near = env.neighbours?.length ? Math.max(...env.neighbours) : null;
  const cap = near !== null && !high ? Math.max(3, near + 3) : Infinity;
  // One tower in eight a landmark, far above the rest: a skyline has peaks.
  const floors = high ? (rng.float() < 0.125 ? rng.int(30, 44) : rng.int(8, 24)) : Math.min(cap, rng.int(3, 7));
  // Shops on the ground floor one block in four (a fachada ativa), a lobby otherwise.
  const ground: GroundRole = rng.float() < 0.25 ? 'shop' : 'lobby';
  // A tiled roof on a low block of an old style; a parapet otherwise.
  const roof: RoofKind = !high && (style.key === 'colonial' || style.key === 'brick') && rng.float() < 0.4 ? 'hip' : rng.float() < 0.3 ? 'terrace' : 'flat';
  const w = half(W), d = half(D);
  const free: Rect[] = [];
  const barD = half(Math.min(d, between(rng, 12, 15)));
  let form: string;
  if (high) {
    // Towers in the forms a Brazilian skyline is made of
    const podium = rng.int(1, 2);
    const inset = half(between(rng, 0.5, 1.2));
    const tw = Math.max(8, w - 2 * inset), td = Math.max(8, Math.min(d - 2 * inset, 22));
    const pd = Math.min(d, td + 2 * inset);
    model.block({ x: 0, y: 0, w, d: pd, storeys: podium, roof: 'terrace' });
    if (d - pd >= 2) free.push({ x0: 0, y0: pd, x1: w, y1: d });
    const forms = ['box', 'setback', 'crown', 'crown'] as string[];
    if (tw >= 14) forms.push('ell');
    if (tw >= 26) forms.push('twin', 'twin');
    const kind = pickOf(rng, forms);
    // The tower's plan: a plain rectangle, a chamfered octagon
    const shape = kind === 'ell' ? undefined : towerShape(rng);
    const skin = shape ? { shape } : {};
    const shapedRoof: RoofKind = 'flat';
    form = `tower:${kind}${shape ? `:${shape.length}` : ''}`;
    switch (kind) {
      case 'setback': setbacks(model, rng, inset, inset, tw, td, podium, floors, { ...skin, roof: shapedRoof }); break;
      case 'ell': {
        const legW = half(Math.max(8, tw * between(rng, 0.38, 0.5)));
        const left = rng.float() < 0.5;
        model.block({ x: inset, y: inset, w: tw, d: half(Math.max(8, td * 0.5)), base: podium, storeys: floors, roof: 'flat' });
        model.block({ x: left ? inset : inset + tw - legW, y: inset + half(Math.max(8, td * 0.5)), w: legW, d: half(Math.max(4, td * 0.5)), base: podium,
          storeys: Math.max(4, floors - rng.int(0, 4)), roof: 'flat' });
        break;
      }
      case 'twin': {
        const gap = half(between(rng, 3, 5));
        const each = half((tw - gap) / 2);
        const other = Math.max(6, floors + pickOf(rng, [-5, -3, 3, 5]));
        model.block({ x: inset, y: inset, w: each, d: td, base: podium, storeys: floors, ...skin, roof: shapedRoof });
        model.block({ x: inset + each + gap, y: inset, w: each, d: td, base: podium, storeys: other, ...skin, roof: shapedRoof });
        break;
      }
      case 'crown': {
        // The shaft, then the top floors drawn in as a penthouse, the same skin (a tower reads as ONE building).
        const top = rng.int(1, 3);
        model.block({ x: inset, y: inset, w: tw, d: td, base: podium, storeys: floors - top, ...skin, roof: 'terrace' });
        const cin = half(between(rng, 1.5, 3));
        model.block({ x: inset + cin, y: inset + cin, w: Math.max(6, tw - 2 * cin), d: Math.max(6, td - 2 * cin), base: podium + floors - top, storeys: top,
          roof: 'flat', ...(shape ? { shape } : {}) });
        break;
      }
      default: model.block({ x: inset, y: inset, w: tw, d: td, base: podium, storeys: floors, ...skin, roof: shapedRoof });
    }
  } else if (d - barD >= 6 && w >= 20 && rng.float() < 0.5) {
    // A U: the street bar and two wings, the courtyard between them.
    form = 'flats:u';
    const ww = half(between(rng, 6, Math.min(9, w / 3)));
    const wingFloors = Math.max(2, floors - rng.int(0, 2));
    model.block({ x: 0, y: 0, w, d: barD, storeys: floors, roof });
    model.block({ x: 0, y: barD, w: ww, d: d - barD, storeys: wingFloors, roof });
    model.block({ x: w - ww, y: barD, w: ww, d: d - barD, storeys: wingFloors, roof });
    free.push({ x0: ww, y0: barD, x1: w - ww, y1: d });
  } else if (d - barD >= 6 && w >= 14 && rng.float() < 0.7) {
    // An L: the bar and a wing behind, mirrored at random, a shorter wing one time in four.
    form = 'flats:l';
    const ww = half(between(rng, 7, Math.min(11, w / 2)));
    const left = rng.float() < 0.5;
    model.block({ x: 0, y: 0, w, d: barD, storeys: floors, roof });
    model.block({ x: left ? 0 : w - ww, y: barD, w: ww, d: d - barD, storeys: rng.float() < 0.25 ? Math.max(2, Math.round(floors * 0.7)) : floors, roof });
    free.push(left ? { x0: ww, y0: barD, x1: w, y1: d } : { x0: 0, y0: barD, x1: w - ww, y1: d });
  } else if (w >= 16 && rng.float() < 0.4) {
    // Two bars side by side, one taller and set back: a block of two buildings.
    form = 'flats:pair';
    const split = half(w * between(rng, 0.4, 0.6));
    const back = half(between(rng, 1, 2.5));
    model.block({ x: 0, y: 0, w: split, d, storeys: floors, roof });
    model.block({ x: split, y: back, w: w - split, d: d - back, storeys: Math.max(2, floors + pickOf(rng, [-2, -1, 1, 2])), roof });
  } else {
    // A bar to the envelope's depth, its top floors stepped back from the street.
    form = 'flats:bar';
    const lower = floors >= 5 && rng.float() < 0.5 ? floors - rng.int(1, 2) : floors;
    model.block({ x: 0, y: 0, w, d, storeys: lower, roof: lower < floors ? 'terrace' : roof });
    if (lower < floors && d >= 9) model.block({ x: 0, y: 2, w, d: d - 2, base: lower, storeys: floors - lower, roof });
  }
  model.core('stairLift', half(w / 2 - 1.5), half(Math.min(d, 10) / 2 - 1.5), floors + (high ? 2 : 0));
  const body = model.build();
  // A second paint only for the second building of a pair, side by side.
  if (form === 'flats:pair' && rng.float() < 0.6) body.volumes.filter((v) => !v.open)[1]!.materials = { wall: otherSkin(style, rng, paints.wall) };
  for (const v of body.volumes) roofShape(v, rng);
  return finish(fn, `${form}:${style.key}`, body, env, rng, style, ground, free, 'doubleDoor');
}

/** A street shop: shopfronts on the ground floor, flats or offices above, a stockroom behind. */
function shop(rng: Rng, env: Envelope, density: 'low' | 'medium'): MadeBuilding {
  const { W, D } = env;
  const fn = pickOf(rng, density === 'low'
    ? ['shop', 'bakery', 'pharmacy', 'snackBar', 'bar', 'shop', 'restaurant', 'supermarket'] as const satisfies readonly BuildingFunction[]
    : ['shop', 'restaurant', 'bank', 'hotel', 'gym', 'office', 'pharmacy', 'supermarket'] as const satisfies readonly BuildingFunction[]);
  const style = styleFor('shop', rng, env.character, env.era);
  const paints = paintsOf(style, rng);
  const model = new Model(fn, 'commercial', rng.int(0, 7)).heights(between(rng, 4, 4.6), 3.1).look(paints.wall, roofOf(rng, CLAY), paints.trim);
  const near = env.neighbours?.length ? Math.max(...env.neighbours) : null;
  const storeys = density === 'low' ? rng.int(1, 3) : Math.min(near !== null ? Math.max(2, near + 3) : 6, rng.int(2, 6));
  const roof: RoofKind = storeys === 1 && style.key === 'colonial' && rng.float() < 0.4 ? pickOf(rng, ['gable', 'hip'] as const) : rng.float() < 0.2 ? 'terrace' : 'flat';
  const w = half(W), d = half(D);
  // The sales floor, then a lower stockroom to the back of the plot.
  const mainD = d > 16 ? half(between(rng, 12, Math.min(16, d - 3))) : d;
  let form = 'shop:block';
  const keep = new Set<Volume>();
  if (w >= 14 && storeys >= 2 && rng.float() < 0.35) {
    // Two shop houses side by side, of different heights: a street front of two.
    form = 'shop:pair';
    const split = half(w * between(rng, 0.4, 0.6));
    model.block({ x: 0, y: 0, w: split, d: mainD, storeys, roof });
    model.block({ x: split, y: 0, w: w - split, d: mainD, storeys: Math.max(1, storeys + pickOf(rng, [-1, 1])), roof });
  } else model.block({ x: 0, y: 0, w, d: mainD, storeys, roof });
  if (d - mainD >= 2) model.block({ x: 0, y: mainD, w, d: d - mainD, storeys: 1, roof: 'flat', fill: 'wall', ground: 'wall' });
  const body = model.build();
  if (d - mainD >= 2) {
    const store = body.volumes[body.volumes.length - 1]!;
    store.dress = { lines: 'none', crown: 'none' };
    keep.add(store);
  }
  if (form === 'shop:pair') body.volumes[1]!.materials = { wall: otherSkin(style, rng, paints.wall) };
  for (const v of body.volumes) roofShape(v, rng);
  const made = finish(fn, `${form}:${style.key}`, body, env, rng, style, 'shop', [], rng.float() < 0.5 ? 'doubleDoor' : 'door', undefined, keep);
  // A shop with homes or offices above has a second door for the stairs, at one end.
  if (storeys > 1 && w >= 7) {
    const main = body.volumes[0]!;
    const across = baysOf(main);
    const f = main.storeys[0]!.facade;
    const end = `0:${rng.float() < 0.5 ? 0 : across - 1}`;
    if (f.bays?.[end] !== 'doubleDoor' && f.bays?.[end] !== 'door') f.bays = { ...(f.bays ?? {}), [end]: 'door' };
  }
  // A shop front of an old street under one long awning the width of the shop, now and then.
  if ((style.key === 'colonial' || style.key === 'brick') && rng.float() < 0.3) {
    hang(body, { kind: 'awning', x: m(w / 2), y: -m(0.6), facing: 0, w: m(Math.max(2, w - 1)), d: m(between(rng, 1, 1.6)), z: m(3), h: m(0.12),
      material: mat('metal', pickOf(rng, AWNINGS)) });
  }
  return made;
}

/** An office building: glass, a base and a tower stepped back as it rises, or a slab. */
function office(rng: Rng, env: Envelope): MadeBuilding {
  const { W, D } = env;
  const style = styleFor('office', rng, env.character, env.era);
  const paints = paintsOf(style, rng);
  const model = new Model('office', 'commercial', rng.int(0, 7)).heights(between(rng, 4.5, 5.5), between(rng, 3.4, 3.9)).look(paints.wall, mat('concrete', GENERIC_SLAB), paints.trim);
  const floors = rng.int(8, 24);
  const w = half(W), d = half(D);
  let form = 'office:slab';
  const officeFree: Rect[] = [];
  if (rng.float() < 0.6 && w >= 14 && d >= 14) {
    // The base the tower's footprint with a narrow ledge, the tower's skin (see `flats`).
    const podium = rng.int(1, 3);
    const inset = half(between(rng, 0.5, 1.2));
    const tw = w - 2 * inset, td = Math.max(8, Math.min(d - 2 * inset, 24));
    const pd = Math.min(d, td + 2 * inset);
    model.block({ x: 0, y: 0, w, d: pd, storeys: podium, roof: 'terrace' });
    if (d - pd >= 2) officeFree.push({ x0: 0, y0: pd, x1: w, y1: d });
    const shaft = floors - podium;
    const pickForm = style.key === 'artDeco' ? 'setback' : pickOf(rng, tw >= 26 ? ['setback', 'podium', 'twin', 'crown'] : ['setback', 'podium', 'crown']);
    form = `office:${pickForm}`;
    if (pickForm === 'setback') setbacks(model, rng, inset, inset, tw, td, podium, shaft, { roof: 'flat' });
    else if (pickForm === 'twin') {
      const gap = half(between(rng, 3, 5)), each = half((tw - gap) / 2);
      model.block({ x: inset, y: inset, w: each, d: td, base: podium, storeys: shaft, roof: 'flat' });
      model.block({ x: inset + each + gap, y: inset, w: each, d: td, base: podium, storeys: Math.max(4, shaft + pickOf(rng, [-6, -3, 4])), roof: 'flat' });
    } else if (pickForm === 'crown') {
      // A shaft and a set-in top of two or three floors, the same skin: one building, finished at the top.
      const top = rng.int(2, 3), cin = half(between(rng, 1, 2.5));
      model.block({ x: inset, y: inset, w: tw, d: td, base: podium, storeys: shaft - top, roof: 'terrace' });
      model.block({ x: inset + cin, y: inset + cin, w: Math.max(6, tw - 2 * cin), d: Math.max(6, td - 2 * cin), base: podium + shaft - top, storeys: top, roof: 'flat' });
    } else model.block({ x: inset, y: inset, w: tw, d: td, base: podium, storeys: shaft, roof: 'flat' });
  } else {
    model.block({ x: 0, y: 0, w, d, storeys: floors, roof: 'flat' });
  }
  model.core('stairLift', half(w / 2 - 1.5), half(Math.min(d, 12) / 2 - 1.5), floors);
  const body = model.build();
  return finish('office', `${form}:${style.key}`, body, env, rng, style, 'lobby', officeFree, 'doubleDoor');
}

/** A works: an office on the street corner, the hall behind it with its loading doors at the back. */
function works(rng: Rng, env: Envelope, density: 'low' | 'medium' | 'high'): MadeBuilding {
  const { W, D } = env;
  const fn: BuildingFunction = density === 'low' ? 'warehouse' : rng.float() < 0.5 ? 'factory' : 'warehouse';
  const style = STYLES.industrial;
  const paints = paintsOf(style, rng);
  // A hall's one tall storey, 6-10 m to the eaves (racking and a lorry's door), taller the denser the district.
  const hallH = density === 'high' ? between(rng, 8, 10) : density === 'medium' ? between(rng, 7, 9) : between(rng, 6, 7.5);
  const model = new Model(fn, 'industrial', rng.int(0, 7)).heights(hallH, 3.4)
    .look(paints.wall, mat('panel', pickOf(rng, WORKS_ROOFS)), paints.trim);
  const w = half(W), d = half(D);
  const roof = pickOf(rng, ['sawtooth', 'shed', 'flat', 'gable', 'sawtooth'] as const satisfies readonly RoofKind[]);
  const free: Rect[] = [];
  const annex = d >= 20 && w >= 12;
  const aw = annex ? half(Math.min(w - 4, between(rng, 6, 9))) : 0;
  const ad = annex ? half(between(rng, 5, 7)) : 0;
  const left = rng.float() < 0.5;
  // One tall storey: a hall of two storeys at 6-9 m each was a box 18 m high.
  model.block({ x: 0, y: ad, w, d: d - ad, storeys: 1, ground: 'wall', fill: 'ribbon', roof, pattern: 'industrial' });
  if (annex) {
    // The office annex: brick or concrete, ribbon windows, its own slab.
    model.block({ x: left ? 0 : w - aw, y: 0, w: aw, d: ad, storeys: rng.int(1, 2), ground: 'ribbon', fill: 'ribbon', roof: 'flat',
      wall: pickOf(rng, [...HARD, ...BRICKS]) });
    free.push(left ? { x0: aw, y0: 0, x1: w, y1: ad } : { x0: 0, y0: 0, x1: w - aw, y1: ad });
  }
  const body = model.build();
  roofShape(body.volumes[0]!, rng, false);
  // The hall's back: loading doors onto the yard.
  const hall = body.volumes[0]!;
  const f = hall.storeys[0]!.facade;
  const across = baysOf(hall, 2);
  for (let i = 0; i < across; i += 2) f.bays = { ...(f.bays ?? {}), [`2:${i}`]: 'loadingDoor' };
  hall.dress = { lines: 'none', crown: 'attic' };
  const keep = new Set<Volume>([hall]);
  if (annex) {
    const office = body.volumes[1]!;
    office.dress = { lines: 'slab', crown: 'slab' };
    keep.add(office);
  }
  return finish(fn, `works:${roof}:${annex ? (left ? 'l' : 'r') : 'none'}`, body, { ...env, door: annex ? (left ? aw / 2 : w - aw / 2) : env.door ?? w / 2 }, rng, style, 'works', free, 'door', undefined, keep);
}


/** A building for an envelope `W` x `D` metres of a lot, for a zone's use and density. */
export function madeToMeasure(use: 'residential' | 'commercial' | 'industrial', density: 'low' | 'medium' | 'high', env: Envelope, rng: Rng): MadeBuilding {
  if (use === 'residential') return density === 'low' ? house(rng, env) : flats(rng, env, density === 'high');
  if (use === 'commercial') return density === 'high' ? office(rng, env) : shop(rng, env, density);
  return works(rng, env, density);
}

/** The signature of any building, grown or not, read off its record as the eye reads it */
export function bodySignature(body: BlueprintBody): Signature {
  const solid = body.volumes.filter((v) => !v.open);
  if (!solid.length) return signatureOf(`${body.function ?? body.use}|`, body);
  const x0 = Math.min(...solid.map((v) => v.x)), x1 = Math.max(...solid.map((v) => v.x + v.w));
  const y0 = Math.min(...solid.map((v) => v.y));
  const width = Math.max(1e-6, x1 - x0);
  const token = (v: Volume): string => {
    const col = Math.round(((v.x + v.w / 2 - x0) / width) * 2);
    const row = v.y - y0 < m(1) ? 'f' : 'b';
    const whole = v.w > width * 0.8 ? 'W' : '';
    return `${row}${col}${whole}${v.base}+${v.storeys.length}${v.roof}`;
  };
  return signatureOf(`${body.function ?? body.use}|${solid.map(token).sort().join(';')}`, body);
}

/** How unlike two signatures are, 0 (the same building) to about 4 */
export function signatureDistance(a: Signature, b: Signature): number {
  const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  const [r1, g1, b1] = rgb(a.colour), [r2, g2, b2] = rgb(b.colour);
  const colour = Math.min(1, Math.hypot(r1 - r2, g1 - g2, b1 - b2) / 90);
  return (a.form === b.form ? 0 : 1.5) + colour + (a.roof === b.roof ? 0 : 0.7) + Math.min(1, Math.abs(a.storeys - b.storeys) / 2) * 0.8;
}
