import { CanvasTexture, Color, DataArrayTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, ShaderChunk, SRGBColorSpace, Texture, TextureLoader, Vector2, type BufferGeometry, type MeshStandardMaterial } from 'three';
import { EYE_COLOURS, type PersonSpec } from '@people/spec';
import { loadProxyItem, proxyUrl, type ProxyItem } from '@people/body/proxy';
import { MAX_TEXTURED, texturedGarments } from './garmentSlots';
import { padGarmentFileInWorker, padGarmentInWorker } from './garmentPaddingPool';
import { cancelUploads, queueUpload } from '../uploads';
import index from '../../../public/models/people/skins/index.json';
// The skin textures' URLs by file name, one module for the folder
// (`model-urls-plugin.ts`): an eager glob made each file a module of its own.
import urls from 'virtual:model-urls/people/skins?ext=webp';

export interface SkinAppearance { texture: Texture; eyeTexture: Texture; tint: Color; hair: Color; hairTexture?: Texture; browTexture?: Texture; lashTexture?: Texture; beardTexture?: Texture; garments: (Texture | null)[]; outfitTint: Color | null; beard: number; makeup: number }

/**
 * The face's small cards - brows and lashes, 256 px each - share one array
 * texture, a layer per item (WebGL2 `sampler2DArray`, three's
 * `DataArrayTexture` with `addLayerUpdate`). Each had a sampler of its own,
 * and a close body with its face's morphs used 17 of the 16 a fragment
 * shader has (ANGLE's limit, on the RTX as on the Intel): three warned every
 * frame and the 17th - the sun's shadow - was not bound (2026-10-10).
 */
const FACE_CARD_SIZE = 256;
const FACE_CARD_LAYERS = 24;
let faceCards: DataArrayTexture | null = null;
const faceCardLayers = new Map<Texture, number>();
let faceCardCanvas: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

function faceCardArray(): DataArrayTexture {
  if (!faceCards) {
    faceCards = new DataArrayTexture(new Uint8Array(FACE_CARD_SIZE * FACE_CARD_SIZE * 4 * FACE_CARD_LAYERS), FACE_CARD_SIZE, FACE_CARD_SIZE, FACE_CARD_LAYERS);
    faceCards.colorSpace = SRGBColorSpace;
    faceCards.magFilter = LinearFilter;
    faceCards.minFilter = LinearMipmapLinearFilter;
    faceCards.generateMipmaps = true;
    faceCards.unpackAlignment = 4;
    faceCards.needsUpdate = true;
  }
  return faceCards;
}

/** The layer a face card's texture is drawn in, copied there the first time it is asked for; -1 without one. */
function faceCardLayer(texture: Texture | undefined): number {
  if (!texture) return -1;
  const known = faceCardLayers.get(texture);
  if (known !== undefined) return known;
  const image = texture.image as CanvasImageSource | undefined;
  if (!image || faceCardLayers.size >= FACE_CARD_LAYERS) return -1;
  faceCardCanvas ??= typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(FACE_CARD_SIZE, FACE_CARD_SIZE).getContext('2d', { willReadFrequently: true })
    : document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const ctx = faceCardCanvas;
  if (!ctx) return -1;
  if (ctx.canvas.width !== FACE_CARD_SIZE) { ctx.canvas.width = FACE_CARD_SIZE; ctx.canvas.height = FACE_CARD_SIZE; }
  ctx.clearRect(0, 0, FACE_CARD_SIZE, FACE_CARD_SIZE);
  ctx.drawImage(image, 0, 0, FACE_CARD_SIZE, FACE_CARD_SIZE);
  const layer = faceCardLayers.size;
  const array = faceCardArray();
  (array.image.data as Uint8Array).set(ctx.getImageData(0, 0, FACE_CARD_SIZE, FACE_CARD_SIZE).data, layer * FACE_CARD_SIZE * FACE_CARD_SIZE * 4);
  array.addLayerUpdate(layer);
  array.needsUpdate = true;
  faceCardLayers.set(texture, layer);
  return layer;
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

/**
 * Which skin texture and eye texture a person gets, and the tint matching the
 * texture to their skin colour: chosen by origin, sex and age.
 */
export function skinChoice(person: PersonSpec): { name: string; url: string; eyeFile: string; tint: Color } {
  const b = person.body;
  const origin = b.african > b.asian && b.african > b.caucasian ? 'african'
    : b.asian > b.caucasian ? 'asian' : 'caucasian';
  const age = b.age > 0.8 ? 'old' : b.age > 0.6 ? 'middleage' : 'young';
  const sex = b.gender < 0.5 ? 'female' : 'male';
  // Each person their own skin among those of their origin, sex and age (the
  // system pack had one per kind, so a street of one face), and a made-up
  // face for the women who wear make-up.
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
  // Match the texture's brightness to the person's skin and only a little of
  // its hue: the texture, chosen by origin, carries a natural hue of its own.
  // Scaling each channel to the target turned a rosy (made-up) texture green.
  const lum = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const bright = lum(desired) / Math.max(0.01, lum(average));
  const hue = 0.3;
  const tint = new Color().setRGB(
    bright + (desired.r / Math.max(0.01, average.r) - bright) * hue,
    bright + (desired.g / Math.max(0.01, average.g) - bright) * hue,
    bright + (desired.b / Math.max(0.01, average.b) - bright) * hue);
  return { name: skin.name, url, eyeFile: eyeTextureFor(person.look.eyes), tint };
}

/**
 * A picture decoded off the main thread (`createImageBitmap`), as three's
 * `ImageBitmapLoader` does: an <img> is decoded when it is first sent to the
 * graphics card, in the frame, 11-14 ms a skin (docs/performance.md #31). A
 * bitmap ignores `flipY`, so the flip is made while decoding.
 */
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

/**
 * Textures for a body drawn on its own (`proceduralCrowd.ts`): the skin and
 * the eyes, held for the life of the page.
 */
export function skinTextures(name: string, url: string, eyeFile: string): Promise<[Texture, Texture]> {
  return Promise.all([skinLeaseOf(name, url).texture, cardLeaseOf(eyeFile).texture]);
}

/**
 * An item's own texture for a piece drawn on its own (`proceduralCrowd.ts`):
 * padded for a garment, plain for a card with holes; null when it has none.
 * Held for the life of the page.
 */
export function itemTexture(name: string, item: ProxyItem): Promise<Texture> | null {
  if (!item.textureFile) return null;
  return item.transparent ? cardLeaseOf(item.textureFile).texture : paddedGarment(name, item).texture;
}

/**
 * A garment's texture padded (its UV islands grown out), whatever its alpha:
 * drawn opaque, a garment never shows the sheet's background at a seam. Held
 * for the life of the page; null without a texture.
 */
export function paddedItemTexture(name: string, item: ProxyItem): Promise<Texture> | null {
  return item.textureFile ? paddedGarment(name, item).texture : null;
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
  // Every card item - hair, brows, lashes, a beard - with its own texture,
  // so its strands are drawn per pixel.
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
    // Every request begins now; all settle before cleanup so an error cannot
    // leave a late texture or garment lease behind.
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
    // Sent to the GPU ahead of the first frame this person is drawn in.
    // Brows and lashes are drawn from the face cards' array (`faceCardLayer`), not uploaded on their own.
    queueUpload(texture, eyeTexture, ...garments, hairTexture, beardTexture);
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
export function applySkinAppearance(material: MeshStandardMaterial, geometry: BufferGeometry, skin: SkinAppearance): void {
  if (!geometry.hasAttribute('skinMask')) return;
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  const detail = { value: 1 };
  material.userData['appearanceDetail'] = detail;
  // ONE shader program for every dressed person: the same samplers and the
  // same code whoever wears what, a blank texture where a slot is empty and
  // flags where a card has no texture of its own. Keyed on what each person
  // wore, a new mix of garments compiled a new program the moment its
  // wearer came into view: a 50-200 ms hitch each time.
  const texturedHair = geometry.hasAttribute('hairMask');
  const texturedGarments = geometry.hasAttribute('garmentSlot');
  const texturedEyes = geometry.hasAttribute('eyeMask');
  // Which cards and garments have a texture is told by uniforms, never by the
  // code: three shares one program between every material of the same key
  // (WebGLPrograms.acquireProgram) and keeps the uniforms per material
  // (WebGLRenderer.getProgram). A slot without a texture is bound to a blank.
  const cards = [skin.hairTexture, skin.browTexture, skin.lashTexture, skin.beardTexture];
  const cardNames = ['personHair', 'personBrow', 'personLash', 'personBeard'];
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
    if (texturedEyes) shader.uniforms.personEyes = { value: skin.eyeTexture };
    if (texturedGarments) {
      shader.uniforms.outfitDye = { value: skin.outfitTint ?? new Color(0xffffff) };
      shader.uniforms.outfitDyed = { value: skin.outfitTint ? 1 : 0 };
      for (let i = 0; i < GARMENT_SLOTS; i++) shader.uniforms[`garment${i}`] = { value: skin.garments[i] ?? BLANK };
      shader.uniforms.garmentTextures = { value: Array.from({ length: GARMENT_SLOTS }, (_, i) => (skin.garments[i] ? 1 : 0)) };
    }
    if (texturedHair) {
      shader.uniforms.personHair = { value: cards[0] ?? BLANK };
      shader.uniforms.personBeard = { value: cards[3] ?? BLANK };
      const brow = faceCardLayer(cards[1]), lash = faceCardLayer(cards[2]);
      shader.uniforms.faceCards = { value: faceCardArray() };
      shader.uniforms.faceCardLayer = { value: new Vector2(Math.max(0, brow), Math.max(0, lash)) };
      shader.uniforms.cardTextures = { value: [cards[0] ? 1 : 0, brow >= 0 ? 1 : 0, lash >= 0 ? 1 : 0, cards[3] ? 1 : 0] };
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
        // Beards are fitted MakeHuman items now (wornItems), not paint: a
        // painted stubble region missed the jaw and lay across the nose as a
        // dark mask.
        diffuseColor.rgb = mix(diffuseColor.rgb, skinColour, vSkinMask);
        }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.5, vSkinMask * appearanceDetail);');
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', personLighting(texturedHair, texturedGarments))
      // The strands' direction, for the hair's highlights: from the card's
      // texture coordinates as they run over the surface (the strands lie
      // along the texture's v), derived per pixel from screen derivatives.
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 dp1 = dFdx(-vViewPosition), dp2 = dFdy(-vViewPosition);
          vec2 du1 = dFdx(vSkinUv), du2 = dFdy(vSkinUv);
          vec3 along = dp2 * du1.x - dp1 * du2.x;
          personStrand = along - normal * dot(along, normal);
          personStrand = dot(personStrand, personStrand) > 1e-12 ? normalize(personStrand) : vec3(0.0, 1.0, 0.0);
          personSparkle = fract(sin(dot(floor(vSkinUv * vec2(160.0, 12.0)), vec2(12.9898, 78.233))) * 43758.5453);
        }`)
      // Skin, cloth and hair hardly mirror the sky: the environment's
      // reflection on them was the plastic sheen over every person.
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.indirectSpecular *= personIndirect();`);
    shader.fragmentShader = `vec3 personStrand = vec3(0.0, 1.0, 0.0); float personSparkle = 0.5;\n${shader.fragmentShader}`;
    if (texturedEyes) {
      shader.vertexShader = `attribute float eyeMask; varying float vEyeMask;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEyeMask = eyeMask;');
      // The cornea's atlas pixels are transparent black; their alpha must
      // reach the existing alpha test or they cover the iris as black discs.
      shader.fragmentShader = `uniform sampler2D personEyes; varying float vEyeMask;\n${shader.fragmentShader}`
        .replace('#include <color_fragment>', '#include <color_fragment>\nif (vEyeMask > 0.5) { vec4 eyeTexel = texture2D(personEyes, vSkinUv); diffuseColor.rgb = eyeTexel.rgb; diffuseColor.a = eyeTexel.a; }')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (vEyeMask > 0.5) roughnessFactor = 0.08;');
    }
    if (texturedHair) {
      // Hair and beard from their own textures; brows (1) and lashes (2) from the face cards' array.
      const declarations = 'uniform sampler2D personHair; uniform sampler2D personBeard; uniform sampler2DArray faceCards; uniform vec2 faceCardLayer;';
      const read = (i: number): string => i === 1 ? 'texture(faceCards, vec3(vSkinUv, faceCardLayer.x))'
        : i === 2 ? 'texture(faceCards, vec3(vSkinUv, faceCardLayer.y))' : `texture2D(${cardNames[i]}, vSkinUv)`;
      const sample = (i: number): string => `(cardTextures[${i}] > 0.5 ? ${read(i)} : ${
        i === 2 ? 'vec4(0.2, 0.2, 0.2, 1.0)' : 'vec4(0.5, 0.5, 0.5, 1.0)'})`;
      const size = (i: number): string => `(cardTextures[${i}] > 0.5 ? vec2(${i === 1 || i === 2 ? 'textureSize(faceCards, 0).xy' : `textureSize(${cardNames[i]}, 0)`}) : vec2(1.0))`;
      // Brows and lashes are cards laid on the skin. Laid exactly on it, the
      // skin won the depth test over most of them - the brows sank into the
      // face in dashes - and the crowd's camera, with its long depth range,
      // cannot tell millimetres apart. As layered surfaces are fixed in
      // character pipelines: lifted a little off the skin along the normal,
      // and drawn with a small depth bias towards the eye (a decal's bias),
      // both in proportion to the body's scale.
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
      shader.fragmentShader = `${declarations} uniform float cardTextures[4]; varying float vHairMask;\n${shader.fragmentShader}`
        .replace('#include <alphatest_fragment>', `
          // A card: hair (1), brows (2), lashes (3) or a beard (4), each from its
          // own texture. The strands take the person's hair colour, shaded by
          // the texture's own light and dark; where the card fades out its
          // colour stays the hair's, not the texture's white backing (the white
          // fringe round every head of hair).
          // The card's texture footprint per pixel, taken before any branch
          // (derivatives need every pixel of a quad to run them).
          vec2 cardDx = dFdx(vSkinUv), cardDy = dFdy(vSkinUv);
          float eyeSlot = floor(vHairMask + 0.5);
          if (eyeSlot > 4.5) {
            // The eyeball: wet. MakeHuman's own advice for eyes that look
            // dead - a hard glossy highlight over them (static.makehumancommunity
            // .org, "The eyes look flat and dead"); the body's matte 0.88 made
            // them dull grey glass.
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
            // The source's grey strand highlights are sRGB, now sampled in
            // linear light. Multiplying them by dark hair dye erased them.
            // Keep a restrained light-coloured reflection on hair cards only.
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
      const uniforms = Array.from({ length: GARMENT_SLOTS }, (_, i) => `uniform sampler2D garment${i};`).join('\n');
      shader.fragmentShader = `uniform vec3 outfitDye; uniform float outfitDyed; uniform float garmentTextures[${GARMENT_SLOTS}]; varying float vGarmentSlot; ${uniforms}\n${shader.fragmentShader}`;
      const sample = Array.from({ length: GARMENT_SLOTS }, (_, i) => `
        if (appearanceDetail > 0.5 && abs(vGarmentSlot - ${i + 1}.0) < 0.1) {
          vec3 cloth = garmentTextures[${i}] > 0.5 ? texture2D(garment${i}, vSkinUv).rgb : vec3(128.0 / 255.0);
          ${i === 0 ? 'float shade = 0.3 + 1.15 * dot(cloth, vec3(0.3, 0.59, 0.11)); cloth = mix(cloth, min(vec3(1.0), outfitDye * shade), outfitDyed * 0.8);' : ''}
          diffuseColor.rgb = cloth;
        }`).join('\n');
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `${sample}\n#include <alphatest_fragment>`)
        // Woven cloth is rough: no glossy highlight on a T-shirt.
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (vGarmentSlot > 0.5 && appearanceDetail > 0.5) roughnessFactor = max(roughnessFactor, 0.9);');
    }
  };
  material.customProgramCacheKey = () => `${key}-textured-skin-v7-hair${texturedHair}-garments${texturedGarments}-eyes${texturedEyes}`;
}

/**
 * three's physical lighting, with a person's own terms (three r186's
 * `RE_Direct_Physical`; the strings are checked, so a three upgrade that
 * moves them fails loudly instead of silently dropping the look):
 *
 * - Skin: wrap lighting with a reddish scatter band at the terminator, the
 *   real-time stand-in for light travelling under the skin (Green, "Real-Time
 *   Approximations to Subsurface Scattering", GPU Gems 1 ch. 16), and a
 *   softer, weaker specular - skin is not glossy plastic.
 * - Hair (card slots 1 and 4, hair and beard): Kajiya-Kay strand lighting
 *   with Scheuermann's two shifted highlights (ATI, "Hair Rendering and
 *   Shading", GDC 2004): a white primary highlight nudged towards the tips, a
 *   wider secondary one tinted by the hair and broken up into sparkles, and
 *   the diffuse term's shadow edge softened (lerp(0.25, 1, N.L)).
 */
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

/**
 * A garment's texture with every UV island grown outward into the background
 * (texture padding, as every game asset pipeline does). Unpadded, the smaller
 * mip levels mixed each island with the background and with its neighbours
 * on the sheet, and every seam - the shoulder of every shirt - was drawn as a
 * brown line. The islands are the garment's own UV triangles, rasterised.
 */
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
      // Fetched, decoded, read and padded in the worker, the pixels moved back
      // and handed to the GPU as they are (a DataTexture: no canvas). Read here
      // - drawn into a canvas, read back, padded, written back - a 2048-pixel
      // sheet was a 100-220 ms task as the first person wearing it came close.
      const sheet = await padGarmentFileInWorker({ url: new URL(url, location.href).href, uvs, index: item.pack.index, padding: GARMENT_PAD });
      if (sheet) {
        // DataTexture's own defaults are nearest and no mipmaps (three r186):
        // set back to what an image texture gets.
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

/** What an empty card or garment slot is bound to: never read (its flag is 0), but a sampler must have a texture. */
const BLANK = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
BLANK.needsUpdate = true;
