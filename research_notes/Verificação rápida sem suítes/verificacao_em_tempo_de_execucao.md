# Runtime verification (assertions, invariants, contracts, runtime validation) for a TypeScript/three.js WebGL2 game

Scope: a Vite dev build and an Electron production build. These notes cover catching bugs while the game runs, as a complement to slow test suites. Research date: 2026-10-21.

## 1. Assertions and invariants in development builds: evidence, practice, and stripping

### Takeaway
There is empirical evidence that assertions help. Microsoft Research found that fault density fell significantly as assertion density rose, though only in two components. Mature projects agree on a density target of about 2 or more assertions per function (NASA/JPL, TigerBeetle) and on running the expensive checks only in debug builds (SQLite, Unreal, Unity). In Vite, `import.meta.env.DEV` and `define` are replaced statically at build time, so guarded code can be removed from the production bundle.

### Cited Findings
**Effectiveness evidence**
- Kudrjavets, Nagappan and Ball, MSR-TR-2006-54 (May 2006), studied two commercial Microsoft components whose developers used assertions systematically. Fault density fell by a statistically significant amount as assertion density in a file rose. Assertions also caught a large share of the faults in the bug database, and the paper compares them with static-analysis tools. The public abstract gives no coefficients or effect sizes. — [Microsoft Research](https://www.microsoft.com/en-us/research/publication/assessing-the-relationship-between-software-assertions-and-code-qualityan-empirical-investigation/); [MSR API record](https://www.microsoft.com/en-us/research/wp-json/wp/v2/msr-research-item/152953)
- NASA/JPL "Power of 10" (Holzmann, 2006), Rule 5: "The code's assertions density should average to minimally two assertions per function." Assertions must be side-effect free and Boolean. A failed assertion needs an explicit recovery action. An assertion that a static checker can prove always holds or never holds violates the rule, so `assert(true)` padding does not count. — [Wikipedia: The Power of 10](https://en.wikipedia.org/wiki/The_Power_of_10:_Rules_for_Developing_Safety-Critical_Code); [Perforce/Klocwork datasheet](https://www.perforce.com/nasa-power-10-klocwork-datasheet)
- TigerBeetle TIGER_STYLE:
  - Assertion density "must average a minimum of two assertions per function", covering arguments, return values, pre- and postconditions, and invariants.
  - "Pair" assertions: check the same property on two code paths, for example just before writing to disk and again just after reading it back.
  - Assert both the "positive space" (what you expect) and the "negative space" (what you do not).
  - Use compile-time assertions on relationships between constants.
  - Split compound assertions (`assert(a); assert(b);`) and write implications as `if (a) assert(b)`.
  - "The only correct way to handle corrupt code is to crash." Assertions "downgrade catastrophic correctness bugs into liveness bugs" and make fuzzing more effective.
  — [TIGER_STYLE.md](https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/docs/TIGER_STYLE.md)
- SQLite:
  - The core has 6,754 `assert()` statements for preconditions, postconditions and loop invariants, plus 1,184 `testcase()` macros.
  - Asserts are enabled only with `SQLITE_DEBUG` and are off by default, because "the database engine runs about three times slower when asserts are enabled."
  - The `ALWAYS(X)`/`NEVER(X)` macros mark defensive conditions. They pass through in release, `assert` in tests, and become constants for coverage builds. The test suite runs once per variant and all runs must give identical results.
  — [sqlite.org/testing.html](https://www.sqlite.org/testing.html)

**Engine precedents for tiered checks**
- Unreal Engine:
  - `check`/`checkf` halt execution. They are active in Debug and Development, and in Test/Shipping only with `USE_CHECKS_IN_SHIPPING`. The expression is not evaluated when disabled.
  - `checkSlow` runs only in Debug.
  - `verify` always evaluates its expression and halts only where checks are active.
  - `ensure` is non-fatal: execution continues and the crash reporter is notified "only once per Engine or Editor session". `ensureAlways` reports every time.
  — [Epic: Asserts in Unreal Engine](https://dev.epicgames.com/documentation/en-us/unreal-engine/asserts-in-unreal-engine)
- Unity `Assertions.Assert` calls are "only conditionally included in a Development Build", controlled by the `UNITY_ASSERTIONS` define. They throw `AssertionException`, which pauses an attached debugger. — [Unity ScriptReference: Assert](https://docs.unity3d.com/ScriptReference/Assertions.Assert.html)

**Stripping in Vite/esbuild/Oxc (2026)**
- Vite statically replaces `import.meta.env.*` at build time "to make tree-shaking effective". Code guarded by `import.meta.env.DEV` is "tree-shaken in production builds". `DEV`/`PROD` follow `NODE_ENV`, not `--mode`, so `vite build --mode development` still has `NODE_ENV=production`. — [Vite: Env and Mode](https://vite.dev/guide/env-and-mode)
- Vite `define` entries "will be defined as globals during dev and statically replaced during build". Values must be JSON-serializable strings or a single identifier, and the docs recommend declaring them in `vite-env.d.ts`. The current Vite docs name Oxc as the replacement engine, and the old `esbuild` option is deprecated and converted to `oxc`. — [Vite: Shared Options](https://vite.dev/config/shared-options)
- esbuild has the same primitives:
  - `define` with `DEBUG=false` turns `DEBUG && require("hooks")` into `false`.
  - `drop: ['console','debugger']` removes the whole call, including side-effecting arguments.
  - `dropLabels: ['DEV']` removes labelled statements such as `DEV: doAnExpensiveCheck()`, but not code inside nested expressions.
  - `/* @__PURE__ */` lets an unused call result be dropped.
  - Its docs list "dead-code elimination within function bodies" among the optimizations esbuild does not perform, so check the output.
  — [esbuild API](https://esbuild.github.io/api/)
- tiny-invariant keeps the check in production and replaces the message with "Invariant failed". To strip the message text you need a build step (`babel-plugin-dev-expression`, or replacing `NODE_ENV`). It narrows TypeScript types, for example `Person | null` to `Person`. — [tiny-invariant README](https://github.com/alexreardon/tiny-invariant)

### Inferences
- Recommended pattern for this project:

  ```ts
  // assert.ts
  export function assert(cond: unknown, msg?: string | (() => string)): asserts cond {
    if (import.meta.env.DEV && !cond) {
      const m = typeof msg === 'function' ? msg() : msg;
      debugger;
      throw new Error('Assertion failed: ' + (m ?? ''));
    }
  }
  // call site for expensive checks: guard explicitly so the argument computation is removed too
  if (import.meta.env.DEV) assert(spatialIndexMatches(world), 'index drift');
  ```

  - A plain `assert(expensive())` still evaluates `expensive()` in production unless it is inside `if (import.meta.env.DEV)` or marked pure.
  - This mirrors the difference between Unreal's `check` (not evaluated) and `verify` (evaluated).
- Use a tiered scheme modelled on Unreal and SQLite:
  - `assert`: cheap, DEV only.
  - `assertSlow`: O(n) structure walks, behind a separate `define` flag such as `__SLOW_CHECKS__` and off by default even in dev.
  - `ensure`: logs once, never throws, may stay in production Electron builds to report to a log file.
- SQLite's ~3x slowdown with all asserts on is a realistic upper bound for an assert-heavy hot loop, which is why the slow tier is needed for a 60 fps game.

### Gaps
- No public numeric effect size from the MSR 2006 paper (the abstract only). The Holzmann PDF could not be text-extracted, so his rationale statistic is not cited here.
- No published measurements of JS assertion overhead in game loops. The ~3x figure is SQLite/C.

## 2. Design by contract and runtime type validation in TypeScript

### Takeaway
Use schema validators (zod/valibot/typia) at trust boundaries, such as save files, worker messages, and cooked asset JSON, not in per-frame hot paths. Their throughput differs by more than 10x: typia's AOT-generated validators are much faster than zod v4, and zod v4 is much faster than zod v3.

### Cited Findings
- Throughput benchmarks:
  - LogRocket, citing the TypeScript runtime-type-benchmarks site: typia ~76M ops/s in "safe parsing", Zod v4 ~6.7M ops/s, Zod v3 <1M ops/s.
  - The same article says the gap matters less where I/O dominates.
  — [LogRocket: why Zod is slow](https://blog.logrocket.com/why-zod-slow); [moltar typescript-runtime-type-benchmarks](https://github.com/moltar/typescript-runtime-type-benchmarks)
- Valibot is positioned for bundle size; one 2026 guide says Zod v4 "closed much of the performance gap". No like-for-like Valibot ops/s figure was found. — [PkgPulse 2026 comparison](https://www.pkgpulse.com/guides/zod-v4-vs-arktype-vs-typebox-vs-valibot-2026)
- Some benchmarks compare TypeScript type-check (compile) time rather than runtime speed, and should not be read as runtime ops/s. — [astahmer typescript-runtime-typechecking-benchmarks](https://github.com/astahmer/typescript-runtime-typechecking-benchmarks)
- tiny-invariant gives an `asserts`-style type narrowing invariant with no dependencies, suitable for contracts (pre- and postconditions) in code. — [tiny-invariant](https://github.com/alexreardon/tiny-invariant)

### Inferences
- Validate on load/save and on postMessage boundaries with a schema (typia if a compile step is acceptable, otherwise zod v4 or valibot). At ~6.7M ops/s, validating a few thousand records on load costs on the order of milliseconds. That is fine on load and wrong per frame.
- Contracts in hot code should be plain `assert` calls guarded by `import.meta.env.DEV`, not schema parses.

### Gaps
- No authoritative Valibot runtime numbers. Benchmark numbers vary by schema shape and machine.

## 3. WebGL runtime debugging

### Takeaway
`gl.getError`, `getParameter`, `checkFramebufferStatus` and `getShader/ProgramParameter` are synchronous GPU-process round trips (up to ~1 ms each), so they belong in dev or capture modes only. three.js offers `renderer.debug.checkShaderErrors` and `onShaderError`, `renderer.info`, and `forceContextLoss()`/`forceContextRestore()` for testing context loss. Spector.js gives frame captures that can be embedded in the page.

### Cited Findings
- MDN WebGL best practices:
  - getError/getParameter "cause synchronous stalls"; even basic requests "can take as long as 1ms".
  - `getError()` "causes a flush + round-trip"; shader/program gets mean "flush + shader compile + round-trip".
  - Avoid these calls "especially on the browser main thread".
  - Prefer `KHR_parallel_shader_compile` and poll `COMPLETION_STATUS_KHR`.
  - Check compile status only when linking fails.
  - "The only errors a well-formed page generates are OUT_OF_MEMORY and CONTEXT_LOST", and after too many errors WebGL "stops generating descriptive messages".
  — [MDN WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- three.js `renderer.debug.checkShaderErrors`: "It may be useful to disable this check in production for performance gain. It is strongly recommended to keep these checks enabled during development." `onShaderError(gl, program, glVertexShader, glFragmentShader)` replaces the default reporting. — [three.js WebGLRenderer docs](https://threejs.org/docs/pages/WebGLRenderer.html)
- three.js `renderer.info`:
  - `memory.geometries`, `memory.textures`, `render.calls`, `render.triangles`, `render.frame`, `programs`.
  - `autoReset` defaults to true. For multi-pass frames, set it to false and call `info.reset()` once per frame.
  - `forceContextLoss()`/`forceContextRestore()` simulate loss through `WEBGL_lose_context`.
  — [three.js WebGLRenderer docs](https://threejs.org/docs/pages/WebGLRenderer.html)
- MDN recommends losing contexts eagerly through `WEBGL_lose_context` when they are no longer needed. — [MDN WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- Spector.js:
  - Captures a frame's full command list with the state at each command, plus shaders and textures.
  - Can be embedded with `new SPECTOR.Spector()`, `displayUI()`, `captureCanvas(canvas)`, `onCapture.add(...)` and `spyCanvases()`.
  - Supports WebGL2, and Workers/OffscreenCanvas with `spyWorker` and `captureWorker`.
  - No overhead numbers are published. `spyCanvases()` instruments calls continuously.
  — [Spector.js GitHub](https://github.com/BabylonJS/Spector.js)
- KhronosGroup/WebGLDeveloperTools ships the debug helpers (`webgl-debug.js`) as an ES6 module under `src/debug`. — [WebGLDeveloperTools](https://github.com/KhronosGroup/WebGLDeveloperTools)

### Inferences
- In dev, wrap the context with a debug context only when a `?gldebug` flag is set. Calling getError after every call multiplies the stalls MDN describes.
- Keep `checkShaderErrors = import.meta.env.DEV` and route `onShaderError` to an on-screen overlay.
- Add a dev hotkey that calls `renderer.forceContextLoss()` then `forceContextRestore()`. This exercises the restore path, which tests rarely cover.

### Gaps
- The Khronos wiki pages (HandlingContextLost, Debugging) refused connections during research, so makeDebugContext and makeLostContextSimulatingCanvas details and costs are not cited.
- KHR_debug is not exposed to WebGL. I found no source confirming any 2026 change to that, so treat it as unverified.
- The default value of `checkShaderErrors` is not stated on the docs page. It is believed to be true in the source; not verified here.

## 4. State validation in simulations: checksums, consistency checks, self-checking modes

### Takeaway
The strongest precedent is Factorio's "heavy mode". It saves and loads every tick and diffs the result, and computes a whole-map CRC every tick. This catches state that is not persisted and nondeterminism at the exact tick where it starts, at the cost of running at a few FPS. That shows why such checks must be opt-in modes rather than always on.

### Cited Findings
- Factorio FFF #47: a special mode computes a CRC of the whole map every tick and writes a readable save each tick. It slows the game to a few FPS, but it pinpoints the first desync tick, and the two saves are then diffed. — [Factorio Friday Facts #47](https://cf-www.factorio.com/blog/post/fff-47)
- Factorio FFF #55: multiplayer compares lightweight CRCs across players every tick. A full-state CRC every tick is described as slow but accurate. — [Factorio Friday Facts #55](https://factorio.com/blog/post/fff-55)
- Factorio wiki: "heavy mode" saves and loads every tick and dumps both states when they differ. Typical causes are bad `on_load` logic and variables that are not persisted. — [Factorio wiki: Desynchronization](https://wiki.factorio.com/Desynchronization)
- Practitioner guidance (vendor blog, not peer reviewed):
  - Hash the full simulation state per tick, including RNG state. CRC32 or an XOR hash is cheap enough to run every tick.
  - Hash per subsystem to localize divergence.
  - Log the last tick that matched and the first that did not.
  — [bugnet.io: lockstep determinism checker](https://bugnet.io/blog/how-to-build-a-lockstep-determinism-checker)
- TigerBeetle's "pair assertions" (validate before write and after read) is the save/load equivalent. — [TIGER_STYLE.md](https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/docs/TIGER_STYLE.md)
- SQLite's journal-test VFS checks an invariant at the I/O layer (nothing is written to the database before the journal is synced) and raises an assertion on violation. — [sqlite.org/testing.html](https://www.sqlite.org/testing.html)

### Inferences
- Patterns for this game:
  1. **Derived-data drift checks.** Periodically, for example every N seconds or on a hotkey, recompute caches, spatial indexes and tile buckets from the source of truth and compare them with the live versions. Use the DEV slow tier, and sample a random subset to bound the cost.
  2. **Save round-trip check.** On save in dev, serialize, deserialize, re-serialize, and compare the bytes or a hash, in the spirit of Factorio's heavy mode.
  3. **Worker results.** Hash the job inputs, then assert the shape and counts of the results when they come back from workers.
  4. **On load.** Validate the schema plus referential integrity, for example that every segment references existing nodes.
- These catch silent corruption and nondeterminism that unit tests miss, because the faults only appear after long, real play sessions.

### Gaps
- No peer-reviewed sources on checksum algorithm choice. The bugnet guidance is from a single vendor.

## 5. Dev-time watchdogs: frame time, long tasks, memory, resource disposal

### Takeaway
The Long Animation Frames (LoAF) API reports frames over 50 ms with script attribution, at near-zero cost. three.js `renderer.info.memory` counts make a cheap leak detector: a monotonic rise in geometries or textures across load/unload cycles indicates a leak. `performance.measureUserAgentSpecificMemory()` needs cross-origin isolation, which is easier to arrange in Electron.

### Cited Findings
- The LoAF API is observed with `PerformanceObserver` type `long-animation-frame` and `buffered: true`. The threshold is the same 50 ms as long tasks. `blockingDuration` sums the time of tasks over 50 ms, with the render time added to the longest task, and differs from `duration`. — [Chrome: Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames); [MDN: Long animation frame timing](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing)
- MDN suggests keeping only the worst frames (top 5–10 by `blockingDuration`) to limit the data collected. — [MDN: Long animation frame timing](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing)
- `performance.measureUserAgentSpecificMemory()`:
  - Requires a secure, cross-origin-isolated context, otherwise it throws `SecurityError`.
  - Returns `{bytes, breakdown[]}` per realm, covering workers.
  - MDN recommends sampling at randomized intervals.
  - Its status is "Limited availability" and experimental.
  — [MDN: measureUserAgentSpecificMemory](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory)
- `renderer.info.memory.geometries`/`.textures` give live counts. `WebGLRenderer.dispose()` frees the renderer's GPU resources. — [three.js WebGLRenderer docs](https://threejs.org/docs/pages/WebGLRenderer.html)

### Inferences
- A dev watchdog could:
  - (a) Log a LoAF entry with its `scripts[]` attribution whenever `blockingDuration` is over 0.
  - (b) After each chunk unload or scene reset, assert that `renderer.info.memory` returns to its baseline within a tolerance.
  - (c) Record `performance.memory.usedJSHeapSize` (non-standard, Chromium only) or the measureUserAgentSpecificMemory result in Electron, and flag growth across repeated identical cycles.
  - (d) Keep a `WeakRef`/`FinalizationRegistry` registry of disposable objects, to list geometries that were never disposed.
- All of these are cheap counter reads, except heap measurement, which is async and sampled.

### Gaps
- The three.js "how to dispose of objects" manual page returned 404 at the URLs tried, so its pitfalls (for example, that materials do not dispose their textures) are not cited.
- No measured overhead numbers for the LoAF observer were found.

## 6. What runtime checks catch vs miss, and overhead summary

### Takeaway
Runtime checks catch violated invariants, corrupted derived state, state that is not persisted, GL misuse and leaks during real play, which are exactly the states tests rarely build. They miss anything on paths that are never run, and they cost CPU or GPU time, so they need tiers and build-time stripping.

### Cited Findings
- Assertions caught a large share of the recorded faults in Microsoft's components. — [MSR-TR-2006-54](https://www.microsoft.com/en-us/research/publication/assessing-the-relationship-between-software-assertions-and-code-qualityan-empirical-investigation/)
- "a fuzzer can prove only the presence of bugs, not their absence". Assertions amplify fuzzing and exploration. — [TIGER_STYLE.md](https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/docs/TIGER_STYLE.md)
- Overhead data points:

  | Check | Cost | Source |
  |---|---|---|
  | SQLite with all asserts on | ~3x slower | [sqlite.org](https://www.sqlite.org/testing.html) |
  | WebGL getError/getParameter | up to ~1 ms per call, synchronous | [MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices) |
  | Factorio full CRC plus a save every tick | down to a few FPS | [FFF #47](https://cf-www.factorio.com/blog/post/fff-47) |
  | zod v4 vs typia | ~6.7M vs ~76M ops/s | [LogRocket](https://blog.logrocket.com/why-zod-slow) |

- Unreal's `ensure` model (report once, keep running) is the precedent for checks that remain in shipping builds without crashing players. — [Epic docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/asserts-in-unreal-engine)

### Inferences
- What runtime checks miss:
  - Paths that are never exercised.
  - Wrong-but-consistent logic, where the invariant itself is wrong.
  - Visual errors with no checkable predicate.
  - Bugs that only appear in production builds because the checks were stripped. Assertions with side effects make this worse, which is why Holzmann requires them to be side-effect free.
- Combining DEV asserts, opt-in slow and heavy modes, and a few short scripted smoke runs can replace much of a slow test suite for this project, but not visual regression checks.

### Gaps
- No 2025–2026 studies quantifying runtime checks vs test suites in game projects were found.
