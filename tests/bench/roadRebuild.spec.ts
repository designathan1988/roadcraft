import { appendFileSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import { type RoadElevation, buildRoadElevation } from '@world/elevation';
import { TerrainIndex, sampleTerrainHeight } from '@world/terrain';
import { commitRoadPath, moveNodeChecked } from '@editor/commit';
import { guardRoadEdit } from '@editor/editRules';
import { findAnchor } from '@editor/snap';
import { restoreSnapshot } from '@editor/history';

/**
 * THE ROAD REBUILD BENCHMARK (BENCH=1, docs/VIAS.md V0): what one road edit
 * costs in the network rebuild and the roads' height solve on the test town
 * (`maps/cidade-com-estacionamento.json`), the way the game pays for it:
 * the editor call (with its own rebuilds and judging), the rebuild
 * `mutateBuilt` does after it, and the renderer's height solve against the
 * terrain (handed the previous solve, as `render/renderer.ts` does when the
 * land did not move). Milliseconds, median of the repeats; written to
 * BENCH_OUT when set.
 */
const REPEATS = Number(process.env['BENCH_EDITS'] ?? 5);
const median = (xs: number[]): number => Math.round(([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0) * 100) / 100;
const time = (fn: () => void): number => { const t0 = performance.now(); fn(); return performance.now() - t0; };

describe('road rebuild benchmark', () => {
  it.runIf(process.env['BENCH'] === '1')('times road edits on the test town', () => {
    const source = JSON.parse(readFileSync('maps/cidade-com-estacionamento.json', 'utf8'));
    const rows: Record<string, number[]> = {};
    const note = (key: string, ms: number): void => { (rows[key] ??= []).push(ms); };
    for (let r = 0; r < REPEATS; r++) {
      const doc = RoadDoc.fromJSON(source);
      const net = new Network(doc);
      note('load: full rebuild', time(() => net.rebuild()));
      const index = new TerrainIndex(doc.terrainStamps, 0, doc.terrainRelief);
      const ground = (x: number, y: number): number => sampleTerrainHeight(index, x, y);
      let elevation: RoadElevation = buildRoadElevation(net, ground);
      note('load: full height solve', time(() => { elevation = buildRoadElevation(net, ground); }));
      const solve = (label: string): void => {
        const previous = elevation;
        note(`${label}: height solve`, time(() => { elevation = buildRoadElevation(net, ground, previous); }));
      };
      const ids = [...doc.segments.keys()].sort((a, b) => a - b);
      // Three short roads out of the middle of existing ones, as the player draws them.
      for (const pick of [0.2, 0.5, 0.8]) {
        const id = ids[Math.floor(pick * ids.length)] as SegmentId;
        const line = net.polylines.get(doc, id);
        const frame = line.sampleAt(line.length / 2);
        const start = findAnchor(doc, net, frame.p, 1);
        const end = { x: frame.p.x + frame.n.x * 150, y: frame.p.y + frame.n.y * 150 };
        const snapshot = doc.toJSON();
        let committed = false;
        // The preview's dry run (`roadTool.ts` `judge`), with its stations (docs/VIAS.md V3).
        performance.clearMeasures();
        note('road: dry run', time(() => {
          commitRoadPath(doc, net, start, { kind: 'free', at: end }, 1,
            [{ start: { at: start.at, heightOffset: 0 }, end: { at: end, heightOffset: 0 }, curve: null }], null, undefined, ground,
            { groundSolve: elevation, dryRun: true });
        }));
        note('  dry run: stations', performance.getEntriesByName('hitch:commit/stations').reduce((sum, e) => sum + e.duration, 0));
        performance.clearMeasures();
        note('road: commit', time(() => {
          committed = commitRoadPath(doc, net, start, { kind: 'free', at: end }, 1,
            [{ start: { at: start.at, heightOffset: 0 }, end: { at: end, heightOffset: 0 }, curve: null }], null, undefined, ground,
            { groundSolve: elevation }).committed;
        }));
        // The commit's own `hitch:` steps (commit.ts, network.ts, elevation.ts), summed per name.
        const steps = new Map<string, number>();
        for (const entry of performance.getEntriesByType('measure')) {
          if (entry.name.startsWith('hitch:')) steps.set(entry.name, (steps.get(entry.name) ?? 0) + entry.duration);
        }
        for (const [name, ms] of steps) note(`  ${name.slice(6)}`, ms);
        note('road: rebuild after', time(() => { if (net.revision !== doc.revision) net.rebuild(); }));
        solve('road');
        if (committed) {
          note('undo: document restored', time(() => doc.replaceFromJSON(snapshot, { repair: false })));
          note('undo: network rebuild', time(() => { if (net.revision !== doc.revision) net.rebuild(); }));
          note('undo: (restoreSnapshot, no-op)', time(() => restoreSnapshot(doc, snapshot, net)));
          solve('undo');
        }
      }
      // A node dragged, and a road retyped.
      const node = [...doc.nodes.values()].find((n) => n.incident.length === 3);
      if (node) {
        note('move node: edit', time(() => { moveNodeChecked(doc, net, node.id, { x: node.x + 6, y: node.y + 4 }); }));
        note('move node: rebuild after', time(() => { if (net.revision !== doc.revision) net.rebuild(); }));
        solve('move node');
      }
      const retyped = ids[Math.floor(ids.length / 3)] as SegmentId;
      note('retype: edit', time(() => { guardRoadEdit(doc, net, () => { doc.setSegmentType(retyped, (doc.requireSegment(retyped).type + 1) % 4); return true; }); }));
      note('retype: rebuild after', time(() => { if (net.revision !== doc.revision) net.rebuild(); }));
      solve('retype');
    }
    // A bigger network (a 12 x 12 grid of streets and avenues, 312 roads) on
    // the town's land: how the cost of one edit grows with the map.
    for (let r = 0; r < REPEATS; r++) {
      const doc = new RoadDoc();
      doc.terrainRelief = source.relief ?? doc.terrainRelief;
      const town = RoadDoc.fromJSON(source);
      doc.terrainStamps.push(...town.terrainStamps.map((stamp) => ({ ...stamp })));
      const n = 12, spacing = 160, origin = -((n - 1) * spacing) / 2;
      const grid: number[][] = [];
      for (let i = 0; i < n; i++) {
        grid.push([]);
        for (let j = 0; j < n; j++) grid[i]!.push(doc.addNode({ x: origin + i * spacing, y: origin + j * spacing }).id);
      }
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i + 1 < n) doc.addSegment(grid[i]![j]! as never, grid[i + 1]![j]! as never, j % 3 === 0 ? 3 : 1);
          if (j + 1 < n) doc.addSegment(grid[i]![j]! as never, grid[i]![j + 1]! as never, i % 3 === 0 ? 3 : 1);
        }
      }
      const net = new Network(doc);
      note('grid: full rebuild', time(() => net.rebuild({ full: true })));
      const index = new TerrainIndex(doc.terrainStamps, 0, doc.terrainRelief);
      const ground = (x: number, y: number): number => sampleTerrainHeight(index, x, y);
      let elevation: RoadElevation = buildRoadElevation(net, ground);
      note('grid: full height solve', time(() => { elevation = buildRoadElevation(net, ground); }));
      const middle = doc.requireNode(grid[5]![6]! as never);
      note('grid move node: edit', time(() => { moveNodeChecked(doc, net, middle.id, { x: middle.x + 8, y: middle.y - 6 }); }));
      note('grid move node: rebuild after', time(() => { if (net.revision !== doc.revision) net.rebuild(); }));
      const previous = elevation;
      note('grid move node: height solve', time(() => { elevation = buildRoadElevation(net, ground, previous); }));
      const seg = [...doc.segments.keys()][100] as SegmentId;
      note('grid retype: edit', time(() => { guardRoadEdit(doc, net, () => { doc.setSegmentType(seg, 2); return true; }); }));
      const before = elevation;
      note('grid retype: height solve', time(() => { elevation = buildRoadElevation(net, ground, before); }));
    }
    const lines = Object.entries(rows).map(([key, xs]) => `${key.padEnd(28)} ${String(median(xs)).padStart(8)} ms`);
    if (process.env['BENCH_OUT']) appendFileSync(process.env['BENCH_OUT'], `${lines.join('\n')}\n`);
    console.log(lines.join('\n'));
    expect(lines.length).toBeGreaterThan(0);
  });
});
