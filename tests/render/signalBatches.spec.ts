import { describe, expect, it } from 'vitest';
import { Color, InstancedMesh, Scene, type InstancedBufferAttribute } from 'three';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { commitPedestrianCrossing } from '@editor/streetObjects';
import { createSignalHeads } from '@render/signals';
import type { SignalFeed } from '@sim/host/simClient';
import type { SignalLayout } from '@sim/host/protocol';
import type { SignalState } from '@sim/signals/query';
import type { NodeId, SegmentId } from '@world/ids';

/** A signal crossing on a straight street: one junction, two approaches, a head on each. */
function crossing() {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -250, y: 0 }, 1), b = doc.addNode({ x: 250, y: 0 }, 3);
  const segment = doc.addSegment(a.id, b.id, 1, null, 17, 'both', 2, 'ground',
    { laneWidth: 9, sidewalk: 7, median: 0, speedKmh: 30, priority: 1 })!;
  const net = new Network(doc);
  net.rebuild();
  const result = commitPedestrianCrossing(doc, net, segment.id, 'signal');
  if (!result.committed) throw new Error('crossing refused');
  net.rebuild();
  return { net, node: result.node, segments: result.segments };
}

function feedOf(node: NodeId, segments: readonly SegmentId[], states: SignalState[]): SignalFeed {
  const layout = { groups: segments.map((s, i) => ({ id: i, segments: [s] })) } as unknown as SignalLayout;
  return {
    changesSince: () => ({ serial: 1, nodes: null }),
    layout: (n) => (n === node ? layout : undefined),
    state: (_n, group) => states[group]!,
    stage: () => states.join(),
    nodes: () => [node],
  };
}

describe('signal heads batched over the map', () => {
  it('draws two junctions apart with four batches a block of the plane: frame, visors, every lens, halos', () => {
    const doc = new RoadDoc();
    const layouts = new Map<NodeId, SignalLayout>();
    const all: SegmentId[] = [];
    for (const y of [0, 1000]) {
      const a = doc.addNode({ x: -250, y }, 1), b = doc.addNode({ x: 250, y }, 3);
      all.push(doc.addSegment(a.id, b.id, 1, null, 17, 'both', 2, 'ground',
        { laneWidth: 9, sidewalk: 7, median: 0, speedKmh: 30, priority: 1 })!.id);
    }
    let net = new Network(doc);
    net.rebuild();
    for (const id of all) {
      const result = commitPedestrianCrossing(doc, net, id, 'signal');
      if (!result.committed) throw new Error('crossing refused');
      layouts.set(result.node, { groups: result.segments.map((s, g) => ({ id: g, segments: [s] })) } as unknown as SignalLayout);
      net = new Network(doc);
      net.rebuild();
    }
    net = new Network(doc);
    net.rebuild();
    const feed: SignalFeed = {
      changesSince: () => ({ serial: 1, nodes: null }),
      layout: (n) => layouts.get(n),
      state: (_n, group) => (group === 0 ? 'green' : 'red'),
      stage: (n) => `${n}`,
      nodes: () => [...layouts.keys()],
    };
    const heads = createSignalHeads(new Scene());
    heads.sync(feed, net, true);
    const meshes = heads.group.children.filter((c): c is InstancedMesh => c instanceof InstancedMesh);
    // The four kinds in each block their heads stand in (one batch a kind for the town was never culled, 2026-10-20).
    const names = meshes.map((m) => m.name);
    expect([...new Set(names)].sort()).toEqual(['signal-frame', 'signal-halos', 'signal-lenses', 'signal-visors']);
    const blocks = names.filter((name) => name === 'signal-frame').length;
    expect(blocks).toBeGreaterThanOrEqual(1);
    expect(blocks).toBeLessThanOrEqual(2);
    expect(meshes).toHaveLength(blocks * 4);
    const count = (name: string): number => meshes.filter((m) => m.name === name).reduce((sum, m) => sum + m.count, 0);
    const n = layouts.size * 2;
    expect(count('signal-frame')).toBe(n);
    expect(count('signal-visors')).toBe(n * 6);
    expect(count('signal-lenses')).toBe(n * 6);
    expect(count('signal-halos')).toBe(n * 2);
    expect(heads.group.userData.litLamps).toBe(n * 2);
    heads.dispose();
  });

  it('draws a cell with four meshes: frame, visors, every lens, halos', () => {
    const { net, node, segments } = crossing();
    const heads = createSignalHeads(new Scene());
    heads.sync(feedOf(node, segments, ['green', 'red']), net, true);
    const meshes = heads.group.children.filter((c): c is InstancedMesh => c instanceof InstancedMesh);
    // Before: posts, arms, boxes, visors, lit, halos, red, amber, green (nine a cell).
    expect(meshes.map((m) => m.name).sort()).toEqual(['signal-frame', 'signal-halos', 'signal-lenses', 'signal-visors']);
    const by = Object.fromEntries(meshes.map((m) => [m.name, m]));
    const n = segments.length;
    expect(by['signal-frame']!.count).toBe(n);
    expect(by['signal-visors']!.count).toBe(n * 6);
    expect(by['signal-lenses']!.count).toBe(n * 6);
    // One lit lamp a head, on both faces.
    expect(by['signal-halos']!.count).toBe(n * 2);
    expect(heads.group.userData.litLamps).toBe(n * 2);
    heads.dispose();
  });

  it('paints each lens as its own mesh did: lit in its pure colour, the dark ones with their filter and glow', () => {
    const { net, node, segments } = crossing();
    const heads = createSignalHeads(new Scene());
    heads.sync(feedOf(node, segments, ['green', 'red']), net, true);
    const lenses = heads.group.children.find((c) => c.name === 'signal-lenses') as InstancedMesh;
    const glows = lenses.geometry.getAttribute('aLensGlow') as InstancedBufferAttribute;
    const lit = new Set(['3bf06a', 'ff4034'].map((h) => new Color(`#${h}`).getHexString()));
    const dark: Record<string, string> = { '8d221c': '2a0705', '8a6410': '281c04', '1d6b33': '07230f' };
    const colour = new Color();
    let litCount = 0;
    for (let i = 0; i < lenses.count; i++) {
      lenses.getColorAt(i, colour);
      const hex = colour.getHexString();
      if (glows.getW(i) === 1) {
        litCount++;
        expect(lit.has(hex)).toBe(true);
        expect([glows.getX(i), glows.getY(i), glows.getZ(i)]).toEqual([0, 0, 0]);
      } else {
        expect(glows.getW(i)).toBe(0);
        expect(Object.keys(dark)).toContain(hex);
        expect(new Color(glows.getX(i), glows.getY(i), glows.getZ(i)).getHexString()).toBe(dark[hex]);
      }
    }
    expect(litCount).toBe(segments.length * 2);
    heads.dispose();
  });

  it('keeps the frame as post, arm and housing, each swaying from its own foot', () => {
    const { net, node, segments } = crossing();
    const heads = createSignalHeads(new Scene());
    heads.sync(feedOf(node, segments, ['green', 'red']), net, true);
    const frame = heads.group.children.find((c) => c.name === 'signal-frame') as InstancedMesh;
    const sway = frame.geometry.getAttribute('aSwayPart');
    const feet = new Set<string>();
    for (let i = 0; i < sway.count; i++) feet.add(`${sway.getX(i).toFixed(3)},${sway.getY(i).toFixed(3)},${sway.getW(i).toFixed(3)}`);
    // The post's centre (half its height), the arm's (out along it, 0.3 m under the top), the housing's (at the arm's end): three parts.
    expect(feet.size).toBe(3);
    heads.dispose();
  });
});
