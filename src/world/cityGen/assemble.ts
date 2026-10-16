import type { SerializedDoc } from '../doc';
import type { Lot } from '../lots';
import { METERS_PER_UNIT } from '../units';
import { TILES, borderLine } from './wholeMap';

/** THE WHOLE MAP JOINED (`wholeMap.ts`): the tiles' records (`TilePiece`, each with ids of its own) made one map, as a saved map holds it. The tiles are taken in their order on the map whatever order they came in, and the nodes on the border lines - corners and gates, which both tiles either side lay at the same place by the same rule - become one node, the border avenue between two of them one road; so the map is the same, byte for byte, however many workers made the tiles and in whatever order they finished. */

/** A tile's records, as a saved map holds them, ids the tile's own (`editor/wholeMapTile.ts` `buildTile`). */
export interface TilePiece {
  readonly i: number;
  readonly j: number;
  readonly nodes: SerializedDoc['nodes'];
  readonly segments: SerializedDoc['segments'];
  readonly lots: readonly Lot[];
  readonly lotKeys: readonly string[];
  readonly buildings: readonly unknown[];
  readonly poles: NonNullable<SerializedDoc['poles']>;
  readonly poleSpans: NonNullable<SerializedDoc['poleSpans']>;
  readonly landscape: NonNullable<SerializedDoc['landscape']>;
  readonly paint: NonNullable<SerializedDoc['paint']>;
  readonly trees: readonly unknown[];
  /** Milliseconds the tile took. */
  readonly ms: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type NodeRecord = Mutable<SerializedDoc['nodes'][number]>;
type SegmentRecord = Mutable<SerializedDoc['segments'][number]>;

/** The tiles joined into one map; every tile must be there. */
export function assembleWholeMap(pieces: readonly TilePiece[]): SerializedDoc {
  const byPlace = new Map<number, TilePiece>();
  for (const piece of pieces) byPlace.set(piece.j * TILES + piece.i, piece);
  if (byPlace.size !== TILES * TILES) throw new Error(`the whole map needs ${TILES * TILES} tiles, ${byPlace.size} came`);
  const lines = new Set<number>();
  for (let k = 0; k <= TILES; k++) lines.add(borderLine(k));
  const onBorder = (p: { readonly x: number; readonly y: number }): boolean => lines.has(p.x) || lines.has(p.y);
  const nodes: NodeRecord[] = [];
  const segments: SegmentRecord[] = [];
  const lots: Lot[] = [];
  const lotKeys: string[] = [];
  const buildings: unknown[] = [];
  const poles: Mutable<NonNullable<SerializedDoc['poles']>[number]>[] = [];
  const poleSpans: { id: number; a: number; b: number }[] = [];
  const landscape: Mutable<NonNullable<SerializedDoc['landscape']>[number]>[] = [];
  const paint: NonNullable<SerializedDoc['paint']>[number][] = [];
  const trees: unknown[] = [];
  /** The border nodes by place, and the border roads by their two nodes. */
  const borderNode = new Map<string, number>();
  const borderRoad = new Set<string>();
  for (let t = 0; t < TILES * TILES; t++) {
    const piece = byPlace.get(t)!;
    const node = new Map<number, number>();
    for (const n of piece.nodes) {
      const key = onBorder(n) ? `${n.x},${n.y}` : null;
      const had = key !== null ? borderNode.get(key) : undefined;
      if (had !== undefined) { node.set(n.id, had); continue; }
      const id = nodes.length + 1;
      nodes.push({ ...n, id });
      node.set(n.id, id);
      if (key !== null) borderNode.set(key, id);
    }
    for (const s of piece.segments) {
      const a = node.get(s.a)!, b = node.get(s.b)!;
      if (onBorder(nodes[a - 1]!) && onBorder(nodes[b - 1]!)) {
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (borderRoad.has(key)) continue;
        borderRoad.add(key);
      }
      segments.push({ ...s, id: segments.length + 1, a, b });
    }
    const building = new Map<number, number>();
    for (const raw of piece.buildings) {
      const b = raw as { id: number };
      const id = buildings.length + 1;
      building.set(b.id, id);
      buildings.push({ ...b, id });
    }
    for (const l of piece.lots) {
      const { building: on, ...rest } = l;
      const id = lots.length + 1;
      lots.push(on !== undefined && building.has(on) ? { ...rest, id, building: building.get(on)! } : { ...rest, id });
    }
    lotKeys.push(...piece.lotKeys);
    const pole = new Map<number, number>();
    for (const p of piece.poles) { const id = poles.length + 1; pole.set(p.id, id); poles.push({ ...p, id }); }
    for (const s of piece.poleSpans) poleSpans.push({ id: poleSpans.length + 1, a: pole.get(s.a)!, b: pole.get(s.b)! });
    for (const item of piece.landscape) landscape.push({ ...item, id: landscape.length + 1 });
    paint.push(...piece.paint);
    trees.push(...piece.trees);
  }
  return {
    version: 1, unit: METERS_PER_UNIT, nodes, segments, terrain: [],
    poles, poleSpans, landscape, paint, trees,
    buildings: buildings as SerializedDoc['buildings'] & unknown[], lots, lotKeys,
  };
}
