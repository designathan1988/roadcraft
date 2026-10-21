# Rendering hundreds of thousands of detailed buildings in real time on WebGL2 (three.js r186), 2026

Scope: techniques, measured costs, how large map/globe engines do it, and what is feasible on WebGL2. The WebGPU migration is paused. Research done 2026-10-21 with about 20 web searches and fetches. Many "numbers" in this field come from forums or vendor rules of thumb, and each one below says which kind it is.

## Q1. How do Cesium / Google Photorealistic tiles, Mapbox/MapLibre, deck.gl, ArcGIS JS, OSM Buildings and three.js projects render massive cities? (LOD by screen-space error, memory budgets, caches)

### Takeaway
Every large web engine uses the same design. A spatial hierarchy (HLOD tree, 3D Tiles or I3S) holds merged per-tile proxies. Each node is refined only while its projected geometric error exceeds a pixel threshold (16 px in Cesium). GPU memory is capped by an LRU byte budget, and the budget lowers LOD automatically when it fills up. Map engines (MapLibre/Mapbox, deck.gl) avoid detailed geometry entirely: they extrude footprints from vector tiles, starting at zoom ~15, in very few draws per tile.

### Cited Findings
- CesiumJS `Cesium3DTileset.maximumScreenSpaceError` defaults to **16**. A tile whose screen-space error exceeds it refines to its children, and "higher values provide better performance but lower visual quality" — [Cesium3DTileset docs](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)
- CesiumJS `cacheBytes` defaults to **536,870,912 (512 MiB) of GPU memory** for cached tiles, and tiles out of view are evicted. `maximumCacheOverflowBytes` (also 512 MiB) lets usage exceed the budget when the requested SSE needs more — [Cesium3DTileset docs](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)
- Other Cesium defaults: `dynamicScreenSpaceError` = true (loads lower-res tiles far from the camera in street-level horizon views, "with a slight drop in distant detail"), `foveatedScreenSpaceError` = true (center of screen first), `cullRequestsWhileMoving` = true, `cullWithChildrenBounds` = true, `skipLevelOfDetail` = false (skipping reduces memory) — [Cesium3DTileset docs](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)
- A community thread reports that an SSE of 2.0 uses "at least 64 times more memory" than the default 16. This is a forum statement, not official docs — [Cesium community](https://community.cesium.com/t/3d-tiles-d3dm-not-shown/39356)
- Cesium staff: `cacheBytes` caps only GPU memory and "won't limit the cache on the CPU". JS heap growth was reported with Google Photorealistic tiles — [Cesium community](https://community.cesium.com/t/googlephotorealistic3dtileset-possibly-leaking-memory/31246)
- Cesium OSM Buildings covers **>350 million buildings**, with about **3 million tiles** and hundreds of GB, streamed on demand as 3D Tiles. It uses a **loose quadtree** so that buildings on tile edges are not split — [Cesium blog](https://cesium.com/blog/2020/06/01/cesium-osm-buildings/); [Cesium community announcement](https://community.cesium.com/t/announcing-cesium-osm-buildings/9757)
- three.js 3DTilesRendererJS (NASA-AMMOS) uses `errorTarget` (target SSE in pixels) and `errorThreshold` (`errorTarget*errorThreshold` decides whether parent tiles load or render). An `lruCache` byte budget must be set before the first `update()`. It includes a Google Photorealistic Tiles example — [3DTilesRendererJS GitHub](https://github.com/NASA-AMMOS/3DTilesRendererJS)
- A user report says the 3DTilesRendererJS LRU correctly evicts GPU geometry and textures by byte budget, but the JS-side tile tree keeps growing, reaching about 1 GB of heap with "millions of arrays", and there is no public pruning API — [three.js forum](https://discourse.threejs.org/t/3d-tiles-renderer-memory-problem/90078)
- ArcGIS JS SceneView: the memory budget depends on `qualityProfile`, **up to 750 MB for medium and 1500 MB for high**. The view's `quality` (0–1) drops automatically when layers need more memory, which lowers scene-layer LOD, terrain resolution and feature counts — [ArcGIS sceneview-memory sample](https://developers.arcgis.com/javascript/latest/sample-code/sceneview-memory)
- ArcGIS 3D object scene layers (I3S) are a hierarchical tree that loads "only visible data at the resolution necessary for the current view". Visibility tests switched from bounding spheres to **oriented bounding boxes**, so the client stores and renders less data with the same image — [Esri blog, scene layer performance pt 2](https://www.esri.com/arcgis-blog/products/js-api-arcgis/3d-gis/scene-layer-performance-in-arcgis-online-part-2)
- MapLibre/Mapbox 3D buildings are `fill-extrusion` layers built from vector-tile footprints plus `render_height`, usually with **minzoom 15** and height interpolated from 0 at z15 to full height at z16 (Mapbox ramps over z15–15.05) — [MapLibre 3D buildings example](https://maplibre.org/maplibre-gl-js/docs/examples/3d-buildings/); [Mapbox example](https://docs.mapbox.com/mapbox-gl-js/example/3d-buildings.md)
- Stadia describes fill-extrusion as "not as detailed as a 3D model, but it's fast" — [Stadia Maps tutorial](https://docs.stadiamaps.com/tutorials/adding-3d-buildings-to-your-maps-with-maplibre/)
- deck.gl's MVTLayer extends TileLayer and can parse tiles into binary feature collections. Extruded buildings use SolidPolygonLayer, which is optimized for large polygon datasets (this came from a third-party mirror of the docs) — [MapTiler deck.gl MVT extrude](https://docs.maptiler.com/deck-gl/mvt-extrude); [deck.gl SolidPolygonLayer](https://deck.gl/docs/api-reference/layers/solid-polygon-layer)

### Inferences
- For roadcraft, the transferable pattern is: a quadtree or loose quadtree of city cells; per cell, several merged LOD proxies; select by projected error (pixels) against a fixed threshold of about 8–16 px; and an LRU byte budget for GPU buffers, with a separate cap for CPU metadata (both Cesium and 3DTilesRenderer show that a GPU-only cap leaks on the CPU side).
- A budget of ~512 MB to 1.5 GB of GPU memory is the operating range used by Cesium and ArcGIS on desktop. Lower-end or integrated profiles should use the low end of that range.

### Gaps
- I found no public technical description of Google Earth web's renderer internals or of the internal tile budgets for Google Photorealistic Tiles.
- I found no published fps or ms benchmarks for MapLibre fill-extrusion or deck.gl at city scale.

## Q2. Which techniques keep building detail out to ~1.4 km at acceptable cost, and how far can facade detail move into shaders?

### Takeaway
On WebGL2 the feasible stack is as follows. Near range uses real geometry, merged per cell into BatchedMesh or InstancedMesh, with simplified LODs from meshoptimizer `simplify`. Mid range uses merged HLOD proxies (meshopt `simplify`, or `simplifySloppy` for unwelded or non-manifold building soups). Far range uses impostors (octahedral or multi-view billboards) or very coarse proxies. Windows, floors and interiors move into shaders (window grids plus interior mapping) instead of triangles. Nanite-style cluster DAGs need compute, indirect draws and atomics, which WebGL2 lacks, so on WebGL2 they shrink to CPU-selected cluster-group LODs.

### Cited Findings
**Instancing / BatchedMesh / multi-draw**
- three.js `BatchedMesh` renders many objects with the same material but different geometry and transforms, to cut draw calls. Without `WEBGL_multi_draw` it falls back to a "less performant" path — [three.js BatchedMesh docs](https://neofixer.arizona.edu/css/CSSOrbit/asteroidJS/three/docs/api/en/objects/BatchedMesh.html); [three.js forum: InstancedMesh vs BatchedMesh](https://discourse.threejs.org/t/how-to-choose-between-instancedmesh-and-batchedmesh/81221)
- A three.js maintainer noted a multi-draw performance bottleneck in WebGL (linked to an open Chromium issue). One forum commenter says multiDraw performs worse than instancing above ~100k instances but is best for many distinct geometries. Both are anecdotal — [three.js forum: InstancedMesh vs BatchedMesh](https://discourse.threejs.org/t/how-to-choose-between-instancedmesh-and-batchedmesh/81221); [three.js forum: _multiDrawInstances](https://discourse.threejs.org/t/why-did-the-performance-worsen-significantly-when-i-used-multidrawinstances-in-batchedmesh/78581)
- A user reports **1 million instanced cubes at 120 fps** with the GPU at 100% (hardware not stated) — [three.js forum](https://discourse.threejs.org/t/rendering-thousands-of-objects-results-in-low-fps-but-also-low-gpu-usage/40142)
- Merging shared-material meshes cut one scene from ~1,600 to 27 draw calls. The trade-off is losing per-object frustum culling, and the fix is chunking — [three.js forum](https://discourse.threejs.org/t/rendering-thousands-of-objects-results-in-low-fps-but-also-low-gpu-usage/40142)

**Simplification, clusters, Nanite-like**
- `meshopt_simplify` follows topology and preserves attribute seams and borders. `meshopt_simplifySloppy` ignores topology, so it can merge spatially close but disconnected parts and collapse small details, at worse quality. "Permissive" mode gives "dramatically higher quality" than sloppy — [meshoptimizer README](https://github.com/zeux/meshoptimizer)
- IfcOpenShell switched to simplifySloppy because building (BIM brep) output is unwelded per-triangle and non-manifold. Sloppy suits disconnected building parts (anecdotal, from a mirror) — [IfcOpenShell commit mirror](https://dev.glassvision.dedyn.io/Glassvision/IfcOpenShell/commit/c78e16eafbf13d3d5f88c53005a5d92b69c32657)
- Meshlet limits: NVIDIA recommends 64 vertices / 126 triangles, and the README suggests 64/96 as more realistic. The spatial (RT) builder uses 64 vertices and 16–64 triangles — [meshoptimizer README](https://github.com/zeux/meshoptimizer)
- meshoptimizer v1.0 ships `clusterlod.h`, Nanite-like continuous LOD: split into clusters, group neighboring clusters, simplify each group while locking group borders. A cluster is replaced by a coarser one only if the error stays under **1 pixel**. Clusters hold up to 128 triangles. A 1.64B-triangle scene (18.9B instanced) is processed in about 2.5–3 min on 16 threads, and renders at **16 ms raster / 26 ms RT on an RTX 3050** (Vulkan with mesh shaders, not WebGL) — [zeux.io, Billions of triangles in minutes](https://zeux.io/2025/09/30/billions-of-triangles-in-minutes/)
- nanite-webgpu (Scthe) supports a meshlet LOD DAG built in-browser with meshoptimizer and METIS WASM, per-instance and per-meshlet frustum and occlusion culling against the previous frame's depth pyramid, a software rasterizer (~98% of triangles in the 1.7B-triangle scene), and billboard impostors (12 views around the up axis). Examples: Lucy 100k tris → 86 tris at the root; bunny 5k → 96. Limits: Chrome-only WebGPU, no 64-bit atomics (depth packed to u16), a 128 MB storage-buffer limit in Chrome, no streaming. It publishes no fps numbers — [nanite-webgpu GitHub](https://github.com/Scthe/nanite-webgpu)
- Assassin's Creed Unity's GPU-driven pipeline (SIGGRAPH 2015) handled ~10× the instances of earlier games because CPU was the scarcest resource. Reported: 20–40% of triangles culled (backface plus cluster bounds), ~10% overall geometry gain, and 30–80% of shadow triangles culled — [Haar & Aaltonen slides](https://advances.realtimerendering.com/s2015/aaltonenhaar_siggraph2015_combined_final_footer_220dpi.pdf); [DSOGaming summary](https://www.dsogaming.com/?p=80038)

**Impostors**
- A three.js octahedral impostor library (agargaro/octahedral-impostor) demo: 200k trees on a 3072² terrain. LOD0 is the mesh, meshopt LOD covers 15–100 units, and the octahedral impostor covers 100+ units. The author reports that it works on mobile. Known issues: interpolation seams, and cross-fades draw two LODs — [three.js forum, forest of octahedral impostors](https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735); [three.js forum, octahedral impostors](https://discourse.threejs.org/t/octahedral-impostors-for-three-js/80318)
- Unity docs say impostors suit "static objects ... seen from multiple viewpoints at a distance such as trees, buildings" — [Unity Pixyz impostors](https://docs.unity3d.com/Packages/com.unity.pixyz.unity-sdk@2.0/manual/features/impostors.html)
- A three.js impostor gotcha: instanced unit-quad geometry needs an explicit bounding sphere, or the whole set gets frustum-culled — [Cinevva open-world browser pt 19](https://app.cinevva.com/blog/2026-05-04-open-world-browser-part-19-imposters)

**Procedural facades / interior mapping**
- Interior mapping (van Dongen, CGI 2008) intersects the view ray with virtual room planes in the pixel shader, so the building "contains no extra geometry whatsoever". The original uses world-space uniform room spacing. It was later used in SimCity, Assassin's Creed and Overwatch — [80.lv](https://80.lv/articles/interior-mapping-rendering-real-rooms-without-geometry); [Alan Zucconi](https://www.alanzucconi.com/?p=10105); [UDK Gems: Interior Mapping](https://docs.unrealengine.com/udk/Three/DevelopmentKitGemsInteriorMapping.html)
- Disney/Pixar extended it ("Visualizing building interiors using virtual windows", 2014) — [80.lv](https://80.lv/articles/interior-mapping-rendering-real-rooms-without-geometry)
- Procedural window lighting for city scenes is patented (US10380790B2, "procedural window lighting effects"). Check before copying that exact method — [Google Patents](https://patents.google.com/patent/US10380790)

**Vertex compression**
- meshopt codecs decode at 3–6 GB/s on desktop CPUs. Vertex data compresses 2–4× over already-quantized data, and indices reach about 1–1.2 bytes per triangle. Quantization guidance: positions as 16-bit normalized ints relative to the AABB (or half floats), normals as 3×8-bit or octahedral, UVs as 12–16-bit ints. gltfpack supports EXT/KHR_meshopt_compression — [meshoptimizer README](https://github.com/zeux/meshoptimizer)

**Occlusion culling**
- Masked Software Occlusion Culling (Intel, HPG 2016) uses **~4 ms on one CPU thread** for a ~7M-triangle Minecraft-style scene with all geometry sent through. It is 3× faster than prior work and culls 98% of what a full-resolution depth buffer would. Intel warns the library's numbers may differ from the paper's — [Intel MOC page](https://intel.com/content/www/us/en/developer/articles/technical/masked-software-occlusion-culling.html); [HPG 2016 paper](https://diglib.eg.org/bitstream/handle/10.2312/hpg20161189/023-031.pdf)
- WebGL2 async readback (usable for Hi-Z or depth readback with a frame of latency): `readPixels` into a PIXEL_PACK buffer, then `fenceSync`, flush, poll the fence, and only then `getBufferSubData`. Use a ring of buffers for pipelining. Firefox warns when a read skips the fence, because that stalls the pipeline — [Khronos public_webgl list](https://www.khronos.org/webgl/public-mailing-list/public_webgl/1712/msg00011.php); [Firefox nonblocking benchmark](https://searchfox.org/firefox-main/source/dom/canvas/test/webgl-conf/checkout/extra/getbuffersubdata-nonblocking-benchmark.html); [Mozilla bug 1425488](https://reviewboard.mozilla.org/r/207796/diff/)

**Shadows**
- Insomniac (SIGGRAPH 2012) caches a shadow map of static geometry (static meaning unmoved for ~5 s), renders only dynamic objects onto a copy each frame, and scrolls the cache with the camera, rendering only newly exposed edges — [Acton CSM Scrolling](https://advances.realtimerendering.com/s2012/insomniac/Acton-CSM_Scrolling(Siggraph2012).pdf)
- Cyberpunk 2077 uses up to 4 per-frame cascades for nearby and dynamic objects, plus 4 "distant shadow" levels refreshed periodically and spread across frames — [SIGGRAPH 2021 Dybisz talk](https://history.siggraph.org/wp-content/uploads/2022/06/2021-Talks-Dybisz_Shadows-Optimizations-in-Cyberpunk-2077.pdf)
- Unity HDRP can update a single cascade on request. Flax caches static-geometry shadows with a separate update rate at distance — [Unity Graphics PR 1559](https://github.com/Unity-Technologies/Graphics/pull/1559); [Flax commit](https://git.flaxengine.com/Flax/FlaxEngine/commit/890b2da1089df6cbf11bf28a10d840b81bfd0f79)
- Cached cascades are only stable if the cascade fit is stable. Fitting that follows camera rotation causes static shadows to drift, so anchor the fit at the camera eye — [GitLab issue](https://gitlab.com/mass4org/mega4/turian/-/issues/171)

### Inferences
- To reach ~1.4 km with detail: ~0–300 m uses full meshes (BatchedMesh per cell); ~300–800 m uses meshopt-simplified per-cell merged proxies with shader facades (window grid plus interior mapping only on near LODs); ~800–1,400 m uses coarse HLOD boxes or roofs with facade shaders, or impostors. The distance bands are my estimate and should be derived from a pixel-error threshold rather than fixed meters. Shader facades keep the window detail at constant triangle cost, so the triangle budget scales with building count, not with facade complexity.
- On WebGL2 the Nanite path reduces to CPU-side cluster-group LOD selection from a meshopt DAG plus multi-draw of the selected ranges. Software rasterization, GPU culling via compute, and indirect draws are not available. Transform feedback or fragment-shader tricks can emulate some GPU culling, but I found no sources measuring that on WebGL2.
- For a 2.5D city, a CPU occlusion buffer (MOC-style, small resolution, run in a worker) or a 1-frame-latency Hi-Z readback via PBO+fence are the realistic WebGL2 occlusion options.

### Gaps
- I found no source that measured octahedral impostors specifically for buildings, or that gives atlas resolution per building.
- I found no published measurement of interior-mapping cost in ms. It is one ray–box intersection plus a texture fetch per pixel, so it is plausibly cheap, but unverified.
- I found no WebGL2-specific benchmark for Hi-Z readback latency or MOC in WASM.
- I did not find KTX2/Basis texture-array numbers in the sources fetched.

## Q3. Concrete numbers: triangle and draw budgets per frame on mid GPUs (RTX 3060) and integrated GPUs (Intel UHD 770), costs in ms; draw call budgets in ANGLE/D3D11

### Takeaway
I found no reliable published measurement of per-draw cost for WebGL through ANGLE/D3D11, and no triangle-per-frame budgets for RTX 3060 or UHD 770 in WebGL. The available numbers are rules of thumb (keep draws in the low hundreds) and native measurements (ANGLE ~27 ns per draw on its Vulkan backend, excluding browser validation). Budgets must be measured on the target hardware.

### Cited Findings
- ANGLE ships a `DrawCallPerf` benchmark with a D3D11 variant and a validation-only mode — [ANGLE DrawCallPerf.cpp](https://chromium.googlesource.com/angle/angle/+/HEAD/src/tests/perf_tests/DrawCallPerf.cpp); [ANGLE perf tests README](https://android.googlesource.com/platform/external/angle/+/cb9a86a9d8/src/tests/perf_tests/README.md)
- The only per-draw figure found was ~27–28 ns per draw in native ANGLE (Vulkan backend, one developer machine). That excludes Chrome's WebGL validation and the GPU-process IPC, so it is not a browser number (search-result summary of an ANGLE commit, not verified in full) — [ANGLE perf tests](https://chromium.googlesource.com/angle/angle/+/HEAD/src/tests/perf_tests/DrawCallPerf.cpp)
- Rule-of-thumb draw budgets: 200–500 draws on mobile WebGL (unsourced guide) — [abratabia](https://abratabia.com/mobile-browser-performance/reducing-draw-calls.php). Under 500 per frame, ideally under 100 (vendor blog) — [MetaDesign](https://metadesignsolutions.com/blog/threejs-performance-optimization-best-practices)
- RTX 3050 (native Vulkan, cluster LOD, 1.64B-triangle scene): 16 ms raster — [zeux.io](https://zeux.io/2025/09/30/billions-of-triangles-in-minutes/)
- MOC: ~4 ms on one CPU thread for ~7M triangles (2016 hardware) — [MOC paper](https://diglib.eg.org/bitstream/handle/10.2312/hpg20161189/023-031.pdf)
- 1M instanced cubes (~12M triangles) at 120 fps on an unspecified GPU, in three.js — [three.js forum](https://discourse.threejs.org/t/rendering-thousands-of-objects-results-in-low-fps-but-also-low-gpu-usage/40142)

### Inferences
- In WebGL on Windows, draw-call cost is dominated by Chrome's validation and command-buffer IPC to the GPU process, which is far above the native ~27 ns. That is why BatchedMesh/multi-draw, merging per cell and instancing are the primary levers. A practical target is about 100–500 draws per pass, with shadows counted separately.
- Use the project's own headless Chrome/Playwright measurement (per the project memory) on RTX 3060 and UHD 770 to set triangle budgets. Do not use web numbers for this.

### Gaps
- No sourced per-draw ms in Chrome WebGL2 + ANGLE D3D11.
- No sourced triangle throughput for Intel UHD 770 or RTX 3060 under WebGL.
- No sourced measurements for the multi-draw Chromium bottleneck (only a link to an open issue via the forum).
