Symptom: close to the city the picture is grainy, "pixelizado" (player, 2026-10-23): a 1-pixel checker/grain over parapets, roofs and walls, and grainy shadow edges (shots close/09-close-a and close/15-close-b, 1:1 crops grain-shutter and grain-wall).

Two diagnoses made by reading alone failed their verification (the weathering's noise, then GTAO's denoise at 8 samples: the shots unchanged), so the passes were turned off one at a time at the same view (`__roadcraft.variant`, the effects panel's switches; shots ablate/*, high-frequency energy of the region 1000..1500 x 100..500: mean |2c - left - right| + |2c - up - down|):
all on 44.8, ambientOcclusion off 41.8, canyonLight off 41.6, smaa off 57.6, sharpen off 25.9, shadows off 45.9, surfaceDetail off 44.8, environmentMap off 42.5.

Trace:
- src/render/quality.ts:238 ultra sharpen 0.45 (high :199 0.35); src/render/postprocess.ts:408 the output pass's uSharpen.
- src/render/postprocess.ts:1181-1186 sharpMask is 1 where a pixel spans under 0.1 m: every surface of a close view.
- src/render/postprocess.ts:1192-1206 AMD CAS (sharpen-only) on the picture after SMAA (src/render/postprocess.ts:379-403 runs before the output pass): its peak -1 / mix(8, 5, uSharpen) is near full whatever the tier's number, and `c = mix(c, cl, sharpen / uSharpen)` takes all of it where the mask is 1.
- CAS is made to restore what a temporal filter or an upscale softened (AMD FidelityFX CAS); this chain draws at the display's size with no temporal filter: it lifts the textures' fine grain and the occlusion's residue into a 1-pixel checker, and puts back the steps SMAA smoothed.
- src/render/sunCascades.ts:1088 the sun's cascades through three's getShadow (node_modules/three/src/renderers/shaders/ShaderChunk/shadowmap_pars_fragment.glsl.js:148-180): five taps turned per pixel by interleaved gradient noise, a grain for a temporal filter this chain has not: the shadow edges grainy (smooth with the deterministic filter, shots close2).

Root cause:
- src/render/quality.ts:199 and :238 sharpening on high and ultra at native resolution after SMAA: 42 % of the region's pixel-level energy (44.8 against 25.9 without it), the checker.
- src/render/sunCascades.ts:1088 the cascades' stochastic PCF without a temporal filter: the grainy penumbrae.

Fix:
- quality.ts: sharpen 0 on high and ultra (low and medium had 0): the picture as drawn and anti-aliased, CAS's four taps and depth reconstruction a pixel saved. The pass and its switch stay (effects panel).
- sunCascades.ts: the cascades read by Ignacio Castano's optimized PCF (The Witness; MJP's Shadows sample, FilterSize 5): nine hardware bilinear-compare taps as a 5x5 tent round the texel, the reach of the radius of 2 texels, deterministic.
- finishes.ts: the wear's procedural terms filtered by the pixel's footprint (they fade to their measured means under 2 pixels): no change seen in these shots, kept as sound and nearly free; the louvres and GTAO's denoise left as they were (no gain seen).
