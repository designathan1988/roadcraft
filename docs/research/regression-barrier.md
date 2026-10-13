# The regression barrier: reading the code, in seconds (2026-10-13)

Question (the player's): how to stop regressions without the performance gate that played the
game in Chrome for 2.5–4 hours before every push, which tested a few scripted scenes and let
other defects through. Constraint: no slow processes, no endless tests; checks read the code;
the visual check after a visible change stays, short and targeted.

## What the gate did (measured, 2026-10-12)
- 2.5–4 h per push; 8+ machine hours in one day.
- Caught three real things: the physics break of the old code (R1), +40 ms on the road click
  (F2a, fixed), the bomb on the planet +7 ms (effect of the R1 fix).
- Missed by construction: it only compared base against candidate, so a cost present on both
  sides never showed (the poles and furniture of the whole map rebuilt twice per road, 52–63 ms
  in one frame, found only by a CPU profile); it only saw scripted scenes (the double key
  actions, R16; the signals the player reported; R9–R15); wall-clock time is noise (first
  version: 114 false "regressions").

## Sources read
Industry practice
- Chromium: perf tests too long to run on every revision; regressions found after landing on a
  dashboard and bisected (Pinpoint). https://chromium.googlesource.com/chromium/src/+/HEAD/docs/speed/bisects.md
- Mozilla: perf alerts after landing, confirmed over 12 later data points, handled by sheriffs.
  https://wiki.mozilla.org/TestEngineering/Performance/Sheriffing
- Software Engineering at Google, ch. 23: presubmit runs "only fast, reliable ones", larger
  tests postsubmit. https://abseil.io/resources/swe-book/html/ch23.html
- Ch. 11: speed and determinism are the most important qualities; "a bad test suite can be worse
  than no test suite"; slow or flaky suites get skipped; 80/15/5 mix.
  https://abseil.io/resources/swe-book/html/ch11.html
- Google Testing Blog, "Just say no to more end-to-end tests".
  https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html
- DORA: tests before integrating in a few minutes, about 10 at most.
  https://dora.dev/capabilities/continuous-integration/
- Memon et al., ICSE-SEIP 2017: few tests ever fail, and those that do are "close" to the code
  changed. https://research.google/pubs/taming-google-scale-continuous-testing/
- Test impact analysis (run the tests tied to the change).
  https://martinfowler.com/articles/rise-test-impact-analysis.html ; https://vitest.dev/guide/cli

Counting instead of timing
- rustc: instructions:u instead of wall time; a neutral change: ±0.2% (outliers ±1.3%) against
  ±9% for wall time; detects 0.3%.
  https://internals.rust-lang.org/t/what-is-perf-rust-lang-org-measuring-and-why-is-instructions-u-the-default/9815
- Cachegrind instruction counts varied by a few instructions in 2.27 billion across VMs.
  https://pythonspeed.com/articles/consistent-benchmarking-in-ci/
- Representative operation counts (Ahuja & Orlin, INFORMS J. Computing 1996; abstract only).
- trend-prof (Goldsmith, Aiken, Wilkerson, FSE 2007): empirical complexity from block execution
  counts against workload size. Algorithmic profiling (Zaparanuks & Hauswirth, PLDI 2012): cost
  functions, not cost values. https://sape.inf.usi.ch/publications/pldi12 . PerfFuzz (Lemieux
  et al., ISSTA 2018): maximises execution counts per program location.

Performance defects found by reading the code
- Infer cost (Facebook): symbolic complexity per function; `reportdiff` flags a complexity
  increase on a diff. https://fbinfer.com/docs/next/checker-cost
- Jin et al., PLDI 2012: 109 real performance bugs; rules from 25 patches found 332 unknown ones.
  https://pure.psu.edu/en/publications/understanding-and-detecting-real-world-performance-bugs/
- CARAMEL (Nistor et al., ICSE 2015): loops with wasted work, 150 new bugs. CLARITY (PLDI 2015):
  redundant traversals, 92 found, 5% false positives.
  https://pldi15.sigplan.org/details/pldi2015-papers/29/Automated-Detection-of-Performance-Bugs-via-Static-Analysis
- Selakovic & Pradel, ICSE 2016 (JavaScript): 98 issues; most common cause inefficient API use;
  small fixes; recurring patterns found 139 more; only 42.68% of optimisations help consistently
  across engine versions (timing is engine-dependent, code patterns are not).
  https://tubiblio.ulb.tu-darmstadt.de/98168/
- UnityLinter, MSR 2020: static game smells, precision 86–100%, present in 39–97% of 100 projects.
  https://2020.msrconf.org/details/msr-2020-papers/15/Detecting-Video-Game-Specific-Bad-Smells-in-Unity-Projects

Guarantees by construction (games and the web)
- Unreal PSO precaching: every PSO that could be used collected at load and compiled async;
  counters Missed / Too late. https://dev.epicgames.com/documentation/en-us/unreal-engine/pso-precaching-for-unreal-engine
- Unity ShaderVariantCollection warm-up; three.js `compileAsync` ("resolves when the scene can be
  rendered without unnecessary stalling"). https://threejs.org/docs/pages/WebGLRenderer.html
- MDN WebGL best practices (compile at load, static VAOs, texStorage, uploads before drawing).
  https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
- MDN WebXR performance: reuse working objects instead of allocating in the draw loop.
  https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Performance
- V8 fast properties: same properties in the same order share a hidden class; heavy add/delete
  falls to dictionary mode. https://v8.dev/blog/fast-properties
- Static timing analysis (WCET) in avionics and automotive: possible only on restricted,
  analysable code; undecidable in general. https://en.wikipedia.org/wiki/Worst-case_execution_time
- Rice's theorem: non-trivial semantic properties are undecidable; checkers restrict the code to
  checkable forms (as type systems do). https://en.wikipedia.org/wiki/Rice%27s_theorem
- Fitness functions (Ford & Parsons): small, fast, local checks of each architectural
  characteristic. https://nealford.com/downloads/Evolutionary_Architectures_workshop_by_Neal_Ford.pdf

Tools
- dependency-cruiser `to.reachable`. https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md
- Semgrep patterns (`...`, metavariables, `pattern-inside`). https://docs.semgrep.dev/writing-rules/pattern-syntax
- typescript-eslint: typed rules cost as much as type checking; untyped ones are far cheaper.
  https://typescript-eslint.io/troubleshooting/typed-linting/performance
- `tsc -b` incremental. https://www.typescriptlang.org/docs/handbook/project-references.html
- Stryker incremental (mutation testing; tells whether tests catch defects).
  https://stryker-mutator.io/docs/stryker-js/incremental/
- fast-check model-based testing. https://fast-check.dev/docs/advanced/model-based-testing/

## Where the repository stood (read-only survey, 2026-10-13)
- `npm run check` took ~20 min: the 46 specs that took 10 s or more used 3,183 s of 3,382 s.
- Checked: layers, `three` only in render, `Math.random` in world/sim, revision writers, silent
  catch, 800 lines, module state (object literals slip through), knip, cycles.
- Counters: `laneletWork`, `cellWork`, `poleLinesWork`, `kerbWork`, `padsWork`, `tickWork`,
  `signalWork`, `airWork`. The scale test covered lanes only, with a baseline allowing ×12.5.
- Not checked, with examples found: whole-map reads per edit and per frame (about 40 loops;
  `render/renderer.ts:2941` copied every landscaping item each frame after the city hour changed);
  materials made in rebuilds (barriers, signs, road blink, blast, lightning); shader compiles
  during play (`renderer.ts` variant scan every 2 s); per-frame allocation; caches keyed on global
  revisions; `RoadDoc.clone` per edit in 8 places; topology catch-up holding the simulation.

## The barrier
Done (2026-10-13): the gate removed; `npm run check` and the pre-push run lint, types, knip, the
specs that finish in seconds (10 s cap per test, `tests/arch/slowSpecs.spec.ts`), architecture,
counting suites and the build, about a minute; the slow specs listed in `tests/slow.json`.

Done (2026-10-13): the code analyser, `scripts/check-code.mjs` (8 s, in place of `tsc --noEmit`,
whose diagnostics it reports). Sources read for it:
- Clang function effect analysis (`nonblocking`, `nonallocating`): constraints verified
  transitively over calls whose bodies are visible; indirect calls only to annotated targets; an
  unknown body "assumes the worst"; `blocking` as the explicit escape.
  https://clang.llvm.org/docs/FunctionEffectAnalysis.html
- Field-based call graphs for JavaScript (Feldthaus, Schäfer, Sridharan, Dolby, Tip, ICSE 2013):
  fast and accurate in practice; its imprecision comes from merging members of the same name.
  https://2013.icse-conferences.org/content/efficient-construction-approximate-call-graphs-javascript-ide-services.html ;
  replication: https://ir.cwi.nl/pub/23111 ; dynamic property access is the most common cause of
  missed edges (Chakraborty et al., 2022): https://arxiv.org/abs/2205.06780
- TypeScript compiler API (`createProgram`, `getTypeChecker`, `getSymbolAtLocation`; the
  program is the main cost): https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API ;
  `isTypeAssignableTo` is public in 5.9 (`typescript.d.ts`).
How it resolves a call: the checker's symbol, through aliases, to every body it names; a call
through an interface or a base class to every implementation tied to that declaration (object
literals by their contextual type, classes by their heritage); one the checker cannot tie, to the
members of that name on holders whose type is assignable to the receiver's (class hierarchy
analysis, Dean, Grove and Chambers, ECOOP 1995, with structural assignability). A function given
as an argument runs inside the call when our callee calls that parameter, or when a library
declares the parameter a function (`forEach`, `sort`), never for the deferring calls
(`setTimeout`, `addEventListener`, `then`). Measured on the repository: 10,429 functions, 4,576
reached per frame, 5,298 from the frame; 192 findings in the baseline. Its own test:
`tests/arch/checkCode.spec.ts`. First defect fixed from the list: `renderer.ts` `draw` copied every
landscaping item on every frame of a city hour with nothing growing (`growPlants`).

Limits: precision in `renderer.ts` `draw` and `main.ts` needs them split (F4): the guards inside
them are lines, not functions, so what they guard counts as per frame. Not yet: caches keyed on a
global revision.

Next, in order:
2. A work counter on every derived product without one (network, elevation, walkways,
   sidewalks, conflicts, lots, road surfaces, furniture, signs, buildings); the scale test: the
   same edit costs the same on a small and a large map, ratio at most 1.05, for every counter.
3. The slow specs rewritten to run in seconds, keeping what each guarantees.
4. Mutation testing (incremental) now and then, to measure whether the tests catch defects.

Limits: GPU time, driver behaviour and how things look are not provable from the code. Counters
cover the causes of slowness (objects drawn, triangles, bytes uploaded, programs); the short
visual check covers the look.

## The gate, the check by change and the rules of the tests (2026-10-13)
Taken from the building editor next door (`C:/Codex-Shared/builder`: `scripts/check.mjs`, `gate.mjs`,
`lock.mjs`, `test/unit/arch.test.ts`), where they hold, and adapted here. Sources read:
- Claude Code hooks: `PostToolUse` runs after a tool; a `Stop` hook that exits 2 keeps Claude
  working with stderr as the reason; `stop_hook_active` is true while Claude continues because of a
  stop hook ("check this value ... to avoid blocking on a condition that will never resolve"); after
  eight continuations in a row the turn ends anyway; exec form (`command` + `args`) for paths with
  `${CLAUDE_PROJECT_DIR}`; default timeout 600 s. https://code.claude.com/docs/en/hooks
- ESLint cache: valid from the file and the configuration; it does not track dependencies between
  files, so it is wrong only for rules that read other files or the types (none here);
  `--cache-strategy content` for checkouts that touch mtimes.
  https://eslint.org/docs/latest/use/command-line-interface#caching
- Vitest: `--changed` / `related` follow static imports only, not dynamic ones (the architecture
  specs read files and import nothing), so every spec runs; profiling the workers with `execArgv`.
  https://vitest.dev/guide/cli ; https://vitest.dev/guide/profiling-test-performance
- git `pre-push` gets the pushed refs on stdin. `git read-tree` into a temporary `GIT_INDEX_FILE`
  and `git checkout-index --prefix` write a commit's files elsewhere without touching the index or
  the folder. https://git-scm.com/docs/githooks ; https://git-scm.com/docs/git-checkout-index
- Software Engineering at Google, ch. 11 (above): speed and determinism first; a test that needs a
  machine's files or an environment variable, or that reads the wall clock, is neither.

What was measured before (2026-10-13): the check 89 s (lint 12.3, code 11.8, knip 2.2, specs 50.1
with 41 s of imports, scale 7.2, build 5.5); 45 slow specs, 45 min, run by nobody; three benchmarks
(`tests/bench`, only with `BENCH=1`, one pointing at a script gone); two tests that ran only with a
cache of the MakeHuman sources (absent here); eight specs asserting milliseconds of wall time; two
waiting on a real timer. A profile of one slow spec (`queuedSwing`, seed 2: 300 s simulated, 18,000
ticks, 15.6 s) found no single hot spot: the time is the simulation itself (walking 18 %, vehicle
integration 18 %, lane changes 15 %, obstacles 14 %), 0.87 ms a tick. The slow specs are slow because
they simulate minutes of a town, not because of a fault; they are rewritten as small scenarios.

## The slow specs rewritten (2026-10-13)
44 of the 45 specs of `tests/slow.json` now run in the check, each test within 10 s: smaller worlds
(the small generated city, a 12-block grid for the scale count, demand 1 where it is enough), shorter
runs with a count proving the situation guarded did happen (vehicles queued, people met at
crossings, a lane used, the events of a closed town at their measured times: a car parks at 53 s,
leaves at 83 s, a person comes out of a gate at 105 s), one test per scenario, seed or fixture instead
of one test over all of them, and a check counted then asserted once instead of an `expect` per
vertex or per pair (an `expect` costs 5 µs, a comparison 0.004 µs). Measurement harnesses that only
printed counts were deleted (`lorryDocks` "counts the docks", twice). Left: `lorryDocks`, 13 s of the
simulation planning every yard's docks in the background, and a lorry that never docks with 6 or 12
works in the block (src/sim, reported).

Found while profiling, in the game's code (reported to the conversation working there):
- `hybridAStar.run` and Reeds-Shepp inside `step` take half of a small closed town's tick time.
- `rebuildTopology` measures every identical junction of a grid again (`conflictPoints.ts`
  `pairTable` 45 %, `turnPaths.ts` `sweep` 30 %): 1.1 s for 36 junctions, 8.2 s for 256.

The specs a change reaches (`vitest related`, the import graph of Vite) cut the check: a change in
`src/render/water.ts` runs 30 spec files in 11 s; one in `src/sim/pipeline.ts` 65 files in about 70 s;
every spec (`check:all`, the pre-push) about 110 s on four cores.
