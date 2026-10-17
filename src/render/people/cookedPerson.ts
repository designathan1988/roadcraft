import {
  Bone, Box3, BufferAttribute, BufferGeometry, Group, Matrix4, MaterialLoader, type Material, type Object3D, Skeleton, SkinnedMesh, Sphere, Vector3,
} from 'three';

/** A person's body cooked ahead (`scripts/cook-people.mjs`): the output of building it */

type ArrayKind = 'f32' | 'u32' | 'u16' | 'u8';
interface BufferRef { readonly at: number; readonly length: number; readonly kind: ArrayKind }
interface CookedAttribute { readonly name: string; readonly itemSize: number; readonly normalized: boolean; readonly data: BufferRef }
interface CookedMorph { readonly name: string; readonly vertices: BufferRef; readonly deltas: BufferRef }
interface CookedMesh {
  readonly attributes: CookedAttribute[];
  readonly index: BufferRef | null;
  readonly groups: { start: number; count: number; materialIndex: number }[];
  readonly morphs: CookedMorph[];
  readonly morphRelative: boolean;
  readonly dictionary: Record<string, number>;
  readonly influences: number[];
  readonly lods: { readonly index: BufferRef; readonly groups: { start: number; count: number; materialIndex: number }[] }[];
  readonly bones: number[];
  /** Full precision (the skeleton works in doubles): 16 numbers a bone. */
  readonly inverses: number[];
  readonly bind: number[];
  readonly bindMode: string;
  readonly materials: unknown[];
  readonly materialArray: boolean;
  /** What the shaders read off the geometry (`skinAppearance.ts`): the face's origin and scale, the garments worn. */
  readonly extra: { faceOrigin?: number[]; faceScale?: number; wornGroups?: string[] };
}
interface CookedNode {
  readonly name: string;
  readonly kind: 'bone' | 'skinned' | 'group' | 'node';
  readonly parent: number;
  readonly p: number[];
  readonly q: number[];
  readonly s: number[];
  readonly mesh?: CookedMesh;
}
interface CookedHeader { readonly version: 2; readonly nodes: CookedNode[] }

const KINDS: Record<ArrayKind, { new (buffer: ArrayBuffer, at: number, length: number): ArrayLike<number> & { buffer: ArrayBufferLike }; bytes: number }> = {
  f32: Float32Array as never, u32: Uint32Array as never, u16: Uint16Array as never, u8: Uint8Array as never,
};
const kindOf = (a: ArrayLike<number>): ArrayKind =>
  a instanceof Float32Array ? 'f32' : a instanceof Uint32Array ? 'u32' : a instanceof Uint16Array ? 'u16' : a instanceof Uint8Array ? 'u8' : 'f32';
const BYTES: Record<ArrayKind, number> = { f32: 4, u32: 4, u16: 2, u8: 1 };
/** A face shape's move below this (metres) is rounding left by the fitting, not a movement. */
const MORPH_EPSILON = 1e-5;

/** Packs a built person (its scene, its levels already made) into one buffer. */
export function cookPerson(scene: Object3D): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const put = (array: ArrayLike<number>): BufferRef => {
    const kind = kindOf(array);
    const typed = array instanceof Float32Array || array instanceof Uint32Array || array instanceof Uint16Array || array instanceof Uint8Array
      ? array : Float32Array.from(array);
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const padded = (bytes.byteLength + 3) & ~3;
    const copy = new Uint8Array(padded);
    copy.set(bytes);
    const ref = { at: size, length: typed.length, kind };
    chunks.push(copy);
    size += padded;
    return ref;
  };
  const order: Object3D[] = [];
  scene.traverse((o) => order.push(o));
  const at = new Map(order.map((o, i) => [o, i] as const));
  const nodes = order.map((o): CookedNode => {
    const base = {
      name: o.name, parent: o.parent && at.has(o.parent) ? at.get(o.parent)! : -1,
      p: o.position.toArray(), q: o.quaternion.toArray() as number[], s: o.scale.toArray(),
    };
    if (!(o instanceof SkinnedMesh)) {
      return { ...base, kind: (o as Bone).isBone ? 'bone' : (o as Group).isGroup ? 'group' : 'node' };
    }
    const g: BufferGeometry = o.geometry;
    const count = g.getAttribute('position').count;
    const morphs: CookedMorph[] = (g.morphAttributes['position'] ?? []).map((m, k) => {
      const moved: number[] = [];
      const deltas: number[] = [];
      for (let v = 0; v < count; v++) {
        const x = m.getX(v), y = m.getY(v), z = m.getZ(v);
        // Under a hundredth of a millimetre is arithmetic, not a movement.
        if (Math.hypot(x, y, z) < MORPH_EPSILON) continue;
        moved.push(v);
        deltas.push(x, y, z);
      }
      return { name: m.name || String(k), vertices: put(Uint32Array.from(moved)), deltas: put(Float32Array.from(deltas)) };
    });
    const lodIndices = (g.userData['lodIndices'] as BufferAttribute[] | undefined) ?? [];
    const lodGroups = (g.userData['lodGroups'] as { start: number; count: number; materialIndex: number }[][] | undefined) ?? [];
    const inverses = o.skeleton.boneInverses.flatMap((m) => [...m.elements]);
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    return {
      ...base,
      kind: 'skinned',
      mesh: {
        attributes: Object.entries(g.attributes).map(([name, a]) => ({
          name, itemSize: a.itemSize, normalized: a.normalized, data: put(a.array as ArrayLike<number>),
        })),
        index: g.index ? put(g.index.array as ArrayLike<number>) : null,
        groups: g.groups.map((gr) => ({ start: gr.start, count: gr.count, materialIndex: gr.materialIndex ?? 0 })),
        morphs,
        morphRelative: g.morphTargetsRelative,
        dictionary: { ...(o.morphTargetDictionary ?? {}) },
        influences: [...(o.morphTargetInfluences ?? [])],
        lods: lodIndices.map((index, level) => ({ index: put(index.array as ArrayLike<number>), groups: lodGroups[level] ?? [] })),
        bones: o.skeleton.bones.map((b) => at.get(b) ?? -1),
        inverses,
        bind: [...o.bindMatrix.elements],
        bindMode: o.bindMode,
        materials: materials.map((m) => m.toJSON()),
        materialArray: Array.isArray(o.material),
        extra: {
          ...(g.userData['faceOrigin'] instanceof Vector3 ? { faceOrigin: (g.userData['faceOrigin'] as Vector3).toArray() } : {}),
          ...(typeof g.userData['faceScale'] === 'number' ? { faceScale: g.userData['faceScale'] as number } : {}),
          ...(Array.isArray(g.userData['wornGroups']) ? { wornGroups: [...(g.userData['wornGroups'] as string[])] } : {}),
        },
      },
    };
  });
  const header = new TextEncoder().encode(JSON.stringify({ version: 2, nodes } satisfies CookedHeader));
  const headerPadded = (header.byteLength + 3) & ~3;
  const out = new Uint8Array(4 + headerPadded + size);
  new DataView(out.buffer).setUint32(0, header.byteLength, true);
  out.set(header, 4);
  let offset = 4 + headerPadded;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out.buffer;
}

/** A typed array as the cook wrote it. */
type Typed = Float32Array | Uint32Array | Uint16Array | Uint8Array;
/** A skinned mesh's arrays read from the cook, each its own buffer (movable to the page): its face shapes whole, its bounds worked out. */
interface DecodedMesh {
  readonly attributes: readonly Typed[];
  readonly index: Typed | null;
  readonly morphs: readonly Float32Array[];
  readonly lods: readonly Typed[];
  /** Box min and max, then the sphere's centre and radius, as three's `computeBoundingBox` / `computeBoundingSphere` give them. */
  readonly bounds: readonly number[];
}
/** A cooked person read: the header, and each node's mesh arrays (null: no mesh). */
export interface DecodedPerson { readonly header: CookedHeader; readonly meshes: readonly (DecodedMesh | null)[] }

/** DO NOT read a cooked person on the page: the arrays sliced, the face shapes made whole (shapes x vertices x 3) and the bounds worked out here, in a worker (`bakePool.ts` uncookInWorker). */
export function decodeCookedPerson(buffer: ArrayBuffer): { person: DecodedPerson; transfer: ArrayBuffer[] } {
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength))) as CookedHeader;
  if (header.version !== 2) throw new Error(`Cooked person version ${String(header.version)}`);
  const base = 4 + ((headerLength + 3) & ~3);
  const transfer: ArrayBuffer[] = [];
  /** `kept`: sent to the page (moved), not only read here. */
  const get = (ref: BufferRef, kept = true): Typed => {
    const Kind = KINDS[ref.kind];
    // A copy of its own, 4-aligned: the views are handed to WebGL as they are.
    const bytes = buffer.slice(base + ref.at, base + ref.at + ref.length * BYTES[ref.kind]);
    if (kept) transfer.push(bytes);
    return new Kind(bytes, 0, ref.length) as Typed;
  };
  const meshes = header.nodes.map((n): DecodedMesh | null => {
    if (n.kind !== 'skinned' || !n.mesh) return null;
    const m = n.mesh;
    const attributes = m.attributes.map((a) => get(a.data));
    const position = attributes[m.attributes.findIndex((a) => a.name === 'position')]!;
    const count = position.length / 3;
    const morphs = m.morphs.map((morph) => {
      const full = new Float32Array(count * 3);
      const vertices = get(morph.vertices, false);
      const deltas = get(morph.deltas, false);
      for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i]!;
        full[v * 3] = deltas[i * 3]!; full[v * 3 + 1] = deltas[i * 3 + 1]!; full[v * 3 + 2] = deltas[i * 3 + 2]!;
      }
      transfer.push(full.buffer);
      return full;
    });
    // The bounds as three works them out (the face shapes widen them): on a geometry of the position and the shapes alone.
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(position, 3));
    if (morphs.length) {
      g.morphAttributes['position'] = morphs.map((full) => new BufferAttribute(full, 3));
      g.morphTargetsRelative = m.morphRelative;
    }
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const box = g.boundingBox!, sphere = g.boundingSphere!;
    return {
      attributes, index: m.index ? get(m.index) : null, morphs, lods: m.lods.map((l) => get(l.index)),
      bounds: [...box.min.toArray(), ...box.max.toArray(), ...sphere.center.toArray(), sphere.radius],
    };
  });
  return { person: { header, meshes }, transfer };
}

/** The person's scene read back from `cookPerson`'s buffer: bones, skinned mesh, face shapes, levels. */
export function uncookPerson(buffer: ArrayBuffer): Group {
  return assemblePerson(decodeCookedPerson(buffer).person);
}

/** The person's scene from its decoded arrays: three's objects only, no loop over a vertex. */
export function assemblePerson(person: DecodedPerson): Group {
  const { header, meshes } = person;
  const loader = new MaterialLoader();
  const built: Object3D[] = header.nodes.map((n, at) => {
    let o: Object3D;
    const d = meshes[at];
    if (n.kind === 'bone') o = new Bone();
    else if (n.kind === 'skinned' && n.mesh && d) {
      const m = n.mesh;
      const g = new BufferGeometry();
      m.attributes.forEach((a, k) => g.setAttribute(a.name, new BufferAttribute(d.attributes[k]!, a.itemSize, a.normalized)));
      if (d.index) g.setIndex(new BufferAttribute(d.index, 1));
      for (const gr of m.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
      if (d.morphs.length) {
        g.morphAttributes['position'] = d.morphs.map((full, k) => {
          const attribute = new BufferAttribute(full, 3);
          attribute.name = m.morphs[k]!.name;
          return attribute;
        });
        g.morphTargetsRelative = m.morphRelative;
      }
      g.userData['lodIndices'] = d.lods.map((index) => new BufferAttribute(index, 1));
      g.userData['lodGroups'] = m.lods.map((l) => l.groups);
      g.userData['lodReady'] = Promise.resolve();
      if (m.extra?.faceOrigin) g.userData['faceOrigin'] = new Vector3().fromArray(m.extra.faceOrigin);
      if (m.extra?.faceScale !== undefined) g.userData['faceScale'] = m.extra.faceScale;
      if (m.extra?.wornGroups) g.userData['wornGroups'] = [...m.extra.wornGroups];
      const b = d.bounds;
      g.boundingBox = new Box3(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]));
      g.boundingSphere = new Sphere(new Vector3(b[6], b[7], b[8]), b[9]);
      const materials = m.materials.map((json) => loader.parse(json) as Material);
      const mesh = new SkinnedMesh(g, m.materialArray ? materials : materials[0]!);
      if (m.influences.length) {
        mesh.morphTargetInfluences = [...m.influences];
        mesh.morphTargetDictionary = { ...m.dictionary };
      }
      o = mesh;
    } else o = n.kind === 'group' ? new Group() : new Group();
    o.name = n.name;
    o.position.fromArray(n.p);
    o.quaternion.fromArray(n.q);
    o.scale.fromArray(n.s);
    return o;
  });
  header.nodes.forEach((n, i) => { if (n.parent >= 0) built[n.parent]!.add(built[i]!); });
  const root = built[0]!;
  root.updateMatrixWorld(true);
  header.nodes.forEach((n, i) => {
    if (!n.mesh) return;
    const mesh = built[i] as SkinnedMesh;
    const bones = n.mesh.bones.map((b) => built[b] as Bone);
    const inverses = bones.map((_, k) => new Matrix4().fromArray(n.mesh!.inverses, k * 16));
    mesh.bindMode = n.mesh.bindMode as SkinnedMesh['bindMode'];
    mesh.bind(new Skeleton(bones, inverses), new Matrix4().fromArray(n.mesh.bind));
  });
  if (!(root as Group).isGroup) {
    const wrap = new Group();
    wrap.add(root);
    return wrap;
  }
  return root as Group;
}
