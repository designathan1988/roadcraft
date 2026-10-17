import { identityMemo } from '@core/identityMemo';
import type { Vec2 } from '@core/vec2';
import { localToWorld } from './buildings/geometry';
import type { Building } from './buildings/types';
import { m } from './units';

/** THE BUILDINGS' ENTRANCES a street's parking keeps clear of: from the records alone (no document, no network), so the document and the tile store read them without a cycle through the streets */

/** The narrowest gate a car goes through (a person's is 1.2 m); `sim/agents/parking.ts` `CAR_GATE`. */
const CAR_GATE_WIDTH = m(2.2);

/** One building's entrances: its car gates and the edges of its parking, worked out once a record (records are replaced, never changed: `identityMemo`) - each street with parking read the buildings near it on both its sides, every one worked out again each time. */
export const entrancesOf: (b: Building) => readonly [Vec2, Vec2][] = identityMemo(workOutEntrances);

/** Each record's entrances, worked out once (`entrancesOf`: records are never changed, only replaced). */
function workOutEntrances(b: Building): readonly [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  // Every car gate is a lowered kerb (CTB art. 181 IX: no parking where the kerb is lowered for vehicles to go in or out)
  for (const el of b.elements ?? []) {
    if (el.kind !== 'gate' || el.w < CAR_GATE_WIDTH) continue;
    const alongY = el.facing === 1 || el.facing === 3;
    const c = Math.cos(el.angle ?? 0), s = Math.sin(el.angle ?? 0);
    const ux = alongY ? -s : c, uy = alongY ? c : s;
    out.push([localToWorld(b, el.x - ux * el.w / 2, el.y - uy * el.w / 2), localToWorld(b, el.x + ux * el.w / 2, el.y + uy * el.w / 2)]);
  }
  for (const el of b.elements ?? []) {
    if (el.kind !== 'parking') continue;
    const lot = b.volumes.find((v) => v.open && el.x >= v.x && el.x <= v.x + v.w && el.y >= v.y && el.y <= v.y + v.d);
    const box = lot ?? { x: el.x - el.w / 2, y: el.y - el.d / 2, w: el.w, d: el.d };
    const corners = [
      localToWorld(b, box.x, box.y), localToWorld(b, box.x + box.w, box.y),
      localToWorld(b, box.x + box.w, box.y + box.d), localToWorld(b, box.x, box.y + box.d),
    ];
    for (let i = 0; i < 4; i++) out.push([corners[i]!, corners[(i + 1) % 4]!]);
  }
  return out;
}

/** Every entrance of some buildings (`entrancesOf`), four numbers each (x0, y0, x1, y1): what a tile keeps of its buildings for its streets' parking (`TileRecords.gates`). */
export function gatesOf(buildings: Iterable<Building>): number[] {
  const out: number[] = [];
  for (const b of buildings) for (const [p, q] of entrancesOf(b)) out.push(p.x, p.y, q.x, q.y);
  return out;
}
