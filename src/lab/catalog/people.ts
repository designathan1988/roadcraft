import { BufferAttribute, BufferGeometry, MeshStandardMaterial, type Material, type Object3D, type SkinnedMesh } from 'three';
import { loadPeopleAssets } from '../../people/body/assets';
import { fitProxy, parseProxy, proxyUrl, type ProxyMeta } from '../../people/body/proxy';
import { loadCookedPerson } from '../../render/people/cookedLoad';
import { createProceduralCrowd } from '../../render/people/proceduralCrowd';
import { CROWD_IDS } from '../../render/citizenCasting';
import type { ItemSpec, PieceSpec } from './items';

/** THE PEOPLE, PIECE BY PIECE: the MakeHuman base body, every garment and hair on its own, the cast's people as cooked, the crowd's classes. */

type Add = (spec: ItemSpec) => void;

/** The base mesh's numbers in decimetres; drawn in metres. */
const DECIMETRE = 0.1;

/** A geometry of positions (decimetres in, metres out) and triangles. */
function meshOf(positions: Float32Array, index: Uint32Array, uvs?: Float32Array): BufferGeometry {
  const g = new BufferGeometry();
  const p = new Float32Array(positions.length);
  for (let i = 0; i < p.length; i++) p[i] = positions[i]! * DECIMETRE;
  g.setAttribute('position', new BufferAttribute(p, 3));
  if (uvs && uvs.length === (positions.length / 3) * 2) g.setAttribute('uv', new BufferAttribute(uvs, 2));
  g.setIndex(new BufferAttribute(index, 1));
  g.computeVertexNormals();
  return g;
}

/** The base body (with and without the helper geometry the game drops), its shape targets' memory, and every garment, hair and eye fitted on it. */
export async function peopleAssetItems(add: Add, proxies: readonly string[], targetBytes: number): Promise<void> {
  const assets = await loadPeopleAssets();
  const base = assets.packs.base as unknown as { sections: { name: string; byteOffset: number; count: number }[] };
  const section = base.sections.find((s) => s.name === 'positions')!;
  const positions = new Float32Array(assets.packs.baseBin, section.byteOffset, section.count * 3);
  const quads = assets.mesh.faces;
  const inBody = (v: number): boolean => assets.bodyRange.some(([a, b]) => v >= a && v <= b);
  const triangles = (onlyBody: boolean): Uint32Array => {
    const out: number[] = [];
    for (let f = 0; f < quads.length / 4; f++) {
      const q = [quads[f * 4]!, quads[f * 4 + 1]!, quads[f * 4 + 2]!, quads[f * 4 + 3]!];
      if (onlyBody && !q.every(inBody)) continue;
      out.push(q[0]!, q[1]!, q[2]!, q[0]!, q[2]!, q[3]!);
    }
    return new Uint32Array(out);
  };
  const skin = new MeshStandardMaterial({ color: 0xc8a08a, roughness: 0.7 });
  const bones = assets.skeleton.bones.length;
  add({
    group: 'People: base body', name: 'MakeHuman base mesh', variation: 'body only', origin: 'file', source: 'public/models/people/base.bin (src/people/body/assets.ts)', build: 'skinned',
    pieces: [{ label: 'body', geometry: meshOf(positions, triangles(true)), material: skin, bones }], extraBytes: targetBytes,
    notes: [`shape targets (macro PCA, local, face units) ${(targetBytes / 1e6).toFixed(1)} MB counted in its memory`, `${bones} bones (game_engine skeleton)`,
      'source asset: every person is built from it and its garments (the cast and crowd rows are what is drawn), so it has no copies of its own'],
  });
  add({
    group: 'People: base body', name: 'MakeHuman base mesh', variation: 'with helper geometry', origin: 'file', source: 'public/models/people/base.bin', build: 'skinned',
    pieces: [{ label: 'body and helpers', geometry: meshOf(positions, triangles(false)), material: skin, bones }], notes: ['the file as shipped; the helpers (joints, proxies\' fitting cubes) are not drawn'],
  });
  // Read straight from its two files, many at once: DO NOT load them as the game does (`loadProxyItem` decodes each texture whole to sample its colour, minutes for 577).
  const read = async (name: string): Promise<{ meta: ProxyMeta; bin: ArrayBuffer }> => {
    const [meta, bin] = await Promise.all([fetch(proxyUrl(`${name}.json`)).then((r) => r.json() as Promise<ProxyMeta>), fetch(proxyUrl(`${name}.bin`)).then((r) => r.arrayBuffer())]);
    return { meta, bin };
  };
  const loaded = await Promise.all(proxies.map((name) => read(name).then((value) => ({ name, value }), (error: unknown) => ({ name, error }))));
  for (const entry of loaded) {
    const name = entry.name;
    try {
      if ('error' in entry) throw entry.error;
      const pack = parseProxy(entry.value.meta, entry.value.bin);
      const fitted = fitProxy(pack, positions);
      const material = new MeshStandardMaterial({ color: pack.colour, roughness: 0.8, transparent: !!entry.value.meta.transparent });
      add({
        group: `People: ${pack.kind}`, name, origin: 'file', source: `public/models/people/proxies/${name}.bin`, build: 'skinned',
        pieces: [{ label: pack.kind, geometry: meshOf(fitted, pack.index, pack.uvs), material, bones }],
        notes: [`hides ${pack.deleteVerts.length} base-body vertices under it`, ...(entry.value.meta.texture ? [`texture ${entry.value.meta.texture}`] : [])], countKey: `proxy:${name}`,
      });
    } catch (error) {
      console.error(`[catalogue] ${name} could not be loaded`, error);
      add({ group: 'People: not loaded', name, origin: 'file', source: `public/models/people/proxies/${name}`, build: 'skinned', pieces: [], notes: [`could not be loaded: ${String(error)}`] });
    }
  }
}

/** Every mesh of a person as cooked, its levels (the cook's index sets) and its skeleton. */
function personPieces(root: Object3D): PieceSpec[] {
  const out: PieceSpec[] = [];
  root.traverse((o) => {
    const mesh = o as SkinnedMesh;
    if (!mesh.geometry) return;
    const ready: unknown = mesh.geometry.userData['lodIndices'];
    const levels = Array.isArray(ready) ? (ready as BufferAttribute[]).map((index) => {
      const g = new BufferGeometry();
      for (const [n, a] of Object.entries(mesh.geometry.attributes)) g.setAttribute(n, a);
      g.setIndex(index);
      return g;
    }) : [];
    out.push({ label: mesh.name || 'part', geometry: mesh.geometry, material: (mesh.material as Material | Material[]) ?? null, levels, ...(mesh.skeleton ? { bones: mesh.skeleton.bones.length } : {}) });
  });
  return out;
}

/** The cast's people as the game draws them (cooked: built in a worker, every garment on), and the procedural crowd's classes. */
export async function peopleItems(add: Add): Promise<void> {
  for (const id of CROWD_IDS) {
    const group = await loadCookedPerson(id);
    if (!group) { add({ group: 'People: cast (cooked)', name: id, origin: 'file', source: `cooked/people/${id}.bin`, build: 'skinned', pieces: [], notes: ['no cooked file: built at run time instead'] }); continue; }
    add({ group: 'People: cast (cooked)', name: id, origin: 'file', source: `cooked/people/${id}.bin (src/render/people/cookedLoad.ts)`, build: 'skinned', pieces: personPieces(group), countKey: `cast:${id}`, shadow: 'casts: coarser level for the shadow (castCoarse)' });
  }
  const crowd = createProceduralCrowd({ unit: 1 });
  await crowd.warmClasses();
  const pieces = personPieces(crowd.group);
  const byClass = new Map<string, PieceSpec[]>();
  for (const p of pieces) {
    const key = p.label.replace(/[@#].*$/, '') || 'class';
    const list = byClass.get(key);
    if (list) list.push(p); else byClass.set(key, [p]);
  }
  for (const [name, list] of byClass) add({ group: 'People: procedural crowd', name, origin: 'kit', source: 'src/render/people/proceduralCrowd.ts', build: 'skinned', pieces: list, countKey: 'people:procedural' });
}
