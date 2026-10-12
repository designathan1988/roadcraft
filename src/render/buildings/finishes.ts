import { DoubleSide, MeshStandardMaterial } from 'three';

import { type Finish, FINISHES } from '@world/buildings/materials';
import { m } from '@world/units';
import { type SurfaceRecipe, bakeSurface, fbm, makeNoise } from '../mesh/textureBaker';

/**
 * The building finishes (docs/buildings.md, "Materials"): one material per
 * finish, each with its own baked texture, shared by every building's shell.
 *
 * The textures are NEUTRAL - greys with the finish's pattern and relief - and
 * the shell's vertex colour tints them, so one brick texture makes a red brick
 * wing and a yellow brick one. Shell UVs are in world units on the face's own
 * plane (see `Shell` in `buildingMesh.ts`), so each map is scaled here to the
 * size of its tile, and brick courses run level on every wall. Baked ONCE per
 * renderer and cached by key (CLAUDE.md: never inside a rebuild).
 */

type Shade = SurfaceRecipe['shade'];

interface FinishLook {
  readonly size: number;
  /** World units one tile of the texture covers. */
  readonly worldSize: number;
  readonly relief: number;
  readonly metalness: number;
  /** Metal and non-metal in one texture (`SurfaceRecipe.metallic`): `metalness` scales the baked map. */
  readonly metallic?: boolean;
  readonly envMapIntensity: number;
  /** Strength of the normal map on the material, 0..1. */
  readonly normalScale: number;
  readonly shade: (size: number) => Shade;
}

/** A small integer hash, stable and tiling: per brick, per board, per tile. */
function cellHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

const grey = (out: { r: number; g: number; b: number }, t: number): void => {
  out.r = t;
  out.g = t;
  out.b = t;
};

/**
 * A running-bond masonry pattern: `rows` courses and `across` units per
 * course in one tile, each course shifted by half a unit. Returns the unit's
 * indices and the distance, in texels, to its nearest joint.
 */
function bond(u: number, v: number, size: number, across: number, rows: number): { col: number; row: number; edge: number } {
  const h = size / rows;
  const w = size / across;
  const row = Math.floor(v / h);
  const shifted = u + (row % 2 === 1 ? w / 2 : 0);
  const col = Math.floor(shifted / w) % across;
  const fu = shifted - Math.floor(shifted / w) * w;
  const fv = v - row * h;
  return { col, row, edge: Math.min(fu, w - fu, fv, h - fv) };
}

const LOOKS: Readonly<Record<Finish, FinishLook>> = {
  roofing: {
    size: 256,
    worldSize: m(4),
    relief: 0.6,
    metalness: 0,
    envMapIntensity: 0.4,
    normalScale: 0.35,
    shade: (size) => {
      const granules = makeNoise(0x4e1f);
      const blotch = makeNoise(0x0a77);
      return (x, y, out) => {
        // A membrane laid in 1 m sheets: a lapped seam every sheet, mineral
        // granules too fine to see from above, and slow weathering.
        const sheet = size / 4;
        const fv = y % sheet;
        // Seams faint and granules quiet: a dark line every metre and a
        // strong relief turned into stripes and sparkle from above (moiré).
        const seam = fv < 2.2 ? 0.975 + fv * 0.01 : 1;
        const g = granules((x / size) * 128, (y / size) * 128, 128);
        const b = fbm(blotch, (x / size) * 3, (y / size) * 3, 3, 3);
        grey(out, (0.8 + (g - 0.5) * 0.025 + (b - 0.5) * 0.08) * seam);
        out.h = fv < 2.2 ? 0.58 : 0.5 + g * 0.04;
        out.rough = 0.93;
      };
    },
  },
  stucco: {
    size: 256,
    worldSize: m(3),
    // A coarse trowel render: a heavy grain the light catches, and the sweep
    // of the trowel running across it.
    // Fine and flat: a heavy relief read as the wall of a cave (the player).
    relief: 0.8,
    metalness: 0,
    envMapIntensity: 0.5,
    normalScale: 0.22,
    shade: (size) => {
      const grain = makeNoise(0x5c31);
      const sweep = makeNoise(0x77a9);
      return (x, y, out) => {
        const g = fbm(grain, (x / size) * 64, (y / size) * 64, 64, 2);
        const s = fbm(sweep, (x / size) * 3 + y / size * 0.6, (y / size) * 3, 3, 2);
        grey(out, 0.9 + (g - 0.5) * 0.12 + (s - 0.5) * 0.07);
        out.h = g * 0.75 + s * 0.25;
        out.rough = 0.92;
      };
    },
  },
  panel: {
    size: 256,
    worldSize: m(2.4),
    // Composite cladding: wide panels two courses high, thin open joints, a
    // touch of tone from panel to panel.
    relief: 1.2,
    metalness: 0.15,
    envMapIntensity: 0.9,
    normalScale: 0.3,
    shade: (size) => {
      const grain = makeNoise(0x1d4b);
      return (x, y, out) => {
        const w = size / 2;
        const h = size / 4;
        const col = Math.floor(x / w);
        const row = Math.floor(y / h);
        const fu = x - col * w;
        const fv = y - row * h;
        const joint = Math.min(fu, w - fu, fv, h - fv);
        const seam = joint < 1.6 ? 0.62 + joint * 0.12 : 1;
        const g = grain((x / size) * 96, (y / size) * 96, 96);
        grey(out, (0.9 + cellHash(col, row, 0x9e) * 0.1 + (g - 0.5) * 0.02) * seam);
        out.h = joint < 1.6 ? 0.7 : 0.55;
        out.rough = 0.5;
      };
    },
  },
  slate: {
    size: 256,
    worldSize: m(2),
    // Hanging slates: eight courses, each lapping the one below, every slate
    // its own shade of grey.
    relief: 3.5,
    metalness: 0,
    envMapIntensity: 0.45,
    normalScale: 0.6,
    shade: (size) => {
      const grain = makeNoise(0x3f88);
      return (x, y, out) => {
        const course = size / 8;
        const row = Math.floor(y / course);
        const fv = (y - row * course) / course;
        const w = size / 6;
        const shifted = x + (row % 2 === 1 ? w / 2 : 0);
        const col = Math.floor(shifted / w) % 6;
        const lap = fv < 0.16 ? 0.5 + fv * 2.2 : 1;
        const g = grain((x / size) * 80, (y / size) * 80, 80);
        grey(out, (0.42 + cellHash(col, row, 0x5a) * 0.22 + (g - 0.5) * 0.05) * lap);
        out.h = (1 - fv) * 0.5 + 0.3;
        out.rough = 0.82;
      };
    },
  },
  plaster: {
    size: 256,
    worldSize: m(4),
    // A smooth render, not a stucco: close up, a heavy grain read as rough
    // cast. The tone moves slowly; the relief is barely there.
    relief: 0.45,
    metalness: 0,
    envMapIntensity: 0.6,
    normalScale: 0.2,
    shade: (size) => {
      const coarse = makeNoise(0x71a3);
      const fine = makeNoise(0x2c5d);
      return (x, y, out) => {
        const n = fbm(coarse, (x / size) * 6, (y / size) * 6, 6, 4);
        const f = fine((x / size) * 96, (y / size) * 96, 96);
        grey(out, 0.91 + (n - 0.5) * 0.06 + (f - 0.5) * 0.012);
        out.h = f * 0.3 + n * 0.7;
        out.rough = 0.93;
      };
    },
  },
  ceramic: {
    size: 256,
    worldSize: m(1),
    relief: .7,
    metalness: 0,
    envMapIntensity: .9,
    normalScale: .25,
    shade: (size) => {
      const grain = makeNoise(0x31c4);
      return (x, y, out) => {
        // Ten 100 mm porcelain tiles per metre, with fine pale grout.
        const tile = size / 10;
        const col = Math.floor(x / tile), row = Math.floor(y / tile);
        const edge = Math.min(x % tile, tile - x % tile, y % tile, tile - y % tile);
        const g = grain((x / size) * 80, (y / size) * 80, 80);
        grey(out, edge < 1.3 ? .78 : .94 + cellHash(col, row, 0x8c) * .035 + (g - .5) * .012);
        out.h = edge < 1.3 ? .12 : .64;
        out.rough = edge < 1.3 ? .73 : .34;
      };
    },
  },
  brick: {
    size: 512,
    worldSize: m(2.4),
    relief: 3.2,
    metalness: 0,
    envMapIntensity: 0.5,
    normalScale: 0.55,
    shade: (size) => {
      const grain = makeNoise(0x6b11);
      return (x, y, out) => {
        // 32 courses of 75 mm and ten 240 mm bricks a course in 2.4 m.
        const { col, row, edge } = bond(x, y, size, 10, 32);
        const g = grain((x / size) * 128, (y / size) * 128, 128);
        if (edge < 1.6) {
          grey(out, 0.58 + g * 0.05);
          out.h = 0.1;
          out.rough = 0.97;
          return;
        }
        const tone = 0.78 + cellHash(col, row, 0x3b) * 0.2 + (g - 0.5) * 0.06;
        out.r = tone;
        out.g = tone * 0.98;
        out.b = tone * 0.96;
        out.h = 0.75 + g * 0.2 + Math.min(1, edge / 4) * 0.05;
        out.rough = 0.86;
      };
    },
  },
  stone: {
    size: 512,
    worldSize: m(3.2),
    relief: 1.4,
    metalness: 0,
    envMapIntensity: 0.5,
    normalScale: 0.3,
    shade: (size) => {
      const grain = makeNoise(0x5d07);
      const mottle = makeNoise(0x0e93);
      return (x, y, out) => {
        // Eight 400 mm courses of ashlar, five blocks a course.
        const { col, row, edge } = bond(x, y, size, 5, 8);
        const g = fbm(grain, (x / size) * 48, (y / size) * 48, 48, 3);
        const mo = fbm(mottle, (x / size) * 8, (y / size) * 8, 8, 3);
        if (edge < 1.5) {
          grey(out, 0.58 + g * 0.06);
          out.h = 0;
          out.rough = 0.95;
          return;
        }
        grey(out, 0.7 + cellHash(col, row, 0x51) * 0.2 + (mo - 0.5) * 0.12 + (g - 0.5) * 0.05);
        // Dressed flat: sawn stone, a fine grain on a level face.
        out.h = 0.7 + g * 0.15;
        out.rough = 0.9;
      };
    },
  },
  concrete: {
    size: 256,
    worldSize: m(4.8),
    relief: 1.6,
    metalness: 0,
    envMapIntensity: 0.5,
    normalScale: 0.3,
    shade: (size) => {
      const n1 = makeNoise(0x44c1);
      const n2 = makeNoise(0x1b7e);
      return (x, y, out) => {
        // Smooth cast concrete: a slow cloudy tone, fine pores, faint
        // trowel marks; no formwork joints or tie holes (they read as a
        // perforated sheet on every slab and canopy).
        const n = fbm(n1, (x / size) * 6, (y / size) * 6, 6, 4);
        const f = n2((x / size) * 120, (y / size) * 120, 120);
        const pore = f > 0.82 ? -0.05 : 0;
        grey(out, 0.8 + (n - 0.5) * 0.07 + (f - 0.5) * 0.02 + pore);
        out.h = 0.6 + f * 0.1;
        out.rough = 0.9;
      };
    },
  },
  wood: {
    size: 256,
    worldSize: m(2.4),
    relief: 2.4,
    metalness: 0,
    envMapIntensity: 0.4,
    normalScale: 0.45,
    shade: (size) => {
      const grain = makeNoise(0x2fa9);
      return (x, y, out) => {
        // Sixteen 150 mm boards, standing: the grain runs up them.
        const board = size / 16;
        const col = Math.floor(x / board);
        const fu = x - col * board;
        if (Math.min(fu, board - fu) < 0.9) {
          grey(out, 0.35);
          out.h = 0;
          out.rough = 0.95;
          return;
        }
        const g = fbm(grain, (x / size) * 64 + col * 3.7, (y / size) * 6, 6, 4);
        const streak = 0.5 + 0.5 * Math.sin((g * 18 + fu * 0.3) * Math.PI);
        const tone = 0.72 + cellHash(col, 0, 0x7c) * 0.16 + (streak - 0.5) * 0.1;
        out.r = tone;
        out.g = tone * 0.97;
        out.b = tone * 0.93;
        out.h = 0.7 + streak * 0.15;
        out.rough = 0.78;
      };
    },
  },
  metal: {
    size: 256,
    worldSize: m(1.6),
    relief: 5,
    metalness: 0.55,
    envMapIntensity: 1,
    normalScale: 0.6,
    shade: (size) => {
      const n = makeNoise(0x6e2b);
      return (x, y, out) => {
        // Corrugated sheet: eight ribs a tile, 200 mm apart, running up.
        const rib = 0.5 + 0.5 * Math.sin(((x / size) * 8) * Math.PI * 2);
        const w = n((x / size) * 20, (y / size) * 20, 20);
        grey(out, 0.8 + (rib - 0.5) * 0.12 + (w - 0.5) * 0.05);
        out.h = rib;
        out.rough = 0.42 + w * 0.1;
      };
    },
  },
  glass: {
    size: 256,
    worldSize: m(3),
    relief: 2,
    // Glass is a dielectric and the mullions are aluminium: metalness is all
    // but binary (Filament, "Metallic"; three's MeshStandardMaterial), so the
    // map says which texel is which. One metalness of 0.6 over both made the
    // panes a grey mirror and the frames as dull as the glass.
    metalness: 1,
    metallic: true,
    envMapIntensity: 1.4,
    normalScale: 0.3,
    shade: (size) => {
      const n = makeNoise(0x39d4);
      return (x, y, out) => {
        // A curtain wall: 1.5 m panes between slim mullions and transoms.
        const pane = size / 2;
        const fu = x % pane;
        const fv = y % pane;
        const frame = Math.min(fu, pane - fu, fv, pane - fv) < 3;
        if (frame) {
          grey(out, 0.85);
          out.h = 1;
          out.rough = 0.4;
          out.metal = 1;
          return;
        }
        // The pane: dark, as the light goes through it into a dim room; what
        // it shows is its reflection (4 % head on, more towards grazing).
        const tint = cellHash(Math.floor(x / pane), Math.floor(y / pane), 0x12) * 0.05;
        grey(out, 0.16 + tint + (n((x / size) * 6, (y / size) * 6, 6) - 0.5) * 0.03);
        out.h = 0.4;
        out.rough = 0.07;
      };
    },
  },
  tile: {
    size: 256,
    worldSize: m(2),
    relief: 5.5,
    metalness: 0,
    envMapIntensity: 0.5,
    normalScale: 0.7,
    shade: (size) => {
      const grain = makeNoise(0x0bb5);
      return (x, y, out) => {
        // Eight 250 mm courses of ten barrel tiles; each course laps the one
        // below, which throws a line of shade along its edge.
        const course = size / 8;
        const row = Math.floor(y / course);
        const fv = (y - row * course) / course;
        const w = size / 10;
        const shifted = x + (row % 2 === 1 ? w / 2 : 0);
        const col = Math.floor(shifted / w) % 10;
        const fu = (shifted % w) / w;
        const barrel = Math.sin(fu * Math.PI);
        const lap = fv < 0.14 ? 0.55 + fv * 2.5 : 1;
        const g = grain((x / size) * 64, (y / size) * 64, 64);
        grey(out, (0.66 + barrel * 0.2 + cellHash(col, row, 0x2e) * 0.12 + (g - 0.5) * 0.05) * lap);
        out.h = barrel * 0.8 + fv * 0.2;
        out.rough = 0.8;
      };
    },
  },
};

/** One material per finish, textured where a document exists to bake on. */
export function createFinishMaterials(anisotropy = 8): Record<Finish, MeshStandardMaterial> {
  const canBake = typeof document !== 'undefined';
  const out = {} as Record<Finish, MeshStandardMaterial>;
  for (const finish of FINISHES) {
    const look = LOOKS[finish];
    // The shell is not a closed solid (openings, no underside), so it casts
    // from both sides.
    const material = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: look.metalness,
      envMapIntensity: look.envMapIntensity,
      shadowSide: DoubleSide,
    });
    if (canBake) {
      const bake = bakeSurface(
        `building-${finish}`,
        { size: look.size, worldSize: look.worldSize, relief: look.relief, shade: look.shade(look.size), ...(look.metallic ? { metallic: true } : {}) },
        anisotropy,
      );
      const repeat = 1 / look.worldSize;
      for (const map of [bake.map, bake.normalMap, bake.roughnessMap]) map.repeat.set(repeat, repeat);
      material.map = bake.map;
      material.normalMap = bake.normalMap;
      // Relief in proportion to the real surface: at a building's scale a
      // strong normal map turns render into popcorn and joints into trenches.
      material.normalScale.set(look.normalScale, look.normalScale);
      material.roughnessMap = bake.roughnessMap;
      if (look.metallic) material.metalnessMap = bake.roughnessMap;
    } else {
      material.roughness = 0.9;
      // No map to say where the metal is: the larger part, the glass.
      if (look.metallic) material.metalness = 0;
    }
    material.name = `building-${finish}`;
    applyWeathering(material, finish);
    out[finish] = material;
  }
  return out;
}

/**
 * Buildings that are not maintained run down (the player's order of
 * 2026-10-05): rain streaks down the walls, grime rises from the foot, paint
 * peels off in patches to the render under it, roofs go dark with moss.
 * `aDecay` (0 new, 1 falling apart) comes per vertex from the building's
 * record; the marks are laid by world position so no two walls match.
 */
function applyWeathering(material: MeshStandardMaterial, finish: Finish): void {
  const roof = finish === 'roofing' || finish === 'tile' || finish === 'slate';
  const glassy = finish === 'glass' || finish === 'metal';
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aDecay;\nvarying float vDecay;\nvarying vec3 vDecayWorld;\nvarying vec3 vDecayNormal;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvDecay = aDecay;\nvDecayWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvDecayNormal = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vDecay;
        varying vec3 vDecayWorld;
        varying vec3 vDecayNormal;
        float dHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float dNoise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(dHash(i), dHash(i + vec3(1, 0, 0)), f.x), mix(dHash(i + vec3(0, 1, 0)), dHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(dHash(i + vec3(0, 0, 1)), dHash(i + vec3(1, 0, 1)), f.x), mix(dHash(i + vec3(0, 1, 1)), dHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (vDecay > 0.001) {
          // After the texture: the stains darken the finish as painted.
          float d = vDecay;
          vec3 w = vDecayWorld;
          bool wall = abs(vDecayNormal.y) < 0.5;
          // Rain streaks: thin, long, running down from sills and copings.
          float streak = smoothstep(0.55, 0.85, dNoise(vec3(w.x * 2.2, w.y * 0.08, w.z * 2.2)));
          // Grime: darker towards the foot of the wall and in soft patches.
          float grime = 0.5 + 0.5 * dNoise(w * 0.22);
          float darken = d * (0.18 + 0.12 * grime + (wall ? 0.28 * streak : 0.1));
          diffuseColor.rgb *= 1.0 - darken;
          ${glassy ? '' : roof ? `
          // Dark moss in the low corners of the roof.
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.55, 0.62, 0.45), d * 0.6 * smoothstep(0.6, 0.85, dNoise(w * 0.3)));` : `
          // Paint gone in a few small patches, the darker render showing.
          float peel = smoothstep(0.8 - d * 0.12, 0.83 - d * 0.12, dNoise(w * 1.3 + 7.0));
          if (wall) diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.72, 0.68, 0.62), peel * d);`}
        }`)
      // The relief faded as a texel shrinks under a pixel: a normal map does
      // not average down its mips like colour does, so from the middle
      // distance each pixel caught a random bump and the walls sparkled
      // (specular aliasing; Toksvig, "Mipmapping Normal Maps"). Full relief
      // up close, none once a texel is a third of a pixel.
      .replace('mapN.xy *= normalScale;', `mapN.xy *= normalScale;
        {
          vec2 texelsPerPixel = fwidth(vNormalMapUv) * vec2(textureSize(normalMap, 0));
          mapN.xy *= 1.0 - smoothstep(0.6, 3.0, max(texelsPerPixel.x, texelsPerPixel.y));
        }`);
  };
  material.customProgramCacheKey = () => `building-weathering-v2-${finish}`;
}
