import { describe, expect, it } from 'vitest';
import { Box3 } from 'three';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { buildCarModel, carStylesFor } from '@render/carBody';
import { buildTruckModel, type VehicleModel } from '@render/vehicleModels';
import { vehicleLook, windowPane } from '@render/agents';
import { windowGlass } from '@render/vehicleWindows';

/** A LOWERED WINDOW STAYS INSIDE ITS DOOR. */
describe('car windows', () => {
  it('lower into the door, never out of it', () => {
    for (const a of ARCHETYPES) {
      if (a.shape !== 'car') continue;
      const model = buildCarModel(a);
      for (const door of model.doors) {
        if (door.kind !== 'hinge') continue;
        const shut = new Box3().setFromBufferAttribute(door.glass.getAttribute('position') as never);
        for (const drop of [0, 0.25, 0.45, 0.7, 0.9, 1]) {
          const pane = windowPane(door, drop);
          if (drop >= 0.98) {
            // Fully down: inside the door, not drawn.
            expect(pane.visible, `${a.id} door ${door.index}`).toBe(false);
            continue;
          }
          // What is drawn is always within the pane's own shut outline
          const lowest = pane.up + shut.min.y * pane.sy;
          const highest = pane.up + shut.max.y * pane.sy;
          expect(lowest, `${a.id} door ${door.index} drop ${drop}`).toBeGreaterThan(shut.min.y - 1e-6);
          expect(highest, `${a.id} door ${door.index} drop ${drop}`).toBeLessThan(shut.max.y + 1e-6);
          expect(highest - lowest).toBeCloseTo((shut.max.y - shut.min.y) * (1 - drop), 6);
        }
      }
    }
  });

  it('are mostly shut, some part-way, some fully down', () => {
    let down = 0;
    let part = 0;
    for (let id = 0; id < 1000; id++) {
      const look = vehicleLook(id, 5);
      if (look.windowsDown !== 0) {
        down++;
        if (look.windowDrop < 1) part++;
      }
    }
    expect(down).toBeGreaterThan(200);
    expect(down).toBeLessThan(400);
    expect(part).toBeGreaterThan(40);
  });

  it('lower in the glazing program exactly where their own panes were drawn', () => {
    const models: [string, VehicleModel][] = [];
    for (const a of ARCHETYPES) {
      if (a.shape === 'car') for (const style of carStylesFor(a)) models.push([`${a.id}:${style}`, buildCarModel(a, style)]);
      else if (a.shape === 'truck') models.push([a.id, buildTruckModel(a)]);
    }
    expect(models.length).toBeGreaterThan(4);
    for (const [name, model] of models) {
      const glazed = windowGlass(model);
      const position = glazed.getAttribute('position'), mark = glazed.getAttribute('color');
      for (const drop of [0, 0.45, 1]) for (const side of [-1, 1] as const) {
        // The program's panes of this side (`vehicleWindows.ts`): squashed towards their sill.
        const lowered = new Box3();
        for (let i = 0; i < position.count; i++) {
          if (mark.getX(i) !== (side === -1 ? 1 : 2)) continue;
          const sill = mark.getY(i);
          lowered.expandByPoint({ x: position.getX(i), y: sill + (position.getY(i) - sill) * (1 - drop), z: position.getZ(i) } as never);
        }
        // The panes as `drawCar` placed them before: each hinged door's own, by `windowPane`.
        const placed = new Box3();
        for (const door of model.doors) {
          if (door.kind !== 'hinge' || door.side !== side) continue;
          const pane = windowPane(door, drop);
          const g = door.glass.getAttribute('position');
          for (let i = 0; i < g.count; i++) {
            const y = pane.visible ? pane.up + g.getY(i) * pane.sy : (door.glass.boundingBox?.min.y ?? 0);
            placed.expandByPoint({ x: g.getX(i) + door.hingeX, y, z: g.getZ(i) + door.hingeZ } as never);
          }
        }
        expect(lowered.isEmpty(), `${name} side ${side}`).toBe(placed.isEmpty());
        if (placed.isEmpty()) continue;
        for (const k of ['x', 'y', 'z'] as const) {
          expect(lowered.min[k], `${name} side ${side} drop ${drop} min ${k}`).toBeCloseTo(placed.min[k], 5);
          expect(lowered.max[k], `${name} side ${side} drop ${drop} max ${k}`).toBeCloseTo(placed.max[k], 5);
        }
      }
      // Every vertex of the shut glazing is kept: the fixed glass and each pane.
      const own = model.openGlass.getAttribute('position').count + model.doors.reduce((n, d) => n + d.glass.getAttribute('position').count, 0);
      expect(position.count, name).toBeLessThanOrEqual(own);
      expect(position.count, name).toBeGreaterThan(0);
    }
  });
});
