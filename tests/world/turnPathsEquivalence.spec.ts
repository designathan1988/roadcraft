import { describe, expect, it, vi } from 'vitest';
import type { Polyline } from '@core/polyline';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import { planCity, DEFAULT_CITY, type CityStyle, type CitySize } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import { HEAVY, type BodyClass } from '@world/conflictPoints';
import { type JunctionSurface, type RoadEnds, type TurnPathResult, type WaitingLane, turnFits } from '@world/turnPaths';
import { ReferenceSurface, referenceTurnFits, referenceTurnPath } from './support/turnPathsReference';

/**
 * THE FAST TURN SEARCH IS THE OLD ONE (2026-10-14): `turnPath` stopped
 * sweeping each candidate position by position against every ring and every
 * queued car (`world/turnPaths.ts`: banded crossings test, approach poses
 * shared, the last failure probed first, candidates made once, no second
 * sweep for `maxBodyClass`). Every movement of generated towns of every
 * street style must come out exactly as the old code made it - the same
 * points, bit for bit, and the same largest body - or traffic would drive
 * differently. The old code is kept frozen in `support/turnPathsReference.ts`.
 */

interface Call {
  readonly args: [Polyline, Polyline, JunctionSurface | null, readonly WaitingLane[], RoadEnds];
  readonly out: TurnPathResult;
}
const calls = vi.hoisted((): Call[] => []);

vi.mock('@world/turnPaths', async (importOriginal) => {
  const real = await importOriginal<typeof import('@world/turnPaths')>();
  return {
    ...real,
    turnPath: (...args: Parameters<typeof real.turnPath>): TurnPathResult => {
      const out = real.turnPath(...args);
      calls.push({ args: [args[0], args[1], args[2], args[3] ?? [], args[4] ?? { fromRoadEnd: false, toRoadEnd: false }], out });
      return out;
    },
  };
});

const sameBits = (a: Float64Array, b: Float64Array): boolean =>
  a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

const TOWNS: [number, CitySize, CityStyle][] = [
  [1, 'small', 'blocks'], [2, 'small', 'grid'], [3, 'small', 'organic'], [4, 'small', 'radial'], [5, 'small', 'mixed'],
  [6, 'medium', 'organic'],
];

describe('turn paths: the fast search gives what the old one gave', () => {
  for (const [seed, size, style] of TOWNS) {
    it(`every movement of a ${size} ${style} town (seed ${seed})`, () => {
      calls.length = 0;
      const doc = layCity(planCity({ ...DEFAULT_CITY, seed, size, style }));
      const net = new Network(doc);
      net.rebuild();
      new LaneletGraph().build(doc, net);
      expect(calls.length).toBeGreaterThan(300);
      let differing = 0, shaped = 0;
      const fitsChecked = new Set<Polyline>();
      for (const { args, out } of calls) {
        const want = referenceTurnPath(...args);
        if (!sameBits(out.path.xy, want.path.xy) || out.maxBodyClass !== want.maxBodyClass) differing++;
        // `turnFits` alone (the turning circle and the median U-turn use it):
        // every body size on every distinct path, against the old sweep.
        const [inCentre, outCentre, surface, , ends] = args;
        if (!surface || surface.empty || fitsChecked.has(out.path)) continue;
        fitsChecked.add(out.path);
        shaped++;
        const ref = new ReferenceSurface(surface);
        for (const body of [0, 1, HEAVY] as BodyClass[]) {
          if (turnFits(inCentre, out.path, outCentre, surface, body, ends)
            !== referenceTurnFits(inCentre, out.path, outCentre, ref, body, ends)) differing++;
        }
      }
      expect(shaped).toBeGreaterThan(300);
      expect(differing).toBe(0);
    });
  }
});
