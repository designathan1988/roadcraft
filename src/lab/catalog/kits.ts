import { SphereGeometry, type BufferGeometry, type Material, type Object3D } from 'three';
import { createBuildingKit } from '../../render/buildings/kit';
import { furnitureParts } from '../../render/buildings/furnitureKit';
import { FURNITURE_KINDS } from '@world/buildings/interior';
import { createSceneryKit } from '../../render/scenery';
import { polePartSpecs } from '../../render/utilities';
import { createGroundCoverKit, FOREST_SPECIES } from '../../render/groundCover';
import { loadElementKit } from '../../render/elements';
import { loadNatureTrees, TREE_MODELS } from '../../render/natureTrees';
import { lowPolyTreeParts, type LowPolyKind } from '../../render/lowPolyTrees';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { buildCarModel, carStylesFor } from '../../render/carBody';
import { buildBusModel, buildTruckModel, buildTwoWheelerModel, rimGeometry, spokedRimGeometry, tyreGeometry, type VehicleModel } from '../../render/vehicleModels';
import { createHeldProps } from '../../render/people/heldProps';
import { createTransit } from '../../render/transit';
import { createBlobShadows } from '../../render/blobShadows';
import { createExhaust } from '../../render/exhaust';
import { createRain } from '../../render/rain';
import { createLightning } from '../../render/lightning';
import { createGore } from '../../render/gore';
import { createCasualties } from '../../render/casualties';
import type { ItemSpec, PieceSpec } from './items';

/** THE ENGINE'S KITS, EACH OBJECT AND VARIATION BUILT ON ITS OWN by the engine's own builder, as the catalogue measures them. */

type Add = (spec: ItemSpec) => void;

/** Every mesh under an object, as pieces (its geometry and material; an instanced mesh's one instance). */
function piecesOf(root: Object3D): PieceSpec[] {
  const out: PieceSpec[] = [];
  root.traverse((o) => {
    const holder = o as Object3D & { geometry?: BufferGeometry; material?: Material | Material[]; skeleton?: { bones: unknown[] } };
    if (!holder.geometry) return;
    out.push({ label: o.name || o.type, geometry: holder.geometry, material: holder.material ?? null, ...(holder.skeleton ? { bones: holder.skeleton.bones.length } : {}) });
  });
  return out;
}

/** The building kit: its part models (windows, frames, doors, railings, facade props...) with their levels and shadow pieces, and the furniture. */
export function buildingKitItems(add: Add): void {
  const kit = createBuildingKit(16);
  for (const [kind, geometry] of Object.entries(kit.geometry) as [string, BufferGeometry][]) {
    const screen = (kit.screen as Record<string, { levels: readonly { geometry: BufferGeometry }[]; pieces: readonly unknown[] }>)[kind];
    const levels = (screen?.levels ?? []).map((l) => l.geometry).filter((g) => g !== geometry);
    const casts = (kit.castsShadow as ReadonlySet<string>).has(kind);
    add({
      group: 'Buildings: part models', name: kind, origin: 'kit', source: 'src/render/buildings/kit.ts', build: 'instanced',
      pieces: [{ label: kind, geometry, material: (kit.material as Record<string, Material>)[kind] ?? null, levels }],
      shadow: casts ? `casts: ${screen?.pieces.length ? `${screen.pieces.length} box pieces under a shadow texel, else its model` : 'its model'}` : 'does not cast (small part)',
      countKey: `part:${kind}`,
    });
  }
  const furniture = kit.furniture();
  for (const kind of FURNITURE_KINDS) {
    const parts = furnitureParts(kind);
    const shapes = [...new Set(parts.map((p) => p.shape))].map((s) => `${parts.filter((p) => p.shape === s).length} ${s.toLowerCase()}`).join(', ');
    add({
      group: 'Furniture (interiors)', name: kind, origin: 'kit', source: 'src/render/buildings/furnitureKit.ts', build: 'instanced',
      pieces: [{ label: kind, geometry: furniture.geometry[kind], material: furniture.material }],
      notes: [`built from ${shapes} (${parts.length} parts)`], countKey: `furniture:${kind}`,
    });
  }
}

/** The landscape kit: street trees and bushes with their foliage cards, street furniture, the lamp's far and lit parts, tufts and flowers. */
export function sceneryItems(add: Add): void {
  const kit = createSceneryKit();
  for (const [species, body] of Object.entries(kit.trees)) {
    const cards = (kit.cards as Record<string, BufferGeometry | undefined>)[species];
    add({
      group: 'Street trees and bushes', name: species, origin: 'kit', source: 'src/render/propGeometry.ts (treeParts)', build: 'instanced',
      pieces: [{ label: 'body', geometry: body, material: kit.foliage }, ...(cards ? [{ label: 'foliage cards', geometry: cards, material: kit.treeCards }] : [])],
      shadow: `casts: body by its depth material${cards ? ', cards by theirs (alpha cut)' : ''}`, countKey: `landscape:tree:${species}`,
    });
  }
  for (const [kind, body] of Object.entries(kit.bushes)) {
    const cards = (kit.cards as Record<string, BufferGeometry | undefined>)[kind];
    add({
      group: 'Street trees and bushes', name: kind, origin: 'kit', source: 'src/render/propGeometry.ts (bushParts)', build: 'instanced',
      pieces: [{ label: 'body', geometry: body, material: kit.shrubs }, ...(cards ? [{ label: 'foliage cards', geometry: cards, material: kit.shrubCards }] : [])],
      shadow: 'casts: by its depth material', countKey: `landscape:shrub:${kind}`,
    });
  }
  for (const [kind, geometry] of Object.entries(kit.furniture)) {
    add({
      group: 'Street furniture', name: kind, origin: 'kit', source: 'src/render/propGeometry.ts', build: 'instanced',
      pieces: [{ label: kind, geometry, material: kit.props, ...(kind === 'lamp' ? { levels: [kit.lampFar] } : {}) }],
      notes: kind === 'lamp' ? ['far level: the column alone (lampFarGeometry); the lens, pool and beam are separate items'] : [], countKey: `landscape:${kind}`,
    });
  }
  const extras: [string, BufferGeometry, Material, string][] = [
    ['lamp lens', kit.lampLens, kit.glow, 'landscape:lamp'], ['lamp light pool (night)', kit.pool, kit.poolGlow, 'landscape:lamp'],
    ['lamp light beam (night)', kit.beam, kit.beamGlow, 'landscape:lamp'], ['tree pit', kit.treePit, kit.props, 'landscape:tree'],
    // A meadow is many tufts and flowers: their copies are the grass layer's, read from the test city's scene.
    ['grass tuft', kit.tuft, kit.grass, ''], ['wildflower', kit.flower, kit.flowers, ''],
  ];
  for (const [name, geometry, material, countKey] of extras) {
    add({ group: 'Street furniture', name, origin: 'kit', source: 'src/render/scenery.ts', build: 'instanced', pieces: [{ label: name, geometry, material }], countKey });
  }
  for (const spec of polePartSpecs(kit)) {
    add({
      group: 'Utility poles', name: spec.name, origin: 'kit', source: 'src/render/utilities.ts (polePartSpecs)', build: 'instanced',
      pieces: [{ label: spec.name, geometry: spec.geometry, material: spec.material, levels: spec.levels.slice(1).map((l) => l.geometry) }],
      shadow: spec.castShadow ? 'casts: its model' : 'does not cast', countKey: 'poles',
      notes: spec.glows ? ['lit at night, drawn at any size'] : [],
    });
  }
}

/** The ground cover of the ecosystem: rocks, scrub and the forest's trees, every variant. */
export function groundCoverItems(add: Add): void {
  const kit = createGroundCoverKit();
  kit.rocks.forEach((geometry, i) => add({ group: 'Ground cover', name: 'rock', variation: `${i + 1}`, origin: 'kit', source: 'src/render/groundCover.ts', build: 'instanced', pieces: [{ label: 'rock', geometry, material: kit.rockMaterial }], countKey: 'cover:rocks' }));
  kit.scrub.forEach((geometry, i) => add({ group: 'Ground cover', name: 'scrub', variation: `${i + 1}`, origin: 'kit', source: 'src/render/groundCover.ts', build: 'instanced', pieces: [{ label: 'scrub', geometry, material: kit.scrubMaterial }], countKey: 'cover:scrub' }));
  for (const species of FOREST_SPECIES) {
    kit.trees[species].forEach((model, i) => add({
      group: 'Forest trees (painted woods)', name: species, variation: `${i + 1}`, origin: 'kit', source: 'src/render/groundCover.ts', build: 'instanced',
      pieces: [{ label: 'body', geometry: model.body, material: kit.treeMaterial }, ...(model.cards ? [{ label: 'foliage cards', geometry: model.cards, material: kit.cardMaterial }] : [])],
      countKey: 'cover:forest',
    }));
  }
}

/** The ecosystem's trees and their far pictures, and the low-poly models every tree is grown from. */
export async function treeItems(add: Add): Promise<void> {
  const kit = await loadNatureTrees(16);
  kit.variants.forEach((variant, i) => {
    const distinct = [...new Set(variant.levels)];
    add({
      group: 'Ecosystem trees', name: TREE_MODELS[i] ?? `variant ${i}`, variation: `${i + 1}`, origin: 'kit', source: 'src/render/natureTrees.ts', build: 'instanced',
      pieces: [{ label: 'body', geometry: variant.levels[0], material: kit.material, levels: distinct.slice(1) }, ...(variant.cards ? [{ label: 'foliage cards', geometry: variant.cards, material: kit.cardMaterial }] : [])],
      shadow: `casts: body by its depth material${TREE_MODELS[i] === 'palm' ? ', fronds too' : ''}`, countKey: 'nature:trees',
      notes: distinct.length === 1 ? ['one model at every distance; past it the far picture (impostor)'] : [],
    });
  });
  kit.pictures.quads.forEach((geometry, i) => add({
    group: 'Ecosystem trees', name: `${TREE_MODELS[i] ?? 'tree'} far picture (impostor)`, variation: `${i + 1}`, origin: 'kit', source: 'src/render/plantImpostors.ts', build: 'instanced',
    pieces: [{ label: 'quad', geometry, material: kit.pictures.material }], countKey: 'nature:impostors',
  }));
  const kinds: LowPolyKind[] = ['oak', 'broadleafTall', 'cypress', 'palm', 'ipeYellow', 'ipePink', 'bush', 'bushFlowering', 'hedge'];
  for (const kind of kinds) {
    const parts = lowPolyTreeParts(kind, 1);
    add({
      group: 'Low-poly plant models', name: kind, origin: 'kit', source: 'src/render/lowPolyTrees.ts', build: 'instanced',
      pieces: [{ label: 'body', geometry: parts.body, material: null }, ...(parts.cards ? [{ label: 'foliage cards', geometry: parts.cards, material: null }] : [])],
      notes: ['the model every street and forest tree of this kind is grown from (seeded); material set by the layer that draws it'], countKey: 'source',
    });
  }
}

/** The elements of the landscape loaded from glTF files (grasses, flowers, ferns, mushrooms, pebbles, rocks) and the fallen leaves' card. */
export async function elementItems(add: Add): Promise<void> {
  const kit = await loadElementKit(16);
  for (const [kind, variants] of kit.models) {
    variants.forEach((parts, i) => add({
      group: 'Landscape elements (glTF)', name: kind, variation: `${i + 1}`, origin: kind === 'leaves' ? 'kit' : 'file', source: kind === 'leaves' ? 'src/render/elements.ts' : 'public/models/elements/*.gltf (src/render/elements.ts)',
      build: 'instanced', pieces: parts.map((p, k) => ({ label: `part ${k + 1}`, geometry: p.geometry, material: p.material })), countKey: `element:${kind}`,
    }));
  }
}

/** The vehicles: every archetype, every car body style, as they stand with their doors shut, their far model as their coarse level; the wheels apart. */
export function vehicleItems(add: Add): void {
  const pieces = (model: VehicleModel): PieceSpec[] => [
    { label: 'shell', geometry: model.shell, material: null, levels: [model.far] },
    { label: 'glass', geometry: model.glass, material: null },
    { label: 'trim', geometry: model.trim, material: null },
    { label: 'interior', geometry: model.interior, material: null },
    ...(model.roof ? [{ label: 'roof', geometry: model.roof, material: null }] : []),
    ...(model.accent ? [{ label: 'accent', geometry: model.accent, material: null }] : []),
    ...(model.steering ? [{ label: 'steering wheel', geometry: model.steering.geometry, material: null }] : []),
  ];
  const note = 'material set by the agents layer (src/render/agents.ts): paint, glass, trim and interior programs; read from the test city where it matches';
  for (const a of ARCHETYPES) {
    if (a.shape === 'car') {
      for (const style of carStylesFor(a)) {
        const model = buildCarModel(a, style);
        add({ group: 'Vehicles', name: a.id, variation: style, origin: 'kit', source: 'src/render/carBody.ts', build: 'instanced', pieces: pieces(model), notes: [note, `${model.doors.length} doors drawn apart only while they move`], countKey: `vehicle:${a.id}:${style}` });
      }
    } else if (a.shape === 'bus' || a.shape === 'truck') {
      const model = a.shape === 'bus' ? buildBusModel(a) : buildTruckModel(a);
      add({ group: 'Vehicles', name: a.id, origin: 'kit', source: 'src/render/vehicleModels.ts', build: 'instanced', pieces: pieces(model), notes: [note], countKey: `vehicle:${a.id}` });
    } else {
      const model = buildTwoWheelerModel(a);
      add({
        group: 'Vehicles', name: a.id, origin: 'kit', source: 'src/render/vehicleModels.ts', build: 'instanced', notes: [note], countKey: `vehicle:${a.id}`,
        pieces: [{ label: 'body', geometry: model.body, material: null }, { label: 'trim', geometry: model.trim, material: null }, { label: 'steering', geometry: model.steering, material: null },
          ...(model.cranks ? [{ label: 'cranks', geometry: model.cranks, material: null }] : [])],
      });
    }
  }
  add({ group: 'Vehicles', name: 'wheel', variation: 'tyre + rim', origin: 'kit', source: 'src/render/vehicleModels.ts', build: 'instanced', pieces: [{ label: 'tyre', geometry: tyreGeometry(), material: null }, { label: 'rim', geometry: rimGeometry(), material: null }], countKey: 'wheels:car' });
  add({ group: 'Vehicles', name: 'wheel', variation: 'spoked (two-wheelers)', origin: 'kit', source: 'src/render/vehicleModels.ts', build: 'instanced', pieces: [{ label: 'tyre', geometry: tyreGeometry(0.06), material: null }, { label: 'spoked rim', geometry: spokedRimGeometry(), material: null }], countKey: 'wheels:bike' });
}

/** What people hold, the trains, and the sky. */
export function miscItems(add: Add): void {
  const held = createHeldProps();
  for (const p of piecesOf(held.group)) add({ group: 'People: held props', name: p.label.replace(/^held-/, ''), origin: 'kit', source: 'src/render/people/heldProps.ts', build: 'instanced', pieces: [p], countKey: 'people:held' });
  const transit = createTransit();
  for (const p of piecesOf(transit.group)) add({ group: 'Transit', name: p.label, origin: 'kit', source: 'src/render/transit.ts', build: 'instanced', pieces: [p], countKey: 'transit:trains', notes: ['the trains\' cars; tracks and stations come from the test city'] });
  add({ group: 'Sky', name: 'sky', variation: 'dome', origin: 'kit', source: 'src/render/environment.ts:149', build: 'individual', pieces: [{ label: 'sphere 32x16', geometry: new SphereGeometry(1, 32, 16), material: null }], countKey: 'one', notes: ['drawn by the sky shader; its copy for the reflection probe the same; the clouds have no mesh (drawn in the post chain)'] });
}

/** The effects with geometry, each as its layer makes it; the blob shadows once a car and once a person. */
export function effectItems(add: Add): void {
  const effect = (name: string, source: string, root: Object3D, countKey: string, build: ItemSpec['build'] = 'instanced', notes: string[] = []): void => {
    const pieces = piecesOf(root);
    if (pieces.length) add({ group: 'Effects', name, origin: 'effect', source, build, pieces, countKey, effect: true, notes });
  };
  effect('blob shadow', 'src/render/blobShadows.ts', createBlobShadows('catalogue', 1).mesh, 'blob:shadows', 'instanced', ['one under every vehicle below its whole level and every person drawn procedurally']);
  effect('exhaust smoke', 'src/render/exhaust.ts', createExhaust().points, 'one', 'points', ['a pool of particles, the size of the pool']);
  effect('rain', 'src/render/rain.ts', createRain().object, 'one', 'lines');
  effect('lightning', 'src/render/lightning.ts', createLightning().group, 'one', 'lines');
  effect('gore', 'src/render/gore.ts', createGore().group, 'one');
  effect('casualty decals', 'src/render/casualties.ts', createCasualties().group, 'one');
}
