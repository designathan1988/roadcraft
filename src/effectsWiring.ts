import { ALL_EFFECTS_ON, BUILDING_SWITCHES, DEFAULT_BUILDING_CHOICES, LAYER_SWITCHES, LIGHT_SWITCHES, POST_SWITCHES, isEffectSwitch, type BuildingChoices, type EffectSwitch, type EffectSwitches } from '@render/effectSwitches';
import { DEFAULT_OPTIMIZATIONS, OPTIMIZATIONS, optimizationChoice, optimizationSpec, type OptId, type OptValue, type OptimizationSpec, type Optimizations } from '@render/optimizations';
import type { SceneHandle } from '@render/renderer';
import { createEffectsPanel, type EffectsPanel, type EffectsPanelGroup } from '@ui/effectsPanel';
import { t } from '@ui/i18n';

/** THE EFFECTS PANEL'S WIRING, out of `main.ts`: the GPU's effects switched in the renderer (`effectSwitches.ts`), the CPU's systems in the frame, the resolution, kept between runs (`roadcraft.effects`). */

/** The frame's heavy systems on the CPU, each on as the game runs. */
const CPU_SWITCHES = ['simulation', 'traffic', 'pedestrians', 'growth', 'onDemand'] as const;
type CpuSwitch = (typeof CPU_SWITCHES)[number];
type CpuSwitches = Readonly<Record<CpuSwitch, boolean>>;
const ALL_CPU_ON: CpuSwitches = { simulation: true, traffic: true, pedestrians: true, growth: true, onDemand: true };

/** The buildings' settings of several values, each with its values as the panel offers them (`BuildingChoices`). */
const BUILDING_CHOICES: readonly { key: string; field: keyof BuildingChoices; values: readonly (string | number)[] }[] = [
  { key: 'bMaterial', field: 'material', values: ['normal', 'lambert', 'basic'] },
  { key: 'bTriangles', field: 'triangles', values: [1, 0.5, 0.25, 0.1, 0.02, 0] },
  { key: 'bDetailMemory', field: 'detailMemoryMB', values: [-1, 1024, 512, 256, 128, 32, 0] },
];

const STORE_KEY = 'roadcraft.effects';
/** The lab's optimisations kept apart (`optimizations.ts`): only those set away from the game's own. */
const OPT_STORE_KEY = 'roadcraft.optimizations';
/** The frames the readings average over. */
const AVERAGE_OF = 60;

interface Kept {
  readonly effects: EffectSwitches;
  readonly cpu: CpuSwitches;
  readonly resolution: number;
  readonly buildings: BuildingChoices;
}

function readKept(): Kept {
  const kept = { effects: { ...ALL_EFFECTS_ON }, cpu: { ...ALL_CPU_ON }, resolution: 1, buildings: { ...DEFAULT_BUILDING_CHOICES } as Record<keyof BuildingChoices, unknown> };
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '{}') as { effects?: Record<string, unknown>; cpu?: Record<string, unknown>; resolution?: unknown; buildings?: Record<string, unknown> };
    for (const { field, values } of BUILDING_CHOICES) if (values.includes(raw.buildings?.[field] as string | number)) kept.buildings[field] = raw.buildings![field];
    for (const [key, on] of Object.entries(raw.effects ?? {})) if (isEffectSwitch(key) && typeof on === 'boolean') kept.effects[key] = on;
    for (const key of CPU_SWITCHES) if (typeof raw.cpu?.[key] === 'boolean') kept.cpu[key] = raw.cpu[key];
    if (typeof raw.resolution === 'number' && raw.resolution > 0 && raw.resolution <= 1) kept.resolution = raw.resolution;
  } catch (error) {
    console.warn('effects panel settings unreadable: everything on', error);
  }
  return { ...kept, buildings: kept.buildings as unknown as BuildingChoices };
}

function readOptimizations(): Optimizations {
  const kept: Record<string, OptValue> = { ...DEFAULT_OPTIMIZATIONS };
  try {
    const raw = JSON.parse(window.localStorage.getItem(OPT_STORE_KEY) ?? '{}') as Record<string, unknown>;
    for (const [id, value] of Object.entries(raw)) {
      const v = optimizationChoice(id, value);
      if (v !== undefined) kept[id] = v;
    }
  } catch (error) {
    console.warn('optimizations unreadable: the game as it draws', error);
  }
  return kept as Optimizations;
}

/** One optimisation as the lab lists it: its spec, the value set, whether that is the game's own. */
export interface OptimizationState {
  readonly spec: OptimizationSpec;
  readonly value: OptValue;
  readonly isDefault: boolean;
}

/** The lab's optimisations (`optimizations.ts`), set live, kept between runs (`roadcraft.optimizations`). Every change told to `EffectsWiring.onChange` as `opt.<id>`. */
export interface OptimizationControl {
  list(): OptimizationState[];
  get(id: string): OptValue | undefined;
  /** False when `id` or the value is not one of its choices. */
  set(id: string, value: unknown): boolean;
  /** Every one back to the game's own. */
  reset(): void;
  values(): Optimizations;
  /** Told of every change: the id and its new value. */
  onChange(listener: (id: OptId, value: OptValue) => void): () => void;
}

export interface EffectsWiring {
  /** The renderer made: the switches kept apply to it from now on. `fullRatio` the whole pixel ratio the graphics options allow. */
  attach(scene: SceneHandle, fullRatio: () => number, redraw: () => void): void;
  readonly panel: EffectsPanel;
  /** The simulation steps at all; its traffic, its pedestrians; the zones grow. */
  readonly simulation: boolean;
  readonly traffic: boolean;
  readonly pedestrians: boolean;
  readonly growth: boolean;
  /** Off: a frame drawn every vsync whether anything moved or not (a steady load to measure). */
  readonly onDemand: boolean;
  /** The share of the population the simulation may put out at most, of what the screen allows (the lab's `population`). */
  readonly populationShare: number;
  /** The lab's optimisations. */
  readonly optimizations: OptimizationControl;
  /** A frame's whole time on the CPU, ms (`frameTimer`). */
  frameEnded(ms: number): void;
  /** Every setting as it stands now (the lab's recorder keeps it with each recording). */
  snapshot(): Readonly<Record<string, unknown>>;
  /** Told of every change made from now on: the key and its new value (the lab's recorder marks it). */
  onChange(listener: (key: string, value: unknown) => void): () => void;
  /** Several switches set at once by key (the lab's tests): on or off, or a building setting's value. */
  setMany(values: Readonly<Record<string, boolean | string | number>>): void;
}

export function createEffectsWiring(): EffectsWiring {
  let { effects, cpu, resolution, buildings } = readKept();
  let optimizations = readOptimizations();
  const optListeners: ((id: OptId, value: OptValue) => void)[] = [];
  let scene: SceneHandle | null = null;
  let fullRatio = (): number => 1;
  let redraw = (): void => {};
  const cpuTimes = new Float64Array(AVERAGE_OF);
  let cpuCount = 0;
  const listeners: ((key: string, value: unknown) => void)[] = [];
  const told = (key: string, value: unknown): void => { for (const listener of listeners) listener(key, value); };

  const save = (): void => {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ effects, cpu, resolution, buildings }));
    } catch (error) {
      console.warn('effects panel settings not kept', error);
    }
  };
  const saveOptimizations = (): void => {
    const changed = Object.fromEntries(Object.entries(optimizations).filter(([id, v]) => v !== DEFAULT_OPTIMIZATIONS[id as OptId]));
    try {
      window.localStorage.setItem(OPT_STORE_KEY, JSON.stringify(changed));
    } catch (error) {
      console.warn('optimizations not kept', error);
    }
  };
  const setOptimizations = (patch: Readonly<Record<string, OptValue>>): void => {
    const changed = Object.entries(patch).filter(([id, v]) => optimizations[id as OptId] !== v);
    if (!changed.length) return;
    optimizations = { ...optimizations, ...patch };
    saveOptimizations();
    scene?.setOptimizations(optimizations);
    redraw();
    for (const [id, v] of changed) {
      told(`opt.${id}`, v);
      for (const listener of optListeners) listener(id as OptId, v);
    }
  };
  const optimizationControl: OptimizationControl = {
    list: () => OPTIMIZATIONS.map((spec) => ({ spec, value: optimizations[spec.id], isDefault: optimizations[spec.id] === spec.choices[0]!.value })),
    get: (id) => (optimizationSpec(id) ? optimizations[id as OptId] : undefined),
    set(id, value) {
      const v = optimizationChoice(id, value);
      if (v === undefined) return false;
      setOptimizations({ [id]: v });
      return true;
    },
    reset: () => setOptimizations(DEFAULT_OPTIMIZATIONS),
    values: () => optimizations,
    onChange(listener) {
      optListeners.push(listener);
      return () => { const i = optListeners.indexOf(listener); if (i >= 0) optListeners.splice(i, 1); };
    },
  };
  const apply = (): void => {
    if (!scene) return;
    scene.setEffects(effects, buildings);
    scene.resize(fullRatio() * resolution);
    redraw();
  };
  const set = (keys: readonly string[], on: boolean): void => {
    const nextEffects = { ...effects };
    const nextCpu = { ...cpu };
    for (const key of keys) {
      if (isEffectSwitch(key)) nextEffects[key] = on;
      else if ((CPU_SWITCHES as readonly string[]).includes(key)) nextCpu[key as CpuSwitch] = on;
    }
    effects = nextEffects;
    cpu = nextCpu;
    save();
    apply();
    for (const key of keys) told(key, on);
  };

  const GROUPS: readonly { id: string; keys: readonly (EffectSwitch | CpuSwitch)[] }[] = [
    { id: 'post', keys: POST_SWITCHES },
    { id: 'light', keys: LIGHT_SWITCHES },
    { id: 'layers', keys: LAYER_SWITCHES },
    { id: 'buildings', keys: BUILDING_SWITCHES },
    { id: 'cpu', keys: CPU_SWITCHES },
  ];
  const isOn = (key: EffectSwitch | CpuSwitch): boolean => (isEffectSwitch(key) ? effects[key] : cpu[key as CpuSwitch]);
  const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

  const stats = (): (readonly [string, string])[] => {
    if (!scene) return [];
    const gl = scene.gl;
    const ring = scene.gpu.samples;
    const gpuCount = Math.min(ring.pushed, ring.size, AVERAGE_OF);
    let gpuSum = 0;
    for (let back = 0; back < gpuCount; back++) gpuSum += ring.newest(back);
    const cpuShown = Math.min(cpuCount, AVERAGE_OF);
    let cpuSum = 0;
    for (let i = 0; i < cpuShown; i++) cpuSum += cpuTimes[i]!;
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    const canvas = gl.domElement;
    return [
      [t('fx.stat.gpu'), scene.gpu.supported ? (gpuCount ? `${(gpuSum / gpuCount).toFixed(2)} ms` : '-') : t('fx.stat.noTimer')],
      [t('fx.stat.cpu'), cpuShown ? `${(cpuSum / cpuShown).toFixed(2)} ms` : '-'],
      [t('fx.stat.fps'), scene.stats.fps.toFixed(0)],
      [t('fx.stat.calls'), String(scene.stats.drawCalls)],
      [t('fx.stat.triangles'), scene.stats.drawnTriangles.toLocaleString()],
      [t('fx.stat.programs'), String(gl.info.programs?.length ?? 0)],
      [t('fx.stat.geometries'), String(gl.info.memory.geometries)],
      [t('fx.stat.textures'), String(gl.info.memory.textures)],
      [t('fx.stat.targets'), mb(scene.targetBytes())],
      [t('fx.stat.buildings'), mb(scene.buildingDetailBytes())],
      [t('fx.stat.heap'), heap ? `${mb(heap.usedJSHeapSize)} / ${mb(heap.totalJSHeapSize)}` : '-'],
      [t('fx.stat.pixels'), `${canvas.width} × ${canvas.height}`],
    ];
  };

  const panel = createEffectsPanel({
    groups: (): EffectsPanelGroup[] => GROUPS.map((group) => ({
      id: group.id,
      title: t(`fx.group.${group.id}`),
      items: [
        ...(group.id === 'buildings' ? BUILDING_CHOICES.map(({ key, field, values }) => ({
          key, label: t(`fx.${key}`), on: true, value: String(buildings[field]),
          choices: values.map((v) => [String(v), t(`fx.${key}.${v}`)] as const),
        })) : []),
        ...group.keys.map((key) => ({ key, label: t(`fx.${key}`), on: isOn(key) })),
      ],
    })),
    toggle: (key, on) => set([key], on),
    choose(key, value) {
      const choice = BUILDING_CHOICES.find((c) => c.key === key);
      if (!choice) return;
      const v = choice.values.find((x) => String(x) === value);
      if (v === undefined) return;
      buildings = { ...buildings, [choice.field]: v };
      save();
      apply();
      told(key, v);
    },
    setGroup: (id, on) => set(GROUPS.find((group) => group.id === id)?.keys ?? [], on),
    reset() {
      resolution = 1;
      buildings = DEFAULT_BUILDING_CHOICES;
      set([...GROUPS.flatMap((group) => group.keys)], true);
    },
    resolution: () => resolution,
    setResolution(scale) {
      resolution = scale;
      save();
      apply();
      told('resolution', scale);
    },
    stats,
  });

  return {
    attach(nextScene, nextFullRatio, nextRedraw) {
      scene = nextScene;
      fullRatio = nextFullRatio;
      redraw = nextRedraw;
      apply();
      // DO NOT tell the renderer the defaults: it draws as the game does until one is set.
      if (optimizations !== DEFAULT_OPTIMIZATIONS && Object.entries(optimizations).some(([id, v]) => v !== DEFAULT_OPTIMIZATIONS[id as OptId])) scene.setOptimizations(optimizations);
    },
    panel,
    get simulation() { return cpu.simulation; },
    get traffic() { return cpu.traffic; },
    get pedestrians() { return cpu.pedestrians; },
    get growth() { return cpu.growth; },
    get onDemand() { return cpu.onDemand; },
    get populationShare() { return typeof optimizations.population === 'number' ? optimizations.population : 1; },
    optimizations: optimizationControl,
    snapshot: () => ({ ...effects, ...cpu, resolution, ...Object.fromEntries(Object.entries(buildings).map(([k, v]) => [`buildings.${k}`, v])),
      ...Object.fromEntries(Object.entries(optimizations).map(([k, v]) => [`opt.${k}`, v])) }),
    onChange(listener) {
      listeners.push(listener);
      return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); };
    },
    setMany(values) {
      const on = Object.entries(values).filter((e): e is [string, boolean] => typeof e[1] === 'boolean');
      for (const value of [true, false]) {
        const keys = on.filter(([, v]) => v === value).map(([k]) => k);
        if (keys.length) set(keys, value);
      }
      for (const [key, value] of Object.entries(values)) {
        // An optimisation by `opt.<id>` (`snapshot`).
        if (key.startsWith('opt.')) { optimizationControl.set(key.slice(4), value); continue; }
        if (typeof value === 'boolean') continue;
        if (key === 'resolution' && typeof value === 'number') { resolution = value; save(); apply(); told(key, value); continue; }
        const choice = BUILDING_CHOICES.find((c) => c.key === key);
        if (choice && choice.values.includes(value)) { buildings = { ...buildings, [choice.field]: value }; save(); apply(); told(key, value); }
      }
    },
    frameEnded(ms) {
      cpuTimes[cpuCount % AVERAGE_OF] = ms;
      cpuCount++;
    },
  };
}
