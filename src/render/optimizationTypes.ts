/** THE OPTIMISATIONS' SHARED WORDS (`optimizations.ts`, `optimizationsQuality.ts`): a value, a system, a choice. */

export type OptValue = string | number;

export type OptSystem = 'renderer' | 'culling' | 'shadows' | 'post' | 'textures' | 'materials' | 'buildings' | 'terrain' | 'water' | 'roads'
  | 'vegetation' | 'people' | 'vehicles' | 'particles' | 'simulation' | 'uploads';

export const OPT_SYSTEM_TITLES: Readonly<Record<OptSystem, string>> = {
  renderer: 'Renderizador',
  culling: 'Recorte (culling)',
  shadows: 'Sombras',
  post: 'Pós-processamento',
  textures: 'Texturas',
  materials: 'Materiais e shaders',
  buildings: 'Prédios',
  terrain: 'Terreno',
  water: 'Água',
  roads: 'Ruas',
  vegetation: 'Vegetação e mobiliário',
  people: 'Pessoas',
  vehicles: 'Veículos',
  particles: 'Partículas',
  simulation: 'Simulação (CPU)',
  uploads: 'Envios à GPU e ritmo',
};

export interface OptChoice {
  readonly value: OptValue;
  readonly label: string;
}
