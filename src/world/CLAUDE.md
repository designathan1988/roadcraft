# src/world — the document and everything derived from it

Rules for the whole repository are in the root `CLAUDE.md`. This file lists what
breaks far from where you edit in `world/`, and how to add the common things.

## Couplings

1. **One trim per segment end** (`world/approach.ts`) feeds the junction mouth, the
   zebra, the stop line, the lanelet end, the elevation plate, the footway kerb
   nodes and the markings. Changing one of its constants moves all of them.
   `Network.stopLineDistance` never returns less than the mouth.
2. **`HEADING_CHORD`** is shared by `sim/pose.ts`, `world/conflictPoints.ts` and
   `world/turnPaths.ts`: change the three together or none.
   `tests/sim/collisions.spec.ts` is the guard.
3. **`RoadSample`** (`elevation.roadAt`) feeds the road UV frame and the asphalt's
   `roadEdge` attribute; the asphalt shader (`render/materials.ts`,
   `ROAD_SPACE_FRAGMENT`) assumes `uv.x * ASPHALT_TILE` is the across direction.
4. **Street furniture** (`world/streetFurniture.ts`) is both what the renderer
   draws and what pedestrians walk round (`sim/peds/clearance.ts`).
5. **Junction legs are framed at the trim they are cut at** (`junction/legs.ts`,
   `build.ts`): a trim changed after framing (the slab bump) must re-frame.
6. **Signal stages come from the conflict matrix** (`sim/signals/plan.ts` over
   `conflictPoints.ts`): a new conflict rule changes the phasing.
7. **The footway height** is `roadTypes.ts` `FOOTWAY_RISE`, declared once;
   `tests/arch` checks it.
8. **Road tuning figures** (grades, clearances, tunnel cover, pier and pole
   spacing, flow thresholds, prices) live in `roads/tuning.ts`, each with its
   source; `elevation.ts`, `structures.ts`, `utilities.ts`, `editor/commit.ts`,
   `editor/editRules.ts` and `render/structures.ts` read them
   (`tests/arch/roads.spec.ts`). A LIVE figure changes only by the player's
   decision (`tests/world/roadTuning.spec.ts` locks them).

## Traps that have already caught someone

- **Terrain height has two meanings.** `heightAt` is the analytic field;
  `renderedHeightAt` is what the triangles draw. Anything laid on the ground must
  clear the second one.
- **A heightfield cannot have a hole.** A tunnel mouth is a STEP in the terrain plus
  a portal wall that covers it. `TUNNEL_ROOF`, `TUNNEL_BORE`, `TUNNEL_PORTAL_COVER`
  and `CUT_SHOULDER` must stay consistent; widening the roof-to-bore fade buries
  the road in a skin of earth.
- **Terrain shaping must clear the lowest road band, not the deck.** Ground beside
  a road is pulled to `deck - SHAPE_DROP`, and `SHAPE_DROP` absorbs the difference
  between the blended field the mesh reads and the nearest profile the shaper
  answers for, plus grid interpolation. `npm run verify:visual` counts road
  vertices under the ground.
- **A road at grade is a designed line, not the ground.** `solveGround` smooths the
  ground over `SMOOTH_REACH` and limits the gradient both ways; the terrain is cut
  and filled to meet it. Following the ground more closely undoes the fix for
  "the roads are not level"; the two-sided `slopeLimit` is not the raise-only
  `gradeEnvelope`.
- **A junction's height comes from its legs' grade lines at the plate edge**, and
  only from legs built at grade. Reading the ground perches a crossroads on the
  tallest hummock; letting a viaduct vote lifts the junction to the ramp.
- **A conflict is two bodies, not two lines.** `conflictPoints.ts` sweeps the drawn
  body rectangle of three size classes along every movement; a claim holds until
  the body centre is past the zone exit. If `sim/pose.ts` changes, the sweep
  changes with it.
- **A building edit moves `doc.buildings.revision`, never `doc.revision`.** Bumping
  the document revision for a storey rebuilds the road network, the lanelets and
  the simulation. A road edit demolishes any building it now overlaps
  (`clearBuildingsOnRoads`, called from `mutateBuilt`) in the same undo step.
- **The terrain's cell is 6.4 m** (`world/bounds.ts` PLATE_SIZE, 320 cells a
  plate): the grading of lots on a hillside was tuned at it, and at 6.25 or
  6.67 m earth rose over a terrace's paving (`tests/world/steppedYards.spec.ts`).
- **Scenes in specs written in steps of 0.4 m** (`TUNED_UNIT`, the unit of
  before 2026-10-11) are multiplied by U: the same metres (`docs/ESCALA.md`).
  A raw number in such a scene is a scene 2.5 times smaller.

## How to add

- **A road class:** `roadTypes.ts` → `ROAD_TYPES` with `nameKey`/`subKey`, both keys
  in both i18n dictionaries. One-way defaults also need the direction rule in
  `editor/commit.ts`; limited-access classes are excluded from pedestrian paths
  in `sim/peds/sidewalk.ts`.
- **A road that rises or falls:** authored as `RoadNode.heightOffset`, relative to
  designed ground. `elevation.ts` solves the profile; `render/roadSurfaces.ts`
  keeps authored decks separate at grade crossings; `render/structures.ts`
  derives supports and portals. `ROAD_STRUCTURES` is only for loading old maps.
- **A surface layer (say, a cycle track):** `roadTypes.ts` (`Level`, `halfWidth`) →
  `surfaces.ts` (`Surfaces`, `Bands`) → `render/roadSurfaces.ts` (one more
  `buildSurfaceMesh` call at its own offset from the shared deck).
- **A terrain brush:** `terrain.ts` (`TerrainMode` and its branch in
  `sampleTerrainHeight`), then the editor steps in `src/editor/CLAUDE.md`. A
  parameter of its own is an optional `TerrainStamp` field with a default where
  it is read, so a stamp from an older build loads unchanged.
