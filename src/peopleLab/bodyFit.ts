import { BODY_CANON, measureBody, type BodyMeasure } from './proportions';
import type { LabBuilder } from './build';
import type { LabPerson } from './record';

/** THE BODY SET TO ITS MEASURED CANON (`proportions.ts` BODY_CANON): height in heads by the head's size, shoulders against hips, the neck against the head.
 *  The face is left alone: the approved base face (`presets.ts` BASE_FACE) is the face; refitting it to ratios bent it (2026-10-21, "caveman"). */
export async function fitBody(person: LabPerson, builder: LabBuilder): Promise<LabPerson> {
  const { assets } = await builder.setup();
  // The body first: height in heads by the head's size (legs as drawn), then shoulders against hips, then the neck against the head.
  const target = BODY_CANON[person.spec.body.gender < 0.5 ? 'female' : 'male'];
  const bodyOf = async (p: LabPerson): Promise<BodyMeasure> => measureBody(assets, await builder.shape(p));
  let p: LabPerson = { ...person, style: { ...person.style, legs: 1, eyes: 1 } };
  const shapes = new Map<string, BodyMeasure>();
  const at = async (q: LabPerson): Promise<BodyMeasure> => {
    const key = JSON.stringify([q.style.head, q.spec.features['measure-shoulder-dist-decr-incr'], q.spec.features['measure-neck-circ-decr-incr'], q.spec.features['torso-scale-horiz-decr-incr']]);
    let m = shapes.get(key);
    if (!m) { m = await bodyOf(q); shapes.set(key, m); }
    return m;
  };
  // The measures are read on whole shapes (async); a few probes each, the secant by hand.
  const fit1 = async (get: (x: number) => LabPerson, key: keyof BodyMeasure, goal: number, x0: number, lo: number, hi: number): Promise<number> => {
    let a = x0, b = Math.min(hi, x0 + (hi - lo) * 0.1);
    let fa = (await at(get(a)))[key] - goal, fb = (await at(get(b)))[key] - goal;
    for (let i = 0; i < 7 && Math.abs(fb) > 1e-3 && Math.abs(fb - fa) > 1e-7; i++) {
      const c = Math.max(lo, Math.min(hi, b - fb * (b - a) / (fb - fa)));
      a = b; fa = fb; b = c; fb = (await at(get(c)))[key] - goal;
    }
    return Math.abs(fb) < Math.abs(fa) ? b : a;
  };
  const head = await fit1((h) => ({ ...p, style: { ...p.style, head: h } }), 'heads', target.heads, p.style.head, 0.85, 1.6);
  p = { ...p, style: { ...p.style, head } };
  const withF = (k: string, v: number): LabPerson => ({ ...p, spec: { ...p.spec, features: { ...p.spec.features, [k]: v } } });
  const sh = await fit1((v) => withF('measure-shoulder-dist-decr-incr', v), 'shoulders', target.shoulders, p.spec.features['measure-shoulder-dist-decr-incr'] ?? 0, -1, 1);
  p = withF('measure-shoulder-dist-decr-incr', sh);
  // Where the shoulder slider runs out, the chest's width finishes the job.
  if (Math.abs((await at(p)).shoulders - target.shoulders) > 0.02) {
    const tw = await fit1((v) => withF('torso-scale-horiz-decr-incr', v), 'shoulders', target.shoulders, p.spec.features['torso-scale-horiz-decr-incr'] ?? 0, -0.7, 0.7);
    p = withF('torso-scale-horiz-decr-incr', tw);
  }
  const nk = await fit1((v) => withF('measure-neck-circ-decr-incr', v), 'neck', target.neck, p.spec.features['measure-neck-circ-decr-incr'] ?? 0, -1, 1);
  p = withF('measure-neck-circ-decr-incr', nk);
  return p;
}
