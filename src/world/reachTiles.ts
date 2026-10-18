import { TILE, tileKey } from './tiles';

/** THE TILES A VIEW REACHES (the opening's curtain, `main.ts`): every tile on the map whose square meets the square of side 2 `reach` round (x, y), as the far trees cut what they draw (`farTree.ts` outOfReach), and that the view sees (`seen`, its box against the camera's frustum, as `farTree.ts` inView). How many there are depends on the view, never on the map's size past it.
 *  - DO NOT wait for the tiles behind the camera: half the square round a district's view, made before the curtain for nothing seen (the plan's level stands there until they come, `farTreePlan.ts`). */
export function tilesInReach(x: number, y: number, reach: number, onMap: (i: number, j: number) => boolean, seen: (x0: number, y0: number, x1: number, y1: number) => boolean = () => true): number[] {
  if (!(reach > 0) || !Number.isFinite(reach)) return [];
  const i0 = Math.floor((x - reach) / TILE), i1 = Math.floor((x + reach) / TILE);
  const j0 = Math.floor((y - reach) / TILE), j1 = Math.floor((y + reach) / TILE);
  const out: number[] = [];
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (onMap(i, j) && seen(i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE)) out.push(tileKey(i, j));
  return out;
}
