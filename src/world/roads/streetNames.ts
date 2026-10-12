import type { Vec2 } from '@core/vec2';
import type { NodeId, SegmentId } from '../ids';
import type { RoadDoc } from '../doc';
import type { Network } from '../network';
import { roadType } from '../roadTypes';
import { METERS_PER_UNIT, m } from '../units';
import { streetChain } from './streetChain';

/**
 * STREET NAMES AND NUMBERING (docs/VIAS.md V8).
 *
 * A street's name is the `streetname` item placed on it (the landscaping
 * tool's, drawn as plates at its corners, `render/signs.ts`); a new street is
 * given one (`nameFor`), the player renames or removes it as any item.
 *
 * Numbering is the metric numbering most Brazilian cities use: a building's
 * number is its distance in metres from the start of the street, even on the
 * right and odd on the left going away from the start; the start is the end
 * nearer the city's zero mark ("marco zero", here the map's centre).
 */

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

/** The street a name item belongs to: the segment nearest it, within reach, and its chain. */
function nameItemSegment(net: Network, item: Vec2): SegmentId | null {
  let best: SegmentId | null = null, bestD = m(30);
  for (const ribbon of net.ribbons.values()) {
    const d = ribbon.full.distanceTo(item);
    if (d < bestD) { bestD = d; best = ribbon.id; }
  }
  return best;
}

/** The name of the street a segment runs in, or null. */
export function streetNameOf(net: Network, segment: SegmentId): string | null {
  const chain = new Set(streetChain(net.doc, segment).map((p) => p.id));
  for (const item of net.doc.landscape.values()) {
    if (item.kind !== 'streetname' || !item.text) continue;
    const seg = nameItemSegment(net, item);
    if (seg !== null && chain.has(seg)) return item.text;
  }
  return null;
}

/**
 * Names for the streets of `segments` that have none: one `streetname` item
 * per street, on its first segment's middle, a name no street of the map
 * already has while any is left. Deterministic.
 */
export function nameFor(net: Network, segments: Iterable<SegmentId>): { at: Vec2; text: string }[] {
  const doc = net.doc;
  const used = new Set<string>();
  for (const item of doc.landscape.values()) if (item.kind === 'streetname' && item.text) used.add(item.text);
  const named = new Set<SegmentId>();
  for (const item of doc.landscape.values()) {
    if (item.kind !== 'streetname') continue;
    const seg = nameItemSegment(net, item);
    if (seg !== null) for (const p of streetChain(doc, seg)) named.add(p.id);
  }
  const out: { at: Vec2; text: string }[] = [];
  for (const id of [...segments].sort((a, b) => a - b)) {
    if (named.has(id)) continue;
    const seg = doc.segment(id), ribbon = net.ribbons.get(id);
    if (!seg || !ribbon) continue;
    const chain = streetChain(doc, id);
    for (const p of chain) named.add(p.id);
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
