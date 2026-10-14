import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, ShapeUtils, Vector2, type Scene,
} from 'three';
import type { Vec2 } from '@core/vec2';
import { m } from '@world/units';
import type { ChangeJournal, ChangeKind, ChangeRect } from '@world/changes';

/**
 * What moves the ground a lot is laid on (`surfaceHeightAt`: the terrain and
 * the roads): its laid pieces there are made again. NOT 'buildings': a
 * building moves no ground by being there - the pads it levels are written
 * as 'ground' when they are cut (`renderer.ts` `shapeGround`). With it, a
 * generated city re-laid 3 000 lots in 18 passes of 190 ms each, 3.4 s of
 * its first 25 (2026-10-14).
 * NÃO pôr 'buildings' de volta: o nivelamento já chega como 'ground'.
 */
const GROUND_KINDS: readonly ChangeKind[] = ['terrain', 'roads', 'ground', 'elevation', 'surfaces'];

/**
 * Milliseconds a frame spends laying lots on the ground, and how often what
 * is laid so far is shown while the rest waits. A generated city's 1 500
 * lots laid in one frame held it 1.3 s, the first frame the town was seen
 * (2026-10-14); a slice a frame, the colours spread over the town instead.
 * NÃO voltar a deitar tudo num quadro: é a travada de mais de um segundo.
 */
const LAY_SLICE_MS = 12;
const REVEAL_MS = 300;

/** One polygon laid on the ground: its fill and outline triangles, and where it is. */
interface Piece { readonly fillPos: Float32Array; readonly fillCol: Float32Array; readonly linePos: Float32Array; readonly lineCol: Float32Array; readonly box: ChangeRect }

/**
 * The lots drawn in the scene (`world/lots.ts`, the Zoning tool): fills and
 * outlines laid on the ground itself - the road deck, the footway, the
 * terrain - so they stay where the land is as the camera moves. Drawn on a
 * 2D canvas over the picture at a guessed height, they slid against the
 * ground with every turn of the camera and sat crooked over the footway.
 *
 * Outlines are ribbons of a constant width on the ground, subdivided so they
 * follow its relief; fills are the polygons triangulated with their edges
 * subdivided, each vertex at the ground's height. Rebuilt only when the
 * input's key changes, and then only the polygons that changed or whose
 * ground did (the diary's rectangles): each building grown laid all 468 lots
 * of a town on the ground again, 1.7 s a building. The polygons still to lay
 * are laid `LAY_SLICE_MS` a frame (`set` is true until they all are).
 */
export interface LotOverlayInput {
  /** Changes whenever anything drawn changes. */
  readonly key: string;
  readonly polygons: readonly {
    readonly corners: readonly Vec2[];
    readonly fill: number | null;
    readonly fillAlpha: number;
    readonly line: number;
    readonly lineAlpha: number;
    /** Line width, metres on the ground. */
    readonly width: number;
  }[];
  readonly lines: readonly { readonly a: Vec2; readonly b: Vec2; readonly colour: number; readonly dashed: boolean; readonly width: number }[];
  readonly points: readonly { readonly p: Vec2; readonly colour: number; readonly radius: number }[];
}

/** An input being laid, a slice a frame: the polygons done, those to come, the loose lines and points. */
interface Laying {
  readonly input: LotOverlayInput;
  next: number;
  readonly laid: Piece[];
  readonly kept: Map<string, Piece>;
  readonly loose: { readonly pos: number[]; readonly col: number[] };
  shownAt: number;
  /** Pieces of `laid` already in meshes; the meshes of the input before are gone once one is. */
  shown: number;
}

export function createLotOverlay(scene: Scene, groundAt: (x: number, y: number) => number) {
  const group = new Group();
  group.name = 'lot-overlay';
  group.renderOrder = 10;
  scene.add(group);
  const material = (alpha: boolean): MeshBasicMaterial => new MeshBasicMaterial({
    vertexColors: true, transparent: alpha, opacity: 1, depthWrite: false, side: DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16,
  });
  const fillMat = material(true), lineMat = material(true);
  fillMat.forceSinglePass = true;
  lineMat.forceSinglePass = true;
  let key = '';
  let meshes: Mesh[] = [];
  /** Each polygon as last laid, by what it is (`pieceKey`). */
  let pieces = new Map<string, Piece>();
  /** The input still being laid (`LAY_SLICE_MS` a frame); null when all is shown. */
  let laying: Laying | null = null;
  /** The diary's serial the pieces' ground was read at. */
  let groundSeen = -1;
  const pieceKey = (poly: LotOverlayInput['polygons'][number]): string =>
    `${poly.fill}|${poly.fillAlpha}|${poly.line}|${poly.lineAlpha}|${poly.width}|${poly.corners.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(';')}`;
  /** The pieces whose ground moved since they were laid are forgotten. */
  /** True when a piece still drawn was forgotten. */
  const forgetMovedGround = (changes: ChangeJournal | undefined): boolean => {
    if (!changes || changes.version === groundSeen) return false;
    const entries = groundSeen < 0 ? null : changes.since(groundSeen, GROUND_KINDS);
    groundSeen = changes.version;
    const before = pieces.size;
    if (entries === null) { pieces.clear(); return before > 0; }
    for (const entry of entries) {
      if (entry.rects === null) { pieces.clear(); break; }
      for (const [k, piece] of pieces) {
        if (entry.rects.some((r) => r[0] <= piece.box[2] && r[2] >= piece.box[0] && r[1] <= piece.box[3] && r[3] >= piece.box[1])) pieces.delete(k);
      }
    }
    return pieces.size < before;
  };
  const LIFT = m(0.12);
  /** The longest side of a fill triangle: about the terrain's own cell, so the fill bends with it. */
  const FILL_EDGE = m(3);

  /** World (x, y) on the ground, as three's (x, height, -y). */
  const at = (x: number, y: number, lift = LIFT): [number, number, number] => [x, groundAt(x, y) + lift, -y];
  const colour = new Color();
  const pushColour = (into: number[], c: number, alpha: number, n: number): void => {
    colour.set(c);
    for (let i = 0; i < n; i++) into.push(colour.r, colour.g, colour.b, alpha);
  };
  const ribbon = (pos: number[], col: number[], a: Vec2, b: Vec2, width: number, c: number, alpha: number, lift: number): void => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) return;
    const nx = -(b.y - a.y) / len * width / 2, ny = (b.x - a.x) / len * width / 2;
    const steps = Math.max(1, Math.ceil(len / m(2)));
    // Each cross-section's two ground points once: a step shares its end
    // with the next step's start (the ground was asked twice for each).
    let r0 = at(a.x - nx, a.y - ny, lift), l0 = at(a.x + nx, a.y + ny, lift);
    for (let k = 0; k < steps; k++) {
      const t1 = (k + 1) / steps;
      const p1x = a.x + (b.x - a.x) * t1, p1y = a.y + (b.y - a.y) * t1;
      const l1 = at(p1x + nx, p1y + ny, lift), r1 = at(p1x - nx, p1y - ny, lift);
      pos.push(...r0, ...l0, ...l1, ...r0, ...l1, ...r1);
      pushColour(col, c, alpha, 6);
      r0 = r1; l0 = l1;
    }
  };

  /** One polygon laid on the ground, into its own lists. */
  function layPiece(poly: LotOverlayInput['polygons'][number]): Piece {
    const ring = poly.corners;
    const fillPos: number[] = [], fillCol: number[] = [], linePos: number[] = [], lineCol: number[] = [];
    if (poly.fill !== null && poly.fillAlpha > 0) {
      // Edges subdivided every 3 m so the fill bends with the ground.
      const pts: Vec2[] = [];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / m(3)));
        for (let k = 0; k < steps; k++) pts.push({ x: a.x + (b.x - a.x) * k / steps, y: a.y + (b.y - a.y) * k / steps });
      }
      const tris = ShapeUtils.triangulateShape(pts.map((p) => new Vector2(p.x, p.y)), []);
      // Each triangle cut until no side is longer than 3 m, every vertex on
      // the ground: with vertices on the edges only, a lot's middle was a
      // few large flat triangles, and wherever the land rose inside it the
      // ground showed through the colour in holes (the player, 2026-10-06).
      const fill = poly.fill;
      // A vertex is shared by up to six triangles: its ground asked once.
      // Keyed by a number, not a string: building the keys was 2.5 s of the
      // 7 s a generated city's 1 530 lots took to lay (2026-10-09).
      const heights = new Map<number, [number, number, number]>();
      const ground = (p: Vec2): [number, number, number] => {
        const k = (Math.round(p.x * 1000) + 4_194_304) * 8_388_608 + (Math.round(p.y * 1000) + 4_194_304);
        let v = heights.get(k);
        if (!v) { v = at(p.x, p.y); heights.set(k, v); }
        return v;
      };
      const emit = (a: Vec2, b: Vec2, cc: Vec2, depth: number): void => {
        const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(cc.x - b.x, cc.y - b.y), ca = Math.hypot(a.x - cc.x, a.y - cc.y);
        if (Math.max(ab, bc, ca) <= FILL_EDGE || depth > 12) {
          fillPos.push(...ground(a), ...ground(b), ...ground(cc));
          pushColour(fillCol, fill, poly.fillAlpha, 3);
          return;
        }
        // The longest side halved: two triangles, no T-junctions along shared sides.
        if (ab >= bc && ab >= ca) { const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; emit(a, mid, cc, depth + 1); emit(mid, b, cc, depth + 1); }
        else if (bc >= ca) { const mid = { x: (b.x + cc.x) / 2, y: (b.y + cc.y) / 2 }; emit(a, b, mid, depth + 1); emit(a, mid, cc, depth + 1); }
        else { const mid = { x: (cc.x + a.x) / 2, y: (cc.y + a.y) / 2 }; emit(a, b, mid, depth + 1); emit(mid, b, cc, depth + 1); }
      };
      for (const tri of tris) emit(pts[tri[0]!]!, pts[tri[1]!]!, pts[tri[2]!]!, 0);
    }
    for (let i = 0; i < ring.length; i++) ribbon(linePos, lineCol, ring[i]!, ring[(i + 1) % ring.length]!, m(poly.width), poly.line, poly.lineAlpha, LIFT * 1.5);
    const xs = ring.map((q) => q.x), ys = ring.map((q) => q.y);
    const pad = m(poly.width);
    return { fillPos: Float32Array.from(fillPos), fillCol: Float32Array.from(fillCol),
      linePos: Float32Array.from(linePos), lineCol: Float32Array.from(lineCol),
      box: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad] };
  }

  /** The loose lines and points of an input, laid at once (a few). */
  function layLoose(input: LotOverlayInput): Laying['loose'] {
    const pos: number[] = [], col: number[] = [];
    for (const line of input.lines) {
      if (!line.dashed) { ribbon(pos, col, line.a, line.b, m(line.width), line.colour, 1, LIFT * 2); continue; }
      const len = Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y);
      const dash = m(2), gap = m(1.2);
      for (let s = 0; s < len; s += dash + gap) {
        const t0 = s / len, t1 = Math.min(1, (s + dash) / len);
        ribbon(pos, col, { x: line.a.x + (line.b.x - line.a.x) * t0, y: line.a.y + (line.b.y - line.a.y) * t0 },
          { x: line.a.x + (line.b.x - line.a.x) * t1, y: line.a.y + (line.b.y - line.a.y) * t1 }, m(line.width), line.colour, 1, LIFT * 2);
      }
    }
    for (const point of input.points) {
      // A disc of 12 sides.
      const r = m(point.radius), c = at(point.p.x, point.p.y, LIFT * 2.5);
      for (let k = 0; k < 12; k++) {
        const a0 = k / 12 * Math.PI * 2, a1 = (k + 1) / 12 * Math.PI * 2;
        pos.push(...c, c[0] + Math.cos(a0) * r, c[1], c[2] + Math.sin(a0) * r, c[0] + Math.cos(a1) * r, c[1], c[2] + Math.sin(a1) * r);
        pushColour(col, point.colour, 1, 3);
      }
    }
    return { pos, col };
  }

  /** Polygons laid until `until`, the known ones read back; true when none is left. */
  function layUntil(job: Laying, until: number): boolean {
    const polygons = job.input.polygons;
    while (job.next < polygons.length) {
      const poly = polygons[job.next++]!;
      if (poly.corners.length < 3) continue;
      const k = pieceKey(poly);
      const known = pieces.get(k) ?? job.kept.get(k);
      const piece = known ?? layPiece(poly);
      job.laid.push(piece);
      job.kept.set(k, piece);
      if (!known && performance.now() >= until) break;
    }
    return job.next >= polygons.length;
  }

  function clear(): void {
    for (const mesh of meshes) { group.remove(mesh); mesh.geometry.dispose(); }
    meshes = [];
  }

  /**
   * The pieces laid since the last time, and with `last` the loose lines and
   * points, as one more mesh of fills and one of outlines: shown a chunk at a
   * time, not all joined again - re-joined at each look the meshes grew to
   * millions of vertices copied and sent to the GPU every 150 ms, and the
   * frames of a growing city from 160 to 240 ms (2026-10-14).
   */
  function show(job: Laying, last: boolean): void {
    if (job.shown === 0) clear();
    const chunk = job.laid.slice(job.shown);
    job.shown = job.laid.length;
    // Copied into one buffer each (a copy per piece, not a push per number: 146 ms for a town's lots).
    const joined = (parts: readonly Float32Array[], extra: readonly number[]): Float32Array => {
      let n = extra.length;
      for (const p of parts) n += p.length;
      const out = new Float32Array(n);
      let at = 0;
      for (const p of parts) { out.set(p, at); at += p.length; }
      out.set(extra, at);
      return out;
    };
    const loose = last ? job.loose : { pos: [], col: [] };
    const fills = [joined(chunk.map((p) => p.fillPos), []), joined(chunk.map((p) => p.fillCol), [])] as const;
    const outlines = [joined(chunk.map((p) => p.linePos), loose.pos), joined(chunk.map((p) => p.lineCol), loose.col)] as const;
    for (const [pos, col, mat, order] of [[fills[0], fills[1], fillMat, 10], [outlines[0], outlines[1], lineMat, 11]] as const) {
      if (!pos.length) continue;
      const geometry = new BufferGeometry();
      // The joined arrays as they are: `Float32BufferAttribute` copied each
      // again (15 ms a building grown in a town of 1 200 lots, audit M3a).
      geometry.setAttribute('position', new BufferAttribute(pos, 3));
      geometry.setAttribute('color', new BufferAttribute(col, 4));
      const mesh = new Mesh(geometry, mat);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      meshes.push(mesh);
      group.add(mesh);
    }
    job.shownAt = performance.now();
  }

  return {
    /** Lays `input` (null: none) on the ground; true while polygons are left for the next frames. */
    set(input: LotOverlayInput | null, changes?: ChangeJournal): boolean {
      // The pieces laid by a job under way join the rest: read back if the
      // input changes again, forgotten with the rest if their ground moves.
      if (laying) for (const [k, piece] of laying.kept) pieces.set(k, piece);
      // The ground moved under pieces still drawn: laid again even with the same input.
      const moved = forgetMovedGround(changes);
      const next = input?.key ?? '';
      if (next !== key || moved) {
        key = next;
        if (!input) { laying = null; clear(); return false; }
        laying = { input, next: 0, laid: [], kept: new Map(), loose: layLoose(input), shownAt: performance.now(), shown: 0 };
      }
      if (!laying) return false;
      const job = laying;
      if (layUntil(job, performance.now() + LAY_SLICE_MS)) {
        // Only the polygons drawn now are kept: the others are gone.
        pieces = job.kept;
        laying = null;
        show(job, true);
        return false;
      }
      if (performance.now() - job.shownAt >= REVEAL_MS) show(job, false);
      return true;
    },
    /**
     * Its materials on a triangle each, out of the scene: for their programs
     * to be compiled ahead (`renderer.ts` `warmPreviewShaders`), not in the
     * frame the Zoning tool first draws a lot.
     */
    warm(): { group: Group; dispose(): void } {
      const warm = new Group();
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3));
      geometry.setAttribute('color', new Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 4));
      for (const mat of [fillMat, lineMat]) {
        const mesh = new Mesh(geometry, mat);
        mesh.frustumCulled = false;
        warm.add(mesh);
      }
      return { group: warm, dispose() { geometry.dispose(); } };
    },
    dispose(): void {
      for (const mesh of meshes) mesh.geometry.dispose();
      fillMat.dispose(); lineMat.dispose();
      scene.remove(group);
    },
  };
}
