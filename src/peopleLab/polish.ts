import { CanvasTexture, Color, type BufferAttribute, type MeshStandardMaterial, type SkinnedMesh, type Texture } from 'three';
import type { PersonLook } from '@people/spec';

/** THE LAB'S FINISH on a person the game built (`createPersonRig`): what the lab shows better than the game does today, without changing the game */

/** `personRig.ts` EYE_SLOT: the eyeballs' mark in `hairMask`. */
const EYE_SLOT = 5;

/** The rig tints the scalp in the hair's colour, and that paint runs down onto the forehead: it is kept on the scalp, taken off the forehead and face. */
function clearScalpPaint(mesh: SkinnedMesh, look: PersonLook): void {
  const g = mesh.geometry;
  const body = g.groups[0];
  const skinMask = g.getAttribute('skinMask') as BufferAttribute | undefined;
  const colour = g.getAttribute('color') as BufferAttribute | undefined;
  const hairMask = g.getAttribute('hairMask') as BufferAttribute | undefined;
  if (!body || !skinMask || !colour || !g.index) return;
  const skin = new Color(look.skin);
  const position = g.getAttribute('position') as BufferAttribute;
  const seen = new Set<number>();
  const painted: number[] = [];
  for (let i = body.start; i < body.start + body.count; i++) {
    const v = g.index.getX(i);
    if (seen.has(v)) continue;
    seen.add(v);
    if (hairMask && Math.round(hairMask.getX(v)) === EYE_SLOT) continue;
    if (skinMask.getX(v) < 0.999) painted.push(v);
  }
  // The paint stays on the scalp (under the hair, so no bald patch shows between strands) and comes off the forehead and face only:
  // above ~7 cm under the crown at the front, down to the nape behind the head's middle.
  let top = -Infinity, zSum = 0;
  for (const v of painted) top = Math.max(top, position.getY(v));
  for (const v of painted) zSum += position.getZ(v);
  const midZ = painted.length ? zSum / painted.length : 0;
  for (const v of painted) {
    const y = position.getY(v), z = position.getZ(v);
    if (y > top - 0.07 || (z < midZ && y > top - 0.17)) continue;
    skinMask.setX(v, 1);
    colour.setXYZ(v, skin.r, skin.g, skin.b);
  }
  skinMask.needsUpdate = true;
  colour.needsUpdate = true;
}

/** Shading smooth across seams: copies of one point (split by the texture's seams) take one normal, within the same part (skin, an item, the eyes). */
function smoothSeams(mesh: SkinnedMesh): void {
  const g = mesh.geometry;
  const position = g.getAttribute('position') as BufferAttribute;
  const normal = g.getAttribute('normal') as BufferAttribute | undefined;
  if (!normal) return;
  const part = (g.getAttribute('garmentSlot') ?? g.getAttribute('hairMask')) as BufferAttribute | undefined;
  const hair = g.getAttribute('hairMask') as BufferAttribute | undefined;
  const groups = new Map<string, number[]>();
  for (let v = 0; v < position.count; v++) {
    const key = `${Math.round(position.getX(v) * 1e4)},${Math.round(position.getY(v) * 1e4)},${Math.round(position.getZ(v) * 1e4)}`
      + `|${part ? Math.round(part.getX(v)) : 0}|${hair ? Math.round(hair.getX(v)) : 0}`;
    const list = groups.get(key);
    if (list) list.push(v); else groups.set(key, [v]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    let x = 0, y = 0, z = 0;
    for (const v of list) { x += normal.getX(v); y += normal.getY(v); z += normal.getZ(v); }
    const l = Math.hypot(x, y, z) || 1;
    for (const v of list) normal.setXYZ(v, x / l, y / l, z / l);
  }
  normal.needsUpdate = true;
}

/** `personRig.ts` card slots in `hairMask`: 1 is the hair, 3 the lashes. */
const HAIR_SLOT = 1;
const LASH_SLOT = 3;

/** Upper lashes only: the lower lid's cards read as grey spikes under the eye. Their triangles are folded to a point, the mesh kept whole. */
function upperLashesOnly(mesh: SkinnedMesh): void {
  const g = mesh.geometry;
  const hairMask = g.getAttribute('hairMask') as BufferAttribute | undefined;
  const position = g.getAttribute('position') as BufferAttribute;
  if (!hairMask || !g.index) return;
  // Each eye's middle, from the eyeballs' vertices (left and right by side of the body's middle).
  // The eyes are an eyeball item (`eyeMask`) or the body's own eyeballs (`EYE_SLOT`); without either, the lashes' own middle.
  const eyeMask = g.getAttribute('eyeMask') as BufferAttribute | undefined;
  const isEye = (v: number): boolean => (eyeMask ? eyeMask.getX(v) > 0.5 : false) || Math.round(hairMask.getX(v)) === EYE_SLOT;
  const sum = { l: [0, 0], r: [0, 0] };
  for (let v = 0; v < hairMask.count; v++) {
    if (!isEye(v)) continue;
    const e = position.getX(v) >= 0 ? sum.l : sum.r;
    e[0]! += position.getY(v); e[1]! += 1;
  }
  for (const [side, e] of [[1, sum.l], [-1, sum.r]] as const) {
    if (e[1]!) continue;
    for (let v = 0; v < hairMask.count; v++) {
      if (Math.round(hairMask.getX(v)) !== LASH_SLOT || Math.sign(position.getX(v)) !== side) continue;
      e[0]! += position.getY(v); e[1]! += 1;
    }
  }
  const middle = (x: number): number => { const e = x >= 0 ? sum.l : sum.r; return e[1]! ? e[0]! / e[1]! : Infinity; };
  const index = g.index;
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
    if (Math.round(hairMask.getX(a)) !== LASH_SLOT) continue;
    const y = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
    if (y < middle(position.getX(a))) { index.setX(t + 1, a); index.setX(t + 2, a); }
  }
  index.needsUpdate = true;
  // Short lashes hugging the lid: each upper lash drawn halfway back to its root, the lid line (the lowest lash point in its 2 mm slice across the eye).
  const BIN = 0.002, KEEP = 0.22;
  const roots = new Map<number, [number, number]>();
  for (let v = 0; v < hairMask.count; v++) {
    if (Math.round(hairMask.getX(v)) !== LASH_SLOT || position.getY(v) < middle(position.getX(v))) continue;
    const bin = Math.round(position.getX(v) / BIN);
    const root = roots.get(bin);
    if (!root || position.getY(v) < root[0]) roots.set(bin, [position.getY(v), position.getZ(v)]);
  }
  for (let v = 0; v < hairMask.count; v++) {
    if (Math.round(hairMask.getX(v)) !== LASH_SLOT || position.getY(v) < middle(position.getX(v))) continue;
    const root = roots.get(Math.round(position.getX(v) / BIN));
    if (!root) continue;
    position.setY(v, root[0] + (position.getY(v) - root[0]) * KEEP);
    position.setZ(v, root[1] + (position.getZ(v) - root[1]) * KEEP);
  }
  position.needsUpdate = true;
}

/** The hair in one even colour: the rig samples each card's strand texture into its vertices, and the overlapping cards read as stripes. */
function solidHair(mesh: SkinnedMesh, look: PersonLook): void {
  const g = mesh.geometry;
  const hairMask = g.getAttribute('hairMask') as BufferAttribute | undefined;
  const colour = g.getAttribute('color') as BufferAttribute | undefined;
  if (!hairMask || !colour) return;
  const hair = new Color(look.hair);
  for (let v = 0; v < hairMask.count; v++) if (Math.round(hairMask.getX(v)) === HAIR_SLOT) colour.setXYZ(v, hair.r, hair.g, hair.b);
  colour.needsUpdate = true;
}

/** No spikes off a garment: a vertex fitted to the wrong body point stretches its triangles into a long spike (a skirt's corner pulled to the knee).
 *  A garment triangle with an edge over six times the garment's typical edge is folded to a point. */
function foldSpikes(mesh: SkinnedMesh): void {
  const g = mesh.geometry;
  const slot = g.getAttribute('garmentSlot') as BufferAttribute | undefined;
  const position = g.getAttribute('position') as BufferAttribute;
  if (!slot || !g.index) return;
  const index = g.index;
  const edge = (a: number, b: number): number => Math.hypot(position.getX(a) - position.getX(b), position.getY(a) - position.getY(b), position.getZ(a) - position.getZ(b));
  const lengths = new Map<number, number[]>();
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
    const k = Math.round(slot.getX(a));
    if (k < 1 || a === b) continue;
    (lengths.get(k) ?? lengths.set(k, []).get(k)!).push(edge(a, b), edge(b, c), edge(c, a));
  }
  const typical = new Map<number, number>();
  for (const [k, list] of lengths) { list.sort((x, y) => x - y); typical.set(k, list[Math.floor(list.length / 2)]!); }
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
    const k = Math.round(slot.getX(a));
    const limit = (typical.get(k) ?? Infinity) * 6;
    if (k >= 1 && Math.max(edge(a, b), edge(b, c), edge(c, a)) > limit) { index.setX(t + 1, a); index.setX(t + 2, a); }
  }
  index.needsUpdate = true;
}

/** A skirt's hem even: the fitting drags a few hem vertices down into a point (the elegant suit's front, 2026-10-21). For a garment that ends above the knee
 *  height band (a skirt, a dress), its vertices below the hem line (the 12th lowest percentile of its lower half) are raised to it. */
function evenHem(mesh: SkinnedMesh): void {
  const g = mesh.geometry;
  const slot = g.getAttribute('garmentSlot') as BufferAttribute | undefined;
  const position = g.getAttribute('position') as BufferAttribute;
  if (!slot) return;
  let top = -Infinity;
  for (let v = 0; v < position.count; v++) top = Math.max(top, position.getY(v));
  const bySlot = new Map<number, number[]>();
  for (let v = 0; v < position.count; v++) {
    const k = Math.round(slot.getX(v));
    if (k >= 1) (bySlot.get(k) ?? bySlot.set(k, []).get(k)!).push(v);
  }
  for (const vs of bySlot.values()) {
    const ys = vs.map((v) => position.getY(v)).sort((a, b) => a - b);
    const lowest = ys[0]!;
    // Trousers reach the ankles, tops end at the waist: only a garment whose bottom lies between knee and mid thigh is a skirt.
    if (lowest < top * 0.08 || lowest > top * 0.5) continue;
    const lower = ys.filter((y) => y < Math.min(top * 0.5, lowest + top * 0.15));
    const hem = lower[Math.floor(lower.length * 0.12)] ?? lowest;
    if (hem - lowest < 0.015) continue;
    for (const v of vs) if (position.getY(v) < hem) position.setY(v, hem - (hem - position.getY(v)) * 0.15);
  }
  position.needsUpdate = true;
}

export function polishPerson(meshes: readonly SkinnedMesh[], look: PersonLook, sculpted = false): void {
  for (const mesh of meshes) {
    // Lengthened or not, the fitting's stray hem point is evened out (a sculpt moves the whole hem, the point stays an outlier).
    void sculpted;
    evenHem(mesh);
    foldSpikes(mesh);
    clearScalpPaint(mesh, look);
    solidHair(mesh, look);
    upperLashesOnly(mesh);
    smoothSeams(mesh);
  }
}

/** Painted skin, as animated films and The Sims draw it: the skin texture's pores and wrinkles softened away, its tones kept. */
export function paintedSkin(source: Texture, softness: number): Texture | null {
  const image = source.image as CanvasImageSource & { width?: number; height?: number } | undefined;
  const w = image?.width ?? 0, h = image?.height ?? 0;
  if (!image || !w || !h || softness <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.filter = `blur(${Math.max(1, Math.round((w / 256) * softness))}px)`;
  ctx.drawImage(image, 0, 0);
  ctx.filter = 'none';
  // A share of the texture's own average tone over it: even skin, no blotches.
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const p = probe.getContext('2d')!;
  p.drawImage(canvas, 0, 0, 1, 1);
  const [r, g, b] = p.getImageData(0, 0, 1, 1).data;
  ctx.globalAlpha = 0.45 * softness;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, w, h);
  const texture = new CanvasTexture(canvas);
  texture.flipY = source.flipY;
  texture.colorSpace = source.colorSpace;
  texture.wrapS = source.wrapS;
  texture.wrapT = source.wrapT;
  texture.anisotropy = 4;
  return texture;
}

/** The game's hair shader with one even sheen: its per-strand sparkle (a random value per strand cell) reads as stripes, and its per-card strand direction as facets, on solid hair. */
export function evenHairSheen(material: MeshStandardMaterial): void {
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(/personSparkle = fract\([^;]*;/, 'personSparkle = 0.5;')
      // Strands run up and down the head (view-space up), not along each card's texture: one smooth highlight band, no facets.
      .replace('vec3 along = dp2 * du1.x - dp1 * du2.x;', 'vec3 along = vec3(0.0, 1.0, 0.0);')
      // No lash cards: their thin strands read as grey spikes round the eye.
      // Lashes as one dark, full line (The Sims draws them so): their strands' alpha thickened, never thinned.
      .replace('cardTexel.a *= 0.65;', 'cardTexel.a = min(1.0, cardTexel.a * 0.6);')
      .replace('diffuseColor.a = cardTexel.a;', 'diffuseColor.a = cardTexel.a; if (slot > 2.5 && slot < 3.5) diffuseColor.rgb = vec3(0.02);');
  };
  const before2 = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before2.call(material, shader, renderer);
    // Hair lit by its own normal on both faces: three flips a back face's normal, and the curtains' back faces showed as dark patches.
    if (shader.fragmentShader.includes('varying float vHairMask')) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nif (abs(vHairMask - 1.0) < 0.5) normal = normalize( vNormal );');
  };
  material.customProgramCacheKey = () => `${key}-lab-even-sheen-2`;
}

/** The eyes from their own full-size texture: the game draws them from a 256 px layer of its shared arrays (`skinAppearance.ts` SMALL_LAYER), a blur up close. */
export function sharpEyes(material: MeshStandardMaterial, eye: Texture): void {
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  eye.anisotropy = 8;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms['labEye'] = { value: eye };
    shader.fragmentShader = `uniform sampler2D labEye;\n${shader.fragmentShader}`
      .replace('vec4 eyeTexel = personLayer(personEye.x, personEye.y, vSkinUv);', 'vec4 eyeTexel = texture2D(labEye, vSkinUv);');
  };
  material.customProgramCacheKey = () => `${key}-lab-sharp-eyes`;
}

/** The part under the pointer glowing, as Create-a-Sim lights it: `labRegion` (a region id a vertex) against `hover` (the region lit, 0 for none), pulsing on `time`. */
export function regionGlow(material: MeshStandardMaterial, uniforms: { hover: { value: number }; time: { value: number } }): void {
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms['labHover'] = uniforms.hover;
    shader.uniforms['labTime'] = uniforms.time;
    shader.vertexShader = `attribute float labRegion; varying float vLabRegion;
${shader.vertexShader}`
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLabRegion = labRegion;');
    shader.fragmentShader = `uniform float labHover; uniform float labTime; varying float vLabRegion;
${shader.fragmentShader}`
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (labHover > 0.5 && abs(vLabRegion - labHover) < 0.5) {
          // A glow round the part's edges (fresnel), as Create-a-Sim outlines it: the part's own colours stay readable.
          float labRim = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.5);
          totalEmissiveRadiance += vec3(0.1, 0.5, 1.0) * (0.12 + 0.9 * labRim) * (0.75 + 0.25 * sin(labTime * 5.0));
        }`);
  };
  material.customProgramCacheKey = () => `${key}-lab-glow`;
}
