/** DO NOT describe `auto` as adaptive until it is wired. */

import { m, perM } from '@world/units';

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  /** Cap on the device pixel ratio the canvas is rendered at. */
  readonly pixelRatio: number;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  readonly postProcessing: boolean;
  readonly ambientOcclusion: boolean;
  readonly smaa: boolean;
  /** AMD FidelityFX Contrast Adaptive Sharpening on the final image, 0 (off) to 1 (strongest). */
  readonly sharpen: number;
  /** Maximum anisotropic filtering taps requested for ground textures. */
  readonly anisotropy: number;
  /** Draw street furniture, kerb detail, parapets and roadside props. */
  readonly detailProps: boolean;
  /** Scatter vegetation over the terrain. */
  readonly vegetation: number;
  /** Blades in the GPU grass field round the camera (`grass.ts`); 0 draws none. */
  readonly grassBlades: number;
  /** The close-zoom texture detail layer (`mesh/detailLayer.ts`). */
  readonly surfaceDetail: boolean;
  /** Zoom below which markings, props and agents stop being drawn. */
  readonly detailCutoffZoom: number;
  /** Crowd detail ceiling: silhouette, wardrobe, or full facial animation. */
  readonly pedestrianDetail: 0 | 1 | 2;
  /** Zoom from which the people inside vehicles are drawn. */
  readonly occupantZoom: number;
  /** Soft shadows of drifting clouds over the land (`postprocess.ts`, needs post-processing). */
  readonly cloudShadows: boolean;
  /** The ecosystem's vegetation (`render/nature/`) */
  readonly vegetationDistance: number;
  /** Far plants as impostors - billboards baked from each species. */
  readonly impostors: boolean;
  /** Most birds in the air at once; 0 draws none. */
  readonly birds: number;
  /** Raindrops in the air (the wet ground is drawn on every tier). */
  readonly rain: boolean;
  /** The cloud layer of the play sky. */
  readonly skyClouds: boolean;
  /** Morning mist in the valleys and over the water. */
  readonly mist: boolean;
  /** The spray and mist at the foot of waterfalls (their falling water is drawn on every tier). */
  readonly waterfalls: boolean;
}

export const QUALITY: Readonly<Record<QualityLevel, QualitySettings>> = {
  low: {
    pixelRatio: 1,
    shadows: false,
    shadowMapSize: 1024,
    postProcessing: false,
    ambientOcclusion: false,
    smaa: false,
    sharpen: 0,
    anisotropy: 2,
    detailProps: false,
    vegetation: 0,
    grassBlades: 0,
    surfaceDetail: false,
    detailCutoffZoom: perM(1.25),
    pedestrianDetail: 0,
    occupantZoom: perM(7.5),
    cloudShadows: false,
    vegetationDistance: m(180),
    impostors: true,
    birds: 0,
    rain: false,
    skyClouds: false,
    mist: false,
    waterfalls: false,
  },
  medium: {
    pixelRatio: 1.25,
    shadows: true,
    shadowMapSize: 1024,
    postProcessing: false,
    ambientOcclusion: false,
    smaa: false,
    sharpen: 0,
    anisotropy: 4,
    detailProps: true,
    vegetation: 600,
    grassBlades: 30_000,
    surfaceDetail: true,
    detailCutoffZoom: perM(0.85),
    pedestrianDetail: 1,
    occupantZoom: perM(5.5),
    cloudShadows: false,
    vegetationDistance: m(300),
    impostors: true,
    birds: 150,
    rain: true,
    skyClouds: true,
    mist: false,
    waterfalls: true,
  },
  high: {
    pixelRatio: 1.5,
    shadows: true,
    // Half the texel of 2048: a balcony's shadow stepped in squares of a hand's width at the middle distance
    shadowMapSize: 4096,
    postProcessing: true,
    ambientOcclusion: true,
    smaa: true,
    sharpen: 0.35,
    anisotropy: 8,
    detailProps: true,
    vegetation: 1_400,
    grassBlades: 60_000,
    surfaceDetail: true,
    detailCutoffZoom: perM(0.65),
    pedestrianDetail: 2,
    occupantZoom: perM(4),
    cloudShadows: true,
    vegetationDistance: m(440),
    impostors: true,
    birds: 400,
    rain: true,
    skyClouds: true,
    mist: true,
    waterfalls: true,
  },
  ultra: {
    pixelRatio: 2,
    shadows: true,
    shadowMapSize: 4096,
    postProcessing: true,
    ambientOcclusion: true,
    smaa: true,
    sharpen: 0.45,
    anisotropy: 16,
    detailProps: true,
    vegetation: 2_600,
    grassBlades: 90_000,
    surfaceDetail: true,
    detailCutoffZoom: perM(0.5),
    pedestrianDetail: 2,
    occupantZoom: perM(3.25),
    cloudShadows: true,
    vegetationDistance: m(640),
    impostors: true,
    birds: 600,
    rain: true,
    skyClouds: true,
    mist: true,
    waterfalls: true,
  },
};

export const QUALITY_LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export const isQualityLevel = (value: unknown): value is QualityLevel =>
  value === 'low' || value === 'medium' || value === 'high' || value === 'ultra';

/** Watches frame time and reports when the tier should change. */
export class QualityGovernor {
  private samples: number[] = [];
  private costs: number[] = [];
  private cooldown = 0;
  private clock = 0;
  private lastRaise = -Infinity;
  private holdRaise = 0;
  private readonly ceiling: number;

  constructor(private level: QualityLevel, ceiling: QualityLevel = level) {
    this.ceiling = QUALITY_LEVELS.indexOf(ceiling);
  }

  get current(): QualityLevel {
    return this.level;
  }

  set(level: QualityLevel): void {
    this.level = level;
    this.samples.length = 0;
    this.costs.length = 0;
    this.cooldown = 2.5;
  }

  /** Returns the tier to switch to, or null to stay put. */
  sample(deltaSeconds: number, costMs = Infinity): QualityLevel | null {
    this.clock += deltaSeconds;
    if (this.holdRaise > 0) this.holdRaise -= deltaSeconds;
    if (this.cooldown > 0) {
      this.cooldown -= deltaSeconds;
      return null;
    }
    // A stall from a road rebuild is not a frame rate; it is one bad frame.
    if (deltaSeconds > 0.4) return null;
    this.samples.push(deltaSeconds);
    this.costs.push(costMs);
    if (this.samples.length < 60) return null;
    const median = middle(this.samples);
    const cost = middle(this.costs);
    this.samples.length = 0;
    this.costs.length = 0;
    const index = QUALITY_LEVELS.indexOf(this.level);
    if (median > 1 / 34 && index > 0) {
      // Undone within twenty seconds: this machine cannot hold that tier.
      if (this.clock - this.lastRaise < 20) this.holdRaise = 90;
      return QUALITY_LEVELS[index - 1] as QualityLevel;
    }
    if (index < this.ceiling && this.holdRaise <= 0 && median < 1 / 50 && cost < 7) {
      this.lastRaise = this.clock;
      return QUALITY_LEVELS[index + 1] as QualityLevel;
    }
    return null;
  }
}

function middle(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}
