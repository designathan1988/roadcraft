# src/sim — vehicles, pedestrians, signals

Rules for the whole repository are in the root `CLAUDE.md`. This file lists what
breaks far from where you edit in `sim/`.

## Which pedestrian engine runs

- ONE: the agents' walking engine, `sim/agents/walk.ts`, installed by
  `main.ts`; the people are the scenery's life (`sim/ambient`): a map opened
  is filled at once, then they come and go at the road ends and the lots'
  gates. `SimWorld` starts with a null engine (nobody walks) until one
  is installed - the specs install it themselves.
- The People (navmesh/ORCA), Detour crowd and sidewalk-graph engines were
  deleted on 2026-10-08 (the player's decision). What is left in `sim/peds/`
  (`sidewalk.ts`, `state.ts`, `publish.ts`, `behaviour.ts`, `corridor.ts`) and
  `sim/people/` (`engine.ts`, `view.ts`, `casualties.ts`) is read by live code
  (the footway graph, the crossings, the views the renderer draws).

## The people and the city (`sim/agents/`, `sim/ambient/`, `sim/city/`)

- `agents/walk.ts`: the agents' walking engine (the game's only one). Lanes on
  `world/walkways.ts`, SUMO striping, the body following a point ahead, zebras
  by `crossings/permission.ts`, published to `crossingStates` for the cars.
  The engine object carries `inspect` for probes in the page.
- `agents/parking.ts`: the bays (stalls of `parking` elements), the way out of
  each lot onto a street, the lane each bay is reached from; `agents/lotNav.ts`
  the grid inside a lot.
- `ambient/ambient.ts`: the scenery's life. A map opened (saved, a file, a
  generated city) gets the panel's cars and people at once, on lanes and
  footways all over it (`open`, a slice a tick); then people come and go at
  the road ends and the lots' gates, by the hour's tables in
  `ambient/demand.ts` (or round the view, `?ambient=view`). The cars parked
  in the bays.
- `agents/lotTraffic.ts`: cars end trips in the lots' car parks (at
  `TRIP_SECONDS`) and drive out of them (the scenery's parked cars handed
  over by `AmbientWorld.release`) while fewer drive than the panel asks:
  a town with no road end keeps its traffic this way.
- `city/city.ts` (`City`, `SimWorld.city`): the time of day, the public
  transport (`transit/transit.ts`), the edge traffic flag. Nobody lives in the
  city: the residents' days (homes, jobs, minds, their own cars) and walking
  the city as one of them are kept apart in `src/backup/residents` (the
  player's decision of 2026-10-08; its README says how to bring them back).
  The Actions (pistol and bomb) are not part of that and stay live.
- `defects.spec.ts` runs the game's setup: the walking engine with the
  scenery's life, the map filled at once when it opens.
  `tests/sim/agents/population.spec.ts` holds the opening and the closed town.

## Couplings

1. **One writer per field.** The stage list is in `pipeline.ts`: topology in stage
   0, signals in 1, routes and population in 2, pedestrians in 3, constraints 4-5,
   position and speed only in `integrate` at 6. To write a field from a second
   place you need a new field.
2. **Seat and door numbering:** `vehicles/kerbStops.ts` counts seats with
   `archetype.doorsPerSide`, `render/vehicleModels.ts` with its door edges. They
   agree by construction only; a new body style keeps both.
3. **Population ceilings:** `FLEET_CEILING` and `PED_CEILING` (`params.ts`) also
   size the renderer's instance buffers (`render/agents.ts`).
4. **`HEADING_CHORD`** is shared with `world/conflictPoints.ts` and
   `world/turnPaths.ts` (see `src/world/CLAUDE.md`).

## Traps that have already caught someone

- **`clock.tick` and `clock.time` do not advance under test.** They move only inside
  `SimClock.advance` and `SimClock.run`, and the specs drive `step` directly.
  Behaviour keyed on the clock silently never happens in the suite (that is how
  the lane-change cooldown blocked every overtake). Use the agent's own `age`.
- **`archetype` is the machine; `driver` is the person.** Size, mass and palette
  read the archetype; acceleration, braking, headway, gap acceptance and patience
  read the driver. `driver.bEmergency` is almost constant on purpose: the
  safe-speed cap sizes every following distance from it.
- **A lane change occupies two lanes.** The occupancy index moves at once; the body
  slides across over the next second. `Vehicle.shadow` keeps it in the old lane,
  and `SimWorld.bodiesIn` is what anything asking "is this lane clear here" must
  read, not `rt(id).order`.
- **A signal stage never holds two movements whose cars could meet.**
  `signals/plan.ts` groups approaches from the conflict matrix, so a crossroads of
  two-way streets runs one approach at a time. Pairing opposing approaches brings
  back the permissive left turn the player reported; `tests/sim/fourWay.spec.ts`
  fails.
- **If the vehicle pose in `pose.ts` changes, the sweep in
  `world/conflictPoints.ts` must change with it**; `tests/sim/collisions.spec.ts`
  tells you.
- **Pedestrians face where they are going, not where the body moved.** Facing each
  tick's displacement made every sidestep swing the body (the zigzag) and turned
  a standing person round on still legs. The heading follows the path through a
  turn rate and holds while standing; the renderer steps the feet round.
- **On the planet (`__PLANET__`) a position means nothing without its chart.**
  A lane is laid on the chart of the node it leaves, a junction's turns and its
  zebras on its node's, a footway on its segment's: across a border between
  pieces two of them are tens of km apart in the atlas. A body moving onto a
  lane or way of another chart takes its place, its last place and its heading
  with it (`pose.ts`, `agents/walk.ts carryOnto`); a distance between two
  things is taken on one chart (`world/planet/charts.ts onChartOf`); a grid of
  neighbours files ghost images on the charts round it (`walk.ts imagesOf`,
  `gapOpen`). `tests/planet/traffic.spec.ts` (run with `vitest.planet.config.ts`).
- **One shape per walker.** Every field a `Walker` may be given later is in
  `WALKER_SHAPE` (`agents/walk.ts`), spread into every walker literal: a
  new optional field added only where it happens gives walkers new hidden
  classes and throws away `stepWalkers`'s optimised code ("wrong map").
  Poses drawn every frame are written in place (`vehiclePoseInto`,
  `vehiclePoseNowInto`, `render/vehicleFrame.ts roadFrameInto`).
- **Doing less must stay the same as doing everything (`SimWorld.doLess`).**
  A tick visits the lanes with a vehicle (`occupied`, written only by
  `enterLanelet`/`exitLanelet`, the only writers of `order`), the lanes an
  edit left (`ghostCandidates`), the junctions somebody approaches
  (`junctionsApproached`) and the signals awake: a signal resting in green
  with nobody near sleeps, keeping only its time, and `signalsAsleep` wakes
  it from what is busy. Anything new the quiet rest reads (`junctionQuiet`,
  the rest in `fsm.ts` GREEN) needs its own wake there, and anything new
  that writes `order` must keep `occupied`; `tests/sim/doLess.spec.ts`
  (both worlds, tick by tick, through edits) tells you.
