import type { CartoonStyle } from '@render/people/cartoon';
import { CLOTH_COLOURS } from '@people/spec';
import { PIXAR, REALISTIC } from '@render/people/cartoon';
import type { PoseName } from './pose';
import type { LibraryClipName } from '@render/citizenWalk';

/** THE LAB'S LISTS OF CHOICES: colours, styles, names shown, face sliders, actions */
export const SKIN = [0xf6dccb, 0xf0cdb2, 0xe5b898, 0xd9a47f, 0xc68b62, 0xb07349, 0x8f5b3a, 0x6f452b, 0x553220, 0x3d2417];
export const HAIR_COLOURS = [0x1a1410, 0x2e2018, 0x4a3022, 0x6b4428, 0x8c5a2e, 0xa8743c, 0xc9a165, 0xe0c58f, 0x9a9a98, 0xdedcd8, 0x8a2f1f,
  0xc23b22, 0xe86aa6, 0x6a5acd, 0x2fa3c7, 0x3cb371];
export const CLOTH = [...CLOTH_COLOURS, 0xe05a8a, 0x2f9d8f, 0x3b6fd1, 0xffd166, 0x9b5de5, 0x00bbf9];

/** The lab's own style, the one approved by eye (2026-10-21): real legs and eyes, the head a touch large (about 6.3 heads tall), hands and feet true to size (enlarged, the feet read clownish).
 *  The body fit (`bodyFit.ts`) tunes the head per person to reach the height in heads. */
export const ROADCRAFT: CartoonStyle = { head: 1.12, eyes: 1, legs: 1, hands: 1, feet: 0.95 };

export const STYLE_PRESETS: readonly (readonly [string, CartoonStyle])[] = [
  ['Roadcraft', ROADCRAFT],
  ['Realista', REALISTIC],
  ['Desenho', { head: 1.2, eyes: 1.22, legs: 0.93, hands: 1.08, feet: 1.06 }],
  ['Pixar', PIXAR],
  ['Exagerado', { head: 1.65, eyes: 1.7, legs: 0.78, hands: 1.22, feet: 1.18 }],
];

export const HAIR_NAMES: Record<string, string> = {
  longStraight: 'Longo liso', longWavy: 'Longo ondulado', midLayered: 'Médio repicado', bob: 'Chanel', bobFringe: 'Chanel com franja',
  ponytail: 'Rabo de cavalo', bun: 'Coque', ponytailFringe: 'Rabo com franja', longFringe: 'Longo com franja', longHeadband: 'Longo com tiara',
  shoulderBob: 'Chanel longo', fade: 'Degradê', buzz: 'Raspado', slickedBack: 'Para trás', quiff: 'Topete', manBun: 'Coque masculino',
  longMale: 'Longo masculino', curlyShort: 'Cacheado curto', afro: 'Black power', shortCrop: 'Curto', pigtails: 'Maria-chiquinha',
  braid: 'Trança', twinBraids: 'Duas tranças', curly: 'Cacheado', sideSwept: 'Jogado de lado', pixie: 'Joãozinho', topKnot: 'Coque alto',
  shortSide: 'Curto de lado',
};

export const FACE: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  ['Cabeça', [['head-fat-decr-incr', 'Bochechuda'], ['head-scale-horiz-decr-incr', 'Largura'], ['head-scale-vert-decr-incr', 'Altura'],
    ['forehead-scale-vert-decr-incr', 'Testa']]],
  ['Olhos', [['eye-scale-decr-incr', 'Tamanho'], ['eye-trans-in-out', 'Distância'], ['eye-corner1-down-up', 'Canto'],
    ['eye-height2-decr-incr', 'Abertura'], ['eyebrows-angle-down-up', 'Sobrancelha'], ['eyebrows-trans-down-up', 'Altura sobr.']]],
  ['Nariz', [['nose-scale-horiz-decr-incr', 'Largura'], ['nose-scale-vert-decr-incr', 'Comprimento'], ['nose-point-width-decr-incr', 'Ponta'],
    ['nose-point-down-up', 'Arrebitado'], ['nose-hump-decr-incr', 'Calombo'], ['nose-volume-decr-incr', 'Volume']]],
  ['Boca', [['mouth-scale-horiz-decr-incr', 'Largura'], ['mouth-upperlip-volume-decr-incr', 'Lábio sup.'], ['mouth-lowerlip-volume-decr-incr', 'Lábio inf.'],
    ['mouth-cupidsbow-decr-incr', 'Arco'], ['mouth-angles-down-up', 'Cantos'], ['mouth-laugh-lines-in-out', 'Covinhas']]],
  ['Queixo', [['chin-width-decr-incr', 'Largura'], ['chin-prominent-decr-incr', 'Projeção'], ['chin-height-decr-incr', 'Altura'],
    ['chin-cleft-decr-incr', 'Furinho'], ['cheek-bones-decr-incr', 'Maçãs'], ['cheek-volume-decr-incr', 'Bochechas']]],
  ['Orelhas', [['ear-scale-decr-incr', 'Tamanho'], ['ear-lobe-decr-incr', 'Lóbulo'], ['ear-flap-decr-incr', 'Abano']]],
];
export const HEAD_SHAPES: readonly (readonly [string, string])[] = [['head-oval', 'Oval'], ['head-round', 'Redonda'], ['head-square', 'Quadrada'],
  ['head-rectangular', 'Retangular'], ['head-diamond', 'Diamante'], ['head-triangular', 'Triangular'], ['head-invertedtriangular', 'Coração']];

/** Ready poses: a name, and a captured clip held at a moment (`ClipPlayer.hold`). */
export const READY_POSES: readonly (readonly [string, LibraryClipName, number])[] = [
  ['Em pé', 'idle', 0.5], ['Tchau', 'wave', 0.9], ['Vitória', 'cheer', 1.0], ['Dança', 'dance', 1.2],
  ['Celular', 'phone', 1.5], ['Foto', 'photo', 1.4], ['Leitura', 'read', 1.5], ['Brinde', 'drink', 1.1],
  ['Gargalhada', 'laugh', 0.8], ['Bronca', 'angry', 1.0], ['Discussão', 'argue', 1.2], ['Pensando', 'look', 1.6],
  ['Sentada', 'sitIdle', 0.5], ['Agachada', 'crouchIdle', 0.5], ['Corrida', 'run', 0.3], ['Passo', 'walkStroll', 0.4],
];

/** The actions: a name, what the face does (`faceAt`), and the captured clip the body plays (`citizenWalk.ts` library). */
export const MOODS: readonly (readonly [string, string | undefined, PoseName, LibraryClipName])[] = [
  ['Parado', undefined, 'idle', 'idle'], ['Conversando', 'talk', 'idle', 'talk'], ['Ouvindo', 'listen', 'idle', 'listen'],
  ['Rindo', 'laugh', 'idle', 'laugh'], ['Acenando', 'wave', 'wave', 'wave'], ['Comemorando', 'cheer', 'cheer', 'cheer'],
  ['Dançando', 'dance', 'hips', 'dance'], ['Ao telefone', 'phone', 'idle', 'phone'], ['Fotografando', undefined, 'idle', 'photo'],
  ['Lendo', undefined, 'idle', 'read'], ['Bebendo', undefined, 'idle', 'drink'], ['Música', 'listen', 'idle', 'headphones'],
  ['Olhando', undefined, 'idle', 'look'], ['Nervoso', 'look', 'idle', 'nervous'], ['Bravo', 'angry', 'hips', 'angry'],
  ['Discutindo', 'argue', 'idle', 'argue'], ['Passeando', undefined, 'idle', 'walkStroll'], ['Andar estiloso', undefined, 'idle', 'walkCool'],
  ['Correndo', undefined, 'idle', 'run'], ['Sentado', 'talk', 'idle', 'sitIdle'], ['Agachado', undefined, 'idle', 'crouchIdle'],
  ['Chorando', 'cry', 'idle', 'idle'], ['Assustado', 'panic', 'idle', 'nervous'],
];

/** Solid hairstyles that read well up close (the MakeHuman system cards, `people` studio's choices), by sex: what a new person wears. */
export const NICE_HAIR = { female: ['long01', 'bob02', 'ponytail01', 'braid01', 'bob01'], male: ['short02', 'short01', 'short04', 'short03'] } as const;

/** The hairstyles that read well, picked by eye from a picture of each on the lab's person (2026-10-21): solid, clean, no stray strands. */
export const HAIR_CATALOGUE = {
  female: ['long01', 'bob02', 'bob01', 'ponytail01', 'braid01', 'culturalibre_hair_01', 'culturalibre_hair_18', 'culturalibre_hair_17', 'cortu_straight_bangs',
    'elvs_50s_updo', 'elvs_daisy_hair', 'elvs_hazel_hair', 'elvs_katherine_hair', 'elvs_short_daisy_hair', 'elvs_that_80s_babe_hair', 'elvs_wavy_bob',
    'elvs_witchy_lil_bob', 'elvs_ashley_may_hair', 'elvs_island_princess_hair', 'elvs_french_braid_variation', 'faydaen_hair_1', 'littleright_bobcut_hair',
    'toigo_blunt_bob', 'toigo_blunt_bob_with_bangs', 'toigo_curled_under_bob', 'toigo_curled_under_bob_with_bangs', 'toigo_inverted_bob',
    'toigo_inverted_bob_with_bangs', 'rehmanpolanski_hair_bun_brown', 'elvs_micky_afro'],
  male: ['short02', 'short01', 'short03', 'short04', 'culturalibre_hair_02', 'culturalibre_hair_05', 'culturalibre_hair_14', 'elvs_maxwell_hair',
    'elvs_short_side_do', 'elvs_grump_hair', 'elvs_keylth_hair', 'afro01', 'elvs_braided_rows'],
} as const;

/** Shoes for each sex, the street's own (no boots for heroes, no costume). */
export const SHOES_CATALOGUE = {
  female: ['elvs_flatshoe_pointy1', 'elvs_flatshoe_gemmed1', 'elvs_flatshoe_bow1', 'elvs_flatshoe_plain1', 'toigo_ballet_flats', 'toigo_ballet_flats_with_bows',
    'toigo_flats', 'dressupdoc_maryjane1', 'dressupdoc_sandals1', 'mindfront_shoes_oxford_female', 'mindfront_shoes_monk_strap_female', 'punkduck_comfortable_sneakers',
    'toigo_ankle_boots_female', 'punkduck_female_half-boots', 'shoes01', 'shoes03'],
  male: ['shoes02', 'shoes01', 'shoes04', 'shoes05', 'shoes06', 'mindfront_shoes_oxford_male', 'mindfront_shoes_monk_strap_male', 'callharvey3d_harvey_saddleshoes1',
    'culturalibre_sneakers', 'punkduck_running_shoes_01', 'punkduck_tennis_shoes', 'toigo_ankle_boots_male', 'mindfront_shoes_biker_boots_male', 'elvs_male_flip_flop_sandals1'],
} as const;

/** What the hairstyles are called in the creator. */
export const HAIR_LABELS: Readonly<Record<string, string>> = {
  long01: 'Longo liso', bob02: 'Chanel', bob01: 'Chanel de lado', ponytail01: 'Rabo de cavalo', braid01: 'Trança', culturalibre_hair_01: 'Longo solto',
  culturalibre_hair_18: 'Chanel com franja', culturalibre_hair_17: 'Ondulado', cortu_straight_bangs: 'Franja reta', elvs_50s_updo: 'Coque anos 50',
  elvs_daisy_hair: 'Ondas longas', elvs_hazel_hair: 'Longo repicado', elvs_katherine_hair: 'Chanel franja', elvs_short_daisy_hair: 'Médio ondulado',
  elvs_that_80s_babe_hair: 'Anos 80', elvs_wavy_bob: 'Chanel retrô', elvs_witchy_lil_bob: 'Chanel curto', elvs_ashley_may_hair: 'Cachos soltos',
  elvs_island_princess_hair: 'Praiano', elvs_french_braid_variation: 'Trança embutida', faydaen_hair_1: 'Médio liso', littleright_bobcut_hair: 'Joãozinho',
  toigo_blunt_bob: 'Chanel reto', toigo_blunt_bob_with_bangs: 'Chanel reto franja', toigo_curled_under_bob: 'Chanel virado', toigo_curled_under_bob_with_bangs: 'Virado com franja',
  toigo_inverted_bob: 'Chanel invertido', toigo_inverted_bob_with_bangs: 'Invertido franja', rehmanpolanski_hair_bun_brown: 'Coque', elvs_micky_afro: 'Puffs',
  short02: 'Curto clássico', short01: 'Curto', short03: 'Curto penteado', short04: 'Raspado', culturalibre_hair_02: 'Topete', culturalibre_hair_05: 'Curto bagunçado',
  culturalibre_hair_14: 'Ondulado curto', elvs_maxwell_hair: 'Social', elvs_short_side_do: 'De lado', elvs_grump_hair: 'Despenteado', elvs_keylth_hair: 'Médio',
  afro01: 'Black', elvs_braided_rows: 'Tranças nagô',
};
