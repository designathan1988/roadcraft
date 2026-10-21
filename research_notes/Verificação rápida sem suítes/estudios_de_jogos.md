# How game studios verify builds fast and catch regressions (2014–2026, with GDC talks)

Research date: 2026-10-21. Several primary pages were unreachable during this run: the GDC Vault slide PDFs redirected to a maintenance page, the Unreal Fest page returned 403, and the Paradox forum returned 500. Facts from those pages are listed under Gaps, not asserted.

## 1. Rare / Sea of Thieves: test types, counts, run times, what was worth it

### Takeaway
Rare gated every check-in on automated tests. About 90% of its tests were cheap unit tests, with fewer integration tests built as Unreal test maps. Small test sets ran on the build server roughly every 20 minutes, and slow multiplayer and performance tests ran overnight. A red build blocked all further commits until the change was rolled back. In 2017 Rare reported about 10,000 tests. The GDC 2019 talk presents a tiered model (unit, then actor/integration) and a remarkable bug-count graph.

### Cited Findings
- GDC 2019 talk "Automated Testing of Gameplay Features in Sea of Thieves" by Robert Masella (Rare). Its abstract says gameplay test automation "has traditionally not been embraced by the industry" because of the time it takes and because tests are hard to make reliable. Sea of Thieves had gameplay automation from the start. The talk covers the framework, the test types, and "what level of test coverage was found to be appropriate" — [GDC Vault](https://www.gdcvault.com/play/1026366/Automated-Testing-of-Gameplay-Features); [GDC news](https://www.gamedeveloper.com/production/-i-sea-of-thieves-i-devs-share-automated-testing-tips-at-gdc-2019)
- The GDC 2025 Automated Testing Roundtable describes the talk as showing how Rare used multiple tiers of tests in Unreal Engine. It also says the talk has the most astounding bug-count graph in GDC history — [autotestingroundtable.com](https://autotestingroundtable.com/)
- Rare's 2017 deck (GAIN 2017, "Automated testing for multiplayer game-AI in Sea of Thieves"), as quoted in search snippets: about 10,000 tests, of which about 90% are unit tests. Integration tests are built as Unreal maps. Every check-in requires testing, a core test set runs before each check-in, and tests run remotely on TeamCity — [eej.dk slides](http://eej.dk/gain/2017/slides/AUTOMATED_TESTING_FOR_MULTIPLAYER_GAME-AI_IN_SEA_OF_THIEVES.pdf). The PDF is image-based, so I could not verify the numbers in the body text myself.
- Game Developer, Part 4 of 4 (based on Rare's AI talk):
  - **Test types:** Most tests are C++ unit tests of single behaviours, for example "does a skeleton equip the expected item". Integration tests use test maps and Blueprints, including tests of AI behaviour trees. Multiplayer integration tests run virtual server and client processes over the network. Performance, network-latency and platform tests catch problems such as a build that runs fine on PC but slows down on Xbox One.
  - **Commit rule:** Developers must show in code review that their change passes the relevant tests.
  - **Schedule:** The build server runs the smaller tests roughly every 20 minutes. The larger multiplayer and performance tests run overnight.
  - **Red build:** Studio status screens go red when the build breaks. No commits are allowed until the change is rolled back, and the change goes back to its author.
  - **Infrastructure:** An extended UE Automation System, plus an external runner that tests built executables on a TeamCity build farm.
  - **Result:** More than 100 internal deployments of a complete, working build before launch.
  - [Game Developer](https://www.gamedeveloper.com/design/how-rare-automates-testing-for-ai-and-more-in-sea-of-thieves-part-4-of-4-)
- Jessica Baker (Rare engineer), 2018 post:
  - Every check-in must run against the current build and pass all tests.
  - Rare aims for a stable, production-ready build at all times, and a feature can go from idea to players in about 3 weeks.
  - Running unit tests before manual play catches simple bugs such as null dereferences.
  - Testing observable behaviour rather than internals kept tests stable through refactors.
  - What failed: subclassing to expose private members, global `GetWorld()` calls that made setup hard, and tests that read live production data assets and broke whenever designers changed the data.
  - [jessicabaker.co.uk](https://jessicabaker.co.uk/2018/03/11/tests-and-testability/)
- Jessica Baker also gave an Unreal Fest Europe 2019 talk, "Automated Testing at Scale in Sea of Thieves", about testing a constantly changing live service — [Unreal Engine events](https://www.unrealengine.com/events/unreal-fest-europe-2019/automated-testing-at-scale-in-sea-of-thieves)
- A Microsoft Learn episode (Pure Virtual C++ 2024, shader-code testing) says the Sea of Thieves project has "hundreds of thousands" of automated tests. This comes from a search snippet and counts the whole suite — [Microsoft Learn](https://learn.microsoft.com/en-us/shows/pure-virtual-cpp-2024/automated-testing-of-shader-code)

### Inferences
- Rare's speed comes from the shape of the suite, not from fast hardware:
  - most tests are unit tests that run in milliseconds,
  - a small core set gates each commit,
  - the slow multiplayer and perf tests are moved to nightly runs.
- Rare kept the suite trustworthy by testing behaviour rather than data. Tests tied to live design data were flaky by construction.

### Gaps
- The exact GDC 2019 figures could not be verified because the slides PDF was down. These include the per-type test counts, the run time per tier, the bug-count graph values and the coverage guidance. I also could not confirm the term "actor tests" or whether screenshot tests were used.

## 2. Other studios: Riot, Ubisoft, EA SEED, Paradox, Factorio, Supercell, Colossal Order, engine tooling

### Takeaway
Riot's Build Verification System gives the most concrete numbers: 5,500 test cases in about 18 minutes per build, about 100,000 per day, a small "Blocker" smoke set gating deployment, and new tests quarantined for a week to remove flakiness. Factorio's practice is the closest to a city-builder or simulation game: tests on small generated maps with CRC checks against saved values, run 24/7. Ubisoft's CLEVER predicts risky commits before they land. EA SEED adds RL agents on top of a scripted-bot pipeline.

### Cited Findings
**Riot – League of Legends (Feb 2016)**
- **Scale:**
  - About 5,500 test cases in about 18 minutes for each new build, which is about 100,000 per day.
  - Over 100 code and content changes per day, and a patch every 2 weeks.
  - Results within about an hour of check-in.
- **How tests work:** Tests and harness are in Python and drive the game through RPC endpoints on the client and server. Each test follows setup, execute, verify, teardown. Example: a Kog'Maw damage test checks damage against computed values with tolerances.
- **Gating:** Test sets are split into **BVSBlocker** (smoke tests that gate builds; builds that fail are not deployed) and **BVSCore** (functional tests, including every champion ability).
- **Flakiness controls:**
  - New tests must pass in **BVSStaging** for at least one week before promotion, and staging failures notify only test developers.
  - The library has no pure `sleep`; all waits poll for a condition. Early tests that relied on sleeps were fragile and hardware-dependent.
- **Load balancing:** Parallel test lists are balanced automatically using the average run time of the last 10 runs. Hand-balancing stopped scaling.
- **Results:**
  - The BVS found half of all critical or blocker bugs.
  - Bugs found by automation were resolved about 8 times faster than average.
  - The time from a defect being committed to the first failure report was 1–2 hours.
  - Bugs that slipped through were usually coverage gaps, not bad tests.
  - Automation freed testers for destructive testing; it did not replace manual testing.
- [Riot Games](https://www.riotgames.com/en/news/automated-testing-league-legends); [Riot Tech Blog](https://technology.riotgames.com/node/33)
- Riot's League client tests drive the Chromium-based UI with ChromeDriver and Cucumber.js — [Riot Tech Blog](https://technology.riotgames.com/node/50)

**Ubisoft La Forge – CLEVER / Clever-Commit**
- CLEVER (MSR 2018, Nayrolles & Hamou-Lhadj) flags risky commits before they reach the central repository. It combines code metrics with clone detection against past bug-introducing commits.
- On 12 Ubisoft systems it reached 79% precision and 65% recall, better than Commit-guru. It proposed fixes for 66.7% of risky commits — [Ubisoft La Forge](https://www.ubisoft.com/en-us/studio/laforge/news/69mh5FECbj12vBfL4HGC5C/clever-combining-code-metrics-with-clone-detection-for-justintime-fault-prevention-and-resolution-in-large-industrial-projects); [paper PDF](https://montreal.ubisoft.com/wp-content/uploads/2018/05/ICSE-CE-MSR-165.pdf)
- Productized as Clever-Commit together with Mozilla in 2019. Ubisoft claimed it could save up to 20% of programmer time; this is an internal estimate — [SD Times](https://sdtimes.com/ai/clever-commit-coding-assistant-uses-ai-to-protect-against-bugs/)
- Reported at release: a 60–70% detection rate with about 30% false positives — [Electronic Design](https://www.electronicdesign.com/embedded-revolution/catching-bugs-without-really-trying)

**EA SEED – bots and RL agents**
- SEED added an experimental RL system to an existing **scripted-bot** automated-testing pipeline to increase test capacity and coverage, on Battlefield 2042 and Dead Space (2023). The paper documents "the largest time sinks" of that move — [arXiv 2307.11105](https://arxiv.org/abs/2307.11105); [EA SEED](https://www.ea.com/seed/news/cog23-challenges-deploying-rl-agents-game-testing)
- EA's motivating estimate: manually testing 601 features in Battlefield V would take about 0.5M hours — [EA SEED](https://www.ea.com/seed/news/seed-ml-research-aaa-game-testing)
- In the 2020 SEED paper (CoG), deep-RL agents explore FPS maps to measure coverage and find exploits, unintended mechanics and map-difficulty issues — [arXiv 2103.15819](https://arxiv.org/pdf/2103.15819); [EA SEED](https://www.ea.com/seed/news/automated-game-testing-deep-reinforcement-learning)

**Factorio (Wube) – the closest analogue to a simulation or city builder**
- **FFF #60 (2014):** Two suites.
  - **Unit tests** with mocks. They load no graphics or prototypes and are "really fast to run". They cover multiplayer sync, the crafting queue and floating-point consistency across architectures.
  - **Integration tests** run the whole game with base data. Each test builds a **small map**, places entities, runs N updates and checks conditions. After each test, and sometimes during it, a **CRC is compared against pre-saved values**, which are regenerated when game logic changes on purpose. A determinism break in covered code shows up when the suite runs.
  - Black-box multi-instance multiplayer tests were planned.
  - [FFF #60](https://factorio.com/blog/post/fff-60)
- **FFF #62:** A nightly build server runs all suites in every configuration. Without the tests, the stable multiplayer release would have been delayed — [FFF #62](https://www.factorio.com/blog/post/fff-62)
- **FFF #186:** A server runs all tests 24/7 and emails the authors of the latest commits on failure. Changes surprisingly break unrelated tests — [FFF #186](https://www.factorio.com/blog/post/fff-186)
- **FFF #366:** GUI end-to-end tests click real widgets through the low-level input path. Before them, releases had crashed on simple GUI bugs.
  - **Test dependencies:** a test is examined only after its prerequisites pass, so the simplest failing case surfaces first.
  - **Policy:** every bug gets a covering test before it is fixed.
  - **Coverage:** OpenCppCoverage is used to find untested branches.
  - [FFF #366](https://www.factorio.com/blog/post/fff-366)
- **FFF #415 (2024):** A desync depended on CPU core count. The fix needed a test that pretends the machine has fewer cores. The bug dated from 2017 — [FFF #415](https://direct.factorio.com/blog/post/fff-415)
- No Factorio post I found gives a total test count or suite run time.

**Paradox (Clausewitz) – out-of-sync (OOS)**
- The HOI4 dev diary "Tech bugaloo II – Dragonslaying" says **telemetry** showed more multiplayer desyncs after a patch, which pointed to a new OOS bug. OOS is when the host and clients start acting differently; it is hard to pin down, and a resync button lets the host recover — [Paradox forum](https://admin-forum.paradoxplaza.com/forum/developer-diary/hoi4-dev-diary-tech-bugaloo-ii-dragonslaying.1188942) (search snippet; the page returned an error when fetched)
- A game checksum covers the loaded game data and mods. Mismatched mods mean you cannot join — [Steam discussion](https://steamcommunity.com/workshop/filedetails/discussion/217416366/2282708683267985928)

**Engine tooling**
- **Unreal Gauntlet:**
  - Launches sessions on many platforms, runs tests and checks results.
  - A session can contain every process the game needs, for example "four clients and a server".
  - An optional TestController plugin drives multi-step smoke tests.
  - Utilities parse logs and crashes and pull saved data off devices.
  - Builds must be supplied to it; it does not create them.
  - [Epic docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/gauntlet-automation-framework-overview-in-unreal-engine)
- **Unity Performance Testing extension:**
  - `Measure.Frames()` with warmup and a measurement count.
  - If the count is unset, it samples for about 500 ms.
  - Warmup waits for at least 3 full frames.
  - [Unity docs](https://docs.unity3d.com/Packages/com.unity.test-framework.performance@1.2/manual/index.html)
  - Official docs did not show a built-in baseline comparison or CI fail gate; teams build that themselves (search summary).

**Supercell / Colossal Order**
- Supercell job postings describe a central automation team behind "hundreds of automated tests" run every day, and end-to-end automation across games — [Supercell careers](https://supercell.com/en/careers/senior-release-engineer-clash-royale/1881430); [Hitmarker](https://hitmarker.net/jobs/supercell-quality-engineering-lead-4698387)
- No public source found for Colossal Order (Cities: Skylines).

### Inferences
- A common pattern across Riot, Rare and Factorio:
  - a **small smoke or blocker set** gates each commit, in minutes;
  - a broad functional set runs per build, in tens of minutes;
  - heavy multiplayer, perf and soak runs happen nightly.
  - Nobody runs everything on every commit.
- For simulation games, Factorio's "small map + N ticks + CRC vs. stored value" is a cheap golden-state test that catches any unintended logic change, not only crashes. The cost is regenerating the stored CRCs whenever logic changes on purpose.

### Gaps
- Activision: I found no public source.
- Colossal Order: no public source.
- Supercell: no concrete numbers.
- EA SEED: bot counts and soak-test details are in the full paper, which I did not read.
- Gauntlet: no studio figures for perf usage.

## 3. Replay / determinism, perf gates, bots and soak tests, and what does NOT work

### Takeaway
Per-tick state checksums with record-and-replay localize a regression or desync to the **exact first tick** and usually to a single variable. A full-state CRC every tick is too slow for normal runs (single-digit FPS in Factorio), so studios use a light per-tick hash in normal play and save the heavy mode for debugging. Perf gates are percentile frame-time and memory budgets compared with a stored baseline. What fails in practice:
- sleep-based waits,
- tests tied to changing design data,
- unquarantined new tests,
- tests that go stale as design changes.

### Cited Findings
- **Factorio FFF #47:** In debug mode the game computes a CRC of the **whole map every tick** and writes a human-readable save every tick. Replaying the save with the same checks throws on the first CRC mismatch.
  - The two saves for that tick usually differ by "a single variable", and the fix is often simple once the divergence is found.
  - Cost: the game slows to "at most units of FPS", so this mode is for debugging only.
  - [FFF #47](https://factorio.com/blog/post/fff-47)
- **Factorio FFF #55:** In live multiplayer, a "lighter, incomplete but very fast" per-tick check compares players' states and triggers a resync on mismatch — [FFF #55](https://factorio.com/blog/post/fff-55)
- **General lockstep practice (secondary, blog-level sources):**
  - Hash all mutable state each tick, including the RNG. Per-subsystem hashes point to which system drifted first.
  - The starting state plus the tick-stamped command stream is a complete replay, so it can serve as a regression test.
  - Usual causes are floating-point non-determinism, uninitialized memory and hash-map iteration order.
  - [Bugnet blog](https://bugnet.io/blog/how-to-debug-desync-in-deterministic-lockstep-games); [SpringRTS Syncing System](https://springrts.com/wiki/Syncing_System)
- **Perf gates:**
  - Rare ran performance and platform tests overnight, which caught builds that ran fine on PC but slowed down on Xbox One — [Game Developer](https://www.gamedeveloper.com/design/how-rare-automates-testing-for-ai-and-more-in-sea-of-thieves-part-4-of-4-)
  - NVIDIA GDC15 "Stutter Avoidance" argues for percentile frame-time metrics, used as regression tests that prove a fix — [NVIDIA GDC15 PDF](https://developer.download.nvidia.com/assets/events/GDC15/GEFORCE/Stutter_Avoidance_GDC15.pdf)
  - Arm Performance Advisor runs headless in CI on device farms, tracks budgets across check-ins and alerts as builds approach a budget — [Samsung/Arm](https://developer.samsung.com/gamedev/blog/en-us/2020/09/29/android-game-analysis-with-arm-mobile-studio)
- **Bots and soak tests:**
  - Rare used multiplayer integration tests with virtual server and client processes.
  - Gauntlet supports sessions of several clients plus a server.
  - EA uses scripted bots plus RL agents (sources above).
- **What does NOT work:**
  - Sleeps that made tests fragile and hardware-dependent — [Riot](https://www.riotgames.com/en/news/automated-testing-league-legends)
  - Promoting new tests without a week in staging — [Riot](https://www.riotgames.com/en/news/automated-testing-league-legends)
  - Tests that read live design data, subclass internals or depend on globals — [Jessica Baker](https://jessicabaker.co.uk/2018/03/11/tests-and-testability/)
  - Studies of developers:
    - Developers hesitate to automate because tests go stale quickly as designers change direction — [Microsoft Research](https://www.microsoft.com/en-us/research/publication/cowboys-ankle-sprains-and-keepers-of-quality-how-is-video-game-development-different-from-software-development)
    - An ICSE 2022 GAS survey found developers skeptical of automated test agents. It recommends approaches that do not disrupt existing workflows and that focus on the test oracle — [arXiv 2202.12777](https://arxiv.org/abs/2202.12777v2)
    - A GameDriver industry survey reports flaky tests and test-script authoring as the main pain points — [GameDriver](https://gamedriver.io/blog/2021/july/state-of-the-game-survey-results)

### Inferences
- For a simulation game, the fastest high-signal check is:
  1. load a small fixed scenario;
  2. advance N ticks headless;
  3. compare a state hash (and optionally per-subsystem hashes) with a stored golden value.

  This runs in seconds and catches any behaviour change. A failure then needs either an intended golden update or a per-tick replay to find the divergence.
- Perf gates only work with percentiles over a fixed camera path or scenario, plus a stored baseline and a tolerance. A single average frame-time sample is noisy.

### Gaps
- No studio gave public figures for false-positive rates of perf gates or for soak-test duration.
- No public source found on Age of Empires sync checks ("1500 Archers"), Paradox OOS tooling internals, or Cities: Skylines testing.
