# Scalable traffic and citizen simulation for a ~200k-building city (web workers / WASM)

Context of our game: micro window of 750 m around the camera, aggregated meso far; every new car runs A* to a random map-border exit (cost grows with map size); meso rates stored in Maps; whole meso state published each tick.

Research budget note: ~18 tool calls. Several primary pages (A/B Street discrete-event doc, TU Berlin distributed QSim PDF) returned 404; Citybound blog not reachable via search. Those are listed as gaps.

## 1. Multi-resolution traffic (micro near camera, meso/macro far) and handoff

### Takeaway
The professional standard is a vehicle-based queue (link/segment) model far away and a car-following model in a bounded area, with vehicles keeping identity across the boundary and entering the micro area only when there is space (Aimsun hybrid). Queue models (SUMO MESO, MATSim QSim) are up to ~100x cheaper than micro because each link is a FIFO with a flow capacity and a storage capacity, updated per vehicle exit event rather than per vehicle per tick.

### Cited Findings
- SUMO MESO is a queue-based model derived from Eissfeldt's work; it "runs up to 100 times faster" than SUMO's microscopic model; it does not model current speeds, so acceleration parameters have no effect — [SUMO docs: Meso](https://sumo.dlr.de/docs/Simulation/Meso.html)
- SUMO MESO splits each edge into equal-length segments (GUI default 100 m; example config uses `edgeLength="98"`); vehicles leave each segment queue roughly FIFO; each segment is classified jammed/free by an occupancy threshold (`--meso-jam-threshold`); minimum headway depends on the jam state of current and next segment, scaled by 1/lane count and vType tau — [SUMO docs: Meso](https://sumo.dlr.de/docs/Simulation/Meso.html)
- SUMO MESO default headways: tauff 1.13 s (free->free), taufj 1.13 s (free->jammed), taujf 1.73 s (jammed->free), taujj 1.4 s (backward gap travel in a jam); an alternative Link Transmission Model mode (`--meso-ltm`) tracks gaps moving upstream — [SUMO docs: Meso](https://sumo.dlr.de/docs/Simulation/Meso.html)
- SUMO MESO junction control is off by default (recommended for motorways or with penalty options); TLS/minor-road penalties replace explicit junction modeling; individual traffic lights can be modeled in detail via `meso.tls.control` — [SUMO docs: Meso](https://sumo.dlr.de/docs/Simulation/Meso.html)
- A June 2026 paper finds SUMO-MESO does not fully comply with LWR theory and "systematically underestimate[s] congestion"; proposes a discrete-time link transmission model with backward-travelling space for spillback — [arXiv 2606.09282](https://arxiv.org/pdf/2606.09282)
- MATSim QSim: each link has free-flow travel time, flow capacity (vehicles that can leave per time unit) and storage capacity (vehicles that physically fit); a front vehicle leaves only when its free-flow exit time passed, outflow capacity allows and the next link has room; a "stuck time" lets a long-waiting vehicle bypass storage to avoid gridlock — [Horni & Axhausen, Gridlock modeling with MATSim (STRC 2014)](https://www.strc.ch/2014/Horni_Axhausen.pdf)
- MATSim runs large scenarios on a population sample and scales capacities: e.g. 25% sample with flowCapacityFactor 0.25 and storageCapacityFactor 0.5 — [Winnipeg AMoD study, arXiv 2410.11416](https://arxiv.org/pdf/2410.11416); sample-vs-100% comparison in [MUM 2025 paper 30](https://matsim.org/conferences/mum2025/abstracts/MUM25_paper_30.pdf)
- Reported MATSim scale: Zurich 1.62 M agents / 163 k links in ~20 min on a 128 GB machine; Switzerland 1 M roads / 7.3 M agents (2009) — via search summaries of [Graur et al. (Hermes)](https://www.dpss.inesc-id.pt/~rbruno/papers/dgraur-abmtrans21.pdf) and [Waraich et al. STRC 2009](https://www.strc.ch/2009/Waraich.pdf) (hardware-specific, indicative only). Hermes is a faster re-implementation of QSim's common operations via data-structure optimization (same source).
- Daganzo's Cell Transmission Model (Transp. Res. B 28(4):269–287, 1994) is the discrete analog of the LWR hydrodynamic model; it reproduces queue build-up, propagation and dissipation and density jumps (shocks) without explicit shock tracking; the 1995 network extension handles junctions with known OD/turning proportions — [ITS Berkeley](https://its.berkeley.edu/publications/cell-transmission-model-dynamic-representation-highway-traffic-consistent-hydrodynamic); [Wikipedia: CTM](https://en.wikipedia.org/wiki/Cell_Transmission_Model); [CTM network paper](https://its.berkeley.edu/publications/cell-transmission-model-network-traffic); implementation tutorial [tabenchmark ctm](https://tabenchmark.readthedocs.io/en/latest/tutorials/05-dnl/01-ctm.html)
- Aimsun hybrid meso–micro: a vehicle is simulated meso until it reaches the boundary of the micro area, enters micro, and returns to meso afterwards; because meso tracks individual vehicles a trip can switch modes; vehicles whose route avoids the micro area stay meso — [Aimsun docs: Hybrid simulator](https://docs.aimsun.com/next/24.0.0/UsersManual/HybridSimulator.html); [Aimsun technical note](https://www.aimsun.com/technical-notes/hybrid-simulation/)
- Aimsun meso->micro entry uses the same space-availability check as micro vehicle entry: if space, earliest entry time comes from the car-following model; if not, retry next step. Both modes share one network and one database of flow/speed/delay for consistent route choice — [Aimsun docs](https://docs.aimsun.com/next/24.0.0/UsersManual/HybridSimulator.html); consistency at transition analysed by Casas, Perarnau & Torday 2011 — [repositori.uvic-ucc.cat](https://repositori.uvic-ucc.cat/handle/10854/2823)
- Aimsun also offers hybrid macro–meso — [Aimsun note](https://www.aimsun.com/technical-notes/hybrid-macro-meso-simulation-in-aimsun-next/)

### Inferences
- For our game: far model = per-link (or per ~100 m segment) FIFO queue with flowCap, storageCap, freeFlowTime, stored in typed arrays indexed by link id (not Maps). Cost is O(vehicles exiting links) per tick, not O(vehicles).
- Handoff: keep vehicle identity (route + current link + entry time) in meso; when the camera window covers a link, spawn micro cars at queue positions; on leaving, push into the downstream link queue with exit time = now. Use Aimsun's "enter only if space, else retry next step" rule at the boundary.
- Sampling trick (MATSim): simulating e.g. 25% of trips far away with capacities scaled (flow 0.25, storage ~0.5) bounds far cost; only the micro window needs full density for visuals.
- SUMO-MESO's known congestion underestimation suggests adding spillback (storage capacity / backward gap) if far jams matter for gameplay.

### Gaps
- No primary source found giving SUMO MESO's absolute vehicles/second throughput on given hardware.
- TU Berlin distributed QSim paper (claim of "up to 100x faster") PDF returned 404; only a search snippet supports it.

## 2. How games do it (CS1, CS2, SimCity 2013, A/B Street, Citybound, Transport Fever)

### Takeaway
Commercial city builders simulate every vehicle as an agent with a hard instance cap (CS1) or with no hard cap but pathfinding as the dominant late-game CPU cost (CS2). None of the sources show a game using a true meso far model; they instead cap agents, limit what spawns, and queue path requests.

### Cited Findings
- Cities: Skylines (1) caps active vehicles at 16,384 and citizen instances at 65,536 (array sizes; "Citizen Instances [65536] | [65535]"); hitting the vehicle cap stops spawning; mods to raise it have mixed results; CitizenUnits is a separate, lower base-game cap. These are community-verified (mod authors/forum), not official — [Steam discussion](https://steamcommunity.com/app/255710/discussions/0/152390648082792963); [Steam workshop discussion](https://steamcommunity.com/workshop/filedetails/discussion/531738447/481115363859488292); [Steam workshop discussion 2](https://steamcommunity.com/workshop/filedetails/discussion/529979180/483366528917557909). Note: the "65k vehicle limit" in our brief is actually the citizen-instance limit; the vehicle limit is 16,384 (one post reports ~21k with mods, conflicting).
- CS1 path requests use a fixed PathUnit buffer; when exhausted, transit lines break and trucks cannot deliver; "More PathUnits" mod expands the array and patches pathfinding thread arrays; TM:PE replaces the PathManager — [More PathUnits changelog](https://steamcommunity.com/sharedfiles/filedetails/changelog/2710657019); [Steam thread](https://steamcommunity.com/app/255710/discussions/0/6406956248977521381)
- CS2 (2023 Traffic AI feature): path cost combines Time, Comfort, Money (incl. parking availability) and Behavior; agents accelerate/brake, change lanes, reroute around accidents; pathfinding "take[s] advantage of all the available processing power of multicore CPUs"; "no hard limits" on agents — [Paradox: CS2 Traffic AI](https://paradoxinteractive.com/games/cities-skylines-ii/features/traffic-ai); [TechRaptor](https://techraptor.net/gaming/news/cities-skylines-2-gets-new-video-all-about-advanced-traffic-ai); [Colossal Order](https://colossalorder.fi/?p=1597)
- CS2 post-launch: simulation issues appear late game because "more citizens equals more pathfinding requests"; fixes included stopping citizens getting stuck in buildings, cutting excessive pathfinding requests, curbing bicycle pathing, plans for "smarter pathing" and lower population density — [PCGamesN, CS2 performance blog](https://www.pcgamesn.com/cities-skylines-2/performance-blog)
- CS2 anecdote: in a 360k-pop city, removing 3 taxi depots raised sim speed from 74% to 94% and pending path queries from 250 to 20 (player report, anecdotal) — via search summary of [Steam CS2 discussions](https://steamcommunity.com/app/949230/discussions/0/6516193716681375839)
- SimCity 2013 GlassBox: agent-based; every car and pedestrian is an agent travelling to a "sink" building; at launch agents took the shortest-distance path ignoring congestion, causing gridlock; later patches added congestion-aware rerouting/road weights — [PC Gamer: Inside GlassBox](https://www.pcgamer.com/uk/simcity-inside-the-glassbox-engine); [GameWatcher 2013](https://www.gamewatcher.com/2013-15-03-maxis-begins-turning-attention-to-improving-the-simulation-in-simcity); [Game Developer GDC 2012](https://gamedeveloper.com/design/gdc-2012-breaking-down-em-simcity-em-s-glassbox-engine)
- A/B Street: individual drivers, cyclists, pedestrians and buses on OSM, demand from real trip models (Seattle Soundcast 2014); docs describe a discrete-event traffic sim in the `sim` crate — [bikesiliconvalley poster](https://bikesiliconvalley.org/2020/07/poster_dustin-carlino/); [abstr Montlake vignette](https://cran.uni-muenster.de/web/packages/abstr/vignettes/montlake.html); [A/B Street trafficsim docs](https://a-b-street.github.io/docs/tech/trafficsim/index.html)
- Citybound (Anselm Eickhoff): 2014 diary replaced looping traffic animation with trips tied to each citizen's routine; planned lane-based roads and individual cars/pedestrians — [GameWatcher 2014](https://www.gamewatcher.com/2014-07-05-new-dev-diary-for-citybound-explores-daily-lives-of-citizens); [EverybodyWiki: Citybound](https://en.everybodywiki.com/Citybound)

### Inferences
- The CS1 lesson is that bounded arrays (vehicles, path units) bound cost but cause visible failures when full; a bounded far model must degrade gracefully (aggregate) instead of silently dropping trips.
- The CS2 lesson is that pathfinding request volume, not vehicle motion, is what scales badly with population; request rate must be throttled/cached, and spurious requests (stuck agents, failed paths) removed.
- SimCity's gridlock shows that distance-only routing on a static graph produces pathological jams; costs should include a cheap congestion term from meso link travel times.

### Gaps
- Could not retrieve A/B Street's discrete-event page (404) or any published agent counts/ms per tick for A/B Street.
- Citybound blog (blog.cityboundsim.com) posts on actor-based lanes/microtraffic not retrieved.
- No source found for Transport Fever's traffic/pathfinding internals or for a GDC "traffic in games" talk with numbers.
- No official CS2 numbers on agents simulated or ms per sim tick.

## 3. Pathfinding at scale (A*, HPA*, CH, CRP, ALT, caching)

### Takeaway
Speed-up techniques for road graphs trade preprocessing for query time: ALT ~1 ms on continental graphs (with reach), CH queries of milliseconds after preprocessing, CRP with metric-independent partition + fast "customization" (seconds on CPU, ~60 ms on GPU continentally) for changing costs (traffic). For a city-sized graph (tens of thousands of nodes), these give microsecond-to-sub-ms queries; HPA* gives up to 10x over optimized A* at <=1% suboptimality.

### Cited Findings
- HPA* (Botea, Müller, Schaeffer 2004): partitions the map into clusters, precomputes optimal crossing distances; up to 10x faster than highly-optimized A*, paths within 1% of optimal — [Botea et al. PDF](https://webdocs.cs.ualberta.ca/%7emmueller/ps/hpastar.pdf); [papersdb](https://papersdb.cs.ualberta.ca/~papersdb/view_publication.php?pub_id=585)
- DHPA* searches up to an order of magnitude faster than HPA* but uses significantly more memory and gives slightly less optimal paths; SHPA* only for static maps — [Kring, Champandard, Samarin (AAAI)](https://cdn.aaai.org/ojs/12397/12397-52-15925-1-2-20201228.pdf)
- Contraction hierarchies (Geisberger et al.): preprocessing adds shortcut edges skipping less important vertices; exploits road-network hierarchy; exact shortest paths at continental scale — [Wikipedia: CH](https://en.wikipedia.org/wiki/Contraction_hierarchies); [KIT ITI](https://ae.iti.kit.edu/english/1550.php)
- Earlier highway hierarchies (Sanders & Schultes) preprocess USA/Western Europe in a few hours in linear space with ~8 ms queries, ~2000x faster than Dijkstra — [Springer 10.1007/11561071_51](https://link.springer.com/doi/10.1007/11561071_51)
- Mobile CH on a 400 MHz Nokia N800: cold query 56 ms — [KIT slides](https://ae.iti.kit.edu/1548.php)
- Customizable CH for traffic assignment: metro area of 2.7 M inhabitants, 1-hour morning peak (~250 k trips) flow computation dropped from 90.9 s to 14.1 s on one core — [KIT ITI](https://ae.iti.kit.edu/english/1554.php) / [ACM 10.1145/3362693](https://api.crossref.org/works/10.1145%2F3362693)
- CRP (Delling, Goldberg, Pajor, Werneck, SEA 2011): metric-independent multilevel overlay preprocessing; customization computes overlay costs from a metric in a few seconds (enables real-time traffic updates); queries in milliseconds on continental networks — [CRP paper](https://i11www.iti.kit.edu/extra/publications/dgpw-crp-11.pdf); [Microsoft Research](https://www.microsoft.com/en-us/research/publication/customizable-route-planning/)
- GPU CRP customization: new metric on continental network (tens of millions of segments) in ~60 ms, ~10x faster than optimized parallel CPU — [gCRP Euro-Par 2014](https://www.microsoft.com/en-us/research/wp-content/uploads/2014/01/gCRP_EuroPar2014.pdf)
- ALT (Goldberg & Harrelson, SODA 2005): A* with landmark lower bounds via triangle inequality; store distances from each vertex to a small constant number of landmarks; constant-time bounds; much better than Euclidean A* on road networks — [GH05 PDF](https://www.cs.princeton.edu/courses/archive/spring06/cos423/Handouts/GH05.pdf); [MSR](https://www.microsoft.com/en-us/research/publication/computing-the-shortest-path-a-search-meets-graph-theory)
- ALT + reach: random US/Europe queries in ~1 ms after 1–2 h preprocessing; landmark selection quality matters strongly — [Goldberg, Kaplan, Werneck WEA 2007](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/goldberg-sp-wea07.pdf); [Landmark selection slides](https://homes.di.unimi.it/righini/Didattica/OttimizzazioneSuGrafo/MaterialeOG/Goldberg%20Werneck%20-%20Landmarks%20selection%20%28slides%29.pdf)

### Inferences
- Our "A* to a random border exit" is a degenerate case: all through-traffic goes to a small set of exits. One reverse Dijkstra per exit (a per-exit next-hop table / flow field over the road graph) makes every spawn O(1) lookup; recompute incrementally/time-sliced when roads change or when meso travel times update. Memory ~ exits x nodes x 4 bytes (e.g. 16 exits x 100k nodes = 6.4 MB).
- For general OD trips, CRP-style partition (cells of the city) maps naturally onto our chunk grid: road edits only re-customize the touched cell, and congestion-updated costs only need customization (seconds on continental scale -> sub-ms to ms on a city).
- Choosing destinations within a local window (or choosing a cell first, then a building) bounds the search; HPA*-style cell abstraction gives ~10x with ~1% detour.
- Path caching: many agents share (origin cell, destination cell) pairs; caching by cell pair with a version stamp invalidated by road edits is the obvious approach (no primary source found quantifying a game's cache hit rate).

### Gaps
- No source found on what CS2 actually uses (A*/Dijkstra variant, hierarchies, caching); only "multicore".
- No primary source found for flow fields applied to road traffic in games (flow fields are known from RTS crowd pathing; not researched here).
- No JS/WASM benchmarks of CH/CRP found (e.g. fast_paths crate WASM numbers).

## 4. Time slicing, fixed budgets, ambient population, publishing deltas; concrete numbers

### Takeaway
The sources support bounded-cost designs indirectly: queue models update only at link exits (event-driven), MATSim downsamples populations, CS1 bounds with fixed arrays and a path request buffer, CS2 shows uncontrolled path-request queues are what kill sim speed. Direct sources on game time-slicing budgets and delta publishing were not found.

### Cited Findings
- CS1 bounds: 16,384 vehicles, 65,536 citizen instances; path requests limited by a fixed PathUnit buffer and dedicated pathfinding threads — see Section 2 sources ([Steam](https://steamcommunity.com/app/255710/discussions/0/152390648082792963), [More PathUnits](https://steamcommunity.com/sharedfiles/filedetails/changelog/2710657019)).
- CS2: pending path queries as a queue; dropping 250 -> 20 pending raised sim speed 74% -> 94% (anecdotal) — [Steam CS2](https://steamcommunity.com/app/949230/discussions/0/6516193716681375839)
- SUMO MESO: up to 100x faster than micro — [SUMO docs](https://sumo.dlr.de/docs/Simulation/Meso.html)
- MATSim: 1.62 M agents/163 k links ~20 min per simulated day on a server — [Hermes paper](https://www.dpss.inesc-id.pt/~rbruno/papers/dgraur-abmtrans21.pdf)
- CCH traffic assignment: 250 k trips routed in 14.1 s single core (~56 µs/trip on a 2.7 M-inhabitant metro graph) — [KIT ITI](https://ae.iti.kit.edu/english/1554.php)

### Inferences
- Derived budget: at ~56 µs/route (CCH, native), a 2 ms/tick routing budget in a worker gives ~35 routes/tick native; JS is plausibly 2–5x slower (not sourced). With per-exit next-hop tables, border-exit routes cost ~0.
- Per tick: process (a) micro cars in the 750 m window (bounded by window area), (b) meso link-exit events from a time-bucketed queue (bounded by a fixed event budget, overflow carries over), (c) a fixed number of path requests from a FIFO; anything beyond budget waits a tick (CS2/CS1 pattern) rather than growing frame time.
- Publish only links whose density/state changed (dirty bitset + compact Float32Array of changed ids/values via transferable buffers) instead of the whole meso state; far visuals only need per-link density anyway.
- Parked cars and pedestrians: spawn ambient agents only inside the micro window from meso link densities and building occupancy; no source quantified this for a game.

### Gaps
- No sourced ms-per-tick or memory figures from any commercial city builder.
- No source found on Transport Fever, Citybound or A/B Street time-slicing or delta publishing.
- No source found for SharedArrayBuffer/transferable performance specific to traffic sims.
