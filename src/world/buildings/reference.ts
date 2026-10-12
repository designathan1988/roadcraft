/**
 * A reference model's geometry as the Builder reads it (`editor/fromReference.ts`)
 * and as the renderer samples it (`render/buildings/referenceModel.ts`): here,
 * below both, so neither layer imports the other.
 */

/** A point of the model, metres: x and y on the plan, z up. */
export type Point3 = readonly [number, number, number];
/** One triangle of the model's surface. */
export type Triangle = readonly [Point3, Point3, Point3];

/** A colour the model shows at a point of its surface, seen along the normal, or null (nothing there). */
export type ReferenceSampler = (x: number, y: number, z: number, nx: number, ny: number) => readonly [number, number, number] | null;
