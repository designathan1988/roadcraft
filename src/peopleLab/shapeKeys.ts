import { yearsFromAge, type MacroParams } from '@people/body/macro';
import { ATELIER, type LabPerson } from './record';

/** WHAT A CHANGE TO A PERSON NEEDS: drawing on the person built (`reshape.ts`) when only the shape moved, a build when what is worn did. */

/** What is built and saved: a child wears the tailored shells (the garments are cut for grown bodies, as the game has it). */
export function effective(person: LabPerson): LabPerson {
  // The atelier's garment is gone: a person saved with one wears the outfit alone.
  const p = person.spec.look.extras?.includes(ATELIER)
    ? { ...person, spec: { ...person.spec, look: { ...person.spec.look, extras: person.spec.look.extras.filter((x) => x !== ATELIER) } } } : person;
  if (yearsFromAge(p.spec.body.age) >= 16) {
    if (p.spec.look.outfit) return p;
    return { ...p, spec: { ...p.spec, look: { ...p.spec.look, outfit: p.spec.body.gender < 0.5 ? 'female_casualsuit02' : 'male_casualsuit02', footwear: 'shoes01' } } };
  }
  const { outfit: _o, footwear: _f, extras: _e, ...look } = p.spec.look;
  void _o; void _f; void _e;
  return { ...p, spec: { ...p.spec, look } };
}

/** What a build depends on beyond the body's shape: what is worn (a child wears the tailored shells), the sex's motion capture. Equal keys reshape, unequal ones build. */
export function buildKey(p: LabPerson): string {
  const e = effective(p);
  // The outfit's colour and style are drawn by uniforms (`clothStyle.ts`): changing them builds nothing.
  const { body: _b, motion: _m, style: _s, outfitStyle: _o, ...rest } = e;
  void _b; void _m; void _s; void _o;
  return JSON.stringify({ ...rest, spec: { ...e.spec, name: '', mood: 0, features: null, body: e.spec.body.gender < 0.5, look: { ...e.spec.look, outfitTint: null } } });
}

/** Everything the body's shape is made from. */
export const shapeOf = (p: LabPerson): string => JSON.stringify([p.spec.body, p.spec.features, p.style, p.body ?? null]);

/** One slider of the shape: its value in a person, and that person with it set. */
export interface Slider { readonly key: string; readonly range: readonly [number, number]; get(p: LabPerson): number; set(p: LabPerson, v: number): LabPerson }

export const bodySlider = (k: keyof MacroParams): Slider => ({ key: `body:${k}`, range: [0, 1], get: (p) => p.spec.body[k],
  set: (p, v) => ({ ...p, spec: { ...p.spec, body: { ...p.spec.body, [k]: v } } }) });
export const featureSlider = (k: string): Slider => ({ key: `feature:${k}`, range: [-1, 1], get: (p) => p.spec.features[k] ?? 0,
  set: (p, v) => ({ ...p, spec: { ...p.spec, features: { ...p.spec.features, [k]: v } } }) });
