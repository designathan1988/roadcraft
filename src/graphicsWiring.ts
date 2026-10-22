import { DynamicResolution } from '@core/dynamicResolution';
import { tierForGpu } from '@core/gpuTier';
import { WEAK_MACHINE } from '@core/weakMachine';
import { QUALITY, QualityGovernor, isQualityLevel, type QualityLevel, type QualitySettings } from '@render/quality';
import type { SceneHandle } from '@render/renderer';
import { createGraphicsPanel, type GraphicsChoices } from '@ui/graphicsPanel';
import type { FrameClock } from './frameLoop';

/** THE GRAPHICS OPTIONS' WIRING, out of `main.ts`: the player's choices kept, the first tier by the GPU, and each applied live. `auto` (the first start's) moves between the tiers in play by the frames' cost (`QualityGovernor`), never above the GPU's own tier. */

/** A tier the player picked, or the automatic one. */
export type QualityPreset = QualityLevel | 'auto';
export const isQualityPreset = (value: unknown): value is QualityPreset => value === 'auto' || isQualityLevel(value);

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
  // A run playing a weaker machine (`core/weakMachine.ts`): its GPU, the tier that one holds.
  if (WEAK_MACHINE.gpu) return WEAK_MACHINE.gpu;
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
function settingsFor(level: QualityLevel, kept: KeptOptions): QualitySettings {
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
  /** What the player chose: a tier, or `auto`. */
  readonly preset: QualityPreset;
  readonly settings: QualitySettings;
  /** The renderer and the frame loop made: the options apply to them from now on. */
  attach(scene: SceneHandle, clock: FrameClock, redraw: () => void): void;
  /** A tier picked (the menu's row or the panel): its own settings, the player's apart from it cleared. */
  setPreset(preset: QualityPreset): void;
  openPanel(): void;
  /** The whole pixel ratio the tier allows on this display (the effects panel draws a share of it). */
  fullRatio(): number;
  /** After each frame drawn: the dynamic resolution and the automatic tier read the GPU's times. */
  frame(): void;
}

/** `onLevel`: the tier in use changed, by the automatic governor (`auto`) or the player's pick (`player`); told for the field's session summary (`fieldReport.ts`). */
export function createGraphicsWiring(onPreset: (preset: QualityPreset) => void, onLevel: (level: QualityLevel, by: 'auto' | 'player') => void = () => {}): GraphicsWiring {
  const saved = readStorage(PRESET_KEY);
  /** The tier this GPU can hold: where `auto` starts, and the most it climbs to. A run playing a weaker machine (`core/weakMachine.ts`) plays `auto` from that machine's tier, whatever this one kept. */
  const hardware = tierForGpu(gpuName());
  // DO NOT start a player with nothing chosen on `auto`: the governor dropped the tier whenever a frame missed 16.7 ms, and the buildings lost their
  // facades' maps on the player's own browser (the player, 2026-10-22: "gráficos piores"). Nothing chosen: this GPU's own tier, held; `auto` only when picked.
  let preset: QualityPreset = WEAK_MACHINE.gpu ? 'auto' : isQualityPreset(saved) ? saved : hardware;
  let level: QualityLevel = preset === 'auto' ? hardware : preset;
  const governor = new QualityGovernor(level, hardware);
  let lastFrame = 0;
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
  // OFF unless the player switches it on. DO NOT turn it on by default: each step resizes the canvas and the screen's targets (`applyScale`), down to half
  // the pixel ratio - the picture came out pixelated and blurred, and flickered at every step (the player, 2026-10-22: "piscando", "pixelizado, borrado").
  const dynamicOn = (): boolean => kept.dynamicResolution ?? false;
  /** The whole ratio the tier allows on this display; the dynamic resolution draws a share of it. */
  const fullRatio = (): number => Math.min(WEAK_MACHINE.pixelRatio ?? (window.devicePixelRatio || 1), settings.pixelRatio);
  const applyScale = (scale: number): void => {
    if (!scene) return;
    scene.resize(fullRatio() * scale);
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
    preset,
    shadows: settings.shadows ? settings.shadowMapSize : 0,
    ambientOcclusion: settings.ambientOcclusion,
    smaa: settings.smaa,
    dynamicResolution: dynamicOn(),
    fpsLimit: fps(),
    vsync: desktopState?.vsync ?? true,
    fullscreen: desktopState ? desktopState.fullscreen : document.fullscreenElement !== null,
  });

  const wiring: GraphicsWiring = {
    level,
    preset,
    settings,
    attach(nextScene, nextClock, nextRedraw) {
      scene = nextScene;
      clock = nextClock;
      redraw = nextRedraw;
      clock.limit(fps());
      seenSamples = scene.gpu.samples.pushed;
    },
    setPreset(next) {
      preset = next;
      level = next === 'auto' ? hardware : next;
      governor.set(level);
      onLevel(level, 'player');
      const { shadows: _s, ambientOcclusion: _a, smaa: _m, ...lasting } = kept;
      kept = lasting;
      writeStorage(PRESET_KEY, next);
      save();
      apply();
      onPreset(next);
    },
    fullRatio,
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
      if (!scene) return;
      const now = performance.now();
      const delta = lastFrame > 0 ? (now - lastFrame) / 1000 : 0;
      lastFrame = now;
      const budget = 1000 / (fps() || 60);
      const ring = scene.gpu.samples;
      const fresh = scene.gpu.supported ? Math.min(ring.pushed - seenSamples, ring.size) : 0;
      seenSamples = ring.pushed;
      if (preset === 'auto' && delta > 0) {
        // The GPU's time of each frame measured since; where no timer answers, the frame's own time (held to the display's refresh: it can drop a tier, never raise one past what the refresh shows).
        let next: QualityLevel | null = null;
        if (scene.gpu.supported) for (let back = fresh - 1; back >= 0; back--) next = governor.sample(delta / Math.max(1, fresh), ring.newest(back), budget) ?? next;
        else next = governor.sample(delta, delta * 1000, budget * 1.1);
        if (next !== null && next !== level) {
          level = next;
          governor.set(level);
          onLevel(level, 'auto');
          apply();
          return;
        }
      }
      if (!dynamicOn() || !scene.gpu.supported) return;
      // The last scale the samples ask for, taken once.
      let scale: number | null = null;
      for (let back = fresh - 1; back >= 0; back--) scale = resolution.sample(ring.newest(back), budget) ?? scale;
      if (scale !== null) applyScale(scale);
    },
  };

  const panel = createGraphicsPanel({
    read: choices,
    desktop: () => desktopState !== null,
    gpu: () => scene?.gpu.label ?? gpuName(),
    change(patch) {
      if (patch.preset !== undefined && patch.preset !== preset) {
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
