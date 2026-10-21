import { QUALITY, QUALITY_LEVELS, type QualitySettings } from './quality';
import type { OptChoice, OptSystem, OptValue } from './optimizationTypes';

/** EVERY FIELD OF THE TIER'S SETTINGS (`QualitySettings`, `quality.ts`) set by hand from the lab (`optimizations.ts`, ids `q.<field>`): "do nível" (the tier's own, the default) or a value of its own, over the tier and over the other optimisations. A field nothing reads today says so: setting it changes nothing. */

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
  pixelRatio: { system: 'renderer', kind: 'number', title: 'Teto da razão de pixels', what: 'O máximo da razão de pixels do dispositivo desenhada (renderer.setPixelRatio). A "Resolução" dos interruptores e a resolução dinâmica a redefinem quando mudam.', affects: ['all'] },
  shadows: { system: 'shadows', kind: 'bool', title: 'Sombras do sol', what: 'As cascatas do sol ligadas (renderer.shadowMap.enabled e os mapas).', affects: ['shadows'] },
  shadowMapSize: { system: 'shadows', kind: 'choice', values: [512, 1024, 2048, 4096], title: 'Lado do mapa de sombra', what: 'O lado de cada mapa das cascatas.', affects: ['shadows'] },
  postProcessing: { system: 'post', kind: 'bool', title: 'Cadeia de pós', what: 'A cadeia de pós montada (sem ela, a cena vai direto ao alvo multiamostrado).', affects: ['post'] },
  ambientOcclusion: { system: 'post', kind: 'bool', title: 'Oclusão ambiente (GTAO) e luz das ruas', what: 'O GTAO e a luz das ruas montados na cadeia.', affects: ['post', 'pass:ambientOcclusion', 'pass:canyonLight'] },
  smaa: { system: 'post', kind: 'bool', title: 'SMAA', what: 'O passe SMAA montado.', affects: ['post', 'pass:smaa'] },
  msaa: { system: 'post', kind: 'choice', values: [0, 2, 4, 8], title: 'Amostras MSAA', what: 'Amostras do alvo da cena.', affects: ['post', 'all'] },
  aoFull: { system: 'post', kind: 'bool', title: 'GTAO na resolução inteira', what: 'A oclusão na resolução da cena (ligado) ou na metade.', affects: ['post', 'pass:ambientOcclusion'] },
  sharpen: { system: 'post', kind: 'number', title: 'Nitidez (CAS)', what: 'A força do AMD CAS na imagem final, 0 a 1.', affects: ['post', 'pass:sharpen'] },
  anisotropy: { system: 'textures', kind: 'choice', values: [1, 2, 4, 8, 16], title: 'Anisotropia (exata)', what: 'Todas as texturas da cena com exatamente esta anisotropia, aplicada direto na textura enviada (o campo do nível só é lido quando o renderizador nasce).', affects: ['textures', 'all'] },
  detailProps: { system: 'vegetation', kind: 'bool', title: 'Mobiliário urbano', what: 'Bancos, adereços e detalhes das calçadas desenhados.', affects: ['layer:furniture'] },
  vegetation: { system: 'vegetation', kind: 'number', title: 'Vegetação (quantidade)', what: 'A quantidade de vegetação: matas distantes e árvores da natureza.', affects: ['layer:vegetation', 'name:far-forest*'] },
  grassBlades: { system: 'vegetation', kind: 'number', unread: true, title: 'Folhas de grama', what: 'Folhas no campo de grama da GPU.', affects: ['layer:vegetation'] },
  surfaceDetail: { system: 'textures', kind: 'bool', title: 'Camada de detalhe das superfícies', what: 'A textura de detalhe de perto no asfalto e nas calçadas (materials.setDetail).', affects: ['layer:roads', 'textures'] },
  detailCutoffZoom: { system: 'people', kind: 'number', title: 'Zoom mínimo do detalhe', what: 'O zoom abaixo do qual marcações, mobiliário e agentes deixam de ser desenhados.', affects: ['layer:people', 'layer:furniture', 'layer:roads', 'layer:signals'] },
  pedestrianDetail: { system: 'people', kind: 'choice', values: [0, 1, 2], title: 'Detalhe das pessoas', what: '0 silhueta, 1 roupas, 2 rosto animado.', affects: ['layer:people', 'name:procedural-people', 'name:person'] },
  occupantZoom: { system: 'vehicles', kind: 'number', title: 'Zoom dos ocupantes', what: 'O zoom a partir do qual as pessoas dentro dos veículos são desenhadas.', affects: ['layer:people', 'name:person'] },
  vehicleErrorPixels: { system: 'vehicles', kind: 'number', title: 'Erro de tela das peças dos veículos', what: 'Pixels de erro que o nível de cada peça aceita.', affects: ['layer:people'] },
  vehicleWholeCap: { system: 'vehicles', kind: 'number', title: 'Veículos inteiros', what: 'Quantos veículos são desenhados inteiros, no máximo.', affects: ['layer:people'] },
  hairStrandPeople: { system: 'people', kind: 'number', title: 'Pessoas com fios de cabelo', what: 'Quantas das mais próximas ganham os fios.', affects: ['layer:people', 'name:procedural-people'] },
  cloudShadows: { system: 'post', kind: 'bool', title: 'Sombras das nuvens', what: 'Monta o passe das nuvens (junto com "Nuvens do céu").', affects: ['post', 'pass:clouds'] },
  vegetationDistance: { system: 'vegetation', kind: 'number', unread: true, title: 'Alcance da vegetação', what: 'Distância da vegetação do ecossistema.', affects: ['layer:vegetation'] },
  impostors: { system: 'vegetation', kind: 'bool', unread: true, title: 'Impostores das plantas', what: 'Plantas distantes como impostores.', affects: ['layer:vegetation'] },
  birds: { system: 'particles', kind: 'number', unread: true, title: 'Pássaros', what: 'Pássaros no ar ao mesmo tempo.', affects: ['layer:particles'] },
  rain: { system: 'particles', kind: 'bool', unread: true, title: 'Gotas de chuva', what: 'As gotas no ar.', affects: ['layer:weather', 'name:rain'] },
  skyClouds: { system: 'post', kind: 'bool', title: 'Nuvens do céu', what: 'Monta o passe das nuvens (junto com "Sombras das nuvens").', affects: ['post', 'pass:clouds'] },
  mist: { system: 'post', kind: 'bool', unread: true, title: 'Névoa matinal', what: 'Névoa nos vales e sobre a água.', affects: ['post'] },
  triangleScale: { system: 'buildings', kind: 'number', title: 'Parcela do orçamento de triângulos', what: 'A parcela do orçamento de triângulos da vista que os níveis dos prédios podem somar (acima dela a escala de erro sobe).', affects: ['layer:buildings'] },
  detailMemoryMB: { system: 'buildings', kind: 'number', title: 'Memória do detalhe dos prédios (MB)', what: 'O máximo que o detalhe das células dos prédios guarda na GPU.', affects: ['layer:buildings'] },
  waterfalls: { system: 'water', kind: 'bool', unread: true, title: 'Spray das cachoeiras', what: 'Spray e névoa ao pé das cachoeiras.', affects: ['layer:water'] },
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
  const tier: OptChoice = { value: 'tier', label: 'do nível' };
  const choices: OptChoice[] = f.kind === 'bool' ? [tier, { value: 'on', label: 'ligado' }, { value: 'off', label: 'desligado' }]
    : f.kind === 'choice' ? [tier, ...f.values!.map((v) => ({ value: v, label: String(v) }))] : [tier];
  return {
    id: `q.${field}` as QualityOptId,
    field,
    system: f.system,
    title: `Nível: ${f.title}`,
    what: `${f.what} (QualitySettings.${field})`,
    tradeoff: f.unread ? 'Campo definido mas que nenhum código lê hoje: mudar não tem efeito.' : 'O valor do nível trocado por este, por cima das outras otimizações.',
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
