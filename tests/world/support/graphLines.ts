import { Digest } from '@core/digest';
import type { LaneletGraph } from '@world/lanelets';
import type { ConflictIndex } from '@world/conflictPoints';

/** The lane graph as sorted lines (`laneletUpdate.spec.ts`, `turnPlan.spec.ts`): every lanelet's points, every connector, exit, lane in and out, junction. */
export function graphLines(graph: LaneletGraph): string[] {
  const out: string[] = [];
  for (const l of graph.lanelets.values()) {
    const d = new Digest().addText(l.kind).addAll(l.centre.xy).add(l.length).add(l.speedLimit).add(l.controlled ? 1 : 0);
    out.push(`lanelet ${l.id} ${l.segment ?? '-'} ${l.node ?? '-'} ${d.value()}`);
  }
  for (const c of graph.connectors.values()) out.push(`connector ${c.id} ${c.node} ${c.fromLane} ${c.toLane} ${c.turn} ${c.carried} ${c.group} ${c.maxBodyClass}`);
  for (const [id, exits] of graph.exits) if (exits.length) out.push(`exits ${id} ${[...exits].sort().join(',')}`);
  for (const [node, lanes] of graph.inbound) if (lanes.length) out.push(`in ${node} ${[...lanes].sort().join(',')}`);
  for (const [node, lanes] of graph.outbound) if (lanes.length) out.push(`out ${node} ${[...lanes].sort().join(',')}`);
  for (const [node, j] of graph.junctions) {
    out.push(`junction ${node} ${j.signalised} ${j.control} ${[...j.connectors].sort().join(',')} ${j.groups.map((g) => `${g.id}:${[...g.segments].sort().join('/')}`).join(' ')}`);
  }
  return out.sort();
}

/** The conflicts as lines, without their ids (kept stable across builds, not across indexes). */
export function conflictLines(conflicts: ConflictIndex): string[] {
  const out: string[] = [];
  for (const point of conflicts.points) if (point) out.push(`point ${point.node} ${point.a} ${point.b} ${point.kind} ${point.sA} ${point.sB} ${point.at.x} ${point.at.y}`);
  for (const [id, refs] of conflicts.byConnector) out.push(`refs ${id} ${refs.map((r) => `${r.other}:${r.kind}:${r.s}`).join(',')}`);
  for (const [id, list] of conflicts.diverges) out.push(`diverges ${id} ${list.map((d) => d.other).sort().join(',')}`);
  for (const q of conflicts.queueIntrusions) out.push(`intrusion ${q.a} ${q.b} ${q.mine} ${q.theirs}`);
  return out;
}
