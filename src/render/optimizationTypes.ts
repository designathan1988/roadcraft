/** THE OPTIMISATIONS' SHARED WORDS (`optimizations.ts`, `optimizationsQuality.ts`): a value, a system, a choice. */

export type OptValue = string | number;

export type OptSystem = 'renderer' | 'culling' | 'shadows' | 'post' | 'textures' | 'materials' | 'buildings' | 'terrain' | 'water' | 'roads'
  | 'vegetation' | 'people' | 'vehicles' | 'particles' | 'simulation' | 'uploads';

export const OPT_SYSTEM_TITLES: Readonly<Record<OptSystem, string>> = {
  renderer: 'Renderer',
  culling: 'Culling',
  shadows: 'Shadows',
  post: 'Post-processing',
  textures: 'Textures',
  materials: 'Materials and shaders',
  buildings: 'Buildings',
  terrain: 'Terrain',
  water: 'Water',
  roads: 'Roads',
  vegetation: 'Vegetation and street furniture',
  people: 'People',
  vehicles: 'Vehicles',
  particles: 'Particles',
  simulation: 'Simulation (CPU)',
  uploads: 'GPU uploads and pacing',
};

export interface OptChoice {
  readonly value: OptValue;
  readonly label: string;
}
