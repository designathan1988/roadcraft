import { QUALITY_FIELD_OPTIONS, qualityFieldValue, withQualityFields, type QualityOptId } from './optimizationsQuality';
import type { OptChoice, OptSystem, OptValue } from './optimizationTypes';
import type { QualitySettings } from './quality';

/** THE OPTIMISATIONS THE GAME DOES NOT MAKE (the lab's "Otimizações" tab, `lab/optimizations/`): each one chosen alone, live, to measure what it gains and what it costs the picture. Its first value is the game as it draws today: every one at its first value, nothing differs (`isDefaultOptimizations`). Applied in the renderer (`optimizationsApply.ts`), the tier's settings (`withOptimizations`) and the frame (`main.ts` population). */

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

const TIER: OptChoice = { value: 'tier', label: 'do nível' };

const BASE = [
  // ---- the renderer
  {
    id: 'opaqueSort', system: 'renderer', title: 'Ordem dos opacos',
    what: 'Como o three ordena os objetos opacos antes de desenhar (WebGLRenderer.setOpaqueSort). Hoje: por material e, dentro dele, da frente para trás. "Profundidade": só da frente para trás (máximo early-z). "Nenhuma": a ordem da cena, sem ordenar.',
    tradeoff: 'Profundidade corta sobreposição de pixels (overdraw) e custa mais trocas de programa; "Nenhuma" poupa a ordenação na CPU e perde o early-z.',
    choices: [{ value: 'material', label: 'material' }, { value: 'depth', label: 'profundidade' }, { value: 'none', label: 'nenhuma' }],
  },
  {
    id: 'precision', system: 'materials', title: 'Precisão dos shaders',
    what: 'Material.precision de todos os materiais da cena (e dos que chegarem): highp como hoje, ou mediump. Os programas são refeitos fora do desenho (compileAsync).',
    tradeoff: 'Em GPUs de desktop (ANGLE/D3D11) mediump é tratado como highp: costuma não mudar nada. Em integradas/móveis pode ganhar e tremer posições grandes.',
    choices: [{ value: 'highp', label: 'highp' }, { value: 'mediump', label: 'mediump' }],
  },
  {
    id: 'frustumCull', system: 'culling', title: 'Recorte pela vista forçado',
    what: 'Liga frustumCulled nas malhas simples (não instanciadas, sem esqueleto) que o jogo deixou com ele desligado: o three deixa de desenhar as que estão fora da vista.',
    tradeoff: 'Menos chamadas de desenho; uma malha cujo shader a desloca (ou cuja esfera está velha) pode sumir na borda da tela.',
    choices: [{ value: 'as-is', label: 'como está' }, { value: 'plain', label: 'malhas simples' }],
  },
  // ---- shadows
  {
    id: 'shadowType', system: 'shadows', title: 'Tipo de sombra',
    what: 'renderer.shadowMap.type: PCF (5 amostras comparadas, filtro linear) como hoje, ou Basic (uma amostra, sem filtro). Os mapas das cascatas são refeitos para o tipo.',
    tradeoff: 'Basic lê o mapa uma vez por pixel em vez de cinco: sombras serrilhadas. Desliga junto a luz das ruas (ela lê os mapas como PCF).',
    choices: [{ value: 'pcf', label: 'PCF' }, { value: 'basic', label: 'Basic' }],
  },
  {
    id: 'shadowMapSize', system: 'shadows', title: 'Tamanho do mapa de sombra',
    what: 'O lado de cada um dos 3 mapas das cascatas do sol, por cima do nível.',
    tradeoff: 'Menor: menos memória e menos pixels de profundidade por passe; sombras mais grossas.',
    choices: [TIER, { value: 4096, label: '4096' }, { value: 2048, label: '2048' }, { value: 1024, label: '1024' }, { value: 512, label: '512' }],
  },
  {
    id: 'shadowEvery', system: 'shadows', title: 'Passe de sombra a cada N quadros',
    what: 'O passe das sombras (todas as cascatas) só é pedido a cada N quadros; o que mudou nos outros espera o próximo.',
    tradeoff: 'Menos passes de sombra com a cena mexendo; sombras de quem anda atrasadas até N quadros.',
    choices: [{ value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }, { value: 4, label: '4' }],
  },
  {
    id: 'farCascadeEvery', system: 'shadows', title: 'Cascatas distantes a cada N quadros',
    what: 'As cascatas 1 e 2 (as distantes) só são redesenhadas a cada N passes; a próxima (0) como sempre.',
    tradeoff: 'Corta a maioria dos redesenhos inteiros das distantes; sombras ao longe atrasam ao girar a câmera (faixas quebradas com a câmera em movimento).',
    choices: [{ value: 1, label: '1' }, { value: 2, label: '2' }, { value: 4, label: '4' }, { value: 8, label: '8' }],
  },
  {
    id: 'castMasses', system: 'shadows', title: 'Prédios na sombra pelas massas',
    what: 'Em que cascatas os prédios lançam sombra só pelas massas (BuildingLayer.castInto coarse). Hoje: nas distantes. "Todas": também na próxima. "Nenhuma": o detalhe em todas.',
    tradeoff: '"Todas" corta centenas de malhas do passe mais próximo; as sombras perdem varandas, toldos e recortes.',
    choices: [{ value: 'far', label: 'distantes' }, { value: 'all', label: 'todas' }, { value: 'none', label: 'nenhuma' }],
  },
  {
    id: 'castTexel', system: 'shadows', title: 'Peças na sombra: largura mínima',
    what: 'Uma peça dos prédios só lança sombra se for mais larga que N texels da cascata (hoje 1). "Nenhuma": nenhuma peça lança.',
    tradeoff: 'Menos malhas em cada passe; peças pequenas sem sombra.',
    choices: [{ value: 1, label: '1 texel' }, { value: 2, label: '2' }, { value: 4, label: '4' }, { value: 'none', label: 'nenhuma' }],
  },
  {
    id: 'agentShadows', system: 'shadows', title: 'Sombra de pessoas e veículos',
    what: 'Pessoas e veículos lançam sombra nas cascatas (como hoje) ou usam o disco suave no chão (o que o jogo faz sem sombras).',
    tradeoff: 'Disco: sem redesenhar as cascatas por quem se mexe; sombra genérica.',
    choices: [{ value: 'cast', label: 'nas cascatas' }, { value: 'disc', label: 'disco' }],
  },
  // ---- post
  {
    id: 'postChain', system: 'post', title: 'Cadeia de pós inteira',
    what: 'A cadeia de pós (oclusão, luz das ruas, nuvens, bloom, SMAA, nitidez) não é nem montada: a cena vai direto ao alvo multiamostrado e à tela, sem os alvos de meia-precisão.',
    tradeoff: 'Diferente de desligar cada passe: poupa também o alvo HalfFloat, as cópias e a memória dos alvos; perde todos os efeitos.',
    choices: [TIER, { value: 'off', label: 'desmontada' }],
  },
  {
    id: 'msaa', system: 'post', title: 'Amostras MSAA da cena',
    what: 'Amostras do alvo multiamostrado onde a cena é desenhada (QualitySettings.msaa).',
    tradeoff: 'Menos amostras: menos banda e memória na resolução da cena; serrilhado nas bordas (o SMAA ainda passa).',
    choices: [TIER, { value: 8, label: '8' }, { value: 4, label: '4' }, { value: 2, label: '2' }, { value: 0, label: '0' }],
  },
  {
    id: 'aoResolution', system: 'post', title: 'Resolução da oclusão (GTAO)',
    what: 'A oclusão ambiente na resolução da cena ou na metade (QualitySettings.aoFull).',
    tradeoff: 'Metade: um quarto dos pixels do GTAO e do denoise; bordas da oclusão borradas.',
    choices: [TIER, { value: 'full', label: 'inteira' }, { value: 'half', label: 'metade' }],
  },
  {
    id: 'cloudPass', system: 'post', title: 'Passe das nuvens montado',
    what: 'O passe das nuvens e da névoa não é nem criado (QualitySettings.cloudShadows e skyClouds), em vez de só pulado.',
    tradeoff: 'Sem o programa e sem os alvos das nuvens; sem nuvens, névoa pintada e sombras de nuvem.',
    choices: [TIER, { value: 'off', label: 'não montar' }],
  },
  // ---- textures
  {
    id: 'anisotropy', system: 'textures', title: 'Teto de filtragem anisotrópica',
    what: 'O máximo de amostras anisotrópicas de todas as texturas da cena (TEXTURE_MAX_ANISOTROPY_EXT direto na textura já enviada, sem reenviar).',
    tradeoff: 'Menos amostras por leitura de textura em ângulo rasante; chão e fachadas borrados ao longe.',
    choices: [TIER, { value: 16, label: '16' }, { value: 8, label: '8' }, { value: 4, label: '4' }, { value: 2, label: '2' }, { value: 1, label: '1' }],
  },
  // ---- level of detail
  {
    id: 'buildingLod', system: 'buildings', title: 'Erro de tela dos prédios',
    what: 'Multiplica o erro na tela que os níveis dos prédios aceitam (levelOfDetail e cullDetails com menos pixels por metro).',
    tradeoff: 'Níveis mais grossos antes: menos triângulos e malhas; trocas de nível mais perto da câmera.',
    // The game's own: two pixels of error at a distance, where a detail is under the eye's reach; ×1.5 changes almost no level.
    choices: [{ value: 2, label: '×2' }, { value: 1, label: '×1' }, { value: 1.5, label: '×1,5' }, { value: 4, label: '×4' }],
  },
  {
    id: 'roadLod', system: 'roads', title: 'Erro de tela das ruas',
    what: 'Multiplica o erro na tela das ruas distantes e dos produtos das telhas próximas (farRoads.choose, nearTiles.choose).',
    tradeoff: 'O nível próximo das ruas mais cedo cede ao distante: menos malhas; marcações somem mais perto.',
    choices: [{ value: 1, label: '×1' }, { value: 1.5, label: '×1,5' }, { value: 2, label: '×2' }, { value: 4, label: '×4' }],
  },
  {
    id: 'wear', system: 'roads', title: 'Desgaste das ruas',
    what: 'O desgaste que rodas e pés deixam nas ruas (wear.ts) é atualizado a cada quadro, ou fica parado.',
    tradeoff: 'Parado: poupa o trabalho de CPU por veículo e pedestre e os envios da textura; o desgaste não evolui.',
    choices: [{ value: 'on', label: 'atualiza' }, { value: 'off', label: 'parado' }],
  },
  {
    id: 'terrainLod', system: 'terrain', title: 'Erro de tela do terreno',
    what: 'Multiplica o erro em pixels que os níveis do terreno aceitam (terrainLod.ts, 1 px hoje).',
    tradeoff: 'Menos remendos e vértices do chão; o relevo ao longe ondula ao mudar de nível.',
    choices: [{ value: 1, label: '×1' }, { value: 2, label: '×2' }, { value: 4, label: '×4' }, { value: 8, label: '×8' }],
  },
  {
    id: 'reliefEvery', system: 'terrain', title: 'Relevo e matas ao longe a cada N quadros',
    what: 'terrain.bakeRelief (a fusão das matas distantes, os traços de pintura) só a cada N quadros.',
    tradeoff: 'Menos trabalho por quadro; pintura e transições das matas aparecem com atraso.',
    choices: [{ value: 1, label: '1' }, { value: 2, label: '2' }, { value: 4, label: '4' }, { value: 8, label: '8' }],
  },
  {
    id: 'waterMaterial', system: 'water', title: 'Material da água',
    what: 'Rios e lagos desenhados com o próprio material (Standard estendido, ondas, espuma) ou com um Lambert liso só durante o desenho.',
    tradeoff: 'Mede quanto custa o sombreamento da água; a água fica chapada.',
    choices: [{ value: 'normal', label: 'próprio' }, { value: 'plain', label: 'Lambert' }],
  },
  {
    id: 'vegetation', system: 'vegetation', title: 'Densidade da vegetação',
    what: 'Fração da vegetação do nível (QualitySettings.vegetation): matas, árvores da natureza.',
    tradeoff: 'Menos instâncias de plantas; paisagem rala.',
    choices: [TIER, { value: 0.5, label: '50%' }, { value: 0.25, label: '25%' }, { value: 0, label: 'nenhuma' }],
  },
  {
    id: 'detailProps', system: 'vegetation', title: 'Mobiliário urbano',
    what: 'Bancos, postes de detalhe e adereços das calçadas (QualitySettings.detailProps).',
    tradeoff: 'Menos malhas pequenas; ruas vazias.',
    choices: [TIER, { value: 'off', label: 'sem' }],
  },
  {
    id: 'detailCutoff', system: 'people', title: 'Zoom mínimo do detalhe',
    what: 'Multiplica o zoom abaixo do qual marcações, mobiliário, pessoas e veículos detalhados deixam de ser desenhados (detailCutoffZoom).',
    tradeoff: 'Vistas de bairro sem o detalhe miúdo; ele surge mais perto.',
    choices: [{ value: 1, label: '×1' }, { value: 1.5, label: '×1,5' }, { value: 2, label: '×2' }, { value: 3, label: '×3' }],
  },
  {
    id: 'pedestrianDetail', system: 'people', title: 'Detalhe das pessoas',
    what: 'O teto de detalhe da multidão: 2 rosto animado, 1 roupas, 0 silhueta (QualitySettings.pedestrianDetail).',
    tradeoff: 'Menos variantes e animações; pessoas genéricas.',
    choices: [TIER, { value: 2, label: '2' }, { value: 1, label: '1' }, { value: 0, label: '0' }],
  },
  {
    id: 'hairStrands', system: 'people', title: 'Pessoas com fios de cabelo',
    what: 'Quantas das pessoas mais próximas ganham os fios do cabelo (QualitySettings.hairStrandPeople).',
    tradeoff: 'Menos malhas de cabelo; cabelo em bloco.',
    choices: [TIER, { value: 4, label: '4' }, { value: 2, label: '2' }, { value: 0, label: '0' }],
  },
  {
    id: 'vehicleError', system: 'vehicles', title: 'Erro de tela dos veículos',
    what: 'Pixels de erro que o nível de cada peça dos veículos aceita (QualitySettings.vehicleErrorPixels, 0,5 px hoje).',
    tradeoff: 'Peças mais grossas antes: menos triângulos; carros simplificados mais perto.',
    choices: [TIER, { value: 1, label: '1 px' }, { value: 2, label: '2 px' }, { value: 4, label: '4 px' }],
  },
  {
    id: 'vehicleWhole', system: 'vehicles', title: 'Veículos inteiros (no máximo)',
    what: 'Quantos veículos são desenhados inteiros (carroceria, cabine e rodas à parte), os maiores na tela (QualitySettings.vehicleWholeCap).',
    tradeoff: 'Menos malhas por veículo; os demais em peça única.',
    choices: [TIER, { value: 100, label: '100' }, { value: 50, label: '50' }, { value: 20, label: '20' }, { value: 0, label: '0' }],
  },
  {
    id: 'occupants', system: 'vehicles', title: 'Ocupantes dos veículos',
    what: 'O zoom a partir do qual as pessoas dentro dos veículos são desenhadas (QualitySettings.occupantZoom).',
    tradeoff: 'Menos pessoas desenhadas; carros vazios de longe ou sempre.',
    choices: [TIER, { value: 'x2', label: 'zoom ×2' }, { value: 'never', label: 'nunca' }],
  },
  {
    id: 'exhaust', system: 'particles', title: 'Fumaça dos escapamentos',
    what: 'As partículas dos escapamentos e da poeira são emitidas e animadas, ou nada é emitido (a camada "Partículas" só as esconde).',
    tradeoff: 'Sem a emissão e a animação na CPU e o envio do buffer; sem fumaça.',
    choices: [{ value: 'on', label: 'emite' }, { value: 'off', label: 'não emite' }],
  },
  // ---- the simulation
  {
    id: 'population', system: 'simulation', title: 'Teto da população',
    what: 'Fração da população que o governador da simulação pode chegar a pôr na rua (maxShare do worker).',
    tradeoff: 'Menos agentes no worker e na tela; cidade mais vazia.',
    choices: [{ value: 1, label: '100%' }, { value: 0.75, label: '75%' }, { value: 0.5, label: '50%' }, { value: 0.25, label: '25%' }],
  },
  {
    id: 'focusDetail', system: 'simulation', title: 'Simulação detalhada na vista',
    what: 'As pessoas desviam umas das outras onde são vistas de perto (SimFocus.detail), ou nunca.',
    tradeoff: 'Desligado: poupa a interação entre pedestres no worker; atravessam-se de perto.',
    choices: [{ value: 'on', label: 'ligada' }, { value: 'off', label: 'desligada' }],
  },
  // ---- uploads and pacing
  {
    id: 'uploadEvery', system: 'uploads', title: 'Envio de malhas a cada N quadros',
    what: 'As malhas que esperam ir à GPU (drainWarm, 4 MiB por vez) só são enviadas a cada N quadros.',
    tradeoff: 'Menos quadros com bufferData; o que carrega aparece mais devagar.',
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
  roadLod: ['layer:roads', 'layer:farRoads', 'name:roads-*', 'name:far-roads'],
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
