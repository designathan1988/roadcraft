import type { RoadProfileSpec } from '@world/roads/profile';
import { type RoadTemplate, normalizeTemplate } from '@world/roads/templates';
import { unitFactor } from '@world/rescale';
import { METERS_PER_UNIT } from '@world/units';

/**
 * The player's own road templates (docs/VIAS.md V1), kept in this browser for
 * every map, as Cities: Skylines keeps a player's roads apart from any one
 * city. Read back through `normalizeTemplate`: a damaged entry is dropped,
 * never built. Storage can be refused (a private window): then nothing is
 * kept and the game goes on.
 */
const STORE = 'roadcraft.roadTemplates';

export function savedTemplates(): RoadTemplate[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map((t) => normalizeTemplate(inThisUnit(t))).filter((t): t is RoadTemplate => t !== null);
  } catch {
    return [];
  }
}

/** Saves a template under a name, replacing one of the same name; null when it cannot be built or kept. */
export function saveTemplate(name: string, type: number, profile: RoadProfileSpec): RoadTemplate | null {
  const template = normalizeTemplate({ id: `user:${Date.now().toString(36)}`, name, type, profile });
  if (!template) return null;
  const list = savedTemplates().filter((t) => t.name !== template.name);
  list.push(template);
  try {
    localStorage.setItem(STORE, JSON.stringify(list.map(withUnit)));
  } catch {
    return null;
  }
  return template;
}

export function deleteTemplate(id: string): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(savedTemplates().filter((t) => t.id !== id).map(withUnit)));
  } catch {
    // Storage refused: there was nothing kept to remove.
  }
}

/** A template as stored: with the world unit its widths are in (docs/ESCALA.md). */
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
