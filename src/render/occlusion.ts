import type { Camera } from 'three';

import type { CameraSolids } from '@world/buildings/cameraSolids';

/** OCCLUSION CULLING ON THE PAGE, TESTED IN THE FRAME BEING DRAWN: the city as its own occluder (Downs, Akenine-Möller & Séquin, "Occlusion
 *  horizons for driving through urban scenery", I3D 2001: a 2.5D city hides 80-90 % of what the frustum keeps; Hasselgren, Andersson &
 *  Akenine-Möller, "Masked Software Occlusion Culling", HPG 2016: the occluders rasterised on the CPU into a small depth buffer, a
 *  hierarchy of it testing the boxes; the hierarchical z-buffer of Greene et al. 1993).
 *  - The occluders are the walls that surely stand (`cameraSolids.ts` forEachOccluder: no roof, drawn in by the reliefs, none of a building
 *    with voids), and only of cells drawn in their own detail (`drawn`): never a building that is not on the screen.
 *  - Each face is laid at the farthest of its corners and only over the pixels it covers whole: the buffer is never nearer, nor wider, than
 *    what stands. A box is hidden only when every texel under it holds an occluder nearer than the box's nearest point.
 *  - Built from this frame's camera before anything is drawn: what it hides is hidden now, never a frame late (no popping, no hole). */

/** Texels across the buffer; its height follows the screen's aspect. 256 is a texel per 7.5 px of a 1920-wide screen: the occluders that
 *  matter, the walls of the street and of the blocks before the eye, span tens of them. */
const WIDTH = 256;
/** How far round the eye the walls are laid, world units: past it a wall spans a few texels and hides little. */
const OCCLUDER_REACH = 1500;
/** A wall lower than this many texels on the buffer is not laid: it hides next to nothing and costs its corners. */
const LEAST_TEXELS = 1.5;
/** A box over more texels than this is never read texel by texel: it spans most of the screen and is all but never hidden. */
const MOST_TEXELS_READ = 8192;

export interface OcclusionStats {
  /** Volumes laid into the buffer this frame, and texels they covered. */
  occluders: number;
  texels: number;
  /** Boxes asked and found hidden this frame. */
  tested: number;
  hidden: number;
  /** ms the frame's buffer took to lay. */
  buildMs: number;
}

export class OcclusionBuffer {
  width = WIDTH;
  height = 0;
  /** Level 0: the nearest occluder over each texel (its view depth), Infinity where none; each level above: the farthest of the four below. */
  private levels: Float32Array[] = [];
  private widths: number[] = [];
  private heights: number[] = [];
  /** The camera's view-projection and view rows, as numbers (three's column-major `elements`). */
  private readonly vp = new Float64Array(16);
  private readonly view = new Float64Array(16);
  private near = 0.1;
  private eyeX = 0;
  private eyeY = 0;
  private eyeZ = 0;
  /** Whether the buffer holds anything this frame: nothing laid, nothing hidden. */
  private laid = false;
  /** Scratch: the eight corners of a box on the buffer (x, y, depth). */
  private readonly corners = new Float64Array(24);
  readonly stats: OcclusionStats = { occluders: 0, texels: 0, tested: 0, hidden: 0, buildMs: 0 };

  /** Lays this frame's occluders: the walls round the eye (`solids`), of the cells `drawn` says are drawn in their detail. `aspect`: the screen's width over its height; `near`: the camera's near plane. */
  build(camera: Camera, aspect: number, solids: CameraSolids, drawn: (x: number, y: number) => boolean, near: number): void {
    const t0 = performance.now();
    const height = Math.max(8, Math.round(WIDTH / Math.max(0.25, aspect)));
    if (height !== this.height) this.resize(height);
    camera.updateMatrixWorld();
    const p = camera.projectionMatrix.elements, v = camera.matrixWorldInverse.elements;
    // vp = projection * view (column-major).
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += p[k * 4 + r]! * v[c * 4 + k]!;
        this.vp[c * 4 + r] = sum;
      }
    }
    for (let i = 0; i < 16; i++) this.view[i] = v[i]!;
    this.near = near;
    const e = camera.matrixWorld.elements;
    // Three's world: the plan's x is x, its y is -z, the height is y.
    this.eyeX = e[12]!; this.eyeY = -e[14]!; this.eyeZ = e[13]!;
    const level0 = this.levels[0]!;
    level0.fill(Infinity);
    this.stats.occluders = 0; this.stats.texels = 0; this.stats.tested = 0; this.stats.hidden = 0;
    const x0 = this.eyeX - OCCLUDER_REACH, y0 = this.eyeY - OCCLUDER_REACH, x1 = this.eyeX + OCCLUDER_REACH, y1 = this.eyeY + OCCLUDER_REACH;
    solids.forEachOccluder(x0, y0, x1, y1, (bx, by, cos, sin, lx0, ly0, lx1, ly1, bottom, top) => {
      if (!drawn(bx, by)) return;
      this.layBox(bx, by, cos, sin, lx0, ly0, lx1, ly1, bottom, top);
    });
    this.laid = this.stats.occluders > 0;
    if (this.laid) this.reduce();
    this.stats.buildMs = performance.now() - t0;
  }

  /** Nothing hidden until the next `build` (a view the buffer cannot stand for: a frame drawn for a picture of its own). */
  clear(): void {
    this.laid = false;
  }

  /** Whether the box (plan x0..x1, y0..y1, height z0..z1) is surely hidden behind the occluders laid this frame. */
  hidden(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): boolean {
    if (!this.laid) return false;
    this.stats.tested++;
    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity, nearest = Infinity;
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? x1 : x0, y = k & 2 ? y1 : y0, z = k & 4 ? z1 : z0;
      const at = this.project(x, z, -y);
      // A corner at or behind the eye's near plane: the box reaches the eye, never hidden.
      if (at === null) return false;
      const c = this.corners;
      if (c[0]! < sx0) sx0 = c[0]!;
      if (c[0]! > sx1) sx1 = c[0]!;
      if (c[1]! < sy0) sy0 = c[1]!;
      if (c[1]! > sy1) sy1 = c[1]!;
      if (c[2]! < nearest) nearest = c[2]!;
    }
    const w = this.width, h = this.height;
    // Off the buffer altogether: the frustum's to cull, not this.
    if (sx1 < 0 || sy1 < 0 || sx0 >= w || sy0 >= h) return false;
    const i0 = Math.max(0, Math.floor(sx0)), i1 = Math.min(w - 1, Math.floor(sx1));
    const j0 = Math.max(0, Math.floor(sy0)), j1 = Math.min(h - 1, Math.floor(sy1));
    // From the level where the box spans a few texels (each the farthest occluder under it) down to the buffer itself: hidden at any level
    // is hidden; a coarse texel half over the sky only says "maybe", and the finer ones are read. A box over most of the buffer is not read texel by texel.
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > MOST_TEXELS_READ) return false;
    let top = 0;
    while (top < this.levels.length - 1 && ((i1 >> top) - (i0 >> top) > 3 || (j1 >> top) - (j0 >> top) > 3)) top++;
    let hiddenAt = false;
    for (let level = top; level >= 0 && !hiddenAt; level--) {
      const data = this.levels[level]!, lw = this.widths[level]!;
      const li0 = i0 >> level, li1 = i1 >> level, lj0 = j0 >> level, lj1 = j1 >> level;
      hiddenAt = true;
      for (let j = lj0; j <= lj1 && hiddenAt; j++) {
        const row = j * lw;
        for (let i = li0; i <= li1; i++) if (data[row + i]! >= nearest) { hiddenAt = false; break; }
      }
    }
    if (!hiddenAt) return false;
    this.stats.hidden++;
    return true;
  }

  private resize(height: number): void {
    this.height = height;
    this.levels = [];
    this.widths = [];
    this.heights = [];
    let w = this.width, h = height;
    for (;;) {
      this.levels.push(new Float32Array(w * h));
      this.widths.push(w);
      this.heights.push(h);
      if (w === 1 && h === 1) break;
      w = Math.max(1, (w + 1) >> 1);
      h = Math.max(1, (h + 1) >> 1);
    }
  }

  /** A three-world point on the buffer into `corners[0..2]` (texel x, texel y from the top, view depth); null at or behind the near plane. */
  private project(x: number, y: number, z: number, into = 0): boolean | null {
    const m = this.vp, v = this.view;
    const depth = -(v[2]! * x + v[6]! * y + v[10]! * z + v[14]!);
    if (depth <= this.near) return null;
    const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    const cx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / cw;
    const cy = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / cw;
    const c = this.corners;
    c[into] = (cx * 0.5 + 0.5) * this.width;
    c[into + 1] = (0.5 - cy * 0.5) * this.height;
    c[into + 2] = depth;
    return true;
  }

  /** One volume's walls and top laid: the faces turned to the eye, each at its farthest corner's depth. */
  private layBox(bx: number, by: number, cos: number, sin: number, lx0: number, ly0: number, lx1: number, ly1: number, bottom: number, top: number): void {
    const c = this.corners;
    // The plan's four corners, counter-clockwise in the building's frame: (lx0, ly0), (lx1, ly0), (lx1, ly1), (lx0, ly1); bottom ones at 0-3, top ones at 4-7.
    let behind = 0;
    for (let k = 0; k < 4; k++) {
      const lx = k === 0 || k === 3 ? lx0 : lx1, ly = k < 2 ? ly0 : ly1;
      const wx = bx + lx * cos - ly * sin, wy = by + lx * sin + ly * cos;
      if (this.project(wx, bottom, -wy, k * 3) === null) behind |= 1 << k;
      if (this.project(wx, top, -wy, (k + 4) * 3) === null) behind |= 1 << (k + 4);
    }
    // Too small on the buffer to hide anything: its height in texels at its nearest standing corner.
    if (behind === 0) {
      let tall = 0;
      for (let k = 0; k < 4; k++) tall = Math.max(tall, Math.abs(c[k * 3 + 1]! - c[(k + 4) * 3 + 1]!));
      if (tall < LEAST_TEXELS) return;
    }
    let laid = false;
    // The walls: wall k runs from corner k to corner k+1, its outward normal in the plan turned with the building.
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) & 3;
      if ((behind >> k) & 1 || (behind >> n) & 1 || (behind >> (k + 4)) & 1 || (behind >> (n + 4)) & 1) continue;
      // Outward normal of the wall in the building's frame: -y, +x, +y, -x.
      const nx = k === 1 ? 1 : k === 3 ? -1 : 0, ny = k === 0 ? -1 : k === 2 ? 1 : 0;
      const wnx = nx * cos - ny * sin, wny = nx * sin + ny * cos;
      const lx = k === 0 || k === 3 ? lx0 : lx1, ly = k < 2 ? ly0 : ly1;
      const px = bx + lx * cos - ly * sin, py = by + lx * sin + ly * cos;
      // Turned from the eye: its back hides nothing its front does not.
      if ((this.eyeX - px) * wnx + (this.eyeY - py) * wny <= 0) continue;
      if (this.layQuad(k, n, n + 4, k + 4)) laid = true;
    }
    // The top, seen from above.
    if (this.eyeZ > top && (behind & 0xf0) === 0 && this.layQuad(4, 5, 6, 7)) laid = true;
    if (laid) this.stats.occluders++;
  }

  /** A convex quad of the corners `a b c d` laid at its farthest depth over the texels it covers whole. */
  private layQuad(a: number, b: number, cc: number, d: number): boolean {
    const c = this.corners;
    const ax = c[a * 3]!, ay = c[a * 3 + 1]!, bx = c[b * 3]!, by = c[b * 3 + 1]!;
    const cx = c[cc * 3]!, cy = c[cc * 3 + 1]!, dx = c[d * 3]!, dy = c[d * 3 + 1]!;
    const depth = Math.max(c[a * 3 + 2]!, c[b * 3 + 2]!, c[cc * 3 + 2]!, c[d * 3 + 2]!);
    // Its turn on the buffer: the edges' insides on the same side whichever way it was wound.
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) + (cx - ax) * (dy - ay) - (cy - ay) * (dx - ax);
    if (Math.abs(area) < 1) return false;
    const s = area > 0 ? 1 : -1;
    const w = this.width, h = this.height;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx, dx))), i1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx, dx)));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy, dy))), j1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy, dy)));
    if (i0 > i1 || j0 > j1) return false;
    // Edge e: inside where s * ((x - x0) * (y1 - y0) - (y - y0) * (x1 - x0)) <= 0 ... written as A x + B y + C >= 0; a texel is covered whole where its worst corner is inside.
    const ex = [ax, bx, cx, dx], ey = [ay, by, cy, dy];
    const A = this.edgeA, B = this.edgeB, C = this.edgeC;
    for (let e = 0; e < 4; e++) {
      const x0 = ex[e]!, y0 = ey[e]!, x1 = ex[(e + 1) & 3]!, y1 = ey[(e + 1) & 3]!;
      // For a counter-clockwise turn in this frame (s > 0) the inside is on the left of each edge.
      const a = -(y1 - y0) * s, b = (x1 - x0) * s;
      A[e] = a; B[e] = b;
      // At a texel's centre (i + 0.5, j + 0.5), less the reach of its worst corner.
      C[e] = -(a * x0 + b * y0) + 0.5 * (a + b) - 0.5 * (Math.abs(a) + Math.abs(b));
    }
    const data = this.levels[0]!;
    let texels = 0;
    for (let j = j0; j <= j1; j++) {
      const row = j * w;
      for (let i = i0; i <= i1; i++) {
        if (A[0]! * i + B[0]! * j + C[0]! < 0 || A[1]! * i + B[1]! * j + C[1]! < 0 || A[2]! * i + B[2]! * j + C[2]! < 0 || A[3]! * i + B[3]! * j + C[3]! < 0) continue;
        if (depth < data[row + i]!) data[row + i] = depth;
        texels++;
      }
    }
    this.stats.texels += texels;
    return texels > 0;
  }

  private readonly edgeA = new Float64Array(4);
  private readonly edgeB = new Float64Array(4);
  private readonly edgeC = new Float64Array(4);

  /** Each level above the first: the farthest of the (up to) four texels under each of its own. */
  private reduce(): void {
    for (let l = 1; l < this.levels.length; l++) {
      const below = this.levels[l - 1]!, bw = this.widths[l - 1]!, bh = this.heights[l - 1]!;
      const out = this.levels[l]!, w = this.widths[l]!, h = this.heights[l]!;
      for (let j = 0; j < h; j++) {
        const j0 = j * 2, j1 = Math.min(bh - 1, j0 + 1);
        for (let i = 0; i < w; i++) {
          const i0 = i * 2, i1 = Math.min(bw - 1, i0 + 1);
          out[j * w + i] = Math.max(below[j0 * bw + i0]!, below[j0 * bw + i1]!, below[j1 * bw + i0]!, below[j1 * bw + i1]!);
        }
      }
    }
  }
}
