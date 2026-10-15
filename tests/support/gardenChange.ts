import type { GardenChange, GardenPlant } from '@render/gardens';

/** The change from the town's lists as last given to the town's lists now */
export function townChanges(): (lists: readonly (readonly GardenPlant[])[]) => GardenChange {
  let placed = new Set<readonly GardenPlant[]>();
  return (lists) => {
    const now = new Set(lists);
    const change = { added: lists.filter((list) => !placed.has(list)), removed: [...placed].filter((list) => !now.has(list)) };
    placed = now;
    return change;
  };
}
