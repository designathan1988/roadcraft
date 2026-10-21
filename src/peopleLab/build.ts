import { SkinnedMesh, type Object3D } from 'three';
import { loadPeopleAssets, type PeopleAssets } from '@people/body/assets';
import { Morpher } from '@people/body/morph';
import { loadProxyItem, type ProxyItem } from '@people/body/proxy';
import { expressionShapes } from '@people/body/expressions';
import { generateHair, type HairBase, type HairStyle } from '@people/hair/procedural';
import { wornItems } from '@people/spec';
import { cartoonBody } from '@render/people/cartoon';
import { createPersonRig, personSimplifier } from '@render/people/personRig';
import { attachFacialMorphs } from '@render/people/facialMorphs';
import { channelShapes } from '@render/people/faceExpression';
import { captureBind, captureBindRotations } from '@render/citizenWalk';
import { PROC_PREFIX, type LabPerson } from './record';
import { decodeSculpt, sculptedPack, type SculptBody } from './sculpt';

/** A LAB PERSON BUILT THE GAME'S WAY: `buildPersonScene` (`render/people/personBuild.ts`), with the hair studio's hairstyle worn as an item */

const hairBase = (a: PeopleAssets, mo: Morpher): HairBase => ({ positions: mo.base, vertexCount: a.mesh.vertexCount,
  bodyRange: a.bodyRange, joints: a.mesh.joints, weights: a.mesh.weights, boneNames: a.mesh.boneNames, faces: a.mesh.faces });

export interface BuiltPerson {
  readonly scene: Object3D;
  readonly meshes: readonly SkinnedMesh[];
  readonly triangles: number;
  readonly morphs: number;
}

/** Builds the lab's people; keeps the MakeHuman packs and the grown hairstyles between builds. */
export class LabBuilder {
  private morpher: Morpher | null = null;
  private assets: PeopleAssets | null = null;
  /** Grown hairstyles by their settings: the same settings are grown once. */
  private readonly grown = new Map<string, ProxyItem>();

  private grownHair(style: HairStyle, a: PeopleAssets, mo: Morpher): ProxyItem {
    const key = JSON.stringify(style);
    let item = this.grown.get(key);
    if (!item) {
      // Plain-coloured cards, no strand texture: the solid, sculpted hair of The Sims ("Maxis Match").
      item = { pack: generateHair(style, hairBase(a, mo)), texture: null, transparent: false, textureFile: null };
      if (this.grown.size > 24) this.grown.clear();
      this.grown.set(key, item);
    }
    return item;
  }

  /** The MakeHuman packs, loaded once. */
  async setup(): Promise<{ assets: PeopleAssets; morpher: Morpher }> {
    this.assets ??= await loadPeopleAssets();
    this.morpher ??= new Morpher(this.assets.packs);
    return { assets: this.assets, morpher: this.morpher };
  }

  /** The hairstyle worn, as an item, before any sculpt: grown or loaded. */
  async hairItem(person: LabPerson): Promise<ProxyItem | null> {
    const { assets: a, morpher: mo } = await this.setup();
    const cut = person.spec.look.hairCut;
    if (!cut || cut === 'none') return null;
    return cut.startsWith(PROC_PREFIX) && person.hair ? this.grownHair(person.hair, a, mo) : loadProxyItem(cut);
  }

  /** The person's body as the sculptor shows it: shaped and styled, in its bind posture. */
  async sculptBody(person: LabPerson): Promise<SculptBody> {
    const { assets: a, morpher: mo } = await this.setup();
    return { positions: cartoonBody(mo.shape(person.spec.body, person.spec.features), a.mesh, person.style),
      faces: a.mesh.faces, faceGroup: a.mesh.faceGroup, skinGroup: a.mesh.faceGroups.indexOf('body') };
  }

  async build(person: LabPerson): Promise<BuiltPerson> {
    const { assets: a, morpher: mo } = await this.setup();
    const { spec } = person;
    const proxies = new Map<string, ProxyItem>();
    try {
      for (const [name, item] of await Promise.all(wornItems(spec.look).map(async (n) =>
        [n, n.startsWith(PROC_PREFIX) && person.hair ? this.grownHair(person.hair, a, mo) : await loadProxyItem(n)] as const))) proxies.set(name, item);
    } catch (error) {
      // Drawn in the tailored shells rather than not at all, as the game does.
      console.warn('[people-lab] an item could not be loaded; drawn in the tailored shells', error);
      proxies.clear();
    }
    // The sculpt worn on its own hairstyle: the same item with its offsets moved.
    const cut = spec.look.hairCut;
    const worn = cut ? proxies.get(cut) : undefined;
    const sculpt = person.sculpt;
    if (cut && worn && sculpt?.base === cut) {
      const n = worn.pack.refs.length / 3;
      proxies.set(cut, { ...worn, pack: sculptedPack(worn.pack, decodeSculpt(sculpt, n)) });
    }
    const sex = spec.body.gender < 0.5 ? 'female' : 'male';
    const input = {
      proxies,
      texturedSkin: true,
      data: a.mesh, skeleton: a.skeleton, bodyRange: a.bodyRange,
      positions: cartoonBody(mo.shape(spec.body, spec.features), a.mesh, person.style), look: spec.look,
      capture: captureBind(sex), captureAxes: captureBindRotations(sex),
    };
    await personSimplifier;
    const rig = createPersonRig(input);
    await attachFacialMorphs(input, rig, channelShapes(await expressionShapes()));
    const meshes: SkinnedMesh[] = [];
    const waits: Promise<unknown>[] = [];
    rig.scene.traverse((o) => {
      if (!(o instanceof SkinnedMesh)) return;
      meshes.push(o);
      waits.push(o.geometry.userData['lodReady'] as Promise<unknown>);
    });
    await Promise.all(waits);
    let triangles = 0;
    for (const m of meshes) triangles += (m.geometry.index?.count ?? m.geometry.getAttribute('position').count) / 3;
    return { scene: rig.scene, meshes, triangles, morphs: Object.keys(rig.mesh.morphTargetDictionary ?? {}).length };
  }
}
