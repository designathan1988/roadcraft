import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Frustum, Matrix4, OrthographicCamera, PerspectiveCamera, Sphere, Vector3, WebGLCoordinateSystem, type InstancedMesh } from 'three';
import { Rng } from '@core/rng';
import { VEHICLE_REACH, createAgentMeshes } from '@render/agents';
import { frustumGroundBox } from '@render/frustumGround';
import { FleetGrid, type FleetCell, type GroundBox } from '@sim/host/fleetGrid';
import type { SimClient, VehicleView } from '@sim/host/simClient';
import { archetypeById } from '@sim/vehicles/archetypes';
import type { Network } from '@world/network';
import { ChangeJournal } from '@world/changes';
import { m } from '@world/units';

/** Only the vehicles on the view's ground are walked (`frustumGround.ts`, `SimClient.vehiclesIn`): the same drawn as walking them all */

type Camera = PerspectiveCamera | OrthographicCamera;

/** The view's frustum as the renderer makes it (`renderer.ts` `crowdFrustum`), in either depth convention. */
function frustumOf(camera: Camera, reversed: boolean): Frustum {
  camera.updateMatrixWorld();
  const projection = new Matrix4();
  if (camera instanceof PerspectiveCamera) {
    const top = camera.near * Math.tan((camera.fov * Math.PI) / 360), right = top * camera.aspect;
    projection.makePerspective(-right, right, top, -top, camera.near, camera.far, WebGLCoordinateSystem, reversed);
  } else projection.makeOrthographic(camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far, WebGLCoordinateSystem, reversed);
  return new Frustum().setFromProjectionMatrix(projection.multiply(camera.matrixWorldInverse), WebGLCoordinateSystem, reversed);
}

function cameraAt(rng: Rng): Camera {
  if (rng.bool(0.3)) {
    const half = m(40) + rng.float() * m(800);
    const camera = new OrthographicCamera(-half, half, half * 0.6, -half * 0.6, m(0.4), m(5600));
    camera.position.set(rng.range(-m(2000), m(2000)), m(300) + rng.float() * m(1500), rng.range(-m(2000), m(2000)));
    camera.lookAt(camera.position.x + rng.range(-m(600), m(600)), 0, camera.position.z + rng.range(-m(600), m(600)));
    return camera;
  }
  const camera = new PerspectiveCamera(30 + rng.float() * 50, 1.2 + rng.float(), m(0.4), m(300) + rng.float() * m(3000));
  camera.position.set(rng.range(-m(2000), m(2000)), m(2) + rng.float() * m(400), rng.range(-m(2000), m(2000)));
  camera.lookAt(rng.range(-m(2000), m(2000)), 0, rng.range(-m(2000), m(2000)));
  return camera;
}

describe("the view's ground box", () => {
  it('holds every centre a sphere of the reach can stand at and be seen, between the two heights', () => {
    const rng = new Rng(11);
    const grow = m(12), low = -m(60), high = m(180);
    const point = new Vector3();
    let seen = 0;
    for (let view = 0; view < 40; view++) {
      const camera = cameraAt(rng);
      const frustum = frustumOf(camera, view % 2 === 0);
      const box = frustumGroundBox(frustum, grow, low, high, { x0: 0, y0: 0, x1: 0, y1: 0 });
      const reach = camera.far + m(100);
      for (let k = 0; k < 6000; k++) {
        point.set(camera.position.x + rng.range(-reach, reach), rng.range(low, high), camera.position.z + rng.range(-reach, reach));
        // `Frustum.intersectsSphere`'s own test: no plane farther than the radius behind.
        if (!frustum.planes.every((p) => p.distanceToPoint(point) >= -grow)) continue;
        seen++;
        const eps = m(0.01);
        expect(point.x).toBeGreaterThanOrEqual(box.x0 - eps);
        expect(point.x).toBeLessThanOrEqual(box.x1 + eps);
        expect(-point.z).toBeGreaterThanOrEqual(box.y0 - eps);
        expect(-point.z).toBeLessThanOrEqual(box.y1 + eps);
      }
    }
    // Enough centres seen for the test to mean something.
    expect(seen).toBeGreaterThan(500);
  });

  it('is the rectangle under a camera looking straight down, grown by the reach', () => {
    const camera = new OrthographicCamera(-m(300), m(300), m(200), -m(200), m(1), m(2000));
    camera.position.set(m(100), m(500), -m(200));
    camera.up.set(0, 0, -1);
    camera.lookAt(m(100), 0, -m(200));
    for (const reversed of [false, true]) {
      const box = frustumGroundBox(frustumOf(camera, reversed), m(10), -m(150), m(300), { x0: 0, y0: 0, x1: 0, y1: 0 });
      expect(box.x0).toBeCloseTo(m(100) - m(310), 4);
      expect(box.x1).toBeCloseTo(m(100) + m(310), 4);
      expect(box.y0).toBeCloseTo(m(200) - m(210), 4);
      expect(box.y1).toBeCloseTo(m(200) + m(210), 4);
    }
  });

  it('is empty where the heights lie outside the view', () => {
    const camera = new OrthographicCamera(-m(300), m(300), m(200), -m(200), m(1), m(400));
    camera.position.set(0, m(1000), 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    const box = frustumGroundBox(frustumOf(camera, false), 0, -m(50), m(50), { x0: 0, y0: 0, x1: 0, y1: 0 });
    expect(box.x0 > box.x1 || box.y0 > box.y1).toBe(true);
  });
});

/** A car standing in its bay with nobody in it. */
function parkedCar(id: number, x: number, y: number): VehicleView {
  return {
    id, archetype: archetypeById(id % 3 === 0 ? 'suv' : 'sedan'), color: '#a83a2c', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: 0,
    prev: { v: 0 }, free: { x, y, angle: 0.3, px: x, py: y, pangle: 0.3, lot: null },
    frames: { bx: x, by: y, bangle: 0.3, x, y, angle: 0.3, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0, tickRead: 0,
  };
}

/** The client `sync` reads: the parked cars as a list and by place (`SimClient.vehiclesIn`, none of them moving). */
function worldWith(parked: readonly VehicleView[]): SimClient {
  const grid = new FleetGrid<VehicleView>();
  for (const car of parked) grid.place(car);
  const vehiclesIn = (box: GroundBox, out: VehicleView[], which = 'all'): VehicleView[] => { out.length = 0; return which === 'traffic' ? out : grid.near(box.x0, box.y0, box.x1, box.y1, out); };
  const parkedCellsIn = (box: GroundBox, out: FleetCell<VehicleView>[]): FleetCell<VehicleView>[] => { out.length = 0; return grid.cellsNear(box.x0, box.y0, box.x1, box.y1, out); };
  return { time: 0, traffic: [], vehicles: new Map(), parked, isParked: (v: VehicleView) => parked.includes(v), pedViews: [], fleet: 0, vehiclesIn, parkedCellsIn, grid } as unknown as SimClient;
}

const netWith = (): Network => ({ doc: { changes: new ChangeJournal() } }) as unknown as Network;
const bodiesOf = (agents: ReturnType<typeof createAgentMeshes>): InstancedMesh[] =>
  agents.meshes.filter((o): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh === true && /^car-.*-(shell|shell-lite|far)$/.test(o.name));
const drawn = (meshes: readonly InstancedMesh[]): number => meshes.reduce((n, mesh) => n + (mesh.visible ? mesh.count : 0), 0);

describe('vehicles drawn from the grid', () => {
  beforeAll(() => { vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {} }); vi.stubGlobal('location', { search: '?bodies=cooked' }); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('are those a walk of every vehicle draws, through the same frustum', () => {
    const cars: VehicleView[] = [];
    for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) cars.push(parkedCar(i * 60 + j + 1, (i - 30) * m(12), (j - 30) * m(12)));
    const world = worldWith(cars);
    const net = netWith();
    // One walking every vehicle, one asking the grid: each frame of each the same view.
    const all = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const grid = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const rng = new Rng(3);
    for (let view = 0; view < 4; view++) {
      const camera = new PerspectiveCamera(40 + rng.float() * 30, 1.6, m(0.4), m(250) + rng.float() * m(250));
      camera.position.set(rng.range(-m(100), m(100)), m(20) + rng.float() * m(80), rng.range(-m(100), m(100)));
      camera.lookAt(camera.position.x + rng.range(-m(120), m(120)), 0, camera.position.z + rng.range(-m(120), m(120)));
      const frustum = frustumOf(camera, view % 2 === 1);
      const sphere = new Sphere(new Vector3(), 1);
      // The renderer's own test (`renderer.ts` `vehicleVisible`).
      const vehicleVisible = (x: number, y: number, height: number, radius: number): boolean => {
        sphere.center.set(x, height + radius * 0.3, -y);
        sphere.radius = radius;
        return frustum.intersectsSphere(sphere);
      };
      const vehicleBox = frustumGroundBox(frustum, VEHICLE_REACH, -m(160), m(300), { x0: 0, y0: 0, x1: 0, y1: 0 });
      // Every car at the middle level: the whole level's cap (`VEHICLE_NEAR_CAP`) takes them in the order walked, and a car off the screen draws only what casts.
      const screenScale = (): number => 2;
      all.sync(world, net, 0, true, undefined, { vehicleVisible, screenScale });
      grid.sync(world, net, 0, true, undefined, { vehicleVisible, vehicleBox, screenScale });
      const walked = drawn(bodiesOf(all));
      expect(walked).toBeGreaterThan(0);
      expect(walked).toBeLessThan(cars.length);
      expect(drawn(bodiesOf(grid))).toBe(walked);
    }
    all.dispose();
    grid.dispose();
  });

  it('walk no parked car of a cell that stands, in a view that stands; a cell that changed walked again', () => {
    const cars: VehicleView[] = [];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) cars.push(parkedCar(i * 6 + j + 1, i * m(40), j * m(40)));
    const world = worldWith(cars);
    const grid = (world as unknown as { grid: FleetGrid<VehicleView> }).grid;
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    let asked = 0;
    const options = {
      vehicleVisible: () => true, vehicleBox: { x0: -m(10), y0: -m(10), x1: m(250), y1: m(250) },
      screenScale: (): number => { asked++; return 2; }, eye: new Vector3(0, m(100), 0),
    };
    agents.sync(world, netWith(), 0, true, undefined, options);
    const shown = drawn(bodiesOf(agents));
    expect(shown).toBe(cars.length);
    // The same view: only the view's own probe asked, every car still drawn from its kept instances.
    asked = 0;
    agents.sync(world, netWith(), 0, true, undefined, options);
    expect(asked).toBe(1);
    expect(drawn(bodiesOf(agents))).toBe(shown);
    // A car of one cell changed there: that cell's cars walked, no other.
    grid.touch(cars[0]!);
    asked = 0;
    agents.sync(world, netWith(), 0, true, undefined, options);
    const inCell = cars.filter((c) => Math.floor(c.frames.x / m(64)) === 0 && Math.floor(c.frames.y / m(64)) === 0).length;
    expect(asked).toBe(1 + inCell);
    // The view moved: every car walked.
    asked = 0;
    agents.sync(world, netWith(), 0, true, undefined, { ...options, eye: new Vector3(m(1), m(100), 0) });
    expect(asked).toBe(1 + cars.length);
    expect(drawn(bodiesOf(agents))).toBe(shown);
    agents.dispose();
  });

  it('test a cell off the view once, not each of its cars, while nothing of it changed', () => {
    const cars: VehicleView[] = [];
    // Two cells: one in the view, one off it, 20 cars each.
    for (let k = 0; k < 20; k++) cars.push(parkedCar(k + 1, m(10) + (k % 5) * m(8), m(10) + Math.floor(k / 5) * m(8)));
    for (let k = 0; k < 20; k++) cars.push(parkedCar(k + 101, m(138) + (k % 5) * m(8), m(10) + Math.floor(k / 5) * m(8)));
    const world = worldWith(cars);
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    let tests = 0;
    const vehicleVisible = (x: number): boolean => { tests++; return x < m(110); };
    let eye = 0;
    const frame = (): void => {
      // A view that moves a little every frame: nothing kept by the view standing still.
      agents.sync(world, netWith(), 0, true, undefined, { vehicleVisible, vehicleBox: { x0: 0, y0: 0, x1: m(250), y1: m(100) }, screenScale: () => 2, eye: new Vector3(eye++, m(100), 0) });
    };
    frame();
    tests = 0;
    frame();
    // A test a cell (the one off the view stops there), then the 20 cars in view their own (the first, the exact one, the body's): not 20 more for the cell off it.
    expect(tests).toBeLessThanOrEqual(2 + 20 * 3);
    expect(drawn(bodiesOf(agents))).toBe(20);
    agents.dispose();
  });

  it('off the screen and in the reach of the shadows, write only what casts', () => {
    const world = worldWith([parkedCar(1, 0, 0)]);
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const named = (re: RegExp): number => drawn(agents.meshes.filter((o): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh === true && re.test(o.name)));
    const big = (): number => 50;
    // Seen: the body, its glass and its lamps.
    agents.sync(world, netWith(), 0, true, undefined, { vehicleVisible: () => true, screenScale: big });
    expect(named(/^car-.*-shell$/)).toBe(1);
    expect(named(/^car-.*-glass$/)).toBe(1);
    expect(named(/^vehicle-lamps$/)).toBeGreaterThan(0);
    // Only its shadow's sphere in the view: the body and the wheels, no glass, no lamps.
    const reachOnly = (_x: number, _y: number, _h: number, radius: number): boolean => radius > m(4.5);
    agents.sync(world, netWith(), 0, true, undefined, { vehicleVisible: reachOnly, screenScale: big });
    expect(named(/^car-.*-shell$/)).toBe(1);
    expect(named(/^vehicle-wheels$/)).toBe(4);
    expect(named(/^car-.*-glass$/)).toBe(0);
    expect(named(/^vehicle-lamps$/)).toBe(0);
    agents.dispose();
  });
});
