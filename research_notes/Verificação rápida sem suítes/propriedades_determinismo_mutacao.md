# Fast high-yield testing for simulation-heavy software, and measuring what suites miss (as of Oct 2026)

Context: the TypeScript city-builder (roadcraft-4.0) uses `vitest ^4.1.11` and `typescript ^5.9.3` (from the local package.json). Neither fast-check nor Stryker is installed yet.

## (a) Property-based testing and fuzzing that run in seconds

### Takeaway
fast-check (4.10.2, Sep 2026) is the standard TS property-based testing library. It has hard wall-clock budgets (`interruptAfterTimeLimit`), automatic shrinking, and model-based testing (`fc.commands` + `fc.modelRun`) with replayable seeds. That makes it a good fit for multi-second checks of simulation invariants. Jazzer.js (4.0.0) is coverage-guided fuzzing, built around Jest. It is a worse fit for a Vitest project.

### Cited Findings
- Current npm versions (checked with `npm view` on 2026-10-21): `fast-check` 4.10.2 (modified 2026-09-19); `@fast-check/vitest` 0.5.0 with peer `vitest: ^4.1.0 || ^5.0.0`; `@jazzer.js/core` 4.0.0 (2026-04-15); `vitest` latest is 5.0.5, so Vitest 4 is now the previous major. — [npm registry: fast-check](https://www.npmjs.com/package/fast-check) (the page itself returned 403 to the fetch; versions come from the npm CLI)
- Time budgets:
  - `interruptAfterTimeLimit` (since 1.19.0) caps the runner's total time for a property, sync or async. An interruption is not a failure unless no run succeeded, or unless `markInterruptAsFailure: true` is set.
  - Combining it with `numRuns: Number.POSITIVE_INFINITY` gives "run for N ms" fuzzing.
  - `skipAllAfterTimeLimit` (since 1.15.0) skips the remaining runs instead. It is slower to stop than `interruptAfterTimeLimit`.
  - `timeout` limits each async predicate run, and a run that exceeds it counts as a failure that is then shrunk. — [fast-check timeouts docs](https://fast-check.dev/docs/configuration/timeouts/)
- Global config: `fc.configureGlobal({ numRuns: 10 })` in a Vitest `setupFiles` file. Calling it fully resets prior globals, so spread `fc.readConfigureGlobal()` to keep them. — [fast-check global settings](https://fast-check.dev/docs/configuration/global-settings/)
- Model-based testing:
  - Commands implement `check(model)`, `run(model, real)` and `toString()`.
  - Scenarios come from `fc.commands([...arbitraries], { size: '+1' })` and run with `fc.modelRun(setup, cmds)`. Async systems use `asyncModelRun`, and `scheduledModelRun` finds race conditions.
  - Unlike `array(oneof(...))`, `fc.commands` shrinks failing scenarios efficiently.
  - Replay: on failure the log prints `seed`, `path` and `replayPath`. Passing `{ seed, path, endOnFailure: true }` replays the minimal counterexample directly. — [fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/)
- Real bugs found by fast-check:
  - Jest: `toStrictEqual` did not tell `0` from `5e-324`, and `toEqual` was asymmetric for Sets.
  - js-yaml: negative binary ints were dumped as `0b-1010`.
  - query-string: a round-trip failure with nulls.
  - left-pad: Unicode characters outside the BMP.
  - javascript-stringify: `-0` became `"0"`.
  - node-jsonwebtoken: TypeError on keys such as `valueOf`.
  - trekhleb/javascript-algorithms: counting sort returned `[null]` for `sort([-1])`. — [fast-check track record](https://fast-check.dev/docs/introduction/track-record/)
- Jazzer.js:
  - It is a coverage-guided, in-process Node.js fuzzer distributed through npm. — [SD Times](https://sdtimes.com/software-development/code-intelligence-introduces-integration-of-jazzer-js-into-jest)
  - Its test-framework integration is Jest-specific: `it.fuzz` with `@jazzer.js/jest-runner`, a "fuzzing" mode and a "regression" mode that replays the corpus. — [Code Intelligence blog](https://code-intelligence.com/blog/fuzzing-javascript-jazzer.js); [third-party write-up](https://javascript.plainenglish.io/crash-your-code-with-jazzer-js-6605fad9fa39)
  - OSS-Fuzz has a JS/TS integration guide with example repos. — [OSS-Fuzz JS guide](https://google.github.io/oss-fuzz//getting-started/new-project-guide/javascript-lang/)

### Inferences
- For the game, use fast-check with explicit budgets in Vitest: `fc.assert(prop, { numRuns: Infinity, interruptAfterTimeLimit: 2000 })` per property, or `test.prop` from `@fast-check/vitest` 0.5.0, which supports Vitest 4.1+.
- Good invariant targets:
  - The road graph stays connected after random add/remove sequences.
  - Pathfinding cost is never below the straight-line or heuristic lower bound.
  - No vehicle sits on a deleted edge.
  - Lot and zone counts are conserved.
  - Serialize then deserialize gives the identity, which matches the save-format bug class that fast-check repeatedly finds.
- Model-based testing fits editor operations: a sequence of build/delete/undo commands run against a simple reference model of the road graph.
- Jazzer.js adds little over fast-check here, because it targets Jest and byte-buffer parsers. It would only pay off for binary save or tile parsers.

### Gaps
- I could not fetch the fast-check README for the default `numRuns`. It is widely known to be 100, but I did not confirm that in this session.
- I found no current official doc on Jazzer.js support for Vitest, and none appeared in search.

## (b) Deterministic simulation testing and golden-state tests for game simulations

### Takeaway
DST means controlling every source of nondeterminism (clock, RNG, scheduling, I/O) so that a seed fully reproduces a run, then exploring many seeds while checking invariants. Games have long done this by hashing or CRC'ing world state every tick and comparing replays (Factorio). For a single-process TS sim, that reduces to: a seeded RNG, a fixed timestep, a per-tick state hash, and golden hashes for N seeds × M ticks. This runs in seconds.

### Cited Findings
- Antithesis's definition:
  - DST places the software in a simulated, deterministic environment and controls "clocks, thread interleaving, and system-provided sources of randomness".
  - Many seeds explore different behaviors, and any run is perfectly reproducible and can be rolled back.
  - It is usually paired with property-based testing, fuzzing and fault injection.
  - There are two approaches: pluggable nondeterminism, as in FoundationDB, or a deterministic hypervisor, as in Antithesis.
  - Stated limitations: setup cost, mocked external dependencies, and state-space size. — [Antithesis DST primer](https://antithesis.com/docs/resources/deterministic_simulation_testing/)
- TigerBeetle VOPR:
  - Simulates a whole cluster of real TigerBeetle code with network, storage and process faults.
  - Runs at 1000x speed, 24/7 on 1024 cores. — [TigerBeetle safety docs](https://docs.tigerbeetle.com/concepts/safety/)
- FoundationDB:
  - Simulates an entire cluster in a single thread, using shims and a simulated network run loop, with Flow (a C++ extension). — [CACM 2023 FoundationDB article](https://cacmb4.acm.org/magazines/2023/6/273229-foundationdb-a-distributed-key-value-store)
  - The team reportedly spent about 18 months building the simulator before touching a real disk.
  - The figure of roughly a trillion CPU-hours of simulation is self-reported and repeated in secondary sources. — [WarpStream DST blog](https://www.warpstream.com/blog/deterministic-simulation-testing-for-our-entire-saas); [FoundationDB DST slides](https://www.slideshare.net/slideshow/deterministic-simulation-testing/39333008)
- Factorio (lockstep game):
  - A special mode computed a CRC of the whole map every tick and saved a readable save per tick. Replays re-check the CRC, and the saves from the first diverging tick are diffed. — [Factorio FFF #47](https://factorio.com/blog/post/fff-47)
  - During MP testing a cheaper, incomplete but very fast check ran every tick. — [Factorio FFF #55](https://factorio.com/blog/post/fff-55)
  - `/heavy-mode` narrows a desync to the update phase where it starts. — [Factorio forum](https://forums.factorio.com/viewtopic.php?p=686390)
  - Even a read-only script access once changed the CRC, a real determinism bug. — [Factorio forum 1.1.52](https://forums.factorio.com/101294)

### Inferences
- Recipe for the city builder, about 1–5 seconds in Vitest:
  1. Inject a single seeded PRNG and a fixed-dt clock into the sim. Ban `Math.random`/`performance.now` in sim code, for example with a lint rule.
  2. Write `hashState(world)` over canonical sorted state: vehicles, lots, road graph, population. FNV or xxhash over a Float64/Int32 view is enough.
  3. Golden test: for seeds {1..K} run T ticks headless and compare `[tick, hash]` checkpoints with a committed JSON. On mismatch, binary-search the first diverging tick and dump both states, as Factorio does.
  4. Determinism self-check: run the same seed twice in one process, and in a worker vs the main thread. The hashes must match. This catches iteration-order, Map/Set ordering, float-accumulation and worker-race bugs.
  5. Combine with fast-check: the seed is the arbitrary, invariants are checked every tick, and shrinking reduces the tick count or command list.
- Golden snapshots of generated cities: store compact digests (counts, hash, a few summary stats) rather than large `toMatchSnapshot` blobs. Large snapshots get blindly re-accepted.
- What DST and goldens catch: nondeterminism, regressions in emergent behavior, and order dependence.
- What they miss:
  - Whether the new output is correct. A golden only says "changed", so any intended change requires a deliberate re-bless.
  - Rendering and GPU problems.
  - Performance.

### Gaps
- I found no published DST case study for a city-builder or traffic simulation in TS or JS. The game evidence is Factorio's lockstep CRC practice only.
- I have no current primary description of how Factorio's checks work today, only the 2014–2015 posts and forum threads.

## (c) Mutation testing and measuring test-suite effectiveness

### Takeaway
Coverage is a weak proxy for fault detection once suite size is controlled for (Inozemtseva & Holmes). Mutation testing measures fault detection directly. StrykerJS 10.0.0 (Aug 2026) supports Vitest ≥2 with per-test coverage and an incremental mode, so mutating only changed files keeps runs short. Google's practice is diff-based, filtered mutants surfaced at code review.

### Cited Findings
- Versions: `@stryker-mutator/core` 10.0.0 and `@stryker-mutator/vitest-runner` 10.0.0 (2026-08-14), with peer `vitest: >=2.0.0`. — [npm registry](https://www.npmjs.com/package/@stryker-mutator/vitest-runner) (checked with `npm view`)
- Vitest runner setup and behavior:
  - Install with `npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner` and set `"testRunner": "vitest"`.
  - The `vitest.configFile` and `vitest.dir` options are available, and `related: true` (the default) runs only tests related to the mutated files.
  - Coverage analysis is always `perTest`. Stryker forces `threads`, bail and no watch.
  - Browser Mode is not supported.
  - In-source tests need `// Stryker disable all`. — [StrykerJS Vitest runner docs](https://stryker-mutator.io/docs/stryker-js/vitest-runner/)
- Incremental mode:
  - Run `npx stryker run --incremental`. State is stored in `reports/stryker-incremental.json`.
  - Killed mutants are reused if the killing test is unchanged. Surviving mutants are reused if no new or changed test covers them.
  - Vitest gets full test-change detection.
  - Changes to dependencies, environment or snapshots are not detected. Use `--force` with `--mutate src/x.ts:5-7` to target lines.
  - Example from the docs: 3,731 of 3,965 results reused, so only 234 mutants ran. — [StrykerJS incremental docs](https://stryker-mutator.io/docs/stryker-js/incremental/)
- Google, "Practical Mutation Testing at Scale" (Petrović, Ivanković, Fraser, Just; IEEE TSE 2021):
  - Mutation testing is applied incrementally to changed code during code review.
  - Mutants likely to be irrelevant are filtered out (arid nodes), mutants are limited per line and per review, and operators are chosen by historical performance.
  - The approach produces "orders of magnitude fewer mutants" and was evaluated with more than 24,000 developers on more than 1,000 projects.
  - The codebase is 2B LOC, with more than 500M tests a day in v1 of the preprint and 150M in a later listing; the versions differ. — [arXiv 2102.11378](https://arxiv.org/abs/2102.11378v2); [Google Research](https://research.google/pubs/practical-mutation-testing-at-scale-a-view-from-google/)
- Inozemtseva & Holmes, ICSE 2014:
  - 31,000 test suites over 5 systems of up to 724K LOC.
  - Once suite size is controlled for, coverage has a low-to-moderate correlation with effectiveness, measured by mutant detection.
  - Stronger coverage types (decision, MC/DC) add no insight.
  - Conclusion: coverage is useful for finding untested code but is not a quality target.
  - The paper won the SIGSOFT Distinguished Paper award and later ICSE's Most Influential Paper award. — [paper PDF](https://cs.ubc.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf); [UBC award page](https://www.cs.ubc.ca/award/2024/04/icse-most-influential-paper-award); [The Morning Paper summary](https://blog.acolyer.org/2014/10/21/coverage-is-not-strongly-correlated-with-test-suite-effectiveness/)
- SWE at Google:
  - Coverage measures execution, not whether results were checked.
  - A fixed 80% bar becomes a ceiling.
  - Measure coverage from small tests only. — [Software Engineering at Google ch. 11](https://abseil.io/resources/swe-book/html/ch11.html)

### Inferences
- For the game, run Stryker on the pure sim modules only (traffic, pathfinding, growth, geometry), with `--incremental` and `--mutate` scoped to changed files. Don't run it on render or WebGPU code, where tests can't observe the output.
- Surviving mutants show exactly which assertions are missing. Surviving mutants in a module with high coverage reveal tests that only execute code without checking results.
- Run cost scales roughly with mutants × the tests related to each mutant. Full runs on a large TS codebase can take hours, while incremental and scoped runs take minutes.
- Use mutation score as a diagnostic, not as a gate.

### Gaps
- I found no published timing benchmark of StrykerJS 10 on a large codebase.
- I did not confirm StrykerJS 10 release notes or any Vitest 5-specific caveats. The peer range `>=2.0.0` suggests Vitest 4 works.
- I did not extract the full numbers from Google's paper, such as the percentage of mutants rated useful.

## (d) Why large suites are slow or flaky, and how teams prune them

### Takeaway
Flakiness is endemic at scale: about 1.5% of Google test runs, and about 16% of Google tests flaky to some degree. Tests lose value as flakiness nears 1%. The main fixes are hermetic small tests (single process, no sleep or I/O), deterministic design, and selecting or deleting tests by value. Meta runs about a third of the dependent tests and still catches more than 99.9% of faulty changes.

### Cited Findings
- Google flakiness (Micco, 2016): about 1.5% of all test runs report a flaky result, and almost 16% of tests have some flakiness. — [Google Testing Blog, John Micco](https://testing.googleblog.com/2016/05/)
- When a test transitions from passing to failing in Google's post-submit CI, 84% of the time it is flaky rather than a real regression. — [Lam et al. 2020 citing Google](https://cs.gmu.edu/~winglam/publications/2020/LamETAL20FaTB.pdf); originally Google Testing Blog (secondary)
- SWE at Google ch. 11:
  - Google's flaky rate is about 0.15%, which still means thousands of flakes a day. At a 0.1% rate on 10K tests a day, about 10 flakes need investigating daily.
  - Tests start losing value as flakiness approaches 1%.
  - Auto-rerun only defers the root cause.
  - Test sizes: **small** = one process, often one thread, no sleep, I/O or blocking calls, and no network or disk except a hermetic in-memory filesystem. **Medium** = multiple processes and threads, localhost network only. **Large** = multiple machines and remote network.
  - Rough mix: 80% unit, 15% integration, 5% end-to-end.
  - "Beyoncé Rule": test everything you don't want to break, including performance and failure handling. — [SWE at Google ch. 11](https://abseil.io/resources/swe-book/html/ch11.html)
- Microsoft (Lam et al., ISSTA 2019, "Root Causing Flaky Tests in a Large-Scale Industrial Setting"): across six large Microsoft projects, async calls are the leading cause of flakiness. Some developer "fixes" did not reduce failure frequency. — [Microsoft Research](https://www.microsoft.com/en-us/research/publication/root-causing-flaky-tests-in-a-large-scale-industrial-setting/); [Lam et al. 2020](https://cs.gmu.edu/~winglam/publications/2020/LamETAL20FaTB.pdf)
- Open-source Java (Luo et al., FSE 2014, via secondary source): about 45% async wait, 20% concurrency and 12% test-order dependency. — [flaky test statistics blog (secondary)](https://www.getpanto.ai/blog/flaky-test-statistics)
- Meta predictive test selection (ICSE-SEIP 2019): an ML model runs about one third of the tests that transitively depend on a change. It catches more than 99.9% of faulty changes and more than 95% of individual test failures, roughly halving infrastructure cost. — [Meta engineering blog](https://engineering.fb.com/2018/11/21/developer-tools/predictive-test-selection/); [arXiv 1810.05286](https://export.arxiv.org/abs/1810.05286)
- Kent Beck's Test Desiderata, 12 properties: Isolated, Composable, Deterministic, Fast, Writable, Readable, Behavioral, Structure-insensitive, Automated, Specific, Predictive, Inspiring. Some properties trade off, such as predictive vs fast, but composability can improve both. — [testdesiderata.com](https://testdesiderata.com/)
- Testing Trophy (Kent C. Dodds, 2018): Static > Unit < Integration (largest) > E2E, after Guillermo Rauch's advice "write tests, not too many, mostly integration". Section size reflects how much focus each kind deserves. Static is included because JS lacks built-in type checking. — [Kent C. Dodds: Testing Trophy and classifications](https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications); [unit vs integration vs e2e](https://kentcdodds.com/blog/unit-vs-integration-vs-e2e-tests)

### Inferences
- What each technique catches and misses, typical run time, and adoption cost:

| Technique | Catches | Misses | Typical run | Adoption cost |
|---|---|---|---|---|
| fast-check properties | Edge-case inputs, round-trip/serialization bugs, invariant breaks | Bugs with no stated invariant; visual/perf | 0.1–3 s per property with a budget | Low: write invariants |
| Model-based (`fc.commands`) | Sequence/state bugs in editors and graphs, undo bugs | Bugs the model shares | Seconds | Medium: write a model |
| DST + per-tick hash goldens | Nondeterminism, emergent-behavior regressions, worker races | Whether a new result is *right*; rendering | 1–5 s for K seeds × T ticks | Medium: refactor RNG/clock injection |
| Mutation testing (Stryker incremental) | Weak or absent assertions; measures the suite itself | Missing *requirements* (equivalent mutants are noise) | Minutes when scoped; hours for a full run | Low install, high CPU |
| Coverage | Code that is never executed | Unchecked results (weak correlation) | Free with Vitest | Trivial |
| Jazzer.js fuzzing | Crashes in byte parsers | Logic without a crash oracle | Open-ended | Medium; Jest-oriented |

- Pruning heuristics for the game's suite:
  - Delete or merge tests whose mutants are all killed by other tests too.
  - Delete tests that never failed and duplicate a property or golden.
  - Quarantine any test with sleeps, real timers or GPU/browser dependence out of the fast lane.
  - Keep the fast lane all "small" (single process, no I/O) and under seconds in total.

### Gaps
- I could not fetch the Microsoft ISSTA 2019 paper for exact percentages.
- The Luo et al. 45/20/12 breakdown comes from a secondary blog.
- The original 2010 Google "Test Sizes" blog post body did not load. The commonly quoted time limits (small about 1 min, medium about 5 min, large about 15 min) could not be verified from a primary source in this session, so treat them as unverified.
- I did not research academic test-suite minimization tools (for example, the ones in the Yoo & Harman survey) because of tool-call limits.
