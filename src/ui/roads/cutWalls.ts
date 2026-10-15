/** Whether the road tool lays new roads with retaining walls in their cuttings */
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
