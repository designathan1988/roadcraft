import type { MeshStandardMaterial } from 'three';

/**
 * WHERE A STREET IS DIRTY AND WHERE IT IS WORN: the marks a carriageway and
 * a footway take from their use, drawn from each fragment's place in the
 * road's cross-section (`surfaceMesh.ts` `section`, the `roadSection`
 * attribute) - no texture and no extra sample. A road read as one flat
 * asphalt from kerb to kerb, a footway as one flat paving from kerb to lot
 * (the player, 2026-10-13: the asphalt by the kerb is a different tone from
 * its middle, the footway too at its edges). As road tools lay such masks
 * along the road's width - edge wear, dirt, wear tracks (the Procedural Road
 * Toolkit's normalised across-the-road UV, "for centerlines, lane markings,
 * wear tracks", and its "edge wear, dirt accumulation").
 *
 * The carriageway: the gutter's band of grit and grime along each kerb,
 * browner and darker; in every lane the two wheel tracks polished lighter and
 * the drip line of oil between them darker. The footway: the dirt splashed
 * behind the kerb stone, the grime and a little moss along the lot's edge, the
 * walking line down the middle a shade lighter.
 *
 * Chained onto the material's own shader changes (`detailLayer.ts`).
 */
export function applyRoadEdges(material: MeshStandardMaterial, kind: 'carriageway' | 'footway'): void {
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 roadSection;\nvarying vec3 vRoadSection;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoadSection = roadSection;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoadSection;')
      .replace('#include <color_fragment>', `#include <color_fragment>
  if (vRoadSection.y > 0.0) {
    // The asphalt's own grain as noise, so no band is an even stripe.
    float grain = texture2D(map, vMapUv * 2.7).r;
${kind === 'carriageway' ? `
    // Metres from the kerb's face.
    float edge = vRoadSection.y - abs(vRoadSection.x);
    float gutter = 1.0 - smoothstep(0.05, 0.65, edge);
    diffuseColor.rgb *= 1.0 - 0.3 * gutter * (0.6 + 0.8 * grain);
    diffuseColor.rgb *= mix(vec3(1.0), vec3(1.06, 0.99, 0.9), gutter * 0.6);
    float lane = vRoadSection.z;
    if (lane > 0.5 && edge > 0.0) {
      // Each lane from its kerb side: its middle, its wheel tracks 0.85 m either side.
      float centre = abs(mod(edge, lane) - 0.5 * lane);
      float tracks = exp(-pow((centre - 0.85) / 0.3, 2.0));
      float oil = exp(-pow(centre / 0.32, 2.0));
      diffuseColor.rgb *= 1.0 + 0.11 * tracks - 0.14 * oil * (0.7 + 0.6 * grain);
    }` : `
    // Metres from the kerb's back, and the footway's width to the lot.
    float fromKerb = vRoadSection.x, width = vRoadSection.y;
    float nearKerb = 1.0 - smoothstep(0.1, 0.6, fromKerb);
    float nearLot = 1.0 - smoothstep(0.0, 0.55, width - fromKerb);
    float walked = exp(-pow((fromKerb - 0.5 * width) / max(0.22 * width, 0.3), 2.0));
    diffuseColor.rgb *= (1.0 - 0.2 * nearKerb * (0.6 + 0.8 * grain)) * (1.0 - 0.24 * nearLot * (0.6 + 0.8 * grain)) * (1.0 + 0.07 * walked);
    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.9, 1.0, 0.86), nearLot * 0.4);`}
  }`);
  };
  material.customProgramCacheKey = () => `${key.call(material)}-road-edges-v1-${kind}`;
}
