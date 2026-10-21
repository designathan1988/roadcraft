# How commercial city builders and large simulations handle huge cities (as of Oct 2026)

Scope: data layout, simulation model, building rendering, LOD, memory, load/save in Cities: Skylines I/II, SimCity 2013 (GlassBox), Anno 1800, Transport Fever 2, Workers & Resources, Factorio, Manor Lords, Planet Coaster, Dwarf Fortress, Townscaper, plus Unity's Megacity reference. Applicability target: three.js WebGL2 city builder with about 200k real buildings in one always-loaded document.

Source quality: primary or near-primary sources are the Factorio Friday Facts (developer-written), Paavo Huhtala's RenderDoc analysis of CS2, the Game Developer write-up of the GDC 2012 GlassBox talk, and Colossal Order/Iceflake statements as reported by press. Many other claims are community or press-sourced and are marked as such.

## 1. How do they store and simulate the city, and what limits did they hit?

### Takeaway
The successful titles do less work rather than more threads: idle entities sleep, work is bucketed or time-sliced across ticks, and similar entities are merged into aggregates (segments, groups, grids). The memory-bandwidth wall arrives before the core-count wall. Fixed-size entity arrays (CS1) and per-agent simulation (SimCity 2013, CS2, Transport Fever 2, Manor Lords) are the usual scaling ceilings.

### Cited Findings
**Cities: Skylines II (Unity DOTS)**
- Simulation runs on Unity 2022.3.7 DOTS/ECS with Burst, about 1,200 ECS systems drive game logic. — [Paavo Huhtala, CS2 performance analysis](https://blog.paavo.me/cities-skylines-2-performance/)
- A post attributed to Colossal Order (Reddit, Oct 2023; unofficial, indicative only) says the simulation is "fully implemented using the DOTS stack" (full ECS, job system, Burst), and that adopting the ECS mindset was the team's biggest challenge. — [r/CitiesSkylines CO comment (mirror)](https://twt.omada.cafe/r/CitiesSkylines/comments/17ekhtw/comment/k64zldb/?context=3)
- CO's stated performance target was "steady 30FPS minimum (not 60 or more)". The simulation is built around an expected update rate given 30 fps. CO also said stutter came from a CPU-dependent "synchronization condition". — [Destructoid on CO AMA, 24 Oct 2023](https://destructoid.com/?p=419528); [DSOGaming](https://www.dsogaming.com/?p=175294)
- CEO Mariina Hallikainen (via PC Gamer, relayed by Automaton, Mar 2026) said the core mistake was planning around Unity features that were not finished. ECS (official release June 2023) had insufficient support for long-running jobs. HDRP lacked features (e.g., custom interpolators), so many systems were built in-house. — [Automaton, 19 Mar 2026](https://automaton-media.com/articles/newsjp/20260319-430623/)
- Iceflake (took over development in early 2026; City Corner #4, Apr 2026) calls the game "very CPU-intensive". It says late-game slowdowns are mostly simulation-side, larger populations mean more pathfinding requests, and "nothing can be precomputed ahead of time or baked in" because the city is dynamic. Fixes: excessive citizen pathing requests removed, bicycle pathing reduced, "smarter pathing", and lower population density to better match city scale. A benchmark tool was planned for the end of April 2026. — [PCGamesN, 10 Apr 2026](https://www.pcgamesn.com/cities-skylines-2/performance-blog)
- Players reported the game seemed bound to about 6 cores (anecdotal). — [DSOGaming summary of Steam reports](https://www.dsogaming.com/?p=175294)

**Cities: Skylines I (Unity, pre-DOTS, fixed arrays)**
- Community stat dumps (not official) list hard caps: buildings 32,768; citizens 1,048,576; citizen instances 65,536; active vehicles 16,384. A CO developer described node, network and vehicle limits as hard caps once reached, and said CitizenUnits (households) can run out before the 1M citizen cap. — [Steam discussion](https://steamcommunity.com/app/255710/discussions/0/3080998989605580571); [Steam Workshop discussion](https://steamcommunity.com/workshop/filedetails/discussion/531738447/481115363859488292)
- Stack traces show a dedicated SimulationManager.SimulationThread dispatching per-manager SimulationStep calls, separate from the render thread. — [Steam thread logs](https://steamcommunity.com/app/255710/discussions/0/2801756152805015510)

**SimCity 2013 (GlassBox, Maxis; GDC 2012, Andrew Willmott)**
- The model has five concepts. Resources live in capacity-limited bins. Units (houses, factories) have state that is a set of bins. Maps hold spatial fields (pollution, land value, coal). Globals are town-wide bins. Agents are mobile carriers that run no rules ("lightweight"), represent people, cars or water in pipes, and travel to a destination. Rules (unit/map/zone) with rates and thresholds move resources between them. — [Game Developer, GDC 2012 GlassBox](https://gamedeveloper.com/design/gdc-2012-breaking-down-em-simcity-em-s-glassbox-engine)
- Target: 10,000+ agents active at once. — [same](https://gamedeveloper.com/design/gdc-2012-breaking-down-em-simcity-em-s-glassbox-engine)
- City plots were capped at about "SC4 medium" size. Ocean Quigley called it a trade-off for dense activity over "sprawling, but low resolution and inert" cities. Maxis GM Patrick Buechner said bigger cities were impossible due to engine limitations. Agents had no persistent home or job ("nearest job/home") per launch-era critics (opinion, not confirmed by Maxis). — [PC Gamer](https://pcgamer.com/sim-city-size-restriction-explained); [Softpedia](https://games.softpedia.com/blog/SimCity-Settlement-Size-Will-Not-Be-Increased-Says-Maxis-388586.shtml); [BGR](https://www.bgr.com/general/simcity-pr-nightmare-analysis-372284/)

**Factorio (Wube, custom C++ engine; developer-written FFF)**
- The main optimization strategy is "do less". Most entities sleep when idle and use zero CPU. Belts check collision only against the item in front. Solar panels and accumulators are grouped, so N panels cost one calculation (N × light × power). Belt and pipe lines merge into segments stored contiguously, and moving the segment offset replaces moving each item. Animation is driven by tick, not per-entity updates. Target 60 UPS. — [FFF #148](https://factorio.com/blog/post/fff-148)
- In the 2.0 optimizations, idle roboports are switched off, cutting about 1 ms to 0.025 ms per tick. Radar chunk coverage became counter-based, with update buckets processed one bucket per tick (+3.6%). "Always on" lamps removed control updates (about 1.2 ms saved with ~15k lamps). Read-only circuit logic was multithreaded: +9.5% on a real save, and 14.9× (131 s to 8.2 s) on a synthetic 77k-combinator benchmark. Robots store a move intention, and the renderer predicts position while the robot updates at most every 20 ticks moving and 60 ticks stationary (+10–25% on robot-heavy saves). — [FFF #421](https://factorio.com/blog/post/fff-421)
- Multithreading the electric network was rejected because it is memory-throughput-bound: update time fell from 0.5 to 0.39 ms, but CPU use rose from 0.5% to 15% with no overall gain. Networks sharing an entity must update together for determinism. — [FFF #421](https://factorio.com/blog/post/fff-421); [forum thread](https://forums.factorio.com/viewtopic.php?p=615108)
- Community reports say a 40–50 UPS 1.1 megabase runs at about 60 UPS in 2.0, largely from the fluid-system overhaul and not from threading (community claim). — [Steam discussion](https://steamcommunity.com/app/427520/discussions/0/4846525652477948433)

**Transport Fever 2, Workers & Resources, Manor Lords, Planet Coaster, Dwarf Fortress**
- Transport Fever 2: every person and every cargo unit is tracked from production to destination (player explanation). The game is CPU-limited late game. Fast-forward is deliberately capped when the CPU can't keep up (player citing June 2020 release notes, not verified). — [Steam discussion](https://steamcommunity.com/app/1066780/discussions/0/3963662566184614687)
- Workers & Resources: each citizen can be inspected individually in a fully simulated planned economy. Content Update #2 claimed a "100%" performance increase (blog claim, unverified). — [PC Gamer](https://www.pcgamer.com/uk/workers-and-resources-is-the-best-soviet-themed-city-builder-ive-ever-seen/); [Gaming Nexus](https://gamingnexus.com/News/44102/In-Workers--Resources-Soviet-Republic2c-video-game-mods-you)
- Manor Lords (UE5): a "nightmare" player save with 3,000 residents and 2,000 sheep ran at 2–5 FPS. Developer Greg Styczeń's fixes raised it to 30–40 FPS (Jan 2026). Pathfinding and large-unit collision were the main CPU problems. Lumen was left off as not worth the cost. — [ixbt.games, 12 Jan 2026](https://ixbt.games/en/news/2026/01/12/sozdatel-manor-lords-v-20-raz-povysil-fps-optimizaciiu-smogli-ulucsit-blagodaria-kosmarnomu-soxraneniiu-ot-fanaty-igry.html); [PCGH](https://www.pcgameshardware.de/Manor-Lords-Spiel-74074/News/Beta-Update-Bugfixes-neues-GUI-Performance-Optimierung-1544613/)
- Planet Coaster (Frontier): guest movement uses a fluid-dynamics simulation instead of per-guest pathfinding, to raise the count of fully simulated guests (thousands). Crowd audio uses a fixed-size park grid of cells, so cost is constant rather than per-guest. — [Audiokinetic/Frontier blog](https://www.audiokinetic.com/en/blog/planet-coaster-part-1-crowd-management-using-data-to-generate-dynamic-crowd-audio); [Frontier Q&A](https://forums.frontier.co.uk/threads/meet-the-team-q-a-owen-mc-carthy.494627/)
- Dwarf Fortress: mostly single-threaded. Over 60% of time in large forts goes to units taking turns, of which under 10% is pathfinding. Items such as boulders are temperature-checked in the main loop. An experimental 2023 multithreading option covers line-of-sight (wiki/community). — [DF Wiki: Lag](https://catsplode.com/index.php/Lag); [DF Wiki: System requirements](https://dwarffortresswiki.org/index.php/DF2014:System_requirements); [Steam discussion](https://steamcommunity.com/app/975370/discussions/0/3727324491572010578)

### Inferences
- Common pattern: static city data (buildings, lots) is mostly passive. Only a sparse active set ticks, and the rest sleeps or updates in round-robin buckets (Factorio buckets; CS1-style per-manager steps). For 200k buildings, a per-frame loop over all buildings is the anti-pattern. Split into an active list plus time-sliced buckets.
- Aggregation beats per-agent fidelity at scale. GlassBox's rule-less agents, Factorio's segments and solar groups, and Planet Coaster's fields and grids all cut cost. CS2 and Manor Lords show per-agent pathfinding is the late-game killer.
- Factorio's measured electric-network result shows memory bandwidth limits simple per-entity loops, so compact typed arrays (SoA) matter more than workers. This maps directly onto JS: TypedArrays and SoA, not object-per-building.
- CS2 shows a third-party engine framework adopted before it is mature can force large in-house rewrites. That is relevant to adopting three.js WebGPU or other immature paths (speculative analogy).

### Gaps
- No primary source found for CS1/CS2 internal per-building update intervals (e.g., "256-frame" building cycles). The figure is unverified and omitted.
- No official ECS archetype or chunk layout detail for CS2 beyond "full ECS". Anno 117, Frostpunk 1/2 and OpenTTD simulation internals were not found in this pass.

## 2. How do they render hundreds of thousands of buildings and props?

### Takeaway
CS2 is the reference failure: custom BatchRendererGroup instancing worked, but missing LODs on props and characters, no occlusion culling, and every object casting shadows into 4 cascades produced about 121M input vertices and 6,705 draw calls per frame, about 72% of them in shadows. The fixes were LOD work, shadow LOD/caster culling, and texture caps. Unity's Megacity shows 200k unique buildings are feasible with aggressive instancing and LOD.

### Cited Findings
- CS2 does not use Unity Entities Graphics. CO wrote its own ECS-to-renderer glue on BatchRendererGroup, with custom culling, skinning and virtual-texture streaming, on D3D11 + HDRP. The instance buffer starts at about 60 MB, about 50 floats per building instance (roads use more). — [Huhtala](https://blog.paavo.me/cities-skylines-2-performance/); [CO Reddit comment](https://twt.omada.cafe/r/CitiesSkylines/comments/17ekhtw/comment/k64zldb/?context=3)
- Huhtala's example frame was a town of about 1,000 people, on an RTX 3080 at 5120×1440, v1.0.11f1. The frame took 87.8 ms with 6,705 draw calls, about 53k API calls, about 121M input vertices, about 36M rasterized triangles, and about 6.7 GB VRAM (3.9 GB textures, 2.3 GB render targets). Shadow mapping took about 40 ms and 4,828 draw calls (72%). The main pass took about 16.7 ms and the pre-pass about 8.2 ms. — [Huhtala](https://blog.paavo.me/cities-skylines-2-performance/)
- CS2 failure specifics:
  - Characters have no LODs. Teeth alone are 6,108 vertices, and a character is about 56k vertices before hair and clothes. 13 sets of teeth were drawn covering zero pixels.
  - Props are heavy: clotheslines about 25–30k vertices, a parking booth over 40k with no LODs, and a log pile over 100k used only in shadows. An average low-density house is under 10k vertices.
  - Culling is frustum plus lenient distance only, with no occlusion culling.
  - Every object casts shadows at any size or distance into 4×2048² cascades, and the shadow-resolution setting was not wired up.
  - The main menu renders the full 3D scene behind the UI.
  
  — [Huhtala](https://blog.paavo.me/cities-skylines-2-performance/)
- CS2 fixes:
  - 1.0.11f1 made LOD independent of render resolution and tuned fog, DoF and GI.
  - 1.0.12f1 improved shadow LOD calculations so insignificant shadows are skipped, and capped character texture detail to cut VRAM.
  - CO prioritized adding and improving missing LODs for GPU, then CPU stutter and simulation.
  - Iceflake (2026) says LOD models, water simulation and terrain pathing still generate too many polygons. Teeth "veneers" were removed.
  
  — [TechRadar](https://www.techradar.com/gaming/consoles-pc/cities-skylines-2s-first-performance-patch-finally-fixes-an-annoying-error); [Shacknews 1.0.11f1 notes](https://www.shacknews.com/article/137554/cities-skylines-2-patch-notes-oct-26); [Neowin](https://www.neowin.net/news/cities-skylines-ii-developer-colossal-order-reveals-their-priorities-for-patching-the-game/); [PCGamesN](https://www.pcgamesn.com/cities-skylines-2/performance-blog)
- Unity's DOTS Megacity demo lists 4.5M mesh renderers, 200k unique building objects, 100k audio sources and 5,000 dynamic vehicles (vendor marketing, a demo rather than a game). — [Unity DOTS page](https://unity.com/dots)
- Anno 1800: Ubisoft Mainz artist David Shelton said buildings are "moveable, dynamic objects" with specific technical requirements for performance. The engine is the predecessors' engine reworked for detail rendering, with DX12 added. An Intel article covered taking laptops from 10 to 30 FPS (article now 404; details not retrieved). — [Ubisoft News](https://news.ubisoft.com/en-us/article/355243/Create-The-Unknown-How-Anno-1800-Put-A-Creative-Spin-on-the-Industrial-Revolution); [PCGH](https://www.pcgameshardware.de/Anno-1800-Spiel-61247/Tests/Benchmarks-Release-Systemanforderungen-1279717/)
- Transport Fever 2: Urban Games describes a terrain pipeline for maps over 120 sq mi at almost 1-yard detail, and texture streaming that unloads textures of out-of-view models (console). — [Xbox Wire](https://news.xbox.com/en-us/2022/12/02/transport-fever-2-console-edition-preview/)
- Factorio 2.0 decouples render from sim for robots: the renderer interpolates from a stored move intention, so simulation updates can be sparse. — [FFF #421](https://factorio.com/blog/post/fff-421)
- Townscaper composes buildings from modular pieces chosen by wave function collapse on an irregular grid, with marching-cubes-like corner rules (from Brick Block). — [Game Developer: How Townscaper works](https://www.gamedeveloper.com/game-platforms/how-townscaper-works-a-story-four-games-in-the-making)

### Inferences
- For 200k real buildings in WebGL2, the CS2 lessons translate to hard rules:
  - Every mesh, including small props, needs a LOD chain.
  - Shadow casters must be culled by size and distance, possibly with a separate cheap shadow LOD.
  - Draw calls must be instanced or merged (CS2's ~6.7k draws on D3D11 was already heavy; WebGL2 per-draw overhead is higher, which is my assessment, not sourced here).
  - Occlusion culling matters for dense urban views.
- "No fake buildings" is compatible with real LOD. CS2 and Megacity keep every real building and only reduce its geometric detail, so distance LOD of the same building is not a stand-in.
- A 50-float-per-instance budget (CS2) gives about 40 MB for 200k buildings. A slimmer per-instance record (transform plus a few IDs) is desirable in the browser (inference).

### Gaps
- No primary data found on Anno 1800/117 draw counts, impostors or HLOD, Frostpunk rendering, or OpenTTD (2D sprites, less relevant).
- No public post-2024 RenderDoc re-analysis of CS2 with current numbers was found.

## 3. How fast do they generate/load large cities, and how?

### Takeaway
Little primary data is public. The pattern that does appear is to precompute nothing that changes dynamically (Iceflake), stream textures (CS2 virtual texturing; TF2), and keep the simulation decoupled from rendering. Load-time numbers for big CS2 or Anno saves were not found from reliable sources.

### Cited Findings
- CS2 uses custom virtual-texture streaming for static 3D objects (feedback processing under 0.1 ms, cache update about 0.5 ms per frame). — [Huhtala](https://blog.paavo.me/cities-skylines-2-performance/)
- Iceflake: with a dynamic city, "nothing can be precomputed ahead of time or baked in". — [PCGamesN](https://www.pcgamesn.com/cities-skylines-2/performance-blog)
- 1.0.11f1 tried to reduce stutter when buildings spawn or level up, which shows building creation and mutation cost on the main path. — [Shacknews](https://www.shacknews.com/article/137554/cities-skylines-2-patch-notes-oct-26)
- Factorio save stability and ownership of merged segment data were open design problems when moving to segment storage. Derived structures (segments) must be rebuilt or serialized consistently across saves. — [FFF #148](https://factorio.com/blog/post/fff-148)
- Transport Fever 2 console edition streams and unloads textures for out-of-view models. — [Xbox Wire](https://news.xbox.com/en-us/2022/12/02/transport-fever-2-console-edition-preview/)

### Inferences
- For an always-loaded document, the transferable practice is to keep authoritative state compact and binary, and to treat GPU buffers, LOD meshes and spatial indices as derived data that can be rebuilt or cached in the background. Texture/VT-style streaming applies to GPU residency, not to the document. This matches the constraint that document tiling was rejected (inference).

### Gaps
- No reliable load times, save sizes or RAM figures were found for CS2 large cities, Anno 1800 or 117, TF2, or W&R. Steam anecdotes exist but were not verified, so no numbers are reported.
- The Intel Anno 1800 optimization article is offline (404), and an archived copy was not retrieved.
