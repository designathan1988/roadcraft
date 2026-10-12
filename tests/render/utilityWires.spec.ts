import { describe, expect, it } from 'vitest';
import { BufferAttribute, Vector3 } from 'three';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { POLE_ARM_DROP, POLE_ARM_HALF, WIRE_COURSES, WIRE_OFFSETS, poleArms, sampleWire, POLE_HEIGHT } from '@world/utilities';
import { createSceneryKit } from '@render/scenery';
import { buildUtilities, type WireChunk } from '@render/utilities';
import { m } from '@world/units';

/**
 * THE POLE LAYER'S WIRES KEPT BY SPAN (docs/PROBLEMAS.md PL45): each span's
 * tubes are made once and kept while its ends stand as they did; the layer
 * is the same picture as the one made whole every time, and an edit makes
 * again only the spans it moved.
 */
const WIRE_RADIUS = m(0.035);

/** The wires as the layer made them before the spans were kept: the same tubes, by Vector3. */
function wiresWhole(doc: RoadDoc, ground: number): number[] {
  const crown = new Map([...doc.poles.values()].map((p) => [p.id, ground + POLE_HEIGHT] as const));
  const framing = poleArms(doc.poles, doc.poleSpans, () => ({ x: 0, y: 1 }));
  const pos: number[] = [];
  const a = new Vector3(), b2 = new Vector3(), d = new Vector3(), u = new Vector3(), w = new Vector3(), up = new Vector3(0, 1, 0);
  for (const span of doc.poleSpans.values()) {
    const pa = doc.poles.get(span.a)!, pb = doc.poles.get(span.b)!;
    const armA = framing.get(pa.id)?.bySpan.get(span.id) ?? { x: 0, y: 1 };
    const armB = framing.get(pb.id)?.bySpan.get(span.id) ?? { x: 0, y: 1 };
    for (const course of WIRE_COURSES) {
      for (const offset of WIRE_OFFSETS) {
        const points = sampleWire(
          pa.x + armA.x * POLE_ARM_HALF * offset, pa.y + armA.y * POLE_ARM_HALF * offset, crown.get(pa.id)! - POLE_ARM_DROP + course,
          pb.x + armB.x * POLE_ARM_HALF * offset, pb.y + armB.y * POLE_ARM_HALF * offset, crown.get(pb.id)! - POLE_ARM_DROP + course,
        );
        for (let i = 0; i + 1 < points.length; i++) {
          const p = points[i]!, q = points[i + 1]!;
          a.set(p.x, p.z, -p.y);
          b2.set(q.x, q.z, -q.y);
          d.copy(b2).sub(a).normalize();
          u.crossVectors(d, up).normalize().multiplyScalar(WIRE_RADIUS);
          w.crossVectors(u, d).normalize().multiplyScalar(WIRE_RADIUS);
          const corners = [u.clone(), w.clone(), u.clone().negate(), w.clone().negate()];
          for (let k = 0; k < 4; k++) {
            const c0 = corners[k]!, c1 = corners[(k + 1) % 4]!;
            for (const [p0, c] of [[a, c0], [b2, c0], [b2, c1], [a, c0], [b2, c1], [a, c1]] as const) pos.push(p0.x + c.x, p0.y + c.y, p0.z + c.z);
          }
        }
      }
    }
  }
  return pos;
}

function line(doc: RoadDoc, n: number, y: number): void {
  const ids = Array.from({ length: n }, (_, i) => doc.addPole({ x: i * m(30), y: y + (i % 2) * m(2) }, i % 2 === 0).id);
  for (let i = 1; i < n; i++) doc.addPoleSpan(ids[i - 1]!, ids[i]!);
}

describe('the pole layer\'s wires kept by span', () => {
  it('draw the same tubes as the layer made whole', () => {
    const doc = new RoadDoc();
    line(doc, 6, 0);
    line(doc, 4, m(80));
    const net = new Network(doc);
    net.rebuild();
    const layer = buildUtilities(net, () => 0, createSceneryKit(), undefined, 'utilities', new Map());
    const wires = layer.group.getObjectByName('utility-wires')!;
    const got = ((wires as unknown as { geometry: { getAttribute(n: string): BufferAttribute } }).geometry.getAttribute('position').array);
    const want = wiresWhole(doc, 0);
    expect(got.length).toBe(want.length);
    let worst = 0;
    for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(got[i]! - want[i]!));
    // Float32 storage of the same numbers.
    expect(worst).toBeLessThan(1e-4);
    layer.dispose();
  });

  it('make again only the spans an edit moved', () => {
    const doc = new RoadDoc();
    line(doc, 8, 0);
    const net = new Network(doc);
    net.rebuild();
    const cache = new Map<string, WireChunk>();
    const kit = createSceneryKit();
    buildUtilities(net, () => 0, kit, undefined, 'utilities', cache).dispose();
    const before = new Set(cache.values());
    expect(before.size).toBe(7);
    // A pole added at the end, strung to the last: one span more, the others kept.
    const last = [...doc.poles.values()].at(-1)!;
    const extra = doc.addPole({ x: last.x + m(30), y: last.y }, false);
    doc.addPoleSpan(last.id, extra.id);
    buildUtilities(net, () => 0, kit, undefined, 'utilities', cache).dispose();
    const after = [...cache.values()];
    const kept = after.filter((c) => before.has(c)).length;
    // The last old span's far arm turns (its pole now carries two spans): it is made again; the other six are kept.
    expect(after.length).toBe(8);
    expect(kept).toBe(6);
  });
});
