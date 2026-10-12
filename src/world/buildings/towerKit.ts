import type { Rng } from '@core/rng';
import { m } from '../units';
import type { BlueprintBody } from './blueprints';
import { Model, mat } from './cityBuildings';
import type { MaterialSpec } from './materials';
import type { BayComponent, BuildingElement, BuildingFunction, FacadePattern, RoofDetail, Side, Volume } from './types';

/**
 * The tower kit: mid-rise and high-rise buildings in the manner of the
 * reference sheets the player brought on 2026-10-05 - a residential block
 * with balconies either side of a timber-clad stair column, a stone-framed
 * glass office, and the family of towers on a podium (glass with balconies,
 * beige with a stepped crown, dark glass, white slab edges, brick frame, a
 * rounded glass tower, a dark grid).
 *
 * Every tower is the building system's own blocks - a podium, the shaft in
 * one to three masses (wings and a projecting middle strip), a crown set
 * back, a lift overrun and plant on the roof, railings and planters on the
 * terrace, an entrance canopy and planters at the door - so it is edited,
 * moved and saved like any other building.
 *
 * Metres in the building's frame, the street along -y (the front is y = 0).
 */

export const TOWER_KINDS = [
  'balconyMid', 'glassOffice', 'glassBalcony', 'beigeClassic', 'darkGlass',
  'whiteBalcony', 'brickFrame', 'roundGlass', 'darkGrid', 'artDeco',
  // The second set: each a different form, balcony, window and colour.
  'twistGreen', 'hexTerracotta', 'stepGarden', 'waveWhite', 'cubeBalcony',
  'twinNavy', 'octCopper', 'stackedBlocks', 'pinkCorner', 'triangleDark',
  // The city's buildings: town halls, hospitals, a church, a school, services, a cemetery.
  'cityHallBrick', 'decoSpire', 'hospitalA', 'loftBrick', 'cityHallWhite', 'forum', 'church', 'bank', 'school',
  'fireStation', 'police', 'hospitalB', 'cemetery',
  // The landmarks (2026-10-09): built from the facade kit's modules (`render/buildings/landmarks.ts`).
  'beauxArts', 'decoTower', 'modernOffice', 'residentialTerrace', 'glassSpire',
] as const;
/** The second set, drawn by `render/buildings/signature.ts` per floor. */
export const SECOND_SET: readonly TowerKind[] = TOWER_KINDS.slice(10, 20);
/** The city's buildings: low, stood in a row of their own in front of the towers. */
export const CIVIC_SET: readonly TowerKind[] = TOWER_KINDS.slice(20, 33);
/** The landmarks: composed of real modules - windows, cornices, balconies, a mansard - not facade pictures. */
export const LANDMARK_SET: readonly TowerKind[] = TOWER_KINDS.slice(33);
export type TowerKind = (typeof TOWER_KINDS)[number];

export interface TowerSpec {
  readonly kind: TowerKind;
  /** Storeys above the ground floor; absent = the kind's own range. */
  readonly floors?: number;
  /** Footprint, metres; absent = the kind's own range. */
  readonly width?: number;
  readonly depth?: number;
}

interface Style {
  readonly fn: BuildingFunction;
  readonly use: 'residential' | 'commercial' | 'mixed';
  readonly floors: readonly [number, number];
  readonly width: readonly [number, number];
  readonly depth: readonly [number, number];
  /** The shaft's walls (wings), and its middle strip when it has one. */
  readonly wall: readonly MaterialSpec[];
  readonly strip?: readonly MaterialSpec[];
  readonly base: readonly MaterialSpec[];
  /** Front and back, then the ends. */
  readonly fill: BayComponent;
  readonly ends: BayComponent;
  readonly stripFill?: BayComponent;
  readonly pattern?: FacadePattern;
  readonly podium: readonly [number, number];
  /** How far the shaft stands in from the podium's edge. */
  readonly inset: number;
  /** Storeys of the crown, set back. */
  readonly crown: number;
  readonly opening: { readonly w: number; readonly h: number; readonly sill: number };
  readonly piers?: { readonly w: number; readonly d: number; readonly every: number };
  readonly round?: boolean;
  readonly storey: number;
  readonly ground: number;
}

const GLASS_BLUE = [mat('glass', 0x7d97b5), mat('glass', 0x6f8f9f), mat('glass', 0x8fb0c0)];
const GLASS_DARK = [mat('glass', 0x3f4f5c), mat('glass', 0x2f3a44), mat('glass', 0x4a5866)];
const STONE_LIGHT = [mat('stone', 0xd8d4cc), mat('stone', 0xcfc7b6), mat('ceramic', 0xd9d6cf)];
const PLASTER_LIGHT = [mat('plaster', 0xe9e4da), mat('plaster', 0xf1ede6), mat('stucco', 0xe2dbcf)];
const BEIGE = [mat('stucco', 0xe3cfa6), mat('stone', 0xd9c49a), mat('stucco', 0xe8d6b0)];
const WHITE = [mat('plaster', 0xf4f3ef), mat('plaster', 0xeceae4)];
const BRICK = [mat('brick', 0x9a4a35), mat('brick', 0x8c4a35), mat('brick', 0xa4563f)];
const WOOD = [mat('wood', 0x9a5f3c), mat('wood', 0x8a5232), mat('wood', 0xa56a42)];
const DARK = [mat('panel', 0x3a3f45), mat('panel', 0x2f3439), mat('metal', 0x41464c)];
const BASE_GREY = [mat('stone', 0x6f6a64), mat('ceramic', 0x5f6366), mat('stone', 0x8f877a)];
const BASE_LIGHT = [mat('stone', 0xbdb8ae), mat('stone', 0xc9c2b4)];

const STYLES: Record<TowerKind, Style> = {
  // Image 1: eight storeys, balconies on both wings, a timber column with the stairs.
  balconyMid: {
    fn: 'apartments', use: 'residential', floors: [6, 9], width: [20, 26], depth: [14, 18],
    wall: PLASTER_LIGHT, strip: WOOD, base: BASE_GREY, fill: 'balcony', ends: 'window', stripFill: 'window',
    podium: [1, 1], inset: 0, crown: 0, opening: { w: 0.62, h: 0.72, sill: 0.4 }, storey: 3.1, ground: 3.8,
  },
  // Image 2: a stone frame, glass between the piers, a glass strip up the middle.
  glassOffice: {
    fn: 'office', use: 'commercial', floors: [18, 26], width: [24, 30], depth: [20, 26],
    wall: STONE_LIGHT, strip: GLASS_BLUE, base: BASE_LIGHT, fill: 'ribbon', ends: 'ribbon', stripFill: 'ribbon',
    podium: [2, 2], inset: 0, crown: 2, opening: { w: 0.86, h: 0.78, sill: 0.25 },
    piers: { w: 0.5, d: 0.35, every: 4 }, storey: 3.7, ground: 5.5,
  },
  glassBalcony: {
    fn: 'residentialTower', use: 'residential', floors: [20, 28], width: [20, 26], depth: [18, 22],
    wall: GLASS_BLUE, strip: STONE_LIGHT, base: BASE_LIGHT, fill: 'balcony', ends: 'balcony', stripFill: 'ribbon',
    podium: [2, 3], inset: 2, crown: 2, opening: { w: 0.85, h: 0.8, sill: 0.15 }, storey: 3.1, ground: 4.5,
  },
  beigeClassic: {
    fn: 'residentialTower', use: 'residential', floors: [20, 26], width: [20, 24], depth: [18, 22],
    wall: BEIGE, base: BASE_LIGHT, fill: 'balcony', ends: 'window',
    podium: [2, 2], inset: 2, crown: 3, opening: { w: 0.5, h: 0.65, sill: 0.8 },
    piers: { w: 0.45, d: 0.2, every: 2 }, storey: 3.1, ground: 4.5,
  },
  darkGlass: {
    fn: 'office', use: 'commercial', floors: [22, 30], width: [20, 26], depth: [20, 24],
    wall: GLASS_DARK, base: DARK, fill: 'ribbon', ends: 'ribbon',
    podium: [2, 2], inset: 1.5, crown: 4, opening: { w: 0.92, h: 0.85, sill: 0.1 }, storey: 3.7, ground: 5.5,
  },
  whiteBalcony: {
    fn: 'residentialTower', use: 'residential', floors: [20, 26], width: [22, 26], depth: [18, 22],
    wall: WHITE, strip: GLASS_BLUE, base: BASE_LIGHT, fill: 'balcony', ends: 'balcony', stripFill: 'ribbon',
    podium: [2, 2], inset: 2, crown: 1, opening: { w: 0.8, h: 0.75, sill: 0.2 }, storey: 3.1, ground: 4.5,
  },
  brickFrame: {
    fn: 'residentialTower', use: 'residential', floors: [20, 26], width: [20, 24], depth: [18, 22],
    wall: BRICK, strip: GLASS_BLUE, base: BASE_GREY, fill: 'balcony', ends: 'window', stripFill: 'ribbon',
    podium: [2, 2], inset: 2, crown: 1, opening: { w: 0.6, h: 0.7, sill: 0.5 },
    piers: { w: 0.5, d: 0.3, every: 2 }, storey: 3.1, ground: 4.5,
  },
  roundGlass: {
    fn: 'residentialTower', use: 'residential', floors: [20, 26], width: [22, 26], depth: [20, 24],
    wall: GLASS_BLUE, base: BASE_LIGHT, fill: 'ribbon', ends: 'ribbon',
    podium: [2, 2], inset: 2, crown: 1, opening: { w: 0.9, h: 0.8, sill: 0.15 }, round: true, storey: 3.1, ground: 4.5,
  },
  darkGrid: {
    fn: 'residentialTower', use: 'residential', floors: [20, 26], width: [20, 24], depth: [18, 22],
    wall: DARK, base: DARK, fill: 'wideWindow', ends: 'wideWindow',
    podium: [2, 2], inset: 1.5, crown: 2, opening: { w: 0.78, h: 0.72, sill: 0.3 },
    piers: { w: 0.45, d: 0.3, every: 1 }, storey: 3.1, ground: 4.5,
  },
  artDeco: {
    fn: 'office', use: 'commercial', floors: [16, 22], width: [20, 24], depth: [18, 22],
    wall: BEIGE, base: BASE_LIGHT, fill: 'window', ends: 'window', pattern: 'artDeco',
    podium: [2, 3], inset: 1.5, crown: 3, opening: { w: 0.4, h: 0.7, sill: 0.8 },
    piers: { w: 0.6, d: 0.35, every: 2 }, storey: 3.5, ground: 5,
  },
  twistGreen: second('residentialTower', 'residential', [24, 30], 24, 24),
  hexTerracotta: second('residentialTower', 'residential', [16, 20], 24, 24),
  stepGarden: second('residentialTower', 'residential', [16, 20], 26, 24),
  waveWhite: second('residentialTower', 'residential', [20, 26], 24, 20),
  cubeBalcony: second('residentialTower', 'residential', [14, 18], 24, 20),
  twinNavy: second('office', 'commercial', [22, 28], 28, 20),
  octCopper: second('office', 'commercial', [22, 28], 24, 24),
  stackedBlocks: second('residentialTower', 'residential', [18, 22], 24, 20),
  pinkCorner: second('apartments', 'residential', [10, 14], 26, 24),
  triangleDark: second('office', 'commercial', [22, 28], 26, 24),
  cityHallBrick: second('cityHall', 'commercial', [3, 3], 30, 22),
  decoSpire: second('office', 'commercial', [30, 34], 26, 26),
  hospitalA: second('hospital', 'commercial', [12, 14], 34, 34),
  loftBrick: second('apartments', 'mixed', [9, 10], 22, 20),
  cityHallWhite: second('cityHall', 'commercial', [4, 4], 36, 26),
  forum: second('courthouse', 'commercial', [5, 5], 26, 24),
  church: second('church', 'commercial', [3, 3], 30, 36),
  bank: second('bank', 'commercial', [5, 5], 22, 22),
  school: second('school', 'commercial', [3, 3], 40, 28),
  fireStation: second('fireStation', 'commercial', [3, 3], 30, 26),
  police: second('police', 'commercial', [3, 3], 28, 22),
  hospitalB: second('hospital', 'commercial', [8, 9], 32, 30),
  cemetery: second('cemetery', 'commercial', [3, 3], 40, 40),
  // A Beaux-Arts hotel: tall classical storeys; an Art Deco office; a modernist office; flats; a glass office tower.
  beauxArts: second('hotel', 'commercial', [10, 10], 25, 20, 3.7, 5.6),
  decoTower: second('office', 'commercial', [23, 23], 22, 18, 3.6, 5.2),
  modernOffice: second('office', 'commercial', [17, 17], 30, 19, 3.7, 4.6),
  residentialTerrace: second('apartments', 'mixed', [22, 22], 25, 21, 3.1, 4.6),
  glassSpire: second('office', 'commercial', [24, 24], 22, 22, 3.7, 5.2),
};

/** A second-set kind: only its blocks' sizes matter, its look is its own (`signature.ts`). */
function second(fn: Style['fn'], use: Style['use'], floors: readonly [number, number], w: number, d: number, storey = 3.2, ground = 4.5): Style {
  return {
    fn, use, floors, width: [w, w], depth: [d, d], wall: PLASTER_LIGHT, base: BASE_LIGHT, fill: 'window', ends: 'window',
    podium: [2, 2], inset: 0, crown: 0, opening: { w: 0.6, h: 0.6, sill: 0.8 }, storey, ground,
  };
}

const pick = <T>(rng: Rng, list: readonly T[]): T => list[rng.int(0, list.length - 1)] as T;
const half = (x: number): number => Math.round(x * 2) / 2;

/** A dodecagon's corners, in the unit square (a rounded tower's plan). */
const ROUND = Array.from({ length: 12 }, (_, i) => {
  const a = (i * Math.PI * 2) / 12 + Math.PI / 12;
  return { x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) };
});

/** The facade of every storey of a block: `front` on front and back, `ends` on the sides. */
function dress(v: Volume, front: BayComponent, ends: BayComponent, st: Style, pattern?: FacadePattern, piers = true): void {
  for (const s of v.storeys) {
    s.facade.fill = front;
    s.facade.sides = { ...(s.facade.sides ?? {}), 1: ends, 3: ends };
  }
  const g = {
    windowWidth: st.opening.w, windowHeight: st.opening.h, sill: m(st.opening.sill),
    ...(piers && st.piers && v.storeys.length >= 3 ? { pierWidth: m(st.piers.w), pierDepth: m(st.piers.d), pierEvery: st.piers.every } : {}),
  };
  v.facadeGeometry = { 0: { ...g }, 1: { ...g }, 2: { ...g }, 3: { ...g } };
  if (pattern) v.facadePattern = pattern;
}

/** Makes one tower of the kit. */
export function makeTower(spec: TowerSpec, rng: Rng): BlueprintBody {
  const st = STYLES[spec.kind];
  const W = half(spec.width ?? st.width[0] + rng.float() * (st.width[1] - st.width[0]));
  const D = half(spec.depth ?? st.depth[0] + rng.float() * (st.depth[1] - st.depth[0]));
  const floors = Math.max(3, Math.min(56, spec.floors ?? rng.int(st.floors[0], st.floors[1])));
  const podium = rng.int(st.podium[0], st.podium[1]);
  const wall = pick(rng, st.wall);
  const strip = st.strip ? pick(rng, st.strip) : null;
  const base = pick(rng, st.base);
  const model = new Model(st.fn, st.use, rng.int(0, 7)).heights(st.ground, st.storey)
    .look(wall, mat('concrete', 0x8a8a86), pick(rng, STONE_LIGHT));

  // The podium: the street floors in the base material, shopfront or lobby glass.
  const podiumFill: BayComponent = st.use === 'commercial' ? 'shopfront' : 'wideWindow';
  model.block({ x: 0, y: 0, w: W, d: D, storeys: podium, ground: podiumFill, fill: podiumFill, door: 'middle', doorKind: 'doubleDoor',
    roof: 'terrace', wall: base });

  // The shaft: two wings and a middle strip that stands forward and one storey higher,
  // or one mass (a rounded tower is one mass on a round plan).
  const ix = st.inset, iy = st.inset;
  const sw = W - 2 * ix, sd = D - 2 * iy;
  const shaft = floors - podium - st.crown;
  const blocks: { v: number; front: BayComponent; ends: BayComponent; mat: MaterialSpec }[] = [];
  const add = (x: number, y: number, w: number, d: number, b: number, n: number, material: MaterialSpec, front: BayComponent, ends: BayComponent,
    extra: { shape?: Volume['outline'] } = {}): void => {
    model.block({ x, y, w, d, base: b, storeys: n, roof: 'flat', wall: material, fill: front, ...extra });
    blocks.push({ v: blocks.length + 1, front, ends, mat: material });
  };
  if (st.round) {
    add(ix, iy, sw, sd, podium, shaft, wall, st.fill, st.ends, { shape: ROUND });
  } else if (strip && sw >= 14) {
    const mw = half(Math.max(4, sw * 0.22));
    const lw = half((sw - mw) / 2);
    add(ix, iy, lw, sd, podium, shaft, wall, st.fill, st.ends);
    add(ix + lw + mw, iy, sw - lw - mw, sd, podium, shaft, wall, st.fill, st.ends);
    add(ix + lw, iy - 0.6, mw, sd + 0.6, podium, shaft + 1, strip, st.stripFill ?? st.fill, st.ends);
  } else {
    add(ix, iy, sw, sd, podium, shaft, wall, st.fill, st.ends);
  }
  // The crown: set back, in the wall's material.
  if (st.crown > 0) {
    const c = half(Math.min(sw, sd) * 0.12 + 1);
    add(ix + c, iy + c, sw - 2 * c, sd - 2 * c, podium + shaft, st.crown, st.round ? wall : wall, st.fill === 'balcony' ? 'window' : st.fill, st.ends,
      st.round ? { shape: ROUND } : {});
  }
  model.core('stairLift', half(W / 2 - 1.5), half(D / 2 - 1.5), floors + 1);

  // The street: an entrance canopy, planters with shrubs either side of the door.
  model.el('canopy', W / 2, -1.1, 0, { w: Math.min(8, W * 0.35), d: 2.2, h: 0.2, z: Math.min(st.ground - 0.4, 3.6), material: mat('metal', 0x3a3f45) });
  for (const sx of [-1, 1]) {
    const x = W / 2 + sx * (Math.min(8, W * 0.35) / 2 + 2.2);
    model.el('planter', x, -1.2, 0, { w: 3.2, d: 1.2, h: 0.6, material: mat('concrete', 0x9a9893) });
    model.el('shrub', x, -1.2, 0, { w: 1.2, d: 1.2, h: 1.4, z: 0.6 });
  }
  for (const x of [1.5, W - 1.5]) model.el('tree', x, -1.6, 0, { w: 2.2, d: 2.2, h: 4.5 });

  const body = model.build();
  const vols = body.volumes;
  // Facades: podium glass with the base material, the shaft's blocks their own.
  dress(vols[0]!, podiumFill, podiumFill, st, undefined, false);
  vols[0]!.storeys[0]!.facade.bays = { [`0:${Math.floor(Math.max(1, Math.round(W / 3)) / 2)}`]: 'doubleDoor' };
  blocks.forEach((b) => dress(vols[b.v]!, b.front, b.ends, st, st.pattern));

  // A timber strip of image 1 carries the stair: windows only, the wings balconies.
  // The roof of the top block: a terrace with plant, the lift overrun, a water tank.
  // The plant stands on the largest block of the top (a narrow strip holds none of it).
  const topLevel = Math.max(...vols.map((v) => v.base + v.storeys.length));
  const top = vols.filter((v) => v.base + v.storeys.length >= topLevel - 1 && v.base > 0)
    .sort((p, q) => q.w * q.d - p.w * p.d)[0] ?? vols[vols.length - 1]!;
  const details: RoofDetail[] = [];
  const add2 = (kind: RoofDetail['kind'], x: number, y: number, w: number, d: number, h?: number): void => {
    // Roof parts are placed in the building's frame (`roofPartFits`), not the block's.
    details.push({ id: details.length + 1, kind, x: top.x + m(x), y: top.y + m(y), rotation: 0, w: m(w), d: m(d), ...(h ? { h: m(h) } : {}) });
  };
  const tw = top.w / m(1), td = top.d / m(1);
  add2('vent', tw * 0.25, td * 0.3, 2.4, 1.6, 1.4);
  add2('vent', tw * 0.75, td * 0.3, 2.4, 1.6, 1.4);
  add2('waterTank', tw * 0.7, td * 0.7, 3, 3, 3);
  if (st.use === 'residential') add2('solar', tw * 0.3, td * 0.72, 3.5, 2.2);
  top.roofDetails = details;
  if (st.use === 'residential' && !st.round) top.roof = 'terrace';

  // The roof terrace of image 1: a railing round its edge and planters with trees.
  if (spec.kind === 'balconyMid') {
    const z = st.ground + (floors - 1) * st.storey;
    const tx = top.x / m(1), ty = top.y / m(1);
    const add3 = (el: BuildingElement): void => {
      (body.elements ??= []).push(el);
    };
    let id = (body.elements?.length ?? 0) + 1;
    const rail = (x: number, y: number, facing: Side, w: number): void => add3({ id: id++, kind: 'railing', x: m(x), y: m(y), facing, w: m(w), d: m(0.1), h: m(1.05), z: m(z) });
    // Over the whole roof (the wings and the strip), in pieces.
    for (const [x, y, f, w] of [
      [W / 2, 0.1, 0, W - 0.4], [W / 2, D - 0.1, 2, W - 0.4], [0.1, D / 2, 3, D - 0.4], [W - 0.1, D / 2, 1, D - 0.4],
    ] as const) {
      const n = Math.ceil(w / 8);
      for (let k = 0; k < n; k++) {
        const off = (k + 0.5) * (w / n) - w / 2;
        rail(f === 0 || f === 2 ? x + off : x, f === 0 || f === 2 ? y : y + off, f, w / n);
      }
    }
    for (const [x, y] of [[2, 1.5], [W - 2, 1.5], [W * 0.3, 1.5], [W * 0.7, 1.5]] as const) {
      add3({ id: id++, kind: 'planter', x: m(x), y: m(y), facing: 0, w: m(1.4), d: m(1), h: m(0.6), z: m(z) });
      add3({ id: id++, kind: 'shrub', x: m(x), y: m(y), facing: 0, w: m(1.1), d: m(1.1), h: m(1.3), z: m(z + 0.6) });
    }
    // Plants on the balconies: a pot at each wing's outer balcony, every floor.
    for (let s = 1; s < floors; s++) {
      const zz = st.ground + (s - 1) * st.storey;
      for (const x of [1.2, W - 1.2]) {
        add3({ id: id++, kind: 'shrub', x: m(x), y: m(ix - 0.8), facing: 0, w: m(0.8), d: m(0.8), h: m(1), z: m(zz + 0.05) });
      }
    }
    void tx; void ty;
    body.nextElementId = id;
  }
  if (SIGNATURES.has(spec.kind)) {
    // Drawn with parts of its own (`render/buildings/signature.ts`): the blocks
    // stay for picking, collisions and the lot; the shared dress goes.
    body.blueprint = `signature:${spec.kind}`;
    delete body.elements;
    body.nextElementId = 1;
    for (const v of body.volumes) delete v.roofDetails;
    body.cores = [];
  }
  return body;
}

/** The kinds drawn by their own parts. */
const SIGNATURES: ReadonlySet<TowerKind> = new Set(TOWER_KINDS);

/** The signature a building is drawn with, or null for the shared facade kit. */
export function signatureKind(b: { readonly blueprint?: string }): TowerKind | null {
  const kind = b.blueprint?.startsWith('signature:') ? b.blueprint.slice(10) : null;
  return kind && (TOWER_KINDS as readonly string[]).includes(kind) ? kind as TowerKind : null;
}
