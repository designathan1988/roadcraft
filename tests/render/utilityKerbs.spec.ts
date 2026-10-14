import { describe, expect, it } from 'vitest';
import type { InstancedMesh } from 'three';
import { Network } from '@world/network';
import { applyLots, planLots } from '@world/lots';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { greenCity, layCity, widenCityFootways } from '@editor/cityGenerator';
import { createSceneryKit } from '@render/scenery';
import { type KerbCache, buildUtilities } from '@render/utilities';
import { m } from '@world/units';

/**
 * THE POLES' WAYS TO THE KERB KEPT FROM BUILD TO BUILD (`KerbCache`): every
 * rebuild of the pole layer asked `kerbward` three times for every pole of
 * the map. Kept by pole while it stands where it stood and the roads are the
 * same, the layer is the picture the layer made whole draws.
 */
function matrices(layer: ReturnType<typeof buildUtilities>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  layer.group.traverse((o) => {
    const mesh = o as InstancedMesh;
    if (mesh.isInstancedMesh) out.set(mesh.name, [...(mesh.instanceMatrix.array as Float32Array)]);
  });
  return out;
}

describe('the poles\' ways to the kerb kept', () => {
  it('draw the layer made whole, and follow a pole moved', () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, size: 'small' }));
    widenCityFootways(doc);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    greenCity(doc, net, DEFAULT_CITY.seed);
    if (net.revision !== doc.revision) net.rebuild();
    expect(doc.poles.size).toBeGreaterThan(50);
    const kit = createSceneryKit();
    const ground = (): number => 0;
    const whole = (): Map<string, number[]> => {
      const layer = buildUtilities(net, ground, kit);
      const out = matrices(layer);
      layer.dispose();
      return out;
    };
    const kerbs: KerbCache = new Map();
    const kept = (): Map<string, number[]> => {
      const layer = buildUtilities(net, ground, kit, undefined, 'utilities', kerbs);
      const out = matrices(layer);
      layer.dispose();
      return out;
    };
    expect(kept()).toEqual(whole());
    expect(kerbs.size).toBe(doc.poles.size);
    // Every way read from the cache now.
    expect(kept()).toEqual(whole());
    // A lamp pole carried across its street: its way to the kerb read again.
    const pole = [...doc.poles.values()].find((p) => p.lamp)!;
    const before = kerbs.get(pole.id)!.dir;
    pole.x += m(9);
    const after = kept();
    expect(after).toEqual(whole());
    expect(kerbs.get(pole.id)!.x).toBe(pole.x);
    expect(before).not.toBeUndefined();
    // A pole taken away is let go.
    doc.removePole(pole.id);
    kept();
    expect(kerbs.has(pole.id)).toBe(false);
  });
});
