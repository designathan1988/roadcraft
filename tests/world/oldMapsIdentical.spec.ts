import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { METERS_PER_UNIT } from '@world/units';
import { applyOp, freshState, type FuzzOp } from '../fuzz/support/ops';
import { generate } from '../fuzz/support/runner';
import { derivedLines, laneletLines, networkLines } from './support/roadDigest';

/**
 * OLD MAPS STAY IDENTICAL (docs/VIAS.md, acceptance of every stage): the
 * road system grows - profiles, asymmetry, materials, connectors, controls -
 * and a map saved before any of it must derive exactly what it derived
 * before: the same ribbons, junctions, lanelets, surface bands, walkways,
 * furniture, markings and cross-sections. Recorded once from the code before
 * the road system (`ROAD_BASELINE_RECORD=1` rewrites it, only on purpose).
 * The fuzz maps are stored as their operations, so a fuzzer that learns new
 * gestures still replays the same maps.
 *
 * One baseline per world unit (`core/units.ts`): the lines digest the numbers
 * in units, and a map opened at another unit is rescaled (`world/rescale.ts`),
 * so its floats round differently though it is the same place in metres. The
 * fuzz operations of each are drawn in that unit's numbers (`fuzz/support/ops.ts`).
 */
const FIXTURE = METERS_PER_UNIT === 0.4 ? 'tests/fixtures/roadBaseline.json' : `tests/fixtures/roadBaseline.${METERS_PER_UNIT}m.json`;

interface Baseline {
  readonly ops: Record<string, FuzzOp[]>;
  readonly lines: Record<string, Record<string, string[]>>;
}

function maps(): [string, () => RoadDoc][] {
  const map = (path: string) => (): RoadDoc => {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return RoadDoc.fromJSON(data.document ?? data);
  };
  return [
    ['test town', map('maps/cidade-com-estacionamento.json')],
    ['grid and bends', map('tests/fixtures/grid-and-bends.json')],
    ['player city', map('tests/fixtures/player-city.json')],
  ];
}

function replayed(ops: readonly FuzzOp[]): RoadDoc {
  const state = freshState();
  for (const op of ops) { try { applyOp(state, op); } catch { break; } }
  return state.doc;
}

function linesOf(doc: RoadDoc): Record<string, string[]> {
  const net = new Network(doc);
  net.rebuild({ full: true });
  return { network: networkLines(net), lanelets: laneletLines(doc, net), derived: derivedLines(net) };
}

describe('old maps', () => {
  it('derive exactly what they derived before the road system', () => {
    const record = process.env['ROAD_BASELINE_RECORD'] === '1' || !existsSync(FIXTURE);
    const before: Baseline | null = record ? null : JSON.parse(readFileSync(FIXTURE, 'utf8')) as Baseline;
    const ops: Record<string, FuzzOp[]> = before?.ops ?? {};
    if (!before) for (const seed of [1, 2, 3, 4]) ops[`fuzz seed ${seed}`] = generate(seed, 24);
    const now: Record<string, Record<string, string[]>> = {};
    for (const [name, build] of maps()) now[name] = linesOf(build());
    for (const [name, list] of Object.entries(ops)) now[name] = linesOf(replayed(list));
    if (!before) {
      writeFileSync(FIXTURE, JSON.stringify({ ops, lines: now } satisfies Baseline));
      return;
    }
    for (const name of Object.keys(before.lines)) {
      for (const part of Object.keys(before.lines[name]!)) {
        expect(now[name]?.[part], `${name}: ${part}`).toEqual(before.lines[name]![part]);
      }
    }
  });
});
