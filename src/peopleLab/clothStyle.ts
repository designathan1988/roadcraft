import { Color, type MeshStandardMaterial } from 'three';

/** THE OUTFIT RECOLOURED AND PATTERNED, as The Sims 3's Create-a-Style did it on any garment: a main colour and an accent, a woven pattern
 *  (stripes, gingham, dots, denim twill, rib) in the cloth's bind-space position (continuous across seams, fixed to the cloth when the body
 *  moves; triplanar on the bind normal), box-filtered so it never shimmers (Quilez's filtered checker, the filtered pulse train of GPU Gems
 *  ch. 25), the garment texture's own shading kept (its luminance times the colour, Photoshop's Color mode). All uniforms: changing any of
 *  it never rebuilds the person nor recompiles a shader. Drawn on the outfit only (garment slot 1). */

export const CLOTH_PATTERNS = ['plain', 'stripes', 'gingham', 'dots', 'denim', 'rib'] as const;
export type ClothPattern = (typeof CLOTH_PATTERNS)[number];

/** The outfit's look as kept with the person. */
export interface OutfitStyle {
  readonly pattern: ClothPattern;
  /** The pattern's colour (the main colour is `spec.look.outfitTint`). */
  readonly accent: number;
  /** Repeats a metre. */
  readonly scale: number;
  /** How much of the pattern shows, 0..1. */
  readonly amount: number;
  /** How much of the texture's own weave and print shows under the colour, 0 (flat) .. 1. */
  readonly detail: number;
  /** 0 matte cloth .. 1 satin. */
  readonly shine: number;
}

export const PLAIN_STYLE: OutfitStyle = { pattern: 'plain', accent: 0xffffff, scale: 12, amount: 1, detail: 1, shine: 0 };

export interface ClothUniforms {
  readonly clothDyed: { value: number };
  readonly clothMain: { value: Color };
  readonly clothAccent: { value: Color };
  readonly clothPattern: { value: number };
  readonly clothScale: { value: number };
  readonly clothAmount: { value: number };
  readonly clothDetail: { value: number };
  readonly clothShine: { value: number };
}

export function clothUniforms(): ClothUniforms {
  return { clothDyed: { value: 0 }, clothMain: { value: new Color() }, clothAccent: { value: new Color() }, clothPattern: { value: 0 },
    clothScale: { value: 12 }, clothAmount: { value: 1 }, clothDetail: { value: 1 }, clothShine: { value: 0 } };
}

/** The uniforms set to a person's outfit colour (null: the garment's own colours) and style. */
export function setCloth(u: ClothUniforms, tint: number | null | undefined, style: OutfitStyle | undefined): void {
  const s = style ?? PLAIN_STYLE;
  u.clothDyed.value = tint == null ? 0 : 1;
  if (tint != null) u.clothMain.value.setHex(tint);
  u.clothAccent.value.setHex(s.accent);
  u.clothPattern.value = CLOTH_PATTERNS.indexOf(s.pattern);
  u.clothScale.value = s.scale;
  u.clothAmount.value = s.amount;
  u.clothDetail.value = s.detail;
  u.clothShine.value = s.shine;
}

const GLSL = `
uniform float clothDyed; uniform vec3 clothMain; uniform vec3 clothAccent; uniform float clothPattern; uniform float clothScale;
uniform float clothAmount; uniform float clothDetail; uniform float clothShine; varying vec3 vClothPos; varying vec3 vClothNormal;
float clothPulse(float x, float d) { return floor(x) * d + max(fract(x) - (1.0 - d), 0.0); }
float clothStripes(float x, float d) { float w = fwidth(x) + 1e-4; return (clothPulse(x + 0.5 * w, d) - clothPulse(x - 0.5 * w, d)) / w; }
float clothChecker(vec2 p) { vec2 w = fwidth(p) + 0.001; vec2 i = 2.0 * (abs(fract((p - 0.5 * w) * 0.5) - 0.5) - abs(fract((p + 0.5 * w) * 0.5) - 0.5)) / w; return 0.5 - 0.5 * i.x * i.y; }
float clothDots(vec2 p) {
  p.x += step(1.0, mod(floor(p.y), 2.0)) * 0.5;
  float d = length(fract(p) - 0.5) - 0.28, aa = fwidth(d);
  return mix(1.0 - smoothstep(-aa, aa, d), 0.246, smoothstep(0.25, 0.5, fwidth(p.y)));
}
float clothRib(float x) { float a = clamp(1.0 - 2.0 * fwidth(x), 0.0, 1.0); return 0.5 + 0.5 * a * cos(6.28318 * x); }
float clothFace(vec2 p) {
  if (clothPattern < 1.5) return clothStripes(p.y, 0.5);
  if (clothPattern < 2.5) return 0.5 * (clothStripes(p.x, 0.5) + clothStripes(p.y, 0.5)) * (0.6 + 0.4 * clothChecker(p * 2.0));
  if (clothPattern < 3.5) return clothDots(p);
  if (clothPattern < 4.5) return clothStripes(p.x * 4.0 + p.y * 2.0, 0.66);
  return clothRib(p.x);
}
float clothCoverage() {
  if (clothPattern < 0.5) return 0.0;
  vec3 p = vClothPos * clothScale;
  // Stripes and ribs run round the body: the height alone, no seams between the faces.
  if (clothPattern < 1.5) return clothStripes(p.y, 0.5);
  vec3 b = pow(abs(normalize(vClothNormal)), vec3(8.0)); b /= dot(b, vec3(1.0));
  return b.x * clothFace(p.zy) + b.y * clothFace(p.xz) + b.z * clothFace(p.xy);
}`;

/** The outfit drawn in the person's colours and pattern (`clothUniforms`), on a material the game's skin appearance already set up. */
export function clothStyle(material: MeshStandardMaterial, u: ClothUniforms): void {
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    if (!shader.fragmentShader.includes('varying float vGarmentSlot')) return;
    Object.assign(shader.uniforms, u);
    shader.vertexShader = `varying vec3 vClothPos; varying vec3 vClothNormal;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvClothPos = position; vClothNormal = normal;');
    shader.fragmentShader = `${GLSL}\n${shader.fragmentShader}`
      // After the game sampled the garment's texture into diffuseColor (`skinAppearance.ts`), before alpha and lighting.
      .replace('#include <alphatest_fragment>', `if (abs(vGarmentSlot - 1.0) < 0.1 && clothDyed + clothPattern > 0.0) {
          vec3 cloth = diffuseColor.rgb;
          float lum = dot(cloth, vec3(0.2126, 0.7152, 0.0722));
          // The weave and print kept as shade: the texture's luminance about its mid-tone.
          float shade = mix(1.0, clamp(lum / 0.35, 0.25, 1.8), clothDetail);
          vec3 base = clothDyed > 0.5 ? clothMain * shade : cloth;
          vec3 pattern = clothAccent * shade;
          diffuseColor.rgb = mix(base, pattern, clothCoverage() * clothAmount);
        }
        #include <alphatest_fragment>`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (abs(vGarmentSlot - 1.0) < 0.1) roughnessFactor = mix(roughnessFactor, 0.32, clothShine);');
  };
  material.customProgramCacheKey = () => `${key}-lab-cloth-1`;
}
