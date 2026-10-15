import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { m } from '@world/units';
import type { LaneletGraph, LaneletId } from '@world/lanelets';
import type { SimWorld } from '@sim/world';
import { cyclesOf } from '@sim/intersections/cycles';
import { seededEdit, seededWorld } from './support';

/** The small loops of road found with the open links in a binary heap */
const MAX_CYCLE_STORAGE = m(560);

function oldBuild(graph: LaneletGraph): Map<LaneletId, { id: number; storage: number; lanelets: ReadonlySet<LaneletId> }[]> {
  const ids = [...graph.lanelets.keys()].filter((id) => graph.lanelets.get(id)?.kind === 'link').sort();
  const length = (id: LaneletId): number => {
    const lane = graph.lanelets.get(id);
    return lane?.kind === 'link' ? lane.length : 0;
  };
  const next = (id: LaneletId): LaneletId[] => {
    const out: LaneletId[] = [];
    for (const c of graph.exitsOf(id)) {
      const connector = graph.lanelets.get(c) as { kind: string; turn?: string; toLane?: LaneletId } | undefined;
      if (!connector || connector.turn === 'uturn' || !connector.toLane) continue;
      out.push(connector.toLane);
    }
    return out.sort();
  };
  const seen = new Map<string, { id: number; storage: number; lanelets: ReadonlySet<LaneletId> }>();
  const byLanelet = new Map<LaneletId, { id: number; storage: number; lanelets: ReadonlySet<LaneletId> }[]>();
  for (const start of ids) {
    const best = new Map<LaneletId, number>();
    const parent = new Map<LaneletId, LaneletId>();
    const open: { id: LaneletId; cost: number }[] = [];
    for (const n of next(start)) {
      const cost = length(start) + length(n);
      if (n === start) continue;
      if (cost <= MAX_CYCLE_STORAGE && cost < (best.get(n) ?? Infinity)) {
        best.set(n, cost);
        parent.set(n, start);
        open.push({ id: n, cost });
      }
    }
    let closing: LaneletId | null = null;
    let closingCost = Infinity;
    while (open.length) {
      open.sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : 1));
      const { id, cost } = open.shift()!;
      if (cost > (best.get(id) ?? Infinity) || cost >= closingCost) continue;
      for (const n of next(id)) {
        if (n === start) {
          if (cost < closingCost) { closingCost = cost; closing = id; }
          continue;
        }
        const c = cost + length(n);
        if (c > MAX_CYCLE_STORAGE || c >= (best.get(n) ?? Infinity)) continue;
        best.set(n, c);
        parent.set(n, id);
        open.push({ id: n, cost: c });
      }
    }
    if (closing === null) continue;
    const loop: LaneletId[] = [start];
    for (let at: LaneletId | undefined = closing; at !== undefined && at !== start; at = parent.get(at)) loop.push(at);
    const members = new Set<LaneletId>(loop);
    for (const link of loop) {
      for (const c of graph.exitsOf(link)) {
        const connector = graph.lanelets.get(c) as { toLane?: LaneletId } | undefined;
        if (connector?.toLane && members.has(connector.toLane)) members.add(c);
      }
    }
    const key = [...loop].sort().join('|');
    let cycle = seen.get(key);
    if (!cycle) {
      cycle = { id: seen.size, storage: closingCost, lanelets: members };
      seen.set(key, cycle);
      for (const id of members) {
        const list = byLanelet.get(id) ?? [];
        list.push(cycle);
        byLanelet.set(id, list);
      }
    }
  }
  return byLanelet;
}

/** A lane's loops by what they are - links, connectors, storage - not by the order they were numbered in (the index is kept by edits, `CycleIndex`). */
const text = (cycles: readonly { id: number; storage: number; lanelets: ReadonlySet<LaneletId> }[]): string =>
  cycles.map((c) => `${c.storage}:${[...c.lanelets].sort().join(',')}`).sort().join(' ; ');

function compare(w: SimWorld): number {
  const old = oldBuild(w.graph);
  let found = 0;
  for (const id of w.graph.lanelets.keys()) {
    const now = cyclesOf(w, id);
    expect(text(now), id).toBe(text(old.get(id) ?? []));
    found += now.length;
  }
  return found;
}

describe('small loops of road, the open links in a heap', () => {
  for (const [seed, jitter, uniform] of [[9, 8, false], [0xb10c, 8, false], [21, 0, true], [0x7e57, 0, false]] as const) {
    it(`are the loops of the sorted open list (seed ${seed}, jitter ${jitter}${uniform ? ', one class' : ''}), through edits`, () => {
      const w = seededWorld(seed, 5, jitter, uniform);
      const rng = new Rng(seed + 3);
      expect(compare(w)).toBeGreaterThan(20);
      for (let k = 0; k < 4; k++) {
        seededEdit(w, rng);
        compare(w);
      }
    });
  }
});
