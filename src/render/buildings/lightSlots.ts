/** DO NOT number the spaces in the order they are asked for (a table on the page, as this was) */

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
