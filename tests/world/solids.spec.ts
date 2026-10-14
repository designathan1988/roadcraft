import { describe, expect, it } from 'vitest';
import { createSolids, solidsOf } from '@world/solids';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import type { PoleId } from '@world/ids';
import { proveIncremental } from '../support/derivedEquivalence';

/**
 * THE SOLIDS ON THE SPINE (`world/solids.ts`, `world/derived.ts`): kept item by
 * item from the diary, equal at every step to the solids made from nothing,
 * looked up the same, and an edit of one item computes that item only.
 */
const span = m(600);
const at = (rng: { float(): number }) => ({ x: rng.float() * span, y: rng.float() * span });
const pick = <T>(list: readonly T[], rng: { float(): number }): T | undefined => list[Math.floor(rng.float() * list.length)];

const edits = [
  (doc: RoadDoc, rng: { float(): number }) => { doc.addPole(at(rng)); },
  (doc: RoadDoc, rng: { float(): number }) => { const id = pick([...doc.poles.keys()], rng); if (id !== undefined) doc.removePole(id as PoleId); },
  (doc: RoadDoc, rng: { float(): number }) => { doc.addLandscape(rng.float() < 0.5 ? 'bench' : 'lamp', at(rng)); },
  (doc: RoadDoc, rng: { float(): number }) => { const id = pick([...doc.landscape.keys()], rng); if (id !== undefined) doc.removeLandscape(id); },
  (doc: RoadDoc, rng: { float(): number }) => { const a = at(rng); doc.addBarrier('wall', [a, { x: a.x + m(12), y: a.y + m(3) }, { x: a.x + m(20), y: a.y - m(4) }]); },
  (doc: RoadDoc, rng: { float(): number }) => { const id = pick([...doc.barriers.keys()], rng); if (id !== undefined) doc.removeBarrier(id); },
];

describe('the solids', () => {
  it('kept from the diary are the solids made from nothing, at every step', () => {
    const doc = new RoadDoc();
    proveIncremental({ source: doc, make: () => createSolids().derived, edits, steps: 120, seed: 0x501d });
  });

  it('are looked up the same as the solids made from nothing', () => {
    const doc = new RoadDoc();
    const kept = solidsOf(doc);
    const rng = { s: 7, float() { this.s = (this.s * 16807) % 2147483647; return this.s / 2147483647; } };
    for (let i = 0; i < 200; i++) edits[i % edits.length]!(doc, rng);
    solidsOf(doc);
    const fresh = createSolids();
    fresh.derived.refresh(doc);
    const shape = (list: readonly { box: readonly number[] }[]): string[] => list.map((s) => s.box.join(',')).sort();
    for (let i = 0; i < 100; i++) {
      const p = at(rng);
      expect(shape(kept.near(p.x, p.y, m(20))), `query ${i}`).toEqual(shape(fresh.solids.near(p.x, p.y, m(20))));
    }
  });

  it('computes the one item an edit touched, however many there are', () => {
    const work = (count: number): number => {
      const doc = new RoadDoc();
      for (let i = 0; i < count; i++) doc.addPole({ x: (i % 50) * m(10), y: Math.floor(i / 50) * m(10) });
      const solids = solidsOf(doc);
      const before = solids.work.computes;
      doc.addLandscape('bench', { x: m(3), y: m(3) });
      solidsOf(doc);
      return solids.work.computes - before;
    };
    expect(work(100)).toBe(1);
    expect(work(1600)).toBe(1);
  });
});
