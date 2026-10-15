import { describe, expect, it } from 'vitest';

import { createIsoRig } from '@render/isoViewport';
import { CameraGestures } from '@view/cameraGestures';
import { m } from '@world/units';

/** A DRAG ACROSS A TOWN (`render/isoViewport.ts`, `view/cameraGestures.ts`) */
const W = 1280;
const H = 720;
const REACH = m(2), CLEAR = m(1);

/** Blocks of buildings 30 m square and 12-60 m tall, streets 14 m wide between them. */
const boxes: { x0: number; x1: number; y0: number; y1: number; top: number }[] = [];
for (let i = -8; i <= 8; i++) {
  for (let j = -8; j <= 8; j++) {
    const x0 = i * m(44), y0 = j * m(44);
    boxes.push({ x0, x1: x0 + m(30), y0, y1: y0 + m(30), top: m(12 + (((i * 7 + j * 13) % 5 + 5) % 5) * 12) });
  }
}
const roofAt = (x: number, y: number): number => {
  let r = -Infinity;
  for (const q of boxes) if (x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1) r = Math.max(r, q.top);
  return r;
};
const floorAt = (x: number, y: number): number => {
  let f = -Infinity;
  for (const q of boxes) {
    const out = Math.hypot(Math.max(0, q.x0 - x, x - q.x1), Math.max(0, q.y0 - y, y - q.y1));
    if (out >= REACH) continue;
    const t = out / REACH;
    f = Math.max(f, q.top + CLEAR - (q.top + CLEAR) * (t * t * (3 - 2 * t)));
  }
  return f;
};

type Rig = ReturnType<typeof createIsoRig>;
/** What is drawn under a screen point: the first surface (roof or ground) the ray meets. */
function surfaceUnder(view: Rig['viewport'], px: number, py: number): number {
  const ray = view.rayAt!(px, py, W, H);
  for (let s = 0; s < 4000; s += 0.25) {
    const x = ray.ox + ray.dx * s, y = ray.oy + ray.dy * s, z = ray.oz + ray.dz * s;
    const top = Math.max(0, roofAt(x, y));
    if (z <= top) return top;
  }
  return 0;
}

function dragAcross(half: number, from: { x: number; y: number }, to: { x: number; y: number }, steps: number) {
  const rig = createIsoRig({ x: m(37), y: m(-7) }, half);
  rig.resize(W, H);
  rig.setGround(() => 0);
  rig.setSolids(floorAt, roofAt);
  rig.setPerspective(true);
  rig.viewport.setOrbit(0.8, 0.84);
  const view = rig.viewport;
  const gestures = new CameraGestures({
    view: () => view, size: () => ({ w: W, h: H }), orbited: () => {}, redraw: () => {},
    heightUnder: (at) => surfaceUnder(view, at.x, at.y),
  });
  let t = 1000;
  gestures.press(1, from, t);
  gestures.startPan(1, from);
  const centres: { x: number; y: number; z: number }[] = [{ ...view.centre, z: view.eye!.z }];
  for (let i = 1; i <= steps; i++) {
    t += 16;
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    gestures.move(1, p, t);
    centres.push({ ...view.centre, z: view.eye!.z });
  }
  return centres;
}

describe('a middle-button drag across the town', () => {
  // The bairro drag takes the centre over three buildings (36, 60 and 24 m)
  const cases = [
    ['bairro', m(45), { x: 200, y: 700 }, { x: 1250, y: 150 }, 240],
    ['rua alta', m(14), { x: 500, y: 600 }, { x: 900, y: 420 }, 120],
  ] as const;
  for (const [name, half, from, to, count] of cases) {
    it(`${name}: the view follows the hand evenly, never back, the eye never leaping`, () => {
      const c = dragAcross(half, from, to, count);
      const steps = c.slice(1).map((p, i) => ({ dx: p.x - c[i]!.x, dy: p.y - c[i]!.y, dz: p.z - c[i]!.z }));
      const lengths = steps.map((s) => Math.hypot(s.dx, s.dy));
      const median = [...lengths].sort((a, b) => a - b)[lengths.length >> 1]!;
      expect(median).toBeGreaterThan(0);
      let back = 0;
      for (let i = 1; i < steps.length; i++) {
        if (steps[i]!.dx * steps[i - 1]!.dx + steps[i]!.dy * steps[i - 1]!.dy <= 0) back++;
      }
      const worst = {
        step: Math.max(...lengths) / median,
        back,
        leap: Math.max(...steps.map((s) => Math.abs(s.dz))) / median,
      };
      // No step many times the hand's, never back the other way
      expect(worst.back).toBe(0);
      expect(worst.step).toBeLessThan(3);
      expect(worst.leap).toBeLessThan(3);
    });
  }
});
