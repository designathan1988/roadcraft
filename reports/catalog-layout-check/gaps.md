# What the catalogue could not measure, and why

- Clouds: no mesh; drawn by ray marching in the post chain (src/render/postprocess.ts CLOUD_SHADOWS).
- Buildings' far levels (facade level L1, masses, base): built per cell of the building layer from many buildings at once (massCells.ts, farParts.ts), not per building; measured as the test city's layers.
- Vehicles' intermediate levels: made at run time by the simplifier (vehicleLevels.ts partLevels, meshoptimizer); the catalogue gives the full model (L0) and the far model.
- Signals, signs, barriers, flags and the far traffic: their layers build their models only from placed items (the builders are private to the layer); measured from the test city's meshes where it has them.
- Garments and hair: how many people wear each one is decided per person at run time; their copies are not counted.
- Cast bodies: who wears which body is the casting's choice at run time (CastingRegistry); each body's copies are the people the game drew as it over the sweep's views (its census), not the people never drawn.
- Test city layers: every mesh the scene drew in any view of the sweep (a grid over the whole map); a cell only drawn at another zoom than the sweep's and the fixed views' is not in it.
- Editor feedback on the ground (src/render/renderer.ts blink) and the tools' 2D gizmos (drawn on a canvas over the view): no catalogued mesh.
- Run without the game (--no-game): the buildings (built from a city's records), the test city's layers, copies, costs, draw calls and the destruction's peak are left out.

## How hidden triangles are counted

hidden_triangles: triangles whose centre lies strictly inside another closed convex solid of the same object (its face planes, the solids welded by position), or pressed face to face on another triangle (the same centre, opposite normals); n/a for lines, points and geometry whose arrays could not be read.