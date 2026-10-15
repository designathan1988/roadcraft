import { BufferAttribute, BufferGeometry, Group, Mesh } from 'three';
import { gpuOnly } from '../mesh/gpuOnly';
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
/**
 * STREET-LEVEL HORIZON VIEWS: with the eye near the ground and looking along
 * the streets, the cells far down the view were all in detail (a 1.5 m
 * error at 800 m is still 2 px) though nearly all of them stand behind the
 * nearer buildings - a street view drew 28 M triangles in 984 calls
 * (2026-10-14). As Cesium's `dynamicScreenSpaceError` ("for street-level
 * horizon views, use lower resolution tiles far from the camera"), the error
 * a far cell may make grows with its distance while the eye is low: doubled
 * at `HORIZON_HALF`, trebled at twice it. From above (`STREET_EYE` up) the
 * rule is the plain one.
 */
const STREET_EYE = m(40);
const HORIZON_HALF = m(150);

/** A cell's key from its column and row (`layer.ts` `cellOf`). */
const keyOf = (i: number, j: number): string => `${i},${j}`;

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
  /**
   * The cells made again from their buildings' masses (by cell key; an empty
   * list: buildings with no mass, a cell always near); a cell whose masses are
   * the same objects is kept, a cell not given goes.
   */
  update(byCell: ReadonlyMap<string, readonly MassingChunk[] | null>): void;
  /**
   * Only the cells given made again (a cell given null goes), the others
   * left as they are: what one building changed costs its cell, not the town
   * (docs/AUDITORIA-2026-10-14.md A1).
   */
  patch(byCell: ReadonlyMap<string, readonly MassingChunk[] | null>): void;
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
  /** The cells drawn near now (what the streaming of the detail reads, `layer.ts` `landCells`). */
  nearKeys(): Iterable<string>;
  /**
   * Whether a cell's detail is shown (`layer.ts` streaming): a near cell
   * keeps its mass shown until its detail lands - between the two the cell
   * stood empty for the seconds its buildings took to come.
   */
  setDetailed(key: string, detailed: boolean): void;
  dispose(): void;
}

const sameMasses = (a: readonly MassingChunk[], b: readonly MassingChunk[]): boolean =>
  a.length === b.length && a.every((c, i) => c === b[i]);

/** A cell's masses, in order, as one mesh's arrays (the indices shifted), and its highest point; null for none. */
function massArrays(masses: readonly MassingChunk[]): {
  position: Float32Array; normal: Float32Array; color: Float32Array; facade: Float32Array; glazing: Float32Array; index: Uint32Array; top: number;
} | null {
  let vertices = 0, indices = 0;
  for (const c of masses) { vertices += c.position.length / 3; indices += c.index.length; }
  if (indices === 0) return null;
  const position = new Float32Array(vertices * 3), normal = new Float32Array(vertices * 3), color = new Float32Array(vertices * 3);
  const facade = new Float32Array(vertices * 4), glazing = new Float32Array(vertices * 2), index = new Uint32Array(indices);
  let v = 0, n = 0, top = -Infinity;
  for (const c of masses) {
    position.set(c.position, v * 3);
    normal.set(c.normal, v * 3);
    color.set(c.colour, v * 3);
    facade.set(c.facade, v * 4);
    glazing.set(c.glazing, v * 2);
    for (let i = 0; i < c.index.length; i++) index[n + i] = c.index[i]! + v;
    for (let i = 1; i < c.position.length; i += 3) top = Math.max(top, c.position[i]!);
    v += c.position.length / 3;
    n += c.index.length;
  }
  return { position, normal, color, facade, glazing, index, top };
}

/**
 * A cell's mesh from its buildings' masses. The masses are what the layer
 * keeps (`layer.ts` `masses`, a cell made again from them when one changes);
 * the mesh is a copy for the GPU and keeps no arrays once there (`gpuOnly`):
 * kept, the town's cells were 465 MB of the heap in a 2,560 m city.
 */
function cellMesh(masses: readonly MassingChunk[], kit: BuildingKit): { mesh: Mesh; top: number } | null {
  const arrays = massArrays(masses);
  if (!arrays) return null;
  const g = new BufferGeometry();
  // Taken as made: DO NOT wrap them in a Float32BufferAttribute, which copies them (`buildingMesh.ts` assembly).
  g.setAttribute('position', new BufferAttribute(arrays.position, 3));
  g.setAttribute('normal', new BufferAttribute(arrays.normal, 3));
  g.setAttribute('color', new BufferAttribute(arrays.color, 3));
  g.setAttribute('facade', new BufferAttribute(arrays.facade, 4));
  g.setAttribute('glazing', new BufferAttribute(arrays.glazing, 2));
  g.setIndex(new BufferAttribute(arrays.index, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  const top = arrays.top;
  const mesh = new Mesh(g, kit.massing);
  gpuOnly(mesh, () => { const { top: _top, ...again } = massArrays(masses)!; return again; });
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
  /**
   * The cells drawn near now, and those whose detail is shown: what `choose`
   * reads besides the cells round the eye. DO NOT walk every cell of the town
   * each frame to choose: the cells that may change are those near now and
   * those within reach of the eye (`choose`), a number set by the view.
   */
  const nearKeys = new Set<string>();
  const detailed = new Set<string>();
  /** How far a cell's box reaches past its square (a building over its edge), the most of any: the eye's search is grown by it. */
  let overhang = 0;
  /** A cell's mass shown: far, or near with no detail to stand in for it. */
  const showMass = (key: string, cell: Cell): void => {
    if (cell.mesh) cell.mesh.visible = !cell.near || !detailed.has(key);
  };
  const setNear = (key: string, cell: Cell, near: boolean): void => {
    cell.near = near;
    if (near) nearKeys.add(key); else nearKeys.delete(key);
    showMass(key, cell);
  };
  const drop = (cell: Cell): void => {
    if (!cell.mesh) return;
    group.remove(cell.mesh);
    cell.mesh.geometry.dispose();
    cell.mesh = null;
  };
  /** A cell made again from its buildings' masses, unless they are the same objects. */
  const put = (key: string, masses: readonly MassingChunk[]): void => {
    const known = cells.get(key);
    if (known && sameMasses(known.masses, masses)) return;
    if (known) drop(known);
    const comma = key.indexOf(',');
    const i = Number(key.slice(0, comma)), j = Number(key.slice(comma + 1));
    const made = cellMesh(masses, kit);
    const cell: Cell = {
      masses, mesh: made?.mesh ?? null,
      x0: i * cellSize, y0: j * cellSize, x1: (i + 1) * cellSize, y1: (j + 1) * cellSize,
      // A cell with no mass is always near (its detail is all it has).
      top: made?.top ?? 0, near: made ? known?.near ?? true : true,
    };
    // A building reaching past its cell's edge: the cell's box is its masses'.
    const box = made?.mesh.geometry.boundingBox;
    if (box) {
      cell.x0 = Math.min(cell.x0, box.min.x); cell.x1 = Math.max(cell.x1, box.max.x); cell.y0 = Math.min(cell.y0, -box.max.z); cell.y1 = Math.max(cell.y1, -box.min.z);
      overhang = Math.max(overhang, i * cellSize - cell.x0, cell.x1 - (i + 1) * cellSize, j * cellSize - cell.y0, cell.y1 - (j + 1) * cellSize);
    }
    if (made) group.add(made.mesh);
    cells.set(key, cell);
    setNear(key, cell, cell.near);
  };
  const forget = (key: string, cell: Cell): void => {
    drop(cell);
    cells.delete(key);
    nearKeys.delete(key);
  };
  return {
    group,
    /** @rebuild Called when the stored buildings were put together again (`layer.ts` `update`, the whole town). */
    update(byCell) {
      for (const [key, masses] of byCell) put(key, masses ?? []);
      for (const [key, cell] of [...cells]) if (!byCell.get(key)) forget(key, cell);
    },
    /** @rebuild Called when some buildings changed (`layer.ts` `update`, their cells only). */
    patch(byCell) {
      for (const [key, masses] of byCell) {
        if (masses) { put(key, masses); continue; }
        const known = cells.get(key);
        if (known) forget(key, known);
      }
    },
    choose(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, allNear, reach = Infinity) {
      const decide = (key: string, cell: Cell): void => {
        let near: boolean;
        const forced = allNear === true || (allNear !== false && allNear.has(key));
        if (forced || !cell.mesh) near = true;
        else {
          // To the cell's nearest point (Cesium measures to the tile's bounding volume).
          const dx = Math.max(cell.x0 - eyeX, 0, eyeX - cell.x1);
          const dy = Math.max(cell.y0 - eyeY, 0, eyeY - cell.y1);
          let pixels: number;
          let allowed = NEAR_PIXELS;
          if (orthoPx !== null) pixels = FAR_ERROR * orthoPx;
          else {
            const dz = Math.max(eyeZ - cell.top, 0);
            const d = Math.max(Math.hypot(dx, dy, dz), 1);
            pixels = (FAR_ERROR * pxAtMetre) / d;
            // The eye low: the farther the cell, the more error it may make (`HORIZON_HALF`).
            const street = Math.max(0, 1 - eyeZ / STREET_EYE);
            allowed = NEAR_PIXELS * (1 + (street * d) / HORIZON_HALF);
          }
          // Within reach, with a margin for a cell already near (hysteresis).
          near = pixels >= allowed * (cell.near ? HYSTERESIS : 1) && Math.hypot(dx, dy) <= reach * (cell.near ? 1.25 : 1);
        }
        if (near !== cell.near) setNear(key, cell, near);
      };
      // Those near now may go far; those named stay near.
      for (const key of [...nearKeys]) decide(key, cells.get(key)!);
      if (allNear !== true && allNear !== false) for (const key of allNear) { const cell = cells.get(key); if (cell && !cell.near) decide(key, cell); }
      // A far cell comes near only within the farthest a near cell may be on the map: within
      // `reach`, and where what the far level leaves out still spans `NEAR_PIXELS` (the error
      // allowed only grows with the distance, `HORIZON_HALF`).
      const within = allNear === true ? Infinity
        : orthoPx !== null ? (FAR_ERROR * orthoPx >= NEAR_PIXELS ? reach : 0)
          : Math.min(reach, (FAR_ERROR * pxAtMetre) / NEAR_PIXELS);
      if (within <= 0) return;
      const r = within + overhang;
      const i0 = Math.floor((eyeX - r) / cellSize), i1 = Math.floor((eyeX + r) / cellSize);
      const j0 = Math.floor((eyeY - r) / cellSize), j1 = Math.floor((eyeY + r) / cellSize);
      const span = (i1 - i0 + 1) * (j1 - j0 + 1);
      // Past the town's own cells (a view of the whole map): its cells, no more.
      if (!Number.isFinite(span) || span > cells.size) {
        for (const [key, cell] of cells) if (!cell.near) decide(key, cell);
        return;
      }
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = keyOf(i, j);
          const cell = cells.get(key);
          if (cell && !cell.near) decide(key, cell);
        }
      }
    },
    near(key) {
      return cells.get(key)?.near ?? true;
    },
    nearKeys() {
      return nearKeys;
    },
    setDetailed(key, on) {
      if (on) detailed.add(key); else detailed.delete(key);
      const cell = cells.get(key);
      if (cell) showMass(key, cell);
    },
    dispose() {
      for (const cell of cells.values()) drop(cell);
      cells.clear();
      nearKeys.clear();
      detailed.clear();
    },
  };
}
