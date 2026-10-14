import { KeptList } from '@core/keptList';
import type { RoadProfileSpec } from '@world/roads/profile';
import { type RoadTemplate, normalizeTemplate } from '@world/roads/templates';
import { unitFactor } from '@world/rescale';
import { METERS_PER_UNIT } from '@world/units';

/**
 * The player's own road templates (docs/source/VIAS.md V1), kept in this browser for
 * every map, as Cities: Skylines keeps a player's roads apart from any one
 * city. Read back through `normalizeTemplate`: a damaged entry is not built.
 * Stored as a `KeptList` (`core/keptList.ts`): saving or deleting one template
 * writes every other back as it was, one this build cannot read included, and a
 * change that was not written says so. Storage can be refused (a private
 * window): then nothing is kept, the player is told, and the game goes on.
 */
const kept = new KeptList('roadcraft.roadTemplates', 'road template');

/** A stored entry as a template in this build's unit, or null when this build cannot read it (it stays stored). */
const readTemplate = (raw: unknown): RoadTemplate | null => normalizeTemplate(inThisUnit(raw));

export function savedTemplates(): RoadTemplate[] {
  return kept.read(readTemplate);
}

/** Saves a template under a name, replacing one of the same name; null when it cannot be built or was not kept. */
export function saveTemplate(name: string, type: number, profile: RoadProfileSpec): RoadTemplate | null {
  const template = normalizeTemplate({ id: `user:${Date.now().toString(36)}`, name, type, profile });
  if (!template) return null;
  const written = kept.update((entries) => [...entries.filter((e) => readable(e)?.name !== template.name), withUnit(template)]);
  return written ? template : null;
}

/** Deletes one template, the rest as they were; false when nothing could be written. */
export function deleteTemplate(id: string): boolean {
  return kept.update((entries) => entries.filter((e) => readable(e)?.id !== id));
}

/** An entry as read, for matching it by name or id; an entry that cannot be read matches nothing and stays. */
function readable(entry: unknown): RoadTemplate | null {
  try {
    return readTemplate(entry);
  } catch (error) {
    console.warn('[templates] a road template this build cannot read; kept as it is', error);
    return null;
  }
}

/** A template as stored: with the world unit its widths are in (docs/source/ESCALA.md). */
const withUnit = (t: RoadTemplate): RoadTemplate & { unit: number } => ({ ...t, unit: METERS_PER_UNIT });

/** A stored template's widths in this build's unit; absent `unit`: 0.4 m, every template before 2026-10-10. */
function inThisUnit(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const t = raw as { unit?: unknown; profile?: { elements?: unknown } };
  const factor = unitFactor(t.unit);
  if (factor === 1 || !t.profile || !Array.isArray(t.profile.elements)) return raw;
  const elements = t.profile.elements.map((e: unknown) => (e && typeof e === 'object' && typeof (e as { width?: unknown }).width === 'number'
    ? { ...(e as object), width: (e as { width: number }).width * factor } : e));
  return { ...t, profile: { ...t.profile, elements } };
}
