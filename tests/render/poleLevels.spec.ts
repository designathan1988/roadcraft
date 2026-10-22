import { describe, expect, it } from 'vitest';
import { type InstancedBufferGeometry, type InstancedMesh, type Mesh, type Object3D, PerspectiveCamera } from 'three';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { createSceneryKit } from '@render/scenery';
import { buildUtilities } from '@render/poleLayer';
import { WIRE_FADE, WIRE_WIDTH, wireLevel } from '@render/utilities';
import { m } from '@world/units';

/** THE POLE LAYER AS THE CAMERA SEES IT: one mesh a part a block of the plane (not a world cell, not the whole layer), each block by its own nearest pole: pieces under a pixel not drawn, wires coarser and gone far away */

/** Two lines of poles in cells a kilometre apart. */
function twoLines(): RoadDoc {
  const doc = new RoadDoc();
  for (const y of [0, m(1000)]) {
    const ids = Array.from({ length: 5 }, (_, i) => doc.addPole({ x: m(20) + i * m(30), y }, i % 2 === 0).id);
    for (let i = 1; i < ids.length; i++) doc.addPoleSpan(ids[i - 1]!, ids[i]!);
  }
  return doc;
}

/** A camera at (x, y) in world terms, `height` up, looking at the near line; three's z is world -y. */
function camera(height: number): PerspectiveCamera {
  const c = new PerspectiveCamera(35, 16 / 9, 0.1, 20_000);
  c.position.set(m(80), height, m(40));
  c.lookAt(m(80), 0, 0);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

/** The meshes of a name, nearest line first (by their bounds' world y). */
function named(root: Object3D, name: string): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => { if (o.name === name) out.push(o as Mesh); });
  const y = (o: Mesh): number => -((o as InstancedMesh).boundingSphere ?? o.geometry.boundingSphere)!.center.z;
  return out.sort((a, b) => y(a) - y(b));
}

/** Whether the colour pass draws a mesh: shown, and an instanced part with instances to draw (a part under a pixel keeps its instances for the sun's cascades and draws none in colour, `poleLayer.ts` PartStore). */
const drawn = (mesh: Mesh): boolean => mesh.visible && (!(mesh as InstancedMesh).isInstancedMesh || (mesh as InstancedMesh).count > 0);

describe('the pole layer as the camera sees it', () => {
  it('draws each block by its own nearest pole: every piece near, the small ones gone and the wires faded far away', () => {
    const doc = twoLines();
    const net = new Network(doc);
    net.rebuild();
    const kit = createSceneryKit();
    const layer = buildUtilities(net, () => 0, kit);
    // A mesh a part a block of the plane: the two lines a kilometre apart stand in two (one mesh a part for the whole layer was never culled, and drew every wire of a city at its nearest pole's detail, 2026-10-20).
    expect(named(layer.group, 'utility-insulators')).toHaveLength(2);
    expect(named(layer.group, 'utility-wires')).toHaveLength(2);

    layer.group.update(camera(m(20)));
    const [nearInsulators, farInsulators] = named(layer.group, 'utility-insulators');
    expect(drawn(nearInsulators!)).toBe(true);
    // The line a kilometre off, by its own nearest pole: its insulators under a pixel, not drawn.
    expect(drawn(farInsulators!)).toBe(false);
    const [wires, farWires] = named(layer.group, 'utility-wires');
    // Near, the tube over every span of the near line; the far line's wires by a coarser template, their own.
    expect(drawn(wires!)).toBe(true);
    expect((wires!.geometry as InstancedBufferGeometry).index!.count).toBe(8 * 24);
    expect((wires!.geometry as InstancedBufferGeometry).instanceCount).toBe(9 * 4);
    expect((farWires!.geometry as InstancedBufferGeometry).index!.count).toBeLessThan(8 * 24);
    // Near, the finest mast.
    const masts = named(layer.group, 'utility-poles')[0]!;
    expect(drawn(masts)).toBe(true);
    expect(masts.geometry.index!.count).toBeGreaterThan(0);

    // From far up, everything small gone, the wires faded out, the light the lamps throw still there.
    layer.group.update(camera(m(12_000)));
    for (const name of ['utility-insulators', 'utility-caps', 'utility-wires', 'utility-lamp-lenses']) {
      for (const mesh of named(layer.group, name)) expect(drawn(mesh)).toBe(false);
    }
    for (const mesh of named(layer.group, 'utility-lamp-pools')) expect(drawn(mesh)).toBe(true);
    // A lens lit at night is seen smaller than an unlit one: by its coverage times its brightness.
    layer.group.update(camera(m(1400)));
    const byDay = named(layer.group, 'utility-lamp-lenses').map(drawn);
    kit.setNight(1);
    layer.group.update(camera(m(1400)));
    const atNight = named(layer.group, 'utility-lamp-lenses').map(drawn);
    // The near line's lenses.
    expect(byDay[0]).toBe(false);
    expect(atNight[0]).toBe(true);
    kit.setNight(0);
    // Back close: drawn again.
    layer.group.update(camera(m(20)));
    expect(drawn(named(layer.group, 'utility-insulators')[0]!)).toBe(true);
    layer.dispose();
  });

  it('picks the wires\' template by their width and sag on the screen', () => {
    // Wider than a pixel and a half: the tube.
    expect(wireLevel(2 / WIRE_WIDTH, m(1))).toBe(0);
    // Under the fade: none.
    expect(wireLevel((WIRE_FADE[1] * 0.9) / WIRE_WIDTH, m(1))).toBe(-1);
    // Thin: as few chords as keep the sag's error under a pixel.
    const thin = 0.5 / WIRE_WIDTH;
    const level = wireLevel(thin, m(1));
    expect(level).toBeGreaterThan(0);
    expect(wireLevel(thin, m(0.01))).toBeGreaterThanOrEqual(level);
  });
});
