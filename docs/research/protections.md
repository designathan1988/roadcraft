# Permanent protections (E3)

Question: what makes the rules of `CLAUDE.md` checked by a machine on every
change, with the debt brought from the SOURCE held so it can only fall.

## Sources read
- ESLint, *Bulk suppressions* — https://eslint.org/docs/latest/use/suppressions
  `--suppress-all` / `--suppress-rule <name>` write `eslint-suppressions.json` (to be
  committed); new violations are still reported; an unused suppression makes the run
  fail (unless `--pass-on-unpruned-suppressions`), fixed with `--prune-suppressions`.
  So the count can only fall.
- ESLint, `no-empty` — https://eslint.org/docs/latest/rules/no-empty
  "This rule ignores block statements which contain a comment": a `catch` holding
  only a comment passes. Hence a local rule.
- ESLint custom rules (rule object `meta` + `create(context)`, `context.sourceCode.visitorKeys`)
  — read in the ESLint docs on custom rules and in the existing `eslint.config.js`.
- Knip — https://knip.dev/overview/configuration, https://knip.dev/features/production-mode,
  https://knip.dev/reference/configuration
  Entries and project patterns; `--production` analyses only `entry`/`project`
  patterns marked `!`; plugins (Vite, Vitest) add their entries; the pages do not say
  that `new URL('./x.worker.ts', import.meta.url)` is followed, so the workers are
  listed as entries. Knip has no suppression file: the issues the SOURCE brings are
  held in `knip.baseline.json` by `scripts/knip-check.mjs`, which fails on a new one
  and on a baseline entry that is gone.
- Git, *githooks* — https://git-scm.com/docs/githooks
  `pre-push` gets the remote's name and URL as arguments and lines
  `<local-ref> <local-sha> <remote-ref> <remote-sha>` on stdin; a non-zero exit aborts
  the push; `core.hooksPath` moves the hooks folder (no dependency needed).

## Decisions
- `eslint-rules/no-silent-catch.js`: a `catch` (and a promise's `.catch(handler)`)
  must throw or report (console.error/warn, a `report*`/`record*`/`warn*`/`error*`/
  `fail*`/`reject*`/`notify*` call, `queueMicrotask`). The audit counted 68 silent ones.
- `eslint-rules/no-module-state.js`: no top-level `let`/`var`, no top-level `const`
  bound to a fresh `Map/Set/WeakMap/WeakSet/Array` or `[]` in `src/`.
- `max-lines` 800 (comments and blanks counted) in `src/`, `tests/`, `scripts/`.
- The violations brought by the copy are held in `eslint-suppressions.json`
  (generated once with `--suppress-rule` for these rules only), to reach zero in F4.
- `tests/arch/imports.spec.ts`: the import graph resolved by TypeScript's
  `preProcessFile`: the layer order holds for relative imports too; cycles may not
  grow beyond `tests/arch/cycles.baseline.json`, which may only shrink.
- `.githooks/pre-push` → `scripts/prepush.mjs`: `npm run check`, then — unless the
  push touches only documents — the gate, base = build of the remote commit, candidate
  = build of the pushed commit (both from `git archive`, kept by hash).

## Not read
- ESLint's own suppressions file format (not documented on the page).
- Whether knip follows `new URL(..., import.meta.url)` (workers listed by hand).
