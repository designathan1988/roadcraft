import { describe, expect, it } from 'vitest';
import type { InstancedBufferGeometry, InstancedMesh, InterleavedBufferAttribute, Mesh } from 'three';
import { Network } from '@world/network';
import { applyLots, planLots } from '@world/lots';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { greenCity, layCity, widenCityFootways } from '@editor/cityGenerator';
import { createSceneryKit } from '@render/scenery';
import { ActiveTiles } from '@render/activeTiles';
import { type PoleLayer, buildUtilities, docPoles } from '@render/poleLayer';
import type { RoadDoc } from '@world/doc';
import type { PoleId } from '@world/ids';
import { tileKey, tileKeyAt, tileRect } from '@world/tiles';
import { m } from '@world/units';

/** THE POLE LAYER KEPT BY POLE (`render/poleLayer.ts`) */

/** Each part's drawn instances as sorted rows over every cell, and the wires' likewise: the picture, whatever the slots. */
function picture(layer: PoleLayer): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const put = (name: string, rows: string[]): void => { out.set(name, [...(out.get(name) ?? []), ...rows].sort()); };
  layer.group.traverse((o) => {
    const mesh = o as InstancedMesh;
    if (mesh.isInstancedMesh) {
      const a = mesh.instanceMatrix.array as Float32Array;
      const rows: string[] = [];
      for (let i = 0; i < mesh.count; i++) rows.push([...a.subarray(i * 16, i * 16 + 16)].map((v) => v.toFixed(4)).join(','));
      if (rows.length) put(mesh.name, rows);
    } else if ((o as Mesh).isMesh && o.name === 'utility-wires') {
      const geometry = (o as Mesh).geometry as InstancedBufferGeometry;
      const data = (geometry.getAttribute('aStart') as InterleavedBufferAttribute).data.array as Float32Array;
      const rows: string[] = [];
      for (let i = 0; i < geometry.instanceCount; i++) rows.push([...data.subarray(i * 8, i * 8 + 8)].map((v) => v.toFixed(4)).join(','));
      if (rows.length) put(o.name, rows);
    }
  });
  return out;
}

function city(): { doc: RoadDoc; net: Network } {
  const doc = layCity(planCity({ ...DEFAULT_CITY, size: 'small' }));
  widenCityFootways(doc);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  greenCity(doc, net, DEFAULT_CITY.seed);
  if (net.revision !== doc.revision) net.rebuild();
  return { doc, net };
}

describe('the pole layer kept by pole', () => {
  it('draws after each edit what a layer built whole draws, placing again only the poles reached', () => {
    const { doc, net } = city();
    expect(doc.poles.size).toBeGreaterThan(50);
    const kit = createSceneryKit();
    let bump: [number, number, number, number] | null = null;
    const ground = (x: number, y: number): number => (bump && x >= bump[0] && x <= bump[2] && y >= bump[1] && y <= bump[3] ? m(0.5) : 0);
    const layer = buildUtilities(net, ground, kit);
    let serial = doc.changes.serialOf('utilities');
    const whole = (): Map<string, string[]> => {
      const fresh = buildUtilities(net, ground, kit);
      const out = picture(fresh);
      fresh.dispose();
      return out;
    };
    /** The layer brought up to the diary, as the renderer does; how many poles it placed again. */
    const follow = (extra: readonly [number, number, number, number][] = []): number => {
      const entries = doc.changes.since(serial, ['utilities'])!;
      serial = doc.changes.serialOf('utilities');
      const placed = countPlaced(layer, () => layer.follow(net, ground, doc,
        [...entries, ...extra.map((r, i) => ({ serial: -1 - i, kind: 'ground' as const, rects: [r], cause: 'test', at: 0 }))]));
      expect(picture(layer)).toEqual(whole());
      return placed;
    };

    const poles = [...doc.poles.values()];
    const spanned = poles.find((p) => doc.spansAt(p.id).length === 2)!;
    // A pole in the middle of a line taken away: its wires with it, its neighbours framed again.
    doc.removePole(spanned.id);
    expect(follow()).toBeLessThan(12);
    // A new pole strung to an old one.
    const near = poles.find((p) => p.id !== spanned.id && doc.poles.has(p.id))!;
    const added = doc.addPole({ x: near.x + m(20), y: near.y + m(3) }, true);
    doc.addPoleSpan(near.id, added.id);
    expect(follow()).toBeLessThan(12);
    // A run of five new poles.
    const run: PoleId[] = [];
    for (let i = 0; i < 5; i++) run.push(doc.addPole({ x: m(40) + i * m(28), y: m(-300) + (i % 2) * m(4) }, i % 2 === 0).id);
    for (let i = 1; i < run.length; i++) doc.addPoleSpan(run[i - 1]!, run[i]!);
    expect(follow()).toBeLessThan(12);
    // The ground raised under some poles: those within reach placed again on it.
    const lamp = poles.find((p) => p.lamp && doc.poles.has(p.id))!;
    bump = [lamp.x - m(30), lamp.y - m(30), lamp.x + m(30), lamp.y + m(30)];
    follow([bump]);
    // A lamp pole taken away, and everything checked once more.
    doc.removePole(lamp.id);
    follow();
    layer.dispose();
  });

  it('places the poles of the streamed world\'s active tiles and those their wires tie, as a layer built whole, as tiles come and go', () => {
    const { doc, net } = city();
    const kit = createSceneryKit();
    const ground = (): number => 0;
    const shown = new Set([tileKey(0, 0)]);
    const at = (x: number, y: number): boolean => shown.has(tileKeyAt(x, y));
    const active = new ActiveTiles();
    active.set(at, []);
    const moves = active.reader();
    const layer = buildUtilities(net, ground, kit, docPoles(doc, active));
    const whole = (): Map<string, string[]> => {
      const fresh = buildUtilities(net, ground, kit, docPoles(doc, active));
      const out = picture(fresh);
      fresh.dispose();
      return out;
    };
    /** The layer as one built whole, and its poles: those on an active tile, and those a wire ties to one. */
    const check = (label: string): number => {
      expect(picture(layer), label).toEqual(whole());
      const placed = new Set(layer.ids());
      for (const pole of doc.poles.values()) {
        const tied = doc.spansAt(pole.id).some((s) => { const o = doc.poles.get(s.a === pole.id ? s.b : s.a)!; return at(o.x, o.y); });
        expect(placed.has(pole.id), `${label}: pole ${pole.id}`).toBe(at(pole.x, pole.y) || tied);
      }
      return placed.size;
    };
    const first = check('first');
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(doc.poles.size);
    for (const [i, j] of [[-1, 0], [0, 0], [-1, -1], [0, -1], [0, 0]] as const) {
      const key = tileKey(i, j);
      if (shown.has(key)) shown.delete(key); else shown.add(key);
      active.set(at, [tileRect(i, j)]);
      layer.follow(net, ground, doc, moves.entries('utilities')!, docPoles(doc, active));
      check(`${i},${j}`);
    }
    // Every tile round the town active: every pole, as with no streamed world.
    for (let i = -3; i <= 2; i++) for (let j = -3; j <= 2; j++) shown.add(tileKey(i, j));
    active.set(at, [[-3 * m(1024), -3 * m(1024), 3 * m(1024), 3 * m(1024)]]);
    layer.follow(net, ground, doc, moves.entries('utilities')!, docPoles(doc, active));
    expect(check('all')).toBe(doc.poles.size);
    layer.dispose();
  });
});

/** How many poles a call placed (counted through the layer's private `place`). */
function countPlaced(layer: PoleLayer, call: () => void): number {
  const target = layer as unknown as { place: (...args: unknown[]) => void };
  const own = target.place;
  let n = 0;
  target.place = function (this: unknown, ...args: unknown[]) { n++; return own.apply(this, args); };
  try { call(); } finally { target.place = own; }
  return n;
}
