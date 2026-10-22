import {
  CanvasTexture,
  DoubleSide,
  MeshStandardMaterial,
  SRGBColorSpace,
  type Texture,
} from 'three';

import { chosenBackend } from './gpu/backendChoice';
import type { Vec2 } from '@core/vec2';
import type { NodeId, SegmentId } from '@world/ids';
import type { SignType } from '@world/landscape';
import type { Network } from '@world/network';
import { m } from '@world/units';
import { cylinderWith } from './mesh/cylinder';

/** Signs on the streets: the ones placed with the sign tool */

/** Plate size by type, metres, and its centre's height above the footway. */
export const PLATE: Readonly<Record<SignType, { w: number; h: number; z: number }>> = {
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

/** The faces of a plate whose face looks along world (sin yaw, -cos yaw) */
export function plateFaces(type: SignType, x: number, y: number, yaw: number): { x: number; y: number; yaw: number }[] {
  const out = onTopOfPost(type) ? BLADE_HALF : FACE_OUT;
  const face = (turn: number) => ({ x: x + Math.sin(turn) * out, y: y - Math.cos(turn) * out, yaw: turn });
  return type === 'street' ? [face(yaw), face(yaw + Math.PI)] : [face(yaw)];
}

/** DO NOT measure every size from the top. */
export function fitSize(max: number, size: number, widthAt: (px: number) => number): number {
  const top = widthAt(size);
  if (top <= max || size <= 10) return size;
  // Steps down to the first size at or under 10: the walk ends there, fitting or not.
  const last = Math.ceil((size - 10) / 2);
  const ok = (k: number): boolean => k >= last || widthAt(size - 2 * k) <= max;
  let k = Math.min(last, Math.max(1, Math.ceil((size - (size * max) / top) / 2)));
  if (ok(k)) { while (k > 1 && ok(k - 1)) k--; } else { do k++; while (!ok(k)); }
  return size - 2 * k;
}

function plateCanvas(type: SignType, text: string): HTMLCanvasElement {
  const plate = PLATE[type];
  const W = 256, H = Math.max(64, Math.round((256 * plate.h) / plate.w));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 4;
  const fit = (s: string, max: number, size: number): void => {
    const px = fitSize(max, size, (at) => { g.font = `700 ${at}px system-ui, sans-serif`; return g.measureText(s).width; });
    g.font = `700 ${px}px system-ui, sans-serif`;
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
export function streetChain(net: Network, at: Vec2): SegmentId[] {
  let seed: SegmentId | null = null, best = Infinity;
  // Only the ribbons within the reach a seed may be found at, filed by place, in the order of `ribbons`
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

/** DO NOT let a sheet grow past `PAGE`: add a sheet. */
/** A cell is 256 wide (a plate canvas's width), with a gutter so the mipmaps do not bleed into the neighbours. */
const CELL = 256;
const GUTTER = 8;
const PITCH = CELL + 2 * GUTTER;
const COLUMNS = 8;
/** A sheet's largest side: eight cells across, as many rows as fit down (2,176 px, under 4,096). */
const PAGE = COLUMNS * PITCH;
/** The heights a cell comes in: a street's or a direction's name plate */
const CELL_HEIGHTS = [80, CELL] as const;
/** Rows a new sheet starts with; it doubles up to the rows `PAGE` holds. */
const FIRST_ROWS = 4;
export interface Sheet {
  texture: CanvasTexture;
  /** One material per sheet, made with the sheet and kept while it is (never per build of the signs). */
  readonly material: MeshStandardMaterial;
  readonly cellHeight: number;
  rows: number;
  readonly free: number[];
  /** Cells holding a plate. */
  used: number;
  /** The sheet's size in pixels: its canvas is let go once on the GPU (`SignSheets.flush`). */
  width: number;
  height: number;
  /** Each cell's plate (type and words): what the sheet is painted again from, never a picture kept. */
  readonly plates: Map<number, { readonly type: SignType; readonly text: string }>;
  /** Plates placed since it was last painted. */
  dirty: boolean;
  /** To be painted whole (new, grown, its context lost): its cells cannot be sent one by one onto a texture never sent. */
  whole: boolean;
  /** Cells let go since it was last painted: blank again at the next flush, as a whole painting leaves them. */
  readonly blank: number[];
}

/** Copies a picture onto a sheet's texture on the GPU, its corner at `x`, `y` (three's `copyTextureToTexture`, which makes the sheet's mipmaps again, r186). */
export type SheetCopier = (picture: CanvasTexture, sheet: CanvasTexture, x: number, y: number) => void;
/** A plate on a sheet: its cell, the height its picture takes in it, and the last build that read it. */
export interface Placed { readonly sheet: Sheet; readonly cell: number; readonly h: number; build: number }
const pitchOf = (sheet: Sheet): number => sheet.cellHeight + 2 * GUTTER;
const maxRows = (cellHeight: number): number => Math.floor(PAGE / (cellHeight + 2 * GUTTER));
const range = (a: number, b: number): number[] => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
/** A sheet's texture on a canvas of its size, given no context yet (no backing store until painted). */
function sheetTexture(width: number, height: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  // DO NOT keep the canvas once uploaded: its pixels are on the GPU; a canvas of no size holds no backing store.
  // Its size as uploaded kept first, with its chain (`anisotropy` needs mipmaps): an emptied canvas was counted as 0 bytes (report TST-09).
  // Kept under the WebGPU renderer (`gpu/backendChoice.ts`): the WebGL one sends it first (`uploads.ts`), and an emptied canvas reached WebGPU as no picture at all (CopyExternalImageToTexture, 2026-10-21).
  const keep = chosenBackend() === 'webgpu';
  texture.onUpdate = () => {
    texture.userData['uploadedBytes'] = Math.round((canvas.width * canvas.height * 4 * 4) / 3);
    if (!keep) { canvas.width = 0; canvas.height = 0; }
  };
  return texture;
}

/** DO NOT keep them in the module: state loose in a module has no owner to let it go (`eslint-rules/no-module-state.js`). */
export class SignSheets {
  private readonly sheets: Sheet[] = [];
  /** Each plate on its sheet, by type and words. */
  private readonly placed = new Map<string, Placed>();
  private builds = 0;
  /** How many standing plates read each picture (`take`/`drop`): the sign layer kept sign by sign. */
  private readonly counts = new Map<string, number>();
  /** The pictures painted for plates placed since the last `flush`, by key: drawn onto their sheet then, and let go. */
  private readonly pending = new Map<string, HTMLCanvasElement>();

  /** `watch`: told when a sheet grew (its cells' uv moved) and when one was let go. */
  /** `copy`: a sheet already on the GPU takes its new plates cell by cell (VIA-04); without it every sheet is painted whole. */
  constructor(private readonly watch?: { grown?(sheet: Sheet): void; gone?(sheet: Sheet): void }, private copy?: SheetCopier) {}

  /** The GPU copy, once the renderer is there (`renderer.ts`). */
  useCopier(copy: SheetCopier): void {
    this.copy = copy;
  }

  /** One cell's picture as the whole painting lays it: its gutters clear, the plate at `GUTTER` in, sent onto the sheet alone. */
  private cellCanvas: HTMLCanvasElement | null = null;
  private cellTexture: CanvasTexture | null = null;

  /** A plate's cell, held for one more standing plate (`drop` lets it go). */
  take(type: SignType, text: string): Placed {
    const key = `${type}|${text}`;
    const placed = this.plateCell(type, text);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    return placed;
  }

  /** One standing plate fewer reads this picture; the last one frees its cell, and a sheet left empty is let go. */
  drop(type: SignType, text: string): void {
    const key = `${type}|${text}`;
    const left = (this.counts.get(key) ?? 0) - 1;
    if (left > 0) { this.counts.set(key, left); return; }
    this.counts.delete(key);
    const kept = this.placed.get(key);
    if (!kept) return;
    this.placed.delete(key);
    this.pending.delete(key);
    // The cell freed keeps its old picture on the GPU until painted over: no plate's uv reads it.
    kept.sheet.plates.delete(kept.cell);
    kept.sheet.free.push(kept.cell);
    kept.sheet.blank.push(kept.cell);
    kept.sheet.used--;
    if (kept.sheet.used > 0) return;
    const at = this.sheets.indexOf(kept.sheet);
    if (at >= 0) this.sheets.splice(at, 1);
    this.watch?.gone?.(kept.sheet);
    kept.sheet.texture.dispose();
    kept.sheet.material.dispose();
  }

  /** A build of the signs begins: the plates it reads are marked with it. */
  begin(): void {
    this.builds++;
  }

  /** The cell of a plate on its sheet (painted there at the next `flush`), and the height its picture takes. */
  plateCell(type: SignType, text: string): Placed {
    const key = `${type}|${text}`;
    let known = this.placed.get(key);
    if (!known) {
      const picture = plateCanvas(type, text);
      const sheet = this.sheetWithRoom(CELL_HEIGHTS.find((c) => c >= picture.height) ?? CELL);
      const cell = sheet.free.shift()!;
      sheet.plates.set(cell, { type, text });
      sheet.dirty = true;
      sheet.used++;
      this.pending.set(key, picture);
      known = { sheet, cell, h: Math.min(picture.height, sheet.cellHeight), build: this.builds };
      this.placed.set(key, known);
    }
    known.build = this.builds;
    return known;
  }

  /** Every sheet with new plates painted whole from its plates and handed to the GPU; its canvas let go after the upload */
  flush(): void {
    // DO NOT paint a whole sheet again for a plate or two (a canvas of up to 2176 x 2176, every plate drawn again, the sheet and its mipmaps sent whole: 20-100 ms a new street name, VIA-04): a sheet already on the GPU takes its new cells alone.
    for (const sheet of this.sheets) {
      if (!sheet.dirty) continue;
      if (this.copy && !sheet.whole && sheet.texture.userData['uploadedBytes'] !== undefined) this.paintCells(sheet);
      else this.paint(sheet);
    }
    for (const picture of this.pending.values()) { picture.width = 0; picture.height = 0; }
    this.pending.clear();
  }

  /** The WebGL context restored: every sheet painted again from its plates (their pixels were only on the GPU). */
  refill(): void {
    for (const sheet of this.sheets) { sheet.dirty = true; sheet.whole = true; }
    this.flush();
  }

  /** The size of each sheet now (a check that none passes what a card takes). */
  sizes(): { width: number; height: number }[] {
    return this.sheets.map((sheet) => ({ width: sheet.width, height: sheet.height }));
  }

  dispose(): void {
    for (const sheet of this.sheets) { sheet.texture.dispose(); sheet.material.dispose(); }
    this.sheets.length = 0;
    this.placed.clear();
    this.pending.clear();
  }

  private paint(sheet: Sheet): void {
    const canvas = sheet.texture.image as HTMLCanvasElement;
    // Sized again (a size set clears it): its backing store lives until three has uploaded it.
    canvas.width = sheet.width;
    canvas.height = sheet.height;
    const g = canvas.getContext('2d')!;
    const pitch = pitchOf(sheet);
    for (const [cell, { type, text }] of sheet.plates) {
      const picture = this.pending.get(`${type}|${text}`) ?? plateCanvas(type, text);
      g.drawImage(picture, (cell % COLUMNS) * PITCH + GUTTER, Math.floor(cell / COLUMNS) * pitch + GUTTER);
    }
    sheet.texture.needsUpdate = true;
    sheet.dirty = false;
    sheet.whole = false;
    sheet.blank.length = 0;
  }

  /** A sheet on the GPU: each cell let go cleared and each new plate drawn in its cell, every one sent onto the sheet where the whole painting puts it (the same pixels: the canvas is turned over as the sheet is, three's UNPACK_FLIP_Y of the sheet). */
  private paintCells(sheet: Sheet): void {
    const pitch = pitchOf(sheet);
    const canvas = this.cellCanvas ??= document.createElement('canvas');
    if (canvas.width !== PITCH || canvas.height !== pitch || !this.cellTexture) {
      canvas.width = PITCH;
      canvas.height = pitch;
      this.cellTexture?.dispose();
      this.cellTexture = new CanvasTexture(canvas);
    }
    const texture = this.cellTexture;
    texture.colorSpace = sheet.texture.colorSpace;
    const g = canvas.getContext('2d')!;
    const send = (cell: number, picture: HTMLCanvasElement | null): void => {
      g.clearRect(0, 0, PITCH, pitch);
      if (picture) g.drawImage(picture, GUTTER, GUTTER);
      const x = (cell % COLUMNS) * PITCH, y = Math.floor(cell / COLUMNS) * pitch;
      // The canvas's rows go up turned over, as the whole sheet's do: its top row at the sheet's `height - y - 1`.
      this.copy!(texture, sheet.texture, x, sheet.height - y - pitch);
    };
    for (const cell of sheet.blank) if (!sheet.plates.has(cell)) send(cell, null);
    for (const [cell, { type, text }] of sheet.plates) {
      const picture = this.pending.get(`${type}|${text}`);
      if (picture) send(cell, picture);
    }
    sheet.dirty = false;
    sheet.blank.length = 0;
  }

  private newSheet(cellHeight: number): Sheet {
    const rows = Math.min(FIRST_ROWS, maxRows(cellHeight));
    const width = COLUMNS * PITCH, height = rows * (cellHeight + 2 * GUTTER);
    const texture = sheetTexture(width, height);
    const material = plateMaterial(texture);
    const sheet: Sheet = { texture, material, cellHeight, rows, free: range(0, rows * COLUMNS), used: 0, width, height, plates: new Map(), dirty: true, whole: true, blank: [] };
    this.sheets.push(sheet);
    return sheet;
  }

  /** The sheet twice as tall, up to `PAGE`: the same material on a larger texture (no new program), painted at the next `flush`. */
  private growSheet(sheet: Sheet): void {
    const rows = Math.min(maxRows(sheet.cellHeight), sheet.rows * 2);
    sheet.height = rows * (sheet.cellHeight + 2 * GUTTER);
    sheet.texture.dispose();
    sheet.texture = sheetTexture(sheet.width, sheet.height);
    sheet.material.map = sheet.texture;
    sheet.material.needsUpdate = true;
    sheet.free.push(...range(sheet.rows * COLUMNS, rows * COLUMNS));
    sheet.rows = rows;
    sheet.dirty = true;
    sheet.whole = true;
    this.watch?.grown?.(sheet);
  }

  /** A sheet of cells `cellHeight` tall with a free cell: one with room, grown, or a new one. */
  private sheetWithRoom(cellHeight: number): Sheet {
    for (const sheet of this.sheets) if (sheet.cellHeight === cellHeight && sheet.free.length) return sheet;
    for (const sheet of this.sheets) {
      if (sheet.cellHeight === cellHeight && sheet.rows < maxRows(cellHeight)) { this.growSheet(sheet); return sheet; }
    }
    return this.newSheet(cellHeight);
  }
}

/** A sheet's material. */
export function plateMaterial(texture: Texture): MeshStandardMaterial {
  return new MeshStandardMaterial({ map: texture, alphaTest: 0.5, side: DoubleSide, roughness: 0.5, metalness: 0.1 });
}

/** A cell's corners on its sheet as it stands, uv. */
export function cellUv({ sheet, cell, h }: Placed): { u0: number; v0: number; u1: number; v1: number } {
  const W = sheet.width, H = sheet.height;
  const x = (cell % COLUMNS) * PITCH + GUTTER, y = Math.floor(cell / COLUMNS) * pitchOf(sheet) + GUTTER;
  // A canvas texture is flipped (`flipY`): v runs up from the sheet's bottom.
  return { u0: x / W, u1: (x + CELL) / W, v0: 1 - (y + h) / H, v1: 1 - y / H };
}

/** The signs' post, one shape and one material for every sign of every build (DO NOT create it per rebuild). */
// Open at its foot: it stands on the footway (`signLayer.ts` from `s.ground`), that cap facing the ground.
export const POST = { geometry: cylinderWith(POST_RADIUS, m(0.045), 1, 8, { top: true, bottom: false }), material:new MeshStandardMaterial({ color: 0x8e979b, roughness: 0.45, metalness: 0.6 }) };

/** The corners of three's plane of 1 x 1 (`PlaneGeometry`), and its two triangles. */
export const QUAD = [[-0.5, 0.5], [0.5, 0.5], [-0.5, -0.5], [0.5, -0.5]] as const;
export const QUAD_ORDER = [0, 2, 1, 2, 3, 1] as const;
