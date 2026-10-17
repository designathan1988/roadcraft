import { type WorldPart, WORLD_PARTS } from '@world/doc';
import type { SerializedDoc } from '@world/doc';
import type { PartStore } from './saveStore';
import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import type { HeldLists } from './tileStore';

/** THE STREAMED WORLD'S VALUES IN THE STORE (`editor/tileStore.ts` WorldMeta): the whole under one key, each part written since under its own (`RoadDoc.worldPart`), read back over the whole */

/** What the world keeps outside its tiles: the values with no place on the map, small. */
export interface WorldMeta {
  readonly version: 1;
  /** The whole-map generator's options with its seed (`cityGen/wholeMap.ts`); null: a map not generated, or saved before the tiles. */
  readonly generator: WholeMapOptions | null;
  /** Metres per world unit the tiles' records are in (`world/units.ts`). */
  readonly unit: number;
  /** The streamed world's parts no tile holds, as the page's document writes them (`RoadDoc.worldValues`): read back into it when the world opens. */
  readonly values?: Partial<SerializedDoc>;
  readonly relief?: number;
  readonly markingStyle?: string;
  readonly nature?: SerializedDoc['nature'];
  readonly weather?: unknown;
  /** The fog's settings (its dabs are the map's). */
  readonly fog?: unknown;
  readonly gullyAuto?: unknown;
  readonly economy?: SerializedDoc['economy'];
  readonly transit?: unknown;
  readonly people?: readonly unknown[];
  /** A map saved before the tiles: what of it no tile holds. */
  readonly held?: HeldLists;
  /** A map saved before the tiles: its camera and simulation settings, and when it was saved. */
  readonly settings?: unknown;
  readonly savedAt?: number;
}

export const metaKey = (map: string): string => `${map}:world`;
export const metaPartKey = (map: string, part: WorldPart): string => `${map}:world:${part}`;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function isWorldMeta(value: unknown): value is WorldMeta {
  return isObject(value) && value['version'] === 1 && typeof value['unit'] === 'number' && Number.isFinite(value['unit']) && (value['generator'] === null || isObject(value['generator']));
}

export async function readMeta(store: PartStore, map: string): Promise<WorldMeta | null> {
  const [blob, ...parts] = await store.get([metaKey(map), ...WORLD_PARTS.map((part) => metaPartKey(map, part))]);
  if (!blob) return null;
  const value: unknown = JSON.parse(await blob.text());
  if (!isWorldMeta(value)) throw new Error(`the world of ${map} is stored and cannot be read`);
  if (parts.every((part) => !part)) return value;
  // Each part written apart since (`setMetaParts`) taken over the values: its keys as it holds them now (a key it no longer has is gone).
  let values: Record<string, unknown> = { ...(value.values ?? {}) };
  for (let k = 0; k < WORLD_PARTS.length; k++) {
    const part = parts[k];
    if (!part) continue;
    const held = JSON.parse(await part.text()) as Record<string, unknown>;
    for (const key of PART_KEYS[WORLD_PARTS[k]!]) delete values[key];
    values = { ...values, ...held };
  }
  return { ...value, values: values as Partial<SerializedDoc> };
}

/** The keys of the world's values each part writes (`RoadDoc.worldPart`): a part read back first clears its own. */
const PART_KEYS: Readonly<Record<WorldPart, readonly string[]>> = {
  terrain: ['terrain', 'relief'], markingStyle: ['markingStyle'], nature: ['nature'], fog: ['fog'], gullies: ['gullies'], clouds: ['clouds'],
  weather: ['weather'], clearings: ['treeClearings'], zones: ['zones', 'zoneMarks'], people: ['people'], transit: ['transit'], economy: ['economy'],
  allocators: ['allocators'],
};
