# What the catalogue could not measure, and why

- Clouds: no mesh; drawn by ray marching in the post chain (src/render/postprocess.ts CLOUD_SHADOWS).
- Vehicles' intermediate levels: made at run time by the simplifier (vehicleLevels.ts partLevels, meshoptimizer); the catalogue gives the full model (L0) and the far model.
- Pictures: the colours are each material's base colour where its look needs the running game (baked surfaces, the engine's uniforms); the geometry and every number are the engine's.
- Editor feedback on the ground (src/render/renderer.ts blink) and the tools' 2D gizmos (drawn on a canvas over the view): no catalogued mesh.
- Run without the game (--no-game): no copies, costs (triangles x copies), draw calls or destruction peak: those are counted in a generated city.

## How hidden triangles are counted

hidden_triangles: triangles whose centre lies strictly inside another closed convex solid of the same object (its face planes, the solids welded by position), or pressed face to face on another triangle (the same centre, opposite normals); n/a for lines, points and geometry whose arrays could not be read.