# City visuals: most quality per millisecond (WebGL2 / three.js r186, 2026)

Scope note: about 18 search and fetch calls. Primary sources were reached for Cities: Skylines II (a RenderDoc teardown), GTAO (the Activision paper and Intel XeGTAO), three.js docs (WebGLRenderer, GTAOPass, CSM), the r182 migration notes, Khronos PBR Neutral (model-viewer), interior mapping (van Dongen) and the SMAA project page. Several requested items (Anno 1800, Google Earth, MSFS night internals, clustered lighting in WebGL, SMAA/TAA ms numbers) had no reachable primary source in this pass; they are listed under Gaps rather than filled from memory.

## What do shipped city renderers (CS2, MSFS, interior-mapped games) actually spend their frame on?

### Takeaway
Measured on Cities: Skylines II, shadows dominate city frame cost: about 40 ms of an 88 ms frame and 72% of draw calls, because every object casts with no size or distance cutoff. AO (GTAO), SSR/SSGI and post together cost only about 6 ms. In a 200k-building city, the biggest quality-per-ms lever is limiting who casts shadows, not cutting post effects.

### Cited Findings
- CS2 (Unity HDRP, deferred) uses 4 shadow cascades of 2048x2048. The shadow resolution setting is not connected to code, so medium and high are identical. — [Paavo Huhtala, "Why Cities: Skylines 2 performs poorly"](https://blog.paavo.me/cities-skylines-2-performance/)
- CS2 per-pass timings in one night/rain frame (about 87.8 ms total, partly RenderDoc overhead):
  - Shadow mapping: about 40 ms
  - Main G-buffer pass: 16.7 ms
  - Depth/normal pre-pass: 8.2 ms
  - GTAO: 1.6 ms
  - SSR + SSGI: 3 ms
  - Deferred lighting: 2.1 ms
  - Post-processing: 1 to 2 ms total
  - Sky: 0.3 ms; skybox generation: 0.65 ms
  - Water: 1 ms; motion vectors: 0.6 ms

  — [Huhtala](https://blog.paavo.me/cities-skylines-2-performance/)
- CS2 frame size: 6,705 draw calls, of which 4,828 (72%) are shadow draws; 53,361 API calls; about 121M input vertices and 36M rasterized triangles summed across passes. Every 3D object is treated as a shadow caster regardless of size or distance. — [Huhtala](https://blog.paavo.me/cities-skylines-2-performance/)
- CS2 culls by frustum only, with no occlusion culling, and distance culling is "not very aggressive". Many props lack LODs, and a typical low-density residential building is under 10k vertices. — [Huhtala](https://blog.paavo.me/cities-skylines-2-performance/); corroborated by [Windows Central](https://www.windowscentral.com/gaming/cities-skylines-ii-runs-horribly-a-deep-dive-into-unity-explains-why)
- CS2 uses Unity's built-in TAA ("a bit broken", with slightly broken motion vectors). SSGI ray-marches at half resolution by default. — [Huhtala](https://blog.paavo.me/cities-skylines-2-performance/)
- The later developer (Iceflake) names LOD models as a remaining polygon problem. — [PCGamesN](https://www.pcgamesn.com/cities-skylines-2/performance-blog)
- MSFS night lights: a forum developer says they are generated procedurally on the client from streamed road and building data, not streamed as light data. This is unofficial and unverified. Users complain that skyscraper windows are too dim and too uniformly lit, and add-ons bake lights into textures. — [MSFS forums](https://forums.flightsimulator.com/t/night-lighting-terrain-emits-light/178647?page=7); [Just Flight Relight](https://justflight.com/product/relight-western-north-america)
- Interior mapping: van Dongen says a programmer told him SimCity (2013) used it, with all room textures in one atlas and rooms of varying depth. He thinks Marvel's Spider-Man "very likely" uses it, but this is unconfirmed by Insomniac. UE4 ships an InteriorCubeMap material function. — [van Dongen, Game Developer](https://gamedeveloper.com/programming/interior-mapping-rendering-real-rooms-without-geometry)

### Inferences
- Our tiers already put a 2048 shadow map on high and ultra. The CS2 data says the shadow caster set (draws and vertices) costs far more than map resolution. Small or distant buildings should be excluded from casting, and static cascades should be cached and re-rendered only when the sun moves or the tile changes. Shadow `autoUpdate=false` plus `needsUpdate` is the three.js hook for this; see the next section.
- CS2 pays 1.6 ms for GTAO and 1 to 2 ms for all post. That suggests AO plus a cheap AA plus tonemapping fits in about 3 ms on a mid GPU, provided geometry and shadows are under control.

### Gaps
- No primary rendering breakdown was found for Anno 1800 or Google Earth (web), nor an official MSFS description of its city night lighting.
- No Digital Foundry ms figures were found for these titles in this pass.

## three.js r186 specifics: MSAA, GTAOPass, SMAA, shadow types, CSM, tone mapping, parallel compile

### Takeaway
three.js gives every needed building block:
- `WebGLRenderTarget.samples` for MSAA in post
- `GTAOPass` with width/height that can be set to half resolution, plus a Poisson denoise
- `PCFShadowMap`, which became soft in r182; `PCFSoftShadowMap` is deprecated
- the `CSM` addon, with a default 3 cascades at 2048
- `AgX` and `Neutral` tone mapping
- `compileAsync`, which uses `KHR_parallel_shader_compile`

The docs publish no ms costs for any of these.

### Cited Findings
- `WebGLRenderer` options:
  - `antialias` (default false) turns on default-framebuffer MSAA.
  - `capabilities.maxSamples` reports the MSAA limit.
  - `outputBufferType` defaults to `UnsignedByteType`; the docs say "Use `HalfFloatType` for HDR rendering with tone mapping and post-processing support".
  - `shadowMap.type` accepts Basic, PCF (default) or VSM.
  - `shadowMap.autoUpdate` defaults to true; `shadowMap.needsUpdate` forces a one-off update.

  — [three.js docs: WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- Tone mapping options are NoToneMapping (default), Linear, Reinhard, Cineon, ACESFilmic, Custom, AgX and Neutral. — [three.js docs: WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- `compileAsync(scene, camera, targetScene)` "makes use of the KHR_parallel_shader_compile WebGL extension". It resolves when the scene renders without compile stalls, and lighting and environment must be set before calling it. — [three.js docs: WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- r182 migration: "PCFSoftShadowMap with WebGLRenderer is now deprecated. Use PCFShadowMap which is now soft as well." The new PCF uses Vogel-disk sampling with interleaved gradient noise. Some users reported pixelation or point-light regressions after switching. — [three.js forum, r182 shadow pixelation](https://discourse.threejs.org/t/shadow-pixelation-issue-in-three-js-0-182-0/88746); [forum, r182 point light shadows](https://discourse.threejs.org/t/upgrading-to-r182-incorrect-point-light-shadows/88891)
- `GTAOPass(scene, camera, width=512, height=512, parameters, aoParameters, pdParameters)`:
  - The docs call it "better quality than SSAOPass but also more expensive".
  - It has a Poisson denoise with `pdRings=2`, `pdSamples=16` and `pdRadiusExponent=2`.
  - `setGBuffer(depthTexture, normalTexture)` reuses an existing depth/normal buffer. Without it, the pass renders its own depth/normal target, which means an extra scene pass.
  - `setSceneClipBox(box)` limits where AO is computed.
  - The docs do not say it renders at half resolution; width and height are caller-set.

  — [three.js docs: GTAOPass](https://threejs.org/docs/pages/GTAOPass.html)
- `CSM` addon (WebGL only; WebGPU uses `CSMShadowNode`):
  - Defaults: cascades=3, maxFar=100000, mode='practical' (also uniform, logarithmic or custom with `customSplitsCallback`), shadowMapSize=2048, lightMargin=200, lightFar=2000. `fade` defaults to false.
  - Each receiving material needs `csm.setupMaterial(material)`.
  - Call `csm.update()` every frame and `updateFrustums()` when the camera changes.

  — [three.js docs: CSM](https://threejs.org/docs/pages/CSM.html)
- MSAA in post:
  - Mugen87's PR replaced `WebGLMultisampleRenderTarget` with `WebGLRenderTarget.samples` (default 0, WebGL2 only).
  - Setting `samples` on composer targets works with bloom and colour passes, but "might break some types of post passes".
  - MRT multisampling was added in r141.

  — [three.js forum: performance of AA techniques](https://discourse.threejs.org/t/performance-of-different-antialiasing-techniques/56740); [three.js forum: MRT supports antialiasing](https://discourse.threejs.org/t/mrt-supports-antialiasing/33215)
- Recommended MSAA layout: render the scene once into a single multisampled target, resolve right away with the equivalent of `glBlitFramebuffer`, then run all later post passes on single-sample targets. This saves memory and needs only one MSAA target. 4x was reported to look poor relative to 8x in one user's scene. — [Khronos community forum](https://community.khronos.org/t/multisample-render-buffer-for-post-processing-in-a-webgl2-context/105400)
- Subjective three.js user ranking, slowest to fastest: SSAA, TAA, SMAA, multisample render target, FXAA. FXAA was called "pretty rough lookin" and TAA "looks much better but is pretty taxing". No numbers were given. — [three.js forum](https://discourse.threejs.org/t/performance-of-different-antialiasing-techniques/56740)

### Inferences
- With msaa 0 on every tier today, the cheapest real quality jump is likely `samples: 4` on the one HDR scene target, resolved before post. Building edges and roof lines are geometric aliasing that MSAA fixes and FXAA only blurs. The cost scales with the scene pass's fill and bandwidth, so it should be measured once on the RTX 3060.
- If AO is enabled, feed `GTAOPass.setGBuffer` from an existing depth/normal (MRT or depth-prepass) so the 200k-building scene is not rasterized again. Run the pass at half width and height. Without `setGBuffer` the pass re-renders the scene, which is likely where most of its cost goes in a draw-heavy city.

### Gaps
- No published ms costs were found for three.js `GTAOPass`, `SMAAPass`, `FXAAPass`, `TAARenderPass` or CSM at 1080p on an RTX 3060 or an iGPU. The local three.js examples should be measured once.
- The SMAA project page contains no timing table. The paper's numbers were not retrieved here, so they are not quoted.

## AO: GTAO full vs half resolution, bent normals, alternatives

### Takeaway
GTAO's reference design runs at half resolution, costing 0.5 ms on PS4 at 1080p with temporal accumulation. At full resolution, Intel's XeGTAO costs about 0.56 ms on an RTX 2060 and about 2.4 ms on an Iris Xe iGPU at 1080p. Bent normals add about 25%.

### Cited Findings
- The GTAO paper reports a match to ray-traced ground truth "in just 0.5 ms on a PS4 at 1080p", using a half-resolution occlusion buffer and spatio-temporal filtering. — [Jimenez et al., Activision ATVI-TR-16-01](https://research.activision.com/publications/archives/atvi-tr-16-01practical-realtime-strategies-for-accurate-indirect-occlusion); [revised PDF](https://www.activision.com/cdn/research/Practical_Real_Time_Strategies_for_Accurate_Indirect_Occlusion_NEW%20VERSION_COLOR.pdf)
- XeGTAO full-resolution High preset:
  - RTX 2060 at 1080p: about 0.56 ms
  - RTX 3070 at 4K: about 1.4 ms
  - i7-1195G7 iGPU at 1080p: about 2.39 ms
  - GTX 1050 at 1080p: 1.5 ms (Medium) and 2.2 ms (High)
  - For comparison, ASSAO Medium on the RTX 2060 costs about 0.72 ms.

  — [XeGTAO (Intel GameTechDev)](https://github.com/GameTechDev/XeGTAO)
- XeGTAO cost scaling and sampling:
  - Medium costs about two-thirds of High, and Low about two-thirds of Medium.
  - Original GTAO uses half resolution with 1 slice and 12 samples. XeGTAO uses full resolution with 3 slices x 6 samples, and 2x4 on its low preset.
  - Suggested speedups are fewer slices, or half-resolution or checkerboard rendering with a bilateral upsample.
  - Bent normals add about 25% cost and noticeably improve contact shadowing for unshadowed lights.
  - The fp16 path is 5 to 20% faster.
  - Its 5x5 depth-aware denoiser is spatial only; temporal accumulation is left to TAA.
  - The project is discontinued.

  — [XeGTAO](https://github.com/GameTechDev/XeGTAO)
- CS2 GTAO in a heavy frame: 1.6 ms. — [Huhtala](https://blog.paavo.me/cities-skylines-2-performance/)

### Inferences
- Applying XeGTAO scaling to an RTX 3060, which is faster than a 2060, half-resolution GTAO at 1080p should cost well under 0.5 ms for the AO math, provided depth and normals are reused. This is an estimate, not a measurement.
- For a city at map height, where screen-space AO radius is useless at a distance, baked per-vertex or per-building AO is nearly free at runtime: ground contact darkening, a vertical gradient on facades, and street-canyon darkening. Screen-space GTAO can then be limited to street level with a distance fade. No source above measures this directly.
- On iGPUs, full-resolution GTAO (about 2.4 ms) is too expensive for a 16.6 ms budget alongside the city. It should stay off, or run at half resolution and low preset.

### Gaps
- No numbers were found for three.js GTAOPass specifically. Its Poisson denoise with 16 samples x 2 rings is likely heavier than XeGTAO's 5x5 filter, but this is unmeasured.

## Facade detail, night lighting and windows

### Takeaway
Interior mapping is a cheap per-pixel trick: a ray intersects 3 of 6 room planes, then does one texture lookup into an atlas. It suits the lit-window night look of a city. Tested by shipped games, procedural "percentage of lit windows" with time-of-day randomization is the standard way to make skylines read at night.

### Cited Findings
- Interior mapping:
  - The view ray is intersected analytically with ceiling, floor and walls; only 3 planes are needed, chosen by view direction.
  - The nearest hit's UV samples a room texture, randomly chosen from an atlas in the paper.
  - No interior geometry is needed.
  - Limits: furniture looks flat, rooms are inconsistent across corners, and extra depth layers cost more.

  — [van Dongen via Game Developer](https://gamedeveloper.com/programming/interior-mapping-rendering-real-rooms-without-geometry); [UDK Interior Mapping gem](https://docs.unrealengine.com/udk/Three/DevelopmentKitGemsInteriorMapping.html)
- Commercial UE5 interior-cubemap systems expose:
  - lit-room percentage
  - randomized light-on times in the morning and after sunset
  - a fraction of rooms left on overnight
  - a single global parameter collection driving a whole skyline instead of per-building material instances
  - one opaque material, avoiding translucency sorting

  These are vendor claims. — [Fab listing: Interior Cubemap System](https://www.fab.com/listings/428d45ff-e4e8-456a-84f4-ab7009b9dc7c)
- MSFS users call uniformly lit, dim skyscraper windows the main night-quality failure and ask for randomized lit windows. — [MSFS forums](https://forums.flightsimulator.com/t/night-lighting-issues-still-present-the-community-solutions/310086?page=44)

### Inferences
- For 200k buildings, a window grid computed in the facade shader is very cheap: a fract() of facade UV per floor and bay, plus a hash per window for on/off and colour temperature. Gating interior mapping to near LODs only adds one ray-plane solve and one atlas fetch per pixel. Emissive output then feeds bloom, so no per-window lights are needed.
- For street lights, "baked emissive + light cookie/decal on the ground" is fill-cost only and scales to thousands of lamps. Forward+/clustered lighting needs per-tile light lists, which three.js WebGLRenderer does not ship (it loops over all lights per fragment). This is an inference from the three.js light API; no source was fetched confirming clustered support status in r186.

### Gaps
- No ms measurements of interior mapping were found.
- No primary source was found for clustered/forward+ in three.js WebGL, or for how CS2 or Anno render street lights.

## Tonemapping and colour grading

### Takeaway
three.js has AgX, ACESFilmic and Neutral (Khronos PBR Neutral) as single-pass, essentially free operators. Neutral keeps base colours 1:1 below a threshold and preserves hue, while ACES (and, per the same source, AgX) lose saturation.

### Cited Findings
- PBR Neutral:
  - Colours map 1:1 up to about sRGB 231.
  - It scales by a single multiplier, so hue is preserved, and highlights desaturate gradually to white.
  - It was designed for commerce; film and games were not the target.
  - It shipped in three.js and Filament in March 2024.
- ACES compresses shadows and highlights, cannot output canary yellow or bright greens and blues, and pushes bright colours to white. AgX is reported with the same saturation loss.

  — [model-viewer tone mapping (Khronos PBR Neutral author)](https://modelviewer.dev/examples/tone-mapping)
- three.js supports `AgXToneMapping` and `NeutralToneMapping`, and recommends a HalfFloat output buffer for HDR plus post. — [three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)

### Inferences
- For a night city with strong emissive windows and bloom, AgX's graceful highlight desaturation avoids the hue skews of clamped emissives. Neutral keeps daytime albedo colours faithful. Either costs effectively nothing per pixel; the choice is aesthetic.

### Gaps
- No Blender AgX docs or CS2 grading details were fetched in this pass.

## Shadows, atmosphere, AA choice and post-chain ordering

### Takeaway
The evidence favours a specific shadow setup and AA choice:
- 3 to 4 cascades at 2048 are the norm (CS2 uses 4x2048; the three.js CSM default is 3x2048).
- The real cost is caster draws, which is the case for distance/size caster culling and cached (non-autoUpdate) far cascades.
- For AA, MSAA resolved once before post is the quality choice for geometric city edges.
- TAA risks ghosting on moving cars, and CS2's TAA motion vectors were broken.

### Cited Findings
- CS2: 4x2048 cascades; shadows about 40 ms and 72% of draws without caster culling. — [Huhtala](https://blog.paavo.me/cities-skylines-2-performance/)
- three.js `shadowMap.autoUpdate` / `needsUpdate` allow static shadow caching. — [three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- CSM `mode: 'custom'` with `customSplitsCallback` allows splits tuned for a high, top-down camera; `fade` blends cascades. — [three.js CSM](https://threejs.org/docs/pages/CSM.html)
- TAA in CS2 was "a bit broken" due to motion vectors, which illustrates that TAA needs correct per-object velocity (moving cars) to avoid ghosting. — [Huhtala](https://blog.paavo.me/cities-skylines-2-performance/)
- TAA is estimated at a 3 to 7% FPS cost and looks soft at 1080p; FXAA at roughly 1 to 2 ms on older GPUs. These are low-quality secondary sources. — [Faceofit](https://www.faceofit.com/compare-fxaa-taa-dlaa-and-gpu-performance/); [box.co.uk](https://box.co.uk/blog/fxaa-vs-taa-vs-msaa-vs-dlaa)

### Inferences
- Suggested post order on a HalfFloat target:
  1. MSAA scene pass
  2. Resolve
  3. Half-resolution GTAO, reusing depth/normal
  4. Height fog / aerial perspective, analytic and computed from depth
  5. Bloom on emissive
  6. Tonemap and colour grade, in one pass
  7. Optional SMAA or FXAA only when MSAA is off

  This keeps the chain at about 3 or 4 full-screen passes, consistent with CS2's 1 to 2 ms post total.
- Height fog and aerial perspective can be computed analytically (exponential height fog from depth). Folding them into the tonemap/composite pass or the material shader avoids an extra pass.

### Gaps
- No sourced ms numbers were found for contact shadows, VSM vs PCF in three.js, aerial perspective (Hillaire/UE), or SMAA at 1080p on an RTX 3060 or an iGPU.
- The Spider-Man and Assassin's Creed GDC city-rendering talks were not retrieved.
