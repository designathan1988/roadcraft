import type { SegmentDirection } from '../doc';
import { CARRIAGEWAY_MATERIALS, type CarriagewayMaterial, FOOTWAY_MATERIALS, type FootwayMaterial, MEDIAN_MATERIALS, ROAD_SECTION_LIMITS } from '../roadSection';
import { ROAD_TYPES } from '../roadTypes';
import { type ProfileElement, type RoadProfileSpec, profileOf, profileProblems } from './profile';

/**
 * ROAD TEMPLATES (docs/VIAS.md V1): a profile with a name, to lay or apply
 * again. The classes of the road tool are the built-in templates (their
 * profile as a road is drawn with them); the player's own are saved by the
 * editor (`editor/roads/templates.ts`) and read back through
 * `normalizeTemplate`, which refuses anything that is not a template.
 */
export interface RoadTemplate {
  readonly id: string;
  /** A translation key for a built-in template; a player's template has a `name`. */
  readonly nameKey?: string;
  readonly name?: string;
  /** The class the profile is laid with (its colours, its rank, its turning rules). */
  readonly type: number;
  readonly profile: RoadProfileSpec;
}

/** The direction a class is drawn in (`editor/commit.ts`): one-lane classes one way. */
export const classDirection = (type: number): SegmentDirection => (ROAD_TYPES[type]?.lanes === 1 ? 'aToB' : 'both');

/** The classes as templates, in the order of the road tool. */
export function classTemplates(): RoadTemplate[] {
  return ROAD_TYPES.map((rt, type) => ({
    id: `class:${rt.id}`,
    nameKey: rt.nameKey,
    type,
    profile: profileOf({ type, lanes: null, direction: classDirection(type) }),
  }));
}

const KINDS = ['footway', 'parking', 'cycle', 'lane', 'median'] as const;

function readElement(raw: unknown): ProfileElement | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const kind = v['kind'];
  const width = v['width'];
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return null;
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return null;
  switch (kind) {
    case 'footway': {
      const material = v['material'];
      if (material !== undefined && !(FOOTWAY_MATERIALS as readonly unknown[]).includes(material)) return null;
      return { kind, width, ...(material ? { material: material as FootwayMaterial } : {}), ...(v['flush'] === true ? { flush: true } : {}) } as ProfileElement;
    }
    case 'median': {
      const material = v['material'];
      if (material !== undefined && !(MEDIAN_MATERIALS as readonly unknown[]).includes(material)) return null;
      return { kind, width, ...(material ? { material } : {}), ...(v['flush'] === true ? { flush: true } : {}) } as ProfileElement;
    }
    case 'lane': {
      const dir = v['dir'];
      if (dir !== 'forward' && dir !== 'backward') return null;
      return { kind, width, dir, ...(v['use'] === 'bus' ? { use: 'bus' as const } : {}), ...(v['line'] === 'solid' ? { line: 'solid' as const } : {}) };
    }
    default:
      return { kind: kind as 'parking' | 'cycle', width };
  }
}

/** A stored template, or null when it is not one the game can build. */
export function normalizeTemplate(raw: unknown): RoadTemplate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const { id, name, type } = v;
  const profile = v['profile'] as Record<string, unknown> | undefined;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim()) return null;
  if (typeof type !== 'number' || !Number.isInteger(type) || type < 0 || type >= ROAD_TYPES.length) return null;
  if (!profile || typeof profile !== 'object' || !Array.isArray(profile['elements'])) return null;
  const elements: ProfileElement[] = [];
  for (const raw of profile['elements'] as unknown[]) {
    const element = readElement(raw);
    if (!element) return null;
    elements.push(element);
  }
  const speed = profile['speedKmh'], priority = profile['priority'], carriageway = profile['carriageway'];
  if (typeof speed !== 'number' || speed < ROAD_SECTION_LIMITS.speedKmh[0] || speed > ROAD_SECTION_LIMITS.speedKmh[1]) return null;
  if (typeof priority !== 'number' || priority < ROAD_SECTION_LIMITS.priority[0] || priority > ROAD_SECTION_LIMITS.priority[1]) return null;
  if (carriageway !== undefined && !(CARRIAGEWAY_MATERIALS as readonly unknown[]).includes(carriageway)) return null;
  const spec: RoadProfileSpec = {
    elements, speedKmh: speed, priority: Math.round(priority),
    ...(carriageway ? { carriageway: carriageway as CarriagewayMaterial } : {}),
  };
  if (profileProblems(spec, type).length) return null;
  return { id, name: name.trim().slice(0, 40), type, profile: spec };
}
