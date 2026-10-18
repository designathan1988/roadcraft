import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Frustum, Matrix4, PerspectiveCamera, Sphere, Vector3, WebGLCoordinateSystem, type InstancedMesh } from 'three';
import { VEHICLE_REACH, createAgentMeshes } from '@render/agents';
import { frustumGroundBox } from '@render/frustumGround';
import { FleetGrid, type FleetCell, type GroundBox } from '@sim/host/fleetGrid';
import type { SimClient, VehicleView } from '@sim/host/simClient';
import { archetypeById } from '@sim/vehicles/archetypes';
import type { Network } from '@world/network';
import { ChangeJournal } from '@world/changes';
import { m } from '@world/units';
import { QUALITY, VEHICLE_WHOLE_CAP } from '@render/quality';

/** What a frame asks of each standing vehicle while the camera moves: its tests of the view, its ground and its scale on the screen, once per change and not per frame. */

function parkedCar(id: number, x: number, y: number): VehicleView {
  return {
    id, archetype: archetypeById(id % 3 === 0 ? 'suv' : 'sedan'), color: '#a83a2c', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: 0,
    prev: { v: 0 }, free: { x, y, angle: 0.3, px: x, py: y, pangle: 0.3, lot: null },
    frames: { bx: x, by: y, bangle: 0.3, x, y, angle: 0.3, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0, tickRead: 0,
  };
}

/** A car stopped at a light a whole tick, on its lane. */
function stoppedCar(id: number, x: number, y: number): VehicleView {
  return {
    id, archetype: archetypeById('sedan'), color: '#2f5f92', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: 0,
    prev: { v: 0 }, free: null, frames: { bx: x, by: y, bangle: 0, x, y, angle: 0, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0, tickRead: 0,
  };
}

function worldWith(parked: readonly VehicleView[], traffic: readonly VehicleView[]): SimClient {
  const grid = new FleetGrid<VehicleView>();
  for (const car of parked) grid.place(car);
  const vehiclesIn = (_box: GroundBox, out: VehicleView[], which = 'all'): VehicleView[] => { out.length = 0; if (which === 'traffic') out.push(...traffic); return out; };
  const parkedCellsIn = (box: GroundBox, out: FleetCell<VehicleView>[]): FleetCell<VehicleView>[] => { out.length = 0; return grid.cellsNear(box.x0, box.y0, box.x1, box.y1, out); };
  const vehicles = new Map<number, VehicleView>(traffic.map((v) => [v.id, v] as const));
  return { time: 0, traffic, vehicles, parked, isParked: (v: VehicleView) => parked.includes(v), pedViews: [], fleet: 0, vehiclesIn, parkedCellsIn } as unknown as SimClient;
}

const bodiesOf = (agents: ReturnType<typeof createAgentMeshes>): InstancedMesh[] =>
  agents.meshes.filter((o): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh === true && /^car-.*-(shell|shell-lite|far)$/.test(o.name));
const drawn = (meshes: readonly InstancedMesh[]): number => meshes.reduce((n, mesh) => n + (mesh.visible ? mesh.count : 0), 0);

describe('standing vehicles while the camera moves', () => {
  beforeAll(() => { vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {} }); vi.stubGlobal('location', { search: '?bodies=cooked' }); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('are tested, grounded and scaled once per change, not once per frame', () => {
    const parked: VehicleView[] = [];
    // 4 x 4 cells of 64 m, 9 cars each, well inside the view.
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) parked.push(parkedCar(i * 12 + j + 1, m(4) + i * m(21), m(4) + j * m(21)));
    const traffic = Array.from({ length: 20 }, (_, k) => stoppedCar(1000 + k, m(10) + k * m(10), m(130)));
    const world = worldWith(parked, traffic);
    const net = { doc: { changes: new ChangeJournal() } } as unknown as Network;
    let grounds = 0, tests = 0, scales = 0;
    const agents = createAgentMeshes(() => { grounds++; return 0; }, () => {}, () => 0, () => { grounds++; return 0; });
    const camera = new PerspectiveCamera(50, 1.6, m(0.4), m(3000));
    const sphere = new Sphere(new Vector3(), 1);
    const projection = new Matrix4();
    const frustum = new Frustum();
    const right = new Vector3(), foot = new Vector3(), other = new Vector3();
    let counts: number[] = [];
    // The renderer's own tests (`renderer.ts` `vehicleVisible`, `vehicleInside`, `screenScale`), from a camera high over the lot panning slowly.
    for (let frame = 0; frame < 12; frame++) {
      camera.position.set(m(130) + frame * m(0.5), m(450), -m(130) + m(40));
      camera.lookAt(m(130) + frame * m(0.5), 0, -m(130));
      camera.updateMatrixWorld();
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projection, WebGLCoordinateSystem);
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      const at = (x: number, y: number, height: number, radius: number): Sphere => { sphere.center.set(x, height + radius * 0.3, -y); sphere.radius = radius; return sphere; };
      const vehicleVisible = (x: number, y: number, height: number, radius: number): boolean => { tests++; return frustum.intersectsSphere(at(x, y, height, radius)); };
      const vehicleInside = (x: number, y: number, height: number, radius: number): boolean => {
        tests++;
        const s = at(x, y, height, radius);
        return frustum.planes.every((p) => p.distanceToPoint(s.center) >= s.radius);
      };
      const screenScale = (x: number, y: number, z: number): number => {
        scales++;
        foot.set(x, z, -y);
        other.copy(foot).add(right).applyMatrix4(projection);
        foot.applyMatrix4(projection);
        return Math.hypot((other.x - foot.x) * 960, (other.y - foot.y) * 540);
      };
      const vehicleBox = frustumGroundBox(frustum, VEHICLE_REACH, -m(160), m(300), { x0: 0, y0: 0, x1: 0, y1: 0 });
      grounds = 0; tests = 0; scales = 0;
      agents.sync(world, net, 0, true, undefined, { vehicleVisible, vehicleInside, vehicleBox, screenScale, eye: camera.position.clone() });
      counts = [grounds, tests, scales];
      expect(drawn(bodiesOf(agents))).toBe(parked.length + traffic.length);
    }
    const [g, t, s] = counts;
    // Nothing of them changed: no ground asked; a test and a scale for each stopped car, a test for each cell and the screen's scale found once (`depthField`), nothing for each parked car.
    // Before (each car walked every frame): 20 grounds, 508 tests and 165 scales.
    expect(g).toBe(0);
    expect(t).toBe(traffic.length + 16);
    expect(s).toBe(1 + traffic.length + 5);
    agents.dispose();
  });

  it('ask nothing of a walker off the view ground: neither whether a ragdoll hides them nor their pose', () => {
    const peds = Array.from({ length: 200 }, (_, k) => {
      const x = m(2000) + k * m(3), y = m(2000);
      return { id: k + 1, x, y, prev: { x: x - m(1), y, heading: 0 }, heading: 0, v: m(1.3), turnV: 0, age: 0, segment: undefined, walking: true, kerbWait: 0, rank: 0, ground: 'footway', tickRead: 0 };
    });
    const world = { ...worldWith([], []), pedViews: peds, tick: 1 } as unknown as SimClient;
    const net = { doc: { changes: new ChangeJournal() } } as unknown as Network;
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    let asked = 0;
    agents.sync(world, net, 0.5, true, 40, { vehicleBox: { x0: 0, y0: 0, x1: m(300), y1: m(300) }, hiddenPed: () => { asked++; return false; } });
    expect(asked).toBe(0);
    // One walking into it, between where they were and are: asked.
    peds[0]!.prev.x = m(250); peds[0]!.x = m(310); peds[0]!.y = m(100); peds[0]!.prev.y = m(100);
    agents.sync(world, net, 0.5, true, 40, { vehicleBox: { x0: 0, y0: 0, x1: m(300), y1: m(300) }, hiddenPed: () => { asked++; return false; } });
    expect(asked).toBe(1);
    agents.dispose();
  });

  it('take their detail from the tier: the weak one coarser, every other one as before', () => {
    expect([QUALITY.low.vehicleErrorPixels, QUALITY.low.vehicleWholeCap, QUALITY.low.hairStrandPeople]).toEqual([1, 60, 2]);
    for (const level of ['medium', 'high', 'ultra'] as const) {
      expect([QUALITY[level].vehicleErrorPixels, QUALITY[level].vehicleWholeCap, QUALITY[level].hairStrandPeople]).toEqual([0.5, 200, 8]);
    }
    // 300 cars, all big on the screen; frames drawn with no tier, the strong one, and the weak one.
    const traffic = Array.from({ length: 300 }, (_, k) => ({ ...stoppedCar(k + 1, (k % 20) * m(12), Math.floor(k / 20) * m(12)), v: m(5), prev: { v: m(5) } }));
    const world = worldWith([], traffic);
    const net = { doc: { changes: new ChangeJournal() } } as unknown as Network;
    const frame = (tier?: (typeof QUALITY)['high']): { names: string[]; matrices: number[][] } => {
      const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
      const options = { vehicleVisible: () => true, vehicleBox: { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, screenScale: () => 40, ...(tier ? { tier } : {}) };
      for (let f = 0; f < 3; f++) agents.sync(world, net, 0, true, 40, options);
      const shown = agents.meshes.filter((o): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh === true && o.visible && (o as InstancedMesh).count > 0);
      const out = { names: shown.map((mesh) => `${mesh.name}:${mesh.count}`), matrices: shown.map((mesh) => Array.from((mesh.instanceMatrix.array as Float32Array).subarray(0, mesh.count * 16))) };
      agents.dispose();
      return out;
    };
    const none = frame();
    for (const level of ['medium', 'high', 'ultra'] as const) expect(frame(QUALITY[level])).toEqual(none);
    // The weak tier: at most its cap whole (a car's shell drawn whole), the rest a level down.
    const weak = frame(QUALITY.low);
    const whole = (f: { names: string[] }): number => f.names.filter((n) => /^car-.*-shell:/.test(n)).reduce((a, n) => a + Number(n.split(':').pop()), 0);
    expect(whole(none)).toBe(VEHICLE_WHOLE_CAP);
    expect(whole(weak)).toBe(60);
  });

  it('draw what walking every car draws, frame by frame, while the camera pans and comes down through the levels', () => {
    const parked: VehicleView[] = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) parked.push(parkedCar(i * 12 + j + 1, m(4) + i * m(21), m(4) + j * m(21)));
    const world = worldWith(parked, []);
    const net = { doc: { changes: new ChangeJournal() } } as unknown as Network;
    const kept = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const walked = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const camera = new PerspectiveCamera(50, 1.6, m(0.4), m(3000));
    const sphere = new Sphere(new Vector3(), 1);
    const projection = new Matrix4();
    const frustum = new Frustum();
    const right = new Vector3(), foot = new Vector3(), other = new Vector3();
    const shown = (agents: ReturnType<typeof createAgentMeshes>): string[] => agents.meshes
      .filter((o): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh === true && o.visible && (o as InstancedMesh).count > 0)
      .map((mesh) => `${mesh.name}:${mesh.count}`).sort();
    for (let frame = 0; frame < 40; frame++) {
      const height = m(900) - frame * m(18);
      camera.position.set(m(130) + frame * m(1.5), height, -m(130) + m(40));
      camera.lookAt(m(130) + frame * m(1.5), 0, -m(130));
      camera.updateMatrixWorld();
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projection, WebGLCoordinateSystem);
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      const at = (x: number, y: number, h: number, radius: number): Sphere => { sphere.center.set(x, h + radius * 0.3, -y); sphere.radius = radius; return sphere; };
      const vehicleVisible = (x: number, y: number, h: number, radius: number): boolean => frustum.intersectsSphere(at(x, y, h, radius));
      const vehicleInside = (x: number, y: number, h: number, radius: number): boolean => {
        const c = at(x, y, h, radius);
        return frustum.planes.every((p) => p.distanceToPoint(c.center) >= c.radius);
      };
      const screenScale = (x: number, y: number, z: number): number => {
        foot.set(x, z, -y);
        other.copy(foot).add(right).applyMatrix4(projection);
        foot.applyMatrix4(projection);
        return Math.hypot((other.x - foot.x) * 960, (other.y - foot.y) * 540);
      };
      const vehicleBox = frustumGroundBox(frustum, VEHICLE_REACH, -m(160), m(300), { x0: 0, y0: 0, x1: 0, y1: 0 });
      const eye = camera.position.clone();
      kept.sync(world, net, 0, true, undefined, { vehicleVisible, vehicleInside, vehicleBox, screenScale, eye });
      walked.sync(world, net, 0, true, undefined, { vehicleVisible, vehicleBox, screenScale, eye });
      expect(shown(kept), `frame ${frame}`).toEqual(shown(walked));
    }
    kept.dispose();
    walked.dispose();
  });
});
