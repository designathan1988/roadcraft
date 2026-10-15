import type { Material } from 'three';

/** DO NOT turn on `logarithmicDepthBuffer` instead: it writes `gl_FragDepth` and loses early-Z (three's docs). */

/** DO NOT write `depth * 2.0 - 1.0`, `depth >= 0.9999` or `min(depth, ...)` in a pass */
export const DEPTH_GLSL = /* glsl */ `
  #ifdef USE_REVERSED_DEPTH_BUFFER
    #define DEPTH_NEAR 1.0
    #define DEPTH_FAR 0.0
    float depthToClipZ(float depth) { return depth; }
    bool depthIsBackground(float depth) { return depth <= 0.0001; }
    float nearerDepth(float a, float b) { return max(a, b); }
  #else
    #define DEPTH_NEAR 0.0
    #define DEPTH_FAR 1.0
    float depthToClipZ(float depth) { return depth * 2.0 - 1.0; }
    bool depthIsBackground(float depth) { return depth >= 0.9999; }
    float nearerDepth(float a, float b) { return min(a, b); }
  #endif
  // A depth just short of the far plane, for a ray through the background.
  float depthNearlyFar() { return mix(DEPTH_FAR, DEPTH_NEAR, 0.00001); }
`;

/** What `onBeforeRender` is handed of the renderer drawing a material: whether its depth buffer is reversed. */
interface DepthOwner { readonly capabilities: { readonly reversedDepthBuffer: boolean } }

/** DO NOT set `polygonOffsetFactor`/`polygonOffsetUnits` on a material by hand. */
export function pullTowardEye(material: Material, slope: number, steps: number): void {
  const units = Math.abs(steps);
  material.polygonOffset = true;
  material.polygonOffsetFactor = -Math.abs(slope);
  material.polygonOffsetUnits = -units;
  material.onBeforeRender = (renderer: DepthOwner) => {
    material.polygonOffsetUnits = renderer.capabilities.reversedDepthBuffer ? units : -units;
  };
}
