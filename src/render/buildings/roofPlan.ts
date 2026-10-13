import { planRoofPlant, type RoofPlantItem } from '@world/buildings/roofPlant';
import { type Building, type Volume, volumeTop } from '@world/buildings/types';
import { m } from '@world/units';

/**
 * WHAT STANDS ON A ROOF, planned once for both levels of a building: the
 * detailed one (`buildingMesh.ts` draws each piece in full) and the far one
 * (`massing.ts` keeps the pieces a metre or more across), so the two never
 * disagree on where a machine room or a tank stands.
 */

/** The colours of a roof's pieces. */
export const ROOF_COLOURS = {
  plant: 0x6c6a64,
  condenser: 0xc9ccc9,
  solar: 0x1d2b45,
  skylight: 0x8fb4c6,
  chimney: 0x8c4a35,
  parasol: 0xe7dcc4,
} as const;
/** Water tanks: the blue fibreglass of most roofs, the grey and the white of others, a sand-coloured one. */
export const TANK_COLOURS: readonly number[] = [0x4a7fb8, 0x8d9399, 0xdcdedb, 0xc9b48a];

/** The plant on a flat roof (`planRoofPlant`): none on a block of roof details of its own or a shaped one. */
export function roofPlantOf(b: Building, v: Volume): readonly RoofPlantItem[] {
  if (v.roofDetails?.length || v.outline) return [];
  const age = b.decay ?? 0;
  return planRoofPlant({
    building: b.id, volume: v.id, use: b.use, storeys: v.base + v.storeys.length,
    x0: v.x, y0: v.y, x1: v.x + v.w, y1: v.y + v.d,
    // A new town's buildings are of every vintage: the seed stands in for the years.
    age: age > 0 ? age : (((b.id * 2_246_822_519) >>> 0) % 1000) / 1000,
    hasCore: b.cores.length > 0,
    // The blocks on this roof, and the machine rooms over its lift cores: a
    // skylight stood with its face in a machine room's (2026-10-13).
    blocked: [
      ...b.volumes.filter((o) => o !== v && !o.open && o.base === volumeTop(v)).map((o) => ({ x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.d })),
      ...machineRooms(b).filter((r) => r.volume === v),
    ],
  });
}

/** How far a machine room keeps inside its roof's edge: off the parapet (0.25 m thick) by 5 cm. */
const MACHINE_ROOM_INSET = m(0.3);

/**
 * The machine rooms over the lift cores, each on the highest flat roof over
 * its core and kept inside the parapet (a core at the block's edge stood
 * with its face in the parapet's, 2026-10-13). One plan for both levels
 * (`buildingMesh.ts`, `massing.ts`) and for the roof plant kept off them.
 */
export function machineRooms(b: Building): { volume: Volume; x0: number; y0: number; x1: number; y1: number }[] {
  const out: { volume: Volume; x0: number; y0: number; x1: number; y1: number }[] = [];
  if (b.cutaway !== undefined) return out;
  const u = b.module;
  for (const core of b.cores) {
    let best: Volume | null = null;
    const cx = core.x + u / 2, cy = core.y + u / 2;
    for (const v of b.volumes) {
      if (v.open || cx < v.x || cx >= v.x + v.w || cy < v.y || cy >= v.y + v.d) continue;
      if (!best || volumeTop(v) > volumeTop(best)) best = v;
    }
    if (!best || (best.roof !== 'flat' && best.roof !== 'terrace')) continue;
    const x0 = Math.max(core.x, best.x + MACHINE_ROOM_INSET), x1 = Math.min(core.x + u, best.x + best.w - MACHINE_ROOM_INSET);
    const y0 = Math.max(core.y, best.y + MACHINE_ROOM_INSET), y1 = Math.min(core.y + u, best.y + best.d - MACHINE_ROOM_INSET);
    if (x1 - x0 < m(1) || y1 - y0 < m(1)) continue;
    out.push({ volume: best, x0, y0, x1, y1 });
  }
  return out;
}

/** A used roof terrace's seeded choices (`buildingMesh.ts` `emitTerrace`): 0..1 by the building, the block and `k`. */
export const terraceSeed = (b: Building, v: Volume, k: number): number => (((b.id * 2654435761 + v.id * 40503 + k * 131) >>> 0) % 1000) / 1000;

/** A used roof terrace's deck, in the block's plan; null when the terrace is too small to be used. */
export function terraceDeck(b: Building, v: Volume): { x0: number; y0: number; x1: number; y1: number } | null {
  if (v.outline || v.w < m(4) || v.d < m(4)) return null;
  return { x0: v.x + m(0.8), x1: v.x + v.w * (0.55 + 0.2 * terraceSeed(b, v, 1)), y0: v.y + m(0.8), y1: v.y + v.d - m(0.8) };
}

/** The centres of the parasols over a terrace's tables, along the middle of its deck. */
export function terraceParasols(b: Building, v: Volume): { x: number; y: number }[] {
  const deck = terraceDeck(b, v);
  if (!deck) return [];
  const tables = Math.floor(Math.floor((deck.x1 - deck.x0) / m(3.5)) * (0.3 + 0.7 * terraceSeed(b, v, 7)));
  const out: { x: number; y: number }[] = [];
  for (let k = 0; k < tables; k++) out.push({ x: deck.x0 + (k + 0.5) * ((deck.x1 - deck.x0) / tables), y: (deck.y0 + deck.y1) / 2 });
  return out;
}

/** A parasol's half width and the height of its canopy over the deck. */
export const PARASOL_HALF = m(1.1);
export const PARASOL_LOW = m(2.3);
export const PARASOL_HIGH = m(2.4);
