import type { MacroParams } from '@people/body/macro';
import type { PersonLook } from '@people/spec';

/** READY-MADE CHOICES for each part of a person, as The Sims' Create-a-Sim offers them: a tap sets the part, the sliders and the click-and-drag refine it */

/** A preset of one part: its regional sliders (-1..1, `Morpher` names), every other slider of the part back at rest. */
export interface PartPreset {
  readonly label: string;
  readonly glyph: string;
  readonly features: Readonly<Record<string, number>>;
}

export interface Part {
  readonly id: string;
  readonly label: string;
  readonly glyph: string;
  /** The sliders a preset of this part owns: set to the preset's value or to rest. */
  readonly sliders: readonly string[];
  readonly presets: readonly PartPreset[];
}

/** The lab's eyes: big as Create-a-Sim draws them, the lid resting on the iris (the eye's size slider, never the eyeball swollen). */
export const BIG_EYES: Readonly<Record<string, number>> = {
  // Bigger only, never opened wider: an opened lid shows white round the iris and reads as a stare (the player, 2026-10-21).
  'eye-scale-decr-incr': 0.7,
};

export const PARTS: readonly Part[] = [
  {
    id: 'eyes', label: 'Olhos', glyph: '👁️',
    sliders: ['eye-scale-decr-incr', 'eye-trans-in-out', 'eye-corner1-down-up', 'eye-corner2-down-up', 'eye-height1-decr-incr', 'eye-height2-decr-incr',
      'eye-height3-decr-incr', 'eye-epicanthus-in-out', 'eye-trans-down-up'],
    presets: [
      { label: 'Grandes', glyph: '🥺', features: BIG_EYES },
      { label: 'Enormes', glyph: '😳', features: { 'eye-scale-decr-incr': 1, 'eye-height1-decr-incr': 0.5, 'eye-height2-decr-incr': 0.65, 'eye-height3-decr-incr': 0.5 } },
      { label: 'Redondos', glyph: '🙂', features: { 'eye-height1-decr-incr': 0.45, 'eye-height2-decr-incr': 0.5, 'eye-height3-decr-incr': 0.45 } },
      { label: 'Amendoados', glyph: '😌', features: { 'eye-corner1-down-up': 0.35, 'eye-corner2-down-up': 0.3, 'eye-height2-decr-incr': -0.15 } },
      { label: 'Puxados', glyph: '😊', features: { 'eye-corner1-down-up': 0.55, 'eye-epicanthus-in-out': -0.5, 'eye-height2-decr-incr': -0.3 } },
      { label: 'Caídos', glyph: '🥱', features: { 'eye-corner1-down-up': -0.5, 'eye-corner2-down-up': -0.45 } },
      { label: 'Juntos', glyph: '🤨', features: { 'eye-trans-in-out': -0.5 } },
      { label: 'Afastados', glyph: '😶', features: { 'eye-trans-in-out': 0.5 } },
      { label: 'Naturais', glyph: '🙂', features: {} },
    ],
  },
  {
    id: 'brows', label: 'Sobrancelhas', glyph: '〰️',
    sliders: ['eyebrows-angle-down-up', 'eyebrows-trans-down-up', 'eyebrows-trans-backward-forward'],
    presets: [
      { label: 'Naturais', glyph: '🙂', features: {} },
      { label: 'Arqueadas', glyph: '🤔', features: { 'eyebrows-angle-down-up': 0.55, 'eyebrows-trans-down-up': 0.25 } },
      { label: 'Altas', glyph: '😮', features: { 'eyebrows-trans-down-up': 0.6 } },
      { label: 'Baixas', glyph: '😐', features: { 'eyebrows-trans-down-up': -0.5 } },
      { label: 'Bravas', glyph: '😠', features: { 'eyebrows-angle-down-up': -0.6, 'eyebrows-trans-down-up': -0.3 } },
      { label: 'Tristes', glyph: '🥺', features: { 'eyebrows-angle-down-up': 0.75, 'eyebrows-trans-down-up': 0.1 } },
    ],
  },
  {
    id: 'nose', label: 'Nariz', glyph: '👃',
    sliders: ['nose-scale-horiz-decr-incr', 'nose-scale-vert-decr-incr', 'nose-volume-decr-incr', 'nose-point-width-decr-incr', 'nose-point-down-up',
      'nose-curve-concave-convex', 'nose-hump-decr-incr', 'nose-greek-decr-incr', 'nose-nostrils-width-decr-incr', 'nose-flaring-decr-incr', 'nose-width1-decr-incr'],
    presets: [
      { label: 'Pequeno', glyph: '🔹', features: { 'nose-scale-horiz-decr-incr': -0.4, 'nose-scale-vert-decr-incr': -0.4, 'nose-volume-decr-incr': -0.4, 'nose-point-width-decr-incr': -0.3 } },
      { label: 'Arrebitado', glyph: '🐽', features: { 'nose-point-down-up': 0.7, 'nose-curve-concave-convex': -0.45, 'nose-scale-vert-decr-incr': -0.2 } },
      { label: 'Batatinha', glyph: '🥔', features: { 'nose-point-width-decr-incr': 0.7, 'nose-volume-decr-incr': 0.45, 'nose-point-down-up': 0.2 } },
      { label: 'Fino', glyph: '📏', features: { 'nose-scale-horiz-decr-incr': -0.6, 'nose-point-width-decr-incr': -0.6, 'nose-width1-decr-incr': -0.4 } },
      { label: 'Largo', glyph: '⬛', features: { 'nose-scale-horiz-decr-incr': 0.55, 'nose-nostrils-width-decr-incr': 0.6, 'nose-flaring-decr-incr': 0.4 } },
      { label: 'Romano', glyph: '🏛️', features: { 'nose-hump-decr-incr': 0.7, 'nose-greek-decr-incr': 0.35, 'nose-scale-vert-decr-incr': 0.3 } },
      { label: 'Aquilino', glyph: '🦅', features: { 'nose-hump-decr-incr': 0.5, 'nose-point-down-up': -0.5, 'nose-curve-concave-convex': 0.5 } },
      { label: 'Grego', glyph: '🗿', features: { 'nose-greek-decr-incr': 0.8 } },
    ],
  },
  {
    id: 'mouth', label: 'Boca', glyph: '👄',
    sliders: ['mouth-scale-horiz-decr-incr', 'mouth-scale-vert-decr-incr', 'mouth-upperlip-volume-decr-incr', 'mouth-lowerlip-volume-decr-incr',
      'mouth-cupidsbow-decr-incr', 'mouth-angles-down-up', 'mouth-laugh-lines-in-out', 'mouth-dimples-in-out', 'mouth-trans-backward-forward'],
    presets: [
      { label: 'Carnuda', glyph: '💋', features: { 'mouth-upperlip-volume-decr-incr': 0.6, 'mouth-lowerlip-volume-decr-incr': 0.7 } },
      { label: 'Fina', glyph: '➖', features: { 'mouth-upperlip-volume-decr-incr': -0.6, 'mouth-lowerlip-volume-decr-incr': -0.55 } },
      { label: 'Coração', glyph: '💗', features: { 'mouth-cupidsbow-decr-incr': 0.7, 'mouth-upperlip-volume-decr-incr': 0.4, 'mouth-scale-horiz-decr-incr': -0.3 } },
      { label: 'Larga', glyph: '😁', features: { 'mouth-scale-horiz-decr-incr': 0.6 } },
      { label: 'Pequena', glyph: '😗', features: { 'mouth-scale-horiz-decr-incr': -0.5, 'mouth-scale-vert-decr-incr': -0.2 } },
      { label: 'Sorridente', glyph: '😊', features: { 'mouth-angles-down-up': 0.6, 'mouth-laugh-lines-in-out': 0.3, 'mouth-dimples-in-out': 0.4 } },
      { label: 'Biquinho', glyph: '😙', features: { 'mouth-lowerlip-volume-decr-incr': 0.6, 'mouth-trans-backward-forward': 0.3, 'mouth-scale-horiz-decr-incr': -0.25 } },
      { label: 'Séria', glyph: '😐', features: { 'mouth-angles-down-up': -0.4 } },
    ],
  },
  {
    id: 'jaw', label: 'Queixo', glyph: '🧔',
    sliders: ['chin-width-decr-incr', 'chin-bones-decr-incr', 'chin-height-decr-incr', 'chin-prominent-decr-incr', 'chin-cleft-decr-incr', 'chin-triangle',
      'chin-prognathism-decr-incr'],
    presets: [
      { label: 'Suave', glyph: '🥚', features: {} },
      { label: 'Quadrado', glyph: '🟦', features: { 'chin-width-decr-incr': 0.6, 'chin-bones-decr-incr': 0.5 } },
      { label: 'Fino', glyph: '🔻', features: { 'chin-width-decr-incr': -0.5, 'chin-bones-decr-incr': -0.4 } },
      { label: 'Pontudo', glyph: '📐', features: { 'chin-triangle': 0.6, 'chin-width-decr-incr': -0.35 } },
      { label: 'Com furinho', glyph: '🍑', features: { 'chin-cleft-decr-incr': 0.8 } },
      { label: 'Marcante', glyph: '💪', features: { 'chin-prominent-decr-incr': 0.6, 'chin-prognathism-decr-incr': 0.3, 'chin-bones-decr-incr': 0.4 } },
    ],
  },
  {
    id: 'cheeks', label: 'Bochechas', glyph: '😊',
    sliders: ['cheek-volume-decr-incr', 'cheek-bones-decr-incr', 'cheek-inner-decr-incr', 'cheek-trans-down-up', 'head-fat-decr-incr'],
    presets: [
      { label: 'Naturais', glyph: '🙂', features: {} },
      { label: 'Bochechudas', glyph: '🐹', features: { 'cheek-volume-decr-incr': 0.7, 'head-fat-decr-incr': 0.3 } },
      { label: 'Maçãs altas', glyph: '🍎', features: { 'cheek-bones-decr-incr': 0.7, 'cheek-trans-down-up': 0.3 } },
      { label: 'Fundas', glyph: '💀', features: { 'cheek-volume-decr-incr': -0.6, 'cheek-inner-decr-incr': -0.4 } },
    ],
  },
  {
    id: 'ears', label: 'Orelhas', glyph: '👂',
    sliders: ['ear-scale-decr-incr', 'ear-flap-decr-incr', 'ear-lobe-decr-incr', 'ear-shape-pointed-triangle', 'ear-shape-square-round'],
    presets: [
      { label: 'Normais', glyph: '👂', features: {} },
      { label: 'Pequenas', glyph: '🤏', features: { 'ear-scale-decr-incr': -0.6 } },
      { label: 'Grandes', glyph: '🐘', features: { 'ear-scale-decr-incr': 0.5 } },
      { label: 'De abano', glyph: '🐒', features: { 'ear-flap-decr-incr': 0.8 } },
      { label: 'Élficas', glyph: '🧝', features: { 'ear-shape-pointed-triangle': 0.85 } },
    ],
  },
];

const HEAD_SHAPES = ['head-oval', 'head-round', 'head-square', 'head-rectangular', 'head-diamond', 'head-triangular', 'head-invertedtriangular'];

/** Whole faces: a head shape and a choice for every part. */
export interface FacePreset { readonly label: string; readonly glyph: string; readonly head: string; readonly parts: Readonly<Record<string, string>> }

export const FACES: readonly FacePreset[] = [
  { label: 'Fofa', glyph: '🥰', head: 'head-round', parts: { eyes: 'Grandes', brows: 'Arqueadas', nose: 'Arrebitado', mouth: 'Coração', jaw: 'Suave', cheeks: 'Bochechudas', ears: 'Pequenas' } },
  { label: 'Simpática', glyph: '😊', head: 'head-oval', parts: { eyes: 'Redondos', brows: 'Naturais', nose: 'Pequeno', mouth: 'Sorridente', jaw: 'Suave', cheeks: 'Maçãs altas', ears: 'Normais' } },
  { label: 'Elegante', glyph: '💃', head: 'head-oval', parts: { eyes: 'Amendoados', brows: 'Arqueadas', nose: 'Fino', mouth: 'Carnuda', jaw: 'Fino', cheeks: 'Maçãs altas', ears: 'Pequenas' } },
  { label: 'Marcante', glyph: '😎', head: 'head-square', parts: { eyes: 'Amendoados', brows: 'Baixas', nose: 'Romano', mouth: 'Larga', jaw: 'Marcante', cheeks: 'Naturais', ears: 'Normais' } },
  { label: 'Durão', glyph: '😤', head: 'head-rectangular', parts: { eyes: 'Pequenos', brows: 'Bravas', nose: 'Largo', mouth: 'Séria', jaw: 'Quadrado', cheeks: 'Fundas', ears: 'Normais' } },
  { label: 'Sonhadora', glyph: '😌', head: 'head-invertedtriangular', parts: { eyes: 'Caídos', brows: 'Tristes', nose: 'Pequeno', mouth: 'Biquinho', jaw: 'Pontudo', cheeks: 'Naturais', ears: 'Pequenas' } },
  { label: 'Divertido', glyph: '🤪', head: 'head-round', parts: { eyes: 'Afastados', brows: 'Altas', nose: 'Batatinha', mouth: 'Larga', jaw: 'Com furinho', cheeks: 'Bochechudas', ears: 'De abano' } },
  { label: 'Misterioso', glyph: '🧐', head: 'head-diamond', parts: { eyes: 'Puxados', brows: 'Baixas', nose: 'Aquilino', mouth: 'Fina', jaw: 'Fino', cheeks: 'Fundas', ears: 'Élficas' } },
];

/** A part's preset applied: the part's sliders all at rest, then the preset's. */
export function withPart(features: Readonly<Record<string, number>>, part: Part, preset: PartPreset): Record<string, number> {
  const out: Record<string, number> = { ...features };
  for (const s of part.sliders) delete out[s];
  return { ...out, ...preset.features };
}

export function withFace(features: Readonly<Record<string, number>>, face: FacePreset): Record<string, number> {
  let out: Record<string, number> = { ...features };
  for (const h of HEAD_SHAPES) delete out[h];
  out[face.head] = 0.4;
  for (const part of PARTS) {
    const preset = part.presets.find((p) => p.label === face.parts[part.id]);
    if (preset) out = withPart(out, part, preset);
  }
  return out;
}

/** The part whose sliders the person's face matches now, by preset label, or null. */
export function currentPreset(features: Readonly<Record<string, number>>, part: Part): string | null {
  for (const p of part.presets) {
    if (part.sliders.every((s) => Math.abs((features[s] ?? 0) - (p.features[s] ?? 0)) < 1e-3)) return p.label;
  }
  return null;
}

/** Bodies: the macro sliders and a few regional ones. */
export interface BodyPreset { readonly label: string; readonly glyph: string; readonly body: Partial<MacroParams>; readonly features: Readonly<Record<string, number>> }

export const BODY_SLIDERS = ['measure-waist-circ-decr-incr', 'measure-hips-circ-decr-incr', 'measure-bust-circ-decr-incr', 'stomach-pregnant-decr-incr',
  'torso-vshape-decr-incr', 'measure-shoulder-dist-decr-incr', 'buttocks-volume-decr-incr', 'measure-thigh-circ-decr-incr'];

export const BODIES: readonly BodyPreset[] = [
  { label: 'Magro', glyph: '🥢', body: { weight: 0.2, muscle: 0.35 }, features: {} },
  { label: 'Esbelto', glyph: '🧍', body: { weight: 0.35, muscle: 0.45, height: 0.6 }, features: { 'measure-waist-circ-decr-incr': -0.3 } },
  { label: 'Médio', glyph: '🙂', body: { weight: 0.5, muscle: 0.5, height: 0.5 }, features: {} },
  { label: 'Atlético', glyph: '🏃', body: { weight: 0.45, muscle: 0.8 }, features: { 'torso-vshape-decr-incr': 0.4, 'measure-waist-circ-decr-incr': -0.3 } },
  { label: 'Musculoso', glyph: '💪', body: { weight: 0.6, muscle: 1 }, features: { 'torso-vshape-decr-incr': 0.7, 'measure-shoulder-dist-decr-incr': 0.4 } },
  { label: 'Curvilíneo', glyph: '⏳', body: { weight: 0.55, muscle: 0.45 }, features: { 'measure-hips-circ-decr-incr': 0.55, 'measure-waist-circ-decr-incr': -0.45, 'measure-bust-circ-decr-incr': 0.35, 'buttocks-volume-decr-incr': 0.5 } },
  { label: 'Gordinho', glyph: '🧸', body: { weight: 0.82, muscle: 0.4 }, features: { 'stomach-pregnant-decr-incr': 0.3 } },
  { label: 'Fortão', glyph: '🐻', body: { weight: 0.8, muscle: 0.8 }, features: { 'measure-shoulder-dist-decr-incr': 0.3 } },
  { label: 'Baixinho', glyph: '⬇️', body: { height: 0.12 }, features: {} },
  { label: 'Alto', glyph: '⬆️', body: { height: 0.88 }, features: {} },
];

export function withBody(body: MacroParams, features: Readonly<Record<string, number>>, preset: BodyPreset): { body: MacroParams; features: Record<string, number> } {
  const out: Record<string, number> = { ...features };
  // Height presets keep the build; build presets keep the height.
  if (Object.keys(preset.body).some((k) => k !== 'height')) for (const s of BODY_SLIDERS) delete out[s];
  return { body: { ...body, ...preset.body }, features: { ...out, ...preset.features } };
}

/** Whole outfits, cut for either sex. */
export interface LookPreset { readonly label: string; readonly glyph: string; readonly female: Partial<PersonLook>; readonly male: Partial<PersonLook> }

export const LOOKS: readonly LookPreset[] = [
  { label: 'Casual', glyph: '👕', female: { outfit: 'female_casualsuit02', outfitTint: 0x6a8fbf, footwear: 'shoes01', extras: [] },
    male: { outfit: 'male_casualsuit02', outfitTint: null, footwear: 'shoes01', extras: [] } },
  { label: 'Social', glyph: '👔', female: { outfit: 'female_elegantsuit01', outfitTint: 0x22252b, footwear: 'elvs_flatshoe_pointy1', extras: [] },
    male: { outfit: 'male_elegantsuit01', outfitTint: null, footwear: 'shoes02', extras: [] } },
  // Not female_sportsuit01: its texture's holes show white specks at the ankles.
  { label: 'Esporte', glyph: '🏀', female: { outfit: 'female_casualsuit02', outfitTint: 0xe05a8a, footwear: 'shoes01', extras: [] },
    male: { outfit: 'male_casualsuit06', outfitTint: 0x2f9d8f, footwear: 'shoes01', extras: [] } },
  { label: 'Trabalho', glyph: '🦺', female: { outfit: 'female_casualsuit01', outfitTint: 0x3b4a6b, footwear: 'shoes02', extras: [] },
    male: { outfit: 'male_worksuit01', outfitTint: null, footwear: 'shoes02', extras: [] } },
  { label: 'Colorido', glyph: '🌈', female: { outfit: 'female_casualsuit01', outfitTint: 0xffd166, footwear: 'shoes01', extras: [] },
    male: { outfit: 'male_casualsuit03', outfitTint: 0xe8b820, footwear: 'shoes01', extras: [] } },
  { label: 'Festa', glyph: '🎉', female: { outfit: 'female_elegantsuit01', outfitTint: 0xb03a2e, footwear: 'elvs_flatshoe_gemmed1', extras: [] },
    male: { outfit: 'male_elegantsuit01', outfitTint: 0x3b4a6b, footwear: 'shoes02', extras: [] } },
];

/** The lab's base faces, approved by eye (front and profile, 2026-10-21): a soft, pretty face whose mouth sits back over a forward chin.
 *  Every new person starts from one and varies a little; the canon fit is a button, not the default (it bent noses and mouths to their ends). */
const SHARED_FACE: Readonly<Record<string, number>> = {
  'eye-scale-decr-incr': 0.35, 'eye-corner1-down-up': 0.15, 'nose-point-down-up': 0.2,
  'mouth-cupidsbow-decr-incr': 0.2, 'mouth-angles-down-up': 0.2, 'mouth-trans-backward-forward': -0.5, 'chin-prominent-decr-incr': 0.4,
  'mouth-upperlip-volume-decr-incr': -0.2, 'mouth-lowerlip-volume-decr-incr': -0.1, 'cheek-bones-decr-incr': 0.25,
};
export const BASE_FACE = {
  female: { ...SHARED_FACE, 'nose-scale-horiz-decr-incr': -0.25, 'nose-scale-vert-decr-incr': -0.2, 'nose-volume-decr-incr': -0.2,
    'chin-width-decr-incr': -0.3, 'head-oval': 0.3, 'eyebrows-trans-down-up': 0.15, 'eyebrows-angle-down-up': 0.15 },
  male: { ...SHARED_FACE, 'eye-scale-decr-incr': 0.25, 'chin-width-decr-incr': 0.3, 'chin-bones-decr-incr': 0.25, 'head-square': 0.3,
    'mouth-angles-down-up': 0.1 },
} as const;

/** A base face varied a little per person (each slider up to 0.12 either way): no two alike, none bent out of shape. */
export function variedFace(sex: 'female' | 'male', r: () => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(BASE_FACE[sex])) out[k] = Math.max(-1, Math.min(1, v + (r() - 0.5) * 0.24));
  return sex === 'female' ? { ...FEMALE_FIGURE, ...out } : out;
}

/** A woman's body as she is drawn by default (the player, 2026-10-21: no builder in a dress): narrow shoulders, a small waist, fuller hips, a slim neck and arms. */
export const FEMALE_FIGURE: Readonly<Record<string, number>> = {
  'measure-shoulder-dist-decr-incr': -0.45, 'measure-waist-circ-decr-incr': -0.4, 'measure-hips-circ-decr-incr': 0.3, 'buttocks-volume-decr-incr': 0.25,
  'measure-neck-circ-decr-incr': -0.35, 'upperarm-fat-decr-incr': -0.2, 'foot-scale-decr-incr': -0.35, 'hand-scale-decr-incr': -0.15, 'measure-upperarm-circ-decr-incr': -0.3, 'torso-scale-horiz-decr-incr': -0.25,
};
