import { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { TUNED_UNIT } from '@world/units';

/** The 0.4 m unit this map was laid out in: lengths below in it, times U. */
const U = TUNED_UNIT;

/** THE INSPECTION MAP: every situation a vehicle or a pedestrian has to sit right on, in one document */
export interface InspectionMap {
  readonly doc: RoadDoc;
  readonly segments: Readonly<Record<'slope' | 'crossfall' | 'bridge' | 'elevated' | 'tunnel' | 'acuteA' | 'acuteB' | 'cross' | 'city', SegmentId>>;
  readonly nodes: Readonly<Record<'signal' | 'acute' | 'city', NodeId>>;
}

export function buildInspectionMap(doc = new RoadDoc()): InspectionMap {
  const road = (a: { x: number; y: number }, b: { x: number; y: number }, type: number): { id: SegmentId; a: NodeId; b: NodeId } => {
    const na = doc.addNode(a);
    const nb = doc.addNode(b);
    const seg = doc.addSegment(na.id, nb.id, type);
    if (!seg) throw new Error('inspection map: segment refused');
    return { id: seg.id, a: na.id, b: nb.id };
  };

  // ---- slope: a hill centred on x = -500, a street straight over it.
  const west = doc.addNode({ x: -1300 * U, y: 0 });
  const signal = doc.addNode({ x: -1000 * U, y: 0 });
  const east = doc.addNode({ x: 100 * U, y: 0 });
  const slopeA = doc.addSegment(west.id, signal.id, 2);
  const slope = doc.addSegment(signal.id, east.id, 2);
  const north = doc.addNode({ x: -1000 * U, y: -300 * U });
  const south = doc.addNode({ x: -1000 * U, y: 300 * U });
  const cross = doc.addSegment(north.id, signal.id, 2);
  doc.addSegment(signal.id, south.id, 2);
  if (!slopeA || !slope || !cross) throw new Error('inspection map: slope refused');
  doc.setNodeControl(signal.id, 'signal');
  for (let i = 0; i < 7; i++) {
    doc.addTerrainStamp({ x: (-760 + i * 70) * U, y: 0, radius: 240 * U, strength: 9 * U, mode: 'raise' });
  }

  // ---- crossfall: a street along a hillside at y = 700.
  const crossfall = road({ x: -1300 * U, y: 700 * U }, { x: -200 * U, y: 700 * U }, 2);
  for (let i = 0; i < 8; i++) {
    doc.addTerrainStamp({ x: (-1250 + i * 140) * U, y: 860 * U, radius: 230 * U, strength: 10 * U, mode: 'raise' });
  }

  // ---- bridge over a river at x = 800.
  const bridge = road({ x: 500 * U, y: 0 }, { x: 1100 * U, y: 0 }, 2);
  doc.setSegmentStructure(bridge.id, 'bridge');
  for (let i = 0; i < 9; i++) {
    doc.addTerrainStamp({ x: 800 * U, y: (-400 + i * 100) * U, radius: 70 * U, strength: 8 * U, mode: 'river' });
  }

  // ---- elevated road at y = -700, joining at grade at both ends.
  const eWest = doc.addNode({ x: 300 * U, y: -700 * U });
  const eA = doc.addNode({ x: 500 * U, y: -700 * U });
  const eB = doc.addNode({ x: 1100 * U, y: -700 * U });
  const eEast = doc.addNode({ x: 1300 * U, y: -700 * U });
  doc.addSegment(eWest.id, eA.id, 2);
  const elevated = doc.addSegment(eA.id, eB.id, 2);
  doc.addSegment(eB.id, eEast.id, 2);
  if (!elevated) throw new Error('inspection map: elevated refused');
  doc.setSegmentStructure(elevated.id, 'elevated');

  // ---- tunnel at y = 700, east side.
  const tunnel = road({ x: 200 * U, y: 700 * U }, { x: 1400 * U, y: 700 * U }, 2);
  doc.setSegmentStructure(tunnel.id, 'tunnel');
  for (let i = 0; i < 6; i++) {
    doc.addTerrainStamp({ x: (670 + i * 52) * U, y: 700 * U, radius: 260 * U, strength: 22 * U, mode: 'raise' });
  }

  // ---- acute junction at (-500, -800).
  const acute = doc.addNode({ x: -500 * U, y: -800 * U });
  const farA = doc.addNode({ x: 100 * U, y: -800 * U });
  const angle = (32 * Math.PI) / 180;
  const farB = doc.addNode({ x: (-500 + Math.cos(angle) * 600) * U, y: (-800 - Math.sin(angle) * 600) * U });
  const farC = doc.addNode({ x: -1100 * U, y: -800 * U });
  const acuteA = doc.addSegment(acute.id, farA.id, 2);
  const acuteB = doc.addSegment(acute.id, farB.id, 2);
  doc.addSegment(farC.id, acute.id, 2);
  if (!acuteA || !acuteB) throw new Error('inspection map: acute refused');

  // ---- city: a grid of avenues and streets north of everything else, every inner junction signalised
  const grid: NodeId[][] = [];
  const COLS = 5;
  const ROWS = 4;
  for (let r = 0; r < ROWS; r++) {
    const row: NodeId[] = [];
    for (let c = 0; c < COLS; c++) row.push(doc.addNode({ x: (-600 + c * 220) * U, y: (1500 + r * 200) * U }).id);
    grid.push(row);
  }
  let cityStreet: SegmentId | undefined;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (c + 1 < COLS) {
        const s = doc.addSegment(grid[r]![c]!, grid[r]![c + 1]!, r === 1 ? 3 : 2);
        if (s && r === 1 && c === 1) cityStreet = s.id;
      }
      if (r + 1 < ROWS) doc.addSegment(grid[r]![c]!, grid[r + 1]![c]!, c === 2 ? 3 : 2);
    }
  }
  for (let r = 1; r < ROWS - 1; r++) for (let c = 1; c < COLS - 1; c++) doc.setNodeControl(grid[r]![c]!, 'signal');
  if (cityStreet === undefined) throw new Error('inspection map: city refused');

  return {
    doc,
    segments: { slope: slope.id, crossfall: crossfall.id, bridge: bridge.id, elevated: elevated.id, tunnel: tunnel.id,
      acuteA: acuteA.id, acuteB: acuteB.id, cross: cross.id, city: cityStreet },
    nodes: { signal: signal.id, acute: acute.id, city: grid[1]![2]! },
  };
}
