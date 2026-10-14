import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';

import type { Vec2 } from '@core/vec2';
import type { NodeId, SegmentId } from '@world/ids';
import { footwayAt, type LandscapeItem, type SignType } from '@world/landscape';
import type { Network } from '@world/network';
import { type RoadElevation } from '@world/elevation';
import { footwayRiseAt } from '@world/roads/footwayRise';
import { derivedSigns } from '@world/roads/derivedSigns';
import { sectionOf, LAMP_ZONE } from '@world/section';
import { m } from '@world/units';

/**
 * Signs on the streets: the ones placed with the sign tool (a kind and, for
 * some, the player's words) and the name plates of every named street, at its
 * corners. Each plate is painted once on a canvas - as a real sign is a
 * printed sheet on a post - and stood on the footway it was placed on.
 */

export interface SignLayer {
  readonly group: Group;
  dispose(): void;
}

/** Plate size by type, metres, and its centre's height above the footway. */
const PLATE: Readonly<Record<SignType, { w: number; h: number; z: number }>> = {
  stop: { w: 0.75, h: 0.75, z: 2.2 },
  yield: { w: 0.8, h: 0.7, z: 2.2 },
  speed: { w: 0.6, h: 0.6, z: 2.2 },
  noParking: { w: 0.6, h: 0.6, z: 2.2 },
  noEntry: { w: 0.6, h: 0.6, z: 2.2 },
  pedestrian: { w: 0.7, h: 0.7, z: 2.2 },
  school: { w: 0.7, h: 0.7, z: 2.2 },
  direction: { w: 1.6, h: 0.5, z: 2.4 },
  street: { w: 1.0, h: 0.28, z: 2.6 },
  info: { w: 1.0, h: 0.6, z: 2.2 },
};

/** The post's radius at its top (`buildSigns` post). */
const POST_RADIUS = m(0.04);
/** How far a plate's face stands out from the post's axis: the post's radius and a bracket's 2 cm. */
export const FACE_OUT = POST_RADIUS + m(0.02);
/** Half the thickness of a street's name plate: its two blades back to back, on top of the post. */
export const BLADE_HALF = m(0.005);

/** Whether the plate stands on top of its post (a street's name, two blades) rather than on its front. */
export const onTopOfPost = (type: SignType): boolean => type === 'street';

/**
 * The faces of a plate whose face looks along world (sin yaw, -cos yaw):
 * where each stands, off the post's axis, and the way it looks. A plate was
 * one quad through the post's axis: half the post stood in front of its
 * face, a grey band across the middle of a street's name (seen 2026-10-11,
 * "Rua Cast|ro Alves"), and a name plate read from behind was mirrored. A
 * face stands in front of the post, as a sign is bolted to the front of its
 * post; a street's name plate, read from both sides of the street, is two
 * blades back to back on top of its post (`onTopOfPost`), each face the
 * right way round - apart by the post's width, the gap between them showed
 * the other blade's back from the side.
 */
export function plateFaces(type: SignType, x: number, y: number, yaw: number): { x: number; y: number; yaw: number }[] {
  const out = onTopOfPost(type) ? BLADE_HALF : FACE_OUT;
  const face = (turn: number) => ({ x: x + Math.sin(turn) * out, y: y - Math.cos(turn) * out, yaw: turn });
  return type === 'street' ? [face(yaw), face(yaw + Math.PI)] : [face(yaw)];
}

function plateCanvas(type: SignType, text: string): HTMLCanvasElement {
  const plate = PLATE[type];
  const W = 256, H = Math.max(64, Math.round((256 * plate.h) / plate.w));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 4;
  const fit = (s: string, max: number, size: number): void => {
    let px = size;
    g.font = `700 ${px}px system-ui, sans-serif`;
    while (g.measureText(s).width > max && px > 10) { px -= 2; g.font = `700 ${px}px system-ui, sans-serif`; }
  };
  const circle = (fill: string, ring: string | null): void => {
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = ring ?? fill; g.fill();
    if (ring) { g.beginPath(); g.arc(cx, cy, r * 0.8, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); }
  };
  g.textAlign = 'center'; g.textBaseline = 'middle';
  switch (type) {
    case 'stop': {
      g.beginPath();
      for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + (i * Math.PI) / 4; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
      g.closePath(); g.fillStyle = '#ffffff'; g.fill();
      g.beginPath();
      for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + (i * Math.PI) / 4; g.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9); }
      g.closePath(); g.fillStyle = '#c8102e'; g.fill();
      g.fillStyle = '#fff'; fit('PARE', r * 1.5, 72); g.fillText('PARE', cx, cy + 4);
      break;
    }
    case 'yield': {
      const tri = (k: number, fill: string): void => {
        g.beginPath(); g.moveTo(cx - r * k, cy - r * 0.8 * k); g.lineTo(cx + r * k, cy - r * 0.8 * k); g.lineTo(cx, cy + r * 0.95 * k); g.closePath(); g.fillStyle = fill; g.fill();
      };
      tri(1, '#c8102e'); tri(0.72, '#ffffff');
      break;
    }
    case 'speed': {
      circle('#ffffff', '#c8102e');
      g.fillStyle = '#111'; fit(text || '40', r * 1.2, 96); g.fillText(text || '40', cx, cy + 4);
      break;
    }
    case 'noParking': {
      circle('#1f4fa0', '#c8102e');
      g.fillStyle = '#fff'; g.font = `700 ${Math.round(r * 1.1)}px system-ui, sans-serif`; g.fillText('E', cx, cy + 4);
      g.strokeStyle = '#c8102e'; g.lineWidth = r * 0.16; g.beginPath(); g.moveTo(cx - r * 0.6, cy - r * 0.6); g.lineTo(cx + r * 0.6, cy + r * 0.6); g.stroke();
      break;
    }
    case 'noEntry': {
      circle('#c8102e', null);
      g.fillStyle = '#fff'; g.fillRect(cx - r * 0.65, cy - r * 0.16, r * 1.3, r * 0.32);
      break;
    }
    case 'pedestrian':
    case 'school': {
      g.save(); g.translate(cx, cy); g.rotate(Math.PI / 4);
      g.fillStyle = '#111'; g.fillRect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4);
      g.fillStyle = '#f2c500'; g.fillRect(-r * 0.66, -r * 0.66, r * 1.32, r * 1.32);
      g.restore();
      g.fillStyle = '#111';
      if (type === 'school') { fit('ESCOLA', r * 1.1, 40); g.fillText('ESCOLA', cx, cy + 2); }
      else {
        // A walking figure.
        g.beginPath(); g.arc(cx, cy - r * 0.35, r * 0.11, 0, Math.PI * 2); g.fill();
        g.lineWidth = r * 0.09; g.strokeStyle = '#111'; g.lineCap = 'round';
        g.beginPath(); g.moveTo(cx, cy - r * 0.2); g.lineTo(cx - r * 0.05, cy + r * 0.12);
        g.lineTo(cx - r * 0.22, cy + r * 0.4); g.moveTo(cx - r * 0.05, cy + r * 0.12); g.lineTo(cx + r * 0.15, cy + r * 0.4);
        g.moveTo(cx - r * 0.2, cy - r * 0.02); g.lineTo(cx, cy - r * 0.15); g.lineTo(cx + r * 0.2, cy); g.stroke();
      }
      break;
    }
    case 'direction':
    case 'street':
    case 'info': {
      const bg = type === 'direction' ? '#1b6e3a' : '#1f4fa0';
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
      g.fillStyle = bg; g.fillRect(4, 4, W - 8, H - 8);
      g.fillStyle = '#fff';
      const words = text || (type === 'street' ? 'Rua' : type === 'direction' ? 'Centro' : 'Informação');
      if (type === 'direction') {
        fit(words, W - 70, Math.round(H * 0.5)); g.fillText(words, (W - 40) / 2, cy + 2);
        g.beginPath(); g.moveTo(W - 14, cy); g.lineTo(W - 44, cy - H * 0.3); g.lineTo(W - 44, cy + H * 0.3); g.closePath(); g.fill();
      } else {
        fit(words, W - 20, Math.round(H * 0.55)); g.fillText(words, cx, cy + 2);
      }
      break;
    }
  }
  return c;
}

/** The segments a street's name runs along: the one under the point, carried straight on through its nodes. */
function streetChain(net: Network, at: Vec2): SegmentId[] {
  let seed: SegmentId | null = null, best = Infinity;
  // Only the ribbons within the reach a seed may be found at, filed by place,
  // in the order of `ribbons` (the first of equals is the same one): NOT every
  // ribbon of the map for every name sign (docs/AUDITORIA-2026-10-14.md C3).
  const reach = m(30);
  for (const ribbon of net.ribbonsMeeting([at.x - reach, at.y - reach, at.x + reach, at.y + reach])) {
    const d = ribbon.full.distanceTo(at);
    if (d < best) { best = d; seed = ribbon.id; }
  }
  if (seed === null || best > reach) return [];
  const doc = net.doc;
  const chain = new Set<SegmentId>([seed]);
  const dirAt = (seg: SegmentId, node: NodeId): Vec2 | null => {
    const s = doc.segment(seg), r = net.ribbons.get(seg);
    if (!s || !r) return null;
    // Direction leaving `node` along `seg`.
    const f = s.a === node ? r.full.sampleAt(Math.min(r.full.length, m(3))) : r.full.sampleAt(Math.max(0, r.full.length - m(3)));
    const n = doc.node(node)!;
    const dx = f.p.x - n.x, dy = f.p.y - n.y, l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  };
  const walk = (seg: SegmentId, node: NodeId): void => {
    for (let guard = 0; guard < 200; guard++) {
      const inbound = dirAt(seg, node);
      const n = doc.node(node);
      if (!inbound || !n) return;
      let next: SegmentId | null = null;
      for (const other of n.incident) {
        if (other === seg || chain.has(other)) continue;
        const out = dirAt(other, node);
        // Straight on: leaving opposite to the way we came in, within 25 degrees.
        if (out && out.x * -inbound.x + out.y * -inbound.y > Math.cos((25 * Math.PI) / 180)) next = other;
      }
      if (next === null) return;
      chain.add(next);
      const s = doc.segment(next)!;
      node = s.a === node ? s.b : s.a;
      seg = next;
    }
  };
  const s0 = doc.segment(seed)!;
  walk(seed, s0.a);
  walk(seed, s0.b);
  return [...chain];
}

/**
 * The plates' pictures, all on one sheet (a texture atlas: the three.js
 * manual's "Optimize Lots of Objects" merges what shares a material), each
 * plate in a cell of its own, painted once and kept from one build of the
 * signs to the next. Every plate was its own mesh and material, transparent
 * and two-sided: two draws for the picture and one for the shadow, about 2
 * draws a plate (audit S1: +237 draws for 113 plates). The plates are now one
 * mesh: opaque, cut by `alphaTest` as before (a two-sided transparent
 * material is drawn twice by three, back faces then front; an opaque one
 * once: `Material.forceSinglePass`, `WebGLRenderer.renderObject`).
 */
/** A cell of the sheet: a plate canvas is 256 wide and up to 256 tall, with a gutter so the mipmaps do not bleed into the neighbours. */
const CELL = 256;
const GUTTER = 8;
const PITCH = CELL + 2 * GUTTER;
const COLUMNS = 8;
interface Atlas {
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  readonly material: MeshStandardMaterial;
  /** Each plate's cell and the height its picture takes in it, by type and words. */
  readonly cells: Map<string, { cell: number; h: number; build: number }>;
  readonly free: number[];
  rows: number;
}
let atlas: Atlas | null = null;
let builds = 0;
function newAtlas(rows: number, from: Atlas | null): Atlas {
  const canvas = document.createElement('canvas');
  canvas.width = COLUMNS * PITCH;
  canvas.height = rows * PITCH;
  if (from) canvas.getContext('2d')!.drawImage(from.canvas, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  if (from) {
    // Grown: the same material on the larger sheet (no new program).
    from.texture.dispose();
    from.material.map = texture;
    from.material.needsUpdate = true;
    return { canvas, texture, material: from.material, cells: from.cells, free: [...from.free, ...range(from.rows * COLUMNS, rows * COLUMNS)], rows };
  }
  const material = new MeshStandardMaterial({ map: texture, alphaTest: 0.5, side: DoubleSide, roughness: 0.5, metalness: 0.1 });
  return { canvas, texture, material, cells: new Map(), free: range(0, rows * COLUMNS), rows };
}
const range = (a: number, b: number): number[] => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
/** The cell of a plate on the sheet (painted there the first time), and the height its picture takes. */
function plateCell(type: SignType, text: string): { readonly cell: number; readonly h: number } {
  atlas ??= newAtlas(4, null);
  const key = `${type}|${text}`;
  let known = atlas.cells.get(key);
  if (!known) {
    if (!atlas.free.length) atlas = newAtlas(atlas.rows * 2, atlas);
    const cell = atlas.free.shift()!;
    const picture = plateCanvas(type, text);
    const g = atlas.canvas.getContext('2d')!;
    const x = (cell % COLUMNS) * PITCH + GUTTER, y = Math.floor(cell / COLUMNS) * PITCH + GUTTER;
    g.clearRect(x - GUTTER, y - GUTTER, PITCH, PITCH);
    g.drawImage(picture, x, y);
    atlas.texture.needsUpdate = true;
    known = { cell, h: picture.height, build: builds };
    atlas.cells.set(key, known);
  }
  known.build = builds;
  return known;
}
/**
 * A cell's corners on the sheet as it stands, uv. Read once every plate of a
 * build is on it: the sheet may grow while they are painted.
 */
function cellUv(cell: number, h: number): { u0: number; v0: number; u1: number; v1: number } {
  const W = atlas!.canvas.width, H = atlas!.canvas.height;
  const x = (cell % COLUMNS) * PITCH + GUTTER, y = Math.floor(cell / COLUMNS) * PITCH + GUTTER;
  // A canvas texture is flipped (`flipY`): v runs up from the sheet's bottom.
  return { u0: x / W, u1: (x + CELL) / W, v0: 1 - (y + h) / H, v1: 1 - y / H };
}

/** The signs' post, one shape and one material for every sign of every build (NÃO criar por reconstrução). */
const POST = { geometry: new CylinderGeometry(POST_RADIUS, m(0.045), 1, 8), material: new MeshStandardMaterial({ color: 0x8e979b, roughness: 0.45, metalness: 0.6 }) };

/** The corners of three's plane of 1 x 1 (`PlaneGeometry`), and its two triangles. */
const QUAD = [[-0.5, 0.5], [0.5, 0.5], [-0.5, -0.5], [0.5, -0.5]] as const;
const QUAD_ORDER = [0, 2, 1, 2, 3, 1] as const;

export function buildSigns(net: Network, elevation: RoadElevation, items: Iterable<LandscapeItem>): SignLayer {
  const group = new Group();
  group.name = 'signs';
  if (typeof document === 'undefined') return { group, dispose() {} };
  builds++;
  // The post's shape and material are the module's (`POST`), made once: a
  // rebuild of the signs (every road, ground or landscaping change) made and
  // disposed a material (CLAUDE.md: "Never create a material inside a rebuild").
  const { geometry: post, material: postMaterial } = POST;
  const owned: { dispose(): void }[] = [];
  /** The posts, one instance each (`setPosts` at the end): a mesh and a draw each before. */
  const posts: Matrix4[] = [];
  /** The plates' quads, merged into one mesh at the end. */
  const position: number[] = [], normal: number[] = [];
  /** Each quad's cell on the sheet, its uv filled in at the end (`cellUv`). */
  const quads: { readonly cell: number; readonly h: number }[] = [];
  const corner = new Vector3();
  const matrix = new Matrix4();
  // `yaw` turns the plate (a quad facing three's +Z) so its face looks along world (sin yaw, -cos yaw).
  const stand = (x: number, y: number, ground: number, type: SignType, text: string, yaw: number): void => {
    const size = PLATE[type];
    // Up to the plate's top behind it; up to its bottom under a plate on top of it.
    const top = m(size.z + (onTopOfPost(type) ? -size.h / 2 : size.h / 2));
    posts.push(new Matrix4().makeScale(1, top, 1).setPosition(x, ground + top / 2, -y));
    const cell = plateCell(type, text);
    for (const face of plateFaces(type, x, y, yaw)) {
      // The quad of the plane of 1 x 1 it was drawn with, turned and sized as that mesh was.
      matrix.makeRotationY(face.yaw).scale(corner.set(m(size.w), m(size.h), 1)).setPosition(face.x, ground + m(size.z), -face.y);
      quads.push(cell);
      for (const i of QUAD_ORDER) {
        corner.set(QUAD[i]![0], QUAD[i]![1], 0).applyMatrix4(matrix);
        position.push(corner.x, corner.y, corner.z);
        normal.push(Math.sin(face.yaw), 0, Math.cos(face.yaw));
      }
    }
  };
  for (const item of items) {
    if (item.kind === 'sign') {
      const hit = footwayAt(net, item, m(0.6));
      if (!hit) continue;
      const ground = elevation.onSegment(hit.segment, item.x, item.y) + footwayRiseAt(net, item.x, item.y);
      // A traffic sign faces the traffic coming towards it on its side of the street.
      const facing = { x: -hit.frame.t.x * hit.side, y: -hit.frame.t.y * hit.side };
      const type = item.signType ?? 'stop';
      const yaw = type === 'street' || type === 'direction' || type === 'info'
        ? Math.atan2(-hit.frame.n.x * hit.side, hit.frame.n.y * hit.side) // read from the street
        : Math.atan2(facing.x, -facing.y);
      stand(item.x, item.y, ground, type, item.text ?? '', yaw);
    } else if (item.kind === 'streetname' && item.text) {
      // The name plates: at both ends of every segment of the named street,
      // on its right-hand footway, beside the corner.
      for (const id of streetChain(net, item)) {
        const seg = net.doc.segment(id), ribbon = net.ribbons.get(id);
        if (!seg || !ribbon) continue;
        const section = sectionOf(ribbon.road, seg.direction);
        for (const [node, sign] of [[seg.a, 1], [seg.b, -1]] as const) {
          // On the right-hand footway seen from the corner: the road's right
          // from `a`, its left from `b` (each side its own width, docs/VIAS.md V1).
          const zone = (sign > 0 ? section.right : section.left).furnishing;
          const out = zone.inner + Math.min(LAMP_ZONE, Math.max(zone.outer - zone.inner, m(0.2))) / 2;
          if ((net.doc.node(node)?.incident.length ?? 0) < 2) continue;
          const s = sign > 0 ? net.mouthDistance(id, node) + m(1.5) : ribbon.full.length - net.mouthDistance(id, node) - m(1.5);
          if (s <= 0 || s >= ribbon.full.length) continue;
          const f = ribbon.full.sampleAt(s);
          const side = sign > 0 ? -1 : 1;
          const x = f.p.x + f.n.x * out * side, y = f.p.y + f.n.y * out * side;
          const ground = elevation.onSegment(id, x, y) + footwayRiseAt(net, x, y);
          // Parallel to the street, readable from both sides.
          stand(x, y, ground, 'street', item.text, Math.atan2(f.n.x, -f.n.y));
        }
      }
    }
  }
  // The signs the junction rules and the speed limits put up (docs/VIAS.md V6, `world/roads/derivedSigns.ts`).
  for (const sign of derivedSigns(net)) {
    const ground = elevation.onSegment(sign.segment, sign.x, sign.y) + footwayRiseAt(net, sign.x, sign.y);
    stand(sign.x, sign.y, ground, sign.type, sign.text, Math.atan2(sign.facing.x, -sign.facing.y));
  }
  if (posts.length) {
    const poles = new InstancedMesh(post, postMaterial, posts.length);
    posts.forEach((matrix, i) => poles.setMatrixAt(i, matrix));
    poles.castShadow = true;
    poles.computeBoundingSphere();
    group.add(poles);
  }
  if (position.length && atlas) {
    const uv = new Float32Array(quads.length * 12);
    quads.forEach(({ cell, h }, q) => {
      const c = cellUv(cell, h);
      QUAD_ORDER.forEach((i, k) => {
        uv[q * 12 + k * 2] = QUAD[i]![0] < 0 ? c.u0 : c.u1;
        uv[q * 12 + k * 2 + 1] = QUAD[i]![1] < 0 ? c.v0 : c.v1;
      });
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normal), 3));
    geometry.setAttribute('uv', new BufferAttribute(uv, 2));
    geometry.computeBoundingSphere();
    owned.push(geometry);
    const faces = new Mesh(geometry, atlas.material);
    faces.name = 'sign-plates';
    faces.castShadow = true;
    group.add(faces);
  }
  // The cells no sign of this build reads: free for the next plate.
  if (atlas) {
    for (const [key, kept] of atlas.cells) {
      if (kept.build === builds) continue;
      atlas.cells.delete(key);
      atlas.free.push(kept.cell);
    }
  }
  return {
    group,
    dispose() {
      // The plates' sheet stays for the next build (`atlas`).
      for (const o of owned) o.dispose();
      group.clear();
    },
  };
}
