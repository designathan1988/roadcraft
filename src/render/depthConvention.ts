import type { Material } from 'three';

/**
 * THE DEPTH BUFFER RUNS BACKWARDS: near is 1, far is 0 (reversed Z), in a
 * 32-bit float buffer. A standard 24-bit buffer spends its precision next to
 * the near plane: with the street view's near plane at 8 cm it told two faces
 * apart only when they stood ~2 mm apart at 50 m and ~5 cm apart at 300 m, so
 * every layer of the buildings a few millimetres over another (a coping on a
 * parapet, a sill on its wall, a paving's kerb under its plate) traded pixels
 * with it in bands as the camera moved - the flicker the player saw on
 * rooftops and doorsteps (2026-10-14). Reversed Z in a float buffer keeps the
 * error proportional to the distance (about 1e-7 of it), whatever the near
 * plane: a millimetre is told apart kilometres away.
 * Sources: N. Reed, "Depth Precision Visualized" (NVIDIA, 2015: reversed-Z
 * with a float32 buffer had no errors where the others had many); three.js
 * r186 `WebGLRenderer({ reversedDepthBuffer })` (EXT_clip_control, the clip
 * range [0, 1]) and its example `webgl_reversed_depth_buffer` (a `FloatType`
 * depth texture behind the composer). DO NOT turn on
 * `logarithmicDepthBuffer` instead: it writes `gl_FragDepth` and loses
 * early-Z (three's docs). DO NOT push the near plane out or grow an offset
 * until a flicker hides: the next layer flickers further away.
 *
 * Everything that reads or offsets depth goes through here, so it holds with
 * the buffer either way (three falls back to the standard buffer where the
 * extension is missing):
 * - `DEPTH_GLSL` for shaders that read the scene's depth texture: three
 *   defines `USE_REVERSED_DEPTH_BUFFER` in every non-raw ShaderMaterial when
 *   the buffer is reversed;
 * - `pullTowardEye` for a material drawn over a surface in its plane.
 */

/**
 * GLSL for a pass that reads the scene's depth texture: the depth of the
 * near and the far plane, a depth value's clip-space z (WebGL's [-1, 1]
 * standard, [0, 1] reversed under EXT_clip_control), whether a depth is the
 * background (nothing drawn, or as good as: the cleared far plane), and the
 * nearer of two depths. DO NOT write `depth * 2.0 - 1.0`, `depth >= 0.9999`
 * or `min(depth, ...)` in a pass: under the reversed buffer the far plane is
 * 0 and the nearer depth is the larger.
 */
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

/**
 * A material drawn over a surface in that surface's plane - a decal, road
 * paint, a part laid on a building's shell - pulled towards the eye by a
 * polygon offset (glPolygonOffset: `factor * DZ + r * units` added to the
 * fragment's depth), so it wins the depth test everywhere instead of pixel by
 * pixel. `slope` and `steps` are magnitudes towards the eye.
 *
 * Towards the eye is a smaller depth in the standard buffer and a larger one
 * in the reversed buffer, for BOTH terms. three r186 (`WebGLState.
 * setPolygonOffset`) negates the factor under a reversed buffer but passes the
 * units as they are, so a material written for the standard buffer (-1, -4)
 * had its constant term push it AWAY from the eye, and a face seen square on
 * (no slope) lost to the surface under it. The factor is written as for the
 * standard buffer (three turns it); the units take their sign at each draw
 * from the renderer drawing it (the game's and the parts studio's). A copy
 * (`Material.clone`) does not keep `onBeforeRender`: offset the copy again.
 * DO NOT set `polygonOffsetFactor`/`polygonOffsetUnits` on a material by hand.
 */
export function pullTowardEye(material: Material, slope: number, steps: number): void {
  const units = Math.abs(steps);
  material.polygonOffset = true;
  material.polygonOffsetFactor = -Math.abs(slope);
  material.polygonOffsetUnits = -units;
  material.onBeforeRender = (renderer: DepthOwner) => {
    material.polygonOffsetUnits = renderer.capabilities.reversedDepthBuffer ? units : -units;
  };
}

/**
 * Whether a material is drawn pulled towards the eye in both terms by a
 * renderer whose depth buffer is `reversed` or not, as three hands its offset
 * to WebGL (the factor negated under the reversed buffer).
 */
export function pulledTowardEye(material: Material, reversed: boolean): boolean {
  if (!material.polygonOffset) return false;
  const kept = material.polygonOffsetUnits;
  const owner: DepthOwner = { capabilities: { reversedDepthBuffer: reversed } };
  (material.onBeforeRender as (renderer: DepthOwner) => void)(owner);
  const units = material.polygonOffsetUnits;
  material.polygonOffsetUnits = kept;
  const factor = reversed ? -material.polygonOffsetFactor : material.polygonOffsetFactor;
  return reversed ? factor > 0 && units > 0 : factor < 0 && units < 0;
}
