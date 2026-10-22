import { BufferAttribute } from 'three';
import { expressionShapes } from '@people/body/expressions';
import { CHANNELS } from '@render/people/faceExpression';
import type { BuiltPerson } from './build';

/** THE WHOLE FACE: Apple ARKit's 52 blendshapes (the FACS action units of face tracking) on the person built, each a slider, mirrored left and
 *  right unless asked otherwise, in groups by region, and expressions made of them (Ekman's EMFACS emotions as ARKit weights). The game's people
 *  carry 13 mixed channels (`faceExpression.ts`); the lab adds the 52 when the face editor opens, once a build. */

/** The face's regions, each an icon and the shapes in it; a pair is its Left name with `Left` taken off. */
export const FACE_GROUPS: readonly (readonly [string, string, string, readonly string[]])[] = [
  ['brows', 'brow', 'Sobrancelhas', ['browInnerUp', 'browDown*', 'browOuterUp*']],
  ['eyes', 'eye', 'Olhos', ['eyeBlink*', 'eyeWide*', 'eyeSquint*', 'eyeLookUp*', 'eyeLookDown*', 'eyeLookIn*', 'eyeLookOut*']],
  ['cheeks', 'cheek', 'Bochechas e nariz', ['cheekPuff', 'cheekSquint*', 'noseSneer*']],
  ['jaw', 'jaw', 'Mandíbula', ['jawOpen', 'jawForward', 'jawLeft', 'jawRight', 'mouthClose', 'tongueOut']],
  ['smile', 'mouth', 'Boca', ['mouthSmile*', 'mouthFrown*', 'mouthDimple*', 'mouthStretch*', 'mouthPress*', 'mouthLeft', 'mouthRight']],
  ['lips', 'lips', 'Lábios', ['mouthPucker', 'mouthFunnel', 'mouthRollUpper', 'mouthRollLower', 'mouthShrugUpper', 'mouthShrugLower', 'mouthUpperUp*', 'mouthLowerDown*']],
];

/** Each shape's name in the panel (a pair once). */
export const FACE_LABELS: Readonly<Record<string, string>> = {
  browInnerUp: 'Centro sobe', browDown: 'Franzir', browOuterUp: 'Ponta sobe',
  eyeBlink: 'Fechar', eyeWide: 'Arregalar', eyeSquint: 'Apertar', eyeLookUp: 'Olhar cima', eyeLookDown: 'Olhar baixo', eyeLookIn: 'Olhar dentro', eyeLookOut: 'Olhar fora',
  cheekPuff: 'Inflar', cheekSquint: 'Maçãs sobem', noseSneer: 'Torcer nariz',
  jawOpen: 'Abrir', jawForward: 'Projetar', jawLeft: 'Esquerda', jawRight: 'Direita', mouthClose: 'Fechar lábios', tongueOut: 'Língua',
  mouthSmile: 'Sorriso', mouthFrown: 'Tristeza', mouthDimple: 'Covinha', mouthStretch: 'Esticar', mouthPress: 'Pressionar', mouthLeft: 'Boca esq.', mouthRight: 'Boca dir.',
  mouthPucker: 'Bico', mouthFunnel: 'Funil', mouthRollUpper: 'Enrolar cima', mouthRollLower: 'Enrolar baixo', mouthShrugUpper: 'Lábio cima', mouthShrugLower: 'Lábio baixo',
  mouthUpperUp: 'Mostrar dentes', mouthLowerDown: 'Baixar lábio',
};

/** The shape names behind one slider: a pair (`name*`) is its Left and Right, together when mirrored. */
export function shapesOf(entry: string, mirrored: boolean): readonly (readonly [string, readonly string[]])[] {
  if (!entry.endsWith('*')) return [[entry, [entry]]];
  const base = entry.slice(0, -1);
  return mirrored ? [[base, [`${base}Left`, `${base}Right`]]] : [[`${base}Left`, [`${base}Left`]], [`${base}Right`, [`${base}Right`]]];
}

/** The 52 shapes as morphs of the built person (through `BuiltPerson.morph`, the body and what is worn on the face), its own 13 channels
 *  replaced; the gaze kept. A few frames at a time, so the page keeps drawing. False when it cannot (the tailored shells). */
export async function attachFace(built: BuiltPerson, current: () => boolean): Promise<boolean> {
  const mesh = built.meshes[0];
  if (!mesh || !built.morph) return false;
  if (mesh.morphTargetDictionary?.['eyeBlinkLeft'] !== undefined) return true;
  const shapes = await expressionShapes();
  const kept = (mesh.geometry.morphAttributes.position ?? []).filter((a) => a.name === 'lookLeft' || a.name === 'lookRight');
  const added: BufferAttribute[] = [];
  const base = built.shape;
  let last = performance.now();
  for (const [name, delta] of Object.entries(shapes)) {
    const positions = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) positions[i] = base[i]! + delta[i]!;
    const attribute = new BufferAttribute(built.morph(positions), 3);
    attribute.name = name;
    added.push(attribute);
    if (performance.now() - last > 12) {
      await new Promise((r) => requestAnimationFrame(r));
      if (!current()) return false;
      last = performance.now();
    }
  }
  mesh.geometry.morphAttributes.position = [...kept, ...added];
  mesh.geometry.morphTargetsRelative = true;
  mesh.updateMorphTargets();
  return true;
}

/** A face written into a mesh's influences: the 52 shapes by name, the game's channels (from the street's life of the face) mixed into them. */
export function applyLabFace(influences: number[], dictionary: Record<string, number>, face: Readonly<Record<string, number>>, strength = 1): void {
  influences.fill(0);
  for (const name in face) {
    const amount = face[name]!;
    const direct = dictionary[name];
    if (direct !== undefined) { influences[direct] = Math.min(1.5, influences[direct]! + amount * strength); continue; }
    const mix = CHANNELS[name];
    if (!mix) continue;
    for (const unit in mix) {
      const index = dictionary[unit];
      if (index !== undefined) influences[index] = Math.min(1.5, influences[index]! + mix[unit]! * amount * strength);
    }
  }
}

/** `X` stands for both sides at once. */
const both = (w: Readonly<Record<string, number>>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(w)) {
    if (k.endsWith('X')) { out[`${k.slice(0, -1)}Left`] = v; out[`${k.slice(0, -1)}Right`] = v; } else out[k] = v;
  }
  return out;
};

/** Expressions as ARKit weights: Ekman's EMFACS emotions by their action units (Wikipedia FACS table; Ozel's ARKit-to-FACS sheet), the FACS
 *  intensity letters as weights (A 0.15 ... E 1). */
export const FACE_PRESETS: readonly (readonly [string, Readonly<Record<string, number>>])[] = [
  ['Neutro', {}],
  ['Alegria', both({ mouthSmileX: 0.8, cheekSquintX: 0.6, eyeSquintX: 0.25, jawOpen: 0.1, mouthUpperUpX: 0.15 })],
  ['Sorriso', both({ mouthSmileX: 0.6, cheekSquintX: 0.35, mouthPressX: 0.2, mouthClose: 0.1 })],
  ['Tristeza', both({ browInnerUp: 0.8, browDownX: 0.25, mouthFrownX: 0.6, mouthShrugLower: 0.25, mouthPressX: 0.15, eyeLookDownX: 0.15 })],
  ['Surpresa', both({ browInnerUp: 0.8, browOuterUpX: 0.8, eyeWideX: 0.35, jawOpen: 0.45, mouthFunnel: 0.1 })],
  ['Medo', both({ browInnerUp: 0.9, browOuterUpX: 0.4, browDownX: 0.3, eyeWideX: 0.7, eyeSquintX: 0.15, mouthStretchX: 0.65, jawOpen: 0.3 })],
  ['Raiva', both({ browDownX: 0.85, eyeWideX: 0.3, eyeSquintX: 0.45, mouthPressX: 0.5, mouthRollLower: 0.15, mouthPucker: 0.1, noseSneerX: 0.2 })],
  ['Nojo', both({ noseSneerX: 0.8, mouthUpperUpX: 0.45, mouthFrownX: 0.4, mouthShrugLower: 0.4, browDownX: 0.3, cheekSquintX: 0.3 })],
  ['Desprezo', { mouthSmileRight: 0.2, mouthDimpleRight: 0.45, mouthPressRight: 0.1, eyeSquintRight: 0.1, mouthRight: 0.1 }],
  ['Malícia', { mouthSmileLeft: 0.55, mouthDimpleLeft: 0.3, cheekSquintLeft: 0.25, eyeSquintLeft: 0.15, mouthLeft: 0.15, browOuterUpRight: 0.2 }],
  ['Piscadela', { eyeBlinkLeft: 1, cheekSquintLeft: 0.5, mouthSmileLeft: 0.35, browDownLeft: 0.2 }],
  ['Beijo', both({ mouthPucker: 0.9, mouthFunnel: 0.3, mouthRollLower: 0.05, eyeSquintX: 0.1 })],
  ['Bico', both({ mouthShrugLower: 0.6, mouthShrugUpper: 0.3, mouthPucker: 0.35, mouthFrownX: 0.35, browInnerUp: 0.4 })],
  ['Desconfiança', both({ browOuterUpLeft: 0.6, browInnerUp: 0.2, browDownRight: 0.5, eyeSquintRight: 0.3, mouthPressX: 0.3, mouthRight: 0.2, mouthShrugLower: 0.2, eyeLookUpX: 0.2 })],
  ['Sono', both({ eyeBlinkX: 0.55, eyeLookDownX: 0.2, browInnerUp: 0.15, browDownX: 0.1, jawOpen: 0.05 })],
];
