# The gate: how a build is measured (E1)

> **Superseded on 2026-10-13.** The gate was removed (the player: hours before each push, few
> scenes, noise). Regressions are stopped by reading the code and by counters, in seconds:
> `docs/research/regression-barrier.md`. Kept as the record of what was tried.

Question: how to measure a production build of the game on this machine so that
a candidate can be compared with the base and a regression blocks the push.

## Sources read
- Chrome, *Long Animation Frames API* —
  https://developer.chrome.com/docs/web-platform/long-animation-frames
  `PerformanceObserver` with `type: 'long-animation-frame'` and `buffered: true`;
  an entry is a frame whose render was delayed past 50 ms; `duration`,
  `blockingDuration`, `renderStart`, `styleAndLayoutStart`, and `scripts` (only
  scripts > 5 ms) with `invoker`, `sourceURL`, `sourceFunctionName`, `duration`.
  Caveats: attribution is the entry point, not the slow callee; no scripts means
  rendering work; workers are not attributed. Shipped in Chrome 123.
- MDN, `Performance.memory` —
  https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory
  Non-standard, deprecated, imprecise (may over- or under-estimate). Therefore the
  gate reads the heap through the DevTools protocol (`Performance.getMetrics`
  `JSHeapUsedSize`) after `HeapProfiler.collectGarbage` when it wants retained
  memory, and never through `performance.memory`.
- Playwright, `BrowserType` —
  https://playwright.dev/docs/api/class-browsertype
  `launch` defaults to headless; `channel: 'chrome'` picks the installed Chrome;
  `launchPersistentContext('')` makes a temporary user data directory: every
  round starts on a fresh profile.
- Khronos, WebGL 2.0 specification —
  https://registry.khronos.org/webgl/specs/latest/2.0/
  Overloads of `texImage2D/texSubImage2D/texImage3D/texSubImage3D` (ArrayBufferView
  with `srcOffset` in elements, PBO offset, `TexImageSource`); the bytes sent are
  the rectangle given (width × height [× depth]) at the format/type's bytes per
  pixel, not the length of the array handed in. The byte formula itself is in the
  OpenGL ES 3.0 spec (not opened; the table of formats and types used is the
  standard one).
- three.js `WebGLInfo` (read at the SOURCE: `renderer.info.render.calls/triangles`,
  `info.programs`, `info.memory`): with `autoReset = false` and a manual `reset()`
  between two frames, one whole frame is counted (post-processing passes call
  `render` several times a frame).

## Decisions
- Visible Chrome on the RTX 3060 (`--use-angle=d3d11`), 1280×720, DPR 1; the GPU
  name is read every round (from the game's `__gpu`, which reads
  `WEBGL_debug_renderer_info`); a round on another GPU stops the gate with
  NÃO VERIFICADO.
- The machine is checked before every round (CPU over 2 s ≤ 40 %, ≥ 6 GB free);
  after 10 minutes of waiting the gate stops with NÃO VERIFICADO: máquina ocupada.
- A/B interleaved (ABAB, BABA...), each side a new Chrome; median and spread of
  each metric; a metric is worse by the test in "Statistics" below (until
  2026-10-12: when the candidate's median passed the base's by more than the A/A
  noise plus an absolute margin, which called noise a regression, PROBLEMS R17);
  the absolute margins per unit stay (ms 2, LoAF 5, counts 1, bytes 64 KiB).
- Frame intervals from the gate's own `requestAnimationFrame` loop (the game draws
  on demand, so its own frame log has gaps that are not frames).
- Uploads counted by wrapping `bufferData`, `bufferSubData`, `texImage2D/3D`,
  `texSubImage2D/3D`, `compressedTex(Sub)Image2D` on the WebGL prototypes before
  the game runs; the five largest kinds of texture upload (call, size, format,
  type) are kept per window.
- Programs linked counted by wrapping `linkProgram` (a program created after the
  game is ready is a compile during play).
- Pictures compared pixel by pixel in a browser page (canvas decoding), share of
  pixels with a channel differing by more than 16 levels, plus a difference image;
  no image library added.

## Not read
- OpenGL ES 3.0 spec tables (bytes per format/type are the standard ones).
- `measureUserAgentSpecificMemory` details (needs cross-origin isolation; not used).

## Statistics (added 2026-10-12, after the E3 push was blocked by noise, PROBLEMS R17)
- Chromium Pinpoint, `dashboard/pinpoint/models/compare/compare.py` and
  `thresholds.py` (catapult, read at the source): two samples are DIFFERENT
  when the smaller of the Mann-Whitney U and Kolmogorov-Smirnov p-values is at
  most the low threshold, 0.01; SAME above a high threshold that falls as the
  samples grow; in between UNKNOWN, and more repeats are run (bounded).
- Mozilla PerfCompare (firefox-source-docs, "PerfCompare"): Mann-Whitney U by
  default (replacing Student's t), significant at p < 0.05, and a change shown
  only with a meaningful effect size, Cliff's delta (< 0.15 negligible, < 0.33
  small, < 0.47 moderate, >= 0.47 large).
- Decision taken: exact two-sided Mann-Whitney U (the permutation distribution
  of the rank sum, ties at mean ranks) and Cliff's delta per judged metric;
  PIOR at p <= 0.01 with delta >= 0.47 and the median difference above the
  metric's absolute margin; `suspeito` at p <= 0.05 (two more rounds, AB and BA,
  up to 12); six rounds by default (with three a side the smallest possible p
  is 0.1: the old gate's three rounds could never be significant). The KS test
  of Pinpoint is not added: it guards against changes of spread with the median
  unmoved, which the p99/max metrics already see.
- Not read: Kalibera and Jones, "Rigorous benchmarking in reasonable time".
