import { readFileSync } from 'node:fs';
import { MeshBasicMaterial, type BufferGeometry, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { Digest } from '@core/digest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation, type RoadElevation } from '@world/elevation';
import type { SceneMaterials } from '@render/materials';
import { type RoadSurfaces, type SurfaceReuse, roadSurfaceSteps } from '@render/roadSurfaces';
import { SurfaceInputs } from '@render/roadSurfaceInputs';
import { marksRoadSection } from '@render/mesh/roadEdges';

/** THE WORLD BUILD VISITS ONLY WHAT CHANGED (`roadSurfaces.ts` PassState): the tiles an edit or a load names, those its blocks reach and those that came into or left the active region; the meshes are a fresh build's, block for block, in its order */

const readingAll = (): MeshBasicMaterial => { const m = new MeshBasicMaterial({ vertexColors: true }); marksRoadSection(m); return m; };
/** One material for each name, made once (as the game's are): a pass's blocks are kept under their materials. */
const made = new Map<string | symbol, MeshBasicMaterial>();
const materials = new Proxy({}, { get: (_t, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : made.get(key) ?? made.set(key, readingAll()).get(key) }) as unknown as SceneMaterials;
const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);
const fixture = (): RoadDoc => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document);

function fingerprint(root: Object3D): number {
  const digest = new Digest();
  root.traverse((object) => {
    const geometry = (object as { geometry?: BufferGeometry }).geometry;
    if (!geometry) return;
    digest.addText(object.name);
    for (const name of ['position', 'normal', 'uv', 'color']) digest.addAll(geometry.getAttribute(name).array);
    digest.addAll(geometry.getIndex()!.array);
  });
  return digest.value();
}

const reuseFor = (elevation: () => RoadElevation, passes: boolean): SurfaceReuse => ({
  tiles: new Map(), depends: new Map(), paint: new Map(), chunks: new Map(), inputs: new SurfaceInputs(),
  dependsOn: (minX, minY, maxX, maxY) => elevation().digest(minX, minY, maxX, maxY),
  ...(passes ? { passes: new Map(), withinMoved: [] } : {}),
});

function build(net: Network, elevation: RoadElevation, reuse: SurfaceReuse, changed: (readonly [number, number, number, number])[] | null, stopAfter = Infinity): RoadSurfaces | null {
  const steps = roadSurfaceSteps(net, elevation, materials, ground, reuse, undefined, null, changed);
  for (let n = 0; ; n++) {
    if (n >= stopAfter) return null;
    const step = steps.next();
    if (step.done) { step.value.adopt(); return step.value; }
  }
}

describe('the world build visiting only what changed', () => {
  it('gives a fresh build\'s meshes after an edit, nothing again when nothing changed, and after a build left halfway', () => {
    const doc = fixture();
    const net = new Network(doc);
    net.rebuild();
    let elevation = buildRoadElevation(net, ground);
    const reuse = reuseFor(() => elevation, true);
    const cold = build(net, elevation, reuse, null)!;
    expect(cold.built).toBeGreaterThan(20);
    // Nothing changed: no tile built, every tile kept, the same meshes.
    const coldPrint = fingerprint(cold.group);
    const still = build(net, elevation, reuse, [])!;
    expect(still.built).toBe(0);
    expect(still.reused).toBe(cold.built);
    // Its blocks are the same meshes, moved into this build's group (`adopt`).
    expect(fingerprint(still.group)).toBe(coldPrint);
    // A road added: only what it reaches built, the meshes a fresh build's.
    const first = [...doc.nodes.values()][0]!;
    const far = doc.addNode({ x: first.x + 40, y: first.y - 260 });
    doc.addSegment(first.id, far.id, 2);
    net.rebuild();
    elevation = buildRoadElevation(net, ground);
    const box: [number, number, number, number] = [Math.min(first.x, far.x) - 200, Math.min(first.y, far.y) - 200, Math.max(first.x, far.x) + 200, Math.max(first.y, far.y) + 200];
    // A build left halfway (a newer change replaced it): the next one still visits what it was asked to.
    expect(build(net, elevation, reuse, [box], 3)).toBeNull();
    const warm = build(net, elevation, reuse, [box])!;
    expect(warm.built).toBeGreaterThan(0);
    expect(warm.reused).toBeGreaterThan(warm.built * 2);
    const fresh = build(net, elevation, reuseFor(() => elevation, false), null)!;
    expect(fingerprint(warm.group)).toBe(fingerprint(fresh.group));
    expect(warm.triangles).toBe(fresh.triangles);
  });

  it('builds the tiles that come into the active region and lets go of those that leave, as a fresh build of that region', () => {
    const doc = fixture();
    const net = new Network(doc);
    net.rebuild();
    const elevation = buildRoadElevation(net, ground);
    const reuse = reuseFor(() => elevation, true);
    const east = (rect: readonly number[]): boolean => (rect[0]! + rect[2]!) / 2 >= 0;
    reuse.within = east;
    const half = build(net, elevation, reuse, null)!;
    // Widened: the west half comes in.
    const west: [number, number, number, number] = [-1e5, -1e5, 0, 1e5];
    reuse.within = () => true;
    reuse.withinMoved!.push(west);
    const whole = build(net, elevation, reuse, [])!;
    expect(whole.built).toBeGreaterThan(0);
    expect(reuse.withinMoved).toEqual([]);
    const fresh = build(net, elevation, reuseFor(() => elevation, false), null)!;
    expect(fingerprint(whole.group)).toBe(fingerprint(fresh.group));
    // Narrowed again: nothing built, the east half's meshes.
    reuse.within = east;
    reuse.withinMoved!.push(west);
    const narrowed = build(net, elevation, reuse, [])!;
    expect(narrowed.built).toBe(0);
    expect(narrowed.triangles).toBe(half.triangles);
    const freshHalf = reuseFor(() => elevation, false);
    freshHalf.within = east;
    expect(fingerprint(narrowed.group)).toBe(fingerprint(build(net, elevation, freshHalf, null)!.group));
  });
});
