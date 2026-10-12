/**
 * Whether the road tool lays new roads with retaining walls in their
 * cuttings (docs/VIAS.md V3, `RoadSegment.cutWalls`) instead of a batter: a
 * choice of the tool, like its width, kept in the browser, not in any map.
 */
const STORAGE_KEY = 'roadcraft.cutWalls';
let chosen = read();

function read(): boolean {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}

export function cutWallsChosen(): boolean {
  return chosen;
}

export function setCutWalls(on: boolean): void {
  if (on === chosen) return;
  chosen = on;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, on ? '1' : '0'); } catch { /* kept for this session */ }
}
