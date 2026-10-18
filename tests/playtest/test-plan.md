# Playtest plan

The whole game played as a player from a blank map, in installed Chrome through Playwright
(`node scripts/look.mjs tests/playtest/scripts/<NN>-<part>.json test-results/pt/<NN> --url=http://127.0.0.1:5301`),
1920x1080, GPU. Real gestures only (clicks, drags with the three buttons, the wheel, keys, typing); the console
probes (`state.js`, `view.js`, `buttons.js`) only read what the page shows. Every shot is opened and looked at.

| # | Script | Part of the route | What is looked at |
|---|--------|-------------------|-------------------|
| 00 | `00-open.json` | Opening the game | loading screen, first frame, what the player sees first |
| 01 | `01-menus.json` | Top bar menus and the tool bar | each menu and each tool's panel: text, overlap, language |
| 02 | `02-camera.json` | Camera and the map's edge | wheel out to the whole map, pan to the edge, turn, Home, wheel in, Q/E held, Shift+E |
| 03 | `03-roads.json` | Road tool: straight, crossing, curve, bridge (+8 m), tunnel (-8 m) | junctions, structures, poles, cost, hint |
| 04 | `04-road-tools.json` | Upgrade, split, control, move, roundabout, slope over a hill | each tool's hint and result |
| 05 | `05-terrain.json` | Terrain brushes and a river | relief, water, roads on slopes |
| 06 | `06-zones.json` | Zones, lots and buildings growing; the Builder | growth, buildings near and far |
| 07 | `07-street.json` | Poles, furniture, barriers, transit, people | placement, look up close |
| 08 | `08-inspect.json` | Inspect, demolish, undo and redo | panels, what comes back |
| 09 | `09-sim.json` | Simulation: traffic, signals, pedestrians, speeds | cars moving, lights, people |
| 10 | `10-save.json` | Save, load, reload the page | the same city back |
| 11 | `11-settings.json` | Quality levels, graphics options, language | every panel in both languages |
| 12 | `12-city.json` | The 10 km city: map, district, street, pan, turn, zoom, CPU profile | levels, holes, blinking, frame times |

Each defect goes to `defects.md` (cause, fix, commit, shot). The report with the shots is `report.md`.
Engine defects (render, sim, world, core) go to the engine session by message and are listed there as such.
