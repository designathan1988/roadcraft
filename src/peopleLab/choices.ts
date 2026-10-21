import type { CartoonStyle } from '@render/people/cartoon';
import { CLOTH_COLOURS } from '@people/spec';
import { PIXAR, REALISTIC } from '@render/people/cartoon';
import type { PoseName } from './pose';

/** THE LAB'S LISTS OF CHOICES: colours, styles, names shown, face sliders, actions */
export const SKIN = [0xf6dccb, 0xf0cdb2, 0xe5b898, 0xd9a47f, 0xc68b62, 0xb07349, 0x8f5b3a, 0x6f452b, 0x553220, 0x3d2417];
export const HAIR_COLOURS = [0x1a1410, 0x2e2018, 0x4a3022, 0x6b4428, 0x8c5a2e, 0xa8743c, 0xc9a165, 0xe0c58f, 0x9a9a98, 0xdedcd8, 0x8a2f1f,
  0xc23b22, 0xe86aa6, 0x6a5acd, 0x2fa3c7, 0x3cb371];
export const CLOTH = [...CLOTH_COLOURS, 0xe05a8a, 0x2f9d8f, 0x3b6fd1, 0xffd166, 0x9b5de5, 0x00bbf9];

export const STYLE_PRESETS: readonly (readonly [string, CartoonStyle])[] = [
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

export const FACE: readonly (readonly [string, string, readonly (readonly [string, string])[]])[] = [
  ['Cabeça', '🙂', [['head-fat-decr-incr', 'Bochechuda'], ['head-scale-horiz-decr-incr', 'Largura'], ['head-scale-vert-decr-incr', 'Altura'],
    ['forehead-scale-vert-decr-incr', 'Testa']]],
  ['Olhos', '👁️', [['eye-scale-decr-incr', 'Tamanho'], ['eye-trans-in-out', 'Distância'], ['eye-corner1-down-up', 'Canto'],
    ['eye-height2-decr-incr', 'Abertura'], ['eyebrows-angle-down-up', 'Sobrancelha'], ['eyebrows-trans-down-up', 'Altura sobr.']]],
  ['Nariz', '👃', [['nose-scale-horiz-decr-incr', 'Largura'], ['nose-scale-vert-decr-incr', 'Comprimento'], ['nose-point-width-decr-incr', 'Ponta'],
    ['nose-point-down-up', 'Arrebitado'], ['nose-hump-decr-incr', 'Calombo'], ['nose-volume-decr-incr', 'Volume']]],
  ['Boca', '👄', [['mouth-scale-horiz-decr-incr', 'Largura'], ['mouth-upperlip-volume-decr-incr', 'Lábio sup.'], ['mouth-lowerlip-volume-decr-incr', 'Lábio inf.'],
    ['mouth-cupidsbow-decr-incr', 'Arco'], ['mouth-angles-down-up', 'Cantos'], ['mouth-laugh-lines-in-out', 'Covinhas']]],
  ['Queixo', '🧔', [['chin-width-decr-incr', 'Largura'], ['chin-prominent-decr-incr', 'Projeção'], ['chin-height-decr-incr', 'Altura'],
    ['chin-cleft-decr-incr', 'Furinho'], ['cheek-bones-decr-incr', 'Maçãs'], ['cheek-volume-decr-incr', 'Bochechas']]],
  ['Orelhas', '👂', [['ear-scale-decr-incr', 'Tamanho'], ['ear-lobe-decr-incr', 'Lóbulo'], ['ear-flap-decr-incr', 'Abano']]],
];
export const HEAD_SHAPES: readonly (readonly [string, string])[] = [['head-oval', 'Oval'], ['head-round', 'Redonda'], ['head-square', 'Quadrada'],
  ['head-rectangular', 'Retangular'], ['head-diamond', 'Diamante'], ['head-triangular', 'Triangular'], ['head-invertedtriangular', 'Coração']];

export const MOODS: readonly (readonly [string, string, string | undefined, PoseName])[] = [
  ['😐', 'Parado', undefined, 'idle'], ['💬', 'Conversando', 'talk', 'idle'], ['😂', 'Gargalhada', 'laugh', 'idle'],
  ['👋', 'Acenando', 'wave', 'wave'], ['🙌', 'Comemorando', 'cheer', 'cheer'], ['💃', 'Animado', 'dance', 'hips'],
  ['😠', 'Bravo', 'angry', 'hips'], ['🗯️', 'Discutindo', 'argue', 'idle'], ['😢', 'Chorando', 'cry', 'idle'], ['😱', 'Assustado', 'panic', 'idle'],
];

/** Solid hairstyles that read well up close (the MakeHuman system cards, `people` studio's choices), by sex: what a new person wears. */
export const NICE_HAIR = { female: ['long01', 'bob02', 'ponytail01', 'braid01', 'bob01'], male: ['short02', 'short01', 'short04', 'short03'] } as const;
