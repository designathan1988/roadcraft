import { writeFileSync } from 'node:fs';
import { tileStreets } from '@world/cityGen/network';
import { MAP_TILES, WHOLE_MAP_DEFAULTS, planWholeMap } from '@world/cityGen/wholeMap';
import { DEFAULT_CITY } from '@world/cityGen/plan';
import { OWNER, TILE, edgeNodeId, tileKey } from '@world/tiles';

// The whole map's streets as the tiles take them: every tile's owned roads, joined by their nodes' places.
const SEED = 1;
const { size: _s, radius: _r, ...base } = DEFAULT_CITY;
const map = planWholeMap({ ...base, ...WHOLE_MAP_DEFAULTS, seed: SEED });
const lo = -MAP_TILES / 2, hi = MAP_TILES / 2;
type P = { x: number; y: number };
const owned: { a: P; b: P; level: number; tile: number }[] = [];
let slowest = 0;
for (let i = lo; i < hi; i++) for (let j = lo; j < hi; j++) {
  const t = performance.now();
  const g = tileStreets(SEED, i, j, map.heatAt);
  slowest = Math.max(slowest, performance.now() - t);
  for (const e of g.edges) {
    const a = g.nodes[e.a]!, b = g.nodes[e.b]!;
    if (OWNER.segment(a, b) === tileKey(i, j)) owned.push({ a, b, level: e.level, tile: tileKey(i, j) });
  }
}
const place = (p: P): string => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;

if (process.env['CITY_SVG']) {
  const H = (MAP_TILES / 2) * TILE, sc = 2048 / (2 * H);
  const X = (p: P): string => ((p.x + H) * sc).toFixed(1), Y = (p: P): string => ((H - p.y) * sc).toFixed(1);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="2048"><rect width="2048" height="2048" fill="#eef0e6"/>`;
  for (let k = lo; k <= hi; k++) svg += `<line x1="${(k * TILE + H) * sc}" y1="0" x2="${(k * TILE + H) * sc}" y2="2048" stroke="#e0a" stroke-width="0.5" stroke-dasharray="3 5"/><line x1="0" y1="${(H - k * TILE) * sc}" x2="2048" y2="${(H - k * TILE) * sc}" stroke="#e0a" stroke-width="0.5" stroke-dasharray="3 5"/>`;
  for (const L of [2, 1, 0]) for (const e of owned) if (e.level === L) svg += `<line x1="${X(e.a)}" y1="${Y(e.a)}" x2="${X(e.b)}" y2="${Y(e.b)}" stroke="${['#222', '#3a6db0', '#8a8a8a'][L]}" stroke-width="${[2.2, 1.2, 0.6][L]}"/>`;
  writeFileSync(process.env['CITY_SVG'], `${svg}</svg>`);
}

describe('the whole map\'s streets (network.ts), tile by tile', () => {
  it('every tile lays roads of its own, a tile in well under a second', () => {
    const tiles = new Set(owned.map((e) => e.tile));
    expect(tiles.size).toBe(MAP_TILES * MAP_TILES);
    expect(slowest).toBeLessThan(1000);
  });

  it('two tiles never lay the same road, and a road crossing an edge meets its neighbour\'s on the edge', () => {
    const seen = new Set<string>();
    for (const e of owned) {
      const k = [place(e.a), place(e.b)].sort().join('|');
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      // An end off its own tile is on an edge (`wholeMapTile.ts` borrowed nodes).
      for (const end of [e.a, e.b]) if (OWNER.node(end) !== e.tile) expect(edgeNodeId(end.x, end.y)).not.toBeNull();
    }
  });

  it('is one network: every road reaches every other, and no street ends in nothing', () => {
    const adj = new Map<string, string[]>();
    for (const e of owned) {
      const a = place(e.a), b = place(e.b);
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
    }
    const first = adj.keys().next().value!;
    const reached = new Set([first]), stack = [first];
    while (stack.length) for (const n of adj.get(stack.pop()!)!) if (!reached.has(n)) { reached.add(n); stack.push(n); }
    expect(reached.size).toBe(adj.size);
    const deadEnds = [...adj.values()].filter((v) => v.length === 1).length;
    expect(deadEnds).toBe(0);
  });

  it('no road shorter than a few metres (the junctions need room)', () => {
    const short = owned.filter((e) => Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) < 2);
    expect(short).toEqual([]);
  });
});
