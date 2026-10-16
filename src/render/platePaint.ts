import type { ChangeRect } from '@world/changes';
import type { PaintDab } from '@world/terrainPaint';

/** THE DABS A PLATE OF THE GROUND LAYS (`flatAtlas.ts` takePaint): the document's that reach it, kept as laid when their tile leaves the page */

export const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** A dab's identity on a plate: a tile come back brings its dabs as new objects of the same paint (a dab a player repeats exactly, at the same place and strength, counts once too). */
const dabKey = (d: PaintDab): string => `${d.kind}:${d.x}:${d.y}:${d.radius}:${d.strength}`;
const dabInRects = (d: PaintDab, rects: readonly ChangeRect[]): boolean =>
  rects.some((r) => d.x + d.radius >= r[0] && d.x - d.radius <= r[2] && d.y + d.radius >= r[1] && d.y - d.radius <= r[3]);

/** THE DABS A PLATE LAYS brought up to the document's (`reaching`: those reaching the plate now). What was laid stays as laid: a tile that left the page took its dabs off the document, not off the world's ground (DO NOT lay every plate again at each tile let go: every shown plate's paint rastered and sent again, and the ecology read again, at each kilometre moved). The dabs new to the plate go after it, so the surface lays only those (`terrain.ts` paintStep); a stroke's rectangles (`edited`) say where a dab gone from the document is taken off. `edited` null: the diary could not say, the document's dabs alone, laid again. Null back: nothing to change. */
export function plateDabs(laid: readonly PaintDab[], keys: Set<string>, reaching: readonly PaintDab[], edited: readonly ChangeRect[] | null): PaintDab[] | null {
  if (edited === null) {
    if (sameList(reaching, laid)) return null;
    keys.clear();
    for (const d of reaching) keys.add(dabKey(d));
    return [...reaching];
  }
  const here = new Set(reaching);
  const kept = edited.length === 0 ? laid : laid.filter((d) => here.has(d) || !dabInRects(d, edited));
  if (kept.length !== laid.length) { keys.clear(); for (const d of kept) keys.add(dabKey(d)); }
  const known = new Set(kept);
  const fresh: PaintDab[] = [];
  for (const d of reaching) {
    if (known.has(d)) continue;
    const key = dabKey(d);
    if (keys.has(key)) continue;
    keys.add(key);
    fresh.push(d);
  }
  if (kept.length === laid.length && fresh.length === 0) return null;
  return [...kept, ...fresh];
}

