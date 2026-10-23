import { Frustum, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene } from 'three';
import type { NodeId } from '@world/ids';
import { FLAG_PATTERNS } from '@world/buildings/flags';
import { addLine, addStop, addTrack, emptyTransit } from '@world/transit';
import type { SignalFeed } from '@sim/host/simClient';
import { createFlagLayer } from '../../render/buildings/flagLayer';
import { createSignalHeads } from '../../render/signals';
import { carGeometry } from '../../render/densityCars';
import { createTransit } from '../../render/transit';
import { unifiedWaterGeometry } from '../../render/terrain';
import { createWaterSurface } from '../../render/water';
import { sheetMaterial } from './items';
import type { BufferGeometry } from 'three';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { SIGN_TYPES, SIGN_HAS_TEXT } from '@world/landscape';
import { BARRIER_KINDS } from '@world/barriers';
import { m } from '@world/units';
import { createSignLayer } from '../../render/signLayer';
import { createBarriers } from '../../render/barriers';
import type { BatchCache } from './capture';
import { piecesOf, shown } from './layout';
import type { ItemSpec } from './items';

/** THE LAYERS THAT STAND ON THE ROADS, each built by its own layer on a layout made here (no city): the signs (`signLayer.ts`), the barriers (`barriers.ts`). */

type Add = (spec: ItemSpec) => void;

const LEG = m(70);

/** A layer's instances culled as a camera close by sees them (`renderer.ts` crowdFrustum, crowdProjection): a run's copies are written only by its cull,
 *  each at the level its size on the screen picks; this camera, 60 m off and 40 m up looking at the centre, sees the whole layout up close. */
export function cullClose(layer: { cull(frustum: Frustum, view: Matrix4): void }): void {
  const camera = new PerspectiveCamera(90, 16 / 9, m(0.1), m(2000));
  camera.position.set(0, m(40), m(60));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  layer.cull(new Frustum().setFromProjectionMatrix(view, camera.coordinateSystem, camera.reversedDepth), view);
}

/** A document with one road of the first class across, `extra` laid on it; its network built. */
function oneRoad(extra: (doc: RoadDoc, net: Network) => void, junction = false): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  if (junction) {
    const centre = doc.addNode({ x: 0, y: 0 });
    for (const [x, y] of [[-LEG, 0], [LEG, 0], [0, LEG], [0, -LEG]] as const) doc.addSegment(doc.addNode({ x, y }).id, centre.id, 0);
  } else doc.addSegment(doc.addNode({ x: -LEG, y: 0 }).id, doc.addNode({ x: LEG, y: 0 }).id, 0);
  let net = new Network(doc);
  net.rebuild();
  extra(doc, net);
  net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/** Where the footway of the road across runs (the document's first road): its middle, metres from the road's centre line. */
function footwayOut(net: Network): number {
  const first = net.doc.segments.keys().next().value!;
  const ribbon = net.ribbons.get(first)!;
  return ribbon.road.width / 2 + ribbon.road.sidewalk / 2;
}

export function signItems(add: Add, cache: BatchCache): void {
  const flat = (): number => 0;
  const one = (name: string, variation: string, extra: (doc: RoadDoc, net: Network) => void, junction = false): void => {
    const { net } = oneRoad(extra, junction);
    const layer = createSignLayer();
    layer.sync(net, buildRoadElevation(net, flat));
    cullClose(layer);
    add({ group: 'Signs', name, variation, origin: 'kit', source: 'src/render/signLayer.ts (createSignLayer, sync)', build: 'instanced',
      pieces: piecesOf(layer.group), object: shown(layer.group, cache), countKey: `sign:${name}`,
      notes: ['the post an instance of the posts\' run, the plate a quad of its sheet\'s mesh (its text painted on the sheet)'] });
  };
  for (const type of SIGN_TYPES) {
    one(type, SIGN_HAS_TEXT.has(type) ? 'with text "Main St 50"' : 'one sign', (doc, net) => {
      doc.addLandscape('sign', { x: 0, y: footwayOut(net) }, { signType: type, ...(SIGN_HAS_TEXT.has(type) ? { text: 'Main St 50' } : {}) });
    });
  }
  one('street name', 'both ends of a street at a junction', (doc, net) => { doc.addLandscape('streetname', { x: LEG / 2, y: footwayOut(net) }, { text: 'Main St' }); }, true);
  one('junction signs', 'what a four-way junction stands of itself', () => {}, true);
}

export function barrierItems(add: Add, cache: BatchCache): void {
  for (const kind of BARRIER_KINDS) {
    const { doc } = oneRoad((d, net) => { d.addBarrier(kind, [{ x: -LEG / 2, y: footwayOut(net) + m(1) }, { x: LEG / 2, y: footwayOut(net) + m(1) }]); });
    const layer = createBarriers();
    layer.sync(doc, () => 0);
    cullClose(layer);
    add({ group: 'Barriers', name: kind, variation: `${LEG} m run`, origin: 'kit', source: 'src/render/barriers.ts (createBarriers, sync)', build: 'instanced',
      pieces: piecesOf(layer.group), object: shown(layer.group, cache), countKey: `barrier:${kind}` });
  }
}

/** A flag as the flag layer draws it (`flagLayer.ts`): one cloth, its pattern and colours the shader's (14 patterns, `flags.ts`). */
export function flagItems(add: Add, cache: BatchCache): void {
  const layer = createFlagLayer();
  layer.set([{ x: 0, y: m(8), z: 0, width: m(1.8), height: m(1.2), design: { pattern: FLAG_PATTERNS[0], colours: [0x1f5fbf, 0xf2f2f2, 0xd8262b] } }]);
  add({ group: 'Flags', name: 'flag cloth', variation: '1.8 x 1.2 m', origin: 'kit', source: 'src/render/buildings/flagLayer.ts (createFlagLayer, set)', build: 'instanced',
    pieces: piecesOf(layer.group), object: shown(layer.group, cache), countKey: 'flags',
    notes: [`the same cloth for every flag: its ${FLAG_PATTERNS.length} patterns and colours drawn by the shader, its wave moved by the wind in the vertex shader`] });
}

/** The traffic signals of a signalised four-way junction as the signal layer stands them (`signals.ts`): a feed as the simulation gives it, its two groups (one
 *  each way across), one stage, every head green. */
export function signalItems(add: Add, cache: BatchCache): void {
  const { net } = oneRoad(() => {}, true);
  const centre = [...net.doc.nodes.values()].find((n) => n.incident.length === 4)!;
  const incident = centre.incident;
  const feed: SignalFeed = {
    changesSince: () => ({ serial: 1, nodes: null }),
    layout: (node: NodeId) => (node === centre.id ? { node, groups: [{ id: 0, segments: [incident[0]!, incident[1]!] }, { id: 1, segments: [incident[2]!, incident[3]!] }] } : undefined),
    state: () => 'green',
    stage: () => 'catalogue',
    nodes: () => [centre.id],
  };
  const heads = createSignalHeads(new Scene());
  heads.sync(feed, net, true);
  add({ group: 'Traffic signals', name: 'signalised junction', variation: `${incident.length} heads (post, arm, housing, visors, lenses, halos)`, origin: 'kit',
    source: 'src/render/signals.ts (createSignalHeads, sync)', build: 'instanced', pieces: piecesOf(heads.group), object: shown(heads.group, cache), countKey: 'signals',
    notes: ['one head on each approach of a signal group, where the world stands its post (signalPostPlace); the frame (post, arm, housing) one geometry an instance'] });
}

/** A far car as the far traffic draws it (`densityCars.ts`): a body and a cabin, placed along its road and coloured by the vertex shader. */
export function farCarItems(add: Add): void {
  const geometry = carGeometry();
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.6 }));
  mesh.name = 'density-car';
  add({ group: 'Vehicles', name: 'far car (far traffic)', variation: '4.3 x 1.8 m, body and cabin', origin: 'kit', source: 'src/render/densityCars.ts (carGeometry)', build: 'instanced',
    pieces: [{ label: 'car', geometry, material: mesh.material }], object: mesh, countKey: 'far-cars',
    notes: ['one instance a car of the far traffic, placed along its road and given its colour in the vertex shader'] });
}

/** The water as the ground lays it (`terrain.ts` unifiedWaterGeometry): a lake from one stamp in a basin, a river along a course; its material the game's (`water.ts`). */
export function waterItems(add: Add): void {
  const surface = createWaterSurface(16);
  const one = (name: string, variation: string, geometry: BufferGeometry): void => {
    const mesh = new Mesh(geometry, sheetMaterial(null, geometry));
    mesh.name = 'water';
    add({ group: 'Water', name, variation, origin: 'kit', source: 'src/render/terrain.ts (unifiedWaterGeometry)', build: 'merged',
      pieces: [{ label: 'water', geometry, material: surface.material }], object: mesh, countKey: `water:${name}`,
      notes: ['its waves, foam and current drawn by the water shader over the time (water.ts)'] });
  };
  // A basin 4 m deep under the lake's disc, the land level round it.
  const basin = (x: number, y: number): number => (Math.hypot(x, y) < m(40) ? -m(4) : 0);
  one('lake', 'one stamp, 40 m round', unifiedWaterGeometry([{ x: 0, y: 0, radius: m(40), level: -m(0.5) }], basin));
  const course = Array.from({ length: 9 }, (_, i) => ({ x: -m(80) + i * m(20), y: Math.sin(i / 2) * m(10), half: m(8), level: -m(1) }));
  const bed = (x: number, y: number): number => (Math.abs(y - Math.sin((x + m(80)) / m(40)) * m(10)) < m(9) ? -m(3) : 0);
  one('river', '160 m course, 16 m wide', unifiedWaterGeometry([], bed, undefined, [course]));
}

/** Rails and stations as the transit layer lays them (`transit.ts`): a train's track with a station, the metro's under the ground with its station and way
 *  down, and a bus stop on a road. */
export function transitItems(add: Add, cache: BatchCache): void {
  const lay = (name: string, variation: string, make: (doc: RoadDoc, net: Network) => void): void => {
    const { doc } = oneRoad(make);
    const layer = createTransit();
    layer.sync(doc, () => 0, () => 0, () => false);
    cullClose(layer);
    add({ group: 'Transit', name, variation, origin: 'kit', source: 'src/render/transit.ts (createTransit, sync)', build: 'instanced',
      pieces: piecesOf(layer.group), object: shown(layer.group, cache), countKey: `transit:${name}` });
  };
  lay('train track and station', `${LEG * 2} m of track`, (doc) => {
    const track = addTrack(emptyTransit(), 'train', [{ x: -LEG, y: m(40) }, { x: LEG, y: m(40) }]);
    const stop = addStop(track.data, { mode: 'train', x: 0, y: m(40), track: track.id });
    doc.setTransit(addLine(stop.data, 'train', [stop.id]).data);
  });
  lay('metro track and station', `${LEG * 2} m of track, its way down`, (doc, net) => {
    const track = addTrack(emptyTransit(), 'metro', [{ x: -LEG, y: m(10) }, { x: LEG, y: m(10) }]);
    const stop = addStop(track.data, { mode: 'metro', x: 0, y: m(10), track: track.id, entrance: { x: m(10), y: footwayOut(net) } });
    doc.setTransit(addLine(stop.data, 'metro', [stop.id]).data);
  });
  lay('bus stop', 'on the footway\'s edge', (doc, net) => {
    const segment = net.doc.segments.keys().next().value!;
    const stop = addStop(emptyTransit(), { mode: 'bus', x: 0, y: footwayOut(net), segment });
    doc.setTransit(addLine(stop.data, 'bus', [stop.id]).data);
  });
}
