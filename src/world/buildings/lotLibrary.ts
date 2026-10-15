import type { LotTemplate } from './lotTemplate';

/** The lots made in the lot lab (`lots/*.json`, 2026-10-05): each a building of the tower kit with its whole lot */
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

