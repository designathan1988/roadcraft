// Triangles and draw calls of the frames drawn in 1.5 s, by the city plan's
// level (`core/perfBudget.ts` memoryGroup) and by pass (colour or shadow),
// averaged per frame. A step of scripts/look.mjs: { "evalFile": "scripts/look/por-nivel.js" }.
// The shadow map is redrawn only when something moved: drag the camera a
// little just before (a "drag" step) or its average undercounts that frame.
(async () => {
  const rc = window.__roadcraft;
  const gl = (typeof rc.scene === 'function' ? rc.scene() : rc.scene).gl;
  const group = (n) => n.startsWith('building-preview') ? 'outros' : n.startsWith('building-shell-') ? 'L0 cascas'
    : n.startsWith('building-massing') ? 'L1 massas' : n.startsWith('building-') ? 'L0 peças'
    : /^(asphalt|footway|kerb|verge|curb-ramp|median-|markings-|road)/.test(n) ? 'vias'
    : n.startsWith('utility-') ? 'postes e fios' : /^(terrain-|flat-world)/.test(n) ? 'terreno'
    : /^(garden-|far-forest|forest|tree|grass|woods)/.test(n) ? 'vegetação'
    : /^(citizen-|car-|bus-|truck-|vehicle|male-|female-)/.test(n) ? 'pessoas e veículos' : 'outros';
  const acc = {};
  let frames = 0;
  const draw = gl.renderBufferDirect;
  const reset = gl.info.reset;
  gl.info.reset = function () { frames++; return reset.call(this); };
  gl.renderBufferDirect = function (camera, scene, geometry, material, object, g) {
    const t = gl.info.render.triangles;
    const c = gl.info.render.calls;
    draw.call(gl, camera, scene, geometry, material, object, g);
    const pass = material.isMeshDepthMaterial || material.isMeshDistanceMaterial ? 'sombra' : 'cor';
    const e = (acc[`${group(object.name || object.type)} / ${pass}`] ??= { tri: 0, calls: 0 });
    e.tri += gl.info.render.triangles - t;
    e.calls += gl.info.render.calls - c;
  };
  try {
    rc.redraw();
    await new Promise((done) => setTimeout(done, 1500));
  } finally {
    gl.renderBufferDirect = draw;
    gl.info.reset = reset;
  }
  const f = Math.max(1, frames);
  return Object.entries(acc)
    .sort((a, b) => b[1].tri - a[1].tri)
    .map(([k, v]) => `${k}: ${(v.tri / f / 1e6).toFixed(1)} M triângulos, ${Math.round(v.calls / f)} chamadas (${frames} quadros)`);
})()
