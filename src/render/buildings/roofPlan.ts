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
    blocked: b.volumes.filter((o) => o !== v && !o.open && o.base === volumeTop(v)).map((o) => ({ x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.d })),
  });
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
