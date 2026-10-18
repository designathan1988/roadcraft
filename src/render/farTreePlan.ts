import { Digest } from '@core/digest';
import { MAP_HALF } from '@world/cityGen/wholeMap';
import { tileKey } from '@world/tiles';
import { TOP_LEVEL, nodeSide } from './buildings/farGrid';
import type { PageCut, PageCuts } from './farTreeCuts';
import type { FarNear, FarNode, FarTileSource } from './farTreeTypes';

/** WHERE THE FAR TREE (`farTree.ts`) DRAWS THE WORLD'S PLAN: a kind bakes it from `planFrom` up (`FarKind.planFrom`; Infinity: no plan) where no tile is made yet, refined to the tiles as they come (3D Tiles' replacement refinement: never a hole) */

/** Whether a node can be drawn whole: from the plan at its level and up, under it only with all its tiles made. */
export const drawable = (n: FarNode, planFrom: number): boolean => n.k >= planFrom || !Number.isFinite(planFrom) || n.tiles === 4 ** n.k;

/** Whether a node can give way to its quarters: each drawable (a quarter under the plan's levels with a tile not made keeps it whole). */
export function refinable(n: FarNode, planFrom: number): boolean {
  if (!Number.isFinite(planFrom) || n.k - 1 >= planFrom) return true;
  return n.children.every((c) => c !== null && c.tiles === 4 ** c.k);
}
/** THE STANDING LEVEL: the level whose nodes over the WHOLE map are always baked, kept on the GPU and waited for by the opening's curtain, to stand in a place the view jumps to before anything finer of it came (the plan's where no tile is made). 16 km nodes: the finest whose plan still draws its avenues (`farRoadTiles.ts` bakePlanRoads: an 8 m error under an avenue's 14 m), 4 over a map of 10 or 20 km, 16 over 40 km.
 *  - DO NOT stand in only round the eye: a jump to the far edge of a 20 km map (`escala` edge-east-1s) showed grass, nothing of it baked at any level, for a second (esc20c, 2026-10-17). */
export const STANDING_LEVEL = 4;

/** The standing level's nodes over the map (`STANDING_LEVEL`). */
export function standingNodes(ensure: (k: number, i: number, j: number) => FarNode): FarNode[] {
  const side = nodeSide(STANDING_LEVEL), lo = Math.floor(-MAP_HALF / side), hi = Math.floor((MAP_HALF - 1) / side);
  const out: FarNode[] = [];
  for (let i = lo; i <= hi; i++) for (let j = lo; j <= hi; j++) out.push(ensure(STANDING_LEVEL, i, j));
  return out;
}

/** Whether a node meets the map (`MAP_HALF`). */
const onMap = (n: FarNode): boolean => n.x1 > -MAP_HALF && n.x0 < MAP_HALF && n.y1 > -MAP_HALF && n.y0 < MAP_HALF;

/** NOT MADE YET (CLAUDE.md: never a hole): the top-level nodes over the view's reach round the eye made, for the plan's to stand where no tile is (those past it, with no tile and off the map, let go: a root over the map holds the standing level, `standingNodes`). */
export function plantRoots(roots: Iterable<FarNode>, e: { readonly x: number; readonly y: number }, r: number, ensure: (k: number, i: number, j: number) => FarNode, forget: (n: FarNode) => void): void {
  const side = nodeSide(TOP_LEVEL);
  const i0 = Math.floor((e.x - r) / side), i1 = Math.floor((e.x + r) / side), j0 = Math.floor((e.y - r) / side), j1 = Math.floor((e.y + r) / side);
  for (const root of [...roots]) if (root.tiles === 0 && !onMap(root) && (root.i < i0 || root.i > i1 || root.j < j0 || root.j > j1)) forget(root);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) ensure(TOP_LEVEL, i, j);
}

/** What the choice reads from outside the tree that tells it nothing when it moves: the near level's version and the page's edits of the stored tiles (`nearTiles`). */
export function nearOutsideKey(near: FarNear<unknown> | undefined, source: FarTileSource | null, leaves: Iterable<number>): string {
  if (!near) return '';
  const version = near.version?.() ?? '';
  // DO NOT ask every leaf each frame (every tile of the map): one serial for them all where the source has it.
  if (source?.pageEdits) return `${version}|${source.pageEdits()}`;
  const edit = source?.pageEdit;
  if (!edit) return version;
  const d = new Digest();
  for (const key of leaves) d.add(edit(key));
  return `${version}|${d.value()}`;
}

/** The tile and its neighbours stored, at their versions (the tile first): what its near level reads; a tile the page holds edited, at the digest of what the near level reads of it (`PageCuts`). */
export function nearTilesOf(n: FarNode, leaves: ReadonlyMap<number, FarNode>, cuts: PageCuts): { key: number; version: number; cut: PageCut | null }[] {
  const out = [{ key: tileKey(n.i, n.j), version: n.version, cut: cuts.of(tileKey(n.i, n.j)) }];
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if (di === 0 && dj === 0) continue;
      const key = tileKey(n.i + di, n.j + dj);
      const leaf = leaves.get(key);
      if (leaf) out.push({ key, version: leaf.version, cut: cuts.of(key) });
    }
  }
  return out;
}

/** NOT COME YET (CLAUDE.md: never a hole): a node with a tile made under it and nothing of it on the GPU, at a level the plan draws, asks its plan first (a quick bake, kept apart, `planKey`) and stands in it until its tiles' bake comes. DO NOT leave it bare while its tiles' bake waits on theirs: the 20 km map showed a band of blocks with avenues only for seconds round the town just made (ring20a, band5, 2026-10-18). */
export const standsInPlan = (n: FarNode, planFrom: number): boolean => Number.isFinite(planFrom) && n.k >= planFrom && n.tiles > 0 && n.landed === null;
