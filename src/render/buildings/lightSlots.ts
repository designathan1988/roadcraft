/**
 * Which space of which building a window pane looks into, as a number: the
 * seed its lot of being lit at night is drawn from (`glassRoom.ts`), so every
 * pane of a flat is lit or dark with the flat.
 *
 * A hash of the space (building, floor, block, corner), the same for the same
 * space on any machine, in any worker, in any order. DO NOT number the spaces
 * in the order they are asked for (a table on the page, as this was): the
 * cells are made in workers, in the order they answer, so which flats were lit
 * changed from one run to the next; the table only grew, never let a space go,
 * and past its 65,536 slots every window of a larger town fell back to a lot
 * per pane; and each cell waited for one more round trip to the page for its
 * numbers. Nothing drove the table (its `setLit` had no caller).
 */

/** Seeds there are (the old table's size: the glass's hash spreads them the same). */
const SPACE_SEEDS = 65_536;

/** The seed of one space: building, floor, block, and the space's corner (to a decimetre). */
export function spaceSeed(building: number, level: number, volume: number, x: number, y: number): number {
  const key = `${building}:${level}:${volume}:${Math.round(x * 10)}:${Math.round(y * 10)}`;
  // FNV-1a, 32 bits.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return (h >>> 0) % SPACE_SEEDS;
}
