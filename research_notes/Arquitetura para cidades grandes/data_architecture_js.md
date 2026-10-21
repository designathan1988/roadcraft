# Data architecture for huge worlds in JS/TS (browser + Electron), 2026

Context given: ~36 KB of heap per building today (345 MB / 8,102 buildings); page and workers share one 4 GB V8 heap in Electron; target < 2.5 GB at 200k buildings, which is a budget of ~12.5 KB per building **for everything** (buildings + roads + lots + props + agents + derived data). 36 KB x 200k = 7.2 GB, which cannot fit the cage, so the layout has to change, not just be tuned.

## Q1. Cheapest correct representation of a large editable city document in JS (records as objects only when edited/read)

### Takeaway
Keep the authoritative document as columns (TypedArrays/ArrayBuffers, structure-of-arrays) keyed by dense integer IDs, with variable-length data (footprint polygons, names) in shared pools addressed by offset+length. Make JS objects only as short-lived views or an LRU cache of "hydrated" records for the selection/inspector. This is the pattern used by ECS libraries (bitECS), by Figma (C++ document in one linear memory), and by VS Code's piece table (one big buffer plus small index nodes instead of one object per line).

### Cited Findings
- V8 objects are made of a hidden class (Map) plus property storage. In-object properties are fastest. Extra properties go to a separate backing store. Objects that see frequent add/delete of named properties switch to dictionary ("slow") mode, where inline caches don't work and memory use grows — [V8: Fast properties](https://v8.dev/blog/fast-properties)
- Very sparse arrays (e.g. `a[9999] = x`) switch to dictionary elements. Holey arrays force prototype-chain lookups. Custom property descriptors force slow elements — [V8: Fast properties](https://v8.dev/blog/fast-properties)
- With pointer compression, every tagged field (pointer or Smi) is 4 bytes instead of 8. Smis carry a 31-bit payload. Doubles do not fit in a 32-bit field, so double-field unboxing was turned off: a non-Smi number stored in an object field becomes a separate boxed HeapNumber — [V8: Pointer compression](https://v8.dev/blog/pointer-compression)
- Tagged values were about 70% of the V8 heap on real sites, which is why compression cut heap size by up to 43% — [V8: Pointer compression](https://v8.dev/blog/pointer-compression)
- Real case of per-record object overhead: VS Code's old line array used one `ModelLine` object per line at ~40-60 bytes each. A 35 MB file with 13.7M lines took ~600 MB, about 20x the file size, and failed to open. The piece table/tree (one big buffer plus a few index nodes) brought memory "very close to the original file size" — [VS Code: text buffer reimplementation](https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation)
- In bitECS, components are SoA TypedArrays indexed by entity id, e.g. `Velocity.x = new Float32Array(1e5)` read as `Velocity.x[eid]`. The library is ~5 KB minzipped and lists serialization and "thread-friendly"/multithreading among its features — [bitECS README](https://github.com/NateTheGreatt/bitECS)
- Figma's document model is a `Map<ObjectID, Map<Property, Value>>` with property-level last-writer-wins. Parent link plus fractional index are stored together as one property on the child. Object IDs embed the client ID — [Figma: How multiplayer works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- Figma's editor is C++ compiled to WebAssembly. Its address space is one large linear memory, and pointers are indices into it — [Figma: WebAssembly cut load time by 3x](https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/)
- TypedArrays carry fixed per-instance overhead. In a V8/Deno measurement, a plain `Array` was smaller than a `Uint8Array` up to 20 elements and they broke even at 20. Below ~150 elements the difference was under 1 KB — [Evan Hahn: Array vs Uint8Array memory](https://evanhahn.com/v8-array-vs-uint8array-memory-usage)

### Inferences
- **Never give each building its own small TypedArrays** (e.g. one `Float32Array` per footprint). Per the Hahn measurement, short TypedArrays cost more than arrays. Use one big pool per kind (e.g. `footprintXY: Float32Array` for all vertices, plus `footprintStart/Count: Uint32Array` per building).
- Rough budget per building in columns: id/type/flags/lot/road refs (~8 x 4 B), transform (~4 x 4 B), height/floors/style (~8 B), footprint of ~8-12 vertices as Float32 x,y (~64-96 B). That is roughly **150-250 B per building** versus 36 KB now, a 150-200x reduction. For 200k buildings that is ~30-50 MB of authoritative data. Derived GPU geometry then dominates, and it should live in ArrayBuffers outside the JS object graph.
- Strings should be interned into a string table (`Uint32` index). Enums should be small integers. Floats stored in object fields cost a HeapNumber box each (pointer-compression post), so columns save the most exactly on numeric-heavy records.
- A hydrated object (`getBuilding(id)`) can be a class instance with fixed-shape fields created in the constructor, kept in an LRU of a few thousand entries, and written back to the columns on commit. Never `delete` properties on those objects (dictionary mode).

### Gaps
- No authoritative per-object byte table for current V8 was found. The numbers above combine V8's 4-byte tagged fields with the VS Code 40-60 B/object case. The exact value should be checked with a heap snapshot of the game's own record shape.

## Q2. Bytes per entity, GC behavior at 1-4 GB heaps, and the Electron 4 GB cage

### Takeaway
Pointer compression limits each V8 heap cage to 4 GB. Electron 21+ also enables the V8 sandbox, which forbids ArrayBuffers that wrap external (malloc) memory. GC marking cost grows with the number of live objects, not raw bytes, so millions of small objects cause long marks even with concurrent marking. TypedArray payloads are traced as one object.

### Cited Findings
- Pointer compression makes all V8 objects live in a 4 GB-aligned 4 GB range. Chrome already limits the V8 heap to 2 or 4 GB depending on the device. Exploring 8-16 GB heaps is listed only as future work — [V8: Pointer compression](https://v8.dev/blog/pointer-compression)
- Electron enabled pointer compression in Electron 14. Its V8 heap is capped at 4 GB, and ArrayBuffers are counted separately with their own limits. Pointer compression cuts heap size by up to 40% and improves CPU/GC by 5-10% — [Electron blog: V8 memory cage](https://www.electronjs.org/blog/v8-memory-cage)
- Electron 21 enabled V8 sandboxed pointers, following Chrome 103. ArrayBuffers that point to external (off-heap) memory are no longer allowed and crash at runtime. Native modules must copy (`napi_create_buffer_copy`) or allocate with V8's allocator (`napi_create_buffer`). Workarounds for more than 4 GB: a child process running a Node.js built without pointer compression, a custom Electron build, or future wasm64/memory64 — [Electron blog: V8 memory cage](https://www.electronjs.org/blog/v8-memory-cage)
- The V8 sandbox reserves ~1 TB of virtual address space (40-bit offsets). Buffers outside it are reached through an external pointer table. Overhead is about 1% or less on Speedometer/JetStream. It was enabled by default on 64-bit desktop/Android for about two years before Chrome 123 — [V8: The V8 Sandbox](https://v8.dev/blog/sandbox)
- To measure: `performance.memory.usedJSHeapSize` in the renderer and `process.memoryUsage().heapUsed` in the main process — [Electron blog: V8 memory cage](https://www.electronjs.org/blog/v8-memory-cage)
- Concurrent marking (Chrome 64 / Node 10) cut main-thread marking time per GC cycle by ~65% on mobile and ~70% on desktop. Non-concurrent marking "can take several hundred milliseconds for large heaps." The post gives no pause numbers for specific heap sizes — [V8: Concurrent marking](https://v8.dev/blog/concurrent-marking)
- Node's `v8.getHeapSnapshot()` needs about twice the current heap size in memory while it runs. For a ~2 GB heap, a snapshot can itself exceed the cage — [Node.js v8 docs](https://nodejs.org/download/release/v22.5.1/docs/api/v8.html)
- `--max-old-space-size` raises the old-generation limit but cannot go beyond the 4 GB compressed cage (inference from the cage limit above; Electron documents no way to exceed it except the workarounds listed)

### Inferences
- Marking traverses every live object and pointer. A TypedArray of 10 MB is one object with an off-heap backing store, while 200k buildings x ~100 objects each (vectors, arrays, closures) is ~20M objects to trace. Moving to columns cuts GC work by orders of magnitude, not just bytes.
- Because each external-memory ArrayBuffer is counted separately from the JS heap, large geometry pools in ArrayBuffers help the JS heap number. Still, per the Electron post the whole thing remains limited inside the sandbox/cage design, and native code cannot hand out malloc'd memory as an ArrayBuffer. Plan the full process budget, not only `usedJSHeapSize`.
- The user's statement that the page and its workers share one 4 GB heap matches Chromium's shared-cage mode, where all isolates in a process share one pointer-compression cage. Spreading work across workers in the same renderer therefore does **not** add headroom. A separate process (utility process / child process) does.

### Gaps
- I found no official Electron doc stating "shared cage across workers" explicitly. This should be verified against Electron's build flags (`v8_enable_pointer_compression_shared_cage`) before relying on it.
- No public measurements of V8 major-GC pause vs heap size at 1-4 GB were found. Use `--trace-gc` on the real app.

## Q3. How large-document editors structure data, undo and saves

### Takeaway
They all avoid "one JS object graph per everything". Figma uses C++/WASM with a flat property map and property-level operations. VS Code uses a piece table over big buffers. Google Sheets moved its calculation engine to WasmGC in a worker. tldraw uses a record store with diff-based undo. The common thread: **the record is the unit; edits are diffs of records/properties; undo stores inverse diffs, not snapshots.**

### Cited Findings
- Figma's undo principle: undoing a lot, copying, then redoing back to the present must not change the document. Undo rewrites redo history at undo time, and vice versa. Properties of deleted objects are not kept on the server. They live in the undo buffer of the client that deleted them — [Figma: multiplayer](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- Figma clients download a full copy of the file, then sync property-level changes over WebSocket. The server runs one process per document — [Figma: multiplayer](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- Figma's move from asm.js to WebAssembly made load time more than 3x faster regardless of document size. Wasm parses ~20x faster than asm.js — [Figma: WebAssembly load time](https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/)
- VS Code's piece tree: memory is close to the file size. Sharing line-break offsets between nodes made text buffer operations 3x faster. The file is loaded in 64 KB chunks — [VS Code: text buffer reimplementation](https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation)
- tldraw's store is a reactive record database with schema validation. History has undo/redo stacks whose entries are diffs (added / updated from-to / removed records) or marks (stopping points). Pending changes are squashed into one entry at each mark — [tldraw: History](https://tldraw.dev/sdk-features/history), [tldraw: Store](https://tldraw.dev/sdk-features/store)
- `store.listen` delivers diffs that can be filtered by source (user vs remote), which is the hook for persistence. The docs advise batching changes to reduce persistence overhead — [tldraw: Store](https://tldraw.dev/sdk-features/store)
- Google Sheets' calculation worker: the JS version was >3x slower than the original Java engine. The first WasmGC port was ~2x slower than JS. After optimization (speculative inlining/devirtualization gave ~40%), WasmGC ended up ~2x faster than JS. Switching regex from compiled re2j to the browser's `RegExp` was ~100x faster. A core structure that blurred arrays and maps was "over-fit to JavaScript" and had to be rewritten. The engine runs in a Web Worker over a `MessageChannel` — [web.dev: Google Sheets WasmGC](https://web.dev/case-studies/google-sheets-wasmgc)

### Inferences
- Undo for a city editor: a command log of per-record diffs (`{table, id, column, before, after}`, or a byte range of a column), grouped by marks. This gives O(change) memory instead of O(document) per step. Persistent/immutable whole-document structures are not needed when records are in columns. The diff log is the structural sharing.
- Saves: write dirty chunks/tables (spatial tiles or column segments) incrementally, not a full JSON re-serialize.

### Gaps
- No primary engineering posts were found for Excalidraw or Photopea data layout in this pass. Figma's newer posts on memory were not retrieved.

## Q4. Workers, shared memory, WASM, binary formats and storage

### Takeaway
Compute derived data (geometry, spatial indices) in workers that read SharedArrayBuffer columns directly (needs cross-origin isolation) or receive transferred ArrayBuffers (zero-copy move). Store saves as binary columnar chunks in OPFS via sync access handles in a worker, optionally gzip/deflate via CompressionStream. Avoid JSON for the whole world because of V8 string limits and parse cost.

### Cited Findings
- `SharedArrayBuffer` needs a secure context plus cross-origin isolation (COOP + COEP headers). Check `crossOriginIsolated`. Without it, the constructor is hidden and `postMessage` of a SAB throws. SAB is shared via structured clone (not transferable). It is growable with `maxByteLength` + `grow()` (grow only, never shrink, new bytes zeroed). Synchronization uses `Atomics` — [MDN: SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
- COEP `credentialless` is an alternative to requiring CORP on every cross-origin resource. A service worker (coi-serviceworker) can add the headers when you don't control the server — [web.dev: COOP/COEP](https://goo.gle/2NATe2S)
- In Electron, SAB is reported as disabled by default unless enabled (Figma forum, March 2024, discussing WasmGC needing SAB in Electron). The exact Electron mechanism was not confirmed by primary docs in this pass — [Figma forum: SharedArrayBuffer support](https://forum.figma.com/t/can-you-add-support-for-sharedarraybuffer/67645)
- Transferable objects: round-tripping a 32 MB ArrayBuffer to a worker took ~302 ms with structured clone vs ~6.6 ms with transfer (~45x). The source buffer is detached (`byteLength` becomes 0) — [Chrome blog: Transferable objects](https://developer.chrome.com/blog/transferable-objects-lightning-fast)
- ECS benchmark (Node 17.8, 1,000-entity workloads, ops/s): SoA libraries bitecs 335k packed / 116k simple / 431k fragmented iteration; piecs 365k/177k/471k; wolf-ecs 378k/166k/535k. Object-based becsy 103k/28k/61k; miniplex 109k/36k/20k; ecsy 7.8k/4.8k/24.5k. But bitecs entity create/destroy is slow (1,634 ops/s vs piecs 64,075), and add/remove is 2,334 ops/s. Variance is 1-4% — [noctjs/ecs-benchmark](https://github.com/noctjs/ecs-benchmark)
- FlatBuffers: data is read directly from the buffer without parsing or unpacking, and "no heap is required" beyond the buffer. Protobuf needs a parse into per-object allocations. JS and TS are supported — [FlatBuffers docs](https://flatbuffers.dev/)
- V8 max string length on 64-bit is `(1 << 29) - 24` UTF-16 code units (~512 MiB Latin-1, ~1 GiB two-byte). It was raised from 2^28 after pointer compression accidentally lowered it, and it is limited because a heap object's byte size must fit in a Smi — [V8 v8-primitive.h](https://chromium.googlesource.com/v8/v8/+/84eee965ef4abe2c5d8e55bdf188eb2ee97e502a/include/v8-primitive.h), [V8 commit: bump max string length](https://chromium.googlesource.com/v8/v8/+/refs/tags/8.1.307.5%5E), [SpiderMonkey constraints doc](https://searchfox.org/firefox-main/source/js/src/doc/constraints.md)
- VS Code hit the (then 256 MB) string limit: a 500 MB file threw — [VS Code blog](https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation)
- OPFS: origin-private, "highly optimized for performance," in-place writes. `createSyncAccessHandle()` (worker-only) gives synchronous `read/write({at})`, `truncate`, `flush`, `getSize`. Same quota as IndexedDB (`navigator.storage.estimate()`). Baseline widely available since March 2023 — [MDN: OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- Compression Streams (`CompressionStream`/`DecompressionStream`, gzip/deflate) are available in workers. Baseline since May 2023 — [MDN: Compression Streams API](https://developer.mozilla.org/en-US/docs/Web/API/Compression_Streams_API)
- WebAssembly memory model: one linear memory with indices as pointers (Figma). Wasm has native 64-bit integers, while JS is limited to 53-bit — [Figma WASM post](https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/). Calling into browser-native code (RegExp, strings) can beat code compiled into Wasm by ~100x — [web.dev: Google Sheets WasmGC](https://web.dev/case-studies/google-sheets-wasmgc)

### Inferences
- Recommended pipeline: main thread owns the column store (or a SAB view of it). Edits produce diffs. Workers read SAB columns (or receive transferred snapshots of dirty tiles), build geometry into fresh ArrayBuffers, and **transfer** them back (zero-copy). The main thread uploads them to the GPU and can drop the CPU copy.
- In Electron you control the protocol handler, so you can set COOP/COEP on your own responses. The exact Electron API should be confirmed in Electron docs before implementation.
- A Wasm linear memory is itself one ArrayBuffer inside the same cage/sandbox in Electron, so moving to Rust/C++ does not escape the 4 GB limit (wasm32 is also limited to 4 GB). Its benefits are compact layout and no per-object GC, not extra address space. memory64 is the only route to more and is cited by Electron only as future.
- For the ECS choice: bitecs-style SoA iteration is 3-40x faster than object ECSs (ecsy) in the benchmark. A city editor creates and deletes few entities per frame, so bitecs' slow entity cycle matters less. A custom SoA store (no library) is also reasonable.
- Save format: binary columnar chunks per tile/table (FlatBuffers or a custom header + raw TypedArray bytes), gzip via CompressionStream, written through OPFS sync handles in a worker. Avoid one giant JSON string. At 200k buildings with polygons, JSON can approach the ~512 MiB one-byte string limit, and `JSON.parse` creates millions of objects.

### Gaps
- No primary source with numbers comparing IndexedDB vs OPFS throughput for large blobs was retrieved in this pass.
- Cap'n Proto JS support and becsy's storage-strategy docs (the page URL returned 404) were not verified.
- No Electron-official doc on enabling SharedArrayBuffer / cross-origin isolation for custom protocols was found.
- Measured JS-to-Wasm call overhead numbers were not found in this pass.
