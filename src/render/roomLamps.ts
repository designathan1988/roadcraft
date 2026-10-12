import type { SimWorld } from '@sim/world';
import { floorHeight, type GroundAt, type PavedAt } from '@world/buildings/foundation';
import { levelElevation, levelHeight, liftAt, localToWorld } from '@world/buildings/geometry';
import { LAMP_KINDS, interiorAt } from '@world/buildings/interior';
import { m } from '@world/units';
import type { CutawaySpec } from './buildings/layer';

/**
 * The room lights of the floors cut open (the building tool's cutaway): one
 * point light over each lamp the player placed in the interior (`interior.ts`,
 * the Interior tab), nearest the middle of the view first. The renderer keeps
 * a fixed set of point lights and moves them here, so switching floors never
 * changes the scene's light count (which recompiles every shader).
 */
export class RoomLamps {
  /** Each cut floor's height, by building and level, for the buildings as they last were. */
  private readonly floors = new Map<string, number>();
  private revision = -1;

  lamps(world: SimWorld, spec: CutawaySpec | null, groundAt: GroundAt, pavedAt: PavedAt, max: number): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    if (!spec) return out;
    if (world.doc.buildings.revision !== this.revision) {
      this.revision = world.doc.buildings.revision;
      this.floors.clear();
    }
    const near = [...world.doc.buildings.all()]
      .map((b) => ({ b, d: Math.hypot(b.x - spec.x, b.y - spec.y) }))
      .filter((e) => (spec.only !== undefined ? e.b.id === spec.only : e.d <= spec.radius))
      .sort((a, c) => a.d - c.d);
    for (const { b } of near) {
      const key = `${b.id}:${spec.level}`;
      let floor = this.floors.get(key);
      if (floor === undefined) {
        floor = floorHeight(b, groundAt, pavedAt) + levelElevation(b, spec.level) + m(0.05);
        this.floors.set(key, floor);
      }
      for (const f of interiorAt(b, spec.level).furniture) {
        if (!LAMP_KINDS.has(f.kind)) continue;
        if (out.length >= max) return out;
        const p = localToWorld(b, f.x, f.y);
        const up = f.kind === 'ceilingLamp' ? levelHeight(b, spec.level) - m(0.6) : f.h * 0.9;
        // On its own block's floor (a split level stands at its own, `Volume.lift`).
        out.push({ x: p.x, y: p.y, z: floor + liftAt(b, spec.level, f.x, f.y) + up });
      }
    }
    return out;
  }
}
