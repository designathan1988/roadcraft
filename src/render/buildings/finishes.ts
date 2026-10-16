import { DoubleSide, MeshStandardMaterial } from 'three';

import { type Finish, FINISHES } from '@world/buildings/materials';
import { LOOKS } from '../bake/finishRecipes';
import { surfaceMaps } from '../surfaceTextures';
import { applyLotOverlay } from '../lotOverlay';

/** The building finishes ("Materials"): their recipes in `bake/finishRecipes.ts`, baked at build time */

/** One material per finish, textured where the build's baked surfaces are loaded (`surfaceBakeClient.ts`; none in a worker or a test). */
export function createFinishMaterials(anisotropy = 8): Record<Finish, MeshStandardMaterial> {
  const out = {} as Record<Finish, MeshStandardMaterial>;
  for (const finish of FINISHES) {
    const look = LOOKS[finish];
    // The shell is not a closed solid (openings, no underside), so it casts from both sides.
    const material = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: look.metalness,
      envMapIntensity: look.envMapIntensity,
      shadowSide: DoubleSide,
    });
    const bake = surfaceMaps(`building-${finish}`, anisotropy);
    if (bake) {
      const repeat = 1 / look.worldSize;
      for (const map of [bake.map, bake.normalMap, bake.roughnessMap]) map.repeat.set(repeat, repeat);
      material.map = bake.map;
      material.normalMap = bake.normalMap;
      // Relief in proportion to the real surface
      material.normalScale.set(look.normalScale, look.normalScale);
      material.roughnessMap = bake.roughnessMap;
      if (look.metallic) material.metalnessMap = bake.roughnessMap;
    } else {
      material.roughness = 0.9;
      // No map to say where the metal is: the larger part, the glass.
      if (look.metallic) material.metalness = 0;
    }
    material.name = `building-${finish}`;
    applyWeathering(material, finish);
    // A built lot's yard - the paving and paths are this shell's level faces at the lot's ground
    applyLotOverlay(material, `building-${finish}`, { building: true });
    out[finish] = material;
  }
  return out;
}

/** Buildings that are not maintained run down (the player's order of 2026-10-05) */
function applyWeathering(material: MeshStandardMaterial, finish: Finish): void {
  const roof = finish === 'roofing' || finish === 'tile' || finish === 'slate';
  const glassy = finish === 'glass' || finish === 'metal';
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aDecay;\nvarying float vDecay;\nvarying vec3 vDecayWorld;\nvarying vec3 vDecayNormal;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvDecay = aDecay;\nvDecayWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvDecayNormal = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vDecay;
        varying vec3 vDecayWorld;
        varying vec3 vDecayNormal;
        float dHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float dNoise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(dHash(i), dHash(i + vec3(1, 0, 0)), f.x), mix(dHash(i + vec3(0, 1, 0)), dHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(dHash(i + vec3(0, 0, 1)), dHash(i + vec3(1, 0, 1)), f.x), mix(dHash(i + vec3(0, 1, 1)), dHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec3 w = vDecayWorld;
          // MACRO VARIATION, on every building
          float macro = dNoise(w * 0.045) * 0.55 + dNoise(w * 0.17) * 0.3 + dNoise(w * 0.6) * 0.15;
          diffuseColor.rgb *= 0.9 + 0.2 * macro;
        }
        {
          // After the texture: the stains darken the finish as painted.
          // streaks, grime), heavier as a building runs down (\`aDecay\`).
          float d = max(vDecay, ${glassy ? '0.0' : '0.3'});
          vec3 w = vDecayWorld;
          bool wall = abs(vDecayNormal.y) < 0.5;
          // Rain streaks: thin, long, running down from sills and copings.
          float streak = smoothstep(0.55, 0.85, dNoise(vec3(w.x * 2.2, w.y * 0.08, w.z * 2.2)));
          // Grime: darker towards the foot of the wall and in soft patches.
          float grime = 0.5 + 0.5 * dNoise(w * 0.22);
          float darken = d * (0.18 + 0.12 * grime + (wall ? 0.28 * streak : 0.1));
          diffuseColor.rgb *= 1.0 - darken;
        }
        if (vDecay > 0.001) {
          float d = vDecay;
          vec3 w = vDecayWorld;
          bool wall = abs(vDecayNormal.y) < 0.5;
          ${glassy ? '' : roof ? `
          // Dark moss in the low corners of the roof.
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.55, 0.62, 0.45), d * 0.6 * smoothstep(0.6, 0.85, dNoise(w * 0.3)));` : `
          // Paint gone in a few small patches, the darker render showing.
          float peel = smoothstep(0.8 - d * 0.12, 0.83 - d * 0.12, dNoise(w * 1.3 + 7.0));
          if (wall) diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.72, 0.68, 0.62), peel * d);`}
        }`)
      // The relief faded as a texel shrinks under a pixel
      .replace('mapN.xy *= normalScale;', `mapN.xy *= normalScale;
        {
          vec2 texelsPerPixel = fwidth(vNormalMapUv) * vec2(textureSize(normalMap, 0));
          mapN.xy *= 1.0 - smoothstep(0.6, 3.0, max(texelsPerPixel.x, texelsPerPixel.y));
        }`);
  };
  material.customProgramCacheKey = () => `building-weathering-v3-${finish}`;
}

/** Each finish's colour as it reads from afar, three numbers to multiply a wall's tint by: the mean of its texture */
export function finishAlbedo(): Record<Finish, readonly [number, number, number]> {
  const out = {} as Record<Finish, readonly [number, number, number]>;
  const STEPS = 48;
  for (const finish of FINISHES) {
    const look = LOOKS[finish];
    const shade = look.shade(look.size);
    const texel = { r: 0, g: 0, b: 0, h: 0, rough: 0, metal: 0 };
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < STEPS; i++) {
      for (let j = 0; j < STEPS; j++) {
        texel.metal = 0;
        shade(((i + 0.5) / STEPS) * look.size, ((j + 0.5) / STEPS) * look.size, texel);
        r += texel.r; g += texel.g; b += texel.b;
      }
    }
    const n = STEPS * STEPS;
    const weathered = finish === 'glass' || finish === 'metal' ? 1 : WEATHERED_MEAN;
    out[finish] = [(r / n) * weathered, (g / n) * weathered, (b / n) * weathered];
  }
  return out;
}

/** How dark the light weathering of every wall leaves it on average (`applyWeathering`, `d` of 0.3: 0.3 x (0.18 + 0.12 x 0.75 + a few streaks)). */
const WEATHERED_MEAN = 0.91;
