import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  FrontSide,
  type Frustum,
  type Group,
  type Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  type Vector3,
  type Texture,
} from 'three';
import { isEffectKind, type EffectKind, type ElementItem, type ElementKind } from '@world/elements';
import type { ChangeRect } from '@world/changes';
import { m } from '@world/units';
import { KEEP_CELL, keepCellKey } from './candidateKeep';
import { keepCellAt, keepCellRect } from './cellKeeps';
import type { ActiveTiles } from './activeTiles';
import { createInstanceRuns, leastPixel, RunBuilder, type Run, type RunStore } from './instanceRuns';
import type { Exhaust, PuffKind } from './exhaust';
import URLS from 'virtual:model-urls/elements?ext=gltf,bin,png';

/** The ELEMENTS the player lays with the brush (`world/elements.ts`), drawn: props as instanced models */

/** Each prop kind's models (several variants, picked by an instance's seed). */
const MODELS: Readonly<Record<Exclude<ElementKind, EffectKind | 'leaves'>, readonly string[]>> = {
  stones: ['Rock_Medium_1', 'Rock_Medium_2', 'Rock_Medium_3'],
  pebbles: ['Pebble_Round_1', 'Pebble_Round_2', 'Pebble_Round_3'],
  gravel: ['Pebble_Square_1', 'Pebble_Square_2', 'Pebble_Square_3'],
  grass: ['Grass_Common_Short', 'Grass_Wispy_Short'],
  tallGrass: ['Grass_Common_Tall', 'Grass_Wispy_Tall'],
  scrub: ['Plant_1', 'Plant_1_Big'],
  fern: ['Fern_1'],
  clover: ['Clover_1', 'Clover_2'],
  flowers: ['Flower_3_Group', 'Flower_4_Group'],
  mushrooms: ['Mushroom_Common', 'Mushroom_Laetiporus'],
};

/** The files' served URLs (the game serves no public folder): one module for the folder (`model-urls-plugin.ts`) */
const url = (file: string): string => {
  const found = URLS[file];
  if (!found) throw new Error(`element model file missing: ${file}`);
  return found;
};

/** One part of a model: its geometry (one unit across, standing on y = 0) and its material. */
interface Part {
  readonly geometry: BufferGeometry;
  readonly material: MeshStandardMaterial;
}

/** Effects: the particle each gives off, how many a second at full intensity, a puff's size (times the element's) and life. */
const EFFECTS: Readonly<Record<EffectKind, { puff: PuffKind; rate: number; size: number; life: number; spread: number; rise: number }>> = {
  smoke: { puff: 2, rate: 7, size: 0.45, life: 5, spread: 0.3, rise: 0.2 },
  fire: { puff: 5, rate: 16, size: 0.45, life: 0.9, spread: 0.35, rise: 0.05 },
  steam: { puff: 3, rate: 7, size: 0.4, life: 3, spread: 0.3, rise: 0.1 },
  dust: { puff: 1, rate: 5, size: 0.5, life: 4, spread: 0.5, rise: 0.05 },
  soot: { puff: 2, rate: 6, size: 0.6, life: 7, spread: 0.3, rise: 0.4 },
  sparks: { puff: 6, rate: 12, size: 0.12, life: 1.2, spread: 0.25, rise: 0.1 },
  spray: { puff: 8, rate: 14, size: 0.15, life: 1.4, spread: 0.4, rise: 0 },
};
/** Effects farther than this from the camera give off nothing (a budget for the one particle pool). */
const EFFECT_REACH = m(720);

async function readParts(name: string, materialFor: (uri: string, mask: boolean, colours: boolean) => MeshStandardMaterial): Promise<Part[]> {
  const json = await (await fetch(url(`${name}.gltf`))).json() as {
    meshes: { primitives: { attributes: Record<string, number>; indices: number; material: number }[] }[];
    accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }[];
    bufferViews: { byteOffset?: number }[];
    materials: { name: string; alphaMode?: string; pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }[];
    textures: { source: number }[];
    images: { uri: string }[];
    buffers: { uri: string }[];
  };
  const bin = await (await fetch(url(json.buffers[0]!.uri))).arrayBuffer();
  const width: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const read = (i: number): Float32Array | Uint32Array => {
    const a = json.accessors[i]!;
    const offset = (json.bufferViews[a.bufferView]!.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const n = a.count * width[a.type]!;
    if (a.componentType === 5126) return new Float32Array(bin.slice(offset, offset + n * 4));
    if (a.componentType === 5123) return Uint32Array.from(new Uint16Array(bin.slice(offset, offset + n * 2)));
    return new Uint32Array(bin.slice(offset, offset + n * 4));
  };
  const prims = json.meshes.flatMap((mesh) => mesh.primitives);
  // The whole model one unit across, on y = 0.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, minZ = Infinity, maxZ = -Infinity;
  const positions = prims.map((p) => read(p.attributes['POSITION']!) as Float32Array);
  for (const pos of positions) {
    for (let i = 0; i < pos.length; i += 3) {
      minX = Math.min(minX, pos[i]!); maxX = Math.max(maxX, pos[i]!);
      minY = Math.min(minY, pos[i + 1]!);
      minZ = Math.min(minZ, pos[i + 2]!); maxZ = Math.max(maxZ, pos[i + 2]!);
    }
  }
  const across = Math.max(maxX - minX, maxZ - minZ, 1e-3);
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  return prims.map((p, k) => {
    const pos = positions[k]!;
    const g = new BufferGeometry();
    const scaled = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      scaled[i] = (pos[i]! - cx) / across;
      scaled[i + 1] = (pos[i + 1]! - minY) / across;
      scaled[i + 2] = (pos[i + 2]! - cz) / across;
    }
    g.setAttribute('position', new BufferAttribute(scaled, 3));
    g.setAttribute('normal', new BufferAttribute(read(p.attributes['NORMAL']!) as Float32Array, 3));
    if (p.attributes['TEXCOORD_0'] !== undefined) g.setAttribute('uv', new BufferAttribute(read(p.attributes['TEXCOORD_0']) as Float32Array, 2));
    const colours = p.attributes['COLOR_0'] !== undefined;
    if (colours) {
      // Normalised shorts in these files (0..65535 for 0..1)
      const accessor = json.accessors[p.attributes['COLOR_0']!]!;
      const c = read(p.attributes['COLOR_0']!);
      const scale = accessor.componentType === 5123 ? 1 / 65535 : accessor.componentType === 5121 ? 1 / 255 : 1;
      const stride = accessor.type === 'VEC3' ? 3 : 4;
      const rgb = new Float32Array((c.length / stride) * 3);
      for (let i = 0, j = 0; i < c.length; i += stride, j += 3) { rgb[j] = c[i]! * scale; rgb[j + 1] = c[i + 1]! * scale; rgb[j + 2] = c[i + 2]! * scale; }
      g.setAttribute('color', new BufferAttribute(rgb, 3));
    }
    g.setIndex(new BufferAttribute(read(p.indices), 1));
    g.computeBoundingSphere();
    const mat = json.materials[p.material]!;
    const texIndex = mat.pbrMetallicRoughness?.baseColorTexture?.index;
    const uri = texIndex !== undefined ? json.images[json.textures[texIndex]!.source]!.uri : '';
    return { geometry: g, material: materialFor(uri, mat.alphaMode === 'MASK', colours) };
  });
}

/** A card of fallen leaves - a dozen leaves in autumn browns, ochres and dull reds, veined - on a clear ground. */
function fallenLeavesTexture(): CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  let seed = 7;
  const rand = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const colours = ['#8a5a2b', '#a8742f', '#6e4a24', '#9c4b25', '#b88a3c', '#5d4a2a', '#7a3d1f'];
  for (let i = 0; i < 26; i++) {
    const x = size * (0.12 + 0.76 * rand()), y = size * (0.12 + 0.76 * rand());
    const len = size * (0.07 + 0.06 * rand()), wid = len * (0.45 + 0.2 * rand());
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rand() * Math.PI * 2);
    ctx.fillStyle = colours[Math.floor(rand() * colours.length)]!;
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.quadraticCurveTo(0, -wid * 1.4, len, 0);
    ctx.quadraticCurveTo(0, wid * 1.4, -len, 0);
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,25,10,0.55)';
    ctx.lineWidth = size * 0.004;
    ctx.beginPath();
    ctx.moveTo(-len * 1.15, 0); ctx.lineTo(len, 0);
    for (let v = -0.6; v <= 0.6; v += 0.3) { ctx.moveTo(len * v, 0); ctx.lineTo(len * (v + 0.25), wid * 0.7); ctx.moveTo(len * v, 0); ctx.lineTo(len * (v + 0.25), -wid * 0.7); }
    ctx.stroke();
    ctx.restore();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export interface ElementKit {
  /** The parts of each prop kind's variants. */
  readonly models: ReadonlyMap<ElementKind, readonly Part[][]>;
  dispose(): void;
}

export async function loadElementKit(anisotropy: number): Promise<ElementKit> {
  const loader = new TextureLoader();
  const textures = new Map<string, Promise<Texture>>();
  const materials = new Map<string, MeshStandardMaterial>();
  const textureOf = (uri: string): Promise<Texture> => {
    let t = textures.get(uri);
    if (!t) {
      // As the glTF loader reads them: no vertical flip, and repeating (the format's default sampler)
      t = loader.loadAsync(url(uri)).then((tex) => {
        tex.colorSpace = SRGBColorSpace;
        tex.anisotropy = anisotropy;
        tex.flipY = false;
        tex.wrapS = RepeatWrapping;
        tex.wrapT = RepeatWrapping;
        tex.needsUpdate = true;
        return tex;
      });
      textures.set(uri, t);
    }
    return t;
  };
  const pending: Promise<void>[] = [];
  const materialFor = (uri: string, mask: boolean, colours: boolean): MeshStandardMaterial => {
    const key = `${uri}|${mask}|${colours}`;
    let mat = materials.get(key);
    if (!mat) {
      const made = new MeshStandardMaterial({ roughness: 0.9, metalness: 0, vertexColors: colours, side: mask ? DoubleSide : FrontSide, alphaTest: mask ? 0.5 : 0 });
      if (uri) pending.push(textureOf(uri).then((tex) => { made.map = tex; made.needsUpdate = true; }));
      materials.set(key, made);
      mat = made;
    }
    return mat;
  };
  const models = new Map<ElementKind, Part[][]>();
  for (const [kind, names] of Object.entries(MODELS) as [ElementKind, readonly string[]][]) {
    models.set(kind, await Promise.all(names.map((name) => readParts(name, materialFor))));
  }
  // Fallen leaves: a flat card lying on the ground.
  const leafCard = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0.02, 0);
  // Each slot's sphere is grown from its model's (`instanceRuns.ts`).
  leafCard.computeBoundingSphere();
  const leafMaterial = new MeshStandardMaterial({ map: fallenLeavesTexture(), alphaTest: 0.5, roughness: 0.95, metalness: 0, side: DoubleSide });
  models.set('leaves', [[{ geometry: leafCard, material: leafMaterial }]]);
  await Promise.all(pending);
  return {
    models,
    dispose() {
      for (const variants of models.values()) for (const parts of variants) for (const part of parts) part.geometry.dispose();
      for (const mat of materials.values()) { mat.map?.dispose(); mat.dispose(); }
      leafMaterial.map?.dispose();
      leafMaterial.dispose();
    },
  };
}

/** What the layer reads of the document: every element (a whole build only) and the elements by place. */
export interface ElementSource {
  readonly elements: readonly ElementItem[];
  elementsIn(rect: ChangeRect): ElementItem[];
}

export interface ElementLayer {
  readonly group: Group;
  /** The cells (`cellKeeps.ts` keep cells) made again from the elements standing in them (null: every cell); whether a prop came or went. */
  sync(cells: ReadonlySet<number> | null, source: ElementSource, groundAt: (x: number, y: number) => number): boolean;
  /** Keeps the instances the camera can see (`InstanceRuns.cull`). */
  cull(frustum: Frustum, view: Matrix4): void;
  /** Gives off the effects' particles near the camera (three's x, y, z), `dt` seconds on. */
  emit(dt: number, eye: Vector3, exhaust: Exhaust): void;
  readonly hasEffects: boolean;
  /** Where each prop kind's variants are drawn among the layer's stores (`ElementLayout`): what a tile's bake builds its run in. */
  readonly layout: ElementLayout;
  /** The streamed world: the elements are the tiles' (`elementTiles.ts`, `put`), the page's own taken away and none made by `sync`; off, every cell made again by the next whole `sync`. */
  setTiled(tiled: boolean): void;
  /** A tile's bake drawn (`bakeElements`), its effects giving off; taken away by `take` with the same bake. */
  put(bake: ElementBake): void;
  take(bake: ElementBake): void;
  dispose(): void;
}

/** Each prop kind's variants as the stores of their parts, and how many stores (`createElementLayer`). */
export interface ElementLayout {
  readonly kinds: readonly (readonly [ElementKind, readonly (readonly number[])[]])[];
  readonly stores: number;
}

/** A tile's elements as a bake hands them (`elementTiles.ts`): its props in one run, its effects with the ground under each. */
export interface ElementBake {
  readonly run: Run | null;
  readonly effects: readonly { readonly item: ElementItem; readonly z: number }[];
}

/** Elements put in a run of the layer's stores (`layout`), each on the ground at its point, turned and sized, tinted by its seed; the effects pushed to `fires`. */
function elementsInto(builder: RunBuilder, storesOf: ReadonlyMap<ElementKind, readonly (readonly number[])[]>, items: readonly ElementItem[],
  groundAt: (x: number, y: number) => number, fires: { readonly item: ElementItem; readonly z: number }[]): void {
  const tint = { r: 1, g: 1, b: 1 };
  for (const item of items) {
    if (isEffectKind(item.kind)) { fires.push({ item, z: groundAt(item.x, item.y) }); continue; }
    const variants = storesOf.get(item.kind);
    if (!variants?.length) continue;
    const parts = variants[Math.min(variants.length - 1, Math.floor(item.seed * variants.length))]!;
    const t = 0.88 + ((item.seed * 7.31) % 1) * 0.24;
    tint.r = t; tint.g = t; tint.b = t;
    // The layer's pose is `YAW_POSE` (place, yaw, scale), never a matrix; world y is three's -z.
    const z = groundAt(item.x, item.y);
    for (const store of parts) builder.turned(store, item.x, z, -item.y, item.yaw, item.size, item.size, item.size, item.size, tint);
  }
}

/** THE ELEMENTS OF A TILE BAKED, IN A WORKER: its props in one run of the layer's stores, its effects, each on the ground as drawn (`elementsInto`, the page's own); none: null */
export function bakeElements(items: readonly ElementItem[], groundAt: (x: number, y: number) => number, layout: ElementLayout): ElementBake | null {
  const builder = new RunBuilder(Array.from({ length: layout.stores }, () => ({ tinted: true })));
  const effects: { item: ElementItem; z: number }[] = [];
  elementsInto(builder, new Map(layout.kinds), items, groundAt, effects);
  const run = builder.build();
  return run.size || effects.length ? { run: run.size ? run : null, effects } : null;
}

/** The props that throw a shadow worth its pass. */
const CASTS: ReadonlySet<ElementKind> = new Set<ElementKind>(['stones', 'pebbles', 'scrub', 'fern', 'tallGrass']);
/** How far off the view a prop still throws a shadow into it. */
const ELEMENT_SHADOW_REACH = m(8);

/** An effect giving off its particles: where it stands, and the particles owed since the last frame. */
interface Emitter { readonly item: ElementItem; readonly z: number; owed: number }

/** @rebuild Every element of the map by the cell it stands in (those `here` says are made here), and every cell drawn before: a map opened or replaced whole. */
function allByCell(source: ElementSource, before: Iterable<number>, here: (item: ElementItem) => boolean): Map<number, ElementItem[]> {
  const byCell = new Map<number, ElementItem[]>();
  for (const item of source.elements) {
    if (!here(item)) continue;
    const key = keepCellAt(item.x, item.y);
    const list = byCell.get(key);
    if (list) list.push(item); else byCell.set(key, [item]);
  }
  for (const key of before) if (!byCell.has(key)) byCell.set(key, []);
  return byCell;
}

/** DO NOT build every element of the map again when one is laid: the elements kept cell by cell, instanced per kind; `active`, the streamed world's active tiles, the only ones whose elements are made here (`activeTiles.ts`; none, every element) */
export function createElementLayer(kit: ElementKit, active?: ActiveTiles): ElementLayer {
  /** An element of the kept ring round the active tiles is the far levels' (`activeTiles.ts`): not made here. */
  const here = (item: ElementItem): boolean => !active || active.has(item.x, item.y);
  const stores: RunStore[] = [];
  /** Each prop kind's variants, as the stores of their parts. */
  const storesOf = new Map<ElementKind, number[][]>();
  for (const [kind, variants] of kit.models) {
    storesOf.set(kind, variants.map((parts) => parts.map((part) => stores.push({
      name: `element-${kind}`, geometry: part.geometry, material: part.material,
      castShadow: CASTS.has(kind), receiveShadow: true, tinted: true, cards: false,
      // A pebble or a tuft under a pixel across is not drawn (`leastPixel`).
      levels: leastPixel(part.geometry),
    }) - 1)));
  }
  const runs = createInstanceRuns('elements', stores, ELEMENT_SHADOW_REACH);
  /** Each cell's instances as drawn, and its effects. */
  const drawn = new Map<number, Run>();
  const emitters = new Map<number, Emitter[]>();
  let effects = 0;
  /** One cell's elements: its props into a run, its effects as emitters. */
  const cellOf = (items: readonly ElementItem[], groundAt: (x: number, y: number) => number): { run: Run; fires: Emitter[] } => {
    const builder = new RunBuilder(stores);
    const fires: { item: ElementItem; z: number }[] = [];
    elementsInto(builder, storesOf, items, groundAt, fires);
    return { run: builder.build(), fires: fires.map((f) => ({ ...f, owed: 0 })) };
  };
  const layout: ElementLayout = { kinds: [...storesOf], stores: stores.length };
  /** The tiles' bakes drawn (`put`), each with its effects as emitters. */
  const tiles = new Map<ElementBake, Emitter[]>();
  let tiled = false;
  /** An effect giving off near the eye. */
  const give = (e: Emitter, dt: number, eye: Vector3, exhaust: Exhaust): void => {
    const { item } = e;
    if (Math.hypot(item.x - eye.x, e.z - eye.y, -item.y - eye.z) > EFFECT_REACH) return;
    const fx = EFFECTS[item.kind as EffectKind];
    e.owed += fx.rate * (item.intensity ?? 0.5) * Math.max(0.5, item.size / m(2)) * dt;
    const n = Math.floor(e.owed);
    if (n <= 0) return;
    e.owed -= n;
    exhaust.burst(item.x, item.y, e.z + item.size * fx.rise, n, fx.puff, item.size * fx.spread, item.size * fx.size, fx.life);
  };
  return {
    group: runs.group,
    get hasEffects() { return effects > 0; },
    sync(cells, source, groundAt) {
      if (tiled) return false;
      const byCell = cells === null ? allByCell(source, [...drawn.keys(), ...emitters.keys()], here) : new Map<number, ElementItem[]>();
      // A cell's elements from the document's filing by place (`RoadDoc.elementsIn`), each in the cell its point falls in.
      for (const key of cells ?? []) byCell.set(key, source.elementsIn(keepCellRect(key)).filter((e) => keepCellAt(e.x, e.y) === key && here(e)));
      const removed: Run[] = [], added: Run[] = [];
      for (const [key, items] of byCell) {
        const was = drawn.get(key);
        if (was) { removed.push(was); drawn.delete(key); }
        effects -= emitters.get(key)?.length ?? 0;
        emitters.delete(key);
        if (!items.length) continue;
        const { run, fires } = cellOf(items, groundAt);
        if (run.size) { added.push(run); drawn.set(key, run); }
        if (fires.length) { emitters.set(key, fires); effects += fires.length; }
      }
      if (!removed.length && !added.length) return false;
      runs.update({ removed, added });
      return true;
    },
    cull(frustum, view) { runs.cull(frustum, view); },
    emit(dt, eye, exhaust) {
      if (effects === 0) return;
      // The cells within reach of the eye only (world y is three's -z): never every effect of the map.
      const i0 = Math.floor((eye.x - EFFECT_REACH) / KEEP_CELL), i1 = Math.floor((eye.x + EFFECT_REACH) / KEEP_CELL);
      const j0 = Math.floor((-eye.z - EFFECT_REACH) / KEEP_CELL), j1 = Math.floor((-eye.z + EFFECT_REACH) / KEEP_CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const e of emitters.get(keepCellKey(i, j)) ?? []) give(e, dt, eye, exhaust);
      // A tile's effects: the tiles drawn are those round the view, a handful of effects each.
      for (const list of tiles.values()) for (const e of list) give(e, dt, eye, exhaust);
    },
    layout,
    setTiled(on) {
      if (on === tiled) return;
      tiled = on;
      if (!on) return;
      // The page's own cells taken away: the tiles' are drawn from now on.
      if (drawn.size) runs.update({ removed: [...drawn.values()], added: [] });
      for (const list of emitters.values()) effects -= list.length;
      drawn.clear();
      emitters.clear();
    },
    put(bake) {
      if (tiles.has(bake)) return;
      const fires = bake.effects.map((f) => ({ ...f, owed: 0 }));
      tiles.set(bake, fires);
      effects += fires.length;
      if (bake.run) runs.update({ removed: [], added: [bake.run] });
    },
    take(bake) {
      const fires = tiles.get(bake);
      if (!fires) return;
      tiles.delete(bake);
      effects -= fires.length;
      if (bake.run) runs.update({ removed: [bake.run], added: [] });
    },
    dispose() {
      runs.dispose();
      drawn.clear();
      emitters.clear();
      tiles.clear();
      effects = 0;
    },
  };
}
