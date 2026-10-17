import { describe, expect, it } from 'vitest';
import type { InstancedBufferGeometry, InterleavedBufferAttribute } from 'three';

import { BOX_INSTANCE, isBoxMass } from '@render/buildings/cellArrays';
import { type FarCache, runFarJob } from '@render/buildings/farTiles';
import { createBuildingKit } from '@render/buildings/kit';
import { boxesMesh, unitBox } from '@render/buildings/massBoxes';
import { BOX_FLOATS } from '@render/buildings/massing';

/** A BOX LEVEL'S BOXES ARE INSTANCES OF ONE BOX: EVERY VERTEX THE SHADER LAYS IS THE ONE THE BOXES' MESH OF MASSES LAID (`massBoxes.ts`, `massingMaterial.ts` `boxes`) */

/** The boxes' mesh as it was laid, vertex by vertex (`farTiles.ts` before the instances): position, normal, colour, facade, glazing. */
function laidBefore(boxes: Float32Array): number[][] {
  const out: number[][] = [];
  for (let o = 0; o < boxes.length; o += BOX_FLOATS) {
    const cx = boxes[o]!, cy = boxes[o + 1]!, hu = boxes[o + 2]!, hv = boxes[o + 3]!, turn = boxes[o + 4]!;
    const foot = boxes[o + 5]!, top = boxes[o + 6]!, floor = boxes[o + 7]!, bay = boxes[o + 14]!, storey = boxes[o + 15]!, share = boxes[o + 16]!, seed = boxes[o + 17]!;
    const ux = Math.cos(turn), uy = Math.sin(turn);
    const xs: number[] = [], ys: number[] = [];
    [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]].forEach(([a, d]) => { xs.push(cx + ux * a! - uy * d!); ys.push(cy + uy * a! + ux * d!); });
    const wall = [boxes[o + 8]!, boxes[o + 9]!, boxes[o + 10]!], roof = [boxes[o + 11]!, boxes[o + 12]!, boxes[o + 13]!];
    for (let side = 0; side < 4; side++) {
      const px = xs[side]!, py = ys[side]!, qx = xs[(side + 1) % 4]!, qy = ys[(side + 1) % 4]!;
      const len = Math.hypot(qx - px, qy - py) || 1;
      const nx = (qy - py) / len, ny = -(qx - px) / len;
      for (const [x, y, z, along] of [[px, py, foot, 0], [qx, qy, foot, len], [qx, qy, top, len], [px, py, top, 0]] as const) {
        out.push([x, z, -y, nx, 0, -ny, ...wall, along, bay, storey, floor, share, seed]);
      }
    }
    for (let n = 0; n < 4; n++) out.push([xs[n]!, top, -ys[n]!, 0, 1, 0, ...roof, 0, 0, 1, 0, 0, seed]);
  }
  return out;
}

/** What the masses' shader lays for a box vertex from its instance (`massingMaterial.ts` `BOX_PARS`, `BOX_LOOK`, the box's `begin_vertex`), in the same numbers. */
function laidByShader(instances: Float32Array, unit: Float32Array): number[][] {
  const out: number[][] = [];
  for (let t = 0; t < instances.length; t += BOX_INSTANCE) {
    const box = instances.subarray(t, t + BOX_INSTANCE);
    const c = Math.cos(box[4]!), s = Math.sin(box[4]!);
    const turn = (x: number, y: number): [number, number] => [c * x - s * y, s * x + c * y];
    for (let v = 0; v < unit.length; v += 4) {
      const corner = Math.round(unit[v]!), up = unit[v + 1]!, face = Math.round(unit[v + 2]!), end = unit[v + 3]!;
      const toward = [[-1, -1], [1, -1], [1, 1], [-1, 1]][corner]!;
      const [dx, dy] = turn(toward[0]! * box[2]!, toward[1]! * box[3]!);
      const x = box[0]! + dx, y = box[1]! + dy, z = box[5]! + (box[6]! - box[5]!) * up;
      const n = face === 4 ? [0, 1, 0] : (() => { const [a, b] = turn(...([[0, -1], [1, 0], [0, 1], [-1, 0]][face] as [number, number])); return [a, 0, -b]; })();
      const side = face === 0 || face === 2 ? 2 * box[2]! : 2 * box[3]!;
      const colour = face === 4 ? [box[12]!, box[13]!, box[14]!] : [box[8]!, box[9]!, box[10]!];
      const facade = face === 4 ? [0, 0, 1, 0] : [end * side, box[11]!, box[15]!, box[7]!];
      out.push([x, z, -y, ...n, ...colour, ...facade, face === 4 ? 0 : box[16]!, box[17]!]);
    }
  }
  return out;
}

/** Two boxes the far levels' bake makes: one turned, of its own colours and glazing. */
function boxes(): Float32Array {
  const out = new Float32Array(2 * BOX_FLOATS);
  out.set([1200, 3400, 30, 25, 0, 2, 31, 2.5, 0.6, 0.55, 0.5, 0.3, 0.28, 0.25, 3, 3.1, 0.5, 0.731, 220], 0);
  out.set([1300, 3300, 40, 20, 0.4, -1, 55, -0.5, 0.2, 0.25, 0.3, 0.4, 0.4, 0.41, 2.8, 3.4, 0.75, 2.125, 120], BOX_FLOATS);
  return out;
}

describe('a box level\'s boxes', () => {
  it('lay every vertex the boxes\' mesh of masses laid, from their instance alone', () => {
    const before = laidBefore(boxes());
    // The bake's instances: the same numbers, `BOX_INSTANCE` a box (`farTiles.ts` `boxMass`), laid at a level of its own.
    const cache: FarCache = { ready: async () => true, get: async (key) => (key.endsWith('#boxes') ? { sig: 'c', boxes: boxes() } : undefined), put: async () => {} };
    return runFarJob({ far: true, node: 'f2:0,0', sig: 'n', want: true, prefix: 'test:', children: [{ key: 'f1:0,0', sig: 'c' }, null, null, null] }, cache).then((reply) => {
      if (reply.kind !== 'far' || !reply.mass || !isBoxMass(reply.mass)) throw new Error('no boxes');
      const mass = reply.mass;
      expect(mass.boxes.length).toBeGreaterThan(0);
      const unit = unitBox().getAttribute('boxVertex').array as Float32Array;
      const shader = laidByShader(mass.boxes, unit);
      // The level's boxes are the boxes merged to its error (`aggregateBoxes`); these two stand alone, each larger than its square.
      expect(shader.length).toBe(before.length);
      shader.forEach((row, i) => row.forEach((x, k) => expect(x, `vertex ${i}, number ${k}`).toBeCloseTo(before[i]![k]!, 4)));
      // Its box and top: the boxes' corners and highest top.
      expect(mass.top).toBe(55);
      expect(mass.boxes.byteLength / (mass.boxes.length / BOX_INSTANCE)).toBe(BOX_INSTANCE * 4);
    });
  });

  it('are one mesh of the kit\'s unit box, each box an instance of its numbers', () => {
    const kit = createBuildingKit();
    const instances = new Float32Array(3 * BOX_INSTANCE).map((_, i) => i * 0.5);
    const bounds = Float64Array.of(0, 0, 0, 10, 10, 10, 5, 5, 5, 9);
    const mesh = boxesMesh({ boxes: instances, bounds, top: 10, error: 4 }, kit);
    const g = mesh.geometry as InstancedBufferGeometry;
    expect(g.instanceCount).toBe(3);
    expect(g.index).toBe(kit.massBox.index);
    expect(g.getAttribute('boxVertex')).toBe(kit.massBox.getAttribute('boxVertex'));
    for (const [name, size, offset] of [['boxA', 4, 0], ['boxB', 4, 4], ['boxC', 4, 8], ['boxD', 4, 12], ['boxE', 2, 16]] as const) {
      const a = g.getAttribute(name) as InterleavedBufferAttribute;
      expect(a.itemSize).toBe(size);
      expect(a.offset).toBe(offset);
      expect(a.data.stride).toBe(BOX_INSTANCE);
    }
    expect(mesh.material).toBe(kit.massingBoxes);
    expect(mesh.customDepthMaterial).toBe(kit.massBoxDepth);
    // The unit box: 20 vertices, 30 indices, for every box of every level.
    expect(kit.massBox.getAttribute('boxVertex').count).toBe(20);
    expect(kit.massBox.index!.count).toBe(30);
    kit.dispose();
  });
});
