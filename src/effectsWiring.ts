import { ALL_EFFECTS_ON, LAYER_SWITCHES, LIGHT_SWITCHES, POST_SWITCHES, isEffectSwitch, type EffectSwitch, type EffectSwitches } from '@render/effectSwitches';
import type { SceneHandle } from '@render/renderer';
import { createEffectsPanel, type EffectsPanel, type EffectsPanelGroup } from '@ui/effectsPanel';
import { t } from '@ui/i18n';

/** THE EFFECTS PANEL'S WIRING, out of `main.ts`: the GPU's effects switched in the renderer (`effectSwitches.ts`), the CPU's systems in the frame, the resolution, kept between runs (`roadcraft.effects`). */

/** The frame's heavy systems on the CPU, each on as the game runs. */
const CPU_SWITCHES = ['simulation', 'traffic', 'pedestrians', 'growth', 'onDemand'] as const;
type CpuSwitch = (typeof CPU_SWITCHES)[number];
type CpuSwitches = Readonly<Record<CpuSwitch, boolean>>;
const ALL_CPU_ON: CpuSwitches = { simulation: true, traffic: true, pedestrians: true, growth: true, onDemand: true };

const STORE_KEY = 'roadcraft.effects';
/** The frames the readings average over. */
const AVERAGE_OF = 60;

interface Kept {
  readonly effects: EffectSwitches;
  readonly cpu: CpuSwitches;
  readonly resolution: number;
}

function readKept(): Kept {
  const kept = { effects: { ...ALL_EFFECTS_ON }, cpu: { ...ALL_CPU_ON }, resolution: 1 };
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '{}') as { effects?: Record<string, unknown>; cpu?: Record<string, unknown>; resolution?: unknown };
    for (const [key, on] of Object.entries(raw.effects ?? {})) if (isEffectSwitch(key) && typeof on === 'boolean') kept.effects[key] = on;
    for (const key of CPU_SWITCHES) if (typeof raw.cpu?.[key] === 'boolean') kept.cpu[key] = raw.cpu[key];
    if (typeof raw.resolution === 'number' && raw.resolution > 0 && raw.resolution <= 1) kept.resolution = raw.resolution;
  } catch (error) {
    console.warn('effects panel settings unreadable: everything on', error);
  }
  return kept;
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
  /** A frame's whole time on the CPU, ms (`frameTimer`). */
  frameEnded(ms: number): void;
}

export function createEffectsWiring(): EffectsWiring {
  let { effects, cpu, resolution } = readKept();
  let scene: SceneHandle | null = null;
  let fullRatio = (): number => 1;
  let redraw = (): void => {};
  const cpuTimes = new Float64Array(AVERAGE_OF);
  let cpuCount = 0;

  const save = (): void => {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ effects, cpu, resolution }));
    } catch (error) {
      console.warn('effects panel settings not kept', error);
    }
  };
  const apply = (): void => {
    if (!scene) return;
    scene.setEffects(effects);
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
  };

  const GROUPS: readonly { id: string; keys: readonly (EffectSwitch | CpuSwitch)[] }[] = [
    { id: 'post', keys: POST_SWITCHES },
    { id: 'light', keys: LIGHT_SWITCHES },
    { id: 'layers', keys: LAYER_SWITCHES },
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
      items: group.keys.map((key) => ({ key, label: t(`fx.${key}`), on: isOn(key) })),
    })),
    toggle: (key, on) => set([key], on),
    setGroup: (id, on) => set(GROUPS.find((group) => group.id === id)?.keys ?? [], on),
    reset() {
      resolution = 1;
      set([...GROUPS.flatMap((group) => group.keys)], true);
    },
    resolution: () => resolution,
    setResolution(scale) {
      resolution = scale;
      save();
      apply();
    },
    stats,
  });

  return {
    attach(nextScene, nextFullRatio, nextRedraw) {
      scene = nextScene;
      fullRatio = nextFullRatio;
      redraw = nextRedraw;
      apply();
    },
    panel,
    get simulation() { return cpu.simulation; },
    get traffic() { return cpu.traffic; },
    get pedestrians() { return cpu.pedestrians; },
    get growth() { return cpu.growth; },
    get onDemand() { return cpu.onDemand; },
    frameEnded(ms) {
      cpuTimes[cpuCount % AVERAGE_OF] = ms;
      cpuCount++;
    },
  };
}
