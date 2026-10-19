import type { Object3D } from 'three';

/** THE EFFECT SWITCHES: every effect and layer of the drawing, each turned off to measure what it costs the GPU (the effects panel, `effectsWiring.ts`). */

/** The post chain's passes (`postprocess.ts`): skipped by the composer when off (three's EffectComposer, `pass.enabled === false`). */
export const POST_SWITCHES = ['ambientOcclusion', 'canyonLight', 'bloom', 'clouds', 'smaa', 'sharpen'] as const;
/** The light: shadows, the sky's reflection and each light. */
export const LIGHT_SWITCHES = ['shadows', 'shadowUpdate', 'environmentMap', 'skyFill', 'ambient', 'fillLight', 'pointLights', 'surfaceDetail'] as const;
/** What is drawn, layer by layer: hidden only while the frame is drawn (what the game sets each frame stands). */
export const LAYER_SWITCHES = ['terrain', 'water', 'roads', 'farRoads', 'buildings', 'vegetation', 'furniture', 'props', 'transit', 'people', 'farTraffic', 'signals', 'particles', 'weather'] as const;

/** The buildings, part by part and piece by piece (`buildingSwitches.ts`), their shadows and their lit windows. */
export const BUILDING_SWITCHES = ['bMasses', 'bFarTiles', 'bFacadeLevel', 'bDetail', 'bParts', 'bSignatures', 'bFlags',
  'bShell', 'bGlass', 'bFrames', 'bFacadeDetails', 'bProps', 'bLots', 'bFurniture', 'bShadows', 'bNightWindows'] as const;

export type PostSwitch = (typeof POST_SWITCHES)[number];
export type LightSwitch = (typeof LIGHT_SWITCHES)[number];
export type LayerSwitch = (typeof LAYER_SWITCHES)[number];
export type BuildingSwitch = (typeof BUILDING_SWITCHES)[number];
export type EffectSwitch = PostSwitch | LightSwitch | LayerSwitch | BuildingSwitch;
export type EffectSwitches = Readonly<Record<EffectSwitch, boolean>>;
export type PostSwitches = Readonly<Record<PostSwitch, boolean>>;

export const ALL_EFFECTS_ON: EffectSwitches = Object.freeze(Object.fromEntries(
  [...POST_SWITCHES, ...LIGHT_SWITCHES, ...LAYER_SWITCHES, ...BUILDING_SWITCHES].map((key) => [key, true]),
) as Record<EffectSwitch, boolean>);

/** The buildings' settings that are not on or off. */
export interface BuildingChoices {
  /** Their own materials, one plain lit grey (Lambert), or one unlit (Basic): what their shading costs. */
  readonly material: 'normal' | 'lambert' | 'basic';
  /** The share of the view's budget of triangles their levels of detail fit (`frameBudget.ts`); 0: no budget at all. */
  readonly triangles: number;
  /** The most their cells' detail may hold on the GPU, MB (`BuildingLayer.setDetailBudget`); -1: as the game sets it. */
  readonly detailMemoryMB: number;
}
export const DEFAULT_BUILDING_CHOICES: BuildingChoices = Object.freeze({ material: 'normal', triangles: 1, detailMemoryMB: -1 });

export function isEffectSwitch(key: string): key is EffectSwitch {
  return key in ALL_EFFECTS_ON;
}

/** The objects hidden for one frame, shown again as they were once it is drawn. */
export interface FrameHider {
  hide(objects: readonly (Object3D | null | undefined)[]): void;
  restore(): void;
}

export function createFrameHider(): FrameHider {
  const hidden: Object3D[] = [];
  return {
    hide(objects) {
      for (const object of objects) {
        if (!object || !object.visible) continue;
        object.visible = false;
        hidden.push(object);
      }
    },
    restore() {
      for (const object of hidden) object.visible = true;
      hidden.length = 0;
    },
  };
}
