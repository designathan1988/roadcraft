import { describe, expect, it } from 'vitest';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';
import { LEGACY_METERS_PER_UNIT, rescaleSerializedDoc, unitFactor } from '@world/rescale';
import type { Building } from '@world/buildings/types';
import { METERS_PER_UNIT } from '@world/units';
import { normalizeSettings, type SavedSettings } from '@editor/persistence';

/**
 * A map saved in another world unit opens at the same size in metres
 * (docs/ESCALA.md): every map before 2026-10-10 was saved at 0.4 m a unit and
 * says nothing; a map saved now says its unit.
 */
describe('a map saved in another world unit', () => {
  const town = (): SerializedDoc => {
    const doc = new RoadDoc();
    buildDefaultTown(doc);
    return JSON.parse(doc.toText()) as SerializedDoc;
  };

  it('is saved with its unit, and reads back unchanged in the same unit', () => {
    const saved = town();
    expect(saved.unit).toBe(METERS_PER_UNIT);
    expect(RoadDoc.fromJSON(saved, { repair: false }).toText()).toBe(RoadDoc.fromJSON(JSON.parse(JSON.stringify(saved)) as SerializedDoc, { repair: false }).toText());
    expect(rescaleSerializedDoc(saved)).toBe(saved);
  });

  it('without a unit is a 0.4 m map', () => {
    expect(unitFactor(undefined)).toBe(LEGACY_METERS_PER_UNIT / METERS_PER_UNIT);
    expect(unitFactor(METERS_PER_UNIT)).toBe(1);
  });

  it('in a unit twice as long opens at the same size in metres', () => {
    const saved = town();
    // The same town written in a unit of twice the metres: every length
    // halved (the transform itself, told the numbers are in half units).
    const halved = rescaleSerializedDoc({ ...saved, unit: METERS_PER_UNIT / 2 });
    const old = { ...halved, unit: METERS_PER_UNIT * 2 };
    const node = saved.nodes.find((n) => n.x !== 0)!;
    expect(old.nodes.find((n) => n.id === node.id)!.x).toBe(node.x / 2);
    const building = (saved.buildings as unknown as Building[])[0]!;
    const oldBuilding = (old.buildings as unknown as Building[])[0]!;
    expect(oldBuilding.storeyHeight).toBe(building.storeyHeight / 2);
    expect(oldBuilding.volumes[0]!.w).toBe(building.volumes[0]!.w / 2);
    expect(oldBuilding.rotation).toBe(building.rotation);
    // Opened, it is the town as saved, field for field, and says this build's unit.
    const opened = RoadDoc.fromJSON(old, { repair: false });
    expect(opened.toText()).toBe(RoadDoc.fromJSON(saved, { repair: false }).toText());
    expect(opened.toJSON().unit).toBe(METERS_PER_UNIT);
  });

  it('keeps the camera on the same ground at the same size on screen', () => {
    const old: SavedSettings = { camera: { x: 100, y: -40, zoom: 2 }, paused: false, speed: 1, trafficIntensity: 1, pedestrianIntensity: 1, congestionOverlay: false, unit: METERS_PER_UNIT * 2 };
    const now = normalizeSettings(old);
    expect(now.camera).toEqual({ x: 200, y: -80, zoom: 1 });
    expect(now.unit).toBe(METERS_PER_UNIT);
    expect(normalizeSettings(now).camera).toEqual(now.camera);
  });
});
