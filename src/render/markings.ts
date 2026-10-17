import { Color, MeshStandardMaterial, type Material } from 'three';

import { PAINT_COLOURS } from './paintQuads';
import { pullTowardEye } from './depthConvention';

/** Painted road markings, as real geometry lifted just off the carriageway: their quads (`paintQuads.ts`), drawn with these materials. */
export { PAINT_COLOURS, PAINT_RISE, STOP_PAINT, ZEBRA_PAINT, barQuad, roadStrokes, strokeQuads, type QuadSink } from './paintQuads';

/** DO NOT make a paint material where a frame reaches: a colour first painted made its material in the frame of the edit. */
export function paintCatalogue(): Map<string, Material> {
  return new Map(PAINT_COLOURS.map((color) => [color, paintMaterial(color)]));
}

/** Paint of one colour: lit like the asphalt under it, drawn over it. */
function paintMaterial(color: string): Material {
  const material = new MeshStandardMaterial({
    color: new Color(color).multiplyScalar(0.88),
    roughness: 0.72,
    metalness: 0,
    // Paint is applied over the asphalt, so it takes the same light but never reflects the sky the way wet tarmac does.
    envMapIntensity: 0.25,
    transparent: true,
    depthWrite: false,
  });
  pullTowardEye(material, 2, 2);
  // Worn paint (the player found the markings flat stickers on the road)
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPaintWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPaintWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vPaintWorld;
        float pHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float pNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(pHash(i), pHash(i + vec2(1.0, 0.0)), f.x), mix(pHash(i + vec2(0.0, 1.0)), pHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 w = vPaintWorld.xz;
          float grain = pNoise(w * 9.0);
          float worn = pNoise(w * 0.7) * 0.6 + pNoise(w * 2.3) * 0.4;
          float flake = pNoise(w * 5.0);
          // Pinholes of asphalt through the paint, wider where it is worn.
          float px = length(fwidth(w));
          float fineSeen = 1.0 - smoothstep(0.015, 0.045, px);
          float grainSeen = 1.0 - smoothstep(0.04, 0.12, px);
          float flakeSeen = 1.0 - smoothstep(0.08, 0.2, px);
          float cover = 1.0 - 0.35 * smoothstep(0.55, 0.85, worn) * mix(0.5, smoothstep(0.4, 0.7, grain), grainSeen);
          cover *= 1.0 - 0.25 * mix(0.14, step(0.86, pNoise(w * 22.0)), fineSeen);
          if (flake < 0.05) cover *= mix(1.0, 0.45, flakeSeen);
          diffuseColor.rgb *= 0.86 + 0.14 * pNoise(w * 1.3);
          diffuseColor.a *= cover * 0.92;
        }`);
  };
  // DO NOT key it by the colour: each new colour of paint built another program, in play.
  material.customProgramCacheKey = () => 'paint-worn-aa';
  return material;
}
