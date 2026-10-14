import { BufferGeometry, Float32BufferAttribute, Group, Mesh, Uint32BufferAttribute } from 'three';
import { m } from '@world/units';
import type { BuildingKit } from './kit';
import type { MassingChunk } from './massing';

/**
 * THE BUILDINGS' FAR LEVEL, cell by cell: each cell of the buildings' grid
 * (`layer.ts` BATCH_CELL) has one mesh of its buildings' masses
 * (`massing.ts`), drawn instead of the detailed cell when the detail would
 * show under a couple of pixels - a hierarchical level of detail as
 * Unreal's HLOD (one proxy mesh and one material a cell, rebuilt only when
 * its buildings changed) chosen as 3D Tiles are refined: by the error the
 * coarser level makes, projected on the screen (Cesium's
 * `Cesium3DTile.getScreenSpaceError`: error * screen height / (distance *
 * 2 tan(fov / 2)) in perspective, error / pixel size in an orthographic
 * view), with a margin each way so a cell at the edge does not flicker
 * (three's `LOD.update` hysteresis).
 */

/**
 * The largest thing the far level leaves out, m: a balcony's slab (1.3 m)
 * or a sill and its frame stand out of the wall; railings, frames and the
 * lots' walls are smaller.
 */
const FAR_ERROR = m(1.5);
/** The detail is drawn while what the far level leaves out spans this many pixels or more. */
const NEAR_PIXELS = 2;
/** A cell drawn near stays near down to this share of `NEAR_PIXELS`. */
const HYSTERESIS = 0.85;

interface Cell {
  /** The masses it was made from, in its buildings' order: kept while they are the same. */
  masses: readonly MassingChunk[];
  mesh: Mesh | null;
  /** Its box in the plan (map x/y) and its highest point, for the distance to the eye. */
  x0: number; y0: number; x1: number; y1: number; top: number;
  near: boolean;
}

export interface MassCells {
  readonly group: Group;
  /** The cells made again from their buildings' masses (by cell key); a cell whose masses are the same objects is kept. */
  update(byCell: ReadonlyMap<string, readonly MassingChunk[]>): void;
  /**
   * Which cells are drawn near (their detail) and which far (their masses),
   * from the eye (map x/y, height) and the screen: `pxAtMetre` the pixels a
   * metre spans at a metre's distance in a perspective view, or `orthoPx`
   * the pixels a metre spans in an orthographic one. `allNear` draws every
   * cell near (true) or the cells named (a set of keys: the building cut
   * open, the one being edited) whatever the eye says. `reach`: a cell
   * farther than this from the eye on the map is far whatever its error (the
   * ground an orthographic view takes in; Infinity for no limit).
   */
  choose(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, allNear: boolean | ReadonlySet<string>, reach?: number): void;
  /** Whether a cell is drawn near; a cell with no mass (lawns only) always is. */
  near(key: string): boolean;
  /**
   * A near cell whose detail is not made yet (`layer.ts` streaming) keeps its
   * mass shown (`held` true) until the detail lands: between the two the
   * cell stood empty for the seconds its buildings took to come.
   */
  holdMass(key: string, held: boolean): void;
  dispose(): void;
}

const sameMasses = (a: readonly MassingChunk[], b: readonly MassingChunk[]): boolean =>
  a.length === b.length && a.every((c, i) => c === b[i]);

function cellMesh(masses: readonly MassingChunk[], kit: BuildingKit): { mesh: Mesh; top: number } | null {
  let vertices = 0, indices = 0;
  for (const c of masses) { vertices += c.position.length / 3; indices += c.index.length; }
  if (indices === 0) return null;
  const position = new Float32Array(vertices * 3), normal = new Float32Array(vertices * 3), colour = new Float32Array(vertices * 3);
  const facade = new Float32Array(vertices * 4), glazing = new Float32Array(vertices * 2), index = new Uint32Array(indices);
  let v = 0, n = 0, top = -Infinity;
  for (const c of masses) {
    position.set(c.position, v * 3);
    normal.set(c.normal, v * 3);
    colour.set(c.colour, v * 3);
    facade.set(c.facade, v * 4);
    glazing.set(c.glazing, v * 2);
    for (let i = 0; i < c.index.length; i++) index[n + i] = c.index[i]! + v;
    for (let i = 1; i < c.position.length; i += 3) top = Math.max(top, c.position[i]!);
    v += c.position.length / 3;
    n += c.index.length;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normal, 3));
  g.setAttribute('color', new Float32BufferAttribute(colour, 3));
  g.setAttribute('facade', new Float32BufferAttribute(facade, 4));
  g.setAttribute('glazing', new Float32BufferAttribute(glazing, 2));
  g.setIndex(new Uint32BufferAttribute(index, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  const mesh = new Mesh(g, kit.massing);
  mesh.name = 'building-massing';
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, top };
}

export function createMassCells(kit: BuildingKit, cellSize: number): MassCells {
  const group = new Group();
  group.name = 'buildings-far';
  group.matrixAutoUpdate = false;
  const cells = new Map<string, Cell>();
  const drop = (cell: Cell): void => {
    if (!cell.mesh) return;
    group.remove(cell.mesh);
    cell.mesh.geometry.dispose();
    cell.mesh = null;
  };
  return {
    group,
    /** @rebuild Called when the stored buildings were put together again (`layer.ts` `update`, on a new buildings key). */
    update(byCell) {
      for (const [key, masses] of byCell) {
        const known = cells.get(key);
        if (known && sameMasses(known.masses, masses)) continue;
        if (known) drop(known);
        const comma = key.indexOf(',');
        const i = Number(key.slice(0, comma)), j = Number(key.slice(comma + 1));
        const made = cellMesh(masses, kit);
        const cell: Cell = {
          masses, mesh: made?.mesh ?? null,
          x0: i * cellSize, y0: j * cellSize, x1: (i + 1) * cellSize, y1: (j + 1) * cellSize,
          top: made?.top ?? 0, near: known?.near ?? true,
        };
        // A building reaching past its cell's edge: the cell's box is its masses'.
        const box = made?.mesh.geometry.boundingBox;
        if (box) { cell.x0 = Math.min(cell.x0, box.min.x); cell.x1 = Math.max(cell.x1, box.max.x); cell.y0 = Math.min(cell.y0, -box.max.z); cell.y1 = Math.max(cell.y1, -box.min.z); }
        if (made) { made.mesh.visible = !cell.near; group.add(made.mesh); }
        cells.set(key, cell);
      }
      for (const [key, cell] of cells) {
        if (byCell.has(key)) continue;
        drop(cell);
        cells.delete(key);
      }
    },
    choose(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, allNear, reach = Infinity) {
      for (const [key, cell] of cells) {
        let near: boolean;
        const forced = allNear === true || (allNear !== false && allNear.has(key));
        if (forced || !cell.mesh) near = true;
        else {
          // To the cell's nearest point (Cesium measures to the tile's bounding volume).
          const dx = Math.max(cell.x0 - eyeX, 0, eyeX - cell.x1);
          const dy = Math.max(cell.y0 - eyeY, 0, eyeY - cell.y1);
          let pixels: number;
          if (orthoPx !== null) pixels = FAR_ERROR * orthoPx;
          else {
            const dz = Math.max(eyeZ - cell.top, 0);
            const d = Math.max(Math.hypot(dx, dy, dz), 1);
            pixels = (FAR_ERROR * pxAtMetre) / d;
          }
          // Within reach, with a margin for a cell already near (hysteresis).
          near = pixels >= NEAR_PIXELS * (cell.near ? HYSTERESIS : 1) && Math.hypot(dx, dy) <= reach * (cell.near ? 1.25 : 1);
        }
        if (near === cell.near) continue;
        cell.near = near;
        if (cell.mesh) cell.mesh.visible = !near;
      }
    },
    near(key) {
      return cells.get(key)?.near ?? true;
    },
    holdMass(key, held) {
      const cell = cells.get(key);
      if (cell?.mesh) cell.mesh.visible = held || !cell.near;
    },
    dispose() {
      for (const cell of cells.values()) drop(cell);
      cells.clear();
    },
  };
}
