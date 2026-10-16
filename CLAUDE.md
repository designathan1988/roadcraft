# Roadcraft 2

Browser city-builder (TypeScript, three.js r186, Vite; to be sold on Steam).
Game: `npm run dev` (127.0.0.1:5300). Check: `npm run check`.

**This file is the project's only documentation, memory and instruction file.** Do not create
another: no `docs/`, no reports, plans, prompts, notes, `memory/`, `README`, nested `CLAUDE.md`,
skills or hooks. A finding goes into "Open findings" below; a fix leaves it (and its commit says
cause, technique and source). Git history is the archive.

## Files and naming
- Every file is written in English: code, comments, tests, error messages and this file. Talk to
  the player in Brazilian Portuguese; commit messages in Portuguese.
- No ALL-CAPS file names (only `CLAUDE.md`, which Claude Code needs by that name, and the license
  texts that ship with third-party assets).
- Nothing at the repository root that is not strictly needed (package, lock, tsconfig, the Vite,
  Vitest and ESLint configs, `index.html`, git and npm settings). Tooling lives in `scripts/`
  (Vite plugins in `scripts/vite/`, check baselines in `scripts/baselines/`).
- Nothing useless: no dead file, no stray probe, no duplicate. Scratch work goes to the session's
  scratchpad, never into the repository or `C:/Codex-Shared/rc2-wt`.

## What the player wants
- Excellent performance and graphics on different computers, toward the unlimited city: first the
  whole 10 km × 10 km map, then larger.
- **Fixed means the code no longer has the problem**: the right algorithm and data for a city of
  any size. A time that dropped on a test city is not a fix; a number is not a goal.
- DO NOT amortize: slicing work across frames, holding a layer, a capped cache that evicts and
  redoes, spacing out rebuilds. That hides the cost, which comes back with a bigger city. Fix the cause.
- Do the work; do not ask what the code and these rules already answer. Ask only about: loss of
  graphics quality, pushing to GitHub, deleting the player's data.
- No loss of graphics quality without the player's yes: before and after shots from the same views.
- Test once at the end of each block of work. No suite at every step, no process, paperwork, plan
  or note instead of fixing.
- Tell the truth: say what you did not check. Never "already exists" or "works" without reading
  the code that USES it (the caller, up to the frame, the edit or the pointer).
- Use judgement and be ethical. If something needs an architecture change to work, say so and wait
  for authorization. Do not insist on fixes that do not work; find the proper solution, report it
  and ask.
- Do not trust your own knowledge: look up the official documentation and proper sources online.
- No trial and error. If you do not know how to solve something, or it fails the first time,
  RESEARCH ON THE INTERNET.

## Architecture rewrite (authorized by the player on 2026-10-15)
The player authorized replacing the architecture where it blocks scale: "extremely fast, with
graphics quality, sold on Steam; change the whole architecture if needed". The full brief was
pasted in the session that started this; these are its binding decisions.
- Threads: the page only does input, UI, level choice, GPU upload of what became visible and
  drawing. Simulation in a worker (typed arrays, poses in a SharedArrayBuffer, triple buffer).
  One job system (hardwareConcurrency - 2) replaces the 14 pools. COOP/COEP in Vite and app://.
- Data: typed tables (SoA) for buildings, lots, nodes, segments, zones. Building = seed +
  generator version + player delta; the rich record is regenerated in a worker. Edits are
  commands with an inverse (no doc.clone, no structuredClone images, no JSON compares, no
  whole-network adopt). Every derived product follows the diary or a per-cell dirty set.
  One grid: plate 2048 m, tile 1024 m, cell 256 m, sub-cell 64 m, Morton keys.
- Buildings: L0 full detail; L1 per-cell shell simplified by meshoptimizer (error under 1 px,
  same colours and atlas); L2 per 1 km tile and L3 per plate merged with baked appearance.
  One shell material (texture array + finish id); parts instanced per kind for the whole near
  ring. Compact vertices. Detail residency capped in bytes, falling back to L1.
- World: terrain CDLOD/clipmap; instances per 256 m cell with far levels; roads painted into
  the plate texture past ~2 km. Simulation meso everywhere, micro in a ~1.5 km window.
- Light: 3 shadow cascades, casters by level and screen size; shader variants compiled at load;
  textures baked to KTX2 at build time.
- Renderer: decided by a 4-day spike (WebGL2 vs WebGPU with compute culling and indirect draw).
  Decision: WebGL2 (2026-10-15, measured: draw submission ~4% of the frame; the bound is triangles and memory).
- Phases: F0 prep, F0b relief, F1 data, F2 threads, F3 spike, F4 buildings, F5 world,
  F6 light, F7 whole-map generation, F8 Steam, F9 validation. Current: block D (buildings).
- Player's queue (2026-10-15, replaces the phase gates: tsc, commit, a look at the game per block): A undo/COOP/sim
  worker, B data, C threads, D buildings, E world, F light, G whole-map generator, H Steam.
- Done: F0 route and worst-case city (57d2eb7); F0b frame without scene walks, detail byte cap (0331e1a); layered
  network fork and in-place edits on forks (d79c945, 7a464c2, 6dbd5ba). Block A: undo by commands (3a55403),
  COOP/COEP (1b9ba07), simulation in a worker with a SharedArrayBuffer triple buffer (7bf4b16). Left from A: the
  meso model over the whole map (goes with the far density cars, block E); the micro window is the ambient's focus.
- Block B: building records hash-consed (bd4862f; seed + delta is not possible: growth reads neighbours, `nextId` and
  corners); whole-map undo without a second city (25ea349); save head in parts on `rewrite/b-save-head-parts` (919814d,
  changes the save format: waits for the player). Block C: one job pool (da8c810); growth in the pool's `growth` lane
  (2b029a9). Medium city after C: growth 14.9 s, 14.8 M triangles, 1,371 draws, GPU p95 254 ms on the UHD 770 (D's target).
- Block D so far: shells 37 B a vertex (1b54d50); page memory: cell arrays held by a closure (9c3498d), baked texels let
  go after upload (ed82632), biomes on demand (7e9d803), gardens as poses (aeea9c9), bounds without allocation (bedd0ba);
  the sim client follows the diary, no whole-map resend (40e6e7c, e07a09c); the world build no longer stops on an empty
  box (003d473). Small city heap 1,486 -> 1,074 MB. WebGL stays: draw submission is ~4% of a frame, the GPU is bound by
  triangles, not by calls (no 30% CPU gain to buy with WebGPU).
- Measured before (worst case 4x4, 81,128 buildings, 17,160 segments): growth 5.7 min, JS heap ~3 GB, ~18 GB of
  Chrome memory, the world not shown 4 min after; a medium city lost its WebGL context (GL_OUT_OF_MEMORY) in a
  8 GB job: 28 workers in the page's process (14 pools) and ~1 GB of geometry.
- Still asks the player: graphics-quality changes (shots), migrating his saved map, pushing.
- Adopted from "Cidade" (a 20 k-line game on the same brief that opens the whole large city; source extracted
  in the session scratchpad, read-only reference, never run; player's order 2026-10-16 to take its architecture ideas):
  one job queue with priority dispatching to any free worker, a key that cancels the older job and drops its result,
  stateless jobs reading shared memory (terrain heights in a SharedArrayBuffer) instead of services pinned to workers
  and page round trips; far building levels emitted again by the generator (same record, fewer pieces) with windows,
  frames, shop fronts and lit rooms drawn by the shader from per-vertex facade attributes (style/seed/kind/column
  width + wall coordinate), averaged by `fwidth` far away — L0 keeps its real openings; compact vertex (int16
  position per cell, RGBA8 colour, planar uv in the shader) and 4-float instances; CDLOD with the heights texture
  array as the same SAB, `texelFetch` + manual bilinear equal to the CPU; roads past ~2 km and markings painted by
  shaders, density cars from an occupancy texture; meso traffic as per-lane exit events (saturation headway);
  save per tile in binary, compressed, in a worker, only dirty tiles; steamworks.js in the Electron main process only.
  Not taken: its WebGPU-only look (post, CSM, GPU-culled props are off in its WebGL2 mode), its simpler buildings,
  its 500-step undo cap.
- Merged 2026-10-16 (main 7a49aaa): building L1 facade level by the emitter, shown by pixel error between detail and
  mass (9de8469); save by tiles in a worker, the old save never touched (`:tiles` manifest, c111959-073afbd); lots planned
  only where the diary says (035b42d); closed shader catalogue at load, the curtain waits (7f4207e); per-cascade casters
  (bb95c88); ragdolls without per-frame allocation, cooked crowd palettes on the GPU (a01320e-06ac47d); renderer
  derivatives by cell and diary (5d8fc21-5895df9); instance layers keep poses (3db1344); KTX2 surfaces baked at build,
  rgba8 (20d18f7); Steam saves as files for Auto-Cloud, Windows and Linux depots (7a49aaa).
- Streaming world in main (2026-10-16; tests of the block pass, import cycles undone b6f87db): tiles and ids (`world/tiles.ts`), tile
  store as the save (`editor/tileStore.ts`), generator per tile (`editor/wholeMapTile.ts` buildStreamTile, unbounded
  plan), `RoadDoc.loadTile`/`unloadTile`/`tileRecords`/`worldValues`, `worldStreamer.ts` (3x3 region, 5-tile ring made
  ahead, one tile put in a frame, undo forgetting what a tile took), no fixed map (`bounds.ts` plates without end,
  terrain on demand), far buildings (`buildings/farLevels.ts`) and far roads (`farRoads.ts`) baked per tile from the
  store, road and conflict caches read by key (never whole), `generateCity({ size: 'whole' })` opens it.
- Merged: meso link tables per tile read by the sim worker (8c9d3bc, 789cea6); meso cars handed to the micro window after
  it opened are made (a224f62); far city past the made tiles drawn from the generator's plan, `FarLevels` on the generic
  `farTree.ts` (7d7320e). Kept for the player's yes on shots: far roads painted into the terrain and terrain at 13
  texture units (af56964b, cf05005).
- Open on the streaming world, measured 2026-10-16 (build on `vite preview` 5310 and dev, headless, under `run-limited`,
  district view): the opening of `generateCity({ size: 'whole' })` still does not show in the 8 GB / 25% CPU job; the page's
  process reaches 6.6 GB at ~60 s and dies. Fixed on the way (9729f1f-781fab5): the frame threw on negative plate keys;
  22 job workers made at the start, each loading every service (now made as work waits, a kind on the workers that run it,
  8 on 32 GB); far boxes 1.6 px wide over 16 km and stored tiles drawn past the camera's far plane (now 4 px boxes, culled
  by the far plane); far tiles' records through the page (now read by the worker); the ground re-shaped and every floor
  re-done at each tile (5 -> 3.7 floors a building); 70 KB of garbage a floor (`roadAtInto`). Left, by measure: the page
  holds 1.37 GB after a GC for a 3 x 3 region (296 MB at boot; ~140 KB a building), of which typed arrays of 256 KB or more
  are 334 MB (people classes ~130 MB of CPU copies, terrain paint layers ~66 MB, wear field 48 MB, ~50 MB a terrain
  plate); the rest is small arrays and objects not yet attributed (heap snapshots do not finish under the cap). The page
  still allocates ~5 GB in 30 s of opening (floors 3.7 times a building, the sim's `trafficBuildings.project`, the camera
  solids); the opening's warm frame uploads ~13 M triangles at once. Fix: per-building derived data (floor, pads, doors,
  traffic) worked out once in workers with the tile, and the page's per-building memory found by a snapshot on a machine
  without the cap.
- Later on 2026-10-16 (c9b7ada-f815328): floors follow the natural ground and the roads only (1.39 floors a building in an
  opening, from 5.1), the page no longer spins while the world's job waits on workers, the sim worker projects a tile's
  buildings for traffic from the store, `intern` hashes numbers by their bits, tiles made ahead are stored by the generator's
  worker (the page gets the version). The opening now gets to drawing and runs out of GPU memory (`GL_OUT_OF_MEMORY`): the
  district view's near cells are L1 (facade level) at ~570 k vertices a 256 m cell (9.8 k a building, `facadeLevel.spec.ts`
  town: L1 has 76% of L0's shell triangles), 1.2-3.3 GB of shells. By emitter (triangles of L1 shells, 80 buildings):
  ~75% are the lots' elements (`emitLots` -> `emitElement`: gates, lamp posts and bins of `emitLotPart` 68 k, fences 68 k,
  stone/plaster/brick/concrete/wood element boxes 81 k, lot surfaces 19 k, parking 7 k), against ~25% the buildings
  themselves (`emitBuilding`, roofs, plinths, jambs); roof plant 33 k. Every element is modelled into the shell, face by
  face, never instanced. Needs the player's call (shots): lot furniture as instanced parts per kind (the brief's "parts
  instanced per kind for the whole near ring"), or left out of L1 below its error; and the detail budget only lets go of
  cells not shown (17 shown cells pass `buildingDetailMB`).
- Also open: city statistics read the region only; growth runs in the region only; the joins between near and
  far roads at the region's edge do not match exactly (far junctions only on owned nodes, heights differ).

## Streaming world (2026-10-16, the player's order: cities far larger than 10 km; the root fix)
Measured before it: the page held every record of the map as JS objects in one document (~75 KB of live heap per
building with its derived copies), every product walked it, and the opening waited for the whole map; the page's V8 heap
is 4.4 GB, so no tuning fits a city much past 10 km. Binding decisions:
- The page never holds the whole map. The world is an unbounded grid of 1,024 m tiles (`world/tiles.ts`); every record
  belongs to one tile (`OWNER`: a node where it stands, a road and a span by the middle of their ends, everything else by
  its anchor).
- Ids per tile: tile k hands out ids from `tileIdBase(k)`; ids under `TILE_IDS` are a pre-tile map's, kept as they are.
- The tile store is the save (`editor/chunkedSave.ts` layout, written in a worker): every tile ever made. A tile not in it
  is generated on demand, a pure function of the seed and its place (`cityGen/wholeMap.ts`, `editor/wholeMapTile.ts`),
  then stored. Generating a city is choosing a seed and options: nothing is generated up front.
- The page document holds the active region only: the tiles within `ACTIVE_RADIUS` (1: 3 x 3 tiles) of the camera's focus, loaded ahead
  and unloaded behind (with hysteresis). A load or an unload is a diary entry per kind with the tile's rectangle and ids
  (causes `'tile loaded'`, `'tile unloaded'`); every derived product follows the diary and drops what an unload names.
  A road across a tile edge keeps its foreign end as a borrowed node in its own tile; a borrowed node stays while a
  loaded road uses it.
- Far from the camera nothing of the records is on the page: far products are baked per tile in workers from the store
  and cached by the tile's version (building masses L2 per tile, L3 per 2x2 tiles, coarser quadtree levels beyond;
  roads painted into the terrain; terrain by CDLOD; ecology); the GPU holds them.
- Simulation: meso over every tile from per-tile link tables baked from the store; micro in the active region.
- No fixed map: `bounds.ts` (5x5 plates), `clampToMap`, `MAP_HALF` users and the whole-map generator's rim go; terrain,
  plates and generation work on any tile.

## How to work
- Find the cause by reading the whole part of the code: file by file, each caller followed up to
  the frame, the edit or the pointer, and the siblings of the same shape in the project. Fix the
  whole class.
- Before a technique the code does not use yet, read the official source. three.js of the game's
  version, offline: `C:/Codex-Shared/referencia/` (docs, manual, examples, source; InstancedMesh2,
  3DTilesRendererJS, three-mesh-bvh, postprocessing; index in its `README.md`).
- `node scripts/accuse.mjs` points at three.js uses the manual warns against and at the patterns
  below. An accusation is a lead to read, not a proof.
- One commit per fix, saying cause, technique and source.

## Causes that already cost a lot
- Rebuilding everything when one part changes. Right: the diary (`world/changes.ts`) says what
  changed; a derived product reads `doc.changes.since`/`touches` for its own kinds, never a cache
  key with a global revision.
- Scanning everything to find what is near. Right: a spatial index (`buildings.near(box)`).
- A capped cache that evicts and redoes the same work.
- Heavy work on the main thread. Right: a worker.
- Drawing or keeping what is not seen: no level of detail; a CPU copy of what is already on the GPU.
- Waiting for the GPU mid-frame (`getImageData`) or compiling shaders during play.
- Comparing by JSON (`JSON.stringify(a) === JSON.stringify(b)`) on a hot path. Right: compare what
  the diary says changed.
- The same data kept in two forms (the record or geometry on both CPU and GPU; a whole copy per edit).

## Lessons (DO NOT redo)
- `BatchedMesh` for the building shells was undone: it keeps its whole capacity on the CPU
  (`_initializeGeometry`), 1.1 GB of heap for 8.1 M vertices; with the chunk cache the heap hit
  4.4-5.1 GB and the map ran at 14 fps. Do not redo it without a batch that drops its arrays.
- Mass (far level) painted with the detail's colours was tried and undone: the mean difference got
  worse (17.6 → 20.6) and the mass looked darker. Swapping detail for mass in the top view loses
  beauty. The way left is fewer triangles in the detail itself (simplified shell per cell,
  meshoptimizer, error under a pixel).
- Checked and right (reopen only if a probe, a shot or the code says otherwise): upload ranges
  (`addUpdateRange`) in agents, transit, grass, blob shadows, casualties, gore, exhaust, nature
  trees, far forest and poles; picking by the ground plane, no `Raycaster`; on-demand frame loop
  (`frameLoop.ts`); sRGB output, ACES, PMREM of the sky, no fog (player's choice); reversed float
  depth.
- Under review: building far level with hysteresis (shows simplified buildings for 3-4 s after a
  camera move); one 4096 shadow map fitted to the view (stair-step aliasing up close); SMAA and
  GTAO at half resolution (the player wants nothing blurry); baked textures with mipmaps (foliage
  speckle up close).

## State (2026-10-15)
- `main` holds all the merged work (`fix/workers-10km` merged on 2026-10-15). No worktree is open.
- Not merged, kept as branches only: `fix/growth-worker` (city growth in a worker, 10 commits),
  `fix/gerador-workers`, `fix/render-cidade` (1 commit: only cells in view in full detail; changes
  quality, needs shots and the player's yes), six `worktree-agent-*` branches from 2026-10-14
  (agents stopped midway), and `wip/*` (uncommitted work saved before worktrees were removed:
  `wip/main-layered-doc` is a second copy-on-write map, superseded by `core/forkMap.ts`).
- Comments are one line each; dead code is gone (`node scripts/knip-check.mjs`: 0 entries).
- `node scripts/check-code.mjs` reports 55 findings not in its baseline, all from the merged
  branch (whole-map walks per input, per frame): fix them, never add them to the baseline.
- The fixed map today: 5 × 5 plates of 2,048 m (`world/bounds.ts`).

## Open findings
Read by agents on `fix/workers-10km` at `3780807` (quick read; line numbers from that commit;
bytes and ms are estimates from reading). Re-check the line before fixing.

GPU memory and drawing
- Building detail residency has no cap: in perspective `reach = Infinity` (`renderer.ts:3196`) and
  the only eviction needs `Number.isFinite(reach)` (`buildings/layer.ts:656`); video memory grows
  with the area visited and a returning cell is re-emitted. Fix: residency by a byte budget; what
  leaves falls back to the mass and returns without redoing.
- Render targets and shadow map are not counted (`core/perfBudget.ts:196` passes `null`).
- `color`/`roadSection` attributes on every road strip (`mesh/surfaceMesh.ts:68`, `tileMesh.ts:83`):
  24 of 56 B per vertex unused. Fix: the `SurfaceSpec` declares what it reads.
- Texture units (measured 2026-10-16, ANGLE D3D11, 16 per stage): the 3 sun cascades take 3; the terrain program uses
  16 and one variant fails to link; the cooked citizen with morph uses 18 and fails ("program not valid", not drawn).
  Fix in flight: terrain to <= 13 (rock/dirt into the detail arrays), people to <= 12 (garments as a texture array).
- Non-indexed geometry: `structures.ts:414`, `vehicleModels.ts:298` (`toNonIndexed`).
- Worst case still crashes the tab in the 8 GB job: a 2x2 city (19,635 buildings) holds ~3.2 GB in the page, ~1 GB in
  the sim worker, 0.34 GB in the pool (2026-10-15, `measureUserAgentSpecificMemory`). Not found yet: ~120 KB of page heap
  per building (the medium city's live JS is ~68 KB, spread; the rest typed arrays). Heap snapshots of a big city do not
  finish under the job's 25% CPU: measure on a machine without the cap.
- The sim worker holds the traffic record of every building of the map (`sim/agents/trafficBuildings.ts`, by 256 m cell),
  not only those near. Fix with the micro window (block E): the worker gets what traffic reads, near.
- Terrain plates keep their editing arrays on the page (~6 MB geometry + paint layers each; 154 MB of CPU geometry at
  2x2).
- KTX2 (20d18f7): UASTC (BC7, a quarter of the memory) waits for the player's yes on shots
  (`ROADCRAFT_TEXTURE_CODEC=uastc`, needs `ktx2-encoder`); the foliage atlas is still drawn on a canvas
  (`lowPolyTrees.ts`); `strataTexture` (`terrain.ts`) and the water texture (`water.ts`) are still baked at run time.
- Steam (7a49aaa): not run in Electron yet (crossOriginIsolated under app://, the saves' MessagePort, flush on quit);
  steamworks.js not installed in `desktop/`; a Linux build packed on Windows loses the executable bit; Steam Cloud quotas
  for one file per square per layer unknown.
- Building shells cannot be simplified (L1): 48% of their edges are open borders even welded by position (each
  `Shell.face` is a loose quad, T-junctions round every window), so meshoptimizer locks them. Tried 2026-10-15 with
  index-only levels (0.25 m / 0.6 m, `ErrorAbsolute`+`Prune`): -13% triangles in the district view, plaster not reduced
  at all, and the cells' detail landed later (weld + simplify in the worker); undone. Fix: the emitter builds each wall
  as one welded grid with the windows' holes sharing its vertices; then simplify.
- About 30 draw calls per building cell: an `InstancedMesh` per part kind (`buildingMesh.ts` `meshesOf`); the
  shells of every finish are one draw (one material, texture arrays, a finish byte a vertex, `finishes.ts`).
- Needs shots and the player's yes: signature buildings without a far level (`massing.ts:157`);
  terrain plates with content have no LOD (`flatAtlas.ts:104`).

Main thread
- The simulation runs on the page (`main.ts:2797`, `SIM_FRAME_BUDGET_MS`). Fix: `SimWorld` in a
  worker fed by diary deltas, poses in shared memory, COOP/COEP in Vite and Electron.
- City growth and power-line layout are sliced (`main.ts:2200-2273` `GROW_SLICE_MS`,
  `roads/powerLine.ts:39`): amortization. The worker version is on `fix/growth-worker`.
- Nature: one plate swept per frame (`renderer.ts` `natureSweep`, `HIDDEN_SLICE_MS`).
- Road blocks' levels: every block of the map scanned every 6 frames (`renderer.ts` `updateRoadLevels`,
  `mesh/roadResidency.ts:48`). Fix: the blocks filed by place in `roadSurfaces.ts`, the near ones kept.
- Shader catalogue (7f4207e): the rigged scenery cast's programs still compile per model during play (its assets load
  then); a quality change that toggles shadows is not re-run through the catalogue; stand-ins built from meshes not in
  the scene (forest sample, `renderer.ts` ~857) get three's plain depth, not the RGBA-packed `depthVariants`.
- Opening: `net.rebuild({ full: true })` (`history.ts:155`); `readDerivedAll` reads the whole cache
  (`renderer.ts:792`).
- Profiler hooks always installed (`main.ts:707`, `profiler.ts:88`, `new Error().stack` per upload).

O(map) per edit
- `snapshotRoads` does `doc.clone()` (`editRules.ts:114`) per in-place edit. Fix: judge on `doc.fork()`.
- `Network.adopt` copies the whole network (`network.ts:270-300`), twice per road drawn. Fix: a
  layered fork, adopting only the delta.
- `elevation.ts` walks every ribbon per solve (`:448`) and digests with `JSON.stringify` (`:1177`).
- Autosave by tiles: an ordered list whose kind changed (stamps, dabs, trees, elements, zones) is walked once per save
  by reference to keep its order (`chunkedSave.ts` `walk`); `lotKeys`, people and transit are each one blob. Fix: ids or
  per-cell storage for those lists (block B data).
- Undo: `DocImage` `structuredClone`s nodes, segments, poles, landscape and barriers
  (`docImage.ts:83, 117`), compares lists by prefix/suffix (`:186`); `doc.ts:2086` logs
  `'utilities'` without ids. 28 `JSON.stringify` comparisons in `doc.ts` `replaceContents`.
- Terrain: a stamp discards the worker-built mesh (`terrain.ts:3125`); `new TerrainIndex` of every
  stamp per revision (`:3102`); textures and buffers re-uploaded whole (no `addUpdateRange`).
- `flatAtlas.ts`: each plate filters every paint dab (`:435-444`) and every terrain stamp (`sync`,
  `doc.terrainStamps.filter`); `letGo` throws a plate away and it is rebuilt when it returns (`:299-307`).
- The rivers' stones are swept again over the whole water box at each water rebuild (`renderer.ts`
  `resweepShore`): it follows `terrain.ts` `rebuildWater`, which rebuilds all the water at any stamp.
- Lot tool: `lotAt` is `doc.lots.find`, up to 400 times per move (`lotTool.ts:359, 552`); the
  overlay recomposes every lot; the proposal key uses `net.revision` (`:259`). Fix: `doc.lotsIn(box)`.
- Fleet scanned, left: the worker writes and the page decodes the whole fleet each tick (the micro window, block E);
  per tick `simHost.ts` walks every parked car (`ambient.parked`) for the few that moved and compares each vehicle's
  rich parts by joined strings; `removeVehiclesNear` walks every vehicle per act.
- Effects left (2026-10-16): `JoltRagdoll.push` allocates two Vector3 per call (`ragdollJolt.ts`); the procedural
  crowd's `ragdoll.hold` slices a palette per held body per frame; `clipPose` makes a palette per frame while a body
  gets up; `GPU_PLAYS` copies `crowdAnimation.ts` `PLAYS` (export it).
- 188 global-revision reads still suppressed in `scripts/baselines/eslint-suppressions.json` (35
  files: `renderer.ts` 42, `doc.ts` 23, `flatAtlas.ts` 19, `main.ts` 15, `terrain.ts` 7). The engine
  has only 6 `engine.register`; the other derived products update themselves.
- Low: `conflictPool.ts:283` does not `terminate` workers already made when creation fails; files of
  3,500-4,500 lines (`main.ts`, `renderer.ts`, `buildingMesh.ts`).

Player's decisions
- Caps that delete the player's work: `MAX_PLANTED_TREES = 20_000` (`doc.ts:1334`), elements
  (`:1381`), undo dropping old steps by bytes (`history.ts:128`).
- About 7 KB per building record (560 MB at 80,000 buildings); seed + lot would change the generator.
- Road surface triangles of the fixed scene `tests/fixtures/grid-and-bends.json` fell from 275,691
  to 133,500 (`tests/perf/budgets.spec.ts` fails its minimum): either the roads are built another
  way or they lost detail. Needs before/after shots of the same views and the player's call.

Agents disagreed (check the line): `GTAOPass` allocating an unused `normalRenderTarget`
(`postprocess.ts:262`, r186 `GTAOPass.js:225, 317`); `simShowsMotion` (`main.ts:2870`).

Not checked (need a measure in the game): ~100 KB heap per building, ~30 MB/s garbage, a road
taking 9-10 s, opening the big map, 18.6 ms GPU on the whole map, relighting at sun ≥ 2°.

Already fixed on the branch (do not report as open): transit and fog by the diary; gullies
(`setGullies` is empty); forests cell by cell (`plantCells.ts`); the `no-global-revision` lint;
chunk LRU cache; atlas `CACHE = 6`; lot tool JSON key; road tiles without CPU arrays; `pedPoseInto`;
lanelets by delta; cell emission in a worker (`cellPool.ts`); parking walls by `store.near`;
`matrixAutoUpdate = false` on buildings; `changedSites` and `changedSegments` by the diary; the sky
is hidden every frame (no overdraw).

## Checking in the game
- `node scripts/look.mjs <script.json>` (example `scripts/look/views.json`): installed Chrome,
  headless, on the GPU, 1920×1080. Camera: middle drags, right rotates, wheel zooms; left belongs to
  the tool. Playwright's Chromium does not open on this machine: `channel: 'chrome'`.
- Open each PNG with Read and look for: cut text, overlap, floating pieces, holes, flicker, wrong
  light, wrong language. A defect seen is fixed and shot again.
- The app's built-in browser returns 800×450 shots: good for reading text, not for images.
- Heavy commands through `node scripts/run-limited.mjs …` (Windows job: 25% CPU, 8 GB).

## Commits, branches, agents
- `git status` first; commit only your paths (`git commit --only <paths>`) after reading their
  `git diff`. Every file saved in the main folder reloads the game on 5300.
- Agents: up to 10 running at once, to speed the work (player's order, 2026-10-16: what froze his PC was
  each agent opening the 10 km city, not their number); the others wait their turn. Never open a window
  on the player's screen (no visible browser, Electron or console windows; headless only). Each one in
  its own worktree made from local `main` (check its first commit: the tool may cut it from an old one),
  one part each, no two on the same files; read its diff whole before merging. Keep progress here.
- Agents run NO process besides git and reading/writing files (player's order, 2026-10-16, repeated: tests and
  typechecks running all the time froze his PC): no tsc, no vitest, no eslint, no check-code, no Vite, no browser.
  They write the code and its unit tests and commit. The coordinator runs the typecheck and the touched tests once
  per merge, through `run-limited`, and opens the game only once at the end of a block — with a SMALL city
  (`{ "city": { "size": "small" } }`): enough to see that it works and looks right. The 10 km city only proves scale
  (memory, worst-case frame, opening time): once, at the phase gate, never per merge.
- Effort high for normal work; xhigh only to decide architecture and at phase gates. Grep before
  Read; in a file over 800 lines read only the part that matters. During a block only the
  typecheck and the tests of what was touched; the full check and the route at the end of the
  block and at the phase gate.
- A worktree, when one is needed, is made from local `main` (`node_modules` and `cooked` by
  junction). To remove it, undo the junctions with `rmdir`, never `rm -rf` (it would delete the
  main folder's `node_modules`); delete the branch once it is merged.
- Push only to `roadcraft4` (https://github.com/designathan1988/roadcraft-4.0.git, the player's order on
  2026-10-16, which is his yes for it); NEVER push to `origin` or `roadcraft3`: another Claude instance works there.
  The player's ports and folders, never touch:
  4180-4183, 5173, 5175-5178, `C:/Codex-Shared/backup-mapa-jogador`.

## Traps by area
**render** (only `src/render` imports `three`)
- Reversed depth in a float buffer (`depthConvention.ts`): distant flicker is never fixed by pushing
  the near plane or raising an offset; a pass that reads depth uses `DEPTH_GLSL`.
- The shadow moves in whole ground texels (`environment.ts` `GroundShadowGrid`); the sun in 0.1°
  steps (`SUN_STEP`). `shadowMap.enabled` depends on the quality level: check the level first.
- World `y` becomes three's `z` and flips direction: measure area with its sign, do not assume.
- `earcut` on a long thin strip makes huge triangles: cut it first (`splitToSpan`).
- Textures and materials made once; never create a material inside a rebuild.
- A repeated piece is instanced; a shared material needs the same program variant.
- `vertexColors: true` on the material, or per-vertex colour does nothing.
- `compileAsync` with the post-processing target, or the first frame stalls.
- People: MakeHuman baked ahead (`cooked/`, version in `scripts/vite/cook-plugin.ts` `CAST`);
  skeletons on the GPU (`people/crowdAnimation.ts`): `renderPalettes` after `update`, before drawing.
- Never two surfaces of a building in the same plane (`tests/render/coplanar.spec.ts`).
- Asphalt shader (`materials.ts` `ROAD_SPACE_FRAGMENT`): `uv.x * ASPHALT_TILE` is across the road.
- Instance buffers sized by `FLEET_CEILING` and `PED_CEILING` (`sim/params.ts`).
- A new visual effect goes in `postprocess.ts`, behind an option in `quality.ts`.

**world**
- One cut per road end (`approach.ts`) feeds mouth, zebra, stop line, lane and kerb.
- `HEADING_CHORD` belongs to `sim/pose.ts`, `conflictPoints.ts` and `turnPaths.ts`: all three together.
- Terrain height: `heightAt` is the field; `renderedHeightAt` is what is drawn.
- A tunnel is a step in the terrain plus a portal; `TUNNEL_*` and `CUT_SHOULDER` go together.
- A road at grade is a projected line, not the ground (`solveGround`); a junction takes its legs' height.
- A building edit moves `doc.buildings.revision`, never `doc.revision`.
- Terrain cell: 6.4 m. One world unit is one metre. Road numbers with a source in `roads/tuning.ts`;
  only the player changes them.

**sim**
- One writer per field; stage order in `pipeline.ts`. `clock.tick` only at the end of `step`.
- `archetype` is the machine, `driver` is the person. A lane change occupies two lanes (`bodiesIn`).
- A signal stage never groups crossing movements (`signals/plan.ts`).
- `WALKER_SHAPE`: every field of a pedestrian declared at once (hidden classes).
- `SimWorld.doLess` must give the same result as doing everything (`tests/sim/doLess.spec.ts`).

**editor**
- `commitDraft` adopts the network only after it is rebuilt. Every road edit pays in `roads/economy.ts`.
- New tool: `Tool` in `toolMachine.ts`, a `case` in `main.ts` `pointerdown`, a key in `gameKeys.ts`,
  a place in `ui/v2/shell.ts`, `tool.`/`hint.` keys in both dictionaries.
- Loading validates with the document's own predicates (`persistence.ts`).

## Third-party assets
- Trees are procedural (`render/lowPolyTrees.ts`); only their proportions follow Kenney's Nature Kit.
- People: MakeHuman base and community items (`public/models/people/`, each item's licence in
  `proxies/community.json`; CC-BY items credited in the About panel), Microsoft Rocketbox (MIT) and
  Quaternius animations (CC0). The licence texts in `public/models/people/` and
  `public/models/citizens/` ship with the game (`render/citizenAssets.ts` shows them) and must stay.
- The people catalogue offers every community item (`people/wardrobe.ts` `itemsOf`), so all of
  `public/models/people/proxies` is in use, not only the street selection.
