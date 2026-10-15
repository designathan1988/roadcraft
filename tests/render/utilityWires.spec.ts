import { describe, expect, it } from 'vitest';
import type { InstancedBufferGeometry, InterleavedBufferAttribute, Mesh } from 'three';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { POLE_ARM_DROP, POLE_ARM_HALF, POLE_HEIGHT, WIRE_COURSES, WIRE_OFFSETS, WIRE_SEGMENTS, poleArms } from '@world/utilities';
import { sampleWire } from '../world/oracle/sampleWire';
import { createSceneryKit } from '@render/scenery';
import { buildUtilities } from '@render/poleLayer';
import { m } from '@world/units';

/**
 * THE POLE LAYER'S WIRES AS INSTANCES: each wire is eight numbers - its ends
 * in three's axes, its sag and its phase - drawn from one tube template the
 * vertex shader bends along the wire (`render/utilities.ts` `WIRE_GLSL`). The
 * instances must lay every wire where `sampleWire` lays it, the way the tubes
 * were built on the CPU before; the tube round each point is the shader's
 * (seen in the game).
 */
function line(doc: RoadDoc, n: number, y: number): void {
  const ids = Array.from({ length: n }, (_, i) => doc.addPole({ x: i * m(30), y: y + (i % 2) * m(2) }, i % 2 === 0).id);
  for (let i = 1; i < n; i++) doc.addPoleSpan(ids[i - 1]!, ids[i]!);
}

/** The wire's point at t from its instance, as the shader takes it (`wireAt`). */
function wireAt(data: ArrayLike<number>, w: number, t: number): [number, number, number] {
  const o = w * 8, u = t * 2 - 1, drop = data[o + 6]! * (1 - u * u);
  return [data[o]! + (data[o + 3]! - data[o]!) * t, data[o + 1]! + (data[o + 4]! - data[o + 1]!) * t - drop, data[o + 2]! + (data[o + 5]! - data[o + 2]!) * t];
}

describe('the pole layer\'s wires as instances', () => {
  it('lay every wire where sampleWire lays it, eight numbers a wire', () => {
    const doc = new RoadDoc();
    line(doc, 6, 0);
    line(doc, 4, m(80));
    const net = new Network(doc);
    net.rebuild();
    const layer = buildUtilities(net, () => 0, createSceneryKit());
    const wires = layer.group.getObjectByName('utility-wires') as Mesh;
    const geometry = wires.geometry as InstancedBufferGeometry;
    // The template: one wire's tube, whatever the number of wires.
    expect(geometry.getAttribute('position').count).toBe(WIRE_SEGMENTS * 24);
    const start = geometry.getAttribute('aStart') as InterleavedBufferAttribute;
    const data = start.data.array as Float32Array;
    expect(start.data.stride).toBe(8);
    const crown = POLE_HEIGHT;
    const framing = poleArms(doc.poles, doc.poleSpans, () => ({ x: 0, y: 1 }));
    let w = 0, worst = 0;
    for (const span of doc.poleSpans.values()) {
      const pa = doc.poles.get(span.a)!, pb = doc.poles.get(span.b)!;
      const armA = framing.get(pa.id)?.bySpan.get(span.id) ?? { x: 0, y: 1 };
      const armB = framing.get(pb.id)?.bySpan.get(span.id) ?? { x: 0, y: 1 };
      for (const course of WIRE_COURSES) {
        for (const offset of WIRE_OFFSETS) {
          const points = sampleWire(
            pa.x + armA.x * POLE_ARM_HALF * offset, pa.y + armA.y * POLE_ARM_HALF * offset, crown - POLE_ARM_DROP + course,
            pb.x + armB.x * POLE_ARM_HALF * offset, pb.y + armB.y * POLE_ARM_HALF * offset, crown - POLE_ARM_DROP + course,
          );
          points.forEach((p, i) => {
            const [x, y, z] = wireAt(data, w, i / WIRE_SEGMENTS);
            worst = Math.max(worst, Math.abs(x - p.x), Math.abs(y - p.z), Math.abs(z + p.y));
          });
          expect(data[w * 8 + 7]).toBeCloseTo((span.id * 2.399) % (Math.PI * 2), 5);
          w++;
        }
      }
    }
    expect(geometry.instanceCount).toBe(w);
    expect(w).toBe(doc.poleSpans.size * WIRE_COURSES.length * WIRE_OFFSETS.length);
    // Float32 storage of the same numbers.
    expect(worst).toBeLessThan(1e-4);
    // The bounds hold every wire, sag and all.
    const sphere = geometry.boundingSphere!;
    for (let k = 0; k < w; k++) {
      for (const t of [0, 0.5, 1]) {
        const [x, y, z] = wireAt(data, k, t);
        expect(Math.hypot(x - sphere.center.x, y - sphere.center.y, z - sphere.center.z)).toBeLessThanOrEqual(sphere.radius);
      }
    }
    layer.dispose();
  });
});
