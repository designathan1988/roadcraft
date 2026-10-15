import type { Vec2 } from '@core/vec2';
import type { NodeId, SegmentId } from '../ids';
import type { RoadDoc } from '../doc';
import type { Network } from '../network';
import type { LandscapeItem } from '../landscape';
import { roadType } from '../roadTypes';
import { METERS_PER_UNIT, m } from '../units';
import { streetChain } from './streetChain';

/** STREET NAMES AND NUMBERING. */

/** The names new streets are given: the ones every Brazilian town has. */
const NAMES = [
  'Brasil', 'Sete de Setembro', 'Quinze de Novembro', 'Tiradentes', 'Santos Dumont', 'Getúlio Vargas', 'Rui Barbosa',
  'Duque de Caxias', 'Marechal Deodoro', 'Princesa Isabel', 'Dom Pedro II', 'Castro Alves', 'Machado de Assis',
  'José de Alencar', 'Carlos Gomes', 'Barão do Rio Branco', 'Anita Garibaldi', 'Benjamin Constant', 'Floriano Peixoto',
  'das Flores', 'dos Ipês', 'das Palmeiras', 'das Acácias', 'dos Jacarandás', 'das Mangueiras', 'dos Pinheiros',
  'da Paz', 'da Liberdade', 'da Esperança', 'da Independência', 'da República', 'XV de Agosto', 'Primeiro de Maio',
  'São Paulo', 'Minas Gerais', 'Bahia', 'Paraná', 'Pernambuco', 'Goiás', 'Amazonas', 'Ceará', 'Santa Catarina',
  'Cecília Meireles', 'Monteiro Lobato', 'Oscar Niemeyer', 'Tom Jobim', 'Portinari', 'Villa-Lobos', 'Clarice Lispector',
  'do Comércio', 'da Estação', 'do Porto', 'da Matriz', 'do Rosário', 'São João', 'São José', 'Santo Antônio',
] as const;

/** "Avenida" for the wide classes, "Rua" for the rest. */
function prefixFor(type: number): string {
  const id = roadType(type).id;
  return id === 'avenue' || id === 'boulevard' ? 'Avenida' : id === 'highway' || id === 'ramp' ? 'Rodovia' : 'Rua';
}

/** How far from a street its name plate may stand and still name it. */
const NAME_REACH = m(30);

/** DO NOT walk every ribbon for each plate: the names of a city were plates × roads. */
function nameItemSegment(net: Network, item: Vec2): SegmentId | null {
  let best: SegmentId | null = null, bestD = NAME_REACH;
  for (const ribbon of net.ribbonsMeeting([item.x - NAME_REACH, item.y - NAME_REACH, item.x + NAME_REACH, item.y + NAME_REACH])) {
    const d = ribbon.full.distanceTo(item);
    if (d < bestD) { bestD = d; best = ribbon.id; }
  }
  return best;
}

/** The street name plates that may name a road of `chain` (those within reach of one of its ribbons), in id order. */
function platesNear(net: Network, chain: readonly SegmentId[]): LandscapeItem[] {
  const found = new Map<number, LandscapeItem>();
  for (const id of chain) {
    const box = net.ribbons.get(id)?.full.bbox;
    if (!box) continue;
    for (const item of net.doc.landscapeIn([box.minX - NAME_REACH, box.minY - NAME_REACH, box.maxX + NAME_REACH, box.maxY + NAME_REACH])) {
      if (item.kind === 'streetname') found.set(item.id, item);
    }
  }
  return [...found.values()].sort((a, b) => a.id - b.id);
}

/** The name of the street a segment runs in, or null: the first plate (by id) that names one of its roads. */
export function streetNameOf(net: Network, segment: SegmentId): string | null {
  const ids = streetChain(net.doc, segment).map((p) => p.id);
  const chain = new Set(ids);
  for (const item of platesNear(net, ids)) {
    if (!item.text) continue;
    const seg = nameItemSegment(net, item);
    if (seg !== null && chain.has(seg)) return item.text;
  }
  return null;
}

/** Names for the streets of `segments` that have none */
export function nameFor(net: Network, segments: Iterable<SegmentId>): { at: Vec2; text: string }[] {
  const doc = net.doc;
  const used = new Set<string>(doc.streetNamesInUse.keys());
  const named = new Set<SegmentId>();
  const out: { at: Vec2; text: string }[] = [];
  for (const id of [...segments].sort((a, b) => a - b)) {
    if (named.has(id)) continue;
    const seg = doc.segment(id), ribbon = net.ribbons.get(id);
    if (!seg || !ribbon) continue;
    const chain = streetChain(doc, id);
    const ids = chain.map((p) => p.id);
    for (const p of chain) named.add(p.id);
    const members = new Set(ids);
    // A plate already on this street (a name the player kept, or one given before).
    if (platesNear(net, ids).some((item) => { const on = nameItemSegment(net, item); return on !== null && members.has(on); })) continue;
    const prefix = prefixFor(seg.type);
    let k = (id * 2654435761) >>> 0;
    let name = '';
    for (let tries = 0; tries < NAMES.length; tries++, k++) {
      const candidate = `${prefix} ${NAMES[k % NAMES.length]}`;
      if (!used.has(candidate)) { name = candidate; break; }
    }
    if (!name) name = `${prefix} ${NAMES[k % NAMES.length]} ${used.size + 1}`;
    used.add(name);
    out.push({ at: ribbon.full.sampleAt(ribbon.full.length / 2).p, text: name });
  }
  return out;
}

/** A segment's place in its street's numbering: the numbers along it and which side is even. */
export interface StreetNumbers {
  /** Metres from the street's start where the segment begins and ends. */
  readonly from: number;
  readonly to: number;
  /** Even numbers on the segment's own right (a -> b) when true. */
  readonly evenOnRight: boolean;
}

export function streetNumbers(doc: RoadDoc, net: Network, segment: SegmentId, zero: Vec2 = { x: 0, y: 0 }): StreetNumbers | null {
  const chain = streetChain(doc, segment);
  if (!chain.length) return null;
  // The ends of the street: the nodes only one of its segments meets.
  const count = new Map<NodeId, number>();
  for (const p of chain) {
    const s = doc.segment(p.id);
    if (!s) continue;
    for (const n of [s.a, s.b]) count.set(n, (count.get(n) ?? 0) + 1);
  }
  const ends = [...count.entries()].filter(([, c]) => c === 1).map(([n]) => n);
  let start: NodeId | undefined;
  let bestD = Infinity;
  for (const n of ends) {
    const node = doc.node(n);
    if (!node) continue;
    const d = Math.hypot(node.x - zero.x, node.y - zero.y);
    if (d < bestD || (d === bestD && start !== undefined && n < start)) { bestD = d; start = n; }
  }
  if (start === undefined) start = doc.segment(chain[0]!.id)!.a; // a loop: from the first segment
  // Walk from the start, adding up lengths.
  const remaining = new Set(chain.map((p) => p.id));
  let node = start, along = 0;
  for (let guard = 0; guard < chain.length + 1 && remaining.size; guard++) {
    const next = [...remaining].find((id) => { const s = doc.segment(id); return s && (s.a === node || s.b === node); });
    if (next === undefined) break;
    remaining.delete(next);
    const s = doc.segment(next)!;
    const length = net.polylines.get(doc, next).length * METERS_PER_UNIT;
    if (next === segment) return { from: Math.round(along), to: Math.round(along + length), evenOnRight: s.a === node };
    along += length;
    node = s.a === node ? s.b : s.a;
  }
  return null;
}
