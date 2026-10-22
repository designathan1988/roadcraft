import { QUALITY_FIELD_OPTIONS, qualityFieldValue, withQualityFields, type QualityOptId } from './optimizationsQuality';
import type { OptChoice, OptSystem, OptValue } from './optimizationTypes';
import type { QualitySettings } from './quality';

/** THE OPTIMISATIONS THE GAME DOES NOT MAKE (the lab's "Optimisations" tab, `lab/optimizations/`): each one chosen alone, live, to measure what it gains and what it costs the picture. Its first value is the game as it draws today: every one at its first value, nothing differs (`isDefaultOptimizations`). Applied in the renderer (`optimizationsApply.ts`), the tier's settings (`withOptimizations`) and the frame (`main.ts` population). */

export { OPT_SYSTEM_TITLES } from './optimizationTypes';
export type { OptChoice, OptSystem, OptValue } from './optimizationTypes';

/** An optimisation as written below, before what it affects is given it. */
interface BaseSpec {
  readonly id: string;
  readonly system: OptSystem;
  readonly title: string;
  readonly what: string;
  readonly tradeoff: string;
  readonly choices: readonly OptChoice[];
}

export interface OptimizationSpec {
  readonly id: OptId;
  readonly system: OptSystem;
  readonly title: string;
  /** What it does, in the game's terms. */
  readonly what: string;
  /** What it should gain and what it costs (expected, not measured). */
  readonly tradeoff: string;
  /** The first is the game as it draws today. */
  readonly choices: readonly OptChoice[];
  /** Any number in it as well as the choices (a tier's field, `optimizationsQuality.ts`). */
  readonly range?: { readonly min: number; readonly max: number; readonly step: number };
  /** What it changes, for the lab's object inspector to find the options of a thing: `all`, `shadows`, `post`, `textures`, `layer:<layer switch>` (`effectSwitches.ts` LAYER_SWITCHES), `pass:<post switch>`, `name:<glob of a mesh or group name>`. */
  readonly affects: readonly string[];
}

const TIER: OptChoice = { value: 'tier', label: 'tier' };

const BASE = [
  // ---- the renderer
  {
    id: 'opaqueSort', system: 'renderer', title: 'Opaque sort order',
    what: 'How three sorts opaque objects before drawing (WebGLRenderer.setOpaqueSort). Today: by material and, within it, front to back. "Depth": front to back only (maximum early-z). "None": scene order, unsorted.',
    tradeoff: 'Depth cuts overdraw and costs more program switches; "None" saves the CPU sort and loses early-z.',
    choices: [{ value: 'material', label: 'material' }, { value: 'depth', label: 'depth' }, { value: 'none', label: 'none' }],
  },
  {
    id: 'precision', system: 'materials', title: 'Shader precision',
    what: 'Material.precision of every material in the scene (and of any that arrive later): highp as today, or mediump. Programs are rebuilt off the draw (compileAsync).',
    tradeoff: 'On desktop GPUs (ANGLE/D3D11) mediump is treated as highp: it usually changes nothing. On integrated/mobile GPUs it may gain, and large positions may jitter.',
    choices: [{ value: 'highp', label: 'highp' }, { value: 'mediump', label: 'mediump' }],
  },
  {
    id: 'frustumCull', system: 'culling', title: 'Forced frustum culling',
    what: 'Turns frustumCulled on for the plain meshes (not instanced, not skinned) the game left with it off: three stops drawing the ones out of view.',
    tradeoff: 'Fewer draw calls; a mesh its shader displaces (or whose bounding sphere is stale) may vanish at the screen edge.',
    choices: [{ value: 'as-is', label: 'as is' }, { value: 'plain', label: 'plain meshes' }],
  },
  // ---- shadows
  {
    id: 'shadowType', system: 'shadows', title: 'Shadow type',
    what: 'renderer.shadowMap.type: PCF (5 compared samples, linear filter) as today, or Basic (one sample, no filter). The cascade maps are rebuilt for the type.',
    tradeoff: 'Basic reads the map once per pixel instead of five times: jagged shadows. Also turns off the street light (it reads the maps as PCF).',
    choices: [{ value: 'pcf', label: 'PCF' }, { value: 'basic', label: 'Basic' }],
  },
  {
    id: 'shadowMapSize', system: 'shadows', title: 'Shadow map size',
    what: "The side of each of the sun's 3 cascade maps, over the tier.",
    tradeoff: 'Smaller: less memory and fewer depth pixels per pass; coarser shadows.',
    choices: [TIER, { value: 4096, label: '4096' }, { value: 2048, label: '2048' }, { value: 1024, label: '1024' }, { value: 512, label: '512' }],
  },
  {
    id: 'shadowEvery', system: 'shadows', title: 'Shadow pass every N frames',
    what: 'The shadow pass (every cascade) is requested only every N frames; what changed in between waits for the next one.',
    tradeoff: 'Fewer shadow passes while the scene moves; shadows of moving things lag up to N frames.',
    choices: [{ value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }, { value: 4, label: '4' }],
  },
  {
    id: 'farCascadeEvery', system: 'shadows', title: 'Far cascades every N frames',
    what: 'Cascades 1 and 2 (the far ones) are redrawn only every N passes; the near one (0) as always.',
    tradeoff: 'Cuts most full redraws of the far cascades; distant shadows lag a frame when the camera turns. The bands it broke into were the scroll of a skipped turn being lost (`sunCascades.ts` fit, fixed 2026-10-22).',
    // 2 by default (the first choice): flying the camera, the shadows cost 4.7 ms of GPU a frame, p95 12.4 ms, against 0.6 standing still (`npm run diagnose`, 2026-10-22).
    choices: [{ value: 2, label: '2' }, { value: 1, label: '1' }, { value: 4, label: '4' }, { value: 8, label: '8' }],
  },
  {
    id: 'castMasses', system: 'shadows', title: 'Buildings cast shadow by their masses',
    what: 'In which cascades buildings cast shadow by their masses only (BuildingLayer.castInto coarse). Today: the far ones. "All": the near one too. "None": the detail in every cascade.',
    tradeoff: '"All" cuts hundreds of meshes from the nearest pass; shadows lose balconies, awnings and cut-outs.',
    choices: [{ value: 'far', label: 'far' }, { value: 'all', label: 'all' }, { value: 'none', label: 'none' }],
  },
  {
    id: 'castTexel', system: 'shadows', title: 'Shadow-casting parts: minimum width',
    what: 'A building part casts shadow only when wider than N texels of the cascade (1 today). "None": no part casts.',
    tradeoff: 'Fewer meshes in each pass; small parts without shadow.',
    choices: [{ value: 1, label: '1 texel' }, { value: 2, label: '2' }, { value: 4, label: '4' }, { value: 'none', label: 'none' }],
  },
  {
    id: 'agentShadows', system: 'shadows', title: 'People and vehicle shadows',
    what: 'People and vehicles cast shadow into the cascades (as today) or use the soft disc on the ground (what the game does without shadows).',
    tradeoff: 'Disc: no cascade redraws for whatever moves; generic shadow.',
    choices: [{ value: 'cast', label: 'in the cascades' }, { value: 'disc', label: 'disc' }],
  },
  // ---- post
  {
    id: 'postChain', system: 'post', title: 'Whole post chain',
    what: 'The post chain (occlusion, street light, clouds, bloom, SMAA, sharpen) is not even built: the scene goes straight to the multisampled target and to the screen, without the half-precision targets.',
    tradeoff: "Unlike turning each pass off: also saves the HalfFloat target, the copies and the targets' memory; loses every effect.",
    choices: [TIER, { value: 'off', label: 'not built' }],
  },
  {
    id: 'msaa', system: 'post', title: 'Scene MSAA samples',
    what: 'Samples of the multisampled target the scene is drawn into (QualitySettings.msaa).',
    tradeoff: 'Fewer samples: less bandwidth and memory at scene resolution; jagged edges (SMAA still runs).',
    choices: [TIER, { value: 8, label: '8' }, { value: 4, label: '4' }, { value: 2, label: '2' }, { value: 0, label: '0' }],
  },
  {
    id: 'aoResolution', system: 'post', title: 'Occlusion resolution (GTAO)',
    what: "Ambient occlusion at the scene's resolution or at half (QualitySettings.aoFull).",
    tradeoff: 'Half: a quarter of the GTAO and denoise pixels; blurred occlusion edges.',
    choices: [TIER, { value: 'full', label: 'full' }, { value: 'half', label: 'half' }],
  },
  {
    id: 'cloudPass', system: 'post', title: 'Cloud pass built',
    what: 'The cloud and fog pass is not even created (QualitySettings.cloudShadows and skyClouds), rather than just skipped.',
    tradeoff: 'No cloud program and no cloud targets; no clouds, painted fog or cloud shadows.',
    choices: [TIER, { value: 'off', label: 'do not build' }],
  },
  // ---- textures
  {
    id: 'anisotropy', system: 'textures', title: 'Anisotropic filtering cap',
    what: 'The most anisotropic samples of every texture in the scene (TEXTURE_MAX_ANISOTROPY_EXT set straight on the uploaded texture, no re-upload).',
    tradeoff: 'Fewer samples per texture read at grazing angles; ground and facades blurred in the distance.',
    choices: [TIER, { value: 16, label: '16' }, { value: 8, label: '8' }, { value: 4, label: '4' }, { value: 2, label: '2' }, { value: 1, label: '1' }],
  },
  // ---- level of detail
  {
    id: 'buildingLod', system: 'buildings', title: 'Building screen error',
    what: 'Multiplies the screen error the building levels accept (levelOfDetail and cullDetails with fewer pixels per metre).',
    tradeoff: 'Coarser levels sooner: fewer triangles and meshes; level switches closer to the camera.',
    // The game's own: two pixels of error at a distance, where a detail is under the eye's reach; ×1.5 changes almost no level.
    choices: [{ value: 2, label: '×2' }, { value: 1, label: '×1' }, { value: 1.5, label: '×1.5' }, { value: 4, label: '×4' }],
  },
  {
    id: 'wear', system: 'roads', title: 'Road wear',
    what: 'The wear wheels and feet leave on the roads (wear.ts) is updated every frame, or stays frozen.',
    tradeoff: 'Frozen: saves the CPU work per vehicle and pedestrian and the texture uploads; the wear does not evolve.',
    choices: [{ value: 'on', label: 'updates' }, { value: 'off', label: 'frozen' }],
  },
  {
    id: 'terrainLod', system: 'terrain', title: 'Terrain screen error',
    what: 'Multiplies the pixel error the terrain levels accept (terrainLod.ts, 1 px today).',
    tradeoff: 'Fewer ground patches and vertices; distant relief ripples when it changes level.',
    choices: [{ value: 1, label: '×1' }, { value: 2, label: '×2' }, { value: 4, label: '×4' }, { value: 8, label: '×8' }],
  },
  {
    id: 'reliefEvery', system: 'terrain', title: 'Distant relief and forests every N frames',
    what: 'terrain.bakeRelief (the blending of distant forests, the paint strokes) only every N frames.',
    tradeoff: 'Less work per frame; paint and forest transitions show up late.',
    choices: [{ value: 1, label: '1' }, { value: 2, label: '2' }, { value: 4, label: '4' }, { value: 8, label: '8' }],
  },
  {
    id: 'waterMaterial', system: 'water', title: 'Water material',
    what: 'Rivers and lakes drawn with their own material (extended Standard, waves, foam) or with a plain Lambert for the draw only.',
    tradeoff: 'Measures what water shading costs; the water goes flat.',
    choices: [{ value: 'normal', label: 'own' }, { value: 'plain', label: 'Lambert' }],
  },
  {
    id: 'vegetation', system: 'vegetation', title: 'Vegetation density',
    what: "Fraction of the tier's vegetation (QualitySettings.vegetation): forests, wild trees.",
    tradeoff: 'Fewer plant instances; sparse landscape.',
    choices: [TIER, { value: 0.5, label: '50%' }, { value: 0.25, label: '25%' }, { value: 0, label: 'none' }],
  },
  {
    id: 'detailProps', system: 'vegetation', title: 'Street furniture',
    what: 'Benches, detail posts and footway props (QualitySettings.detailProps).',
    tradeoff: 'Fewer small meshes; empty streets.',
    choices: [TIER, { value: 'off', label: 'none' }],
  },
  {
    id: 'detailCutoff', system: 'people', title: 'Detail minimum zoom',
    what: 'Multiplies the zoom below which markings, furniture, and detailed people and vehicles stop being drawn (detailCutoffZoom).',
    tradeoff: 'Neighbourhood views without the fine detail; it appears closer in.',
    choices: [{ value: 1, label: '×1' }, { value: 1.5, label: '×1.5' }, { value: 2, label: '×2' }, { value: 3, label: '×3' }],
  },
  {
    id: 'pedestrianDetail', system: 'people', title: 'People detail',
    what: "The crowd's detail cap: 2 animated face, 1 clothes, 0 silhouette (QualitySettings.pedestrianDetail).",
    tradeoff: 'Fewer variants and animations; generic people.',
    choices: [TIER, { value: 2, label: '2' }, { value: 1, label: '1' }, { value: 0, label: '0' }],
  },
  {
    id: 'hairStrands', system: 'people', title: 'People with hair strands',
    what: 'How many of the nearest people get hair strands (QualitySettings.hairStrandPeople).',
    tradeoff: 'Fewer hair meshes; block hair.',
    choices: [TIER, { value: 4, label: '4' }, { value: 2, label: '2' }, { value: 0, label: '0' }],
  },
  {
    id: 'vehicleError', system: 'vehicles', title: 'Vehicle screen error',
    what: 'Pixels of error the level of each vehicle part accepts (QualitySettings.vehicleErrorPixels, 0.5 px today).',
    tradeoff: 'Coarser parts sooner: fewer triangles; simplified cars closer in.',
    choices: [TIER, { value: 1, label: '1 px' }, { value: 2, label: '2 px' }, { value: 4, label: '4 px' }],
  },
  {
    id: 'vehicleWhole', system: 'vehicles', title: 'Whole vehicles (at most)',
    what: 'How many vehicles are drawn whole (body, cabin and wheels apart), the largest on screen (QualitySettings.vehicleWholeCap).',
    tradeoff: 'Fewer meshes per vehicle; the rest as a single part.',
    choices: [{ value: 50, label: '50' }, TIER, { value: 100, label: '100' }, { value: 20, label: '20' }, { value: 0, label: '0' }],
  },
  {
    id: 'occupants', system: 'vehicles', title: 'Vehicle occupants',
    what: 'The zoom from which the people inside vehicles are drawn (QualitySettings.occupantZoom).',
    tradeoff: 'Fewer people drawn; empty cars from afar, or always.',
    choices: [TIER, { value: 'x2', label: 'zoom ×2' }, { value: 'never', label: 'never' }],
  },
  {
    id: 'exhaust', system: 'particles', title: 'Exhaust smoke',
    what: 'Exhaust and dust particles are emitted and animated, or nothing is emitted (the "Particles" layer only hides them).',
    tradeoff: 'No CPU emission and animation and no buffer upload; no smoke.',
    choices: [{ value: 'on', label: 'emits' }, { value: 'off', label: 'does not emit' }],
  },
  // ---- the simulation
  {
    id: 'population', system: 'simulation', title: 'Population cap',
    what: "Fraction of the population the simulation governor may put on the street (the worker's maxShare).",
    tradeoff: 'Fewer agents in the worker and on screen; emptier city.',
    choices: [{ value: 1, label: '100%' }, { value: 0.75, label: '75%' }, { value: 0.5, label: '50%' }, { value: 0.25, label: '25%' }],
  },
  {
    id: 'focusDetail', system: 'simulation', title: 'Detailed simulation in view',
    what: 'People avoid one another where they are seen up close (SimFocus.detail), or never.',
    tradeoff: 'Off: saves the pedestrian interaction in the worker; they walk through each other up close.',
    choices: [{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }],
  },
  // ---- uploads and pacing
  {
    id: 'uploadEvery', system: 'uploads', title: 'Mesh upload every N frames',
    what: 'The meshes waiting to go to the GPU (drainWarm, 4 MiB at a time) are uploaded only every N frames.',
    tradeoff: 'Fewer frames with bufferData; whatever is loading appears more slowly.',
    choices: [{ value: 1, label: '1' }, { value: 2, label: '2' }, { value: 4, label: '4' }],
  },
] as const satisfies readonly BaseSpec[];

/** What each changes (`OptimizationSpec.affects`). */
const AFFECTS: Readonly<Record<(typeof BASE)[number]['id'], readonly string[]>> = {
  opaqueSort: ['all'],
  precision: ['all'],
  frustumCull: ['all'],
  shadowType: ['shadows', 'pass:canyonLight'],
  shadowMapSize: ['shadows'],
  shadowEvery: ['shadows'],
  farCascadeEvery: ['shadows'],
  castMasses: ['shadows', 'layer:buildings', 'name:building-*'],
  castTexel: ['shadows', 'layer:buildings', 'name:building-*'],
  agentShadows: ['shadows', 'layer:people', 'name:procedural-people', 'name:person'],
  postChain: ['post', 'pass:ambientOcclusion', 'pass:canyonLight', 'pass:bloom', 'pass:clouds', 'pass:smaa', 'pass:sharpen'],
  msaa: ['post', 'all'],
  aoResolution: ['post', 'pass:ambientOcclusion'],
  cloudPass: ['post', 'pass:clouds'],
  anisotropy: ['textures', 'all'],
  buildingLod: ['layer:buildings', 'name:building-*'],
  wear: ['layer:roads', 'name:roads-*'],
  terrainLod: ['layer:terrain', 'name:flat-world-*'],
  reliefEvery: ['layer:terrain', 'layer:vegetation', 'name:flat-world-*', 'name:far-forest*'],
  waterMaterial: ['layer:water', 'name:*water*'],
  vegetation: ['layer:vegetation', 'name:far-forest*'],
  detailProps: ['layer:furniture'],
  detailCutoff: ['layer:people', 'layer:furniture', 'layer:roads', 'layer:signals'],
  pedestrianDetail: ['layer:people', 'name:procedural-people', 'name:person'],
  hairStrands: ['layer:people', 'name:procedural-people'],
  vehicleError: ['layer:people'],
  vehicleWhole: ['layer:people'],
  occupants: ['layer:people', 'name:person'],
  exhaust: ['layer:particles', 'name:exhaust'],
  population: ['layer:people', 'layer:farTraffic', 'name:densityCars'],
  focusDetail: ['layer:people'],
  uploadEvery: ['all'],
};

type BaseId = (typeof BASE)[number]['id'];
export type OptId = BaseId | QualityOptId;

/** Every optimisation: the ones above, then every field of the tier's settings (`optimizationsQuality.ts`). */
export const OPTIMIZATIONS: readonly OptimizationSpec[] = [
  ...BASE.map((spec) => ({ ...spec, affects: AFFECTS[spec.id] })),
  ...QUALITY_FIELD_OPTIONS,
];

export type Optimizations = Readonly<Record<OptId, OptValue>>;

export const DEFAULT_OPTIMIZATIONS: Optimizations = Object.freeze(Object.fromEntries(
  OPTIMIZATIONS.map((spec) => [spec.id, spec.choices[0]!.value]),
) as Record<OptId, OptValue>);

export const optimizationSpec = (id: string): OptimizationSpec | undefined => OPTIMIZATIONS.find((spec) => spec.id === id);

/** The value `value` (or its text, as an input gives it) when `id` may take it: one of its choices, or a number in its range; undefined otherwise. */
export function optimizationChoice(id: string, value: unknown): OptValue | undefined {
  const quality = QUALITY_FIELD_OPTIONS.find((spec) => spec.id === id);
  if (quality) return qualityFieldValue(quality, value);
  const spec = optimizationSpec(id);
  if (!spec) return undefined;
  return spec.choices.find((c) => c.value === value || String(c.value) === String(value))?.value;
}

export function isDefaultOptimizations(values: Optimizations): boolean {
  return OPTIMIZATIONS.every((spec) => values[spec.id] === spec.choices[0]!.value);
}

/** The tier's settings that the optimisations change. */
const QUALITY_OPTIONS: readonly OptId[] = ['shadowMapSize', 'postChain', 'msaa', 'aoResolution', 'cloudPass', 'vegetation', 'detailProps', 'detailCutoff', 'pedestrianDetail', 'hairStrands', 'vehicleError', 'vehicleWhole', 'occupants',
  // q.anisotropy is applied to the textures directly (`optimizationsApply.ts`): no tier rebuilt for it.
  ...QUALITY_FIELD_OPTIONS.filter((spec) => spec.field !== 'anisotropy').map((spec) => spec.id)];

/** Whether two sets of optimisations give the tier different settings (`withOptimizations`). */
export function qualityOptionsDiffer(a: Optimizations, b: Optimizations): boolean {
  return QUALITY_OPTIONS.some((id) => a[id] !== b[id]);
}

/** The tier's settings with the optimisations over them; THE SAME OBJECT when none of them changes one (the game as it draws, byte for byte). */
export function withOptimizations(settings: QualitySettings, o: Optimizations): QualitySettings {
  if (QUALITY_OPTIONS.every((id) => o[id] === DEFAULT_OPTIMIZATIONS[id])) return settings;
  const num = (v: OptValue, tier: number): number => (typeof v === 'number' ? v : tier);
  const postOff = o.postChain === 'off';
  // Each field set by hand last, over everything (`optimizationsQuality.ts`).
  return withQualityFields({
    ...settings,
    shadowMapSize: num(o.shadowMapSize, settings.shadowMapSize),
    postProcessing: postOff ? false : settings.postProcessing,
    ambientOcclusion: postOff ? false : settings.ambientOcclusion,
    smaa: postOff ? false : settings.smaa,
    msaa: num(o.msaa, settings.msaa),
    aoFull: o.aoResolution === 'full' ? true : o.aoResolution === 'half' ? false : settings.aoFull,
    cloudShadows: o.cloudPass === 'off' ? false : settings.cloudShadows,
    skyClouds: o.cloudPass === 'off' ? false : settings.skyClouds,
    vegetation: typeof o.vegetation === 'number' ? Math.round(settings.vegetation * o.vegetation) : settings.vegetation,
    detailProps: o.detailProps === 'off' ? false : settings.detailProps,
    detailCutoffZoom: settings.detailCutoffZoom * num(o.detailCutoff, 1),
    pedestrianDetail: typeof o.pedestrianDetail === 'number' ? (o.pedestrianDetail as 0 | 1 | 2) : settings.pedestrianDetail,
    hairStrandPeople: num(o.hairStrands, settings.hairStrandPeople),
    vehicleErrorPixels: num(o.vehicleError, settings.vehicleErrorPixels),
    vehicleWholeCap: num(o.vehicleWhole, settings.vehicleWholeCap),
    occupantZoom: o.occupants === 'never' ? Infinity : o.occupants === 'x2' ? settings.occupantZoom * 2 : settings.occupantZoom,
  }, o);
}

/** A thing of the scene as the lab's inspector knows it: its layer (`LAYER_SWITCHES`), its post pass, the names of it and its parents. */
export interface OptTarget {
  readonly layer?: string;
  readonly pass?: string;
  readonly names?: readonly string[];
}

/** `*` any run of characters, everything else itself. */
function globMatch(glob: string, name: string): boolean {
  const parts = glob.split('*');
  if (parts.length === 1) return glob === name;
  const first = parts[0]!, last = parts[parts.length - 1]!;
  if (!name.startsWith(first) || !name.endsWith(last) || name.length < first.length + last.length) return false;
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = name.indexOf(part, at);
    if (found < 0 || found + part.length > name.length - last.length) return false;
    at = found + part.length;
  }
  return true;
}

/** Whether `spec` changes `target` (`OptimizationSpec.affects`); `all` only when `withAll`. */
export function affectsTarget(spec: OptimizationSpec, target: OptTarget, withAll = false): boolean {
  return spec.affects.some((tag) => {
    if (tag === 'all') return withAll;
    if (target.layer && tag === `layer:${target.layer}`) return true;
    if (target.pass && tag === `pass:${target.pass}`) return true;
    if (tag.startsWith('name:')) return (target.names ?? []).some((name) => globMatch(tag.slice(5), name));
    return false;
  });
}
