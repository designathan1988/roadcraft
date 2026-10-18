import { Digest } from '@core/digest';
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
/** NOT MADE YET (CLAUDE.md: never a hole): the top-level nodes over the view's reach round the eye made, for the plan's to stand where no tile is (those past it, with no tile, let go; their bakes kept: they never change). */
export function plantRoots(roots: Iterable<FarNode>, e: { readonly x: number; readonly y: number }, r: number, ensure: (k: number, i: number, j: number) => FarNode, forget: (n: FarNode) => void): void {
  const side = nodeSide(TOP_LEVEL);
  const i0 = Math.floor((e.x - r) / side), i1 = Math.floor((e.x + r) / side), j0 = Math.floor((e.y - r) / side), j1 = Math.floor((e.y + r) / side);
  for (const root of [...roots]) if (root.tiles === 0 && (root.i < i0 || root.i > i1 || root.j < j0 || root.j > j1)) forget(root);
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
