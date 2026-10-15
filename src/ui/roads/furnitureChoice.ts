import { type FurnitureSet, isFurnitureSet } from '@world/roads/furnitureSets';

/** The furniture the road tool lays new roads with (`world/roads/furnitureSets.ts`) */
const STORAGE_KEY = 'roadcraft.roadFurniture';
let chosen: FurnitureSet = read();

function read(): FurnitureSet {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isFurnitureSet(v) ? v : 'complete';
  } catch { return 'complete'; }
}

export function furnitureChosen(): FurnitureSet {
  return chosen;
}

export function setFurnitureChosen(set: FurnitureSet): void {
  if (set === chosen) return;
  chosen = set;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, set); } catch { /* kept for this session */ }
}
