import { BoxGeometry, CylinderGeometry, Group, type Material } from 'three';
import type { ChangeRect } from '@world/changes';
import { CellFiling } from '@world/cells';
import type { RoadElevation } from '@world/elevation';
import type { Network, SegmentRibbon } from '@world/network';
import { m } from '@world/units';
import type { ActiveTiles } from './activeTiles';
import type { SceneMaterials } from './materials';
import { PIER_FOOT_FLARE, SPAN_REACH, buildStructureDetails, type StructureDetails } from './structures';

/** DO NOT build every viaduct and tunnel of the map again because an edit reached one of them */

/** A cell's side: the world's own (`world/cells.ts`). */
const CELL = m(256);

const cellKey = (ix: number, iy: number): number => (ix + 0x8000) * 0x10000 + (iy + 0x8000);
const cellOfRibbon = (ribbon: SegmentRibbon): number => {
  const b = ribbon.full.bbox;
  return cellKey(Math.floor((b.minX + b.maxX) / 2 / CELL), Math.floor((b.minY + b.maxY) / 2 / CELL));
};
const cellRect = (key: number): ChangeRect => {
  const ix = Math.floor(key / 0x10000) - 0x8000, iy = (key % 0x10000) - 0x8000;
  return [ix * CELL, iy * CELL, (ix + 1) * CELL, (iy + 1) * CELL];
};

/** A cell's structures, and the box they read (each road's own box grown by the reach of its details). */
interface Cell { readonly details: StructureDetails; readonly reads: ChangeRect }

export interface StructureCells {
  readonly group: Group;
  readonly triangles: number;
  /** The cells a road edit reached (`blocks`: where the roads or the ground changed; null: everywhere) built again */
  prepare(net: Network, elevation: RoadElevation, terrainAt: (x: number, y: number) => number,
    blocks: readonly (readonly [number, number, number, number])[] | null): { readonly fresh: readonly Group[]; apply(): void };
  dispose(): void;
}

/** `active`: the streamed world's active tiles (`activeTiles.ts`): a cell none of whose roads reaches one is the far levels' (none: every cell is built). */
export function createStructureCells(materials: SceneMaterials, groundMaterial?: Material, active?: ActiveTiles): StructureCells {
  const group = new Group();
  group.name = 'road-structure-details';
  // The shapes every cell's instances are drawn with, made once.
  const shapes = { pier: new CylinderGeometry(1, PIER_FOOT_FLARE, 1, 16), box: new BoxGeometry(1, 1, 1) };
  const cells = new Map<number, Cell>();
  /** The cells by the box their structures read: what an edit there reaches. */
  const filing = new CellFiling<number, Cell>();
  let triangles = 0;
  /** Where the active tiles moved since the cells were last put in place: read by a build, let go once it is applied (a build replaced halfway leaves them to the next); null, everywhere. */
  const moves = active?.reader();
  let owed: ChangeRect[] | null = [];

  /** The roads whose line centres in the cell; none when no road of it reaches an active tile (a cell reaching one keeps all its roads, so its structures stay as they were). */
  const ribbonsOf = (net: Network, key: number): SegmentRibbon[] => {
    const out: SegmentRibbon[] = [];
    for (const id of net.segmentCells.idsMeeting(cellRect(key))) {
      const ribbon = net.ribbons.get(id);
      if (ribbon && cellOfRibbon(ribbon) === key) out.push(ribbon);
    }
    if (active && !out.some((r) => active.meets([r.full.bbox.minX, r.full.bbox.minY, r.full.bbox.maxX, r.full.bbox.maxY]))) return [];
    return out.sort((a, b) => a.id - b.id);
  };

  return {
    group,
    get triangles() { return triangles; },
    prepare(net, elevation, terrainAt, blocks) {
      const moved = moves?.take();
      if (moved === null) owed = null;
      else if (moved && owed) owed.push(...moved);
      const read = owed === null ? null : owed.length;
      // The tiles that came into the active region or left it: their cells built or let go, as an edit there would.
      const reached = blocks === null || owed === null ? null : owed.length ? [...blocks, ...owed] : blocks;
      const dirty = new Set<number>();
      if (reached === null) {
        /** @rebuild Every road of the map only when the edit cannot say where (the first world, a map opened). */
        for (const ribbon of net.ribbons.values()) dirty.add(cellOfRibbon(ribbon));
        for (const key of cells.keys()) dirty.add(key);
      } else {
        for (const b of reached) {
          for (const id of net.segmentCells.idsMeeting([b[0] - SPAN_REACH, b[1] - SPAN_REACH, b[2] + SPAN_REACH, b[3] + SPAN_REACH])) {
            const ribbon = net.ribbons.get(id);
            if (ribbon) dirty.add(cellOfRibbon(ribbon));
          }
          for (const key of filing.idsMeeting(b)) dirty.add(key);
        }
      }
      const made = new Map<number, Cell | null>();
      for (const key of dirty) {
        const ribbons = ribbonsOf(net, key);
        const details = ribbons.length ? buildStructureDetails(net, elevation, terrainAt, materials, groundMaterial, ribbons, shapes) : null;
        if (!details || details.group.children.length === 0) { details?.dispose(); made.set(key, null); continue; }
        let reads: ChangeRect | null = null;
        for (const s of details.spans) reads = reads ? [Math.min(reads[0], s[0]), Math.min(reads[1], s[1]), Math.max(reads[2], s[2]), Math.max(reads[3], s[3])] : [s[0], s[1], s[2], s[3]];
        made.set(key, { details, reads: reads ?? cellRect(key) });
      }
      return {
        fresh: [...made.values()].filter((c): c is Cell => c !== null).map((c) => c.details.group),
        apply() {
          for (const [key, cell] of made) {
            const was = cells.get(key);
            if (was) {
              group.remove(was.details.group);
              triangles -= was.details.triangles;
              was.details.dispose();
              cells.delete(key);
              filing.remove(key);
            }
            if (!cell) continue;
            cells.set(key, cell);
            filing.file(key, cell, cell.reads);
            group.add(cell.details.group);
            triangles += cell.details.triangles;
          }
          // What this build read of the moves is in place; a move told since waits for the next.
          if (read === null) owed ??= [];
          else owed?.splice(0, read);
        },
      };
    },
    dispose() {
      for (const cell of cells.values()) cell.details.dispose();
      cells.clear();
      shapes.pier.dispose();
      shapes.box.dispose();
      group.clear();
      triangles = 0;
    },
  };
}
