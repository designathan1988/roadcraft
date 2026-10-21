import type { Color, Material, Mesh, ShaderMaterial, Texture, Vector3, Vector4 } from 'three';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, type Node, type NodeMaterial } from 'three/webgpu';
import {
  abs, attribute, bitAnd, cameraPosition, cameraProjectionMatrix, clamp, distance, dot, float, int, ivec2, max, mix, modelViewMatrix, normalize,
  positionLocal, pow, select, smoothstep, sqrt, textureLoad, transformNormalToView, uniform, uniformArray, varying, vec3, vec4,
} from 'three/tsl';
import { LOD_PATCH } from '../terrainLevels';
import type { LandGrid } from '../terrainLod';

/** THE GAME'S OWN MATERIALS REWRITTEN IN NODES (TSL), for the WebGPU renderer (`MIGRACAO-WEBGPU.md`): each twin draws what its WebGL material
 *  draws, reading the SAME uniforms' objects (a colour or a direction changed in place is seen by both), and replaces it in the WebGPU frame
 *  only once `scripts/look.mjs` `compare` shows the two pictures equal. A material with no twin and no node equivalent is left out and named. */

interface Twin {
  /** Whether this twin draws that mesh's material. */
  matches(mesh: Mesh, material: Material): boolean;
  make(material: Material, mesh: Mesh): NodeMaterial;
  /** `faithful`: drawn as the WebGL material draws (the comparison says how near); `simple`: the right shape with a plain finish, to see the scene until its faithful twin comes (`MIGRACAO-WEBGPU.md` stage 2). */
  readonly kind: 'faithful' | 'simple';
}

/** The sky dome (`environment.ts` SKY_VERTEX / SKY_FRAGMENT), line for line. */
const sky: Twin = {
  kind: 'faithful',
  matches: (mesh, material) => mesh.name === 'sky' && (material as ShaderMaterial).isShaderMaterial === true,
  make(material) {
    const u = (material as ShaderMaterial).uniforms as Record<'uZenith' | 'uHorizon' | 'uGround' | 'uSunColor', { value: Color }> & { uSunDirection: { value: Vector3 } };
    const zenith = uniform(u.uZenith.value), horizon = uniform(u.uHorizon.value), ground = uniform(u.uGround.value);
    const sunDirection = uniform(u.uSunDirection.value), sunColor = uniform(u.uSunColor.value);
    const direction = varying(normalize(positionLocal));
    const twin = new MeshBasicNodeMaterial({ side: material.side, depthWrite: false, depthTest: false, fog: false });
    twin.name = 'sky (nodes)';
    // Never clipped by the far plane (the GLSL pushes it onto it): a depth of 0 is inside WebGPU's 0..1 clip range in either convention, and the dome tests and writes no depth.
    const clip = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(positionLocal, 1));
    twin.vertexNode = vec4(clip.x, clip.y, 0, clip.w);
    const h = normalize(direction).y;
    const above = mix(horizon, zenith, pow(clamp(h, 0, 1), 0.62));
    const level = mix(ground, above, smoothstep(-0.12, 0.02, h));
    const sun = max(dot(normalize(direction), sunDirection), 0);
    twin.fragmentNode = vec4(level.add(sunColor.mul(pow(sun, 7).mul(0.28).add(pow(sun, 120).mul(0.9)))), 1);
    return twin;
  },
};

// three's typings (r186) give clamp and bitAnd no integer vectors, which its node builder takes (WGSL clamp and & on vec2<i32>).
const clampCorner = clamp as unknown as (x: Node<'ivec2'>, low: Node<'ivec2'>, high: Node<'ivec2'>) => Node<'ivec2'>;
const integerAnd = bitAnd as unknown as (a: Node<'ivec2'>, b: Node<'ivec2'>) => Node<'ivec2'>;

/** What a plate's patches are placed with (`terrain.ts` patchMesh `userData.landLod`). */
interface LandLodData {
  uniforms: { uLand: { value: Texture }; uLodMorph: { value: Float32Array }; uLodSkirt: { value: Vector4 } };
  grid: LandGrid;
}

/** The ground's patches (`terrainLod.ts` lodVertexGlsl): placed, read from the land's texels and morphed exactly as WebGL does, so the
 *  relief stands where it stands; its finish one plain grass tone, lit (the splat, the paint, the water's edge and the lots wait for the
 *  ground's faithful twin, stage 2). */
const ground: Twin = {
  kind: 'simple',
  matches: (mesh) => mesh.userData['landLod'] !== undefined,
  make(material, mesh) {
    const { uniforms: u, grid } = mesh.userData['landLod'] as LandLodData;
    const origin = uniform((material.userData['terrainUniforms'] as { uTileOrigin: { value: Vector3 } }).uTileOrigin.value);
    const morphs = uniformArray(u.uLodMorph.value as unknown as number[], 'float');
    const skirt = uniform(u.uLodSkirt.value);
    const land = u.uLand.value;
    const patch = attribute('aLodPatch', 'vec4');
    const v = attribute('position', 'ivec3');
    const texel = (c: Node<'ivec2'>): Node<'vec4'> => textureLoad(land, clampCorner(c, ivec2(0, 0), ivec2(grid.seg, grid.seg))) as unknown as Node<'vec4'>;
    const normalOf = (t: Node<'vec4'>): Node<'vec3'> => vec3(t.x, sqrt(max(0, float(1).sub(t.x.mul(t.x)).sub(t.y.mul(t.y)))), t.y);
    const point = (c: Node<'ivec2'>, h: Node<'float'>): Node<'vec3'> => vec3(float(c.x).mul(grid.cell).sub(grid.half), h, float(c.y).mul(grid.cell).sub(grid.half));
    const start = ivec2(patch.xy), step = int(patch.z);
    /** A corner of the patch, moved towards the next level's by its own distance (`landCorner`). */
    const corner = (g: Node<'ivec2'>): { p: Node<'vec3'>; n: Node<'vec3'>; k: Node<'float'> } => {
      const c = start.add(g.mul(step));
      const t = texel(c);
      const p = point(c, t.w);
      const level = int(patch.w).mul(2);
      const k = clamp(distance(p.add(origin), cameraPosition).sub(morphs.element(level) as unknown as Node<'float'>).mul(morphs.element(level.add(1)) as unknown as Node<'float'>), 0, 1);
      const odd = integerAnd(g, ivec2(1, 1));
      const to = start.add(g.sub(odd).mul(step));
      const next = texel(to);
      const moved = select(odd.x.add(odd.y).greaterThan(int(0)), k, float(0));
      return { p: mix(p, point(to, next.w), moved), n: mix(normalOf(t), normalOf(next), moved), k };
    };
    const role = v.z;
    const a = corner(v.xy), b = corner(v.xy.add(ivec2(0, 1))), c = corner(v.xy.add(ivec2(1, 1))), d = corner(v.xy.add(ivec2(1, 0)));
    const unmorphed = patch.w.equal(0).and(a.k.add(b.k).add(c.k).add(d.k).equal(0));
    const flip = select(unmorphed, texel(start.add(v.xy)).z.greaterThan(0.5), abs(a.p.y.sub(c.p.y)).add(0.5).lessThan(abs(b.p.y.sub(d.p.y))));
    const which = select(role.equal(int(2)), select(flip, int(2), int(3)), select(role.equal(int(3)), select(flip, int(0), int(1)),
      select(role.equal(int(4)), int(2), select(role.equal(int(5)), int(3), role))));
    const pick = (x: Node<'vec3'>, y: Node<'vec3'>, z: Node<'vec3'>, w: Node<'vec3'>): Node<'vec3'> => select(which.equal(int(0)), x, select(which.equal(int(1)), y, select(which.equal(int(2)), z, w)));
    // The rim's strips: hung from the edge corners, down by the skirt on a plate's own edge.
    const side = role.sub(int(6)).shiftRight(int(1));
    const end = step.mul(int(LOD_PATCH));
    const onEdge = select(side.equal(int(0)), start.x.equal(int(0)), select(side.equal(int(1)), start.x.add(end).equal(int(grid.seg)),
      select(side.equal(int(2)), start.y.equal(int(0)), start.y.add(end).equal(int(grid.seg)))));
    const hang = select(side.equal(int(0)), skirt.x, select(side.equal(int(1)), skirt.y, select(side.equal(int(2)), skirt.z, skirt.w)));
    const bottom = role.sub(int(6)).bitAnd(int(1)).equal(int(1));
    const rimP = a.p.sub(vec3(0, select(onEdge.and(bottom), hang, float(0)), 0));
    const inPatch = role.lessThan(int(6));
    const twin = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0, envMapIntensity: (material as Material & { envMapIntensity?: number }).envMapIntensity ?? 1 });
    twin.name = 'terrain (nodes, simple)';
    twin.positionNode = select(inPatch, pick(a.p, b.p, c.p, d.p), rimP);
    twin.normalNode = transformNormalToView(varying(select(inPatch, pick(a.n, b.n, c.n, d.n), a.n)));
    // The WebGL ground's mean grass, read off its picture under the same light (`scripts/look.mjs` compare, 2026-10-21), linear.
    twin.colorNode = vec3(0.037, 0.054, 0.021);
    return twin;
  },
};

const TWINS: readonly Twin[] = Object.freeze([sky, ground]);

export interface MadeTwin {
  readonly material: NodeMaterial;
  readonly kind: Twin['kind'];
}

/** The node twins of the game's materials, each made once, for the renderer that asks them. */
export function createTwins(): (mesh: Mesh, material: Material) => MadeTwin | null {
  const made = new WeakMap<Material, MadeTwin>();
  /** The node twin of this mesh's material, or null when it has none. */
  return (mesh, material) => {
    const kept = made.get(material);
    if (kept) return kept;
    const twin = TWINS.find((t) => t.matches(mesh, material));
    if (!twin) return null;
    const one = { material: twin.make(material, mesh), kind: twin.kind };
    made.set(material, one);
    return one;
  };
}
