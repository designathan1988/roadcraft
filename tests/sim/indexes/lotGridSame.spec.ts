import { describe, expect, it, vi } from 'vitest';
import { Rng } from '@core/rng';
import type { Building, BuildingElement, ElementKind } from '@world/buildings/types';
import { Network } from '@world/network';
import { applyLots, planLots } from '@world/lots';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import type { BuildingId } from '@world/buildings/types';
import { greenCity, layCity, widenCityFootways, zoneCity } from '@editor/cityGenerator';
import { LOT_PLAN_VERSION, growOnLot } from '@editor/zoning';
import { SimWorld } from '@sim/world';
import { buildLotGrid as oldGrid } from './oracle/lotNavOld';

/**
 * THE LOT'S GRID IS THE GRID OF BEFORE, CELL FOR CELL.
 *
 * `buildLotGrid` fills the walls by scanline, tests the parts' cells without
 * building arrays per cell and grows only the solid's edge
 * (`sim/agents/lotNav.ts`). The oracle is the grid of before
 * (`oracle/lotNavOld.ts`: every centre against every wall, every solid cell
 * grown). Every grid the game builds for a generated city - each lot's car
 * grid (`parking.ts`) and each gate's walker grid (`lotDoors.ts`) - and
 * random lots of turned parts and walls off the cells' lines must give the
 * same blocked cells, distances and exits.
 */

type Args = Parameters<typeof oldGrid>;
const seen = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@sim/agents/lotNav', async (load) => {
  const real = await load<typeof import('@sim/agents/lotNav')>();
  return { ...real, buildLotGrid: (...args: Parameters<typeof real.buildLotGrid>) => { seen.calls.push(args); return real.buildLotGrid(...args); } };
});
const { buildLotGrid } = await import('@sim/agents/lotNav');
const { collectBays } = await import('@sim/agents/parking');
const { doorWay } = await import('@sim/agents/lotDoors');

function same(args: Args): number {
  const now = buildLotGrid(...args);
  const was = oldGrid(...args);
  expect([now.x0, now.y0, now.cell, now.nx, now.ny]).toEqual([was.x0, was.y0, was.cell, was.nx, was.ny]);
  expect(Buffer.from(now.blocked).equals(Buffer.from(was.blocked))).toBe(true);
  expect(Buffer.from(now.dist.buffer).equals(Buffer.from(was.dist.buffer))).toBe(true);
  expect(Buffer.from(now.exitOf.buffer).equals(Buffer.from(was.exitOf.buffer))).toBe(true);
  let blocked = 0;
  for (const c of now.blocked) blocked += c;
  return blocked;
}

/** The small city as `main.ts` grows it (`citySpin.spec.ts`). */
function city(): { doc: ReturnType<typeof layCity>; net: Network } {
  const plan = planCity({ ...DEFAULT_CITY, size: 'small' });
  const doc = layCity(plan);
  widenCityFootways(doc);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  greenCity(doc, net, DEFAULT_CITY.seed);
  const zoned = zoneCity(doc, net, plan);
  const refused = new Set<number>();
  for (let guard = 0; guard < zoned * 3 + 50; guard++) {
    const id = growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed);
    if (id === null) {
      if (!doc.lots.some((l) => l.use && (l.building === undefined || !doc.buildings.has(l.building as BuildingId)) && !refused.has(l.id))) break;
      continue;
    }
    const fresh = doc.buildings.get(id as BuildingId);
    if (fresh) doc.buildings.put({ ...fresh, builtAt: 0, decay: 0, lotPlan: LOT_PLAN_VERSION });
  }
  if (net.revision !== doc.revision) net.rebuild();
  return { doc, net };
}

const KINDS: ElementKind[] = ['wall', 'fence', 'parking', 'tree', 'lamp', 'bollard', 'planter', 'stair', 'hedge', 'flowers', 'bench'];

describe('the lot grid', () => {
  it('is the grid of before for every lot and gate of a generated city', () => {
    const { doc, net } = city();
    const w = new SimWorld(doc, net, 7);
    w.rebuildTopology();
    seen.calls.length = 0;
    collectBays(w);
    const cars = seen.calls.length;
    for (const b of doc.buildings.all()) doorWay(b);
    const people = seen.calls.length - cars;
    expect(cars).toBeGreaterThan(50);
    expect(people).toBeGreaterThan(50);
    let blocked = 0;
    for (const args of seen.calls.splice(0)) blocked += same(args as Args);
    expect(blocked).toBeGreaterThan(1000);
  }, 120_000);

  it('is the grid of before for random lots of turned parts and walls', () => {
    const rng = new Rng(0x1a7);
    const r = (a: number, b: number): number => a + (b - a) * rng.float();
    for (let n = 0; n < 300; n++) {
      const lot = { x: r(-40, 40), y: r(-40, 40), w: r(3, 50), d: r(3, 50) };
      const elements: BuildingElement[] = [];
      for (let k = 0; k < 25; k++) {
        elements.push({
          kind: KINDS[Math.floor(rng.float() * KINDS.length)]!, x: r(lot.x - 3, lot.x + lot.w + 3), y: r(lot.y - 3, lot.y + lot.d + 3),
          w: rng.float() < 0.2 ? r(5, 30) : r(0.05, 4), d: r(0.05, 6), facing: Math.floor(rng.float() * 4) as 0 | 1 | 2 | 3,
          z: rng.float() < 0.2 ? 3 : 0, ...(rng.float() < 0.5 ? { angle: r(-Math.PI, Math.PI) } : {}),
        } as BuildingElement);
      }
      const walls: { x: number; y: number }[][] = [];
      for (let k = 0; k < 5; k++) {
        // Rings of 3 to 9 points round a centre, some concave, some on the cells' lines.
        const cx = r(lot.x - 10, lot.x + lot.w + 10), cy = r(lot.y - 10, lot.y + lot.d + 10);
        const count = 3 + Math.floor(rng.float() * 7);
        const ring: { x: number; y: number }[] = [];
        for (let p = 0; p < count; p++) {
          const a = (p / count) * 2 * Math.PI, rad = r(1, 12);
          ring.push(rng.float() < 0.3
            ? { x: lot.x + Math.round((cx + Math.cos(a) * rad - lot.x) / 0.75) * 0.75, y: lot.y + (Math.round((cy + Math.sin(a) * rad - lot.y) / 0.75) + 0.5) * 0.75 }
            : { x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad });
        }
        if (rng.float() < 0.3) ring.reverse();
        walls.push(ring);
      }
      const exits = [0, 1, 2].map(() => {
        const inner = { x: r(lot.x, lot.x + lot.w), y: r(lot.y, lot.y + lot.d) };
        return { inner, edge: { x: inner.x + r(-3, 3), y: inner.y + r(-3, 3) } };
      });
      const b = { elements } as unknown as Building;
      same([b, lot, walls, exits]);
      same([b, lot, walls, exits, { cell: 0.2, clearance: 0.25, solid: new Set<ElementKind>(['wall', 'fence', 'tree', 'flowers', 'parking']) }]);
      same([b, lot, walls, exits, { cell: 0.5, clearance: 0.2 }]);
    }
  });
});
