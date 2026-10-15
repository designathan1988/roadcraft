import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { MAX_ITEM_RADIUS, footwayAt, landscapeNearIn, snapLandscape, type LandscapeItem, type LandscapeKind, type LandscapeSnap } from '@world/landscape';
import type { SignType } from '@world/landscape';
import { m } from '@world/units';
import { signApproach } from '@world/roads/derivedSigns';
import { FURNITURE_CATALOG } from '@world/roads/furnitureCatalog';
import { Level, halfWidth } from '@world/roadTypes';
import { ribbonsNear } from './snap';

/** What the landscaping tool reads of the game and does to it. */
export interface StreetscapeToolHost {
  readonly doc: RoadDoc;
  readonly net: Network;
  zoom(): number;
  /** The item chosen in the tool (`ui/toolChoices.ts`). */
  kind(): LandscapeKind;
  /** What the chosen item carries: a sign's type and text, a street name, a planting date. */
  extra(kind: LandscapeKind): { signType?: SignType; text?: string; planted?: number };
  /** An edit of the document, one undo step. */
  mutate(fn: () => boolean): void;
  hint(key: string): void;
  redraw(): void;
}

/** THE LANDSCAPING TOOL: benches, bins, street lights, trees, signs... placed on the footways */
export class StreetscapeTool {
  /** Where the chosen item would go under the pointer: a ring, red where it cannot. */
  hover: LandscapeSnap | null = null;
  /** A row being dragged out from the item just placed (placement in line) */
  row: { readonly kind: LandscapeKind; readonly from: LandscapeSnap; pieces: LandscapeSnap[] } | null = null;

  constructor(private readonly host: StreetscapeToolHost) {}

  /** Pick radius for a placed item and the reach of the footway snap, world units. */
  reach(): number {
    return Math.max(m(1.5), 26 / this.host.zoom());
  }

  /** @perInput Runs once an input on one thing (a press, a release, a click): nothing it reaches may walk the map. */
  down(world: Vec2, shift: boolean): void {
    const { host } = this;
    const { doc } = host;
    if (shift) {
      const hit = landscapeNearIn(doc, world, this.reach());
      if (hit) {
        host.mutate(() => doc.removeLandscape(hit.id));
        host.hint('hint.streetscape.removed');
      }
      return;
    }
    const kind = host.kind();
    const placed = snapLandscape(host.net, itemsAround(host, world, this.reach()), kind, world, this.reach());
    // A stop or give-way plate at a junction's approach IS that leg's rule
    const signType = kind === 'sign' ? host.extra(kind).signType : undefined;
    const approach = placed.ok && placed.hit && (signType === 'stop' || signType === 'yield')
      ? signApproach(host.net, placed.at, placed.hit.segment) : null;
    if (approach && (signType === 'stop' || signType === 'yield')) {
      host.mutate(() => {
        const node = doc.node(approach.node);
        if (!node) return false;
        if (node.control !== 'priority') doc.setNodeControl(node.id, 'priority');
        const rules = (doc.node(node.id)?.approachRules ?? []).filter((e) => e.segment !== approach.segment);
        doc.setNodeApproachRules(node.id, [...rules, { segment: approach.segment, rule: signType }]);
        return true;
      });
      host.hint(`hint.streetscape.rule.${signType}`);
      this.hover = null;
      host.redraw();
      return;
    }
    if (placed.ok) {
      host.mutate(() => {
        doc.addLandscape(kind, placed.at, host.extra(kind));
        return true;
      });
      if (ROW_SPACING[kind] !== undefined && placed.hit) this.row = { kind, from: placed, pieces: [] };
    } else {
      host.hint(`hint.streetscape.${placed.reason}`);
    }
    this.hover = null;
    host.redraw();
  }

  /** @perInput `pressed`: the button still down, dragging a row out from the item just placed. */
  move(world: Vec2, pressed = false): void {
    const { host } = this;
    if (this.row && pressed) {
      this.row.pieces = rowPieces(host, this.row.kind, this.row.from, world, this.reach());
      this.hover = null;
    } else {
      if (this.row && !pressed) this.row = null;
      this.hover = snapLandscape(host.net, itemsAround(host, world, this.reach()), host.kind(), world, this.reach());
    }
    host.redraw();
  }

  /** The button let go: the row dragged out is laid, one undo step. */
  up(): void {
    const row = this.row;
    this.row = null;
    if (!row?.pieces.length) return;
    const { host } = this;
    host.mutate(() => {
      for (const piece of row.pieces) host.doc.addLandscape(row.kind, piece.at, host.extra(row.kind));
      return true;
    });
    host.hint('hint.streetscape.row');
    host.redraw();
  }
}

/** The spacing a row of each kind is laid at: the catalogue's (`world/roads/furnitureCatalog.ts`). */
const ROW_SPACING: Partial<Record<LandscapeKind, number>> = Object.fromEntries(FURNITURE_CATALOG.map((e) => [e.kind, e.rowEvery]));

/** The pieces after `from` along its footway, toward the pointer, each where the tool would accept it. */
function rowPieces(host: StreetscapeToolHost, kind: LandscapeKind, from: LandscapeSnap, world: Vec2, reach: number): LandscapeSnap[] {
  const start = from.ok ? from.hit : null;
  const spacing = ROW_SPACING[kind];
  if (!start || spacing === undefined) return [];
  const hit = footwayAt(host.net, world, reach);
  if (!hit || hit.segment !== start.segment || hit.side !== start.side) return [];
  const line = host.net.ribbons.get(start.segment)?.full;
  if (!line) return [];
  const dir = Math.sign(hit.s - start.s);
  // The row's own pieces so far: each next one keeps clear of them too.
  const laid: LandscapeItem[] = [];
  const out: LandscapeSnap[] = [];
  for (let k = 1; k <= 200 && dir !== 0; k++) {
    const s = start.s + dir * spacing * k;
    if ((s - hit.s) * dir > 0 || s < 0 || s > line.length) break;
    const f = line.sampleAt(s);
    const at = { x: f.p.x + f.n.x * start.across * start.side, y: f.p.y + f.n.y * start.across * start.side };
    const snap = snapLandscape(host.net, [...itemsAround(host, at, m(0.6)), ...laid], kind, at, m(0.6));
    if (!snap.ok || snap.hit?.segment !== start.segment) continue;
    out.push(snap);
    laid.push({ id: -k, kind, x: snap.at.x, y: snap.at.y });
  }
  return out;
}

/** DO NOT hand it `doc.landscape.values()` */
function itemsAround(host: StreetscapeToolHost, at: Vec2, reach: number): LandscapeItem[] {
  let widest = 0;
  for (const ribbon of ribbonsNear(host.net, [at.x - reach, at.y - reach, at.x + reach, at.y + reach])) {
    widest = Math.max(widest, halfWidth(ribbon.road, Level.Casing));
  }
  const r = reach + 2 * widest + 2 * MAX_ITEM_RADIUS + MEADOW_CLEAR;
  return host.doc.landscapeIn([at.x - r, at.y - r, at.x + r, at.y + r]);
}

/** How far a meadow keeps from another (`snapLandscape`), and more than any gap between two items. */
const MEADOW_CLEAR = m(2.5);
