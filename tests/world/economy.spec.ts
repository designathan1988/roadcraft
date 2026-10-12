import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { ROAD_TUNING } from '@world/roads/tuning';
import { BUILD_KINDS, DEFAULT_ECONOMY, buildLengths, chargeFor, pricePerUnit, readEconomy, roadValue, segmentCost } from '@world/economy';
import { roadProfile } from '@world/roadTypes';
import { segmentPolyline } from '@world/geometry';

const E = ROAD_TUNING.economy;
const PIERS = ROAD_TUNING.structure.pierFrom;

function oneRoad(structure: 'ground' | 'elevated' | 'bridge' | 'tunnel' = 'ground', h0 = 0, h1 = 0, type = 0): { doc: RoadDoc; cost: number } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: 0, y: 0 }, h0);
  const b = doc.addNode({ x: 250, y: 0 }, h1);
  const s = doc.addSegment(a.id, b.id, type, null, 0, 'both', null, structure)!;
  return { doc, cost: segmentCost(doc, s, segmentPolyline(doc, s).length) };
}

describe('road prices', () => {
  it('prices a wider class higher per unit', () => {
    expect(pricePerUnit(roadProfile(0, null))).toBeGreaterThan(0);
    expect(pricePerUnit(roadProfile(3, null))).toBeGreaterThan(pricePerUnit(roadProfile(0, null)));
  });

  it('prices each way of building by its multiplier', () => {
    const ground = oneRoad('ground').cost;
    expect(oneRoad('elevated').cost).toBeCloseTo(ground * E.structure.bridge, 6);
    expect(oneRoad('bridge').cost).toBeCloseTo(ground * E.structure.bridge, 6);
    expect(oneRoad('tunnel').cost).toBeCloseTo(ground * E.structure.tunnel, 6);
    // Authored high over the ground all along: on piers; a little: an embankment; below: a cutting.
    expect(oneRoad('ground', PIERS + 1, PIERS + 1).cost).toBeCloseTo(ground * E.structure.bridge, 6);
    expect(oneRoad('ground', E.fillFrom + 0.5, E.fillFrom + 0.5).cost).toBeCloseTo(ground * E.structure.embankment, 6);
    expect(oneRoad('ground', -E.fillFrom - 0.5, -E.fillFrom - 0.5).cost).toBeCloseTo(ground * E.structure.trench, 6);
  });

  it('splits a ramp exactly between the ways it is built, and a split road sums to the whole', () => {
    const top = PIERS * 2;
    const whole = buildLengths('ground', 0, top, 100);
    expect(BUILD_KINDS.reduce((sum, k) => sum + whole[k], 0)).toBeCloseTo(100, 9);
    expect(whole.ground).toBeCloseTo((E.fillFrom / top) * 100, 9);
    expect(whole.embankment).toBeCloseTo(((PIERS - E.fillFrom) / top) * 100, 9);
    expect(whole.bridge).toBeCloseTo(50, 9);
    const left = buildLengths('ground', 0, top * 0.3, 30);
    const right = buildLengths('ground', top * 0.3, top, 70);
    for (const k of BUILD_KINDS) expect(left[k] + right[k]).toBeCloseTo(whole[k], 9);
  });

  it('values the roads of a document, and only what changed is priced again', () => {
    const { doc, cost } = oneRoad();
    expect(roadValue(doc)).toBeCloseTo(cost, 6);
    const c = doc.addNode({ x: 250, y: 200 });
    const s = doc.addSegment([...doc.nodes.keys()][1]!, c.id, 1)!;
    expect(roadValue(doc)).toBeCloseTo(cost + segmentCost(doc, s, segmentPolyline(doc, s).length), 6);
  });
});

describe('charging an edit', () => {
  it('takes the difference when the roads are worth more, and refuses what the balance cannot cover', () => {
    expect(chargeFor(1000, 1500, 600)).toEqual({ amount: 500, balance: 100, affordable: true });
    expect(chargeFor(1000, 1500, 400)).toEqual({ amount: 500, balance: -100, affordable: false });
  });

  it('gives back the demolition share when they are worth less', () => {
    const charge = chargeFor(2000, 1000, 50);
    expect(charge.amount).toBe(-Math.round(1000 * E.demolitionRefund));
    expect(charge.balance).toBe(50 + Math.round(1000 * E.demolitionRefund));
    expect(charge.affordable).toBe(true);
  });

  it('charges nothing for the rounding of a road re-cut', () => {
    expect(chargeFor(1000, 1000.4, 0)).toEqual({ amount: 0, balance: 0, affordable: true });
  });
});

describe('the balance in the document', () => {
  it('starts at the starting funds and reads only a finite number back', () => {
    expect(new RoadDoc().economy).toEqual(DEFAULT_ECONOMY);
    expect(DEFAULT_ECONOMY.balance).toBe(E.startingFunds);
    expect(readEconomy({ balance: 12 })).toEqual({ balance: 12 });
    expect(readEconomy({ balance: 'a lot' })).toBeNull();
    expect(readEconomy({ balance: Infinity })).toBeNull();
    expect(readEconomy(null)).toBeNull();
  });

  it('is saved only off the starting balance, and comes back as saved', () => {
    const doc = new RoadDoc();
    expect('economy' in doc.toJSON()).toBe(false);
    doc.setBalance(1234);
    expect(doc.toJSON().economy).toEqual({ balance: 1234 });
    expect(RoadDoc.fromJSON(doc.toJSON()).economy.balance).toBe(1234);
    expect(JSON.parse(doc.toText()).economy).toEqual({ balance: 1234 });
  });

  it('moves the economy revision, and replacing the document carries the balance', () => {
    const doc = new RoadDoc();
    const before = doc.economyRevision;
    doc.setBalance(99);
    expect(doc.economyRevision).toBeGreaterThan(before);
    const other = new RoadDoc();
    other.replaceWith(doc);
    expect(other.economy.balance).toBe(99);
  });
});
