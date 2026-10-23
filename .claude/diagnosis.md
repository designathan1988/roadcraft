Symptom: walls seen along the street (at a grazing angle), close up, carry fine vertical streaks and short bright dashes (player, 2026-10-23; shot close4/15-close-b, crop crop-wall-final). Open: no cause found yet; no code changed for it.

Measured (mean second difference over the wall, 640..820 x 100..560, horizontal / vertical; shots ablate2/*, ablate3/*, close5/*):
- all on 9.6 / 6.3; environmentMap off 12.2 / 7.9; shadows off 27.5 / 5.6; buildings' shadows off 27.4 / 5.6; the buildings drawn plain Lambert (no maps, no paint, no specular) 1.4 / 1.0; bShell off: another building shows in the region (the wall is the shell's, src/render/buildings/finishes.ts).
- The finishes' maps on the GPU (probe through `surfaceMaps('building-finishes')` and `renderer.properties`): CompressedArrayTexture 512 x 512 x 13 layers, 10 mip levels, LinearMipmapLinearFilter, anisotropy 16 set on the GPU (`__currentAnisotropy` 16) for colour, normal and roughness: filtered as well as the hardware can.
- The optimizations panel's anisotropy cap (src/render/optimizationsApply.ts:113-123 `texturesOf`) does not reach these maps (they are uniforms added in onBeforeCompile, not on the material): its 1 / 4 / 16 gave the same 11.37 / 7.1.

Ruled out (each tried and measured, reverted):
- The wear's procedural terms (src/render/buildings/finishes.ts WEATHERING): filtered by the footprint (kept, commit 8895aa93); the wall unchanged.
- Specular aliasing of the mapped normal: geometric specular antialiasing after the normal map (Tokuyoshi & Kaplanyan 2019, Filament normalFiltering 0.15 / 0.2): 11.43 / 7.32 -> 11.30 / 7.17, no change; reverted.
- The texture's filtering: every mip and anisotropy 16 on the GPU (above).

Left to read: the finishes' own recipes (src/render/bake/finishRecipes.ts, which finish the tall white towers take and what its colour map holds at 512 a layer: vertical joints or ribs read edge-on are the texture's own lines, not aliasing), and the shell's geometry on those towers (pilasters, fins as thin faces: `bFacadeDetails` and `bParts` off changed the region's content, inconclusive).
