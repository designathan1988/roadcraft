---
name: code-first
description: MANDATORY for every bug, regression, visual difference, slowness, memory or "it doesn't work" in Roadcraft, and before running the game, a photo (look.mjs), a comparison (look-compare), tests (vitest, verify.mjs), a build, a browser or any measurement. Forces the cause to be found by reading and tracing the code, written as a diagnosis with file:line, and fixed in code BEFORE anything is run. A hook (.claude/hooks/code-first-gate.mjs) blocks every run until this is done.
---

# Code first: read the code, find the cause, fix it, then verify once

The player forbids trial and error, hypotheses, measuring loops and runs used instead of reading code. This skill is not advice: the hook `.claude/hooks/code-first-gate.mjs` (PreToolUse) refuses any run until its conditions hold. There is no exception and no "quick check".

## What is blocked until the gate opens
Running the game or any part of it: `look.mjs`, `look-compare.mjs`, `verify.mjs`, `vitest`, `playwright`, `vite build`, `npm run` (test, verify, look, build, cook, budgets), `node` scripts that load the game (`ssrLoadModule`, `createServer`), Chrome/Electron, and every `mcp__chrome-devtools__*` and `mcp__threejs-devtools-mcp__*` tool.

## The only way through
1. **Read the code** with Read / Grep / Glob: from the symptom's entry point (the frame, the open path, the layer that draws the thing) follow every call and every condition until the line that produces the wrong result. Read whole functions, not snippets. Follow data from where it is made to where it is used. Read `git log -p` / `git show` of the files involved to see what changed.
2. **Write `.claude/diagnosis.md`** with these sections, all filled, nothing guessed:
   - `Symptom:` what is wrong, seen where.
   - `Trace:` the chain of code that leads to it, one line each, every step as `src/<file>.ts:<line>` or `scripts/<file>.ts:<line>` with what that line does. At least 3 steps.
   - `Root cause:` the exact line(s) `src/…:<line>` or `scripts/…:<line>` and why they produce the symptom.
   - `Fix:` the code change and why it removes the cause without breaking what the code was there for.
   Words like "maybe", "probably", "likely", "suspect", "hypothesis", "talvez", "provavelmente", "suspeito", "hipótese" make the gate refuse it: if you are not sure, you have not read enough code.
3. **Edit the code** (`src/`, or `scripts/` for the build and tools; the photo plans in `scripts/look/` are data and do not count) to apply the fix. The gate opens only when such code changed after the diagnosis was written.
4. **One verification**: at most 4 gated commands for one state of the code (start the server, the related specs, one photo plan, its comparison; chain them). After it, the gate closes again until the code changes again. A failed verification means the diagnosis was wrong: go back to step 1 and read more code; never re-run hoping for a different result.

## Forbidden
- Running anything "to see what happens", "to confirm a hypothesis", "to measure first", or to bisect by reverting files and shooting photos.
- Patching code temporarily (sed in a worktree, `&& false`) to test an idea.
- Writing a diagnosis without having read the code it cites; citing lines that do not say what the diagnosis claims.
- Editing or deleting the gate, its settings entry or `.claude/code-first-state.json`, or getting around it with another shell, another tool or a subagent. Subagents get the same rules: pass them this skill.
