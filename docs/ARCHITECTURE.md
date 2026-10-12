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

## 4. F1 — global controllers (written before the code)

What F1 changes in the chain: nothing in the document or in any derived product.
It changes WHO decides what the player's input does, and who owns the session's
values. Reads: input events, the session store. Writes: the session store (tool,
mode, view, selection...), and calls the same functions the SOURCE calls
(`setTool`, `undo`, `cameraCommand`...). Depends on it: `ui/v2/shell.ts`, the
keyboard handlers of `main.ts`, the F9 panel. Proof of no change: the gate and its
pictures equal before and after (A/B within the A/A noise).

### 4.1 Session store
`core/gameState.ts` `GameState` already is the store F1 asks for (one writer,
every change recorded with from/to/cause, watchers flushed after the task, F9
"estado" tab). F1 keeps it and moves into it the session values still loose in
`main.ts` (32 module-level `let`s at the SOURCE, listed by the lint rule
`roadcraft/no-module-state`), or into the controller that owns them (render
caches into `render/`, flight into the flight module).

### 4.2 State machines (`core/statechart.ts`)
SCXML semantics (W3C SCXML, read for F1): an event is processed to completion
(a macrostep); events raised during it go to an internal FIFO drained before the
next external event; a transition runs exit actions (innermost first), its own
actions, then entry actions; among enabled transitions the first in document
order wins and a child's beats its parent's; guards are pure; every transition is
recorded (from, event, to, cause) in the same ring the F9 panel reads.
- `toolMachine` (`editor/`): states = the tools (`inspect` is the free hand);
  events `pick(tool)`, `putDown`, `escape`, `gesture.start/end`. Today's rule
  "a tool button picks the tool, or puts it down when it is already in hand"
  (`pickTool`) becomes one explicit transition; the "one click on Roads turns the
  tool on and off" defect (F12) is then a fact about that transition, testable.
- `modeMachine` (`ui/`): `planet` / `flatView` in the planet build, `flat` in the
  flat build; `switch` → in place, or to the other page.

### 4.3 Event bus (`core/bus.ts`) — written, enters with F2
Its first events are the document's (`doc.committed`, `history.changed`,
`persist.*`), which F2 introduces; the session values already have their
watchers (`core/gameState.ts`). A module with no caller would be dead code, so
the bus lands with its first listener.
A closed, typed union; synchronous delivery in registration order by layer
(world → sim → render → editor → ui); the listener list copied at the start of an
emission; an emission during a delivery is queued and delivered after it (run to
completion); a listener that throws is reported (`health`) and the others still
run. The bus never draws: a listener that needs a frame asks for one.
Closed list (F1): `doc.committed {cause, kinds, rects}`, `doc.loaded {source}`,
`history.changed {canUndo, canRedo}`, `tool.changed {from, to}`,
`mode.changed {from, to}`, `selection.changed`, `view.changed`,
`persist.saved {bytes}`, `persist.failed {reason}`, `notify {key, params}`.

### 4.4 Command registry (`core/commands.ts` + `editor/gameKeys.ts`)
One table of commands — `{ id, label (i18n key), enabled(ctx), run(ctx) →
'done' | 'cancelled' | 'pass' }` — and key rules `{ code | key, ctrl, shift, alt,
when, command, args, prevent }` (the operator of Blender, whose PASS_THROUGH is
`pass`, and the keybindings of VS Code: the last rule bound whose key and `when`
match and whose command does not pass wins). `editor/gameKeys.ts` writes the
rules first-wins, in the order the SOURCE's listeners read keys (flight, the tool
in hand, Q/E, page shortcuts, Delete, Space, terrain, road classes, F8, tool
letters, Escape, camera), and binds them reversed. Done in F1: the four game
`keydown` listeners of the SOURCE (three in `main.ts`, the drawer's in
`ui/v2/shell.ts`) are one listener in `main.ts`; one key runs one command
(PROBLEMS R16). The select widget's own keys (WAI-ARIA APG listbox, capture
phase, only while a list is open) and the compass button's stay with those
widgets: they are focus-scoped, not game commands. Keyup (held camera and
flight keys) stays one listener each. Still to route through the registry: the
dock, the drawers, the menus and the top bar (they call the same functions the
commands call).

### 4.4b Tool machine (done in F1)
`editor/toolMachine.ts`: the tools are states, the road tools children of
`roads`; `pick`, `toggle` (a tool's button or key) and `putDown` are its events;
entering a state is the only call of `takeTool` (`main.ts`), the only writer of
`game.tool`. `tests/editor/toolMachine.spec.ts` checks it against the SOURCE's
`pickTool` rule for every pair of tools. Its transitions are in `__state()`
(`toolMachine`) and in the F9 state tab.

### 4.5 `main.ts`
Only wiring after F1 and F4: it creates the controllers and hands each its
collaborators. Logic it holds today moves to the module that owns the data (F4
splits it under 800 lines).

## 5. Commands on the document (F2)
Step F2a done (2026-10-12): `world/docImage.ts` (the image and the patch),
`RoadDoc.restore` (the one writer that puts records back), `editor/history.ts`
(`begin`/`end`, undo and redo by patches). Measured on the player's big map
(1 348 buildings): undo/redo frame 177–185 ms → 7–15 ms. Drawing a road costs
the same as before: a whole-document text is only 4–6 ms there (the buildings'
text is cached per record); the click's cost is `commit/clone` (18–20 ms) and
the work after the edit (60–100 ms) - the next steps.

What the SOURCE does: every edit (`main.ts` `mutateBuilt`) serializes the whole
document before and after (`serializedDoc`, cached while no diary counter moved),
compares the two texts to know whether anything changed, and pushes the "before"
text on the undo stack (`editor/history.ts`, 60 steps, 96 MB budget). Undo parses
a whole snapshot and replaces the document (`applySnapshot`). The autosave writes
the same whole text. On a city of 1 530 buildings that is 12.7 MB serialized per
edit, twice, and parsed per undo.

Sources read: tldraw `packages/store/src/lib/RecordsDiff.ts` (a diff is
`added`, `updated [from, to]`, `removed` by record id; the inverse swaps added and
removed and each from/to; squashing keeps the first `from` and the last `to`,
and an add then remove cancels), Excalidraw `packages/element/src/store.ts`
(changes found by comparing each element's `version` with the last snapshot's,
cloning only the changed ones; the inverse delta is computed on undo), Nystrom
*Game Programming Patterns*, "Command".

Design:
- The document's ~60 writers (`world/doc.ts` `addNode`, `setSegmentLanes`,
  `addTerrainStamp`..., `BuildingStore.add/put/remove`) are already the only
  way records change (direct field writes outside them are being audited: one
  found, `world/rescale.ts`). Each writer tells the open transaction the record's
  state BEFORE it changes (`tx.before(collection, id, record)`, a clone of that
  one record, once per record per transaction) and after (`tx.after`).
- `mutate` opens the transaction, runs the edit, closes it into a `RecordsDiff`
  per collection. An empty diff is "nothing changed" (replaces the text compare).
- History keeps diffs: undo applies the reverse diff through the same writers
  (so the diary, dirty cells and derived data follow as for any edit), redo the
  diff. A gesture (a drag, a brush stroke) squashes its diffs into one step.
  Bytes held are proportional to what changed.
- Collections kept as arrays without ids (terrain stamps, paint, fog and gully
  dabs, clouds, trees, zones, lots...) get ids or are diffed as appended ranges;
  decided per collection in F2.
- Proof: a fast-check model test (`fc.commands`) runs random edits, undoes all
  and compares with the start (deep equal), redoes all and compares with the end;
  a debug check compares the diff with a full serialization on every edit in
  tests and in F9.
- Autosave: the dirty records of the diffs since the last save, written to
  IndexedDB by record in one transaction; the whole-map text only for "Save as"
  and export. Persistence changes only after the player's maps are backed up
  again and each one reopens (CLAUDE.md).

## 6. Persistence (F2)
Written by F2 before code. Until then the SOURCE's format is kept byte for byte, so the player's maps
open unchanged (proved in E2).
