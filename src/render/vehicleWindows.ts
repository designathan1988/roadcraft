import { BufferAttribute, type BufferGeometry, type MeshStandardMaterial } from 'three';
import { merge, type DoorModel } from './vehicleModels';

/** A CAR'S GLAZING WITH ITS DOOR WINDOWS LOWERED IN THE SHADER (`agents.ts` drawCar): a window down was the fixed glazing and each door's
 *  pane drawn apart, five draws a body style and every one at full detail; now the shut glazing is drawn whatever its windows, each pane
 *  lowered by its own car's drop (`windowDrop`, per instance: the left side's, the right side's).
 *  The glass is drawn without vertex colours, so its colour attribute (which the levels keep, `vehicleLevels.ts`) carries each vertex's pane:
 *  red the side whose drop moves it (0 none, 1 left, 2 right), green the pane's sill. A pane is lowered exactly as `windowPane` placed it:
 *  squashed towards its sill by 1 - drop (gone, all on the sill, when fully down), its normal as three's instancing turned it. */

/** The per-instance attribute: the left side's drop, the right side's (0 shut, 0.45 part-way, 1 fully down). */
export const WINDOW_DROP = 'windowDrop';

/** The pane mark of a door's side: what the drop of `drawCar`'s `windowsDown` bit for that side moves. */
const sideMark = (door: DoorModel): number => (door.kind !== 'hinge' ? 0 : door.side === -1 ? 1 : 2);

/** Every vertex of `g` marked as one pane: its side and its sill. */
function marked(g: BufferGeometry, side: number, sill: number): BufferGeometry {
  const count = g.getAttribute('position').count;
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { data[i * 3] = side; data[i * 3 + 1] = sill; }
  g.setAttribute('color', new BufferAttribute(data, 3));
  return g;
}

/** The shut glazing of a body: its fixed glass, then each door's pane where the door shuts, marked. */
export function windowGlass(model: { readonly openGlass: BufferGeometry; readonly doors: readonly DoorModel[] }): BufferGeometry {
  return merge([
    marked(model.openGlass.clone(), 0, 0),
    ...model.doors.map((door) => {
      // The sill `windowPane` lowers it to: the pane's lowest point, in the door's frame and the body's alike (a door is hung at road level).
      if (!door.glass.boundingBox) door.glass.computeBoundingBox();
      const sill = door.glass.boundingBox?.min.y ?? 0;
      return marked(door.glass.clone().translate(door.hingeX, 0, door.hingeZ), sideMark(door), sill);
    }),
  ]);
}

/** The glass `glass` is, its panes lowered by each instance's `windowDrop`: a program of its own (the other glass has no drop to read). */
export function windowGlassMaterial(glass: MeshStandardMaterial): MeshStandardMaterial {
  const material = glass.clone();
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 ${WINDOW_DROP};\n#ifndef USE_COLOR\nattribute vec3 color;\n#endif`)
      // The squash's normal: three's instancing divides a normal by its axis's scale squared, then scales it (r186 `defaultnormal_vertex`).
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
  float paneScale = 1.0 - (color.r > 1.5 ? ${WINDOW_DROP}.y : color.r > 0.5 ? ${WINDOW_DROP}.x : 0.0);
  objectNormal.y /= max(paneScale, 1e-3);`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed.y = color.g + (transformed.y - color.g) * paneScale;');
  };
  material.customProgramCacheKey = () => 'vehicle-window-glass';
  return material;
}
