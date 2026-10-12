import { describe, expect, it } from 'vitest';
import { ROAD_TUNING } from '@world/roads/tuning';
import { MAX_AUTHORED_GRADE } from '@world/elevation';
import { TUNNEL_GRADE, roadStructure } from '@world/structures';
import { DEFAULT_POLE_SPACING, MAX_POLE_SPACING, MIN_POLE_SPACING } from '@world/utilities';
import { m } from '@world/units';

/**
 * The road tuning (`world/roads/tuning.ts`, docs/VIAS.md V0) holds the LIVE
 * figures exactly as the code had them before it existed: moving them into
 * one place must not change the game. A live figure changes only by the
 * player's decision, and then this lock changes with it, on purpose.
 */
describe('road tuning', () => {
  it('keeps every live figure at the value the game ran on', () => {
    expect(ROAD_TUNING.grade.ground).toBe(0.12);
    expect(ROAD_TUNING.grade.authored).toBe(0.12);
    expect(ROAD_TUNING.grade.ramp).toBe(0.16);
    expect(ROAD_TUNING.grade.deck).toBe(0.05);
    expect(ROAD_TUNING.grade.deckTie).toBe(0.05);
    expect(ROAD_TUNING.grade.tunnel).toBe(0.13);
    expect(ROAD_TUNING.grade.refuse).toBe(0.35);
    expect(ROAD_TUNING.clearance.elevated).toBeCloseTo(m(5.6), 9);
    expect(ROAD_TUNING.clearance.bridge).toBeCloseTo(m(3), 9);
    expect(ROAD_TUNING.structure.liftOn).toBeCloseTo(m(0.6), 9);
    expect(ROAD_TUNING.structure.pierFrom).toBeCloseTo(m(2.8), 9);
    expect(ROAD_TUNING.tunnel.autoCover).toBe(m(18));
    expect(ROAD_TUNING.piers.spacingElevated).toBeCloseTo(m(29.6), 9);
    expect(ROAD_TUNING.piers.spacingBridge).toBeCloseTo(m(38.4), 9);
    expect(ROAD_TUNING.poles.spacing).toBe(m(38));
    expect(ROAD_TUNING.poles.minSpacing).toBe(m(18));
    expect(ROAD_TUNING.poles.maxSpacing).toBe(m(80));
  });

  it('is what the code that used to declare them reads', () => {
    expect(MAX_AUTHORED_GRADE).toBe(ROAD_TUNING.grade.authored);
    expect(TUNNEL_GRADE).toBe(ROAD_TUNING.grade.tunnel);
    expect(roadStructure('elevated').clearance).toBe(ROAD_TUNING.clearance.elevated);
    expect(roadStructure('bridge').clearance).toBe(ROAD_TUNING.clearance.bridge);
    expect(DEFAULT_POLE_SPACING).toBe(ROAD_TUNING.poles.spacing);
    expect(MIN_POLE_SPACING).toBe(ROAD_TUNING.poles.minSpacing);
    expect(MAX_POLE_SPACING).toBe(ROAD_TUNING.poles.maxSpacing);
  });

  it('holds the sourced figures for the stages to come', () => {
    expect(ROAD_TUNING.grade.groundReference).toBe(0.08);
    expect(ROAD_TUNING.clearance.overRoad).toBeCloseTo(m(5.5));
    expect(ROAD_TUNING.clearance.underUrbanViaduct).toBeCloseTo(m(4.5));
    expect(ROAD_TUNING.structure.bridgeAbove).toBeCloseTo(m(6));
    expect(ROAD_TUNING.tunnel.minCover).toBeCloseTo(m(7));
    expect(ROAD_TUNING.piers.reference.min).toBeCloseTo(m(25));
    expect(ROAD_TUNING.piers.reference.max).toBeCloseTo(m(35));
    expect(ROAD_TUNING.poles.reference.min).toBeCloseTo(m(30));
    expect(ROAD_TUNING.poles.reference.max).toBeCloseTo(m(38));
  });

  it('orders the grades and the prices sensibly', () => {
    const g = ROAD_TUNING.grade;
    expect(g.deck).toBeLessThan(g.ground);
    expect(g.ground).toBeLessThan(g.ramp);
    expect(g.ramp).toBeLessThan(g.refuse);
    const s = ROAD_TUNING.economy.structure;
    expect(s.ground).toBe(1);
    expect(s.embankment).toBeGreaterThan(s.ground);
    expect(s.trench).toBeGreaterThan(s.embankment);
    expect(s.bridge).toBeGreaterThan(s.trench);
    expect(s.tunnel).toBeGreaterThan(s.bridge);
    expect(ROAD_TUNING.economy.demolitionRefund).toBeGreaterThanOrEqual(0);
    expect(ROAD_TUNING.economy.demolitionRefund).toBeLessThanOrEqual(1);
    expect(ROAD_TUNING.economy.startingFunds).toBeGreaterThan(0);
  });
});
