import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { lorryDocks } from '@world/buildings/docks';
import { facadeBays } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import { growOnLot } from '@editor/zoning';
import { FOOTWAY_RISE, Level, halfWidth, roadType } from '@world/roadTypes';

/** A works' loading yard is laid with lorry docks, each square in front of a loading door of the hall */

const flat = (): number => 0;
const paved = (x: number, y: number): number =>
  Math.abs(y) <= halfWidth(roadType(1), Level.Sidewalk) && Math.abs(x) <= m(160) ? FOOTWAY_RISE : NaN;

describe('lorry docks at the loading doors', () => {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-160), y: 0 }).id, b = doc.addNode({ x: m(160), y: 0 }).id;
  doc.addSegment(a, b, 1);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  zoneLots(doc, doc.lots.map((l) => l.id), { use: 'industrial', density: 'low' });
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: flat, pavedAt: paved }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  const all = [...doc.buildings.all()] as Building[];
  const works = all.filter((h) => lorryDocks(h).length > 0);

  it('stands every dock square in front of a loading door, its door end at the wall', () => {
    let docks = 0, atDoor = 0;
    for (const h of works) {
      const doors = facadeBays(h).filter((bay) => bay.component === 'loadingDoor' && bay.level === 0);
      for (const d of lorryDocks(h)) {
        docks++;
        // The loading door the dock's door end stands at: its middle within the lorry's own margin of the dock's
        const hit = doors.find((bay) => Math.hypot(bay.x - d.door.x, bay.y - d.door.y) < m(0.65));
        if (hit) atDoor++;
        expect(Math.hypot(d.open.x - d.door.x, d.open.y - d.door.y)).toBeGreaterThan(m(8));
      }
    }
    console.log(`DOCAS: ${atDoor} de ${docks} diante de uma porta de carga (${works.length} galpões)`);
    expect(works.length).toBeGreaterThan(4);
    expect(atDoor).toBe(docks);
  });
});
