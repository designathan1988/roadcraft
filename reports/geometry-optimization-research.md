# Geometry optimisation research (2026-10-22)

Follow-up to `reports/polygon-geometry-audit.md`. Goal: the most performance with **identical image quality**.
Method: a deep-research run (5 search angles, 23 sources fetched, 96 claims extracted, 25 verified by 3-vote adversarial
checks: 23 confirmed, 2 refuted), then targeted searches for the audit items the run left without a source, then every
recommendation checked against this repository's code (three r186 in `node_modules`).

## 1. Already implemented in the code (no work needed)

| Technique from the research | Where it already is |
|---|---|
| Cached / scrolled static shadow maps, cascades spread over frames (Dybisz, SIGGRAPH 2021) | `src/render/sunCascades.ts:31` static stores, texel scrolling, change-box patches |
| GPU skinning from a palette texture, one instanced draw per LOD piece (GPU Gems 3 ch. 2) | `src/render/people/proceduralCrowd.ts` palette pass, `crowdLod.ts` ladders |
| BatchedMesh `sortObjects` off for opaque (per-instance sort in every pass) | `src/render/buildings/shellBatch.ts:210-213`, `networkFarRoads.ts:180` |
| meshoptimizer simplification LOD ladders | `render/mesh/simplify.ts`, `kit.ts`, `carBody.ts`, `crowdLod.ts`, `roadLodPure.ts` ... |
| Octahedral / quantised normals on building meshes | `buildingMesh.ts`, `cellArrays.ts`, `chunk.ts`, `kit.ts` |
| three picks Uint16 automatically when an index is set from a plain array under 65,536 | `node_modules/three/src/core/BufferGeometry.js:234` (`arrayNeedsUint32`) |

## 2. Recommendations, ordered by gain / risk

Each item: technique, expected gain, how quality stays identical, sources.

### R1. Furniture: no RoundedBoxGeometry for small boxes (`render/buildings/furnitureKit.ts:51`)
- Today `RoundedBoxGeometry(w,h,d,2,r)` = 5x5x5 box = 216 v / 300 t (`RoundedBoxGeometry.js:69-75`); a bookshelf ~54.6k t.
- Technique: a bevel box with one chamfer ring (24 face quads + 12 edge quads + 8 corner tris = 44 tris after welding)
  for pieces whose bevel radius projects above a pixel; a plain box (12 t) below that (books: 4-8 cm, r 3 cm). Then the
  existing meshopt ladder for the merged furniture piece.
- Gain: ~7x (300 -> 44) or 25x (-> 12) per box; a bookshelf from ~54.6k to roughly 2-8k triangles.
- Quality: the rounding of a 3 cm edge covers < 1 px beyond a few metres; near pieces keep the bevel. A shading-only
  substitute (bump "round corners") was **refuted 0-3** in verification, so geometry stays geometric.
- Sources: [three.js webgl_batch_lod_bvh example](https://threejs.org/examples/webgl_batch_lod_bvh.html) (5 LODs, 4 auto-generated with meshoptimizer);
  [meshoptimizer README](https://github.com/zeux/meshoptimizer).

### R2. Stop submitting collapsed instances (density cars, far woods, sign-plate free slots, destruction, poseHidden)
- Technique: on WebGL2 compact on the CPU (swap-remove into a dense range, set `count` / draw range) or, for
  BatchedMesh, `setVisibleAt(false)` / `deleteInstance()`, which drop the instance from the multi-draw lists entirely.
  GPU culling with `IndirectStorageBufferAttribute` exists only on a real WebGPU backend (WebGL2 has no indirect draw).
- Gain: vertex work and draw-list length in proportion to hidden instances (density cars: up to 262,144 x 24 t).
- Quality: none; collapsed instances produced no pixels.
- Sources: [BatchedMesh docs](https://threejs.org/docs/pages/BatchedMesh.html) and r186 `BatchedMesh.js:861-871, 1590-1661`;
  [IndirectStorageBufferAttribute](https://threejs.org/docs/pages/IndirectStorageBufferAttribute.html), `WebGLBackend.js:963-965`.

### R3. Terrain patches and rim (`render/terrainLod.ts:35,43`)
- Code fact: patches are non-indexed on purpose: the cell diagonal is chosen in the shader from the corner heights
  (`terrainLod.ts:102-105`, same rule as `world/groundPatch.ts`). A plain shared indexed grid cannot flip diagonals,
  so the research's "6x fewer vertex invocations" does **not** apply as stated.
- Technique that keeps the data-driven diagonal: 4 vertices per cell, fixed index order (0,1,2, 2,1,3), and in the
  shader rotate the corner each vertex takes by 90 degrees when the other diagonal is chosen (rotating a quad's corners
  swaps its diagonal). Vertex invocations 6 -> 4 per cell (-33 %), identical triangles. Order with meshopt vertex-cache.
- Rim: today every rim instance draws all 4 sides, both windings (160 t, 120+ zero-area). Draw one side per instance
  (instance attribute = side) only where a border needs it, one winding facing out: 160 -> 20 t per needed side.
- Quality: identical surfaces; CDLOD morphing already prevents cracks, the rim is a safety skirt only.
- Sources: [meshoptimizer README](https://github.com/zeux/meshoptimizer) (index -> vertex cache -> overdraw -> vertex fetch -> quantize);
  [Kerbl et al., HPG 2018, vertex reuse in batches](https://www.tugraz.at/institute/icg/research/team-steinberger/research-projects/gpu-rendering-pipelines/shadingrate);
  [Strugar, CDLOD](https://github.com/fstrugar/CDLOD).

### R4. Screen-space tolerance for curves and arcs (`core/ring.ts` ARC_TOL 8 mm, `core/bezier.ts` 2 cm)
- Segment count ~ 1/sqrt(tolerance) (sagitta = L^2 k / 8). Keep 8 mm for level 0 near the camera; derive the tolerance
  of each far level from its pixel error (tolerance = allowed px x metres per px at that level's distance).
- Gain: 16x looser tolerance = 4x fewer arc segments on far levels (bulbs ~75 -> ~19, curb returns 11-17 -> 3-5).
- Quality: identical as long as the error stays under one pixel at the distance the level is drawn.
- Source: [kurbo `flatten`](https://doc.servo.org/kurbo/fn.flatten.html).

### R5. Closed cylinders whose caps never show; lens and halo discs
- `render/signals.ts:119,124` lenses/halos `CylinderGeometry(...,12)` closed = 48 t; a 12-segment `CircleGeometry` is 12 t.
  Sign posts Cylinder(8) and piers Cylinder(16): set `openEnded = true` where the cap is buried or never seen.
- Gain: 4x on lenses/halos (7,638 lenses + halos in a large city per code comment); 2x on posts and piers.
- Quality: identical when the removed caps are not visible (buried base, underside under a deck).
- Source: [CylinderGeometry docs](https://threejs.org/docs/pages/CylinderGeometry.html) (`openEnded`).

### R6. Road markings: fill instead of stroke stacks
- Mini-roundabout disc: 18 concentric strokes x 40 segments (~1,440 overlapping t) -> one 40-segment filled disc (~40 t).
- Parking / no-parking lines: one point per metre on straight runs -> points only where the kerb bends (collinear
  points dropped with the same tolerance as R4).
- Gain: ~36x on the disc; ~50x on straight parking lines. Quality: identical outline. No external source verified;
  this is plain geometry (overlapping strokes cover the same pixels as the fill).

### R7. Sky: fullscreen triangle instead of a 960-triangle sphere (`render/environment.ts:147`)
- Technique: one fullscreen triangle (`gl_VertexID`), view ray reconstructed from the inverse view-projection, same
  sky function evaluated per pixel; depth at the far plane.
- Gain: small (960 -> 1 t; one triangle also avoids the shared diagonal of a quad: measured 65,536 vs 65,792 quads
  at 512^2, ~0.1 ms at 4K for a heavy shader).
- Quality: identical if the sky function receives the same direction per pixel (it does today per fragment).
- Source: [Wallis, "Optimizing triangles for a full-screen pass"](https://wallisc.github.io/rendering/2021/04/18/Fullscreen-Pass.html).

### R8. Index width and attribute packing
- Use Uint16 indices wherever a geometry has < 65,536 vertices: glTF elements (always widened to Uint32), vehicle body+panel
  join, far ground patches, people proxies. Halves index memory and fetch bandwidth.
- Quantise remaining Float32 attributes: 16-bit positions per tile/mesh with scale+offset, octahedral normals at oct16+
  (oct24P mean/max error 0.0195/0.0393 deg vs snorm8x3 0.170/0.386 deg at the same 24 bits). A static PBR vertex goes from 48 to 20 bytes.
- Quality: identical at oct16/oct24 and 16-bit local positions; not snorm8x3.
- Sources: [KHR_mesh_quantization](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_mesh_quantization);
  [Cigolle et al., JCGT 2014](https://jcgt.org/published/0003/02/01/paper.pdf);
  [Unity IndexFormat](https://docs.unity3d.com/ScriptReference/Rendering.IndexFormat.html) (16-bit default for memory and bandwidth).

### R9. Shadow pass: position-only, de-duplicated index ("shadow indexing")
- meshopt `generateShadowIndexBuffer(Multi)` merges vertices that differ only in normal/UV, so the depth pass reuses
  more vertices; three can draw shadows with a separate geometry (the project already swaps coarse shadow indices).
- Gain: largest on meshes with many UV/normal seams (people proxies, furniture, signature buildings).
- Quality: identical depth.
- Sources: [meshoptimizer header](https://github.com/zeux/meshoptimizer/blob/master/src/meshoptimizer.h);
  [Ogre position-only shadow buffer](https://forums.ogre3d.org/viewtopic.php?p=519135).

### R10. Shadow casters that cannot matter
- Receiver-masked caster culling (Bittner et al. 2011: 3-10x on city scenes) and dropping casters whose shadow is under a
  texel of the cascade (the code already does this for small props with `castTexel`). Extend to: lot elements under
  ~0.2 m (posts, drains, parking bays), signal lens/halo (already non-casting), hidden welded volumes (R11).
- Sources: [Bittner et al., Shadow Caster Culling, I3D 2011](https://dcgi.fel.cvut.cz/en/publications/2011/bittner-i3d-scc/);
  [NVIDIA cascaded shadow maps](https://developer.download.nvidia.com/SDK/10/opengl/src/cascaded_shadow_maps/doc/cascaded_shadow_maps.pdf).

### R11. Hidden internal faces of welded / overlapping volumes (`world/buildings.ts:805-860`)
- Union the welded blocks' wall rings in 2D per storey band (the road surfaces already use Clipper for the same job) and
  emit only outer walls; faces fully inside another block are dropped before meshing.
- Gain: the internal walls and their shadow casts. Quality: identical silhouette; risk only on non-manifold input, so
  only coplanar-band 2D unions are proposed, not 3D CSG.
- Sources: [Blender Boolean union removes interior faces](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/booleans.html);
  [MeshInspector: union vs combine](https://meshinspector.com/knowledge-base/mesh-editing/combine-and-union/).

### R12. Foliage cards: indexed and trimmed
- Cards are 6 vertices per quad at 52 B (non-indexed): index them (4 v + 6 indices). Trim the card outline to the
  opaque area of the leaf texture: alpha-tested fragments with `discard` lose early-Z, so cutting transparent area cuts overdraw.
- Sources: [Cinevva, foliage overdraw](https://app.cinevva.com/blog/2026-05-11-foliage-overdraw);
  [Polycount discussion](https://polycount.com/discussion/comment/1368451).

### R13. Cheap fixes found by the audit
- Builder hover: add the `samePlain` check to `hoverElement` (`editor/buildingTool.ts:1806`).
- Delete the never-drawn torso box and head sphere (`render/agents.ts:607`), the unused crowd `instanceMatrix`
  growth, `boxWithout` orphan vertices.
- Lab wireframe on released arrays (`render/mesh/gpuOnly.ts:17-18`): skip those geometries in the wireframe view.

### R14. Measurement: drawn vs built
- `renderer.info.render.triangles` in r186 = instanceCount x count/3 per submitted draw (multi-draw included), reset per
  frame; it ignores clipping and back-face culling and still counts collapsed instances. Keep "built" (buffers) and
  "drawn" (submitted) separate; fix the inspector `trianglesUnder`, `cellInstances.triangles`, and the scripts that
  ignore drawRange/multi-draw (`scripts/buildingParts.mjs:314`, `scripts/layers.mjs:327`), and count shadow casters per cascade.
- Sources: [Info docs](https://threejs.org/docs/pages/Info.html); r186 `renderers/common/Info.js:62,151-193`.

## 3. Refuted or unproven
- Shader-only rounded edges as a RoundedBox replacement: refuted 0-3.
- "BatchedMesh + extensions handles 500k instances" from the example: refuted 0-3.
- No benchmark found for Uint16 vs Uint32 on current GPUs: the recommendation rests on bytes halved, not a measured fps gain.
- All expected gains above are analytical; each change must be measured in the game (drawn triangles, GPU ms) after the fix.

## 4. Suggested order
1. R1, R5, R6, R13 (local, no risk, large triangle cuts).
2. R2 (collapsed instances), R14 (measurement first, so later gains are visible).
3. R3 (terrain), R4 (curve tolerance per level), R7 (sky).
4. R8, R9, R12 (data formats; touch many files).
5. R10, R11 (shadow casters and welded volumes; need visual checks at every distance).
