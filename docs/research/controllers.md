# Global controllers (F1)

Question: how to build the session store, the tool and mode state machines, the
event bus and the command registry so that each is the only writer of its data, the
order of effects is defined, and every shortcut, button and menu goes through one
table.

## Sources read
- W3C, *SCXML* — https://www.w3.org/TR/scxml/ (algorithm part read; the second half
  of the page not read): a macrostep is a series of microsteps ending when the internal
  queue is empty; events raised during processing go to the back of the internal queue
  and are handled after the current executable content; a transition exits states in
  exit order, runs its content, then enters in entry order; the most deeply nested
  active state is checked first and, within a state, the first transition in document
  order wins; run-to-completion ("a single blocking operation").
- VS Code, *Key Bindings* — https://code.visualstudio.com/docs/configure/keybindings
  A rule is `{ key, command, when, args }`; "Rules are evaluated from bottom to top";
  "The first rule that matches both the key and when clause, is accepted"; a rule whose
  command is `-name` removes a default rule; chords are two key presses separated by a
  space.
- Blender, `bpy.types.Operator` — https://docs.blender.org/api/current/bpy.types.Operator.html
  (part read): `execute` returns `{'FINISHED'}` or `{'CANCELLED'}` ("aborted without
  making any changes"); with `'UNDO'` in `bl_options` an undo step is made when it
  returns `FINISHED`, never on `CANCELLED`; `invoke` initializes from the context.
- At the SOURCE: `core/gameState.ts` (the store, with recorded changes, watchers
  flushed in a microtask; Nystrom "Event Queue"/"Observer"), `world/changes.ts` (the
  diary), `ui/v2/shell.ts` `mountShell` (the interface handed the game's functions),
  five `keydown` listeners (three in `main.ts`, two in `shell.ts`).

## Decisions (F1)
- Keep `GameState` as the session store (it already records what/from/to/why and is
  read by F9); move the 32 loose `let`s of `main.ts` into it or into their owner.
- `core/statechart.ts`: a small statechart with the SCXML semantics above (synchronous
  `send`, internal FIFO drained before returning, exit → transition actions → entry,
  child before parent, first declared wins), every transition recorded.
- `core/bus.ts`: closed typed union; delivery in registration order by layer; the list
  copied at the start of an emission; an emission during a delivery queued
  (run-to-completion); a listener that throws is reported and the others still run.
- `core/commands.ts`: `{ id, label, keys, when, enabled, run → 'done' | 'cancelled' }`;
  key rules resolved bottom-to-top, first match on key and `when` wins (VS Code);
  undo recorded only for `done` (Blender). Every key, dock button, drawer tab and menu
  item resolves to a registered command (a test walks the table).

## Not read
- The rest of the SCXML page (data model, invoke); Blender's `poll`/`modal` sections.
