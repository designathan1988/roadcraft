import { m } from './units';

/**
 * THE universal grid: every street, footway, junction, lot, zone and piece of
 * street furniture is measured against it.
 *
 * Cells of 10 x 10 m, each cut into ten subdivisions of 1 m. A road's
 * cross-section is laid out in whole subdivisions (a residential street is
 * 2 + 6 + 2 = 10 m: one cell), the zoning grid is made of whole cells, and the
 * road tool's snap places points on the subdivision.
 *
 * Lengths are world units (`units.ts`, one metre); this module only says
 * which world lengths are on the grid.
 */

/** One cell of the grid, 10 m. */
export const GRID_CELL = m(10);
/** One subdivision of a cell, 1 m. */
export const GRID_STEP = m(1);

/** The nearest whole number of subdivisions to a length, never below `min` of them. */
export function onGridLength(length: number, min = 0): number {
  return Math.max(min, Math.round(length / GRID_STEP)) * GRID_STEP;
}

/** The nearest grid point (a whole number of subdivisions on both axes). */
export function snapToGrid(p: { readonly x: number; readonly y: number }, step = GRID_STEP, offset = 0): { x: number; y: number } {
  return { x: Math.round((p.x - offset) / step) * step + offset, y: Math.round((p.y - offset) / step) * step + offset };
}

/** Whether a point is on the grid (`snapToGrid` leaves it where it is). */
export function onGrid(p: { readonly x: number; readonly y: number }, step = GRID_STEP, offset = 0): boolean {
  return Math.abs((p.x - offset) / step - Math.round((p.x - offset) / step)) < 1e-6 &&
    Math.abs((p.y - offset) / step - Math.round((p.y - offset) / step)) < 1e-6;
}
