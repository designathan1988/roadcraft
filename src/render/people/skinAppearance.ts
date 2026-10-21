import { CanvasTexture, Color, DataArrayTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, ShaderChunk, SRGBColorSpace, Texture, TextureLoader, Vector2, type BufferGeometry, type MeshStandardMaterial } from 'three';
import { EYE_COLOURS, type PersonSpec } from '@people/spec';
import { loadProxyItem, proxyUrl, type ProxyItem } from '@people/body/proxy';
import { MAX_TEXTURED, texturedGarments } from './garmentSlots';
import { padGarmentFileInWorker, padGarmentInWorker } from './garmentPaddingPool';
import { stageTexels, type TexelPart } from '../stagedTexels';
import { cancelUploads, queueUpload } from '../uploads';
import index from '../../../public/models/people/skins/index.json';
// The skin textures' URLs by file name, one module for the folder (`model-urls-plugin.ts`)
import urls from 'virtual:model-urls/people/skins?ext=webp';

export interface SkinAppearance { texture: Texture; eyeTexture: Texture; tint: Color; hair: Color; hairTexture?: Texture; browTexture?: Texture; lashTexture?: Texture; beardTexture?: Texture; garments: (Texture | null)[]; outfitTint: Color | null; beard: number; makeup: number }

// A dressed person's eyes, brows, lashes, hair, beard and garments are layers of two arrays (256 and 512 px, the catalogue's sizes): two texture units for all, not one each (ANGLE D3D11 has 16; three r186 `allocateTextureUnit` counts both stages).
const SMALL_LAYER = 256;
const LARGE_LAYER = 512;
/** Layers each array starts with: the catalogue's textured brows and lashes (16) fit the small one with room to spare. */
const SMALL_LAYERS = 24;
const LARGE_LAYERS = 16;

/** One array of same-sized layers and who holds which layer, owned by whoever makes the materials */
interface CardAtlas {
  /** Width and height of every layer, pixels. */
  readonly size: number;
  /** The layer a texture is copied into (when first asked for); -1 without a picture to copy. */
  layerOf(texture: Texture | undefined): number;
  /** The array, ONE uniform for every material: when the array grows, every program reads the new one */
  readonly uniform: { value: DataArrayTexture | null };
  dispose(): void;
}

/** A person's two arrays (`SMALL_LAYER`, `LARGE_LAYER`): a texture goes in the one of its own size */
export interface PersonLayers {
  readonly small: CardAtlas;
  readonly large: CardAtlas;
  /** Where a texture is drawn from: [0, 0] without one, else [1 small or 2 large, its layer]. */
  place(texture: Texture | undefined | null): Place;
  dispose(): void;
}

export function createPersonLayers(): PersonLayers {
  const small = createCardAtlas(SMALL_LAYER, SMALL_LAYERS);
  const large = createCardAtlas(LARGE_LAYER, LARGE_LAYERS);
  return {
    small, large,
    place(texture) {
      if (!texture) return [0, 0];
      const width = (texture.image as { width?: number } | undefined)?.width ?? 0;
      const atlas = width > SMALL_LAYER ? 2 : 1;
      const layer = (atlas === 2 ? large : small).layerOf(texture);
      return layer < 0 ? [0, 0] : [atlas, layer];
    },
    dispose() {
      small.dispose();
      large.dispose();
    },
  };
}

function newLayerArray(size: number, depth: number): DataArrayTexture {
  const array = new DataArrayTexture(null, size, size, depth);
  // As each texture it holds was sampled on its own: sRGB, trilinear, edges clamped, no flip
  array.colorSpace = SRGBColorSpace;
  array.magFilter = LinearFilter;
  array.minFilter = LinearMipmapLinearFilter;
  array.generateMipmaps = true;
  array.unpackAlignment = 4;
  array.needsUpdate = true;
  return array;
}

/** A texture's own bytes when they are already a layer's (a padded garment, `paddedGarment`): copied as they are. */
function ownBytes(texture: Texture, size: number): ArrayLike<number> | null {
  const image = texture.image as { data?: unknown; width?: number; height?: number } | undefined;
  const data = image?.data;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) return null;
  return image!.width === size && image!.height === size && data.length === size * size * 4 && !texture.flipY ? data : null;
}

function createCardAtlas(size: number, layers: number): CardAtlas {
  const bytes = size * size * 4;
  const uniform: { value: DataArrayTexture | null } = { value: null };
  /** Each held texture's layer, and how it gives it back. */
  const held = new Map<Texture, { layer: number; release: () => void }>();
  /** Layers given back by textures let go, reused before the array grows. */
  const free: number[] = [];
  /** Layers ever handed out: the next new one. */
  let used = 0;
  /** The texture each layer is copied from, by layer: what a send makes the layer from again. */
  const sourceOf: (Texture | undefined)[] = [];
  /** Layers' pixels written and not sent yet, by layer: copied once, kept only until three sends them. */
  const pending = new Map<number, ArrayLike<number>>();
  let canvas: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  /** DO NOT list a layer on an array not yet uploaded */
  let whole = true;
  const array = (): DataArrayTexture => uniform.value ??= fresh(layers);
  /** The layers three sends, made from their pixels written or their textures again (a grown array, a context restored). */
  const fill = (into: Uint8Array, part: TexelPart): void => {
    const each = part.layers ?? sourceOf.keys();
    for (const layer of each) {
      const source = sourceOf[layer];
      const pixels = pending.get(layer) ?? (source ? ownBytes(source, size) ?? drawn(source) : null);
      if (pixels) into.set(pixels, layer * bytes);
    }
  };
  /** A new array: sent whole on its first upload (three calls `onUpdate` once it has been). */
  const fresh = (depth: number): DataArrayTexture => {
    const texture = newLayerArray(size, depth);
    whole = true;
    texture.onUpdate = () => {
      if (uniform.value !== texture) return;
      whole = false;
      // Every pending layer went with this send: a whole one, or the layers listed as each was written.
      pending.clear();
    };
    // DO NOT keep the array's texels on the page (the arrays of a crowd, tens of MB): each send's own array, made from the layers' pictures.
    stageTexels(texture, Uint8Array, bytes * depth, 4, fill, { shared: false });
    return texture;
  };
  /** DO NOT cap the layers or hand out -1 when full: a brow without a layer is drawn as an opaque grey card */
  const take = (): number => {
    const reused = free.pop();
    if (reused !== undefined) return reused;
    const current = array();
    if (used >= current.image.depth) {
      // Sent whole on its first upload: every layer made again from its texture.
      const grown = fresh(current.image.depth * 2);
      cancelUploads([current]);
      current.dispose();
      uniform.value = grown;
    }
    return used++;
  };
  /** A picture's pixels at the layer's size, top row first as three uploads an image with `flipY` off. */
  const drawn = (texture: Texture): ArrayLike<number> | null => {
    const source = texture.image as { data?: unknown; width?: number; height?: number } | undefined;
    if (!source) return null;
    canvas ??= typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true })
      : document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const ctx = canvas;
    if (!ctx) return null;
    if (ctx.canvas.width !== size || ctx.canvas.height !== size) { ctx.canvas.width = size; ctx.canvas.height = size; }
    let image = source as CanvasImageSource;
    if (source.data instanceof Uint8Array || source.data instanceof Uint8ClampedArray) {
      // Raw pixels of another size: through a canvas of their own, then drawn to the layer's size.
      if (typeof ImageData !== 'function' || typeof OffscreenCanvas !== 'function') return null;
      const w = source.width ?? 0, h = source.height ?? 0;
      if (w * h * 4 !== source.data.length) return null;
      const own = new OffscreenCanvas(w, h);
      own.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(source.data), w, h), 0, 0);
      image = own;
    }
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    if (texture.flipY) ctx.setTransform(1, 0, 0, -1, 0, size);
    ctx.drawImage(image, 0, 0, size, size);
    ctx.restore();
    return ctx.getImageData(0, 0, size, size).data;
  };
  return {
    size,
    uniform,
    /** DO NOT keep layers by texture for good */
    layerOf(texture) {
      if (!texture) return -1;
      const known = held.get(texture);
      if (known) return known.layer;
      const pixels = ownBytes(texture, size) ?? drawn(texture);
      if (!pixels) return -1;
      const layer = take();
      const target = array();
      sourceOf[layer] = texture;
      pending.set(layer, pixels);
      if (!whole) target.addLayerUpdate(layer);
      target.needsUpdate = true;
      const release = (): void => {
        texture.removeEventListener('dispose', release);
        held.delete(texture);
        sourceOf[layer] = undefined;
        pending.delete(layer);
        free.push(layer);
      };
      held.set(texture, { layer, release });
      texture.addEventListener('dispose', release);
      return layer;
    },
    dispose() {
      for (const [texture, { release }] of held) texture.removeEventListener('dispose', release);
      held.clear();
      sourceOf.length = 0;
      pending.clear();
      free.length = 0;
      used = 0;
      if (uniform.value) cancelUploads([uniform.value]);
      uniform.value?.dispose();
      uniform.value = null;
    },
  };
}

const EYE_TEXTURES = ['eye-brown.webp', 'eye-brownlight.webp', 'eye-brownlight.webp', 'eye-green.webp', 'eye-blue.webp', 'eye-grey.webp'] as const;
const EYE_PALETTE = EYE_COLOURS.map((colour) => new Color(colour));

function eyeTextureFor(colour: number): string {
  const target = new Color(colour);
  let best = 0, distance = Infinity;
  for (let i = 0; i < EYE_PALETTE.length; i++) {
    const candidate = EYE_PALETTE[i]!;
    const d = (target.r - candidate.r) ** 2 + (target.g - candidate.g) ** 2 + (target.b - candidate.b) ** 2;
    if (d < distance) { best = i; distance = d; }
  }
  return EYE_TEXTURES[best]!;
}

/** Which skin texture and eye texture a person gets, and the tint matching the texture to their skin colour */
export function skinChoice(person: PersonSpec): { name: string; url: string; eyeFile: string; tint: Color } {
  const b = person.body;
  const origin = b.african > b.asian && b.african > b.caucasian ? 'african'
    : b.asian > b.caucasian ? 'asian' : 'caucasian';
  const age = b.age > 0.8 ? 'old' : b.age > 0.6 ? 'middleage' : 'young';
  const sex = b.gender < 0.5 ? 'female' : 'male';
  // Each person their own skin among those of their origin, sex and age
  type Skin = (typeof index.skins)[number] & { makeup?: boolean };
  const skins = index.skins as Skin[];
  const madeUp = sex === 'female' && (person.look.makeup ?? 0) > 0;
  const fits = (s: Skin): boolean => s.origin === origin && s.sex === sex && !!s.makeup === madeUp;
  const pool = skins.filter(s => fits(s) && s.age === age);
  const candidates = pool.length ? pool : skins.filter(fits).length ? skins.filter(fits)
    : skins.filter(s => s.origin === origin && s.sex === sex && !s.makeup);
  const skin = candidates[Math.abs(person.id * 2654435761 >>> 0) % candidates.length] ?? index.skins[0]!;
  const url = urls[`${skin.name}.webp`];
  if (!url) throw new Error(`Missing skin texture: ${skin.name}`);
  const average = new Color().setRGB(skin.average[0]! / 255, skin.average[1]! / 255, skin.average[2]! / 255, SRGBColorSpace);
  const desired = new Color(person.look.skin);
  // Match the texture's brightness to the person's skin and only a little of its hue
  const lum = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const bright = lum(desired) / Math.max(0.01, lum(average));
  const hue = 0.3;
  const tint = new Color().setRGB(
    bright + (desired.r / Math.max(0.01, average.r) - bright) * hue,
    bright + (desired.g / Math.max(0.01, average.g) - bright) * hue,
    bright + (desired.b / Math.max(0.01, average.b) - bright) * hue);
  return { name: skin.name, url, eyeFile: eyeTextureFor(person.look.eyes), tint };
}

/** A picture decoded off the main thread (`createImageBitmap`), as three's `ImageBitmapLoader` does */
async function decodedTexture(url: string, flipY: boolean): Promise<Texture> {
  if (typeof createImageBitmap !== 'function') {
    const map = await new TextureLoader().loadAsync(url);
    map.flipY = flipY;
    return map;
  }
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob, { imageOrientation: flipY ? 'flipY' : 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const map = new Texture(bitmap);
  map.flipY = false;
  map.needsUpdate = true;
  return map;
}

/** A skin texture by `skinChoice` name, shared while anyone holds it. */
function skinLeaseOf(name: string, url: string): TextureLease {
  return acquireTexture(SKINS, name, async () => {
    const map = await decodedTexture(url, true);
    map.colorSpace = SRGBColorSpace;
    return map;
  });
}

/** An eye or card texture from the proxies folder, shared while anyone holds it. */
function cardLeaseOf(file: string): TextureLease {
  return acquireTexture(CARDS, file, async () => {
    const map = await decodedTexture(proxyUrl(file), false);
    map.colorSpace = SRGBColorSpace;
    return map;
  });
}

/** Textures for a body drawn on its own (`proceduralCrowd.ts`): the skin and the eyes, held for the life of the page. */
export function skinTextures(name: string, url: string, eyeFile: string): Promise<[Texture, Texture]> {
  return Promise.all([skinLeaseOf(name, url).texture, cardLeaseOf(eyeFile).texture]);
}

/** An item's own texture for a piece drawn on its own (`proceduralCrowd.ts`) */
export function itemTexture(name: string, item: ProxyItem): Promise<Texture> | null {
  if (!item.textureFile) return null;
  return item.transparent ? cardLeaseOf(item.textureFile).texture : paddedGarment(name, item).texture;
}

/** Existing CC0 skin and eye packs, selected by the authored body and look. */
export async function loadSkinAppearance(person: PersonSpec): Promise<SkinAppearance> {
  const { name: skinName, url, eyeFile, tint } = skinChoice(person);
  const skinLease = skinLeaseOf(skinName, url);
  const skinRequest = skinLease.texture;
  const eyeLease = cardLeaseOf(eyeFile);
  const garmentNames = texturedGarments(person.look);
  const leases: TextureLease[] = [skinLease, eyeLease];
  let texture: Texture | undefined;
  // Every card item - hair, brows, lashes, a beard - with its own texture, so its strands are drawn per pixel.
  const cardTexture = async (name: string | undefined): Promise<Texture | undefined> => {
    if (!name || name === 'none') return undefined;
    const item = await loadProxyItem(name);
    if (!item.textureFile) return undefined;
    const lease = acquireTexture(CARDS, item.textureFile, async () => {
      const map = await new TextureLoader().loadAsync(proxyUrl(item.textureFile!));
      map.colorSpace = SRGBColorSpace;
      map.flipY = false;
      return map;
    });
    leases.push(lease);
    return lease.texture;
  };
  let hairTexture: Texture | undefined;
  let browTexture: Texture | undefined;
  let lashTexture: Texture | undefined;
  let beardTexture: Texture | undefined;
  let eyeTexture: Texture | undefined;
  const release = (): void => {
    for (const lease of leases) lease.release();
  };
  try {
    const garmentRequests = garmentNames.map(async name => {
      if (!name || name === 'none') return null;
      const item = await loadProxyItem(name);
      if (!item.textureFile) return null;
      const lease = paddedGarment(name, item);
      leases.push(lease);
      return lease.texture;
    });
    const beardName = (person.look.extras ?? []).find((e) => /beard|moustache|goatee|stubble|sideburn/i.test(e));
    // Every request begins now; all settle before cleanup so an error cannot leave a late texture or garment lease behind.
    const requests: Promise<Texture | null | undefined>[] = [skinRequest, ...garmentRequests,
      cardTexture(person.look.hairCut), cardTexture(person.look.brows),
      cardTexture(person.look.lashes), cardTexture(beardName), eyeLease.texture];
    const settled = await Promise.allSettled(requests);
    const loaded = settled.map((result) => result.status === 'fulfilled' ? result.value : null);
    texture = loaded[0] ?? undefined;
    const cardStart = garmentNames.length + 1;
    hairTexture = loaded[cardStart] ?? undefined;
    browTexture = loaded[cardStart + 1] ?? undefined;
    lashTexture = loaded[cardStart + 2] ?? undefined;
    beardTexture = loaded[cardStart + 3] ?? undefined;
    eyeTexture = loaded[cardStart + 4] ?? undefined;
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (!texture || !eyeTexture) throw new Error(`Missing loaded skin or eye texture: ${skinName}, ${eyeFile}`);
    const garments = loaded.slice(1, cardStart).map((map) => map ?? null);
    // The skin sent to the GPU ahead of the first frame this person is drawn in; the rest is copied into `PersonLayers`.
    queueUpload(texture);
    const appearance: SkinAppearance = { texture, eyeTexture, tint, hair: new Color(person.look.hair), garments,
      outfitTint: person.look.outfitTint == null ? null : new Color(person.look.outfitTint),
      ...(hairTexture ? { hairTexture } : {}),
      ...(browTexture ? { browTexture } : {}),
      ...(lashTexture ? { lashTexture } : {}),
      ...(beardTexture ? { beardTexture } : {}),
      beard: ['none', 'stubble', 'moustache', 'beard'].indexOf(person.look.beard ?? 'none'), makeup: person.look.makeup ?? 0 };
    RELEASE.set(appearance, release);
    return appearance;
  } catch (error) {
    release();
    throw error;
  }
}

const RELEASE = new WeakMap<SkinAppearance, () => void>();

/** Releases one user's textures without invalidating another person's shared garment. */
export function releaseSkinAppearance(appearance: SkinAppearance): void {
  const release = RELEASE.get(appearance);
  if (!release) return;
  RELEASE.delete(appearance);
  release();
}

/** Extends the crowd shader after its bone-palette hook, preserving one draw batch. */
export function applySkinAppearance(material: MeshStandardMaterial, geometry: BufferGeometry, skin: SkinAppearance, layers: PersonLayers): void {
  if (!geometry.hasAttribute('skinMask')) return;
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  const detail = { value: 1 };
  material.userData['appearanceDetail'] = detail;
  // ONE shader program for every dressed person
  const texturedHair = geometry.hasAttribute('hairMask');
  const texturedGarments = geometry.hasAttribute('garmentSlot');
  const texturedEyes = geometry.hasAttribute('eyeMask');
  const layered = texturedHair || texturedGarments || texturedEyes;
  // Which cards and garments have a texture, and where it is, is told by uniforms, never by the code: [array, layer]
  const eye: Place = texturedEyes ? layers.place(skin.eyeTexture) : NO_LAYER;
  const garments: Place[] = texturedGarments ? Array.from({ length: GARMENT_SLOTS }, (_, i) => layers.place(skin.garments[i])) : [];
  const cards: Place[] = texturedHair ? [skin.hairTexture, skin.browTexture, skin.lashTexture, skin.beardTexture].map((card) => layers.place(card)) : [];
  // The arrays these were copied into, sent ahead of the first frame this person is drawn in
  if (layered) queueUpload(layers.small.uniform.value, layers.large.uniform.value);
  if (texturedHair) { material.alphaToCoverage = true; material.alphaTest = 0.35; }
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.personSkin = { value: skin.texture };
    shader.uniforms.appearanceDetail = detail;
    shader.uniforms.personSkinTint = { value: skin.tint };
    shader.uniforms.faceOrigin = { value: geometry.userData['faceOrigin'] };
    shader.uniforms.faceScale = { value: geometry.userData['faceScale'] ?? 0.2 };
    shader.uniforms.beardColour = { value: skin.hair };
    shader.uniforms.beardStyle = { value: skin.beard };
    shader.uniforms.makeupAmount = { value: skin.makeup };
    if (layered) {
      shader.uniforms.personLayersSmall = layers.small.uniform;
      shader.uniforms.personLayersLarge = layers.large.uniform;
    }
    if (texturedEyes) shader.uniforms.personEye = { value: new Vector2(eye[0], eye[1]) };
    if (texturedGarments) {
      shader.uniforms.outfitDye = { value: skin.outfitTint ?? new Color(0xffffff) };
      shader.uniforms.outfitDyed = { value: skin.outfitTint ? 1 : 0 };
      shader.uniforms.garmentTextures = { value: garments.map((g) => g[0]) };
      shader.uniforms.garmentLayers = { value: garments.map((g) => g[1]) };
    }
    if (texturedHair) {
      shader.uniforms.cardTextures = { value: cards.map((c) => c[0]) };
      shader.uniforms.cardLayers = { value: cards.map((c) => c[1]) };
    }
    shader.vertexShader = `attribute float skinMask; uniform vec3 faceOrigin; uniform float faceScale; varying float vSkinMask; varying vec2 vSkinUv; varying vec3 vFace;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkinMask = skinMask; vSkinUv = uv; vFace = (position - faceOrigin) / faceScale;');
    shader.fragmentShader = `uniform float appearanceDetail; uniform sampler2D personSkin; uniform vec3 personSkinTint; uniform vec3 beardColour; uniform float beardStyle; uniform float makeupAmount; varying float vSkinMask; varying vec2 vSkinUv; varying vec3 vFace;\n${shader.fragmentShader}`
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (appearanceDetail > 0.5 && vSkinMask > 0.0) {
        vec3 skinColour = texture2D(personSkin, vSkinUv).rgb * personSkinTint;
        float front = smoothstep(-0.12, 0.02, vFace.z);
        float lips = (1.0 - smoothstep(0.65, 1.0, length(vFace.xy / vec2(0.22, 0.045)))) * front;
        float cheeks = exp(-30.0 * (pow(abs(vFace.x) - 0.32, 2.0) + pow(vFace.y - 0.18, 2.0))) * front;
        skinColour = mix(skinColour, skinColour * vec3(1.05, 0.55, 0.6), makeupAmount * max(lips, cheeks * 0.25));
        // Beards are fitted MakeHuman items now (wornItems), not paint
        diffuseColor.rgb = mix(diffuseColor.rgb, skinColour, vSkinMask);
        }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.5, vSkinMask * appearanceDetail);');
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', personLighting(texturedHair, texturedGarments))
      // The strands' direction, for the hair's highlights: from the card's texture coordinates as they run over the surface
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 dp1 = dFdx(-vViewPosition), dp2 = dFdy(-vViewPosition);
          vec2 du1 = dFdx(vSkinUv), du2 = dFdy(vSkinUv);
          vec3 along = dp2 * du1.x - dp1 * du2.x;
          personStrand = along - normal * dot(along, normal);
          personStrand = dot(personStrand, personStrand) > 1e-12 ? normalize(personStrand) : vec3(0.0, 1.0, 0.0);
          personSparkle = fract(sin(dot(floor(vSkinUv * vec2(160.0, 12.0)), vec2(12.9898, 78.233))) * 43758.5453);
        }`)
      // Skin, cloth and hair hardly mirror the sky
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.indirectSpecular *= personIndirect();`);
    shader.fragmentShader = `vec3 personStrand = vec3(0.0, 1.0, 0.0); float personSparkle = 0.5;\n${shader.fragmentShader}`;
    if (texturedEyes) {
      shader.vertexShader = `attribute float eyeMask; varying float vEyeMask;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEyeMask = eyeMask;');
      // The cornea's atlas pixels are transparent black
      shader.fragmentShader = `uniform vec2 personEye; varying float vEyeMask;\n${shader.fragmentShader}`
        .replace('#include <color_fragment>', '#include <color_fragment>\nif (vEyeMask > 0.5 && personEye.x > 0.5) { vec4 eyeTexel = personLayer(personEye.x, personEye.y, vSkinUv); diffuseColor.rgb = eyeTexel.rgb; diffuseColor.a = eyeTexel.a; }')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (vEyeMask > 0.5) roughnessFactor = 0.08;');
    }
    if (texturedHair) {
      // Hair (0), brows (1), lashes (2) and beard (3), each from its layer.
      const sample = (i: number): string => `(cardTextures[${i}] > 0.5 ? personLayer(cardTextures[${i}], cardLayers[${i}], vSkinUv) : ${
        i === 2 ? 'vec4(0.2, 0.2, 0.2, 1.0)' : 'vec4(0.5, 0.5, 0.5, 1.0)'})`;
      const size = (i: number): string => `(cardTextures[${i}] > 0.5 ? personLayerSize(cardTextures[${i}]) : vec2(1.0))`;
      // Brows and lashes are cards laid on the skin.
      shader.vertexShader = `attribute float hairMask; varying float vHairMask;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vHairMask = hairMask;
float cardSlot = floor(hairMask + 0.5);
bool faceCard = cardSlot > 1.5 && cardSlot < 3.5;
if (faceCard) transformed += normalize(objectNormal) * 0.002;`)
        .replace('#include <project_vertex>', `#include <project_vertex>
if (faceCard) {
  float bodyScale = length(modelViewMatrix[0].xyz);
  #ifdef USE_INSTANCING
    bodyScale *= length(instanceMatrix[0].xyz);
  #endif
  mvPosition.z += 0.004 * bodyScale;
  gl_Position = projectionMatrix * mvPosition;
}`);
      shader.fragmentShader = `uniform float cardTextures[4]; uniform float cardLayers[4]; varying float vHairMask;\n${shader.fragmentShader}`
        .replace('#include <alphatest_fragment>', `
          // A card: hair (1), brows (2), lashes (3) or a beard (4), each from its own texture.
          vec2 cardDx = dFdx(vSkinUv), cardDy = dFdy(vSkinUv);
          float eyeSlot = floor(vHairMask + 0.5);
          if (eyeSlot > 4.5) {
            // The eyeball: wet.
          } else
          if (vHairMask > 0.5 && appearanceDetail > 0.5) {
            vec4 cardTexel = vec4(0.0);
            float slot = floor(vHairMask + 0.5);
            if (slot < 1.5) { cardTexel = ${sample(0)}; }
            else if (slot < 2.5) { cardTexel = ${sample(1)}; }
            else if (slot < 3.5) { cardTexel = ${sample(2)}; }
            else { cardTexel = ${sample(3)}; }
            // Fine strands thin out and vanish in a texture's smaller mips: a
            // brow seen from a little way off was a few dashes. Its alpha is
            // scaled up by the mip level the pixel reads, keeping the strands'
            // coverage (Ben Golus, "Anti-aliased Alpha Test"; I. Castano,
            // "Computing Alpha Mipmaps"; as OpenMW's alpha.glsl does it).
            vec2 cardSize = slot < 1.5 ? ${size(0)} : slot < 2.5 ? ${size(1)}
              : slot < 3.5 ? ${size(2)} : ${size(3)};
            float cardMip = max(0.0, 0.5 * log2(max(dot(cardDx * cardSize, cardDx * cardSize), dot(cardDy * cardSize, cardDy * cardSize))));
            cardTexel.a *= 1.0 + cardMip * 0.25;
            if (slot > 1.5 && slot < 2.5 && cardTextures[1] > 0.5) cardTexel.a = min(1.0, cardTexel.a * 1.55);
            if (slot > 2.5 && slot < 3.5 && cardTextures[2] > 0.5) cardTexel.a *= 0.65;
            float strand = dot(cardTexel.rgb, vec3(0.3, 0.59, 0.11));
            // The source's grey strand highlights are sRGB, now sampled in linear light.
            vec3 hairCol = slot > 2.5 && slot < 3.5 ? vec3(0.03)
              : beardColour * (0.55 + 0.95 * strand) + (slot < 1.5 ? vec3(0.03 * sqrt(strand)) : vec3(0.0));
            diffuseColor.rgb = mix(beardColour * 0.55, hairCol, smoothstep(0.25, 0.75, cardTexel.a));
            diffuseColor.a = cardTexel.a;
          }
          #include <alphatest_fragment>`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (vHairMask > 4.5) roughnessFactor = 0.06;\nelse if (vHairMask > 0.5) roughnessFactor = 0.42;');
    }
    if (texturedGarments) {
      shader.vertexShader = `attribute float garmentSlot; varying float vGarmentSlot;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGarmentSlot = garmentSlot;');
      shader.fragmentShader = `uniform vec3 outfitDye; uniform float outfitDyed; uniform float garmentTextures[${GARMENT_SLOTS}]; uniform float garmentLayers[${GARMENT_SLOTS}]; varying float vGarmentSlot;\n${shader.fragmentShader}`;
      const sample = Array.from({ length: GARMENT_SLOTS }, (_, i) => `
        if (appearanceDetail > 0.5 && abs(vGarmentSlot - ${i + 1}.0) < 0.1) {
          vec3 cloth = garmentTextures[${i}] > 0.5 ? personLayer(garmentTextures[${i}], garmentLayers[${i}], vSkinUv).rgb : vec3(128.0 / 255.0);
          ${i === 0 ? 'float shade = 0.3 + 1.15 * dot(cloth, vec3(0.3, 0.59, 0.11)); cloth = mix(cloth, min(vec3(1.0), outfitDye * shade), outfitDyed * 0.8);' : ''}
          diffuseColor.rgb = cloth;
        }`).join('\n');
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `${sample}\n#include <alphatest_fragment>`)
        // Woven cloth is rough: no glossy highlight on a T-shirt.
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (vGarmentSlot > 0.5 && appearanceDetail > 0.5) roughnessFactor = max(roughnessFactor, 0.9);');
    }
    if (layered) shader.fragmentShader = `${LAYER_READ}\n${shader.fragmentShader}`;
  };
  material.customProgramCacheKey = () => `${key}-textured-skin-v8-hair${texturedHair}-garments${texturedGarments}-eyes${texturedEyes}`;
}

/** Where a picture is drawn from: [0 none, 1 the small array or 2 the large one, its layer]. */
type Place = readonly [number, number];
/** No texture: drawn in the slot's plain colour. */
const NO_LAYER: Place = [0, 0];

/** A layer of a person's arrays (`PersonLayers`): `atlas` 1 the small one, 2 the large; same filtering as each texture had alone */
const LAYER_READ = `uniform sampler2DArray personLayersSmall; uniform sampler2DArray personLayersLarge;
vec4 personLayer(float atlas, float layer, vec2 uv) {
  return atlas > 1.5 ? texture(personLayersLarge, vec3(uv, layer)) : texture(personLayersSmall, vec3(uv, layer));
}
vec2 personLayerSize(float atlas) {
  return atlas > 1.5 ? vec2(textureSize(personLayersLarge, 0).xy) : vec2(textureSize(personLayersSmall, 0).xy);
}`;

/** three's physical lighting, with a person's own terms */
export function personLighting(hair: boolean, garments: boolean): string {
  const chunk = ShaderChunk.lights_physical_pars_fragment;
  const specular = 'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;';
  const diffuse = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
  if (!chunk.includes(specular) || !chunk.includes(diffuse)) throw new Error('three lighting chunk changed: person lighting must be updated');
  const hairWeight = hair ? '(abs(vHairMask - 1.0) < 0.5 ? appearanceDetail : 0.0)' : '0.0';
  const clothWeight = garments ? '(vGarmentSlot > 0.5 ? appearanceDetail : 0.0)' : '0.0';
  const helpers = `
float personStrandSpecular(vec3 T, vec3 H, float exponent) {
  float dotTH = dot(T, H);
  float sinTH = sqrt(max(0.0, 1.0 - dotTH * dotTH));
  return smoothstep(-1.0, 0.0, dotTH) * pow(sinTH, exponent);
}
float personHairWeight() { return ${hairWeight}; }
float personClothWeight() { return ${clothWeight}; }
float personIndirect() {
  float skin = vSkinMask * appearanceDetail;
  return mix(1.0, 0.25, max(max(skin, personHairWeight()), personClothWeight()));
}
`;
  return helpers + chunk
    .replace(specular, `{
      float skinW = vSkinMask * appearanceDetail;
      float hairW = personHairWeight();
      vec3 spec = irradiance * specularBRDF * material.multiScatteringCompensation;
      spec *= mix(1.0, 0.35, skinW) * mix(1.0, 0.3, personClothWeight());
      if (hairW > 0.0) {
        vec3 H = normalize(directLight.direction + geometryViewDir);
        float shift = personSparkle - 0.5;
        vec3 t1 = normalize(personStrand + (-0.12 + 0.2 * shift) * geometryNormal);
        vec3 t2 = normalize(personStrand + (0.22 + 0.2 * shift) * geometryNormal);
        float lit = saturate(dot(geometryNormal, directLight.direction) * 0.5 + 0.5);
        vec3 strands = (vec3(0.035) + material.diffuseColor * 0.25) * personStrandSpecular(t1, H, 140.0)
          + material.diffuseColor * 0.55 * step(0.4, personSparkle) * personStrandSpecular(t2, H, 26.0);
        spec = mix(spec, strands * lit * directLight.color, hairW);
      }
      reflectedLight.directSpecular += spec;
    }`)
    .replace(diffuse, `{
      float skinW = vSkinMask * appearanceDetail;
      float hairW = personHairWeight();
      float rawNL = dot(geometryNormal, directLight.direction);
      vec3 lit = irradiance;
      if (skinW > 0.0) {
        float wrapped = saturate((rawNL + 0.4) / 1.4);
        float scatter = smoothstep(0.0, 0.3, wrapped) * smoothstep(0.62, 0.3, wrapped);
        lit = mix(lit, (vec3(wrapped) + scatter * vec3(0.32, 0.07, 0.04)) * directLight.color, skinW);
      }
      if (hairW > 0.0) lit = mix(lit, mix(0.25, 1.0, saturate(rawNL)) * directLight.color, hairW);
      reflectedLight.directDiffuse += lit * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
    }`);
}

/** How far each island of a garment's texture is grown into its background, pixels. */
const GARMENT_PAD = 12;
interface TextureEntry { promise: Promise<Texture>; texture?: Texture; refs: number }
interface TextureLease { texture: Promise<Texture>; release(): void }
const PADDED = new Map<string, TextureEntry>();
const SKINS = new Map<string, TextureEntry>();
const CARDS = new Map<string, TextureEntry>();

function acquireTexture(cache: Map<string, TextureEntry>, key: string, build: () => Promise<Texture>): TextureLease {
  let entry = cache.get(key);
  if (!entry) {
    const work = build();
    const current: TextureEntry = { promise: work, refs: 0 };
    current.promise = work.then((texture) => {
      current.texture = texture;
      return texture;
    }, (error: unknown) => {
      if (cache.get(key) === current) cache.delete(key);
      throw error;
    });
    cache.set(key, current);
    entry = current;
  }
  const held = entry;
  held.refs++;
  let released = false;
  return {
    texture: held.promise,
    release() {
      if (released) return;
      released = true;
      if (--held.refs !== 0) return;
      if (cache.get(key) === held) cache.delete(key);
      if (held.texture) {
        cancelUploads([held.texture]);
        held.texture.dispose();
      } else {
        void held.promise.then((texture) => {
          cancelUploads([texture]);
          texture.dispose();
        }, () => {});
      }
    },
  };
}

/** A garment's texture with every UV island grown outward into the background */
function paddedGarment(name: string, item: ProxyItem): TextureLease {
  return acquireTexture(PADDED, name, async () => {
      const url = proxyUrl(item.textureFile!);
      const plain = async (): Promise<Texture> => {
        const map = await new TextureLoader().loadAsync(url);
        map.colorSpace = SRGBColorSpace; map.flipY = false;
        return map;
      };
      const uvs = item.pack.uvs;
      if (!uvs || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return plain();
      // Fetched, decoded, read and padded in the worker, the pixels moved back and handed to the GPU as they are
      const sheet = await padGarmentFileInWorker({ url: new URL(url, location.href).href, uvs, index: item.pack.index, padding: GARMENT_PAD });
      if (sheet) {
        // DataTexture's own defaults are nearest and no mipmaps (three r186): set back to what an image texture gets.
        const map = new DataTexture(sheet.pixels, sheet.width, sheet.height);
        map.magFilter = LinearFilter;
        map.minFilter = LinearMipmapLinearFilter;
        map.generateMipmaps = true;
        map.unpackAlignment = 4;
        map.colorSpace = SRGBColorSpace;
        map.flipY = false;
        map.needsUpdate = true;
        return map;
      }
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const W = bitmap.width, H = bitmap.height;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return plain();
      ctx.drawImage(bitmap, 0, 0);
      const image = ctx.getImageData(0, 0, W, H);
      const pixels = await padGarmentInWorker({ pixels: image.data, width: W, height: H,
        uvs, index: item.pack.index, padding: GARMENT_PAD });
      if (pixels !== image.data) image.data.set(pixels);
      ctx.putImageData(image, 0, 0);
      const map = new CanvasTexture(canvas);
      map.colorSpace = SRGBColorSpace;
      map.flipY = false;
      return map;
    });
}

/** Maximum garment slots authored by `garmentSlots.ts`; empty slots use a constant in the shader. */
const GARMENT_SLOTS = MAX_TEXTURED;
