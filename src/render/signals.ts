import { applyPartSway, applyStructureSway } from './wind';
import { castBySize, casterTexel } from './shadowCasters';
import { holdStill } from './stillTree';
import {
  BoxGeometry,
  BufferAttribute,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Quaternion,
  RGBADepthPacking,
  Scene,
  Sphere,
  Vector3,
  type Frustum,
  BufferGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { signalPostPlace } from '@world/signalPosts';
import { JournalCursor } from '@world/derived';
import type { SignalFeed } from '@sim/host/simClient';
import type { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import type { SignalState } from '@sim/signals/query';
import { m } from '@world/units';

/** Physical traffic signal heads. ## Why every head is double-sided A real signal aims its lenses at the traffic it */

/** Signal heads at life size, like everything else in the scene */
const SIGNAL_SCALE = 1;
const u = (metres: number): number => m(metres) * SIGNAL_SCALE;

const POST_HEIGHT = u(6.2);
const POST_RADIUS = u(0.09);
const ARM_LENGTH = u(3.5);
const ARM_RADIUS = u(0.06);
const HEAD_HEIGHT = u(1.05);
const HEAD_WIDTH = u(0.42);
const HEAD_DEPTH = u(0.3);
const LAMP_RADIUS = u(0.15);
const VISOR_DEPTH = u(0.18);
const HEAD_CENTRE = u(5.5);
/** Vertical spacing between lens centres. */
const LAMP_PITCH = HEAD_HEIGHT * 0.3;

type Lamp = 'red' | 'amber' | 'green';
const LAMPS: readonly Lamp[] = ['red', 'amber', 'green'];
/** Which way each lens cluster looks, along the housing's local Z. */
const FACES = [1, -1] as const;

export interface SignalHeads {
  readonly group: Group;
  /** `frustum`: what the camera sees this frame; the lamps of cells out of it wait until they come in. */
  sync(feed: SignalFeed, net: Network, detailed: boolean, frustum?: Frustum): void;
  dispose(): void;
}

/** The heads are batched BY CELL of the ground */
const SIGNAL_CELL = m(256);
/** How far a head's parts reach from the foot of its post, with its sway: the cell's sphere grows by it. */
const HEAD_REACH = Math.hypot(ARM_LENGTH + HEAD_WIDTH, POST_HEIGHT) + m(0.1);

interface Head {
  readonly x: number;
  readonly height: number;
  readonly y: number;
  readonly yaw: number;
  readonly groupId: number;
  readonly key: string;
  state: SignalState | null;
}

/** A signalised junction's heads, and the controller's phase they were last drawn at. */
interface Junction {
  readonly node: NodeId;
  readonly heads: Head[];
  /** The stage seen (`SignalFeed.stage`): the heads are asked again only when it moves. */
  stage: string;
}

/** A cell's meshes: the frame (post, arm and housing as one geometry, one instance a head), the visors, every lens lit or not, the lit lenses' halos. */
type BatchName = 'frame' | 'visors' | 'lenses' | 'halos';

interface Cell {
  readonly junctions: Junction[];
  readonly heads: Head[];
  readonly batches: Record<BatchName, InstancedMesh>;
  readonly sphere: Sphere;
  /** Its lenses lit now. */
  lit: number;
  /** A head's state changed: its lenses are written again (this cell's only). */
  stale: boolean;
}

/** Builds and updates the physical signal heads used by the Three.js renderer. */
export function createSignalHeads(
  scene: Scene,
  elevationAt: (x: number, y: number, segment?: SegmentId) => number = () => 0,
): SignalHeads {
  const group = new Group();
  group.name = 'traffic-signals';
  // DO NOT let the frame recompose every cell's batches: they never move (the sway is the shader's), a still tree (`stillTree.ts`).
  holdStill(group);
  scene.add(group);

  const postGeometry = new CylinderGeometry(POST_RADIUS, POST_RADIUS, POST_HEIGHT, 8);
  const armGeometry = new CylinderGeometry(ARM_RADIUS, ARM_RADIUS, ARM_LENGTH, 8);
  const housingGeometry = new BoxGeometry(HEAD_WIDTH, HEAD_HEIGHT, HEAD_DEPTH);
  // A flat disc rather than a sphere
  const lensGeometry = new CylinderGeometry(LAMP_RADIUS, LAMP_RADIUS, u(0.06), 12).rotateX(
    Math.PI / 2,
  );
  const haloGeometry = new CylinderGeometry(LAMP_RADIUS * 1.8, LAMP_RADIUS * 1.8, u(0.02), 12)
    .rotateX(Math.PI / 2);
  const visorGeometry = new BoxGeometry(LAMP_RADIUS * 2.5, u(0.06), VISOR_DEPTH);

  // Where each part sits in its head, relative to the foot of the post.
  const at = (x: number, y: number, z: number, rotateZ = 0): Matrix4 =>
    new Matrix4().makeRotationZ(rotateZ).setPosition(x, y, z);
  const POST = at(0, POST_HEIGHT / 2, 0);
  const ARM = at(ARM_LENGTH / 2, POST_HEIGHT - u(0.3), 0, -Math.PI / 2);
  const BOX = at(ARM_LENGTH, HEAD_CENTRE, 0);
  const lens: Record<Lamp, Matrix4[]> = { red: [], amber: [], green: [] };
  const halos: Record<Lamp, Matrix4[]> = { red: [], amber: [], green: [] };
  const visors: Matrix4[] = [];
  LAMPS.forEach((name, index) => {
    const y = HEAD_CENTRE + LAMP_PITCH * (1 - index);
    for (const face of FACES) {
      const z = (HEAD_DEPTH / 2 + u(0.03)) * face;
      halos[name].push(at(ARM_LENGTH, y, z * 0.96));
      lens[name].push(at(ARM_LENGTH, y, z));
      // A hood over each lens.
      visors.push(at(ARM_LENGTH, y + LAMP_RADIUS * 1.15, z + (VISOR_DEPTH / 2) * face));
    }
  });

  // A signal post sways a few centimetres at the top in a gust, its arm and heads with it (`applyStructureSway`).
  const SWAY = m(0.05);
  const STEEL = { color: new Color(0x2b302d), roughness: 0.7, metalness: 0.45 };
  const HOUSING = { color: new Color(0x15191a), roughness: 0.78, metalness: 0.1 };
  const housing = new MeshStandardMaterial({ color: HOUSING.color, roughness: HOUSING.roughness, metalness: HOUSING.metalness });
  applyStructureSway(housing, HEAD_CENTRE, POST_HEIGHT, SWAY, 'signal-housing');

  // DO NOT draw the post, the arm and the housing as a mesh each (three draws a cell): one geometry, each part painted and swaying as its own mesh did.
  /** A part of the frame in its head: its colour, roughness and metal, its sway's foot (`applyPartSway`) and its size (`frameDepth`). */
  const framePart = (geometry: BufferGeometry, local: Matrix4, look: typeof STEEL, swayOrigin: number): BufferGeometry => {
    geometry.computeBoundingSphere();
    const part = geometry.clone().applyMatrix4(local);
    const n = part.getAttribute('position').count;
    const colour = new Float32Array(n * 3), surface = new Float32Array(n * 2), sway = new Float32Array(n * 4);
    const reach = new Float32Array(n).fill(geometry.boundingSphere!.radius);
    const e = local.elements;
    for (let i = 0; i < n; i++) {
      colour.set([look.color.r, look.color.g, look.color.b], i * 3);
      surface.set([look.roughness, look.metalness], i * 2);
      sway.set([e[12]!, e[13]!, e[14]!, swayOrigin], i * 4);
    }
    part.setAttribute('color', new BufferAttribute(colour, 3));
    part.setAttribute('aSurface', new BufferAttribute(surface, 2));
    part.setAttribute('aSwayPart', new BufferAttribute(sway, 4));
    part.setAttribute('aCastReach', new BufferAttribute(reach, 1));
    return part;
  };
  const frameParts = [
    framePart(postGeometry, POST, STEEL, POST_HEIGHT / 2),
    framePart(armGeometry, ARM, STEEL, POST_HEIGHT - u(0.3)),
    framePart(housingGeometry, BOX, HOUSING, HEAD_CENTRE),
  ];
  const frameGeometry = mergeGeometries(frameParts)!;
  for (const part of frameParts) part.dispose();
  /** The frame's widest part: what decides whether it casts into a cascade at all (`castBySize`). */
  const frameReach = Math.max(postGeometry.boundingSphere!.radius, armGeometry.boundingSphere!.radius, housingGeometry.boundingSphere!.radius);
  const frame = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, metalness: 1 });
  frame.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aSurface;
        varying vec2 vSurface;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSurface = aSurface;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vSurface;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurface.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurface.y;');
  };
  applyPartSway(frame, POST_HEIGHT, SWAY, 'signal-frame');
  // Its shadow at rest, as the parts' was; a part narrower than the cascade's texel left out of it, as its own mesh was (`casterTexel`).
  const frameDepth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, colorWrite: false });
  frameDepth.onBeforeCompile = (shader) => {
    shader.uniforms.uCastTexel = casterTexel;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aCastReach;
        uniform float uCastTexel;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        if (aCastReach < uCastTexel) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);`);
  };
  frameDepth.customProgramCacheKey = () => 'signal-frame-depth';

  // DO NOT draw the lenses as a mesh a colour and one for the lit: every lens in one mesh, its colours its instance's.
  // Off, but still obviously a coloured filter over a dark can: its colour and glow (`aLensGlow` rgb).
  const DARK: Record<Lamp, { readonly color: Color; readonly glow: Color }> = {
    red: { color: new Color(0x8d221c), glow: new Color(0x2a0705) },
    amber: { color: new Color(0x8a6410), glow: new Color(0x281c04) },
    green: { color: new Color(0x1d6b33), glow: new Color(0x07230f) },
  };
  // Lit lenses keep their hue at full brightness: their colour as it is and untone-mapped, as a basic material draws it (`aLensGlow` a = 1).
  const LIT: Record<Lamp, Color> = {
    red: new Color(0xff4034),
    amber: new Color(0xffb219),
    green: new Color(0x3bf06a),
  };
  const lenses = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0 });
  lenses.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aLensGlow;
        varying vec4 vLensGlow;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLensGlow = aLensGlow;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vLensGlow;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance = vLensGlow.rgb;`)
      .replace('#include <opaque_fragment>', `if (vLensGlow.a > 0.5) outgoingLight = diffuseColor.rgb;
        #include <opaque_fragment>`)
      .replace('#include <tonemapping_fragment>', `if (vLensGlow.a < 0.5) {
        #include <tonemapping_fragment>
        }`);
  };
  const halo = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.28 });
  for (const [k, mat] of [['lens', lenses], ['halo', halo]] as const) {
    applyStructureSway(mat, HEAD_CENTRE, POST_HEIGHT, SWAY, `signal-${k}`);
  }
  const HALO: Record<Lamp, Color> = {
    red: new Color(0xff5145),
    amber: new Color(0xffc850),
    green: new Color(0x59ff86),
  };

  const solid = { cast: true, receive: true };
  const shading = { cast: true, receive: false };
  const glow = { cast: false, receive: false };
  /** Each kind of part: its geometry, material, instances a head, shadows, and whether it takes a colour per instance. */
  const KINDS: Record<BatchName, readonly [BufferGeometry, Material, number, { cast: boolean; receive: boolean }, boolean]> = {
    frame: [frameGeometry, frame, 1, solid, false],
    visors: [visorGeometry, housing, LAMPS.length * FACES.length, shading, false],
    lenses: [lensGeometry, lenses, LAMPS.length * FACES.length, glow, true],
    halos: [haloGeometry, halo, FACES.length, glow, true],
  };
  const NAMES = Object.keys(KINDS) as BatchName[];
  const FIXED: readonly BatchName[] = ['frame', 'visors'];
  const LENSES: readonly BatchName[] = ['lenses', 'halos'];
  /** A cell's batches, sized for its heads, culled by its sphere. */
  /** Each casting batch taken off the casters chosen by cascade when its cell goes (`castBySize`). */
  const uncast = new Map<InstancedMesh, () => void>();
  /** A geometry holding `shape`'s attributes and index themselves (three uploads an attribute once, whatever holds it). */
  const sharing = (shape: BufferGeometry): BufferGeometry => {
    const geometry = new BufferGeometry();
    geometry.setIndex(shape.index);
    for (const [key, attribute] of Object.entries(shape.attributes)) geometry.setAttribute(key, attribute);
    return geometry;
  };
  const batchesFor =(heads: number, sphere: Sphere): Record<BatchName, InstancedMesh> => {
    const out = {} as Record<BatchName, InstancedMesh>;
    for (const name of NAMES) {
      const [shape, material, perHead, shadows, coloured] = KINDS[name];
      const capacity = Math.max(1, heads * perHead);
      // The lenses' glows are their instances': a geometry of the cell's own over the shape's own arrays (never copied, one buffer on the GPU).
      const geometry = name === 'lenses' ? sharing(shape) : shape;
      if (name === 'lenses') {
        const glows = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
        glows.setUsage(DynamicDrawUsage);
        geometry.setAttribute('aLensGlow', glows);
      }
      const mesh = new InstancedMesh(geometry, material, capacity);
      mesh.name = `signal-${name}`;
      mesh.count = 0;
      mesh.castShadow = shadows.cast;
      mesh.receiveShadow = shadows.receive;
      if (name === 'frame') mesh.customDepthMaterial = frameDepth;
      if (shadows.cast) {
        // Cast into a cascade only with heads, and where the part reaches a texel (a visor's hood is a few centimetres): `shadowCasters.ts`.
        if (!geometry.boundingSphere) geometry.computeBoundingSphere();
        const reach = name === 'frame' ? frameReach : geometry.boundingSphere?.radius ?? 0;
        uncast.set(mesh, castBySize({ mesh, casts: true, radius: () => reach }));
      }
      // Culled as a cell, by the sphere round its heads (three's own test, `frustumCulled` left on).
      mesh.boundingSphere = sphere;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      if (coloured) {
        mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
        mesh.instanceColor.setUsage(DynamicDrawUsage);
      }
      group.add(mesh);
      out[name] = mesh;
    }
    return out;
  };

  const root = new Matrix4();
  const place = new Matrix4();
  const turn = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const foot = new Vector3();
  const one = new Vector3(1, 1, 1);
  const HEAD = new Matrix4();
  const put = (mesh: InstancedMesh, local: Matrix4, colour?: Color): void => {
    place.multiplyMatrices(root, local);
    mesh.setMatrixAt(mesh.count, place);
    if (colour) mesh.setColorAt(mesh.count, colour);
    mesh.count++;
  };
  /** What was written of a mesh to the GPU: its first `count` instances. */
  const flush = (mesh: InstancedMesh): void => {
    mesh.visible = mesh.count > 0;
    if (!mesh.count) return;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, mesh.count * 3);
      mesh.instanceColor.needsUpdate = true;
    }
    const glows = mesh.geometry.getAttribute('aLensGlow') as InstancedBufferAttribute | undefined;
    if (glows) {
      glows.clearUpdateRanges();
      glows.addUpdateRange(0, mesh.count * 4);
      glows.needsUpdate = true;
    }
  };
  const rootOf = (head: Head): void => {
    root.compose(foot.set(head.x, head.height, -head.y), turn.setFromAxisAngle(up, head.yaw), one);
  };

  /** What each head shows, by `node:segment`, for the verification harness. */
  const shown = new Map<string, SignalState>();
  group.userData.heads = shown;
  /** The cells by key (`SIGNAL_CELL` of each junction's first head), and each junction's cell. */
  const cells = new Map<number, Cell>();
  const junctionCell = new Map<NodeId, number>();
  /** The network the heads stand on, the junctions' log as last read (`signalChangesSince`), and the land's changes. */
  let placedNetwork: Network | null = null;
  let signalSerial = -1;
  const landRead = new JournalCursor(['terrain', 'elevation']);

  const dropCell = (cell: Cell): void => {
    for (const name of NAMES) {
      const mesh = cell.batches[name];
      uncast.get(mesh)?.();
      uncast.delete(mesh);
      group.remove(mesh);
      mesh.dispose();
      // The lenses' geometry is the cell's own (its glows): the shape's arrays let go of first, or its dispose would free them on the GPU
      // for every other cell too (three r186 `WebGLGeometries` onGeometryDispose removes each attribute the geometry holds).
      const shape = KINDS[name][0];
      if (mesh.geometry !== shape) {
        mesh.geometry.setIndex(null);
        for (const key of Object.keys(shape.attributes)) mesh.geometry.deleteAttribute(key);
        mesh.geometry.dispose();
      }
    }
  };
  const dropCells = (): void => {
    for (const cell of cells.values()) dropCell(cell);
    cells.clear();
    junctionCell.clear();
  };

  /** A cell's lenses written again from its heads' states: that cell's alone. */
  const writeLenses = (cell: Cell): void => {
    const b = cell.batches;
    for (const name of LENSES) b[name].count = 0;
    const glows = b.lenses.geometry.getAttribute('aLensGlow') as InstancedBufferAttribute;
    cell.lit = 0;
    for (const head of cell.heads) {
      rootOf(head);
      for (const name of LAMPS) {
        const on = head.state === name;
        for (let face = 0; face < FACES.length; face++) {
          if (on) {
            glows.setXYZW(b.lenses.count, 0, 0, 0, 1);
            put(b.lenses, lens[name][face] as Matrix4, LIT[name]);
            put(b.halos, halos[name][face] as Matrix4, HALO[name]);
            cell.lit++;
          } else {
            const dark = DARK[name];
            glows.setXYZW(b.lenses.count, dark.glow.r, dark.glow.g, dark.glow.b, 0);
            put(b.lenses, lens[name][face] as Matrix4, dark.color);
          }
        }
      }
    }
    for (const name of LENSES) flush(b[name]);
    cell.stale = false;
  };

  /** A signalised junction's heads, one on each approach of a signal group, where the world stands its post. */
  const junctionOf = (feed: SignalFeed, net: Network, node: NodeId): Junction | null => {
    const layout = feed.layout(node);
    if (!layout?.groups.length) return null;
    const nodeRecord = net.doc.node(node);
    if (!nodeRecord) return null;
    const heads: Head[] = [];
    for (const segmentId of nodeRecord.incident) {
      const segment = net.doc.segment(segmentId);
      if (!segment) continue;
      const signalGroup = layout.groups.find((candidate) => candidate.segments.includes(segmentId));
      if (!signalGroup) continue;
      // Where the post stands is the world's (`world/signalPosts.ts`): the pedestrians walk round the same post.
      const post = signalPostPlace(net, node, segmentId);
      if (!post) continue;
      heads.push({
        x: post.x,
        height: elevationAt(post.x, post.y, segmentId),
        y: post.y,
        // Local +X carries the arm inward over the road.
        yaw: post.yaw,
        groupId: signalGroup.id,
        key: `${node}:${segmentId}`,
        state: null,
      });
    }
    return heads.length ? { node, heads, stage: '' } : null;
  };
  const cellKeyOf = (j: Junction): number => Math.floor(j.heads[0]!.x / SIGNAL_CELL) * 100_003 + Math.floor(j.heads[0]!.y / SIGNAL_CELL);
  /** A cell's batches made again from its junctions: that cell's alone. */
  const buildCell = (key: number, junctions: Junction[]): void => {
    const was = cells.get(key);
    if (was) { dropCell(was); cells.delete(key); }
    if (!junctions.length) return;
    const heads = junctions.flatMap((j) => j.heads);
    let cx = 0, cy = 0, cz = 0;
    for (const h of heads) { cx += h.x; cy += h.height; cz -= h.y; }
    cx /= heads.length; cy /= heads.length; cz /= heads.length;
    let r = 0;
    for (const h of heads) r = Math.max(r, Math.hypot(h.x - cx, h.height - cy, -h.y - cz));
    const sphere = new Sphere(new Vector3(cx, cy, cz), r + HEAD_REACH);
    const cell: Cell = { junctions, heads, batches: batchesFor(heads.length, sphere), sphere, lit: 0, stale: true };
    for (const head of heads) {
      rootOf(head);
      put(cell.batches.frame, HEAD);
      for (const visor of visors) put(cell.batches.visors, visor);
    }
    for (const name of FIXED) flush(cell.batches[name]);
    for (const name of LENSES) cell.batches[name].visible = false;
    cells.set(key, cell);
  };
  const countLamps = (): void => {
    let lamps = 0;
    for (const cell of cells.values()) lamps += cell.heads.length * LAMPS.length * FACES.length;
    group.userData.lamps = lamps;
  };

  /** @rebuild Every head of the map placed again, cell by cell. */
  const placeAll = (feed: SignalFeed, net: Network): void => {
    dropCells();
    shown.clear();
    const byCell = new Map<number, Junction[]>();
    for (const node of feed.nodes()) {
      const entry = junctionOf(feed, net, node);
      if (!entry) continue;
      const key = cellKeyOf(entry);
      junctionCell.set(node, key);
      const list = byCell.get(key);
      if (list) list.push(entry); else byCell.set(key, [entry]);
    }
    for (const [key, junctions] of byCell) buildCell(key, junctions);
    countLamps();
  };

  /** These junctions placed again, and the cells they left or came into made again. */
  const placeSome = (feed: SignalFeed, net: Network, nodes: Iterable<NodeId>): void => {
    const touched = new Map<number, Junction[]>();
    const cellJunctions = (key: number): Junction[] => {
      let list = touched.get(key);
      if (!list) touched.set(key, list = [...(cells.get(key)?.junctions ?? [])]);
      return list;
    };
    for (const node of new Set(nodes)) {
      const was = junctionCell.get(node);
      if (was !== undefined) {
        const list = cellJunctions(was);
        const at = list.findIndex((j) => j.node === node);
        if (at >= 0) for (const head of list[at]!.heads) shown.delete(head.key);
        if (at >= 0) list.splice(at, 1);
        junctionCell.delete(node);
      }
      const entry = junctionOf(feed, net, node);
      if (!entry) continue;
      const key = cellKeyOf(entry);
      junctionCell.set(node, key);
      cellJunctions(key).push(entry);
    }
    for (const [key, junctions] of touched) buildCell(key, junctions);
    countLamps();
  };

  return {
    group,
    sync(feed, net, detailed, frustum) {
      if (!detailed) {
        group.visible = false;
        return;
      }
      group.visible = true;
      // DO NOT place every head of the map again on a revision of the network, the traffic, the land or the topology
      const log = feed.changesSince(signalSerial);
      const land = landRead.read(net.doc.changes);
      if (placedNetwork !== net || log.nodes === null || land === null || land.some((e) => e.rects === null)) {
        placedNetwork = net;
        placeAll(feed, net);
      } else {
        const nodes = new Set<NodeId>(log.nodes);
        for (const entry of land) {
          for (const rect of entry.rects!) {
            for (const id of net.segmentCells.idsMeeting(rect)) {
              const segment = net.doc.segment(id);
              if (segment) { nodes.add(segment.a); nodes.add(segment.b); }
            }
          }
        }
        if (nodes.size) placeSome(feed, net, nodes);
      }
      signalSerial = log.serial;
      // DO NOT ask every head of the map each frame, nor write every lens of the map at a change of one.
      let litLenses = 0;
      for (const cell of cells.values()) {
        if (frustum && !frustum.intersectsSphere(cell.sphere)) continue;
        for (const junction of cell.junctions) {
          const stage = feed.stage(junction.node);
          if (junction.stage === stage && junction.heads[0]!.state !== null) continue;
          junction.stage = stage;
          for (const head of junction.heads) {
            const state = feed.state(junction.node, head.groupId);
            if (head.state === state) continue;
            head.state = state;
            shown.set(head.key, state);
            cell.stale = true;
          }
        }
        if (cell.stale) writeLenses(cell);
        litLenses += cell.lit;
      }
      group.userData.litLamps = litLenses;
    },
    dispose() {
      scene.remove(group);
      dropCells();
      group.clear();
      shown.clear();
      for (const geometry of [
        postGeometry,
        armGeometry,
        housingGeometry,
        frameGeometry,
        lensGeometry,
        haloGeometry,
        visorGeometry,
      ]) {
        geometry.dispose();
      }
      const materials: Material[] = [frame, frameDepth, housing, lenses, halo];
      for (const material of materials) material.dispose();
    },
  };
}
