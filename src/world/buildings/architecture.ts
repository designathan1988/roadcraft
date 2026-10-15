import type { Rng } from '@core/rng';
import { m, stepsIn } from '../units';
import { mat } from './cityBuildings';
import { volumeSides } from './footprints';
import { sideLength } from './geometry';
import type { MaterialSpec } from './materials';
import { type BayComponent, type FaceId, type FacadeGeometry, type Volume, type VolumeDress, bayKey } from './types';

/**
 * ARCHITECTURAL STYLES for the grown buildings, as a facade grammar.
 *
 * What made the generated city look generic (the player, 2026-10-09: "prédios
 * feios e genéricos"): every block was the same layer cake - a white moulding
 * at every floor, one window component repeated over every bay, a cornice -
 * with only the paint and the window drawn at random, so two buildings
 * differed in colour and not in kind, and the window, colour and roof of one
 * building were combinations without a reason.
 *
 * Here a style is a whole design, as CityEngine's facade rules write it
 * (Esri, CityEngine tutorials 6 and 9, "Basic/Advanced shape grammar":
 * the facade split into a ground floor and repeated upper floors, each floor
 * into a row of tiles, the tiles indexed so the same rule places the same
 * element in every floor's same column; Müller, Wonka et al., "Procedural
 * Modeling of Buildings", SIGGRAPH 2006), and as the classical facade is
 * composed: base, body and crown (Sullivan's base, shaft and cornice for a
 * tall building; the embasamento, corpo and coroamento of a Brazilian one):
 *
 * - COLUMNS, not bays at random: a facade is shared into an odd number of
 *   columns where it can be (a middle axis for the entrance), and each column
 *   takes its component from the style's RHYTHM, counted from the ends in,
 *   so the facade is symmetric and every opening stands over the one below;
 * - BASE, BODY, CROWN: the ground floor is the building's use (shopfronts, a
 *   lobby, a house's rooms), the body the rhythm, the top floor the style's
 *   own crown floor when the block is tall enough to have one;
 * - LINES and CROWN (`VolumeDress`): which horizontal mouldings the style
 *   draws - none, one string course over the base, flush slab edges, or a
 *   moulding at every floor - and how the top is finished (a cornice, a
 *   stepped deco cornice, a thin projecting slab, a deep plain attic);
 * - a SKIN family, a TRIM family that goes with it and the window's
 *   proportions: the colours vary inside the family, never across it.
 *
 * A building is ONE skin: its wings, its stepped top and its penthouse wear
 * the same walls (the player rejected stacked skins as "prédios empilhados").
 */

export type StyleKey =
  | 'colonial' | 'artDeco' | 'modernist' | 'contemporary' | 'brick' | 'tropical' | 'glass' | 'industrial'
  | 'colonialHouse' | 'bungalow' | 'modernHouse' | 'sobrado';

export type GroundRole = 'shop' | 'lobby' | 'house' | 'works';

export interface ArchStyle {
  readonly key: StyleKey;
  /** The walls of the body: one family, each a finish and a colour. */
  readonly skins: readonly MaterialSpec[];
  /** Frames, railings, mouldings and fins: colours that go with the skins. */
  readonly trims: readonly MaterialSpec[];
  /** Column rhythms of the body's street and back faces, counted from the ends in. */
  readonly rhythms: readonly (readonly BayComponent[])[];
  /** What the end faces (left and right) carry. */
  readonly sideFill: BayComponent;
  /** The ground floor of a lobby or a house (a shop's is its shopfronts). */
  readonly groundFill: BayComponent;
  /** The top floor of a block of four floors or more, or null for the body's. */
  readonly top: BayComponent | null;
  readonly dress: Required<VolumeDress>;
  /** The window's share of its bay's width and storey's height, and its sill (metres). */
  readonly opening: { readonly width: readonly [number, number]; readonly height: readonly [number, number]; readonly sill: number };
  /** Projecting piers between columns, metres: width, depth, every how many columns. */
  readonly piers?: { readonly width: number; readonly depth: number; readonly every: number };
  /** The ground floor wears a harder version of the skin (stone of the same tone). */
  readonly stoneBase?: boolean;
  /** The column module this style lays its openings on, metres. */
  readonly module: number;
}

const tones = (finish: MaterialSpec['finish'], colours: readonly number[]): MaterialSpec[] => colours.map((c) => mat(finish, c));

export const STYLES: Readonly<Record<StyleKey, ArchStyle>> = {
  // A street of the old centre: rendered in strong colours, white frames and
  // surrounds, louvred shutters, a cornice and parapet hiding the roof.
  colonial: {
    key: 'colonial',
    skins: tones('plaster', [0xe9c46a, 0xd98c5f, 0x7fa8c9, 0xe8a7a0, 0x9cc5a1, 0xf1e3c6, 0xc96f53, 0xe0b54b, 0x88a9b5, 0xd7b9d5]),
    trims: [mat('plaster', 0xf7f4ec), mat('plaster', 0xf1ead9)],
    rhythms: [['shutteredWindow'], ['shutteredWindow', 'frenchWindow', 'shutteredWindow'], ['frenchWindow', 'balcony', 'frenchWindow'], ['frenchWindow']],
    sideFill: 'window', groundFill: 'shutteredWindow', top: null,
    dress: { lines: 'base', crown: 'cornice' },
    opening: { width: [0.36, 0.42], height: [0.6, 0.66], sill: 0.9 },
    module: 3,
  },
  // Stone and cream render, bronze frames, vertical piers rising the whole
  // body, a stepped cornice: the 1930s-50s blocks of Copacabana and the centro.
  artDeco: {
    key: 'artDeco',
    skins: [...tones('stucco', [0xe8dcc4, 0xdccaa6, 0xefe4cf, 0xd8c7ad]), ...tones('stone', [0xcfc4ae, 0xd9cdb4])],
    trims: [mat('metal', 0x5f4a33), mat('plaster', 0xf0e8d6), mat('metal', 0x3b3d3f)],
    rhythms: [['sashWindow'], ['sashWindow', 'sashWindow', 'bayWindow']],
    sideFill: 'sashWindow', groundFill: 'window', top: 'window',
    dress: { lines: 'none', crown: 'deco' },
    opening: { width: [0.36, 0.42], height: [0.62, 0.7], sill: 0.85 },
    piers: { width: 0.55, depth: 0.32, every: 1 },
    stoneBase: true,
    module: 2.8,
  },
  // Brazilian modernism: light walls or pastilhas, brise-soleil columns,
  // ribbon windows, the slabs shown, a thin roof slab over all.
  modernist: {
    key: 'modernist',
    skins: [...tones('ceramic', [0xe9ecea, 0x9fbfcf, 0xa9cbb4, 0xe8d38f, 0x7fa0bf, 0xd9a07a, 0x8fb5a8]), ...tones('plaster', [0xf2f0ea, 0xe6e4dc])],
    trims: [mat('plaster', 0xf4f3ee), mat('metal', 0xb9bcbd), mat('concrete', 0xd6d2c8)],
    rhythms: [['brise'], ['ribbon', 'brise', 'brise'], ['brise', 'ribbon']],
    sideFill: 'ribbon', groundFill: 'wideWindow', top: 'ribbon',
    dress: { lines: 'slab', crown: 'slab' },
    opening: { width: [0.7, 0.85], height: [0.5, 0.58], sill: 0.9 },
    module: 3,
  },
  // Today's residential block: light render or pale pastilha, graphite
  // frames, continuous glass-railed balconies (varandas gourmet) stacked in
  // columns, loggias, a deep plain attic for a crown.
  contemporary: {
    key: 'contemporary',
    // Light renders, and the colours of today's Brazilian blocks kept to
    // earth and mineral tones (terracotta, sand, sage, slate, graphite, a
    // deep teal) - never a candy colour, never all beige.
    skins: [...tones('plaster', [0xf1f0ec, 0xe7e3dc, 0xcfc8bd, 0xd8b99a, 0xb7c2b0]),
      ...tones('ceramic', [0x8e959a, 0xb4673f, 0xc9a27a, 0x7d8b78, 0x4a5258, 0x3f6b72, 0xa65f45, 0x6f7f91]), mat('concrete', 0xbab7b0)],
    trims: [mat('metal', 0x2e3134), mat('metal', 0x4a4f53), mat('metal', 0x8e9396)],
    rhythms: [['gourmet', 'window', 'gourmet'], ['window', 'gourmet', 'gourmet'], ['loggia', 'window'], ['gourmet', 'gourmet', 'window', 'window']],
    sideFill: 'window', groundFill: 'wideWindow', top: 'wideWindow',
    dress: { lines: 'none', crown: 'attic' },
    opening: { width: [0.6, 0.75], height: [0.52, 0.6], sill: 0.8 },
    module: 3.2,
  },
  // Exposed brick, white or black frames, concrete lintels at every floor, a cornice.
  brick: {
    key: 'brick',
    skins: tones('brick', [0xa4563f, 0x8c4a35, 0xb86a4a, 0x9a6a52, 0xb07a5a, 0x7d5444]),
    trims: [mat('plaster', 0xf4f2ec), mat('metal', 0x26282a), mat('metal', 0x2f4a3a)],
    rhythms: [['window'], ['window', 'frenchWindow', 'window'], ['balcony', 'window', 'window']],
    sideFill: 'window', groundFill: 'window', top: null,
    dress: { lines: 'every', crown: 'cornice' },
    opening: { width: [0.45, 0.55], height: [0.6, 0.64], sill: 0.85 },
    piers: { width: 0.35, depth: 0.12, every: 1 },
    module: 3,
  },
  // The coloured Brazilian block of the 60s-70s: ceramic tile cladding in a
  // strong colour, ribbon windows, balconies with metal railings.
  tropical: {
    key: 'tropical',
    skins: tones('ceramic', [0x3f78a8, 0x4f9a86, 0xc0633f, 0xd3a03a, 0x2f6f8f, 0x8fb9a0, 0xb84a3a, 0x6f8fb8, 0xe0c27a, 0x5a8a5a]),
    trims: [mat('plaster', 0xf7f5ef), mat('metal', 0x26282a)],
    rhythms: [['ribbon'], ['balcony', 'ribbon', 'balcony'], ['ribbon', 'balcony']],
    sideFill: 'window', groundFill: 'window', top: null,
    dress: { lines: 'slab', crown: 'slab' },
    opening: { width: [0.7, 0.85], height: [0.46, 0.54], sill: 0.9 },
    module: 3,
  },
  // A curtain wall: tinted glass from floor to floor, slim black or silver mullions.
  glass: {
    key: 'glass',
    skins: tones('glass', [0x8fb0c0, 0x6f8f9f, 0x9fb8b0, 0x7d97b5, 0x5d7280, 0x4f7f6a, 0x8a6f4f, 0x2f4f7f, 0x3f7f86, 0xb8a68a]),
    trims: [mat('metal', 0x1e2022), mat('metal', 0x8e9396)],
    rhythms: [['wideWindow']],
    sideFill: 'wideWindow', groundFill: 'wideWindow', top: null,
    dress: { lines: 'none', crown: 'attic' },
    opening: { width: [0.92, 0.94], height: [0.78, 0.82], sill: 0.25 },
    module: 3,
  },
  // Sheds: metal or fibre-cement panels, a parapet hiding the roof edge.
  industrial: {
    key: 'industrial',
    skins: [...tones('panel', [0x8f9ba5, 0xa3a9a6, 0x9aa49a, 0x7f8b8f, 0x6f7f8c, 0x8a9a7c, 0xc2b8a3]), ...tones('metal', [0xb7b2a6, 0x7c8a96]), mat('concrete', 0xb0aca2)],
    trims: [mat('metal', 0x3b4044), mat('metal', 0xd8dad6)],
    rhythms: [['ribbon']],
    sideFill: 'wall', groundFill: 'wall', top: null,
    dress: { lines: 'none', crown: 'attic' },
    opening: { width: [0.9, 0.9], height: [0.4, 0.4], sill: 1.2 },
    module: 3,
  },
  // Houses.
  colonialHouse: {
    key: 'colonialHouse',
    skins: tones('plaster', [0xf2d98a, 0xe8c66a, 0xf0c4a4, 0x9fc4a8, 0xb8d0e0, 0xeac6cc, 0xf6f1e6, 0xd98e6a, 0xa9c6c9, 0xe9cf8f]),
    trims: [mat('plaster', 0xf7f5ef)],
    rhythms: [['shutteredWindow']],
    sideFill: 'window', groundFill: 'shutteredWindow', top: null,
    dress: { lines: 'none', crown: 'cornice' },
    opening: { width: [0.38, 0.42], height: [0.58, 0.62], sill: 0.95 },
    module: 2.6,
  },
  bungalow: {
    key: 'bungalow',
    skins: [...tones('plaster', [0xf2ead8, 0xe9dcc0, 0xf0e4cc, 0xe4d6bc, 0xcfe0c3, 0xd5e3ec, 0xf3e1a6]), ...tones('stucco', [0xe8dcc2, 0xd9c6a8])],
    trims: [mat('plaster', 0xf7f5ef), mat('wood', 0x7a5536), mat('plaster', 0x2f5a7a), mat('plaster', 0x3d6b45)],
    rhythms: [['window'], ['window', 'frenchWindow', 'window']],
    sideFill: 'window', groundFill: 'window', top: null,
    dress: { lines: 'none', crown: 'none' },
    opening: { width: [0.4, 0.55], height: [0.5, 0.58], sill: 1 },
    module: 3,
  },
  modernHouse: {
    key: 'modernHouse',
    skins: [...tones('plaster', [0xf4f3ef, 0xe6e4df, 0xd8d5ce, 0x5b6064]), mat('concrete', 0xb8b5ae), mat('wood', 0x9c6b43), ...tones('ceramic', [0xc9c4ba, 0x8e8a84])],
    trims: [mat('metal', 0x2e3134), mat('metal', 0x8e9396)],
    rhythms: [['wideWindow'], ['wideWindow', 'loggia'], ['frenchWindow', 'wideWindow']],
    sideFill: 'window', groundFill: 'wideWindow', top: null,
    dress: { lines: 'none', crown: 'slab' },
    opening: { width: [0.7, 0.85], height: [0.55, 0.65], sill: 0.6 },
    module: 3,
  },
  sobrado: {
    key: 'sobrado',
    skins: [...tones('plaster', [0xf1d98a, 0xf0c4a4, 0xb9d3b0, 0xb8d0e0, 0xd9c2d8, 0xe9dcc0, 0xc9714f, 0x7fa88f]), ...tones('brick', [0xa4563f, 0xb86a4a])],
    trims: [mat('plaster', 0xf7f5ef), mat('plaster', 0xeee6d2), mat('wood', 0x7a5536)],
    rhythms: [['sashWindow'], ['frenchWindow', 'sashWindow'], ['balcony', 'sashWindow']],
    sideFill: 'window', groundFill: 'window', top: null,
    dress: { lines: 'base', crown: 'cornice' },
    opening: { width: [0.4, 0.48], height: [0.6, 0.66], sill: 0.9 },
    module: 2.8,
  },
};

/** The styles each kind of building is drawn from, with their weights. */
const FOR: Readonly<Record<'house' | 'flats' | 'tower' | 'shop' | 'office' | 'works', readonly (readonly [StyleKey, number])[]>> = {
  house: [['bungalow', 3], ['colonialHouse', 2], ['modernHouse', 2], ['sobrado', 2]],
  flats: [['contemporary', 3], ['colonial', 1], ['artDeco', 2], ['modernist', 2], ['brick', 1.5], ['tropical', 2]],
  tower: [['contemporary', 4], ['modernist', 2], ['artDeco', 1.5], ['tropical', 1.5], ['glass', 1]],
  shop: [['colonial', 3], ['artDeco', 2], ['brick', 2], ['contemporary', 2], ['modernist', 1.5], ['tropical', 1]],
  office: [['glass', 4], ['modernist', 2], ['contemporary', 1.5], ['artDeco', 1]],
  works: [['industrial', 1]],
};

/**
 * The ERA of a quarter of the city: its buildings were mostly put up in one
 * period, so they share a family of styles (the old centre of render,
 * shutters and deco; the 1950s-70s ring of modernist and tiled blocks; the
 * new quarters of glass, gourmet balconies and modern houses). 0 old, 1 the
 * modern middle years, 2 new. How much each style belongs to each era.
 */
export type Era = 0 | 1 | 2;
const ERA_AFFINITY: Readonly<Record<StyleKey, readonly [number, number, number]>> = {
  colonial: [3, 0.5, 0.15], artDeco: [2.5, 1, 0.2], brick: [2, 1.5, 0.5], sobrado: [3, 1.5, 0.3], colonialHouse: [3, 0.8, 0.2],
  bungalow: [1.5, 2, 1.5], tropical: [0.5, 3, 0.5], modernist: [0.7, 3, 1], contemporary: [0.3, 1, 3], glass: [0.2, 1, 3],
  modernHouse: [0.2, 1, 3], industrial: [1, 1, 1],
};

/**
 * The style of a building of `kind`: its quarter's era weighs the styles
 * (`ERA_AFFINITY`); then half the time the street's own (its `character`,
 * so a street side reads as one), else drawn by weight.
 */
export function styleFor(kind: keyof typeof FOR, rng: Rng, character?: number, era?: Era): ArchStyle {
  const list = FOR[kind].map(([key, w]) => [key, w * (era === undefined ? 1 : ERA_AFFINITY[key][era])] as const);
  const total = list.reduce((s, [, w]) => s + w, 0);
  if (character !== undefined && rng.float() < 0.5) {
    // The street's style: the weights laid out on a line, the character a point on it.
    let at = ((character * 2654435761) >>> 0) / 4_294_967_296 * total;
    for (const [key, w] of list) { if ((at -= w) < 0) return STYLES[key]; }
  }
  let at = rng.float() * total;
  for (const [key, w] of list) { if ((at -= w) < 0) return STYLES[key]; }
  return STYLES[list[0]![0]];
}

const pick = <T>(rng: Rng, list: readonly T[]): T => list[rng.int(0, list.length - 1)] as T;
const between = (rng: Rng, [a, b]: readonly [number, number]): number => a + (b - a) * rng.float();

/** The colour of a skin, nudged a little in lightness: two buildings of one paint are never the same. */
function tint(c: number, rng: Rng): number {
  const k = 0.95 + rng.float() * 0.1;
  const ch = (s: number): number => Math.max(0, Math.min(255, Math.round(((c >> s) & 255) * k)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** A building's paints within its style: the skin, the trim that goes with it. */
export interface StylePaints {
  readonly wall: MaterialSpec;
  readonly trim: MaterialSpec;
}
export function paintsOf(style: ArchStyle, rng: Rng): StylePaints {
  const skin = pick(rng, style.skins);
  const wall = { ...skin, colour: tint(skin.colour, rng) };
  // A light frame on a light wall disappears: on a pale skin, a style with a
  // dark trim on its list prefers it.
  const light = (c: number): boolean => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255) > 600;
  const trims = light(wall.colour) && style.trims.some((t) => !light(t.colour)) && rng.float() < 0.5
    ? style.trims.filter((t) => !light(t.colour)) : style.trims;
  return { wall, trim: pick(rng, trims) };
}

/**
 * How many columns a face of `length` units is shared into on a module of
 * `module` metres: odd when an odd count is as near the module as an even
 * one (a middle axis), never fewer than one.
 */
export function columnsFor(length: number, module: number): number {
  const exact = stepsIn(length, module);
  const n = Math.max(1, Math.round(exact));
  if (n % 2 === 1 || n < 2) return n;
  // The odd count either side of n, whichever is nearer the module.
  const lo = n - 1, hi = n + 1;
  const best = Math.abs(exact - lo) <= Math.abs(exact - hi) ? lo : hi;
  return Math.abs(exact - best) <= 0.75 ? best : n;
}

/** The component of column `i` of `n` in a rhythm counted from the ends in (symmetric). */
export function columnComponent(rhythm: readonly BayComponent[], i: number, n: number): BayComponent {
  const k = Math.min(i, n - 1 - i);
  return rhythm[k % rhythm.length]!;
}

/** What a composition was given, for the parts of the building that follow it (the door, the dress). */
export interface Composition {
  readonly style: ArchStyle;
  readonly rhythm: readonly BayComponent[];
  readonly geometry: FacadeGeometry;
}

/**
 * Composes a building's solid blocks in a style: columns on every face, the
 * rhythm on the street and back faces, the side fill on the ends, the ground
 * floor by its role, the crown floor, the dress. One rhythm and one set of
 * proportions for the whole building, so its wings and steps read as one.
 */
export function composeFacades(volumes: readonly Volume[], style: ArchStyle, rng: Rng, ground: GroundRole, rhythm = pick(rng, style.rhythms)): Composition {
  const geometry: FacadeGeometry = {
    windowWidth: between(rng, style.opening.width),
    windowHeight: between(rng, style.opening.height),
    sill: m(style.opening.sill),
    ...(style.piers ? { pierWidth: m(style.piers.width), pierDepth: m(style.piers.depth), pierEvery: style.piers.every } : {}),
  };
  const tallest = Math.max(0, ...volumes.filter((v) => !v.open).map((v) => v.base + v.storeys.length));
  for (const v of volumes) {
    if (v.open) continue;
    // A block with another standing on it (a setback, a base under its
    // tower) carries no cornice of its own: a moulding at every step read
    // as stacked buildings. Only the top of the building is crowned.
    const carries = volumes.some((o) => o !== v && !o.open && o.base === v.base + v.storeys.length
      && o.x < v.x + v.w && o.x + o.w > v.x && o.y < v.y + v.d && o.y + o.d > v.y);
    v.dress = { ...style.dress, ...(carries ? { crown: 'none' as const } : {}) };
    const faces = volumeSides(v);
    const counts = new Map<FaceId, number>();
    v.facadeGeometry = {};
    for (const side of faces) {
      const n = columnsFor(sideLength(v, side), style.module);
      counts.set(side, n);
      // Piers on a block of three floors or more only; a low one stays plain.
      const g: FacadeGeometry = { ...geometry, bays: n };
      if (v.storeys.length < 3) { delete g.pierWidth; delete g.pierDepth; delete g.pierEvery; }
      v.facadeGeometry[side] = g;
    }
    const top = v.base + v.storeys.length - 1;
    v.storeys.forEach((storey, k) => {
      const level = v.base + k;
      const crownFloor = style.top !== null && tallest >= 4 && level === tallest - 1 && level === top && level > 0;
      const bays: Record<string, BayComponent> = {};
      let fill: BayComponent;
      if (level === 0) {
        fill = ground === 'shop' ? 'shopfront' : ground === 'works' ? 'wall' : style.groundFill;
      } else if (crownFloor) {
        fill = style.top!;
      } else {
        fill = style.sideFill;
        // The street and the back: the rhythm, column by column.
        for (const side of faces) {
          // The street and the back of a block; on a shaped plan, its long faces only.
          if (v.outline ? counts.get(side)! < 3 : side === 1 || side === 3) continue;
          const n = counts.get(side)!;
          for (let i = 0; i < n; i++) {
            const c = columnComponent(rhythm, i, n);
            // Every column of the rhythm that is not the fill (the comment here
            // promised to turn a balcony over a shop's street into a window;
            // nothing does: noted as a defect to decide).
            if (c !== fill) bays[bayKey(side, i)] = c;
          }
        }
      }
      // A component that needs a floor under it is not drawn at the ground.
      if (level === 0 && (fill === 'gourmet' || fill === 'loggia' || fill === 'balcony')) fill = 'wideWindow';
      storey.facade = { fill, ...(Object.keys(bays).length ? { bays } : {}) };
    });
  }
  return { style, rhythm, geometry };
}

/** The stone of the base of a style that has one: the skin's tone, a harder finish, a shade darker. */
export function stoneBaseOf(wall: MaterialSpec): MaterialSpec {
  const k = 0.86;
  const ch = (s: number): number => Math.round(((wall.colour >> s) & 255) * k);
  return mat('stone', (ch(16) << 16) | (ch(8) << 8) | ch(0));
}
