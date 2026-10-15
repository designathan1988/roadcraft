import { KeptList } from '@core/keptList';
import type { Blueprint, BlueprintBody } from '@world/buildings/blueprints';
import { migrateBuilding } from '@world/buildings/serialize';
import { rescaleBuilding, unitFactor } from '@world/rescale';
import { METERS_PER_UNIT } from '@world/units';

/** DO NOT drop the oldest past a count: the 49th save erased the first without a word */
const KEY = 'roadcraft.blueprints.v1';

interface StoredBlueprint {
  readonly key: string;
  readonly name: string;
  readonly body: unknown;
  /** Metres per world unit it was saved in; absent: 0.4, before 2026-10-10. */
  readonly unit?: number;
}

const isStored = (entry: unknown): entry is StoredBlueprint =>
  !!entry && typeof entry === 'object' && typeof (entry as StoredBlueprint).key === 'string' && typeof (entry as StoredBlueprint).name === 'string';

export class BlueprintLibrary {
  private readonly kept: KeptList;

  constructor(storageKey = KEY) {
    this.kept = new KeptList(storageKey, 'blueprint');
  }

  list(): Blueprint[] {
    return this.kept.read(readEntry);
  }

  /** Saves a body under a name (the one of that name replaced); returns the stored blueprint, or null when it was not saved. */
  save(name: string, body: BlueprintBody): Blueprint | null {
    const title = name.trim().slice(0, 40) || 'Blueprint';
    let key = '';
    const written = this.kept.update((entries) => {
      const existing = entries.find((e): e is StoredBlueprint => isStored(e) && e.name.toLocaleLowerCase() === title.toLocaleLowerCase());
      key = existing?.key ?? `user-${Date.now().toString(36)}-${entries.length}`;
      const entry: StoredBlueprint = { key, name: title, body, unit: METERS_PER_UNIT };
      return [entry, ...entries.filter((e) => !(isStored(e) && e.key === key))];
    });
    return written ? { key, name: title, body } : null;
  }

  /** Removes one blueprint, the rest as they were; false when nothing could be written. */
  remove(key: string): boolean {
    return this.kept.update((entries) => entries.filter((e) => !(isStored(e) && e.key === key)));
  }
}

/** One stored entry as a blueprint, or null when this build cannot read it (it stays stored). */
function readEntry(entry: unknown): Blueprint | null {
  if (!isStored(entry)) return null;
  const body = readBody(rescaleBuilding(entry.body, unitFactor(entry.unit), null));
  return body ? { key: entry.key, name: entry.name, body } : null;
}

/** A stored body, repaired through `migrateBuilding` (placement fields are dummies). */
function readBody(raw: unknown): BlueprintBody | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const building = migrateBuilding({ ...(raw as object), id: 1, x: 0, y: 0, rotation: 0 });
  if (!building) return null;
  const body = JSON.parse(JSON.stringify(building)) as Record<string, unknown>;
  for (const key of ['id', 'x', 'y', 'rotation']) delete body[key];
  return body as unknown as BlueprintBody;
}
