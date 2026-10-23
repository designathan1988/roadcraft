import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial } from 'three';
import { Rng } from '@core/rng';
import { BLUEPRINTS, instantiate, type BlueprintBody } from '@world/buildings/blueprints';
import { CITY_BUILDINGS } from '@world/buildings/cityBuildings';
import { madeToMeasure } from '@world/buildings/procedural';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { createBuildingKit } from '../../render/buildings/kit';
import { buildBuildingMeshes, setShellTap } from '../../render/buildings/buildingMesh';
import type { ItemSpec } from './items';

/** THE BUILDING SHELL PIECE BY PIECE: every face the building builder lays (`buildingMesh.ts` Shell.face) told to the catalogue with the function that laid
 *  it (the bays, the plinths, each roof, the cornices and bands, the terraces, the roof plant, the lanterns, the clocks, the lot's parts, stairs, fences,
 *  parking...), for every building the engine's generators make; each piece its own object, its faces exactly as laid (corners, normal, paint). */

type Add = (spec: ItemSpec) => void;

/** The functions of `buildingMesh.ts` that lay faces, and what each lays. */
const MAKERS: Readonly<Record<string, string>> = {
  emitBay: 'facade bay (wall round an opening, reveals, sill, head)', emitFacadeRuns: 'facade run (bays laid as one, far level)', emitPlinth: 'plinth',
  emitRecessedFlight: 'recessed entrance flight', emitRelief: 'facade relief', emitRoofPlant: 'roof plant', emitTerrace: 'roof terrace', emitLots: 'lot',
  emitLot: 'lot ground and foundation', emitClock: 'clock', emitElement: 'lot element', layElement: 'lot element', emitOpenStair: 'open stair', emitStairRails: 'stair rails',
  emitTurnedStair: 'turned stair', emitRailLine: 'rail line', emitFence: 'fence', emitFlowers: 'flower bed', emitRocks: 'rocks', emitParking: 'parking',
  emitLotPart: 'lot part', postAt: 'post', band: 'storey band', flushBand: 'flush storey band', emitCornice: 'cornice', emitRoofDetails: 'roof details',
  emitFlag: 'flag', emitLantern: 'lantern', emitPolygonRoof: 'roof (polygon plan)', emitRoof: 'roof', emitStreak: 'streak under a sill', emitPorchLight: 'porch light',
  emitInterior: 'interior (cut open)', placeFurniture: 'furniture', emitBuilding: 'building body (walls, slabs)', emitChunk: 'building chunk',
};
const MAKER = new RegExp(`at (?:[A-Za-z_$.]*\\.)?(${Object.keys(MAKERS).join('|')}) `);

interface Piece { readonly maker: string; readonly site: string; readonly positions: number[]; readonly normals: number[]; readonly colours: number[]; triangles: number; readonly finishes: Set<string> }

/** The function that laid the face being laid, and the line it was called from: the first of `MAKERS` up the stack. */
function makerOf(): { maker: string; site: string } {
  const lines = (new Error().stack ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const hit = MAKER.exec(lines[i]!);
    if (hit) return { maker: hit[1]!, site: `${lines[i]!.trim()}|${(lines[i + 1] ?? '').trim()}` };
  }
  return { maker: 'emitBuilding', site: 'unknown' };
}

/** The pieces one building's shell is laid as: the faces of one call of one function, in order. */
function piecesOf(b: Building, kit: ReturnType<typeof createBuildingKit>): Piece[] {
  const pieces: Piece[] = [];
  let current: Piece | null = null;
  setShellTap((points, n, c) => {
    const { maker, site } = makerOf();
    if (!current || current.site !== site) { current = { maker, site, positions: [], normals: [], colours: [], triangles: 0, finishes: new Set() }; pieces.push(current); }
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    // Three's axes, as the shell writes them: (x, z, -y).
    const nx = n[0] / length, ny = n[2] / length, nz = -n[1] / length;
    for (let k = 1; k + 1 < points.length; k++) {
      for (const p of [points[0]!, points[k]!, points[k + 1]!]) {
        current.positions.push(p[0], p[2], -p[1]);
        current.normals.push(nx, ny, nz);
        current.colours.push(c.rgb[0], c.rgb[1], c.rgb[2]);
      }
      current.triangles++;
    }
    current.finishes.add(c.finish);
  });
  try { buildBuildingMeshes([b], () => 0, kit); } finally { setShellTap(null); }
  return pieces;
}

/** Every shell piece of every building the generators make, each piece a row: the same piece (same maker, triangles and size) listed once, with the buildings it is in. */
export function shellPieceItems(add: Add): void {
  const kit = createBuildingKit(16);
  const bodies: { name: string; body: BlueprintBody; key?: string }[] = [
    ...BLUEPRINTS.map((bp) => ({ name: `preset ${bp.key}`, body: bp.body, key: bp.key })),
    ...CITY_BUILDINGS.map((cb) => ({ name: `function ${cb.fn}`, body: cb.body })),
  ];
  for (const use of ['residential', 'commercial', 'industrial'] as const) {
    for (const density of ['low', 'medium', 'high'] as const) {
      for (const [size, W, D] of [['small', m(12), m(16)], ['medium', m(24), m(26)], ['large', m(40), m(36)]] as const) {
        bodies.push({ name: `${use} ${density} ${size} lot`, body: madeToMeasure(use, density, { W, D }, new Rng(1)).body });
      }
    }
  }
  const seen = new Map<string, string[]>();
  let id = 1;
  for (const { name, body, key } of bodies) {
    const b = { ...instantiate(body, { x: 0, y: 0 }, 0, key), id: id++ as BuildingId } as Building;
    for (const piece of piecesOf(b, kit)) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(piece.positions), 3));
      g.setAttribute('normal', new BufferAttribute(new Float32Array(piece.normals), 3));
      g.setAttribute('color', new BufferAttribute(new Float32Array(piece.colours), 3));
      g.computeBoundingBox();
      const box = g.boundingBox!;
      const size = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z].map((v) => v.toFixed(2)).join(' x ');
      const shape = `${piece.maker}|${piece.triangles}|${size}`;
      const where = seen.get(shape);
      if (where) { where.push(name); continue; }
      seen.set(shape, [name]);
      const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
      const mesh = new Mesh(g, material);
      mesh.name = piece.maker;
      add({
        group: 'Buildings: shell pieces', name: MAKERS[piece.maker] ?? piece.maker, variation: `${piece.maker}, ${piece.triangles} triangles, ${size} m, from ${name}`,
        origin: 'kit', source: `src/render/buildings/buildingMesh.ts (${piece.maker})`, build: 'merged', pieces: [{ label: piece.maker, geometry: g, material }], object: mesh,
        notes: [`finishes: ${[...piece.finishes].join(', ')}`, 'faces exactly as the shell lays them (Shell.face), not welded: the engine welds equal vertices, so its vertex count is lower'],
      });
    }
  }
}
