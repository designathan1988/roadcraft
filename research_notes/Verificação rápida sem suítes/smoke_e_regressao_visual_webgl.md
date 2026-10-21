# Fast smoke testing and visual regression testing of WebGL / three.js / Electron in headless browsers (2026)

Context: WebGL2 game, three.js r186, Vite dev server, Electron 44, Playwright 1.62. Research date 2026-10-21. Sources fetched directly (GitHub raw files, official docs). Where a fetch failed, it is listed as a gap.

## 1. How engines/libraries test rendering in CI (three.js, Babylon.js, MapLibre, others)

### Takeaway
three.js runs every example once in Puppeteer with time frozen, Math.random seeded, and exactly one rAF frame delivered. It compares 400x250 screenshots (taken at viewScale 2, downscaled) with a per-pixel threshold of 0.1 and at most 0.1% differing pixels. It has no retries and an exception list of about 55 flaky or slow examples. Babylon.js and MapLibre follow the same pattern: a Playwright or Puppeteer harness, committed reference PNGs, and pixel diff.

### Cited Findings
**three.js (`test/e2e/puppeteer.js`, dev branch)**
- Chrome flags: `--hide-scrollbars --enable-unsafe-webgpu --enable-features=Vulkan --disable-vulkan-surface --ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --disable-gpu-watchdog --no-sandbox`. Env `VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json`, i.e. Mesa lavapipe software Vulkan. No SwiftShader or ANGLE flag is passed. — [three.js puppeteer.js](https://raw.githubusercontent.com/mrdoob/three.js/dev/test/e2e/puppeteer.js)
- `headless` is `'new'` locally and `false` in CI, where it runs under xvfb. Uses a persistent `userDataDir: './.puppeteer_profile'`. — [puppeteer.js](https://raw.githubusercontent.com/mrdoob/three.js/dev/test/e2e/puppeteer.js)
- Thresholds: `pixelThreshold = 0.1` (per-pixel color error) and `maxDifferentPixels = 0.1` (percent of the image). Viewport is 400x250 with `viewScale = 2`; the screenshot is downscaled by 1/viewScale, which smooths AA noise. Screenshots are JPEG at quality 95. — [puppeteer.js](https://raw.githubusercontent.com/mrdoob/three.js/dev/test/e2e/puppeteer.js)
- Timing per example:
  - Network idle: `idleTime = 2` s, `networkTimeout = 5` min.
  - Parse wait: `parseTime = 1` s per MB of page payload.
  - Video readiness poll: every 100 ms, 5 s cap.
  - Render: `renderTimeout = 5` s.
  - A render timeout is tolerated and the screenshot is still taken (`// TODO: fix this`). — [puppeteer.js](https://raw.githubusercontent.com/mrdoob/three.js/dev/test/e2e/puppeteer.js)
- Flakiness handling:
  - No retry count; each file gets one attempt.
  - A TimeoutError fails the file and restarts the browser.
  - "WebGPU Device Lost" restarts the browser without recording a failure.
  - About 55 examples are excluded. The categories include "too slow" (7), "timing issues" (15), "needs more render time" (12), "black screen" post-processing (8) and video/webcam. — [puppeteer.js](https://raw.githubusercontent.com/mrdoob/three.js/dev/test/e2e/puppeteer.js)
- Determinism (`deterministic-injection.js`, injected via `evaluateOnNewDocument`):
  - `Math.random` is replaced with a sine hash: seed `Math.PI/4`, `x = Math.sin(seed++)*10000`, returns `x - floor(x)`.
  - `performance.now`, `Date.now` and `Date.prototype.getTime` all return 0.
  - `requestAnimationFrame` polls every 100 ms until `window._renderStarted`. It then fires the callback once with time 0 and sets `_renderFinished`, so only one frame is rendered.
  - Videos get `playbackRate = 0` and are paused once they resolve. — [deterministic-injection.js](https://raw.githubusercontent.com/mrdoob/three.js/dev/test/e2e/deterministic-injection.js)
- Parallelism:
  - `numCIJobs = 5`; the file list is sliced by job index.
  - The CI matrix is `CI: [0,1,2,3,4]` on `ubuntu-latest`, with `fail-fast: false` and a 30-minute timeout.
  - CI steps: `sudo apt-get install -y mesa-vulkan-drivers xvfb`, `npm ci`, `npm run build`, `xvfb-run -a npm run test-e2e`.
  - Output screenshots are uploaded as an artifact even on failure. — [three.js ci.yml](https://github.com/mrdoob/three.js/blob/dev/.github/workflows/ci.yml)
- A separate fast job runs `lint`, `test-unit`, `test-unit-addons` and `test-e2e-cov` ("Examples ready for release", a coverage check that each example has a screenshot). — [ci.yml](https://github.com/mrdoob/three.js/blob/dev/.github/workflows/ci.yml)

**Babylon.js**
- Visualization tests are entries in `packages/tools/tests/test/visualization/config.json`. Each entry has `title`, `playgroundId`, optional `referenceImage`, `excludedEngines` and `renderCount` (default 1 frame). — [Babylon.js contribute docs](https://doc.babylonjs.com/contribute/toBabylon/HowToContribute#visualization-tests)
- Tests run on Playwright for the webgl1, webgl2 and webgpu engines:
  - Run everything: `npm start`, then `npm run test:visualization`.
  - Filter: `npm run test:visualization -- --project="webgl2" -g "Title"`.
  - UI mode: `npm run test:visualization:ui`.
  - Reference snapshots are produced by running the test once, then committed under `snapshots/`.
  - A failing test does not stop the run; a report opens at the end. — [Babylon.js docs](https://doc.babylonjs.com/contribute/toBabylon/HowToContribute#visualization-tests)

**MapLibre GL JS**
- Render tests are `style.json` fixtures whose metadata gives size, camera and description. Puppeteer drives a real browser and produces `actual.png`; pixelmatch compares it with `expected.png` and writes `diff.png`.
- Commands:
  - Run: `npm run test-render`, serial by default. Parallel: `RENDER_TEST_CONCURRENCY=4`. Filter: `-t "<name>"`.
  - Update baselines on Linux: `xvfb-run -a UPDATE=true npm run test-render`.
  - A failing test is retried with console output enabled.
  - The HTML report is written to `test/integration/render/results.html`. — [MapLibre integration README](https://github.com/maplibre/maplibre-gl-js/blob/main/test/integration/README.md)

### Inferences
- The three.js recipe maps directly onto a game smoke test:
  - Inject a deterministic script before page load.
  - Wait for assets, render exactly one frame with time frozen, then screenshot a small, downscaled canvas.
  - Compare with a per-pixel threshold of about 0.1 and an allowed differing-pixel budget of about 0.1%.
- Their 2 s network-idle wait and the 1 s/MB parse wait are the dominant per-example costs. A game smoke test should instead wait on an explicit app signal (e.g. `window.__firstFrame = true`).
- Software rasterizers (lavapipe) are used in CI on purpose: they are deterministic across runs on the same image. Baselines must be generated on that same stack.

### Gaps
- MapLibre's default `allowed` diff and pixelmatch threshold: the `run_render_tests.ts` raw URL returned 404, so the values were not confirmed.
- Babylon's comparison thresholds (`visualization.utils.ts` path 404); not confirmed.
- PlayCanvas, Cesium, deck.gl and Google Maps render-test specifics were not researched within the tool budget.
- Per-example wall time for three.js e2e: none of the sources state it.

## 2. Headless Chrome GPU options, determinism and image-comparison tooling

### Takeaway
Headless Chrome disables the GPU by default. You can opt into a real GPU with ANGLE/Vulkan flags, or into deterministic software rendering with SwiftShader (`--use-angle=swiftshader-webgl --enable-unsafe-swiftshader`) or lavapipe. Baselines are only valid on the exact stack that produced them. Playwright's `toHaveScreenshot` (default threshold 0.2), pixelmatch (default 0.1, OKLab/HyAB plus AA detection) and odiff (about 5-7x faster than pixelmatch) cover pixel diffs. NVIDIA FLIP is the perceptual option.

### Cited Findings
- Chrome dev blog: "By default, Headless Chrome disables GPU".
  - Linux recipe: `--no-sandbox --headless=new --use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface --enable-unsafe-webgpu`.
  - Warning: some flag combinations detect the GPU but can't use it. Verify at `chrome://gpu`.
  - Before the fix, WebGL showed "Software only" with GL_RENDERER SwiftShader. After installing proper NVIDIA drivers it showed hardware acceleration. — [Chrome for Developers: Supercharge Web AI testing](https://developer.chrome.com/blog/supercharge-web-ai-testing)
- SwiftShader for WebGL now requires opting in with `--enable-unsafe-swiftshader`. The fallback combination is `--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader`, and the docs call it useful for testing on headless/GPU-less systems. — [Chromium docs: Using Chromium with SwiftShader](https://chromium.googlesource.com/chromium/src/+/798e59c5275d4131797e8ea2e96e6c6000256b58/docs/gpu/swiftshader.md)
- Playwright `toHaveScreenshot` options and caveats:
  - `threshold` defaults to 0.2 (YIQ-style 0..1). `maxDiffPixels` and `maxDiffPixelRatio` are available, and `stylePath` can inject CSS that hides dynamic elements.
  - Rendering varies with OS, version, hardware, power source and headless mode, so generate baselines in the same environment.
  - Snapshots are suffixed per browser/platform (e.g. `chromium-darwin`). Update them with `npx playwright test --update-snapshots`.
  - Move the mouse away with `page.mouse.move(-1,-1)` to avoid hover states. — [Playwright: Visual comparisons](https://playwright.dev/docs/test-snapshots)
- Playwright Clock API:
  - It fakes `Date`, `setTimeout/Interval`, `requestAnimationFrame/cancelAnimationFrame`, `requestIdleCallback`, `performance` and `Event.timeStamp`.
  - `clock.install()` must come first. `pauseAt`, `runFor` (fires timers and animation frames), `fastForward` and `resume` follow; `setFixedTime` fixes only Date.
  - Calls made before `install` give undefined behavior. — [Playwright: Clock](https://playwright.dev/docs/clock)
- pixelmatch defaults: `threshold 0.1`, `includeAA false` (AA pixels ignored), `alpha 0.1`, `aaColor [255,255,0]`, `diffMask false`. Current versions compare in OKLab with HyAB distance and use Vyšniauskas (2009) anti-aliasing detection. It has zero dependencies and works on raw typed arrays. — [pixelmatch README](https://github.com/mapbox/pixelmatch)
- odiff benchmarks:
  - Cypress full page: odiff 1.168 s vs pixelmatch 7.712 s vs ImageMagick 8.881 s.
  - "8k" water image: odiff 1.951 s vs pixelmatch 10.614 s.
  - Options include `antialiasing` and `ignoreRegions` rectangles.
  - `ODiffServer` / `odiff --server` keeps a process warm, so process spawn is not paid per compare (`npm i odiff-bin`). — [odiff README](https://github.com/dmtrKovalenko/odiff)
- NVIDIA FLIP:
  - Perceptual error metric for rendered images, in LDR-FLIP and HDR-FLIP variants.
  - Install with `pip install flip-evaluator` (Python 3.10+) and run `flip -r ref.png -t test.png`. A C++/CUDA single header (`FLIP.h`) and a PyTorch loss are also available. — [NVlabs/flip](https://github.com/NVlabs/flip)
- three.js's own determinism controls are in section 1: seeded Math.random, `performance.now`/`Date.now` = 0, a single rAF frame. — [deterministic-injection.js](https://raw.githubusercontent.com/mrdoob/three.js/dev/test/e2e/deterministic-injection.js)

### Inferences
- On a Windows dev box with a real GPU, the default Playwright headless Chromium may fall back to software/SwiftShader WebGL. Check `renderer` via `WEBGL_debug_renderer_info`, or `chrome://gpu`, as the first assertion of the smoke test. The point is to know which baseline set applies.
- For a large procedural city scene, pixel-exact baselines across GPU and SwiftShader are unrealistic. Use one baseline per stack (as Playwright does per platform), or loosen to a ratio budget plus FLIP mean error.
- Freeze time two ways: with `page.clock.install()` plus `runFor`, or a three.js-style init script. Seed the game's own RNG via a URL param or init script. Otherwise wind, traffic and particles make screenshots flaky.

### Gaps
- No measured numbers on SwiftShader vs real-GPU frame time for a three.js scene.
- Whether `--use-angle=d3d11` in headless mode on Windows gives hardware WebGL: no source found in budget.

## 3. Capturing failures (console, pageerror, WebGL errors, shader errors, Electron)

### Takeaway
Fail the smoke test on any of these:
- `pageerror` or a console `error`
- `webglcontextlost`
- three.js `renderer.debug.onShaderError` firing (`checkShaderErrors` defaults to true)
- a non-zero `gl.getError()` after the first frame
- the first-frame signal not arriving within a timeout

Playwright's `_electron.launch` gives the same `Page` API for the Electron build, but its Electron support is still experimental.

### Cited Findings
- three.js WebGLRenderer `debug.checkShaderErrors` defaults to `true`. `debug.onShaderError(gl, program, glVertexShader, glFragmentShader)` is a custom callback, and "Assigning a custom function disables the default error reporting". `compileAsync` uses `KHR_parallel_shader_compile` when the extension is available. — three.js source in this repo (`node_modules/three/src/renderers/WebGLRenderer.js`, lines 164-195 and 1506-1555), mirrored at [three.js WebGLRenderer.js](https://github.com/mrdoob/three.js/blob/dev/src/renderers/WebGLRenderer.js)
- `KHR_parallel_shader_compile` lets you poll `gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR)` without stalling. Total link time is unchanged. MDN's advice: "Never check compile status unless subsequent linking fails". The extension is not Baseline. — [MDN KHR_parallel_shader_compile](https://developer.mozilla.org/en-US/docs/Web/API/KHR_parallel_shader_compile)
- Playwright Electron:
  - Experimental support, Electron v21+.
  - `electron.launch({ args, executablePath, env, timeout (default 30000), recordVideo })`, then `firstWindow()`. `evaluate(({app}) => ...)` runs in the main process, which is also how you stub native dialogs.
  - If launch times out, check that the `EnableNodeCliInspectArguments` fuse is not disabled. — [Playwright: Electron](https://playwright.dev/docs/api/class-electron)
- three.js CI treats "WebGPU Device Lost" as an infrastructure error: it restarts the browser rather than failing the test. Context loss is therefore a signal to classify, not always a code bug. — [puppeteer.js](https://raw.githubusercontent.com/mrdoob/three.js/dev/test/e2e/puppeteer.js)

### Inferences
- Minimal capture set in Playwright (standard APIs):
  - `page.on('pageerror')`; `page.on('console', m => m.type()==='error')`; `page.on('requestfailed')`.
  - An init script that adds a `webglcontextlost` listener on the canvas and wraps `HTMLCanvasElement.prototype.getContext` to record context creation failure.
  - The app sets `renderer.debug.onShaderError` to push to `window.__errors`.
  - Unhandled promise rejections surface through `pageerror` in Chromium. Calling `gl.getError()` once after the first frame is cheap. Calling it every draw stalls the pipeline (standard WebGL practice; not sourced here).
- Long tasks: a `PerformanceObserver({type:'longtask'})` registered in an init script can report main-thread stalls of 50 ms or more during boot. This is a standard web API; not fetched in this session.
- GPU memory: `renderer.info.memory.{geometries,textures}` and `renderer.info.programs.length` are cheap leak and explosion sentinels to assert against bounds.

### Gaps
- Electron 44 compatibility with Playwright 1.62 `_electron`: no source fetched. The docs say only "v21+" and "experimental".
- Measured overhead of `gl.getError()` per call: not found.

## 4. Speed of a boot-to-first-frame smoke test, and what it misses

### Takeaway
No source gave a measured "boot-to-first-frame in N seconds" figure for a three.js app. The sourced cost drivers are network idle waits, payload parsing and shader compilation, and browser launch and restart. These are reduced by waiting on an app-level ready flag instead of networkidle, reusing a warm browser/server, using a small viewport (400x250 in three.js), using a fast differ (odiff server mode) and rendering a single frame. Smoke tests do not catch frame-time regressions, behavior after minutes of play, GPU-specific driver bugs on other stacks, or anything outside the captured view.

### Cited Findings
- three.js per-example budget:
  - 2 s network idle, plus 1 s/MB parse, plus up to 5 s render.
  - Browser restarts only on timeout.
  - Small 400x250 output.
  - Sharded into 5 CI jobs to bound wall time (30-min job timeout). — [puppeteer.js](https://raw.githubusercontent.com/mrdoob/three.js/dev/test/e2e/puppeteer.js), [ci.yml](https://github.com/mrdoob/three.js/blob/dev/.github/workflows/ci.yml)
- Image diff cost scales with resolution: about 1.2-2 s with odiff vs 7.7-10.6 s with pixelmatch on large images. A small canvas keeps diffing in the millisecond range. — [odiff README](https://github.com/dmtrKovalenko/odiff)
- Playwright's Electron `launch` default timeout is 30 s. That is a ceiling, not a typical time. — [Playwright Electron](https://playwright.dev/docs/api/class-electron)
- `compileAsync`/`KHR_parallel_shader_compile` doesn't reduce total link time, so shader count bounds first-frame time. — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/KHR_parallel_shader_compile)

### Inferences
- Practical fast recipe, synthesized from the sources (not measured here):
  1. Keep the Vite dev server running.
  2. Launch Chromium once with `headless` and the GPU flags.
  3. Add an init script that seeds RNG, freezes time and installs error hooks.
  4. `page.goto(url, { waitUntil: 'commit' })`.
  5. `waitForFunction(() => window.__firstFrame)` with a timeout of about 10-20 s.
  6. Assert no errors, plus `renderer.info` bounds and a non-blank canvas (pixel variance above 0).
  7. Take one small screenshot and compare with ratio and threshold settings.
- A Vite dev server cold start transforms modules on demand. The first page load after a server restart is slower than a warm one; this is consistent with the three.js choice of a pre-built server, but not separately sourced.
- What it does not catch:
  - Performance or frame pacing.
  - Leaks over time.
  - Rare timing races that one frozen frame hides (three.js excludes 15 "timing issues" examples for exactly this reason).
  - Differences between real-GPU and software rendering.
  - Content that streams in later than the first frame.

### Gaps
- No engineering blog with measured smoke-test seconds for WebGL apps was found within the tool budget.

## 5. Golden-image testing in game engines (Unity, Unreal, Godot)

### Takeaway
Game engines use the same model with perceptual tolerances. Unity's Graphics Test Framework uses a per-pixel deltaE threshold plus an average-error threshold, and requires an exact match when no settings are given. Unreal uses low/medium/high tolerance presets, per-channel and brightness tolerance, ignore-AA and luminance-only options, and a "Disable Noisy Rendering Features" switch. Godot has community tooling that keys baselines per platform and renderer.

### Cited Findings
- Unity `ImageComparisonSettings`:
  - `PerPixelCorrectnessThreshold`: deltaE below this is ignored as noise.
  - `AverageCorrectnessThreshold`: the image fails if the mean error exceeds it.
  - Settings may be null, in which case the image must be exactly identical. A diff image is attached on failure. — [Unity SRP mirror: ImageComparisonSettings.cs](https://plastichub.unity.cn/unity-tech-cn/ScriptableRenderPipeline/src/branch/main...com.unity.testframework.graphics/Runtime/ImageComparisonSettings.cs); [Unity GTF 9.0 sample projects](https://docs.unity3d.com/Packages/com.unity.testframework.graphics@9.0/manual/sample-projects.html)
- Unreal:
  - `Tolerance` presets default to Low, because "TxAA" adds constant per-pixel variation.
  - `FComparisonToleranceAmount` sets per-channel RGBA and Min/MaxBrightness tolerance.
  - "Ignore Anti-Aliasing" searches neighboring pixels; "Ignore Colors" compares luminance only.
  - "Disable Noisy Rendering Features" turns off AA, motion blur, SSR, eye adaptation and contact shadows.
  - Screenshots are reviewed in the Screenshot Comparison tool with history across builds. — [UE 4.27 Screenshot Comparison](https://docs.unrealengine.com/4.27/en-US/TestingAndOptimization/Automation/ScreenShotComparison); [FAutomationScreenshotOptions API](https://dev.epicgames.com/documentation/unreal-engine/API/Developer/FunctionalTesting/FAutomationScreenshotOptions)
- Godot (community, `Gua.Testing.Visual` 0.18.0):
  - Baselines are keyed per platform and renderer, e.g. `windows-godot-gl-compatibility`.
  - Advice: pin resolution, DPI, fonts, locale, engine version, renderer and driver.
  - Don't create new variants for random diffs, because that hides regressions. — [NuGet Gua.Testing.Visual](https://www.nuget.org/packages/Gua.Testing.Visual/)

### Inferences
- For the game, mirror Unreal's "disable noisy features" in test mode: no TAA/temporal effects, no auto-exposure, no particles or wind, fixed time of day. This removes most nondeterminism before any thresholding.
- Combine a pixel-ratio gate (three.js: 0.1%) with a mean-error gate (Unity average/FLIP mean). The ratio gate catches localized breakage; the mean gate catches global shifts such as tonemapping or color-space changes.

### Gaps
- Exact Unity default threshold values and the Unreal enum numeric tolerances were not confirmed from official pages.
- No official Godot engine-level visual regression suite was found.
