import {
  archedDormer, awning, balcony, balustrade, band, bellMansard, cartouche, consoles, cornice, curtain, door, facesOf, fbox, finial, fpoint,
  hedge, lampPost, pier, plantedTree, punched, railFace, repeat, span, spire, WALL, type Sink,
} from './facadeKit';

/**
 * The five buildings of the reference sheet the player gave on 2026-10-09
 * (oldest to newest), modelled after it piece by piece from the facade kit
 * (`facadeKit.ts`):
 *
 * A. a Beaux-Arts hotel: five bays between colossal pilasters and corner
 *    pavilions, carved panels under the windows, a rusticated base of three
 *    arches (awnings either side, the arched entrance in the middle) and an
 *    arcade down the side, an attic of cartouches under a bracketed cornice,
 *    a balustrade with planters, a bell mansard in green copper with arched
 *    dormers, finials and a two-level penthouse;
 * B. an Art Deco office tower: stone wings either side of a recessed middle
 *    strip between massive piers, gilded spandrels, a three-storey gilded
 *    entrance, four setbacks whose piers rise past the parapets, trees on the
 *    terraces, a ribbed crown, a gilded cap and needle;
 * C. a modernist office: light continuous mullions and dark spandrels round a
 *    lit glass box, a double-height lobby in light stone, a thick coping and
 *    a dark plant penthouse;
 * D. contemporary flats: a white gridded block of seven storeys with a glazed
 *    corner, a planted terrace on it, a tower set back with stacked glass
 *    balconies, a terracotta blade, a white stair box and a roof garden;
 * E. a blue glass tower: silver floor bands, white corner frames, a lit strip
 *    up the front carried past the roof, two lower wings ending in planted
 *    terraces, a dark glazed podium.
 *
 * `W` x `D` is the base block (x along the street front at y = 0), `g` the
 * ground storey and `s` the others, `upper` the storeys over the ground.
 */

export interface LandmarkSink extends Sink {
  lamp(x: number, y: number, z?: number, h?: number): void;
}
type Design = (p: LandmarkSink, W: number, D: number, g: number, s: number, upper: number) => void;

/** The bottom of storey `k` (0 = the ground storey). */
const level = (g: number, s: number) => (k: number): number => (k <= 0 ? 0 : g + (k - 1) * s);

/** The raised stone plaza the building stands on, with its kerb. */
function plaza(p: LandmarkSink, W: number, D: number, front = 5, sides = 4): void {
  p.box('paving', -sides, W + sides, -front, D + 2.5, 0, 0.18);
  p.box('stoneLight', -sides - 0.25, W + sides + 0.25, -front - 0.25, D + 2.75, 0, 0.12);
}

/** A face's interior posts: `n` bays between `a` and `b`. */
const posts = (a: number, b: number, n: number): number[] => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

// ================================================================ A. Beaux-Arts hotel

const hotelBeauxArts: Design = (p, W, D, g, s, upper) => {
  const z = level(g, s);
  const zShaft = z(2), zAttic = z(upper), zTop = z(upper + 1);
  plaza(p, W, D);
  p.box('limestone', WALL - 0.01, W - WALL + 0.01, WALL - 0.01, D - WALL + 0.01, 0, zTop);
  const PAV = 1.9;
  for (const f of facesOf(0, W, 0, D)) {
    const L = span(f);
    const long = f.side === 'front' || f.side === 'back';
    const nb = long ? 5 : 4;
    const e = posts(PAV, L - PAV, nb);
    // ---- The base: the ground storey's arches and the mezzanine, rusticated.
    fbox(p, f, 'rustic', 0, PAV, -WALL, 0.1, 0, zShaft);
    fbox(p, f, 'rustic', L - PAV, L, -WALL, 0.1, 0, zShaft);
    const arches = long ? 3 : 4;
    const a = posts(PAV, L - PAV, arches);
    for (let i = 0; i < arches; i++) {
      const u0 = a[i]!, u1 = a[i + 1]!;
      const entrance = f.side === 'front' && i === 1;
      if (entrance) {
        door(p, f, u0 + 0.5, u1 - 0.5, 0.18, g - 0.4, { wall: 'rustic', trim: 'limestone', leaf: 'glassLit', frame: 'frameBronze', arch: true });
        fbox(p, f, 'rustic', u0, u0 + 0.5, -WALL, 0, 0, g);
        fbox(p, f, 'rustic', u1 - 0.5, u1, -WALL, 0, 0, g);
        fbox(p, f, 'rustic', u0, u1, -WALL, 0, g - 0.4, g);
        fbox(p, f, 'gold', (u0 + u1) / 2 - 0.8, (u0 + u1) / 2 + 0.8, -WALL + 0.12, -WALL + 0.16, 3.05, 3.4);
        for (const u of [u0 + 0.2, u1 - 0.2]) { const q = fpoint(f, u, 0.25); p.box('gold', q.x - 0.12, q.x + 0.12, q.y - 0.12, q.y + 0.12, 2.3, 2.9); p.box('sconce', q.x - 0.1, q.x + 0.1, q.y - 0.1, q.y + 0.1, 2.4, 2.8); }
        // Steps up to the doors.
        for (let k = 0; k < 2; k++) fbox(p, f, 'stoneLight', u0 + 0.3, u1 - 0.3, 0, 0.9 - k * 0.45, 0.18 + k * 0.14, 0.32 + k * 0.14);
      } else {
        const sw = u1 - u0, ow = Math.min(sw - 0.9, 3.0), sill = 0.5;
        const oh = g - 0.35 - sill - ow / 2;
        punched(p, f, u0, u1, 0, g, { wall: 'rustic', w: ow / sw, h: oh / g, sill, head: 'arch', glass: 'glassLit', frame: 'frameWhite', trim: 'limestone', mullions: 2, transom: 0.72 });
        if (f.side !== 'back') awning(p, f, u0 + (sw - ow) / 2 - 0.05, u1 - (sw - ow) / 2 + 0.05, sill + oh * 0.55 + 0.7, 1.15, 'awning');
      }
    }
    band(p, f, 'limestone', 0, L, g - 0.05, g + 0.25, 0.14);
    // The mezzanine: a window to each bay, keystoned.
    for (let i = 0; i < nb; i++) punched(p, f, e[i]!, e[i + 1]!, z(1), zShaft, { wall: 'rustic', w: 0.34, h: 0.6, sill: 0.6, glass: 'glassLit', frame: 'frameWhite', head: 'keystone', trim: 'limestone', mullions: 1 });
    consoles(p, f, 'limestone', PAV, L - PAV, zShaft - 0.2, 0.35, 1.25);
    cornice(p, f, 'limestone', 0, L, zShaft - 0.2, 0.35, 0.45);
    // ---- The shaft: the pavilions' windows, the bays between the pilasters, carved panels under the windows.
    for (let k = 2; k < upper; k++) {
      const z0 = z(k), z1 = z(k + 1);
      for (const [u0, u1] of [[0, PAV], [L - PAV, L]] as const) punched(p, f, u0, u1, z0, z1, { wall: 'limestone', w: 0.5, h: 0.6, sill: 0.85, glass: 'glassLit', frame: 'frameWhite', surround: 'stoneLight', mullions: 1 });
      for (let i = 0; i < nb; i++) {
        const u0 = e[i]!, u1 = e[i + 1]!, c = (u0 + u1) / 2;
        punched(p, f, u0, u1, z0, z1, { wall: 'limestone', w: 0.5, h: 0.64, sill: 0.8, glass: 'glassLit', frame: 'frameWhite', surround: 'stoneLight', mullions: 1, transom: 0.72,
          head: k === 2 ? 'cornice' : 'none' });
        if (k > 2) cartouche(p, f, c - 0.75, c + 0.75, z0 + 0.15, z0 + 0.8);
      }
    }
    // The pavilions stand a little forward; quoins up their corners.
    fbox(p, f, 'limestone', 0, 0.35, -0.05, 0.2, zShaft, zAttic);
    fbox(p, f, 'limestone', L - 0.35, L, -0.05, 0.2, zShaft, zAttic);
    // The colossal order: a pilaster at every bay line, its base and capital.
    for (const u of e) {
      pier(p, f, 'stoneLight', u, 0.55, zShaft, zAttic - 0.5, 0.18);
      fbox(p, f, 'stoneLight', u - 0.38, u + 0.38, -0.05, 0.26, zShaft, zShaft + 0.45);
      fbox(p, f, 'stoneLight', u - 0.42, u + 0.42, -0.05, 0.3, zAttic - 0.65, zAttic - 0.4);
      fbox(p, f, 'stoneLight', u - 0.32, u + 0.32, -0.05, 0.24, zAttic - 0.4, zAttic - 0.2);
    }
    band(p, f, 'limestone', 0, L, zAttic - 0.25, zAttic, 0.3);
    // ---- The attic: small windows, a cartouche between each pair, the bracketed main cornice.
    for (let i = 0; i < nb; i++) {
      punched(p, f, e[i]!, e[i + 1]!, zAttic, zTop, { wall: 'limestone', w: 0.42, h: 0.52, sill: 0.7, glass: 'glassLit', frame: 'frameWhite', surround: 'stoneLight', mullions: 1 });
    }
    for (const u of e) cartouche(p, f, u - 0.4, u + 0.4, zAttic + 0.5, zTop - 0.6);
    for (const [u0, u1] of [[0, PAV], [L - PAV, L]] as const) cartouche(p, f, u0 + 0.5, u1 - 0.5, zAttic + 0.5, zTop - 0.6);
    consoles(p, f, 'limestone', 0, L, zTop - 0.15, 0.6, 0.85);
    cornice(p, f, 'limestone', 0, L, zTop - 0.15, 0.6, 0.85, true);
    // ---- The balustrade on the cornice, planters in its openings.
    balustrade(p, f, 0.1, L - 0.1, zTop + 0.45, 1.0, 0.3, 'limestone', L / (nb + 2), 'leafDark');
  }
  // ---- The bell mansard in green copper, the arched dormers through it, finials.
  const mz = zTop + 0.45, mh = 5.6, inset = 2.9, m0 = 0.6;
  bellMansard(p, m0, W - m0, m0, D - m0, mz, mh, inset, 'copperRoof');
  for (const f of facesOf(m0, W - m0, m0, D - m0)) {
    const L = span(f), long = f.side === 'front' || f.side === 'back';
    const e = posts(PAV - m0, L - (PAV - m0), long ? 5 : 4);
    for (let i = 0; i < e.length - 1; i++) {
      const c = (e[i]! + e[i + 1]!) / 2;
      const big = f.side === 'front' && i === 2;
      archedDormer(p, f, c, big ? 1.9 : 1.55, mz + 0.3, big ? 3.6 : 3.1, 0.15, 1.9, 'limestone');
    }
  }
  for (const [x, y] of [[0.4, 0.4], [W - 0.4, 0.4], [0.4, D - 0.4], [W - 0.4, D - 0.4]] as const) finial(p, x, y, zTop + 1.5, 1.6, 'limestone', 'patina');
  for (const [x, y] of [[m0 + inset, m0 + inset], [W - m0 - inset, m0 + inset], [m0 + inset, D - m0 - inset], [W - m0 - inset, D - m0 - inset]] as const) finial(p, x, y, mz + mh, 1.4, 'patina');
  // ---- The top: a stone curb round the flat, a two-level penthouse, plant.
  const t0 = m0 + inset;
  for (const f of facesOf(t0, W - t0, t0, D - t0)) fbox(p, f, 'limestone', 0, span(f), -0.3, 0.1, mz + mh - 0.1, mz + mh + 0.55);
  p.box('roofing', t0, W - t0, t0, D - t0, mz + mh - 0.2, mz + mh);
  const px0 = W * 0.34, px1 = W * 0.72, py0 = D * 0.36, py1 = D * 0.74, pz = mz + mh;
  p.box('limestone', px0, px1, py0, py1, pz, pz + 2.0);
  for (const f of facesOf(px0, px1, py0, py1)) cornice(p, f, 'limestone', 0, span(f), pz + 1.85, 0.2, 0.2);
  p.box('limestone', px0 + 0.8, px0 + 3.6, py0 + 0.8, py1 - 1.2, pz + 2.0, pz + 3.6);
  p.box('limestone', px1 - 2.8, px1 - 0.6, py0 + 1.2, py1 - 0.6, pz + 2.0, pz + 3.0);
  p.box('metal', px0 + 1.2, px0 + 2.8, py0 + 1.2, py0 + 2.4, pz + 3.6, pz + 3.9);
  // ---- The street: trees in planters at the corners, lamps, the hotel's front.
  for (const [x, y] of [[-2.4, -2.6], [W + 2.4, -2.6], [-2.4, D * 0.6], [W + 2.4, D * 0.6]] as const) plantedTree(p, x, y, 0.18, 4.6);
  for (const [x, y] of [[W * 0.32, -3.9], [W * 0.68, -3.9], [-3.4, D * 0.25]] as const) lampPost(p, x, y, 0.18, 3.3);
  for (const u of [W / 2 - 3.4, W / 2 + 3.4]) { p.box('pot', u - 0.4, u + 0.4, -1.1, -0.3, 0.18, 0.75); p.bush(u, -0.7, 0.65, 0.42, true); }
};

// ================================================================ B. Art Deco tower

const decoTower: Design = (p, W, D, g, s, upper) => {
  const z = level(g, s);
  const zTop = z(upper + 1);
  plaza(p, W, D);
  // The tiers: the full block to the 20th storey, then three setbacks.
  const tiers = [
    { k0: 0, k1: upper - 7, ix: 0, iy: 0 },
    { k0: upper - 7, k1: upper - 4, ix: 2, iy: 1.8 },
    { k0: upper - 4, k1: upper - 1, ix: 4.8, iy: 4 },
    { k0: upper - 1, k1: upper + 1, ix: 7.4, iy: 6.4 },
  ];
  const strip = { glass: 'glassLit', frame: 'frameBronze', mullion: 'decoStone', mw: 0.55, fin: 0.32, spandrel: { h: 1.05, mat: 'decoSpandrel' } };
  for (let t = 0; t < tiers.length; t++) {
    const T = tiers[t]!;
    const x0 = T.ix, x1 = W - T.ix, y0 = T.iy, y1 = D - T.iy;
    const za = z(T.k0), zb = z(T.k1);
    p.box('decoStone', x0 + WALL, x1 - WALL, y0 + WALL, y1 - WALL, za, zb);
    for (const f of facesOf(x0, x1, y0, y1)) {
      const L = span(f);
      const wing = Math.min(6.4, L * 0.28);
      const c0 = wing, c1 = L - wing;
      const kStart = t === 0 ? 3 : T.k0;
      // The wings: punched windows, two to a wing.
      for (let k = kStart; k < T.k1; k++) {
        for (const [u0, u1] of [[0, wing], [L - wing, L]] as const) {
          const e = repeat(u1 - u0 - 0.9, 2.6);
          const base = u0 === 0 ? 0.9 : u0;
          for (let i = 0; i + 1 < e.length; i++) punched(p, f, base + e[i]!, base + e[i + 1]!, z(k), z(k + 1), { wall: 'decoStone', w: 0.48, h: 0.62, sill: 0.85, glass: 'glassLit', frame: 'frameBronze', mullions: 1 });
        }
      }
      // The corners and the massive piers either side of the middle strip.
      for (const [u0, u1] of [[0, 0.9], [L - 0.9, L]] as const) fbox(p, f, 'decoStone', u0, u1, -WALL, 0.05, z(kStart), zb);
      // The middle strip: recessed glazing between ribs, gilded spandrels.
      const zs = t === 0 ? z(3) : za;
      curtain(p, f, c0 + 0.8, c1 - 0.8, zs, zb - 1.2, s, { ...strip, bay: (c1 - c0 - 1.6) / 3 });
      fbox(p, f, 'decoStone', c0 + 0.8, c1 - 0.8, -0.3, -0.05, zb - 1.2, zb);
      fbox(p, f, 'decoGold', c0 + 1.0, c1 - 1.0, -0.05, 0.02, zb - 1.15, zb - 0.1);
      for (const u of [c0, c1]) fbox(p, f, 'decoStone', u - 0.8, u + 0.8, -0.1, 0.55, zs, zb);
      // The parapet, and the piers rising past it in steps with gilded caps.
      fbox(p, f, 'decoStone', 0, L, -0.2, 0.3, zb, zb + 0.9);
      for (const [u, rise] of [[0.45, 1.6], [L - 0.45, 1.6], [c0, 3.2], [c1, 3.2], [(c0 + c1) / 2, 2.2]] as const) {
        const w = u === c0 || u === c1 ? 1.4 : 0.9;
        fbox(p, f, 'decoStone', u - w / 2, u + w / 2, -0.15, 0.5, zb + 0.9, zb + 0.9 + rise);
        fbox(p, f, 'decoStone', u - w / 2 + 0.2, u + w / 2 - 0.2, -0.05, 0.4, zb + 0.9 + rise, zb + 0.9 + rise + 0.8);
        fbox(p, f, 'gold', u - w / 2 + 0.25, u + w / 2 - 0.25, 0, 0.42, zb + 0.9 + rise + 0.8, zb + 0.9 + rise + 1.0);
      }
      // A gilded panel on the parapet over the middle strip.
      fbox(p, f, 'decoGold', c0 + 0.9, c1 - 0.9, 0.3, 0.34, zb + 0.1, zb + 0.85);
    }
    // Trees on the terrace this tier stands back from.
    if (t > 0) {
      const P = tiers[t - 1]!;
      const tz = z(T.k0);
      for (const [x, y] of [[P.ix + 1.1, P.iy + 1.1], [W - P.ix - 1.1, P.iy + 1.1], [P.ix + 1.1, D - P.iy - 1.1], [W - P.ix - 1.1, D - P.iy - 1.1]] as const) plantedTree(p, x, y, tz, 3.4);
    }
  }
  // ---- The base: three storeys, the wings' tall windows, the gilded entrance.
  for (const f of facesOf(0, W, 0, D)) {
    const L = span(f), wing = Math.min(6.4, L * 0.28), c0 = wing, c1 = L - wing;
    for (let k = 0; k < 3; k++) {
      for (const [u0, u1] of [[0.9, wing], [L - wing, L - 0.9]] as const) {
        const e = repeat(u1 - u0, 2.6);
        for (let i = 0; i + 1 < e.length; i++) punched(p, f, u0 + e[i]!, u0 + e[i + 1]!, z(k), z(k + 1), { wall: 'decoStone', w: 0.5, h: k === 0 ? 0.68 : 0.62, sill: k === 0 ? 0.9 : 0.8, glass: 'glassLit', frame: 'frameBronze', mullions: 1, transom: 0.7 });
      }
    }
    for (const u of [c0, c1]) fbox(p, f, 'decoStone', u - 0.8, u + 0.8, -0.1, 0.55, 0, z(3));
    for (const [u0, u1] of [[0, 0.9], [L - 0.9, L]] as const) fbox(p, f, 'decoStone', u0, u1, -WALL, 0.05, 0, z(3));
    if (f.side === 'front') {
      // A tall recess: dark glazing in gilded frames, gilded panels over the doors.
      fbox(p, f, 'decoStone', c0 + 0.8, c1 - 0.8, -1.4, -1.0, 0, z(3));
      fbox(p, f, 'glassLit', c0 + 1.0, c1 - 1.0, -1.0, -0.95, z(1) - 0.3, z(3) - 0.4);
      for (const u of repeat(c1 - c0 - 2, 1.4)) fbox(p, f, 'gold', c0 + 1 + u - 0.06, c0 + 1 + u + 0.06, -0.97, -0.9, z(1) - 0.3, z(3) - 0.4);
      for (let r = 0; r < 3; r++) fbox(p, f, 'decoGold', c0 + 1.1, c1 - 1.1, -0.94, -0.9, z(1) + r * 1.6, z(1) + r * 1.6 + 1.1);
      door(p, f, c0 + 1.6, c1 - 1.6, 0.18, z(1) - 0.3, { wall: 'decoStone', trim: 'gold', leaf: 'glassLit', frame: 'frameBronze', portal: false });
      fbox(p, f, 'gold', c0 + 0.9, c1 - 0.9, -0.95, -0.85, z(1) - 0.35, z(1) - 0.2);
      for (const u of [c0 + 0.5, c1 - 0.5]) { const q = fpoint(f, u, 0.65); p.box('gold', q.x - 0.15, q.x + 0.15, q.y - 0.15, q.y + 0.15, 2.4, 3.1); p.box('sconce', q.x - 0.11, q.x + 0.11, q.y - 0.11, q.y + 0.11, 2.5, 3.0); }
      for (let k = 0; k < 3; k++) fbox(p, f, 'stoneLight', c0 + 0.6, c1 - 0.6, 0, 1.6 - k * 0.5, 0.18 + k * 0.12, 0.3 + k * 0.12);
    }
    band(p, f, 'decoStone', 0, L, z(3) - 0.3, z(3) + 0.1, 0.4);
  }
  // ---- The crown: a ribbed lantern, a gilded stepped cap, the needle.
  const cx0 = W / 2 - 3.2, cx1 = W / 2 + 3.2, cy0 = D / 2 - 2.6, cy1 = D / 2 + 2.6;
  p.box('decoStone', cx0, cx1, cy0, cy1, zTop, zTop + 7);
  for (const f of facesOf(cx0, cx1, cy0, cy1)) {
    const L = span(f);
    for (const u of repeat(L, 1.1)) fbox(p, f, 'decoStone', u - 0.2, u + 0.2, 0, 0.35, zTop, zTop + 7.6);
    for (const u of repeat(L, 2.2).slice(1, -1)) fbox(p, f, 'gold', u - 0.1, u + 0.1, 0.35, 0.4, zTop + 2, zTop + 7.2);
  }
  for (let k = 0; k < 3; k++) {
    const i = 0.6 + k * 0.85;
    p.box('gold', cx0 + i, cx1 - i, cy0 + i, cy1 - i, zTop + 7.6 + k * 1.0, zTop + 8.6 + k * 1.0);
  }
  spire(p, W / 2, D / 2, zTop + 10.6, 14, 'gold', 0.8);
  // ---- The street: hedges in troughs along the front, trees, lamps.
  for (const x0 of [0.5, W - 6.5]) hedge(p, x0, x0 + 6, -1.6, -0.8, 0.18);
  for (const [x, y] of [[-2.4, -2.8], [W + 2.4, -2.8], [-2.4, D * 0.65]] as const) plantedTree(p, x, y, 0.18, 4.8);
  for (const [x, y] of [[W * 0.3, -4], [W * 0.7, -4]] as const) lampPost(p, x, y, 0.18, 3.3);
};

// ================================================================ C. Modernist office

const modernOffice: Design = (p, W, D, g, s, upper) => {
  const z = level(g, s);
  const zTop = z(upper + 1), zBase = z(2);
  plaza(p, W, D);
  // ---- The base: two storeys of glass between light stone piers, the doors in the middle.
  p.box('stoneLight', 0.6, W - 0.6, 0.6, D - 0.6, 0, zBase);
  for (const f of facesOf(0, W, 0, D)) {
    const L = span(f), e = repeat(L, 4.5);
    for (let i = 0; i + 1 < e.length; i++) {
      const u0 = e[i]! + 0.5, u1 = e[i + 1]! - 0.5;
      fbox(p, f, 'glassLit', u0, u1, -0.55, -0.5, 0.18, zBase - 0.8);
      for (const u of repeat(u1 - u0, 1.3)) fbox(p, f, 'frame', u0 + u - 0.04, u0 + u + 0.04, -0.52, -0.42, 0.18, zBase - 0.8);
      fbox(p, f, 'frame', u0, u1, -0.52, -0.42, z(1) - 0.05, z(1) + 0.05);
    }
    for (const u of e) fbox(p, f, 'stoneLight', u - 0.5, u + 0.5, -0.6, 0.05, 0, zBase);
    fbox(p, f, 'stoneLight', 0, L, -0.6, 0.12, zBase - 0.8, zBase);
    if (f.side === 'front') {
      door(p, f, L / 2 - 1.8, L / 2 + 1.8, 0.18, 3.2, { wall: 'stoneLight', trim: 'alu', leaf: 'glassLit', frame: 'alu' });
      fbox(p, f, 'alu', L / 2 - 2.6, L / 2 + 2.6, 0, 1.6, 3.4, 3.55);
    }
  }
  // ---- The shaft: a lit glass box behind light continuous mullions and dark spandrels.
  const zs = zTop;
  p.box('darkPanel', 0.3, W - 0.3, 0.3, D - 0.3, zBase, zs);
  for (const f of facesOf(0, W, 0, D)) {
    const L = span(f);
    curtain(p, f, 0.45, L - 0.45, zBase, zs - 0.2, s, { glass: 'glassLit', mullion: 'alu', bay: 1.5, mw: 0.14, fin: 0.2, spandrel: { h: 1.05, mat: 'darkPanel' } });
    fbox(p, f, 'alu', 0, 0.45, -0.1, 0.25, zBase, zs);
    fbox(p, f, 'alu', L - 0.45, L, -0.1, 0.25, zBase, zs);
    // The coping: a thick light band round the roof.
    fbox(p, f, 'alu', -0.25, L + 0.25, -0.1, 0.3, zs - 0.2, zs + 0.55);
  }
  p.box('roofing', 0.3, W - 0.3, 0.3, D - 0.3, zs, zs + 0.3);
  // ---- The plant penthouse, dark, and the units.
  const px0 = W * 0.52, px1 = W * 0.82, py0 = D * 0.25, py1 = D * 0.78;
  p.box('darkPanel', px0, px1, py0, py1, zs + 0.3, zs + 3.8);
  p.box('darkPanel', px0 - 0.2, px1 + 0.2, py0 - 0.2, py1 + 0.2, zs + 3.8, zs + 4.1);
  for (const f of facesOf(px0, px1, py0, py1)) for (const u of repeat(span(f), 0.5)) fbox(p, f, 'metal', u - 0.04, u + 0.04, 0, 0.06, zs + 1, zs + 3.4);
  p.box('darkPanel', px0 + 1.2, px0 + 4.2, py0 + 1.5, py1 - 1.5, zs + 4.1, zs + 5.6);
  for (const [x, y] of [[W * 0.18, D * 0.35], [W * 0.3, D * 0.62]] as const) p.box('metal', x, x + 2.2, y, y + 1.5, zs + 0.3, zs + 1.5);
  // ---- The street.
  for (const x0 of [1, W - 8]) hedge(p, x0, x0 + 7, -1.6, -0.8, 0.18);
  for (const [x, y] of [[-2.2, -2.8], [W + 2.2, -2.8], [W * 0.25, -3.2], [W * 0.75, -3.2]] as const) plantedTree(p, x, y, 0.18, 4.6);
  for (const x of [W * 0.12, W * 0.88]) lampPost(p, x, -4.1, 0.18, 3.3);
};

// ================================================================ D. Contemporary flats

const residentialTerrace: Design = (p, W, D, g, s, upper) => {
  const z = level(g, s);
  const kLow = 7; // storeys of the white block
  const zLow = z(kLow), zTop = z(upper + 1);
  plaza(p, W, D);
  // ---- The white block: a grid of deep-set windows, a glazed corner on the first two storeys.
  p.box('white', WALL, W - WALL, WALL, D - WALL, 0, zLow);
  for (const f of facesOf(0, W, 0, D)) {
    const L = span(f), e = repeat(L, 2.2);
    for (let k = 0; k < kLow; k++) {
      for (let i = 0; i + 1 < e.length; i++) {
        const u0 = e[i]!, u1 = e[i + 1]!;
        const corner = k < 2 && ((f.side === 'front' && u0 >= L * 0.45) || (f.side === 'right' && u1 <= L * 0.55));
        if (corner) {
          fbox(p, f, 'glassLit', u0, u1, -0.3, -0.25, z(k) + 0.05, z(k + 1) - 0.2);
          fbox(p, f, 'white', u1 - 0.12, u1 + 0.12, -0.25, 0.05, z(k), z(k + 1));
          fbox(p, f, 'frame', u0, u1, -0.27, -0.2, z(k + 1) - 0.25, z(k + 1) - 0.18);
        } else if (k === 0 && f.side === 'front' && i === 1) {
          door(p, f, u0, u1, 0.18, g - 0.4, { wall: 'white', trim: 'metal', leaf: 'glassLit', frame: 'metal' });
        } else {
          punched(p, f, u0, u1, z(k), z(k + 1), { wall: 'white', w: 0.58, h: k === 0 ? 0.7 : 0.62, sill: k === 0 ? 0.6 : 0.75, glass: 'glassLit', frame: 'metal', mullions: 1 });
        }
      }
      band(p, f, 'white', 0, L, z(k + 1) - 0.12, z(k + 1) + 0.06, 0.08);
    }
    if (f.side === 'front') { fbox(p, f, 'white', L * 0.45, L, 0, 1.4, z(2) - 0.3, z(2) - 0.05); railFace(p, f, L * 0.45, L, 1.35, z(2) - 0.05, 1.0); }
  }
  // ---- The terrace on the white block, in front of the tower.
  const tx0 = 0, tx1 = W - 4.5, ty0 = 4, ty1 = D;
  p.box('slab', 0, W, 0, D, zLow, zLow + 0.12);
  for (const f of facesOf(0, W, 0, D)) railFace(p, f, 0.1, span(f) - 0.1, -0.1, zLow + 0.12, 1.05);
  for (const [x, y] of [[2, 1.6], [W - 2, 1.6], [W - 2, D * 0.5]] as const) plantedTree(p, x, y, zLow + 0.12, 3.2);
  for (let x = 4.5; x < W - 4; x += 3) { p.box('pot', x - 0.6, x + 0.6, 0.9, 1.9, zLow + 0.12, zLow + 0.6); p.bush(x, 1.4, zLow + 0.5, 0.45, x % 2 < 1); }
  // ---- The tower: glass balconies on the side, white and balconies on the front, the terracotta blade.
  p.box('white', tx0 + WALL, tx1 - WALL, ty0 + WALL, ty1 - WALL, zLow, zTop);
  for (const f of facesOf(tx0, tx1, ty0, ty1)) {
    const L = span(f);
    for (let k = kLow; k <= upper; k++) {
      const z0 = z(k), z1 = z(k + 1);
      const top = k === upper;
      if (f.side === 'front') {
        // White with two windows on the left, a stack of balconies, the terracotta blade on the right.
        const e = repeat(7.5, 3.75);
        for (let i = 0; i + 1 < e.length; i++) punched(p, f, e[i]!, e[i + 1]!, z0, z1, { wall: 'white', w: 0.5, h: 0.62, sill: 0.75, glass: 'glassLit', frame: 'metal', mullions: 1 });
        const b0 = 7.5, b1 = L - 3.2;
        for (const [u0, u1] of [[b0, (b0 + b1) / 2], [(b0 + b1) / 2, b1]] as const) punched(p, f, u0, u1, z0, z1, { wall: 'white', w: 0.86, h: 0.82, sill: 0.08, glass: 'glassLit', frame: 'metal', mullions: 2 });
        if (!top || k % 2 === 0) balcony(p, f, b0 + 0.1, b1 - 0.1, z0 + 0.02, 1.7, 'glass', 'darkPanel');
        if (k % 2 === 0) { const q = fpoint(f, b0 + 1, 1.0); p.plant(q.x, q.y, z0 + 0.02, 0.85); const q2 = fpoint(f, b1 - 1, 1.0); p.plant(q2.x, q2.y, z0 + 0.02, 0.7); }
        fbox(p, f, 'terracotta', L - 3.2, L, -WALL, 0.35, z0, z1);
        fbox(p, f, 'glassLit', L - 2.4, L - 1.2, 0.35, 0.4, z0 + 0.4, z1 - 0.3);
      } else if (f.side === 'left') {
        // Glass from slab to slab behind glass balconies, the blade round the front corner.
        const e = repeat(L - 2.6, 3.0);
        for (let i = 0; i + 1 < e.length; i++) punched(p, f, e[i]!, e[i + 1]!, z0, z1, { wall: 'white', w: 0.9, h: 0.84, sill: 0.06, glass: 'glassLit', frame: 'metal', mullions: 2 });
        balcony(p, f, 0.2, L - 2.8, z0 + 0.02, 1.5, 'glass', 'darkPanel');
        if (k % 3 === 0) { const q = fpoint(f, 1.2, 0.9); p.plant(q.x, q.y, z0 + 0.02, 0.8); }
        fbox(p, f, 'terracotta', L - 2.6, L, -WALL, 0.3, z0, z1);
        fbox(p, f, 'glassLit', L - 2.0, L - 0.9, 0.3, 0.35, z0 + 0.4, z1 - 0.3);
      } else {
        const e = repeat(L, 2.6);
        for (let i = 0; i + 1 < e.length; i++) punched(p, f, e[i]!, e[i + 1]!, z0, z1, { wall: 'white', w: 0.56, h: 0.62, sill: 0.75, glass: 'glassLit', frame: 'metal', mullions: 1 });
      }
      band(p, f, 'white', 0, L, z1 - 0.1, z1 + 0.08, 0.1);
    }
  }
  // ---- The roof: a white stair box, a glass railing, planters and a tree.
  p.box('slab', tx0, tx1, ty0, ty1, zTop, zTop + 0.15);
  for (const f of facesOf(tx0, tx1, ty0, ty1)) fbox(p, f, 'glassRail', 0, span(f), -0.06, 0, zTop + 0.15, zTop + 1.2);
  p.box('white', tx0 + 0.6, tx0 + 6.6, ty1 - 6.5, ty1 - 0.6, zTop + 0.15, zTop + 5.2);
  p.box('white', tx0 + 0.4, tx0 + 6.8, ty1 - 6.7, ty1 - 0.4, zTop + 5.2, zTop + 5.45);
  p.box('metal', tx1 - 5, tx1 - 2.6, ty1 - 5, ty1 - 3, zTop + 0.15, zTop + 1.6);
  plantedTree(p, tx1 - 2.2, ty0 + 2.2, zTop + 0.15, 3.6);
  for (let x = tx0 + 8; x < tx1 - 4; x += 2.4) { p.box('pot', x - 0.5, x + 0.5, ty0 + 0.6, ty0 + 1.6, zTop + 0.15, zTop + 0.6); p.bush(x, ty0 + 1.1, zTop + 0.5, 0.42); }
  // ---- The street.
  for (const [x, y] of [[-2.2, -2.8], [W * 0.35, -2.8], [W + 2.2, -2.8], [W + 2.2, D * 0.6]] as const) plantedTree(p, x, y, 0.18, 4.6);
  for (const x of [W * 0.15, W * 0.85]) lampPost(p, x, -4.1, 0.18, 3.3);
};

// ================================================================ E. Blue glass tower

const glassTower: Design = (p, W, D, g, s, upper) => {
  const z = level(g, s);
  const zTop = z(upper + 1), zPod = z(2);
  plaza(p, W, D);
  // ---- The podium: dark-framed glass, the doors under a canopy.
  p.box('darkPanel', 0.5, W - 0.5, 0.5, D - 0.5, 0, zPod);
  for (const f of facesOf(0, W, 0, D)) {
    const L = span(f), e = repeat(L, 3.4);
    for (let i = 0; i + 1 < e.length; i++) {
      const u0 = e[i]!, u1 = e[i + 1]!;
      if (f.side === 'front' && i === Math.floor((e.length - 1) / 2)) door(p, f, u0, u1, 0.18, g - 0.3, { wall: 'darkPanel', trim: 'alu', leaf: 'glassLit', frame: 'alu' });
      else fbox(p, f, 'glassLit', u0, u1, -0.4, -0.35, 0.18, z(1) - 0.3);
      fbox(p, f, 'glassBlueLit', u0, u1, -0.4, -0.35, z(1), zPod - 0.4);
      fbox(p, f, 'frame', u0 - 0.06, u0 + 0.06, -0.4, 0.05, 0, zPod);
    }
    fbox(p, f, 'frame', 0, L, -0.4, 0.05, z(1) - 0.35, z(1));
    fbox(p, f, 'alu', 0, L, -0.4, 0.15, zPod - 0.45, zPod);
    if (f.side === 'front') fbox(p, f, 'alu', L / 2 - 3, L / 2 + 3, 0, 2, z(1) - 0.6, z(1) - 0.45);
  }
  p.box('slab', 0, W, 0, D, zPod, zPod + 0.1);
  // ---- A glass mass: blue glass, fine mullions, a silver band at each floor, white corner frames.
  const cw = { glass: 'glassBlueLit', mullion: 'alu', bay: 1.35, mw: 0.06, fin: 0.08, spandrel: { h: 0.22, mat: 'alu' } };
  const mass = (x0: number, x1: number, y0: number, y1: number, za: number, zb: number, terrace: boolean): void => {
    p.box('glassBlueLit', x0 + 0.25, x1 - 0.25, y0 + 0.25, y1 - 0.25, za, zb);
    for (const f of facesOf(x0, x1, y0, y1)) {
      const L = span(f);
      curtain(p, f, 0.5, L - 0.5, za, zb, s, cw);
      fbox(p, f, 'white', 0, 0.5, -0.1, 0.18, za, zb + 0.3);
      fbox(p, f, 'white', L - 0.5, L, -0.1, 0.18, za, zb + 0.3);
      fbox(p, f, 'white', 0, L, -0.1, 0.15, zb - 0.1, zb + 0.3);
      if (terrace) fbox(p, f, 'glassRail', 0.2, L - 0.2, -0.32, -0.26, zb + 0.3, zb + 1.3);
    }
    p.box('slab', x0 + 0.1, x1 - 0.1, y0 + 0.1, y1 - 0.1, zb - 0.05, zb + 0.3);
  };
  const sx0 = 3.2, sx1 = W - 3.2, sy0 = 3.4, sy1 = D - 2.2;
  const kL = Math.round(upper * 0.62), kR = Math.round(upper * 0.4);
  mass(sx0, sx1, sy0, sy1, zPod, zTop, true);
  // The front wing, standing forward, to the 21st storey; the side wing to the 13th.
  mass(1.6, W * 0.45, 1.6, sy1 - 4, zPod, z(kL), true);
  plantedTree(p, 3.2, 3.2, z(kL) + 0.3, 3.2);
  mass(sx1 - 0.2, W - 1.2, sy0 + 3, sy1 - 1, zPod, z(kR), true);
  plantedTree(p, W - 2.6, sy0 + 4.5, z(kR) + 0.3, 3.2);
  // ---- The lit strip up the front, carried past the roof as a fin.
  const lx = W * 0.62;
  p.box('white', lx - 0.55, lx + 0.55, sy0 - 0.5, sy0 + 0.1, zPod, zTop + 6);
  p.box('lightStrip', lx - 0.25, lx + 0.25, sy0 - 0.56, sy0 - 0.4, zPod + 0.5, zTop + 5.6);
  // ---- The top: a white frame over the roof terrace, a tree, the plant.
  p.box('white', sx0, sx0 + 0.5, sy0, sy1, zTop, zTop + 4.5);
  p.box('white', sx0, lx, sy0, sy0 + 0.5, zTop + 4, zTop + 4.5);
  p.box('metal', sx0 + 3, sx0 + 6.5, sy1 - 5, sy1 - 2, zTop + 0.3, zTop + 2.4);
  plantedTree(p, sx0 + 2, sy0 + 2, zTop + 0.3, 3.4);
  // ---- The street.
  for (const [x, y] of [[-2.2, -2.8], [W + 2.2, -2.8], [W * 0.25, -3.2], [W * 0.75, -3.2], [-2.2, D * 0.6]] as const) plantedTree(p, x, y, 0.18, 4.6);
  for (const x of [W * 0.1, W * 0.9]) lampPost(p, x, -4.1, 0.18, 3.3);
};

/** The landmark designs, by tower kind. */
export const LANDMARKS: Readonly<Record<string, Design>> = {
  beauxArts: hotelBeauxArts, decoTower, modernOffice, residentialTerrace, glassSpire: glassTower,
};

