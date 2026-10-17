import { pointInPolygon } from '@core/polygon';
import type { Vec2 } from '@core/vec2';
import { resolveBlocks } from '@world/buildings/blocks';
import { type GroundAt, type PavedAt, PLINTH_BURY, floorHeight } from '@world/buildings/foundation';
import { localFootprint } from '@world/buildings/footprints';
import { buildingFrame, closedBlocks, frameX, frameY, isMass, storedBounds, volumeElevation, volumeHeight, volumeLift } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import { drawsSignature } from './signature';

/** PARTY WALLS: a bay inside a neighbour's block, back to back with its wall, is never seen, so it is not laid (as `geometry.ts` `exposedParts` leaves out what one block of a building covers of another). */

/** One block of a neighbour as a wall beside it reads it: its plan in the world, its box, and the heights its walls (and plinth) stand between. */
export interface Cover {
  readonly ring: readonly Vec2[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly bottom: number;
  readonly top: number;
}

/** How far out of a bay's face its neighbour's mass is looked for: two walls on one lot line, never a gap a view could go into. */
export const PARTY_NUDGE = m(0.03);
/** A bay is looked at this often along its width, its ends this far in. */
const PARTY_STEP = m(1);
const PARTY_INSET = m(0.01);
/** Two boxes this close may stand back to back. */
const PARTY_REACH = m(0.1);

/** The buildings of one job read as one another's neighbours: only those the job is handed, so a neighbour that changes changes the job's entries and the job is made again (`layer.ts` `sameEntries`). A cut-open or signature building is no one's cover and is laid whole. */
export class PartyWalls {
  private readonly floors = new Map<Building, number | undefined>();
  private readonly blocks = new Map<Building, readonly Cover[]>();
  private readonly boxes: { readonly b: Building; readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }[];

  /** `known`: each building's floor as an earlier job measured it (`CellEntry.floor`), not measured again. */
  constructor(private readonly buildings: readonly Building[], private readonly naturalAt: GroundAt, private readonly pavedAt?: PavedAt, known?: readonly (number | null | undefined)[]) {
    this.boxes = buildings.map((b) => { const box = storedBounds(b); return { b, minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY }; });
    if (known) buildings.forEach((b, i) => { const floor = known[i]; if (floor !== undefined) this.floors.set(b, floor ?? undefined); });
  }

  /** Each building's floor as the job knows it now, in the job's order: null with no closed block, undefined where none was asked. */
  floorsKnown(): (number | null | undefined)[] {
    return this.buildings.map((b) => (this.floors.has(b) ? this.floors.get(b) ?? null : undefined));
  }

  /** A building's ground floor as `emitChunk` lays it (its natural ground, `floorHeight`), worked out once for the job. */
  floorOf(b: Building): number | undefined {
    if (this.floors.has(b)) return this.floors.get(b);
    const resolved = resolveBlocks(b);
    const floor = closedBlocks(resolved.volumes).length > 0 ? floorHeight(resolved, this.naturalAt, this.pavedAt) : undefined;
    this.floors.set(b, floor);
    return floor;
  }

  /** The other buildings' blocks whose box touches this one's. */
  coversNear(b: Building): readonly Cover[] {
    if (b.cutaway !== undefined) return [];
    const box = storedBounds(b);
    const out: Cover[] = [];
    for (const o of this.boxes) {
      if (o.b === b || o.minX > box.maxX + PARTY_REACH || o.maxX < box.minX - PARTY_REACH || o.minY > box.maxY + PARTY_REACH || o.maxY < box.minY - PARTY_REACH) continue;
      for (const c of this.coversOf(o.b)) out.push(c);
    }
    return out;
  }

  /** A building's blocks as covers: each wall from its plinth's foot (a block on the ground) or its own floor up to its eaves. */
  private coversOf(b: Building): readonly Cover[] {
    const was = this.blocks.get(b);
    if (was) return was;
    const known: Cover[] = [];
    const floor = b.cutaway === undefined && !drawsSignature(b) ? this.floorOf(b) : undefined;
    if (floor !== undefined) {
      const resolved = resolveBlocks(b);
      const body = { ...resolved, volumes: closedBlocks(resolved.volumes) };
      const f = buildingFrame(b);
      for (const v of body.volumes) {
        if (!isMass(v)) continue;
        const ring = localFootprint(v).map((p) => ({ x: frameX(f, p.x, p.y), y: frameY(f, p.x, p.y) }));
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of ring) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
        // A ground block's plinth runs at least `PLINTH_BURY` under its floor (`emitPlinth`): the higher bound, never past what is laid.
        let bottom = v.base === 0 ? floor + volumeLift(v) - PLINTH_BURY : floor + volumeElevation(body, v, v.base);
        // An arcade's walk is open to the street: no cover up to the storey over the highest one with a pillar bay.
        v.storeys.forEach((s, k) => {
          if (s?.facade && (s.facade.fill === 'pillar' || Object.values(s.facade.sides ?? {}).includes('pillar') || Object.values(s.facade.bays ?? {}).includes('pillar'))) bottom = floor + volumeElevation(body, v, v.base + k + 1);
        });
        known.push({ ring, minX, minY, maxX, maxY, bottom, top: floor + volumeHeight(body, v) });
      }
    }
    this.blocks.set(b, known);
    return known;
  }
}

/** Whether a stretch of wall - from (x, y) along (tx, ty) for `width`, facing (nx, ny), from z0 to z1, all in the world - stands inside the covers, every step of it. */
export function hiddenByCovers(covers: readonly Cover[], x: number, y: number, tx: number, ty: number, nx: number, ny: number, width: number, z0: number, z1: number): boolean {
  if (covers.length === 0 || width <= 2 * PARTY_INSET) return false;
  const steps = Math.max(1, Math.ceil((width - 2 * PARTY_INSET) / PARTY_STEP));
  for (let i = 0; i <= steps; i++) {
    const a = PARTY_INSET + ((width - 2 * PARTY_INSET) * i) / steps;
    const p = { x: x + tx * a + nx * PARTY_NUDGE, y: y + ty * a + ny * PARTY_NUDGE };
    let inside = false;
    for (const c of covers) {
      if (z0 < c.bottom - 1e-6 || z1 > c.top + 1e-6 || p.x < c.minX || p.x > c.maxX || p.y < c.minY || p.y > c.maxY) continue;
      if (pointInPolygon(p, c.ring)) { inside = true; break; }
    }
    if (!inside) return false;
  }
  return true;
}
