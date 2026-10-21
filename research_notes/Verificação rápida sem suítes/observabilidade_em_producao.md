# Observabilidade em produção e lançamento seguro (Electron + three.js WebGL2, jogo pago, 2026)

## 1. Crash and error reporting for Electron (crashReporter, Sentry, BugSplat, Backtrace, pricing, privacy)

### Takeaway
Electron's own `crashReporter` (Crashpad) covers native crashes from every process created after `start()` and uploads Breakpad-format minidumps to any compatible server. `@sentry/electron` adds JS errors from main, renderer, preload and utility processes on top of that, plus release health and source maps. The free tiers of Sentry (5k errors), BugSplat (15k crashes/month) and Backtrace (25k errors, per a secondary source) are enough for a small studio to start with.

### Cited Findings
- Electron uses Crashpad. Its upload protocol matches Breakpad, so any server that accepts Breakpad minidumps can receive Electron reports. Once started, the reporter cannot be disabled. It is a no-op in Mac App Store builds. — [Electron crashReporter docs](https://www.electronjs.org/docs/latest/api/crash-reporter)
- Call `crashReporter.start()` early, before `app.on('ready')`. Renderers created before start are not monitored. Main options:
  - `submitURL`
  - `uploadToServer` (`false` keeps reports on disk only)
  - `compress` (default `true`, gzip)
  - `rateLimit` (at most 1 upload per hour)
  - `extra` (main process only)
  - `globalExtra` (all processes, immutable after start)
  - Limits: keys up to 39 bytes, values up to 20,320 bytes.
  — [Electron crashReporter docs](https://www.electronjs.org/docs/latest/api/crash-reporter)
- Node child processes (`child_process.fork`) are monitored automatically. For `utilityProcess`, only `globalExtra` is sent. Renderer-side crashReporter methods are deprecated since v10; use preload plus `contextBridge`. Dumps go to `app.getPath('crashDumps')`, and the upload is a multipart POST with field `upload_file_minidump`, `ver`, process type, GUID, etc. — [Electron crashReporter docs](https://www.electronjs.org/docs/latest/api/crash-reporter)
- `@sentry/electron` (current docs) requires **Electron ≥ 35.0.0**. Installation is `npm install @sentry/electron`. You initialize it separately in each process:
  - `@sentry/electron/main`, as early as possible
  - `@sentry/electron/renderer`; renderer events go through main, so dsn/release set in the renderer are ignored
  - `@sentry/electron/utility`, in each utility process
  - the preload script, when `contextIsolation: true`
  If you change `userData`, do it before `init`. Source maps are uploaded with `npx @sentry/wizard@latest -i sourcemaps`. — [Sentry Electron guide](https://docs.sentry.io/platforms/javascript/guides/electron/)
- Version history:
  - SDK v8 moves the underlying JS SDKs from v10 to v11 and sets Electron 35 as the minimum. It makes stream mode the default and replaces `sendDefaultPii` with `dataCollection`. — [Sentry migration v7→v8](https://docs.sentry.io/platforms/javascript/guides/electron/migration/v7-to-v8/)
  - 7.15.0 added JS stack parsing from renderer out-of-memory (OOM) minidumps. — [socket.dev diff 7.15.0](https://socket.dev/npm/package/@sentry/electron/diff/7.15.0)
  - 7.11.0 updated the underlying Sentry SDKs to v10.47. — [CHANGELOG 7.11.0](https://cdn.jsdelivr.net/npm/@sentry/electron@7.11.0/CHANGELOG.md)
- Native crashes in Sentry:
  - `SentryMinidump` is the default and gives fuller context.
  - `electronMinidumpIntegration()` uses Electron's own `crashReporter` uploader, so renderer and GPU crashes carry only minimal context.
  - Enabling one disables the other, which avoids duplicates.
  — [Sentry ElectronMinidump](https://docs.sentry.io/platforms/javascript/guides/electron/configuration/integrations/electronminidump/)
- Sentry privacy: by default the SDK sends user identity data, HTTP bodies and query params. The `dataCollection` option controls this (`userInfo` in main governs IP inference for all processes). Keys such as `auth` and `password` become `[Filtered]`. — [Sentry Electron guide](https://docs.sentry.io/platforms/javascript/guides/electron/)
- Sentry pricing (2026):

  | Plan | Price | Users | Errors | Retention |
  |---|---|---|---|---|
  | Developer | $0 | 1 | 5k | 30 days |
  | Team | $29/mo, or $26/mo annual | unlimited | 50k | up to 90 days |
  | Business | $89/mo, or $80/mo annual | unlimited | 50k | up to 90 days |

  Every plan includes 50 replays, 1 GB of attachments (where minidumps count), 5M spans and 1 cron monitor. Logs are $0.50/GB. Per-unit prices for extra errors and replays are not on the main page (see docs.sentry.io/pricing). — [Sentry pricing](https://sentry.io/pricing/)
- Self-hosted Sentry:
  - Hardware: at least 4 CPU cores, 16 GB RAM plus 16 GB swap (32 GB recommended), 20 GB disk with high IOPS, Docker ≥19.03.6 and Compose ≥2.32.2.
  - License: FSL, which allows internal use but not resale, and becomes Apache 2.0 after 2 years.
  - Support: "no guarantees or dedicated support".
  — [Sentry self-hosted](https://develop.sentry.dev/self-hosted/)
- BugSplat pricing:

  | Plan | Price | Users | Crashes/month | Storage | Retention |
  |---|---|---|---|---|---|
  | Free | $0 | 3 | 15,000 | 100 GB | 1 month |
  | Team | $37/mo annual | 10 | 25k | 250 GB | 3 months |
  | Business | $208/mo annual | 20 | 50k | 500 GB | 6 months |

  Business adds an external symbol server and PII obfuscation. The pricing page does not mention Electron. — [BugSplat pricing](https://www.bugsplat.com/pricing/)
- Backtrace (Sauce Labs) pricing, from a competitor's source:
  - Free Developer plan: 1 dev, 25k errors/month, 1 month retention, 10 GB.
  - Standard: $900/user/year for "mobile + PC".
  - Unverified at the primary source.
  — [Bugnet blog](https://bugnet.io/blog/backtrace-alternative-for-indie-game-studios); product page [Sauce Labs error reporting](https://saucelabs.com/platform/error-reporting)

### Inferences
- Minimum setup for Roadcraft:
  - `@sentry/electron` in main, renderer, preload, utility and workers.
  - The default `SentryMinidump` integration.
  - Upload of source maps (Vite) and Electron symbols.
  - `release` = app version plus the git SHA.
  - `globalExtra` / tags carrying GPU, driver and quality level.
- Electron 44 is above the minimum of 35, so SDK v8 is compatible.
- Because a crash dump can contain memory with personal data, LGPD/GDPR call for explicit opt-in on first launch, a privacy policy, and `dataCollection` set to the minimum. Upload gating can be done in `beforeSend` / `uploadToServer:false` until consent is given.

### Gaps
- Bugsnag and Raygun pricing/Electron support were not checked within the call budget.
- Official per-unit prices for extra errors and attachments in Sentry are not on the main page.
- No official Sentry text specific to LGPD was found. The consent inference is mine, from the general requirements.

## 2. Capturing WebGL-specific failures and performance telemetry in the field

### Takeaway
Treat the GPU string as optional. In Chromium/Electron it is usually available via `WEBGL_debug_renderer_info`, but it is deprecated in Firefox and blocked under `resistFingerprinting`. Recording context lost events, shader compilation logs and frame times has to be instrumented by hand and sent as events/metrics, because no SDK does it automatically for WebGL.

### Cited Findings
- `WEBGL_debug_renderer_info` (UNMASKED_RENDERER/VENDOR) has been "widely available" since 2017. In Firefox it is disabled when `privacy.resistFingerprinting` is on. — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/WEBGL_debug_renderer_info)
- Firefox logs a deprecation warning ("use RENDERER"). Babylon.js falls back to "Unknown renderer" when the extension is missing. — [Babylon.js forum](https://forum.babylonjs.com/t/firefox-webgl-debug-renderer-info-is-deprecated/27017); fingerprinting rationale in [Mozilla bug 1722782](https://bugzil.la/1722782)
- `@sentry/electron` 7.15 extracts JS stack frames from renderer OOM minidumps, which is useful for out-of-memory crashes in heavy scenes. — [socket.dev diff 7.15.0](https://socket.dev/npm/package/@sentry/electron/diff/7.15.0)
- Sentry includes Application Metrics (always on), Logs and Tracing in Electron. These can carry custom metrics such as frame time. — [Sentry Electron guide](https://docs.sentry.io/platforms/javascript/guides/electron/)
- Renderer and GPU process crashes reach Sentry as minidumps, though with minimal context if you use the crashReporter uploader. — [Sentry ElectronMinidump](https://docs.sentry.io/platforms/javascript/guides/electron/configuration/integrations/electronminidump/)

### Inferences
- Recommended instrumentation:
  1. On startup, record a Sentry tag/context with GPU vendor/renderer, `MAX_TEXTURE_SIZE`, Electron/Chromium version, OS, RAM (`os.totalmem`) and quality level.
  2. Listen for `webglcontextlost`/`webglcontextrestored` on the canvas, call `preventDefault()`, and send an event with the scene state.
  3. In three.js, enable shader error capture via `renderer.debug.onShaderError` and send the log.
  4. Keep a histogram of frame times (p50/p95/p99, % of frames >33 ms) per session and send it at session end as a metric, keyed by release and GPU.
  5. In main, listen for `app.on('child-process-gone')` (GPU process) and `webContents 'render-process-gone'` to count GPU/renderer resets.
- The default Chromium GPU blocklist can push some machines into software rendering (SwiftShader). Recording `renderer` makes this visible.

### Gaps
- I did not fetch the official docs for `child-process-gone`/`render-process-gone`, `renderer.debug.onShaderError`, or the `webglcontextlost` MDN page within the call budget. The steps above rely on those APIs and should be confirmed in the Electron and three.js docs (the project has local three.js docs).
- No public post-mortem from a WebGL game studio with real frame-time percentiles was found.

## 3. Session replay for canvas/WebGL apps

### Takeaway
Sentry and PostHog both record WebGL canvas as periodic images. Sentry asks for `enableManualSnapshot` and a `snapshot()` call inside the render loop to avoid `preserveDrawingBuffer`. PostHog records at 4 FPS with quality 0.4 by default. Neither scrubs PII from the canvas, and both have a performance cost. For a 3D game, replay is useful only in low-sampled form for UI/menus or error sessions.

### Cited Findings
- Sentry setup:
  - Enable with `Sentry.replayCanvasIntegration()` (opt-in, tree-shaken when unused).
  - WebGL normally needs `preserveDrawingBuffer`, which "can affect performance". The alternative is `enableManualSnapshot: true` with `snapshot(canvas)` called in the same loop as the draw.
  - For WebGPU, call `snapshot()` right after rendering with `skipRequestAnimationFrame: true`.
  - "There is currently no PII scrubbing in canvas recordings!"
  — [Sentry Session Replay canvas](https://docs.sentry.io/platforms/javascript/session-replay/#canvas-recording)
- Sentry plans include only 50 replays/month. — [Sentry pricing](https://sentry.io/pricing/)
- PostHog setup:
  - Canvas capture is off by default. It needs posthog-js ≥1.105.7.
  - Default capture is 4 FPS. `canvasFps` ranges 0–12 and `canvasQuality` 0–1 (remote default "0.4").
  - It "can affect performance" on some sites.
  - `maskRegionsFn` (≥1.408.0) blacks out regions before encoding.
  — [PostHog canvas recording](https://posthog.com/docs/session-replay/canvas-recording)

### Inferences
- For Roadcraft, the preferable default is no canvas replay. Record only DOM/UI replay with `replaysOnErrorSampleRate` and capture a single screenshot of the canvas when an error occurs. The overhead of reading back a WebGL framebuffer each frame (readPixels/toDataURL) conflicts with the GPU budget.

### Gaps
- No vendor publishes CPU/GPU overhead figures for canvas replay. LogRocket was not researched within the budget.
- PostHog prices could not be extracted (the pricing page came back empty in the fetch).

## 4. Release health, staged rollouts, beta branches, feature flags, kill switches, rollback

### Takeaway
Use Sentry's crash-free sessions/users per release, with alerts on drops, as the regression signal. Ship gradually in one of two ways:
- Outside Steam, use electron-updater's `stagingPercentage`.
- On Steam, use a beta branch (optionally password-protected) before "Set build live" on default.
Pair these with a remote kill switch / feature flag (GrowthBook open source is free and self-hostable) to turn off expensive effects per GPU without a new build.

### Cited Findings
- Sentry release health:
  - Crash-free sessions = % of sessions without a crash. Crash-free users = % of distinct users without a crash.
  - Session statuses: healthy, errored, crashed, abnormal, and unhandled (separate since v25.9.0).
  - Adoption is measured over 24 h. The "Adopted" stage means ≥10% of sessions.
  - Crash-rate monitors alert below a threshold.
  - Sessions are not subject to sampling or inbound filters.
  — [Sentry Release Health](https://docs.sentry.io/product/releases/health/)
- electron-builder supports staged rollouts on all platforms. `UpdateInfo.stagingPercentage` takes 0–100. — [electron-builder auto update](https://www.electron.build/docs/features/auto-update); [UpdateInfo API](https://www.electron.build/electron-updater.interface.updateinfo)
- How it works in practice:
  - Edit `latest.yml` and add `stagingPercentage: X` (an integer 1–100).
  - The client derives a percentage from a persistent per-installation GUID and refuses updates when the manifest percentage is below its own.
  — [Bitwarden contributing docs](https://contributing.bitwarden.com/getting-started/clients/desktop/update)
- Steam beta branches:
  - Create them in App Admin › Builds › "Create new app branch". They can carry a password, and the name stays hidden until the password is entered.
  - Players opt in under Properties › Game Versions & Betas.
  - Uploads never go to default automatically. You "Set build live" per branch, with Preview Change first.
  - In-game API: `ISteamApps::GetCurrentBetaName/GetNumBetas/GetBetaInfo/SetActiveBeta`.
  — [Steamworks Branches](https://partner.steamgames.com/doc/store/application/branches)
- GrowthBook:
  - Starter cloud: free, 3 users, 1 project, unlimited flags and traffic.
  - Pro: $40/seat/month, with "safe rollouts".
  - Self-hosted open source: free, unlimited users, 1 project.
  — [GrowthBook pricing](https://www.growthbook.io/pricing)

### Inferences
- Suggested release flow:
  1. Build signed and tagged with release = version+SHA, with source maps/symbols uploaded.
  2. Steam private/password beta branch, or `stagingPercentage: 5` outside Steam, for 24–72 h.
  3. Compare crash-free sessions, context-lost rate, and p95 frame time against the previous release.
  4. Go to 25% → 100%, or "set build live" on default.
  5. Rollback: on Steam, set an earlier build live on default (the builds page lists the history). With electron-updater, publish a higher version containing the old code; `allowDowngrade` exists but only applies to the channel.
- Kill switches: a remote JSON or flag (GrowthBook SDK, or a static file on a CDN) read at startup, with keys such as `disableShadows`, `maxQuality`, or blocklists by renderer string. Always cache it locally with a safe default when offline.

### Gaps
- No official Steam doc on rollback was found ("not covered" on the branches page). The rollback statement is an inference from how "Set build live" works.
- The electron-builder auto-update docs were not fully read (404s at old URLs). The details of `allowDowngrade`/channels need confirming.
- Unleash, LaunchDarkly and PostHog flags pricing was not checked.
- Squirrel.Windows has no native staged rollout. That claim is unverified here.

## 5. Self-hosted vs SaaS for a small studio

### Takeaway
SaaS on the free or entry tier (Sentry Developer/Team at $0–$29/mo, BugSplat Free) costs less than running self-hosted Sentry, which needs 16–32 GB of RAM and comes without support. Self-hosting makes sense mainly for feature flags (GrowthBook OSS) or for a plain minidump server.

### Cited Findings
- Self-hosted Sentry: at least 4 cores, 16 GB RAM plus swap (32 GB recommended), high-IOPS disk, no support. — [Sentry self-hosted](https://develop.sentry.dev/self-hosted/)
- Sentry SaaS Team: $26–29/mo, unlimited users, 50k errors. — [Sentry pricing](https://sentry.io/pricing/)
- BugSplat Free: 15k crashes/month, 3 users. — [BugSplat pricing](https://www.bugsplat.com/pricing/)
- GrowthBook OSS self-hosted: free with unlimited users. — [GrowthBook pricing](https://www.growthbook.io/pricing)
- `crashReporter` uploads to any Breakpad-compatible server, which allows a custom receiver (for example a small endpoint that stores minidumps) without a vendor. — [Electron crashReporter docs](https://www.electronjs.org/docs/latest/api/crash-reporter)

### Inferences
- A machine with 32 GB RAM for self-hosted Sentry costs more per month than Sentry Team, on top of maintenance. For a solo developer or small studio, SaaS Team plus attention to the attachments quota (minidumps) is the cost-effective choice.

### Gaps
- Cost of a VPS for self-hosted Sentry, and GlitchTip (a lighter Sentry-compatible alternative), were not researched.
- Engineering blogs (Figma, Discord, VS Code, Slack) on telemetry were not consulted within the call budget.
