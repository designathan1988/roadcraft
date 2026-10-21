# Adaptive scalability: automatic quality scaling and frame pacing across weak and strong PCs (as of Oct 2026)

Note on method: about 17 search and fetch calls. Primary sources are the Unreal, Unity, MDN, Steam, Chrome, Android and Epic docs. Benchmark numbers come from GamersNexus and UL. Some community or forum results are flagged where used. Several requested items (MSFS tier tables, Digital Foundry, GPUOpen DRS article, Electron flag docs) could not be retrieved and are listed under Gaps.

## 1. Concrete tier tables from shipped games/engines, and which settings save most per quality lost

### Takeaway
Shadows, LOD/draw distance, GI and volumetrics are the big-ticket items; AA, textures (with enough VRAM), AO and reflections were near-free in Cities: Skylines II. UE's stock scalability shows the typical tier ladder: shadow map 512→1024 with 1→4 cascades, texture pool 200→1000 MB, and foliage density 0/0.4/0.8/1.0.

### Cited Findings
**Unreal Engine scalability groups** (levels 0=Low … 3=Epic) — [UE Scalability Reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/scalability-reference-for-unreal-engine)
- Shadows (sg.ShadowQuality), levels 0/1/2/3:
  - r.Shadow.MaxResolution: 512 / 1024 / 1024 / 1024
  - r.Shadow.CSM.MaxCascades: 1 / 1 / 2 / 4
  - r.Shadow.RadiusThreshold: 0.06 / 0.05 / 0.04 / 0.03. This culls small casters by screen radius, which works like a screen-space-error cutoff.
  - r.ShadowQuality: 0 / 2 / 5 / 5
  - r.LightFunctionQuality: 0 / 1 / 1 / 1
- Textures (sg.TextureQuality), levels 0/1/2/3:
  - r.Streaming.MipBias: 2.5 / 1 / 0 / 0
  - r.MaxAnisotropy: 0 / 2 / 4 / 8
  - r.Streaming.PoolSize: 200 / 400 / 700 / 1000 MB
- Post-process, levels 0/1/2/3:
  - r.AmbientOcclusionLevels: 0 / 1 / 2 / 3
  - AO radius scale: 1.7 / 1.7 / 1.5 / 1.0
  - MotionBlurQuality: 0 / 3 / 3 / 4
  - DOF quality: 0 / 1 / 2 / 2
- Effects, levels 0/1/2/3:
  - Translucency lighting volume: 24 / 32 / 48 / 64
  - SSR: off / off / off / quality 1, on Epic only
  - Scene colour format: 3 / 3 / 3 / 4
- Foliage: density scale 0 / 0.4 / 0.8 / 1.0.
- View distance: r.ViewDistanceScale defaults to 1.0. The docs give 0.4 and 0.7 as examples, not per-level values.
- r.ScreenPercentage accepts 10–100.
- AA: r.PostProcessAAQuality 0 = off and values above 6 do nothing. For TAA, 2 settles fast but jitters, while 4 settles slower without jitter.

**Cities: Skylines II per-setting cost** (GTX 1080 Ti, 1080p Low baseline, 100K-pop city, dynamic resolution off) — [GamersNexus](https://gamersnexus.net/game-benchmarks-graphics-guides/terrible-optimization-cities-skylines-2-gpu-benchmarks-graphics)
- Shadows Low→Off: about +37%, the largest single gain.
- LOD at Low: about +29%.
- GI Off: 31.8→35.5 fps, about +12% (about +7.3% after the patch).
- Volumetrics Off: 31.8→35.2 fps, about +11%.
- DOF Off: about +5.7% (+3% after the patch).
- AO, clouds, AA (FXAA), texture quality and reflections had little measurable effect.
- Very Low vs Low preset: about 72 vs 32 fps (2×). GN calls this gap too wide and says a middle preset is needed.
- City size matters: a 4090 at 1080p Medium ran about 62% faster in a 1K-pop city than in a 100K-pop city.
- The first patch gave +4.5% (RX 7800 XT) to +18% (GTX 970). Weak cards gained most.
- The CS2 developer recommended turning off DOF mode, DOF quality and volumetrics — [SI Videogames guide](https://videogames.si.com/guides/cities-skylines-2-settings-to-increase-performance)
- PCGamesN recommended Medium for GI, reflections, shadows, terrain and LOD, with High textures. CS2 has no built-in benchmark — [PCGamesN](https://www.pcgamesn.com/cities-skylines-2/settings-best)

**Fortnite Performance Mode (low-end tier)** — [Epic/Fortnite news, Apr 2021](https://www.fortnite.com/news/fortnite-performance-mode-boosts-pc-fps)
- The test machine was an i5-8265U with Intel UHD 620 and 8 GB RAM.
- At 720p in Squads it went from 24 fps to 61 fps with high-resolution textures disabled.
- No dedicated GPU is required. Epic suggests an SSD or at least 6 GB RAM.
- Listed specs: minimum Intel HD 4000 / i3-3225 / 8 GB; recommended GTX 960 / i5-7300U / 16 GB — [PCGamesN](https://www.pcgamesn.com/fortnite/system-requirements)

**Unity Adaptive Performance thermal example** — [Unity Adaptive Performance user guide](https://docs.unity3d.com/Packages/com.unity.adaptiveperformance@5.1/manual/user-guide.html)
- QualitySettings.lodBias = 1.0 with no warning.
- lodBias = 0.75 when throttling is imminent and temperature is above 0.8.
- lodBias = 0.5 while throttling.

### Inferences
- For a city game, the order of savings per quality lost is roughly: (1) volumetrics, DOF and motion blur (cheap to lose, about 5–11%); (2) shadow cascades and resolution (largest gain, but visible); (3) LOD and draw distance (large gain, visible at the horizon); (4) GI. AA, AO and texture resolution are cheap on GPU time when VRAM is enough, so they should be cut for memory reasons, not for speed.
- The 2× jump between CS2's Very Low and Low shows that tiers should be spaced in roughly equal steps of cost. Avoid one huge step.

### Gaps
- No primary Microsoft Flight Simulator 2020/2024 tier table was retrieved (terrain LOD 50–400, etc. are unverified here).
- No Digital Foundry "optimised settings" article was fetched.
- No official Fortnite/UE5 Lumen/Nanite per-tier table was retrieved.
- The CS2 numbers are launch-era (late 2023). Later patches may have changed them.

## 2. Hardware detection, initial quality selection and the hardware population

### Takeaway
The Steam population in Sep 2026 is mostly 8–16 GB VRAM at 1080p/1440p. Integrated GPUs are a small share of Steam, but they span a wide range: Iris Xe scores about 1.5k in Time Spy and the 780M about 2.7k, a 1.8× gap. The initial tier should come from a quick GPU-name/VRAM heuristic, then be corrected by a short measured warm-up, as UE's benchmark-based autodetect does.

### Cited Findings
**Steam Hardware Survey, September 2026** — [Steam HW Survey](https://store.steampowered.com/hwsurvey/)
- VRAM:

  | VRAM | Share |
  |---|---|
  | 16 GB | 27.21% |
  | 8 GB | 26.71% |
  | 12 GB | 13.06% |
  | 24 GB | 5.50% |
  | 6 GB | 5.12% |
  | 4 GB | 5.13% |
  | 2 GB | 3.69% |

  About 14% have 6 GB or less.
- Display: 1920×1080 47.91%; 2560×1440 27.04%; 2560×1600 5.22%; 3840×2160 4.79%.
- System RAM: 32 GB 42.22%; 16 GB 37.82%; 8 GB 6.47%.
- Top GPUs: RTX 5070 5.86%, RTX 5060 4.20%, 5060 Ti 3.87%, 4060 3.72%, 3060 3.54% — [Digital Citizen summary](https://www.digitalcitizen.life/nvidia-rtx-5070-most-popular-gpu-steam-hardware-survey-september-2026/)
- Integrated GPUs listed as separate entries (no total integrated share is given):

  | GPU | Share |
  |---|---|
  | Intel Iris Xe | 1.50% |
  | AMD Radeon Graphics | 1.43% + 0.81% |
  | Intel UHD Graphics | 1.01% |
  | Intel UHD 620 | 0.40% |
  | Radeon 780M | 0.32% |
  | Steam Deck GPU | 0.28% |
  | Apple M2 | 1.74% |

- Linux is 3.05% overall.
- July 2026 was the first month that 16 GB (25.9%) overtook 8 GB (25.32%) — [Club386](https://www.club386.com/steam-hardware-survey-july-2026/)
- Caveat: the survey measures respondents. Month-to-month swings partly reflect who answered.

**Integrated GPU performance (3DMark Time Spy graphics medians)**
- Radeon 780M: about 2,747 — [UL Benchmarks 780M](https://benchmarks.ul.com/hardware/gpu/AMD%20Radeon%20780M+review)
- Intel Iris Xe: about 1,510–1,517 — [UL Benchmarks Iris Xe](https://benchmarks.ul.com/hardware/gpu/Intel%20Iris%20Xe%20Graphics+review)
- Core Ultra 7 155H (Arc/Xe-LPG iGPU) scored 3,452 vs 2,785 for a 780M — [Notebookcheck](https://www.notebookcheck.net/Intel-shares-iGPU-performance-data-of-Intel-Core-Ultra-7-155H.782988.0.html)
- UHD 770 at stock is about Vega 6 level, and overclocking raised it by about 47% — [The Overclocking Page](https://theoverclockingpage.com/2024/01/28/intel-uhd-graphics-770-exploring-the-performance-of-intels-integrated-graphics/?lang=en)

**Engine support for picking a starting quality**
- UE's scalability docs give the 0–3 level ladder above, but the fetched page does not cover the autodetect thresholds — [UE Scalability Reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/scalability-reference-for-unreal-engine)
- Unity's Adaptive Performance defaults: AdaptiveResolution scale 0.5–1.0 over 9 levels — [Unity AP guide](https://docs.unity3d.com/Packages/com.unity.adaptiveperformance@5.1/manual/user-guide.html)

### Inferences
- A practical tier map for a WebGL/Electron city game, built from the data above (not taken from any single source):

  | Tier | Hardware | VRAM | Settings |
  |---|---|---|---|
  | Low | UHD 620/770, Iris Xe, small Radeon iGPU | ≤2 GB effective, shared memory | 720p–900p internal, 1 cascade at 512–1024, no AO |
  | Medium | 780M / Steam Deck / Arc iGPU, GTX 1650/1060-class | 4–6 GB | |
  | High | RTX 3060/4060/5060 | 8 GB | |
  | Ultra | 12–16 GB cards | 12–16 GB | |

- Unmasked renderer strings from WEBGL_debug_renderer_info can seed the tier. A 5–10 s measured warm-up should then confirm or demote it, because UHD 770 and Iris Xe differ by about 2× under the same "Intel" name.
- Since 1080p is about 48% of users and 1440p is 27%, resolution scale should be a percentage of native, not a fixed resolution.

### Gaps
- UE autodetect internals (r.ScalabilityBenchmark / Synth Benchmark CPU and GPU index thresholds; levels around 100 = "average") were not on the fetched page and are unverified.
- No Steam Deck Time Spy median was found.
- No clean, single-source UHD 770 score was found.

## 3. Dynamic resolution and an automatic quality governor

### Takeaway
Both engines drive resolution from measured GPU time against a budget with headroom, and stay within a range of 50–100% screen percentage. Each needs a minimum-change threshold, a minimum period between changes, a history window, and a "panic" path that drops fast and resets history after several over-budget frames in a row. Resolution comes first because its visual impact is lowest. Unity rates resolution Low impact and frame-rate cap High.

### Cited Findings
**UE Dynamic Resolution** — [UE Dynamic Resolution docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/dynamic-resolution-in-unreal-engine)
- Defaults: r.DynamicRes.MinScreenPercentage = 50, MaxScreenPercentage = 100, FrameTimeBudget = 33.3 ms.
- Tuning cvars:
  - TargetedGPUHeadRoomPercentage: headroom kept free before going over budget.
  - ChangePercentageThreshold: minimum change before render targets are resized.
  - MinResolutionChangePeriod: minimum frames between changes.
  - HistorySize: frames kept in the heuristic's history.
  - CPUBoundScreenPercentage: target screen percentage when CPU-bound.
  - MaxConsecutiveOverbudgetGPUFrameCount: over-budget frames in a row before the panic drop.
- Under budget, resolution "cruises" within the range. After consecutive over-budget frames, the panic switch drops resolution quickly and resets the history.
- GPU timings arrive a few frames late because they are not synced with the render thread.
- The heuristic can be replaced (IDynamicResolutionState).
- Picking ChangePercentageThreshold: too small and the resolution changes constantly; too large and it risks going over budget — [UE4.27 DR docs](https://docs.unrealengine.com/4.27/RenderingAndGraphics/DynamicResolution)

**Unity**
- Adaptive Performance tracks overall, CPU and GPU frame time every frame. CPU time covers only the main and render threads, without waits for the GPU — [Unity AP guide](https://docs.unity3d.com/Packages/com.unity.adaptiveperformance@5.1/manual/user-guide.html)
- The bottleneck (CPU, GPU or target-frame-rate bound) is inferred against the target frame rate, and a change event fires when it changes.
- The Indexer orders Scalers by: the current bottleneck, the lowest level, and the lowest visual impact. Each Scaler has a cost.
- Indexer timers "Thermal Action Delay" and "Performance Action Delay" (in seconds) act as cooldowns.
- Scalers available: Resolution (0.5–1, 9 levels, Low impact), Framerate (High impact, needs vsync off), View distance (camera far clip), LOD, Physics, Layer culling, and URP shadow cascades, distance, quality and shadowmap resolution.
- Unity's dynamic-resolution sample reads FrameTimingManager GPU time and resizes ScalableBufferManager between 0.5 and 1.0 in 0.1 steps — [Unity 6 Dynamic Resolution control](https://docs.unity.com/en-us/engine/6000.0/manual/cameras/resolution-scale/dynamic-resolution/control.md)
- The docs say to change "instantly or gradually over a set amount of frames", and to raise the scale only "when the GPU is performing consistently".

**Prior art**
- NVIDIA patent: compute a target scale from the average frame rate, then step the current scale toward it gradually — [US patent 20140184626](https://patents.justia.com/patent/20140184626)

### Inferences
- Recommended governor, synthesised from the UE and Unity patterns:
  - Metric: GPU time, from timer queries, at p90 over a window of about 30–60 frames. Use whole-frame time (CPU-bound check) to decide whether lowering GPU knobs can help at all, as with UE's CPUBoundScreenPercentage.
  - Budget: frame budget minus about 10–15% headroom.
  - Downscale: when p90 is over budget, step resolution down. Panic: after N (about 3–5) consecutive frames over budget, drop several steps at once and clear the history.
  - Upscale: only after a long stable window (several seconds) below about 70–80% of budget, one step at a time. This asymmetry is the hysteresis.
  - Cooldown: no change for about 0.5–2 s after each change, and no change below the minimum-change threshold.
  - Knob order:
    1. Resolution, down to about 0.5–0.7 of native.
    2. Volumetrics, DOF and post effects.
    3. Shadow cascades, then shadow map resolution, then shadow distance.
    4. LOD bias, screen-space error and draw distance.
    5. AO resolution, then AO off.
    6. A lower frame-rate cap as the last resort.

    Restore in reverse order. Discrete knobs change only on tier transitions with long cooldowns, because they can trigger shader or pipeline compiles and uploads.
- User override: any knob the user sets by hand is pinned and taken out of the governor's set, as Unity's per-Scaler "Enabled" flag does. Also offer a target-fps choice.

### Gaps
- No GPUOpen or NVIDIA developer article on DRS heuristics was retrieved; the search returned none.
- Default values for UE's HeadRoom, HistorySize and MinResolutionChangePeriod were not stated on the fetched page.
- No primary source was found for p90 vs p95 choices. Those percentiles are an inference here.

## 4. WebGL/Electron specifics: GPU timers, power preference, frame pacing, stutter

### Takeaway
EXT_disjoint_timer_query_webgl2 is available on about 87% of Windows reports and about 81% of Chrome reports, but almost nowhere on Firefox, Safari or mobile. A governor needs a fallback that uses rAF frame-time deltas. WebGPU timestamp queries are quantized to 100 µs in Chrome unless a developer flag is set. powerPreference "high-performance" must be requested explicitly: Chrome 80 changed the dual-GPU default to low-power. A GPU switch costs about 1 s of stutter. On Windows, the GPU is historically chosen by the OS or driver setting.

### Cited Findings
**GPU timer queries**
- EXT_disjoint_timer_query_webgl2 support, as a share of reports — [web3dsurvey](https://web3dsurvey.com/webgl2/extensions/EXT_disjoint_timer_query_webgl2)

  | Group | Support |
  |---|---|
  | Overall | 66.37% |
  | Windows | 86.77% |
  | macOS | 61.19% |
  | Linux | 46.25% |
  | ChromeOS | 99.05% |
  | Android | 0.67% |
  | iOS | 0.13% |
  | Edge | 94.29% |
  | Chrome | 81.3% |
  | Firefox | 0.07% |
  | Safari | 0.11% |

  No collection date is shown.
- How the extension works: it measures the duration of GL commands without stalling the pipeline. If GPU_DISJOINT_EXT is set, the results are unreliable and must be discarded. TIME_ELAPSED_EXT is in ns. In WebGL2, getQueryObject becomes getQueryParameter. It is not Baseline — [MDN EXT_disjoint_timer_query](https://developer.mozilla.org/en-US/docs/Web/API/EXT_disjoint_timer_query)
- WebGPU timestamp queries are quantized to 100 µs because of timing attacks. The "WebGPU Developer Features" flag (chrome://flags/#enable-webgpu-developer-features) disables quantization — [Chrome: New in WebGPU 121](https://developer.chrome.com/blog/new-in-webgpu-121)

**Power preference and dual GPUs**
- WebGL powerPreference takes "default", "high-performance" or "low-power". Related context options: desynchronized (lower-latency hint), failIfMajorPerformanceCaveat (refuse a software or slow GPU) — [MDN getContext](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/getContext)
- Chrome 80 changed the default powerPreference on dual-GPU machines from high-performance to low-power. Heavy apps must request high-performance, and switching GPUs causes about a 1 s stutter — [Khronos public_webgl, Dec 2019](https://www.khronos.org/webgl/public-mailing-list/public_webgl/1912/msg00001.php)
- On Windows (2019), Chrome/ANGLE used the first enumerated D3D adapter, which is the one set in the control panel. It could not pick a specific GPU — [Khronos public_webgl reply](https://www.khronos.org/webgl/public-mailing-list/public_webgl/1912/msg00003.php). This may be outdated.
- Chromium's GpuPreference enum is {kNone, kDefault, kLowPower, kHighPerformance} — [Chromium gpu_preference.h](https://chromium.googlesource.com/chromium/src/+/913eaefa55beab765aa1d99da170db474d8c63ca/ui/gl/gpu_preference.h)
- The internal switch was renamed to force_high_performance_gpu to match WebGL's naming — [Chromium commit](https://chromium.googlesource.com/chromium/src/ppapi/+/c0e58009e8e822b87bec7c989bbd9ea5dbf80c0f%5E%21/)
- `--force_high_performance_gpu` is used in Electron apps such as OpenAsar's presets, but it is unofficial — [OpenAsar cmdSwitches](https://gitdab.com/profxadke/OpenAsar/raw/commit/b8c64e2fe8bab16034e05daf3ec79b9b8e844ac9/src/cmdSwitches.js)

**Frame pacing**
- Cause of stutter: swapchains were built for throughput, not pacing. Apps that take their time step from gaps between renders or from acquire-fence timing get inconsistent steps, which show as stutter even when every vblank gets a new frame. VK_EXT_present_timing now offers timed presentation — [Khronos blog, VK_EXT_present_timing](https://www.khronos.org/blog/vk-ext-present-timing-the-journey-to-state-of-the-art-frame-pacing-in-vulkan) (taken from the search summary; the direct fetch failed)
- Android's Swappy adjusts the swap interval and pipeline mode from the average of recent frame durations. VK_EXT_present_timing arrives in Android 17 (API 37) — [Android Vulkan frame pacing extensions](https://developer.android.com/games/develop/vulkan/frame-pacing-extensions)

**Shader-compile stutter**
- UE 5.2+ PSO precaching finds possible PSOs at load time and compiles them behind the loading screen. Objects streamed in during play wait or use a default material. Global shader PSOs are precached at startup (r.PSOPrecache.GlobalShaders, on by default). The bundled PSO cache was best practice before 5.2 but has to be kept up to date — [Epic tech blog](https://www.unrealengine.com/en-US/tech-blog/game-engines-and-shader-stuttering-unreal-engines-solution-to-the-problem); [UE PSO Precaching docs](https://dev.epicgames.com/documentation/unreal-engine/pso-precaching-for-unreal-engine)

### Inferences
- In a WebGL2/Electron game on Windows, timer queries are usually available because ANGLE D3D11 is the Chrome default. The game should still check for the extension, handle the disjoint flag, read results 2–3 frames late, and fall back to rAF delta minus estimated CPU time when the extension is missing.
- Electron: pass powerPreference:"high-performance" to getContext. Optionally add app.commandLine.appendSwitch('force_high_performance_gpu'), which is unofficial. Never switch GPU in the middle of a session (about 1 s stall).
- Frame pacing in the browser: drive the simulation step from rAF's timestamp argument, smoothed or snapped to the measured refresh interval, not from performance.now() deltas. Avoid --disable-frame-rate-limit or disable-gpu-vsync in shipped builds, because they remove vsync pacing.
- Stutter avoidance, by analogy with PSO precaching:
  - Compile and warm every shader variant during loading (KHR_parallel_shader_compile in WebGL).
  - Spread texture and buffer uploads over frames with a per-frame byte budget.
  - Reuse typed arrays to avoid GC spikes.
  - Never let the governor flip shader-defining toggles during play without first precompiling the variants they need.

### Gaps
- No primary Chrome or Electron doc was found on `--disable-frame-rate-limit`, `--disable-gpu-vsync`, the ANGLE D3D11 vs Vulkan backend default (`--use-angle=d3d11|vulkan`), or how either affects rAF pacing on Windows. Those searches returned only forum posts.
- No Electron documentation on powerPreference was found. Whether current Chrome on Windows honours high-performance per context through DXGI GPU preference is not confirmed.
- No sourced GPU memory budgets for 4–8 GB cards or for shared-memory iGPUs were found, beyond UE's texture pool tiers of 200/400/700/1000 MB. WebGL exposes no VRAM query, so budgets have to be inferred from tier.
- No sourced numbers on JS GC pause lengths, or on web3dsurvey data for KHR_parallel_shader_compile, were retrieved.
