import type { WebGLRenderer } from 'three';
import type { LabContext } from '../labTypes';
import { shortHash } from './probe';

/** THE PROGRAMS THE RENDERER HOLDS (`renderer.info.programs`, three r186 `WebGLPrograms.programs`: one per cache key, `usedTimes` the materials using it, let go at 0): every new one told with when and what came just before it - a count that keeps growing is a leak or a recompile. */

export interface ProgramRow {
  readonly id: number;
  readonly name: string;
  readonly key: string;
  usedTimes: number;
  readonly firstSeen: number;
  /** What happened just before it was first seen (the last lab event, the pass being drawn). */
  readonly trigger: string;
  alive: boolean;
}

export interface ProgramTracker {
  readonly rows: readonly ProgramRow[];
  /** The count over time (t, live programs). */
  readonly counts: readonly (readonly [number, number])[];
  readonly made: number;
  readonly released: number;
  check(): void;
  dispose(): void;
}

interface Program { readonly id: number; readonly name: string; readonly cacheKey: string; readonly usedTimes: number }

const POLL_MS = 500;
const COUNTS_KEPT = 1200;
/** An event counts as the trigger when this recent. */
const TRIGGER_MS = 3000;

export function createProgramTracker(ctx: LabContext, renderer: WebGLRenderer, pass: () => string | null): ProgramTracker {
  const byId = new Map<number, ProgramRow>();
  const rows: ProgramRow[] = [];
  const counts: [number, number][] = [];
  let first = true;
  const tracker = {
    rows,
    counts,
    made: 0,
    released: 0,
    check(): void {
      const list = (renderer.info.programs ?? []) as unknown as readonly Program[];
      const now = performance.now();
      const live = new Set<number>();
      for (const p of list) {
        live.add(p.id);
        const known = byId.get(p.id);
        if (known) { known.usedTimes = p.usedTimes; known.alive = true; continue; }
        const events = ctx.events();
        const last = events[events.length - 1];
        const trigger = first ? 'already there at opening' : [last && now - last.t < TRIGGER_MS ? `${last.kind}: ${last.detail}` : '', pass() ? `pass ${pass()}` : ''].filter(Boolean).join(' · ') || '—';
        const row: ProgramRow = { id: p.id, name: p.name || '(unnamed material)', key: shortHash(p.cacheKey), usedTimes: p.usedTimes, firstSeen: now, trigger, alive: true };
        byId.set(p.id, row);
        rows.push(row);
        if (!first) {
          tracker.made++;
          ctx.emit('gpu.program', `new program: ${row.name} #${p.id} (${list.length} alive)`, { id: p.id, name: p.name || '(unnamed material)', key: row.key, trigger, live: list.length });
        }
      }
      for (const row of rows) {
        if (row.alive && !live.has(row.id)) { row.alive = false; tracker.released++; }
      }
      const lastCount = counts[counts.length - 1];
      if (!lastCount || lastCount[1] !== list.length) counts.push([now, list.length]);
      if (counts.length > COUNTS_KEPT) counts.splice(0, counts.length - COUNTS_KEPT);
      first = false;
    },
    dispose(): void {
      window.clearInterval(timer);
    },
  };
  const timer = window.setInterval(() => tracker.check(), POLL_MS);
  tracker.check();
  return tracker;
}
