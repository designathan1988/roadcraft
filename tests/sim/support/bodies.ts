import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RoadDoc } from '@world/doc';
import type { NodeId } from '@world/ids';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { vehiclePose } from '@sim/pose';
import type { Vehicle } from '@sim/vehicles/state';
import type { Vec2 } from '@core/vec2';
import { TUNED_UNIT } from '@world/units';

/** The 0.4 m unit these scenes were laid out in: every length below is in it, times U. */
const U = TUNED_UNIT;

/** Shared harness for measuring what the player actually sees */

export interface Body {
  readonly vehicle: Vehicle;
  readonly c: Vec2;
  /** Unit heading. */
  readonly u: Vec2;
  readonly halfLength: number;
  readonly halfWidth: number;
}

/** Overlap tolerance, in world units, removed from each half-dimension. 0.1 u is 4 cm */
const BODY_TOLERANCE = 0.1 * U;

export function bodyOf(w: SimWorld, v: Vehicle): Body | null {
  const pose = vehiclePose(w, v, 1);
  if (!pose) return null;
  return {
    vehicle: v,
    c: pose.p,
    u: { x: Math.cos(pose.angle), y: Math.sin(pose.angle) },
    halfLength: v.archetype.length / 2 - BODY_TOLERANCE,
    halfWidth: v.archetype.width / 2 - BODY_TOLERANCE,
  };
}

/** Separating-axis test between two oriented rectangles. */
export function bodiesOverlap(a: Body, b: Body): boolean {
  const dx = b.c.x - a.c.x;
  const dy = b.c.y - a.c.y;
  // Farther apart than their half-diagonals: no axis needed.
  const reach = Math.hypot(a.halfLength, a.halfWidth) + Math.hypot(b.halfLength, b.halfWidth);
  if (dx * dx + dy * dy >= reach * reach) return false;
  return !separates(a, b, dx, dy, a.u.x, a.u.y) && !separates(a, b, dx, dy, -a.u.y, a.u.x)
    && !separates(a, b, dx, dy, b.u.x, b.u.y) && !separates(a, b, dx, dy, -b.u.y, b.u.x);
}

function separates(a: Body, b: Body, dx: number, dy: number, ax: number, ay: number): boolean {
  return Math.abs(dx * ax + dy * ay) >= projectedRadius(a, ax, ay) + projectedRadius(b, ax, ay);
}

function projectedRadius(body: Body, ax: number, ay: number): number {
  const along = Math.abs(body.u.x * ax + body.u.y * ay);
  const across = Math.abs(-body.u.y * ax + body.u.x * ay);
  return body.halfLength * along + body.halfWidth * across;
}

export interface Collision {
  readonly a: Vehicle;
  readonly b: Vehicle;
  readonly category: string;
}

/** Every overlapping pair of vehicle bodies at this instant. */
export function collisions(w: SimWorld): Collision[] {
  const cell = 40 * U;
  // Cells keyed by number: a string per body and per neighbour a tick was most of the check.
  const grid = new Map<number, Body[]>();
  const keyOf = (ix: number, iy: number): number => (ix + 32_768) * 65_536 + (iy + 32_768);
  const bodies: Body[] = [];
  for (const v of w.vehiclesInIdOrder()) {
    const body = bodyOf(w, v);
    if (!body) continue;
    bodies.push(body);
    const key = keyOf(Math.floor(body.c.x / cell), Math.floor(body.c.y / cell));
    const list = grid.get(key);
    if (list) list.push(body);
    else grid.set(key, [body]);
  }

  const out: Collision[] = [];
  for (const a of bodies) {
    const cx = Math.floor(a.c.x / cell);
    const cy = Math.floor(a.c.y / cell);
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iy = cy - 1; iy <= cy + 1; iy++) {
        for (const b of grid.get(keyOf(ix, iy)) ?? []) {
          if (b.vehicle.id <= a.vehicle.id) continue;
          if (!bodiesOverlap(a, b)) continue;
          out.push({ a: a.vehicle, b: b.vehicle, category: categorise(w, a.vehicle, b.vehicle) });
        }
      }
    }
  }
  return out;
}

/** Why two bodies are allowed to be near each other at all, as a label. */
function categorise(w: SimWorld, a: Vehicle, b: Vehicle): string {
  const la = w.lanelet(a.lanelet);
  const lb = w.lanelet(b.lanelet);
  if (Math.abs(a.lateral) > 0.02 * U || Math.abs(b.lateral) > 0.02 * U) return 'lane-change';
  if (a.lanelet === b.lanelet) return 'same-lanelet';
  const aPath = [a.lanelet, ...a.rearPath.slice(0, 3)];
  const bPath = [b.lanelet, ...b.rearPath.slice(0, 3)];
  if (aPath.some((id) => bPath.includes(id))) return 'shared-path';
  if (la?.kind === 'connector' || lb?.kind === 'connector') {
    const turns = [la?.turn ?? 'link', lb?.turn ?? 'link'].sort().join('/');
    return `junction:${turns}`;
  }
  const aConnector = a.rearPath.slice(0, 3).some((id) => w.lanelet(id)?.kind === 'connector');
  const bConnector = b.rearPath.slice(0, 3).some((id) => w.lanelet(id)?.kind === 'connector');
  if (aConnector || bConnector) return 'junction-exit';
  return 'link';
}

// ------------------------------------------------------------------ scenarios

export interface Layout {
  readonly name: string;
  readonly bearings: readonly number[];
  readonly types: readonly number[];
  readonly lanes?: readonly number[];
  readonly oneWay?: boolean;
}

/** The junction shapes every physical-conflict measurement runs against. */
export const LAYOUTS: readonly Layout[] = [
  { name: 'four-way-avenues', bearings: [0, 90, 180, 270], types: [3, 3, 3, 3] },
  { name: 'mixed-T', bearings: [0, 90, 180], types: [2, 1, 3] },
  { name: 'skewed', bearings: [0, 67, 175, 257], types: [1, 2, 3, 2] },
  { name: 'five-leg', bearings: [0, 68, 145, 218, 293], types: [2, 1, 3, 2, 1] },
  { name: 'one-way-mix', bearings: [0, 90, 180, 270], types: [2, 3, 1, 2], oneWay: true },
  { name: 'mixed-lanes', bearings: [0, 90, 180, 270], types: [3, 2, 3, 2], lanes: [3, 1, 2, 2] },
];

/** A junction of `layout`'s legs, each `radius` long in U (0.4 m). */
export function layoutDoc(layout: Layout, radius = 420): { doc: RoadDoc; centre: NodeId } {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  layout.bearings.forEach((degrees, index) => {
    const angle = (degrees * Math.PI) / 180;
    const far = doc.addNode({ x: Math.cos(angle) * radius * U, y: Math.sin(angle) * radius * U });
    const segment = doc.addSegment(centre.id, far.id, layout.types[index] as number);
    if (!segment) throw new Error(`invalid ${layout.name} leg ${index}`);
    const lanes = layout.lanes?.[index];
    if (lanes !== undefined) doc.setSegmentLanes(segment.id, lanes);
    if (layout.oneWay && index % 2 === 0) {
      doc.setSegmentDirection(segment.id, index === 0 ? 'aToB' : 'bToA');
    }
  });
  doc.setNodeControl(centre.id, 'signal');
  return { doc, centre: centre.id };
}

export function simOf(doc: RoadDoc, seed: number, intensity = 2): SimWorld {
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, seed);
  sim.rebuildTopology();
  sim.trafficIntensity = intensity;
  sim.demandMultiplier = intensity;
  sim.clock.paused = false;
  // People on the footways as the game has them (`main.ts`)
  sim.usePedestrianEngine(createAgentWalkEngine());
  sim.ambient.enabled = true;
  sim.ambient.source = 'edges';
  sim.pedestrianCount = Math.round(50 * intensity);
  return sim;
}

export function fixtureDoc(): RoadDoc {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'tests', 'fixtures', 'grid-and-bends.json'), 'utf8'),
  ) as { document: unknown };
  return RoadDoc.fromJSON(raw.document as never);
}
