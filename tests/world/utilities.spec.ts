import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import {
  DEFAULT_POLE_SPACING,
  WIRE_MAX_SAG,
  poleCarriesLamp,
  spanSag,
  wireDrop,
} from '@world/utilities';
import { m } from '@world/units';
import { sampleWire } from './oracle/sampleWire';

/** The overhead utility network. */

describe('pole runs', () => {
  it('lights every other pole, deterministically', () => {
    expect(poleCarriesLamp(0)).toBe(true);
    expect(poleCarriesLamp(1)).toBe(false);
    expect(poleCarriesLamp(2)).toBe(true);
  });
});

describe('wires hang', () => {
  it('sags in the middle and not at the ends', () => {
    expect(wireDrop(0, 5)).toBeCloseTo(0, 9);
    expect(wireDrop(1, 5)).toBeCloseTo(0, 9);
    expect(wireDrop(0.5, 5)).toBeCloseTo(5, 9);
  });

  it('is symmetric about the middle', () => {
    for (const t of [0.1, 0.25, 0.4]) {
      expect(wireDrop(t, 3)).toBeCloseTo(wireDrop(1 - t, 3), 9);
    }
  });

  it('sags more on a longer span, but not without limit', () => {
    expect(spanSag(m(40))).toBeGreaterThan(spanSag(m(10)));
    expect(spanSag(m(10_000))).toBeLessThanOrEqual(WIRE_MAX_SAG);
  });

  it('never rises above the chord between its two poles', () => {
    // A wire that bulges upward is not a wire.
    const points = sampleWire(0, 0, 20, 100, 0, 26);
    for (let i = 0; i < points.length; i++) {
      const t = i / (points.length - 1);
      const chord = 20 + (26 - 20) * t;
      expect(points[i]?.z ?? 0).toBeLessThanOrEqual(chord + 1e-9);
    }
  });

  it('meets both poles exactly', () => {
    const points = sampleWire(3, 4, 20, 90, 12, 24);
    const first = points[0];
    const last = points[points.length - 1];
    expect(first?.x).toBeCloseTo(3, 9);
    expect(first?.z).toBeCloseTo(20, 9);
    expect(last?.x).toBeCloseTo(90, 9);
    expect(last?.z).toBeCloseTo(24, 9);
  });

  it('produces only finite points, including for a zero-length span', () => {
    for (const points of [sampleWire(0, 0, 10, 0, 0, 10), sampleWire(0, 0, 5, 300, 200, 40)]) {
      for (const p of points) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
      }
    }
  });
});

describe('the document carries the network', () => {
  const runOf = (doc: RoadDoc, from: { x: number; y: number }, to: { x: number; y: number }) => {
    const spans = Math.max(1, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / DEFAULT_POLE_SPACING));
    const at = (i: number) => ({ x: from.x + (to.x - from.x) * i / spans, y: from.y + (to.y - from.y) * i / spans });
    const ids = Array.from({ length: spans + 1 }, (_, i) => doc.addPole(at(i), poleCarriesLamp(i)).id);
    for (let i = 1; i < ids.length; i++) {
      const a = ids[i - 1];
      const b = ids[i];
      if (a !== undefined && b !== undefined) doc.addPoleSpan(a, b);
    }
    return ids;
  };

  it('survives a JSON round trip', () => {
    const doc = new RoadDoc();
    runOf(doc, { x: -200, y: 0 }, { x: 200, y: 0 });
    const poles = doc.poles.size;
    const spans = doc.poleSpans.size;
    expect(poles).toBeGreaterThan(2);
    expect(spans).toBe(poles - 1);

    const restored = RoadDoc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(restored.poles.size).toBe(poles);
    expect(restored.poleSpans.size).toBe(spans);
    for (const [id, pole] of doc.poles) {
      expect(restored.poles.get(id)?.x).toBeCloseTo(pole.x, 9);
      expect(restored.poles.get(id)?.lamp).toBe(pole.lamp);
    }
  });

  it('LOADS A MAP SAVED BEFORE POLES EXISTED, unchanged', () => {
    // The property that matters most.
    const legacy = {
      version: 1 as const,
      nodes: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 200, y: 0 },
      ],
      segments: [{ id: 1, a: 1, b: 2, type: 2, curve: null }],
    };
    const doc = RoadDoc.fromJSON(legacy);
    expect(doc.nodes.size).toBe(2);
    expect(doc.segments.size).toBe(1);
    expect(doc.poles.size).toBe(0);
    expect(doc.poleSpans.size).toBe(0);
  });

  it('drops a wire whose poles did not survive', () => {
    const doc = RoadDoc.fromJSON({
      version: 1,
      nodes: [],
      segments: [],
      poles: [{ id: 1, x: 0, y: 0 }],
      poleSpans: [{ id: 1, a: 1, b: 99 }],
    });
    expect(doc.poles.size).toBe(1);
    expect(doc.poleSpans.size).toBe(0);
  });

  it('removes every wire that reached a removed pole', () => {
    const doc = new RoadDoc();
    const ids = runOf(doc, { x: 0, y: 0 }, { x: 300, y: 0 });
    const middle = ids[1];
    expect(middle).toBeDefined();
    const before = doc.poleSpans.size;
    if (middle !== undefined) doc.removePole(middle);
    expect(doc.poles.size).toBe(ids.length - 1);
    // An interior pole carried two spans; both must go.
    expect(doc.poleSpans.size).toBe(before - 2);
    for (const span of doc.poleSpans.values()) {
      expect(span.a).not.toBe(middle);
      expect(span.b).not.toBe(middle);
    }
  });

  it('never strings the same wire twice, or a wire to itself', () => {
    const doc = new RoadDoc();
    const a = doc.addPole({ x: 0, y: 0 }).id;
    const b = doc.addPole({ x: 50, y: 0 }).id;
    doc.addPoleSpan(a, b);
    doc.addPoleSpan(a, b);
    doc.addPoleSpan(b, a);
    expect(doc.poleSpans.size).toBe(1);
    expect(doc.addPoleSpan(a, a)).toBeNull();
    expect(doc.poleSpans.size).toBe(1);
  });

  it('is carried through clone and replaceWith', () => {
    const doc = new RoadDoc();
    runOf(doc, { x: 0, y: 0 }, { x: 240, y: 60 });
    const copy = doc.clone();
    expect(copy.poles.size).toBe(doc.poles.size);
    expect(copy.poleSpans.size).toBe(doc.poleSpans.size);

    const target = new RoadDoc();
    target.replaceWith(doc);
    expect(target.poles.size).toBe(doc.poles.size);
    expect(target.poleSpans.size).toBe(doc.poleSpans.size);
  });

  it('bumps the utility revision, and not the network revision', () => {
    const doc = new RoadDoc();
    // A pole moved `revision` and rebuilt the whole road network and the simulation topology
    const before = doc.revision;
    const utilities = doc.utilityRevision;
    const a = doc.addPole({ x: 0, y: 0 }).id;
    const b = doc.addPole({ x: 60, y: 0 }).id;
    doc.addPoleSpan(a, b);
    doc.removePole(a);
    expect(doc.utilityRevision).toBe(utilities + 4);
    expect(doc.revision).toBe(before);
  });

  it('finds the nearest pole within reach, and none outside it', () => {
    const doc = new RoadDoc();
    doc.addPole({ x: 0, y: 0 });
    const near = doc.addPole({ x: 10, y: 0 });
    expect(doc.poleNear({ x: 11, y: 0 }, 5)?.id).toBe(near.id);
    expect(doc.poleNear({ x: 500, y: 500 }, 5)).toBeNull();
  });
});
