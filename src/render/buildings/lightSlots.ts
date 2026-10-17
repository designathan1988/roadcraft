/** DO NOT number the spaces in the order they are asked for (a table on the page, as this was) */

/** Seeds there are (the old table's size: the glass's hash spreads them the same). */
const SPACE_SEEDS = 65_536;

/** FNV-1a, 32 bits, of a whole number's decimal text, as `String(n)` writes it (no text made). */
function hashWhole(h: number, n: number): number {
  if (n < 0) { h = Math.imul(h ^ 45, 0x01000193); n = -n; }
  // Its digits from the last (an exact division each), then hashed from the first.
  let count = 0;
  do { const digit = n % 10; DIGITS[count++] = digit; n = (n - digit) / 10; } while (n > 0);
  while (count > 0) h = Math.imul(h ^ (48 + DIGITS[--count]!), 0x01000193);
  return h;
}
/** A whole number's digits, written over by each `hashWhole`. */
const DIGITS = new Uint8Array(24);

/** The seed of one space: building, floor, block, and the space's corner (to a decimetre): FNV-1a of "building:level:volume:x:y", hashed digit by digit, never written out (a pane's slot asked thousands of times a job). */
export function spaceSeed(building: number, level: number, volume: number, x: number, y: number): number {
  let h = 0x811c9dc5;
  const colon = (): void => { h = Math.imul(h ^ 58, 0x01000193); };
  h = hashWhole(h, building); colon();
  h = hashWhole(h, level); colon();
  h = hashWhole(h, volume); colon();
  // `+ 0`: a corner rounded to -0 is written "0".
  h = hashWhole(h, Math.round(x * 10) + 0); colon();
  h = hashWhole(h, Math.round(y * 10) + 0);
  return (h >>> 0) % SPACE_SEEDS;
}
