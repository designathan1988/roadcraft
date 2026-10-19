import { describe, expect, it } from 'vitest';

import { History, followNetwork } from '@editor/history';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { generateBody } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { Rng } from '@core/rng';

function city(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: 0, y: 0 });
  const b = doc.addNode({ x: 200, y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/** Undo puts back the records an edit changed. */
describe('undo', () => {
  it('of a building edit leaves the road revisions, and the network, alone', () => {
    const { doc, net } = city();
    const history = new History();
    history.begin(doc);
    doc.buildings.add({ ...generateBody('residential', 30, 30, 2), x: 0, y: 80, rotation: 0 } as unknown as Building);
    const roads = doc.revision;
    const traffic = doc.trafficRevision;
    const built = net.revision;

    expect(history.undo(doc)).toBe(true);
    followNetwork(doc, net);
    expect(doc.buildings.size).toBe(0);
    expect(doc.revision).toBe(roads);
    expect(doc.trafficRevision).toBe(traffic);
    expect(net.revision).toBe(built);
  });

  it('of a road edit moves the revisions and rebuilds', () => {
    const { doc, net } = city();
    const history = new History();
    history.begin(doc);
    const c = doc.addNode({ x: 200, y: 200 });
    doc.addSegment([...doc.nodes.keys()][1]!, c.id, 1);
    net.rebuild();
    const roads = doc.revision;

    history.undo(doc);
    followNetwork(doc, net);
    expect(doc.segments.size).toBe(1);
    expect(doc.revision).toBeGreaterThan(roads);
    expect(net.revision).toBe(doc.revision);
  });

  it('and redo are exact inverses', () => {
    const { doc, net } = city();
    const history = new History();
    const start = JSON.stringify(doc.toJSON());
    history.begin(doc);
    const c = doc.addNode({ x: 100, y: 150 });
    doc.addSegment([...doc.nodes.keys()][0]!, c.id, 2);
    const edited = JSON.stringify(doc.toJSON());
    history.undo(doc);
    followNetwork(doc, net);
    expect(JSON.stringify(doc.toJSON())).toBe(start);
    history.redo(doc);
    followNetwork(doc, net);
    expect(JSON.stringify(doc.toJSON())).toBe(edited);
  });

  it('makes no step of an edit that changed nothing', () => {
    const { doc } = city();
    const history = new History();
    history.begin(doc);
    expect(history.end(doc)).toBe(false);
    history.begin(doc);
    doc.setSegmentLanes([...doc.segments.keys()][0]!, doc.requireSegment([...doc.segments.keys()][0]!).lanes);
    expect(history.end(doc)).toBe(false);
    expect(history.canUndo).toBe(false);
  });

  it('keeps a change made with no edit open, and undoes only the edit after it', () => {
    const { doc } = city();
    const history = new History();
    history.begin(doc);
    history.end(doc);
    // A building grown on its own, then a road drawn.
    doc.buildings.add({ ...generateBody('residential', 30, 30, 2), x: 0, y: 80, rotation: 0 } as unknown as Building);
    history.begin(doc);
    doc.addNode({ x: 0, y: 400 });
    history.end(doc);
    history.undo(doc);
    expect(doc.nodes.size).toBe(2);
    expect(doc.buildings.size).toBe(1);
  });

  it('is exact through random edits of every kind, undone to the start and redone to the end', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rng = new Rng(seed);
      const { doc } = city();
      const history = new History(1000, Infinity);
      const start = JSON.stringify(doc.toJSON());
      let steps = 0;
      for (let k = 0; k < 30; k++) {
        history.begin(doc);
        const nodes = [...doc.nodes.keys()], segments = [...doc.segments.keys()];
        const pick = <T>(xs: T[]): T => xs[Math.floor(rng.float() * xs.length)]!;
        switch (Math.floor(rng.float() * 8)) {
          case 0: { const n = doc.addNode({ x: rng.float() * 2000, y: rng.float() * 2000 }); if (nodes.length) doc.addSegment(pick(nodes), n.id, 1 + Math.floor(rng.float() * 3)); break; }
          case 1: if (segments.length > 1) doc.removeSegment(pick(segments)); break;
          case 2: if (nodes.length) doc.moveNode(pick(nodes), { x: rng.float() * 2000, y: rng.float() * 2000 }); break;
          case 3: if (segments.length) doc.setSegmentLanes(pick(segments), 2 + 2 * Math.floor(rng.float() * 3)); break;
          case 4: doc.addPole({ x: rng.float() * 2000, y: rng.float() * 2000 }, rng.float() < 0.5); break;
          case 5: doc.buildings.add({ ...generateBody('residential', 30, 30, 2), x: rng.float() * 2000, y: rng.float() * 2000, rotation: 0 } as unknown as Building); break;
          case 6: doc.addTerrainStamp({ mode: 'raise', x: rng.float() * 2000, y: rng.float() * 2000, radius: 50, strength: 2 }); break;
          case 7: doc.setWeather({ rain: rng.float() }); break;
        }
        if (history.end(doc)) steps++;
      }
      const end = JSON.stringify(doc.toJSON());
      for (let i = 0; i < steps; i++) expect(history.undo(doc)).toBe(true);
      expect(history.undo(doc)).toBe(false);
      expect(JSON.stringify(doc.toJSON()), `seed ${seed}, undone`).toBe(start);
      for (let i = 0; i < steps; i++) expect(history.redo(doc)).toBe(true);
      expect(JSON.stringify(doc.toJSON()), `seed ${seed}, redone`).toBe(end);
    }
  });
});

describe('the history', () => {
  it('keeps within its byte budget by dropping the oldest steps, the newest kept', () => {
    const { doc } = city();
    const history = new History(60, 20_000);
    for (let i = 0; i < 40; i++) {
      history.begin(doc);
      doc.addNode({ x: i * 10, y: 300 });
      history.end(doc);
    }
    expect(history.bytes).toBeLessThanOrEqual(20_000);
    expect(history.canUndo).toBe(true);
    const nodes = doc.nodes.size;
    history.undo(doc);
    expect(doc.nodes.size).toBe(nodes - 1);
  });

  it('holds a step of one road far smaller than the map', () => {
    const { doc } = city();
    for (let i = 0; i < 300; i++) {
      const a = doc.addNode({ x: i * 30, y: 1000 });
      const b = doc.addNode({ x: i * 30, y: 1200 });
      doc.addSegment(a.id, b.id, 1);
    }
    const history = new History();
    history.begin(doc);
    history.end(doc);
    history.begin(doc);
    const a = doc.addNode({ x: 0, y: 2000 });
    doc.addSegment([...doc.nodes.keys()][0]!, a.id, 1);
    history.end(doc);
    expect(history.bytes).toBeLessThan(JSON.stringify(doc.toJSON()).length / 20);
  });
});

describe('the diary of an undo', () => {
  it('names the poles, spans, landscaping and barriers put back, so what is derived by id redoes only them (`solids.ts`)', () => {
    const { doc } = city();
    const history = new History();
    history.begin(doc);
    const p = doc.addPole({ x: 20, y: 12 }, true), q = doc.addPole({ x: 50, y: 12 }, false);
    const span = doc.addPoleSpan(p.id, q.id);
    history.end(doc);
    const named = (act: () => void, kind: 'utilities' | 'landscape' | 'barriers' = 'utilities'): number[] | null => {
      const from = doc.changes.version;
      act();
      const entries = doc.changes.since(from, [kind])!;
      if (!entries.length || entries.some((e) => !e.ids)) return null;
      return [...new Set(entries.flatMap((e) => e.ids!))].sort((a, b) => a - b);
    };
    const all = [...new Set([p.id, q.id, span!.id])].sort((a, b) => a - b);
    expect(named(() => history.undo(doc))).toEqual(all);
    expect(named(() => history.redo(doc))).toEqual(all);
    history.begin(doc);
    const barrier = doc.addBarrier('fence', [{ x: 10, y: 30 }, { x: 40, y: 30 }]);
    history.end(doc);
    expect(named(() => history.undo(doc), 'barriers')).toEqual([barrier!.id]);
    history.begin(doc);
    const bench = doc.addLandscape('bench', { x: 30, y: 20 });
    history.end(doc);
    expect(named(() => history.undo(doc), 'landscape')).toEqual([bench.id]);
  });
});

/** A LONG ROAD'S PARTS ARE ONE UNDO STEP (`History.grouped`, `RoadTool.layHeld`) */
describe('steps joined into a group', () => {
  it('are undone and redone together', () => {
    const { doc } = city();
    const history = new History();
    const lay = (x: number): void => { history.begin(doc); const a = doc.addNode({ x, y: 500 }), b = doc.addNode({ x: x + 100, y: 500 }); doc.addSegment(a.id, b.id, 1); history.end(doc); };
    lay(1_000);
    history.grouped(7);
    lay(2_000);
    lay(3_000);
    lay(4_000);
    history.grouped(null);
    expect(doc.segments.size).toBe(5);
    // One undo: the three parts; the step before them stays.
    expect(history.undo(doc)).toBe(true);
    expect(doc.segments.size).toBe(2);
    expect(history.redo(doc)).toBe(true);
    expect(doc.segments.size).toBe(5);
  });
});

