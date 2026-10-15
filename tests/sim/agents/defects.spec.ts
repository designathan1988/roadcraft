import { describe, expect, it } from 'vitest';
import { CITIES, measureDefects } from '../support/agentDefects';

/** The agents, in every kind of city the player builds, with the engines the game runs */
/** Simulated seconds in each city but those that set their own (90 before 2026-10-13, which ran in no check). */
const SECONDS = 20;
describe('agents in every city', () => {
  for (const city of CITIES) {
    it(city.name, () => {
      const r = measureDefects(city, city.seconds ?? SECONDS);
      expect(r.people).toBeGreaterThan(10);
      // Never stepping backwards nor jumping
      expect({ back: r.back, jump: r.jump }).toEqual({ back: 0, jump: 0 });
      expect(r.side).toBeLessThan(0.1);
      // Walking means getting somewhere: no pair circling each other, no body treading the same spot
      expect(r.milling).toBeLessThan(0.001);
      expect(r.millingSpell).toBeLessThan(1);
      expect(r.flip).toBeLessThan(0.1);
      // Nobody stands frozen: on a zebra
      expect(r.zebraStand).toBeLessThan(5);
      expect(r.pavementStand).toBeLessThan(4);
      // Standing still means standing still: no head swinging to and fro.
      expect(r.fidgets).toBeLessThan(0.1);
      // Bodies meet (closer than 0.4 m) only for a moment, somebody held up squeezing past
      expect(r.overlaps).toBeLessThan(0.5);
      expect(r.ghost).toBeLessThan(0.005);
      expect(r.junction).toBeLessThan(60);
      // No car stands longer than a signal cycle: the longest measured is a five-stage junction's red, 78 s
      expect(r.still).toBeLessThan(100);
    });
  }
});
