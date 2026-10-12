import type { LotTemplate } from './lotTemplate';

/**
 * The lots made in the lot lab (`lots/*.json`, 2026-10-05): each a building
 * of the tower kit with its whole lot - front, walls, gates, parking, trees -
 * drawn with parts of its own (`render/buildings/signature.ts`). Offered in
 * the builder's models (`ui/builder/workspace.ts`, key `lot:<name>`).
 *
 * Read only when one is chosen: a lazy glob, each file its own chunk, so the
 * 33 records (about 1 MB of JSON) never weigh on the opening (the eager glob
 * of the models was what `render/elements.ts` moved away from).
 */
const loaders = import.meta.glob<LotTemplate>('/lots/*.json', { import: 'default' });

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1, -'.json'.length);

/** The names of the lots, in a stable order. */
export const LOT_NAMES: readonly string[] = Object.keys(loaders).map(nameOf).sort();

/** The key a lot goes by in the builder's models. */
export const lotKey = (name: string): string => `lot:${name}`;

/** The lots read so far, by name (`loadedLot`). */
const loaded = new Map<string, LotTemplate>();

/** Reads one lot, or null when there is none of that name. */
export async function loadLot(name: string): Promise<LotTemplate | null> {
  const known = loaded.get(name);
  if (known) return known;
  const path = Object.keys(loaders).find((p) => nameOf(p) === name);
  const load = path ? loaders[path] : undefined;
  if (!load) return null;
  const lot = await load();
  loaded.set(name, lot);
  return lot;
}

/** A lot already read (`loadLot`), or null: for what must answer at once (a picture of it). */
export const loadedLot = (name: string): LotTemplate | null => loaded.get(name) ?? null;

