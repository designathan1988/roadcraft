# Replacing geometry with cheaper equivalents: research (2026-10-22)

Question: how to draw far less geometry and GPU work for every kind of element, with no visible quality loss, without moving
the cost into something else (pixel shaders dearer than the triangles, uncompressed textures, `discard` / `gl_FragDepth` killing
early-Z, overdraw, shader-program explosion).

Method: a verified deep-research run (106 agents, 24 sources read, 99 claims extracted, 25 verified by 3-vote adversarial checks:
20 confirmed, 5 refuted) plus seven dedicated research passes (per-pixel displacement, impostors and shading stand-ins, cost
pitfalls, terrain and roads, vegetation, vehicles/people/shadows, buildings at city scale), each with sources read; then every
recommendation checked against this repository (three r186).

## 1. The rules every choice follows

1. **Tiny triangles are the expensive ones.** GPUs shade in 2x2 quads; triangles under ~4-8 px waste most of their shading
   (Qualcomm: "ideally every triangle rasterized shades at least 4 pixels"; measured sweep at 1080p: >=16x16 px free, 8x8
   significant, below that up to 10-20x slower; slivers worse).
   [Qualcomm Adreno best practices](https://docs.qualcomm.com/doc/80-78185-2/topic/mobile_best_practices.html),
   [Fatahalian et al. 2010](https://www.microsoft.com/en-us/research/?p=159994), [g-truc sweep](https://www.g-truc.net/post-0662.html),
   [Counting quads](https://blog.selfshadow.com/2012/11/12/counting-quads/).
   Consequence: thin bars (frames, mullions, balusters, slats) seen beyond a few tens of metres are the worst geometry in the game.
   1 px at 1080p / 60 deg FOV is about 0.00107 x distance (m): a 2 cm bar is under a pixel at ~19 m, a 5 cm frame at ~47 m.
2. **Replace with closed-form shading, not iterated marching, wherever the shape is piecewise planar** (recesses, frames, panels,
   slats): an exact ray-box / ray-plane test per pixel, no texture fetch, no loop
   ([Quilez box functions](https://iquilezles.org/articles/boxfunctions); interior mapping uses 3 plane tests and "eats little
   performance", [van Dongen](https://gamedeveloper.com/programming/interior-mapping-rendering-real-rooms-without-geometry)).
   Iterated parallax (POM: 8-50 dependent fetches per pixel, [Tatarchuk 2006](https://faculty.digipen.edu/~gherron/references/References/SurfaceDetail/Tatarchuk-POM-SI3D06.pdf))
   only near the camera, few steps + secant refinement, amplitude faded to zero at distance
   ([Cinevva POM in three.js](https://app.cinevva.com/blog/2026-05-05-open-world-browser-part-20-parallax-occlusion)).
3. **Never write `gl_FragDepth`** for these effects: it disables early-Z (Adreno, Intel), and the conservative-depth extension is on
   ~84 % of Chrome and ~1.4 % of Firefox ([Qualcomm](https://docs.qualcomm.com/doc/80-78185-2/topic/mobile_best_practices.html),
   [web3dsurvey](https://web3dsurvey.com/webgl2/extensions/EXT_conservative_depth)).
4. **`discard` / alpha test only where nothing else works**, drawn after opaques; even an unexecuted `discard` raised pixel-shader
   invocations from 440,640 to ~582,000 in one measurement ([MJP](https://therealmjp.github.io/posts/to-earlyz-or-not-to-earlyz/),
   [AMD RDNA guide](https://gpuopen.com/learn/rdna-performance-guide/)).
5. **Procedural (math) for regular patterns, filtered with fwidth**; textures only for irregular detail and then compressed
   (KTX2: ETC1S colour, UASTC normals), never raw RGBA8 over large areas
   ([Quilez filtering](https://iquilezles.org/articles/checkerfiltering/), [Don McCurdy](https://www.donmccurdy.com/2024/02/11/web-texture-formats/)).
6. **Shadows are where cities spend most**: Cities: Skylines 2 spent ~40 ms of an 87.8 ms frame and 72 % of draws on shadows
   ([Huhtala](https://blog.paavo.me/cities-skylines-2-performance/)).
7. **Few, fixed program keys** in three.js (every `customProgramCacheKey` is another program) ([three Material](https://threejs.org/docs/pages/Material.html)).

## 2. Already in this code (no work needed)

| Technique | Where |
|---|---|
| Interior mapping behind panes | `render/buildings/glassRoom.ts` |
| Procedural, filtered facade at the far level (openings, frames, panes, doors, shutters, streaks, lit rooms) | `render/buildings/facadeLevel.ts` |
| Octahedral impostors for plants, stochastic thinning (Cook et al. 2007) | `render/plantImpostors.ts`, `cellInstances.ts`, `farForest.ts` |
| Small casters dropped per cascade by texel size | `render/cellInstances.ts` (`castTexel`), `renderer.ts` |
| Cached / scrolled static shadow stores with change boxes (Insomniac CSM scrolling, Cyberpunk spread updates) | `render/sunCascades.ts` |
| GPU palette skinning, crowd LOD ladders | `render/people/proceduralCrowd.ts`, `crowdLod.ts`, `riggedCitizens.ts` |
| Alpha-to-coverage on foliage and crowd | `farForest.ts`, `lowPolyTrees.ts`, `proceduralCrowd.ts` |
| KTX2 baked surfaces, octahedral normals on buildings | `render/bake/*`, `cellArrays.ts` |
| Furniture: 12-tri boxes, shaded rounding, hidden faces (this session) | `render/buildings/furnitureKit.ts`, `mesh/hiddenFaces.ts` |

## 3. What is left, by element (ordered by expected gain)

| # | Element | Technique | Evidence | Expected gain | Quality risk / how kept identical |
|---|---|---|---|---|---|
| F1 | Window and door openings near (reveal, frame, sill, glass, roller shutter, panelled door, louvres) | Extend the facade shader: exact ray-box recess per opening (reveal walls, sill, frame bars, glass plane at depth, slats as periodic planes), only inside the opening rectangle; the near shell keeps flat walls | Box functions, interior mapping, 2x2 overshading | Frames alone ~167k x 56 = 9.4 M triangles in a large city -> ~0; shells lose 16 tris a bay | No silhouette change (openings lie inside the wall); recess shadow from an analytic sun ray, no shadow-map self-shadow of the recess |
| F2 | Railings, balusters | Procedural bars on the existing card beyond ~20 m (bars < 1 px), geometry near | Epic: aggregate geometry does not simplify; sub-pixel bars | 222 -> 12 tris per railing beyond ~20 m | Card already exists; keep geometry near |
| F3 | Building shadows in far cascades | Proxy casters: the mass box casts, detail parts do not | [Epic proxy shadows](https://dev.epicgames.com/documentation/unreal-engine/proxy-geometry-shadows-in-unreal-engine) | Detail parts out of cascades 1-2 | Only far cascades, where texels are larger than the parts |
| F4 | Shadow casters that touch no visible receiver | Receiver mask culling | [Bittner 2011](https://dcgi.fel.cvut.cz/en/publications/2011/bittner-i3d-scc/): 3-10x on city scenes | Large in dense views | Exact (only casters with no visible effect) |
| T1 | Terrain patches | Indexed patches keeping the data-dependent diagonal (4 vertices a cell, corners rotated), rim drawn only where needed | [meshoptimizer ACMR](https://github.com/zeux/meshoptimizer), [CDLOD](https://github.com/fstrugar/CDLOD/blob/master/cdlod_paper_latest.pdf) | 6 -> 4 vertex invocations a cell; rim 160 -> 20 tris a needed side | Identical triangles |
| R1 | Junction asphalt UVs | World-projected UVs on junction plates, road-frame UVs on straight runs | [CityEngine crossings](https://doc.arcgis.com/en/cityengine/2024.1/help/help-street-intersection-shape-uv.htm) | Quality fix (seams, 2x stretch) | Asphalt texture is isotropic |
| R2 | Curve tolerance by level | Screen-space error per far level | [kurbo flatten](https://doc.servo.org/kurbo/fn.flatten.html), Cesium 2 px SSE | 4x fewer arc segments far | Error < 1 px |
| V1 | Vehicles | LOD ladder by projected size (12.8k -> ~3k -> ~500 -> 24), wheels merged far | Store traffic cars 2.6-3.3k LOD0; [GPU Gems 3 ch.2](https://developer.nvidia.com/gpugems/GPUGems3/gpugems3_ch02.html) | Large near traffic | meshopt error < 1 px |
| P1 | People | LOD by screen height (LOD0 only within a few metres), simple shadow proxy far | AC Unity tiers; [Epic capsule shadows](https://dev.epicgames.com/documentation/unreal-engine/capsule-shadows-overview-in-unreal-engine) | LOD0 rarely drawn | Thresholds by pixel size |
| G1 | Foliage cards | Trim cards to the opaque area; discard only in a depth prepass | [Humus](https://www.humus.name/index.php?page=Comments&ID=266) 15-20 %; MJP | Overdraw | Exact |

Refuted in verification (not used): an "8x overshading" multiplier, a 37 -> 48 fps Z-prepass figure, three HLOD layer types,
Qualcomm 8-bit index advice, shader-only rounded edges as a full replacement.
Sources not reachable (GDC Vault in maintenance): Far Cry 5 terrain, Spider-Man facades; their claims are not used.

Detailed notes per research pass: the scratchpad `research/*.md` of this session (copied into this report's tables).
