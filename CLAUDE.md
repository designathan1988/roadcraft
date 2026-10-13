# CLAUDE.md — Roadcraft 2

Browser game (TypeScript, three.js, Vite): the player builds roads on sculptable terrain, grows a
town, and traffic, people and public transport are simulated live. ONE flat map, about 10 km on a
side (`world/bounds.ts`), one world unit a metre. The spherical planet, the flat Earth and the 0.4 m
unit were taken out on 2026-10-13 (the player's decision). The Actions dock has the PISTOL and the
BOMB (explosion, buildings falling apart, people and cars thrown, casualties, fire, craters). Every
edit takes effect at once.

This repository (`C:/Codex-Shared/roadcraft-2`, remote `origin` =
`https://github.com/designathan1988/roadcraft-2.0.git`, branch `main`) replaces the old Roadcraft.
Only code the game really uses comes here, and every engineering fault is fixed at its cause. The
old repository and worktrees (`C:/Codex-Shared/Roadcraft`, `C:/Codex-Shared/roadcraft-planeta-esfera`,
`roadcraft-agente-*`, `roadcraft-terrario`) are read-only references: never edit or delete them.

Out of the game for good: the "Jogar" mode (walking/driving as a person, 1st/3rd person), crime and
police, residents with inner lives, the human generator, creator, people-lab, sandbox, studios,
weapons lab and the `*-system.html` pages. FORMA is a separate project (`C:/Codex-Shared/forma`).

Code, comments and docs are in English. Player-facing text lives in `src/ui/i18n/en.ts` and
`src/ui/i18n/pt-BR.ts` (always both). Everything the player reads in chat and every commit message
is in Brazilian Portuguese.

State: `docs/STATUS.md`. Plan: the CURRENT stage of `docs/PLAN.md` (the only plan). Architecture
and the chain of dependencies: `docs/ARCHITECTURE.md`. Open problems: `docs/PROBLEMS.md`.

## Research before every change (non-negotiable)

1. Before writing or changing code, search for the task and the intended approach and READ the
   sources: official docs and source (three.js, Khronos, MDN, Vite, Vitest, Playwright, TypeScript,
   Chrome), maintainers' issues, standards and manuals (OpenDRIVE, AASHTO, NACTO, DNIT/MBST, HCM,
   GTFS), simulators and engines (SUMO, MATSim, Unreal, Unity, Cesium), GDC/SIGGRAPH talks and
   post-mortems. Search snippets do not count. Memory and local files do not replace it.
2. Start from what was already researched: `docs/reference/` and `docs/research/`.
3. Before editing, write one short message: what was found (with links), the confirmed cause and
   the approach. Then code. Trial and error is forbidden: never improvise, guess or "try and see".
4. After two failed attempts at the same problem (verification failed or did not confirm), stop and
   research again before a third; changing tool or approach does not reset the count. Record the
   attempts in `docs/PROBLEMS.md` ("Already tried").
5. No internet or not enough evidence: stop and say so. Never invent sources or claim research
   not done. Research never widens scope or replaces verification.

## Architecture (enforced by `eslint.config.js` and `tests/arch`)

```
core → world → sim, render;  world → editor → ui;  core → view → render, ui
```
`core` pure math; `world` the document and everything derived that is not a picture; `sim`
vehicles, people, transit, signals (never reads `render`); `view` world↔screen; `render` owns
three.js (nothing else imports `three`); `editor` turns input into commands; `ui` the DOM.
`main.ts` only wires modules together: no game logic in it.

Global controllers, each the ONLY writer of its data:
- **Document**: changes only through COMMANDS with an inverse. Undo, redo and autosave never copy
  or serialize the whole document.
- **Session/UI state** (tool, mode, view, selection, panels, quality): one typed store with
  recorded changes (what, from what to what, why), visible in F9.
- **Tool and mode state machines.**
- **One typed event bus** with a closed list of events and a documented delivery order.
- **One command registry** behind shortcuts, menus, the dock and search.
- **Simulation**: sole owner of agents; others read per-frame views.
- **Render**: sole owner of scene objects.
No mutable state loose in a module. One read-only debug surface.

The chain: command → change diary (rectangles) → dirty CELLS of a fixed grid → per-cell derived
data (network, road heights, shaped ground, road surfaces, structures, grass, poles, furniture,
lanes and junctions, walkways, lot bays, yards and docks, buildings) → simulation and render of the
affected and visible cells only. Each derived product declares what it reads and who depends on it.
- Nothing derived reads the whole map on an edit. A scale test proves the same edit costs the
  same on a small map and a large one (work counters, not timings).
- A topology change never stops the traffic: vehicles are remapped, not paused.
- Invariants: road height is a continuous function of position; every band of a road reads the
  same deck height; junction plates are flat; `world` and `sim` never call `Math.random`
  (`core/rng.ts`); one writer per field.
- One file, one responsibility; no file over 800 lines.

## Performance and quality (judged at load: 400 people, 400 vehicles, big road networks)

- Cost depends on what changes and what is seen, never on the map's area.
- Closed catalogue of materials and shader variants, all compiled at load (`compileAsync`):
  zero shader compiles during play. Never create a material inside a rebuild.
- Texture and buffer uploads have a per-frame budget; nothing big is uploaded during play.
- ONE people system, animated on the GPU, prepared at build time (bodies, clothes, clips, LODs):
  nothing is dressed, baked or animated on the CPU during play. People look good up close.
- Vehicles: merged mesh per model, real LOD chain built offline, per-instance culling, shadows on a
  budget. Cars look as good as before up close.
- Shadows: cascades; small objects stop casting far away; the shadow map is redrawn only when a
  caster moved. Post-processing has a per-pass GPU budget. Nothing is drawn that is not seen.
- Ground: plates drawn in full only near the view, the far view a simplified mesh per plate
  (`render/flatAtlas.ts`), opening without stalls.
- No allocation in hot loops (frame, sim step). Nothing computes geometry inside a draw call.
- Optimise without losing visuals. Small visual trade-offs for speed are yours to decide; removing a
  feature or changing gameplay needs the player's yes. No fixed population cap: the limit is what the
  machine sustains.
- Fix causes, not symptoms. A defect is a class: fix it where it is generated and add a test or an
  F9 check so it cannot return. Never silence errors (no empty or silent `catch`), skip or weaken
  tests, or loosen lint.
- Physical plausibility: nothing floats, passes through things or teleports.

## Protection against regressions

Regressions are stopped by reading the code, in seconds, never by playing the game before a push
(the player, 2026-10-13: no slow processes, no endless tests; research and sources in
`docs/research/regression-barrier.md`).
- `npm run check` (`scripts/check.mjs`, about a minute): lint (layers, file size, no empty/silent
  `catch`, no module state; cached by file content), the code rules, `knip` (no unused file, export
  or dependency), the specs, architecture tests, the counting (scale) suites, the build. It runs
  what the change can affect (git against HEAD: docs only → nothing; tests only → no build; the
  specs whose imports reach a changed file, `vitest related`, plus those that read the code as text,
  `ALWAYS` in `scripts/check.mjs`; data read by path is in `forceRerunTriggers` and runs them all),
  each step under a hard limit, stops at the first failure and prints the seconds of each step.
- Held, not only asked (`.claude/settings.json` → `scripts/gate.mjs`): a turn of a conversation that
  edited a file here (docs aside) does not end while the check is red; the reason reaches Claude.
  Continued by the gate and still red, the check runs once more and the turn ends with a warning
  to the player. Edits made by shell commands only (sed, git rm) are not seen: run the check by hand.
  Red because of another conversation's files: say so; never change or commit them.
- The pre-push (`.githooks/pre-push`, `npm run setup` once) runs `npm run check:all` on the COMMIT
  being pushed: in place when the folder is that commit, else on its files exported to a temporary
  folder (`scripts/prepush.mjs`), so one conversation's unsaved work neither blocks another's push
  nor hides a file a commit forgot.
- Heavy jobs take the machine's lock (`scripts/run-limited.mjs`): one at a time, below-normal
  priority on four cores; the wait has an end (`RUN_LIMITED_WAIT_S`) and names who holds the lock.
- The code rules (`scripts/check-code.mjs`, ~8 s): one TypeScript program types the code and
  builds the call graph from the functions marked `@perFrame` (`main.ts` `frame`, the sim
  `step`). Nothing a frame reaches makes a three.js material or compiles a shader; per-frame code
  (up to a function marked `@rebuild`: its work runs only when what it reads changed, or once)
  calls no JSON, `structuredClone` or bounding-volume computation and loops over no collection as
  big as the map; key listeners on the window only in `main.ts`. What was there is in
  `code-rules.baseline.json`, which only shrinks; `--why "<text>"` shows how a frame reaches a
  finding. A `@rebuild` mark is a claim the analysis trusts: put it only where it is true.
- The rules of the tests (`tests/arch/testRules.spec.ts`): every test runs in every check (no
  `.only`, `.skip`, `.todo`, `skipIf` or `runIf`: a test that needs an environment variable or a
  file of one machine runs nowhere; `it.fails` stays for a recorded defect); no real clock (no
  `performance.now()`/`Date.now()`, no wait on a timer, unless the file installs fake timers): work
  is counted, never timed; every test finishes in 10 s (`vitest.config.ts` testTimeout, none may
  declare more). The specs that took longer are listed in `tests/slow.json`, run only by
  `npm run test:slow`, and are rewritten to run in seconds (a small scenario of the same defect,
  counters, model-based tests) until the list is empty; the list only shrinks.
- Performance is checked as counts, not timings: each derived product has a work counter, and the
  same edit costs the same on a small map and a large one (`tests/scale`). Wall-clock measures
  are noise and never block anything.
- Loosening a tolerance, budget or test limit needs the line `aprovado pelo jogador em <data>`.
  The performance gate in Chrome before each push was removed: aprovado pelo jogador em 2026-10-13.
- A test written for a defect must fail on the old code and pass on the new.

## Verify (no exceptions, and short)

- After a change the player can see, open the game in the in-app browser with the pane DISPLAYED
  (hidden it draws 0 fps; ask for Ctrl+Shift+B once and wait), go straight to what changed (the
  debug surface puts the camera there) and use it as the player does: real controls, a few
  different inputs, close and far, in the views it touches. Minutes, not long scripted probes:
  no scenario runs, no dozens of pictures, nothing left running.
- Take pictures, open every one and look for what the player would see wrong (hidden or cut text,
  overlaps, misalignment, floating or sunken parts, wrong language, aliasing, pixelation, jumps).
  Watch motion over time; a still proves nothing that moves. Fix every defect seen and look again.
- Report, picture by picture, what was checked. Code, logs, no errors or green tests never prove
  that something works. Cannot open or use it: write NÃO VERIFICADO with the reason.
- Probes: stub `requestPointerLock`; never run probes or edits on the player's map origin.
- "Done" is measured and seen; "closed" only when the player checked it.

## Servers and the player's maps

| port | what |
|---|---|
| 5300 | dev server of this repository (scratch storage) |
| 5301 | a production build looked at by hand, when a check needs one (cleared storage) |
| 4300 | the player's game: production build of the last verified commit only |
| 4299 | the old game (reference build of the source commit), read-only |

The player's saved maps live in the browser storage of the old origins (4180, 5173, 5175-5178,
4181-4183) and in `C:/Codex-Shared/backup-mapa-jogador`. Never clear them. Before any change to
persistence, back them up to files and prove each one opens in this game.

## Git, sessions and the machine

- One repository, branch `main`, ONE session writing at a time; no worktrees, no parallel branches.
- Commit each verified step with code and docs together (message in Brazilian Portuguese), then
  `git push origin main`. Never force-push. Stage explicit paths.
- One heavy job at a time (`scripts/run-limited.mjs`); never saturate the CPU (the player plays on
  this machine, RTX 3060); vitest with at most 6 workers; no automatic invisible Chrome.
- Agents only under the rules of `C:/Codex-Shared/Roadcraft/PROMPT-AGENTES.md`; no agent spawns
  agents.

## Commands

```bash
npm run dev            # the game on localhost:5300
npm run check          # what the change can affect: lint, code rules, knip, specs, counters, build (~1 min)
npm run check:all      # every step whatever changed (the pre-push runs it on the pushed commit)
npm run test:slow      # the slow specs of tests/slow.json, by hand only, while they are rewritten
npm run cook:people    # after changing people code or assets (dev server up)
```
