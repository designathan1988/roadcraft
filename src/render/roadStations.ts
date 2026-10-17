import type { SegmentId } from '@world/ids';
import type { StationHint } from '@world/elevation';
import { platesOver } from '@world/bounds';
import { canQueueJobs, submitJob, type JobTicket } from '../jobs/jobPool';
import { type SharedGroundData, groundOver } from './sharedGround';
import type { RoadStationsJob, RoadStationsReply } from './roadStations.worker';

/** THE GROUND UNDER THE ROADS A SOLVE WILL READ, ASKED OF THE JOB SYSTEM (`roadStations.worker.ts`): the page's solve (`renderer.ts` buildWorld) waits for it instead of reading every new road's ground in the frame a tile is put in */

/** Fewer roads than this are read on the page (an edit's few): a job's round trip would cost more than their reads. */
const OFF_PAGE_FROM = 24;

/** A road's ground as read, with the plates its box read (each as the share held it: a plate made or let go since is read again) and the terrain's revision then (a stamp since: read again). */
interface Hint extends StationHint {
  readonly plates: readonly (readonly [number, SharedArrayBuffer | undefined])[];
  readonly terrain: number;
}

const sameXY = (x: Float64Array, y: Float64Array): boolean => {
  if (x === y) return true;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};

/** The plates a road's casing reads, with the buffer the share holds for each now. */
function platesUnder(xy: Float64Array, half: number, ground: SharedGroundData): [number, SharedArrayBuffer | undefined][] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < xy.length; i += 2) { x0 = Math.min(x0, xy[i]!); x1 = Math.max(x1, xy[i]!); y0 = Math.min(y0, xy[i + 1]!); y1 = Math.max(y1, xy[i + 1]!); }
  return platesOver([x0 - half, y0 - half, x1 + half, y1 + half]).map((k) => [k, ground.plates.get(k)]);
}

/** The box round every road asked, each by its casing's half. */
function roadsBox(roads: readonly { readonly xy: Float64Array; readonly half: number }[]): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { xy, half } of roads) {
    for (let i = 0; i < xy.length; i += 2) {
      box[0] = Math.min(box[0], xy[i]! - half); box[1] = Math.min(box[1], xy[i + 1]! - half);
      box[2] = Math.max(box[2], xy[i]! + half); box[3] = Math.max(box[3], xy[i + 1]! + half);
    }
  }
  return box;
}

export class RoadStations {
  private readonly hints = new Map<SegmentId, Hint>();
  private asked: JobTicket | null = null;
  /** The job system failed it once: read on the page from then on. */
  private off = false;

  /** `landed`: a frame asked for once an answer is in (the solve runs again then). */
  constructor(private readonly landed: () => void) {}

  /** Whether the solve must wait for the ground under `roads` (each read off the page unless its hint stands); asked now if not yet. False: solve now, with `hints`. */
  waiting(roads: readonly { readonly id: SegmentId; readonly xy: Float64Array; readonly half: number }[], ground: SharedGroundData | null, terrain: number): boolean {
    if (this.off || !ground || !canQueueJobs()) return false;
    const stands = (h: Hint): boolean => h.terrain === terrain && h.plates.every(([k, b]) => ground.plates.get(k) === b);
    const missing = roads.filter((r) => { const h = this.hints.get(r.id); return !(h && h.half === r.half && sameXY(h.xy, r.xy) && stands(h)); });
    if (missing.length < OFF_PAGE_FROM) return false;
    // One at a time: what is still missing when it lands is asked then.
    if (this.asked?.pending) return true;
    const asked = missing.map((r) => ({ id: r.id, xy: r.xy, half: r.half, plates: platesUnder(r.xy, r.half, ground) }));
    this.asked = submitJob({
      service: 'roadStations',
      key: 'roadStations',
      // Before every other job: the world's build waits on it.
      priority: -1,
      // The plates under the roads asked only (`groundOver`): each one's casing on them.
      write: () => ({ data: { ground: groundOver(ground, roadsBox(asked)), roads: asked.map(({ id, xy, half }) => ({ id, xy, half })) } satisfies RoadStationsJob, transfer: [] }),
      done: (answer) => {
        const byId = new Map(asked.map((r) => [r.id, r]));
        for (const r of (answer as RoadStationsReply).roads) {
          const a = byId.get(r.id as SegmentId);
          if (a) this.hints.set(a.id, { xy: a.xy, half: a.half, ceil: Array.from(r.ceil), base: Array.from(r.base), plates: a.plates, terrain });
        }
        this.landed();
      },
      failed: (message) => {
        console.warn('[roads] the ground under the roads is read on the page', message);
        this.off = true;
        this.landed();
      },
    });
    return true;
  }

  /** The hints for the solve (`buildRoadElevation` checks each road's line and casing again). */
  get current(): ReadonlyMap<SegmentId, StationHint> {
    return this.hints;
  }

  /** After a solve: what it read is in the solve now (kept there for the next, `stationsFrom`). */
  used(): void {
    this.hints.clear();
  }
}
