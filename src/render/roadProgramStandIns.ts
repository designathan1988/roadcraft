import { BufferAttribute, BufferGeometry, Group, type Material, Mesh } from 'three';
import type { SceneMaterials } from './materials';
import { readsRoadSection } from './mesh/roadEdges';
import { PAINT_COLOURS } from './paintQuads';
import { surfaceLook } from './roadSurfaces';
import type { TileSource } from './roadTileShape';

/** Every surface a block of the roads can draw, for its programs' stand-ins: each band, each median part, each paint colour of the catalogue. */
const LOOK_SOURCES: readonly TileSource[] = [
  ...(['verge', 'footway', 'curbRamp', 'kerb', 'asphalt'] as const).map((band): TileSource => ({ kind: 'band', band })),
  ...(['kerb', 'planting', 'paved'] as const).map((part): TileSource => ({ kind: 'median', part })),
  ...PAINT_COLOURS.map((color): TileSource => ({ kind: 'paint', color })),
];

/** Each vertex's place in no road's section (`tileMesh.ts`: a surface without one). */
function noSection(vertices: number): Float32Array {
  const out = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) out[v * 3 + 1] = -1;
  return out;
}

/** THE ROADS' PROGRAMS AMONG THE WORLD'S, never drawn: one invisible triangle per look of a road surface (`surfaceLook`), raised and not (a raised surface casts: its depth program too), so the opening's catalogue (`shaderCatalogue.ts`, it walks the scene, the hidden too) builds every program a block of the roads can be drawn with before the curtain lifts.
 *  DO NOT leave them to their first draw: the opening's district met only some of them, and every other one (the decks, the raised asphalt, a paint colour, their shadows) was built in the frame it first came into view, one after the other, behind the curtain (2026-10-21: ~10 s more of curtain once the far roads, which carried these stand-ins, were deleted). */
export function roadProgramStandIns(materials: SceneMaterials, groundMaterial: Material | undefined, paintFor: (color: string) => Material): { readonly group: Group; dispose(): void } {
  const group = new Group();
  group.name = 'roads-program-stand-ins';
  group.visible = false;
  const seen = new Set<string>();
  for (const raised of [false, true]) {
    for (const source of LOOK_SOURCES) {
      const look = surfaceLook(source, raised, materials, groundMaterial, paintFor);
      const reads = readsRoadSection(look.material);
      const key = `${look.material.uuid}|${look.castShadow ?? false}|${reads}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
      g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
      g.setAttribute('uv', new BufferAttribute(new Float32Array(6), 2));
      if (look.material.vertexColors) g.setAttribute('color', new BufferAttribute(new Float32Array(9).fill(1), 3));
      if (reads) g.setAttribute('roadSection', new BufferAttribute(noSection(3), 3));
      g.setIndex([0, 1, 2]);
      const mesh = new Mesh(g, look.material);
      mesh.name = 'roads-program-stand-in';
      mesh.castShadow = look.castShadow ?? false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  }
  return {
    group,
    dispose() {
      for (const child of group.children) (child as Mesh).geometry.dispose();
      group.clear();
    },
  };
}
