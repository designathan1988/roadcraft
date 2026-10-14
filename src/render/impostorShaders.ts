import { DoubleSide, GLSL3, ShaderMaterial, Vector3 } from 'three';
import { foliageAtlas } from './lowPolyTrees';

/**
 * THE OCTAHEDRAL IMPOSTOR'S SHADERS (`farForest.ts`).
 *
 * The pictures: a model seen from `FRAMES` x `FRAMES` directions over the
 * upper hemisphere, laid out by the hemi-octahedral map (a direction d, over
 * |d.x|+|d.y|+|d.z|, unfolded onto a square; Brucks, "Octahedral Impostors",
 * shaderbits.com; the same formulas as github.com/agargaro/octahedral-impostor
 * and github.com/SIsilicon/Godot-Octahedral-Impostors). Each picture holds the
 * model's colour and its normal in the model's own frame.
 *
 * The quad: facing the eye, sized to the model's sphere; for each of the
 * three pictures nearest the eye's direction, the ray from the eye through
 * the corner met with that picture's plane gives where it is read (so the
 * three line up, no ghost), and they are blended by the eye's place between
 * them (the quad's barycentric weights, Godot's `quadBlendWieghts`).
 *
 * The cover is kept at every mip (Castaño, "Computing Alpha Mipmaps",
 * ludicon.com: the alpha raised with the level read) and the edge sharpened
 * to a pixel for alpha to coverage (the leaf cards' own, `lowPolyTrees.ts`).
 */

/** Pictures along each side of a model's square. */
export const FRAMES = 8;
/**
 * Pixels of one picture on the atlas: a power of two, so every mip level's
 * texels lie each within one picture down to a texel a picture (`atlasUv`).
 */
export const FRAME_PX = 64;

/** The direction of the picture at (u, v), each 0..1, on the hemi-octahedron (y up). */
export function hemiOctaDirection(u: number, v: number, out: Vector3): Vector3 {
  const x = u - v, z = -1 + u + v;
  return out.set(x, 1 - Math.abs(x) - Math.abs(z), z).normalize();
}

/** The picture's own axes for a direction: right and up in it (the shader's `frameBasis`, the same numbers). */
export function frameBasis(n: Vector3, tangent: Vector3, bitangent: Vector3): void {
  const up = n.y > 0.999 ? new Vector3(-1, 0, 0) : new Vector3(0, 1, 0);
  tangent.crossVectors(up, n).normalize();
  bitangent.crossVectors(n, tangent);
}

const GLSL_COMMON = /* glsl */ `
  #define FRAMES ${FRAMES.toFixed(1)}
  void frameBasis(vec3 n, out vec3 t, out vec3 b) {
    vec3 up = n.y > 0.999 ? vec3(-1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    t = normalize(cross(up, n));
    b = cross(n, t);
  }
`;

export const IMPOSTOR_VERTEX_PARS = /* glsl */ `
  ${GLSL_COMMON}
  attribute vec4 aSpot;
  attribute vec4 aLook;
  uniform float uFade[FAR_PLATES];
  uniform float uScale;
  uniform vec4 uThin;
  uniform vec3 uCentre[FAR_MODELS];
  uniform float uRadius[FAR_MODELS];
  varying vec2 vFrameUv1;
  varying vec2 vFrameUv2;
  varying vec2 vFrameUv3;
  flat varying vec2 vFrame1;
  flat varying vec2 vFrame2;
  flat varying vec2 vFrame3;
  flat varying vec3 vWeights;
  flat varying vec2 vBlock;
  flat varying vec2 vYaw;
  flat varying float vFade;
  flat varying float vTint;

  vec2 hemiOctaEncode(vec3 d) {
    vec3 o = d / dot(d, sign(d));
    return vec2(1.0 + o.x + o.z, 1.0 + o.z - o.x) * 0.5;
  }
  vec3 hemiOctaDecode(vec2 frame) {
    vec2 g = frame / (FRAMES - 1.0);
    vec3 p = vec3(g.x - g.y, 0.0, -1.0 + g.x + g.y);
    p.y = 1.0 - abs(p.x) - abs(p.z);
    return normalize(p);
  }
  /** Where the eye's ray through a corner meets picture \`frame\`'s plane, 0..1 across it. */
  vec2 frameUv(vec2 frame, vec3 eye, vec3 ray, float radius) {
    vec3 n = hemiOctaDecode(frame), t, b;
    frameBasis(n, t, b);
    float along = -dot(eye, n) / dot(ray, n);
    vec3 hit = eye + ray * along;
    return vec2(dot(t, hit), dot(b, hit)) / (2.0 * radius) + 0.5;
  }
`;

/** In place of three's \`begin_vertex\`: \`transformed\` is the corner in the world (the mesh stands at the origin). */
export const IMPOSTOR_VERTEX = /* glsl */ `
  vec3 transformed = aSpot.xyz;
  {
    float plateFloat = floor(aLook.x / 8.0 + 0.01);
    int model = int(aLook.x - plateFloat * 8.0 + 0.5);
    float fade = uFade[int(plateFloat)];
    float size = aSpot.w;
    // How big the tree is on the screen (a share of its height), in either camera.
    vec4 clip = projectionMatrix * viewMatrix * vec4(aSpot.xyz, 1.0);
    float onScreen = size * projectionMatrix[1][1] * 0.5 / max(clip.w, 1e-3);
    // Small on the screen, the woods thinned: a share kept, each grown to keep the cover.
    float keep = clamp(onScreen / uThin.x, uThin.y, 1.0);
    float want = uScale * keep;
    // A tree at the margin shrinks away rather than vanishing.
    float grow = clamp((want - aLook.y) / max(want * 0.15, 1e-4), 0.0, 1.0);
    if (fade > 0.001 && grow > 0.0) {
      size *= grow * inversesqrt(keep);
      vec3 centre = uCentre[model];
      float radius = uRadius[model];
      float c = cos(aLook.z), s = sin(aLook.z);
      // The eye in the model's frame (unit tall, its sphere's centre at the origin); an orthographic
      // camera's eye far back along its axis.
      vec3 eyeWorld = cameraPosition;
      if (projectionMatrix[2][3] == 0.0) eyeWorld = aSpot.xyz + vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) * 1.0e5;
      vec3 rel = (eyeWorld - aSpot.xyz) / size;
      vec3 eye = vec3(c * rel.x - s * rel.z, rel.y, s * rel.x + c * rel.z) - centre;
      vec3 dir = normalize(eye);
      // Never from below: the lowest pictures are level.
      dir = normalize(vec3(dir.x, max(dir.y, 0.0), dir.z) + vec3(0.0, 1e-5, 0.0));
      vec3 qx, qy;
      frameBasis(dir, qx, qy);
      vec3 corner = (qx * position.x + qy * position.y) * (2.0 * radius);
      vec3 ray = normalize(corner - eye);
      vec2 grid = hemiOctaEncode(dir) * (FRAMES - 1.0);
      vec2 cell = min(floor(grid), vec2(FRAMES - 2.0));
      vec2 f = clamp(grid - cell, 0.0, 1.0);
      vec3 w = vec3(min(1.0 - f.x, 1.0 - f.y), abs(f.x - f.y), min(f.x, f.y));
      vWeights = w / max(w.x + w.y + w.z, 1e-4);
      vFrame1 = cell;
      vFrame2 = cell + (f.x >= f.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
      vFrame3 = cell + vec2(1.0);
      vFrameUv1 = frameUv(vFrame1, eye, ray, radius);
      vFrameUv2 = frameUv(vFrame2, eye, ray, radius);
      vFrameUv3 = frameUv(vFrame3, eye, ray, radius);
      vBlock = vec2(mod(float(model), uThin.z), floor(float(model) / uThin.z));
      vYaw = vec2(c, s);
      vFade = fade;
      vTint = aLook.w;
      vec3 local = (centre + corner) * size;
      transformed = aSpot.xyz + vec3(c * local.x + s * local.z, local.y, -s * local.x + c * local.z);
    } else {
      // Not drawn: the corners at one point, no triangle.
      vFade = 0.0;
    }
  }
`;

export const IMPOSTOR_FRAGMENT_PARS = /* glsl */ `
  #define FRAMES ${FRAMES.toFixed(1)}
  #define FRAME_PX ${FRAME_PX.toFixed(1)}
  uniform sampler2D uAlbedo;
  uniform sampler2D uNormals;
  uniform vec4 uThin;
  varying vec2 vFrameUv1;
  varying vec2 vFrameUv2;
  varying vec2 vFrameUv3;
  flat varying vec2 vFrame1;
  flat varying vec2 vFrame2;
  flat varying vec2 vFrame3;
  flat varying vec3 vWeights;
  flat varying vec2 vBlock;
  flat varying vec2 vYaw;
  flat varying float vFade;
  flat varying float vTint;
  /**
   * A picture's place on the atlas, held half a texel of mip level \`level\` inside its frame: the
   * filter never reads the next picture's texels (the pictures sit edge to edge with no margin; read
   * up to the frame's edge, the mips blended the neighbours' leaves into the tree's outline).
   */
  vec2 atlasUv(vec2 uv, vec2 frame, float level) {
    float h = min(0.5 * exp2(level) / FRAME_PX, 0.5);
    return (vBlock * FRAMES + frame + clamp(uv, h, 1.0 - h)) / (FRAMES * uThin.zw);
  }
  /**
   * A picture read with the raw uv's change across the pixel (\`dx\`, \`dy\`, on the atlas): the level is
   * the picture's scale on the screen, the uv held inside its frame at the coarser of the two levels
   * the filter blends.
   */
  vec4 impostorRead(sampler2D atlas, vec2 uv, vec2 frame, vec2 dx, vec2 dy) {
    vec2 texels = vec2(textureSize(atlas, 0));
    float lod = 0.5 * log2(max(max(dot(dx * texels, dx * texels), dot(dy * texels, dy * texels)), 1e-8));
    return textureGrad(atlas, atlasUv(uv, frame, clamp(ceil(lod), 0.0, log2(FRAME_PX))), dx, dy);
  }
`;

/** In place of three's \`map_fragment\`: the three pictures' colour, blended; the cover kept; the fade dissolved by alpha to coverage. */
export const IMPOSTOR_FRAGMENT_MAP = /* glsl */ `
  // Each picture's uv change across the pixel, on the atlas, taken before anything is discarded.
  vec2 impostorAtlas = FRAMES * uThin.zw;
  vec2 impostorDx1 = dFdx(vFrameUv1) / impostorAtlas, impostorDy1 = dFdy(vFrameUv1) / impostorAtlas;
  vec2 impostorDx2 = dFdx(vFrameUv2) / impostorAtlas, impostorDy2 = dFdy(vFrameUv2) / impostorAtlas;
  vec2 impostorDx3 = dFdx(vFrameUv3) / impostorAtlas, impostorDy3 = dFdy(vFrameUv3) / impostorAtlas;
  vec4 impostorColour = impostorRead(uAlbedo, vFrameUv1, vFrame1, impostorDx1, impostorDy1) * vWeights.x
    + impostorRead(uAlbedo, vFrameUv2, vFrame2, impostorDx2, impostorDy2) * vWeights.y
    + impostorRead(uAlbedo, vFrameUv3, vFrame3, impostorDx3, impostorDy3) * vWeights.z;
  {
    vec2 texel = vec2(textureSize(uAlbedo, 0));
    float lod = max(0.0, 0.5 * log2(max(dot(impostorDx1 * texel, impostorDx1 * texel), dot(impostorDy1 * texel, impostorDy1 * texel))));
    float cover = impostorColour.a * (1.0 + lod * 0.3);
    cover = clamp((cover - 0.5) / max(fwidth(cover), 1e-4) + 0.5, 0.0, 1.0) * vFade;
    if (cover < 0.01) discard;
    // Stored premultiplied and gamma-encoded (\`bakeMaterials\`).
    vec3 albedo = pow(impostorColour.rgb / max(impostorColour.a, 1e-4), vec3(2.2)) * vTint;
    diffuseColor = vec4(diffuseColor.rgb * albedo, cover);
  }
`;

/** After three's \`normal_fragment_begin\`: the pictures' normal, from the model's frame to the view's. */
export const IMPOSTOR_FRAGMENT_NORMAL = /* glsl */ `
  {
    vec4 packed = impostorRead(uNormals, vFrameUv1, vFrame1, impostorDx1, impostorDy1) * vWeights.x
      + impostorRead(uNormals, vFrameUv2, vFrame2, impostorDx2, impostorDy2) * vWeights.y
      + impostorRead(uNormals, vFrameUv3, vFrame3, impostorDx3, impostorDy3) * vWeights.z;
    vec3 n = normalize(packed.rgb / max(packed.a, 1e-4) * 2.0 - 1.0);
    vec3 world = vec3(vYaw.x * n.x + vYaw.y * n.z, n.y, -vYaw.y * n.x + vYaw.x * n.z);
    normal = normalize(mat3(viewMatrix) * world);
    nonPerturbedNormal = normal;
  }
`;

const BAKE_FRAGMENT_OUT = /* glsl */ `
  layout(location = 0) out vec4 gColour;
  layout(location = 1) out vec4 gNormal;
`;

/**
 * The materials the pictures are taken with, made at load: the body's
 * faceted colour and face normal (as `flatShading` draws it), the cards'
 * leaves cut by their alpha, each with its normal in the model's frame
 * (the view's turned back by the picture camera's own rotation).
 */
export function bakeMaterials(): { body: ShaderMaterial; cards: ShaderMaterial } {
  const body = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexColors: true,
    vertexShader: /* glsl */ `
      varying vec3 vColour;
      varying vec3 vView;
      void main() {
        vColour = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${BAKE_FRAGMENT_OUT}
      varying vec3 vColour;
      varying vec3 vView;
      void main() {
        vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
        vec3 local = normalize(transpose(mat3(viewMatrix)) * n);
        gColour = vec4(pow(max(vColour, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
        gNormal = vec4(local * 0.5 + 0.5, 1.0);
      }`,
  });
  const cards = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexColors: true,
    side: DoubleSide,
    uniforms: { uLeaves: { value: foliageAtlas() } },
    vertexShader: /* glsl */ `
      attribute vec2 aCorner;
      varying vec3 vColour;
      varying vec3 vNormalLocal;
      varying vec2 vLeafUv;
      void main() {
        vColour = color;
        vNormalLocal = normal;
        vLeafUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        mv.xy += aCorner;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${BAKE_FRAGMENT_OUT}
      uniform sampler2D uLeaves;
      varying vec3 vColour;
      varying vec3 vNormalLocal;
      varying vec2 vLeafUv;
      void main() {
        vec4 leaf = texture(uLeaves, vLeafUv);
        if (leaf.a < 0.5) discard;
        gColour = vec4(pow(max(vColour * leaf.rgb, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
        gNormal = vec4(normalize(vNormalLocal) * 0.5 + 0.5, 1.0);
      }`,
  });
  return { body, cards };
}
