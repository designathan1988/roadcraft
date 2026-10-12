import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import { cloudUnder, drawnCloudHeight, driftedCloud, undriftedCloud } from '@world/clouds';
import { onChartOf } from '@world/planet/charts';
import { UNITS_PER_METER } from '@world/units';

/** What the cloud tool reads of the game and does to it. */
export interface CloudToolHost {
  readonly doc: RoadDoc;
  /** 'add', 'move', 'edit' or 'remove' (`ui/toolChoices.ts` `cloudMode`). */
  mode(): string;
  /** The tool's size and height in metres, density 0..100. */
  brush(): { readonly size: number; readonly height: number; readonly density: number };
  /** How far the wind has carried the clouds (`SceneHandle.cloudDrift`). */
  drift(): Vec2;
  /** Where the ray under screen point (px, py) meets the plane at `height`, on the map. */
  rayAt(px: number, py: number, height: number): Vec2;
  /** The document as it is, kept for undo. */
  record(): void;
  /** After a change: the undo buttons, the autosave, a frame. */
  changed(): void;
  hint(key: string): void;
}

/**
 * THE CLOUD TOOL (Landscape > Terrain > Clouds): a click puts a cloud in the
 * sky right under the pointer, a drag moves one, a click sets one to the
 * tool's size, height and density or takes it away (`world/clouds.ts`). A
 * cloud is picked where the pointer's ray crosses its body - the ray cast
 * from the camera through the pointer, as a raycaster picks - and where the
 * wind has carried it, so it is picked where it is seen. Each click is one
 * undo step; the drag in progress lives here.
 */
export class CloudTool {
  private drag: { pointer: number; id: number; dx: number; dy: number } | null = null;

  constructor(private readonly host: CloudToolHost) {}

  get pointer(): number | null {
    return this.drag?.pointer ?? null;
  }

  gesture(): string | null {
    return this.drag ? 'nuvem: arrastando' : null;
  }

  down(pointer: number, px: number, py: number): void {
    const { host } = this;
    const { doc } = host;
    const mode = host.mode();
    const brush = host.brush();
    const size = brush.size * UNITS_PER_METER;
    const height = brush.height * UNITS_PER_METER;
    const drift = host.drift();
    const seen = doc.clouds.map((c) => ({ ...c, ...driftedCloud(c, drift) }));
    const picked = cloudUnder(seen, (h) => host.rayAt(px, py, h));
    if (mode === 'add') {
      // Under the pointer at the height it is drawn at (`drawnCloudHeight`).
      const at = host.rayAt(px, py, drawnCloudHeight(height) + size * 0.3);
      host.record();
      // Kept where it is put: the wind's drift taken off.
      const kept = undriftedCloud(at, drift);
      const cloud = doc.addCloud({ x: kept.x, y: kept.y, height, size, density: brush.density / 100, yaw: ((at.x * 0.013 + at.y * 0.007) % 1) * Math.PI * 2 });
      if (!cloud) host.hint('hint.cloud.full');
      host.changed();
      return;
    }
    if (!picked) return;
    host.record();
    if (mode === 'remove') doc.removeCloud(picked.id);
    else if (mode === 'edit') doc.updateCloud(picked.id, { size, height, density: brush.density / 100 });
    else {
      // The grip on the cloud as seen, on its chart (on the planet the pointer's
      // point can be written on the next piece's).
      const at = onChartOf(host.rayAt(px, py, drawnCloudHeight(picked.height) + picked.size * 0.3), picked);
      this.drag = { pointer, id: picked.id, dx: picked.x - at.x, dy: picked.y - at.y };
    }
    host.changed();
  }

  /** The pointer moved to (px, py): the cloud being dragged follows it. */
  move(px: number, py: number): void {
    const { host } = this;
    const drag = this.drag;
    const cloud = drag ? host.doc.clouds.find((c) => c.id === drag.id) : undefined;
    if (!drag || !cloud) return;
    const at = host.rayAt(px, py, drawnCloudHeight(cloud.height) + cloud.size * 0.3);
    const kept = undriftedCloud({ x: at.x + drag.dx, y: at.y + drag.dy }, host.drift());
    host.doc.updateCloud(cloud.id, { x: kept.x, y: kept.y });
    host.changed();
  }

  up(pointer: number): void {
    if (this.drag?.pointer === pointer) this.drag = null;
  }

  cancel(): void {
    this.drag = null;
  }
}
