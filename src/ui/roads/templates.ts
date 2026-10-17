import { KeptList } from '@core/keptList';
import type { RoadProfileSpec } from '@world/roads/profile';
import { type RoadTemplate, normalizeTemplate } from '@world/roads/templates';
import { unitFactor } from '@world/rescale';
import { METERS_PER_UNIT } from '@world/units';

/** The player's own road templates, kept in this browser for every map, as Cities */
const kept = new KeptList('roadcraft.roadTemplates', 'road template');

/** A stored entry as a template in this build's unit, or null when this build cannot read it (it stays stored). */
const readTemplate = (raw: unknown): RoadTemplate | null => normalizeTemplate(inThisUnit(raw));

/** The same list while nothing was saved or deleted, so the catalogue can tell it is unchanged. */
export function savedTemplates(): readonly RoadTemplate[] {
  return kept.readShared(readTemplate);
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

/** A template as stored: with the world unit its widths are in. */
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
