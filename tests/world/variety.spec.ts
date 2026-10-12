import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, lotCentre, planLots, zoneLots } from '@world/lots';
import { bodySignature, madeToMeasure, signatureDistance } from '@world/buildings/procedural';
import type { Building } from '@world/buildings/types';
import { growOnLot } from '@editor/zoning';
import type { ZoneDensity, ZoneUse } from '@world/zones';

/**
 * Buildings grown on zoned lots do not repeat (the player, 2026-10-09: "the
 * buildings are practically all the same; nothing prevents identical
 * buildings within a large radius"): many forms and paints for one zone,
 * and no two buildings next to each other that look alike.
 */

/** A street of zoned lots, grown to the end; the buildings in the order of the street. */
function grownStreet(use: ZoneUse, density: ZoneDensity): Building[] {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-300), y: 0 }).id, b = doc.addNode({ x: m(300), y: 0 }).id;
  doc.addSegment(a, b, 1);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  zoneLots(doc, doc.lots.map((l) => l.id), { use, density });
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  return doc.lots.filter((l) => l.building !== undefined)
    .sort((p, q) => lotCentre(p).y - lotCentre(q).y || lotCentre(p).x - lotCentre(q).x)
    .map((l) => doc.buildings.get(l.building as Building['id'])!).filter(Boolean);
}

describe('variety of grown buildings', () => {
  it('draws many forms and paints for one zone', () => {
    const rng = new Rng(11);
    const forms = new Set<string>(), colours = new Set<number>();
    for (let k = 0; k < 60; k++) {
      const made = madeToMeasure('residential', 'low', { W: 14, D: 14, driveSide: 'left' }, rng);
      forms.add(made.signature.form);
      colours.add(made.signature.colour);
    }
    expect(forms.size).toBeGreaterThanOrEqual(5);
    expect(colours.size).toBeGreaterThanOrEqual(50);
  });

  for (const [use, density] of [['residential', 'low'], ['residential', 'medium'], ['commercial', 'low']] as const) {
    it(`puts no look-alikes side by side: ${use} ${density}`, () => {
      const street = grownStreet(use, density);
      expect(street.length).toBeGreaterThan(12);
      const sig = street.map((b) => bodySignature(b));
      // Next-door neighbours: each building and the nearest other one, on the next lot.
      let twins = 0, pairs = 0;
      for (let i = 0; i < street.length; i++) {
        let j = -1, best = m(32);
        for (let k = 0; k < street.length; k++) {
          const d = Math.hypot(street[i]!.x - street[k]!.x, street[i]!.y - street[k]!.y);
          if (k !== i && d < best) { best = d; j = k; }
        }
        if (j < 0) continue;
        pairs++;
        if (signatureDistance(sig[i]!, sig[j]!) < 1.2) twins++;
      }
      console.log(`VARIEDADE ${use} ${density}: ${street.length} prédios, ${twins}/${pairs} vizinhos parecidos, formas ${new Set(sig.map((s) => s.form)).size}, cores ${new Set(sig.map((s) => s.colour)).size}`);
      expect(twins, `${twins} look-alike pairs of ${pairs}`).toBe(0);
      // Within 100 m, few buildings share both form and paint with another.
      let alike = 0;
      for (let i = 0; i < street.length; i++) {
        for (let j = 0; j < street.length; j++) {
          if (i === j || Math.hypot(street[i]!.x - street[j]!.x, street[i]!.y - street[j]!.y) > m(100)) continue;
          if (sig[i]!.form === sig[j]!.form && signatureDistance(sig[i]!, sig[j]!) < 2.2) { alike++; break; }
        }
      }
      console.log(`GÊMEOS ${use} ${density}: ${alike} de ${street.length} com um quase igual a menos de 100 m`);
      expect(alike / street.length, `${alike} of ${street.length} with a near twin within 100 m`).toBeLessThan(0.15);
    }, 120_000);
  }
});
