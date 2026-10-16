import { packArrays, packedArray, packedNumber, unpackArrays } from '@core/arrayPack';
import { ChangeLog } from '@core/changeLog';
import type { BuildingId } from '@world/buildings/types';
import type { TileRecords } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { type GraphChange, LaneletGraph, laneletId } from '@world/lanelets';
import { tileRoadNetwork } from '@world/tileNetwork';
import type { Bay, BayLane } from './agents/bay';
import { LaneGrid } from './agents/laneGrid';
import { type BakedBays, type BakedSource, type BayWorld, bakeBays } from './agents/parking';
import { type TrafficBuilding, TrafficBuildingTable } from './agents/trafficBuildings';

/** A TILE'S PARKING BAYS, BAKED ONCE A VERSION WHERE THE TILE IS WRITTEN (`tileSections.ts`): its lots' stalls (`lotBays.ts`, a nav grid a lot) and its streets' kerb bays (`kerbBays.ts`), each with what it was worked out from; the simulation's worker takes them where what they read is the same there (`parking.ts` lookAtLot, `kerbBays.ts` kerbKey) */
// A lot and a street are baked with the tile that owns them (`OWNER`: a building by its anchor, a road by the middle of its ends) from its records alone: one that reads a road, a wall or an entrance of the next tile, or a street ending on a junction with a neighbour's road, has another key there and is worked out where the tile is loaded.

/** The section's name in the tile store (`editor/tileStore.ts`). */
export const BAYS_SECTION = 'bays';
/** Bumped when what the section holds or how the bays are worked out changes (`lotBays.ts`, `kerbBays.ts`, `parkingLayout.ts`, the keys in `parking.ts`): an older one is not read, its bays worked out where the tile is loaded until it is written again. */
const TILE_BAYS_FORMAT = 1;

/** Numbers a bay keeps: x, y, ox, oy, depth, room. */
const BAY = 6;
/** Numbers a bay's lane keeps: its lanelet's segment (NaN: no lane), from, to and lane (`laneletId`), then at, x, y, tx, ty, entryAt (NaN: none). */
const LANE = 10;
/** The building of a street's bay (`kerbBays.ts` NO_LOT). */
const NO_LOT = -1 as BuildingId;
/** A lane of a tile's bake is never a ghost: it has no traffic. */
const NOT_GHOST = Object.freeze({ ghost: false });

/** @rebuild A tile's bays worked out from its own records alone (no workers): its roads as a network of their own with their link lanes, its buildings as traffic reads them back from the tile's traffic section (`traffic`) */
export function bakeTileBays(records: TileRecords, traffic: readonly TrafficBuilding[]): Uint8Array<ArrayBuffer> {
  // The tile's roads built once for its bakes (`world/tileNetwork.ts`): the junctions' bake reads the same network.
  const { doc, net } = tileRoadNetwork(records);
  // The link lanes alone: the bays read no junction's turns.
  const graph = LaneletGraph.linksOnly(doc, net);
  const buildings = new TrafficBuildingTable(doc.changes);
  buildings.load(traffic);
  const world: BayWorld = { doc, net, graph, topologyLog: new ChangeLog<GraphChange>(), laneGrid: new LaneGrid(), buildings, rt: () => NOT_GHOST };
  return packBays(records.key, records.version, bakeBays(world), graph);
}

/** The baked lots then streets as one pack (`core/arrayPack.ts`): each source's id, digests and bays, every bay's lane by its lanelet's numbers. */
function packBays(key: number, version: number, baked: ReturnType<typeof bakeBays>, graph: LaneletGraph): Uint8Array<ArrayBuffer> {
  const sources: readonly BakedSource[] = [...baked.lots, ...baked.kerbs];
  let bays = 0, points = 0;
  for (const s of sources) {
    bays += s.bays.length;
    for (const b of s.bays) points += b.via.length;
  }
  const source = new Float64Array(sources.length), record = new Float64Array(sources.length), keys = new Float64Array(sources.length);
  const start = new Uint32Array(sources.length + 1);
  const bay = new Float64Array(bays * BAY), lane = new Float64Array(bays * LANE).fill(Number.NaN);
  const viaStart = new Uint32Array(bays + 1), via = new Float64Array(points * 2);
  let n = 0, v = 0;
  sources.forEach((s, k) => {
    source[k] = s.id;
    record[k] = s.record;
    keys[k] = s.sources;
    start[k] = n;
    for (const b of s.bays) {
      const o = n * BAY;
      bay[o] = b.x; bay[o + 1] = b.y; bay[o + 2] = b.ox; bay[o + 3] = b.oy; bay[o + 4] = b.depth; bay[o + 5] = b.room;
      if (b.lane) laneInto(lane, n * LANE, b.lane, graph);
      viaStart[n] = v;
      for (const p of b.via) { via[2 * v] = p.x; via[2 * v + 1] = p.y; v++; }
      n++;
    }
  });
  start[sources.length] = n;
  viaStart[n] = v;
  return packArrays(
    { key, version, format: TILE_BAYS_FORMAT, lots: baked.lots.length, kerbs: baked.kerbs.length },
    { source, record, keys, start, bay, lane, viaStart, via },
  );
}

/** A bay's lane written as numbers: its lanelet named by its segment, ends and lane (DO NOT keep the id's text: it is made again by `laneletId`). */
function laneInto(out: Float64Array, o: number, lane: BayLane, graph: LaneletGraph): void {
  const l = graph.lanelet(lane.lanelet);
  if (!l || l.kind !== 'link' || laneletId(l.segment!, l.from!, l.to!, l.laneIndex!) !== lane.lanelet) throw new Error(`a bay's lane ${lane.lanelet} is not a link of the tile`);
  out[o] = l.segment!; out[o + 1] = l.from!; out[o + 2] = l.to!; out[o + 3] = l.laneIndex!;
  out[o + 4] = lane.at; out[o + 5] = lane.x; out[o + 6] = lane.y; out[o + 7] = lane.tx; out[o + 8] = lane.ty; out[o + 9] = lane.entryAt ?? Number.NaN;
}

/** A tile's baked bays read back, its arrays views on the buffer; null: of another format than this build bakes (worked out where the tile is loaded). */
export function unpackTileBays(buffer: ArrayBuffer): TileBays | null {
  const pack = unpackArrays(buffer);
  if (packedNumber(pack, 'format') !== TILE_BAYS_FORMAT) return null;
  return new TileBays(packedNumber(pack, 'key'), packedNumber(pack, 'version'), packedNumber(pack, 'lots'), {
    source: packedArray(pack, 'source', Float64Array), record: packedArray(pack, 'record', Float64Array), keys: packedArray(pack, 'keys', Float64Array),
    start: packedArray(pack, 'start', Uint32Array), bay: packedArray(pack, 'bay', Float64Array), lane: packedArray(pack, 'lane', Float64Array),
    viaStart: packedArray(pack, 'viaStart', Uint32Array), via: packedArray(pack, 'via', Float64Array),
  });
}

/** A tile's baked bays as the simulation's worker holds them (`parking.ts` BakedBays): a source's bays made only when they are taken. */
export class TileBays implements BakedBays {
  private readonly lotAt = new Map<BuildingId, number>();
  private readonly kerbAt = new Map<SegmentId, number>();

  constructor(readonly key: number, readonly version: number, lotCount: number, private readonly a: {
    readonly source: Float64Array; readonly record: Float64Array; readonly keys: Float64Array; readonly start: Uint32Array;
    readonly bay: Float64Array; readonly lane: Float64Array; readonly viaStart: Uint32Array; readonly via: Float64Array;
  }) {
    for (let k = 0; k < a.source.length; k++) {
      if (k < lotCount) this.lotAt.set(a.source[k]! as BuildingId, k);
      else this.kerbAt.set(a.source[k]! as SegmentId, k);
    }
  }

  lots(): Iterable<BuildingId> {
    return this.lotAt.keys();
  }

  kerbs(): Iterable<SegmentId> {
    return this.kerbAt.keys();
  }

  lot(id: BuildingId, record: number, sources: number): Bay[] | null {
    const k = this.lotAt.get(id);
    return k !== undefined && this.a.record[k] === record && this.a.keys[k] === sources ? this.baysAt(k, id, false) : null;
  }

  kerb(id: SegmentId, sources: number): Bay[] | null {
    const k = this.kerbAt.get(id);
    return k !== undefined && this.a.keys[k] === sources ? this.baysAt(k, NO_LOT, true) : null;
  }

  /** The bays of source `k` as `bayRows` and `kerbBaysOf` make them (ids from 0). */
  private baysAt(k: number, building: BuildingId, kerb: boolean): Bay[] {
    const { start, bay, lane, viaStart, via } = this.a;
    const out: Bay[] = [];
    for (let n = start[k]!; n < start[k + 1]!; n++) {
      const o = n * BAY, l = n * LANE;
      const points: { x: number; y: number }[] = [];
      for (let p = viaStart[n]!; p < viaStart[n + 1]!; p++) points.push({ x: via[2 * p]!, y: via[2 * p + 1]! });
      out.push({
        id: out.length, building, x: bay[o]!, y: bay[o + 1]!, ox: bay[o + 2]!, oy: bay[o + 3]!, depth: bay[o + 4]!,
        lane: Number.isNaN(lane[l]!) ? null : laneOf(lane, l), via: points, room: bay[o + 5]!, car: null, ...(kerb ? { kerb: true as const } : {}),
      });
    }
    return out;
  }
}

/** A bay's lane read back from its numbers (`laneInto`). */
function laneOf(lane: Float64Array, l: number): BayLane {
  const entryAt = lane[l + 9]!;
  return {
    lanelet: laneletId(lane[l]! as SegmentId, lane[l + 1]! as NodeId, lane[l + 2]! as NodeId, lane[l + 3]!),
    at: lane[l + 4]!, x: lane[l + 5]!, y: lane[l + 6]!, tx: lane[l + 7]!, ty: lane[l + 8]!,
    ...(Number.isNaN(entryAt) ? {} : { entryAt }),
  };
}
