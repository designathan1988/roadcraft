import { describe, expect, it } from 'vitest';
import { DEFAULT_CITY } from '@world/cityGen/plan';
import { TILES, WHOLE_MAP_DEFAULTS, type WholeMapOptions, borderLine, planWholeMap } from '@world/cityGen/wholeMap';
import { planTile } from '@world/cityGen/tile';
import { type TilePiece, assembleWholeMap } from '@world/cityGen/assemble';
import { ROAD_TYPES } from '@world/roadTypes';
import { buildTile, pieceOf } from '@editor/wholeMapTile';
import { layCity, widenCityFootways } from '@editor/cityGenerator';

/** THE WHOLE MAP BY TILE (`world/cityGen/wholeMap.ts`, `tile.ts`, `assemble.ts`, `editor/wholeMapTile.ts`): each tile a pure function of the seed and its place, the tiles joined the same whatever order they come in, the streets going on across the border avenues. The streets of every tile here (cheap); the whole build of a tile on a countryside one (a town tile takes seconds: the game's run measures those). */

const { size: _size, radius: _radius, ...base } = DEFAULT_CITY;
const options = (seed: number): WholeMapOptions => ({ ...base, ...WHOLE_MAP_DEFAULTS, seed });

/** Every tile's streets alone, as a tile hands them over (`pieceOf`), in the order given. */
function streetPieces(seed: number, order: readonly number[]): TilePiece[] {
  const map = planWholeMap(options(seed));
  return order.map((t) => {
    const tile = planTile(map, t % TILES, Math.floor(t / TILES));
    const doc = layCity(tile.city);
    widenCityFootways(doc);
    return pieceOf(tile, doc.toJSON(), 0);
  });
}

const inOrder = Array.from({ length: TILES * TILES }, (_, t) => t);
/** The tiles as some workers might finish them: a fixed shuffle. */
const shuffled = [...inOrder].sort((a, b) => ((a * 7919) % 101) - ((b * 7919) % 101));

describe('the whole map by tile', () => {
  const seed = 3;
  const joined = assembleWholeMap(streetPieces(seed, inOrder));

  it('joins the tiles the same, byte for byte, in whatever order they were made and came', () => {
    const again = assembleWholeMap(streetPieces(seed, shuffled));
    expect(JSON.stringify(again)).toBe(JSON.stringify(joined));
    // Another seed is another map.
    expect(JSON.stringify(assembleWholeMap(streetPieces(seed + 1, inOrder)).segments)).not.toBe(JSON.stringify(joined.segments));
  }, 60_000);

  it('covers the whole map, every tile a district of some kind, a town in the middle', () => {
    const map = planWholeMap(options(seed));
    const kinds = new Set<string>();
    for (let j = 0; j < TILES; j++) for (let i = 0; i < TILES; i++) kinds.add(map.tile(i, j).kind);
    expect(kinds.has('downtown') && kinds.has('rural')).toBe(true);
    const xs = joined.nodes.map((n) => n.x), ys = joined.nodes.map((n) => n.y);
    // From rim avenue to rim avenue on both axes: the corners covered, not a circle.
    expect(Math.min(...xs)).toBe(borderLine(0));
    expect(Math.max(...xs)).toBe(borderLine(TILES));
    expect(Math.min(...ys)).toBe(borderLine(0));
    expect(Math.max(...ys)).toBe(borderLine(TILES));
  }, 60_000);

  it('joins the roads across the tiles: one node per border crossing, one avenue between two, no street left ending at a border', () => {
    const lines = new Set(Array.from({ length: TILES + 1 }, (_, k) => borderLine(k)));
    const at = new Map<string, number>();
    for (const n of joined.nodes) {
      const key = `${n.x},${n.y}`;
      expect(at.has(key), `two nodes at ${key}`).toBe(false);
      at.set(key, n.id);
    }
    const pair = new Set<string>();
    const degree = new Map<number, number>();
    for (const s of joined.segments) {
      const key = s.a < s.b ? `${s.a}:${s.b}` : `${s.b}:${s.a}`;
      expect(pair.has(key), `two roads ${key}`).toBe(false);
      pair.add(key);
      degree.set(s.a, (degree.get(s.a) ?? 0) + 1);
      degree.set(s.b, (degree.get(s.b) ?? 0) + 1);
    }
    const avenue = ROAD_TYPES.findIndex((t) => t.id === 'avenue');
    const node = new Map(joined.nodes.map((n) => [n.id, n]));
    let crossings = 0;
    for (const n of joined.nodes) {
      const near = Math.min(...[...lines].map((l) => Math.min(Math.abs(n.x - l), Math.abs(n.y - l))));
      // No street ends at or near a border avenue: a dead end there is a stub left of a gate or a street stopped short.
      if (near < 60) expect(degree.get(n.id), `dead end at (${n.x}, ${n.y})`).toBeGreaterThan(1);
      const inner = (v: number): boolean => lines.has(v) && v !== borderLine(0) && v !== borderLine(TILES);
      if (inner(n.x) && inner(n.y)) expect(degree.get(n.id)).toBe(4);
      // A gate on an inner border with streets on both sides: the street goes on across the avenue.
      if ((inner(n.x) || inner(n.y)) && degree.get(n.id) === 4) crossings++;
    }
    expect(crossings).toBeGreaterThan(100);
    // Every border avenue runs whole along each inner line: its pieces are avenues, end to end.
    for (const s of joined.segments) {
      const a = node.get(s.a)!, b = node.get(s.b)!;
      if ((a.x === b.x && lines.has(a.x)) || (a.y === b.y && lines.has(a.y))) expect(s.type).toBe(avenue);
    }
  }, 60_000);

  it('builds a tile the same each time, buildings and all', () => {
    const map = planWholeMap(options(seed));
    let rural: [number, number] = [0, 0];
    for (let j = 0; j < TILES; j++) for (let i = 0; i < TILES; i++) if (map.tile(i, j).kind === 'rural') rural = [i, j];
    const strip = (p: TilePiece): string => JSON.stringify({ ...p, ms: 0 });
    const first = buildTile(options(seed), ...rural);
    expect(first.lots.length).toBeGreaterThan(50);
    expect(strip(buildTile(options(seed), ...rural))).toBe(strip(first));
  }, 60_000);
});
