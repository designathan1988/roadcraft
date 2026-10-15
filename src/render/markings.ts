import { Color, MeshStandardMaterial, type Material } from 'three';

import type { Vec2 } from '@core/vec2';
import { GEO_EPS } from '@core/scalar';
import { LANE_LINE, Level, ROAD_TYPES } from '@world/roadTypes';
import { STYLE_PAINT } from '@world/roads/markingStyle';
import type { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import {
  type Bar,
  type StrokeSpec,
  junctionDetail,
  miniRoundaboutMarkings,
  approachLegends,
  segmentMarkings,
  transitionMarkings,
} from '@world/markings';
import { STOP_BAR_WIDTH } from '@world/approach';
import { PARKING_PAINT, parkingLayout } from '@world/parkingLayout';
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

interface Batch {
  rings: number[][][];
}

function quad(batch: Batch, a: Vec2, b: Vec2, half: number): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < GEO_EPS) return;
  const nx = (-dy / length) * half;
  const ny = (dx / length) * half;
  batch.rings.push([
    [a.x - nx, a.y - ny],
    [a.x + nx, a.y + ny],
    [b.x + nx, b.y + ny],
    [b.x - nx, b.y - ny],
  ]);
}

function stroke(batch: Batch, spec: StrokeSpec): void {
  const pattern = spec.dash;
  if (!pattern?.length) {
    for (let i = 1; i < spec.points.length; i++) {
      quad(batch, spec.points[i - 1] as Vec2, spec.points[i] as Vec2, spec.width / 2);
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
          batch,
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

function addBar(batch: Batch, value: Bar): void {
  quad(batch, value.a, value.b, value.width / 2);
}

/**
 * Every colour the roads are painted in: each class's line, the lane lines, the regional standards'
 * centres and the parking's lines - a closed set, so the paint is made at load (`paintCatalogue`).
 */
/** The stop lines' and the zebras' paint. */
const STOP_PAINT = '#ece9d9';
const ZEBRA_PAINT = '#f4f1e3';
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


/**
 * The painted strokes of the network, one list of quads per colour, before
 * they are merged and clipped: `roadSurfaces.ts` does that a tile at a time,
 * against the carriageway of the ribbons alone, so paint belongs to the road
 * legs and a crossing never becomes a white lattice at close zoom.
 */
export function markingQuads(
  net: Network,
  include: (segment: SegmentId) => boolean,
  includeJunctionDetails: boolean,
): Map<string, number[][][]> {
  const batches = new Map<string, Batch>();
  const at = (color: string): Batch => {
    let batch = batches.get(color);
    if (!batch) {
      batch = { rings: [] };
      batches.set(color, batch);
    }
    return batch;
  };

  for (const ribbon of net.ribbons.values()) {
    if (!include(ribbon.id)) continue;
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
    for (const spec of segmentMarkings(ribbon, start, cutA, cutB, net.doc.markingStyle)) stroke(at(spec.color), spec);
  }
  // Parking bays and the no-parking lines beside them (`world/parkingLayout.ts`).
  for (const line of parkingLayout(net).lines) {
    if (!include(line.segment)) continue;
    stroke(at(line.color), { points: line.points, width: line.width, color: line.color, dash: line.dash, dashOffset: 0 });
  }
  for (const node of net.transitions) {
    const leg = net.junctions.get(node)?.get(Level.Asphalt)?.legs[0];
    if (!leg || !include(leg.seg)) continue;
    for (const spec of transitionMarkings(net, node)) stroke(at(spec.color), spec);
  }
  if (includeJunctionDetails) {
    const detail = junctionDetail(net);
    for (const value of detail.stops) addBar(at(STOP_PAINT), value);
    for (const value of detail.zebras) addBar(at(ZEBRA_PAINT), value);
    // Mini-roundabouts' painted islands (V5).
    for (const spec of miniRoundaboutMarkings(net)) stroke(at(spec.color), spec);
    // The junction rule's words and symbols before the stop lines (V6).
    for (const spec of approachLegends(net, net.doc.markingStyle)) stroke(at(spec.color), spec);
  }
  const out = new Map<string, number[][][]>();
  for (const [color, batch] of batches) if (batch.rings.length > 0) out.set(color, batch.rings);
  return out;
}
