import { Color, MeshStandardMaterial, type Material } from 'three';

import type { Vec2 } from '@core/vec2';
import { GEO_EPS } from '@core/scalar';
import { LANE_LINE, Level, ROAD_TYPES } from '@world/roadTypes';
import { STYLE_PAINT } from '@world/roads/markingStyle';
import type { Network, SegmentRibbon } from '@world/network';
import type { NodeId } from '@world/ids';
import { type Bar, type StrokeSpec, segmentMarkings } from '@world/markings';
import { STOP_BAR_WIDTH } from '@world/approach';
import { PARKING_PAINT } from '@world/parkingLayout';
import { m } from '@world/units';
import { pullTowardEye } from './depthConvention';

/**
 * Painted road markings, as real geometry lifted just off the carriageway.
 *
 * Two things matter here and both were wrong before.
 *
 * **The paint is lit.** Markings used to be `MeshBasicMaterial` with
 * `toneMapped: false`, which makes them the same flat white in sunlight and in
 * shadow — a dead giveaway that the scene is a diagram. Thermoplastic road paint
 * is a rough, slightly raised surface; drawing it with a lit material and a high
 * roughness puts it under the same sun as the asphalt around it, and it darkens
 * with the road when a viaduct passes overhead.
 *
 * **One mesh per colour, not per stroke.** All the white paint in the network is
 * one draw call, all the yellow another.
 *
 * The central reservation is NOT here. It used to be two overlapping strokes at
 * the same height, which is two coplanar surfaces in the depth buffer and the
 * torn green scribble that ran down the middle of every boulevard. It is built
 * as a kerbed island in `roadSurfaces.ts` instead.
 */

/** How far paint stands above the asphalt. Enough to win the depth test. */
export const PAINT_RISE = m(0.008);

/** Where a stroke's quads go, one ring each, with its colour (`roadSurfaceInputs.ts`). */
export type QuadSink = (color: string, ring: number[][]) => void;

function quad(sink: QuadSink, color: string, a: Vec2, b: Vec2, half: number): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < GEO_EPS) return;
  const nx = (-dy / length) * half;
  const ny = (dx / length) * half;
  sink(color, [
    [a.x - nx, a.y - ny],
    [a.x + nx, a.y + ny],
    [b.x + nx, b.y + ny],
    [b.x - nx, b.y - ny],
  ]);
}

/** One stroke as quads, dashed as its pattern says. */
export function strokeQuads(sink: QuadSink, spec: StrokeSpec): void {
  const color = spec.color;
  const pattern = spec.dash;
  if (!pattern?.length) {
    for (let i = 1; i < spec.points.length; i++) {
      quad(sink, color, spec.points[i - 1] as Vec2, spec.points[i] as Vec2, spec.width / 2);
    }
    return;
  }

  const period = pattern.reduce((sum, value) => sum + value, 0);
  let phase = ((spec.dashOffset % period) + period) % period;
  let patternIndex = 0;
  while (phase >= (pattern[patternIndex] as number)) {
    phase -= pattern[patternIndex] as number;
    patternIndex = (patternIndex + 1) % pattern.length;
  }
  let remaining = (pattern[patternIndex] as number) - phase;
  let ink = patternIndex % 2 === 0;

  for (let i = 1; i < spec.points.length; i++) {
    const a = spec.points[i - 1] as Vec2;
    const b = spec.points[i] as Vec2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < GEO_EPS) continue;
    let travelled = 0;
    while (travelled < length) {
      const amount = Math.min(remaining, length - travelled);
      if (ink) {
        const t0 = travelled / length;
        const t1 = (travelled + amount) / length;
        quad(
          sink,
          color,
          { x: a.x + dx * t0, y: a.y + dy * t0 },
          { x: a.x + dx * t1, y: a.y + dy * t1 },
          spec.width / 2,
        );
      }
      travelled += amount;
      remaining -= amount;
      if (remaining <= GEO_EPS) {
        patternIndex = (patternIndex + 1) % pattern.length;
        remaining = pattern[patternIndex] as number;
        ink = !ink;
      }
    }
  }
}

/** A stop line or a zebra's bar as one quad. */
export function barQuad(sink: QuadSink, color: string, value: Bar): void {
  quad(sink, color, value.a, value.b, value.width / 2);
}

/**
 * Every colour the roads are painted in: each class's line, the lane lines, the regional standards'
 * centres and the parking's lines - a closed set, so the paint is made at load (`paintCatalogue`).
 */
/** The stop lines' and the zebras' paint. */
export const STOP_PAINT = '#ece9d9';
export const ZEBRA_PAINT = '#f4f1e3';
export const PAINT_COLOURS: readonly string[] = Object.freeze([...new Set([...ROAD_TYPES.map((rt) => rt.line), LANE_LINE, ...STYLE_PAINT, ...PARKING_PAINT, STOP_PAINT, ZEBRA_PAINT])]);

/**
 * The paint of every colour, made once when the scene is (CLAUDE.md: a material made once, never in a
 * rebuild): the road surfaces only read it (`roadSurfaces.ts`). DO NOT make a paint material where a
 * frame reaches: a colour first painted made its material in the frame of the edit.
 */
export function paintCatalogue(): Map<string, Material> {
  return new Map(PAINT_COLOURS.map((color) => [color, paintMaterial(color)]));
}

/** Paint of one colour: lit like the asphalt under it, drawn over it. */
export function paintMaterial(color: string): Material {
  const material = new MeshStandardMaterial({
    color: new Color(color).multiplyScalar(0.88),
    roughness: 0.72,
    metalness: 0,
    // Paint is applied over the asphalt, so it takes the same light but never
    // reflects the sky the way wet tarmac does.
    envMapIntensity: 0.25,
    transparent: true,
    depthWrite: false,
  });
  pullTowardEye(material, 2, 2);
  // Worn paint (the player found the markings flat stickers on the road): the
  // asphalt's grain shows through, the paint thins in patches where wheels
  // run, flakes off at the edges, and is a little dirty.
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPaintWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPaintWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vPaintWorld;
        float pHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float pNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(pHash(i), pHash(i + vec2(1.0, 0.0)), f.x), mix(pHash(i + vec2(0.0, 1.0)), pHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 w = vPaintWorld.xz;
          float grain = pNoise(w * 9.0);
          float worn = pNoise(w * 0.7) * 0.6 + pNoise(w * 2.3) * 0.4;
          float flake = pNoise(w * 5.0);
          // Pinholes of asphalt through the paint, wider where it is worn.
          // Mostly whole: fine pinholes, a soft thinning where wheels run, and
          // only rare small flakes - not blotches.
          // The fine patterns fade to their average once a pixel covers them
          // (world units a pixel, from the screen derivatives): seen from afar
          // they broke the lines into flickering dots (the player, 2026-10-06).
          float px = length(fwidth(w));
          float fineSeen = 1.0 - smoothstep(0.015, 0.045, px);
          float grainSeen = 1.0 - smoothstep(0.04, 0.12, px);
          float flakeSeen = 1.0 - smoothstep(0.08, 0.2, px);
          float cover = 1.0 - 0.35 * smoothstep(0.55, 0.85, worn) * mix(0.5, smoothstep(0.4, 0.7, grain), grainSeen);
          cover *= 1.0 - 0.25 * mix(0.14, step(0.86, pNoise(w * 22.0)), fineSeen);
          if (flake < 0.05) cover *= mix(1.0, 0.45, flakeSeen);
          diffuseColor.rgb *= 0.86 + 0.14 * pNoise(w * 1.3);
          diffuseColor.a *= cover * 0.92;
        }`);
  };
  // One program for every colour: the colour is a uniform, the code the same. DO NOT key it by the
  // colour: each new colour of paint built another program, in play.
  material.customProgramCacheKey = () => 'paint-worn-aa';
  return material;
}


/** A road's own paint along it (`segmentMarkings`), from its mouth to its stop lines or crossings. */
export function roadStrokes(net: Network, ribbon: SegmentRibbon): StrokeSpec[] {
  const trims = net.trims.get(ribbon.id);
  const start = trims?.a[Level.Asphalt] ?? 0;
  const segment = net.doc.segment(ribbon.id);
  // From the mouth to the stop line (or the crossing) is not painted along.
  const cut = (node: NodeId | undefined, trim: number): number => {
    if (node === undefined) return 0;
    const crossing = net.doc.node(node)?.crossing;
    if (net.doc.degree(node) < 3 && !crossing) return 0;
    return Math.max(0, net.stopLineDistance(ribbon.id, node) + STOP_BAR_WIDTH / 2 - trim);
  };
  const cutA = cut(segment?.a, start);
  const cutB = cut(segment?.b, trims?.b[Level.Asphalt] ?? 0);
  return segmentMarkings(ribbon, start, cutA, cutB, net.doc.markingStyle);
}
