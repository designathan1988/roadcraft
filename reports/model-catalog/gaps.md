# What the catalogue could not measure, and why

- Clouds: no mesh; drawn by ray marching in the post chain (src/render/postprocess.ts CLOUD_SHADOWS).
- Buildings' far levels (facade level L1, masses, base): built per cell of the building layer from many buildings at once (massCells.ts, farParts.ts), not per building; measured as the test city's layers.
- Vehicles' intermediate levels: made at run time by the simplifier (vehicleLevels.ts partLevels, meshoptimizer); the catalogue gives the full model (L0) and the far model.
- Signals, signs, barriers, flags and the far traffic: their layers build their models only from placed items (the builders are private to the layer); measured from the test city's meshes where it has them.
- Garments and hair: how many people wear each one is decided per person at run time; their copies are not counted.
- Editor feedback on the ground (src/render/renderer.ts blink) and the tools' 2D gizmos (drawn on a canvas over the view): no catalogued mesh.

## Rows without vertex-level measures (arrays sent to the GPU only)

- Test city layers/building-lotBox-caster/buildings-layer
- Test city layers/footway+curb-ramp+median-paved/world
- Test city layers/building-lotBox/buildings-layer
- Test city layers/road-far-blocks/world
- Test city layers/building-lotSides-caster/buildings-layer
- Test city layers/kerb+median-kerb/world
- Test city layers/building-lotSides/buildings-layer
- Test city layers/footway+curb-ramp+median-paved-far/world
- Test city layers/building-massing-plate/buildings-layer
- Test city layers/building-lotRail-caster/buildings-layer
- Test city layers/kerb+median-kerb-far/world
- Test city layers/gardens-far-cells/world
- Test city layers/building-lotRail/buildings-layer
- Test city layers/road-far-network/world
- Test city layers/markings/world
- Test city layers/building-lotSlab-caster/buildings-layer
- Test city layers/building-lotSlab/buildings-layer
- Test city layers/markings-f4f1e3-far/world
- Test city layers/markings-ece9d9-far/world
- Test city layers/markings-e1c45a-far/world
- Test city layers/markings-eee8d7-far/world
- Test city layers/building-water/buildings-layer
- Test city layers/utility-wires/world
- Test city layers/far-forest/flat-world-ground