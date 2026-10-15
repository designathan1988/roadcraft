import type { Aabb } from '@core/aabb';
import { identityMemo } from '@core/identityMemo';
import type { Vec2 } from '@core/vec2';
import { groundElements } from './elements';
import { footprintRects, groundProjections, storedBounds } from './geometry';
import { type Signature, bodySignature } from './procedural';
import { type Building, type BuildingId, MAX_PROJECTION } from './types';

/** A STANDING BUILDING AS ITS NEIGHBOURS READ IT: what a building checked or grown beside it asks of it (`validate.ts` `validateOn`, `editor/zoning.ts`) - where it stands, what it puts on the ground, what it looks like, how tall it is - and nothing else of the record. On the page a neighbour is a stored record read through (`neighbourOf`), each answer worked out once per record; off the page (`editor/growthReplica.ts`) it is the same answers worked out once from the record sent, the record itself let go: the growth's worker keeps what the checks read, not a second copy of every record of the town (`settledNeighbour`). Both are worked out by the same functions here, so a check reads the same numbers on either side. */

/** A ring a building puts on the ground (world units) and its box. */
export interface Obstacle {
  readonly ring: readonly Vec2[];
  readonly box: Aabb;
}

export interface Neighbour {
  readonly id: BuildingId;
  /** Its anchor (`Building.x`, `y`): the front middle of its lot when grown. */
  readonly x: number;
  readonly y: number;
  /** Its box as the store files it (`storedBounds`). */
  readonly bounds: Aabb;
  /** Its box grown by the deepest a projection may be (`storedBounds(b, MAX_PROJECTION)`). */
  readonly reach: Aabb;
  /** What it puts on the ground: its footprints, then its projections, then its ground elements. */
  readonly obstacles: readonly Obstacle[];
  /** How many of `obstacles` are footprints, and how many projections follow them. */
  readonly footprints: number;
  readonly projections: number;
  /** What it looks like (`procedural.ts` `bodySignature`). */
  readonly signature: Signature;
  /** Its height in storeys: the top of its tallest built block (0: none). */
  readonly storeys: number;
}

/** Where a neighbour is asked for: the buildings by place (`BuildingStore.near`, a superset). */
export interface NeighbourSource {
  near(minX: number, minY: number, maxX: number, maxY: number): readonly Neighbour[];
}

/** A ring's box. */
export function ringBox(ring: readonly Vec2[]): Aabb {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** What a stored building puts on the ground - its volumes, projections and ground elements - as world rings with their boxes, once per record (a record of the store is never changed in place). DO NOT turn a neighbour's corners into the world again at each check: every building tried while a city grows turned every neighbour's again, 3.8 s of `localToWorld` in a 2,560 m city's growth (2026-10-15). */
const groundOf = identityMemo((b: Building): { readonly obstacles: readonly Obstacle[]; readonly footprints: number; readonly projections: number } => {
  const footprints = footprintRects(b), projections = groundProjections(b);
  return {
    obstacles: [...footprints, ...projections, ...groundElements(b)].map((ring) => ({ ring, box: ringBox(ring) })),
    footprints: footprints.length,
    projections: projections.length,
  };
});

/** Each record's signature, worked out once (a record is replaced when its building changes). */
const signatureOf = identityMemo((b: Building): Signature => bodySignature(b));

/** The top of a building's tallest built block, in storeys. */
const storeysOf = (b: Building): number => Math.max(0, ...b.volumes.filter((v) => !v.open).map((v) => v.base + v.storeys.length));

/** A stored record read as a neighbour, each answer worked out when first asked. */
class RecordNeighbour implements Neighbour {
  private top: number | undefined;
  constructor(private readonly b: Building) {}
  get id(): BuildingId { return this.b.id; }
  get x(): number { return this.b.x; }
  get y(): number { return this.b.y; }
  get bounds(): Aabb { return storedBounds(this.b); }
  get reach(): Aabb { return storedBounds(this.b, MAX_PROJECTION); }
  get obstacles(): readonly Obstacle[] { return groundOf(this.b).obstacles; }
  get footprints(): number { return groundOf(this.b).footprints; }
  get projections(): number { return groundOf(this.b).projections; }
  get signature(): Signature { return signatureOf(this.b); }
  get storeys(): number { return this.top ??= storeysOf(this.b); }
}

/** A stored record as its neighbours read it, made once per record (the page's side). */
export const neighbourOf = identityMemo((b: Building): Neighbour => new RecordNeighbour(b));

/** Every answer worked out now, the record not kept (the growth's worker, `editor/growthReplica.ts`). */
export function settledNeighbour(b: Building): Neighbour {
  const ground = groundOf(b);
  return {
    id: b.id, x: b.x, y: b.y,
    bounds: storedBounds(b), reach: storedBounds(b, MAX_PROJECTION),
    obstacles: ground.obstacles, footprints: ground.footprints, projections: ground.projections,
    signature: signatureOf(b), storeys: storeysOf(b),
  };
}

/** The buildings of a store by place, read as neighbours (the page's side). */
export function storeNeighbours(store: { near(minX: number, minY: number, maxX: number, maxY: number): readonly Building[] }): NeighbourSource {
  return { near: (minX, minY, maxX, maxY) => store.near(minX, minY, maxX, maxY).map(neighbourOf) };
}
