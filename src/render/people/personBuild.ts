import { SkinnedMesh, type Object3D } from 'three';
import { loadPeopleAssets } from '@people/body/assets';
import { Morpher } from '@people/body/morph';
import { loadProxyItem, type ProxyItem } from '@people/body/proxy';
import { expressionShapes } from '@people/body/expressions';
import type { PersonSpec } from '@people/spec';
import { wornItems } from '@people/spec';
import { cartoonBody, styleFor, type CartoonStyle } from './cartoon';
import { createPersonRig, personSimplifier } from './personRig';
import { attachFacialMorphs } from './facialMorphs';
import { channelShapes } from './faceExpression';
import { captureBind, captureBindRotations } from '../citizenWalk';

/** A roster person built from the MakeHuman packs (what the cook stores, `cookedPerson.ts`): in a worker (`citizenBake.worker.ts`), or on the page where none can */

let morpher: Morpher | null = null;

/** The person's scene, its levels made: body, garments worn (the tailored shells where they fail to load) and, with `faces`, the live face's shapes. */
export async function buildPersonScene(person: PersonSpec, gender: 'f' | 'm', style: CartoonStyle, faces: boolean,
  beforeRig: () => Promise<void> = () => Promise.resolve()): Promise<Object3D> {
  const people = await loadPeopleAssets();
  morpher ??= new Morpher(people.packs);
  // The garments it wears, loaded first; failing that it is drawn in the tailored shells rather than not at all.
  const proxies = new Map<string, ProxyItem>();
  try {
    for (const [name, item] of await Promise.all(wornItems(person.look).map(async (n) => [n, await loadProxyItem(n)] as const))) proxies.set(name, item);
  } catch { proxies.clear(); }
  const sex = gender === 'f' ? 'female' : 'male';
  const input = {
    proxies,
    texturedSkin: true,
    data: people.mesh, skeleton: people.skeleton, bodyRange: people.bodyRange,
    positions: cartoonBody(morpher.shape(person.body, person.features), people.mesh, styleFor(style, person.id)), look: person.look,
    capture: captureBind(sex), captureAxes: captureBindRotations(sex),
  };
  await personSimplifier;
  await beforeRig();
  const built = performance.now();
  const rig = createPersonRig(input);
  performance.measure('person-rig', { start: built, end: performance.now() });
  // Live faces: blinking, gaze, mood, speech
  if (faces) {
    const faceAt = performance.now();
    await attachFacialMorphs(input, rig, channelShapes(await expressionShapes()));
    performance.measure('person-face', { start: faceAt, end: performance.now() });
  }
  // Its levels made (off the thread, `personRig.ts`) before anybody reads them.
  const waits: Promise<unknown>[] = [];
  rig.scene.traverse((o) => { if (o instanceof SkinnedMesh) waits.push(o.geometry.userData['lodReady'] as Promise<unknown>); });
  await Promise.all(waits);
  return rig.scene;
}
