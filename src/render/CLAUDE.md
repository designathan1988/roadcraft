# src/render — everything three.js

Rules for the whole repository are in the root `CLAUDE.md`. Nothing outside this
folder imports `three`. This file lists what breaks far from where you edit here.

## Couplings

1. **The asphalt shader** (`materials.ts`, `ROAD_SPACE_FRAGMENT`) assumes
   `uv.x * ASPHALT_TILE` is the across direction of `world/elevation.roadAt`.
2. **Shadow bias is in world units over the fitted depth range**
   (`environment.ts` `fitDepth`); change the range and the bias follows.
3. **`SUN_AZIMUTH` against the camera's azimuth** decides whether shadows are
   visible at all: with the sun opposite the camera every shadow falls behind its
   own caster.
4. **Instance buffers** in `agents.ts` are sized by `FLEET_CEILING` and
   `PED_CEILING` (`sim/params.ts`).
5. **Door edges** in `vehicleModels.ts` must agree with the seat count in
   `sim/vehicles/kerbStops.ts`.

## Traps that have already caught someone

- **Winding.** World `y` is mirrored into three's `z`, which flips handedness.
  `mesh/surfaceMesh.ts` measures each ring's signed area instead of assuming;
  assuming once back-face culled the whole road network.
- **Ear clipping fans.** `earcut` on a long thin band makes triangles with
  1400-unit edges. `splitToSpan` cuts the polygon first; never feed it a long one.
- **The shadow map moves in whole texels of the GROUND** (`environment.ts`
  `GroundShadowGrid`): its grid hangs on a frame of the drawn ground, and the
  shadow camera's `up` is the grid's. Round the light's centre in three's own
  space, or let three pick the camera's up, and on the planet (where the ground
  moves through three's space under the view) every shadow shimmers in a drag
  and jumps at a piece's border. The light falls from a sun held in steps of
  0.1 degree (`SUN_STEP`), not the sky's sun disc (`sunDirection`).
- **`shadowMap.enabled` is a quality tier setting.** If shadows stop working, check
  the tier first.
- **Textures are baked once** (`materials.ts`, `mesh/textureBaker.ts` cache by key).
  Never create a material inside a rebuild.
- **Repeated parts are instanced, never one object each.** Signal heads as single
  meshes cost over a thousand draw calls a frame. A material shared by instanced
  meshes must see all of them with the same program variant (all with instance
  colours or none, never also a plain mesh), and a transparent DoubleSide
  material needs `forceSinglePass`, or three re-evaluates its program every draw.
- **A vertex colour attribute does nothing unless the material sets
  `vertexColors: true`.** If a per-vertex tint has no effect, check the material
  before the maths.
- **Shader variants must be compiled for the target they draw to.**
  `compileAsync` runs with the renderer target set to the post-processing target
  (linear, no tone mapping), or it builds the wrong variants and the first frame
  stalls.
- **A seated person must fit the seat.** Car-seat poses are IK poses sized by
  `seatFitScale` against measured extents. After changing a body profile or a
  pose, rerun `scripts/measure-seated-poses.mjs` (against `npm run dev`) and
  `tests/render/occupantFit.spec.ts`.
- **People are MakeHuman bodies cooked ahead** (`cooked/people`, gitignored).
  After any change to people code or assets the cook fingerprint changes and
  bodies are built slowly at runtime until `npm run cook:people` runs again.
  The procedural crowd's cook (`cooked/procedural`) is fingerprinted by the
  import closure of `people/proceduralBake.ts` only: changing how the crowd
  is drawn (`proceduralCrowd.ts`, `crowd*.ts`) does not stale it; changing
  the bake or what it imports does.
- **The procedural people's skeletons are drawn on the GPU** (`people/
  crowdAnimation.ts`): `renderPalettes(renderer)` must run after the crowd's
  `update` and before the scene is drawn (`renderer.ts` before `post.render`,
  `peopleLab.ts`), or people are drawn in the last pose rendered.
- **A procedural person's level of detail comes from `person.pixels`**
  (`agents.ts` from `personPixels`); unset, they are drawn in full.
- **Main-thread JavaScript, not the GPU, was the frame cost** in the 2026-10-02
  profile. Profile before optimising the GPU side.

## How to add a visual effect

Put it in `postprocess.ts` behind a flag in `quality.ts`, so a weak machine can turn
it off. Never add an unconditional cost.
