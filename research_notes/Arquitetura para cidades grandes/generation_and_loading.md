# Generating and opening very large procedural cities and game worlds quickly (2026)

Scope: deterministic parallel generation, city-generation pipelines, progressive opening, worker/shader warm-up, caching derived data, fast saves and loads.
Project context: an 8,102-building city opens in 15.4 s today. Synchronous growth takes 2.6-4.5 s, world and roads 5-9 s, shader programs 2.4-7.4 s, and the heap is 345 MB.

## How do games open huge saves and worlds fast (Factorio, Cities: Skylines, Minecraft, Satisfactory, X4, No Man's Sky)?

### Takeaway
The primary sources point to three patterns:
- **Separate stored state from derived state.** Store only the authoritative state and rebuild everything else from it deterministically. Factorio requires save, exit and reload to change nothing observable. No Man's Sky generates terrain from a seed instead of storing it.
- **Chunk the file with a random-access index.** Minecraft's region format lets any chunk be found and decoded on its own.
- **Take the slow work off the critical path.** Factorio forks a process to save in the background. Minecraft pauses far chunks at early generation stages and finishes them when a player approaches.

I found no primary numbers for Cities: Skylines, Satisfactory or X4.

### Cited Findings
**Factorio (Wube)**
- Factorio requires save/load to be fully deterministic: saving, exiting and reloading must not change any observable behaviour. Developers call this "one of the key parts" of the process. It is what makes multiplayer join, replays, and save/load regression testing possible. — [Factorio FFF #270](https://www.factorio.com/blog/post/fff-270)
- A Factorio save holds a prototype-ID mapping plus the map data. Loading is "much more complex" than saving. It has to handle version migrations, mod changes and corrupt files, and it re-derives things like which chunks an entity overlaps and electric-network membership. — [Factorio FFF #270](https://www.factorio.com/blog/post/fff-270)
- Factorio runs its expensive consistency checks only on version or mod transitions, not on every save/load, because running them on every save/load "would affect the game too much". — [Factorio forum, FFF #242 thread](https://forums.factorio.com/viewtopic.php?p=362122)
- Each Factorio autosave is a full write with no incremental saving. Players report 20-60 s saves on big bases. — [Factorio forum, FFF #201 thread](https://forums.factorio.com/viewtopic.php?p=303102)
- **Non-blocking saving.** Factorio's "non-blocking saving" fork()s the process, so the child writes the save from a copy-on-write snapshot while the game keeps running. It is Linux/macOS only because Windows has no fork(). It is a hidden option and has had crash reports (for example, only one async save may run at a time). — [Factorio forum: What is non-blocking saving?](https://forums.factorio.com/viewtopic.php?p=341647); [Non-blocking save crashes](https://forums.factorio.com/viewtopic.php?p=507103); [2.0.43 autosave thread](https://forums.factorio.com/viewtopic.php?p=667753)

**Minecraft (Mojang)**
- **Region files.** Each file holds 32×32 = 1,024 chunks (512×512 blocks) and is laid out in 4 KiB sectors, one memory page each:
  - The header is two 4 KiB tables. One gives each chunk's offset (3 bytes) and length (1 byte, up to 255 sectors, about 1 MiB). The other gives each chunk's timestamp.
  - Each chunk is stored as length + compression byte + compressed NBT.
  - Compression types: 1 = gzip, 2 = zlib (the default), 3 = none, 4 = LZ4 (since snapshot 24w04a, opt-in in server.properties), 127 = custom.
  - A chunk too large for its sectors overflows into a separate `.mcc` file.
  - The format was claimed to be up to 7x faster than the older Alpha format.
  - Each chunk can be located and decoded independently, which makes this a lazy-decoding index.
  — [Minecraft Wiki: Region file format](https://minecraft.wiki/w/Region_file_format)
- **Generation stages.** Minecraft generates chunks in ordered steps: structure_starts, structure_references, biomes, terrain (including carvers), features, initialize_light, light, spawn, full. Chunks far from players can be "frozen" at an early step and resumed when a player approaches. Unfinished chunks are "proto-chunks". The seed space is 2^64. — [Minecraft Wiki: World generation](https://minecraft.wiki/w/World_generation)

**No Man's Sky (Hello Games)**
- Hello Games' GDC 2017 talk "Continuous World Generation in No Man's Sky" covers generating planets "continuously in real-time". The slides are behind the GDC Vault login and I could not read them. — [GDC Vault](https://www.gdcvault.com/play/1024265/Continuous-World-Generation-in-No)
- Secondary articles say the seed is the input to a generator, not a stored map. Two players at the same coordinates see the same terrain, but each machine computes it locally. These are SEO-style pages, so treat them as weak sources. — [Kill Screen](https://www.killscreen.com/no-mans-sky-and-technology-created-18-quintillion-planets/)

**Cities: Skylines II**
- I found only player reports. In March 2024, players said loading and saving had become noticeably faster after patches, and one commenter attributed load time mostly to Unity/DX12. There were no official numbers. — [Steam discussion](https://steamcommunity.com/app/949230/discussions/0/4286935452896894605)

### Inferences
- **Factorio's determinism rule fits the project.** If save → reload must be bit-identical, then all derived data (meshes, road geometry, building shells) can be rebuilt or loaded from a cache, and the save only has to hold the document.
- **Minecraft-style index for the document.** A sector-aligned index (offset + length per region) plus per-region compression gives O(1) access to any region. The whole document can still be read up front, while decoding or expansion of far regions waits until it is needed. This matters because the brief says the document must be fully loaded.
- **Pause far work at an early stage.** Minecraft's "frozen at an early status" proto-chunks map directly onto "build derived data only near the camera". Keep far regions at the document/footprint stage and promote them to mesh as the camera approaches.
- **Background saving in a browser.** Without fork(), the equivalent is to snapshot the typed arrays (copy, or `structuredClone` with transfer) and hand them to a worker to serialize, compress and write to OPFS.

### Gaps
- No official numbers on load times or save formats for Cities: Skylines I/II, Satisfactory or X4. Searches returned only forum and player content.
- No Man's Sky's GDC slides need a login. I found no primary detail on how it derives per-region seeds.
- I did not fetch the Dwarf Fortress world-generation sources.
- The Minecraft Wiki page does not describe how Minecraft derives per-chunk random values from the world seed (it uses positional/xoroshiro RNGs) or how it parallelises generation. That detail is unverified here.

## Deterministic parallel generation: per-region seeds and counter-based RNGs

### Takeaway
Counter-based RNGs make output identical under any parallel split. Examples are Philox (Random123), Squares and SplitMix-style hashes. Each value is a pure function `f(key, counter)`, so seeding by (world seed, region coordinates, element index) gives the same result in serial and in parallel. Squares needs only 4 rounds for 32-bit output and 5 for 64-bit. Philox 4x32 uses 10 rounds and is the industry default in cuRAND, MKL and MATLAB.

### Cited Findings
- Squares applies several rounds of squaring to a counter. Four rounds give 32-bit output and five rounds give 64-bit output, and both pass rigorous statistical tests. The author says they "may be the fastest counter-based generators". Early arXiv versions claimed 3 rounds were enough; later versions say 4. — [Widynski, arXiv:2004.06278](https://arxiv.org/abs/2004.06278v6)
- Philox 4x32-10 uses 10 rounds and ships in NVIDIA cuRAND, Intel MKL and MATLAB. — [Wikipedia: Counter-based RNG](https://en.wikipedia.org/wiki/Counter-based_random_number_generator)
- A JavaScript port of Squares measured about 50 M numbers/s on an older Intel i7, against about 1,000 M/s for the C original. The gap comes from function-call and number-conversion overhead in JS. — [squares-rng (npm)](https://npmjs.org/package/squares-rng)
- I found no neutral head-to-head benchmark of Squares against Philox. The "2x faster than Philox" figure comes from the author and a Rust crate. — [docs.rs squares](https://docs.rs/crate/squares/0.1.0)

### Inferences
- **Recipe for identical serial and parallel output.**
  - Derive `regionSeed = hash(worldSeed, regionX, regionY)`.
  - Inside each region, draw `rand(regionSeed, elementIndex, purpose)` rather than advancing one shared stream.
  - Any process that reads neighbours (roads crossing region borders, lots on a boundary) needs either a fixed ownership rule (for example, the lower-left region owns the edge), or a two-phase scheme: generate the global skeleton (arterials) serially first, then fill regions in parallel.
- **Use 32-bit math in JS.** A 64-bit generator such as Squares-64 or SplitMix64 needs BigInt, which is slow. Prefer 32-bit variants built on `Math.imul`, or run generation in WASM.

### Gaps
- I did not obtain the original Random123 paper (Salmon et al., SC11) or its throughput numbers. I also did not fetch L'Ecuyer et al.'s 2021 comparison of counter-based RNGs.

## Procedural city generation pipelines and their performance

### Takeaway
The classic pipeline is from Parish & Müller (SIGGRAPH 2001, later CityEngine):
1. Input maps (terrain, water, population density).
2. An extended L-system grows highways and then streets, under global goals and local constraints.
3. Blocks are subdivided into lots.
4. Each lot gets building geometry from a grammar.

Steps 3 and 4 are independent per block and per lot, so they parallelise naturally. Street growth is the inherently sequential part. I found no published timings for the original system.

### Cited Findings
- Parish & Müller's system takes input maps and outputs highways, streets, lots and buildings. The L-system is extended to handle global goals and local constraints, which keeps the production rules simple. — [ACM SIGGRAPH History Archive](https://history.siggraph.org/?p=116923)
- A 2008 tutorial (Watson, Wonka et al.) summarises procedural urban modelling. Its inputs are geography, population density and layout constraints, and its outputs are streets and subdivided land. — [Procedural Methods for Urban Modeling (Wonka)](https://peterwonka.net/Publications/pdfs/2008.CGA.Watson.ProceduralModelingTutorial.pdf)
- Šťava et al. (2010) use L-systems for street layout in inverse procedural modelling. — [Purdue PDF](https://cs.purdue.edu/homes/bbenes/papers/Stava10CGF.pdf)

### Inferences
- **Split the pipeline at the sequential/parallel boundary.**
  - Road-network growth is a sequential, priority-queue process. Keep it on one thread, or run it per district with fixed ownership of district borders.
  - Lot subdivision and building generation are embarrassingly parallel. Each block is a job seeded by `(worldSeed, blockId)`.
  - This step is likely where the 2.6-4.5 s "synchronous growth" goes. It belongs in a worker pool.

### Gaps
- No runtime or performance figures were found for CityEngine, Citygen (Kelly & McCabe) or the original Parish & Müller system. Getting them would mean reading the full papers.

## How much does Electron/Chromium cache compiled shaders across runs, and how do you warm the cache?

### Takeaway
Chromium keeps a persistent shader and program cache in the profile's `GPUCache` directory, and ANGLE feeds compiled program binaries into it through the `GL_ANGLE_blob_cache` extension. On a second run, programs with the same source, the same ANGLE build and the same driver load from disk instead of compiling. Any change to the ANGLE commit or the driver invalidates them. The cache becomes stale after driver or OS updates; the visible error is "Binary is not compatible with current driver/hardware combination".

Warm-up steps:
1. Request `KHR_parallel_shader_compile`.
2. Compile every material variant during opening with three.js `compileAsync`. It polls `isReady()` every 10 ms and avoids blocking only when the extension is present.
3. Keep material permutations few and stable, so program keys (and so cache hits) stay the same between runs.

### Cited Findings
- Chromium's `shader_disk_cache.cc` (in `gpu/ipc/host`) stores shader and program entries in a `GPUCache` directory under the profile. — [Chromium source](https://chromium.googlesource.com/chromium/src/+/900d25159ac083fda1702706cfc8da4c09087411/gpu/ipc/host/shader_disk_cache.cc)
- Chromium adds the ANGLE commit ID to the program-cache hash, because ANGLE rejects program binaries built by a different ANGLE version. Every Chromium/Electron upgrade that changes ANGLE therefore starts with a cold cache. — [Chromium commit "Add ANGLE commit to program cache hash"](https://chromium.googlesource.com/chromium/src/+/dc26192a317d9511ce983fd4b26b1130fe25761a)
- ANGLE has a `MemoryShaderCache` whose platform layer can warm it from disk, plus a `GL_ANGLE_blob_cache` extension through which the embedder stores and fetches binary blobs. ANGLE's own default BlobCache is off unless the embedder provides one; Chromium does. — [ANGLE MemoryShaderCache.h](https://chromium.googlesource.com/angle/angle/+/main/src/libANGLE/MemoryShaderCache.h); [ANGLE BlobCacheTest](https://chromium.googlesource.com/angle/angle.git/+/main/src/tests/gl_tests/BlobCacheTest.cpp); [ANGLE commit 390ef299](https://android.googlesource.com/platform/external/angle/+/390ef29999)
- ANGLE disabled Vulkan pipeline-cache serialisation on NVIDIA drivers older than 520, noting it "might affect second-run performance". — [ANGLE commit](https://android.googlesource.com/platform/external/angle/+/84f5295c97%5E)
- **Failure mode in Electron.** After an OS or driver update, WebGL2 programs failed to load from the cache with "Program binary could not be loaded. Binary is not compatible with current driver/hardware combination". The fix was deleting the app's `GPUCache`. Joplin and Ferdium, also Electron apps, hit the same issue. — [Saleae support](https://new.saleae.com/support/troubleshooting/platform-specific-issues/analog-waveforms-do-not-appear-on-linux); [Ferdium issue #1265](https://github.com/ferdium/ferdium-app/issues/1265)
- **KHR_parallel_shader_compile in Chrome.**
  - It must be enabled with `getExtension` first, or `COMPLETION_STATUS_KHR` raises INVALID_ENUM.
  - In 2019, Chrome's first status query blocked until the latest compile finished. This was fixed in crbug 881152, after which the query took about 0.01 ms.
  - Advice from the same thread: make no GL calls on a program until its status is true.
  - The main benefit is a responsive main thread, not a large total speed-up, because driver compile threads are limited.
  — [Khronos public_webgl list, Apr-May 2019](https://www.khronos.org/webgl/public-mailing-list/public_webgl/1904/msg00005.php); [follow-up](https://www.khronos.org/webgl/public-mailing-list/public_webgl/1905/msg00011.php)
- **three.js compile and compileAsync (current dev source).**
  - `compile(scene, camera, targetScene)` walks the scene and calls `prepareMaterial` → `getProgram` for each material. It returns a Set of materials and does not wait for compilation.
  - `compileAsync` calls `compile`, then polls with `setTimeout(check, 10)` until every material's `program.isReady()` is true, and resolves with the scene.
  - When `KHR_parallel_shader_compile` is present, the first check runs immediately.
  - Programs are keyed by `programCache.getProgramCacheKey(parameters)`, so each distinct parameter set (lights, fog, defines, skinning, and so on) is a separate GL program.
  — [three.js WebGLRenderer.js (dev)](https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/WebGLRenderer.js)
- **Unreal's analogous problem.** UE 5.1+ has two complementary systems:
  - PSO Precaching collects and compiles PSOs automatically and asynchronously.
  - A Bundled PSO cache is recorded by playing the game. Epic recommends a small bundled cache for global PSOs created in the first frames after loading.
  - Guides recommend using both, and warn that compiling the bundle lengthens the first load.
  — [Epic: PSO Precaching](https://dev.epicgames.com/documentation/en-us/unreal-engine/pso-precaching-for-unreal-engine); [Tom Looman guide](https://tomlooman.com/psocaching-unreal-engine)

### Inferences
- **Diagnosis of the current 2.4-7.4 s shader time.** The wide range most likely reflects cold versus warm GPUCache plus how many permutations are built.
  - To confirm, time a second run after a clean run, with the same Electron version and driver.
  - The likely fix is to cut the number of permutations (shared materials, fewer `defines`, no per-object `onBeforeCompile` variations) so the program set is small and stable.
  - Then call `compileAsync` on a "shader warm scene" holding one mesh of every material and light combination. Run it in parallel with document loading, not after it.
- **First-run cost cannot be avoided in Electron.** No supported Electron API pre-populates GPUCache, so a new Electron version or GPU driver means a cold compile. A "first launch after update" warm-up, run while the UI is idle, is the practical answer, mirroring Unreal's bundled PSO cache.
- **Don't block a frame on readiness.** Avoid calling `renderer.render` with not-ready programs before the promise resolves. Rendering a program forces a synchronous link wait.

### Gaps
- I could not confirm the current Chromium defaults for in-memory program-cache size (`gpu_program_cache_size`) or the GPUCache disk size. The `gpu_preferences.h` path returned 404.
- No published measurements of warm versus cold GPUCache load times for WebGL apps were found.
- I did not verify how WebGPU/Dawn caches pipelines in Electron. Dawn has its own blob cache through the same Chromium mechanism, but this is unverified here.

## Caching derived geometry, compression, OPFS, and lazy decoding

### Takeaway
Browsers and Electron offer fast binary I/O through OPFS with `FileSystemSyncAccessHandle`. It runs in workers only, is synchronous, and does in-place `read` and `write` at byte offsets into typed arrays, with `flush`. That makes an mmap-like "header + offset table + raw typed-array blobs" layout practical: read only the regions near the camera, and keep cached geometry keyed by a content hash of its inputs.

For compression, zstd is now standard for HTTP in Chrome 123+, Firefox 126+ and Safari 26.3. However, I found no evidence that `CompressionStream` accepts "zstd". It supports gzip and deflate; a JS zstd needs WASM. Minecraft's move to LZ4 shows that a fast codec beats a high-ratio one for load time.

### Cited Findings
- **OPFS sync access.**
  - `createSyncAccessHandle()` is itself async but returns a handle whose `read`, `write`, `truncate`, `getSize`, `flush` and `close` methods are synchronous.
  - It is usable only in Web Workers, "so as not to block the main thread".
  - "Synchronous APIs are faster as they avoid having to deal with promises."
  - OPFS is "highly optimized for performance and offers in-place write access", unlike File System Access API writes, which go through temporary files and are "fairly slow".
  - It is Baseline since March 2023, subject to storage quota, and available in secure contexts only.
  — [MDN: Origin private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- **zstd for HTTP.** Chrome 123 (March 2024) shipped zstd Content-Encoding, with the window capped at 8 MB to limit memory use. Firefox 126 and Safari 26.3 followed. — [blink-dev Intent to Ship: Zstd Content-Encoding](https://groups.google.com/a/chromium.org/g/blink-dev/c/GFFOLCF12a4/m/crdNkVeaAQAJ); [Phoronix](https://phoronix.com/news/Zstd-1.5.6-Zstandard); [youngju.dev 2026](https://www.youngju.dev/blog/2026-07-17-content-encoding-zstd-dictionary-transport.en)
- **Minecraft codecs.** Minecraft added LZ4 (scheme 4) as an alternative to zlib for region chunks in 24w04a, and a custom-codec slot in 24w05a. — [Minecraft Wiki: Region file format](https://minecraft.wiki/w/Region_file_format)
- **Factorio derived state.** Factorio re-derives state such as chunk overlap and electric networks on load rather than trusting it. Loading must cope with prototype changes that alter bounding boxes. — [Factorio FFF #270](https://www.factorio.com/blog/post/fff-270)

### Inferences
- **Suggested on-disk layout for a 200k-building document.**
  - A fixed header and an offset table per district or region.
  - Struct-of-arrays sections: `Float32Array` footprints, `Uint32Array` ids, `Uint16Array` heights and types.
  - Each section compressed with LZ4 or zstd-WASM, or left uncompressed when on local disk.
  - Decoding is a `new Float32Array(buffer, offset, len)` view with no parsing. This is the browser analogue of memory-mapped loading.
  - JSON parsing of 200k objects is likely the dominant cost to avoid. This is unmeasured here.
- **Derived-geometry cache.** Key = hash(region document bytes + generator version + LOD). Store the vertex and index buffers in OPFS (or Electron's userData through Node fs) and reuse them when the hash matches. Invalidate by bumping the generator version.
- **Compressing in the browser.** `CompressionStream` supports gzip, deflate and deflate-raw. For faster decompression, use a WASM zstd or LZ4 decoder in a worker.

### Gaps
- No primary data on whether `CompressionStream` gained a "zstd" format by 2026. The search returned only HTTP Content-Encoding results.
- No published OPFS throughput numbers (MB/s) were found on MDN.

## Best practice to keep the opening under a few seconds for a 200k-building city (full document, derived data near the camera only)

### Takeaway
No single source answers this directly. Combining the cited practices gives one plan:
1. Load the document as a binary SoA snapshot. This is milliseconds to low hundreds of ms, with no JSON and no per-object allocation.
2. Start the worker pool and shader warm-up in parallel with step 1, so module load and `compileAsync` overlap I/O.
3. Build derived data (road meshes, buildings) only for regions near the camera, in workers, with a counter-based RNG keyed by region. Results are then identical to serial generation and cacheable by content hash.
4. Show the first frame as soon as the near set is ready.
5. Promote far regions progressively, Minecraft proto-chunk style, within a per-frame time budget.

### Cited Findings
- Minecraft pauses far chunks at early generation stages and resumes them as players approach. — [Minecraft Wiki: World generation](https://minecraft.wiki/w/World_generation)
- Unreal: most global PSOs are created in the first frames after loading, so precache them, and a bundled cache lengthens first load. This suggests overlapping shader warm-up with loading. — [Epic: PSO Precaching](https://dev.epicgames.com/documentation/en-us/unreal-engine/pso-precaching-for-unreal-engine)
- The benefit of KHR_parallel_shader_compile is a responsive main thread, not raw speed. — [Khronos public_webgl](https://www.khronos.org/webgl/public-mailing-list/public_webgl/1905/msg00011.php)
- Synchronous OPFS I/O exists only in workers. — [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- Factorio keeps saves deterministic and re-derives runtime structures on load. — [Factorio FFF #270](https://www.factorio.com/blog/post/fff-270)

### Inferences
These are estimates mapped onto the project's measured phases. None of them were measured here.
- **World/roads (5-9 s).** Store road centrelines and intersections in the document, and generate road meshes only for near regions, in workers. A 200k-building document of about 50-100 bytes per building is about 10-20 MB raw, which is readable in well under 1 s from local disk.
- **Synchronous growth (2.6-4.5 s).** Growth produces the document. On open it should not run at all, because the document is loaded, not regrown. During new-city generation, parallelise lot and building generation per block with region-keyed RNG.
- **Shader programs (2.4-7.4 s).** Reduce permutations. Start `compileAsync` on a warm-up scene at t = 0 and render nothing until it resolves. Expect warm runs to hit GPUCache, and accept one cold run after each Electron or driver update.
- **Worker cold start.** Create the pool before the document arrives and pre-import the generator modules, sending a no-op job to each worker. Transfer `ArrayBuffer`s rather than cloning them.
- **Time slicing on the main thread.** Keep only GPU uploads and scene insertion on the main thread, capped to a budget of a few ms per frame, for example a 4 ms slice. Everything CPU-heavy goes to workers.
- **Heap (345 MB).** SoA typed arrays for 200k buildings cost tens of MB. Per-building JS objects and per-building `Object3D`s are what explode the heap.

### Gaps
- No primary source gives concrete open times for a 200k-object city in a browser or Electron engine.
- Worker-pool cold-start costs (module parse and compile per worker) were not sourced. V8's code cache for workers was not researched within the tool budget.
- The Dwarf Fortress world-generation approach, X4 and Satisfactory save systems, and Cities: Skylines dev diaries are not covered by primary sources here.
