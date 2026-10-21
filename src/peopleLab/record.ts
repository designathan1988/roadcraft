import type { PersonSpec } from '@people/spec';
import type { HairStyle } from '@people/hair/procedural';
import type { CartoonStyle } from '@render/people/cartoon';
import type { HairSculpt } from './sculpt';
import { yearsFromAge } from '@people/body/macro';

/** A PERSON MADE IN THE LAB, as saved: the game's own `PersonSpec` plus what the game does not yet keep per person */

export const RECORD_FORMAT = 'roadcraft-people/1';

export interface LabPerson {
  readonly spec: PersonSpec;
  /** Proportions in an animated film's style, per person (`cartoon.ts`). */
  readonly style: CartoonStyle;
  /** A hairstyle grown in the hair studio (`hair/procedural.ts`) when `spec.look.hairCut` is `proc:<name>`. */
  readonly hair?: HairStyle;
  /** The hairstyle reshaped with the sculptor, when `base` is the one worn (`spec.look.hairCut`). */
  readonly sculpt?: HairSculpt;
  /** Any worn piece reshaped with the sculptor (a garment, shoes, a hat), each by its item name (`sculpt.base`). */
  readonly sculpts?: readonly HairSculpt[];
}

export interface LabRoster {
  readonly format: typeof RECORD_FORMAT;
  readonly people: readonly LabPerson[];
}

/** The hair studio's hairstyles are named `proc:<id>`, never a catalogue item. */
export const PROC_PREFIX = 'proc:';

const round = (x: number, places = 3): number => {
  const k = 10 ** places;
  return Math.round(x * k) / k;
};

/** The person written small: numbers to 3 places, features at rest left out, nothing undefined. */
export function compactPerson(person: LabPerson): LabPerson {
  const { spec } = person;
  const features: Record<string, number> = {};
  for (const [name, value] of Object.entries(spec.features)) {
    const v = round(value, 2);
    if (v !== 0) features[name] = v;
  }
  const body = Object.fromEntries(Object.entries(spec.body).map(([k, v]) => [k, round(v)])) as unknown as PersonSpec['body'];
  const look = Object.fromEntries(Object.entries(spec.look)
    .filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? round(v) : v])) as unknown as PersonSpec['look'];
  const style = Object.fromEntries(Object.entries(person.style).map(([k, v]) => [k, round(v)])) as unknown as CartoonStyle;
  return {
    spec: { id: spec.id, name: spec.name, ...(spec.mood !== undefined ? { mood: round(spec.mood, 2) } : {}), body, features, look },
    style,
    ...(person.hair && spec.look.hairCut?.startsWith(PROC_PREFIX) ? { hair: person.hair } : {}),
    ...(person.sculpt && person.sculpt.base === spec.look.hairCut ? { sculpt: person.sculpt } : {}),
    ...(person.sculpts?.length ? { sculpts: person.sculpts } : {}),
  };
}

export function rosterOf(people: readonly LabPerson[]): LabRoster {
  return { format: RECORD_FORMAT, people: people.map(compactPerson) };
}

/** A roster read back (a file, the browser's storage); malformed entries are dropped, not guessed. */
export function readRoster(raw: unknown): LabPerson[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const people = (raw as { people?: unknown }).people;
  if (!Array.isArray(people)) return [];
  return people.filter((p): p is LabPerson => typeof p === 'object' && p !== null
    && typeof (p as LabPerson).spec?.id === 'number' && typeof (p as LabPerson).spec?.look === 'object'
    && typeof (p as LabPerson).style?.head === 'number');
}

/** Bytes the person takes saved. */
export const savedBytes = (person: LabPerson): number => new Blob([JSON.stringify(compactPerson(person))]).size;

/** The roster as read in the browser's storage (per-viewer convenience; the project file `lab-reports/people-roster.json` is the record). */
export function loadRoster(): LabPerson[] {
  try { return readRoster(JSON.parse(localStorage.getItem('roadcraft.peopleLab.roster') ?? 'null')); } catch (error) { console.warn('[people-lab] the saved roster could not be read', error); return []; }
}
export function loadThumbs(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem('roadcraft.peopleLab.thumbs') ?? '{}') as Record<string, string>; } catch (error) { console.warn('[people-lab] the saved thumbnails could not be read', error); return {}; }
}

/** The roster for a reader: one line a person. */
export function rosterMarkdown(people: readonly LabPerson[]): string {
  return ['# Pessoas criadas no lab', '', `Formato \`roadcraft-people/1\`, ${people.length} pessoas.`, '',
    ...people.map((p) => `- **${p.spec.name || 'Sem nome'}** (id ${p.spec.id}): ${Math.round(yearsFromAge(p.spec.body.age))} anos, `
      + `${p.spec.body.gender < 0.5 ? 'feminino' : 'masculino'}, cabelo \`${p.spec.look.hairCut ?? 'none'}\`, roupa \`${p.spec.look.outfit ?? 'sob medida'}\`, `
      + `${savedBytes(p)} bytes`)].join('\n');
}
