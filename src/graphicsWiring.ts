import { DynamicResolution } from '@core/dynamicResolution';
import { tierForGpu } from '@core/gpuTier';
import { QUALITY, isQualityLevel, type QualityLevel, type QualitySettings } from '@render/quality';
import type { SceneHandle } from '@render/renderer';
import { createGraphicsPanel, type GraphicsChoices } from '@ui/graphicsPanel';
import type { FrameClock } from './frameLoop';

/** THE GRAPHICS OPTIONS' WIRING, out of `main.ts`: the player's choices kept, the first tier by the GPU, and each applied live. */

/** The desktop shell's calls (`desktop/preload.cjs`); absent in a browser. */
interface DesktopBridge {
  state(): Promise<{ vsync: boolean; fullscreen: boolean; steam: boolean; steamDeck: boolean } | null>;
  set(patch: { vsync?: boolean; fullscreen?: boolean }): Promise<boolean>;
}
const desktop = (): DesktopBridge | null => (window as unknown as { roadcraftDesktop?: DesktopBridge }).roadcraftDesktop ?? null;

const PRESET_KEY = 'roadcraft.quality';
const OPTIONS_KEY = 'roadcraft.graphics';

/** What the player set apart from the tier's own (`roadcraft.graphics`); a tier picked clears the first three. */
interface KeptOptions {
  shadows?: number;
  ambientOcclusion?: boolean;
  smaa?: boolean;
  dynamicResolution?: boolean;
  fpsLimit?: number;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    console.warn('graphics options not read', error);
    return null;
  }
}
function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    // Not remembering the choice is not a reason to refuse it.
    console.warn('graphics options not kept', error);
  }
}

/** The GPU's name from a context of its own, let go at once: the tier is needed before the game's renderer exists. */
function gpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return '';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch (error) {
    console.warn('GPU name not read', error);
    return '';
  }
}

function readKept(): KeptOptions {
  try {
    const raw = JSON.parse(readStorage(OPTIONS_KEY) ?? '{}') as Record<string, unknown>;
    const kept: KeptOptions = {};
    if (typeof raw['shadows'] === 'number' && [0, 1024, 2048, 4096].includes(raw['shadows'])) kept.shadows = raw['shadows'];
    if (typeof raw['ambientOcclusion'] === 'boolean') kept.ambientOcclusion = raw['ambientOcclusion'];
    if (typeof raw['smaa'] === 'boolean') kept.smaa = raw['smaa'];
    if (typeof raw['dynamicResolution'] === 'boolean') kept.dynamicResolution = raw['dynamicResolution'];
    if (typeof raw['fpsLimit'] === 'number' && raw['fpsLimit'] >= 0) kept.fpsLimit = raw['fpsLimit'];
    return kept;
  } catch (error) {
    console.warn('graphics options unreadable: the tier settings used', error);
    return {};
  }
}

/** The tier's settings with the player's own over them; occlusion and SMAA are passes of the post chain, so either brings it. */
export function settingsFor(level: QualityLevel, kept: KeptOptions): QualitySettings {
  const tier = QUALITY[level];
  const shadows = kept.shadows ?? (tier.shadows ? tier.shadowMapSize : 0);
  const ambientOcclusion = kept.ambientOcclusion ?? tier.ambientOcclusion;
  const smaa = kept.smaa ?? tier.smaa;
  return {
    ...tier,
    shadows: shadows > 0,
    shadowMapSize: shadows > 0 ? shadows : tier.shadowMapSize,
    ambientOcclusion,
    smaa,
    postProcessing: tier.postProcessing || ambientOcclusion || smaa,
  };
}

export interface GraphicsWiring {
  /** The tier and settings the renderer starts with. */
  readonly level: QualityLevel;
  readonly settings: QualitySettings;
  /** The renderer and the frame loop made: the options apply to them from now on. */
  attach(scene: SceneHandle, clock: FrameClock, redraw: () => void): void;
  /** A tier picked (the menu's row or the panel): its own settings, the player's apart from it cleared. */
  setPreset(level: QualityLevel): void;
  openPanel(): void;
  /** After each frame drawn: the dynamic resolution reads the GPU's times. */
  frame(): void;
}

export function createGraphicsWiring(onPreset: (level: QualityLevel) => void): GraphicsWiring {
  const saved = readStorage(PRESET_KEY);
  let level: QualityLevel;
  if (isQualityLevel(saved)) {
    level = saved;
  } else {
    // The first start: the tier this GPU can hold, kept as if the player had picked it.
    level = tierForGpu(gpuName());
    writeStorage(PRESET_KEY, level);
  }
  let kept = readKept();
  let settings = settingsFor(level, kept);
  let scene: SceneHandle | null = null;
  let clock: FrameClock | null = null;
  let redraw = (): void => {};
  let desktopState: { vsync: boolean; fullscreen: boolean } | null = null;
  const resolution = new DynamicResolution();
  let seenSamples = 0;

  const save = (): void => writeStorage(OPTIONS_KEY, JSON.stringify(kept));
  const fps = (): number => kept.fpsLimit ?? 0;
  /** The whole ratio the tier allows on this display; the dynamic resolution draws a share of it. */
  const fullRatio = (): number => Math.min(window.devicePixelRatio || 1, settings.pixelRatio);
  const applyScale = (scale: number): void => {
    if (!scene) return;
    scene.gl.setPixelRatio(fullRatio() * scale);
    scene.resize();
    redraw();
  };
  const apply = (): void => {
    settings = settingsFor(level, kept);
    resolution.reset();
    if (!scene) return;
    scene.setQuality(level, settings);
    seenSamples = scene.gpu.samples.pushed;
    redraw();
  };

  const choices = (): GraphicsChoices => ({
    preset: level,
    shadows: settings.shadows ? settings.shadowMapSize : 0,
    ambientOcclusion: settings.ambientOcclusion,
    smaa: settings.smaa,
    dynamicResolution: kept.dynamicResolution ?? false,
    fpsLimit: fps(),
    vsync: desktopState?.vsync ?? true,
    fullscreen: desktopState ? desktopState.fullscreen : document.fullscreenElement !== null,
  });

  const wiring: GraphicsWiring = {
    level,
    settings,
    attach(nextScene, nextClock, nextRedraw) {
      scene = nextScene;
      clock = nextClock;
      redraw = nextRedraw;
      clock.limit(fps());
      seenSamples = scene.gpu.samples.pushed;
    },
    setPreset(next) {
      level = next;
      const { shadows: _s, ambientOcclusion: _a, smaa: _m, ...lasting } = kept;
      kept = lasting;
      writeStorage(PRESET_KEY, next);
      save();
      apply();
      onPreset(next);
    },
    openPanel() {
      const bridge = desktop();
      if (!bridge) {
        panel.open();
        return;
      }
      void bridge.state().then((state) => {
        desktopState = state;
        panel.open();
      }, () => panel.open());
    },
    frame() {
      if (!scene || !kept.dynamicResolution || !scene.gpu.supported) return;
      const ring = scene.gpu.samples;
      const fresh = Math.min(ring.pushed - seenSamples, ring.size);
      seenSamples = ring.pushed;
      const budget = 1000 / (fps() || 60);
      for (let back = fresh - 1; back >= 0; back--) {
        const scale = resolution.sample(ring.newest(back), budget);
        if (scale !== null) applyScale(scale);
      }
    },
  };

  const panel = createGraphicsPanel({
    read: choices,
    desktop: () => desktopState !== null,
    gpu: () => scene?.gpu.label ?? gpuName(),
    change(patch) {
      if (patch.preset !== undefined && patch.preset !== level) {
        wiring.setPreset(patch.preset);
        return;
      }
      if (patch.shadows !== undefined || patch.ambientOcclusion !== undefined || patch.smaa !== undefined) {
        kept = { ...kept, ...pick(patch) };
        save();
        apply();
      }
      if (patch.dynamicResolution !== undefined) {
        kept = { ...kept, dynamicResolution: patch.dynamicResolution };
        save();
        // Off: the whole ratio back at once.
        if (!patch.dynamicResolution) {
          resolution.reset();
          applyScale(1);
        }
        if (scene) seenSamples = scene.gpu.samples.pushed;
      }
      if (patch.fpsLimit !== undefined) {
        kept = { ...kept, fpsLimit: patch.fpsLimit };
        save();
        clock?.limit(patch.fpsLimit);
        redraw();
      }
      const bridge = desktop();
      if (patch.vsync !== undefined && bridge && desktopState) {
        desktopState = { ...desktopState, vsync: patch.vsync };
        void bridge.set({ vsync: patch.vsync });
      }
      if (patch.fullscreen !== undefined) {
        if (bridge && desktopState) {
          desktopState = { ...desktopState, fullscreen: patch.fullscreen };
          void bridge.set({ fullscreen: patch.fullscreen });
        } else if (patch.fullscreen) {
          void document.documentElement.requestFullscreen().catch((error: unknown) => console.warn('full screen refused', error));
        } else if (document.fullscreenElement) {
          void document.exitFullscreen().catch((error: unknown) => console.warn('full screen not left', error));
        }
      }
    },
  });
  return wiring;
}

function pick(patch: Partial<GraphicsChoices>): KeptOptions {
  const out: KeptOptions = {};
  if (patch.shadows !== undefined) out.shadows = patch.shadows;
  if (patch.ambientOcclusion !== undefined) out.ambientOcclusion = patch.ambientOcclusion;
  if (patch.smaa !== undefined) out.smaa = patch.smaa;
  return out;
}
