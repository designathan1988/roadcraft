import type { NodeId, SegmentId } from '@world/ids';
import { mainRoadLegs, type SignalSettings } from '@world/roads/rules';
import type { SimWorld } from '../world';
import { fixedCycle } from '../signals/fsm';
import { m } from '@world/units';

/**
 * A GREEN WAVE along the main road through a junction (docs/VIAS.md V5): the
 * signals of the road, junction by junction, given one common cycle and each
 * an offset equal to the time a platoon takes to reach it at the road's
 * speed, so the platoon meets green at each in turn (the offset is distance
 * over platoon speed, t = L / S, on a common cycle; Wikipedia, "Green wave").
 * Each signal becomes fixed-time: the cycle is stretched to the longest
 * signal's by lengthening the main road's own stage; the player's bus
 * priority is kept. Returns the settings to give each junction, starting
 * with the one asked about; empty when the road has fewer than two signals.
 */
export function greenWave(w: SimWorld, start: NodeId): Map<NodeId, SignalSettings> {
  const corridor = corridorFrom(w, start);
  const signals = corridor.filter((c) => w.graph.junctions.get(c.node)?.signalised && w.controllers.get(c.node));
  const out = new Map<NodeId, SignalSettings>();
  if (signals.length < 2) return out;
  // Each signal's main stage: the one that lets the corridor's through movement go.
  const plans = signals.map((c) => {
    const ctl = w.controllers.get(c.node)!;
    const conn = [...w.graph.connectors.values()].find((x) => x.node === c.node && x.inSegment === c.from && x.outSegment === c.to);
    const main = Math.max(0, ctl.plan.stages.findIndex((s) => conn !== undefined && s.greenGroups.includes(conn.group)));
    return { ...c, ctl, main, cycle: fixedCycle(ctl.plan, undefined) };
  });
  const cycle = Math.max(...plans.map((p) => p.cycle));
  for (const p of plans) {
    const greens = p.ctl.plan.stages.map((s) => Math.round(s.targetGreen));
    greens[p.main] = Math.round((greens[p.main] ?? 0) + (cycle - p.cycle));
    let mainStart = 0;
    for (let i = 0; i < p.main; i++) {
      const s = p.ctl.plan.stages[i]!;
      mainStart += greens[i]! + s.amber + s.allRed;
    }
    const offset = Math.round(((p.travel - mainStart) % cycle + cycle) % cycle);
    const before = w.doc.node(p.node)?.signal;
    out.set(p.node, { mode: 'fixed', greens, ...(offset > 0 ? { offset } : {}), ...(before?.busPriority ? { busPriority: true as const } : {}) });
  }
  return out;
}

interface CorridorStop {
  readonly node: NodeId;
  /** The leg the platoon arrives on, and the one it leaves by. */
  readonly from: SegmentId;
  readonly to: SegmentId;
  /** Seconds from the first junction, at each road's speed. */
  readonly travel: number;
}

/**
 * The junctions along the main road through `start`, in the direction of
 * its higher leg, up to a dozen: from each the road goes on along the leg
 * the junction's main road pairs with the one it arrived on.
 */
function corridorFrom(w: SimWorld, start: NodeId): CorridorStop[] {
  const main = mainRoadLegs(w.doc, start);
  if (!main) return [];
  const out: CorridorStop[] = [];
  // Back to the first junction behind `start`, then forward from there.
  const walk = (node: NodeId, leaving: SegmentId, limit: number): { node: NodeId; via: SegmentId }[] => {
    const path: { node: NodeId; via: SegmentId }[] = [];
    let at = node, seg = leaving;
    for (let i = 0; i < limit; i++) {
      const s = w.doc.segment(seg);
      if (!s) break;
      const next = s.a === at ? s.b : s.a;
      path.push({ node: next, via: seg });
      const legs = mainRoadLegs(w.doc, next);
      const on = legs?.find((l) => l !== seg);
      if (!legs || !legs.includes(seg) || on === undefined) break;
      at = next;
      seg = on;
    }
    return path;
  };
  const behind = walk(start, main[0], 12);
  const first = behind.length ? behind[behind.length - 1]! : null;
  const origin = first?.node ?? start;
  const originLeg = first ? (mainRoadLegs(w.doc, origin)?.find((l) => l !== first.via) ?? first.via) : main[1];
  const ahead = walk(origin, originLeg, 12);
  const otherLeg = (node: NodeId, leg: SegmentId): SegmentId | undefined => mainRoadLegs(w.doc, node)?.find((l) => l !== leg);
  const originFrom = otherLeg(origin, originLeg);
  if (originFrom !== undefined) out.push({ node: origin, from: originFrom, to: originLeg, travel: 0 });
  let travel = 0;
  for (let k = 0; k < ahead.length; k++) {
    const here = ahead[k]!;
    const ribbon = w.net.ribbons.get(here.via);
    travel += (ribbon?.full.length ?? 0) / Math.max(m(0.4), ribbon?.road.speedLimit ?? m(5.6));
    const leaving = ahead[k + 1]?.via ?? otherLeg(here.node, here.via);
    if (leaving === undefined) break;
    out.push({ node: here.node, from: here.via, to: leaving, travel });
  }
  return out;
}
