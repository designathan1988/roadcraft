import type { Vec2 } from '@core/vec2';
import { GRID } from '@world/buildings/geometry';
import { m } from '@world/units';

/** DO NOT grow a second layer of gizmos here */
export function drawBuilderGrid(ctx: CanvasRenderingContext2D, project: (x: number, y: number, z: number) => Vec2, centre: Vec2, z: number): void {
  const radius = m(24);
  const reach = m(60);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = 1;
  // Two paths, one stroke each (the major lines and the minor): DO NOT stroke each line apart, ~127 strokes a frame.
  for (const major of [false, true]) {
    ctx.strokeStyle = major ? 'rgba(85,230,206,0.22)' : 'rgba(85,230,206,0.1)';
    ctx.beginPath();
    for (let v = -reach; v <= reach; v += GRID) {
      const isMajor = Math.abs(Math.round(v / (GRID * 5))) * GRID * 5 === Math.abs(v);
      if (isMajor !== major || (!isMajor && Math.abs(v) > radius)) continue;
      const a = project(centre.x + v, centre.y - reach, z);
      const b = project(centre.x + v, centre.y + reach, z);
      const c = project(centre.x - reach, centre.y + v, z);
      const d = project(centre.x + reach, centre.y + v, z);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}
