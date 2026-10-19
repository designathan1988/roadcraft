import type { Material } from 'three';

/** WHO HIDES WHOM AMONG THE OPAQUES (PRD-05): three sorts the opaque list by group, renderOrder, then material id, and only then front to back; the order the materials were made in decided whether the panes (the dearest pixels, `glassRoom.ts`) were shaded before the walls that hide them. A material's class goes between renderOrder and material id: the big occluders (shells, facade levels, masses) first, the panes last. A depth test's answer between opaques does not hang on their order, so the picture is the same; the hidden panes and parts are no longer shaded for nothing. */
export const OCCLUDER = -1;
export const BEHIND = 1;

export function setDrawClass(material: Material, drawClass: number): void {
  material.userData['drawClass'] = drawClass;
}

const classOf = (material: Material): number => (material.userData['drawClass'] as number | undefined) ?? 0;

/** An item of three's render list, as its opaque sort reads it (`WebGLRenderLists.js` painterSortStable). */
interface SortItem {
  readonly groupOrder: number;
  readonly renderOrder: number;
  readonly material: Material & { readonly id: number };
  readonly materialVariant: number;
  readonly z: number;
  readonly id: number;
}

/** three's `painterSortStable` with the material's class between renderOrder and material id (`WebGLRenderer.setOpaqueSort`). */
export function opaqueSort(a: SortItem, b: SortItem): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  const ca = classOf(a.material), cb = classOf(b.material);
  if (ca !== cb) return ca - cb;
  if (a.material.id !== b.material.id) return a.material.id - b.material.id;
  if (a.materialVariant !== b.materialVariant) return a.materialVariant - b.materialVariant;
  if (a.z !== b.z) return a.z - b.z;
  return a.id - b.id;
}
