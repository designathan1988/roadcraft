import { PAINT_ATTRIBUTE, PAINT_UNIT, WEAR_STEPS } from '@render/buildings/cellArrays';
import { describe, expect, it } from 'vitest';
import type { Mesh, Object3D } from 'three';

import { beginFrameWork } from '@core/frameWork';
import { createBuildingLayer } from '@render/buildings/layer';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building, BuildingId } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/** The buildings layer takes a change of some buildings by their ids in the diary (`townIndex.ts`, AUDITORIA A1) */
const SPACING = m(70);
const flat = (): number => 0;

function body(index: number, x: number, y: number): Omit<Building, 'id'> {
  const bp = BLUEPRINTS[index % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), x, y, rotation: 0 } as Omit<Building, 'id'>;
}

/** Updates until nothing is pending; true when any update put something together again. */
function settle(layer: ReturnType<typeof createBuildingLayer>, doc: RoadDoc): boolean {
  let rebuilt = false;
  for (let frame = 0; frame < 5000; frame++) {
    beginFrameWork();
    if (layer.update(doc, flat, 'g')) rebuilt = true;
    if (!layer.pending) return rebuilt;
  }
  throw new Error('the layer never settled');
}

/** What a layer draws: its triangles, and each far cell's mesh by its vertices. */
function drawn(layer: ReturnType<typeof createBuildingLayer>): { triangles: number; far: number[] } {
  const far: number[] = [];
  layer.group.traverse((o: Object3D) => {
    if (o.parent?.name === 'buildings-far' && (o as Mesh).isMesh) far.push((o as Mesh).geometry.getAttribute('position').count);
  });
  return { triangles: layer.triangles, far: far.sort((a, b) => a - b) };
}

describe('the buildings layer, a change at a time', () => {
  /** Twelve rounds of edits played on a live layer; from round `from` on, each round's drawing compared with a layer put together from nothing (the cost of the test: split in two so each half stays within its time). */
  const rounds = (from: number, to: number): void => {
    let seed = 11;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const doc = new RoadDoc();
    const side = 6;
    for (let i = 0; i < side * side; i++) doc.buildings.add(body(i, (i % side) * SPACING, Math.floor(i / side) * SPACING));
    const live = createBuildingLayer();
    settle(live, doc);
    let incremental = 0;
    for (let round = 0; round < to; round++) {
      // A cell emptied whole, and a building taken to a cell where none stood.
      if (round === 4) for (const b of [...doc.buildings.all()]) if (b.x < m(240) && b.y < m(240)) doc.buildings.remove(b.id);
      if (round === 7) doc.buildings.add(body(3, side * SPACING + m(500), m(10)));
      // A few edits between two frames, as a tool or the growth makes them.
      for (let k = 0, n = round === 4 || round === 7 ? 0 : 1 + Math.floor(rand() * 3); k < n; k++) {
        const ids = [...doc.buildings.all()].map((b) => b.id);
        const pick = ids[Math.floor(rand() * ids.length)]! as BuildingId;
        const roll = rand();
        if (roll < 0.3) doc.buildings.add(body(Math.floor(rand() * 100), rand() * side * SPACING, rand() * side * SPACING));
        else if (roll < 0.5) doc.buildings.remove(pick);
        else if (roll < 0.75) {
          // Moved: across a cell's edge or within it.
          const b = doc.buildings.get(pick)!;
          doc.buildings.put({ ...b, x: b.x + (rand() - 0.5) * m(300), y: b.y + (rand() - 0.5) * m(60) });
        } else {
          const b = doc.buildings.get(pick)!;
          doc.buildings.put({ ...b, palette: (b.palette + 1) % 8 });
        }
      }
      // A change overtaking one still being put together: the cells of both are swapped.
      if (round === 9) {
        beginFrameWork();
        live.update(doc, flat, 'g');
        const b = doc.buildings.get([...doc.buildings.all()][0]!.id)!;
        doc.buildings.put({ ...b, x: b.x + m(250) });
      }
      // Taken in by the ids alone: the town is not walked.
      const all = doc.buildings.all.bind(doc.buildings);
      let walked = 0;
      doc.buildings.all = () => { walked++; return all(); };
      const rebuilt = settle(live, doc);
      doc.buildings.all = all;
      if (rebuilt && walked === 0) incremental++;
      if (round < from) continue;
      const fresh = createBuildingLayer();
      settle(fresh, doc);
      expect(drawn(live)).toEqual(drawn(fresh));
      for (let i = 0; i < 300; i++) {
        const x = rand() * side * SPACING, y = rand() * side * SPACING;
        expect(live.covers(x, y)).toBe(fresh.covers(x, y));
      }
      fresh.dispose();
    }
    expect(incremental).toBe(to);
    live.dispose();
  };

  it('draws what a layer put together from nothing draws (rounds 1 to 6)', () => rounds(0, 6));
  it('draws what a layer put together from nothing draws (rounds 7 to 12)', () => rounds(6, 12));

  it("draws a building's new wear, by its id, without walking the town", () => {
    const doc = new RoadDoc();
    for (let i = 0; i < 9; i++) doc.buildings.add(body(i, (i % 3) * SPACING, Math.floor(i / 3) * SPACING));
    const live = createBuildingLayer();
    settle(live, doc);
    const worn = (): number => {
      let most = 0;
      live.group.traverse((o: Object3D) => {
        // A shell's wear in its paint's fourth short, over its finish id (`cellArrays.ts` `finishWear`); a part's in its looks.
        const paint = (o as Mesh).isMesh ? (o as Mesh).geometry.getAttribute(PAINT_ATTRIBUTE) : undefined;
        if (paint) for (let i = 0; i < paint.count; i++) most = Math.max(most, (Math.round(paint.getW(i) * PAINT_UNIT) >> 8) / WEAR_STEPS);
        const decay = (o as Mesh).isMesh ? (o as Mesh).geometry.getAttribute('aDecay') : undefined;
        if (decay) for (let i = 0; i < decay.count; i++) most = Math.max(most, decay.getX(i));
      });
      return most;
    };
    expect(worn()).toBeLessThan(0.9);
    const shape = doc.buildings.revision;
    doc.buildings.wear([...doc.buildings.all()][4]!.id, 0.9);
    expect(doc.buildings.revision).toBe(shape);
    const all = doc.buildings.all.bind(doc.buildings);
    let walked = 0;
    doc.buildings.all = () => { walked++; return all(); };
    const rebuilt = settle(live, doc);
    doc.buildings.all = all;
    expect(rebuilt).toBe(true);
    expect(walked).toBe(0);
    // A byte's step on the GPU (`cellArrays.ts` `finishWear`): 0.9 reads back within 1/510.
    expect(worn()).toBeCloseTo(0.9, 2);
    live.dispose();
  });
});

describe('a tile handed to the cells', () => {
  it('is not said drawn before the town was put together from the document as it stood when the tile came in', () => {
    const doc = new RoadDoc();
    const layer = createBuildingLayer();
    settle(layer, doc);
    // The tile comes in, its roads and its buildings (`RoadDoc.loadTile`): the town has not taken them in yet, no cell of it exists.
    doc.addNode({ x: m(50), y: m(50) });
    for (let i = 0; i < 4; i++) doc.buildings.add(body(i, m(100) + i * SPACING, m(100)));
    const came = doc.revision;
    const rect = [0, 0, m(1024), m(1024)] as const;
    // No cell over it yet: "every cell drawn" held for none.
    expect(layer.drawnOver(rect)).toBe(true);
    expect(layer.drawnOver(rect, came)).toBe(false);
    settle(layer, doc);
    // Put together: its cells say for it, the tile's revision no longer holds it back.
    expect(layer.drawnOver(rect, came)).toBe(layer.drawnOver(rect));
  });
});


describe('the far sun cascades', () => {
  it('take the cells in detail by their masses only, never leave one without a caster, and every caster is back as it was after the passes', () => {
    const doc = new RoadDoc();
    for (let i = 0; i < 9; i++) doc.buildings.add(body(i, (i % 3) * SPACING, Math.floor(i / 3) * SPACING));
    const layer = createBuildingLayer();
    // An eye low over the town: its cells near and in detail, their masses come too.
    for (let frame = 0; frame < 400; frame++) {
      beginFrameWork();
      layer.update(doc, flat, 'g');
      layer.levelOfDetail(SPACING, SPACING, m(40), 1000, null);
      if (!layer.pending && frame > 20) break;
    }
    /** What casts now: every mesh shown (it and every parent) that casts, by its parents' names and its own. */
    const casters = (): string[] => {
      const out: string[] = [];
      const walk = (o: Object3D, path: string): void => {
        if (!o.visible) return;
        const mesh = o as Mesh;
        if (mesh.isMesh && mesh.castShadow) out.push(`${path}/${o.name}#${o.id}`);
        for (const child of o.children) walk(child, `${path}/${o.name}`);
      };
      walk(layer.group, '');
      return out.sort();
    };
    const near = casters();
    // In detail: the cells' batches cast in the near cascade, their masses hidden.
    expect(near.some((c) => c.includes('/buildings/buildings/'))).toBe(true);
    expect(near.some((c) => c.includes('building-massing'))).toBe(false);
    layer.castInto(m(1), true);
    const far = casters();
    // A far cascade: the masses stand in, the detail left out, fewer objects and none of the town without a caster.
    expect(far.some((c) => c.includes('/buildings/buildings/'))).toBe(false);
    expect(far.some((c) => c.includes('building-massing'))).toBe(true);
    expect(far.length).toBeLessThan(near.length);
    layer.castInto(m(1), true);
    expect(casters()).toEqual(far);
    layer.castInto(null);
    expect(casters()).toEqual(near);
    layer.dispose();
  });
});

describe('the ground under the buildings, followed', () => {
  it('samples no building\'s ground again while nothing changes, nor when the ground changed elsewhere: what moved is asked once a key', () => {
    const doc = new RoadDoc();
    for (let i = 0; i < 9; i++) doc.buildings.add(body(i, (i % 3) * SPACING, Math.floor(i / 3) * SPACING));
    const layer = createBuildingLayer();
    let sampled = 0;
    const ground = (): number => { sampled++; return flat(); };
    let asked = 0;
    const movedUnder = (): readonly never[] => { asked++; return []; };
    for (let frame = 0; frame < 400; frame++) {
      beginFrameWork();
      layer.update(doc, ground, 'g', undefined, ground, movedUnder);
      layer.levelOfDetail(SPACING, SPACING, m(40), 1000, null);
      if (!layer.pending && frame > 20) break;
    }
    // Nothing changes: no digest made again, frame after frame.
    sampled = 0;
    for (let frame = 0; frame < 30; frame++) {
      beginFrameWork();
      layer.update(doc, ground, 'g', undefined, ground, movedUnder);
      layer.levelOfDetail(SPACING, SPACING, m(40), 1000, null);
    }
    expect(sampled).toBe(0);
    // The ground changed where no building stands: every digest kept, what moved asked once for the key the buildings were sampled at.
    asked = 0;
    for (let frame = 0; frame < 30; frame++) {
      beginFrameWork();
      layer.update(doc, ground, 'g2', undefined, ground, movedUnder);
      layer.levelOfDetail(SPACING, SPACING, m(40), 1000, null);
    }
    expect(sampled).toBe(0);
    expect(asked).toBeLessThanOrEqual(2);
    layer.dispose();
  });
});

describe('a cell waiting for its level', () => {
  it('keeps its entries while its records, ground and cut-open view stay, made again only when one changes', async () => {
    const { readFileSync } = await import('node:fs');
    const layer = readFileSync('src/render/buildings/layer.ts', 'utf8');
    const land = layer.slice(layer.indexOf('const landCells'), layer.indexOf('const landCells') + 3000);
    expect(land).toMatch(/const entries = entriesFor\(cell, list, groundAt, groundKey, pavedAt\)/);
    const keep = layer.slice(layer.indexOf('const entriesFor'), layer.indexOf('const entriesFor') + 600);
    expect(keep).toMatch(/known\.groundKey === groundKey && known\.cutaway === cutaway && known\.list\.length === list\.length && known\.list\.every/);
  });
});

describe('the cells the budget of triangles held back', () => {
  /** Nine cells round an eye over the middle one, each a building of its own. */
  const town = (middle: number): RoadDoc => {
    const doc = new RoadDoc();
    for (let i = 0; i < 9; i++) doc.buildings.add(body(i === 4 ? middle : i, (i % 3) * m(256) + m(128), Math.floor(i / 3) * m(256) + m(128)));
    return doc;
  };
  /** Frames as the renderer draws them on demand: stopped at the first with nothing pending; how many ran. */
  const frames = (layer: ReturnType<typeof createBuildingLayer>, doc: RoadDoc, least = 1): number => {
    for (let frame = 0; frame < 2000; frame++) {
      beginFrameWork();
      layer.update(doc, flat, 'g');
      layer.levelOfDetail(m(384), m(384), m(300), 1000, null);
      layer.cullDetails(m(384), m(384), m(300), 1000, null, m(1));
      if (!layer.pending && frame >= least) return frame;
    }
    throw new Error('the layer never settled');
  };
  /** The meshes shown in detail and of masses. */
  const shown = (layer: ReturnType<typeof createBuildingLayer>): { detail: number; masses: number } => {
    let detail = 0, masses = 0;
    const walk = (o: Object3D, path: string): void => {
      if (!o.visible) return;
      if ((o as Mesh).isMesh) {
        if (path.includes('/buildings/buildings')) detail++;
        if (`${path}/${o.name}`.includes('massing')) masses++;
      }
      for (const child of o.children) walk(child, `${path}/${o.name}`);
    };
    walk(layer.group, '');
    return { detail, masses };
  };

  it('come back, still view, once a lighter level landed leaves room for them', () => {
    const doc = town(4);
    const layer = createBuildingLayer();
    layer.frame.budget = 58_000;
    frames(layer, doc);
    // The heavy middle building: the cells spanning least held back in their masses.
    expect(shown(layer).masses).toBeGreaterThan(0);
    const middle = [...doc.buildings.all()][4]!;
    doc.buildings.put({ ...middle, ...body(20, middle.x, middle.y), id: middle.id } as Building);
    frames(layer, doc);
    expect(shown(layer).masses).toBe(0);
    expect(layer.triangles).toBeLessThanOrEqual(58_000);
    layer.dispose();
  });

  it('ask no frame while none of them fits and nothing is measured anew', () => {
    const doc = town(4);
    const layer = createBuildingLayer();
    layer.frame.budget = 40_000;
    const ran = frames(layer, doc);
    expect(ran).toBeLessThan(20);
    const held = shown(layer);
    expect(held.masses).toBeGreaterThan(0);
    // Further frames of the same still view: nothing to wait for, nothing changes.
    for (let frame = 0; frame < 5; frame++) {
      beginFrameWork();
      layer.update(doc, flat, 'g');
      layer.levelOfDetail(m(384), m(384), m(300), 1000, null);
      layer.cullDetails(m(384), m(384), m(300), 1000, null, m(1));
      expect(layer.pending).toBe(false);
    }
    expect(shown(layer)).toEqual(held);
    layer.dispose();
  });
});

describe('what the layer keeps while the camera walks the town', () => {
  /** A row of the same building, one a cell, along 23 tiles; the active region the three tiles round the eye; the eye walked a tile at a time. */
  const walk = (tiles: number): Record<string, number> => {
    const doc = new RoadDoc();
    const CELL = m(256), TILE = m(1024);
    for (let i = 0; i < 23 * 4; i++) doc.buildings.add(body(0, i * CELL + CELL / 2, CELL / 2));
    const layer = createBuildingLayer();
    // A budget the view passes: cells held back by it (`capTriangles`).
    layer.frame.budget = 40_000;
    let region: [number, number] | null = null;
    for (let step = 0; step <= tiles; step++) {
      const eyeX = TILE * 1.5 + step * TILE;
      const lo = eyeX - TILE * 1.5, hi = eyeX + TILE * 1.5;
      const rects: [number, number, number, number][] = [[Math.min(lo, region?.[0] ?? lo), -TILE, Math.max(hi, region?.[1] ?? hi), TILE]];
      region = [lo, hi];
      layer.setActive((x) => x >= lo && x < hi, rects);
      for (let frame = 0; frame < 600; frame++) {
        beginFrameWork();
        layer.update(doc, flat, 'g');
        layer.levelOfDetail(eyeX, CELL / 2, m(60), 1000, null);
        layer.cullDetails(eyeX, CELL / 2, m(60), 1000, null, m(1));
        if (!layer.pending && frame > 2) break;
      }
    }
    const books = { ...layer.books() };
    layer.dispose();
    return books;
  };

  it('keeps as much after 20 tiles walked as after 2: its books bounded by the active region, never by the road walked', () => {
    const near = walk(2), far = walk(20);
    // The masses' books and the cells held back (`massCells.ts`, `capTriangles`): the same, region for region.
    for (const book of ['massCells', 'massTiles', 'massPlates', 'massEntries', 'massAsked', 'townCells', 'heldFar', 'heldCoarse']) {
      expect([book, far[book]]).toEqual([book, near[book]]);
    }
    // The levels measured (`LandedMeasure`): the town's cells' only, two levels a cell at most, whatever was walked (DO NOT keep every cell passed).
    for (const book of ['landedTriangles', 'landedBytes']) {
      for (const books of [near, far]) expect(books[book]!).toBeLessThanOrEqual(2 * books['townCells']!);
    }
  });
});
