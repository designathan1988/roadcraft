import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  AdditiveBlending,
  FrontSide,
  type Material,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Finish } from '@world/buildings/materials';
import { createFinishMaterials, finishAlbedo } from './finishes';
import { createFurnitureGeometries, createFurnitureMaterial, furnitureTones } from './furnitureKit';
import type { FurnitureKind } from '@world/buildings/interior';
import { NIGHT_LUMINANCE, lightPoolTexture, luminanceOf } from '../lightLevels';
import { createMassingMaterial } from './massingMaterial';
import { prefilterThinParts, twoSided } from './thinParts';
import { roomBehindGlass } from './glassRoom';
import { FACADE_PROP_KINDS, type FacadePropKind, SHADOWED_PROPS, THIN_PROPS } from './facadeProps';
import { acFarGeometry, createFacadePropGeometries } from './facadePropModels';
import { simplified } from '../mesh/simplify';
import { m } from '@world/units';

/**
 * Share of people awake, by hour from midnight: 100 % less the share asleep in
 * the American Time Use Survey 2007-11 (BLS table A-3,
 * https://www.bls.gov/tus/tables/a3_0711.htm). A lit window is a room with
 * somebody home and awake in it (Richardson et al., "Domestic lighting: a
 * high-resolution energy demand model", 2009: lights follow active occupancy
 * once the daylight outside drops), so this is the share of rooms lit after dark.
 */
const AWAKE_BY_HOUR = [
  0.174, 0.095, 0.063, 0.051, 0.082, 0.146, 0.34, 0.579, 0.755, 0.864, 0.924, 0.951,
  0.964, 0.959, 0.958, 0.961, 0.964, 0.97, 0.975, 0.973, 0.95, 0.855, 0.628, 0.349,
];
/** The awake share at a clock time (hours), between the survey's hourly figures. */
export function awakeShare(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  const a = AWAKE_BY_HOUR[i] as number;
  const b = AWAKE_BY_HOUR[(i + 1) % 24] as number;
  return a + (b - a) * (h - i);
}
/** The share the glass reads (`setNight`). */
const roomsAwake = { value: awakeShare(22) };
/**
 * How bright a room seen through its window is by day, as light it sends out
 * (`setNight`): a room is lit by the daylight its window lets in, not by the
 * sun on the facade, so it is drawn unlit behind the glass, as interior
 * mapping draws it (van Dongen 2008; SimCity's, rebuilt by Golus) - a fifth
 * of its colour in full day (an interior is far darker than the street
 * outside; a quarter drew every room as a lit picture), none at night (the
 * lamps take over).
 */
const ROOM_DAYLIGHT = 0.2;
const roomDaylight = { value: 0 };
/** Seconds since the kit was made, for a television's flicker (`roomLamps.ts`). */
const tvClock = { value: 0 };

/**
 * Everything the buildings layer draws with, built ONCE per renderer.
 *
 * CLAUDE.md: materials and textures are made once and never inside a
 * rebuild, and repeated scene parts are instanced. Each component part here
 * is a unit geometry in a component frame - X along the facade, Y up, Z out
 * of the wall - scaled and turned per instance by `buildingMesh.ts`.
 */

export type PartKind =
  | 'glass'
  | 'frame'
  | 'concrete'
  | 'door'
  | 'shutter'
  | 'railing'
  | 'roofRailing'
  | 'awning'
  | 'column'
  | 'glassDark'
  | 'water'
  | 'lamp'
  | 'wash'
  | 'fin'
  | 'louvre'
  | 'glassRail'
  | 'brise'
  | FacadePropKind;

export const PART_KINDS: readonly PartKind[] = [
  'glass',
  'frame',
  'concrete',
  'door',
  'shutter',
  'railing',
  'roofRailing',
  'awning',
  'column',
  'glassDark',
  'water',
  'lamp',
  'wash',
  'fin',
  'louvre',
  'glassRail',
  'brise',
  ...FACADE_PROP_KINDS,
];

/** The lantern beside a front door: a warm lamp behind frosted glass. */
const PORCH_LIGHT = 0xffd49a;
/**
 * A lit room's mean brightness over the glass (`roomLit` in the pane's
 * shader: 0.55-1.25 for a lit room, 0.45-1.35 drawn by lot, both 0.9 on
 * average), so the mean lit pane sits at `NIGHT_LUMINANCE.window`.
 */
const ROOM_LIT_MEAN = 0.9;

/** The lantern beside a front door: width, height and depth out of the wall; its gap from the door's edge. */
export const PORCH_LAMP = { w: m(0.16), h: m(0.26), d: m(0.12), gap: m(0.4) } as const;
/** How far the wash of its light (the `wash` part, placed at the lantern's centre) stands out of the wall. */
const WASH_OUT = m(0.01);
/**
 * Outside lights after dark. 43 % of homes leave one on all night (EIA,
 * Residential Energy Consumption Survey 2024, table HC5.9: 57.5 of 132.5
 * million); the others light theirs while somebody is up (LRC/NYSERDA
 * assume about 4 hours a night), so with the share awake (`awakeShare`).
 * Each lamp draws its own lot by where it stands, in cells of about 4 m, so
 * a lantern, the light it throws on the wall and the lamps of one gate draw
 * the same.
 */
const ALL_NIGHT = 0.43;
/** The share of outside lights lit at a clock time (hours). */
function outsideLit(hour: number): number {
  return ALL_NIGHT + (1 - ALL_NIGHT) * awakeShare(hour);
}
const outsideOn = { value: outsideLit(22) };
/** The lot a lamp draws, from its instance's position (`outsideOn`), for both the lantern and its wash. */
const LAMP_LOT_VERTEX = `
#ifdef USE_INSTANCING
  vLampLot = fract(sin(dot(floor(instanceMatrix[3].xyz * 0.1), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
#else
  vLampLot = 0.0;
#endif`;
/** Switches an outside light by its lot. */
function scheduleOutsideLight(material: Material, key: string, after: string, apply: string): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms['outsideOn'] = outsideOn;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLampLot;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>${LAMP_LOT_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float outsideOn;\nvarying float vLampLot;')
      .replace(after, `${after}\n  ${apply}`);
  };
  material.customProgramCacheKey = () => key;
}

export interface BuildingKit {
  readonly geometry: Readonly<Record<PartKind, BufferGeometry>>;
  /** Lighter geometry for the parts whose depth is lost from afar (`FAR_KINDS`). */
  readonly far: Readonly<Partial<Record<PartKind, BufferGeometry>>>;
  /** The thin parts drawn by their far versions whose shadow goes too when it is under a pixel (`setShadowFar`). */
  readonly farShadows: ReadonlySet<PartKind>;
  /** Settles when the simplified far versions of the small props are in `far` (`SIMPLIFIED_FAR`). */
  readonly farReady: Promise<void>;
  readonly material: Readonly<Record<PartKind, Material>>;
  /** The merged shell - walls, plinths, bands, roofs, steps - one material per finish, vertex coloured. */
  readonly shell: Readonly<Record<Finish, MeshStandardMaterial>>;
  /** Ghost materials for the placement / drag preview, tinted by validity. */
  readonly ghostShell: MeshStandardMaterial;
  readonly ghostParts: MeshStandardMaterial;
  /** "Ocultar outros": the same shells, faded, for every building but the edited one. */
  readonly dimShell: Readonly<Record<Finish, MeshStandardMaterial>>;
  readonly dimParts: MeshStandardMaterial;
  /** Each finish's colour from afar (`finishes.ts` `finishAlbedo`), for the far level of the buildings. */
  readonly finishTone: Readonly<Record<Finish, readonly [number, number, number]>>;
  /** Buildings seen from afar, their windows drawn by the shader (`massing.ts`, `massingMaterial.ts`). */
  readonly massing: MeshStandardMaterial;
  /** Parts that cast shadows; the small ones do not, to spare the shadow pass. */
  readonly castsShadow: ReadonlySet<PartKind>;
  /** The furniture models, built the first time an interior is drawn. */
  furniture(): { readonly geometry: Readonly<Record<FurnitureKind, BufferGeometry>>; readonly material: MeshStandardMaterial };
  setGhostValid(valid: boolean): void;
  /**
   * Lights the windows from inside as night falls: 0 by day, 1 at night;
   * `hour` (clock hours) decides how many rooms are lit (`awakeShare`).
   */
  setNight(dark: number, hour?: number): void;
  dispose(): void;
}

/** The props drawn from afar by a simplified copy (`createBuildingKit` `farReady`): the heaviest, their detail under a pixel there. */
// Not the louvres and brises: boxes of slats the simplifier cannot reduce within the error (measured).
const SIMPLIFIED_FAR: readonly PartKind[] = ['bike', 'foliage', 'kettle', 'bush', 'airer', 'table', 'dish', 'pot', 'chair', 'grill', 'lounger'];

/** A box of the given size whose centre is at (x, y, z). */
function box(w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Window frame: outer border, a mullion and a transom, in a unit square. */
function frameGeometry(): BufferGeometry {
  const t = 0.045;
  const parts = [
    box(1, t, 1, 0, 0.5 - t / 2, 0),
    box(1, t, 1, 0, -0.5 + t / 2, 0),
    box(t, 1, 1, 0.5 - t / 2, 0, 0),
    box(t, 1, 1, -0.5 + t / 2, 0, 0),
    box(t * 0.8, 1, 1, 0, 0, 0),
    box(1, t * 0.8, 1, 0, 0.18, 0),
  ];
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/** A balcony railing: top rail and balusters on three sides, z from 0 (wall) to 1. */
function railingGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [
    box(1, 0.06, 0.05, 0, 0.97, 1),
    box(0.05, 0.06, 1, -0.5, 0.97, 0.5),
    box(0.05, 0.06, 1, 0.5, 0.97, 0.5),
    box(1, 0.04, 0.03, 0, 0.12, 1),
  ];
  for (let i = 0; i <= 10; i++) parts.push(box(0.015, 0.94, 0.015, -0.5 + i / 10, 0.5, 1));
  for (let i = 1; i < 4; i++) {
    parts.push(box(0.015, 0.94, 0.015, -0.5, 0.5, i / 4));
    parts.push(box(0.015, 0.94, 0.015, 0.5, 0.5, i / 4));
  }
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/** A flat quad facing `axis` ('z' out of the wall, 'x' along it), centred at (x, y, z). */
function quad(w: number, h: number, x: number, y: number, z: number, axis: 'z' | 'x' | '-x' = 'z'): BufferGeometry {
  const g = new PlaneGeometry(w, h);
  if (axis === 'x') g.rotateY(Math.PI / 2);
  if (axis === '-x') g.rotateY(-Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/**
 * The far versions: what of a part is seen from a distance, its faces to the
 * street only. A frame bar is a pixel or less from the overview; its sides,
 * top and back were five sixths of its triangles and two million in a town.
 */
function frameFarGeometry(): BufferGeometry {
  const t = 0.045;
  const parts = [
    quad(1, t, 0, 0.5 - t / 2, 0.5),
    quad(1, t, 0, -0.5 + t / 2, 0.5),
    quad(t, 1, 0.5 - t / 2, 0, 0.5),
    quad(t, 1, -0.5 + t / 2, 0, 0.5),
    quad(t * 0.8, 1, 0, 0, 0.5),
    quad(1, t * 0.8, 0, 0.18, 0.5),
  ];
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

function railingFarGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [
    quad(1, 0.06, 0, 0.97, 1.025),
    quad(1, 0.04, 0, 0.12, 1.015),
    quad(1, 0.06, -0.525, 0.97, 0.5, '-x'),
    quad(1, 0.06, 0.525, 0.97, 0.5, 'x'),
  ];
  for (let i = 0; i <= 10; i++) parts.push(quad(0.015, 0.94, -0.5 + i / 10, 0.5, 1.0075));
  for (let i = 1; i < 4; i++) {
    parts.push(quad(0.015, 0.94, -0.5075, 0.5, i / 4, '-x'));
    parts.push(quad(0.015, 0.94, 0.5075, 0.5, i / 4, 'x'));
  }
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return twoSided(merged);
}

function roofRailingFarGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [quad(1, 0.06, 0, 0.97, 0.025), quad(1, 0.04, 0, 0.45, 0.015)];
  for (let i = 0; i <= 4; i++) parts.push(quad(0.02, 0.94, -0.5 + i / 4, 0.5, 0.01));
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return twoSided(merged);
}

/** A straight railing along a roof edge, centred at z = 0. */
function roofRailingGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [box(1, 0.06, 0.05, 0, 0.97, 0), box(1, 0.04, 0.03, 0, 0.45, 0)];
  for (let i = 0; i <= 4; i++) parts.push(box(0.02, 0.94, 0.02, -0.5 + i / 4, 0.5, 0));
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * A door leaf in the component frame: a slab with two raised panels on each
 * leaf half, a lock rail between them and a handle - not a brown rectangle.
 */
function doorGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [box(1, 1, 0.6, 0, 0, -0.2)];
  for (const x of [-0.24, 0.24]) {
    parts.push(box(0.36, 0.5, 0.35, x, 0.2, 0.25));
    parts.push(box(0.36, 0.3, 0.35, x, -0.3, 0.25));
  }
  // The handle, at hand height, near the lock stile.
  parts.push(box(0.1, 0.035, 1.6, 0.4, -0.04, 0.9));
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/** A shop awning: a sloped canvas from the wall (y 0, z 0) down and out, with a valance. */
/**
 * A louvred shutter leaf: a stile-and-rail frame round slats tilted to shed
 * rain, the persiana of a Brazilian sash or casement window. Unit size, X
 * across, Y up, Z out of the wall.
 */
function louvreGeometry(): BufferGeometry {
  const t = 0.09;
  const parts: BufferGeometry[] = [
    box(1, t, 1, 0, 0.5 - t / 2, 0), box(1, t, 1, 0, -0.5 + t / 2, 0),
    box(t, 1, 1, 0.5 - t / 2, 0, 0), box(t, 1, 1, -0.5 + t / 2, 0, 0),
    box(1, 0.6 * t, 0.6, 0, 0, -0.2),
  ];
  for (let k = 0; k < 9; k++) {
    const slat = new BoxGeometry(1 - 2 * t, 0.07, 0.7);
    slat.rotateX(-0.6);
    slat.translate(0, -0.42 + k * 0.105, -0.1);
    parts.push(slat);
  }
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * A glass parapet: a clear pane the full width standing on the slab, a slim
 * metal cap along its top. Unit width, unit height from Y 0 (the floor) up,
 * centred on Z 0.
 */
function glassRailGeometry(): BufferGeometry {
  const pane = box(1, 0.92, 0.02, 0, 0.48, 0);
  const merged = mergeGeometries([pane]) as BufferGeometry;
  pane.dispose();
  return merged;
}

/**
 * A bay's rack of sun fins: six vertical blades across the unit width, the
 * storey's height, standing out of the wall (Z, unit depth centred on 0).
 * One instance a bay, scaled to it: the fins drawn one by one were thirty
 * thousand instances in a city.
 */
export const BRISE_FINS = 6;
function briseGeometry(): BufferGeometry {
  const t = 0.035;
  const parts: BufferGeometry[] = [];
  for (let k = 0; k < BRISE_FINS; k++) parts.push(box(t, 1, 1, -0.5 + t / 2 + (k * (1 - t)) / (BRISE_FINS - 1), 0, 0));
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

function awningGeometry(): BufferGeometry {
  const canvas = new BoxGeometry(1, 0.04, 1.08);
  canvas.rotateX(Math.atan2(0.75, 1));
  canvas.translate(0, -0.38, 0.5);
  // The valance hangs from the canvas's front edge, overlapping it a little:
  // set apart from it by hand, it left a slot of sky between the two (the
  // player, 2026-10-13, "buraco no meio").
  canvas.computeBoundingBox();
  const edge = canvas.boundingBox!;
  const valance = box(1, 0.28, 0.025, 0, edge.min.y + 0.03 - 0.14, edge.max.z - 0.0125);
  const merged = mergeGeometries([canvas, valance]) as BufferGeometry;
  canvas.dispose();
  valance.dispose();
  return merged;
}

export function createBuildingKit(): BuildingKit {
  const unitBox = new BoxGeometry(1, 1, 1);
  const glassPlane = new PlaneGeometry(1, 1);
  const geometry: Record<PartKind, BufferGeometry> = {
    glass: glassPlane,
    frame: frameGeometry(),
    concrete: unitBox,
    door: doorGeometry(),
    shutter: unitBox,
    railing: railingGeometry(),
    roofRailing: roofRailingGeometry(),
    awning: awningGeometry(),
    column: new CylinderGeometry(0.5, 0.5, 1, 12),
    glassDark: glassPlane,
    water: unitBox,
    lamp: unitBox,
    // Placed at the lantern's centre (the same lot), the plane drawn back on the wall.
    wash: new PlaneGeometry(1, 1).translate(0, 0, -(PORCH_LAMP.d / 2 - WASH_OUT)),
    fin: unitBox,
    louvre: louvreGeometry(),
    glassRail: glassRailGeometry(),
    brise: briseGeometry(),
    ...createFacadePropGeometries(),
  };

  const concrete = new MeshStandardMaterial({ color: 0xcfc9bd, roughness: 0.82, metalness: 0 });
  const metal = new MeshStandardMaterial({ color: 0x33373a, roughness: 0.45, metalness: 0.55 });
  const material: Record<PartKind, Material> = {
    // Both sides in the shadow pass: a pane is one-sided, and three draws a
    // front-sided material's BACK faces for shadows, so a pane facing the sun
    // would let it straight through.
    // Glossy enough to carry the sky. A dielectric (metalness 0, Filament "Metallic"): its sheen is the 4 %
    // Fresnel reflection that grows towards grazing, never a tinted mirror.
    glass: new MeshStandardMaterial({ color: 0x7c8e98, roughness: 0.06, metalness: 0, envMapIntensity: 1.6, shadowSide: DoubleSide }),
    // White: each frame takes its building's trim as an instance colour
    // (`buildingMesh.ts` COLOURED_PARTS) - black, bronze, green, wood, white.
    frame: new MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.05 }),
    concrete,
    door: new MeshStandardMaterial({ color: 0x6b4a33, roughness: 0.55, metalness: 0 }),
    shutter: new MeshStandardMaterial({ color: 0x9aa1a4, roughness: 0.5, metalness: 0.45 }),
    // Its own material, white, coloured per instance like the frames: a
    // material shared with uncoloured batches would switch program variants.
    railing: new MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.55 }),
    roofRailing: metal,
    // Per-instance colours (with the frames and railings), and it alone uses this material.
    awning: new MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 }),
    column: concrete,
    // Window variety: a pane that reflects less (a darker room behind it) -
    // no two rows of windows alike.
    glassDark: new MeshStandardMaterial({ color: 0x5d6c74, roughness: 0.08, metalness: 0, envMapIntensity: 1.3, shadowSide: DoubleSide }),
    // Pool water: clear, glossy and a little turquoise, the tiled floor showing
    // through it - not a blue tile texture laid at the rim.
    water: new MeshStandardMaterial({
      color: 0x58c4dd, roughness: 0.03, metalness: 0.15, envMapIntensity: 1.8,
      transparent: true, opacity: 0.62, depthWrite: false,
    }),
    // The lantern beside a front door: frosted glass by day, a lamp after dark.
    lamp: new MeshStandardMaterial({ color: 0xf1ebdd, roughness: 0.35, metalness: 0, emissive: PORCH_LIGHT, emissiveIntensity: 0 }),
    // The light the lantern throws on the wall round it: laid on the wall
    // additively, as a decal (pulled towards the eye so it never fights the
    // wall for depth), seen only after dark.
    // Sun fins and window surrounds, in the trim's colour per instance (`COLOURED_PARTS`).
    fin: new MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0 }),
    // Brise-soleil racks, concrete or painted metal in the trim's colour per instance.
    brise: new MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0 }),
    // Louvred shutters, painted wood, coloured per instance.
    louvre: new MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, metalness: 0 }),
    // A balcony's glass parapet: pale green-grey laminated glass, half seen through.
    glassRail: new MeshStandardMaterial({
      color: 0xa9c4c4, roughness: 0.05, metalness: 0.2, envMapIntensity: 1.4, transparent: true, opacity: 0.42, depthWrite: false,
    }),
    // The props on the facades and balconies (`facadeProps.ts`): toned per
    // vertex (a condenser's dark grille), tinted per instance. The leaves are
    // single strips, seen from both sides.
    acUnit: new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.55, metalness: 0.15 }),
    pot: new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85, metalness: 0 }),
    foliage: new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.75, metalness: 0, side: DoubleSide, shadowSide: DoubleSide }),
    bush: new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0, side: DoubleSide, shadowSide: DoubleSide }),
    grill: new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0 }),
    kettle: new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0.3 }),
    lounger: new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.75, metalness: 0 }),
    // The wheels are rings seen from both sides.
    bike: new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.4, metalness: 0.3, side: DoubleSide }),
    chair: new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0 }),
    table: new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.55, metalness: 0.1 }),
    airer: new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0 }),
    dish: new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0.2 }),
    wash: new MeshBasicMaterial({
      map: lightPoolTexture(), color: PORCH_LIGHT, transparent: true, opacity: 0, blending: AdditiveBlending,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, visible: false,
    }),
  };
  for (const [kind, m] of Object.entries(material)) m.name = `building-part-${kind}`;
  // A part laid on the shell in its plane - a balcony's slab on the roof of
  // the block beside it, a sill on its wall - wins it for depth everywhere
  // instead of pixel by pixel (z-fighting: the player, 2026-10-13, "objetos se
  // sobrepondo e piscando"): pulled towards the eye by a few depth steps, as
  // a decal is (OpenGL `glPolygonOffset`, three's `Material.polygonOffset`).
  // The source meant every part so (its `coplanar.spec`) and the parts here
  // had lost it.
  for (const m of Object.values(material)) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -4;
  }
  prefilterThinParts(material, THIN_PROPS);
  scheduleOutsideLight(material.lamp, 'outside-lamp-lot', '#include <emissivemap_fragment>', 'totalEmissiveRadiance *= step(vLampLot, outsideOn);');
  scheduleOutsideLight(material.wash, 'outside-wash-lot', '#include <color_fragment>', 'diffuseColor.a *= step(vLampLot, outsideOn);');
  // The furniture's models, made once: drawn in a cut-open interior, and
  // their colours read by the windows for the piece seen through them.
  const furnitureGeometry = createFurnitureGeometries();
  const tones = furnitureTones(furnitureGeometry);
  for (const kind of ['glass', 'glassDark'] as const) roomBehindGlass(material[kind] as MeshStandardMaterial, kind, { tones, roomsAwake, roomDaylight, tvClock });
  const shell = createFinishMaterials();
  const ghostShell = new MeshStandardMaterial({
    color: 0x65e5c3,
    emissive: new Color(0x1d5a4a),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    roughness: 0.7,
    side: FrontSide,
  });
  const ghostParts = ghostShell.clone();

  // The faded copies: same colour and maps, a fraction of the presence, and no
  // depth write, so the edited building reads through them.
  const dim = (m: MeshStandardMaterial): MeshStandardMaterial => {
    const faded = m.clone();
    faded.transparent = true;
    faded.opacity = 0.22;
    faded.depthWrite = false;
    faded.color.multiplyScalar(0.75);
    return faded;
  };
  const dimShell = Object.fromEntries(Object.entries(shell).map(([finish, mat]) => [finish, dim(mat)])) as Record<Finish, MeshStandardMaterial>;
  const dimParts = dim(material['concrete'] as MeshStandardMaterial);
  dimParts.opacity = 0.16;

  // How bright a lit window glows from afar: set with the detailed panes' (`setNight`).
  const massingNight = { value: 0 };
  const massing = createMassingMaterial({ roomsAwake, massingNight });
  const unique = new Set<Material>([...Object.values(material), ...Object.values(shell), ...Object.values(dimShell), ghostShell, ghostParts, dimParts, massing]);
  const far: Partial<Record<PartKind, BufferGeometry>> = {
    frame: frameFarGeometry(),
    railing: railingFarGeometry(),
    roofRailing: roofRailingFarGeometry(),
    acUnit: acFarGeometry(),
  };
  const geometries = new Set<BufferGeometry>([...Object.values(geometry), ...Object.values(far)]);
  const farShadows = new Set(Object.keys(far) as PartKind[]);
  // LOD OF THE SMALL PROPS: the balconies' life is 80-240 triangles a piece
  // with no far version, a pixel or two each from the overview (2026-10-14).
  // Simplified once by meshoptimizer (`mesh/simplify.ts`, error 4 % of the
  // prop's size: 2 cm on a 0.5 m pot, 0.15 px at the far zoom of 7.5 px/m),
  // drawn from afar as the hand-made far frames are (`layer.ts` `applyDetail`).
  // NÃO trocar por cortar as peças de longe: a versão simplificada é a mesma peça.
  const farReady = Promise.all(SIMPLIFIED_FAR.map(async (kind) => {
    const lighter = await simplified(geometry[kind], 0.3, 0.04);
    if (lighter === geometry[kind]) return;
    far[kind] = lighter;
    geometries.add(lighter);
  })).then(() => {}, (error: unknown) => { console.error('Simplified far props failed', error); });
  let furniture: { geometry: Record<FurnitureKind, BufferGeometry>; material: MeshStandardMaterial } | null = null;

  return {
    geometry,
    far,
    farShadows,
    farReady,
    material,
    shell,
    ghostShell,
    ghostParts,
    dimShell,
    dimParts,
    massing,
    finishTone: finishAlbedo(),
    // Glass, doors and shutters close the openings for the sun: without them
    // the shadow of every building is a lattice of lit windows.
    castsShadow: new Set<PartKind>(['glass', 'glassDark', 'frame', 'door', 'shutter', 'concrete', 'railing', 'awning', 'column', 'roofRailing', 'fin', 'louvre', 'brise', ...SHADOWED_PROPS]),
    furniture() {
      if (!furniture) {
        furniture = { geometry: furnitureGeometry, material: createFurnitureMaterial() };
        for (const g of Object.values(furniture.geometry)) geometries.add(g);
        unique.add(furniture.material);
      }
      return furniture;
    },
    setNight(dark, hour) {
      if (hour !== undefined) {
        roomsAwake.value = awakeShare(hour);
        outsideOn.value = outsideLit(hour);
      }
      // Rooms lit behind the glass: a warm glow, brighter than any lit wall
      // (`lightLevels.ts`), less behind the darker glass.
      // White: each room's lamp gives the colour (`roomLamps.ts`, luminance 1).
      const room = NIGHT_LUMINANCE.window / ROOM_LIT_MEAN;
      for (const [kind, k] of [['glass', 1], ['glassDark', 0.64]] as const) {
        const mat = material[kind] as MeshStandardMaterial;
        mat.emissive.setHex(0xffffff);
        mat.emissiveIntensity = dark * k * room;
      }
      tvClock.value = performance.now() / 1000;
      massingNight.value = dark * room;
      roomDaylight.value = (1 - dark) * ROOM_DAYLIGHT;
      // The lanterns at the front doors, and their light on the wall.
      (material.lamp as MeshStandardMaterial).emissiveIntensity = dark * NIGHT_LUMINANCE.porchLamp / luminanceOf(PORCH_LIGHT);
      const wash = material.wash as MeshBasicMaterial;
      wash.opacity = 0.55 * dark;
      wash.visible = dark > 0.02;
    },
    setGhostValid(valid) {
      for (const m of [ghostShell, ghostParts]) {
        m.color.setHex(valid ? 0x65e5c3 : 0xff6f63);
        m.emissive.setHex(valid ? 0x1d5a4a : 0x5a1d1d);
      }
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of unique) m.dispose();
    },
  };
}
