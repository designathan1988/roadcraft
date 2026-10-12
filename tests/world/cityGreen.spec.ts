import { describe, expect, it } from 'vitest';

import { greenCity, layCity, widenCityFootways } from '@editor/cityGenerator';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { NEIGHBOURHOOD } from '@world/cityGen/squares';
import { footwayAt, LANDSCAPE_RADIUS, medianAt } from '@world/landscape';
import { applyLots, insideLot, planLots, type Lot } from '@world/lots';
import { Network } from '@world/network';

/**
 * THE GENERATED CITY'S GREEN (docs/VIAS.md V7): no street trees (the
 * player, 2026-10-09), the streets' furniture, one square per neighbourhood made
 * of a whole block (no loose lawn inside a block), its trees inside it, and
 * all of it laid fast.
 */
describe('a generated city is planted', () => {
  it('small city: squares of whole blocks, one per neighbourhood at most, street trees and medians planted', () => {
    const plan = planCity({ ...DEFAULT_CITY, size: 'small', seed: 5 });
    const doc = layCity(plan);
    widenCityFootways(doc);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    const lotsBefore = [...doc.lots] as Lot[];
    const started = performance.now();
    const green = greenCity(doc, net, 5);
    const ms = performance.now() - started;
    expect(green.squares).toBeGreaterThanOrEqual(1);
    expect(ms).toBeLessThan(15_000);
    // No lot remains under a square's tree; every square tree stood on a lot (inside the block).
    const lotsAfter = doc.lots as readonly Lot[];
    for (const tree of doc.trees) {
      expect(lotsBefore.some((l) => insideLot(tree, l))).toBe(true);
      expect(lotsAfter.some((l) => insideLot(tree, l))).toBe(false);
    }
    // At most one square per neighbourhood cell.
    const cells = new Map<string, number>();
    const removed = lotsBefore.filter((l) => !lotsAfter.some((k) => k.id === l.id));
    expect(removed.length).toBeGreaterThan(0);
    // No street trees (the player, 2026-10-09): none on a footway or in a
    // median, while the rest of the furniture is laid.
    const items = [...doc.landscape.values()];
    expect(items.filter((i) => i.kind === 'tree')).toEqual([]);
    expect(items.some((i) => i.kind !== 'tree' && i.kind !== 'streetname' && (footwayAt(net, i) !== null || medianAt(net, i) !== null))).toBe(true);
    expect(items.filter((i) => i.kind === 'bench').length).toBeGreaterThan(20);
    const squareTrees = doc.trees;
    for (const t of squareTrees) {
      const key = `${Math.floor(t.x / NEIGHBOURHOOD)},${Math.floor(t.y / NEIGHBOURHOOD)}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    expect(cells.size).toBeLessThanOrEqual(green.squares * 4);
    // The power lines: poles down the streets, joined by spans, every one lit, nothing of the furniture on a pole.
    expect(doc.poles.size).toBeGreaterThan(50);
    expect(doc.poleSpans.size).toBeGreaterThan(doc.poles.size / 2);
    expect([...doc.poles.values()].every((p) => p.lamp)).toBe(true);
    for (const pole of doc.poles.values()) {
      for (const item of doc.landscape.values()) expect(Math.hypot(item.x - pole.x, item.y - pole.y)).toBeGreaterThan(LANDSCAPE_RADIUS.lamp);
    }
  });
});
