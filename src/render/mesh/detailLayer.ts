import type { MeshStandardMaterial, Texture } from 'three';

import { m } from '@world/units';
import { DETAIL_WORLD_SIZE, type DetailKind } from '../bake/detailRecipes';
import { surfaceTexture } from '../surfaceTextures';

/** The close-up detail layer: what a surface looks like at the camera's nearest zoom. ## Why the ground went to mush up */

interface DetailTextures {
  readonly map: Texture;
  readonly normalMap: Texture;
  /** World units one tile covers. */
  readonly worldSize: number;
}

/** The detail textures for one family, baked at build time (`bake/detailRecipes.ts`) and loaded once (`surfaceBakeClient.ts`). */
function detailTextures(kind: DetailKind, anisotropy: number): DetailTextures {
  return {
    map: surfaceTexture(`${kind}:detail`, anisotropy),
    normalMap: surfaceTexture(`${kind}:detail-normal`, anisotropy),
    worldSize: DETAIL_WORLD_SIZE[kind],
  };
}

/** The shared on/off switch, so a low tier pays nothing but a uniform read. */
export const detailSwitch = { value: 1 };

/** GLSL for sampling a detail layer. */
export const DETAIL_GLSL = /* glsl */ `
  uniform float uDetailOn;
  // World units per pixel below which detail is fully shown, and above which it is gone.
  const float DETAIL_NEAR = ${m(0.018).toFixed(6)};
  const float DETAIL_FAR = ${m(0.064).toFixed(6)};
  const mat2 DETAIL_TURN = mat2(0.5403, 0.8415, -0.8415, 0.5403);

  float detailWeight(vec2 worldUv) {
    vec2 footprint = fwidth(worldUv);
    float perPixel = max(footprint.x, footprint.y);
    return uDetailOn * (1.0 - smoothstep(DETAIL_NEAR, DETAIL_FAR, perPixel));
  }
  vec3 detailSample(sampler2D tex, vec2 uv) {
    vec3 a = texture2D(tex, uv).rgb * 2.0;
    vec3 b = texture2D(tex, DETAIL_TURN * uv * 0.4137 + 0.31).rgb * 2.0;
    return a * mix(vec3(1.0), b, 0.55);
  }
  vec3 detailNormal(sampler2D tex, vec2 uv) {
    vec3 a = texture2D(tex, uv).xyz * 2.0 - 1.0;
    vec3 b = texture2D(tex, DETAIL_TURN * uv * 0.4137 + 0.31).xyz * 2.0 - 1.0;
    // The second sample was read through a rotation
    b.xy = b.xy * DETAIL_TURN;
    return vec3(a.xy + b.xy * 0.55, a.z);
  }
`;

export interface DetailSpec {
  readonly kind: DetailKind;
  /** World units one tile of the MACRO map covers - how the mesh UVs are scaled. */
  readonly macroTile: number;
  /** How hard the detail albedo modulates, 0..1. */
  readonly albedo: number;
  /** Strength of the detail normal. */
  readonly normal: number;
  /** Mip bias applied to the macro maps at full detail, to soften magnified grain. */
  readonly macroBlur: number;
}

/** Installs the detail layer on a standard material whose UVs are in macro tiles */
export function applyDetail(material: MeshStandardMaterial, spec: DetailSpec, anisotropy: number): void {
  const textures = detailTextures(spec.kind, anisotropy);
  const uniforms = {
    uDetailOn: detailSwitch,
    uDetailMap: { value: textures.map },
    uDetailNormal: { value: textures.normalMap },
    uDetailRepeat: { value: spec.macroTile / textures.worldSize },
    uMacroTile: { value: spec.macroTile },
    uDetailAlbedo: { value: spec.albedo },
    uDetailNormalScale: { value: spec.normal },
    uMacroBlur: { value: spec.macroBlur },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D uDetailMap;
         uniform sampler2D uDetailNormal;
         uniform float uDetailRepeat;
         uniform float uMacroTile;
         uniform float uDetailAlbedo;
         uniform float uDetailNormalScale;
         uniform float uMacroBlur;
         ${DETAIL_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `float detailW = detailWeight(vMapUv * uMacroTile);
         vec2 detailUv = vMapUv * uDetailRepeat;
         vec4 sampledDiffuseColor = texture2D(map, vMapUv, detailW * uMacroBlur);
         vec3 detailAlbedo = detailSample(uDetailMap, detailUv);
         sampledDiffuseColor.rgb *= mix(vec3(1.0), detailAlbedo, detailW * uDetailAlbedo);
         diffuseColor *= sampledDiffuseColor;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 mapN = texture2D(normalMap, vNormalMapUv, detailW * uMacroBlur).xyz * 2.0 - 1.0;
         mapN.xy *= normalScale;
         vec3 fineN = detailNormal(uDetailNormal, detailUv);
         mapN.xy += fineN.xy * uDetailNormalScale * detailW;
         normal = normalize(tbn * mapN);`,
      );
  };
  material.customProgramCacheKey = () => `detail-${spec.kind}`;
}
