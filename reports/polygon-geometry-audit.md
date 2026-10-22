# Polygon geometry audit (2026-10-22)

Every element of Roadcraft that ends up as triangles, lines or points on the GPU, with its source location, vertex and
triangle counts, multiplicity, LOD and shadow behaviour. Read-only audit: no code was changed and nothing was run except
small Node scripts that read asset headers.

## Coverage

- `src/**` (all `.ts`, 1,254 tracked files, 818 TypeScript) and `scripts/**` code: **209,619 + 8,588 lines** split into 15
  chunks of 9.7k-16k lines; each chunk was read in full, first line to last. Per-file line counts are in each chunk section
  below ("Files read").
  | Chunk | Lines | Scope |
  |---|---|---|
  | g00 | 15,720 | src root, core, editor (start) |
  | g01 | 14,706 | editor (rest), jobs, lab, lab/inspector |
  | g02 | 15,959 | lab (rest), main.ts, people, peopleLab |
  | g03 | 15,870 | peopleLab (rest), render (a-b), render/bake, render/buildings (start) |
  | g04 | 15,656 | render/buildings (rest), render/c* |
  | g05 | 15,250 | render d*-p* (densityCars, environment, elements, gpu, mesh, ...) |
  | g06 | 15,234 | render/people, render p*-r* (props, poles, post, rain) |
  | g07 | 14,543 | render/renderer.ts ... render/t* (roads, signals, structures, citizens, cascades) |
  | g08 | 13,830 | render/terrain*, transit, utilities, vehicles, wind; sim/agents (start) |
  | g09 | 13,658 | sim/** |
  | g10 | 13,194 | sim (rest), ui (start) |
  | g11 | 15,991 | ui (rest), world/buildings (start) |
  | g12 | 13,014 | world/buildings (rest), world/doc, elevation, cityGen, growth |
  | g13 | 15,915 | world/junction, network, lots, markings, roads |
  | g14 | 9,667 | world (rest), scripts/** |
- Assets measured by script from the files themselves: 22 glTF nature props, 16 cooked MakeHuman people, the MakeHuman base
  mesh, 575 clothing/hair proxies, 29 cooked procedural hair/accessory packs (section "Imported and cooked meshes").
- Not covered: `tests/**` (776 files, not part of the game), `public/models/people/proxies/*.webp` and other textures
  (no polygons), `cooked/cities/*.gz` (city documents, not meshes). `src/peopleLab/pics/*.webp` are images.
- Constants outside a chunk were resolved by targeted reads/greps (each chunk section says which). three.js is r186
  (`node_modules/three/src/constants.js`); built-in geometry counts follow its sources.

## Executive summary

### Frame budgets already in code
`src/core/perfBudget.ts:44-47` (`VIEW_BUDGETS`): street 16 M triangles / 1000 draws, district 16 M / 1100, map 8 M / 400,
GPU p95 12 ms. Measured at full facade level (comment, 2026-10-16): district 13 M, street 5.4 M, map 4.9 M.
`frameBudget.ts`: error scale stepped x1.25 up to 32 to fit the view budget; assumes 1.3 M tris per dense cell (detail),
0.6 M (facade level). VRAM budgets (MB): L0 shells 300, L0 parts 150, L1 masses 120, L2 tiles 60, L3 plates 15.

### Largest triangle sources (by scaling)

| Element | Where | Per unit | Scales with |
|---|---|---|---|
| Building shells (welded fans, multi-draw) | render/buildings/buildingMesh.ts, cellArrays.ts, shellBatch.ts | ~16 tris shell per window bay + 3-4 instanced parts; far level 1 quad per run | bays x storeys x sides per building |
| Building part kit (frames, doors, railings...) | render/buildings/kit.ts, partCells.ts | frame 56, door 72, railing 252, louvre 136, column 24 | per bay, instanced per 64 m sub-cell |
| Building masses (far) | massing.ts, massCells.ts | plain flat block ~34 tris | per building, cell/tile/plate levels |
| Road surface tiles | render/roadSurfaces.ts, mesh/tileMesh.ts | edges <= 3.2 m (relief), 6.4 m (flat/decks); ~0.25-0.4 tris/m2 | road area; far level meshopt to 8 % |
| Terrain CDLOD | render/terrainLod.ts, terrain.ts | patch 10x10 cells = 200 tris; full plate 204,800 | plates in view, 5 levels |
| People (cooked MakeHuman) | cooked/people, riggedCitizens.ts | 28.7k-45.3k LOD0; ~0.5k-17.6k at LOD1-3 | up to 1000 instances per body |
| Procedural crowd | render/people/proceduralCrowd.ts, crowdLod.ts | skin L0 26,756 / L1 2,000 / L2 600; far L3 ~270 | 30 at L0, 120 at L1 caps |
| Density (far) cars | render/densityCars.ts | 24 tris per car | cap 262,144 = 6.29 M tris worst case |
| Cars (near) | carBody.ts, vehicleModels.ts | body ~12.8k tris + 4 tyres x 256 + rims 148 | 7 meshopt levels, 200 drawn whole |
| Street furniture | render/propGeometry.ts | lamp 156, bench 180, bin 252, hydrant 208, phone booth 570 | ~6 lamps, 3 bins, 3 benches, 20 trees per 100 m street |
| Traffic signals | render/signals.ts | 532 tris per lit head (148 cast) | comment: 7,638 lenses, 20,196 visors in a large city |
| Trees | render low-poly trees, farForest.ts | oak 202+80, palm 240+240; far impostor 2 | up to 2,500 per 1,920 m square |

### Main inefficiencies found

Items 1, 6 and 7 and the line numbers of item 9's head sphere were re-checked against the source after the chunk reads;
the rest come from the chunk readers' full reads and cite their file:line.

1. **Interior furniture uses `RoundedBoxGeometry(w,h,d,2,r)`** (`render/buildings/furnitureKit.ts:51`). In r186 that is a
   5x5x5 subdivided box (`RoundedBoxGeometry.js:69-75`): **216 v / 300 t instead of 24 / 12** (25x). Every book of a
   bookshelf is one: a bookshelf ~54,600 t, shelf ~11,400, rack ~6,300, stairs ~5,400, sofa ~3,428, chair ~1,628. Drawn in
   cut-open interiors and destruction (cap 140 pieces), casts shadows.
2. **Terrain rim/skirt** (`render/terrainLod.ts:43`): 160 tris per instance draws all 4 sides both windings; sides not on
   the border are zero-area, 120+ of the 160 wasted. Ground patches are non-indexed (6 v/cell) with 4 corner fetches each.
3. **Mini-roundabout disc** (`world/markings.ts:452-464`): 18 concentric strokes x 40 segments = ~1,440 overlapping tris
   where a 40-gon fill would be ~40.
4. **Parking / no-parking lines** (`world/parkingLayout.ts:172-191`): one point per metre even on straight streets.
5. **Arc tolerance 8 mm** (`core/ring.ts`, `ARC_TOL`): ~75 segments on a turning-circle bulb, 11-17 per curb return, on
   each of the 4 road levels; no coarser tolerance for outer levels or far LOD.
6. **Closed cylinders where only the side or a disc shows**: signal lenses/halos (`render/signals.ts:119,124`, 48 t where a
   12 t disc would do), sign posts Cylinder(8) and piers Cylinder(16) with hidden caps (half their triangles).
7. **Sky dome** `SphereGeometry(1,32,16)` = 561 v / 960 t (`render/environment.ts:147`), full screen every frame.
8. **Degenerate instances still submitted**: density cars hidden in the micro window, far-woods thinned trees, sign plate
   freed slots, destruction pieces (folded to a point but drawn).
9. **Unused / wasted buffers**: procedural crowd `instanceMatrix` allocated and doubled but never written (64 B/instance);
   dead torso box and head `SphereGeometry(0.5,10,7)` (`render/agents.ts:607`) built and never drawn; `boxWithout` leaves
   orphan vertices; Uint32 indices where Uint16 fits (glTF elements always widened, vehicle body+panel join, shell batches,
   far ground patches, proxies).
10. **Unindexed cards and props**: foliage cards 6 v per quad at 52 B/vertex; propGeometry and signature buildings all
    non-indexed (box 36 v).
11. **Overlapping geometry**: welded buildings keep both blocks whole (`world/buildings.ts:805-860`, "Nothing is cut") so
    internal faces are drawn and cast shadows; lawn polygon under all other lot surfaces on non-rectangular lots; road
    tongues / node caps / mouth strips overlap rings unless the level is unioned (Clipper path does).
12. **Builder hover** (`editor/buildingTool.ts:1806`): `hoverElement` calls `setPreview` on every pointer move without the
    `samePlain` check, rebuilding the whole ghost building mesh.
13. **Instrumentation gaps**: the inspector `trianglesUnder` and `cellInstances.triangles` count all live instances, not drawn
    ones; `scripts/buildingParts.mjs:314` and `scripts/layers.mjs:327` ignore drawRange, groups, culling and BatchedMesh
    multi-draw, and do not multiply shadow casters by cascade.
14. **Possible bug (by reading)**: the lab wireframe view uses three's wireframe index on geometries whose arrays were
    released after upload (`render/mesh/gpuOnly.ts:17-18`), which would throw in `updateWireframeAttribute`.

### Imported and cooked meshes (measured from files)

See the "assets" section at the end. Highlights: cooked people 28,736-45,256 tris at LOD0 (mh_45 the largest), 53 bones,
13 morphs, ~84 B/vertex; 575 clothing proxies sum 6.27 M tris (largest single item 155,930 t; street items capped at
`STREET_TRIANGLES = 16000`, `people/wardrobe.ts:30`); procedural hair 4,730 (shortCrop) to 46,180 (afro) tris; glTF nature
props 52-3,216 tris.

---

The detailed per-chunk reports follow, unchanged, in chunk order.


---

## Polygon geometry audit — chunk g00

Scope: 78 files of `parts/g00.txt` (root wiring/workers, `src/core/*`, `src/desktop*`, first half of `src/editor/*`).
Result in one line: **no file in this chunk creates GPU geometry** (no three.js geometry, BufferGeometry, InstancedMesh, shader, or vertex buffer). The chunk contains (a) the CPU-side tessellation tolerances and vertex-count rules that size road/kerb/junction geometry built elsewhere, (b) the building plan-shape vertex counts that size building masses built elsewhere, (c) the game's triangle/draw-call/VRAM budget table, and (d) editor code that drives preview/ghost geometry rebuilds. No import outside the list had to be followed to resolve a number; every constant cited below is defined in this chunk (`m()` = metres, `METERS_PER_UNIT = 1`, `src/core/units.ts:2`).

### Files read

Every file was read whole, first line to last (big files in sequential parts: `buildingsWiring.ts` in one read of 1232 lines, `buildingTool.ts` in 4 parts 1-700/700-1399/1400-2099/2100-2723, `buildings.ts` 1-600/600-1125, `commit.ts` 1-520/520-1008).

| File | Lines |
|---|---|
| src/actionsWiring.ts | 475 |
| src/bayPool.ts | 124 |
| src/bays.worker.ts | 24 |
| src/buildingsWiring.ts | 1232 |
| src/cityGen.worker.ts | 31 |
| src/conflictPool.ts | 280 |
| src/conflictTable.worker.ts | 164 |
| src/core/aabb.ts | 46 |
| src/core/arrayPack.ts | 101 |
| src/core/assert.ts | 56 |
| src/core/axisCut.ts | 231 |
| src/core/bezier.ts | 112 |
| src/core/changeLog.ts | 72 |
| src/core/clipper.ts | 188 |
| src/core/commands.ts | 98 |
| src/core/derivedCache.ts | 341 |
| src/core/digest.ts | 78 |
| src/core/dynamicResolution.ts | 63 |
| src/core/engine.ts | 137 |
| src/core/events.ts | 29 |
| src/core/fillet.ts | 64 |
| src/core/forkMap.ts | 175 |
| src/core/gameState.ts | 146 |
| src/core/gpuTier.ts | 32 |
| src/core/health.ts | 216 |
| src/core/heap.ts | 64 |
| src/core/hitch.ts | 6 |
| src/core/hypot.ts | 48 |
| src/core/idSlots.ts | 132 |
| src/core/identityMemo.ts | 18 |
| src/core/intersect.ts | 68 |
| src/core/keptList.ts | 85 |
| src/core/minMax.ts | 9 |
| src/core/offset.ts | 147 |
| src/core/perfBudget.ts | 166 |
| src/core/plain.ts | 49 |
| src/core/polygon.ts | 90 |
| src/core/polygonBands.ts | 58 |
| src/core/polyline.ts | 402 |
| src/core/profiler.ts | 284 |
| src/core/recentCache.ts | 34 |
| src/core/recordMap.ts | 21 |
| src/core/regionIndex.ts | 553 |
| src/core/rerootMap.ts | 104 |
| src/core/ring.ts | 219 |
| src/core/rng.ts | 118 |
| src/core/runPool.ts | 74 |
| src/core/sampleRing.ts | 69 |
| src/core/scalar.ts | 72 |
| src/core/statechart.ts | 138 |
| src/core/units.ts | 19 |
| src/core/vec2.ts | 46 |
| src/core/weakMachine.ts | 49 |
| src/core/weightedSlots.ts | 118 |
| src/desktopJobs.ts | 46 |
| src/desktopSaves.ts | 151 |
| src/desktopShown.ts | 19 |
| src/editor/barriers.ts | 174 |
| src/editor/blocks.ts | 49 |
| src/editor/blueprintLibrary.ts | 66 |
| src/editor/buildingFacade.ts | 2 |
| src/editor/buildingFloors.ts | 42 |
| src/editor/buildingPlans.ts | 271 |
| src/editor/buildingProfile.ts | 107 |
| src/editor/buildingRoofs.ts | 43 |
| src/editor/buildingSnap.ts | 225 |
| src/editor/buildingTool.ts | 2723 |
| src/editor/buildings.ts | 1125 |
| src/editor/bulldozer.ts | 150 |
| src/editor/chunkedSave.ts | 800 |
| src/editor/cityGenerator.ts | 104 |
| src/editor/cloudTool.ts | 92 |
| src/editor/commit.ts | 1008 |
| src/editor/cookedCities.ts | 52 |
| src/editor/editRules.ts | 284 |
| src/editor/editStream.ts | 13 |
| src/editor/fromReference.ts | 251 |
| src/editor/gameKeys.ts | 148 |
| **Total (78 files)** | **15 720** |

Nothing was left unread.

### Elements

None of these is a GPU primitive by itself; they are the CPU-side generators/sizers whose output becomes triangles in renderer/world files outside this chunk. Counts are given as the vertex counts they produce, with numeric results for the constants actually in code.

#### E1. Quadratic road-curve flattening (road centrelines -> every road strip, kerb, marking, lane)
- Location: `src/core/bezier.ts:40-56` (`quadSegmentCount`, `flattenQuad`), entry `flattenSegment` :59-67. Tolerance `FLATTEN_TOL = m(0.02)` (`src/core/scalar.ts:36`).
- Primitive: produces a polyline (Vec2 list); downstream it becomes triangle strips (ribbons/markings) built elsewhere.
- Counts: straight segment (no curve or |h| < 1e-9) = 2 points. Curved: `steps = clamp(ceil(sqrt(d / (4*tol))), 1, 64)`, points = steps + 1, where `d = |a + b - 2c|` (twice the control point's offset from the chord midpoint, i.e. ~2·|h|... exactly `|a+b-2c|`). With tol = 0.02 m: `steps = ceil(sqrt(d / 0.08))`. Examples: d = 1 m -> 4 steps (5 pts); d = 10 m -> 12 steps (13 pts); d = 50 m -> 25 steps (26 pts); d = 100 m -> 36 steps; cap 64 steps (65 pts) reached at d >= 4096·0.08 = 327.7 m.
- Multiplicity: per road segment; each point becomes 2+ vertices per strip level (asphalt, kerb, footway, verge, markings) in the mesher. Uniform parameter steps (not arc-length adaptive), so dense where curvature is low on a long gentle curve too.
- Used also by `commit.ts:117, 260, 392` (draft polyline, crossings) — CPU only there.

#### E2. Arc tessellation of rings (junction kerb returns, rounded plate corners, curb fillets)
- Location: `src/core/ring.ts:98-120` (`Ring.flatXY`), arc edges built by `arcEdge` :212-217. Tolerance `ARC_TOL = m(0.008)` (`scalar.ts:39`), floor `MIN_ITER_STEP = 1e-3` rad.
- Counts: per arc edge, `maxStep = 2·acos(1 - ARC_TOL/r)` (r < ARC_TOL -> pi), `steps = max(1, ceil(|sweep| / max(maxStep, 1e-3)))`, adds `steps` vertices; a line edge adds 1. Fillet radii come from `curbRadius` (`src/core/fillet.ts:57-64`): `clamp(0.5·min(hwA,hwB), 2.8 m, 7.2 m)`.
  - r = 2.8 m (CURB_R_MIN): maxStep = 0.1513 rad -> 90° corner = 11 vertices.
  - r = 7.2 m (CURB_R_MAX): maxStep = 0.0943 rad -> 90° corner = 17 vertices.
  - Large arcs (e.g. roundabout r = 20 m): maxStep 0.0566 rad -> full circle 111 vertices.
- Multiplicity: per junction corner (4 per X junction -> ~44-68 vertices of kerb return per plate outline, before the mesher extrudes kerb faces). 8 mm chord error is very fine for distant junctions; the ring is re-flattened on every `flatXY()`/`flatten()`/`bbox` (first call) call (`ring.ts:97` "worked out at each call") — CPU cost, no caching of vertices by design.

#### E3. Offset-polyline round joins (lane/kerb offsets of road centrelines)
- Location: `src/core/offset.ts:25-43` (`pushArc`), `offsetPolyline` :46-112, defaults `MITER_LIMIT = 4`, `ARC_TOL = 8 mm` (`scalar.ts:30,39`).
- Counts: output = n points (miter joins, collinear vertices dropped) plus, for joins whose miter exceeds 4·|d| (turns sharper than ~151°, cosHalf < 0.25) or full reversals, a round join of `max(1, ceil(sweep / 2acos(1-0.008/|d|)))` extra points (+2 bracketing points). E.g. |d| = 3.5 m half-width, 180° reversal: step 0.1352 rad -> 24 extra vertices.
- `pruneSelfIntersections` (:115-147) removes inner loops (O(m²) segSeg per offset chain).
- Multiplicity: per road offset line per level; vertices feed strip meshes built elsewhere.

#### E4. Building plan-shape outlines (the wall/roof polygon count of every editor-made mass)
- Location: `src/editor/buildingPlans.ts:27-43` (`shapePoints`), used by `shapeBody` :60-65, `setVolumePlan` :46-58 (outline vertex cap 3..64), primitives table :15-24.
- Vertex counts per outline (= number of wall faces per storey of that mass in the building mesher):
  - rectangle 4 (stored as no outline), L 6, U 8, chamfered 8, hexagon 6, octagon 8, cross 12, stepped (ziggurat) 20, **circle 24**.
  - Primitives: box 4 sides flat roof; cylinder = circle 24 sides flat; octagonal 8; prism/wedge/pyramid 4 sides with gable/shed/hip; **cone = 24-sided hip roof** (55°); crossBlock 12.
- Caps: `setVolumePlan` rejects > 64 vertices (:47); `changePlanVertex` refuses insert at >= 64 (:168); `bevelPlan` refuses > 64 (:115) — each bevel doubles the beveled corners (bevelAll on a 24-gon -> 48, on a cross 12 -> 24).
- Facade bays per side are clamped 1..64 on reshape (`buildingProfile.ts:73-74`); every bay is a window/door unit drawn by the facade mesher (outside chunk), so a 24-gon cylinder multiplies bays x 24 sides x storeys.
- Multiplicity: per editor-made volume (`MAX_VOLUMES` per building, defined outside chunk). Curved forms are explicit vertices by design (comment :26), so a round tower is 24 flat facets with 24 x storeys x bays facade units.

#### E5. Reference-model (glTF) to building conversion
- Location: `src/editor/fromReference.ts:31-74` (`blocksFromTriangles`), `buildFromReference` :82-220; wired from `src/buildingsWiring.ts:218-261` (`createReferenceModel(scene.scene, ...)` in `@render/buildings/referenceModel`, outside chunk; `reference.capture()` returns `triangles`).
- What it does with imported triangles: reads every triangle of the loaded glTF once on the CPU, keeps only upward faces (|nz|/|n| >= 0.98), merges them into roof "tops", convex-hulls each top (`convexHull` :235-251), keeps blocks >= 2 x 2 m and >= 2.5 m tall, and emits a procedural building (outline kept only if hull has > 4 points, :146, :232). The imported mesh itself is not kept in the city: it is replaced by procedural masses, i.e. a decimation by re-modelling. Colour sampling: 4 sides x 9 x 3 = 108 samples per storey window; facade 7 x 5 = 35 samples per bay (`sample` is a raycast/texture sampler outside the chunk).
- Note: the reference model is shown in the scene while loaded (overlay mesh, outside chunk); its triangle count is whatever glTF the player loads (no decimation here).

#### E6. Building preview / ghost / interior cut-away (rebuilt meshes, drawn by the renderer)
- Location: `src/editor/buildingTool.ts` — `BuildingPreview` :130-140 (`serial` "so the renderer can gate its rebuild"), `setPreview` :2570-2574 (bumps serial on every call), `showDraft` :2367-2373 (dedups via `samePlain`), `ghostAt` :2563-2568, `hoverPrimitive` :1106-1114 (dedups), `hoverElement` :1771-1807, `interiorPreview` :916-932 (cached by record/level/8-way view direction); handed to the renderer by `buildingsWiring.ts:1144` (`scene.setBuildingPreview`) every frame in `beforeDraw`, cut-away by `scene.setBuildingCutaway` :1139-1143.
- Geometry: a full building mesh (masses, facades, elements) rebuilt by the renderer whenever `serial` changes (mesher outside chunk). `name` prefix `building-preview` is counted as 'other' VRAM (`perfBudget.ts:77`).
- Notable: `hoverElement` (:1806) calls `setPreview` unconditionally on every pointer move while an element kind is armed — it does **not** go through the `samePlain` dedup that `showDraft`/`hoverPrimitive` use — so each pointer move with an armed element bumps `serial` and forces a full ghost-building rebuild, even when the pointer stays on the same bay. Also `updatePlanPreview` (:665-672) always sets a new preview (serial bump) per plan click/back-point (rare, fine). Interior view rebuilds only on level/8-sector direction change (good).

#### E7. Editor handles and overlays (2D canvas, not GPU triangles)
- `buildingTool.ts:291-318` (`handles()`: move, rotate, storeys, scale, lift, side arrows, vertex handles — vertex handles thinned to every 3rd when outline > 12 vertices, :305/:315-316), drawn by `drawBuildingOverlay` / `drawBuilderGrid` on a `CanvasRenderingContext2D` (`buildingsWiring.ts:1147-1186`, :976-979). Barrier tool plan line/dots (`barriers.ts:155-161`), bulldozer box (`bulldozer.ts:87-91`) likewise go to the 2D overlay. No WebGL geometry.
- `Ring.addToPath` (`ring.ts:190-201`) writes rings to a `Path2D` with exact arcs (2D canvas).

#### E8. Thumbnail studio (part gallery pictures)
- `buildingsWiring.ts:483-494`: `createThumbnailStudio(scene.gl)` (`@render/buildings/parts`, outside chunk) renders part thumbnails a few per frame, held only while the Builder is open (`studio.hold`, :1124). Geometry is the parts' own meshes, defined outside the chunk.

#### E9. Explosion / weapon effects requested (geometry built in renderer)
- `src/actionsWiring.ts`: per bomb, `scene.soot` blots `min(40, round(6 + radius/3 m))` (:375-380) — decals, radius `m(2.5 + strength·1.1)` (:230); `scene.explode`, `scene.strikeBuilding` (Voronoi fracture of a building's meshes, comment :264, deferred 4 buildings per frame :396-405), `scene.flingOccupants` (ragdolls), `scene.dropVehicle`, `scene.burn` 2 flames per burning building every 6 s sim time (:434-442, at most 3 buildings burning :416), `scene.sparkAt`/`leak` up to 2 per struck building (:276), `scene.geyser`, `scene.wound`, `scene.vehicleHit`, `scene.strikeGround`. All mesh/particle/decal construction is in `@render/*` (outside chunk). Soot decals are "kept" (comment :374) — they accumulate per blast (up to 40 each).
- Picking here is analytic (ray vs vehicle OBB slab test :163-178, ray-march 0.5 m steps down a building :463-470), no hit meshes.

#### E10. Building picking along a ray (no hit meshes)
- `buildingTool.ts:2688-2723` (`pickAlongRay`): walks the ray in 64 m steps (`PICK_STEP`) over the store grid, `pickBuilding` (outside chunk) intersects analytic volumes; no picking geometry on the GPU.

#### E11. City-generation / landscape population (counts that drive instance numbers elsewhere)
- `src/editor/cityGenerator.ts:46-62` (`greenCity`): adds every street-furniture piece (`furnitureFor`), power-line poles (`layPowerLines`), square trees (`doc.plantTrees`), paint dabs and one `streetname` landscape item per street name in bulk; comment :57 cites ~11 000 entries for the generated city. These become instanced trees/benches/lamps/poles/labels in renderer files (outside chunk). Footways widened to 3 m and planted 2 m medians (:31-43) widen road strips (more area, same vertex count).
- `blocks.ts:20-29` (`blockGridLines`): a grid of cols+rows+2 straight streets (2 points each).

#### E12. Facade element runs (repeated parts per building)
- `buildings.ts:1103-1125` (`opRepeatElement`): up to 63 copies each way (126 per call) of a free element (pillar, canopy...) along a facade, stopping at the footprint or a clash.
- `buildingTool.ts:1678-1753` (`finishElementRun`): one element (wall/fence/pavement/stair box) per traced path segment >= 0.4 m.
- `buildingTool.ts:2069-2078`, `buildings.ts:186-239` wings, `:242-276` setbacks: each adds a whole volume (more facades).

#### E13. Welded buildings keep overlapping masses (hidden internal faces)
- `buildings.ts:805-860` (`weldInto`): when a placed/dragged building touches others, their volumes are copied into the draft unchanged; comment :858 "Nothing is cut: the blocks of both buildings stay whole, overlapping where they overlap". Also `addPlanMass` "A block added to the building: whole, overlapping or not" (`buildingTool.ts:650`), and `copyBlock` (:872-888). Unless the mesher performs boolean merging (outside chunk; `Volume.mode` void/intersect/xor exists), overlapping solids leave coincident/internal wall and roof faces that are drawn (and shadow-cast) for nothing.

#### E14. Terrain craters / road tunnels set by edits (inputs to terrain & road meshes)
- `actionsWiring.ts:344-347`: each bomb on bare earth adds a terrain stamp (radius `0.5·blast radius`), changing terrain mesh tiles (outside chunk).
- `commit.ts:214-251` (`boreDeepCuts`): samples new roads every ~3.2 m and turns them into tunnels when cover > `ROAD_TUNING.tunnel.autoCover` — switches the road's mesh type (tunnel geometry built elsewhere).

#### E15. Dry-run road stations (draft preview samples)
- `commit.ts:60` `STATION_STEP = m(2)`, `draftStations` :254-277: one station every 2 m along the drafted road for the tool's live preview (consumer outside chunk, probably drawn as the draft ribbon/profile). Recomputed per dry run (pointer at rest), reused at the click (`lastDryRun`, :96-100).

### Budgets, caps and counters found

- **Triangle / draw-call budgets per view** — `src/core/perfBudget.ts:44-48` `VIEW_BUDGETS` (colour + shadow passes, one frame, `renderer.info.render`):
  - street: 16 000 000 triangles, 1 000 draw calls (700 colour + 300 shadow), GPU p95 12 ms, >= 60 fps
  - district: 16 000 000 triangles, 1 100 draw calls (800 + 300), 12 ms, >= 60 fps
  - map: 8 000 000 triangles, 400 draw calls (300 + 100), 12 ms, >= 50 fps
  - Comment :43: measured at full facade level on a dedicated GPU 2026-10-16: district 13 M, street 5.4 M, map 4.9 M; "at 8 M the district view fell to masses"; levels' error scale rises until the frame fits (`buildings/frameBudget.ts`, outside chunk).
- **GPU memory budgets per group** — `perfBudget.ts:54-68` (MB, plan §8.6, city of 80 000 buildings): L0 shells 300, L0 building parts 150, L1 masses 120, L2 tiles 60, L3 plates 15, roads/poles-and-wires/terrain/vegetation/people-and-vehicles no budget, other 0. Textures 600 MB, render targets + shadow maps 300 MB, JS heap 1 500 MB (:71-73). Group by mesh name `memoryGroup` :76-87 (prefixes building-shell, building-massing, building-*, asphalt|footway|kerb|verge|curb-ramp|median-|markings-|road, utility-, terrain-|flat-world, garden-|far-forest|forest|tree|grass|woods|far-woods, citizen-|car-|bus-|truck-|vehicle|male-|female-). `cityBudgetTable` :126-166 reports rows.
- **Step time budgets** — `perfBudget.ts:15-26` (e.g. `draw/Render` 100 ms CPU, `draw/Rebuild` 200 ms).
- **Profiler counters** — `src/core/profiler.ts:4-6, 141-155`: counts `build.geometry`, `upload.buffer` (bytes), `upload.texture`, `dispose.geometry|material|texture|target` per frame/second/total with call sites; `gauges` map (:129) filled by the renderer (draw calls, geometries on GPU).
- **Dynamic resolution** — `src/core/dynamicResolution.ts:8` pixel-ratio steps 1, 0.9, 0.8, 0.7, 0.6, 0.5 (fill-rate, not triangles), p90 over 30 frames, aim 85% of budget.
- **GPU tier** — `src/core/gpuTier.ts` maps renderer string to low/medium/high/ultra (quality presets that change geometry live elsewhere). Weak-machine preset UHD 770 (`weakMachine.ts:15`).
- **Tessellation caps/tolerances** — `FLATTEN_TOL` 2 cm, quad steps 1..64 (`bezier.ts:42`); `ARC_TOL` 8 mm (`scalar.ts:39`); `MITER_LIMIT` 4; `MIN_RIBBON` 0.2 m, `SEAM_OVERLAP` 0.1 m ("a ribbon overlaps into its junction so nonzero fill hides the seam": deliberate overlapping road/junction triangles, `scalar.ts:44-48`); `SURFACE_END_STEP` per nested surface level.
- **Building caps** — outline 3..64 vertices (`buildingPlans.ts:47,115,168`), bays per side 1..64 on reshape (`buildingProfile.ts:73`), inspector bays field 1..40 (`buildingsWiring.ts:860`), storeys field 1..60 (`:815`), `opRepeatElement` <= 63 per direction (`buildings.ts:1115`), roof detail sizes (`buildingRoofs.ts:7-10`: solar 3x2 m, skylight 2x1.5, vent 1x1, chimney 1x1, water tank 2.2x2.2, spire 1.5x1.5 h 11.7 m, lantern 4x4 h 19.4 m).
- **Effects caps** — soot blots <= 40 per blast, burning buildings <= 3, deferred fractures 4 per frame (`actionsWiring.ts:375, 416, 398`).
- **Save tiles** — `SAVE_TILE = m(1024)` (`chunkedSave.ts:28`), buildings/lots by `CELL` (not geometry).
- **Health** — `LONG_FRAME_MS = 50` (`health.ts:123`), frame records kept 30 s / 4096 (`:139-141`); `STUTTER_MS` 2/59 s (`sampleRing.ts:69`).

### Files without geometry

All 78 files contain no GPU geometry. Those that also have no geometry-sizing role (pure infrastructure):
- `src/`: bayPool.ts, bays.worker.ts, cityGen.worker.ts, conflictPool.ts, conflictTable.worker.ts (worker pools for parking bays / traffic conflict tables / city generation), desktopJobs.ts, desktopSaves.ts, desktopShown.ts (Electron bridges).
- `src/core/`: aabb.ts, arrayPack.ts, assert.ts, axisCut.ts (2D polygon cutter, CPU), changeLog.ts, clipper.ts (2D boolean ops on a 0.04 mm grid, CPU), commands.ts, derivedCache.ts (IndexedDB cache; `WriteBudget`), digest.ts, engine.ts, events.ts, forkMap.ts, gameState.ts, health.ts, heap.ts, hitch.ts, hypot.ts, idSlots.ts, identityMemo.ts, intersect.ts, keptList.ts, minMax.ts, plain.ts, polygon.ts, polygonBands.ts, polyline.ts (CPU polyline queries; CHUNK/GROUP 16 boxes), recentCache.ts, recordMap.ts, regionIndex.ts (point-in-region grid, CPU), rerootMap.ts, rng.ts, runPool.ts, sampleRing.ts, statechart.ts, units.ts, vec2.ts, weakMachine.ts, weightedSlots.ts.
- `src/editor/`: blueprintLibrary.ts, buildingFacade.ts (re-export), buildingFloors.ts, buildingSnap.ts, bulldozer.ts, chunkedSave.ts, cloudTool.ts (edits cloud records; cloud meshes elsewhere), cookedCities.ts, editRules.ts, editStream.ts, gameKeys.ts.
- Geometry-sizing but not geometry-creating (covered above): core/bezier.ts, core/ring.ts, core/offset.ts, core/fillet.ts, core/scalar.ts, core/perfBudget.ts, core/profiler.ts, core/dynamicResolution.ts, core/gpuTier.ts, actionsWiring.ts, buildingsWiring.ts, editor/buildingPlans.ts, buildingProfile.ts, buildingRoofs.ts, buildingTool.ts, buildings.ts, blocks.ts, barriers.ts, cityGenerator.ts, commit.ts, fromReference.ts.

---

## Polygon geometry audit — chunk g01

Chunk: editor tools/saves, root wiring files (effects, graphics, frame loop, growth, jobs), the debugging lab (code, doctor, gpu, inspector).
Headline: almost nothing in this chunk builds GPU geometry itself. It (a) produces the *data* other modules turn into overlay or preview meshes (lot overlay, road/pole/track drafts), (b) holds the only two real three.js objects here (the inspector's two `Box3Helper` outlines and the lab's debug-view materials), and (c) holds the triangle counters, budgets and switches the lab and the effects panel use.

### Files read

Every file was read in full with Read (line counts from `wc -l`):

| File | Lines |
|---|---|
| src/editor/growthFeed.ts | 353 |
| src/editor/growthReplica.ts | 290 |
| src/editor/history.ts | 192 |
| src/editor/lotTool.ts | 874 |
| src/editor/mapExport.ts | 46 |
| src/editor/nodeMover.ts | 120 |
| src/editor/persistence.ts | 662 |
| src/editor/poleRoutes.ts | 198 |
| src/editor/poles.ts | 515 |
| src/editor/preparedCity.ts | 84 |
| src/editor/regionFrames.ts | 68 |
| src/editor/repair.ts | 72 |
| src/editor/roadParking.ts | 40 |
| src/editor/roadPath.ts | 108 |
| src/editor/roadTool.ts | 599 |
| src/editor/roadTop.ts | 93 |
| src/editor/roads/economy.ts | 22 |
| src/editor/roads/powerLine.ts | 94 |
| src/editor/roads/profile.ts | 34 |
| src/editor/roads/streetKit.ts | 90 |
| src/editor/roundabout.ts | 85 |
| src/editor/save.worker.ts | 23 |
| src/editor/saveBinary.ts | 108 |
| src/editor/saveStore.ts | 156 |
| src/editor/smallCityMap.ts | 113 |
| src/editor/snap.ts | 424 |
| src/editor/storeTurns.ts | 44 |
| src/editor/streetObjects.ts | 105 |
| src/editor/streetscapeTool.ts | 154 |
| src/editor/terrainBrush.ts | 265 |
| src/editor/toolMachine.ts | 85 |
| src/editor/transitTools.ts | 249 |
| src/editor/workerParts.ts | 92 |
| src/effectsWiring.ts | 303 |
| src/fieldReport.ts | 210 |
| src/frameLoop.ts | 125 |
| src/globals.d.ts | 7 |
| src/graphicsWiring.ts | 290 |
| src/growth.worker.ts | 17 |
| src/growthPool.ts | 86 |
| src/job.worker.ts | 94 |
| src/jobs/jobPool.ts | 693 |
| src/jobs/jobScope.ts | 19 |
| src/jobs/nodeJobHost.ts | 38 |
| src/jobs/processWorker.ts | 191 |
| src/lab/code/aggregate.ts | 177 |
| src/lab/code/analysis.ts | 137 |
| src/lab/code/codeTab.ts | 263 |
| src/lab/code/coverageTab.ts | 172 |
| src/lab/code/declared.ts | 61 |
| src/lab/code/index.ts | 42 |
| src/lab/code/sampler.ts | 129 |
| src/lab/code/sourceMap.ts | 140 |
| src/lab/code/sourceStore.ts | 138 |
| src/lab/code/state.ts | 61 |
| src/lab/code/viewer.ts | 97 |
| src/lab/doctor/findings.ts | 210 |
| src/lab/doctor/index.ts | 235 |
| src/lab/doctor/measure.ts | 167 |
| src/lab/gpu/caps.ts | 50 |
| src/lab/gpu/controller.ts | 294 |
| src/lab/gpu/dom.ts | 37 |
| src/lab/gpu/frameTab.ts | 120 |
| src/lab/gpu/index.ts | 35 |
| src/lab/gpu/memory.ts | 149 |
| src/lab/gpu/objectsTab.ts | 147 |
| src/lab/gpu/passTimer.ts | 158 |
| src/lab/gpu/passesTab.ts | 149 |
| src/lab/gpu/probe.ts | 224 |
| src/lab/gpu/programs.ts | 79 |
| src/lab/gpu/views.ts | 171 |
| src/lab/icons.ts | 74 |
| src/lab/inspector/consoleTab.ts | 188 |
| src/lab/inspector/describe.ts | 213 |
| src/lab/inspector/dom.ts | 155 |
| src/lab/inspector/edit.ts | 260 |
| src/lab/inspector/entity.ts | 219 |
| src/lab/inspector/index.ts | 65 |
| src/lab/inspector/inspectorTab.ts | 146 |
| src/lab/inspector/pick.ts | 191 |
| src/lab/inspector/raycast.ts | 217 |
| src/lab/inspector/related.ts | 131 |
| src/lab/inspector/relatedView.ts | 132 |
| src/lab/inspector/sceneTab.ts | 142 |
| src/lab/inspector/sections.ts | 193 |
| src/lab/inspector/state.ts | 208 |
| **Total (86 files)** | **14,706** |

Nothing was left unread. Files outside the chunk that I opened only to pin down a number:
- `node_modules/three/src/helpers/Box3Helper.js` (lines 1-60): the Box3Helper vertex and index counts. I also confirmed three r186 in `constants.js`.
- `node_modules/three/src/renderers/webgl/WebGLGeometries.js` (`updateWireframeAttribute`): how the wireframe index is built.
- `src/render/gpuLedger.ts` (`geometryCost`, lines 73-85): the triangle formula the inspector uses.
- `src/render/mesh/gpuOnly.ts` (grep only, lines 17-28): it confirms that `array = null` after upload.

### Elements

#### E1. Lot overlay shapes (Zoning tool and faint zones): data that feeds `render/lotOverlay.ts`
- **What:** each lot's outline and fill, its front edge and an arrow, its corner dots, the proposed street-land lots, and the gesture in progress (a polygon being drawn, a cut line, a curved side, the snap point, a drawn rectangle).
- **Where:** `src/editor/lotTool.ts`. `LotOverlay` interface at 49-56. `LotOverlayBook` at 87-114. `overlay()` at 621-633. `drawAllLots` at 690-693. `drawLot` at 696-735. `refreshProposal` at 744-788. `refreshGesture` at 791-855. The mesh is built in `render/lotOverlay.ts`, which is outside this chunk and not read.
- **Primitive and counts per group** (the triangulation is the consumer's):
  - Lot group: 1 polygon of `corners.length` vertices (fill plus outline, width 0.35 or 0.7). In editing mode it adds 1 front line and, when the front is at least 2 m long, 3 arrow lines (4 segments in total). In `edit` mode it adds 1 point per corner (radius 0.6).
  - Proposal group (one per proposed lot): 1 polygon (outline 0.25, fill only when painted or hovered).
  - Gesture group: up to 16 line segments for a quadratic curved side (fixed `k <= 16`, line 817), the cut lines `cutLines()` returns for the split preview, one line per polygon edge, one point per polygon corner, and 1 snap point. The drawn rectangle is clipped to land by `onLand`, giving 1 polygon.
- **Multiplicity:**
  - Zoning tool open: one group per lot in the map plus one per proposed lot.
  - Other tools: only zoned, unbuilt lots (`drawLot` line 700). While the city grows, the overlay is frozen (`holdOverlay`, line 166; checked at line 624).
  - Groups are re-put only when something changed (journal cursor, hover, stroke, dragged corner). `drawAllLots` rebuilds every group on mode change, use change, map load or an unplaceable diary entry. That is O(lots) work (tagged `@rebuild`).
- **Performance notes:**
  - The proposal can hold every street-land lot of the region, and each is its own group. Large cities can therefore push many small groups into the overlay; how the consumer batches them was not checked here.
  - Ranks are capped below 2^29 (`PROPOSAL_RANK` is 2^28).

#### E2. Road draft preview (road tool): data
- **What:** the road being dragged, the next stretch of a chain, a curve waiting for its bend, and the road just laid, which stays drawn "as previewed" until the network is rebuilt.
- **Where:** `src/editor/roadTool.ts` `preview()` at 517-531 and `pieces()` at 534-544; `src/editor/roadPath.ts` `roadPathFromGesture` at 67-107. The mesh is made by the overlay or renderer, which is outside this chunk.
- **Counts:**
  - Freehand stroke samples are capped at `MOST_SAMPLES` = 4096; past `DENSE_SAMPLES` = 256, only one sample per metre is kept (`pushSample`, lines 590-599).
  - The path is simplified to at most `MAX_CONTROLS` = 48 control points (`roadPath.ts`, line 19), giving at most 47 quadratic pieces.
  - Straight and curve modes give 1 piece.
- **Multiplicity:** one draft at a time. `verdict()` runs the dry-run commit once the draft has rested for 120 ms (`VERDICT_DELAY`), so a draft is not judged on every pointer move.

#### E3. Pole run preview (pole tool): data
- **What:** the planned poles and spans of a distribution line drawn "in 3D" (`marks()` comment, line 505), plus the remove or snap marks.
- **Where:** `src/editor/poles.ts` `PoleTool.plan()` at 437-449, `marks()` at 506-514, `computePoleRun` at 275-365. The route graph is in `poleRoutes.ts`.
- **Counts:** about one pole per spacing step along the route. Spacing is clamped between `MIN_POLE_SPACING` and `MAX_POLE_SPACING` (defined in world/utilities, not read); poles are at least `MIN_POLE_GAP` = 10 m apart.
- **Multiplicity:** one plan per frame while dragging. The last plan is cached in `lastPlan` (lines 251-257), so a still pointer does not recompute it. Pole and span meshes are built elsewhere.

#### E4. Transit track preview and 2D transit overlay
- **What:**
  - `preview()` (lines 176-179) returns the track points; the scene builds them as real track (outside this chunk).
  - `draw()` (lines 188-243) uses Canvas2D, not GPU triangles: per stop, one arc (radius 6 or 8 px) or one 14×14 rect plus a letter; per line, one polyline through its stops; one 4 px dot per draft point; one dashed-style polyline for the line being made.
- **Where:** `src/editor/transitTools.ts`.
- **Multiplicity:** every stop and line is drawn on each overlay redraw. This is Canvas2D, with no GPU geometry.

#### E5. Streetscape placement row: data
- **What:** the hover ring and the row of pieces dragged out along a footway.
- **Where:** `src/editor/streetscapeTool.ts` `rowPieces` at 118-141.
- **Counts:** at most 200 pieces in a row (`k <= 200`, line 130). Drawing happens elsewhere.

#### E6. Roundabout: network geometry generated
- **What:** a single-lane roundabout.
- **Where:** `src/editor/roundabout.ts` `commitRoundabout` at 39-85.
- **Counts:**
  - 8 ring nodes with 8 curved ring segments (`shapeFromControl`, π/4 apart).
  - 4 approach nodes with 4 straight two-lane approach segments, each 40 m long.
  - In total 12 segments, all of which become road, ribbon and junction meshes downstream.
  - Radius is 32-128 m.

#### E7. Node drag preview (network rebuild throttle)
- **Where:** `src/editor/nodeMover.ts`, lines 22-23 and 64-68.
- **What:** while a node is dragged, the network (and so the road meshes) is rebuilt no more often than every `max(50 ms, 1.6 × the last rebuild's cost)`. This is a cap on geometry rebuild frequency, not geometry itself.

#### E8. Terrain brush dabs, which trigger terrain, tree and element mesh updates
- **Where:** `src/editor/terrainBrush.ts` `stampTerrain` at 59-138 and `paint` at 222-252.
- **Caps:**
  - At most 12 dabs per pointer event (line 243).
  - Dabs are at least 45 ms apart (`TERRAIN_MIN_MS`, line 15), or the host's `interval()`.
  - Dab spacing is `max(1.6 m, 0.2 × radius)`.
  - Each dab adds a terrain stamp, or scatters elements or trees (instances drawn elsewhere), or adds paint, fog or gully dabs.
  - A per-tile cap may refuse a dab ("decision 5.1", line 58).

#### E9. Inspector selection and hover outlines: `Box3Helper` × 2 (the only three.js mesh built in this chunk)
- **What:** the box outline around the selected object (colour 0x2fc2ab) and around the object under the picker's cursor (0xffc35a).
- **Where:** `src/lab/inspector/pick.ts` `createHighlight` at 39-71. One instance for the selection (`index.ts` line 17) and one for hover (`pick.ts` line 83).
- **Primitive:** `LineSegments`, indexed.
- **Counts each:**
  - 8 vertices × `position` Float32 × 3 = 96 B.
  - Index `Uint16Array` of 24 entries = 48 B.
  - 12 line segments, 0 triangles (`Box3Helper.js` r186).
- **Multiplicity and settings:**
  - 2 objects, added to the scene lazily on the first `show`, and only visible while there is a selection or hover.
  - `depthTest` and `depthWrite` are off, `transparent` is on, `renderOrder` is 1e6 and `frustumCulled` is false.
  - Lines cast no shadows. One draw call each while visible.
- **Notes:**
  - Negligible cost.
  - `dispose` frees both the geometry and the material, but `dispose` is never called for the two instances created in `index.ts` and `pick.ts`. They live as long as the lab, which is fine.

#### E10. Lab debug views: per-material stand-ins, three's wireframe index, checker override
- **Where:** `src/lab/gpu/views.ts`. Stand-ins at 101-130, `substitute` at 152-162, `checkerTexture` at 32-62. Hooked through the probe's draw wrapper in `probe.ts` at 104-121.
- **Wireframe:**
  - Each scene-pass material gets a stand-in with `wireframe = true`. three r186 `WebGLGeometries.updateWireframeAttribute` then builds a line index with 6 entries per triangle (a,b,b,c,c,a): 2 × the original index count, as Uint16 or Uint32, cached per geometry.
  - Effective GPU memory for indices therefore doubles for every geometry drawn while the view is on.
  - Draws become `LINES`, with 3 lines per triangle.
- **Overdraw and normals:** same geometry, but a new program per material (`customProgramCacheKey` + `|lab:<view>`). Overdraw uses additive blending, depth func Always (Never on a reversed-depth buffer), and keeps depth writes on.
- **UV and mips:** one `MeshBasicMaterial` override over the scene (`scene.overrideMaterial`) with a checker `DataTexture`: 256² for UV and 512² for mips, with the full mip chain given (about 349 KB for 512² RGBA8). This is a texture, not geometry.
- **Possible issue (found by reading only, not run):**
  - The wireframe view on a geometry whose arrays were released after upload (`render/mesh/gpuOnly.ts` sets `array = null`, lines 17-18) reaches three's `updateWireframeAttribute`, which reads `geometryIndex.array.length` (or `position.array.length`).
  - With `array === null` that throws inside `renderBufferDirect`.
  - Roads and buildings, which the inspector says "let their arrays go", are likely to hit this. `substitute` (line 154) only excludes non-recolourable materials, and only for views other than wireframe.

#### E11. Lab GPU probe: per-draw triangle, line, point and vertex counter
- **Where:** `src/lab/gpu/probe.ts` `draw` wrapper at 104-121 and `record` at 155-187.
- **What:**
  - Per draw, triangles, lines and points are the change in `renderer.info.render` across the call.
  - Vertices are `max(0, min(indexCount or positionCount, drawRange.count) - drawRange.start) × instances`.
  - Instances come from `InstancedMesh.count`, or for a `BatchedMesh` from `_multiDrawCount ?? instanceCount`.
  - Layer is the top group, or the top two levels, under the scene. A draw with no parent is labelled `quad: <pass>`, which covers the composer's fullscreen quads.
- **Multiplicity:** only installed while capture, live layers, timing or a debug view is on (`update`, 196-213).
- **Note:** for a BatchedMesh the vertex figure uses the whole geometry's index count times the multi-draw count, so it overstates. It is a display figure only.

#### E12. Lab triangle counters (inspector)
- **`trianglesUnder`** (`describe.ts`, 201-213): for each `isMesh` in the subtree, `floor(min(indexCount or positionCount, drawRange.count) / 3) × (InstancedMesh.count or 1)`. It ignores `drawRange.start`, `BatchedMesh` multi-draw ranges, lines and points, and counts hidden objects too.
  - Used by the Scene tab for every row (`sceneTab.ts` 25-30, cached per draw of the tree) and by `objectSection`.
  - Cost: on the root row, the Scene tab walks the whole scene once per redraw.
- **`geometryCost`** (`render/gpuLedger.ts` 73-85, used by `geometrySummary`): `floor(index count or position count / 3)`. No drawRange, no instances.
- **`attributeRows`** (`describe.ts`, 76-92): per attribute `itemSize`, `count`, array type, byte length, whether the array is still on the CPU, interleaved or not. Index and morph targets are included. This is where per-vertex bytes can be read live.

#### E13. Lab GPU objects scan: geometry bytes
- **Where:** `src/lab/gpu/memory.ts` `scanGpuObjects` at 60-149.
- **What:**
  - Per unique geometry: attribute count, vertices (`position.count`), indices, and bytes (array byte length, or `keptBytes` for released arrays).
  - A shared buffer is counted once.
  - Holder and user count are reported.
- **Note:** this is a statistic, not geometry. It walks the whole scene and every material's fields, so it is O(scene). It runs on demand only.

#### E14. Lab inspector geometry edit: `drawRange`
- **Where:** `src/lab/inspector/edit.ts` `geometryEditor` at 249-260.
- **What:** live editing of `drawRange.start` and `drawRange.count` (step 3) over `0..indexCount` (or position count). The only place in the chunk that changes what part of a geometry is drawn, and it is debug only.

#### E15. Lab ray picking (no geometry; CPU triangle tests)
- **Where:** `src/lab/inspector/raycast.ts` `hitsAlong` at 90-130 and `boundsHits` at 62-87.
- **What:**
  - three's `raycast` runs on every visible mesh whose arrays are still on the CPU.
  - Otherwise each instance's bounding box is tested. That is a loop over all `InstancedMesh.count` instances with a `getMatrixAt` call each, so it is O(instances) per pick.
  - Hover picks are limited to one per 70 ms (`pick.ts` line 13).

#### E16. Doctor layer statistics
- **Where:** `src/lab/doctor/findings.ts` `layersOf` at 79-94 and `findingsOf` at 96-210.
- **What:**
  - Sums triangles, calls, instances and shadow triangles per layer from one captured frame.
  - A fullscreen pass is recognised as `layer` starting with `quad:` or as having 2 triangles or fewer (`isQuad`, line 63), and is excluded.
  - Shadow draws are recognised by `/shadow|sun|cascade/` in the target or pass name.
  - A layer is reported when it has at least 8 % of triangles or at least 12 % of draws.
  - The shadow finding fires when shadow triangles exceed 20 % of the total.

### Budgets, caps and counters found

| Item | Value | Location |
|---|---|---|
| Draw-call budget per view (doctor) | 1000 (medium severity above 1500); cost estimate 0.004 ms per extra draw | `lab/doctor/findings.ts` 152-160 |
| Frame budget | 16.67 ms (60 fps); `verdictOf` calls GPU-bound or CPU-bound above 85 % of it | `findings.ts` 57, 67-74 |
| Layer report thresholds | at least 8 % of triangles or 12 % of draws; shadow triangles above 20 % | `findings.ts` 122, 142 |
| Fullscreen-quad detection | 2 triangles or fewer, or layer `quad:*` | `findings.ts` 63; `probe.ts` 131 |
| Building triangle-share switch (effects panel) | `bTriangles` ∈ {1, 0.5, 0.25, 0.1, 0.02, 0} (consumer in `@render/effectSwitches`, not read) | `effectsWiring.ts` 18 |
| Building detail memory switch | `bDetailMemory` ∈ {-1, 1024, 512, 256, 128, 32, 0} MB | `effectsWiring.ts` 19 |
| Building material switch | normal / lambert / basic | `effectsWiring.ts` 17 |
| Effects-panel stats shown | `scene.stats.drawCalls`, `scene.stats.drawnTriangles`, `gl.info.memory.geometries`, programs, building detail bytes | `effectsWiring.ts` 193-219 |
| Shadow map sizes allowed | 0 / 1024 / 2048 / 4096 | `graphicsWiring.ts` 72 |
| Quality tier and auto governor | `QUALITY[level]` from `@render/quality` (not read); `auto` never climbs above the GPU's tier | `graphicsWiring.ts` 85-98, 213-224 |
| VRAM cap check | finding when `gpuLedger.bytes()` exceeds 80 % of `gpuLedger.cap` | `findings.ts` 193-201 |
| Freehand road samples | 256 dense, then 1 per metre, at most 4096 | `roadTool.ts` 590-599 |
| Freehand road control points | at most 48 (so at most 47 quadratic pieces) | `roadPath.ts` 19 |
| Curved lot side preview | 16 segments | `lotTool.ts` 817 |
| Brush or erase steps per pointer move | at most 400 samples at 2 m | `lotTool.ts` 509, 525 |
| Lot cut test samples | 21 samples plus edge intersections | `lotTool.ts` 860-874 |
| Streetscape row | at most 200 pieces | `streetscapeTool.ts` 130 |
| Terrain dabs | at most 12 per event, at least 45 ms apart | `terrainBrush.ts` 15, 243 |
| Node-drag network rebuild | at most one per max(50 ms, 1.6 × rebuild ms) | `nodeMover.ts` 23, 64-68 |
| Roundabout | 8 ring + 4 approach segments, radius 32-128 m | `roundabout.ts` 10-12, 58-78 |
| Growth batch | at most 32 buildings per worker ask (`BATCH_MOST`); each is meshed after it is written | `growthReplica.ts` 106 |
| Growth region | ±160 m around the lot, read pad 48 m, miss margin +32 m, at most 4 misses | `growthFeed.ts` 47-56 |
| Pole route search | margin 96 m doubling up to 4096 m; planner tiles of 4 cells; stations every 2 m | `poles.ts` 104-108, 152; `poleRoutes.ts` 31 |
| Job pool size | `min(cores-2, floor(4 GiB × share / 170 MB))` with share 1/5 in a browser and 2/5 on desktop; page room assumes 600 MB per worker | `jobs/jobPool.ts` 8-13, 263-282 |
| Geometry job ordering | waiting jobs (cells, road tiles, ...) ranked by priority plus distance to the view focus; re-ranked after the view moves 64 units; lanes may not queue behind more than 8 in-flight messages | `jobPool.ts` 72, 400, 542-553 |
| Lab capture | gives up after 60 frames | `lab/gpu/controller.ts` 96 |
| Lab pass timer | 240 frames kept, 512 queries | `lab/gpu/passTimer.ts` 36 |
| Scene tab | 300 children per node, 500 filter hits | `lab/inspector/sceneTab.ts` 12-13 |
| Undo history | 60 steps and 96 MiB of patches (not geometry) | `editor/history.ts` 20 |

### Files without geometry

These files neither make GPU primitives nor size, transform or count them. At most they move map data or do UI and tooling work. Items marked "data" pass coordinates to a renderer outside this chunk.

- **src/editor/:**
  - growthFeed.ts, growthReplica.ts: growth sync; only the batch cap above.
  - history.ts, mapExport.ts, persistence.ts.
  - poleRoutes.ts: CPU route graph.
  - preparedCity.ts, regionFrames.ts, repair.ts, roadParking.ts, roadTop.ts.
  - roads/economy.ts, roads/powerLine.ts (lays poles in the document), roads/profile.ts, roads/streetKit.ts.
  - save.worker.ts, saveBinary.ts, saveStore.ts, smallCityMap.ts.
  - snap.ts: CPU snapping; reads polylines.
  - storeTurns.ts, streetObjects.ts (crossing and U-turn network edits), toolMachine.ts, workerParts.ts.
  - Data or caps only (listed under Elements): lotTool.ts (E1), roadTool.ts and roadPath.ts (E2), poles.ts (E3), transitTools.ts (E4, Canvas2D), streetscapeTool.ts (E5), roundabout.ts (E6), nodeMover.ts (E7), terrainBrush.ts (E8).
- **src/ (root):**
  - fieldReport.ts, frameLoop.ts, globals.d.ts, growth.worker.ts, growthPool.ts.
  - job.worker.ts: only lists the geometry-building worker services (cells, fracture, roadTiles, roadCoarse, roadFar, roadStations, groundShape, flatGround, peopleLod, citizenBake, garmentPadding, ecology, terrainLight, landStroke, derivedWriter). These are pointers for the chunks that own those files.
  - effectsWiring.ts and graphicsWiring.ts: switches and stats only (see Budgets).
- **src/jobs/:** jobPool.ts (scheduling only, see Budgets), jobScope.ts, nodeJobHost.ts, processWorker.ts.
- **src/lab/code/:** all 11 files (aggregate, analysis, codeTab, coverageTab, declared, index, sampler, sourceMap, sourceStore, state, viewer). JS profiling and source maps only.
- **src/lab/doctor/:** index.ts and measure.ts (UI and measurement). findings.ts only has the counters and thresholds (E16).
- **src/lab/gpu/:**
  - No geometry: caps.ts, dom.ts, frameTab.ts, index.ts, objectsTab.ts, passTimer.ts, passesTab.ts, programs.ts, controller.ts (aggregation of draw records).
  - Counters or debug only: probe.ts (E11), memory.ts (E13), views.ts (E10, materials and textures, plus three's wireframe index).
- **src/lab/:** icons.ts (SVG UI icons, not WebGL).
- **src/lab/inspector/:**
  - No geometry: consoleTab.ts, dom.ts, entity.ts, index.ts (creates the E9 highlight), inspectorTab.ts, related.ts, relatedView.ts, state.ts.
  - Counters or debug only: describe.ts (E12), edit.ts (E14), raycast.ts (E15), sceneTab.ts (E12), sections.ts.
  - Real three.js line geometry: pick.ts (E9).

---

## Polygon geometry audit - chunk g02

Scope: the debugging lab (`src/lab/**`), `src/main.ts`, `src/networkBake.worker.ts`, the people data layer (`src/people/**`) and the Person Creator lab (`src/peopleLab/**`, the files in the list only).

### Files read

Every file below was read completely, first line to last (long files in sequential chunks: `src/main.ts` in 8 chunks of 600-650 lines up to line 4288).

| File | Lines |
|---|---|
| src/lab/investigate.ts | 292 |
| src/lab/lab.ts | 140 |
| src/lab/labTypes.ts | 90 |
| src/lab/optimizations/index.ts | 222 |
| src/lab/recorder/analysis.ts | 289 |
| src/lab/recorder/deliver.ts | 72 |
| src/lab/recorder/index.ts | 355 |
| src/lab/recorder/recording.ts | 241 |
| src/lab/recorder/report.ts | 262 |
| src/lab/recorder/timeline.ts | 89 |
| src/lab/resources/collector.ts | 448 |
| src/lab/resources/consumers.ts | 113 |
| src/lab/resources/diagnostics.ts | 278 |
| src/lab/resources/index.ts | 65 |
| src/lab/resources/meter.ts | 206 |
| src/lab/resources/overview.ts | 297 |
| src/lab/table.ts | 216 |
| src/lab/tabs.ts | 32 |
| src/lab/tests/benchmarks.ts | 276 |
| src/lab/tests/index.ts | 281 |
| src/lab/tests/items.ts | 102 |
| src/lab/tests/measure.ts | 251 |
| src/lab/tests/probes.ts | 135 |
| src/lab/tests/sweep.ts | 182 |
| src/lab/usage.ts | 135 |
| src/lab/window.ts | 364 |
| src/main.ts | 4288 |
| src/networkBake.worker.ts | 43 |
| src/people/body/assets.ts | 97 |
| src/people/body/expressions.ts | 42 |
| src/people/body/macro.ts | 114 |
| src/people/body/morph.ts | 411 |
| src/people/body/proxy.ts | 205 |
| src/people/hair/procedural.ts | 638 |
| src/people/phenotype.ts | 34 |
| src/people/roster.ts | 129 |
| src/people/spec.ts | 360 |
| src/people/wardrobe.ts | 116 |
| src/peopleLab/bodyFit.ts | 43 |
| src/peopleLab/bodySculpt.ts | 211 |
| src/peopleLab/bodySculptPanel.ts | 41 |
| src/peopleLab/build.ts | 200 |
| src/peopleLab/choices.ts | 111 |
| src/peopleLab/clothStyle.ts | 111 |
| src/peopleLab/direct.ts | 190 |
| src/peopleLab/dress.ts | 40 |
| src/peopleLab/faceRig.ts | 110 |
| src/peopleLab/groom.ts | 323 |
| src/peopleLab/hairShape.ts | 99 |
| src/peopleLab/handDrag.ts | 194 |
| src/peopleLab/history.ts | 63 |
| src/peopleLab/icons.ts | 96 |
| src/peopleLab/main.ts | 779 |
| src/peopleLab/navigation.ts | 59 |
| src/peopleLab/panels.ts | 321 |
| src/peopleLab/picker.ts | 90 |
| src/peopleLab/polish.ts | 295 |
| src/peopleLab/pose.ts | 171 |
| src/peopleLab/posePanel.ts | 126 |
| src/peopleLab/posing.ts | 376 |
| **Total (60 files)** | **15,959** |

Nothing was left unread.

Followed outside the list only to resolve numbers (said where used):
- `public/models/people/base.json` / `base.bin`, `targets-macro-pca.json`, `targets-local.json`, `faceunits.json`, `skeleton-game-engine.json`, `proxies/*.json`, `proxies/community.json`: headers and section counts read with a small Node script (vertex/face counts, per-proxy triangle counts).
- `src/core/perfBudget.ts` lines 41-48 (`VIEW_BUDGETS`).
- A grep for `generateHairStrands|generateHeadband|generateHair(` across `src` (to find where the procedural hair is used).

### Elements

#### 1. MakeHuman base mesh (every person's body)
- What: the human body all people are built from (crowd and Person Creator lab).
- Location: loaded by `src/people/body/assets.ts:45-97` (`loadPeopleAssets`); positions read by `src/people/body/morph.ts:74-94` (`Morpher` constructor); shaped by `Morpher.shape` (`morph.ts:129-168`). The GPU mesh itself is built outside this chunk (`createPersonRig`, `@render/people/personRig`).
- Primitive: quads in the pack (`faceVerts` Uint16 x4 per face, `d === c` marks a triangle), triangulated as 2 triangles per quad by the consumers (`bodySculpt.ts:44-45`, `groom.ts:44`, `procedural.ts:566-567`).
- Counts (measured from `public/models/people/base.json` + `base.bin`):
  - whole base mesh: 19,158 vertices; 18,304 faces, all quads -> 36,608 triangles; 21,334 UV coordinates (UVs are per face corner via `faceUvs`, so a GPU mesh with split seams has more than 19,158 vertices).
  - skin only (`faceGroup` "body", index 0; vertex range `bodyRange` = [0, 13379]): 13,380 vertices, 13,378 quads -> 26,756 triangles.
  - the remaining 5,778 vertices / 4,926 quads (9,852 triangles) are MakeHuman helper geometry (`helper-hair`, `helper-skirt`, `helper-tights`, teeth, tongue, eyes, lashes, joint cubes): 138 face groups in total.
- Attributes in the pack: position Float32 x3 (12 B), uv Float32 x2 (8 B, per UV index), faceVerts/faceUvs Uint16 x4 per face, faceGroup Uint8 per face, skin joints Uint8 x4 + weights Uint16 x4 per vertex (`assets.ts:84-85`, 12 B) -> 53 bones (`skeleton-game-engine.json`).
- Morph data (CPU-side, used to compute the body shape, not uploaded as morph targets here): 64 PCA components x 19,158 x 3 Int16 basis (`morph.ts:82`), 348 macro targets with sparse residuals, 802 local/regional targets with 830,232 sparse entries (Uint16 index + Int16 x3 delta). `Morpher.shape` writes a full 19,158 x 3 Float32 position array per body (and each basis multiply-add is K=64 passes over 57,474 floats).
- Multiplicity: one per person built. The street roster (`src/people/roster.ts:46-51`, `makeRoster`) is a fixed set of 84 bodies (42 per sex: 4+3+4+3+2+1+4+3+3+3+2+3+3+1+1+2 per sex). How many of them are drawn and at which LOD is decided outside this chunk.
- Notable: the GPU mesh is built by `personRig`/`personSimplifier` (outside); `build.ts:193` waits for `geometry.userData.lodReady`, i.e. LOD levels exist there.

#### 2. Face expression shapes (ARKit 52)
- What: 52 face blendshapes (Apple ARKit set) used for facial expression.
- Location: `src/people/body/expressions.ts:20-42` (`expressionShapes`): packed sparse (Uint16 vertex index + Int16 x3 delta, 52,220 entries) expanded into 52 dense Float32Array(19,158 x 3) = 52 x 229,896 B = 11.95 MB of CPU memory, cached once.
- In the game they are folded into 13 mixed channels (`channelShapes`, `@render/people/faceExpression`, outside; `build.ts:187`).
- In the Person Creator lab, `src/peopleLab/faceRig.ts:40-65` (`attachFace`) adds all 52 as morph targets of the built mesh: one `BufferAttribute(Float32 x3)` per shape over every vertex of the built mesh (`built.morph(positions)`), `morphTargetsRelative = true`. GPU cost: 52 x 12 B = 624 B per vertex of the built person mesh (for example ~15.6 MB at 25,000 vertices). Lab only, on demand (face tab).

#### 3. Proxies (garments, hair, eyebrows, eyelashes, eyes, shoes, hats, community items)
- What: every worn item fitted to the body (MakeHuman proxy format).
- Location: format and fitting in `src/people/body/proxy.ts` (`ProxyPack` 6-30, `fitProxy` 33-56, `proxySkin` 59-82, `parseProxy` 99-117, `loadProxyItem` 159-196). GPU mesh built outside (`personRig`).
- Primitive: indexed triangles (`index: Uint32Array`, `proxy.ts:20,114`).
- Per-vertex pack data: refs Uint32 x3 (12 B) + weights Float32 x3 (12 B) + offsets Float32 x3 (12 B) + optional uvs Float32 x2 (8 B) + optional fade Float32 (4 B); skin weights produced per vertex as Uint16 x4 joints + Float32 x4 weights (`proxySkin`, 24 B). `fitProxy` computes Float32 x3 positions per vertex (3 weighted base vertices + scaled offset).
- Counts of system items (from `public/models/people/proxies/*.json` layout): 

| Item | Vertices | Triangles |
|---|---|---|
| long01 (hair) | 3,314 | 4,108 |
| bob01 (hair) | 5,961 | 8,474 |
| bob02 (hair) | 1,759 | 2,248 |
| short01 (hair) | 3,177 | 3,678 |
| short02 (hair) | 2,061 | 3,344 |
| braid01 (hair) | 4,771 | 5,518 |
| ponytail01 (hair) | 4,049 | 5,352 |
| afro01 (hair) | 2,276 | 2,192 |
| eyebrow001 | 126 | 192 |
| eyelashes01 | 250 | 368 |
| eyes | 1,076 | 2,040 |
| shoes01 | 1,904 | 3,320 |
| male_casualsuit02 | 2,349 | 4,120 |
| female_casualsuit02 | 3,204 | 5,488 |
| female_elegantsuit01 | 2,446 | 4,192 |
| male_elegantsuit01 | 8,522 | 14,956 |
| fedora01 (hat) | 702 | 1,244 |

- Community catalogue (`proxies/community.json`, read by `src/people/wardrobe.ts:85-99`): 528 items, triangles min 100 / median 4,714 / max 155,930.
- Multiplicity: per person, `wornItems` (`spec.ts:88-104`) = outfit + footwear + eyes + hair + brows + lashes + hat + extras (glasses, jewelry, beard, bottoms). A typical street person: body 26,756 + outfit ~4-15 k + shoes ~3.3 k + hair ~2-8.5 k + eyes 2,040 + brows ~192 + lashes ~368 triangles, i.e. roughly 40-55 k triangles at full detail before any LOD/simplifier (the simplifier and LODs are outside this chunk).
- `deleteVerts` (proxy.ts:22): base-mesh vertices hidden under a garment (removed or masked by the rig outside).

#### 4. Street triangle cap for worn items
- `src/people/wardrobe.ts:30` `STREET_TRIANGLES = 16000`: a community item is street-eligible only at <= 16,000 triangles (`wardrobe.ts:95`, plus selection, `street` flag and not a costume). In the raw data 343 of 528 community items have the `street` flag and <= 16,000 triangles (before the `SELECTED` / costume filters).

#### 5. Procedural hair cards (`generateHair`, cards mode)
- What: generated hairstyles (28 styles in `HAIR_STYLES`, `procedural.ts:42-71`; crowd uses 16 female + 8 male, `procedural.ts:74-77`), drawn as the lab's "grown" hair (`peopleLab/build.ts:56-66`) and baked for the crowd (`render/people/proceduralBake.ts:95,287`, outside).
- Location: `src/people/hair/procedural.ts:246-612` (`generateHair`); cards 478-517, scalp cap 519-569, braid 571-609; output `pinned()` 206-239 (a `ProxyPack`).
- Primitive: indexed triangles (index Uint32 in the pack), two-sided card strips.
- Counts:
  - roots R: dart-throwing over the scalp vertices with spacing `0.85*sqrt(area/clumps)` (0.6x near the hairline) -> R is of the order of `style.clumps` (160-300). Guides at the front hairline (`edgeFront`) get no card.
  - points per guide N = segments + 1 (+8 for a bun coil, +10 for a gathered tail; a braid stops at the tie). segments = 16 if length > 2.5 dm, 10 if > 1, else 5; curls: `ceil(length / (pitch/8))` (curlyShort 30, curly 41, afro 50).
  - per guide per layer: 2N vertices, 2(N-1) triangles; layers 1 or 2.
  - examples (R ~= clumps, before edge-guide removal): longStraight (N=17, 2 layers, 230 clumps) ~15,640 vertices / 14,720 triangles; bob (N=11, 2 layers, 220) ~9,680 v / 8,800 t; fade (N=6, 1 layer, 220) ~2,640 v / 2,200 t; afro (N=51, 2 layers, 300) ~61,200 v / 60,000 t (afro not in the crowd lists).
  - scalp cap: every head quad touching the scalp, 2 triangles each, recursively split up to 2 levels (x4 each, up to x16) where the fade varies by > 0.05 (`capTriangle`, 550-560); vertices deduplicated by a 0.5 mm key (`capKey`); fully faded triangles dropped.
  - braid: per lobe (A=6 around, L=5 along) 42 vertices / 60 triangles; lobes = max(4, round(tail/0.22)): braid 16 lobes -> 672 v / 960 t; twinBraids 2 x 15 -> 1,260 v / 1,800 t.
- Attributes: pack layout as for proxies (48 B/vertex: refs, weights, offsets, uv, fade).
- Notable: CPU generation cost is heavy (per vertex `nearestThree` k-d tree query; cards pinned with 3 refs each).

#### 6. Procedural hair strands (`generateHairStrands`)
- What: the same style as thin ribbons ("a millimetre and a bit wide") drawn over the cards close up; used by the crowd (`render/people/proceduralCrowd.ts:1599`, outside).
- Location: `src/people/hair/procedural.ts:242-244` and the `strands` branch 439-476.
- Primitive: indexed triangle ribbons (2 vertices per point, 2 triangles per segment), not GL lines.
- Counts: per guide `count` ribbons = 26 (interior), 12 (near the hairline), 14 (fringe); each ribbon end = 80-100 % of N-1 segments -> (end+1)*2 vertices, 2*end triangles.
  - longStraight (N=17, ~230 guides): ~26 x 230 x ~30.8 v ~= 184,000 vertices and ~172,000 triangles.
  - fade (N=6, ~220 guides): ~63,000 vertices / ~51,000 triangles.
- Notable for performance: this is by far the heaviest generated geometry in this chunk; 4-10 x the cards of the same style. Whether and at what distance it is drawn is decided in `proceduralCrowd.ts` (outside).

#### 7. Procedural headband
- `src/people/hair/procedural.ts:615-638` (`generateHeadband`): grid steps=28 x across=4 -> 29 x 5 = 145 vertices, 28 x 4 x 2 = 224 triangles, indexed. One per person wearing `longHeadband`. Used by `proceduralBake.ts:290` and `proceduralCrowd.ts:1014` (outside).

#### 8. Hair/garment shaping (`shapedPack`) and lab sculpts
- `src/peopleLab/hairShape.ts:30-89`: moves a proxy's offsets (length, volume, wave), optionally re-pins vertices to the 3 nearest skin vertices (`nearestThree`); no change to vertex/triangle count. Lab only (`build.ts:119-130`).
- `sculptedPack` / `decodeSculpt` (`peopleLab/sculpt.ts`, outside the list) applied in `build.ts:172-176`: offsets only, same topology.

#### 9. Body sculptor mesh (Person Creator lab)
- What: the editable skin mesh while the body brush tool is open.
- Location: `src/peopleLab/bodySculpt.ts:30-65` (`BodySculptor` constructor).
- Primitive: indexed triangles; `BufferGeometry` with `position` = Float32 x3 over all 19,158 base vertices (229,896 B) and an index of the skin group's quads split in two: 26,756 triangles (80,268 indices; three.js picks Uint16 for a plain array with max < 65,535). Normals computed (`computeVertexNormals`, +12 B/vertex). `MeshStandardMaterial`, `castShadow = true`.
- Multiplicity: 1, lab only, while the sculptor is open (the built person is hidden meanwhile).
- Notable: the position buffer includes the 5,778 helper vertices no triangle uses (~69 KB unused). Every dab recomputes all normals (26,756 triangles) and re-uploads the full position buffer (`refresh`, 190-195), and `within()` walks all 13,380 skin vertices per dab; mirrored strokes run it twice.

#### 10. Body sculptor cursor ring
- `src/peopleLab/bodySculpt.ts:61` `new RingGeometry(0.94, 1, 48)`: thetaSegments 48, phiSegments 1 -> (1+1)(48+1) = 98 vertices, 2 x 48 x 1 = 96 triangles, indexed. `depthTest: false`, double-sided, transparent. 1 instance, lab only.

#### 11. Person Creator lab stage props
- Location: `src/peopleLab/main.ts:179-194`.
- Pedestal: `CircleGeometry(0.75, 64)` -> 66 vertices, 64 triangles; receives shadow.
- Shadow catcher: `CircleGeometry(4, 32)` -> 34 vertices, 32 triangles; `ShadowMaterial`, receives shadow.
- Stool (seated clips only): `CylinderGeometry(0.2, 0.18, 0.44, 32)` (heightSegments 1, closed) -> side 33 x 2 = 66 + two caps of 32 + 33 = 65 each -> 196 vertices; 2 x 32 + 32 + 32 = 128 triangles; casts and receives shadow.
- Lighting: one `DirectionalLight` casting shadows, 2048 x 2048 map (`main.ts:167-175`), `PCFSoftShadowMap`: every shadow caster (person, stool) is drawn twice per frame. Renderer pixel ratio forced to 2-3 (`main.ts:155`), `RoomEnvironment` PMREM.
- 1 each, lab only.

#### 12. Pose editor helpers (Person Creator lab, rig tab)
- Location: `src/peopleLab/posing.ts:78-116` (constructor), `drawSkeleton` 294-313.
- Skeleton lines: `LineSegments` (non-indexed lines), one segment (2 vertices) per bone whose parent is a bone, fingers/toes/nubs/root excluded; Float32 x3. Rebuilt every frame while visible: `drawSkeleton` allocates a new `Float32Array` and a new `BufferAttribute` each frame (`posing.ts:305`) - a fresh GPU buffer upload and garbage per frame.
- Joint pick spheres: shared `SphereGeometry(0.018, 12, 8)` -> 13 x 9 = 117 vertices, 2 x 12 x 7 = 168 triangles; 20 meshes (one per `JOINTS` entry), a separate `MeshBasicMaterial` each -> 20 draw calls, `depthTest: false`.
- IK target handles: `SphereGeometry(0.03, 16, 10)` -> 17 x 11 = 187 vertices, 2 x 16 x 9 = 288 triangles; 4 meshes (one per chain).
- IK pole handles: `SphereGeometry(0.02, 12, 8)` -> 117 vertices, 168 triangles; 4 meshes.
- `TransformControls` gizmo (`posing.ts:79-94`, three.js addon): its own helper meshes/lines (not counted here; three.js addon geometry).
- Visible only in the lab's pose tab.

#### 13. Lab's per-vertex region attribute and shader-side edits
- `src/peopleLab/direct.ts:112-137` (`regionAttribute`): a Float32 per vertex of the built mesh, set as attribute `labRegion` (`main.ts:314`) - +4 B per vertex; no new triangles.
- `src/peopleLab/polish.ts`:
  - `upperLashesOnly` (69-119) folds the lower-lash triangles to a point (index rewritten `b = c = a`) and `foldSpikes` (134-157) folds garment triangles with an edge > 6x the garment's median edge: the triangles stay in the index buffer as degenerate (zero-area) triangles - vertex-shader work kept, no raster cost.
  - `evenHem`, `clearScalpPaint`, `solidHair`, `smoothSeams`: vertex edits/normal averaging; no count change. `polishPerson` also keeps a full copy of positions in `userData.rawPositions` (+12 B/vertex CPU).
- `clothStyle.ts`, `regionGlow`, `evenHairSheen`, `sharpEyes`: fragment/vertex shader patches only (no geometry). `clothStyle` adds two varyings (vec3 pos, vec3 normal).

#### 14. Built lab person (game build path)
- `src/peopleLab/build.ts:152-199` (`LabBuilder.build`): calls the game's `createPersonRig` + `attachFacialMorphs` (outside); skinned meshes; triangle counter `triangles += (index.count ?? position.count) / 3` (`build.ts:196-197`), shown in the lab's stats line (`main.ts:343`). `dress.ts:38` sets `castShadow = true`, `frustumCulled = false` on every person mesh.

#### 15. Groom body (hair studio helper, CPU)
- `src/peopleLab/groom.ts:37-156` (`GroomBody`): derives `capTris` (scalp quads as triangles) and `rimTris` (quads across the hairline) as index arrays over the base mesh, plus a 48 x 24 radial head proxy (`headProxy`, 260-312). These arrays feed the hair shell built elsewhere (`hairShell.ts`, outside the list); here they are CPU data only. Counts depend on the scalp: a subset of the 13,378 skin quads x 2.

#### 16. Editor overlay in `src/main.ts` (Canvas 2D, not GPU geometry)
All of these are drawn with `CanvasRenderingContext2D` on the overlay canvas (`main.ts:611-754`, `drawOverlayScreen` 2942-3410), so they make no GPU triangles, but they are per-frame CPU work proportional to their point counts:
- Road draft preview (3205-3409): the draft densified every 2 m (`densify`, 4234-4243) and each point projected 2-3 times; 5 filled bands (casing, verge, footway, kerb, asphalt) each projecting 2 offset points per sample (`band`, 3298-3316) with a terrain height read per point.
- Roundabout hover: 65-point circle (2971-2976).
- Block-grid preview lines (2991-3006), bulldozer box following the land (3042-3065, one point per `GRID_CELL`), terrain brush ellipses, junction-control glyphs over the junctions on screen (3182-3203, `net.junctionCells.idsMeeting`), F8 change rectangles (2912-2940), pole plan rings/crosses, streetscape rings, barrier plan, transit editor drawing, lot labels.
- The 48 x 48 asphalt preview pattern (`asphaltPreviewPattern`, 617-638).

#### 17. 3D previews requested from `src/main.ts` (built in the renderer, outside this chunk)
- `scene.setPolePreview(net, {poles})` (2701-2703): the planned pole run drawn in 3D, every frame from the pole tool's plan.
- `scene.setGrid(roadGridShown())` (2990): the universal grid on the ground.
- `scene.setTransitXray` / `scene.setTransitPreview` (3011-3012): metro seen through the ground, track being laid.
- `scene.setLotOverlay(overlay, doc.changes)` (3020, 3038): zoning drawn by the ground's shaders (`lotOverlay.ts`).
- `scene.flashRoads`, `scene.strikeAt` (lightning), `scene.effects()` / `actions.strikeAt` / `shootAt` (bomb, pistol and debris, `actionsWiring.ts`), clouds (`doc.addClouds(scatterClouds(...))`, 1703-1711, 1810-1816; up to 24 a scatter).
- Geometry counts for these belong to the render-side chunks.

#### 18. Network solved off the page
- `src/networkBake.worker.ts:24-30` (`bakeNetwork`): rebuilds the whole `Network` (junction and ribbon solves - the inputs of the road/junction meshes) in a job worker and exports it (`Network.exportBake`); the page takes the solved junctions/ribbons (`main.ts:2090-2106`, `2219`). No triangle buffers are built here.

### Budgets, caps and counters found

- `VIEW_BUDGETS` (`src/core/perfBudget.ts:44-48`, used by `src/lab/tests/benchmarks.ts:86-97` and `main.ts:4189-4207`): triangles per frame (colour + shadow passes) street 16,000,000, district 16,000,000, map 8,000,000; draw calls street 1,000, district 1,100, map 400; GPU p95 12 ms; fps 60/60/50.
- `STREET_TRIANGLES = 16000` per worn item (`src/people/wardrobe.ts:30`).
- Roster: 84 fixed street bodies (`src/people/roster.ts:46-51`).
- Hair clumps per style 160-300 (`procedural.ts:43-70`); lab grown-hair cache capped at 25 entries (`peopleLab/build.ts:62`).
- Lab usage meter draw-call reference: 1,000 calls per frame = 100 % (`src/lab/usage.ts:96-97`).
- Triangle counters/statistics:
  - `scene.stats.drawnTriangles` / `builtTriangles` / `drawCalls`: sampled per frame by the lab (`lab.ts:130-131`), recorded per frame (`recorder/recording.ts:136-137`), segmented with a noise floor of max(1, 0.5 %) (`recorder/analysis.ts:239-240`), reported (`recorder/report.ts:171-177`), overview KPI (`resources/overview.ts:47-48`), consumers meter `frame.triangles` (`resources/collector.ts:153-154`), A/B sweep `trianglesDelta` (`tests/sweep.ts:174`), benchmark rows vs `VIEW_BUDGETS` (`tests/benchmarks.ts:97`), `__roadcraft.inventory/usage/memory/budget` (`main.ts:4128-4207`).
  - GPU ledger triangles per class (`gpuLedger.entries()` `e.triangles`, `resources/collector.ts:267-286`).
  - Building levels' `chosenTriangles` (`ctx.scene.buildingLevels()`, `tests/measure.ts:74-78`) as part of the scene signature.
  - `renderer.info.memory.geometries/textures` and program counts (collector, diagnostics leak check: > 50 geometries/min and > 100 rise in 2 min = warning, `resources/diagnostics.ts:135-144`; leak benchmark limits 20 geometries / 2 textures / 1 program / 5 MB, `tests/benchmarks.ts:199-203`).
  - Lab person triangle count (`peopleLab/build.ts:196-197`, shown at `peopleLab/main.ts:343`).
- `MAX_FRAMES = 216,000` frames per recording (`recorder/recording.ts:90`), not geometry.

### Files without geometry

- `src/lab/`: investigate.ts, lab.ts (only samples triangle counters), labTypes.ts, optimizations/index.ts, table.ts, tabs.ts, usage.ts (counter only), window.ts (2D sparkline canvases).
- `src/lab/recorder/`: analysis.ts, deliver.ts, index.ts, recording.ts, report.ts (counters only); timeline.ts (Canvas 2D chart).
- `src/lab/resources/`: collector.ts, consumers.ts, diagnostics.ts, index.ts, meter.ts (counters only); overview.ts (Canvas 2D sparklines).
- `src/lab/tests/`: benchmarks.ts, index.ts, items.ts, measure.ts, probes.ts, sweep.ts (counters and budgets only).
- `src/`: networkBake.worker.ts (network solve, no mesh buffers). `src/main.ts` has no three.js geometry of its own (Canvas 2D overlay and calls into the renderer, see elements 16-17).
- `src/people/`: body/macro.ts (slider weights), phenotype.ts (colours), roster.ts (person specs), spec.ts (person specs), wardrobe.ts (catalogue; holds the 16,000-triangle cap).
- `src/peopleLab/`: bodyFit.ts, bodySculptPanel.ts, choices.ts, clothStyle.ts (shader patch), dress.ts (materials, shadow flags), faceRig.ts (morph targets, element 2), handDrag.ts, history.ts, icons.ts (SVG), navigation.ts, panels.ts, picker.ts, pose.ts (bone rotations), posePanel.ts.

---

## Polygon geometry audit - chunk g03

### Files read

All 40 files read completely, first line to last (long files in sequential chunks).

| File | Lines |
|---|---|
| src/peopleLab/presets.ts | 253 |
| src/peopleLab/proportions.ts | 265 |
| src/peopleLab/record.ts | 113 |
| src/peopleLab/reshape.ts | 194 |
| src/peopleLab/sculpt.ts | 455 |
| src/peopleLab/sculptPanel.ts | 45 |
| src/peopleLab/shapeKeys.ts | 38 |
| src/peopleLab/thumbs.ts | 153 |
| src/peopleLab/widgets.ts | 93 |
| src/render/agents.ts | 2613 |
| src/render/bake/catalogue.ts | 124 |
| src/render/bake/detailRecipes.ts | 261 |
| src/render/bake/finishRecipes.ts | 382 |
| src/render/bake/roadRecipes.ts | 217 |
| src/render/bake/terrainRecipes.ts | 308 |
| src/render/bakePool.ts | 201 |
| src/render/barriers.ts | 257 |
| src/render/blast.ts | 757 |
| src/render/blobShadows.ts | 103 |
| src/render/buildingSwitches.ts | 102 |
| src/render/buildings/buildingMesh.ts | 4127 |
| src/render/buildings/cell.worker.ts | 20 |
| src/render/buildings/cellArrays.ts | 578 |
| src/render/buildings/cellPool.ts | 396 |
| src/render/buildings/cellRequests.ts | 209 |
| src/render/buildings/cellWork.ts | 236 |
| src/render/buildings/chunk.ts | 135 |
| src/render/buildings/facadeKit.ts | 450 |
| src/render/buildings/facadeLevel.ts | 224 |
| src/render/buildings/facadePropModels.ts | 327 |
| src/render/buildings/facadeProps.ts | 192 |
| src/render/buildings/fade.ts | 43 |
| src/render/buildings/farParts.ts | 293 |
| src/render/buildings/finishes.ts | 357 |
| src/render/buildings/flagLayer.ts | 170 |
| src/render/buildings/fracture.ts | 417 |
| src/render/buildings/fracture.worker.ts | 19 |
| src/render/buildings/frameBudget.ts | 142 |
| src/render/buildings/furnitureKit.ts | 345 |
| src/render/buildings/glassRoom.ts | 256 |
| **Total** | **15,870** |

Files outside the list consulted only to resolve numbers (excerpts, not audited):
- `src/render/vehicleModels.ts` lines 488-537 (tyre / rim / spoked-rim geometry used by agents.ts).
- Constants by grep: `src/sim/params.ts` (FLEET_CEILING = 1200, PED_CEILING = 1000), `src/render/quality.ts` (VEHICLE_WHOLE_CAP = 200), `src/render/riderPoses.ts` (HELMET_SEGMENTS = {width 24, height 16}), `src/render/partLevelsWork.ts` (LEVEL_ERRORS = [0.0125, 0.025, 0.05, 0.1, 0.2, 0.4]), `src/render/vehicleLevels.ts` (LEVELS = LEVEL_ERRORS.length + 1 = 7), `src/render/buildings/partPose.ts` (POSE_FLOATS = 8), `roomBehind.ts` (ROOM_FLOATS = 12), `shellParts.ts` (LOOK_FLOATS = 3), `src/world/buildings/interior.ts` (FURNITURE_KINDS, FURNITURE_SIZE), `node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js` (super(1,1,1, 2*segments+1, ...)).

Formulas used (three r186): Box(1,1,1,1,1,1) = 24 v / 12 t; Box(segments s) = 6(s+1)^2 v / 12 s^2 t; Cylinder(rs, hs=1, closed) = 2(rs+1) + 2(2rs+1) v, 2rs + 2rs t; Cone(rs) = 2(rs+1) + (2rs+1) v, rs + rs t (degenerate apex triangles skipped); Sphere(w,h, full) = (w+1)(h+1) v, w(2h-2) t; Circle(s) = s+2 v / s t; Ring(theta s, phi 1) = 2(s+1) v / 2s t; Lathe(points p, seg s) = (s+1)p v / 2s(p-1) t; Plane(a,b) = (a+1)(b+1) v / 2ab t; Torus(radial r, tubular t) = (r+1)(t+1) v / 2rt t; Icosahedron(detail 1) non-indexed = 240 v / 80 t; Extrude (no bevel, steps 1) non-indexed = 2(n-2) cap + 2n side triangles for an n-point contour.

### Elements

#### A. Vehicles and riders (src/render/agents.ts)

General: every vehicle "part" is an `InstancedMesh` built by `instanced()` (agents.ts:490-512): starts at `PART_CAPACITY = 16` instances (agents.ts:110), doubles on demand (`growPart`, :1419-1456, unbounded; old GPU buffers deliberately not freed until context loss, :1443). Per instance: instanceMatrix 16 f32 (64 B) + instanceColor 3 f32 (12 B), DynamicDraw; extra per-instance attributes for lamps (`glow` 1 f32), joined bodies (`panelColor` 3 f32), glazing (`WINDOW_DROP` 2 f32). `frustumCulled = true` with a sphere refit (`fitInstances`) when instances change (:505-507, :2555). Uploads are range-limited (`send`, :1458). Parked/stopped cars keep instances across frames ("kept", :449-476, :1303-1351).

Level ladders: `ladder()` (:677-702) creates for each base part `LEVELS - 1 = 6` extra InstancedMeshes, one per coarser level, whose geometry is simplified off-thread (`partLevels`, vehicleLevels.ts). So each laddered car part is up to 7 InstancedMeshes. The level is picked per vehicle from screen size (`levelFor(frame[FRAME_PIXELS])`, :1549) against `ERROR_PIXELS` (tier `vehicleErrorPixels`).

Vehicle LOD bands (per vehicle, :2259-2273): level 2 "whole" above `occupantZoom` (default perM(3), :92) and capped to `VEHICLE_NEAR_CAP = VEHICLE_WHOLE_CAP = 200` biggest on screen (tier `vehicleWholeCap`); level 1 above `FAR_BODY_ZOOM = perM(1.75)`; level 0 (far proxy) down to 2 px car length; hysteresis 10 %. Fleet ceiling for culling arrays `MAX_VEHICLES = FLEET_CEILING = 1200`, but parts grow past it (:80, :1418).

1. Car/bus/truck body shell, glazing, interior, trim, roof, accent, doors, door glass, door cards, steering wheel, far proxy, joined body+panel
   - Location: per body style in `createAgentMeshes` :762-801 (models from `buildCarModel`/`buildBusModel`/`buildTruckModel`, vehicleModels.ts - not in this chunk, counts not resolved here). Drawn in `drawCar` :1535-1614.
   - Primitive: indexed triangles (model geometries), instanced, one instance per vehicle per part.
   - Multiplicity: one set of InstancedMeshes per (archetype x style). Laddered parts (x7 each): shell, glass, interior, trim, roof, accent, shellLite, roofLite, accentLite, panel (x7 via `panelLadder`), panelLite (x7). Non-laddered: openShell, openGlass, openInterior, per-door panel/glass/card, roofGlass, far, steering. That is roughly 11 ladders x 7 + ~8 + 3/door InstancedMeshes per body style (most are hidden/empty; empty ones set `visible=false`, :2558).
   - Shadows: shell/roof/accent/doors/panel cast at level 2 only; "Lite" copies (level 1) cast none (soft blob instead); glass, interior, trim, steering cast none.
   - Far proxy (`car.far`) simplified with meshoptimizer target 1 %, error 10 % (`simplified(..., 0.01, 0.1)`, :805) - comment says the 5 % version kept ~440 tris/car and 3.5 M tris for thousands of far cars.
   - Notable: `shell` and `shellLite` (and roof/accent and their Lite) are separate InstancedMeshes sharing the same geometry only to toggle castShadow - doubles the number of draw objects but not triangles.

2. Road-wheel tyre (`vehicle-wheels`)
   - `tyreGeometry()` (vehicleModels.ts:491) LatheGeometry of 9 profile points x 16 segments: 153 v / 256 t, indexed. Created agents.ts:602, InstancedMesh :609, laddered with copies=4 (:758).
   - Per vehicle: 4 (car), 2 per axle per side; bicycles use thin tyres instead. Casts shadow only when a car is drawn whole (level 2) or a two-wheeler is whole (:2473).
3. Rim / hub (`vehicle-hubs`)
   - `rimGeometry()` (vehicleModels.ts:507): Cylinder(14) 88 v/56 t + 5 boxes 120 v/60 t + Cylinder(8) 52 v/32 t = 260 v / 148 t before `merge` (merge welds), indexed. Laddered x7 (:759). Drawn only at band >= 1 (:1482). No shadow.
4. Bicycle thin tyre (`bicycle-wheels`): `tyreGeometry(0.035)` 153 v / 256 t (:605, :611). 2 per bicycle. Not laddered.
5. Bicycle spoked wheel (`bicycle-spokes`): `spokedRimGeometry()` Torus(4,24) 125 v/192 t + Cylinder(8) 52/32 + 16 boxes 384/192 = 561 v / 416 t before merge (:606, :612). 2 per bicycle, no shadow. Not laddered.
6. Lamps / plates / indicators / destination blind (`vehicle-lamps`)
   - `unitBox = BoxGeometry(1,1,1)` 24 v / 12 t (:598, :613). Unlit MeshBasicMaterial with per-instance `glow` attribute. One instance per lamp: a car writes head lamps + tail lamps + active indicator + plates (2) + bus destination; far cars still write tail lamps (:1543). Typically ~5-8 instances per car. No shadow.
7. Rider helmet (`rider-helmets`): `merge([SphereGeometry(0.5, 24, 16)])` = 425 v / 720 t (:619-620). One per motorcyclist; casts shadow.
8. Two-wheeler body / trim / steering / cranks: from `buildTwoWheelerModel` (vehicleModels.ts, not resolved), each laddered x7 (:828-840). castShadow switched by whether any two-wheeler is whole (:2468-2472).
9. Vehicle soft shadow disc (`vehicle-shadows`): `blobMesh(..., MAX_VEHICLES=1200, 0.4)` (:1169) - see element C1. One per vehicle below level 2 (or two-wheelers when none whole). frustumCulled = false.
10. Dead geometry: `torsoGeometry` (BoxGeometry tapered, 24 v/12 t, :600-601) and `headGeometry` (SphereGeometry(0.5,10,7) = 88 v / 120 t, :607) are created and disposed but never attached to any mesh. Wasted CPU allocation only (never uploaded).
11. Wreck / carcass geometry (`carcass()`, :2092-2149)
   - Built on demand when a vehicle is destroyed: clones and scales the model's shell, trim, interior, accent, roof plus hubs/tyres, `merge`, then `toNonIndexed()` (:2129) for faceted look, then per-vertex procedural dents and `computeVertexNormals`.
   - Primitive: non-indexed triangles; vertices = 3 x (sum of the parts' triangles). Handed to blast.ts as a `mesh` debris piece (own Mesh, DoubleSide material, casts/receives shadow), at most 40 wrecks kept (blast.ts:376-381).
   - Notable: non-indexed by design (3 vertices per triangle) and DoubleSide.
12. People (pedestrians / occupants): drawn through `createRiggedCitizens` and `createProceduralCrowd` (riggedCitizens.ts, people/proceduralCrowd.ts - other chunks). Caps here: `MAX_PEDS = PED_CEILING = 1000` walkers drawn per frame (:2485), `PROC_CAP = PED_CEILING` procedural bodies (:862), up to 12 spare bodies (:891), occupant rows limited by zoom (`rowsDrawn`, :2180). Hair strands only for `tier.hairStrandPeople` nearest people.

#### B. People lab (src/peopleLab)

1. Sculptor body mesh (skin)
   - `HairSculptor` constructor, sculpt.ts:120-143. Hand-built `BufferGeometry`: position = the MakeHuman base mesh positions (Float32 x3, shared array), `setIndex(tris)` from skin quads (each quad -> 2 triangles, a degenerate quad -> 1), quads whose vertices are covered by the worn piece skipped. Vertex colour attribute Float32 x3 (all skin colour). Normals computed. Triangles = 2 x (skin quads not covered); vertex count = whole base mesh vertex count (non-skin vertices included, unreferenced).
   - Bytes/vertex: 12 position + 12 normal + 12 colour = 36 B. Index: plain JS array -> three picks Uint16/Uint32 by max index.
   - Multiplicity: 1, lab only. casts and receives shadow.
2. Sculpted hair / garment piece
   - sculpt.ts:149-169. Position = fitted proxy (`fitProxy`), index = `pack.index` (proxy's own), uv when textured. MeshStandardMaterial DoubleSide, alphaTest 0.45 with strand texture. Count = the proxy pack's (not resolved; asset data).
   - Notable: `refresh()` (:242-280) runs on every brush dab/move: collisions per vertex, `computeVertexNormals`, a weld-normal pass and `computeBoundingSphere` on the whole piece - full-mesh CPU rebuild per pointer event (lab tool only).
3. Brush cursor ring: `RingGeometry(0.92, 1, 48)` = 98 v / 96 t, indexed, depthTest off, renderOrder 10 (sculpt.ts:193). 1 instance.
4. Reshaper (reshape.ts:38-194): no new geometry; while a slider moves it rewrites the whole `position` attribute of the person's SkinnedMesh on the CPU every tick (:128-144, loop over all floats x number of moving axes) and on commit runs `polishShape`, `computeVertexNormals`, `smoothSeams`, bounding box/sphere. Lab only. Vertex count = the built person's.
5. Thumbnails (thumbs.ts): renders a built person (`builder.build`) in its own WebGLRenderer (224 x 224) only when baking (`baking` flag); geometry is the person's (built elsewhere), disposed after each shot. No geometry of its own.
6. Face proportions (proportions.ts): reads the base mesh (`m.vertexCount`, `m.faces` quads, joints/weights) and `Morpher.shape` outputs to measure; builds no GPU data. Notable CPU cost: `fit()` calls `measure()` (full-shape morph) up to 8 passes x 8 measures x up to 7 secant evaluations.

#### C. Shadows, debris, effects

1. Blob shadow disc (blobShadows.ts:21-51)
   - Hand-built indexed fan: centre + 10 rim points = 11 v / 10 t (`SEGMENTS = 10`). Attributes: position f32x3 (12 B), normal f32x3 (12 B), color f32x4 (16 B) = 40 B/vertex; index Uint16.
   - InstancedMesh, `capacity` initial (vehicles: 1200), grows by doubling (`createBlobShadows.grow` :69-77). frustumCulled = false, no shadow cast, transparent, depthWrite false, `pullTowardEye` polygon offset.
   - Users here: vehicles (agents.ts:1169). `createBlobShadows` used by other layers (not in chunk).
2. Blast debris boxes (blast.ts:212): `BoxGeometry(1,1,1)` 24 v / 12 t, InstancedMesh cap `MAX_PIECES = 1400`.
3. Blast debris cylinders (blast.ts:213): `CylinderGeometry(1,1,1,9)` = 58 v / 36 t, cap 1400.
4. Car-side shell debris (blast.ts:215-220): `ExtrudeGeometry` of a 9-point profile, depth 1, no bevel: non-indexed, 14 cap + 18 side = 32 t / 96 v. Cap 80 instances.
5. Broken slab debris (blast.ts:222-233): ExtrudeGeometry of an 11-point jagged contour with bevel (bevelSegments 1): 4 contour layers -> 18 cap + 66 side = 84 t / 252 v, non-indexed. Cap 1400.
   - All four debris meshes: one shared MeshStandardMaterial, instance colours, castShadow + receiveShadow, **frustumCulled = false** (:237), visible only when count > 0. Instance matrices rewritten for every piece whenever any piece moves (`redraw`, :670-689; up to 1400 per mesh), upload limited to `count`.
   - Spawns: explosion 24 + 1.5 x radius boxes; crater rim 8 + 0.8 r boxes; heaved plates min(60, 10 + r/1.6 m) slabs + a box every third; persistent (`still`) slabs never culled for room.
6. Crater decals (blast.ts:245-280): `CircleGeometry(0.5, 28)` = 30 v / 28 t. Two InstancedMeshes (road / earth) of cap `MAX_CRATERS = 60`, one soot InstancedMesh of cap `MAX_SOOT = 600`. Transparent, depthWrite false, polygon offset, frustumCulled false, receiveShadow. Crater matrices rewritten every frame while any crater exists (:691-706).
7. Shockwave ring (blast.ts:283): `RingGeometry(0.86, 1, 48)` = 98 v / 96 t, 1 Mesh, additive, DoubleSide.
8. Torn wires (blast.ts:289-295): `LineSegments`, position f32 buffer of `MAX_WIRES(40) x (WIRE_POINTS-1 = 11) x 2` = 880 vertices = 440 line segments max; drawRange set to used length; frustumCulled false.
9. Wrecks: own `Mesh` per vehicle carcass (see A11), max 40 kept, DoubleSide, cast/receive shadow.

#### D. Barriers (src/render/barriers.ts)

1. Walls, copings, fence posts and rails, hedges, guardrail posts and beams, railing posts and bars
   - One shared `BoxGeometry(1,1,1)` (24 v / 12 t, :145), 9 instance stores (`createInstanceRuns`, :106-109; instanceRuns.ts not in chunk), one MeshStandardMaterial each, castShadow + receiveShadow true. Each box is one instance via `RunBuilder.turned`.
   - Per metre of barrier (pieces of <= 4 m, posts every 2 m / 1.5 m):
     - wall: 2 boxes / 4 m piece (wall + coping) -> ~0.5 box/m = ~6 t/m
     - hedge: 1 box / 4 m -> ~3 t/m
     - fence: 2 rails / 4 m + 1 post / 2 m -> ~1 box/m = ~12 t/m
     - guardrail: 1 beam / 4 m + 1 post / 2 m -> ~0.75 box/m = ~9 t/m
     - railing: 2 bars / 4 m + 1 post / 1.5 m + vertical bars every 0.14 m (~7.1/m) -> ~8.3 boxes/m = **~100 t/m** (dense thin boxes, shadow casting; railing bars 2 cm wide).
   - Triangle counter: `triangles = boxes * 12` (:115).

#### E. Buildings

1. Building shell (walls, reveals, sills, bands, cornices, parapets, roofs, plinths, steps, lot paving, kerbs, element boxes when not instanced, roof plant, terraces, lanterns, spires, clocks, ramps, stairs, rails)
   - Built in workers: `emitChunk` (buildingMesh.ts:3669) -> `emitBuilding` (:1028) -> `Shell.face` (:682-752). Every face is a polygon fan (`count - 2` triangles), each vertex written in GPU layout and **welded** by a hash table on all of its attribute bits (`ShellPart.weld`, :561-578), so flat-shaded faces share only vertices with identical normal/paint.
   - Primitive: indexed triangles (Uint32 per building chunk; merged per piece into Uint16 when the piece has <= 65,535 vertices, `SHELL_PIECE`, cellArrays.ts:367, `indexArray` :249).
   - Attributes per vertex (cellArrays.ts:134-150): position Float32x3 (12 B) - or on the far level, on the cell's grid as Uint16x4 normalized (8 B, `onGrid`, :56-71); normal octahedral Int16x2 (4 B); paint Uint16x4 (rgb + finish/wear) (8 B). = **24 B/vertex** (20 B on the grid). Far-level "runs" add facade half-float x2 (4 B), grid Int16x4 (8 B), opening/trim Uint8x8 (8 B) = **44 B/vertex** (40 B gridded). UV computed in shader (`shellPlanarUv`).
   - Elemental counts (per call): `rect`/`strip`/`jamb` = 1 quad = 2 t / 4 v; `Emitter.box` shell path = 5 quads (no bottom) = 10 t / 20 v; `slab` = 10 t; `cylinder(sides=14)` = 14 side quads + 14 top tris = 42 t (up to 98 v before weld); pots on terraces sides=10 -> 30 t.
   - Per window bay (detail level, `emitBay` :1575-1774): 4 wall rects + 2 jambs + sill strip + head strip = 8 quads = 16 t of shell + instanced parts (glass, frame, sill 'concrete', shutters etc.). A plain wall bay = 1 quad = 2 t. Pilaster rib (art deco) +3 quads.
   - Far level (L1): bays without deep openings are merged into runs (`emitFacadeRuns` :1479-1543): one quad per run of alike bays across a storey and alike storeys up (never over the grime-darkened base storey) -> typically 2 t per facade run instead of 16 t per bay; windows drawn by the shader (facadeLevel.ts). Roof plant drains/posts/poles and fence posts skipped on far level (`FLAT_DEPTH` 0.3 m error).
   - Roofs (`emitRoof` :3428-3623): flat = 1 quad + parapet pieces per bay width (each 2 rects + strip + rect = 8 t); gable = 2 slopes + 2 fascia + 2 soffit + 2 ridge cap + 4 barge + 4 soffit + 2 gable triangles = 34 t; hip = 2+2+2+2 + 2 end tris + 4 fascia/soffit quads = ~26 t; shed ~16 t; sawtooth 6 t per tooth. Polygon roofs (outlined volumes) via earcut + polygon-clipping per plane patch plus eave segments per module.
   - Plinth (`emitPlinth`): per exposed side stretch 2 quads (4 t) plus 2 quads per entrance notch.
   - Entrance steps: 4 quads (8 t) per step (:1249-1261); recessed flights 2 quads per step.
   - Interior (cut-open view only, `emitInterior` :1317-1401): floor earcut, lift shafts (6 boxes = 60 t), cab, 12 stair boxes (120 t), flights, partitions (1 box each).
   - Lantern roof detail (`emitLantern` :3256-3318, N = 24): base ring 8 quads + disc 6 t + glass ring 24 quads + 6 frame bands x 24 quads + 24 mullion boxes (10 t) + cap ring 24 quads + disc 22 t + dome 6 x 24 quads + mast ring 8 quads + red box = **~982 t** per lantern.
   - Spire roof detail (:3210-3232): 3 bands x 8 quads = 48 t + base box 10 t.
   - Clock element (`emitClock` :2339-2368): 1 + 1 + 12 marks + 2 hands = 16 boxes = 160 t.
   - Lot surfaces (`emitLots` :2097-2275): rectangular paved lot as a grid of ceil(w/3 m) x ceil(d/3 m) cells x 2 t (follows the street's fall); kerb 1 quad per 3 m of perimeter; pool coping 4 quads + tiled sides. Lawns are not drawn here (terrain).
   - Apron round the base (`emitLot` :2635-2724): one quad per 2 m of exposed perimeter (APRON 0.9 m wide), each vertex sampled from `groundAt`; path to street one quad per 2 m.
   - Parking element: ceil(max(w,d)/3)^2 quads + one line quad per stall (2.5 m).
   - Gates: bars every 0.14 m as boxes (`part` -> `e.box`) -> instanced lotBox where possible.
   - Fences (`emitFence`): rails as instanced `lotRail` (or 4 quads each); posts every 2 m (railing every 0.45 m) as boxes (10 t each); far level drops fence posts but keeps railing posts.
   - Stair handrail posts (`postAt`): 4 quads (8 t) each, every ~1.2 m.
   - Multiplicity / drawing: per cell, chunks merged into pieces grouped by quadrant (2 x DETAIL_CELL squares, cellWork.ts:214) so each piece is culled by its own box; one `Mesh` per piece, one draw for all finishes (texture array). castShadow + receiveShadow; the shell material casts with `shadowSide: BackSide` (finishes.ts:229). Shells move into a multi-draw batch when shown (`shellBatch.ts`, other chunk). CPU arrays dropped after upload (`gpuOnlyAttributes`).
   - Ghost preview: same pipeline with ghost material, rebuilt on every draft change but reusing one `ShellWriter` (:4097-4103).
   - Counter: `meshesOf` sums `triangles` = shell index/3 + per part kind (kit triangles x count) + furniture (:3945, :4013, :4044).
2. Shell "parts" instanced from a unit box: `lotBox`, `lotSlab`, `lotRail` (element boxes, pavings and fence rails when `apart`), buildingMesh.ts:899-905, 915-920, 2910-2912, `shellPart` :973-980. Instance data: pose 8 f32 (32 B) + colour (half floats in the batch, 6 B) + look 3 f32 (finish, wear, ground, 12 B). Geometry is the kit's (`SHELL_PART_FACES` - shellParts.ts, other chunk; the shell-equivalent box is 5 faces / 20 v / 10 t per finishes.ts:310 comment). Drawn per cell; far material `createFarShellMaterial` for distant ones (finishes.ts:312 comment: 376 thousand boxes of 20 vertices in a large city).
3. Instanced facade parts (glass, glassDark, frame, concrete sills/canopies, door, shutter, railing, roofRailing, awning, column, water, lamp, wash, fin, louvre, glassRail, brise + facade props)
   - Placed by `Emitter.put` (:953-964) into `PartRows` (pose 8 floats = 32 B per instance; colour 3 f32 at emit -> half floats Uint16x3 = 6 B in the batch; glass panes add litSlot f32 + rooms 12 half floats = 28 B; shell parts add looks 12 B).
   - Geometry: the kit's models (kit.ts, other chunk - not resolved). Drawn as `InstancedMesh` with `InstancedInterleavedBuffer` poses (`posedCopy`), customDepthMaterial for shadows when the kit says the kind casts (`kit.castsShadow`).
   - Per typical window bay (detail): glass (1) + frame (1) + sill concrete (1) (+ shutter on 4/20 windows) = 3-4 instances; balcony bay adds slab + railing; door bay at ground floor adds 2 canopy slabs + 2 brackets + lamp + wash; gourmet adds 4-6 fins/rails; shuttered windows 3 fins + 2 louvres + sill.
   - On the far level, glass/glassDark/frame/door/shutter set into a flattened bay are skipped (`SHADER_DRAWN`, :181, :955) - the shader paints them.
4. Far-level part batch (farParts.ts:48-279)
   - One `InstancedMesh` per non-shell part kind for the whole town's facade cells, using the kind's coarsest kit level (`kit.screen[kind].levels.at(-1)`), initial capacity 256, doubling. Pose interleaved buffer 32 B/instance, colours half-float 6 B. **frustumCulled = false** (one draw a kind over the town, :76), casts shadow unless the level is a card. Visibility per kind by pixel size of the nearest cell (`view`, :100-124; bars hidden below BAR_PIXELS). Triangles per cell tracked (`drawn`, `trianglesOf`) for the budget.
   - Notable: `remove` compacts buffers with copyWithin and marks the tail dirty (whole tail re-uploaded on each cell removal).
5. Facade prop models (facadePropModels.ts) - instanced through the part pipeline; indexed (`tone` welds non-indexed parts, deletes uv); attributes position+normal+color f32 = 36 B/vertex:
   - acUnit (:49-94): 15 boxes + Circle(16) + 3 Ring(16) + 2 open Cylinder(6) = **508 v / 316 t**
   - acFar (far model, :231-238): 3 boxes + Circle(8) = 82 v / 44 t
   - pot (:97-106): 2 Cylinder(14) + Circle(14) = 192 v / 126 t
   - foliage (:120-163): 14 hand-built leaf strips (10 v / 8 t each) + deformed Icosahedron(detail 1, flat, 240 v / 80 t) = **380 v / 192 t**
   - bush (:257-281): Icosahedron(1) 240 v / 80 t + 22 Circle(4) leaves (6 v / 4 t) = 372 v / 168 t
   - chair (:166-176): 8 boxes = 192 v / 96 t
   - table (:179-187): Cylinder(18) + Cylinder(8) + Cylinder(14) = 252 v / 160 t
   - airer (:190-216): 14 boxes = 336 v / 168 t
   - dish (:219-228): partial Sphere(14,4, theta 0..0.8) 75 v / 98 t + 4 boxes = 171 v / 146 t
   - lounger (:284-294): 7 boxes = 168 v / 84 t
   - bike (:297-326): 4 Ring(18) 152 v / 144 t + 8 boxes 192 v / 96 t = 344 v / 240 t
   - Placement (facadeProps.ts:61-192): only storeys >= 1 on window/balcony/gourmet/loggia bays; AC on 2-7 % of window bays, dish 5 %, balconies 55 % furnished with 1-8 props. Shadow only for acUnit, pot, foliage, bush (`SHADOWED_PROPS`).
   - Notable: Icosahedron cores are flat-shaded non-indexed before welding (240 v for 80 t; welding cannot merge because normals differ per face).
6. Interior furniture models (furnitureKit.ts)
   - `createFurnitureGeometries` (:302-316): one merged indexed geometry per kind (40 kinds), position+normal+uv(zeros, added for merging)+color f32 = 44 B/vertex.
   - Building block `rbox` = `RoundedBoxGeometry(w,h,d, segments 2, r)` -> BoxGeometry(1,1,1,5,5,5) = **216 v / 300 t per rounded box** (vs 24 v / 12 t for a plain box). `cyl` Cylinder(seg 12 default) = 76 v / 48 t; legs Cylinder(8) = 52 v / 32 t; `ball` Sphere(10,8) = 99 v / 140 t.
   - Examples: table 1 rbox + 4 legs = 428 t; chair 5 rbox + 4 legs = 1,628 t; bed (double) 7 rbox + 4 legs = 2,228 t; sofa 11 rbox + 4 legs = 3,428 t; stairs 18 rbox = 5,400 t; rack 21 rbox = 6,300 t; shelf (W 2 m) ~38 rbox = ~11,400 t; **bookshelf (W 2.4 m, 5 rows of ~35 books) ~182 rbox = ~54,600 t / ~39,300 v per instance**; bars (W 3 m) 2 rbox + ~23 Cylinder(6) = ~1,150 t; officeChair 7 rbox + Cylinder(12) + 5 balls = ~2,850 t; plant Cylinder(14) + 3 balls = 476 t.
   - Drawn only in cut-open interiors (`emitInterior`) and for destruction fragments (`interiorFurniture`, capped at 140 pieces, buildingMesh.ts:4106-4127). InstancedMesh per kind, castShadow + receiveShadow (buildingMesh.ts:4021-4045). Whether the kit makes simplified levels for furniture is in kit.ts (other chunk).
   - Notable: rounded boxes with 2-segment bevels on every book and shelf board are extremely triangle-heavy for what they represent.
7. Signature-building facade kit (facadeKit.ts) - draws through a `Sink` (signature.ts, other chunk); boxes via `p.box` (count depends on Sink), raw geometries pushed:
   - `archFill` / `archRing` (:161-178): ExtrudeGeometry with `absarc` at curveSegments 16 -> 32 arc segments per arc: archFill ~36-point contour -> ~140 t (non-indexed ~420 v); archRing two arcs ~66-point contour -> ~260 t. Per arched window / door.
   - `spire` (:326-338): 4 x Cylinder(8) (52 v / 32 t) + Cone(8) (35 v / 16 t) = 243 v / 144 t.
   - `finial` (:341-349): box + Cylinder(8) + Cone(8) = 87 v / 48 t + box.
   - `cartouche` bosses (:410-428): 3 x Cylinder(1,1,out,14) = 264 v / 168 t.
   - `awning` (:276-288): BoxGeometry 24 v / 12 t + valance box.
   - Box-heavy generators: `balustrade` balusters every 0.24 m, `curtain` mullions per bay + transoms per storey, `cornice` 4 boxes (+ dentils every 0.32 m), `consoles` 2 boxes per 0.9 m, `archedDormer` 5 slices, `bellMansard` 4 hip tiers.
8. Flags (flagLayer.ts:103-162)
   - `PlaneGeometry(1,1,24,12)` = **325 v / 576 t**, indexed, wind-waved in the vertex shader. One InstancedMesh for all flags (instance attrs aPattern, aLength, aC0-aC2: 11 f32 = 44 B/instance), rebuilt whole on every `set`. DoubleSide, castShadow (gated by `castBySize`), **frustumCulled = false**.
9. Far-level window grid (facadeLevel.ts:33-224): no geometry; the facade run quads' fragment shader draws panes, frames, doors, shutters, streaks and lit rooms procedurally from per-vertex grid attributes (geometry generated in shader instead of instanced parts).
10. Glass panes' interior mapping (glassRoom.ts): fragment-shader ray-box room, floor, ceiling, furniture box and curtains behind each pane - replaces interior geometry; no triangles. Fades to a flat colour under ~3 px per pane.
11. Cell masses (`CellMass`, cellArrays.ts:226-322): merged massing chunks (massing.ts, other chunk) for cell/tile/plate levels. Vertex: position f32x3 or Uint16x4 grid (8 B), normal Int8x4 (4 B), color half x4 (8 B), facade f32x2 (8 B), grid half x4 (8 B), seed f32 (4 B) = **44 B/vertex** (40 gridded); index Uint16 if <= 65,535 vertices else Uint32.
12. Building fracture fragments (fracture.ts + fracture.worker.ts)
   - `fractureData` (:236-417): every shell triangle and every instanced part triangle (kit model `toNonIndexed`, x each instance's matrix) and floor slab quads are subdivided until every edge <= `MAX_EDGE` 1.4 m (cap 200,000 output triangles per input triangle stack, :68), assigned to 2.8 m jittered Voronoi cells; each solid (shell) triangle gets a back face (+1 t) and 2 t per cut edge (side walls, 0.28 m thick).
   - Output: **non-indexed** triangles, one merged buffer per building with a draw group per material (`mergeFragments`), vertex = position f32x3 + normal f32x3 + colour f32x3 + uv f32x2 + decay f32 + finish f32 = 13 f32 = **52 B/vertex**. Fragments split out on demand (`fragmentGeometry`, :173-202) as their own geometries when they fall.
   - Notable: per destroyed building the triangle count multiplies (subdivision of large wall quads to 1.4 m edges, x ~2-4 for thickness and cut sides); uses JS arrays of numbers (`number[]` per triangle, 36 numbers) - heavy GC in the worker.

#### F. Lab / tooling-only
- Brush cursor ring (B3), sculptor meshes (B1, B2) - lab only.

### Budgets, caps and counters found

- `FLEET_CEILING = 1200` (`MAX_VEHICLES`, agents.ts:81) - sizes vehicle blob capacity and culling arrays; parts grow past it (no draw cap).
- `PED_CEILING = 1000`: `MAX_PEDS` walkers drawn per frame (agents.ts:2485), `PROC_CAP` procedural bodies (:862); spare bodies kept <= 12 (:891).
- `PART_CAPACITY = 16` initial instances per vehicle part, doubling (agents.ts:110, :1419).
- `VEHICLE_NEAR_CAP = VEHICLE_WHOLE_CAP = 200` vehicles drawn whole (level 2), overridable per tier (`vehicleWholeCap`), picked by largest screen size (agents.ts:99, :2195-2201, :2476).
- Vehicle part levels: `LEVELS = 7` (`LEVEL_ERRORS` = 1.25 %, 2.5 %, 5 %, 10 %, 20 %, 40 % of extent), chosen by `ERROR_PIXELS` / tier `vehicleErrorPixels` (agents.ts:2185); far proxy simplified to 1 % target / 10 % error (:805).
- Vehicle zoom bands: NEAR_DETAIL_ZOOM perM(1.375), FAR_BODY_ZOOM perM(1.75), OCCUPANT_ZOOM perM(3), front-row-only below 1.6 x occupant zoom, hysteresis 0.1 (agents.ts:87-95, :2180).
- Hair strands only for `tier.hairStrandPeople` people (`HAIR_STRAND_PEOPLE = 8` in quality.ts).
- Blast: `MAX_PIECES = 1400` (boxes, cylinders, slabs each), car shells 80, `MAX_CRATERS = 60` per crater mesh, `MAX_SOOT = 600`, `MAX_WIRES = 40` x `WIRE_POINTS = 12`, 40 wrecks kept, 40 geysers (blast.ts:99-107, :376-381, :592).
- Barriers: `triangles = boxes * 12` counter (barriers.ts:115); pieces <= 4 m, posts every 2 m / 1.5 m, railing bars every 0.14 m.
- Buildings:
  - `SHELL_PIECE = 0xffff` vertices per shell piece -> Uint16 indices (cellArrays.ts:367); shells pieced by quadrant for culling (cellWork.ts:214).
  - Shell grid quantization step `SHELL_GRID_STEP = (CELL + 128 m) / 65535` (~5.9 mm) for the far level (cellArrays.ts:47-53); mass grid per square (5.9 / 18 / 33 mm).
  - `meshesOf` triangle counter: shell indices/3 + part kit triangles x count + furniture (buildingMesh.ts:3883-4045); `cellBytes` GPU-bytes counter for the residency budget (cellArrays.ts:333-345).
  - `FLAT_DEPTH = 0.3 m` far-level geometric error (openings shallower than this flattened to shader; small fittings dropped) (buildingMesh.ts:179).
  - Frame triangle budget: `FrameScale` / `fitErrorScale` raises the screen-space error scale by `ERROR_STEP = 1.25` up to `MOST_ERROR_SCALE = 32` until the chosen levels fit the view's triangle budget; steps finer below `SLACK = 0.6` (frameBudget.ts:4-64). `letGoPassed` / `letBackFitting` hold/release cells against the budget.
  - `TYPICAL_LEVEL_TRIANGLES`: cell detail 1,300,000 t, facade level 600,000 t per dense cell (frameBudget.ts:67); `LandedMeasure` tracks measured triangles per landed level and estimates unlanded ones.
  - Far part batch: initial capacity 256 per kind, doubling; per-cell triangle count (`trianglesOf`); bars hidden below `BAR_PIXELS` (farParts.ts).
  - Cell requests: `MOST_HOLES = 4` levels asked past a full upload queue (cellRequests.ts:30); upload queue reservation `reserveWarm`.
  - Cell job priority bands (`TIER`, `FAR_TIER`, `EDIT_TIER`) and persistent cache of mass/facade jobs (cellPool.ts).
  - Destruction furniture cap: 140 pieces (buildingMesh.ts:4118); fracture subdivision safety cap 200,000 triangles (fracture.ts:68).
- People lab sculpt undo stack 40 snapshots of the full piece positions (sculpt.ts:235).

### Files without geometry

- src/peopleLab: presets.ts (face/body/outfit presets data), record.ts (save format), sculptPanel.ts (UI panel), shapeKeys.ts (build-key logic), widgets.ts (DOM controls), proportions.ts (CPU measurement of the base mesh; no GPU data), thumbs.ts (renders other builders' meshes to images; only when baking), reshape.ts (rewrites an existing SkinnedMesh's positions; no new geometry).
- src/render/bake: catalogue.ts, detailRecipes.ts, finishRecipes.ts, roadRecipes.ts, terrainRecipes.ts (build-time texture recipes only).
- src/render: bakePool.ts (worker pool for bakes), buildingSwitches.ts (hides meshes / swaps materials for debug switches).
- src/render/buildings: cell.worker.ts (worker entry), cellPool.ts (job queue / cache), cellRequests.ts (request/landing bookkeeping), chunk.ts (types), cellWork.ts (job runner; orchestrates geometry emission but builds none itself), fade.ts (material swap), facadeLevel.ts (shader-only window grid), finishes.ts (shader / material code), glassRoom.ts (shader-only interior mapping), facadeProps.ts (prop placement rules only; models in facadePropModels.ts), frameBudget.ts (triangle budget logic, listed above), fracture.worker.ts (worker entry).

---

## Polygon geometry audit — chunk g04

### Files read

Every file of `parts/g04.txt` was read completely, first line to last (long files in sequential chunks: `layer.ts` 1–848 + 849–1243, `massCells.ts` 1–560 + 561–1081, `signature.ts` 1–450 + 450–899 + 900–1349 + 1350–1790, `carBody.ts` 1–520 + 520–1018, `cellInstances.ts` 1–530 + 530–1045).

| File | Lines |
|---|---|
| src/render/buildings/gpuBatchedMesh.ts | 406 |
| src/render/buildings/kit.ts | 704 |
| src/render/buildings/landmarks.ts | 421 |
| src/render/buildings/lawnGround.ts | 62 |
| src/render/buildings/layer.ts | 1242 |
| src/render/buildings/layerApi.ts | 111 |
| src/render/buildings/layerCells.ts | 313 |
| src/render/buildings/levelKeys.ts | 30 |
| src/render/buildings/lightSlots.ts | 29 |
| src/render/buildings/massBase.ts | 226 |
| src/render/buildings/massCells.ts | 1081 |
| src/render/buildings/massLevels.ts | 180 |
| src/render/buildings/massing.ts | 607 |
| src/render/buildings/massingMaterial.ts | 105 |
| src/render/buildings/partCells.ts | 442 |
| src/render/buildings/partFiling.ts | 209 |
| src/render/buildings/partPose.ts | 99 |
| src/render/buildings/partWarm.ts | 30 |
| src/render/buildings/parts.ts | 322 |
| src/render/buildings/partyWalls.ts | 114 |
| src/render/buildings/referenceModel.ts | 246 |
| src/render/buildings/roofPlan.ts | 83 |
| src/render/buildings/roomBehind.ts | 170 |
| src/render/buildings/roomLamps.ts | 62 |
| src/render/buildings/shellBatch.ts | 288 |
| src/render/buildings/shellParts.ts | 170 |
| src/render/buildings/signature.ts | 1790 |
| src/render/buildings/thinParts.ts | 98 |
| src/render/buildings/townColumns.ts | 178 |
| src/render/buildings/townIndex.ts | 130 |
| src/render/candidateKeep.ts | 83 |
| src/render/canyonLight.ts | 378 |
| src/render/carBody.ts | 1018 |
| src/render/casualties.ts | 164 |
| src/render/cellInstances.ts | 1045 |
| src/render/cellKeeps.ts | 106 |
| src/render/changeBoxes.ts | 63 |
| src/render/citizenAssets.ts | 8 |
| src/render/citizenBake.ts | 531 |
| src/render/citizenBake.worker.ts | 165 |
| src/render/citizenCasting.ts | 343 |
| src/render/citizenGait.ts | 608 |
| src/render/citizenPalette.ts | 55 |
| src/render/citizenPlays.ts | 154 |
| src/render/citizenStride.ts | 113 |
| src/render/citizenWalk.ts | 388 |
| src/render/clearingCells.ts | 87 |
| src/render/cloudShadowStamp.ts | 54 |
| src/render/coverRaster.ts | 94 |
| src/render/coverSweep.ts | 251 |
| **Total (50 files)** | **15,656** (wc -l; Read shows +1 for files ending without a final newline) |

Outside the list, read only to resolve numbers (said where used):
- `src/render/buildings/cellArrays.ts` lines 128–252 (shell / mass vertex layouts, `MASS_FACADE = 2`, `MASS_GRID = 4`, `indexArray`), and grep of its constants (`SHELL_MESH`, `FINISH_ATTRIBUTE`, `SHELL_NORMAL`).
- `src/render/buildings/frameBudget.ts:67` (`TYPICAL_LEVEL_TRIANGLES`) and `src/core/perfBudget.ts:44-48` (`VIEW_BUDGETS`) via grep.
- `node_modules/three` r186 (`REVISION = '186'`): `CylinderGeometry.js` 81-84/169-176 (cone has no top cap and skips the apex triangle row), `SphereGeometry.js` 139-140, `PolyhedronGeometry.js` (non-indexed), `ExtrudeGeometry.js` (non-indexed), `examples/jsm/postprocessing/Pass.js:116` (FullScreenQuad = one 3-vertex triangle).
- Not resolved (outside chunk, not opened): `facadePropModels.ts` (acUnit/pot/foliage/bush/lounger/bike/chair/table/airer/dish models and `acFarGeometry`), `furnitureKit.ts`, `facadeKit.ts` (the sink the landmark designs emit into), `buildingMesh.ts` (`emitChunk`, `buildBuildingMeshes`), `farParts.ts`, `flagLayer.ts`, `facadeLevel.ts`, `finishes.ts`, `interiorSolids.ts`, `vehicleModels.ts`. Their triangle counts are not given here.

### Elements

Conventions: BoxGeometry(…) = 24 v / 12 t, indexed Uint16, position+normal+uv Float32 = 32 B/vertex. "v/t" = vertices/triangles. Non-indexed geometry: 3 v per triangle.

#### 1. Building part kit (instanced part models) — `kit.ts`
- Location: `createBuildingKit` kit.ts:450-704; geometry table kit.ts:453-475; builders kit.ts:222-447.
- Primitive: indexed triangles (BufferGeometry from three built-ins + `mergeGeometries`), Uint16 index; attrs position/normal/uv Float32 (32 B/v) unless stated.
- Counts (finest level = `levels[0]`):
  | Kind | Geometry | v / t |
  |---|---|---|
  | glass, glassDark | PlaneGeometry(1,1) shared | 4 / 2 |
  | frame | 2 boxes + 4 `boxWithout` (2 faces dropped each) — kit.ts:254 | 144 / **56** (comment kit.ts:253 says "60 triangles where 72"; computed 2×12 + 4×8 = 56). 48 of the 144 vertices are orphans left by `boxWithout` (index trimmed, vertices kept) |
  | concrete, shutter, water, lamp, fin | unit BoxGeometry shared | 24 / 12 |
  | door | 6 boxes (leaf, 4 panels, handle) kit.ts:330 | 144 / 72 |
  | railing | 4 rails + 11 front + 6 side balusters = 21 boxes kit.ts:270 | 504 / 252 |
  | roofRailing | 2 rails + 5 posts = 7 boxes | 168 / 84 |
  | awning | 2 boxes (canvas, valance) | 48 / 24 |
  | column | CylinderGeometry(0.5,0.5,1,12,1,open) | 26 / 24 |
  | wash | PlaneGeometry(1,1) | 4 / 2 |
  | louvre | 2 rails + 3 `boxWithout`(8 t) + 9 slats (5 inner with ends dropped = 8 t, 4 outer 12 t) kit.ts:345 | 336 / 136 (orphans 9×4+... vertices) |
  | glassRail | 1 box via mergeGeometries | 24 / 12 |
  | brise | 6 boxes | 144 / 72 |
  | lotBox / lotSlab (shell parts) | `shellPartGeometry` 5 faces fan-triangulated, pos/normal/uv/color Float32 = 44 B/v | 20 / 10 |
  | lotRail | 4 faces | 16 / 8 |
  | facade props (acUnit, pot, foliage, bush, lounger, bike, chair, table, airer, dish) | `createFacadePropGeometries()` (facadePropModels.ts, not in chunk) | not resolved |
- Coarser LOD levels added (kit.ts:594-616): frame card (Plane, 4/2 + `partCard` attr), railing card (3 quads → `twoSided` 24/12, pos+normal+partCard = 28 B/v), roofRailing card (8/4), acUnit far (`acFarGeometry`, not resolved), brise far (6 quads twoSided 48/24, pos+normal only), louvre far = unit box (24/12), door far = 1 box (24/12), each shell part top-only (4/2), concrete/fin/water top face (4/2). Small props (`SIMPLIFIED` = bike, foliage, bush, airer, table, dish, pot, chair, lounger) get up to 4 meshoptimizer levels at absolute errors 0.01/0.025/0.06/0.15 m, kept only if ≤ 75 % of the previous level's triangles (`FEWER`), built asynchronously (kit.ts:185-219, 636-641); welded clone + new Uint32 index each (positions kept in full, only the index shrinks).
- Multiplicity: one model per kind for the whole renderer; drawn as InstancedMesh runs per cell sub-cell (see §3). Shadows: `castsShadow` set kit.ts:663 (glass, glassDark, frame, door, shutter, concrete, railing, awning, column, roofRailing, fin, louvre, brise, SHADOWED_PROPS, shell parts); cards never cast (partCells.ts:185). Glass casts front side only (`shadowSide: FrontSide`).
- Notable: `boxWithout` leaves unreferenced vertices in the vertex buffer (frame 48 of 144, louvre 5×8+3×8 of 336); frame card/railing-card discards in the fragment shader (`thinParts.ts` CARD_GLSL) — cheap geometry, more fragment work.

#### 2. Thin-part helpers — `thinParts.ts`
- `twoSided(g)` thinParts.ts:4-31: duplicates vertices (2n) with negated normals, index doubled, Uint16 if 2n ≤ 65535; drops uv. Used by brise far, railing card, roofRailing card.
- `prefilterThinParts` thinParts.ts:60-98: shader-only (bar coverage, card discard), no geometry.

#### 3. Part cells (instanced part runs per 256 m cell) — `partCells.ts`, `partFiling.ts`, `partPose.ts`
- Location: `PartCell` partCells.ts:97-433, `make` partCells.ts:398-432 (`new InstancedMesh(geometry, material, 0)`), `posedLevel` 380-395, filing `fileParts` partFiling.ts:66-79.
- Primitive: InstancedMesh of the kit model (indexed triangles); per-instance attributes from interleaved buffers: pose 8 floats = 32 B (`POSE_FLOATS`, partPose.ts:6, replaces a 64 B matrix; matrix built in the vertex shader `partPoseShader`), colour 3 half floats = 6 B (`isFloat16BufferAttribute`), shell parts' look 3 floats = 12 B (finish, decay, ground).
- Multiplicity: per cell 16 sub-cells (`LEAVES = 4×4`, `DETAIL_CELL = 64 m`); per kind instances split into error bands (`bandOf`, base 1 cm ×4 per band, ≤ 16 bands), bands merged until they draw ≥ `DRAW_TRIANGLES = 16384` (partFiling.ts:19,149). One InstancedMesh per contiguous run of sub-cells at the same LOD; run merging rules partCells.ts:236-254. Instance not drawn when its diagonal < 1 px, bars (frame/railing/brise) when bar width < `BAR_PIXELS = 0.5` px; coarser level taken when its error < `PART_ERROR_PX = 1.5` px with hysteresis `COARSEN = 0.85`. Meshes evicted `EVICT_AFTER = 240` choices out of view. Shadow: casts only where widest piece ≥ cascade texel (`castInto`), cards never.
- Triangles counter: `PartCell.triangles` = Σ mesh.count × level triangles (partCells.ts:308-312).
- Notable: each run gets a posed copy geometry per level (shares the kit's attributes/index, own pose binding) — cheap; shell parts switch to `kit.farShell` program under `LIGHT_PIXELS = 6` px/m.

#### 4. Part warm-up meshes — `partWarm.ts`
- partWarm.ts:8-30: one `InstancedMesh(kit.geometry[kind], material, 1)` per PART_KIND, one faded `lotBox`, one per FURNITURE_KIND; frustumCulled false, used only to compile programs. Counts = the kit models above (1 instance each).

#### 5. Shell multi-draw batches — `shellBatch.ts` + `gpuBatchedMesh.ts`
- Location: `ShellBatch.makeBatches` shellBatch.ts:199-222 (`new GpuBatchedMesh(64, 1<<14, 1<<15, material)`), `add` 61-102, `worldGeometry` 248-272; `GpuBatchedMesh` gpuBatchedMesh.ts:69-406.
- Primitive: three BatchedMesh multi-draw (indexed triangles), storage as `GLBufferAttribute`s on the GPU only; index **always Uint32** (`INDEX_BYTES = 4`, gpuBatchedMesh.ts:44).
- Batches: 3 — `detail` (cell L0 walls, kit.shellMaterial), `facade` (L1 plain walls, kit.facade), `runs` (L1 bays with openings, kit.facade). Every cell's `SHELL_MESH` meshes are copied in as one geometry + one instance (identity matrix).
- Vertex layout (cellArrays.ts:134-150, outside chunk): shell 24 B/vertex quantized (position 4×Uint16 normalized, normal octahedral 2×Int16, paint Uint16s), runs 44 B/vertex. `worldGeometry` rewrites positions to Float32×3 (12 B instead of 8 B) before the batch copies them: +4 B/vertex in the batch.
- Capacity: start 64 instances / 16,384 vertices / 32,768 indices; grows to (used + new) × 1.25, compacted (`compact`) when holes > 25 % or > 32k; instance capacity doubles, never shrinks.
- Shadows: castShadow true, drawn into each cascade by three's multi-draw (onBeforeShadow); not cast in far cascades (`castShadow(false)` when `coarse`). Occlusion: per-instance hiding for the colour camera only (`colourHidden`). Unused reserved index ranges filled with degenerate triangles (gpuBatchedMesh.ts:223, 336).
- Notable: Uint32 indices for everything (2× index memory vs the Uint16 source pieces), float positions re-expanded (+50 % on position bytes); `raycast` disabled (no CPU arrays). Per-geometry local index copies kept on the CPU (Uint16 when ≤ 65,535 vertices) for compaction.

#### 6. Building masses (far level L1.5/L2/L3) — `massing.ts`, `massCells.ts`
- Builder: `MassWriter` massing.ts:94-192 (`face` fan-triangulates convex polygons: n points → n v, n−2 t; `polygon` earcut with shared points), `emitVolume` 316-403, `emitRoof` 405-491, `emitPolygonRoof` 494-556, `box` 559-565 (5 faces = 20 v / 10 t), `emitRoofPlant` 571-596, `emitMachineRooms` 599-607, `emitLotPlates` 274-300.
- Worker-side layout: position3 + normal3 + colour3 + facade4 + glazing2 Float32 = 60 B/vertex, Uint32 index. GPU layout (`cellMesh` massCells.ts:244-275 + cellArrays.ts:227-246): position 4×Uint16 normalized (8 B, on the square's grid) or 3×Float32, normal 4×Int8 (4 B), color 4×half (8 B), facade 2×Float32 (8 B), facadeGrid 4×half (8 B), glazingSeed Float32 (4 B) = **40 B/vertex** quantized; index Uint16 when ≤ 65,535 vertices else Uint32.
- Counts per building (formulas): each wall run = 1 quad (4 v / 2 t), storeys merged vertically when alike (massing.ts:358-366); a relief/recess run adds 3 quads (cheeks + head); flat-roof parapet per exposed side part = 3 quads (outer, cap, inner); roof slab earcut (rectangle 4 v / 2 t); gable = 2 roof quads + 2 gable triangles (14 v / 6 t); hip = 2 quads + 2 triangles; shed = 1 quad + 2 triangles + 1 quad; sawtooth per tooth 2 quads + 2 triangles (14 v / 6 t); polygon pitched roof: clipped patches (earcut) + walls stepped **8 quads per ring edge** (massing.ts:545); machine room / lift room / tank / chimney / skylight / solar / air handler / parasol = box 20 v / 10 t each. Example: a plain rectangular flat-roof block with parapet and no reliefs ≈ 4 wall quads + 12 parapet quads + slab = 68 v / 34 t (+20/10 per machine room).
- LOD levels: cell (`CELL_DETAIL` drop 0), tile 1,024 m (`TILE_DETAIL` drop 3 m: no parapets, machine rooms, ≤ 3 m plant, reliefs < 3 m laid flat), plate 2,048 m (`PLATE_DETAIL` drop 8 m, pitched roofs < 8 m flattened to boxes). `emitMassingLevels` reuses the finer chunk if nothing between the drops was asked.
- Multiplicity: one Mesh per 256 m cell (`createMassCells`), per tile (16 cells), per plate (64 cells), material `kit.massing`; castShadow + receiveShadow true; far cascades use these masses instead of detail (`shadowMasses`). Choice: near when `FAR_ERROR (1.5 m) × px/m ≥ 2 px` (`NEAR_PIXELS`), forced detail within `DETAIL_REACH = 1.4 km` when ≥ 0.5 px/m; fine (L0) when 0.3 m (`FLAT_DEPTH`) spans ≥ 1 px; hysteresis 0.85; street-level horizon relaxation (`STREET_EYE 40 m`, `HORIZON_HALF 150 m`).
- Counter: `farTriangles` = Σ triangles of standing (shown) masses (massCells.ts:318-331).

#### 7. Building base (top level) — `massBase.ts`, `massCells.ts` `baseMesh`
- Location: `emitBase` massBase.ts:118-157 (`prism`, `slab`), `BaseWriter.done` 172-218; mesh `baseMesh` massCells.ts:105-128.
- Primitive: indexed triangles, one interleaved buffer of 4×Uint16 per vertex (position normalized + 5-6-5 sRGB paint) = **8 B/vertex**; Uint16 index per piece (`PIECE_VERTICES = 65535`), Uint32 fallback; flat shading, flat-varying colour (massingMaterial.ts:44-51).
- Counts: per closed block with an n-point footprint: roof ring n v + earcut n−2 t, foot ring n v, walls 2n t → **2n v / 3n−2 t** (rectangle 8 v / 10 t). Paved lots ≥ 100 m² (`LOT_AREA`): n v / n−2 t. Measured in-code: 6.6 MB for 25,000 buildings, 277 B/building (comment massBase.ts:21).
- Multiplicity: per 2,048 m plate square, pieces of ≤ 65,535 vertices; never evicted; drawn only for cells nothing finer draws via geometry groups (`syncBases` massCells.ts:730-756, one draw per contiguous run). castShadow + receiveShadow true.

#### 8. Building layer previews / bridges / solo — `layer.ts`
- `ghost` (placement preview, layer.ts:947-964), `solo` ("Ocultar outros" kept building, 913-923), `bridges` (just-placed building until its cell lands, ≤ `BRIDGE_MAX_MS = 20 s`, 926-946): each is `buildBuildingMeshes([b], …)` (buildingMesh.ts, not in chunk) — one building's full detail meshes, drawn outside the batches.
- `castInto` layer.ts:1101-1131: past the first cascade a part casts only if wider than max(texel, `CAST_RADIUS_SHARE 0.03` × cascade half side); far cascades hide all detail/part groups of cells whose masses stand in.
- Occlusion: `hideOccluded` hides masses, cell groups, part groups and batch instances whose plan box is behind walls (colour pass only).

#### 9. Cell groups — `layerCells.ts`
- `cellGroup` layerCells.ts:79-101: a Group of the cells' batches; `triangles` = Σ part triangles. No geometry built here. Cover index (`coverCell`) is CPU polygons for plant culling (Float64 xy), not GPU.

#### 10. Signature buildings — `signature.ts` (+ `landmarks.ts`)
- Location: `buildSignature` signature.ts:1751-1786, `Parts` class 360-607, designs 610-1734 (24 designs + 9 `towerOf` looks + 5 landmarks from `landmarks.ts`).
- Primitive: per material one merged Mesh, **non-indexed** triangles: every pushed geometry is `toNonIndexed()` (signature.ts:377) before `mergeGeometries(list, false)`; attrs position/normal/uv Float32 = 32 B/v.
- Primitive counts (after toNonIndexed):
  | Builder | v / t |
  |---|---|
  | `box` (BoxGeometry) | 36 / 12 (+ 36/12 extra "roofing" cap box whenever the material is a facade style, signature.ts:388-390) |
  | `rail` (box, alpha-tested railing) | 36 / 12 |
  | `plant` (pot box + Icosahedron(r,1) + Icosahedron(r,0)) | 336 / 112 |
  | `bush` Icosahedron(r,1) | 240 / 80 |
  | `cone` (pot box + Cone(0.38,1.6,7)) | 78 / 26 |
  | `cypress` Cone(7) | 42 / 14 |
  | `cylinder` Cylinder(r,r,h,10) closed | 120 / 40 |
  | `tree` (cylinder + 2 bushes) | 600 / 200 |
  | `lamp` (cylinder + 3 boxes) | 228 / 76 |
  | `ellipse` seg 24 / 20 / 16 | 288/96, 240/80, 192/64 |
  | `prism` seg n (Cylinder n,1 closed) | 12n / 4n (3: 36/12, 4: 48/16, 6: 72/24, 8: 96/32) |
  | `gable` (8 triangles, drawn twice, both windings) | 48 / 16 |
  | `hip` (Cylinder 4 seg, closed) | 48 / 16 |
  | `dome` Sphere(16,8, half) | 720 / 240 |
  | `steps` n | n boxes: 36n / 12n |
  | `decal` Plane | 6 / 2 |
  | `windowFront` (mullions m) / `windowSide` | (5+m) boxes: 216/72 for m=1; 6 boxes 216/72 |
  | `colonnade` per column (2 boxes + cylinder) | 192 / 64 |
  | `balustrade` | 2 boxes + cylinder (40 t) every 0.35 m |
  | `roofRing` | 5 boxes 180 / 60 |
  | `podium2` | box + 2×cols glass boxes + roofRing + canopy + windowFront + 2 cones + 6 bushes ≈ 700+ t |
  | raw cones (hex roof 6 seg, spire 8 seg, apse 8, water-tower cap 12) | 2×seg t (12, 16, 16, 24) |
- Per-design scaling (W, D in m from the base block, `upper` storeys): e.g. `waveWhite` per storey ≈ 2 mirrors × ⌈(W−3)/1.2⌉ × 2 boxes + 2 × ⌈(D−5)/1.2⌉ boxes (≈ 1,600 t per storey at W = D = 30 → ≈ 48 k t for 30 storeys); `balconyMid` per storey: 8 plants (896 t) + windows + rails + slabs; `cubeBalcony` per storey ≈ cols/2 × 2 mirrors × 5 boxes; `cemetery` per grave 2–3 boxes over all plots; `towerOf` bands: 4 band boxes + up to 4 glass-rail boxes per storey.
- Multiplicity: one Group per signature building (few), one draw per material used (often 20–40 materials → 20–40 draws), castShadow on every mesh except `glass` and `sconce` (signature.ts:1772), so all those draws repeat in each cascade. Facade style: one shared material/canvas per style (24 styles), decals one material each.
- Landmarks (`landmarks.ts:27-415`): designs emit through `facadeKit` (`fbox`, `punched`, `curtain`, `cornice`, `balustrade`, `plantedTree`, `lampPost`, `bellMansard`, `archedDormer`, `spire`, …) into the same `Parts` sink (LandmarkSink); per-call counts live in `facadeKit.ts` (not in chunk). They loop per face × storey × bay (e.g. Art Deco tower: per storey per wing `punched` windows every 2.6 m; Beaux-Arts hotel: per face × storey × 4–5 bays), so their triangle count scales with storeys × perimeter.
- Notable: everything non-indexed (×3 vertices per triangle vs ~×1–2 indexed), Icosahedron detail 1 (80 t) for every potted plant/bush, every box (even tiny gold caps, sconces) casts shadows, extra roofing cap box per facade box.

#### 11. Thumbnail studio — `parts.ts`
- `createThumbnailStudio` parts.ts:137-322: a second WebGLRenderer (224×224, `PER_FRAME = 3`), its own `createBuildingKit()`, `buildBuildingMeshes([sample])` + optional `buildSignature` per gallery item; geometry = one building's meshes, disposed after each shot. Not in the game scene.

#### 12. Reference model (Builder glTF overlay) — `referenceModel.ts`
- `load` referenceModel.ts:173-202: GLTFLoader.parseAsync of a user file; meshes as authored (no decimation/LOD), DoubleSide, castShadow/receiveShadow false, renderOrder 2. `captureModel` 59-140 reads every triangle on the CPU (index or position count / 3) and renders 5 orthographic views (≤ 2048 px, 8 px/m) twice (colour + depth) in a throwaway renderer. Vertex/triangle count = the imported file's.

#### 13. Car bodies — `carBody.ts`
- Location: `buildCarModel` carBody.ts:382-958.
- Body surface: loft of stations × ring. Stations = 65 uniform (`N = 64`) + 16 nose/tail + 2 × 21 arch + 4 per door edge (3 edges sedan/wagon/hatch/suv/pickup, 2 van) + 8 glass/screen + 4 rear + 2 bed, deduplicated at 4 mm → about 140–150 stations. Ring = `RING = 46` points. Quads = (stations − 1) × 46 → ≈ 6,400 quads ≈ **12,800 triangles** + caps 2 × 46 = 92 t. Built non-indexed in `fromFaces` (3 v per triangle, position/normal/color Float32 = 36 B/v) then welded in `merge` (`weldGeometry`) by position+normal+colour → indexed; split by region into shell, glass, openShell, openGlass, roof, door panels/glass/cards, so parts of the surface appear in several output geometries (closed vs open variants).
- Trim: grille `roundedSlab` (ExtrudeGeometry, curveSegments 3, ≈ 16 outline points → ≈ 60 t), 4 wheel-house liners (extrude of 26-point band, no bevel → ≈ 26×2 + 2×24 ≈ 100 t each).
- Door fittings: handle box 12 t, mirror: bar box 12 t + roundedSlab ≈ 60 t + glass box 12 t.
- Interior (CabinParts): carpet/shelf/card/wall boxes (12 t each), dashboard extrude (7 points, bevel 2 segments → ≈ 7×5×2 + 10 ≈ 80 t) + binnacle roundedSlab + screen box, console roundedSlab, lever, column bar, 3 pedals (2 boxes each), seats: `seatShell` = profile extrude (8 points, bevel 2 → ≈ 92 t) + 2 bars + 1 box; headrests: roundedSlab + 2 boxes.
- Steering wheel `steeringWheel` 1006-1018: Torus(r, 0.02, 8, 28) 261 v / 448 t + 3 spoke boxes (36 t) + boss Cylinder(14) closed 88 v / 56 t → ≈ 540 t.
- Far LOD carBody.ts:914-929: 3 boxes = 72 v / **36 t** (comment: used under 9 px long; replaced ~440 t meshopt attempt).
- Multiplicity: built per archetype × style (6 styles), drawn per car by the agents renderer (not in chunk).
- Notable: the shell is ~13 k triangles per car model at full detail; `merge` welding keeps hard region edges split.

#### 14. Blood decals — `casualties.ts`
- casualties.ts:106-120: CircleGeometry(0.5, 20) rotated flat: 22 v / 20 t, indexed; 3 InstancedMeshes (pool/splat/drops), cap `MAX = 400` instances each, DynamicDraw matrices, no shadows, frustumCulled false, transparent, renderOrder 4, matrices re-sent only when the list changes.

#### 15. Generic instance cells (gardens / props / plants) — `cellInstances.ts`
- Location: `createCellInstances` cellInstances.ts:434-1045; `makeMesh` 589-614 (`dressedMesh` → `new InstancedMesh(geometry, material, 1)`), `batchMesh` 317-327.
- Primitive: InstancedMesh over each kind's model (geometry from other modules); per-instance pose of `stride` 5–8 floats (20–32 B) interleaved, matrix rebuilt in the vertex shader (`poseVertexShader`), optional tint 3×Float32 (12 B), DynamicDraw; hidden poses collapse to a point (degenerate).
- Multiplicity: kinds filed in a quadtree of 64 m leaf cells (`CELL`), `LEVELS = 10` (roots 65 km); per kind two levels (near model / far impostor), level by screen size with `HYSTERESIS = 0.15`; buffers sized to what is in view (min 64, ×2 growth, shrink at < ¼). Shadows via `castBySize` (kinds with `least`/`small` need ≥ 2 texels, `SMALL_CAST_TEXELS`); off-frustum instances kept when under the cascades (`keep` box). Empty meshes removed from the scene (`settleInScene`).
- Counter: `triangles` (cellInstances.ts:912-916) = triangles(model) × (used − dead) for every near mesh — counts **all live instances**, not the culled/drawn ones (over-reports what the GPU draws).

#### 16. Canyon light post-process — `canyonLight.ts`
- `createCanyonLight` canyonLight.ts:198-378: `ShaderPass` → three FullScreenQuad = **1 triangle, 3 vertices** (position+uv, Pass.js:116). Fragment does up to 8 dirs × 3 height taps + 8 depth taps for the normal + 8 contact-shadow steps per pixel. Data texture 512×512 RGBA8 (`SIDE = 2048/4`) = 1 MB height field, row-range uploads.

#### 17. Citizen rigs for baking — `citizenBake.ts`, `citizenBake.worker.ts`
- `rigFromData` citizenBake.ts:502-531 rebuilds a SkinnedMesh with position (3×Float32), skinIndex (4×Float32), skinWeight (4×Float32) per vertex in the worker — 44 B/vertex, never drawn (used to pose bones and measure feet). `restRig` clones the body scene for baking. Vertex counts are the cooked MakeHuman body's (people/ modules, not in chunk).
- Output is bone palettes, not geometry: per clip `(frames + 2) × bones × 12` floats (`PACKED_BONE_FLOATS`), FPS 30 (10 for loops > 6 s; riders 2/6/30).
- `citizenPlays.ts` 44-87: atlas DataTexture RGBA32F, width = bones × 3 texels, height = rows × 1.25 slack (doubling on growth); GPU blends ≤ `GPU_PLAYS = 4` plays.
- `citizenCasting.ts`: the scenery cast `CROWD` = 2 sexes × 8 (age, wardrobe) picks → up to 16 distinct bodies (body meshes defined elsewhere).

#### 18. Changes boxes for shadow store patches — `changeBoxes.ts`
- No geometry; caps `MOST = 128` boxes per list, `LAYER_BOXES = 32` per mesh; determines how much of each cascade is redrawn.

#### 19. Plant/stone placement densities — `coverSweep.ts`
- No geometry, but sets instance counts fed to instance cells: forest tree candidate every `FOREST_SPACING = 12 m` lattice cell (≤ 1/144 m², kept by density × 0.92), scrub every `2.4 m` (≤ 1/5.76 m²), rocks every `3.2 m` (≤ 1/10.24 m², × √density × 0.7), river rocks every `3 m` within 12 m of water. Scrub at full density can reach 1 per 5.76 m² ≈ 1,736 instances per hectare (trees ≤ 69/ha, rocks ≤ 977/ha before the density draw).

### Budgets, caps and counters found
- `VIEW_BUDGETS` (core/perfBudget.ts:44-48, outside chunk): street 16 M triangles / 1,000 draws, district 16 M / 1,100, map 8 M / 400; buildings' share × `quality.triangleScale` sets `frame.budget` (renderer.ts:3511).
- `TYPICAL_LEVEL_TRIANGLES` (frameBudget.ts:67): cell 1,300,000, facade 600,000 (reckoning before a level lands).
- `GAME_DETAIL_MEMORY_MB = 768` (layer.ts:47) cap on cells' detail GPU bytes; `room()` also bounded by `gpuLedger.roomFor`.
- `CAST_RADIUS_SHARE = 0.03` (layer.ts:53) shadow caster size threshold past the first cascade.
- Mass LOD: `FAR_ERROR = 1.5 m`, `NEAR_PIXELS = 2`, `FINE_PIXELS = 1`, `HYSTERESIS = 0.85`, `DETAIL_REACH = 1.4 km`, `DETAIL_REACH_VISIBLE = 0.5 px/m`, `PLATES_IN_FLIGHT = 3`, `TILE_DETAIL.drop = 3 m`, `PLATE_DETAIL.drop = 8 m`, base `LOT_AREA = 100 m²`, `PIECE_VERTICES = 65535`.
- Parts: `PART_ERROR_PX = 1.5`, `BAR_PIXELS = 0.5`, `COARSEN = 0.85`, `LIGHT_PIXELS = 6 / LIGHT_BACK = 7`, `EVICT_AFTER = 240`, `DRAW_TRIANGLES = 16384`, `LEAVES = 16`, `DETAIL_CELL = 64 m`, meshopt errors `[0.01, 0.025, 0.06, 0.15]` m, `FEWER = 0.75`.
- Shell batch: initial 64 instances / 16,384 v / 32,768 i, ×1.25 growth, compaction thresholds `1<<15`.
- `STREAM_AHEAD = 8` cells asked at once; `BRIDGE_MAX_MS = 20000`.
- Casualties `MAX = 400` per variant (3 variants).
- Cell instances `MIN_CAPACITY = 64`, `HYSTERESIS = 0.15`, `SMALL_CAST_TEXELS = 2`, quadtree `CELL = 64 m`, `LEVELS = 10`.
- Change boxes `MOST = 128`, `LAYER_BOXES = 32`, `TOUCH = 16 m`.
- Counters: `BuildingLayer.triangles` (layer.ts:693-698, visible cells + parts + ghost), `chosenTriangles` (layer.ts:259-269), `massCells.farTriangles` / `massTriangles`, `PartCell.triangles`, `CellInstances.triangles` (all live instances, see §15), `gpuLedger.set(..., bytes, triangles)` for cell/facade levels, masses (`sendUp`), bases; `levels()` census and `books()`; massBase comment measurement 277 B/building.

### Files without geometry
- `src/render/buildings/`: `layerApi.ts` (interfaces), `levelKeys.ts` (cell/tile/plate keys), `lightSlots.ts` (pane seed hash), `lawnGround.ts` (ground height sampling under a footprint), `massLevels.ts` (tile/plate job scheduling), `massingMaterial.ts` (shader patch only; flat shading for the base), `partyWalls.ts` (CPU test that drops wall bays hidden by a neighbour — reduces geometry elsewhere, builds none), `roofPlan.ts` (roof plant plan data), `roomBehind.ts` (12 floats per pane room data), `roomLamps.ts` (GLSL lamp colours), `townColumns.ts`, `townIndex.ts` (signature body bookkeeping only; bodies built in signature.ts), `partFiling.ts` (instance filing data only), `partPose.ts` (pose → matrix shader patch; 32 B/instance pose format).
- `src/render/`: `candidateKeep.ts`, `cellKeeps.ts`, `changeBoxes.ts`, `citizenAssets.ts`, `citizenCasting.ts`, `citizenGait.ts`, `citizenPalette.ts`, `citizenPlays.ts` (bone atlas texture), `citizenStride.ts`, `citizenWalk.ts`, `citizenBake.worker.ts` (worker plumbing), `clearingCells.ts`, `cloudShadowStamp.ts`, `coverRaster.ts`, `coverSweep.ts` (placement densities only).

---

## Polygon geometry audit - chunk g05

Read-only audit of 88 files under `src/render/` (densityCars.ts .. partLevelsWork.ts). All three.js formulas checked against `node_modules/three` r186 (`src/constants.js` REVISION '186'): `CylinderGeometry.generateTorso` skips the (a,b,d) triangle of the top row when radiusTop = 0 and the (b,c,d) triangle of the bottom row when radiusBottom = 0; caps are `rs` triangles each with `rs + (rs+1)` vertices; `SphereGeometry` skips the top-row and bottom-row degenerate triangles (2·w·h − 2·w triangles); `PolyhedronGeometry` is non-indexed with (detail+1)² triangles per base face; `LineSegmentsGeometry` base is 8 vertices / 6 triangles (indexed) per instanced segment.

### Files read

Every file was read completely, first line to last (`Read` of the whole file; densityCars.ts .. derivedWriterLane.ts through one `cat -n` dump read whole).

| File | Lines |
|---|---|
| src/render/densityCars.ts | 509 |
| src/render/depthConvention.ts | 36 |
| src/render/derivedCache.ts | 2 |
| src/render/derivedWriter.worker.ts | 46 |
| src/render/derivedWriterLane.ts | 50 |
| src/render/destruction.ts | 409 |
| src/render/ecology.worker.ts | 37 |
| src/render/ecologyKept.ts | 86 |
| src/render/ecologyPool.ts | 103 |
| src/render/effectSwitches.ts | 64 |
| src/render/elements.ts | 357 |
| src/render/environment.ts | 335 |
| src/render/exhaust.ts | 239 |
| src/render/farForest.ts | 358 |
| src/render/farGround.ts | 65 |
| src/render/farWoods.ts | 195 |
| src/render/flatAtlas.ts | 959 |
| src/render/flatGround.worker.ts | 29 |
| src/render/flatGroundPool.ts | 103 |
| src/render/fogLayer.ts | 204 |
| src/render/frustumGround.ts | 57 |
| src/render/gardenLists.ts | 123 |
| src/render/gardens.ts | 274 |
| src/render/gore.ts | 258 |
| src/render/gpu/backendChoice.ts | 8 |
| src/render/gpu/compatibility.ts | 89 |
| src/render/gpu/imageCompare.ts | 80 |
| src/render/gpu/twins.ts | 132 |
| src/render/gpu/webgpuView.ts | 410 |
| src/render/gpuLedger.ts | 132 |
| src/render/gpuTimer.ts | 96 |
| src/render/grass.ts | 97 |
| src/render/groundChanges.ts | 79 |
| src/render/groundCover.ts | 322 |
| src/render/groundShape.ts | 266 |
| src/render/groundShape.worker.ts | 21 |
| src/render/groundShapePool.ts | 131 |
| src/render/groundShear.ts | 35 |
| src/render/impostorShaders.ts | 314 |
| src/render/inspector.ts | 96 |
| src/render/instanceBounds.ts | 26 |
| src/render/instanceCull.ts | 40 |
| src/render/instanceRuns.ts | 220 |
| src/render/interiorSolids.ts | 70 |
| src/render/inventory.ts | 177 |
| src/render/isoViewport.ts | 460 |
| src/render/ktxParse.d.ts | 62 |
| src/render/landStroke.ts | 155 |
| src/render/landStroke.worker.ts | 17 |
| src/render/landStrokePool.ts | 25 |
| src/render/lightLevels.ts | 61 |
| src/render/lightning.ts | 138 |
| src/render/lotLattice.ts | 446 |
| src/render/lotOverlay.ts | 517 |
| src/render/lowPolyTrees.ts | 636 |
| src/render/markings.ts | 61 |
| src/render/materials.ts | 148 |
| src/render/memoryCounters.ts | 146 |
| src/render/mesh/detailLayer.ts | 122 |
| src/render/mesh/gpuOnly.ts | 56 |
| src/render/mesh/roadEdges.ts | 52 |
| src/render/mesh/roadLod.ts | 78 |
| src/render/mesh/roadLodPure.ts | 81 |
| src/render/mesh/roadResidency.ts | 351 |
| src/render/mesh/simplify.ts | 28 |
| src/render/mesh/stream.ts | 54 |
| src/render/mesh/surfaceMesh.ts | 47 |
| src/render/mesh/surfaceTiles.ts | 241 |
| src/render/mesh/textureBaker.ts | 141 |
| src/render/mesh/tileMesh.ts | 317 |
| src/render/mesh/tileShape.ts | 577 |
| src/render/mesh/updateRanges.ts | 23 |
| src/render/mesh/weld.ts | 80 |
| src/render/meshoptSimplifier.d.ts | 14 |
| src/render/natureNoise.ts | 25 |
| src/render/natureTrees.ts | 331 |
| src/render/networkFarRoads.ts | 280 |
| src/render/networkFarRoads.worker.ts | 18 |
| src/render/networkFarRoadsBuild.ts | 187 |
| src/render/occlusion.ts | 260 |
| src/render/occupants.ts | 240 |
| src/render/optimizationTypes.ts | 30 |
| src/render/optimizations.ts | 376 |
| src/render/optimizationsApply.ts | 262 |
| src/render/optimizationsQuality.ts | 114 |
| src/render/pagePorts.ts | 20 |
| src/render/paintQuads.ts | 114 |
| src/render/partLevelsWork.ts | 122 |
| **Total (88 files)** | **15,252** |

Nothing was left unread.

Followed outside the chunk only to resolve numbers: `world/bounds.ts` (PLATE_SIZE = 2048 m), `world/cityGen/wholeMap.ts` (MAP_TILES = 18 → MAP_HALF = 9216 m), `world/tiles.ts` (TILE = 1024 m), `render/terrainGrid.ts` (320 cells of 6.4 m a plate, TERRAIN_HALF = 1024 m), `render/woodsBase.ts` (WOODS_SPACING = 5 m), `render/terrainLevels.ts` (LOD_PATCH = 10), `render/scenery.ts` (SHADOW_REACH = 28 m), `render/buildings/fracture.ts` (FRAGMENT 2.8 m, MAX_EDGE 1.4 m, StillData all Float32), `render/roadSurfacePass.ts` / `roadSurfaceReads.ts` (road maxEdge values), `render/renderer.ts` / `playEffects.ts` call sites (grep only), the element glTF files in `public/models/elements/` (vertex/triangle counts read from their accessors with a node one-liner), and three r186 geometry sources.

### Elements

#### 1. Far traffic cars ("density cars", meso model cars outside the micro window)
- Location: `src/render/densityCars.ts:59` `carGeometry()` (shape); per-tile `InstancedBufferGeometry` in `tileGeometry()` :187, meshes in `tileAt()` :206; vertex shader placement `VERTEX_PLACE` :84 / `VERTEX_TRANSFORM` :108.
- Primitive: indexed triangles (two merged `BoxGeometry`, body 4.3×0.75×1.8 m + cabin 2.2×0.55×1.6 m, uv deleted), instanced draw.
- Counts: 2 × (24 v / 12 t) = **48 vertices / 24 triangles** per car, Uint16 index (72 indices).
- Attributes: position + normal Float32 = 24 B/vertex; per instance `aLink` vec4 + `aMove` vec4 Float32 = 32 B/instance; positions come from a 1024-wide RGBA32F texture (8 texels a road, `texelFetch` vertex pulling of the road centreline).
- Multiplicity: one mesh / draw call per 1024 m tile with cars; tile capacity starts at 256 and doubles; global cap `MOST_CARS = 1 << 18` = 262,144 cars → worst case 6.29 M triangles. Culled by tile sphere. castShadow false, receiveShadow true.
- Notable: cars inside the micro window are folded to a single point in the vertex shader (`carHidden`) - their triangles are still submitted and vertex-shaded (degenerate). Geometry index/position/normal shared across all tiles (only instance buffers are per tile).

#### 2. Sky dome
- Location: `src/render/environment.ts:147` `new SphereGeometry(1, 32, 16)` in `createEnvironment()`; ShaderMaterial :132 (BackSide, no depth test/write, z pushed to far plane).
- Primitive: indexed triangles. Counts: (33)(17) = **561 vertices / 960 triangles** (2·32·16 − 2·32), 2880 Uint16 indices.
- Attributes: position, normal, uv Float32 = 32 B/vertex (normal/uv unused by shader).
- Multiplicity: 1 mesh, 1 draw call every frame, frustumCulled false, scaled to 3600 m round the target; no shadows. Same mesh name twinned in TSL for WebGPU (`gpu/twins.ts:23`).
- Notable: covers the whole screen with 960 triangles and per-fragment sky; a fullscreen triangle would do the same job (it does not write depth anyway).

#### 3. Environment probe sphere (PMREM bake)
- Location: `src/render/environment.ts:156` (WebGL), `src/render/gpu/webgpuView.ts:96` (WebGPU twin). `SphereGeometry(1, 32, 16)` = 561 v / 960 t, rendered once into PMREM (6 cube faces) and disposed. PMREMGenerator also builds its own internal LOD meshes once. One-time cost only.

#### 4. Element props (brush-placed rocks, pebbles, gravel, grass, plants, fern, clover, flowers, mushrooms)
- Location: `src/render/elements.ts:69` `readParts()` (hand-read glTF), layer `createElementLayer()` :285 via `createInstanceRuns` (`instanceRuns.ts:201` → `cellInstances.ts`).
- Primitive: indexed triangles, instanced with a YAW_POSE (8 floats = 32 B/instance, matrix built in the vertex shader).
- Counts per model (from the .gltf accessors): Rock_Medium_1/2/3 351/249/531 v, 342/244/522 t; Pebble_Round_1/2/3 292/212/244 v, 136/114/128 t; Pebble_Square_1/2/3 216/162/108 v, 104/78/52 t; Grass_Common_Short 153 v/155 t; Grass_Wispy_Short 559/494; Grass_Common_Tall 303/326; Grass_Wispy_Tall 644/622; Plant_1 120/120; Plant_1_Big 360/360; Fern_1 243/288; Clover_1 267/379; Clover_2 433/615; Flower_3_Group (2 prims) 581/755; Flower_4_Group (2 prims) 1302/1690; Mushroom_Common 555/880; Mushroom_Laetiporus 1806/**3216**.
- Fallen leaves: `PlaneGeometry(1,1)` :212 = 4 v / 2 t.
- Attributes: position/normal/uv Float32 + colour (decoded from normalized Uint16 to Float32 rgb) = 44 B/vertex where coloured; index stored as **Uint32** always (`read()` :86 widens Uint16 to Uint32).
- Multiplicity: per placed element, kept per keep-cell; stores per kind × variant × primitive; casts shadow for stones, pebbles, scrub, fern, tallGrass (`CASTS` :265) with shadow reach 8 m; `leastPixel` drops instances under 1 px.
- Notable: indices doubled in size (Uint32 for meshes of < 2000 vertices); Mushroom_Laetiporus 3216 triangles for a small prop; no LOD below the 1-px cut.

#### 5. Exhaust / dust / smoke / blood / sparks / paper particles
- Location: `src/render/exhaust.ts:41` BufferGeometry, `Points` :171.
- Primitive: points (non-indexed), gl_PointSize sprites. Counts: **POOL = 4000 points**, always submitted.
- Attributes: position vec3 + aBorn, aKind, aSeed, aSize, aLife (Float32) = 32 B/point.
- Multiplicity: 1 draw call, frustumCulled false, transparent, no shadow. Dead/unborn points are clipped in the vertex shader (sent to clip 2,2,2). Partial uploads per spawned slot (`addUpdateRange`).

#### 6. Building destruction (fracture rubble)
- Location: `src/render/destruction.ts:121` `place()` (one "still" BufferGeometry per ruined building from the worker's StillData), flying pieces `loosen()` :237 (`fragmentGeometry`), `blank()` :157, `land()` :170.
- Primitive: **non-indexed** triangles (no index set), multi-material groups.
- Counts: fracture-dependent: shell triangles subdivided to edges ≤ 1.4 m (`fracture.ts` MAX_EDGE) and cut into fragments on a 2.8 m grid (FRAGMENT); all of a building's fragments in one mesh.
- Attributes: position 3 + normal 3 + colour 3 + uv 2 + aDecay 1 + finish 1, all Float32 = **52 B/vertex**.
- Multiplicity: one still mesh per ruined building (cast + receive shadow); each flying piece its own Mesh / draw call (casts shadow) until it lands and is written back into the still mesh. Releases ≥ 6 pieces/frame or 4 ms.
- Notable: unindexed fine subdivision (1.4 m) for the whole building, kept forever ("rubble stays"); blanked pieces are collapsed to a point (degenerate triangles still drawn and shadow-cast in the still mesh).

#### 7. Far ground (CDLOD quadtree patches round the view)
- Location: `src/render/flatAtlas.ts:130` `createFlatFar()`, `writeFarNode()` :149, `farIndexInto()` :192; node selection `src/render/farGround.ts:39` `farNodesFor()`.
- Primitive: indexed triangles, one geometry with slots, drawn by `drawRange`.
- Counts per slot: FAR_QUADS = 32 → vertices 33² + 4·33 = **1,221**; indices max 32²·6 + 4·32·12 = 7,680 → **2,560 triangles** (2,048 surface + 512 skirt: skirts drawn double-sided, 4 triangles per skirt quad). Rim edges (map edge) have no skirt.
- Attributes: position + normal Float32 = 24 B/vertex, **Uint32 index**.
- Multiplicity: slots start at 32 (78 kB index + 1,221·24 B a slot ≈ 29 kB vertices), doubled on demand; nodes from a 9×9-plate map (FAR_RING = 4, split ranges 3 plates at level 1, 2 above). One mesh, one draw, frustumCulled false, receiveShadow true, no cast. Plates drawn in full skip their level-0 patch.
- Notable: skirts at all four edges of every patch double-sided (2× the skirt triangles); all patches in one undivided draw (no per-node culling).

#### 8. Map-edge slab (cut sides to bedrock)
- Location: `src/render/flatAtlas.ts:249` mesh, `buildSlab()` :291 calls `slabGeometry(-MAP_HALF, MAP_HALF, ..., PLATE_SIZE / FAR_QUADS)` (defined in `terrain.ts`, outside the chunk). Step 64 m along the 4 × 18,432 m perimeter (≈ 1,152 columns); exact triangle count lives in `slabGeometry`. Rebuilt only when the relief changes. receiveShadow true.

#### 9. Far woods (far-plate tree impostor quads)
- Location: `src/render/farForest.ts:241` `quadOf()`, `write()` :285; shaders `src/render/impostorShaders.ts:77-211` (octahedral impostor, 8×8 frames of 64 px, 3-frame blend); tree data `src/render/farWoods.ts:93`.
- Primitive: indexed triangles, instanced quad. Counts: **4 vertices / 2 triangles per tree** (Uint16 index of 6).
- Attributes: position + normal Float32 = 24 B/vertex; instance `aSpot` vec4 + `aLook` vec4 = 32 B/tree (GPU-only after upload, `mesh/gpuOnly.ts`).
- Multiplicity: one mesh / draw call per far plate in the ring (up to `WOODS_MOST` = 192 plates); per plate at most `SLOT` = 4,096 trees; budget `FAR_WOODS_BUDGET` = 2,500 trees per 1920 m square, ×1.3 headroom (≈ 3,700 per 2048 m plate at full vegetation). castShadow/receiveShadow false. Trees thinned by screen size in the vertex shader (uThin) and faded per plate.
- Notable: thinned / faded trees are collapsed to a point in the vertex shader (degenerate quads still submitted for every instance).

#### 10. Gore: guts, organs, bones, flesh cuffs
- Location: `src/render/gore.ts:67-71` (InstancedMesh each).
- `CylinderGeometry(1,1,1,7)` guts: side 8·2 = 16 v + caps 2·15 = **46 v / 28 t**; cap MAX_SEGMENTS = 1,600.
- `SphereGeometry(1,10,7)` organs: 11·8 = **88 v / 120 t** (2·10·7 − 20); cap MAX_ORGANS = 400.
- `CylinderGeometry(1,0.8,1,7)` bones: **46 v / 28 t**; cap MAX_BONES = 120.
- `CylinderGeometry(1,1,1,9)` cuffs: 20 + 38 = **58 v / 36 t**; cap 120.
- Attributes: position/normal/uv Float32 (32 B/vertex), Uint16 index; instance matrix 64 B + colour 12 B.
- Multiplicity: 4 draws when visible, all cast + receive shadow (each cascade redraws them), bounding sphere fitted (`instanceBounds.ts`). Worst case 1,600·28 + 400·120 + 120·28 + 120·36 = 100,480 triangles. Only re-uploaded when changed (`sameAsSent`).

#### 11. Ground cover kit: rocks, scrub, forest trees
- Location: `src/render/groundCover.ts:88` `rockGeometry()`, :119 `scrubGeometry()`, :168 `treeModel()`, kit :172.
- Rock: `DodecahedronGeometry(1,0)` displaced, **non-indexed 108 v / 36 t**; attributes position, normal, uv (unused), colour = 44 B/vertex; 5 variants.
- Scrub: 3 × `IcosahedronGeometry(1,0)` = **180 v / 60 t**, non-indexed, position + colour + normal = 36 B/vertex; 4 variants.
- Trees: see element 12 (low-poly tree styles); kit holds broadleaf ×2, broadleafTall ×2, conifer (cypress) ×2, ipeYellow, ipePink. Instancing format `COVER_POSE` (8 floats = 32 B/instance, matrix in shader).
- Notable: rocks keep an unused uv attribute (8 B/vertex).

#### 12. Low-poly trees, bushes and hedges (the one tree style) and foliage cards
- Location: `src/render/lowPolyTrees.ts` `Builder` :116 (`add` :180 de-indexes three primitives, `mass` :197 = `IcosahedronGeometry(1,1)` 80-face crown, `finish` :227 cards, `frond` :129 palm strips); kinds :327-449.
- Primitive: **non-indexed** triangles (body: flat-faceted, each face own corners; cards: 6 corners per card, billboarded by `aCorner` in the vertex shader).
- Body triangle counts (trunk = open 6-seg cylinder 12 t; limb = open 5-seg cylinder 10 t; crown mass 80 t; cone open 6 t):
  - oak: 12 + 3·10 + 2·80 = **202 t (606 v)**; cards 40 → 80 t (240 v)
  - broadleafTall: 12 + 2·10 + 80 = **112 t**; cards 34 → 68 t
  - cypress: 12 + 6 = **18 t**; cards 70 → 140 t
  - palm: 5 rings × 16 + crownshaft Icosa(·,1) 80 + 4 nuts × 20 = **240 t**; 10 fronds × 24 = **240 frond triangles** (cards geometry)
  - ipe (yellow/pink): 12 + 4·10 + 80 = **132 t**; cards 54 → 108 t
  - bush / bushFlowering: **80 t**; cards 16 → 32 t
  - hedge: **80 t**; cards 20 → 40 t
- Attributes: body position + colour + normal (computeVertexNormals) = 36 B/vertex; cards position, normal, colour, uv, aCorner = 13 floats = **52 B/vertex**.
- Multiplicity: shared models instanced by gardens / nature trees / ground cover; body casts shadow (wind depth material), cards do not (except palm fronds).
- Notable: cards unindexed (6 vertices a quad where 4 would do, ~33 % extra vertices); body unindexed by design (flat shading); crown heart drawn at 62 % behind the cards (overdraw).

#### 13. Nature trees warm-up forest (sample)
- Location: `src/render/natureTrees.ts:232` `buildNatureForest()` (InstancedMesh body + cards + far impostor per variety; models `TREE_MODELS` oak, oak, cypress, cypress, palm, palm, `loadNatureTrees` :88). Used at `renderer.ts:1537` only to compile programs ahead with 20 sample trees (5 species × 4 seeds). frustumCulled false on all; body casts shadow, palm cards cast. Counts are those of element 12. The tree picture atlas (`natureTreePictures` :62) is shared with far woods.

#### 14. Garden plants (building gardens: trees, shrubs, hedges, flower beds)
- Location: `src/render/gardens.ts:75` `gardenPack()` (poses), :168 `gardenKinds()` (body, leaf cards, far picture quad per kind), `createGardenCells()` :246 via `propCells.ts`/`cellInstances.ts`.
- Geometry: the low-poly tree/bush/hedge models of element 12 + the impostor quads of `plantImpostors.ts` (outside chunk). Hedges: one piece per ~max(2.2 m, 1.5·h) of run; flower beds: max(2, w·d / 0.49 m²) clumps, capped at 24 per bed.
- Instance: YAW_POSE 8 floats (32 B) + tint 12 B. Body cast + receive shadow, cards receive only, far picture casts. Shadow margin SHADOW_REACH = 28 m.

#### 15. Lightning bolts
- Location: `src/render/lightning.ts:22` `boltSegments()`, `make()` :87 (`LineSegmentsGeometry` + `LineSegments2`).
- Primitive: instanced screen-space line quads: base 8 v / **6 triangles per segment** (indexed), instance attributes instanceStart/instanceEnd (interleaved Float32, 24 B/segment).
- Counts: main channel midpoint displacement 7 generations = **128 segments**, drawn twice (core 2.6 px + glow 8 px); 3-6 branches × 5 generations = 32 segments each (96-192). Per strike 352-448 segments = **2,112-2,688 triangles**; MAX_STRIKES = 4 → ≤ 10,752 triangles. Plus one hidden warm-up segment.
- Multiplicity: 3 draws per strike, frustumCulled false, transparent, no shadow; geometry made and disposed per strike (0.45 s).

#### 16. Road surface tiles (asphalt, footway, kerb, verge, deck, paint...) - the meshing pipeline
- Location: shape `src/render/mesh/tileShape.ts:29` `surfaceShape()` (splitToSpan at 6·maxEdge, earcut :53, Delaunay flips :223, longest-edge bisection `refine()` :313 budget 600,000 triangles a piece, 24 rounds); mesh `src/render/mesh/tileMesh.ts:172` `meshTileShape()` (`meshPiece` :62 top faces, `meshSkirts` :115, `weldVertices` :184); merge `src/render/mesh/surfaceTiles.ts:55` `mergeTiles()`; mesh `src/render/mesh/surfaceMesh.ts:25` `finish()`.
- Primitive: indexed triangles (welded).
- Counts: top faces refined until every edge ≤ maxEdge; maxEdge = TERRAIN_CELL / 2 = **3.2 m** on ground (`roadSurfacePass.ts:23`), 6.4 m raised, 0.75 m ramps, 5 for one surface (`roadSurfaceReads.ts`). Equilateral-ish refined triangles of edge ≤ L average ~0.25-0.43·L² of area, so on the order of **0.25-0.4 triangles/m²** at 3.2 m (estimate; exact count depends on outlines). Skirts: **4 vertices / 2 triangles per outline edge**, edges densified to ≤ maxEdge; vertices not shared between skirt quads (per-edge normals). UV-frame repair (`copyCorner`) duplicates up to 3 corners per inconsistent triangle.
- Attributes: position, normal, uv Float32 (32 B) + colour (12 B) only for vertexColors materials + roadSection vec3 (12 B) only for road-edge materials → 32-56 B/vertex; index Uint16 when ≤ 65,535 vertices, else Uint32.
- Multiplicity: one mesh per surface material per road block (many draw calls; comment in `roadResidency.ts:102` cites ~320 draw calls of 448 for 8,102 buildings at the map view); castShadow default false, receiveShadow true; materials have `shadowSide: DoubleSide` (`materials.ts:62`). Arrays dropped after upload (`gpuOnly.ts`) and rebuilt from tiles on context loss.

#### 17. Road block far level (simplified block)
- Location: `src/render/mesh/roadLodPure.ts:29` `coarseArrays()` (meshoptimizer `simplifyWithAttributes`, target ratio 0.08, absolute error 0.12 m, 'Prune', border locked, normal weight 0.4 / colour 0.15), mesh `roadLod.ts:10` `coarseGeometry()`, `surfaceTiles.ts:163` `attachFarLevel()`; residency `mesh/roadResidency.ts:272` `updateRoadLevels()`.
- Counts: up to 8 % of the block's triangles (less when error allows); blocks under 160 triangles get no far level. Index Uint16/Uint32 by vertex count. Same attribute set as element 16.
- Multiplicity: one per block; near/far switch at reach × 1.25; budgets roadsNearMB / roadsFarMB (`quality.ts` GEOMETRY_BUDGETS); 3 blocks brought near per look; dropped cells fall back to element 18.

#### 18. Network far roads (whole-map road top level)
- Location: `src/render/networkFarRoadsBuild.ts:119` `buildFarRoadCells()` (union/difference/intersection per cell, `fill()` :99 earcut), page side `src/render/networkFarRoads.ts:167` `place()` into `GpuBatchedMesh` (outside chunk).
- Primitive: indexed triangles, earcut fan only (no interior points): per polygon ≈ (vertices − 2 + 2·holes) triangles, vertices = outline vertices after clipping.
- Attributes: position Float32 12 B + normal Int8 normalized 3 B + colour Uint16 normalized 6 B = **21 B/vertex**; index **Uint32**.
- Multiplicity: 2 batches (casing layer 0, carriageway layer 1), one multi-draw each, a cell an instance (cell = road block CHUNK); receiveShadow true; polygon offset steps 2 / 3. Shown only where block levels are dropped/parked or before fill.
- Notable: Uint32 index even for small cells (batched).

#### 19. Road paint markings (lane lines, dashes, stop bars, zebras)
- Location: `src/render/paintQuads.ts:20` `quad()`, `strokeQuads()` :36, `barQuad()` :89; materials `src/render/markings.ts:15`.
- Primitive: each dash/segment a 4-corner ring handed to a sink (`roadSurfaceInputs.ts`, outside chunk) that meshes it with the surface pipeline (element 16). A plain quad is 4 v / 2 t before any refinement.
- Multiplicity: per road per dash; one material per colour (`PAINT_COLOURS`), transparent, depthWrite false, polygon offset `pullTowardEye(2,2)`, PAINT_RISE 0.008 m.

#### 20. Terrain patch vertex pulling (WebGPU twin) - geometry generated in the shader
- Location: `src/render/gpu/twins.ts:58` `ground` twin (TSL): `position` attribute read as ivec3 (corner x, y, role), instanced `aLodPatch` vec4 (start x, y, step, level); corners/heights/normals fetched from the land texture with `textureLoad`, CDLOD morph by distance.
- Roles 0-5: the two triangles of a quad (diagonal chosen by texel flag or by height difference); roles ≥ 6: skirt strips hung on patch edges (4 sides). Patch = LOD_PATCH = 10 quads a side (`terrainLevels.ts`). Geometry itself built in `terrainLod.ts` (outside chunk).
- Notable: this twin is "simple" (one grass colour).

#### 21. WebGPU own-geometry copies
- Location: `src/render/gpu/webgpuView.ts:131` `geometryFor()`: under WebGPU every geometry with Uint8/Uint16/Int8/Int16 non-normalized attributes or index gets a full copy (`copyOf` :136) kept in sync whole on each version change. Doubles CPU memory of those buffers and re-copies whole arrays on any edit. WebGPU path only.

#### 22. Occlusion buffer occluders (CPU software raster)
- Location: `src/render/occlusion.ts:57` `build()`, `layBox()` :168, `layQuad()` :204.
- Not GPU geometry: per occluder volume (walls from `cameraSolids.forEachOccluder` within 1,500 units) up to 4 wall quads (front-facing only) + 1 roof quad, rasterised conservatively into a 256 × (256/aspect) Float32 depth buffer with a max-mip hierarchy; walls under 1.5 texels skipped; boxes over 8,192 texels not tested.

#### 23. Lots overlay (shapes evaluated per pixel instead of geometry)
- Location: `src/render/lotLattice.ts` (8 m cell lattice in an RGBA32UI texture 2048 wide), `src/render/lotOverlay.ts:111` `lotOver()` GLSL injected into ground/road/building materials (`applyLotOverlay` :208).
- No triangles: polygons, lines and dots are edge lists per 8 m cell; the fragment shader loops over every shape and edge in the cell (up to 1023 edges per shape per cell). Replaces per-lot ground geometry ("DO NOT go back to geometry laid on the ground per lot").

#### 24. Vehicle part LOD ladder
- Location: `src/render/partLevelsWork.ts:54` `partLevelArrays()`; `ladderIndices()` :10 (meshoptimizer `simplifyWithAttributes`, 'ErrorAbsolute' + 'Prune').
- 6 coarser levels at errors 0.0125, 0.025, 0.05, 0.1, 0.2, 0.4 m; a level keeping > 90 % of the finer one's triangles is 'same'.
- 'smooth' parts: levels share the welded attributes, own index (Uint32). 'boxes' parts: `toCreasedNormals` (crease 45°) makes each level **non-indexed** with its own position/colour/normal arrays (3 vertices per triangle per level).
- Colour attribute forced (white Float32 rgb filled when absent).

#### 25. Generic simplifier / weld
- `src/render/mesh/simplify.ts:6` `simplified(source, ratio, error)`: weld at 1e-4 then meshopt simplify (colour weighted 0.5 if present), Uint32 index.
- `src/render/mesh/weld.ts:5` `weldGeometry()`: three `mergeVertices` equivalent with numeric hash; index Uint16 if < 65,535 vertices.

#### 26. Interior solids (vehicle cabin parts bookkeeping)
- Location: `src/render/interiorSolids.ts:44` `CabinParts`: records index ranges (start, count) of each merged cabin part (floor, dash, seats, ...) for later hiding; geometry itself built in vehicle models (outside chunk). Counts the index or, for non-indexed parts, the position count.

#### 27. Inspection camera clipping planes (dev only)
- `src/render/inspector.ts:35`: no geometry; two clip planes for vehicle interior shots; re-renders the scene at 1600×1000.

### Budgets, caps and counters found

- `densityCars.ts:46` MOST_CARS = 262,144 far cars; TILE_START = 256 per tile, doubling.
- `exhaust.ts:15` POOL = 4,000 particles.
- `gore.ts:48-50` MAX_SEGMENTS 1,600, MAX_ORGANS 400, MAX_BONES 120 (cuffs share it).
- `lightning.ts:10` MAX_STRIKES = 4.
- `farForest.ts:25` SLOT = 4,096 trees per far plate; `flatAtlas.ts:69` WOODS_MOST = 192 far plates with woods; `farWoods.ts:50` FAR_WOODS_BUDGET = 2,500 trees per 1920 m square, HEADROOM 1.3; `setVegetation` scales by amount / 2,600.
- `flatAtlas.ts`: FAR_QUADS = 32 (2,560 triangles max a far patch), FAR_SLOTS_FIRST = 32 (doubling), NEAR_MOST = 9 plates in full, CACHED_MOST = 9, NEAR_VIEW = 1,400 m.
- `farGround.ts`: SPLIT_PLATES = 3, SPLIT_ABOVE = 2 (CDLOD split ranges).
- `mesh/tileShape.ts:313` refine budget 600,000 triangles a piece, 24 rounds; densify ≤ 512 cuts an edge; splitToSpan depth ≤ 12.
- `mesh/roadLodPure.ts`: COARSE_ERROR 0.12 m, COARSE_RATIO 0.08, COARSE_MIN_TRIANGLES 160.
- `mesh/roadResidency.ts`: FAR_MARGIN 1.25, BRING_PER_LOOK 3, NEAR_PER_FAR 5 (bytes estimate), VIEW_MARGIN 64 m, RESTORING_AT_ONCE 2, budgets `budget` (near) / `farBudget` from `quality.ts` GEOMETRY_BUDGETS roadsNearMB / roadsFarMB; `networkFrom` distance hands cells to the network far level.
- `partLevelsWork.ts`: LEVEL_ERRORS 0.0125-0.4, WORTH 0.9, CREASE 45°.
- `elements.ts`: EFFECT_REACH 720 m, ELEMENT_SHADOW_REACH 8 m, `leastPixel` 1 px; `CASTS` set.
- `instanceRuns.ts`: YAW_POSE 8 floats/instance (vs 16), NEAR_SQUARE hides far-batch instances in the near square (vertices collapsed: `poseHidden`).
- `gardens.ts`: flower bed ≤ 24 clumps; SHADOW_REACH 28 m.
- `lowPolyTrees.ts`: card counts per kind (oak 40, broadleafTall 34, cypress 70 of 120 candidate points, ipe 54, bush 16, hedge 20); FAR_LEAVES 300 in the atlas; LEAF_NEAR 22 m / LEAF_FAR 70 m.
- `impostorShaders.ts`: FRAMES = 8 (8×8 hemi-octahedral views), FRAME_PX = 64.
- `occlusion.ts`: WIDTH 256, OCCLUDER_REACH 1,500, LEAST_TEXELS 1.5, MOST_TEXELS_READ 8,192.
- `lotLattice.ts`: LOT_CELL 8 m, TILE_CELLS 16, TEXTURE_WIDTH 2,048, ≤ 1,023 edges per shape per cell, UPLOAD_GAP 64, UPLOAD_RANGES 256.
- `gpuLedger.ts`: GpuLedger books bytes **and triangles** per class ('building detail', 'cell masses', 'tile masses', 'plate masses', 'base masses', 'far *', ...); `geometryCost()` triangles = index.count / 3 (or position count / 3); `deviceGpuCap()` = max(512 MiB, min(ceiling, 690 B × drawing-buffer pixels)), ceiling = system GB × 0.25 on iGPU, 3 GB on discrete.
- `inventory.ts:52` FLAGS: dominantShare 20 %, bytesPerVertex 70, trianglesPerMesh 150,000, tinyMesh < 60 triangles × tinyCount ≥ 400 meshes, cpuBytes > 20 MB, hidden > 50 MB; `sceneInventory()` counts vertices/triangles × instances per layer/kind.
- `memoryCounters.ts`: geometry bytes (GPU/CPU), released buffers, texture bytes (no triangle count).
- `effectSwitches.ts:29` BuildingChoices.triangles = share of the view's triangle budget (`frameBudget.ts`), detailMemoryMB.
- `optimizations.ts` / `optimizationsQuality.ts`: buildingLod (screen error ×2 default), terrainLod (×1), vehicleError, vehicleWhole (50 default), castMasses ('far'), castTexel (1 texel), agentShadows, vegetation share, `q.triangleScale` (triangle budget share), `q.detailMemoryMB`, `q.grassBlades` (unread), `q.impostors` (unread).
- `mesh/updateRanges.ts`: MAX_RANGES 128 per attribute.
- `gpuTimer.ts`: GPU time samples only (no geometry).

### Files without geometry

- src/render/: depthConvention.ts (depth GLSL helpers, polygon offset), derivedCache.ts, derivedWriter.worker.ts, derivedWriterLane.ts (derived cache I/O), ecology.worker.ts, ecologyKept.ts, ecologyPool.ts (ecosystem workers/cache), effectSwitches.ts (switches; budget share field only), farGround.ts (CDLOD node selection only - geometry in flatAtlas.ts), farWoods.ts (tree placement data), flatGround.worker.ts, flatGroundPool.ts (plate heights in workers), fogLayer.ts (fog DataTexture 512² half float), frustumGround.ts (frustum footprint math), gardenLists.ts, grass.ts (tuft data, 90-160 per clump), groundChanges.ts, groundShape.ts, groundShape.worker.ts, groundShapePool.ts (terrain shaping math), groundShear.ts (matrix shear), inspector.ts (dev camera), instanceBounds.ts (bounding sphere fit), instanceCull.ts (sphere/frustum helpers), interiorSolids.ts (index-range bookkeeping), inventory.ts and memoryCounters.ts and gpuLedger.ts and gpuTimer.ts (counters), isoViewport.ts (camera rig), ktxParse.d.ts, landStroke.ts, landStroke.worker.ts, landStrokePool.ts (brush jobs), lightLevels.ts (64² light pool texture), lotLattice.ts and lotOverlay.ts (shader-evaluated shapes, no triangles), markings.ts (paint materials), materials.ts (road materials), natureNoise.ts, occlusion.ts (CPU raster), occupants.ts (animation choreography), optimizationTypes.ts, optimizations.ts, optimizationsApply.ts, optimizationsQuality.ts (lab options), pagePorts.ts, impostorShaders.ts (shaders for element 9; bake materials only).
- src/render/gpu/: backendChoice.ts, compatibility.ts, imageCompare.ts.
- src/render/mesh/: detailLayer.ts and roadEdges.ts (shader patches), gpuOnly.ts (array release), stream.ts (typed growable arrays), textureBaker.ts (texture recipes), updateRanges.ts.

---

## Polygon geometry audit — chunk g06

### Files read

Every file below was read completely, first line to last (long files in sequential chunks: proceduralCrowd.ts 1-600, 600-1199, 1200-1849, 1850-2422; postprocess.ts 1-650, 650-1242; ragdoll.ts 1-700, 700-1349, 1349-1980).

| File | Lines |
|---|---|
| src/render/people/bodyPixels.ts | 19 |
| src/render/people/cartoon.ts | 131 |
| src/render/people/classRigMade.ts | 62 |
| src/render/people/cookPack.ts | 52 |
| src/render/people/cookedLoad.ts | 63 |
| src/render/people/cookedPerson.ts | 266 |
| src/render/people/crowdAnimation.ts | 362 |
| src/render/people/crowdBodies.ts | 114 |
| src/render/people/crowdLod.ts | 249 |
| src/render/people/faceExpression.ts | 139 |
| src/render/people/facialMorphs.ts | 63 |
| src/render/people/garmentPadding.ts | 100 |
| src/render/people/garmentPadding.worker.ts | 32 |
| src/render/people/garmentPaddingPool.ts | 123 |
| src/render/people/garmentSlots.ts | 20 |
| src/render/people/gpuRows.ts | 172 |
| src/render/people/hairTexture.ts | 66 |
| src/render/people/heldProps.ts | 174 |
| src/render/people/lodPool.ts | 59 |
| src/render/people/lodPort.ts | 23 |
| src/render/people/lodWorker.ts | 111 |
| src/render/people/paletteTargets.ts | 103 |
| src/render/people/personBuild.ts | 53 |
| src/render/people/personMesh.ts | 306 |
| src/render/people/personRig.ts | 896 |
| src/render/people/personVariants.ts | 78 |
| src/render/people/proceduralBake.ts | 306 |
| src/render/people/proceduralCook.ts | 74 |
| src/render/people/proceduralCrowd.ts | 2422 |
| src/render/people/skinAppearance.ts | 692 |
| src/render/pinned.ts | 9 |
| src/render/plantCells.ts | 174 |
| src/render/plantImpostors.ts | 511 |
| src/render/plateFollow.ts | 50 |
| src/render/plateMesh.ts | 98 |
| src/render/platePaint.ts | 36 |
| src/render/plateTexels.ts | 83 |
| src/render/playEffects.ts | 576 |
| src/render/poleBake.ts | 87 |
| src/render/poleCells.ts | 235 |
| src/render/poleLayer.ts | 718 |
| src/render/postprocess.ts | 1242 |
| src/render/profilerHooks.ts | 63 |
| src/render/propCells.ts | 618 |
| src/render/propGeometry.ts | 381 |
| src/render/quality.ts | 340 |
| src/render/ragdoll.ts | 1980 |
| src/render/ragdollAxes.ts | 60 |
| src/render/ragdollGround.ts | 72 |
| src/render/ragdollJolt.ts | 398 |
| src/render/rain.ts | 173 |
| **Total (51 files)** | **15,234** |

Nothing was left unread. Constants resolved outside the list (grep only, cited): `impostorShaders.ts:7-9` (FRAMES = 8, FRAME_PX = 64), `uploads.ts:659-664` (fullScreenTriangle), `utilities.ts:95,249,251` (POLE_PART_COUNT = 11, SPAN_WIRES, WIRE_STRIDE = 8), `world/utilities.ts:19,21,41` (WIRE_COURSES 3, WIRE_OFFSETS 3, WIRE_SEGMENTS 8), `blobShadows.ts:63` (createBlobShadows signature). The MakeHuman base mesh vertex count (`people/body/assets.ts`) comes from a data file and was not resolved to a number; the code's own constant `SKIN_TRIANGLES_LEVEL0 = 26756` (crowdLod.ts:31) is used for the body.

Three r186 formulas used (non-indexed counts after `toNonIndexed`: vertices = 3 x triangles): Box 12 tris; Cylinder(rs, hs=1) closed 4·rs tris, open 2·rs; Cone(rs, hs=1, open) rs tris (the tip row's degenerate triangle is skipped); Icosahedron(detail 0) 20; Plane(1,1) 2; Sphere(w, h, theta 0..thetaLength<pi) 2wh − w tris.

### Elements

#### 1. Procedural crowd body/item pieces (the in-game people)
- What: every procedural person is drawn as a set of "pieces": one `InstancedMesh` per (body class x item x LOD level). Items: the skin (body + eyes), outfit, garment, shoes, hair cards, brows, lashes, teeth/tongue ("mouth"), accessories (headband).
- Location: `proceduralCrowd.ts:1218-1255` (`makePiece`), `:1358-1397` (`makeItem`), `:1402-1421` (`skinItem`), `:1424-1458` (`wornItem`); materials `:462-565` (`pieceMaterial`), depth `:616-627`.
- Primitive: indexed triangles, `InstancedMesh`, `DoubleSide` MeshStandardMaterial with custom skinning (bone palette from texture, `getBoneMatrix` `:337-342`).
- Counts per person per piece (triangle budget table `crowdLod.ts:34-49`):

| role | L0 | L1 | L2 | L3 |
|---|---|---|---|---|
| skin (body) | all (26,756 per `SKIN_TRIANGLES_LEVEL0`) | 2,000 (of which eyes 200) | 600 (eyes 40) | far mesh only |
| outfit | all | 1,200 | 400 | far mesh |
| garment | all | 900 | 300 | far mesh |
| shoes | all | 300 | 80 | 0 |
| hair (cards) | 26,756 cap | 1,000 | 300 | 120 |
| brows | all | 100 | 0 | 0 |
| lashes | all | 0 | 0 | 0 |
| mouth (teeth/tongue) | all | 0 | 0 | 0 |
| accessory | all | 200 | 60 | 60 |

  Hair/brow L1-L3 are chosen by keeping whole cards largest-area first and widening the kept cards by up to 1.6x in the vertex shader (`crowdLod.ts:101-150`, `aCard` attribute); if the card selection overshoots by >1.3x it falls back to meshopt simplification (`proceduralCrowd.ts:1317`). Other roles: meshopt `simplify`, then `simplifySloppy` if the result is >1.3x target (`lodWorker.ts:68-79`). LOD choice by on-screen height in pixels: L0 ≥ 40 px, L1 ≥ 20, L2 ≥ 8, L3 ≥ 3, else not drawn; 10 % hysteresis (`crowdLod.ts:8-25`). Caps: at most 30 people at L0 and 120 at L1, the smallest pushed down (`crowdLod.ts:14`, `proceduralCrowd.ts:2226-2234`).
- Vertex attributes (shared by every level of an item; each level only has its own index):
  - Skin source (dressed body, `personRig.ts:728-744` + `proceduralCrowd.ts:1087-1090`): position 3f, normal 3f, uv 2f, color 3f, skinIndex 4 x Uint16, skinWeight 4f, skinMask 1f, hairMask 1f, eyeMask 1f, garmentSlot 1f, aRefs 3f, aRefW 3f = 108 bytes/vertex.
  - Fitted item (`proceduralCrowd.ts:1436-1448`): position 3f, uv 2f, skinIndex 4 x Uint16, skinWeight 4f, aRefs 3f (Float32 copy of Uint32 refs), aRefW 3f, normal 3f (computeVertexNormals) = 80 bytes/vertex; +aFade 1f for grown hair, +aCard 3f for widened hair.
  - Index: the item pack's Uint32Array as is (`:1446`); level indices Uint32 from meshopt.
  - Per-instance: aPerson 4f, aDye 4f, (+aWorn 4f on skin L0-2) = 32-48 bytes, plus the mesh's own `instanceMatrix` (64 bytes) which is allocated and grown but never written (the place is read from the `procPerson` texture, `:335-336`, `:414-416`).
- Multiplicity: classes = 2 sexes x 4 age bands = 8 (`proceduralBake.ts:278-283`); one piece per (class, item, level) holding every person of that class wearing it at that level; starts at 16 instances, doubles (`PIECE_START`, `:267`, `growPiece` `:1258-1272`). Draw calls = visible pieces (`stats().draws`). `frustumCulled = false` on every piece (`:1231`): culling is entirely via the LOD level (person.pixels supplied by the caller).
- Shadows: pieces at L0 and L1 cast (not face/mouth roles, `personVariants.ts:34-36`), and they cast with the NEXT level's index (L0 casts the L1 triangles, L1 casts the L2 triangles) by swapping `geometry.index` in `onBeforeShadow`/`onAfterShadow` (`proceduralCrowd.ts:1236-1242`); depth material skips the face/expression deltas. L2/L3 people get a blob disc instead (`:2287`). Each cascade re-draws the shadow triangles.
- Counter: `trianglesDrawn += people x piece.triangles` (`:2296`), shadow excluded.
- Notable: DoubleSide on closed skin/cloth meshes; instanceMatrix buffer allocated and doubled but unused (64 B/instance wasted, copied on grow); `aRefs` stored as Float32 though they are vertex indices; L0 skin is the full MakeHuman body for up to 30 people (~0.8 M triangles for the skin alone at the cap, more with outfit/hair).

#### 2. Procedural crowd far mesh (L3)
- What: one merged low-poly mesh per (class, outfit combination): bare skin + outfit + under-garment, coloured per vertex by region.
- Location: `crowdLod.ts:190-232` (`farMesh`), requested at `proceduralCrowd.ts:1461-1492`, material `:568-613`.
- Primitive: indexed triangles (index from `setIndex(number[])`, then `mergeGeometries`), InstancedMesh, DoubleSide, skinned with the two strongest bones only (`TWO_BONES_*`, `:395-404`).
- Counts: target 120 (skin) + 90 (outfit) + 60 (garment) = ~270 triangles per person (`FAR_TRIANGLES`, `crowdLod.ts:49`), meshopt targets (up to 1.3x, else sloppy).
- Attributes: position 3f, normal 3f, skinIndex 4 x Uint16, skinWeight 4f, aRefs 3f, aRefW 3f, aFar 4f = 88 bytes/vertex. Per instance aPerson, aSkin, aOut, aShoe (4f each = 64 B) + unused instanceMatrix.
- Multiplicity: one draw per (class, outfit key) with people at L3; does not cast (blob shadow instead).

#### 3. Grown hair strands (close-up)
- What: procedurally generated strand ribbons for the nearest people with a grown hairstyle.
- Location: `proceduralCrowd.ts:1593-1624` (`strandPiece`), filled each frame `:1632-1671`.
- Primitive: indexed triangles, InstancedMesh (variant `grown`, alpha-to-coverage).
- Counts: `pack.index.length / 3` from `generateHairStrands` (people/hair/procedural.ts, not in this chunk — not resolved).
- Multiplicity: only people at L0-L1 within 14 m (x world unit) of the eye, nearest `hairStrandPeople` (8 on medium/high/ultra, 2 on low, `quality.ts:10,144`); one piece per (class, style). No shadow.

#### 4. Program stand-ins for precompile
- `proceduralCrowd.ts:656-680` (`personProgramStandIns`): one 3-vertex (1 triangle, non-indexed, position+normal) `InstancedMesh` (count 1) per lit variant and per shadow variant, used only to compile programs ahead. Negligible.

#### 5. Crowd skinning palette pass (GPU compute via raster)
- What: per body class, bone matrices for every person computed into a float render target.
- Location: `crowdAnimation.ts:117-348`; quad `:230-232`.
- Primitive: one full-screen triangle (3 vertices, position only), viewport `bones*4` x `n` rows.
- Multiplicity: 1 draw per class per frame (2 when the skeleton has parent depth > 0: blend pass + refit pass). Targets shared per width in pages of up to 2,048 rows (`paletteTargets.ts:7`).

#### 6. GPU rows copy pass
- `gpuRows.ts:36-66`: one shared full-screen triangle (3 vertices) used to carry rows when a rows texture grows or a row is copied (body and face textures). Writes use `copyTextureToTexture` with a freshly created `DataTexture` per write (`:144`) — a JS object per write, not geometry.

#### 7. Cooked roster person meshes (MakeHuman `SkinnedMesh`)
- What: the roster/"rigged citizens" person body built from MakeHuman packs, dressed in proxy garments or tailored shells, with LOD index sets.
- Location: built `personRig.ts:181-433` (`createPersonRig`), `:446-579` (`clothedGeometry`), `:596-751` (`dressedGeometry`); packed/unpacked `cookedPerson.ts:51-132`, `:149-266`; loaded `cookedLoad.ts:46-60`; built in worker `personBuild.ts:20-53`.
- Primitive: indexed triangles, one `SkinnedMesh`, MeshStandardMaterial DoubleSide, vertex colours, groups per worn item.
- Counts: MakeHuman quads split into 2 triangles (1 for a degenerate quad); the tailored path also clips hems with Sutherland-Hodgman, adding vertices at cuts and fan-triangulating (`:536-557`). Level indices on the same vertices: 30 % / 10 % / 1.5 % of triangles with errors 0.008 / 0.03 / 0.12 (last "loose", seams may move) (`LOD_LEVELS`, `:781`); fallback grid clustering at 3 / 8 / 20 cm cells when meshopt is not ready (`:777`, `:818-839`).
- Attributes: position 3f, color 3f, skinIndex 4 x Uint16, skinWeight 4f, normal 3f, uv 2f, (+skinMask, hairMask, eyeMask, garmentSlot 1f each when texturedSkin) = up to 92 B/vertex; index from `setIndex(number[])` (three picks Uint16/Uint32 by max). Vertices are duplicated per part and, with texturedSkin, per UV seam (`emitOriginal` key `part:v:uv`, `:473`); normals then re-averaged across seams (`smoothSkinSeams`, `:754-774`).
- Morph targets: expression channels (11 in `CHANNELS`, `faceExpression.ts:7-20`) + gaze lookLeft/lookRight, as full relative position arrays (vertexCount x 3 floats each) (`facialMorphs.ts:5-63`); cooked file stores only moved vertices (> 1e-5 m) and expands them back to full arrays on decode (`cookedPerson.ts:80-91`, `:170-180`).
- Multiplicity: one per roster person loaded (the cook ships them as .bin files); LOD chosen per figure elsewhere (riggedCitizens.ts, not in chunk).
- Notable: transient whole person rebuilt per expression in the non-dressed path (`facialMorphs.ts:40`), only at build time.

#### 8. Class rig bodies (procedural crowd source)
- `proceduralBake.ts:150-164` (`classRig`): a nude body + eyes `SkinnedMesh` per class (8), built on the worker and reassembled on the page (`classRigMade.ts:19-62`). Its geometry becomes the skin piece source (element 1). Shape basis texture rows: `ceil(vertexCount*16/4096)` rows x 4096 RGBA32F (`proceduralBake.ts:172-173`); bodies texture 16 bodies x `ceil(vertexCount/4096)` rows (`crowdBodies.ts:7-9,37-49`) — per-vertex morph deltas fetched in the vertex shader (`procDelta`, `proceduralCrowd.ts:369-380`, up to 3 references a vertex).
- Teeth/tongue pieces are built from the base mesh helper groups (`proceduralCrowd.ts:985-1008`).

#### 9. Held props (cup, phone, newspaper/book, camera, bag, umbrella, box)
- Location: `heldProps.ts:36-78` (`model`), `:101-174` (`createHeldProps`).
- Primitive: non-indexed triangles (each part `toNonIndexed`, merged, `computeVertexNormals` → flat), InstancedMesh, MeshStandardMaterial vertexColors.
- Attributes: position 3f, normal 3f, color 3f = 36 B/vertex.
- Counts:
  - newspaper: 2 boxes = 24 tris / 72 verts
  - cup: 2 x Cylinder(12) closed = 96 tris / 288 verts
  - phone: 1 box = 12 / 36
  - camera: box + Cylinder(10) closed = 52 / 156
  - bag: 2 boxes = 24 / 72
  - box: 2 boxes = 24 / 72
  - umbrella: Cylinder(6) closed 24 + Cone(16, 1, open) 16 = 40 / 120
- Multiplicity: 7 InstancedMeshes, capacity 300 each (`CAPACITY`, `:89`), DynamicDrawUsage, frustum-culled by a fitted sphere; cast shadows only when large enough on a shadow texel (`castBySize`, `:123`).

#### 10. Plant impostor quads (octahedral impostors)
- What: far pictures of trees and bushes (scenery and nature).
- Location: `plantImpostors.ts:336-348` (quads), shaders `:100-217`, bake `:352-426`.
- Primitive: indexed triangles (Uint16 index [0,1,2,0,2,3]), 4 vertices / 2 triangles per instance; vertex shader billboards it towards the eye (or light in the shadow pass) and thins/grows it by pixel size (`impostorThin`).
- Attributes: position 3f, normal 3f, aSphere 4f, aBlock 2f = 48 B/vertex (as a model quad; in far batches aSphere/aBlock become per-instance, `propCells.ts:362-391`).
- Atlas: blocks of FRAMES x FRAME_PX = 8 x 64 = 512 px; up to 4 x 4 blocks (2,048 px) (`layoutOf`, `:246-253`); two colour attachments + one Red outline target, mipmapped.
- Bake: renders each model's full body (+cards) 64 times into the colour target and 64 times into the outline target (8 x 8 frames x 2 passes), once per picture set, between frames (`takeWaitingPictures`).
- Switch: drawn as picture under `PICTURE_PX = 48` device pixels (`:467`); thinned under `THIN_PX = 2` px. Cast shadows (thinned again per shadow texel).

#### 11. Tree and cover cells (countryside trees, rocks, scrub, card trees)
- Location: `plantCells.ts:27-64` (`plantLayer`), `:80-110` (`createTreeCells`), `:125-149` (`createCoverCells`). Geometry comes from `natureTrees.ts` / `groundCover.ts` / `instanceRuns.ts` (not in chunk).
- Per tree model: body (levels[0]) InstancedMesh run + optional leaf cards (cast only for palms) + far picture quad (2 tris). Rocks/scrub have a `leastPixel` level (not drawn under a pixel). Shadow margin 48 m (trees), 8 m (cover).

#### 12. Prop layer near cells and far batches (gardens, street furniture, street trees)
- Location: `propCells.ts:254-603` (`createPropLayer`), batches `:310-436`, `lookProps` `:609-618`.
- Near: cell-by-cell instances of each kind's meshes (via `cellInstances.ts`, not in chunk); near square up to 8 cells each way (`MOST_NEAR`), sized so plants ≥ 48 px are whole.
- Far: blocks of 4 x 4 cells; plants as one instanced picture-quad batch (2 tris per plant) per block; other kinds instanced with their own body meshes (all body meshes of the kind, cards and far meshes skipped) per block. CPU arrays freed once uploaded (`gpuOnlyAttributes`).
- Budgets: near 48 MB CPU, far 24 MB CPU, GPU 192 MB per class (`:284`, `:441`), scaled by tier (`quality.ts:110-115`). Two far classes: wide (pictures and all-size kinds, to the horizon) and small (kinds with `levels.least`, only where ≥ 1 px).
- Counter: `triangles` = near meshes only (`:505`).

#### 13. Street furniture / plant prop geometries
- Location: `propGeometry.ts`. All built with `part()` (`:40-79`): non-indexed, position 3f + normal 3f + color 3f = 36 B/vertex, merged, bounds computed.

| Geometry | Function / line | Triangles | Vertices |
|---|---|---|---|
| Grass tuft (7 blades x (2 quads + tip)) | `grassTuftGeometry` :120 | 35 | 105 |
| Wildflower (open cyl4 + box + icosahedron d0) | `wildflowerGeometry` :178 | 40 | 120 |
| Lighting column (cyl10 x2 closed, cyl10 open, cyl8 closed, 2 boxes) | `lampGeometry` :197 | 156 | 468 |
| Lamp lens (plane) | `lampLensGeometry` :221 | 2 | 6 |
| Bench (15 boxes) | `benchGeometry` :237 | 180 | 540 |
| Litter bin (4 closed cyl14 + 1 open cyl14) | `binGeometry` :265 | 252 | 756 |
| Hydrant (3 cyl10, cyl6, 2 cyl8, all closed) | `hydrantGeometry` :283 | 208 | 624 |
| Post box (4 boxes + half cylinder 12 closed) | `postboxGeometry` :297 | 96 | 288 |
| "Orelhao" phone (cyl8 + sphere 16x10 cap + sphere 14x8 cap + 2 boxes) | `phoneGeometry` :314 | 570 (spheres 304 + 210) | 1,710 |
| Kerb drain (11 boxes) | `drainGeometry` :334 | 132 | 396 |
| Tree pit (9 boxes) | `treePitGeometry` :356 | 108 | 324 |

- Trees/bushes come from `lowPolyTreeParts` (lowPolyTrees.ts, not in chunk).
- Notable: everything non-indexed (36 B x 3 per triangle); the phone shell's two spheres are 90 % of its triangles; drain/tree-pit boxes include faces hidden below the footway/kerb. `trianglesOf` helper `:379`.

#### 14. Utility poles and wires (view-cell version)
- Location: `poleCells.ts:48-235` (`PoleCells`), stores `poleLayer.ts:152-298` (`PartStore`), `:301-457` (`WireStore`).
- Primitive: poles = 11 part kinds (`POLE_PART_COUNT`), each an InstancedMesh per 768 m block (`BLOCK`, `poleLayer.ts:471`) with LOD levels `spec.levels` chosen by `error * pixelsPerUnit < 1` (`:267-273`), hidden when cover x px² x brightness < 1, cast only when cover ≥ texel². Wires = a `Mesh` with an `InstancedBufferGeometry` template per level (`wireGeometry`, utilities.ts), 9 wire instances per span (3 courses x 3 offsets), 8 floats each = 288 B per span (`WIRE_BLOCK`).
- Counts: part geometries are in utilities.ts (not in chunk); comment `poleLayer.ts:470` gives 64 triangles per wire at full detail (26,145 wires → 3 M triangles before blocks).
- Multiplicity: per block 11 InstancedMeshes + 1 wire mesh; budgets 16 MB CPU / 128 MB GPU (`poleCells.ts:70`); shadow margin 40 m. Counter `triangles` = perInstance x count over live blocks.
- `PoleLayer` (whole-document version, `poleLayer.ts:481-675`, also `buildPolePreview` `:697-718`) uses the same stores. `PartStore.reserve` grows by doubling (min 16), building a new InstancedMesh and disposing the old.

#### 15. Terrain plate grid data (CPU side)
- `plateMesh.ts:73-98` (`buildPlateMesh`): per plate `side x side` corners, a per-cell diagonal flip, normals as three's area-weighted `computeVertexNormals` would make them (`landNormalsInto`, `:19-70`), and `LandLevels` LOD nodes. Triangles at full resolution = 2·(side−1)². The comment `plateTexels.ts:39` gives ~103 thousand corners per plate (side ≈ 321 → 204,800 triangles at full level). The mesh itself is drawn elsewhere (terrainLod.ts); here it is height/normal texel data (Float32 x 4 per corner = 16 B, Float64 heights).
- `plateTexels.ts:11-83`: texel refills for the same grid (no geometry). `plateFollow.ts`, `platePaint.ts`: bookkeeping only.

#### 16. Tracers
- `playEffects.ts:107-158` (`createTracers`): one `LineSegments`, 32 slots (`TRACER_SLOTS`) = 64 vertices / 32 lines, non-indexed; position 3f + color 4f = 28 B/vertex, DynamicDraw, `frustumCulled = false`, 1 draw when any is lit.

#### 17. Rain
- `rain.ts:84-173` (`createRain`): one `LineSegments`, 10,000 drops (`MAX_DROPS`) = 20,000 vertices / 10,000 line segments, non-indexed; attributes position 3f (seed) + tip 1f = 16 B/vertex (320 KB). Positions are generated in the vertex shader (wrapped lattice). `setDrawRange` scales with rain amount; additive, `frustumCulled = false`, 1 draw. Off on low tier.

#### 18. Explosion / shot debris (spawned here, built in blast.ts)
- `playEffects.ts:360-555`: per event debris pieces (`blast.debris` boxes/cylinders/meshes): glass hit 14 boxes; per exploded pole 1-many cylinders + cross-arm box (+ lamp box); per wire 3 wires; per post 2 cylinders + box; per vehicle a carcass mesh (or a `car` box) + 2 wheel cylinders; per tree 2 cylinders + 6 splinter boxes + 24 leaf boxes; per shrub 1 + 14; per lamp 1 + 1; other items 4 boxes; gore 4-7 organ pieces per torn body (`:282-291`). Geometry and caps are in blast.ts (not in chunk).

#### 19. Ragdolls
- `ragdoll.ts`: no geometry of its own. Bodies are 20 particles (`JOINTS` + belly, `:75-85`) simulated by Verlet or Jolt, drawn by re-using the crowd's skinned meshes via `citizens.drawPalette` (one palette per piece, `:1101`, `:1908-1955`). Caps: 40 bodies (`MAX_BODIES`, `:154`), 400 blood decals (`:414`, drawn by casualties.ts). Jolt colliders (`ragdollJolt.ts`): capsule/box parts (12 per body), height-field tiles of 64 x 64 samples at 0.1 m (`ragdoll.ts:190`), convex-hull prisms for walls — physics only, never rendered. `ragdollGround.ts`: 64 x 64 height tiles cached on CPU (physics). `ragdollAxes.ts`: maths only.

#### 20. Post-processing full-screen passes
- Location: `postprocess.ts:75-567`.
- Primitive: every pass draws one full-screen triangle (3 vertices; `fullScreenTriangle` = position 3f + uv 2f, and three's `FullScreenQuad`).
- Draws per frame (high/ultra): scene copy 1 (only when the canyon pass is off, `:166-173`); GTAO 2 (AO + Poisson denoise, 8 samples each, half or full resolution `aoFull`); canyon light 1; bloom (only at night): bright pass 1 + 5 mips x 2 separable blurs + composite + blend ≈ 13 at half resolution; clouds: shadow map (512², only when it changes) + bodies (quarter pixels, history ping-pong) + composite = 2-3; SMAA 3 (edges, weights, blend); output/grade 1. Low/medium (no post chain): 0, or 1 copy (`plainChain`) when the canvas has no MSAA.
- Warm-up scenes add triangles only for compile.
- Notable: ray-marched clouds (up to 24 clouds x 7 puffs, 24 steps) and ground fog (36 steps) are per-pixel loops, not geometry.

#### 21. Textures that feed geometry shaders (no polygons)
- `hairTexture.ts`: 512 x 1024 RGBA8 strand atlas. `skinAppearance.ts`: DataArrayTexture layers (256 px x 24, 512 px x 16, doubling) and shader patches for the roster person material. `garmentPadding*.ts`: UV-island padding (rasterises UV triangles on the CPU, not GPU geometry).

### Budgets, caps and counters found
- Crowd LOD triangle budgets per role and level: `crowdLod.ts:31-49` (`SKIN_TRIANGLES_LEVEL0 = 26756`, `LEVEL_TRIANGLES`, `EYE_TRIANGLES = [∞, 200, 40, 0]`, `FAR_TRIANGLES = {skin 120, outfit 90, garment 60}`).
- Crowd LOD pixel thresholds `[40, 20, 8, 3]`, hysteresis 0.1, caps `LEVEL_CAPS = [30, 120]`: `crowdLod.ts:8-14`.
- Roster person LOD ratios `[[0.3,0.008],[0.1,0.03],[0.015,0.12,loose]]`, cluster cells `[0.03,0.08,0.2]` m: `personRig.ts:777-781`.
- Crowd counters: `stats()` → classes, people, pieces, draws, items, vertices, textureBytes, levels per LOD, triangles (shadow excluded): `proceduralCrowd.ts:2403-2420`.
- Piece capacity start 16 (doubling), class rows start 64: `proceduralCrowd.ts:265-267`; 16 baked bodies per class `crowdBodies.ts:7`; palette pages 2,048 rows `paletteTargets.ts:7`; wound slots 8, expression slots 12.
- Hair strands nearest N: `HAIR_STRAND_PEOPLE = 8` (low 2), range 14 m: `quality.ts:10`, `proceduralCrowd.ts:1572`.
- Held props capacity 300 per kind (7 kinds): `heldProps.ts:89`.
- Tracers 32, rain 10,000 drops: `playEffects.ts:96`, `rain.ts:8`.
- Ragdolls 40 bodies, 400 decals: `ragdoll.ts:154`, `:414`.
- Blob shadows start capacity 1024 (grows): `proceduralCrowd.ts:895`.
- Impostors: `THIN_PX = 2`, `PICTURE_PX = 48`, atlas ≤ 4 x 4 blocks of 512 px: `plantImpostors.ts:45,467,246`.
- Prop layers: near 48 MB CPU, far 24 MB CPU, 192 MB GPU, `MOST_NEAR = 8`, `FRAME_MS = 6`: `propCells.ts:53,61,284,441`.
- Poles: block 768 m, 16 MB CPU / 128 MB GPU, `triangles` getters: `poleLayer.ts:471`, `poleCells.ts:70,77-81`, `poleLayer.ts:509-513`.
- Tier table `QUALITY` (`quality.ts:122-261`): `triangleScale` (0.35 / 0.6 / 1 / 1), `grassBlades` (0 / 30k / 60k / 90k), `vegetation` (0 / 600 / 1,400 / 2,600), `birds` (0 / 150 / 400 / 600), `vehicleWholeCap` (60 / 200), `vehicleErrorPixels` (1 / 0.5), `detailMemoryMB` (256 / 448 / 768 / 1024), shadow map 1024 / 1024 / 2048 / 2048.
- Geometry memory budgets `GEOMETRY_BUDGETS` (`quality.ts:110-115`): total 448 / 600 / 900 / 1200 MB, masses 96-320 MB, roads near 48-192, roads far 48-160, view-cell share 0.25-1; `NETWORK_FAR_MB = 16`.
- Profiler counters: geometry builds/disposes, buffer and texture upload bytes (`profilerHooks.ts:8-55`).

### Files without geometry
- src/render/people/: bodyPixels.ts (CPU morph sum), cartoon.ts (vertex reproportioning maths), classRigMade.ts (transfer wrapper), cookPack.ts (binary record format), cookedLoad.ts (loader), faceExpression.ts (morph weights), garmentPadding.ts / garmentPadding.worker.ts / garmentPaddingPool.ts (texture padding), garmentSlots.ts, hairTexture.ts (texture), lodPool.ts / lodPort.ts / lodWorker.ts (simplifier service; they produce index arrays but draw nothing), paletteTargets.ts (render targets), personMesh.ts (face selection and hem planes feeding personRig), personVariants.ts (shader keys), proceduralCook.ts (cook loader), skinAppearance.ts (textures/shaders).
- src/render/: pinned.ts, plateFollow.ts, platePaint.ts, plateTexels.ts, poleBake.ts (bounds helpers), profilerHooks.ts, quality.ts (budgets only), ragdollAxes.ts, ragdollGround.ts, ragdollJolt.ts (physics shapes only), ragdoll.ts (no meshes of its own).

---

## Polygon geometry audit - chunk g07

### Files read

Every file was read in full, from the first line to the last (long files in sequential chunks).

| File | Lines |
|---|---|
| src/render/renderer.ts | 4140 |
| src/render/revealGate.ts | 41 |
| src/render/riderPoses.ts | 586 |
| src/render/riggedCitizens.ts | 1287 |
| src/render/roadProgramStandIns.ts | 58 |
| src/render/roadStandIn.ts | 134 |
| src/render/roadStations.ts | 83 |
| src/render/roadStations.worker.ts | 27 |
| src/render/roadSurfaceEntries.ts | 199 |
| src/render/roadSurfaceInputs.ts | 775 |
| src/render/roadSurfacePass.ts | 142 |
| src/render/roadSurfaceReads.ts | 359 |
| src/render/roadSurfaceRings.ts | 77 |
| src/render/roadSurfaces.ts | 818 |
| src/render/roadTile.worker.ts | 110 |
| src/render/roadTileMesh.ts | 172 |
| src/render/roadTilePool.ts | 207 |
| src/render/roadTileShape.ts | 83 |
| src/render/roadTones.ts | 19 |
| src/render/roadsRead.ts | 12 |
| src/render/roomLamps.ts | 45 |
| src/render/scenery.ts | 370 |
| src/render/screenSize.ts | 33 |
| src/render/shaderCatalogue.ts | 165 |
| src/render/shadowCasters.ts | 35 |
| src/render/sharedGround.ts | 137 |
| src/render/signLayer.ts | 440 |
| src/render/signals.ts | 726 |
| src/render/signs.ts | 464 |
| src/render/stagedTexels.ts | 116 |
| src/render/stillTree.ts | 41 |
| src/render/streetFurnitureLayer.ts | 466 |
| src/render/structureCells.ts | 115 |
| src/render/structures.ts | 712 |
| src/render/sunCascades.ts | 1073 |
| src/render/surfaceBakeClient.ts | 121 |
| src/render/surfaceTextures.ts | 104 |
| src/render/targetBytes.ts | 51 |
| **Total (38 files)** | **14,543** |

Nothing was left unread.

I looked outside the chunk only to resolve numbers, with targeted greps and no full reads:
- `src/render/terrainGrid.ts` (first 15 lines): `TERRAIN_CELL = 2048/320 = 6.4 m`.
- `src/core/units.ts`: `METERS_PER_UNIT = 1`, so `m(x) = x`.
- `src/core/perfBudget.ts`: `VIEW_BUDGETS` triangles.
- `src/world/roads/tuning.ts`: pier spacing.
- `src/render/paintQuads.ts`: the `PAINT_COLOURS` definition.
- `src/render/agents.ts:619`: the helmet `SphereGeometry`.

Unless stated otherwise, three.js r186 formulas are used:
- **Box:** 24 vertices / 12 triangles.
- **Cylinder(rs, hs) closed:** side (rs+1)(hs+1) vertices; each cap adds rs + (rs+1) vertices. Triangles: 2·rs·hs, plus rs per cap.
- **Circle(s):** s+2 vertices / s triangles.
- **Sphere(w, h):** (w+1)(h+1) vertices / 2·w·(h-1) triangles.

---

### Elements

#### 1. Grid flash ("blink" of the universal grid cells under a road just laid)
- **Location:** `renderer.ts:854-869` (`addBlink`), filled by `flashGrid` (`renderer.ts:2987-3000`); material `blinkMaterial` (`renderer.ts:834-852`).
- **Primitive:** triangles, non-indexed `BufferGeometry`, default draw mode.
- **Counts:** each cell is split into `sub = 4` × 4 pieces, 2 triangles each. Per cell that is 16 × 6 = **96 vertices / 32 triangles**. The vertices sit on the ground (`terrain.renderedHeightAt` + 0.3 m).
- **Attributes:** `position` f32×3 + `aRing` f32×1 = **16 B/vertex**, so 1,536 B per cell.
- **Multiplicity:** one mesh per `flashGrid` call. It lives about 0.8 s + ring × 0.09 s and is then removed and disposed (`renderer.ts:3565-3571`). It is `frustumCulled = false`, `renderOrder 6`, transparent, additive, `depthTest/depthWrite false`, DoubleSide, and casts no shadow.
- **Notes:** short-lived; geometry is made per flash. It is non-indexed (4 shared corners per piece are duplicated to 6), which is harmless at this scale.

#### 2. Road flash strip (blink over a road just laid)
- **Location:** `renderer.ts:3540-3564` (inside `draw`), passed to `addBlink`.
- **Primitive:** triangles, non-indexed, sharing material 1.
- **Counts:** one quad per `step = 1.5 m` of road between its trims. Each quad is **6 vertices / 2 triangles**, so per metre that is 4 vertices / 1.33 triangles. Width is `sidewalkHalf` on each side; height is the deck + 0.3 m.
- **Attributes:** 16 B/vertex, as in element 1.
- **Multiplicity:** one mesh per frame that has pending road flashes; same lifetime, culling and shadow settings as element 1.
- **Notes:** built with `pos.push(...l0, ...)` spreads into JS arrays. This allocates during the frame, but only once per road edit.

#### 3. Blast shader warm-up triangle
- **Location:** `renderer.ts:2498-2531` (`warmBlastShaders`).
- **Primitive:** triangles, non-indexed; one triangle (`tiny`).
- **Counts:** **3 vertices / 1 triangle**.
- **Attributes:** position, normal, color (f32×3 each), uv (f32×2), `aDecay` (f32×1) = 48 B/vertex.
- **Multiplicity:** one `Mesh` per building material: 3 + |`kit.material`| + 2. They are in an invisible group that casts and receives shadows, used only for `compileAhead`, and removed once compiled. The same function also instances `partWarmMeshes(kit)` (built in `buildings/partWarm.ts`, outside this chunk) for the part programs and their shadow stand-ins.
- **Notes:** one-time. Not drawn in play.

#### 4. Road shader / preview warm-up geometry
- **Location:** `renderer.ts:2455-2493` (`warmRoadShaders`) and `renderer.ts:2536-2573` (`warmPreviewShaders`).
- **Counts:** builds a whole sample world. That is a 4-leg junction (four 70 m roads) with 2 poles and a span, plus:
  - `buildRoadSurfaces`, `buildStructureDetails`, `buildUtilities`, and the furniture and sign warm meshes;
  - a sample building ×3 (ghost, real, faded) from `buildBuildingMeshes`;
  - `plantSamples` (element 22);
  - two track previews (60 m each).
- **Multiplicity:** once per session. Compiled through `compileAhead` and then disposed. Never drawn in play.

#### 5. Shadow depth material variants (shadow-pass state, not geometry)
- **Location:** `renderer.ts:512-537`.
- Three `MeshDepthMaterial`s (`plain`, `instanced`, `tinted`), all `colorWrite: false`. Every caster without its own depth material gets one of them. The shadow pass therefore re-draws every caster's triangles once per cascade drawn; see element 27.

#### 6. Road program stand-ins (one invisible triangle per road look)
- **Location:** `roadProgramStandIns.ts:24-58`.
- **Primitive:** triangles, indexed `[0,1,2]` (a JS array, so `Uint16`).
- **Counts:** **3 vertices / 1 triangle** per mesh.
- **Attributes:** position, normal (f32×3), uv (f32×2) = 32 B/vertex, plus `color` (f32×3) when the material uses vertex colours and `roadSection` (f32×3) when it reads one.
- **Multiplicity:** at most 2 (raised or not) × (5 bands + 3 median parts + |`PAINT_COLOURS`|) meshes, deduplicated by `material.uuid | castShadow | readsSection`. The group is `visible = false` and the meshes are `frustumCulled = false`. They exist only so the opening's `shaderCatalogue` compiles every road program and its depth program. The group is added to `world` permanently (`renderer.ts:928-929`).
- **Notes:** negligible size. They stay in the scene graph for the session; they are hidden, so they are not drawn.

#### 7. Road stand-in (a road just built, drawn until the world build of its commit lands)
- **Location:** `roadStandIn.ts:34-61` (`fill`, `meshOf`) and `show` (`roadStandIn.ts:77-108`).
- **Primitive:** triangles, indexed; earcut triangulation of each ring outline. The index is `Uint16`, or `Uint32` past 65,535 vertices.
- **Counts:** per outline ring of n points: **n vertices / n−2 triangles**. Each road contributes its casing ring and asphalt ring. A junction whose roads are all new contributes its casing and asphalt plate rings.
- **Attributes:** position + normal (f32×3 each) = 24 B/vertex; no uv.
- **Multiplicity:** 2 meshes (casing at `renderOrder 1`, asphalt at `renderOrder 2`) per road commit not yet landed, keyed by network revision. They are let go when a build of that revision lands. `receiveShadow` is on; they do not cast. Flat-tone `MeshStandardMaterial` with `pullTowardEye`.
- **Notes:** transient and small.

#### 8. Road surface tiles and blocks (the main road geometry: verge, footway, curb ramps, kerb, asphalt, medians, paint)
- **Location:**
  - Orchestration: `roadSurfaces.ts:280-789` (`roadSurfaceSteps`, `buildRoadSurfaces` at `roadSurfaces.ts:264-277`).
  - Per-surface specs: `roadSurfaceReads.ts:108-359` (`passSurfaces`).
  - Pass descriptions: `roadSurfacePass.ts:95-142`.
  - Tile shapes: `roadTileShape.ts:34-83` (`tileShapes`: Clipper union, difference, intersection, then `clipToRect` and `surfaceShape`).
  - Meshing: `meshTileShape` in `mesh/tileMesh.ts` (outside this chunk), called from `roadSurfacePass.ts:134-142` and `roadTileMesh.ts:130-158` (worker).
  - Merging blocks and the far level: `mergeTiles`, `attachFarLevel` and `splitBlock` in `mesh/surfaceTiles.ts`, and `coarseArrays` (meshoptimizer) in `mesh/roadLodPure.ts` (all outside this chunk).
  - Worker pool: `roadTilePool.ts:51-207` and `roadTile.worker.ts:42-110`.
  - Input rings (CPU polygons, not GPU): `roadSurfaceInputs.ts`, `roadSurfaceRings.ts`, `roadSurfaceEntries.ts`.
- **Primitive:** triangles, indexed (a `Tile` carries `indices`). Draw mode default.
- **Tile and block sizes:** a tile is `TILE = 76.8 m` square (`roadSurfaceEntries.ts:12`). A block (one mesh) is `CHUNK = 8` × 8 tiles = **614.4 m square** (`roadSurfaces.ts:218`).
- **Counts:** generated. Triangle density is set by `maxEdge` (longest triangle edge):
  - Ground pass on real relief: `GROUND_MAX_EDGE = TERRAIN_CELL/2 = 3.2 m` (`roadSurfacePass.ts:23`).
  - Raised decks, and ground roads on a new flat map (`RELIEF_FLAT`, no stamps): `RAISED_MAX_EDGE = 6.4 m` (`roadSurfacePass.ts:25-27,104`).
  - Curb ramps: `RAMP_MAX_EDGE = 0.75 m` (`roadSurfaceReads.ts:26`).
  - Paint: `maxEdge: 5` (5 m) (`roadSurfaceReads.ts:350`).
  - Every band with a `bottom` grows skirts along its outline: verge, footway, curbRamp, kerb, raised asphalt, median kerb, planting and paved.
  - No exact count is possible without the network. The code reports triangles as `index.count/3` per block (`roadSurfaces.ts:740`), summed into `RoadSurfaces.triangles`, which goes into `renderer.builtTriangles` (`renderer.ts:2439`).
  - A code comment records the scale: on a flat map at 3.2 m edges, "a large city's streets drew 6 M triangles of a flat plane, a quarter of the frame's" (`roadSurfacePass.ts:26`). That is why level ground now uses 6.4 m.
- **Attributes (per `Tile`, `roadTileMesh.ts:166-168`):** positions, normals, uvs, colors (tint), sections (`roadSection`, the cross-section position for wear marks), indices, and an optional box. Exact types and bytes are defined in `mesh/tileMesh.ts` (not in this chunk).
- **Surfaces per pass:** 8 (verge, footway, curb-ramp, kerb, asphalt, median-kerb, median-planting, median-paved) + one per paint colour (`paintColours()` = `PAINT_COLOURS` + any other colour met).
  - Surfaces drawn with the same material, order and shadow flags are merged into **one mesh per draw group per block** (`drawGroups`, `roadSurfaces.ts:167-180`). For example, footway + curbRamp + median-paved share `materials.footway`, and kerb + median-kerb share `materials.kerb`.
  - Passes: one per road structure kind (`ROAD_STRUCTURES`) plus one per hand-raised alignment chain (`roadSurfaceInputs.ts:651-657`).
- **Multiplicity and LOD:**
  - Draw calls are about blocks × draw groups × passes present.
  - Each block also holds a **far level**: a meshoptimizer-simplified copy, locked at the block's edge. It is made off the page (`roadTilePool.coarsen`) and kept hidden beside the full mesh (`addBlock`). Near and far are switched by `mesh/roadResidency.ts` (`updateRoadLevels`, every 6 frames, `renderer.ts:3806-3817`).
  - Reach: `roadFocus.reach = clamp(halfHeight × 1.8, 320, 900) / buildings.frame.scale`.
  - Residency budgets: `roadsNearMB` and `roadsFarMB` from `GEOMETRY_BUDGETS[tier]` (`renderer.ts:1356-1363`).
  - A whole-network far level (`NetworkFarRoads`, `FAR_ROAD_CELL = 8 × TILE`) covers cells not built in detail (scoped opening, map view).
- **Shadows:** ground-level roads do **not** cast (`surfaceLook`, `roadSurfaces.ts:792-807`). On raised passes, verge (deck), footway, curbRamp and asphalt cast. Paint and medians never cast. Everything receives shadows. Paint is drawn at `renderOrder 3`, lifted `0.02 + PAINT_RISE`.
- **Worker and batching numbers:** `SHAPE_BATCH = 64` tiles per batch, `IN_FLIGHT = 3` batches ahead, up to `MOST_LANES = 6` workers (`roadSurfaces.ts:220-222`, `roadTilePool.ts:25`). Tiles are cached in IndexedDB keyed by digest; the worker write ceiling is 48 MB (`roadTile.worker.ts:18`, `renderer.ts:1017`).
- **Performance notes:**
  - Paint is meshed as its own surfaces, one per colour per tile, clipped to the carriageway: polygon geometry for every line or zebra, not a decal.
  - Every skirted band adds a vertical ring of triangles along each outline.
  - The input residency (`ROAD_INPUT_RESIDENCY`: 48 MB CPU, 400 m reach) only bounds the CPU polygons, not GPU triangles.

#### 9. Lamp light pool (warm disc on the road under a street lamp at night)
- **Location:** `scenery.ts:213-224` (`new CircleGeometry(1, 28)`, rotated flat).
- **Primitive:** triangles, indexed.
- **Counts:** **30 vertices / 28 triangles**.
- **Attributes:** standard Circle (position, normal, uv) = 32 B/vertex.
- **Multiplicity:** one instance per street lamp, through the furniture runs (`street-light-pools`, `streetFurnitureLayer.ts:110`) and the poles' layer. Scaled to an ellipse (across × along). Transparent, additive, `depthWrite false`, `renderOrder 3`. Visible only when `dark > 0.02`. No shadow.

#### 10. Lamp light beam (visible cone of light)
- **Location:** `scenery.ts:225-230` (`new CylinderGeometry(0.075, 1, 1, BEAM_SIDES = 18, BEAM_SEGMENTS = 4, openEnded true)`), shader `beamMaterial` (`scenery.ts:82-128`).
- **Primitive:** triangles, indexed.
- **Counts:** (18+1)(4+1) = **95 vertices / 144 triangles** (2·18·4; open, no caps).
- **Multiplicity:** one instance per street lamp (`street-light-beams`, `renderOrder 4`). Additive, `depthWrite false`, FrontSide. Only visible when `night × haze > 0.02` (rain or fog at night). Fades out from 60 m to 140 m from the eye, but the vertices are still processed. No shadow.

#### 11. Scenery kit models (street furniture, trees, bushes, cards, tufts, flowers, lens, tree pit)
- **Location:** `scenery.ts:172-306` (`createSceneryKit`). The geometry functions (`lampGeometry`, `binGeometry`, `benchGeometry`, `hydrantGeometry`, `postboxGeometry`, `phoneGeometry`, `drainGeometry`, `lampLensGeometry`, `treePitGeometry`, `grassTuftGeometry`, `wildflowerGeometry`, `treeParts`, `bushParts`) are in `propGeometry.ts`, and the leaf cards in `lowPolyTrees.ts`. Both are outside this chunk, so vertex counts are not computed here.
- **Multiplicity:** shared by the street furniture (element 12), gardens, poles and planted plants. Built once per renderer.
- **Notes:** a code comment in `streetFurnitureLayer.ts:96-98` says the small props (a bin is about 250 triangles) drew "~3.5 M triangles, scene and shadows" at the district view before the far box level (element 13) was added.

#### 12. Street furniture and street plants layer (placed lamps, bins, benches, hydrants, post boxes, phones, drains, tree pits, street trees, shrubs)
- **Location:** `streetFurnitureLayer.ts:94-140` (`furnitureStores`), `furniturePlace` (`:163-227`), `createStreetFurniture` (`:396-466`). Instancing is done by `createPropLayer` (`propCells.ts`) and `RunBuilder` / `createInstanceRuns` (`instanceRuns.ts`); both are outside this chunk.
- **Primitive:** triangles, instanced meshes (one store per model). Each lamp item writes 4 instances: post, lens, pool and beam.
- **Stores:** 11 prop stores plus one per tree species and one per bush kind:
  - **Plants:** body + leaf cards (cards do not cast) + a far impostor quad (`far.quads[picture]`, chosen by screen size `PICTURE_PX`).
  - **Small props** (bin, bench, hydrant, postbox, phone, drain, tree pit): a far box below 12 px (element 13).
- **Shadows:** posts and props cast. Lens, pool and beam do not. Tree pits do not cast. Plant bodies and far quads cast; cards do not ("alpha-cut cards in the shadow pass cost 70 ms a frame").
- **Multiplicity:** per placed item, held in view cells (`propCells.ts`). `SHADOW_REACH = 28 m` cull margin. Hidden when `quality.detailProps` is false or below `detailCutoffZoom` (`renderer.ts:3527-3529`). Leaf cards are hidden below `PLANT_MAP_ZOOM = 2.5 px/m`.

#### 13. Far box of a small prop (props under 12 px)
- **Location:** `streetFurnitureLayer.ts:73-91` (`farBox`), used by `prop(..., small = true)` (`:99-104`).
- **Primitive:** triangles, indexed `BoxGeometry` fitted to the model's bounding box.
- **Counts:** **24 vertices / 12 triangles**, replacing the full model.
- **Attributes:** Box position, normal and uv, plus every other attribute of the model averaged (vertex colour, finish, and so on).
- **Multiplicity:** one per small prop instance drawn below `PROP_FAR_PX = 12` px. Shadows follow the prop's flags.

#### 14. Long grass tufts and wildflowers (placed meadow clumps)
- **Location:** `streetFurnitureLayer.ts:312-338` (`MEADOW_STORES`, `meadowInto`). The `kit.tuft` and `kit.flower` geometry is in `propGeometry.ts` (outside this chunk).
- **Primitive:** instanced (`createInstanceRuns('grass', …, 0)`).
- **Multiplicity:** per tuft or flower of each placed meadow clump (`grassClump`, `grass.ts`). No shadow (`castShadow false`). Drawn at every zoom. DoubleSide material with wind.

#### 15. Plant samples (shader warm-up)
- **Location:** `scenery.ts:309-338` (`plantSamples`).
- **Counts:** one `InstancedMesh(geometry, material, 1)` per tree and bush model and per card set, × 2 (tinted or not), plus a matching depth-material instanced mesh each.
- **Multiplicity:** used only by `warmPreviewShaders` (`renderer.ts:2559-2562`); disposed after compiling.

#### 16. Sign posts
- **Location:** `signs.ts:460` (`POST = CylinderGeometry(0.04, 0.045, 1, 8)`); instanced by `createInstanceRuns('sign-posts', POST_STORES, 4 m)` (`signLayer.ts:234-243`), filled by `standOf` (`signLayer.ts:373-390`).
- **Primitive:** triangles, indexed, closed cylinder with 8 radial segments and 1 height segment.
- **Counts:** side (9×2 = 18) + 2 caps × 17 = **52 vertices / 32 triangles** (16 side + 8 per cap).
- **Multiplicity:** one per sign stand: junction signs, placed signs, and street name plates at both ends of every segment of a named street. `castShadow` and `receiveShadow` are on, and instances are culled by `posts.cull`.
- **Notes:** caps are invisible at 4 cm radius at any normal view distance (the top is hidden by the plate or too small). An open cylinder would save 16 of 32 triangles.

#### 17. Sign plates (the picture quads)
- **Location:** `signLayer.ts:266-353` (`storeOf`, `sized`, `putQuad`, `freeQuad`); textures from `signs.ts` (`SignSheets`, `plateCanvas`).
- **Primitive:** triangles, **non-indexed**: 6 vertices per quad (`QUAD_ORDER = [0,2,1,2,3,1]`, `signs.ts:463-464`). Uses `drawRange(0, used × 6)`.
- **Counts:** **6 vertices / 2 triangles** per plate face. A street name plate has 2 faces (`plateFaces`, `signs.ts:44-48`); every other type has 1.
- **Attributes:** position f32×3, normal f32×3, uv f32×2 = **32 B/vertex** (192 B per quad), all `DynamicDrawUsage`. Updated per slot with `addUpdateRange`.
- **Multiplicity:**
  - One mesh per sign sheet (texture atlas). A sheet is up to 8 columns × rows of 256-px cells (`PAGE` = 2,176 px). Two cell heights (80 and 256) give separate sheets.
  - Capacity starts at 64 quads and grows to ×1.5 + 512 (`signLayer.ts:277,326`).
  - `frustumCulled = false` and `castShadow = true` (alphaTest 0.5, DoubleSide material, so three uses an alpha-tested depth material).
- **Notes:**
  - Freed slots are zeroed (zero-area triangles) but stay inside the draw range until reused. Degenerate triangles are still submitted.
  - Every plate is drawn into every shadow cascade pass it falls in (no frustum culling at the mesh level).
  - The warm plate in `warm()` (`signLayer.ts:415-425`) is one 6-vertex quad.

#### 18. Traffic signal frame (post + arm + housing merged)
- **Location:** `signals.ts:115-117`, then `framePart` and `mergeGeometries` (`signals.ts:157-181`); depth material `frameDepth` (`:200-210`).
- **Primitive:** triangles, indexed (merged indexed geometries).
- **Counts:**
  - Post `CylinderGeometry(0.09, 0.09, 6.2, 8)`: 52 vertices / 32 triangles.
  - Arm `CylinderGeometry(0.06, 0.06, 3.5, 8)`: 52 vertices / 32 triangles.
  - Housing `BoxGeometry(0.42, 1.05, 0.3)`: 24 vertices / 12 triangles.
  - Merged: **128 vertices / 76 triangles**.
- **Attributes:** position f32×3, normal f32×3, uv f32×2, color f32×3, `aSurface` f32×2, `aSwayPart` f32×4, `aCastReach` f32×1 = **72 B/vertex**.
- **Multiplicity:**
  - 1 instance per signal head; one head per signalised approach (`junctionOf`).
  - Batched per `BLOCK = 768 m` square: one `InstancedMesh` per batch kind per block, with runs per 256-m cell (`SIGNAL_CELL`).
  - Instance capacity starts at 16 and doubles.
  - Casts (`castBySize`, using the widest part's radius) and receives. In the depth pass, parts narrower than the cascade texel are collapsed per vertex (`aCastReach < uCastTexel`, so `gl_Position` goes off-clip). Wind sway is applied in the shader.
  - The whole signal group is hidden when not `detailed` (`signals.ts:659-662`).

#### 19. Signal visors (hoods over each lens)
- **Location:** `signals.ts:126` (`BoxGeometry(LAMP_RADIUS × 2.5, 0.06, 0.18)`).
- **Primitive:** indexed Box, **24 vertices / 12 triangles**.
- **Multiplicity:** 6 per head (3 lamps × 2 faces), instanced per block (element 18). Casts (by size, the box's bounding radius) but does not receive.

#### 20. Signal lenses
- **Location:** `signals.ts:119-121` (`CylinderGeometry(0.15, 0.15, 0.06, 12)` rotated X), material `lenses` with an `aLensGlow` instanced attribute (`signals.ts:227-245`, `:353-368`).
- **Primitive:** triangles, indexed, closed cylinder with 12 radial segments.
- **Counts:** side 13×2 = 26 + 2 caps × 25 = **76 vertices / 48 triangles** (24 side + 12 per cap).
- **Per-instance attributes:** instanceMatrix 64 B + instanceColor 12 B + `aLensGlow` 16 B.
- **Multiplicity:** 6 per head (3 lamps × 2 faces). No shadow. One `InstancedMesh` per block.
- **Notes:** a full closed disc-cylinder is drawn where only one face is visible (the back cap faces into the housing). One `CircleGeometry(…, 12)` would be 14 vertices / 12 triangles. A code comment (`signals.ts:452`) measured a large city at **7,638 lenses, 20,196 visors, "1 M triangles at a close view and as many cast"** before per-block batching.

#### 21. Signal halos (glow disc over a lit lens)
- **Location:** `signals.ts:123-125` (`CylinderGeometry(HALO_RADIUS, HALO_RADIUS, 0.02, 12)` rotated X).
- **Counts:** **76 vertices / 48 triangles**, the same shape as the lens.
- **Multiplicity:** one per lit lens face: 2 per head (one lamp lit × 2 faces). Transparent, opacity 0.28, `toneMapped false`, no shadow.
- **Notes:** a 2-cm-thick closed cylinder used as a transparent glow; a circle would do (12 triangles).
- **Per-head total (lit):** 76 (frame) + 6 × 12 (visors) + 6 × 48 (lenses) + 2 × 48 (halos) = **532 triangles per signal head**. Of these, 148 cast (frame + visors).

#### 22. Road structure details: piers (columns under elevated roads and bridges)
- **Location:**
  - Shape: `structureCells.ts:41` (`CylinderGeometry(1, PIER_FOOT_FLARE = 1.08, 1, 16)`), or the fallback at `structures.ts:684`.
  - Placements: `structures.ts:509-552` (`placeBent`).
  - Instancing: `structures.ts:235-246` (`instanced`).
- **Primitive:** triangles, indexed, closed cylinder with 16 radial segments.
- **Counts:** side 17×2 = 34 + 2 caps × 33 = **100 vertices / 64 triangles** (32 side + 16 per cap).
- **Multiplicity:**
  - One bent (crossbeam) every `spacingElevated = 29.6 m` or `spacingBridge = 38.4 m` (`world/roads/tuning.ts:48,50`), with 1–2 columns per bent.
  - One `InstancedMesh` per 256-m structure cell (`structureCells.ts:13`). Casts and receives.
  - The bottom cap is buried in the ground and the top cap sits under the crossbeam; neither is visible (32 of 64 triangles).

#### 23. Road structure details: pier caps, abutments, tunnel jambs, lintels, headwalls
- **Location:** shared `BoxGeometry(1, 1, 1)` (`structureCells.ts:41`), with placements:
  - caps: `structures.ts:540`;
  - abutments: `:487-506`;
  - jambs: `:618-639` (wing-wall slices of `PORTAL_SLICE = 1.2 m`);
  - lintels: `:640-648`;
  - headwalls: `:650-658`.
- **Counts:** **24 vertices / 12 triangles** each instance.
- **Multiplicity:** 1 cap per bent; 1 abutment wherever the deck crosses `ABUTMENT_LIFT`; per tunnel portal, about 2 × ceil(width / 1.2 m) jambs + 1 lintel + 1 headwall. One `InstancedMesh` per kind per 256-m cell. All cast and receive.

#### 24. Parapets along raised decks
- **Location:** `structures.ts:368-425` (`parapetRun`), `Extrusion` (`:262-343`), and `sheetMesh` (`:346-359`).
- **Primitive:** triangles, indexed; 4 vertices + 6 indices per quad. Index is `Uint16`, or `Uint32` at 65,536+ vertices.
- **Counts:** 3 quads per `PARAPET_STEP = 1.2 m` section per side (outer face, top, traffic face), plus end caps. Per metre of raised road, both sides: about **20 vertices / 10 triangles**.
- **Attributes:** position f32×3, normal f32×3, uv f32×2 = 32 B/vertex.
- **Multiplicity:** one mesh per 256-m structure cell. Casts and receives.

#### 25. Retaining walls and their backfill (cuttings with `cutWalls`)
- **Location:** `structures.ts:95-152` (`retainingWalls`), with meshes made at `:692-697`.
- **Primitive:** indexed quads (`Extrusion`).
- **Counts:** per `WALL_STEP = 0.8 m` per side:
  - 3 face quads (road face, coping, coping back): 6 triangles / 12 vertices;
  - 1 backfill lid quad: 2 triangles / 4 vertices;
  - plus end quads.
  - Per metre with both sides walled: walls about **15 triangles / 30 vertices**, backfill about **5 triangles / 10 vertices**.
- **Multiplicity:** 2 meshes (walls with `materials.parapet`, backfill with the terrain material) per 256-m cell. Walls cast. Backfill does not cast and only exists when a ground material is given.
- **Note:** `structureCells` keeps up to 9 meshes, so up to 9 draw calls per cell: 6 instanced kinds + parapets + walls + backfill.

#### 26. Rigged citizens (people bodies, instanced and GPU-skinned, with LOD)
- **Location:** `riggedCitizens.ts:339-1277` (`createRiggedCitizens`).
  - Mesh creation: `load`, `:584-685`.
  - Coarse shadow LOD: `castCoarse`, `:215-248`.
  - Instance growth: `growLevel`, `:251-266`.
  - Skinning shader: `:151-164`, `skinMaterial` `:307-337`.
- **Primitive:** triangles, indexed. One `InstancedMesh` per **distinct LOD index** per body part per body model. LOD levels share every vertex attribute and differ only in index (`variants`, `:586-613`).
- **Counts:** vertex and triangle counts come from the cooked bodies (`people/cookedLoad.ts`, `personBuild.ts`, `personRig.ts`) or the glTF assets, all outside this chunk. LOD error targets are `CITIZEN_LEVEL_ERROR = [0, 0.008, 0.03, 0.12]` × body height (1.9 m) (`:113-115`). A code comment (`:212-213`) states "~0.25 M triangles a rigged citizen a frame went into the shadow maps" before `castCoarse`.
- **Attributes:**
  - Per vertex: the cooked body's, plus `clothingMask` f32×1 for child bodies (`markChildShirt`) and face morph targets on level 0 only.
  - Per instance: instanceMatrix 64 B, instanceColor 12 B (`DynamicDrawUsage`), and `citizenRow` f32 (an `InstancedBufferAttribute` of size `CAPACITY = 1000`, set as a geometry attribute).
  - Bone palettes are rendered on the GPU into a shared target (`createPalettePass`, rows 16 doubling to 1000).
- **Multiplicity:**
  - Up to `CAPACITY = 1000` figures per body model. Instance buffers start at `LEVEL_START = 16` and double.
  - Up to 6 concurrent loads. Idle bodies are evicted after 60 s.
  - The level is chosen per figure from its pixel height (`citizenLevelOfFigure`). Level 0 (with face) is used whenever `citizenBandAt(zoom) === 0` (zoom ≥ 20 px/m).
- **Shadows:**
  - Cast only when `detail > 0 && band < 2` (zoom ≥ 5 px/m); never received (`receiveShadow = false`).
  - Each level casts with the coarsest LOD index whose error is under the cascade texel (`castCoarse` swaps the index during the shadow draw).
  - People are movers drawn into cascades 0–1 only (`maxCascade: 1`, `renderer.ts:1337`).
- **Notes:**
  - Every level mesh allocates a per-instance `citizenRow` buffer of 1000 floats regardless of its instance capacity (`:647`).
  - Setting a face sets `mesh.count = CAPACITY` so three allocates the morph texture for 1000 instances (`:189-193`).
  - Warm-up builds a temporary `InstancedMesh(…, 1)` per level form for compiling (`:686-718`).

#### 27. Rider helmet shape (only the constants live here)
- **Location:** `riderPoses.ts:328` (`HELMET_SEGMENTS = {width: 24, height: 16}`) and `helmetShape` (`:331-349`, an ellipsoid matrix). The geometry is built in `agents.ts:619`: `SphereGeometry(0.5, 24, 16)`.
- **Counts:** (24+1)(16+1) = **425 vertices / 720 triangles** (2·24·15).
- **Multiplicity:** one per helmeted two-wheeler rider (instanced in `agents.ts`, outside this chunk).
- **Notes:** 720 triangles for a helmet only a few pixels tall at most zooms. `helmetShape` and `headPoints` walk every skinned vertex of the body on the CPU once per body (`:358-376`), which is load-time work.

#### 28. Sun cascaded shadow maps (shadow-pass geometry multiplier, not geometry itself)
- **Location:** `sunCascades.ts`, `createSunCascades` (`:196-951`).
- **What it does to triangle counts:**
  - `SUN_CASCADES = 3`. Each cascade drawn whole re-draws every caster in it.
  - Each cascade keeps a **static store** (depth copy). Movers (people, vehicles, transit, wind-swayed plants) are drawn over a copy of the store.
  - Partial redraws: scrolled strips (`blitShift`, `stripsOfShift`) and patched strips (`rectsOf`, up to `MOST_STRIPS = 32`, union ≤ `UNION_MOST = 0.85` of the map) are drawn instead of whole passes.
  - Safety redraw every `SAFETY_FRAMES = 600` frames, staggered by 10.
  - Movers too small for a cascade's texel are skipped (`drawnIn`, `castersIn`).
  - `KEEP_CASCADES = 1`: cascade 0's cover box tells the layers to keep casters outside the view. A comment records that keeping cascade 1 too raised the district view from 21 to 27 M triangles.
  - Map sizes: near cascade at `shadowMapSize`, far cascades at half (minimum 512) (`:887`).
- **Shader:** cascade coordinates are computed per fragment, not per vertex (`CASCADE_PARS`). The comment says "the city's 15-20 M vertices a frame each paid three matrices", which states the measured vertex load.

#### 29. Shader catalogue stand-ins
- **Location:** `shaderCatalogue.ts:52-72` (`litStandIns`), `:114-147` (`compile`).
- **Counts:** one `compileCopy` (from `uploads.ts`) per distinct program key in the scene. These are copies of existing meshes, used only for compilation and cleared afterwards. No new geometry is built here.

---

### Budgets, caps and counters found

**Triangle and memory budgets**
- `VIEW_BUDGETS` (`core/perfBudget.ts:44-47`), applied in `renderer.ts:3511`:
  - street 16,000,000 triangles / 1,000 draw calls;
  - district 16,000,000 / 1,100;
  - map 8,000,000 / 400.
  - Buildings' `frame.budget` = view budget × `buildingChoices.triangles` × `quality.triangleScale`.
- `GEOMETRY_BUDGETS[tier]` (`quality.ts`, used in `renderer.ts:1354-1389`): `massesMB`, `roadsNearMB`, `roadsFarMB`, `viewCellsShare`, `totalMB`. `governGeometry` runs every `GOVERN_FRAMES = 60` frames: it reads `countMemory(scene).geometryBytes` and cuts the building detail budget when over `totalMB`.
- `quality.detailMemoryMB` sets the building detail budget (`renderer.ts:1349`).

**Triangle and draw-call counters**
- `RenderStats.builtTriangles`: built triangles = roads + structures + furniture + barriers + transit + `buildings.triangles` (`renderer.ts:198-216, 3042-3053`).
- `RenderStats.drawnTriangles` and `drawCalls`: `renderer.info.render` read right after the post chain (`renderer.ts:4003-4004`), with `info.autoReset = false`.
- Per-layer `triangles` getters:
  - `RoadSurfaces.triangles` (index.count/3 per block);
  - `StructureCells.triangles`;
  - `StructureDetails.triangles` (index count / 3 × instances, `structures.ts:678-683`);
  - `StreetFurnitureLayer.triangles`, plus `barriers.triangles` and `transit.triangles`.
- Signal counters: `group.userData.lamps` and `litLamps` (`signals.ts:606-610, 702`).
- Citizen counters (`userData`): `paletteBytes`, `animationBytes`, `loadedModels`, `clipFrames`, `lod`.

**Instance caps and pool sizes**
- Citizens: `CAPACITY = 1000` per body model; `LEVEL_START = 16` doubling; 6 parallel loads.
- Signal batches: start at 16 instances, doubling; one batch set per 768-m block.
- Sign plates: 64 quads, then ×1.5 + 512; sheet ≤ 2,176 px.
- Grid and road flash meshes: transient.

**Road tiling and caching**
- `TILE = 76.8 m`; `CHUNK = 8` tiles (614.4-m block meshes).
- `SHAPE_BATCH = 64`, `IN_FLIGHT = 3`, `MOST_LANES = 6` workers.
- Tile write ceiling 48 MB (page and worker).
- `ROAD_INPUT_RESIDENCY`: 48 MB CPU, 400 m reach.
- `FAR_ROAD_CELL = 614.4 m`.
- Opening solve: half-size 700 m + `OPENING_SOLVE_MARGIN` 320 m.
- `maxEdge` values: 3.2 m (ground on relief), 6.4 m (raised or flat map), 0.75 m (curb ramps), 5 m (paint).

**Ecosystem trees**
- `NATURE_TREES = 2,500` at full vegetation, scaled by `quality.vegetation / 2,600` (`renderer.ts:2685, 2770`).
- `NATURE_SPACING = WOODS_SPACING` grid.

**Lights**
- `ROOM_LIGHTS = 6` point lights plus 2 effect lights, kept in the scene and hidden unless lit, to keep the program variant stable.

**Shadows**
- `SUN_CASCADES = 3`, `SAFETY_FRAMES = 600`, `MOST_STRIPS = 32`, `UNION_MOST = 0.85`, `SCROLL_MOST = 0.5`, `KEEP_CASCADES = 1`.
- `shadowStats` counters: passes, whole, over, and why (refit, changed, effects, safety, noStore, scroll, patch, deferred, thrown, noBox, tooBig, tooBigNear), plus casters `unknown` and `widest`.

**Render target bytes**
- `targetBytes.ts`: `renderTargetBytes`, `renderTargetsBytes` and `liveTargets` (memory estimate, not geometry). Fed to `gpuLedger` as "render targets" and "shadow maps".

**Size thresholds and LOD switches**
- `PROP_FAR_PX = 12`: below it a small prop becomes a 12-triangle box.
- Plant pictures switch at `PICTURE_PX`.
- `PLANT_MAP_ZOOM = 2.5 px/m` drops leaf cards; `PLANT_NEAR_ZOOM = 3.5 px/m`.
- Citizens: `citizenBandAt` thresholds at 20, 5 and 3 px/m.

---

### Files without geometry

Under `src/render/`:
- `revealGate.ts`: opening curtain state machine.
- `roadStations.ts`, `roadStations.worker.ts`: ground heights read under roads, off the page.
- `roadSurfaceEntries.ts`: tile keys, entry filing and constants (`TILE`, `TILE_ORIGIN`, residency). These are CPU input data, not GPU geometry.
- `roadSurfaceInputs.ts`: filing of CPU input polygons (rings, paint quads) per tile and pass. It feeds element 8 but makes no GPU buffers.
- `roadSurfaceRings.ts`: input ring digests and median strip polygons (CPU).
- `roadSurfacePass.ts`, `roadSurfaceReads.ts`, `roadTileShape.ts`, `roadTileMesh.ts`, `roadTilePool.ts`, `roadTile.worker.ts`: the road tile pipeline (described under element 8). The actual vertex arrays are produced by `mesh/tileMesh.ts`, outside this chunk.
- `roadTones.ts`: colour constants.
- `roadsRead.ts`: memo helper.
- `roomLamps.ts`: room light positions.
- `screenSize.ts`: drawing buffer sizing.
- `shadowCasters.ts`: per-cascade `castShadow` toggling by size (geometry-related policy, no geometry).
- `sharedGround.ts`: shared-memory ground heights for workers.
- `stagedTexels.ts`: texture texel staging.
- `stillTree.ts`: matrix update policy.
- `surfaceBakeClient.ts`, `surfaceTextures.ts`: KTX2 texture loading and texel release.
- `targetBytes.ts`: render target byte estimates.
- `sunCascades.ts`: shadow maps and shader chunks only (a pass multiplier; see element 28).
- `shaderCatalogue.ts`: compile-only copies (element 29).

---

## Polygon geometry audit, chunk g08

### Files read

Every file was read completely, from the first line to the last. Long files were read in sequential parts: terrain.ts as 1-700, 700-1399, 1400-2149 and 2150-2855; vehicleModels.ts as 1-650 and 650-1246.

| File | Lines |
|---|---|
| src/render/terrain.ts | 2854 |
| src/render/terrainGrid.ts | 12 |
| src/render/terrainLevels.ts | 161 |
| src/render/terrainLight.worker.ts | 24 |
| src/render/terrainLightCompute.ts | 96 |
| src/render/terrainLightPool.ts | 78 |
| src/render/terrainLod.ts | 311 |
| src/render/terrainShaping.ts | 94 |
| src/render/torusWindow.ts | 62 |
| src/render/transit.ts | 568 |
| src/render/uploads.ts | 664 |
| src/render/utilities.ts | 588 |
| src/render/vehicleFrame.ts | 75 |
| src/render/vehicleLevels.ts | 82 |
| src/render/vehicleModels.ts | 1245 |
| src/render/vehiclePanels.ts | 139 |
| src/render/vehicleWindows.ts | 53 |
| src/render/water.ts | 405 |
| src/render/wear.ts | 187 |
| src/render/wind.ts | 209 |
| src/render/woodsBase.ts | 78 |
| src/sim/agents/bay.ts | 44 |
| src/sim/agents/buildingOrder.ts | 252 |
| src/sim/agents/hybridAStar.ts | 474 |
| src/sim/agents/kerbBays.ts | 387 |
| src/sim/agents/laneGrid.ts | 192 |
| src/sim/agents/lorryDocks.ts | 558 |
| src/sim/agents/lorryTraffic.ts | 483 |
| src/sim/agents/lotBays.ts | 519 |
| src/sim/agents/lotDoors.ts | 126 |
| src/sim/agents/lotNav.ts | 318 |
| src/sim/agents/lotTraffic.ts | 739 |
| src/sim/agents/manoeuvre.ts | 252 |
| src/sim/agents/parking.ts | 484 |
| src/sim/agents/reedsShepp.ts | 271 |
| src/sim/agents/trafficBuildings.ts | 746 |
| **Total (wc -l)** | **13,830** |

The table uses `wc -l` counts. The Read tool shows one more line where a file ends without a final newline.

To resolve numbers, I followed these imports outside the chunk using Grep only:
- `@world/bounds` PLATE_SIZE = m(2048)
- `@world/utilities`: POLE_HEIGHT = 8.5 m, POLE_TOP_RADIUS = 0.11 m, POLE_BASE_RADIUS = 0.18 m, WIRE_COURSES = 3 courses, WIRE_OFFSETS = 3 offsets, WIRE_SEGMENTS = 8
- `partLevelsWork.ts` LEVEL_ERRORS = [0.0125, 0.025, 0.05, 0.1, 0.2, 0.4]
- `quality.ts` VEHICLE_ERROR_PIXELS = 0.5
- `flatAtlas.ts`: FAR_QUADS = 32, and the slabGeometry call at line 296
- `wholeMap.ts` MAP_TILES = 18 and `tiles.ts` TILE = 1024 m, so MAP_HALF = 9216 m
- callers of `fullScreenTriangle` (postprocess.ts:221, 247, 273, 366) and of `wireLevel` (poleLayer.ts:423)

`instanceRuns.ts` (transit runs), `scenery.ts` (lamp pool and beam shapes), `carBody.ts` (car bodies) and `interiorSolids.ts` are outside this chunk and were not opened.

Mesh formulas follow three.js r186. I did not open them in node_modules; I used the formulas given in the brief, and they are consistent with the code's own comments. In particular, `mastShape` relies on the cylinder's group order (side, top, base).

---

### Elements

#### E1. Terrain plate ground: CDLOD patches (the main ground mesh)
- **Location:** `src/render/terrainLod.ts:35` `patchCells()`, used by `LandLod` (`terrainLod.ts:160-193`) and selected per frame by `LandLod.select` (`:196`). The mesh is built in `src/render/terrain.ts:1364-1386` (`createTerrainSurface`, `patchMesh(lod.geometry, 'terrain-ground')`).
- **Primitive:** triangles, non-indexed `InstancedBufferGeometry`.
  - The vertex shader pulls everything (`lodVertexGlsl`, `terrainLod.ts:64-119`). `position` is not a position: it holds (cell x, cell y, role 0-5).
  - The shader reads heights and normals with `texelFetch` from the plate's RGBA32F `uLand` texture, which is 321×321.
  - The shader picks the diagonal per cell (roles 2 and 3 swap). It morphs odd corners with Strugar's geomorphing.
- **Counts per instance (one patch):**
  - LOD_PATCH = 10 cells a side, so 10×10 cells × 6 vertices = **600 vertices and 200 triangles**.
  - Every cell is two unshared triangles: no index, no vertex reuse. Each vertex runs four `landCorner` calls, and each does a `texelFetch` and possibly a morph fetch. So a cell computes 6 × 4 = 24 corner evaluations for 4 unique corners.
- **Attributes:**
  - `position`: Uint8 ×3 = 3 B/vertex, shared template of 1.8 kB (each plate holds its own copy).
  - `aLodPatch`: Float32 ×4 = 16 B per instance (x, y, step, level), DynamicDrawUsage. Only a dirty range is re-uploaded.
- **Multiplicity:**
  - One draw call per plate for the ground.
  - Instance cap: (320/10)² = **1024 patches a plate**.
  - Five levels (LOD_LEVELS = 5; nodes are 20 cells at level 0, and each level doubles). A patch at level L covers 10·2^L cells.
  - **Full resolution of a whole plate:** TERRAIN_SEGMENTS = 320 cells/side × 6.4 m, so 320² × 2 = **204,800 triangles** (1024 patches).
  - **Coarsest:** level 4 is 4 patches for the plate, **800 triangles**.
  - Level switches are not fixed distances. `ranges()` (`terrainLod.ts:221-257`) derives each level's reach from the measured worst error per level (`LandLevels.worst`) at a 1-pixel threshold (LOD_PIXELS = 1), plus the node diagonal and a LOD_MARGIN of 1 m.
  - An orthographic camera uses one level for the whole plate.
  - Selection culls node by node against the frustum, using boxes whose height comes from the stored lo/hi values.
  - Plates drawn: up to 9 near plates and 9 kept plates by default (`setPlates`, note in `terrain.ts:201`), with fewer on lower tiers.
- **Shadows:** `castShadow = false`, `receiveShadow = true` (`terrain.ts:1373-1375`), so the ground adds no triangles to the shadow passes.
- **Notable:**
  - Unindexed 6 vertices per cell where 4 would do. On top of that, each vertex recomputes all 4 cell corners in the shader, so the vertex shader does about 6× redundant fetch work.
  - `renderOrder = GROUND_AFTER (10)`, so the ground is drawn after the town for early-Z.
  - The fragment shader recomputes the full-resolution height and normal per pixel (`lodFragmentGlsl`). The splat shader is heavy: triplanar rock with up to 3 geologies, flowers, shore and paint.

#### E2. Terrain plate rim/skirt patches
- **Location:** `terrainLod.ts:43` `patchRim()`; mesh `terrain.ts:1386` (`'terrain-rim'`).
- **Primitive:** triangles, non-indexed, instanced, vertex-pulled (roles 6-13).
- **Counts per instance:** 4 sides × 10 edge segments × 12 vertices = **480 vertices and 160 triangles**. Each segment is drawn both ways round, which gives 4 triangles per segment.
- **Attributes:** Uint8 ×3 template (1.4 kB) plus Float32 ×4 instance data.
- **Multiplicity:**
  - Cap: 4·320/10 = **128 rim instances a plate**. One instance is added per selected patch touching a plate edge whose skirt is on (all four edges are on, `terrain.ts:1364`).
  - One draw per plate. The skirt drops LOD_SKIRT = 30 m.
- **Notable:**
  - Every rim instance draws all 4 sides (160 triangles), but only the sides on the plate border hang. The other sides keep top equal to bottom, so they are zero-area triangles.
  - Even on a border side, the strip is drawn double-sided (both windings).
  - So a typical corner patch wastes at least 120 of its 160 triangles. This is cheap in absolute terms (at most 128 × 160 = 20,480 triangles a plate) but avoidable.

#### E3. Map slab (cut sides of the whole map)
- **Location:** `terrain.ts:1159` `slabGeometry()`, called from `flatAtlas.ts:296` with step = PLATE_SIZE / FAR_QUADS = 64 m around MAP_HALF = 9216 m.
- **Primitive:** triangles, non-indexed `BufferGeometry` (positions pushed per triangle corner).
- **Counts:**
  - Per side: n = round(length / step) segments. Each segment has 2 bands (turf/topsoil, then down to the floor), each a quad of 2 triangles and 6 vertices. That is 4 triangles and 12 vertices per segment.
  - Formula: triangles = 4·Σn and vertices = 12·Σn.
  - With the values used: side 18,432 m / 64 = 288 segments, × 4 sides = 1152 segments, so **4,608 triangles and 13,824 vertices**.
- **Attributes:** position 3f, normal 3f, uv 2f, color 3f, aBelow 1f = 12 floats = **48 B/vertex**. That is about 663 kB of vertex data, unindexed.
- **Material:** `wallMaterial()` (`terrain.ts:1220`). Its fragment shader is heavy (Voronoi 3×3 and many noises).
- **Multiplicity:** one mesh for the whole map. Shadow flags are set by the caller (not in this chunk).
- **Notable:** unindexed. Indexed, it would be about 4 vertices per quad instead of 6.

#### E4. River and lake water surface (unified water geometry)
- **Location:** `terrain.ts:2580` `unifiedWaterGeometry()`, helpers `pushTriangle` (`:2796`), `pushWetTriangle` (`:2807`), `riverRibbon` (`:2718`). Rebuilt in `rebuildWater` (`:1848`). The mesh is `terrain.ts:1441` (`'terrain-water'`), one per plate.
- **Primitive:** triangles, non-indexed.
- **Counts:** generated per water body. WATER_CELL = 1.6 m grid.
  - Interior cell (4 wet corners and a wet centre): **2 triangles, 6 vertices**.
  - Shore cell: 4 wedges (cell edge to centre), each clipped by `pushWetTriangle` to a polygon of up to 4 points. That is **up to 8 triangles (24 vertices)** per shore cell. Edges are found by an 8-step bisection against the ground sampler.
  - River ribbon: rows every RIBBON_STEP ≤ 2.4 m along a Catmull-Rom curve, with RIBBON_ACROSS = 6 strips. Per row interval: 6 quads × 2 triangles × 3 vertices = **12 triangles and 36 vertices**, minus quads skipped where the water is shallower than 0.75.
  - Example: a 1 km river is about 417 rows, so about 5,000 triangles.
  - A flood fill (`floodBasins`) can add up to MAX_FLOOD_CELLS = 40,000 cells per body, about 80,000 triangles if all interior.
- **Attributes:** position 3f, aDepth 1f, aFlow 2f, uv 2f, normal 3f = 11 floats = **44 B/vertex**.
- **Material:** `createWaterSurface` (`water.ts:163`): MeshStandardMaterial, transparent, FrontSide.
- **Multiplicity:**
  - One mesh per plate, hidden when the plate has no water.
  - `castShadow = false`, `receiveShadow = false`.
  - Rebuilt whole when the land moves near water (not per frame). Shore levels are worked out off the page.
- **Notable:**
  - Unindexed: neighbouring cells duplicate every shared vertex.
  - The normal attribute is constant (0, 1, 0) for every vertex, a 12 B/vertex array that could be a constant.

#### E5. Far land material (no geometry here)
- **Location:** `terrain.ts:495` `farLandMaterial`. Material only, used by the far patches in `flatAtlas.ts` (outside this chunk).
- **Notable:** its shore textures are 2×2, so no geometry is made here.

#### E6. Verge material
- **Location:** `terrain.ts:2015`.
- **Notable:** a material clone used by road batters (`roadSurfaces.ts`, outside this chunk). It is not geometry.

#### E7. Transit track and stop boxes (instance runs)
- **Location:** `transit.ts:331` `unit = new BoxGeometry(1, 1, 1)`. Boxes come from `trackBoxes` (`:57`) and `stopParts` (`:112`), and are turned into runs by `TransitProduct.compute` (`:271`) through `createInstanceRuns` (`instanceRuns.ts`, outside this chunk). Stores are defined at `:336-359`.
- **Primitive:** triangles, indexed, **24 vertices / 12 triangles per box** (BoxGeometry 1×1×1: position, normal, uv; Uint16 index).
- **Multiplicity:**
  - **Track (train), per 4 m piece (PIECE):** 1 ballast + about 5-6 sleepers (SLEEPER_STEP = 0.7 m) + 2 rails = 8-9 boxes. That is about 100-108 triangles per 4 m, about **26 triangles per metre of track**.
  - Level crossings drop the ballast and sleepers: 2 rails only.
  - **Metro track:** adds 3 tunnel boxes and 1 roof box per piece, all on the x-ray layer, so about 12-13 boxes per 4 m.
  - **Train station:** 13 boxes (156 triangles).
  - **Metro stop:** 4 visible boxes and 7 x-ray boxes.
  - **Bus stop:** 6 boxes (72 triangles).
  - 9 visible stores, which cast and receive shadows (`castShadow: true`). The 6 x-ray stores do not cast; they draw through the ground, are transparent, and use renderOrder 20+.
  - Culling uses a cell size of m(8) in `createInstanceRuns`. The stat is `triangles = boxes * 12` (`transit.ts:396`).
- **Notable:** sleepers dominate the count. They are separate 12-triangle boxes every 0.7 m, and all are shadow casters.

#### E8. Train cars
- **Location:** `transit.ts:382` `new InstancedMesh(unit, ..., MAX_CARS)`.
- **Primitive and counts:** a box of 24 vertices and 12 triangles per car.
- **Multiplicity:**
  - Cap **MAX_CARS = 256**, so at most **3,072 triangles**.
  - instanceColor is 3 floats per car.
  - Casts shadows. `frustumCulled = false`; cars are culled on the CPU by a sphere test per car each frame.
  - Matrices are written every frame for the visible cars only, with an update range.

#### E9. Track preview (track tool)
- **Location:** `transit.ts:505` `createTrackPreview`. There are 5 InstancedMesh layers of the same unit box (`PREVIEW_LAYERS`, `:496`).
- **Multiplicity:** initial cap 16 instances per layer, doubled on demand (a new mesh each time). Matrices are rewritten each time the preview is set.
- **Notable:** also built once for the shader warm-up (`buildTrackPreview`, `:563`).

#### E10. Fullscreen post-process triangle
- **Location:** `uploads.ts:659` `fullScreenTriangle()`. Used by `postprocess.ts:221/247/273/366`.
- **Counts:** non-indexed, **3 vertices, 1 triangle**.
- **Attributes:** position 3f + uv 2f = 20 B/vertex.

#### E11. Warm-up and compile copies (not drawn on screen, but they do draw triangles)
- **`warmLoose`** (`uploads.ts:622`): renders each queued mesh once into a 1×1 WebGLRenderTarget with an override MeshBasicMaterial, to upload its buffers ahead of time.
  - This runs every vertex of the mesh (all instances of an InstancedMesh) once.
  - Budget: UPLOAD_BYTES = 4 MiB per frame of buffers (`:594`).
  - Queue ceiling: WARM_CEILING = 64 MiB (`:412`).
- **`compileCopy` / `shadowStandIn`** (`uploads.ts:130`, `:75`): clones meshes (an InstancedMesh copy with count 1) only to compile programs. No new geometry.

#### E12. Utility pole parts (instanced, levels by screen error)
- **Location:** `utilities.ts:478` `madeUtilityParts()` and `polePartSpecs` (`:122`). Placement is `placePole` (`:154`) and `writePlacement` (`:240`). The instancing layer itself is in `poleLayer.ts` (outside this chunk).
- **Shapes** (per instance, indexed, Uint16 index; position, normal, uv):
  - **Mast** (`mastShape`, `:510`): CylinderGeometry(rt, rb, 8.5 m, sides). The base cap's indices are cut, but its vertices are kept. Three levels by screen error, error = max(R−r, r−R·cos(π/n)):
    - 12 sides: 76 vertices (13 unused), **36 triangles** (24 side + 12 top)
    - 6 sides: 40 vertices (7 unused), **18 triangles**
    - 3 sides: 22 vertices (4 unused), **9 triangles**
  - **Cap** (`:500`): Cylinder 10 segments, **64 vertices / 40 triangles**.
  - **Insulator** (`:501`): Cylinder 10 segments, **64 vertices / 40 triangles**.
  - **Transformer can** (`:502`): Cylinder 14 segments, **88 vertices / 56 triangles**.
  - **Box** (`:503`): used by arms, braces, lamp arms and lamp heads, **24 vertices / 12 triangles**.
  - **Lens** (`:505`): PlaneGeometry(1, 1) rotated, **4 vertices / 2 triangles**.
  - **Lamp pool and beam:** `kit.pool` and `kit.beam` from scenery.ts (outside this chunk; counts not resolved here).
- **Per pole** (with A cross-arms, 3 insulators per arm, 2 braces per arm):
  - mast 36 + cap 40 + A·(12 arm + 3·40 insulators + 2·12 braces) + [can 56 on 1 pole in 5] + [lamp: 12 arm + 12 head + 2 lens + pool + beam].
  - One-arm pole with no lamp: 36 + 40 + 156 = **232 triangles**, of which **120 are insulators**.
  - One-arm pole with a lamp: about **258 triangles + pool + beam**.
- **Shadows:**
  - Solid parts cast and receive. That includes the 40-triangle insulators and 40-triangle caps, both tiny.
  - Pools and beams: no shadow (glows).
  - Lens: receives only.
- **Notable:**
  - The insulators (40 triangles each, 3 per arm) and the cap (40 triangles) outweigh the mast and have no coarser levels. Only the mast has levels.
  - The mast keeps the unused base-cap vertices in its attribute arrays.

#### E13. Overhead wires (instanced template, LOD by pixel width)
- **Location:** templates `tubeTemplate` (`utilities.ts:290`) and `stripTemplate` (`:313`), list `WIRE_TEMPLATES` (`:327`). Level picked by `wireLevel` (`:330`), geometry from `wireGeometry` (`:343`).
- **Primitive:** triangles, indexed (Uint16), InstancedBufferGeometry. The vertex shader bends the template along each wire (`WIRE_GLSL`, `:367`): vertex pulling from `aStart`, `aEnd` and `aSagPhase`.
- **Counts per wire instance:**

  | Level | Shape | Vertices | Triangles |
  |---|---|---|---|
  | 0 | tube, WIRE_SEGMENTS = 8 × 4 faces × 4 vertices | 128 | 64 |
  | 1 | strip of 8 chords | 18 | 16 |
  | 2 | strip of 4 chords | 10 | 8 |
  | 3 | strip of 2 chords | 6 | 4 |
  | 4 | strip of 1 chord | 4 | 2 |
  | −1 | faded out (WIRE_FADE 1/32 px) | 0 | 0 |

- **Attributes:**
  - Template: position 3f + normal 3f = 24 B/vertex. Strip normals are an all-zero array that the shader never reads.
  - Instance: interleaved 8 floats = **32 B per wire**.
- **Multiplicity:**
  - **SPAN_WIRES = 9 wires per span** (3 courses × 3 offsets). A tube-level span is **576 triangles**.
  - One draw per cell and level.
  - Shadow: a depth material (`wireMaterials`, `:418`) at rest, without wind. It uses `RGBADepthPacking` with `colorWrite: false`.
- **Notable:** the tube is drawn when a wire is at least 1.5 px wide (WIRE_TUBE_PIXELS). It is DoubleSide, so back faces of the 4-sided tube are shaded too.

#### E14. Vehicle part levels (meshopt simplification)
- **Location:** `vehicleLevels.ts:37` `partLevels()`.
- **What it does:** each source part gets LEVELS = 7 levels: the source plus 6 simplified ones within LEVEL_ERRORS of 0.0125, 0.025, 0.05, 0.1, 0.2 and 0.4 (part units, metres).
  - The levels are built in a worker pool (`lodPool`) or on the page (`partLevelArrays`, outside this chunk).
  - `levelFor` picks the coarsest level whose error × pixels per unit ≤ ERROR_PIXELS = 0.5 px.
  - A level that sheds fewer than SHED = 64 triangles per vehicle (× copies, for example 4 tyres) is replaced by the finer level, to save draw calls.
  - Attributes: position, color, normal; shared vertex buffers between levels where the worker says so (`made.shared`).
- **Counts:** depend on the source parts (E16-E21). Triangle counting uses `index.count / 3` (`trianglesOf`).

#### E15. Joined body and panel geometry (one draw for body and roof or accent)
- **Location:** `vehiclePanels.ts:53` `createPanelJoiner`, `:115` `panelGeometry`, `:124` `panelPaint`.
- **Primitive:** indexed with a **Uint32 index** (`:99`), even when the joined part fits in 16 bits.
- **Attributes:** position, color, normal, a `panel` Float32 flag per vertex (4 B/vertex), and an instanced `panelColor`.
- **Counts:** body triangles + panel triangles. Nothing is added; the parts are concatenated.
- **Notable:** a Uint32 index where Uint16 would do for parts under 65,536 vertices doubles the index bytes.

#### E16. Car glazing with lowerable windows
- **Location:** `vehicleWindows.ts:27` `windowGlass` (merges the fixed glass and each door's pane) and `:40` `windowGlassMaterial` (squashes panes in the vertex shader per instance `windowDrop`, 2 floats per instance).
- **Counts:** the sum of the source glass parts (car bodies come from carBody.ts, outside this chunk). Before this, it was five draws per body style at full detail.

#### E17. Wheel and tyre templates (vehicleModels.ts)
- **`tyreGeometry`** (`:491`): LatheGeometry of 9 profile points × 16 segments, so (16+1)·9 = **153 vertices and 16·8·2 = 256 triangles**, indexed.
- **`rimGeometry`** (`:507`):
  - parts: Cylinder 14 segments (88 vertices / 56 triangles), 5 spoke boxes (120 vertices / 60 triangles), hub Cylinder 8 (52 vertices / 32 triangles)
  - before weld: 260 vertices, **148 triangles**
  - `merge()` welds vertices that are equal in position, normal and colour; the triangle count stays 148
- **`spokedRimGeometry`** (`:521`, bicycle):
  - parts: Torus(0.43, 0.025, 4, 24) (125 vertices / 192 triangles), Cylinder 8 (52 / 32), 16 spoke boxes (384 vertices / 192 triangles)
  - total **416 triangles** for a bicycle wheel; the 16 spokes are 8 mm boxes
- **`steeringWheel`** (`:459`): Torus(r, 0.022, 6, 20) (147 vertices / 240 triangles) + 3 spoke boxes (36 triangles) + Cylinder 10 (64 vertices / 40 triangles) = **316 triangles**.
- **`farWheels`** (`:482`): one dark box across the car per axle, **12 triangles per axle**. The comment there records that this replaced 2 × 32-triangle cylinders and saved millions of triangles in a city view.

#### E18. Two-wheelers (motorcycle and bicycle models)
- **Location:** `vehicleModels.ts:593` `motorcycleModel` and `:664` `bicycleModel`, outputs body, trim, steering and cranks (merged).
- **Pieces:**
  - Extrusions (`extrude`, `:284`): ExtrudeGeometry with bevel. Formula for an n-point straight-edged shape with b bevel segments: sides 2n(2b+1) triangles, caps 2(n−2) triangles. Non-indexed before `merge()` welds it.
    - Example: the motorcycle tank (6 points, bevel segments 3) is 2·6·7 + 8 = **92 triangles**.
  - Boxes (`strut`, `bar`, `box`): 12 triangles each.
  - Cylinders: footpegs 6 segments (24 triangles), exhaust 10 segments (40 triangles), grips 8 segments (32 triangles), chainring 14 segments (56 triangles).
- **Rough totals (excluding wheels):**
  - motorcycle: about 4 extrusions of 70-100 triangles, about 20 boxes and 6 cylinders, roughly **700-900 triangles**
  - bicycle: about 15 boxes, 1 extrusion and cylinders, roughly **400 triangles**
  - plus 2 tyres (E17), 2 rims or spoked rims
- **Multiplicity:** per archetype, built once. LOD levels via E14.

#### E19. City bus model
- **Location:** `vehicleModels.ts:735` `buildBusModel`.
- **Pieces:**
  - Side walls: `extrude` of the wall outline. That outline includes 17 arc points per axle × 3 axles, so about 55-60 points. With bevel segments 2 this is about **590 side + about 115 cap triangles, about 700 triangles per wall run**. There are 4 wall runs: 1 left, 3 between the doors on the right. This is the largest part of the shell.
  - Window band: bays = max(5, round((L−1.5)/1.4)), so 8 for a 12 m bus.
  - Pillar boxes: 12 triangles each.
  - Each glass bay is `twoSided`: 2 quads = 4 triangles.
  - Roof extrude: 6 points, bevel 3, curveSegments 6, about 92 triangles.
  - Doors: 2 doors × 2 leaves × (5 boxes + 4-triangle pane).
- **Interior (`CabinParts`):**
  - Passenger seats (`busSeat`): extrude (8 points, bevel 2: 80 + 12 = **92 triangles**) + 2 bolsters + pedestal + grab bar, about **140 triangles per seat**, about 30 seats.
  - Stanchions: Cylinder 6 segments, 24 triangles each.
  - About 5,000 triangles of interior.
- **Far proxy (`far`, `:1000`):** 2 boxes + roof extrude without bevel (6 points: 12 sides + 8 caps = 20 triangles) + 3 axle boxes, about **80 triangles**.
- **Notable:** many separate `merge()` copies are kept: shell/openShell, glass/openGlass, interior/openInterior (the same object for the bus). The closed variants are clones plus door parts, so the vertex data is duplicated in memory for the open and closed states.

#### E20. Rigid truck model
- **Location:** `vehicleModels.ts:1054` `buildTruckModel`.
- **Pieces:**
  - Cab rounded slabs: `roundedSlab` is a 16-point outline with quadratic corners at 3 segments, no bevel, so 16·2 + 2·14 = **60 triangles**.
  - Small extrudes: 4 points, bevel 1, 4·2·3 + 4 = **28 triangles** each.
  - Mudguards: `archOutline` has 22 points; extrude bevel 1 gives 22·2·3 + 2·20 = **172 triangles**. There are 2 front + 2 rear.
  - Box body extrude: 4 points, bevel 1, 28 triangles.
  - Fuel tank: Cylinder 12 segments (48 triangles).
  - Seats: 2 × about 128 triangles.
  - Steering wheel: 316 triangles.
  - Total about 2,000-2,500 triangles before simplification.
- **Far proxy:** 4 boxes + 3 axle boxes + an unbevelled box-body extrude (12 triangles), about **96 triangles**.

#### E21. Seat, headrest and other cabin helpers (shared by bus and truck; car bodies are in carBody.ts)
- **`seatShell`** (`:415`): extrude of 8 points with bevel 2 (92 triangles) + 2 bolster bars (24) + runner box (12), about **128 triangles**.
- **`headrest`** (`:450`): roundedSlab (about 60 triangles) + 2 post boxes (24), about **84 triangles**.
- **`loft`** (`:376`): indexed, stations × (across+1) vertices, 2·across triangles per station interval. The windscreens use 2 stations × 6 across, so 14 vertices and 12 triangles.
- **`polygon` / `twoSided`** (`:342`, `:368`): triangulated with `ShapeUtils`, non-indexed then welded. A quad pane two-sided is 4 triangles.
- **`merge`/`weldPart`** (`:221-244`): every part is welded on position, normal and colour (`weldGeometry`) and merged with `mergeGeometries`. A part without normals goes through `toNonIndexed()` and `computeVertexNormals()` first.

#### E22. Wind and sway vertex deformation (shader-side geometry transform)
- **Location:** `wind.ts:42-62` `windOffset`, applied to instanced foliage. `applyStructureSway` / `applyPartSway` (`:161-209`) move vertices of signal posts. `wireWindGlsl` (`:151`) moves wires.
- **Counts:** no new triangles. Every vertex of a swaying mesh is recomputed every frame.
- **Shadows:** `markSway` (`:103`) flags these materials. The sun cascades must redraw them every frame instead of caching them (the "movers" in sunCascades.ts).
- **Notable:**
  - `windDepthMaterial` (`:125`) gives the swaying casters a depth twin that sways too, so these triangles are re-drawn in every shadow cascade every frame.
  - Wires use a static depth material (E13), so wires are not movers through their depth material.

#### E23. Wear field (not geometry)
- **Location:** `wear.ts`: an RG8 2048² texture window (`WEAR_RES`, 5 m texels) and a fragment shader patch on road materials.
- **Notable:** no geometry. Listed only because it shades every road pixel.

---

### Budgets, caps and counters found
- `TERRAIN_SEGMENTS = 320` cells per plate side (`terrainGrid.ts:8`), TERRAIN_CELL = 6.4 m, so a plate at full detail is 204,800 triangles.
- `LOD_PATCH = 10`, `LOD_LEVELS = 5`, `LOD_NODE = 20` (`terrainLevels.ts:6-10`).
  - Patch instance cap = 1024 per plate; rim cap = 128 per plate (`terrainLod.ts:182-184`).
  - `LOD_PIXELS = 1`, `LOD_MARGIN = 1 m`, `LOD_SKIRT = 30 m` (`terrainLod.ts:21-25`).
  - The worst error per level is kept in `LandLevels.worst`.
- Terrain `gpuBytes()` (`terrain.ts:2305`): texture bytes + `geometryCost()` of patches, rim and water (`gpuLedger.ts`).
- `PAINT_RES = 1024`, `PAINT_LAYERS = 3` (texture memory, not geometry).
- Water: `WATER_CELL = 1.6 m`, `MAX_FLOOD_CELLS = 40,000`, `SHORE_BAND = 6`, `RIBBON_STEP = 2.4 m`, `RIBBON_ACROSS = 6`.
- Slab: step = PLATE_SIZE / FAR_QUADS (32) = 64 m.
- Transit: `MAX_CARS = 256` (`transit.ts:50`); the `triangles` getter is boxes × 12 (`:396`); preview cap starts at 16 per layer and doubles.
- Wires: `SPAN_WIRES = 9`, `WIRE_STRIDE = 8` floats, 5 templates, `WIRE_TUBE_PIXELS = 1.5`, `WIRE_FADE = [1/8, 1/32] px`.
- Pole parts: `POLE_PART_COUNT = 11`; mast levels [12, 6, 3] sides with error-based selection.
- Vehicles:
  - `LEVELS = 7` (source + 6 LEVEL_ERRORS), `ERROR_PIXELS = VEHICLE_ERROR_PIXELS = 0.5`, `SHED = 64` triangles per vehicle (`vehicleLevels.ts:12-18`).
  - The far proxy is under 9 px long (`FAR_BODY_ZOOM`, comment `vehicleModels.ts:483`).
- Upload pacing: `UPLOAD_BYTES = 4 MiB` per frame, `WARM_CEILING = 64 MiB`, `COMPILE_GIVE_UP_MS = 10 s` (`uploads.ts`).
- `meshBytes()` (`uploads.ts:468`) counts the GPU bytes of attributes, index and instance buffers.
- DEV-only program stats: `window.__compileLog`, `__programSamples`, `__programsTable` (`uploads.ts:154-204`).

### Files without geometry
- **src/render:**
  - `terrainGrid.ts`: constants only
  - `terrainLevels.ts`: LOD error measurement, CPU data only
  - `terrainLight.worker.ts`, `terrainLightCompute.ts`, `terrainLightPool.ts`: per-corner slope bytes
  - `terrainShaping.ts`: corner shaping and sampling
  - `torusWindow.ts`: toroidal texture window maths
  - `vehicleFrame.ts`: road pitch and roll for a vehicle
  - `wear.ts`: texture and shader patch only
  - `woodsBase.ts`: tree density field
  - `water.ts`: material and texture only; its geometry is built in terrain.ts (E4)
  - `wind.ts`: shader vertex displacement only, no geometry built (E22)
- **src/sim/agents:** all 15 files contain no rendering geometry. They are simulation code: grids, A*/Reeds-Shepp planning, bay layout, lane grids, traffic tables.
  - `bay.ts`, `buildingOrder.ts`, `hybridAStar.ts`, `kerbBays.ts`, `laneGrid.ts`
  - `lorryDocks.ts`, `lorryTraffic.ts`, `lotBays.ts`, `lotDoors.ts`, `lotNav.ts`
  - `lotTraffic.ts`, `manoeuvre.ts`, `parking.ts`, `reedsShepp.ts`, `trafficBuildings.ts`
  - Some of them build occupancy grids (for example a lorry yard at 0.1 m cells), which matter for CPU and memory but not for GPU polygons.

---

## Polygon geometry audit - chunk g09 (src/sim/**)

### Files read
All files were read completely, first line to last (walk.ts in 5 sequential chunks, ambient.ts in 2, simClient.ts in 2, admission.ts in 2, meso.ts in 2). No file outside the list was opened.

| Lines | File |
|---|---|
| 2275 | src/sim/agents/walk.ts |
| 999 | src/sim/ambient/ambient.ts |
| 401 | src/sim/ambient/ambientIndex.ts |
| 62 | src/sim/ambient/demand.ts |
| 391 | src/sim/ambient/lotPlaces.ts |
| 2 | src/sim/ambient/playerId.ts |
| 41 | src/sim/audit.ts |
| 42 | src/sim/city/city.ts |
| 65 | src/sim/clock.ts |
| 171 | src/sim/crossings/permission.ts |
| 35 | src/sim/crossings/state.ts |
| 68 | src/sim/drive/operational.ts |
| 20 | src/sim/drive/physicalMotion.ts |
| 147 | src/sim/drive/tactical.ts |
| 2 | src/sim/dt.ts |
| 128 | src/sim/host/fleetGrid.ts |
| 188 | src/sim/host/protocol.ts |
| 102 | src/sim/host/simAnswers.ts |
| 796 | src/sim/host/simClient.ts |
| 465 | src/sim/host/simHost.ts |
| 1139 | src/sim/intersections/admission.ts |
| 208 | src/sim/intersections/claims.ts |
| 240 | src/sim/intersections/crossingSpans.ts |
| 260 | src/sim/intersections/cycles.ts |
| 93 | src/sim/intersections/spillback.ts |
| 361 | src/sim/invariants.ts |
| 117 | src/sim/meso/demand.ts |
| 170 | src/sim/meso/memory.ts |
| 798 | src/sim/meso/meso.ts |
| 630 | src/sim/meso/model.ts |
| 226 | src/sim/meso/slots.ts |
| 8 | src/sim/meso/tileLinks.ts |
| 137 | src/sim/params.ts |
| 308 | src/sim/peds/sidewalk.ts |
| 105 | src/sim/peds/signalPostIndex.ts |
| 75 | src/sim/people/casualties.ts |
| 79 | src/sim/people/engine.ts |
| 115 | src/sim/people/view.ts |
| 452 | src/sim/pipeline.ts |
| 77 | src/sim/populationGovernor.ts |
| 214 | src/sim/pose.ts |
| 65 | src/sim/roads/controlAdvisor.ts |
| 97 | src/sim/roads/flowStats.ts |
| 87 | src/sim/roads/greenWave.ts |
| 76 | src/sim/routing/destination.ts |
| 374 | src/sim/routing/laneReach.ts |
| 41 | src/sim/routing/lowerBound.ts |
| 73 | src/sim/routing/routeIndex.ts |
| 402 | src/sim/routing/router.ts |
| 231 | src/sim/routing/searchScratch.ts |

Total: 50 files, 14,075 lines (sum of the per-file counts above).

### Elements
This chunk is the simulation layer (src/sim). It contains NO three.js geometry, no BufferGeometry, no InstancedMesh, no shader, no imported mesh. No file in it imports `three`. There is no triangle, line or point primitive built here. What it does contain is the CPU/data side that decides HOW MANY and WHERE the instanced / animated things drawn elsewhere are. Those items are listed below because they size or feed GPU instance buffers; none has its own vertex or triangle count.

#### E1. Agent population ceilings (sizes the renderer's instance buffers)
1. What: maximum vehicles and pedestrians the sim can publish; per params.ts comment "They are ALSO what the renderer sizes its instance buffers from".
2. Location: src/sim/params.ts:119-120 (`FLEET_CEILING = 1200`, `PED_CEILING = 1000`). Re-exposed as `MAX_VEHICLES` / `MAX_PEDS` in src/sim/host/protocol.ts:30-38.
3. Primitive: none here (CPU counts). Renderer (outside this chunk) draws cars and people from these.
4. Counts: 1200 vehicles, 1000 pedestrians hard caps. Vertex/triangle counts per car/person are NOT in this chunk (render/agents, people meshes live elsewhere).
5. Attributes: n/a.
6. Multiplicity: scaled by `SimWorld.populationShare` (0.3 .. 1.0): src/sim/populationGovernor.ts:5-15,18-20 (`HIGH_MS = 6.5`, `LOW_MS = 3.5`, `STEP = 0.85`, `MIN_SHARE = 0.3`; start share by thread count `cpuPopulationShare`: <=4 threads 0.5, <=8 threads 0.75, else 1). Narrow screen share `NARROW_SCREEN_SHARE = 0.5` under `NARROW_SCREEN_WIDTH = 800` px (params.ts:123-125). So drawn agents effective max is 360..1200 vehicles and 300..1000 people.
7. Notable: the governor thins the *population* (hence drawn triangles) from measured sim step cost, not from GPU cost. Ambient targets: `MAX_WALKERS = 260`, `MAX_DRIVERS = 180`, `MAX_DRIVERS_FAR = 110` (src/sim/ambient/ambient.ts:28-30) in the view-driven source mode; in the default `edges` source mode the target is `peopleTarget` (ambient.ts:354-364) = min(street length / 100 m x land-use table x pedestrianIntensity, street length/8 m, `PED_CEILING x populationShare`) and cars come from the meso micro window (E4) and `trafficTarget`.

#### E2. Shared frame buffer (sim worker -> page), the data that drives per-instance transforms
1. What: SharedArrayBuffer triple buffer holding every vehicle and pedestrian pose per tick.
2. Location: src/sim/host/protocol.ts:15-52 (layouts `V`, `P`, `H`, `SLOT`, `makeSharedFrames`); written in src/sim/host/simHost.ts:202-281 (`publish`), read in src/sim/host/simClient.ts:548-707 (`readTick`).
3. Primitive: none (Float64 data).
4. Counts: `VEHICLE_STRIDE = 23` doubles (184 B) per vehicle, `PED_STRIDE = 14` doubles (112 B) per person, head 8 doubles. `SLOT = 8 + 1200*23 + 1000*14 = 41,608` doubles = 332,864 B; triple buffer `3 * SLOT * 8` = 998,592 B (~975 KiB), allocated once at full ceilings.
5. Attributes per vehicle: id, archetype, free flag, previous pose (x,y,angle), current pose, yawBefore/yawNow, jump, v, prevV, age, segment, indicator, curvature, odometer, seats, slain, lot, inSegment (V in protocol.ts:16-18). Per person: id, x,y,heading, prev x,y,heading, v, turnV, age, segment, walking, kerbWait, rank (protocol.ts:21-24).
6. Multiplicity: per vehicle / per person per tick (60 Hz sim step, `DT = 1/60`, src/sim/dt.ts:2). Page interpolates by `alpha`.
7. Notable: full-precision Float64 poses; page-side views are persistent objects (no per-tick allocation). Rich (non-numeric) look data (color, archetype id, doors, people, wound/gesture state) is sent by structured clone only when changed (simHost.ts:232-242, 262-265).

#### E3. Parked cars list and grid (feeds parked-car instances)
1. What: scenery cars standing in parking bays.
2. Location: src/sim/ambient/ambient.ts:68-91, 830-943 (`parking`, `standSource`, `stand`); wire format `PK`, `PARKED_STRIDE = 8` doubles (64 B) per car in src/sim/host/protocol.ts:170-171; page grid src/sim/host/fleetGrid.ts (64 m cells, `FLEET_CELL = m(64)`, line 10); page-side `parked` / `parkedGrid` in src/sim/host/simClient.ts:113-181.
3. Primitive: none here.
4. Counts: no cap in code for parked cars; one car per bay with probability `PARKED = 0.62` (ambient.ts:43), kind chosen among hatch/sedan/suv/van that fit the stall (`stallFits`, ambient.ts:921). Count = 0.62 x number of bays in the stood sources. With meso on, only the micro window's bay sources are stood (`parkInWindow`, ambient.ts:852-873).
5. Attributes: id, gone, x, y, angle, lot, archetype index, 0xrrggbb colour.
6. Multiplicity: per bay; scales with city size, limited to the micro window radius under meso.
7. Notable: seeded by bay position (ambient.ts:917), so a bay keeps its car. Cars outside the micro window are not materialised at all.

#### E4. Meso (far) traffic link records - data behind the "far cars" drawn by render/densityCars (outside chunk)
1. What: per directed road link, count / queue / speed / length / lanes / flags and a 3-point straight line (start, middle, end) for drawing far cars cheaply.
2. Location: src/sim/meso/memory.ts:7-8 (`ML` record, `MESO_RECORD = 13` Float32 = 52 B per link per delta); line fed by src/sim/meso/meso.ts:318-327 (`placeLine`, `line = [a.x,a.y, mid.x,mid.y, b.x,b.y]`, built at meso.ts:410-412 from `segmentLine(...)` midpoint), published at meso.ts:759-797.
3. Primitive: none here; the line is 3 points (a polyline of two segments, drawn straight "from afar").
4. Counts: 1 record per link; link count = 2 x road segments (one-way: 1). Model memory formula in `MesoModel.bytes` (model.ts:105-107): `cap * (3 + 17*8 + 6*4 + 1)` = 164 B per slot plus rings and turns arenas.
5. Attributes per record: count, queued, speed, length, lanes, flags, ax,ay, mx,my, bx,by, shape serial (Float32). Delta also carries slot Int32 and link id Float64.
6. Multiplicity: per road link of the whole map; micro window radius `MICRO_RADIUS = 750 m` max, `MICRO_MIN_RADIUS = 300 m` min, follows view at 1.35 x view radius (memory.ts:14-27). Inside the window links hold micro vehicles (real cars, up to the 1200 ceiling x share); outside they are density records.
7. Notable: step work is spread over ticks (`MESO_WORK_PER_TICK = 4096` links a tick, meso.ts:25), `MESO_DT = 1` s. A link is re-sent only when rounded count/queue, speed (>10 % change, `SPEED_STEP`), flags or line changed (meso.ts:776-780). The page's `MesoMemory` grows by doubling (min 1024 slots, memory.ts:164-169). Deltas kept up to `MESO_KEPT = 600` (10 s) before a whole resend (simClient.ts:24).

#### E5. Walker routes and walk graph (sim-side polylines, not rendered here)
1. What: sidewalk/zebra/footway polylines the people walk on.
2. Location: src/sim/peds/sidewalk.ts:47-263 (`SidewalkGraph.build/update`, kerb nodes at lines 101-139, zebra `Polyline.fromPoints([right.at, left.at])` at line 155, footway lines at 177-227); walk graph `WalkGraph`/`Walkway` itself is in `@world/walkways` (not read, outside list). Signal post positions: src/sim/peds/signalPostIndex.ts.
3. Primitive: none (CPU `Polyline`s). A zebra is a 2-point polyline; a footway side line is `[from.at, ...offset middle points, to.at]` with consecutive points <= 0.01 apart dropped.
4. Counts: per road segment 2 footway lines (side -1 and +1), per junction leg 1 zebra, 2 kerb nodes per leg. Middle point count = that of `pl.sub(s0, s1).toPoints()` (depends on the road centreline).
5. n/a.
6. Per road / per junction leg; rebuilt incrementally from the topology log.
7. Notable: none for GPU; these are the same footway lines the road renderer may draw elsewhere (not verified, outside chunk).

#### E6. Casualty / wound records (inputs to ragdoll and blood decals, rendered elsewhere)
1. What: killed/knocked bodies, severed limbs, bullet wounds that the renderer turns into ragdoll bodies, limb pieces and clothing holes/blood.
2. Location: src/sim/people/casualties.ts:8-40 (`Casualty`), caps in `recordWound` (line 49: wounds list capped at 256 per world between takes); casualties kept for 60 s (lines 69-75, 253 in simClient.ts); `Severable = 'armL'|'armR'|'legL'|'legR'|'head'` (people/view.ts:51), `BodyPart` adds torso.
3. Primitive: none here.
4. Counts: no vertex/triangle data. Up to 5 severable pieces per casualty (each "a piece of its own" per the Casualty comment).
5. n/a.
6. Per blow / per shot; 60 s retention.
7. Notable: `walk.ts` shock list capped at 64 (walk.ts:454).

### Budgets, caps and counters found
- `FLEET_CEILING = 1200`, `PED_CEILING = 1000` (src/sim/params.ts:119-120): hard caps; renderer sizes instance buffers from them (comment params.ts:118).
- `NARROW_SCREEN_SHARE = 0.5`, `NARROW_SCREEN_WIDTH = 800` (params.ts:123-125).
- Population governor: `HIGH_MS 6.5`, `LOW_MS 3.5`, `STEP 0.85`, `MIN_SHARE 0.3`, `HOLD_S 3`, `SMOOTHING 60` (populationGovernor.ts:4-15); start share by thread count (lines 18-20).
- Ambient: `MAX_WALKERS 260`, `MAX_DRIVERS 180`, `MAX_DRIVERS_FAR 110`, `MAKE_PER_LOOK 8`, `TRIM_PER_LOOK 10`, `LOOK_EVERY 0.25 s`, opening fill `OPEN_CARS 2`, `OPEN_PEOPLE 2` per tick for `OPEN_TICKS 600` (ambient.ts:26-43); `PARKED 0.62`; live radii `LIVE_PEOPLE 150 m`, `LIVE_CARS 200 m`, `UNSEEN_REACH 170 m` (ambient.ts:109-112); people spawned at most 2 per second in edges mode (ambient.ts:393).
- `STEP_BUDGET_MS = 14` (simHost.ts:34); `MAX_SUBSTEPS 5`, `MAX_FRAME 0.25` (params.ts:8-10); `SEARCH_EXPANSIONS 6000`, `SEARCHES_PER_TICK 16` (routing/searchScratch.ts:184-186).
- Meso: `MESO_WORK_PER_TICK 4096`, `MESO_DT 1`, `MICRO_RADIUS 750 m`, `MICRO_MIN_RADIUS 300 m`, `ADMIT_PER_TICK 4`, `SPEED_STEP 0.1` (meso.ts, memory.ts); `MESO_KEPT 600` (simClient.ts:24).
- Stats/counters already in code: `walkWork` {hailLooked, routeNodes, parkedFiled} (walk.ts:122); `ambientIndexWork` (ambientIndex.ts:14); `tickWork` {cleanupLanes, retired, controllers, rebound} (pipeline.ts:178); `rebuildWork` (imported from @world/rebuildWork, not read); `Meso.late`, `MesoModel.generated/lost/sunk/handedIn/handedOut` and `MesoModel.bytes` (model.ts:90-107); `SimStats` {vehicles, people, controllers, lotsMoving, populationShare, stepMs} (protocol.ts:174-188); `SimClock.lastSteps/lastStepMs` (clock.ts:13-14); `AmbientWorld.counts()` (ambient.ts:115). No triangle/vertex counters or per-quality triangle budgets exist in this chunk.

### Files without geometry
All 50 files contain no polygon/line/point geometry on the GPU. Grouped:
- src/sim/agents: walk.ts (pedestrian striping model, spatial hashes, zebra queueing; geometry only as CPU polylines/discs: `CarZone` = 3 discs along a car body, `parkedZone`, walk.ts:111-119).
- src/sim/ambient: ambient.ts, ambientIndex.ts (SightWalls ring index: building footprint rings as typed arrays, CPU line-of-sight tests only), demand.ts, lotPlaces.ts, playerId.ts.
- src/sim (root): audit.ts, clock.ts, dt.ts, invariants.ts, params.ts, pipeline.ts, pose.ts (vehicle/pedestrian pose interpolation, writes numbers only), populationGovernor.ts.
- src/sim/city: city.ts.
- src/sim/crossings: permission.ts, state.ts.
- src/sim/drive: operational.ts, physicalMotion.ts, tactical.ts.
- src/sim/host: fleetGrid.ts, protocol.ts (data layout, see E2), simAnswers.ts, simClient.ts, simHost.ts (data transport, see E2/E3).
- src/sim/intersections: admission.ts, claims.ts, crossingSpans.ts (CPU sampling of zebras every 0.5 m, `SAMPLE = 0.5`, not GPU), cycles.ts, spillback.ts.
- src/sim/meso: demand.ts, memory.ts (see E4), meso.ts, model.ts, slots.ts, tileLinks.ts.
- src/sim/peds: sidewalk.ts (CPU polylines, see E5), signalPostIndex.ts.
- src/sim/people: casualties.ts, engine.ts, view.ts.
- src/sim/roads: controlAdvisor.ts, flowStats.ts, greenWave.ts.
- src/sim/routing: destination.ts, laneReach.ts, lowerBound.ts, routeIndex.ts, router.ts, searchScratch.ts.

Out-of-list facts not resolved (would need other chunks): the triangle counts of car and person meshes, the instanced-mesh capacities in render/agents and render/densityCars, and the `Walkway`/`WalkGraph` geometry in `@world/walkways`.

---

## Polygon geometry audit, chunk g10 (src/sim non-agent files + src/ui)

Result in one line: none of the 45 files in this chunk builds, transforms or sizes GPU geometry (no BufferGeometry, no three.js import, no instancing, no vertex/triangle counts). The chunk is simulation logic (signals, vehicles, transit, world) and DOM/Canvas2D UI. The only items relevant to the audit are indirect: vehicle body dimensions (the data the renderer builds vehicle meshes from), fleet caps, train car counts, 2D-canvas overlays (not GPU geometry), and UI strings that expose the existing triangle-budget and stats controls.

### Files read

Every file was read completely, first to last line (large ones in sequential offset/limit chunks). Line counts:

src/sim:
- src/sim/signals/fsm.ts 430
- src/sim/signals/permission.ts 43
- src/sim/signals/plan.ts 433
- src/sim/signals/query.ts 50
- src/sim/sim.worker.ts 13
- src/sim/topologyCatchUp.ts 45
- src/sim/transit/transit.ts 599
- src/sim/vehicleSignals.ts 131
- src/sim/vehicles/archetypes.ts 236
- src/sim/vehicles/curvature.ts 126
- src/sim/vehicles/cycleLane.ts 32
- src/sim/vehicles/driver.ts 76
- src/sim/vehicles/idm.ts 109
- src/sim/vehicles/integrate.ts 326
- src/sim/vehicles/kerbStops.ts 595
- src/sim/vehicles/laneChange.ts 577
- src/sim/vehicles/laneClosures.ts 89
- src/sim/vehicles/leaderIndex.ts 201
- src/sim/vehicles/obstacles.ts 212
- src/sim/vehicles/spawn.ts 327
- src/sim/vehicles/state.ts 249
- src/sim/vehicles/vehicleId.ts 2
- src/sim/world.ts 1400

src (root) and src/ui:
- src/steamAchievements.ts 24
- src/ui/about.ts 24
- src/ui/buildStamp.ts 46
- src/ui/builder/catalog.ts 198
- src/ui/builder/icons.ts 315
- src/ui/builder/workspace.ts 371
- src/ui/chrome.ts 15
- src/ui/effectsPanel.ts 180
- src/ui/graphicsPanel.ts 111
- src/ui/healthPanel.ts 266
- src/ui/healthWatch.ts 203
- src/ui/i18n/en.ts 1865
- src/ui/i18n/index.ts 141
- src/ui/i18n/pt-BR.ts 1855
- src/ui/inspector.ts 519
- src/ui/labels.ts 20
- src/ui/materialSwatch.ts 211
- src/ui/overlay/builderGrid.ts 31
- src/ui/overlay/buildingOverlay.ts 316
- src/ui/overlay/congestion.ts 84
- src/ui/overlay/palette.ts 7
- src/ui/overlay/surface.ts 91

Totals: sim group 6301 lines, UI/root group 6893 lines, 13194 lines in 45 files. Nothing was left unread. One outside-the-list lookup was made to resolve a number: src/sim/params.ts lines 115 and 119 (grep only, for `TRAFFIC_DENSITY` and `FLEET_CEILING`).

### Elements

Nothing here is GPU geometry. The items below are the nearest things to it, so the caller can cross-reference them with the files that actually build the meshes.

#### 1. Vehicle body dimensions (data that drives vehicle mesh construction elsewhere)
1. What: the eight vehicle archetypes (hatch, sedan, suv, van, bus, truck, motorcycle, bicycle); the renderer assembles a body per `shape` ('car' | 'bus' | 'truck' | 'motorcycle' | 'bicycle') from these numbers.
2. Location: src/sim/vehicles/archetypes.ts:7 (shape type), :12-48 (Archetype interface), :50-226 (ARCHETYPES table). No geometry built here.
3. Primitive: n/a (data only). `style` ('hatch' | 'sedan' | 'suv' | 'van', :10) selects the silhouette for cars.
4. Counts: no vertex/triangle counts in this file. Numbers that size the meshes (metres, via `m()`): length / width / height / wheelRadius / axles / seats / doorsPerSide:
   - hatch 3.9 x 1.72 x 1.48, wheel r 0.31, 2 axles, 4 seats, 2 doors per side
   - sedan 4.7 x 1.84 x 1.45, r 0.33, 2 axles, 4 seats, 2 doors per side
   - suv 4.9 x 1.95 x 1.78, r 0.37, 2 axles, 4 seats, 2 doors per side
   - van 5.6 x 2.0 x 2.35, r 0.35, 2 axles, 2 seats, 1 door per side
   - bus 12.0 x 2.55 x 3.2, r 0.5, 3 axles, 7 seats, 0 doors per side (cabinFraction 0.98)
   - truck 9.8 x 2.5 x 3.5, r 0.52, 3 axles, 2 seats, 0 doors per side
   - motorcycle 2.1 x 0.8 x 1.25, r 0.3, 2 axles, 1 seat
   - bicycle 1.8 x 0.6 x 1.1, r 0.34, 2 axles, 1 seat
   Wheel count follows `axles` (comment at :25, "decides the wheel count and their spacing"); seat count caps the occupant figures drawn inside (`seats`, :29-31). Cabin proportions: `cabinFraction`, `cabinShift` (:22-25).
5. Per-vertex attributes: n/a.
6. Multiplicity: spawn weights (:46 field `weight`, values 0.3 hatch, 0.27 sedan, 0.14 suv, 0.08 van, 0.025 bus, 0.035 truck, 0.11 motorcycle, 0.04 bicycle, sum 1.0). Fleet ceiling see "Budgets" below. Each vehicle also draws seated people (see #2) and door animation (`Vehicle.doors`, state.ts:114).
7. Notes: the number of occupants drawn per car is bounded by seats (state.ts:117, kerbStops.ts:88 `SEAT_STRIDE = max(8, max seats)`); `slain` flag draws a person slumped (state.ts:55-56). No performance issue is visible in this file; mesh cost lives in the renderer files.

#### 2. Per-vehicle render inputs read from the sim (steering, indicator, wheels, doors, seated people)
1. What: values the page reads each frame to pose a vehicle's wheels, indicators, doors, and seated occupants.
2. Location:
   - src/sim/vehicleSignals.ts:31 `indicatorSide` (-1/0/1), :74 `blinkOn` (BLINK_HZ 1.5, duty 0.55 at :20-21), :80 `steerAngle`, :85 `steerFrom` (clamped to +/- MAX_STEER 0.6 rad, :23), :95 `pathCurvature`, :115 `WheelOdometer` (rolling angle).
   - src/sim/vehicles/state.ts:114 `doors: number[]` (0 shut to 1 open), :119-121 `seats` bitmask, `people`, `peopleAge`.
   - src/sim/vehicles/kerbStops.ts:97 `seatPerson`, :102 `seatPersonInto`, :117 `seatAgeClass`, :576 `kerbTransfer` (seated/walked fractions for the person moving between seat and footway).
3. Primitive: n/a (scalars/bitmasks).
4. Counts: n/a.
5. Attributes: n/a.
6. Multiplicity: per vehicle on screen, every frame; comments in the code state these are called "for every seat of every car drawn, each frame" (kerbStops.ts:116) and "every vehicle drawn, every frame" (vehicleSignals.ts:91), so allocation was removed (reused frames `HERE/THERE/BEFORE/AFTER`, `seatPersonInto` writes into an out object).
7. Notes: nothing creates geometry; these are CPU costs per drawn vehicle.

#### 3. Trains as drawn (car lists for the renderer)
1. What: train and metro cars for the transit layer.
2. Location: src/sim/transit/transit.ts:93 `TrainView`, :534 `trains()`; counts at :42 `TRAIN_CARS = 4, METRO_CARS = 3, CAR_LENGTH = m(18)`.
3. Primitive: n/a. The sim only hands out `cars: {x, y, heading}[]` per train (centre and heading of each car) plus line colour and `metro` flag.
4. Counts: 4 cars per train, 3 cars per metro train, each 18 m long (the renderer builds each car's mesh elsewhere). A train's length is therefore 72 m, a metro train 54 m.
5. Attributes: n/a.
6. Multiplicity: `line.vehicles` trains per line (set by the player, `trains` array per `RailLine`, transit.ts:219-223); buses likewise `line.vehicles` per bus line (:162). Tracks are polylines (`RailLine.points`, `at`, :79-90) built by `railPath` over the transit plan; the track geometry itself is built elsewhere (`@world/transit`).
7. Notes: also builds collision "discs" for pedestrians (not rendered): `trainZones` (:493) pushes one disc (r = m(1.9)) every m(3) over the track ahead of each moving train (reach = max(30 m, v*7 s)), and discs every m(2.5) of r = m(1.8) along each of the 4 cars. Per train at rest: for each of 4 cars, floor((18 - 2*1.5)/2.5)+1 = 7 discs, so 28 discs; ahead-track discs about (reach-4)/3. These are logic circles, not polygons.

#### 4. 2D canvas overlays (Canvas2D, not GPU triangles/lines of the 3D scene)
These are drawn with the 2D context onto an overlay canvas, so they cost CPU rasterisation, not three.js geometry. Listed because the brief covers editor gizmos/overlays; they are explicitly NOT in the WebGL/WebGPU scene.

a. Builder grid overlay
- src/ui/overlay/builderGrid.ts:6 `drawBuilderGrid`. Lines: for v from -reach to +reach step GRID (reach = m(60), minor lines only inside radius m(24), major every 5 cells). Two Path2D strokes total (minor and major), each line has 2 axes (4 `project` calls per step). GRID comes from `@world/buildings/geometry` (not resolved here). Comment at :12 states ~127 strokes a frame were merged into two strokes.

b. Building tool overlay
- src/ui/overlay/buildingOverlay.ts:44 `drawBuildingOverlay`. Draws: plan polyline with circles (:65-89), hover ring (:91-94), cutting/clipping volume rings top and bottom plus vertical edges per corner (:99-118, dashed [6,4]), selected volume rings at base and roof (:122-125), side length labels for volumes with <= 8 sides (:126-147), picked bay as a filled quad (:149-175), handles as circles/arrows (:179-192, `drawHandle` :244-316: radius 5/7/9 circles, triangles for arrows, glyph text). All 2D, per-frame while the tool is active, bounded by the building's volume and handle counts.

c. Congestion map
- src/ui/overlay/congestion.ts:61 `drawCongestion`. One stroked polyline per road in view (`net.ribbonsMeeting(view)`), width = max(3, 0.7 x road width on screen), alpha 0.75. Band sampling cached per ribbon in a WeakMap (:39-58): steps = clamp(ceil(length / 12), 2, 48), Float64Array of 4 + 2*(steps+1) numbers per road. Colours from 4 stops (:15). Per road: up to 49 points; this is CPU path building, not GPU geometry. Occupancy per road: `CAR_SPACE = m(7.5)` per queued car over lane length (:13, :25-36).

d. Material swatches
- src/ui/materialSwatch.ts:197 `materialSwatch(finish, size = 56, dpr = 2)`: draws a 112x112 px canvas per finish (cached by key `finish|size@dpr`, :195-210) and returns a PNG data URL for the UI tiles. 13 finish cases drawn (:33-191: plaster/concrete, stucco, ceramic, brick, stone, wood, metal, glass, tile/roofing, slate, panel). Not a 3D texture; no mesh.

e. Builder icons
- src/ui/builder/icons.ts: a table `P` of about 170 inline SVG path strings, 24 x 24 viewBox, stroke-based (:3-221). `builderIconSvg` (:313) returns one `<svg>` string per id. DOM SVG, no GPU.

#### 5. Triangle budget and stats controls that already exist in the UI (strings and panels)
1. What: the effects panel exposes a "Level-of-detail triangle budget" and "Detail memory on the GPU" and a triangle counter; no logic here, just labels and the panel framework.
2. Location:
   - src/ui/i18n/en.ts:216-222 `fx.bTriangles` choices 1 (Normal), 0.5, 0.25, 0.1, 0.02, 0 (No limit); :223-230 `fx.bDetailMemory` choices -1 (Normal), 1024 MB, 512, 256, 128, 32, 0 (masses only). Same keys in src/ui/i18n/pt-BR.ts:215-229.
   - Stats rows: en.ts:279-291 (`fx.stat.gpu`, `.cpu`, `.fps`, `.calls` draw calls, `.triangles` triangles drawn, `.programs`, `.geometries`, `.textures`, `.targets`, `.buildings` "Buildings detail (GPU)", `.heap`, `.pixels`).
   - Building layers toggles: en.ts:231-245 (`fx.bMasses` masses and far levels, `fx.bFacadeLevel` L1, `fx.bDetail` L0 cells in detail, `fx.bParts` instanced cell parts, `fx.bSignatures`, `fx.bFlags`, `fx.bShell`, `fx.bGlass`, `fx.bFrames`, `fx.bFacadeDetails`, `fx.bProps`, `fx.bLots`, `fx.bFurniture` interior cutaway, `fx.bShadows`, `fx.bNightWindows`). These confirm the building geometry classes: masses, L1 facade level, L0 detailed cells, instanced cell parts, landmarks, flags, shell, glass, frames, facade details, facade props, lots, interior furniture, with per-layer shadow casting.
   - World layers: en.ts:260-273 (`fx.terrain`, `fx.water`, `fx.roads` "Roads, decks and markings", `fx.buildings`, `fx.vegetation` trees/forests/gardens, `fx.furniture` street furniture and long grass, `fx.props` signs/barriers/poles/elements, `fx.transit`, `fx.people`, `fx.farTraffic`, `fx.signals`, `fx.particles` exhaust and dust, `fx.weather` rain and lightning).
   - src/ui/effectsPanel.ts:20-34 `EffectsPanelDeps` (`stats()` returns name/value pairs; refresh every 250 ms, `STATS_MS` at :47; resolution scales 1, 0.75, 0.5, 0.25 at :45). The values are supplied by the wiring (`effectsWiring.ts`, outside this chunk).
   - src/ui/graphicsPanel.ts:31-33: SHADOWS = [0, 1024, 2048, 4096] texel sides for the shadow map; FPS limits [0, 30, 60, 120, 144]; PRESETS auto/low/medium/high/ultra; `GraphicsChoices` (:7-19) also lists ambientOcclusion, smaa, dynamicResolution, vsync, fullscreen.
3-7. Notes: there is no geometry code; the actual triangle budget logic is elsewhere (render/buildings). Cap of clouds is stated as 24 in a hint string: en.ts:528 `hint.cloud.full` ("The sky already holds the most clouds (24)"), pt-BR.ts:523.

#### 6. Terrain and map-size facts exposed through strings (for cross-reference)
- en.ts:91 and :316 state the standard city is "10 km x 10 km"; en.ts:317 states the large planned city is "about 2.7 km across" and opens at one district with the rest filling in after a curtain.
- en.ts:62 roundabout radius range 32 to 128 m.
- Landform tools described at en.ts:551-553, :570-573 (mesa, canyon, escarpment, sugarloaf), trees/biomes (:488-503, :555-566), clouds (:513-528), fog (:529-538), water (:477-480), elements (stones, pebbles, gravel, leaves, grass, tall grass, scrub, fern, clover, flowers, mushrooms, smoke/fire/steam/dust/soot/sparks/spray; :445-475). No counts or segment numbers given anywhere in these strings.

#### 7. Builder catalogue entries that map to generated building geometry (names only)
- src/ui/builder/catalog.ts:36-111 `BUILDER_TAB_SPECS`: tabs models, draw, mass, facade, parts, roof, interior, paint. Primitives (:41): primBox, primCylinder, primOctagonal, primPrism, primWedge, primPyramid, primCone, primCross. Plan shapes (`DRAW_SHAPES`/`TIER_SHAPES`, :122-148): rectangle, l, u, circle, hexagon, octagon, chamfered, cross, stepped. Openings (`OPENING_COMPONENTS`, :151-166): door, doubleDoor, garageDoor, window, sashWindow, wideWindow, frenchWindow, bayWindow, ribbon, balcony, shopfront, loadingDoor, pillar, wall. Parts (:75-83): stair, ramp, pillar, canopy, wall, slab, wall/fence/pavement/railing/stair runs, tree, shrub, hedge, flowers, rocks, bench, planter, parking, ac, awning, clock, solar, skylight, vent, chimney, waterTank, spire, lantern. Interior (:94-101): lift, stair, 22 furniture types (sofa, armchair, table, chair, bed, singleBed, wardrobe, tv, desk, officeChair, bookshelf, shelf, counter, fridge, stove, sink, bath, toilet, plant, ceilingLamp, floorLamp, tableLamp). Roof types (:89): flat, terrace, gable, hip, shed, sawtooth. Reference models: .glb/.gltf imported as translucent reference (en.ts:1574 `hint.builder.refLoad`, :1592 `hint.builder.refBuild`; processing happens elsewhere).
- Segment counts for these shapes (e.g. how many sides the "circle"/"cylinder" plan uses) are NOT defined in this chunk; they live in `@world/buildings/*`.

#### 8. Pedestrian/vehicle support collision shapes (non-rendered)
- src/sim/transit/transit.ts:493-531 train discs (see #3); src/sim/vehicles/laneClosures.ts is a list of closed lane stretches (no shape); src/sim/vehicles/obstacles.ts builds scalar obstacles. None go to the GPU.

### Budgets, caps and counters found

- Fleet cap: `FLEET_CEILING = 1200` vehicles (src/sim/params.ts:119, read via grep outside the list); `TRAFFIC_DENSITY = 1 / m(45)` cars per metre of road (params.ts:115). Used in src/sim/vehicles/spawn.ts:32-45 `trafficTarget`: min(ceiling, floor(roadLength x density x intensity x demand)), where ceiling = FLEET_CEILING (or FLEET_CEILING x `populationShare` when the player has not chosen a count). A chosen count is further limited to one car per 12 m of road (`stepsIn(total, 12)`, :38). `populationShare` is 1, or a smaller `NARROW_SCREEN_SHARE` on narrow screens (world.ts:271).
- Spawn limits: `ADMIT_PER_TICK = 4` vehicles per tick (spawn.ts:29); `ENTRY_QUEUE = 6` waiting arrivals per entry (:25); `ENTRY_RATE = 0.05`/s per entry (:23); `FILL_RATE = 0.25`/s (:27).
- Micro window radii that decide which vehicles exist: `FOCUS_WINDOW = m(600)` (world.ts:37), `VEHICLE_WINDOW = m(300)` (:33), `WINDOW_CELL = m(100)` (:35). Buses and trains are taken off the road outside `AWAY_MARGIN = m(200)` past the view (transit.ts:45).
- Transit: `TRAIN_CARS = 4`, `METRO_CARS = 3`, `CAR_LENGTH = m(18)`, `BUS_SPACING = 40` s (transit.ts:27, :42).
- Issues list capped at 512 (world.ts:1300).
- Health/performance: `LONG_FRAME_MS` and `stepBudget` from `@core/health` and `@core/perfBudget` are used in src/ui/healthWatch.ts:1-2, :142-148 (a measured step over its `budget.max` is logged); the budgets' values are defined outside this chunk. The log stores up to 256 entries on copy and keeps 300 `hitches` (healthWatch.ts:140), clears `performance.measure` buffer past 4000 entries (:136); health panel shows `ROWS = 7` (healthPanel.ts:14).
- UI "triangle budget" selector: choices 1, 0.5, 0.25, 0.1, 0.02, 0 (en.ts:217-222); "detail memory" choices -1, 1024, 512, 256, 128, 32, 0 MB (en.ts:224-230). The real implementation is not in this chunk.
- Shadow map sizes selectable: 0, 1024, 2048, 4096 (graphicsPanel.ts:32); resolution scale 1, 0.75, 0.5, 0.25 (effectsPanel.ts:45).
- Cloud cap: 24 (string only, en.ts:528).
- Overlay: congestion band sampling steps capped at 48 per road (congestion.ts:46); builder grid reach m(60), minor-line radius m(24) (builderGrid.ts:7-8).
- Stats shown in the effects panel (from i18n keys only): draw calls, triangles, shader programs, geometries, textures, render targets, building detail memory, JS heap, pixels drawn.

### Files without geometry

All 45 files in the chunk contain no GPU geometry (no BufferGeometry, no meshes, no instancing). Grouped:

src/sim/signals: fsm.ts, permission.ts, plan.ts, query.ts (traffic-signal state machines and plans).
src/sim: sim.worker.ts, topologyCatchUp.ts, vehicleSignals.ts (indicator/steering numbers only), world.ts (simulation world state, lane graph indexes, signal sleeping).
src/sim/transit: transit.ts (bus/train logic; hands out car centres/headings only, see Elements #3).
src/sim/vehicles: archetypes.ts (body dimension data, see Elements #1), curvature.ts, cycleLane.ts, driver.ts, idm.ts, integrate.ts, kerbStops.ts, laneChange.ts, laneClosures.ts, leaderIndex.ts, obstacles.ts, spawn.ts, state.ts, vehicleId.ts.
src (root): steamAchievements.ts.
src/ui: about.ts, buildStamp.ts, chrome.ts, effectsPanel.ts (panel framework, no geometry), graphicsPanel.ts, healthPanel.ts, healthWatch.ts, inspector.ts (road/junction inspector DOM), labels.ts, materialSwatch.ts (2D canvas texture swatches only).
src/ui/builder: catalog.ts (tool catalogue data), icons.ts (inline SVG icons), workspace.ts (inspector DOM for the Builder).
src/ui/i18n: en.ts, index.ts, pt-BR.ts (string tables; see Elements #5 and #6 for the few lines relevant to budgets).
src/ui/overlay: builderGrid.ts, buildingOverlay.ts, congestion.ts, palette.ts, surface.ts (2D canvas overlays only; surface.ts explicitly allocates a 1x1 canvas and never draws on it, line 4 and 19-21; see Elements #4 for the others).

---

## Polygon geometry audit - chunk g11

Scope: 72 files from `parts/g11.txt` (UI panels, view/camera, world helpers, `src/world/buildings/*` record model).
Read-only analysis. No project file edited, nothing run.

Headline: **no file in this chunk creates a BufferGeometry, InstancedMesh, three.js built-in geometry or shader-generated
vertices.** The chunk is the *building record model* and the *UI*. What it holds is the data that decides how many
polygons the renderer later emits (bay counts per facade, roof shapes, outline vertex counts, free parts, stair steps,
furniture pieces, roof plant, occluder boxes, terrain grading). Those drivers are listed below as elements, with the
formulas and the numbers the code actually uses. The mesh builders themselves live outside this chunk (`render/buildings/*`,
`buildingMesh.ts`, `partCells.ts`, `render/occlusion.ts`, terrain mesh).

### Files read

All files read completely, first to last line (long files in sequential chunks: `src/ui/v2/shell.ts` 1-700, 700-1399,
1400-2084). Lines from `wc -l`:

| File | Lines |
|---|---|
| src/ui/planSwatch.ts | 87 |
| src/ui/profilerHud.ts | 100 |
| src/ui/roadSectionEditor.ts | 128 |
| src/ui/roadSwatch.ts | 97 |
| src/ui/roads/catalogPanel.ts | 186 |
| src/ui/roads/connectorPanel.ts | 176 |
| src/ui/roads/crossSection.ts | 317 |
| src/ui/roads/cutWalls.ts | 17 |
| src/ui/roads/drawProfile.ts | 18 |
| src/ui/roads/furnitureChoice.ts | 22 |
| src/ui/roads/junctionPanel.ts | 325 |
| src/ui/roads/keys.ts | 110 |
| src/ui/roads/keysPanel.ts | 99 |
| src/ui/roads/money.ts | 18 |
| src/ui/roads/profileEditor.ts | 754 |
| src/ui/roads/profilePanel.ts | 83 |
| src/ui/roads/profileSwatch.ts | 136 |
| src/ui/roads/templates.ts | 53 |
| src/ui/thunder.ts | 73 |
| src/ui/toolChoices.ts | 233 |
| src/ui/v2/compass.ts | 117 |
| src/ui/v2/shell.ts | 2084 |
| src/ui/v2/start.ts | 76 |
| src/ui/v2/transitLine.ts | 16 |
| src/view/camera.ts | 81 |
| src/view/cameraGestures.ts | 333 |
| src/view/cameraMotion.ts | 195 |
| src/view/cameraProfile.ts | 57 |
| src/view/viewport.ts | 104 |
| src/world/approach.ts | 43 |
| src/world/approachGroups.ts | 69 |
| src/world/barriers.ts | 27 |
| src/world/bounds.ts | 93 |
| src/world/buildingGates.ts | 44 |
| src/world/buildings/architecture.ts | 325 |
| src/world/buildings/blocks.ts | 134 |
| src/world/buildings/blueprints.ts | 330 |
| src/world/buildings/cameraSolids.ts | 344 |
| src/world/buildings/cityBuildings.ts | 341 |
| src/world/buildings/decayWatch.ts | 58 |
| src/world/buildings/docks.ts | 56 |
| src/world/buildings/elements.ts | 518 |
| src/world/buildings/facadePatterns.ts | 113 |
| src/world/buildings/flags.ts | 38 |
| src/world/buildings/floors.ts | 47 |
| src/world/buildings/footprints.ts | 181 |
| src/world/buildings/foundation.ts | 352 |
| src/world/buildings/geometry.ts | 802 |
| src/world/buildings/grid.ts | 188 |
| src/world/buildings/handles.ts | 154 |
| src/world/buildings/interior.ts | 914 |
| src/world/buildings/intern.ts | 241 |
| src/world/buildings/items.ts | 142 |
| src/world/buildings/lotLibrary.ts | 31 |
| src/world/buildings/lotTemplate.ts | 11 |
| src/world/buildings/lots.ts | 87 |
| src/world/buildings/materials.ts | 296 |
| src/world/buildings/neighbours.ts | 103 |
| src/world/buildings/pads.ts | 442 |
| src/world/buildings/pick.ts | 226 |
| src/world/buildings/procedural.ts | 705 |
| src/world/buildings/recordTable.ts | 515 |
| src/world/buildings/reference.ts | 9 |
| src/world/buildings/roofPlant.ts | 145 |
| src/world/buildings/sections.ts | 94 |
| src/world/buildings/serialize.ts | 398 |
| src/world/buildings/siteGrading.ts | 181 |
| src/world/buildings/spaces.ts | 149 |
| src/world/buildings/spilledItems.ts | 161 |
| src/world/buildings/splitLevel.ts | 307 |
| src/world/buildings/store.ts | 441 |
| src/world/buildings/streetDoors.ts | 41 |
| **Total (72 files)** | **15,991** |

Outside the list, read only to resolve constants: `src/world/buildings/types.ts` via grep for `DEFAULT_MODULE = m(3)`
(l.334), `MAX_STOREYS = 60` (l.338), `MAX_SIZE = m(160)` (l.340), `MAX_RECESS = m(4)` (l.343), `MAX_PROJECTION = m(2.4)`
(l.344), `MAX_ELEMENTS = 128` (l.358), `MAX_TERRACE = m(5.5)` (l.191), `MAX_LIFT = m(6)` (l.193). Nothing else outside
the list was opened.

### Elements

None of these is a GPU mesh by itself; each is the data that sizes one. "Primitive" says what the downstream mesh is,
where this chunk makes it clear; otherwise "decided outside this chunk".

#### 1. Facade bay layout (the grid every facade mesh is built from)
- Location: `src/world/buildings/geometry.ts` - `baysOn` l.315, `bayWidth` l.319, `workOutLayout` l.651-716,
  `bayLayout` l.577 (memo per blocks list + rhythm), `facadeBays` l.586, `groundBays` l.623 (packed Float64, stride 8,
  l.614). Covered/exposed spans: `coveredSpans` l.333, `spansAgainst` l.343, `insideSpans` l.401, `exposedParts` l.417.
- What it is: one `LocalBay` per (volume, storey, side, bay index), or several pieces of one bay where another block
  stands against part of it. The renderer turns each bay into a window/door/wall/balcony component mesh.
- Count formula: bays per side = `facadeGeometry[side].bays ?? max(1, round(sideLength / module))`, module default
  3 m (`DEFAULT_MODULE`). Bays per building = sum over volumes of storeys x sum over sides of bays (+ extra pieces where
  a side is partly covered). Sides = 4, or `outline.length` (3..64).
  - Example `residentialTower` preset (`cityBuildings.ts` l.207-210): podium 24x20 m, 2 storeys = 2 x (8+7+8+7) = 60
    bays; tower 18x14 m, 16 storeys = 16 x (6+5+6+5) = 352 bays; total ~412 bay records (minus covered parts).
  - Example procedural landmark tower (`procedural.ts` l.448, 284-287): up to 44 floors, 16-gon outline; for a 20 m
    plan each edge ~3.9 m -> 1 bay per side -> 16 bays/storey -> ~704 bays.
- Per-bay data: 15 fields (LocalBay); ground storey also packed as 8 x Float64 = 64 B/bay (`groundBays`).
- Multiplicity: per building, per storey. Shared by every record with the same `volumes` array (interned, see 15).
- Notable: `insideSpans` samples each edge 64+ times (`step = max(EPS*20, length/64)`, l.403) with `pointInPolygon`
  when any volume has an outline - CPU cost, not GPU. Bay count clamp 1..64 per face (`facadePatterns.ts` l.87,
  `serialize.ts` l.210). `facadeGeometry.pierEvery` 1..16, pier width/depth <= 2.4 m.

#### 2. Roof shapes (gable, hip, shed, sawtooth, flat, terrace)
- Location: `geometry.ts` `DEFAULT_PITCH` l.739 (gable 30, hip 30, shed 12, sawtooth 35 deg), `roofSlope` l.742,
  `ridgeAlongX` l.748, `sawtoothRun` l.754, `roofRise` l.757, `roofHeightAt` l.775. Pitch chosen by
  `procedural.ts roofShape` l.262-274 (`PITCH` ranges l.259, `MAX_ROOF_RISE` l.257: gable/hip 3.2 m, shed 1.2 m,
  sawtooth 2 m; flattened when the cap is under 5 x 0.66 deg).
- Count: sawtooth teeth per volume = ceil(d / min(2 x module, d)) = ceil(d / 6 m) at module 3 m. Warehouse preset
  d = 24 m (`cityBuildings.ts` l.320 is shed; factory l.316 d = 24 m sawtooth) -> 4 teeth; `blueprints.ts warehouse`
  d = bays(6) = 18 m -> 3 teeth. Gable = 2 slopes + 2 gable ends; hip = 4 planes; shed = 1 plane (mesh triangles are
  decided by the roof builder outside this chunk).
- Roof parts on a roof: `roofDetails` <= 32 per volume (`serialize.ts` l.184); spire/lantern height 1..40 m, default
  lantern 19.4 m, spire 11.7 m (l.189).

#### 3. Volume footprints / outlines (polygon plans)
- Location: `footprints.ts validOutline` l.10 (3..64 vertices), `localFootprint` l.17, `volumeSides` l.22,
  `edgeFrame` l.31 (memoized side frames), `offsetRing` l.170; `geometry.ts volumeCorners` l.153.
- Producers of non-rectangular outlines:
  - `procedural.ts towerShape` l.277-288: 50% rectangle (4), 35% chamfered octagon (8 vertices, chamfer 0.14..0.26),
    15% circle (16 vertices). A 16-gon tower has 16 facade sides, each with its own bays and wall pieces.
  - `cityBuildings.ts OCTAGON` l.188-191 (8 vertices) for the council dome block.
  - `blocks.ts resolve` l.13-80: CSG of void / intersect / xor blocks with `polygon-clipping`; each result piece becomes
    a volume with an outline (`volumeOf` l.106, rejected over 64 vertices or under 0.5 m), holes split recursively
    (`simplePieces`, depth <= 4, so up to 2^4 = 16 pieces per hole chain).
- Notable: a hole-free CSG result can still multiply volumes per level band (`breaks` l.44-49), each band a separate
  volume with its own walls and roof.

#### 4. Free building parts (elements: stairs, ramps, pillars, canopies, walls, fences, trees, benches, ...)
- Location: `elements.ts ELEMENT_DEFAULTS` l.36-62 (25 kinds, w x d x h), `followPieces` l.97-114,
  `stairSteps` l.136, `runFor` l.139, placement `elementsAgainstBayAxis` l.297-420.
- Counts:
  - Ground-following runs (wall, fence, railing, pavement, hedge, bin, lamp, bollard, drain, planter, bench, rocks,
    flowers, shrub, tree; gate excluded) are cut into n = ceil(length / 2 m) pieces (`FOLLOW_STEP = m(2)`, l.94). A 40 m
    wall -> 20 pieces, each a separate box downstream.
  - Stair steps per stair = max(1, ceil(h / 0.17 m)) (`STEP_RISE`); a 3 m storey -> 18 steps.
  - Ramp run = max(1 m, 12 x rise).
- Caps: `MAX_ELEMENTS = 128` per building (`serialize.ts` l.352); generator `hang` stops at 96 (`procedural.ts` l.134).
- Generated multiplicity examples: `Model.ring` (`cityBuildings.ts` l.133-144) lays fences/walls in 4 m pieces: school
  ring 40 x 40 m -> 10+10+10+10 minus gate = ~39 pieces (`l.243`), each later cut again by `followPieces` into 2 pieces
  (4 m / 2 m) -> ~78 boxes. Prison wall 38 x 42 -> ~40 pieces -> ~80. Veranda posts = max(2, round(vw / 2.6 m) + 1)
  (`procedural.ts` l.356).
- Element default sizes, metres: stair 1.2x3x1, ramp 1.5x6x0.5, pillar 0.4x0.4x3, canopy 2.4x1.2x0.15, wall 4x0.25x1.8,
  slab 4x4x0.25, pavement 4x3x0.12, fence 2x0.12x1.1, tree 3x3x5, bench 1.6x0.5x0.45, ac 0.8x0.35x0.6, planter 1x1x0.5,
  railing 2x0.12x1.05, awning 3x1.2x0.12, flowers 1.4x1.4x0.4, rocks 1.6x1.6x0.7, parking 6x5x0.12, clock 3x0.25x3,
  hedge 3x0.7x1.2, shrub 1.4x1.4x1.2, gate 3x0.12x1.8, bin 1.4x0.7x1.1, lamp 0.3x0.3x4.5, bollard 0.2x0.2x0.9,
  drain 0.5x0.5x0.1.

#### 5. Foundation: plinth and entrance flights
- Location: `foundation.ts` constants l.10-18 (`PLINTH_MIN` 0.15 m, `PLINTH_BURY` 0.8 m, `MAX_PLINTH` 5.5 m,
  `STEP_RISE` 0.17 m, `STEP_RUN` 0.3 m), `foundationOf` l.182-264, `stepsFor` l.349 (<= 40 steps), `flightRun` l.125
  ((steps + 1) x 0.3 m), `mergeEntrances` l.267 (adjacent doors merged into one wide flight).
- Count: steps per entrance 0..40 (each a tread/riser downstream); plinth walls follow the volume rings down to
  `lowest - 0.8 m`. Ground sampling grid per volume (`sampleFootprint` l.88): (stepsX+1)(stepsY+1) with
  steps = min(24, ceil(side / 1.5 m)) -> up to 625 ground reads per volume (CPU only).

#### 6. Split-level flights between blocks and hillside steps
- Location: `interior.ts levelFlights` l.101-134 (risers = ceil(rise / 0.18 m), tread 0.24..0.28 m, width <= 1 m);
  `splitLevel.ts stepToSlope` l.100-240 (adds volumes by splitting a block, adds a lower storey, cuts facade bands into
  two elements, l.226-230). Lift steps up to floor(6 m / 0.17 m) = 35 options when a yard exists (l.153).
- Effect on polygons: each split adds one volume (more walls/roof); each split facade band adds one element.

#### 7. Interior furniture and partitions (cut-open view, lit windows)
- Location: `interior.ts FURNITURE_SIZE` l.49-60 (40 kinds), `interiorAt` l.194 (per level, deduplicated by floor type
  `floorType` l.179), `furnishFloor` l.209, `roomLights` l.238 (one ceiling lamp per 4.5 m cluster), `Plan.put` l.330,
  `Plan.grid` l.350, partitions as segments `Plan.wall` l.368; layouts per function l.387-914; flat/room plans
  `spaces.ts flatPlan` l.101 (corridor 1.6 m, double-loaded from 11 m depth).
- Count: data-driven per floor area; each piece is one box/prop downstream; each partition one thin wall. Example cinema
  preset 24 x 30 m (`cityBuildings.ts` l.296): seat grid 0.7 x 1.2 m spacing, but `free()` pads 0.15 m round placed
  pieces so seats 0.7 m apart collide (0.7 < 0.3 + 0.45) and every other one is refused -> ~14 per row x ~14 rows =
  ~196 seats (my calculation from l.301-327, 505). Stored furnishing capped at 400 pieces per level
  (`serialize.ts` l.386); generated furnishing is not capped.
- Multiplicity: per building per level, but levels of the same type share one `FloorInterior` (l.199-204), and the
  memo is keyed by the interned `volumes` array, shared across buildings with identical blocks.

#### 8. Roof plant (tanks, condensers, solar, masts, vents...)
- Location: `roofPlant.ts CATALOGUE` l.58-74, `planRoofPlant` l.94-145 (0.5 m packing grid, 0.6 m clearance, 0.8 m
  parapet edge, 24 placement tries per piece).
- Per-roof caps (max pieces): liftRoom 1, tankBox 1, tank 2, hatch 1, airHandler min(2 x 6, area/260 x p) = 12,
  condenser min(36, area/30 x p), solar 3, mast 3, dish 12, skylight 6, vent 30, chimney 1 -> hard ceiling 108 pieces
  per flat roof; roofs under 4 x 4 m get none.
- Sizes, metres (w x d x h): liftRoom 2.6x2.6x2.5, tankBox 3.2x2.4x2.2, tank 1.9x1.9x1.5, hatch 0.9x0.9x0.45,
  airHandler 3.4x1.8x1.6, condenser 0.9x0.8x0.85, solar 4.6x3.4x0.4 (x 0.7..1.45 by variant), mast 0.6x0.6x3.5,
  dish 0.9x0.7x1.2, skylight 1.2x1.2x0.25, vent 0.7x0.7x0.9, chimney 0.9x0.9x4.5.
- Notable: condensers and vents scale with roof area (one per 30 m^2 / 70 m^2); a 40 x 30 m commercial roof can reach
  the 36 + 30 caps - the largest per-building source of small props in this chunk.

#### 9. Occluder and camera-floor boxes (CPU data for `render/occlusion.ts`)
- Location: `cameraSolids.ts` `SolidFiling.add` l.216-251, `forEachOccluder` l.298-313, `SolidPages` l.28-75.
- What: one record per solid volume: building frame, local box, foot/top, wall bottom/top and inset (occluder = wall
  box drawn in by `OCCLUDER_MARGIN` 0.6 m and the deepest recess). NaN wall span (no occlusion) for carved buildings,
  outlined volumes, or volumes thinner than 2 x inset.
- Bytes: stride 14 x Float64 = 112 B per volume; pages of 4096 slots = 458,752 B + 16 KB stamps per page. Filed in 40 m
  cells (+2 m reach).
- Notable: outlined (octagon/16-gon) towers never occlude (l.233), so the tallest landmark towers hide nothing.

#### 10. Terrain grading under buildings (pads) - modifies terrain-grid vertex heights
- Location: `pads.ts padOf` l.116-154, `shapeOverPads` l.350-440 (called per terrain grid corner), `townPads` l.184-311
  (cells 25.6 m, squares of 4 x 4 cells, `PADS_KEPT` 1024, `CELL_LISTS_KEPT` 256), `siteGrading.ts` l.33-181.
- Effect: no new polygons; it displaces existing terrain vertices within `apron + PAD_REACH` (40 m) of each building,
  bank slope 1 : 3.5 (`PAD_BATTER`), lot plates 0.03 m, pools sunk 0.04 + 0.03 + 0.06 m. `padsWork.rings` counts ring
  distance evaluations (stats hook).

#### 11. Lot surfaces (car parks, yards, lawns, water) and lot plates
- Location: `lots.ts lotSurfaces` l.54-87 (one 4-corner ring per open volume, slope kinds level / ramp / street),
  `lotHeightAt` l.30. Downstream each is a plate quad (plus kerb), height from `lotHeightAt`.

#### 12. Building picking (CPU ray tests, no pick meshes)
- Location: `pick.ts pickBuilding` l.48-173: ray vs axis-aligned slab per volume and per element, outlines tested side by
  side, roof refined 4 iterations. No hidden pick geometry exists in this chunk.

#### 13. Editor handles (Builder gizmo positions)
- Location: `handles.ts buildingHandles` l.67-154.
- Count per selected volume: 1 (storeys) + n sides + n vertices + 1 lift (ground built block) + move + rotate + scale
  (+1 relief when a region is picked) -> rectangle: 1 + 4 + 4 + 1 + 3 = 13 (14 with relief); 16-gon: 37 (38).
  Drawn by the editor outside this chunk; one handle mesh each.

#### 14. Barriers (walls, fences, hedges, guardrails, railings drawn along paths)
- Location: `src/world/barriers.ts BARRIER_SIZE` l.17-23: fence 1.1 x 0.12 m, wall 1.8 x 0.25, hedge 1.2 x 0.8,
  guardrail 0.75 x 0.3, railing 1.0 x 0.06 (height x thickness). Mesh built elsewhere per path segment.

#### 15. Record interning and shared layouts (what lets identical buildings share derived geometry data)
- Location: `intern.ts intern` l.72-104 (hash-consing, frozen canonical objects), `SharedMembers` l.117-233;
  `recordTable.ts` binary tables; memo keys `bayLayout` (`geometry.ts` l.569), `furnishedOf` (`interior.ts` l.160),
  `spacesOf` (`spaces.ts` l.24), all keyed by the `volumes` array identity.
- Notable for performance: buildings with identical blocks share one bay layout, one interior and one space plan. Any
  per-building edit that clones `volumes` (e.g. `blocks.ts volumeOf` uses `structuredClone(storeys)`, `splitLevel.ts`
  uses JSON clones) breaks that sharing for that building.

#### 16. UI 2D drawings (not GPU geometry, listed for completeness)
- `planSwatch.ts` canvas outlines (circle = 28-point path l.13), `roadSwatch.ts`, `roads/profileSwatch.ts` canvas tiles;
  `roads/crossSection.ts` SVG street section; `roads/connectorPanel.ts` SVG lane plan; `v2/compass.ts` SVG needle;
  `v2/shell.ts` SVG icons. All DOM/canvas 2D, rendered by the browser compositor, not three.js.

### Budgets, caps and counters found

- `MAX_STOREYS = 60` (types.ts l.338; enforced `serialize.ts` l.143-144, levels l.346).
- `MAX_SIZE = 160 m` per volume side, `MIN_SIZE = 2 m` (`geometry.ts` l.25).
- Outline vertices 3..64 (`footprints.ts` l.11, `blocks.ts` l.107).
- Bays per face 1..64 (`facadePatterns.ts` l.87, `serialize.ts` l.210); `pierEvery` 1..16; sill/pier <= 2.4 m.
- `MAX_ELEMENTS = 128` per building (`serialize.ts` l.352); generator cap 96 (`procedural.ts hang` l.134).
- `roofDetails` <= 32 per volume (`serialize.ts` l.184).
- Stored furnishing <= 400 pieces per level (`serialize.ts` l.386); generated furnishing uncapped.
- Entrance flight <= 40 steps (`foundation.ts stepsFor` l.351).
- Ground-following runs split every 2 m (`elements.ts FOLLOW_STEP` l.94).
- Roof plant per-kind caps (section 8), max 108 pieces per roof.
- `MAX_PROJECTION 2.4 m`, `MAX_RECESS 4 m`, `MAX_LIFT 6 m`, `MAX_TERRACE 5.5 m`, `MAX_PLINTH 5.5 m`.
- Occluder pages 4096 volumes per page (`cameraSolids.ts PAGE_BITS = 12`), cell 40 m.
- Pads: cell 25.6 m, `PADS_KEPT` 1024, `CELL_LISTS_KEPT` 256, `PAD_REACH` 40 m.
- Spilled records `RECENT` 1024 (`spilledItems.ts` l.6).
- Stats/counters on screen: `ui/profilerHud.ts` l.53-74 shows `gauges.drawCalls`, `gpuGeometries`, `gpuTextures`,
  events `build.geometry` (per second and peak per frame, with call sites), `upload.buffer` and `upload.texture` MB/s,
  dispose counts (`dispose.geometry/material/texture/target`). `pads.ts padsWork.rings` counts grading work.
  `profileEditor.ts` l.299-302 records SVG redraw time in `data-redraw-ms` (UI only).
- No triangle or vertex budget per quality level exists in this chunk.

### Files without geometry

- `src/ui/`: planSwatch.ts, roadSwatch.ts (2D canvas only); profilerHud.ts (stats text); roadSectionEditor.ts,
  thunder.ts (Web Audio), toolChoices.ts.
- `src/ui/roads/`: catalogPanel.ts, connectorPanel.ts (SVG), crossSection.ts (SVG), cutWalls.ts, drawProfile.ts,
  furnitureChoice.ts, junctionPanel.ts, keys.ts, keysPanel.ts, money.ts, profileEditor.ts, profilePanel.ts,
  profileSwatch.ts (canvas), templates.ts.
- `src/ui/v2/`: compass.ts (SVG), shell.ts, start.ts, transitLine.ts.
- `src/view/`: camera.ts, cameraGestures.ts, cameraMotion.ts, cameraProfile.ts (FOV 35-55 deg, no geometry),
  viewport.ts.
- `src/world/`: approach.ts, approachGroups.ts, bounds.ts, buildingGates.ts (lowered-kerb segments, data only);
  barriers.ts only sizes (section 14).
- `src/world/buildings/` with no geometry-driving data: decayWatch.ts, docks.ts, flags.ts (pattern list only),
  floors.ts, grid.ts (64 m spatial grid), intern.ts, items.ts, lotLibrary.ts, lotTemplate.ts, materials.ts (colours /
  finishes), neighbours.ts, recordTable.ts, reference.ts (type `Triangle` only), sections.ts, serialize.ts (caps only),
  spilledItems.ts, store.ts, streetDoors.ts, architecture.ts (style module 2.6-3.2 m feeds bay counts, section 1),
  blueprints.ts and cityBuildings.ts (preset data, examples in sections 1-4), facadePatterns.ts (bay components).

---

## Polygon geometry audit - chunk g12

Chunk: `src/world/buildings/{tableRows,towerKit,types,validate}.ts`, `src/world/{carriageway,cells,changes}.ts`, `src/world/cityGen/*`, `src/world/{clouds,conflictPoints,conflictTable,curbRamps,derived,doc,docBinary,docImage,ecology,economy,elements,elevation,fogPaint,footwayPath,geometry,grid,groundPatch}.ts`, `src/world/growth/*`, `src/world/{gullies,heading,ids}.ts`.

Summary: this chunk is the pure world model (no three.js, no BufferGeometry, no InstancedMesh, no shaders). **No file in it creates GPU geometry.** What it does contain is (a) the data that drives polygon counts elsewhere - per-building volumes and lot elements generated by the growth, the elevation stations that the road surface meshes are sampled from, the terrain cell triangulation rule mirrored on the CPU - and (b) the caps that bound those inputs (per building, per tile, per map). These are reported below as "geometry inputs / budgets", with the multiplicity they cause.

### Files read

All files read completely, first line to last (large files in sequential chunks: `doc.ts` 1-1000, 1000-1999, 2000-2899, 2900-3700; `elevation.ts` 1-800, 800-1540; `growth/lotPlan.ts` 1-370, 370-729, 730-1094; `growth/zoning.ts` 1-330, 330-640).

| File | Lines |
|---|---|
| src/world/buildings/tableRows.ts | 122 |
| src/world/buildings/towerKit.ts | 21 |
| src/world/buildings/types.ts | 469 |
| src/world/buildings/validate.ts | 347 |
| src/world/carriageway.ts | 17 |
| src/world/cells.ts | 255 |
| src/world/changes.ts | 381 |
| src/world/cityGen/field.ts | 64 |
| src/world/cityGen/largeCity.ts | 12 |
| src/world/cityGen/plan.ts | 156 |
| src/world/cityGen/smallCity.ts | 12 |
| src/world/cityGen/squares.ts | 152 |
| src/world/cityGen/streets.ts | 483 |
| src/world/cityGen/wholeMap.ts | 249 |
| src/world/clouds.ts | 110 |
| src/world/conflictPoints.ts | 687 |
| src/world/conflictTable.ts | 643 |
| src/world/curbRamps.ts | 203 |
| src/world/derived.ts | 187 |
| src/world/doc.ts | 3700 |
| src/world/docBinary.ts | 130 |
| src/world/docImage.ts | 25 |
| src/world/ecology.ts | 446 |
| src/world/economy.ts | 169 |
| src/world/elements.ts | 101 |
| src/world/elevation.ts | 1540 |
| src/world/fogPaint.ts | 88 |
| src/world/footwayPath.ts | 61 |
| src/world/geometry.ts | 100 |
| src/world/grid.ts | 24 |
| src/world/groundPatch.ts | 65 |
| src/world/growth/grownRows.ts | 83 |
| src/world/growth/lotBoundaryRuns.ts | 58 |
| src/world/growth/lotPlan.ts | 1094 |
| src/world/growth/rows.ts | 44 |
| src/world/growth/version.ts | 2 |
| src/world/growth/zoning.ts | 640 |
| src/world/gullies.ts | 23 |
| src/world/heading.ts | 13 |
| src/world/ids.ts | 38 |
| **Total (40 files)** | **13,014** |

Files outside the chunk consulted only to resolve constants (grep, not full reads): `src/world/trees.ts:40-41` (MAX_PLANTED_TREES 20 000, MAX_TREE_CLEARINGS 10 000), `src/world/terrainPaint.ts:37` (MAX_PAINT_DABS 60 000), `src/world/terrain.ts:36` (MAX_TERRAIN_STAMPS 4 096), `src/world/tiles.ts:7` (TILE = m(1024)), `src/world/rampRise.ts:55` (RAMP_CELL = m(20)).

### Elements

None of the items below is itself a GPU primitive. Each is world data that a renderer in another chunk turns into triangles; the counts given are of the data (rectangles, boxes, stations, cells) and how they multiply.

#### 1. Terrain cell triangulation rule (CPU mirror of the terrain mesh)
- What: the rule by which every terrain grid cell is split into two triangles, used on the CPU to read ground height exactly as the terrain mesh draws it. Header says the shaders in `render/terrainLod.ts` (`landSurface`, `landVertex`) and `render/terrain.ts` (`sampleGrid`) draw with the same rule ("DO NOT change it here alone").
- Location: `src/world/groundPatch.ts:4-6` `cellDiagonal`, `:9-12` `cellHeight`, `:18-27` `latticeHeight`, `:41-48` `sampleGroundPatch`, `:58-65` `patchGround`.
- Primitive: 2 triangles per cell, data-dependent diagonal (Garland-Heckbert): a-c diagonal when `|a-c| + 0.5 < |b-d|`, else b-d. Corner (i, j) at (i*cell, -j*cell), rows southwards.
- Counts: per terrain cell 4 corners / 2 triangles. A ground patch round a rectangle has `cols x rows` corners = `(floor(maxX/cell) - floor(minX/cell) + 2) x (floor(-minY/cell) - floor(-maxY/cell) + 2)` Float64 heights (8 B each); it is sent to the growth worker, not drawn.
- Notable: because the diagonal choice depends on heights, the index buffer of the drawn terrain cannot be a fixed pattern unless the shader derives the diagonal (the comment says the shaders do). Any terrain LOD/vertex-pulling change must keep this function in sync.

#### 2. Road elevation stations (the vertical sampling the road surface meshes are built from)
- What: one continuous height field for every road; each segment is sampled into stations along its centreline. The road surface/footway/kerb meshes (other chunks, `render/mesh/*`) read heights from this field (`at`, `surfaceFrameAt`, `roadAt` via `roadField.ts`).
- Location: `src/world/elevation.ts:43-45` (`STATION = m(1.6)`, `MAX_STATIONS = 400`), `:240-245` `roadStations`, `:370-373` station count in `buildRoadElevation`, `:1128-1158` `readStations`.
- Counts: stations per segment = `max(2, min(400, ceil(length / 1.6 m) + 1))`; step = length / (count - 1). Examples: 100 m road -> 64 stations; 638.4 m -> 400 (cap reached); a 2 km road -> 400 stations at 5.01 m spacing. Ground read: 7 lateral samples (`LATERAL`, `:49`) per station -> up to 2 800 terrain reads per road per (re)solve (skipped on flat ground, `:1131-1134`).
- Per-station data (JS `number[]`, 8 B each): `h`, `ceil`, `base`, and `deck` for raised roads -> 24-32 B/station; `stationsAt` caches x,y as Float64Array (16 B/station, `:963-972`).
- Multiplicity: per road segment, persistent across solves (`RerootMap`), incremental (only changed roads/nodes resolved). Spatial index `ProfileIndex` with `INDEX_CELL`/`OVERSIZED_CELLS` (constants in `roadField.ts`, not in chunk).
- Notable: the 400-station cap means a road longer than ~638 m has a coarser vertical profile (step grows linearly with length); if road meshes take their longitudinal vertex rows from stations, long straight roads lose vertical resolution on hills. Solve passes capped at `MAX_SOLVE_PASSES = 64` (`:86`).

#### 3. Ground shaping under roads (cut/fill batter footprint)
- What: how far each road deforms the terrain mesh (embankment/cutting), read per terrain vertex by the terrain builder (`shapeAt`, `shapeBounds`, `shapeCut`).
- Location: `src/world/elevation.ts:211-226` (constants), `:849-885` `roadShapeAt`, `:888-898` `roadShaper`.
- Counts: influence half-width = `half + 1.2 m + shoulder`, shoulder = `clamp(|natural - road| * 2.5, 18 m, 36 m)` (6.4 m for tunnel cuts / walled cuttings). So each road affects terrain vertices up to ~37 m + half width either side; candidate roads per point come from the index cell.
- Notable: per terrain vertex cost is O(roads in the index cell); `shapeBounds()` builds one box per road for whole-map readers.

#### 4. Lot surfaces ("open" volumes) generated by the growth
- What: every grown lot is paved/planted with rectangles or outlined polygons laid as `Volume`s with `open: LotSurface` (grass, paving, asphalt, concrete, pavers, tiles, sand, water, gravel), drawn by the building mesher as flat slabs (or ramps/terraces).
- Location: `src/world/growth/lotPlan.ts:285-308` (`surface`, `ramp`, `tile`), used throughout `furnishLot` `:240-1094`; `src/world/growth/zoning.ts:496-526` `reachStreet` (extra paving strips), `:552-640` `fitToLot` (lawn under the whole lot with the lot's own outline, clipped surfaces via `clipper.intersection`).
- Counts per lot (typical): front zone 1-3 rectangles (front surface split by drives, `:549-555`), each side drive 1-2 (surface + ramp), side gardens 1-2, back zone 1-4 (`tile` splits a region round holes into strips, `:295-308`), terrace/pool/apron 1-3, plus 1 lawn polygon on non-rectangular lots and 0-3 paving strips from `reachStreet`. Roughly 4-12 open volumes per lot. Each surface < 2 m on either side is dropped (`:286`, `MIN_SIZE` in `zoning.ts:616`).
- Cap: all volumes of a building (building masses + open surfaces) <= `MAX_VOLUMES = 24` (`types.ts:341`, enforced by `validate.ts:138`; a building exceeding it is refused as 'size').
- Notable: a non-rectangular lot gets a full-lot lawn polygon drawn *under* the other surfaces (`zoning.ts:613-621`) - overlapping coplanar/near-coplanar surfaces, i.e. hidden duplicate area (overdraw, possible z-fighting, extra triangles). Outlined surfaces become arbitrary polygons (triangulated elsewhere).

#### 5. Lot elements (boxes: walls, fences, hedges, gates, railings, trees, benches, planters, bins, lamps, bollards, drains, parking bays, slabs, pillars, stairs, ac, rocks, flowers, shrubs, pavement)
- What: the furniture and boundary of every grown lot, stored as `BuildingElement` (centre x,y, facing, w, d, z, h, optional angle and material), rendered by the building/part meshers (other chunks) as boxes or kit meshes per `ElementKind` (25 kinds, `types.ts:228-255`).
- Location: `src/world/growth/lotPlan.ts:309-389` (`fits`, `put`, `runX`, `runY`, `path`), all of `furnishLot`; `zoning.ts:575-593` (boundary along polygon lot sides); `zoning.ts:40-61` (`placed` drops boundary pieces against neighbours).
- Counts / formulas:
  - Boundary runs: pieces of at most 20 m (`n = ceil(len / 20)`, `:351`, `:369`, `zoning.ts:584`); a piece refused by a clash is halved recursively down to < 1 m (`:354-361`, `:371-378`) -> one blocked run can turn into up to ~2*len pieces.
  - Front with a low base wall (`frontBase > 0`) lays two parallel runs (base wall + fence/railing on it), doubling the front boundary pieces (`:1011-1012`, `:1072-1074`).
  - Typical counts: house 30-70, flats/tower 25-60, shop 15-40, office 20-45, industry 20-50 elements; the yard "character" sets add 5-25 (swing = 6 boxes, trampoline = 5, table = 4, edicula = up to 8 incl. 6 stepping stones, beds up to 4x3 = 12; `:794-848`).
- Caps: `MAX_ELEMENTS = 128` per building (`types.ts:358`; checked `validate.ts:174`), with 30 kept in reserve for the boundary (`lotPlan.ts:197`, `:312`); `fitToLot` truncates to 128 (`zoning.ts:593`). Every element must also satisfy `MIN_ELEMENT/MAX_ELEMENT` sizes (`validate.ts:180`, constants in `buildings/elements.ts`).
- Multiplicity: per grown building; a city of 25 000 / 70 000 / 200 000 buildings (`largeCity.ts:9`) -> on the order of 1-10 million element boxes city-wide before any LOD. Drawing cost depends on the render-side instancing (not in this chunk).
- Notable: many very small boxes (drains 0.35-0.6 m, bollards 0.2 m, clothes-line slabs 0.03 m thick, swing ropes 0.02 m pillars, gas cylinders, crates). Good candidates for distance culling / no shadow casting; several are pure decals in practice (drains, parking 0.12 m, pavement 0.06-0.1 m).

#### 6. Building volumes (masses) and their limits
- What: the modular building model whose `Volume`s (rectangles or outlines, storeys, roofs, reliefs, facade bays) are meshed by the building renderer.
- Location: `src/world/buildings/types.ts:150-188` (`Volume`), `:284-328` (`Building`), limits `:332-358`.
- Limits that bound mesh size: `MAX_STOREYS = 60`, `MAX_VOLUMES = 24`, `MAX_SIZE = 160 m` per side, `MIN_MODULE = 2.4 m` (bay width floor), facade `bays <= 64` per face and `pierEvery <= 16` (`validate.ts:162-167`), `roofDetails <= 32` per volume (`validate.ts:141`), reliefs per face, `MAX_ELEMENTS = 128`.
- Worst-case bays: a 160 m face / 2.4 m module = 66 bays (validate caps explicit `bays` at 64) x 60 storeys = ~3 960 bay cells per face; x4 faces x 24 volumes is the theoretical ceiling a single building record allows.
- Signature buildings: 38 tower kinds drawn by their own parts (`towerKit.ts:3-14`) - meshes defined elsewhere (`render/buildings/landmarks.ts`).

#### 7. Squares (generated plazas): paint dabs and trees
- What: per neighbourhood (420 m cell) one square: concrete paint dabs on a 1.8 m grid along the walks, and planted trees on a 9 m grid.
- Location: `src/world/cityGen/squares.ts:13`, `:133-148`.
- Counts: dabs = grid points inside the block on the walk cross (+/- 2.2 m bands and 7 m disc) at 1.8 m spacing; trees = 9 m lattice points inside the block clear of walks and 3 m from the edge, over a +/-200 m window (45 x 45 = 2 025 candidates tested). A 1 ha square yields roughly 80-110 trees.
- Notable: trees become the tree renderer's instances; dabs become terrain paint (texture, not triangles).

#### 8. Generated street graph (input to every road mesh)
- What: the street polylines of a generated city; each edge becomes a road segment whose ribbon/curve is meshed elsewhere.
- Location: `src/world/cityGen/plan.ts:20-38` `blockGrid` ('blocks' style: 120 m x 72 m blocks, avenues every 4 blocks), `:124-132`; `src/world/cityGen/streets.ts:61-176` `traceStreets` (dstep 6-8 m, up to 4 000 steps per half line), `:294-453` `planarize` (RDP simplify 1.2 m, minimum point spacing 16 m).
- Counts: blocks style nodes = (nx+1)(ny+1), edges = (nx)(ny+1) + (nx+1)(ny); nx = floor(1.7R / 120 m), ny = floor(1.7R / 72 m). Large city R = 1 600 m: nx = 22, ny = 37 -> 874 nodes, 1 652 edges, straight (no interior points). Traced styles: interior points every >= 16 m after simplification.
- Notable: interior points spaced >= 16 m bound how many polyline vertices each road ribbon starts from.

#### 9. Clouds (placed cumulus)
- What: player-placed cloud records the sky renderer draws.
- Location: `src/world/clouds.ts:24` `MAX_PLACED_CLOUDS = 24`, limits `:26-30` (size 24-640 m), period `CLOUD_SPAN = 10 240 m` (`:6`), picking sphere radius 0.55*size (`:72-93`).
- Notable: hard cap of 24 per map (doc enforces at `doc.ts:1264`, `:1278`, `:2777`).

#### 10. Elements brush (ground props and effects)
- What: brush-laid props (stones, pebbles, gravel, leaves, grass, tall grass, scrub, fern, clover, flowers, mushrooms) and effects (smoke, fire, steam, dust, soot, sparks, spray) -> instanced props / particle emitters in render.
- Location: `src/world/elements.ts:26` `MAX_ELEMENTS = 60 000`, `:45-64` default densities (gravel 120 per 100 m^2, grass 40, pebbles/clover 30), `:78-101` `scatter` (<= 400 instances per dab).
- Multiplicity: the cap is applied per tile (`doc.ts:2951-2954` TILE_CAPS) -> up to 60 000 element instances per 1 024 m tile.
- Notable: `scatter` spacing test is O(count x (nearby + out)) per dab.

#### 11. Curb ramp outlines (cut into the footway and kerb meshes)
- What: dropped-kerb quads at each zebra end and road end, used to cut the footway/kerb meshes.
- Location: `src/world/curbRamps.ts:198-203` `rampOutline` (4-point ring), `:75-109` `rampsAt`; run = min(FOOTWAY_RISE*12, sidewalk), flare = FOOTWAY_RISE*10.
- Counts: 2 ramps per crosswalk leg per node (one each side), 2 at a dead-end; each ramp outline 4 vertices. Regions of 12 x 20 m = 240 m worked out lazily.

#### 12. Fog and gully dabs
- Location: `src/world/fogPaint.ts:30` `MAX_FOG_DABS = 20 000`, `src/world/gullies.ts:14` `MAX_GULLY_DABS = 20 000` (both per tile via TILE_CAPS). `fogAt` is O(dabs) per sample (`fogPaint.ts:68-88`). Not geometry by themselves (fog density field / terrain displacement inputs).

### Budgets, caps and counters found

| Cap / counter | Value | Scope | Location |
|---|---|---|---|
| MAX_STATIONS (road elevation samples) | 400 per segment, every 1.6 m | per road | elevation.ts:43-45 |
| LATERAL ground samples | 7 per station | per road | elevation.ts:49 |
| MAX_SOLVE_PASSES | 64 | per solve | elevation.ts:86 |
| SHAPE_SHOULDER / _MAX / CUT_SHOULDER | 18 m / 36 m / 6.4 m | per road | elevation.ts:213-220 |
| elevationWork {profiles, nodes} | counter | global | elevation.ts:229 |
| MAX_VOLUMES | 24 | per building | types.ts:341 |
| MAX_STOREYS | 60 | per building | types.ts:338 |
| MAX_SIZE | 160 m | per volume side | types.ts:340 |
| MIN_MODULE / MAX_MODULE | 2.4 m / 8 m | bay width | types.ts:332-333 |
| facade bays | 1..64, pierEvery 1..16 | per face | validate.ts:162-167 |
| roofDetails | <= 32 | per volume | validate.ts:141 |
| MAX_ELEMENTS (building) | 128 (30 reserved for boundary) | per building | types.ts:358, lotPlan.ts:197 |
| MAX_ELEMENTS (brush) | 60 000 | per tile | elements.ts:26, doc.ts:2951 |
| scatter per dab | 400 | per dab | elements.ts:84 |
| MAX_PLACED_CLOUDS | 24 | per map | clouds.ts:24 |
| MAX_FOG_DABS / MAX_GULLY_DABS | 20 000 / 20 000 | per tile | fogPaint.ts:30, gullies.ts:14 |
| MAX_PAINT_DABS / MAX_TERRAIN_STAMPS / MAX_PLANTED_TREES / MAX_TREE_CLEARINGS | 60 000 / 4 096 / 20 000 / 10 000 | per tile | resolved in terrainPaint.ts, terrain.ts, trees.ts |
| TILE_CAPS (refuse, never drop) | table above | per tile | doc.ts:2950-2954, 1087-1098 |
| City scale | ~25 000 / 70 000 / 200 000 buildings at ~2.8 / 4.7 / 8.85 km | per city | largeCity.ts:9 |
| MAP_TILES | 18 (x 1 024 m = ~18.4 km) | map | wholeMap.ts:14 |
| CELL (world cell) | 256 m | filing | cells.ts:9 |
| cellWork {filed, cellsRead} | counter | global | cells.ts:40 |
| journalWork {entries} | counter | global | changes.ts:134 |
| Journal KEPT / HELD_FLOOR | 2 048 entries / 65 536 weight | diary | changes.ts:61-63 |
| conflict SWEEP_STEP | 0.4 m samples, CELL 3.2 m | per movement | conflictTable.ts:53, 68 |

### Files without geometry

All 40 files contain no GPU geometry (no three.js objects, no vertex/index buffers, no shaders). Grouped by what they are:

- `src/world/buildings/`: `tableRows.ts` (building record table as a read-only map), `towerKit.ts` (signature kind list), `types.ts` (building model and limits - limits listed above), `validate.ts` (placement checks: polygon overlap, road distance; CPU only).
- `src/world/`: `carriageway.ts` (point-on-carriageway test), `cells.ts` (256 m spatial filing), `changes.ts` (change journal), `derived.ts` (journal cursor / derived products), `doc.ts` (authoring document, tiles, undo, serialization; per-tile caps), `docBinary.ts`, `docImage.ts` (save format), `conflictPoints.ts`, `conflictTable.ts` (traffic conflict zones from swept rectangles, simulation only), `clouds.ts` (cloud records), `curbRamps.ts` (ramp outlines as data), `ecology.ts` (vegetation density fields per terrain corner, Float32 arrays - drives tree/grass scattering elsewhere), `economy.ts` (road pricing), `elements.ts` (brush records), `elevation.ts` (road height field), `fogPaint.ts`, `footwayPath.ts` (footway polylines for walkers), `geometry.ts` (segment centreline polylines), `grid.ts` (10 m / 1 m snapping), `groundPatch.ts` (terrain triangulation rule mirrored on CPU), `gullies.ts`, `heading.ts`, `ids.ts`.
- `src/world/cityGen/`: `field.ts`, `largeCity.ts`, `plan.ts`, `smallCity.ts`, `squares.ts`, `streets.ts`, `wholeMap.ts` (city plan, street graph, districts).
- `src/world/growth/`: `grownRows.ts`, `rows.ts`, `version.ts` (grown buildings as replayable rows), `lotBoundaryRuns.ts` (open stretches of a lot edge), `lotPlan.ts`, `zoning.ts` (lot layout producing volumes and element boxes).

---

## Polygon geometry audit - chunk g13 (src/world: junctions, network, lots, markings, roads/*, misc)

Scope note: every file in this chunk lives in `src/world`, the pure-data/world-model layer. **None of these files creates a
three.js object, a BufferGeometry, an InstancedMesh, a shader or a draw call.** What they do produce is the 2D *source polygonry*
that the renderer (outside this chunk: `render/mesh/*`, `render/markings.ts`, `render/networkFarRoads.ts`, `render/structures.ts`,
`render/natureTrees.ts`, walkway/lane overlays...) triangulates, extrudes, strokes or instances. So the "elements" below are the
outline rings, polylines, stroke specs, bar quads, placement grids and spacing constants whose vertex counts and multiplicities
directly set the triangle counts downstream. Triangle counts given are for the obvious downstream treatment (ring fan/earcut:
`n-2` triangles; stroke segment as a quad: 2 triangles) and are labelled as estimates where the render side is not in this chunk.

Numbers resolved outside the list (read only to resolve a constant, by grep/partial read):
- `src/core/units.ts`: `METERS_PER_UNIT = 1`, `m(x) = x` (1 world unit = 1 m).
- `src/core/scalar.ts`: `ARC_TOL = 0.008 m` (arc flattening chord error), `FLATTEN_TOL = 0.02 m`, `MIN_RIBBON = 0.2 m`,
  `SEAM_OVERLAP = 0.1 m`, `SURFACE_END_STEP = 0.00004 m`, `TAPER_ANGLE = 12 deg`, `CORNER_MITER = 2.5`.
- `src/core/ring.ts` (lines ~89-115): an arc edge is flattened with step `2*acos(1 - ARC_TOL/r)` (r < ARC_TOL: one step of pi).
- `src/core/bezier.ts` (lines 40-67): a curved segment centreline = quadratic flattened into `clamp(ceil(sqrt(d/(4*0.02))), 1, 64)`
  steps (d = |a + b - 2c|); a straight segment = 2 points.
- `src/core/fillet.ts`: `curbRadius = clamp(0.5*min(hwA,hwB), 2.8 m, 7.2 m)`, `CURB_R_MAX = 7.2 m`.
- `src/world/geometry.ts` lines 1-60 (segmentLine/frameFromNode).

### Files read

All 80 files read completely, first line to last (Read tool, whole file; `lots.ts` in two parts 1-700 and 700-1329;
`roads/connectors.ts` lines 1-38 seen in a cat preview and 39-84 with Read).

| File | Lines |
|---|---|
| src/world/junction/build.ts | 312 |
| src/world/junction/bulb.ts | 135 |
| src/world/junction/corners.ts | 219 |
| src/world/junction/derive.ts | 198 |
| src/world/junction/legs.ts | 188 |
| src/world/junction/levels.ts | 342 |
| src/world/junction/mouthOverlap.ts | 25 |
| src/world/junction/polygon.ts | 238 |
| src/world/junction/transition.ts | 119 |
| src/world/junction/trim.ts | 54 |
| src/world/junction/trimSummary.ts | 41 |
| src/world/junctionBuild.ts | 415 |
| src/world/junctionTurns.ts | 83 |
| src/world/landscape.ts | 414 |
| src/world/lanelets.ts | 845 |
| src/world/legAngles.ts | 44 |
| src/world/lotRecord.ts | 26 |
| src/world/lotRings.ts | 66 |
| src/world/lotStore.ts | 451 |
| src/world/lots.ts | 1329 |
| src/world/markings.ts | 464 |
| src/world/nearestRibbon.ts | 21 |
| src/world/network.ts | 380 |
| src/world/networkBuild.ts | 797 |
| src/world/networkDelta.ts | 122 |
| src/world/networkLength.ts | 44 |
| src/world/openLots.ts | 286 |
| src/world/parking.ts | 69 |
| src/world/parkingLayout.ts | 251 |
| src/world/paving.ts | 63 |
| src/world/pedestrianAccess.ts | 6 |
| src/world/pointFiling.ts | 113 |
| src/world/poleIndex.ts | 121 |
| src/world/poleLines.ts | 573 |
| src/world/rampRise.ts | 94 |
| src/world/rasterGrid.ts | 31 |
| src/world/rebuildWork.ts | 5 |
| src/world/rescale.ts | 132 |
| src/world/ribbons.ts | 211 |
| src/world/roadField.ts | 750 |
| src/world/roadSection.ts | 270 |
| src/world/roadTypes.ts | 427 |
| src/world/roads/buildMode.ts | 124 |
| src/world/roads/catalog.ts | 109 |
| src/world/roads/connectors.ts | 83 |
| src/world/roads/derivedSigns.ts | 83 |
| src/world/roads/footwayRise.ts | 91 |
| src/world/roads/furnitureCatalog.ts | 28 |
| src/world/roads/furnitureSets.ts | 164 |
| src/world/roads/laneEnds.ts | 41 |
| src/world/roads/markingStyle.ts | 86 |
| src/world/roads/profile.ts | 267 |
| src/world/roads/rules.ts | 142 |
| src/world/roads/streetChain.ts | 68 |
| src/world/roads/streetNames.ts | 141 |
| src/world/roads/templates.ts | 89 |
| src/world/roads/tuning.ts | 85 |
| src/world/section.ts | 105 |
| src/world/signalPosts.ts | 76 |
| src/world/solids.ts | 152 |
| src/world/streetFurniture.ts | 123 |
| src/world/structures.ts | 75 |
| src/world/surfaceParts.ts | 58 |
| src/world/surfaces.ts | 150 |
| src/world/sweptBodies.ts | 54 |
| src/world/terrain.ts | 295 |
| src/world/terrainPaint.ts | 37 |
| src/world/tileIndex.ts | 140 |
| src/world/tiles.ts | 91 |
| src/world/transit.ts | 368 |
| src/world/trees.ts | 88 |
| src/world/turnChoice.ts | 12 |
| src/world/turnDigest.ts | 27 |
| src/world/turnPaths.ts | 632 |
| src/world/units.ts | 2 |
| src/world/utilities.ts | 161 |
| src/world/viewCells.ts | 342 |
| src/world/waiting.ts | 13 |
| src/world/walkable.ts | 136 |
| src/world/walkingLines.ts | 403 |
| **Total (80 files)** | **15,915** (wc -l) |

Nothing was left unread.

### Elements

Surface levels everywhere below: `Level.Casing=1, Sidewalk=2, Curb=3, Asphalt=4` (roadTypes.ts:10-23); half-widths
`Asphalt = width/2`, `Curb = width/2 + 0.15`, `Sidewalk = width/2 + sidewalk`, `Casing = width/2 + sidewalk + 1.0` (roadTypes.ts:339-350).
Every road and every junction produces one outline ring PER LEVEL (4 levels), so each count below is multiplied by up to 4
before the renderer unions/differences them into bands (surfaces.ts `bands`: casing verge, footway, kerb, carriageway).

#### E1. Road ribbon outline ("carriageway/kerb/footway/verge strip of one road segment", one ring per level)
- Location: ribbons.ts `ribbonParts` 121-144, `ribbonRing` 168-175, `overlapUntrimmedEnds` 147-165; made by `makeRibbon` 104 /
  `leanRibbon` 112; called from networkBuild.ts `buildRibbon` 781-790.
- Primitive: closed 2D polygon (Ring of line edges), `left offset + reversed right offset` (offsetPolyline both sides). Triangulated downstream.
- Counts: centreline points P = 2 for a straight road; `steps+1` (max 65) for a curved one, steps = `clamp(ceil(sqrt(|a+b-2c|/0.08)),1,64)`.
  Ring vertices = 2P (offsetPolyline may add join points). Straight road: **4 verts / 2 tris per level, 16 verts / 8 tris for the 4 levels**.
  Fully curved road (64 steps): 130 verts / 128 tris per level, 520 verts / 512 tris for 4 levels (before union/difference).
- Attributes: CPU Float64 (Polyline.xy) only; no GPU attributes here.
- Multiplicity: one per segment x 4 levels. LeanRibbon recomputes levels on demand, cache `HELD_RIBBONS = 1024` (ribbons.ts 65).
- Notable: bends at two-leg nodes push the untrimmed end out by `hw*tan(bend/2)` (capped at 20 deg) to overlap the neighbour
  (overlap is hidden by nonzero union); ends pulled `SEAM_OVERLAP` 0.1 m into the junction - intentional overlap geometry.

#### E2. Junction corner ring ("junction plate / intersection surface", per level)
- Location: junction/polygon.ts `buildJunctionRing` 109-211 (Asphalt and any level not derivable); junction/derive.ts
  `deriveFromLegs` 56-186 (Casing/Sidewalk/Curb carried out from the carriageway); junction/build.ts `buildJunction` 150-312;
  networkBuild.ts `solveNode` 617-645.
- Primitive: closed ring of line edges + arc edges (curb returns), flattened by Ring.flatten (ARC_TOL 8 mm).
- Counts per n-leg junction (n mouths): 2n mouth corners + per corner either
  - fillet: 1 line + arc of `ceil(psi_sweep / (2*acos(1-0.008/r)))` segments; for a 90 deg corner: r = 2.8 m -> **11 segments**,
    r = 7.2 m (CURB_R_MAX) -> **17 segments**; or
  - bevel/chord/collinear/taper: 2 points.
  Typical 4-leg cross at Asphalt: 8 mouth points + 4 x ~12 arc points ~= **56 verts -> ~54 tris**; 3-leg T ~= 6 + 3 x 12 ~= 42 verts.
  Derived outer levels (derive.ts 107-136): equal-width sides keep an arc (radius r - offset: fewer segments); unequal sides use
  `BLEND_STEPS = 16` points (derive.ts 27, 127-134); squared footway backs (derive.ts 102-106) use 1 point.
  Hull fallback (polygon.ts 201-210): convex hull of 2n mouth points.
- Multiplicity: per junction node x 4 levels. Outer levels re-derived on demand, caches `HELD_LEVELS = 512` per level and
  `HELD_RINGS = 1024` (levels.ts 27-29). Up to 3 passes per node (j1/j2/j3, networkBuild.ts 311-387) but only the last is kept whole.

#### E3. Leg tongues ("rectangle of carriageway from the node out to each mouth")
- Location: junction/polygon.ts `legTongue` 63-76 (used by buildJunctionRing 120, derive.ts 172, levels.ts `fill` 47-51, bulb.ts 72-73).
- Primitive: 4-point ring. **4 verts / 2 tris per leg per level**; omitted when trim <= COARSE_EPS.
- Multiplicity: n per junction x 4 levels (3-leg: 12 quads; 4-leg: 16 quads).
- Notable: the tongues are fully covered by the corner ring + ribbon overlap for ordinary junctions; they exist to fill gaps.
  If the renderer triangulates `junction.rings` without unioning, they are **hidden duplicate faces** (overdraw, extra triangles).
  The comment says "unioned by the painter" (build.ts 54), so check the render side.

#### E4. Node cap ("disc over the node when all legs leave on one side")
- Location: junction/polygon.ts `nodeCap` 82-106, `CAP_STEPS = 24` (79).
- Primitive: 24-point polygon. **24 verts / 22 tris** per level where the widest gap between legs > 180 deg.
- Multiplicity: such junctions only (sharp Y/V junctions), x 4 levels.
- Notable: like tongues, mostly covered by other rings - duplicate faces unless unioned.

#### E5. Transition / taper ring ("one road carrying on at another width, or a continuous bend")
- Location: junction/transition.ts `transitionRing` 109-119, `TransitionAxis.samples` 95-100 (`SAMPLE_STEP = 1.6 m`, min 8 steps).
- Primitive: 2 x (count+1) point polygon, count = `max(8, ceil(chord/1.6))`. Taper run = `max(9.6 m, 8*step)/2` per leg.
  Typical 9.6 m taper: count 8 -> **18 verts / 16 tris per level, 72 verts for 4 levels**.
- Multiplicity: two-leg nodes with a width change or a bend < 55 deg, or a structure seam (build.ts 202-247).

#### E6. Turning circle ("bulb" at a road's end)
- Location: junction/bulb.ts `outline` 27-55, `buildBulb` 58-78; `BULB_RADIUS = 13 m`, `BULB_RETURN = 7.5 m`.
- Primitive: ring: 2 mouth lines + 2 kerb-return arcs (r ~7.5 m) + the big arc (r = 13 m + grow).
- Counts (local road, hw 3 m, Asphalt): big arc sweep ~298 deg / step 0.0702 rad -> **~75 segments**; each return ~59 deg / step
  0.0924 rad -> ~12 segments; total **~100 verts / ~98 tris per level**, plus one 4-vert tongue. Outer levels are larger radius -> more
  segments (~80+). x 4 levels => ~400 verts per bulb.
- Notable: the 8 mm chord tolerance gives ~75 segments on a 13 m circle - very fine for a surface seen from above; a 2-3 cm tolerance
  would halve it. `bulbLine` (81-91) makes the same outline as a line (lane/footway paint).

#### E7. Curved-mouth overlap strip ("strip of a curved road's full width laid across a junction mouth")
- Location: junction/mouthOverlap.ts 12-25 (REACH 2 m, STEP 0.5 m); duplicated inline in surfaces.ts `levelRingsOf` 91-113.
- Primitive: polygon, `count = max(2, ceil(4/0.5)) = 8` -> 9 cross-sections -> **18 verts / 16 tris**.
- Multiplicity: per curved segment end at a node of degree >= 2, per level (surfaces.ts) - i.e. up to 2 x 4 = 8 strips per curved road.
- Notable: the strip overlaps both ribbon and junction ring entirely (duplicate area, hidden by the union). Same code exists twice
  (mouthOverlap.ts and surfaces.ts) - easy drift.

#### E8. Level polygons / bands (union of all rings of a level)
- Location: surfaces.ts `levelRingsOf` 81-126, `levelPolygons` 129, `surfaces` 133, `bands` 142-149 (Clipper union/difference).
- Primitive: MultiPoly (outer + holes) per level; `bands` = casing\sidewalk, sidewalk\curb, curb\asphalt, asphalt.
- Counts: sum of E1-E7 vertices after union (union removes interior vertices, adds intersection points).
- Multiplicity: whole map (surfaces) or per region/cell (levelRingsOf with given ribbons/junctions). Used by poleLines, walkable, lots, walkingLines too.

#### E9. Lane markings ("painted lines along a segment": centre line, lane dividers, double line)
- Location: markings.ts `segmentMarkings` 48-117 (StrokeSpec: points, width, colour, dash in world units).
- Primitive: polyline strokes (the renderer turns each segment into a quad / dashes).
- Counts per road: centreline points (2 straight, <= 65 curved) per stroke; strokes: centre line 1 (double: 2, widths 0.12/0.16 m);
  one-way: `lanes-1` dividers; two-way 'lanes': `2*(lpd-1)` dividers (+1 centre if no median). Dash: classic 3.2/3.2 m; regional
  3/6, 3/9, 4/12 m (markingStyle.ts 27-41). Downstream estimate: a 100 m dashed line at 3.2/3.2 = ~16 dash quads = 32 tris.
- Multiplicity: per segment; avenue (4 lanes, no median): 1 solid centre + 2 dividers; boulevard: 2 dividers.

#### E10. Lane turn arrows
- Location: markings.ts `laneArrowMarkings` 206-248.
- Primitive: short strokes width 0.12 m. Per lane: stem 1 segment; through: +1 shaft +2 head segments; each of left/right: +2 +2 segments.
  e.g. `leftThrough` = **8 stroke segments (~16 tris)** per lane.
- Multiplicity: lanes with an explicit turn rule, approaches >= 19.2 m long.

#### E11. Road legends: "PARE"/"STOP", yield triangle, bus "ONIBUS"/"BUS"
- Location: markings.ts `busLegends` 124-142 (every `LEGEND_EVERY = 70 m` from 12 m), `paintInLane` 145-161, `approachLegendsAt`
  174-203; glyph strokes markingStyle.ts `GLYPHS` 48-68 (`ring()` = 17 points = 16 segments for O/Ô), `YIELD_SYMBOL` 71-74.
- Counts (stroke segments, width 0.2 m stop / 0.16 m yield): "PARE" = 6+3+7+4 = **20**; "STOP" = 11+2+16+6 = **35**;
  "ÔNIBUS" = 18+3+1+10+5+11 = **48**; "BUS" = 26; yield symbol = **6**. ~2 tris each (+ joins downstream).
- Multiplicity: PARE/yield per lane per stop/yield approach of 3+-leg nodes; bus legend per bus lane every 70 m.
- Notable: each letter vertex is placed by `centre.sampleAt` (follows the curve) - fine.

#### E12. Mini-roundabout painted island
- Location: markings.ts `miniRoundaboutAt` 452-464.
- Primitive: concentric closed strokes of **41 points (40 segments)** each: outer ring (0.2 m wide) + fill rings every 0.22 m (0.248 m wide)
  from r-0.22 down to 0.12 m; r = clamp(0.4*min mouth, 2 m, 4 m).
- Counts: r = 4 m -> 1 + 17 rings = **18 x 40 = 720 stroke segments (~1,440 tris + joins)**; r = 2 m -> 9 x 40 = 360 segments.
- Notable (performance): a filled disc drawn as up to 18 overlapping stroke rings (0.248 wide at 0.22 pitch -> overlapping overdraw).
  A single 40-segment disc would be **38-40 triangles** instead of ~1,440. Biggest triangle waste found in this chunk per item.

#### E13. Transition (taper) markings
- Location: markings.ts `transitionMarkings` 399-449.
- Primitive: strokes along `TransitionAxis.offset` -> `count+1` points each (count >= 8, 1.6 m step); median nose 2 strokes (0.28 m)
  or centre line split in 2; `2*(shared-1)` dashed lane lines.

#### E14. Stop bars and zebra crosswalk bars
- Location: markings.ts `stopBar` 262-284 (width `STOP_BAR_WIDTH`), `crosswalkBars` 287-297, `zebraBars` 300-331 (bar 0.5 m, gap 0.5 m,
  0.3 m kerb margin), `junctionDetail` 334-341, `junctionDetailAt` 344-365, `midBlockDetailAt` 368-396.
- Primitive: `Bar {a, b, width}` = one quad (4 verts / 2 tris) each.
- Counts per crossing: bars = `floor((span + 0.5)/1.0)` per carriageway stretch, span = width - 0.6 (or each side of a median):
  local 6 m: **5 bars**; urban 8 m: **7**; avenue 14 m: **13**; boulevard 18 m + 2 m median: 7 + 7 = **14** -> 10-28 tris per crossing.
  Stop bar: 1 quad per approaching leg of a 3+-leg junction.
- Multiplicity: per leg with a crossing (not on highways/ramps), plus mid-block crossings.

#### E15. Parking paint and bays
- Location: parkingLayout.ts `parkingOf` 104-183, `stations` 186-191 (`RUN_STEP = 1 m`), bays at `PARKING_PITCH.parallel = 6 m` (parking.ts 24-28).
- Primitive: ParkingLine polylines + ParkingBay quads (bay = 4 corners, used for parked-car placement).
  - bay divider: 2-point stroke per bay (0.12 m);
  - run end lines: 2 x 2-point strokes per run;
  - parking-lane edge: dashed (1 m / 1 m) polyline with **1 point per metre**;
  - no-parking yellow line: solid polyline with **1 point per metre**;
  - cycle lane: red band (width depth-0.1) + white line, `ceil(len/2)+1` points (1 per 2 m).
- Multiplicity: per side with parking per segment (100 m of parked kerb ~ 16 bays, 17 dividers, ~100-point dashed edge).
- Notable: the 1 point/m sampling is applied even on straight roads, where 2 points would give the same line: a 100 m straight
  yellow line becomes ~100 segments instead of 1 (render joins add more). Sampling only on curved ribbons, or at the polyline's own
  vertices, would cut these strokes ~50-100x on straight streets.

#### E16. Lanelet link centrelines and junction connector (turn) paths
- Location: lanelets.ts `buildSegmentLinks` 447-540 (offsetPolyline of trimmed centre + `clipToEndSections` 818-825);
  turnPaths.ts `bezierTurn` 144-171 (`STEPS = 48` -> **49 points**, cosine spaced), `twoPieceTurn` 489-510 (**49 points**),
  `bulbTurnPath` 406-442 (25 + ~1 point per metre of arc + 24), `medianUturnPath` 448-475 (`max(12, ceil(pi*r/0.5))+1` points).
- Primitive: polylines (sim data). They become GPU geometry only where an overlay/debug view or lane-connector editor draws them
  (render side, not in this chunk).
- Multiplicity: per lane per direction per segment (links); per movement per junction (connectors: e.g. 4-leg 2+2 lanes ~ 16-24 connectors x 49 pts).
- Notable: the sweep (`sweep` 284-364) is CPU collision work, no geometry; WAYPOINTS 5x5 grid x 2 shares candidates (553-559).

#### E17. Walking lines ("pedestrian walkway centre lines round corners")
- Location: walkingLines.ts `cornerPath` 47-71 (arc step pi/24 = 7.5 deg), `hermite` 30-44 (`CURVE_STEPS = 10` -> 11 points),
  `stretch` 248-278 (**a point every 0.2 m**), `roundCorner` 294-371 (resample to that count, 3 smoothing passes),
  `LocalLines.at` 137-148 (Clipper inflate, round joins, arc tol 0.008 m).
- Primitive: polylines (walkway paths; drawn by `walkways.ts`/render if displayed).
- Counts: a corner stretch of ~10 m -> ~51 points.
- Notable: 20 cm spacing is set for the smoothing; if these polylines are drawn (walkway debug/overlay) they are dense. Decimating
  after smoothing (e.g. Douglas-Peucker at 1-2 cm) would cut them several times.

#### E18. Pole lines (kerb contour inset where utility poles stand)
- Location: poleLines.ts `contoursOf` 159-168 (`inflatePathsD` round joins, arc tolerance 0.008 m), `poleLinesOf` 230-257,
  `markPlates` 384-472 (raster labelling).
- Primitive: closed contours (CPU, placement); the `paving/kerbed` MultiPoly are CPU only. Not drawn here.

#### E19. Utility wires and poles (sizes and segment counts)
- Location: utilities.ts constants 9-41: `POLE_HEIGHT 8.5 m`, radius 0.11 top / 0.18 base, arm half 0.85 m, arm thickness 0.1 m,
  `WIRE_COURSES` 3 heights x `WIRE_OFFSETS` 3 positions = **9 wires per span**, `WIRE_SEGMENTS = 8` points per span (sag
  `min(1.4 m, 1.8% of length)`), lamp head 0.5 x 0.14 x 0.26 m; `poleArms` 93-161 (1 arm per pole, more at corners >= 60 deg).
- Counts (downstream): if a wire is a line strip: 9 x 7 segments = **63 line segments per span** (comment says "points": 8 points -> 7 segments);
  if tubes, x radial segments. Pole mesh built in render (not here).
- Multiplicity: spans and poles; pole spacing 38 m (18-80 m) (roads/tuning.ts 54-60); lamp on every other pole (`poleCarriesLamp`).

#### E20. Street furniture placement (drives instanced prop counts)
- Location: roads/furnitureCatalog.ts 17-26, roads/furnitureSets.ts `furnitureFor` 71-164, streetFurniture.ts `streetFurniture` 114-123,
  landscape.ts `snapLandscape` 326-377, radii `LANDSCAPE_RADIUS` 57-70.
- Spacing per side of a street ("complete" set): lamp every 30 m (left side staggered 15 m), bin 60 m, hydrant 100 m (right side only),
  bench 60 m, tree 10 m (or down a planted median every 10 m); "basic" = lamps + bins. Shrub 3 m, postbox 200 m, drain 30 m (not in sets).
- Per 100 m of complete street (both sides): ~20 trees, ~6-7 lamps, ~3 bins, ~3 benches, ~1 hydrant.
- Primitive: points only here; each is an instance of a render-side model.
- Notable: trees every 10 m both sides dominate the instance count of street props.

#### E21. Derived signs and signal posts (placement of sign/post instances)
- Location: roads/derivedSigns.ts `signsAtNode` 27-61 (stop/yield plate per arriving leg; speed plate 14 m past the mouth on legs >= 60 m,
  regional styles only); signalPosts.ts `signalPostPlace` 25-45 (`SIGNAL_POST_KERB 0.9 m`, radius 0.17 m), `signalPosts` 53-76
  (one post per signalised approach).
- Primitive: points + yaw/facing; meshes built in render.

#### E22. Structure dimensions (bridge/elevated decks, tunnels, piers)
- Location: structures.ts 29-75 (`TUNNEL_HEADROOM 4.4 m`, `TUNNEL_ARCH 0.6 m`, deck thickness ground 0.22 / elevated 1.04 / bridge 0.96 /
  tunnel 0.24 m, `RAISED_LIFT 2 m`); roads/tuning.ts piers `spacingElevated 29.6 m`, `spacingBridge 38.4 m` (47-53).
- Multiplicity: one pier/bent per 29.6 m of elevated road, per 38.4 m of bridge (mesh in render/structures.ts).

#### E23. Lots (zone overlays / lot outlines, building frames)
- Location: lots.ts (`blockPlan` 705-776, `streetPlan` 779-854, `landLot` 861-868 via Clipper difference, `squareCorners` 1120-1143,
  `curveLotSide` 1196-1224 adds **11 interior points per curved side** (12 steps), `lotRect` 1034-1041 (4 corners), `cutLines` 951-974,
  `lotBuildFrame` 61-111 (N = up to 160 depth strips, CPU only)); lotRecord.ts, lotRings.ts (`hull`, `orientedBox`, `simplifyRing` at 1 cm).
- Primitive: arbitrary polygons (typically 4-8 corners after `simplifyRing(..., 0.01)`), drawn downstream as zone tint/outline overlays.
- Multiplicity: one per lot (cities of 25k-70k buildings: tens of thousands of rings). Planning raster cells 2 m (`RASTER`), tiles 64x64.

#### E24. Rail tracks / transit stops (polylines and points)
- Location: transit.ts `RailTrack.points` 28-33, `railGraph` 164-204, `railPath` 302-349 (Dijkstra path as points).
- Primitive: user-drawn polylines; stops are points. Meshes in render.

#### E25. Terrain stamp and paint dab inputs (drive the terrain mesh/texture, not built here)
- Location: terrain.ts (`MAX_TERRAIN_STAMPS = 4096`, heights -144..224 m, `TerrainIndex` cell 64 m, `sampleTerrainHeight` 218-292);
  terrainPaint.ts `MAX_PAINT_DABS = 60,000`.
- Notable: terrain.ts 49-50 comment says `MIN_HARD_WALL` is "two cells of the drawn terrain grid (6.4 m)" but the value is `m(12.8)`
  = 12.8 m - either the comment or the value is stale (implies a terrain grid cell of 6.4 m, not 3.2 m).

#### E26. Planted trees (instance source)
- Location: trees.ts: `MAX_PLANTED_TREES = 20,000`, `MAX_TREE_CLEARINGS = 10,000`, `plantTrees` <= 200 trees per brush dab,
  6 model slots (`MODEL_COUNT`), default brush 120 trees/ha, 6 m spacing.

#### E27. View-cell residency budgets (GPU byte budgets for cell products)
- Location: viewCells.ts `ViewCells` 95-342 (`cpuBudget`, `gpuBudget`, `ViewCells.gpuShare` set from `render/quality.ts` GEOMETRY_BUDGETS,
  LRU eviction, `ENTRY_BYTES 96`, lead 1.5 s, behind factor 2).
- Not geometry itself; it is the cap mechanism for per-cell GPU geometry (far props, poles).

### Budgets, caps and counters found

| What | Value | Where |
|---|---|---|
| Arc flatten tolerance (junction returns, bulbs, Clipper inflate) | 0.008 m | core/scalar.ts ARC_TOL (used by Ring.flatten, poleLines 164, walkingLines 144) |
| Curve flatten tolerance / max steps (segment centrelines) | 0.02 m / 64 steps | core/bezier.ts |
| Junction node cap circle | 24 points | junction/polygon.ts 79 |
| Unequal-width curb return blend | 16 points | junction/derive.ts 27 |
| Transition sample step / min samples | 1.6 m / 8 | junction/transition.ts 17, 96 |
| Mouth overlap strip | 2 m each side, 0.5 m step (9 sections) | junction/mouthOverlap.ts 5-7, surfaces.ts 102-106 |
| Turning circle radius / return | 13 m / 7.5 m | junction/bulb.ts 16, 21 |
| Turn path samples | 48 steps (49 pts) | turnPaths.ts 24 |
| Mini roundabout ring points | 41 | markings.ts 457 |
| Glyph ring points | 17 | markings.ts / markingStyle.ts 64 |
| Parking paint sampling | 1 point / m (cycle: 1 / 2 m) | parkingLayout.ts 56, 130 |
| Walking line stretch sampling | 0.2 m | walkingLines.ts 271 |
| Wire points per span / wires per span | 8 / 9 | utilities.ts 41, 19-21 |
| Pole spacing | 38 m (18-80) | roads/tuning.ts 54-59 |
| Pier spacing elevated / bridge | 29.6 m / 38.4 m | roads/tuning.ts 48-50 |
| Held derived junction levels (per level) / rings | 512 / 1024 | junction/levels.ts 27-29 |
| Held ribbon level parts | 1024 | ribbons.ts 65 |
| Walkable cells kept | 128 (~50 KB each) | walkable.ts 12 |
| View cell GPU/CPU budgets + quality share | spec-defined, `ViewCells.gpuShare` | viewCells.ts 46-49, 97 |
| Terrain stamps / paint dabs / planted trees / clearings | 4096 / 60,000 / 20,000 / 10,000 | terrain.ts 36, terrainPaint.ts 37, trees.ts 40-41 |
| Trees per brush dab | 200 | trees.ts 70 |
| Lane links per node | 128 | roads/connectors.ts 14 |
| Lane count per road | 1-8 | roadTypes.ts 239-240 |
| Work counters | `networkWork`, `rebuildWork` (rebuildWork.ts), `laneletWork` (lanelets.ts 127), `lotPlanWork` (lots.ts 163), `poleLinesWork` (poleLines.ts 184), `kerbWork` (poleLines.ts 487), `ViewCells.work` | CPU work counters, no triangle counters in this chunk |

No triangle or vertex budget per quality level exists in this chunk (only the `ViewCells.gpuShare` hook).

### Performance notes (summary)

1. **Mini roundabout** (markings.ts 452-464): filled disc drawn as up to 18 concentric 40-segment strokes = ~720 segments (~1,440+ tris)
   per roundabout with overlapping overdraw; a single filled 40-gon would be ~40 tris.
2. **Parking and no-parking lines** (parkingLayout.ts 172, 180, 186-191): 1 point per metre even on straight streets: ~100 segments
   per 100 m where 1-2 would do; multiplied by both kerbs of every parked street.
3. **Bulb (turning circle)** at 8 mm chord tolerance: ~75 segments on the 13 m arc, ~100 verts per level, x 4 levels.
   Curb returns at 8 mm: 11-17 segments per 90 deg corner per level. A coarser tolerance for the outer levels (casing, footway back)
   or for far LODs would cut junction vertex counts substantially.
4. **Overlapping helper rings**: leg tongues (4 verts each), node caps (24 verts), curved-mouth overlap strips (18 verts) and the ribbon
   seam overlap all lie on top of other rings. They are cheap if the renderer unions per level (surfaces.ts does via Clipper); if any
   render path triangulates `junction.rings` directly, they are duplicate faces.
5. **Duplicated strip code**: mouthOverlap.ts and surfaces.ts 91-113 build the same strip independently.
6. **Walking lines** sampled every 0.2 m (walkingLines.ts 271) - dense if drawn.
7. Stale comment: terrain.ts 49-50 (12.8 m value vs "6.4 m" comment).

### Files without geometry

Pure logic / data, no polygon, line or point generation and no size constants that drive mesh counts:
- src/world/junction: trim.ts, trimSummary.ts, legs.ts (leg frames only), corners.ts (corner/fillet solver; feeds E2), levels.ts (caching of E2/E3; caps listed)
- src/world: junctionBuild.ts (movement topology; calls E16 builders), junctionTurns.ts, legAngles.ts, lotRecord.ts, lotStore.ts, openLots.ts,
  nearestRibbon.ts, network.ts (crossing distances, stop lines), networkBuild.ts (incremental solve; orchestrates E1/E2), networkDelta.ts,
  networkLength.ts, parking.ts (constants used by E15), paving.ts, pedestrianAccess.ts, pointFiling.ts, poleIndex.ts, rampRise.ts,
  rasterGrid.ts, rebuildWork.ts, rescale.ts, roadField.ts (height field reads, spatial index, typed-array packing), roadSection.ts,
  roadTypes.ts (widths used by all), section.ts (furniture zones), solids.ts (collision discs/capsules, CPU), surfaceParts.ts,
  sweptBodies.ts, tileIndex.ts, tiles.ts (1,024 m tiles), turnChoice.ts, turnDigest.ts, units.ts, viewCells.ts (budget mechanism only),
  waiting.ts, walkable.ts (CPU region index), landscape.ts (placement rules), streetFurniture.ts (placement), signalPosts.ts (placement),
  structures.ts (dimensions only), terrain.ts / terrainPaint.ts (height function and caps), trees.ts (instance records), transit.ts (records/graph),
  utilities.ts (dimensions and wire sampling constants)
- src/world/roads: buildMode.ts, catalog.ts, connectors.ts, derivedSigns.ts (placement), footwayRise.ts, furnitureCatalog.ts (spacing),
  furnitureSets.ts (placement), laneEnds.ts, markingStyle.ts (glyph strokes, E11), profile.ts, rules.ts, streetChain.ts, streetNames.ts,
  templates.ts, tuning.ts (spacing constants)

---

## Polygon geometry audit — chunk g14

Scope: `src/world/walkways.ts`, `weather.ts`, `zoneGrid.ts`, `zones.ts` and 56 files under `scripts/` (tooling, probes, Vite plugins, the MakeHuman importer).
Summary: no file in this chunk builds GPU geometry (no three.js geometry, BufferGeometry, InstancedMesh, shader-generated vertices). The chunk holds:
- (a) world-side data that later feeds meshes built elsewhere (walkway centrelines, zone cell quads);
- (b) one offline mesh importer (MakeHuman proxy clothing/hair -> `.bin`), which fixes the vertex/triangle counts and vertex layout of imported people items;
- (c) the project's triangle/draw-call counters, budgets and measuring scripts. Several of them count triangles in ways that do not match what the GPU draws; see the notes under "Budgets, caps and counters".

### Files read

All files were read in full, from the first line to the last. Long files were read in sequential parts:
- `scripts/check-code.mjs`, `scripts/diagnose/report.mjs` and `scripts/probe/run.mjs` were read through persisted full outputs.
- `scripts/probe/analyze.mjs` was read in two parts: lines 1-568, then 569-734.

| file | lines |
|---|---:|
| src/world/walkways.ts | 673 |
| src/world/weather.ts | 54 |
| src/world/zoneGrid.ts | 313 |
| src/world/zones.ts | 39 |
| scripts/accuse.mjs | 267 |
| scripts/bake-people-pics.mjs | 27 |
| scripts/buildingParts.mjs | 52 |
| scripts/check-code.mjs | 655 |
| scripts/check-code/program.mjs | 62 |
| scripts/check-code/units.mjs | 210 |
| scripts/check-refs.mjs | 97 |
| scripts/check.mjs | 188 |
| scripts/cook-cities.mjs | 32 |
| scripts/cook-people.mjs | 34 |
| scripts/diagnose/diagnose.mjs | 578 |
| scripts/diagnose/instrument.mjs | 88 |
| scripts/diagnose/quality.mjs | 60 |
| scripts/diagnose/report.mjs | 225 |
| scripts/diagnose/server.mjs | 80 |
| scripts/diagnose/sources.mjs | 59 |
| scripts/diagnose/staticRules.mjs | 54 |
| scripts/frames.mjs | 67 |
| scripts/gpuSteady.mjs | 30 |
| scripts/import-makehuman-pack.py | 243 |
| scripts/knip-check.mjs | 38 |
| scripts/lab/coverage.mjs | 278 |
| scripts/lab/sweep.mjs | 104 |
| scripts/lab/verify.mjs | 36 |
| scripts/lab/verify/common.js | 19 |
| scripts/lab/verify/step1.js | 52 |
| scripts/lab/verify/step2.js | 27 |
| scripts/lab/verify/step3.js | 58 |
| scripts/lab/verify/step4.js | 62 |
| scripts/lab/verify/step5.js | 80 |
| scripts/layers.mjs | 76 |
| scripts/lib/measureCity.mjs | 159 |
| scripts/look-compare.mjs | 97 |
| scripts/look.mjs | 685 |
| scripts/material.mjs | 52 |
| scripts/materialEach.mjs | 55 |
| scripts/package-desktop.mjs | 102 |
| scripts/probe.mjs | 575 |
| scripts/probe/analyze.mjs | 733 (734 with the trailing newline as Read shows it) |
| scripts/probe/collect.mjs | 116 |
| scripts/probe/page.mjs | 199 |
| scripts/probe/plan.mjs | 286 |
| scripts/probe/run.mjs | 251 |
| scripts/probe/sources.mjs | 57 |
| scripts/run-limited.mjs | 60 |
| scripts/sessionJob.mjs | 88 |
| scripts/shellMaps.mjs | 69 |
| scripts/verify.mjs | 84 |
| scripts/vite/build-stamp.ts | 124 |
| scripts/vite/cook-plugin.ts | 215 |
| scripts/vite/desktop-jobs.config.ts | 17 |
| scripts/vite/ktx2.ts | 218 |
| scripts/vite/labReports.ts | 96 |
| scripts/vite/labSource.ts | 114 |
| scripts/vite/model-urls-plugin.ts | 48 |
| scripts/vite/surface-bake-plugin.ts | 150 |
| **total** | **9 667** (`wc -l`) |

One file outside the list was opened: `src/core/perfBudget.ts`, lines 42-47 only (Grep). This was done to confirm the VIEW_BUDGETS numbers that `scripts/diagnose/report.mjs` copies.

### Elements

#### E1. MakeHuman community proxy items (clothes, hair, shoes, hats, glasses, eyebrows, eyelashes...): imported meshes
- **What it is:** the wardrobe and hair meshes worn by the people, converted offline from MakeHuman `.mhclo` + `.obj` into `public/models/people/proxies/<name>.bin` + `.json` (format `roadcraft-people-proxy/1`).
- **Location:**
  - `scripts/import-makehuman-pack.py:138` (`convert`), `:99` (`parse_obj`), `:43` (`parse_mhclo`).
  - The index is built at `:149-160`; the vertex records at `:161-167`; the binary layout at `:169-174`; the meta at `:198-204`.
- **Primitive:** triangles, indexed (Uint32 index, `'I'` format).
  - Faces are triangulated by fan: `(ids[0], ids[k], ids[k+1])` (`:159-160`). A quad gives 2 triangles; an n-gon gives n-2.
- **Counts:** data-dependent, per item.
  - Vertices = number of `vt` lines in the `.obj` (one game vertex per texture coordinate: vertices are split at UV seams, `:148-167`). Written as `vertexCount: n`.
  - Triangles = sum over faces of (corners - 2), written as `triangleCount: len(index)//3`.
  - No fixed number exists in code. Every item's counts are recorded in `community.json` (`vertices`, `triangles`, `:207-208`).
- **Per-vertex data in the file:**
  - `refs`: u32 x 3 = 12 B, the 3 base-mesh vertex refs.
  - `weights`: f32 x 3 = 12 B.
  - `offsets`: f32 x 3 = 12 B.
  - `uvs`: f32 x 2 = 8 B (v flipped).
  - Total **44 B per vertex** before positions are resolved at runtime against the body mesh.
  - Index: u32 (4 B per index, 12 B per triangle).
  - `deleteVerts`: u32 list of base-mesh vertices hidden under the garment.
- **Texture:** diffuse resized to 512x512 RGBA WebP; thumbnail 160x160.
- **Multiplicity:** one per person wearing the item. Runtime use is outside this chunk (`src/render/people/...`, cooked by `scripts/cook-people.mjs`).
- **Performance notes:**
  1. **No decimation or LOD at import.** Every MakeHuman triangle is kept, and community hair packs are often dense.
  2. **Vertices are duplicated at every UV seam** (one vertex per `vt`). Unavoidable for the UVs, but it inflates the vertex count over the `.obj`'s `v` count.
  3. **`refs`/`weights` are 32-bit.** They could be u16 refs (the base mesh has fewer than 65 536 vertices: scale refs up to 11 998 are used at `:195`) and f16/unorm weights.
  4. **The index is u32** even when the item has fewer than 65 536 vertices.

#### E2. Walkways (pedestrian network centrelines): world data, not drawn here
- **What it is:** `Walkway.path` polylines (footway, corner, crossing). They are the walking lanes, not render geometry.
- **Location:** `src/world/walkways.ts`.
  - `footwayShapes` `:565`, `Walkways.buildNode` `:446`, `cut` `:425`.
  - Corners: `cornerPath` / `roundCorner` (from `walkingLines.ts`, not in this chunk).
  - Turning circle: `bulbLine`.
- **Primitive:** none on the GPU in this file.
- **Counts:**
  - Per road: up to 2 footways, cut at every crossing landing.
  - Per junction node: one corner per pair of adjacent legs, plus one crossing per incident walkable leg with a crosswalk.
  - Per dead end: one unmarked crossing or a bulb corner.
  - A straight-through join is a 2-point polyline of length `JOIN`.
- **Multiplicity:** per road and per node.
- **Notes:** the graph keeps at most `KEPT_CHANGES = 64` logged updates (`:78`). If a debug/inspector overlay draws these polylines, that happens elsewhere.

#### E3. Zone cells (zoning grid quads): world data, not drawn here
- **What it is:** the 4-corner quads of the street zoning grid. Buildings are placed on them; a zoning overlay elsewhere may draw them.
- **Location:** `src/world/zoneGrid.ts:232` (`buildZoneGrid`) and `:240` (`zoneGridSteps`); quad corners at `:286-291`.
- **Primitive:** none here. Each cell is a CPU quad (4 corners = 2 triangles if drawn).
- **Counts per street:**
  - `floor(length / ZONE_CELL)` columns, plus up to 2 partial columns of at least 1 m.
  - x 2 sides x `ZONE_DEPTH = 4` rows (`:70`).
  - `ZONE_CELL = GRID_CELL` (10 m per the comment at `:308`; not resolved further).
  - At most `8 * (columns + 2)` cells per street. If drawn as quads: 4 vertices / 2 triangles each.
- **Multiplicity:** per ground street that carries pedestrians.
- **Note:** `markPaved` / `markRoads` (`:162`, `:172`) rasterise road capsules onto a CPU label grid. This is CPU only.

#### E4. Baked surface textures (KTX2 mip chains): not geometry
- **Location:** `scripts/vite/ktx2.ts`, `scripts/vite/surface-bake-plugin.ts`.
- **What it does:** builds texture mip chains (alpha-coverage-preserving mips for foliage, RGBA8 or UASTC, Zstd).
- **Why it is listed:** foliage cards' alpha-tested coverage at distance depends on `mipChain(..., alphaRef)` (`ktx2.ts:322`).
- **Polygon counts:** none.

### Budgets, caps and counters found

1. **`VIEW_BUDGETS` copy** (`scripts/diagnose/report.mjs:157-161`, mirroring `src/core/perfBudget.ts:44-47`):

   | view | triangles per frame | draw calls (colour + shadow) | GPU p95 |
   |---|---:|---:|---:|
   | street | 16 M | 1000 (700 + 300) | 12 ms |
   | district | 16 M | 1100 (800 + 300) | 12 ms |
   | map | 8 M | 400 (300 + 100) | 12 ms |

   - The frame budget is 60 fps (50 fps for map).
   - `perfBudget.ts:43` records measured full-facade triangles: district 13 M, street 5.4 M, map 4.9 M (2026-10-16).
   - Findings are raised when `memory().drawnTriangles` or `drawCalls` exceed these (`report.mjs:221-225`).
2. **Game counters read by the tools** (all defined outside this chunk):
   - `__roadcraft.memory()`: `drawCalls`, `drawnTriangles`, `builtTriangles`, `geometryMB`, `geometryCpuMB`, `buildingDetailMB`, `gpuByName`, `glGeometries`. Read in `diagnose.mjs:447-453` and `look.mjs:486-500`.
   - `scene().buildingLevels()`: `chosenTriangles`, `budgetTriangles`, `shownDetail`, `shownFacade`, `chosenFar`, `heldFar`, `heldCoarse`, `notLanded`, `residentBytes`. Read in `frames.mjs:250-251`, `gpuSteady.mjs:280`, `lib/measureCity.mjs:113-118`, `layers.mjs:335-337`. The building level system has its own triangle budget (`budgetTriangles`).
   - `scene().stats.drawnTriangles` / `drawCalls` (`lab/verify/step3.js:86`, `:114`).
   - `scene().shadowStats()`: passes, whole cascade redraws, why, widest (`diagnose.mjs:229`, `gpuSteady.mjs:280`).
   - `gl.info.render.triangles` (`probe/page.mjs:298`).
   - `window.__labGpu.capture()` records: per-draw `calls`, `triangles`, `instances`, by layer, pass, material and name (`diagnose.mjs:185-200`, `lab/verify/step4.js:220-228`). The check requires under 2 % of captured triangles to be unnamed.
   - `__roadcraft.budget(view)`: status rows (`look.mjs:481-484`, `probe/page.mjs:290`).
3. **Script-side triangle counters**, and how they differ from what the GPU draws:
   - **`scripts/buildingParts.mjs:314-316` and `scripts/layers.mjs:327`:**
     - They count `(index ? index.count : position.count) / 3 * (isInstancedMesh ? count : 1)`.
     - They ignore `drawRange`, geometry groups, frustum culling and BatchedMesh multi-draw ranges. A BatchedMesh counts its whole arena index buffer once.
     - The shadow-cast figure in buildingParts is the same count, not multiplied by the number of cascades.
     - Result: "built" triangles, not drawn ones.
     - buildingParts reports kinds over 20 000 triangles and their `vertsMax`.
   - **`scripts/probe.mjs:230-243` (hook on `renderer.renderBufferDirect`):**
     - Per element and pass (scene, shadow, orthographic): calls, triangles, vertices, instances.
     - It honours `drawRange` and `group.count`, and instance counts (InstancedMesh `count`, InstancedBufferGeometry `instanceCount`).
     - For BatchedMesh (`multiDrawElements`), the per-object counts are not seen: the whole geometry or drawRange is counted.
   - **`scripts/probe.mjs:246-276` (inventory):** triangles, vertices, geometry bytes (attributes + index + instanceMatrix / instanceColor), textures, cast-shadow count per element. Triangles here also ignore `drawRange`.
4. **Instance and log caps in this chunk:**
   - `KEPT_CHANGES = 64` walkway change log (`walkways.ts:78`).
   - `MOST_STACKS = 25` (diagnose instrument).
   - `MAX_HITS = 40` (labSource).
   - None relate to geometry instances.
5. **Static rule related to geometry draw cost** (`scripts/diagnose/staticRules.mjs:173-176`): it flags any `new BatchedMesh` / `GpuBatchedMesh` whose file never sets `sortObjects`. With three's defaults, every instance is frustum-tested and sorted in every pass, including each shadow cascade.
6. **`accuse.mjs` rules touching geometry** (`:25-39`, `:70-74`): `whole-buffer` (needsUpdate without addUpdateRange), `geometry-swapped` (setAttribute/setIndex on a live geometry), `position-without-bounds`, `typed-copy` (`new Float32BufferAttribute(typedArray)` copies the array).

### Files without geometry
- **src/world/:**
  - `walkways.ts`: walking-lane polylines, data only (E2).
  - `zoneGrid.ts`: zone quads, data only (E3).
  - `weather.ts`, `zones.ts`: no geometry.
- **scripts/ (root):**
  - No geometry: accuse.mjs, bake-people-pics.mjs, check-code.mjs, check-refs.mjs, check.mjs, cook-cities.mjs, cook-people.mjs, frames.mjs, gpuSteady.mjs, knip-check.mjs, look-compare.mjs, look.mjs, material.mjs, materialEach.mjs, package-desktop.mjs, run-limited.mjs, sessionJob.mjs, shellMaps.mjs, verify.mjs.
  - Material swaps only, no geometry built: material.mjs, materialEach.mjs, shellMaps.mjs.
  - Counters only: buildingParts.mjs, layers.mjs, probe.mjs.
  - `import-makehuman-pack.py` is the only mesh producer (E1).
- **scripts/check-code/:** program.mjs, units.mjs.
- **scripts/diagnose/:** diagnose.mjs, instrument.mjs, quality.mjs, report.mjs (budgets), server.mjs, sources.mjs, staticRules.mjs.
- **scripts/lab/:** coverage.mjs, sweep.mjs, verify.mjs, verify/common.js, step1.js through step5.js.
- **scripts/lib/:** measureCity.mjs.
- **scripts/probe/:** analyze.mjs, collect.mjs, page.mjs, plan.mjs, run.mjs, sources.mjs.
- **scripts/vite/:**
  - No geometry: build-stamp.ts, cook-plugin.ts, desktop-jobs.config.ts, labReports.ts, labSource.ts, model-urls-plugin.ts.
  - Textures only: ktx2.ts, surface-bake-plugin.ts.

---

## Imported / cooked mesh assets (measured by script from the files)

## public/models/elements/*.gltf (22 nature props, Quaternius-style; COLOR_0/POSITION/NORMAL/TEXCOORD_0, triangles, indexed)
Clover_1 267v/379t; Clover_2 433v/615t; Fern_1 243v/288t; Flower_3_Group 581v/755t (2 prims); Flower_4_Group 1302v/1690t (2 prims);
Grass_Common_Short 153v/155t; Grass_Common_Tall 303v/326t; Grass_Wispy_Short 559v/494t; Grass_Wispy_Tall 644v/622t;
Mushroom_Common 555v/880t; Mushroom_Laetiporus 1806v/3216t; Pebble_Round_1..3 292/136, 212/114, 244/128; Pebble_Square_1..3 216/104, 162/78, 108/52;
Plant_1 120v/120t; Plant_1_Big 360v/360t; Rock_Medium_1..3 351/342, 249/244, 531/522.

## cooked/people/mh_*.bin (16 MakeHuman crowd people, SkinnedMesh, 53 bones, 13 face morphs, ~84 B/vertex)
id: verts / tris LOD0 / LOD1 / LOD2 / LOD3
mh_00 19342 / 32024 / 11547 / 5997 / 1083
mh_04 16535 / 28736 / 9192 / 3908 / 753
mh_08 21485 / 33387 / 13213 / 7415 / 3168
mh_11 16215 / 28876 / 8772 / 3288 / 897
mh_14 21874 / 34051 / 13693 / 7619 / 3214
mh_18 17214 / 28832 / 9814 / 4546 / 1776
mh_34 16931 / 30166 / 9216 / 3214 / 518
mh_38 17844 / 30916 / 9928 / 4106 / 872
mh_44 19290 / 29493 / 11461 / 6347 / 2612
mh_45 25720 / 45256 / 15744 / 6204 / 1144
mh_48 23700 / 37217 / 14197 / 7905 / 3512
mh_51 19644 / 33606 / 10764 / 4328 / 1371
mh_55 22082 / 33497 / 13125 / 7207 / 3304
mh_59 29206 / 36162 / 17614 / 12518 / 9875
mh_64 23390 / 36020 / 14129 / 7986 / 2680
mh_67 17922 / 30320 / 11684 / 4976 / 1188
attrs: position f32x3, normal f32x3, uv f32x2, color f32x3, skinIndex u16x4, skinWeight f32x4, skinMask/hairMask/eyeMask/garmentSlot f32x1

## public/models/people/base.json/.bin — MakeHuman hm08 base mesh: 19158 vertices, 21334 UVs, 18304 quads (~36608 tris), 182 helper faces dropped
## public/models/people/proxies — 575 clothing/hair/accessory proxies (MakeHuman CC0), sum 4,600,600 v / 6,268,141 t
 kind n avgV avgT minT maxT: hair 70 9677 12244 576 120022; shoes 59 11114 16301 704 153938; underwear 58 4245 5721 460 155930; suit 57 11038 17010 2380 142468;
 dress 56 11917 14004 1406 65094; top 42 6035 8807 1288 112004; hat 33 3232 4456 432 28602; equipment 29 7469 10067 228 63128; eyebrows 26 10786 16196 192 42300;
 bottom 25 6140 7476 392 28815; skirt 20 4072 5228 360 22973; clothes 20 2982 5187; glasses 15 4756 6054; jewelry 14 5669 8988; mask 13; gloves 9; eyelashes 9; helmet 6; beard 5; horns 4; socks 4; eyes 1 (1076v/2040t)
 largest: elvs_all_tied_up_bikini 155,930 t; smallest: ews_industrial_piercing_left_ear 100 t

## cooked/procedural (procedural crowd): 8 body classes (shape textures, 5303-entry faceList), 28 hairstyles + headband
hair verts/tris: afro 45615/46180; curly 34551/35196; ponytailFringe 20255/20948; pigtails 18807/19604; ponytail 18807/19604; longFringe 15355/15988;
sideSwept 14267/14964; longHeadband 14063/14772; longStraight 14063/14772; midLayered 13859/14580; shoulderBob 13859/14580; longMale 13655/14388; longWavy 13655/14388;
curlyShort 13677/14720; manBun 12015/12796; bun 11243/12028; topKnot 11131/11912; bobFringe 10583/11220; bob 9527/10260; twinBraids 6879/8204; braid 7111/8172;
slickedBack 5479/6580; pixie 4239/5280; buzz/fade/quiff 4071/5140; shortCrop/shortSide 3579/4730; headband 145/224. Sum of hair triangles 386,240.
