import { ACESFilmicToneMapping, MeshDepthMaterial, PCFSoftShadowMap, RGBADepthPacking, SRGBColorSpace, type Material, type Object3D } from 'three';
import { WebGLPrograms } from 'three/src/renderers/webgl/WebGLPrograms.js';

/** The programs three r186 builds for what `roots` draw, by its own key (`WebGLPrograms.getParameters` + `getProgramCacheKey`), with the game's renderer settings: a sun with its shadow, reversed depth, ACES, sRGB; and each caster's depth program. */
export function programKeys(roots: readonly Object3D[]): Set<string> {
  const renderer = {
    getRenderTarget: () => null, state: { buffers: { depth: { getReversed: () => true } } }, toneMapping: ACESFilmicToneMapping,
    outputColorSpace: SRGBColorSpace, shadowMap: { enabled: true, type: PCFSoftShadowMap }, localClippingEnabled: false,
  };
  const environments = { get: () => null };
  const extensions = { has: () => true };
  const capabilities = { logarithmicDepthBuffer: false, reversedDepthBuffer: true, precision: 'highp', getMaxPrecision: () => 'highp', vertexTextures: true, floatVertexTextures: true, maxBones: 1024 };
  const clipping = { numPlanes: 0, numIntersection: 0 };
  const programs = new WebGLPrograms(renderer as never, environments as never, extensions as never, capabilities as never, {} as never, clipping as never);
  const lights = { sun: [], directional: [{}], point: [], spot: [], spotLightMap: [], rectArea: [], hemi: [{}], sunShadowMap: [], directionalShadowMap: [{}], pointShadowMap: [], spotShadowMap: [], numSpotLightShadowsWithMaps: 0, numLightProbes: 0 };
  const scene = { fog: null, environment: null };
  const keys = new Set<string>();
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  const add = (material: Material, object: Object3D, shadows: unknown[]): void => {
    const parameters = programs.getParameters(material, lights as never, shadows as never, scene as never, object, [] as never);
    keys.add(programs.getProgramCacheKey(parameters as never));
  };
  for (const root of roots) root.traverse((o) => {
    const mesh = o as Object3D & { isMesh?: boolean; material?: Material | Material[]; customDepthMaterial?: Material };
    if (!mesh.isMesh || !mesh.material) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) add(material, mesh, [{}]);
    if (mesh.castShadow) add(mesh.customDepthMaterial ?? depth, mesh, []);
  });
  return keys;
}
