# Roadcraft

Browser city-builder (TypeScript, three.js r186, Vite; to be sold on Steam).
Game: `npm run dev` (127.0.0.1:5300). Typecheck: `npm run typecheck`. Lint: `npm run lint`. Full suite: `npm test`.

This file holds the project's rules, architecture and work list. Working documents live in `tests/playtest/`
(test plan, defect list, playtest report: create them when needed and keep them current, one file each);
shots go to `test-results/` (ignored by git). No `docs/`, nested `CLAUDE.md`, skills or hooks.

## The job: read the code, fix it, open the game and LOOK, commit
What moves the game is reading the code, fixing the cause, and looking at the result on screen.
- A turn's work is: read the part of the code the problem lives in (callers up to the frame, the edit or the
  pointer, and siblings of the same shape), find the cause, fix it, run the typecheck and the tests of the files
  touched, commit, then OPEN THE GAME AND LOOK: `node scripts/look.mjs <script.json> <out> --url=<dev server>`
  (installed Chrome through Playwright, headless, GPU, 1920x1080; `scripts/look/` has scripts; steps click, move,
  drag, wheel, keys, type, hold, wait, shot, clip; the `city` option `{ "size": "whole" }` opens the 10 km city).
  Shots from several views: map, district, street, after a middle-drag (pan), after a right-drag (turn), after
  wheel zooms, and again seconds later (what settles, what blinks). Open every PNG with Read and look for: holes,
  shadows without buildings, far level where near should be, blinking levels, cut text, floating pieces, wrong
  light, wrong language, overlapping or unclear interface. A defect seen is a cause to find in the code, fix, and
  shoot again. One shot is never "it is fine": the player has to be able to play it.
- The built-in browser pane is 800x450: not for shots. Chrome through `look.mjs` only. Never a window on the screen.
- Measuring points at the code and proves a fix: the CPU profile of the long frames while the camera moves
  (`look.mjs` steps `{ "profile": "name" }` ... drags ... `{ "profileEnd": true }`) names the functions to read and
  fix the same hour; frame times before and after a fix go in its commit message and the playtest report.
  A number never replaces the fix or the shot.
- A world's tiles are stored under `worldKey` (seed, map size, `PLAN_VERSION` in `wholeMap.ts`): bump
  PLAN_VERSION whenever the plan puts things elsewhere, or the player sees the old city from the store.
- Tests: `npm run typecheck` and `npx vitest run <files touched>` before each commit; a failure is fixed in the
  code, never by loosening the test. The full suite at the end of a block.
- Every file written in the main folder reloads the player's game on 5300 (Vite). Work and commit in a worktree of
  this repository (`git worktree add ../roadcraft-wt -b work/<topic> main`, then a junction `node_modules` to the
  main folder's), look at it with its own dev server (`npx vite --host 127.0.0.1 --port 5301 --strictPort` in the
  worktree), and fast-forward `main` in one go per batch once its shots are right. Never leave another session's
  uncommitted edits in the main folder.
- The map: 10 km x 10 km (`wholeMap.ts` MAP_TILES), the city over ALL of it, nothing past the edge, the camera
  held to it. Never a world without an edge. The size becomes the player's choice later (10, 20, 40 km).
- Rules taken from the reference game that opens the big city: a tile draws by cells only when every cell is
  ready (then fades in), SoA tables, one job pool reading shared memory, 12 numbers a building + a versioned
  generator, binary save per tile.
- Say plainly what you did not run or did not look at.
- Never tell the player what the game shows ("opened", "fills the map", "fixed") before you opened the shot
  with Read in this turn and saw it; name the shot. A run still going is "not seen yet", never "it works".
- The player's message is followed in its turn. Do not turn one message into a new rule here: this file's
  rules change only when he says to change this file.
- If a fix does not hold, read more code and the official sources (three.js r186: `node_modules/three/src` and
  `examples/jsm`, docs at threejs.org; Cesium 3D Tiles spec for level refinement); do not try variations at random.
- NEVER ask the player anything: every decision is yours; weigh the options and take the best one, then say in
  the report what you chose and why. That includes graphics trade-offs (before/after shots in the playtest
  report), interface design and any architecture change the goal needs.
- Do not stop until everything is solved: no pausing for approval, no "should I continue?", no ending a turn
  with work left; finish each defect (fix, test, commit, shot) and go on to the next. Hard limits, never crossed:
  push only to `roadcraft4`; never delete the player's saves (a format change reads or migrates the old one,
  keeping a copy). No agents unless he asks: do the work yourself.

## What the player wants
- Excellent performance and graphics on different computers, toward the unlimited city: the whole
  10 km map first, then larger.
- **Fixed means the code no longer has the problem**: the right algorithm and data for a city of any size.
- DO NOT amortize: slicing work across frames, holding a layer, a capped cache that evicts and redoes,
  spacing out rebuilds. That hides the cost. Fix the cause.
- Never "already exists" or "works" without reading the code that USES it.
- Before a technique the code does not use yet, read the official source: three.js of the game's version in
  `node_modules/three` (r186) and its docs at threejs.org.
- One commit per fix: cause, technique, source. When a fix lands, delete its line from the work list below.

## Files and naming
- Every file in English: code, comments, tests, this file. Talk to the player in Brazilian Portuguese;
  commit messages in Portuguese. Comments are one line each.
- No ALL-CAPS file names (only `CLAUDE.md` and shipped licence texts). Nothing at the root that is not
  strictly needed; tooling in `scripts/`.
- No dead file, stray probe or duplicate. Scratch work goes to the session's scratchpad, never into the
  repository.

## Architecture (binding; authorized 2026-10-15/16, no further authorization needed)
- Threads: the page does input, UI, level choice, GPU upload of what became visible and drawing. Simulation
  in a worker (SoA typed arrays, poses in a SharedArrayBuffer). One job queue with priority, any free
  worker, a key that cancels the older job; stateless jobs reading shared memory, not services pinned to
  workers with page round trips. COOP/COEP in Vite and app://. Renderer: WebGL2.
- Data: typed tables (SoA) per tile in shared memory for buildings, lots, nodes, segments, zones. Edits are
  commands with an inverse. Every derived product follows the diary (`world/changes.ts`) or a per-cell
  dirty set. Grid: plate 2048 m, tile 1024 m, cell 256 m, sub-cell 64 m, Morton keys.
- Streaming world: an unbounded grid of 1,024 m tiles (`world/tiles.ts`); every record belongs to one tile;
  ids from `tileIdBase(k)`. The tile store is the save (written in a worker); a tile not in it is generated
  on demand, a pure function of seed and place, then stored. The page document holds the active 3 x 3
  region only (`ACTIVE_RADIUS`), a ring kept with records only (`KEEP_MARGIN`); load and unload are diary
  entries and every product drops what an unload names. Far from the camera nothing of the records is on
  the page: far products are baked per tile in workers from the store and cached by tile version.
- Buildings: L0 full detail; L1 facade level emitted by the generator (openings drawn by the shader);
  L2 per tile, L3 per 2 x 2 tiles merged. One shell material (texture arrays + finish id); parts instanced
  per kind. Compact vertices. Detail residency capped in bytes, falling back to L1.
- World: terrain CDLOD; instances per 256 m cell with far levels; roads painted into the terrain far away.
  Simulation meso over every tile from per-tile link tables; micro in the active region.
- Light: 3 shadow cascades, casters by level; shader catalogue compiled at load; KTX2 textures baked at build.
- Phases (player's queue): A undo/COOP/sim worker, B data, C threads, D buildings, E world, F light,
  G whole-map generator, H Steam. Current: D/E on the streaming world, and the full playtest from a blank
  map with the interface redesign that follows from its defect list (`tests/playtest/`).

## Work list (causes found by reading the code; re-read the line before fixing)
Root: a building record is the whole authored model (lot furniture inside, many JS objects a building).
Done: a tile's buildings are one typed table in a SharedArrayBuffer (`world/buildings/recordTable.ts`), made
where the tile is prepared; the page reads its records from it; cell jobs, growth, the tile write-back and the
far levels get buffers and rows, never objects or JSON text. The desktop's workers read and write the store by
ports of their own (`editor/workerParts.ts`). The sim worker takes the page's junctions (`'bake'`) but still keeps
a second RoadDoc + Network of the active region.
- Per-building derived data: bays, floors and spaces are kept per blocks list (`bayLayout`, `interiorAt`,
  `deriveSpaces`) and lot/kerb bays baked with the tile (`sim/tileBays.ts`); a worker job still decodes its records
  fresh, so the layouts are redone once per job and level. Fix: bake them into the tile's table as sections.
- Every tile load records 'roads' and runs `buildWorld`: the road surfaces now visit only the tiles that changed
  (`roadSurfaces.ts` PassState); the world job (`renderer.ts` `worldSteps`, one step a frame in `pumpWorld`) still runs
  on the page: the blocks' tiles joined (`surfaceTiles.ts` tileArrays), `details.prepare` (structure cells), `syncUtilities`,
  `roads.adopt`. Fix: each step's product built in a job from the changed blocks, the page only uploading it.
- `renderer.ts` `natureSweep`: the trees' scale is the average over the shown plates, so a plate shown re-picks
  every plate's lattice on the page (`farForest.ts` keeps each tree's pick and moves a uniform). Fix: picks kept
  per plate; check the forest density near the camera in shots before and after.
- Sim parked cars: the scenery's are rows (`ambient.ts` `SceneryCar`), but every row of the region is still
  told to the page, which keeps a view each (`simClient.ts` `parked`), and the walkers file a zone for each
  (`walk.ts` `ParkedZoneIndex`). Fix: the page told the rows near the view only (by place), the walkers'
  zones made for the cells walkers are in.
- Vehicles drawn (`render/agents.ts`): parked cars are kept instances and only the moving ones are written and
  sent each frame (upload ranges); left: moving traffic interpolated on the CPU each frame (fix: two poses per
  instance per tick interpolated in the vertex shader, every vehicle material and its depth material), the
  worker still writes all 23 fields of every vehicle each tick (`simHost.ts` publish), `forgetCast` walks every
  cast vehicle when the fleet moves, occupants allocate per seat per frame at the occupant zoom.
- Near products (gardens, furniture, signs, barriers, poles, structure cells, planted trees, covers, elements,
  lots) build only on active tiles (`render/activeTiles.ts`); still over the ring: camera solids, canyon light,
  building floors, the cover index.
- L1 lot furniture modelled face by face into the shell (`emitLots` -> `emitElement`, `emitLotPart`): the
  bulk of L1 triangles. Fix: instanced parts per kind (same look at L1 distance: shots before and after).
- Building shells cannot be simplified: each `Shell.face` is a loose quad, T-junctions round windows. Fix:
  each wall as one welded grid with the windows' holes sharing its vertices; then meshoptimizer.
- Slicing still in the code (amortization): `render/citizenBake.ts` `SLICE_MS` / `breathe` (people baked a few
  ms a frame on the page), `render/destruction.ts` `RELEASE_SLICE_MS` (a blow's fragments released a few ms a frame).
- Terrain: a stamp discards the worker-built mesh and rebuilds `TerrainIndex` (`terrain.ts`); textures
  re-uploaded whole; a river dab rebuilds the plate's every pool and river (`rebuildWater`, one water mesh a plate).
- Region only: city statistics and growth; near/far road joins at the region's edge do not match.
- 183 global-revision reads suppressed in `scripts/baselines/eslint-suppressions.json`.
- Caps that delete the player's work (`MAX_PLANTED_TREES` and the other caps in `doc.ts` drop items of loaded
  tiles and the tile write stores them as gone). Fix: nothing he built is dropped; the limit becomes cost, not loss.
- Signature buildings without a far level: `massing.ts` `massWriter` skips their body (`!signature`). Fix: give
  them L2/L3 masses.
- Textures: KTX2 UASTC not baked yet (Architecture, Light).

## Lessons (DO NOT redo)
- `BatchedMesh` for building shells: keeps its whole capacity on the CPU (`_initializeGeometry`). Undone.
- Mass painted with the detail's colours instead of detail: looked worse. Undone.
- Index-only meshoptimizer levels on the current shells: almost nothing reduced (open borders). Undone.
- `clipper2-ts` horizontal-edge bug patched (`scripts/patches/`); keep the patch.
- Right as they are: upload ranges (`addUpdateRange`) in agents, transit, grass, shadows, effects, trees and
  poles; picking by the ground plane; on-demand frame loop; sRGB, ACES, PMREM sky, no fog; reversed float depth.

## Commits, branches, agents
- `git status` first; commit only your paths (`git commit --only <paths>`) after reading their diff. Every
  file saved in the main folder reloads the game on 5300.
- Agents only when the player asks for them: up to 10 at once, each in its own worktree from local `main`,
  one part each, no two on the same files. Agents run no process besides git and reading/writing files. Read each diff whole before merging.
  Remove a worktree's junctions with `rmdir`, never `rm -rf`; delete the branch once merged.
- Push only to `roadcraft4` (https://github.com/designathan1988/roadcraft-4.0.git); NEVER to `original` (a
  local copy of an older extract). Never touch ports 4180-4183, 5173, 5175-5178.

## Traps by area
**render** (only `src/render` imports `three`)
- Reversed depth in a float buffer (`depthConvention.ts`): distant flicker is never fixed by pushing the near
  plane; a pass that reads depth uses `DEPTH_GLSL`.
- The shadow moves in whole ground texels (`environment.ts`); the sun in 0.1° steps. `shadowMap.enabled`
  depends on the quality level.
- World `y` becomes three's `z` and flips direction.
- `earcut` on a long thin strip makes huge triangles: cut it first (`splitToSpan`).
- Textures and materials made once; never in a rebuild. A shared material needs the same program variant.
- `vertexColors: true` on the material, or per-vertex colour does nothing.
- `compileAsync` with the post-processing target.
- People: MakeHuman baked ahead (`cooked/`, version in `scripts/vite/cook-plugin.ts` `CAST`); skeletons on
  the GPU: `renderPalettes` after `update`, before drawing.
- Never two surfaces of a building in the same plane.
- Asphalt shader: `uv.x * ASPHALT_TILE` is across the road.
- Instance buffers sized by `FLEET_CEILING` and `PED_CEILING` (`sim/params.ts`).
- A new visual effect goes in `postprocess.ts`, behind an option in `quality.ts`.

**world**
- One cut per road end (`approach.ts`) feeds mouth, zebra, stop line, lane and kerb.
- `HEADING_CHORD` belongs to `sim/pose.ts`, `conflictPoints.ts` and `turnPaths.ts` together.
- `heightAt` is the field; `renderedHeightAt` is what is drawn.
- A tunnel is a step in the terrain plus a portal; `TUNNEL_*` and `CUT_SHOULDER` go together.
- A road at grade is a projected line (`solveGround`); a junction takes its legs' height.
- A building edit moves `doc.buildings.revision`, never `doc.revision`.
- Terrain cell 6.4 m; one unit is one metre. Road numbers in `roads/tuning.ts`: change one only for a defect seen in a shot, the reason in the commit.

**sim**
- One writer per field; stage order in `pipeline.ts`. `clock.tick` only at the end of `step`.
- `archetype` is the machine, `driver` the person. A lane change occupies two lanes (`bodiesIn`).
- A signal stage never groups crossing movements.
- `WALKER_SHAPE`: every field of a pedestrian declared at once.
- `SimWorld.doLess` must give the same result as doing everything.

**editor**
- `commitDraft` adopts the network only after it is rebuilt. Every road edit pays in `roads/economy.ts`.
- New tool: `Tool` in `toolMachine.ts`, a `case` in `main.ts` `pointerdown`, a key in `gameKeys.ts`, a
  place in `ui/v2/shell.ts`, `tool.`/`hint.` keys in both dictionaries.
- Loading validates with the document's own predicates (`persistence.ts`).

## Third-party assets
- Trees are procedural (`render/lowPolyTrees.ts`); proportions follow Kenney's Nature Kit.
- People: MakeHuman base and community items (`public/models/people/`, licences in
  `proxies/community.json`, CC-BY credited in the About panel), Rocketbox (MIT), Quaternius (CC0). The licence
  texts in `public/models/people/` and `public/models/citizens/` ship with the game and must stay.
- The people catalogue offers every community item (`people/wardrobe.ts` `itemsOf`).
