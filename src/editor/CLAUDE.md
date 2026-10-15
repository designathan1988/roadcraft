# src/editor (and main.ts, buildingsWiring.ts) — tools that change the document

Rules for the whole repository are in the root `CLAUDE.md`. `main.ts`,
`index.html` and `src/ui/**` are edited by the interface session too: check the
owner in docs/STATUS.md before changing them.

## Couplings

1. **`commitDraft` adopts its work network**, rebuilt after the draft's segments
   are added. Adopting it before that hands back a stale network stamped current.
2. **Revisions:** a road edit moves `doc.revision` (and `trafficRevision` only if the
   road plan changes); a building edit moves `doc.buildings.revision`, never
   `doc.revision`; utilities move `utilityRevision`. The wrong one rebuilds
   everything or nothing.
3. **Every road edit is paid for in one place** (`roads/economy.ts`,
   docs/source/VIAS.md V0): take `roadsBefore(doc)` before the edit and
   `settleRoadEdit` after it; refuse with `funds` when it is not affordable.
   `commitRoadPath`, `commitDraft`, `guardRoadEdit`, `moveNodeChecked` and the
   bulldozer do; a new tool that changes roads without them builds for free.
4. **Road snapping** (`snap.ts` `roadSnap`/`setRoadSnap`, stored in localStorage
   `roadcraft.roadSnap`) works on the universal grid (`world/grid.ts`): points on
   the 1 m subdivision, lengths in whole 10 m cells (`ZONE_CELL`).

## Traps that have already caught someone

- **The terrain brush is paced by what the last rebuild cost**
  (`TerrainBrushHost.interval`, `editor/terrainBrush.ts`, wired in `main.ts`):
  a dab that moves the land rebuilds the ground (and, after the stroke, the
  roads on it), and dabbing on every pointer sample queued rebuilds. The pacing
  is an amortization (class C8 of `docs/PLANO-ESPINHA-2026-10-14.md`): it goes
  when a dab rebuilds only the cells it touched.
- **A missing hint key shows a blank hint bar, not an error.** `hintKey` derives
  the key from the tool.
- **A brush stroke covers the whole way between two pointer reports.** The
  browser coalesces fast moves and a slow frame reports the pointer far apart:
  `lotTool.ts` walks from the last sample in `STROKE_STEP` (2 m) steps.
  Testing only the reported point zoned one lot in three along a street.
  `tests/editor/zoneStroke.spec.ts`.
- **Heavy commands go through `scripts/run-limited.mjs`** (vitest, tsc, probes,
  builds): at once, inside the conversation's Windows job (`scripts/sessionJob.mjs`,
  a hard cap of 25% of the CPU and 8 GB, the children inside), below normal
  priority, stopped after `RUN_LIMITED_TIMEOUT_S` (480 s). There is no machine
  lock and no wait for the CPU (removed in 03c2647). Call node, not npx:
  `node scripts/run-limited.mjs node node_modules/vitest/vitest.mjs run …`.

- **The load boundary validates with the document's own predicates**
  (`persistence.ts` isSerializedDoc: `readRelief` from `world/terrain.ts`).
  A list of its own here went stale when a new relief (4) came: every map
  with it was set aside as unreadable on the next reload and the game opened
  empty (PL20). A value the document reads must pass here too.

## How to add

- **An editing tool:** add it to the `Tool` union and `TOOLS` in
  `editor/toolMachine.ts` (under `roads` if the Roads button holds it), a `case`
  in the `pointerdown` switch of `main.ts` and a letter in `TOOL_LETTERS` of
  `editor/gameKeys.ts` (keys are rules there, never a new `keydown` listener); give it its
  place in the interface (`src/ui/v2/shell.ts`: `categoryOf`, the panel of its
  category, and `CATS` for a new one in the dock); then `tool.<name>`,
  `hint.<name>` in both dictionaries. The junction-control
  tool (`cycleNodeControl`) is the smallest complete example.
- **A terrain brush:** `world/terrain.ts` first (see `src/world/CLAUDE.md`), then its
  button in the interface, then `TERRAIN_BRUSH_COLOUR` and `TERRAIN_BRUSH_FILL` in
  `main.ts` (or the ring preview throws), then both dictionaries including
  `hint.terrain.<mode>` (a key nothing asks for fails `tests/ui/i18nKeys.spec.ts`).
