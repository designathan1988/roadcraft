import { QUALITY, QUALITY_LEVELS, type QualitySettings } from './quality';
import type { OptChoice, OptSystem, OptValue } from './optimizationTypes';

/** EVERY FIELD OF THE TIER'S SETTINGS (`QualitySettings`, `quality.ts`) set by hand from the lab (`optimizations.ts`, ids `q.<field>`): "tier" (the tier's own, the default) or a value of its own, over the tier and over the other optimisations. A field nothing reads today says so: setting it changes nothing. */

type Field = keyof QualitySettings;
type Kind = 'bool' | 'number' | 'choice';

interface FieldSpec {
  readonly system: OptSystem;
  readonly title: string;
  readonly what: string;
  readonly kind: Kind;
  /** A choice's values (`kind` choice). */
  readonly values?: readonly number[];
  /** Read by nothing in the game today (`grep`, 2026-10-19). */
  readonly unread?: boolean;
  readonly affects: readonly string[];
}

const FIELDS: Readonly<Record<Field, FieldSpec>> = {
  pixelRatio: { system: 'renderer', kind: 'number', title: 'Pixel ratio cap', what: "The most device pixel ratio drawn (renderer.setPixelRatio). The switches' \"Resolution\" and dynamic resolution reset it when they change.", affects: ['all'] },
  shadows: { system: 'shadows', kind: 'bool', title: 'Sun shadows', what: "The sun's cascades on (renderer.shadowMap.enabled and the maps).", affects: ['shadows'] },
  shadowMapSize: { system: 'shadows', kind: 'choice', values: [512, 1024, 2048, 4096], title: 'Shadow map side', what: 'The side of each cascade map.', affects: ['shadows'] },
  postProcessing: { system: 'post', kind: 'bool', title: 'Post chain', what: 'The post chain built (without it, the scene goes straight to the multisampled target).', affects: ['post'] },
  ambientOcclusion: { system: 'post', kind: 'bool', title: 'Ambient occlusion (GTAO) and street light', what: 'GTAO and the street light built into the chain.', affects: ['post', 'pass:ambientOcclusion', 'pass:canyonLight'] },
  smaa: { system: 'post', kind: 'bool', title: 'SMAA', what: 'The SMAA pass built.', affects: ['post', 'pass:smaa'] },
  msaa: { system: 'post', kind: 'choice', values: [0, 2, 4, 8], title: 'MSAA samples', what: 'Samples of the scene target.', affects: ['post', 'all'] },
  aoFull: { system: 'post', kind: 'bool', title: 'Full-resolution GTAO', what: "Occlusion at the scene's resolution (on) or at half.", affects: ['post', 'pass:ambientOcclusion'] },
  sharpen: { system: 'post', kind: 'number', title: 'Sharpen (CAS)', what: 'The strength of AMD CAS on the final image, 0 to 1.', affects: ['post', 'pass:sharpen'] },
  anisotropy: { system: 'textures', kind: 'choice', values: [1, 2, 4, 8, 16], title: 'Anisotropy (exact)', what: "Every texture in the scene with exactly this anisotropy, set straight on the uploaded texture (the tier's field is read only when the renderer is created).", affects: ['textures', 'all'] },
  detailProps: { system: 'vegetation', kind: 'bool', title: 'Street furniture', what: 'Benches, props and footway details drawn.', affects: ['layer:furniture'] },
  vegetation: { system: 'vegetation', kind: 'number', title: 'Vegetation (amount)', what: 'The amount of vegetation: distant forests and wild trees.', affects: ['layer:vegetation', 'name:far-forest*'] },
  grassBlades: { system: 'vegetation', kind: 'number', unread: true, title: 'Grass blades', what: 'Blades in the GPU grass field.', affects: ['layer:vegetation'] },
  surfaceDetail: { system: 'textures', kind: 'bool', title: 'Surface detail layer', what: 'The close-up detail texture on asphalt and footways (materials.setDetail).', affects: ['layer:roads', 'textures'] },
  detailCutoffZoom: { system: 'people', kind: 'number', title: 'Detail minimum zoom', what: 'The zoom below which markings, furniture and agents stop being drawn.', affects: ['layer:people', 'layer:furniture', 'layer:roads', 'layer:signals'] },
  pedestrianDetail: { system: 'people', kind: 'choice', values: [0, 1, 2], title: 'People detail', what: '0 silhouette, 1 clothes, 2 animated face.', affects: ['layer:people', 'name:procedural-people', 'name:person'] },
  occupantZoom: { system: 'vehicles', kind: 'number', title: 'Occupant zoom', what: 'The zoom from which the people inside vehicles are drawn.', affects: ['layer:people', 'name:person'] },
  vehicleErrorPixels: { system: 'vehicles', kind: 'number', title: 'Vehicle part screen error', what: 'Pixels of error the level of each part accepts.', affects: ['layer:people'] },
  vehicleWholeCap: { system: 'vehicles', kind: 'number', title: 'Whole vehicles', what: 'How many vehicles are drawn whole, at most.', affects: ['layer:people'] },
  hairStrandPeople: { system: 'people', kind: 'number', title: 'People with hair strands', what: 'How many of the nearest get strands.', affects: ['layer:people', 'name:procedural-people'] },
  cloudShadows: { system: 'post', kind: 'bool', title: 'Cloud shadows', what: 'Builds the cloud pass (together with "Sky clouds").', affects: ['post', 'pass:clouds'] },
  vegetationDistance: { system: 'vegetation', kind: 'number', unread: true, title: 'Vegetation range', what: "Distance of the ecosystem's vegetation.", affects: ['layer:vegetation'] },
  impostors: { system: 'vegetation', kind: 'bool', unread: true, title: 'Plant impostors', what: 'Distant plants as impostors.', affects: ['layer:vegetation'] },
  birds: { system: 'particles', kind: 'number', unread: true, title: 'Birds', what: 'Birds in the air at once.', affects: ['layer:particles'] },
  rain: { system: 'particles', kind: 'bool', unread: true, title: 'Raindrops', what: 'The drops in the air.', affects: ['layer:weather', 'name:rain'] },
  skyClouds: { system: 'post', kind: 'bool', title: 'Sky clouds', what: 'Builds the cloud pass (together with "Cloud shadows").', affects: ['post', 'pass:clouds'] },
  mist: { system: 'post', kind: 'bool', unread: true, title: 'Morning mist', what: 'Mist in the valleys and over the water.', affects: ['post'] },
  triangleScale: { system: 'buildings', kind: 'number', title: 'Triangle budget share', what: "The share of the view's triangle budget the building levels may add up to (above it the error scale rises).", affects: ['layer:buildings'] },
  detailMemoryMB: { system: 'buildings', kind: 'number', title: 'Building detail memory (MB)', what: "The most the building cells' detail keeps on the GPU.", affects: ['layer:buildings'] },
  waterfalls: { system: 'water', kind: 'bool', unread: true, title: 'Waterfall spray', what: 'Spray and mist at the foot of the waterfalls.', affects: ['layer:water'] },
};

export type QualityOptId = `q.${Field}`;

/** A number's range: from 0 to twice the largest any tier holds. */
function rangeOf(field: Field): { min: number; max: number; step: number } {
  const top = Math.max(...QUALITY_LEVELS.map((level) => QUALITY[level][field] as number));
  const max = top > 0 ? top * 2 : 1;
  const raw = max / 100;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return { min: 0, max, step: Number((Math.round(raw / magnitude) * magnitude).toPrecision(6)) };
}

export interface QualityOptionSpec {
  readonly id: QualityOptId;
  readonly field: Field;
  readonly system: OptSystem;
  readonly title: string;
  readonly what: string;
  readonly tradeoff: string;
  readonly choices: readonly OptChoice[];
  readonly range?: { readonly min: number; readonly max: number; readonly step: number };
  readonly affects: readonly string[];
}

export const QUALITY_FIELD_OPTIONS: readonly QualityOptionSpec[] = (Object.keys(FIELDS) as Field[]).map((field) => {
  const f = FIELDS[field];
  const tier: OptChoice = { value: 'tier', label: 'tier' };
  const choices: OptChoice[] = f.kind === 'bool' ? [tier, { value: 'on', label: 'on' }, { value: 'off', label: 'off' }]
    : f.kind === 'choice' ? [tier, ...f.values!.map((v) => ({ value: v, label: String(v) }))] : [tier];
  return {
    id: `q.${field}` as QualityOptId,
    field,
    system: f.system,
    title: `Tier: ${f.title}`,
    what: `${f.what} (QualitySettings.${field})`,
    tradeoff: f.unread ? 'A field defined but read by no code today: changing it has no effect.' : "The tier's value replaced by this one, over the other optimisations.",
    choices,
    ...(f.kind === 'number' ? { range: rangeOf(field) } : {}),
    affects: f.affects,
  };
});

/** Whether `value` is one `id` (a `q.<field>`) may take: a choice, or a number in its range. */
export function qualityFieldValue(spec: QualityOptionSpec, value: unknown): OptValue | undefined {
  const choice = spec.choices.find((c) => c.value === value || String(c.value) === String(value));
  if (choice) return choice.value;
  if (!spec.range) return undefined;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= spec.range.min && n <= spec.range.max ? n : undefined;
}

/** The settings with every `q.<field>` set over them; the same object when none is. */
export function withQualityFields(settings: QualitySettings, values: Readonly<Record<string, OptValue>>): QualitySettings {
  let out: Record<string, unknown> | null = null;
  for (const spec of QUALITY_FIELD_OPTIONS) {
    const v = values[spec.id];
    if (v === undefined || v === 'tier') continue;
    out ??= { ...settings };
    out[spec.field] = v === 'on' ? true : v === 'off' ? false : v;
  }
  return (out ?? settings) as unknown as QualitySettings;
}
