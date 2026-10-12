# Architecture — Roadcraft 2

The rules are in `CLAUDE.md`; this file says how the code meets them, stage by
stage. Each stage of `docs/PLAN.md` writes here, BEFORE it starts, what it
changes in the chain (what it reads, what it writes, who depends on it), and the
code is checked against it when the stage closes.

## 1. Layers

```
core → world → sim, render;  world → editor → ui;  core → view → render, ui
```

| layer | holds | never |
|---|---|---|
| `core` | pure maths, geometry, RNG (`core/rng.ts`), generic containers (state store, diary, event bus, command registry) | DOM, three, `Math.random` |
| `world` | the document and every derived product that is not a picture (network, road heights, ground shape, lanes, walkways, lots, docks, buildings' plans) | three, DOM, `sim`, `render` |
| `sim` | vehicles, people, transit, signals; sole owner of agents | `render`, three, DOM, `Math.random` |
| `view` | world ↔ screen (cameras, projections, the planet's charts) | three objects, DOM panels |
| `render` | everything three.js; sole owner of scene objects | the document's writers, DOM panels |
| `editor` | input → commands on the document; tools and their state machines | three, DOM panels |
| `ui` | the DOM: shell v2, panels, i18n | three |
| `main.ts` | wiring only | game logic |

Enforced by `eslint.config.js` (layer table, carried from the SOURCE) and
`tests/arch` (from E3: also file size, module state, silent `catch`, cycles).

## 2. Global controllers (one writer each)

State at the SOURCE (`4cc2926e`) → target, and the stage that does it.

| controller | at the SOURCE | target | stage |
|---|---|---|---|
| Document | `world/doc.ts` `RoadDoc`, mutated in place by tools through `main.ts` `mutateBuilt`; ~20 revision counters derived from the diary | changed only by COMMANDS with an inverse; records keyed by id; each edit returns its patches | F2 |
| Undo/redo, autosave | `editor/history.ts`: whole document as text before and after each edit (12.7 MB per edit on a generated city); `editor/persistence.ts` rewrites the whole map (localStorage ≤ 2.4 M chars, else IndexedDB) | history of patches (bytes ∝ change); autosave of dirty records only | F2 |
| Diary of changes | `world/changes.ts` `ChangeJournal`: kinds × rectangles × cause, ring of 2048; consumers partly use it (`groundChanges`, `touches`) | the only input of every derived product, mapped to dirty cells of a fixed grid | F3 |
| Session/UI state | `core/gameState.ts` `GameState`: one store with recorded changes (key, from, to, cause), watchers flushed in a microtask, F9 "estado" tab. Not every session value lives there yet (loose `let`s in `main.ts`) | every session value in the store; nothing loose in a module | F1 |
| Tool and mode | `game.tool` string + `setTool`/`pickTool`/`showTool` in `main.ts`; mode switch `ui/modeChooser.ts` | explicit state machines (SCXML semantics: run-to-completion, internal queue) | F1 |
| Event bus | none: watchers of `GameState`, the diary, direct calls | one typed bus, closed list of events, documented delivery order | F1 |
| Command registry | shortcuts, dock, drawers and menus call `main.ts` functions directly | one registry behind shortcuts, menus, dock and search | F1 |
| Simulation | `sim/world.ts` `SimWorld` owns agents; `doLess` already sleeps signals, cleans locally, caches by revision | unchanged ownership; topology patched, agents remapped, never paused | F3, F11 |
| Render | `render/renderer.ts` `SceneHandle` owns the scene; `rebuildWorld` behind revision gates | per-cell products, closed material catalogue | F3, F5–F8 |
| Debug surface | `window.__roadcraft` (reads AND writes: `generateCity`, `loadDoc`, `lookAt`...), `__state`, `__changes`, `__gpu`, `__frames`, `__health` | one read-only surface; the gate drives the game through real controls and a separate test-only command port | F1 |

## 3. The chain

```
command ──► document (records) ──► diary entry (kind, rectangles, cause)
                                        │
                                        ▼
                          dirty CELLS of a fixed grid
                                        │
   ┌────────────────┬───────────────────┼──────────────────────┬───────────────┐
   ▼                ▼                   ▼                      ▼               ▼
 network ──► road heights ──► ground shape ──► road surfaces   lots/zones ──► buildings
   │              │                │      └─► structures, grass, poles, furniture
   ▼              ▼                ▼
 lanes & junctions ──► walkways, lot bays, yards & docks ──► simulation (affected cells)
                                                          └─► render (affected AND visible cells)
```

### 3.1 Derived products at the SOURCE: what each reads today

Measured and read in the code (audit `docs/reference/auditoria-roadcraft-2026-10-12.md` §3,
and the files below). "Whole map" marks the products that F3 turns into per-cell ones.

| product | file | gate today | reads | cost class |
|---|---|---|---|---|
| network | `world/network.ts` | `doc.revision` | roads | incremental since V0 (`rebuild({full})` only on open) |
| lanes (lanelets) | `world/lanelets.ts:220-243` | `net.trafficRevision` | network | **whole map**: cleared and rebuilt every edit (55 ms at 0.7 km, 6.8 s at 4.3 km); traffic paused meanwhile |
| walkways | `sim` walkway graph | network revision | network | **whole map** (1.35 s) |
| lorry docks | `sim/agents/lorryDocks.ts:323` | key includes `net.revision` | network, buildings | **whole map**: any road invalidates every dock's manoeuvre (A*) |
| lot bays | `sim/.../lotTraffic.ts:243` | lanes revision | lanes, lots | **whole map** |
| road heights | `world/elevation.ts` | `doc.revision`, `terrainRevision` | network, terrain | solved per edit, offered to render |
| ground shape | `render/terrain.ts` | diary (`groundChanges`) | heights | per region (P1–P3 fixed) |
| road surfaces | `render/roadSurfaces.ts` | tile keys (`dependsOn`) | heights, network | per tile (P2 fixed) |
| grass / scenery | `render/renderer.ts:1915` `buildScenery` → `buildGrass` | network/terrain revisions | ground, roads | **whole map** every road |
| poles, furniture | `renderer.ts` | `doc.utilityRevision` | network, utilities | whole layer per revision |
| buildings | `render/buildings/*` | `buildings.revision` | buildings, terrain | per building, but solids key on global revisions (`renderer.ts:3299`) |

### 3.2 Rules for every derived product (from F3)
- It declares its inputs (diary kinds + the cells it reads, with its neighbourhood) and its dependents.
- On an edit it recomputes only dirty cells and their neighbourhood; a scale test counts its work on a
  small and a large map and the counts are equal.
- It never keys a cache on a global counter (rule that already cost dearly at the SOURCE: `docs/PROBLEMS.md`).
- A topology change never stops traffic: vehicles are remapped.

## 4. Events (F1)
Closed list and delivery order: written by F1 before code.

## 5. Commands (F1, F2)
One registry; written by F1 before code.

## 6. Persistence (F2)
Written by F2 before code. Until then the SOURCE's format is kept byte for byte, so the player's maps
open unchanged (proved in E2).
