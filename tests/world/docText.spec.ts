import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';

/**
 * The undo and the autosave keep the document as text (`RoadDoc.toText`), with
 * each building's text written once per record; writing every building again
 * was most of the text taken on each road drawn (docs/performance.md #21). It
 * must be the very text `JSON.stringify(toJSON())` writes.
 */
describe('the document as text', () => {
  it('is JSON.stringify(toJSON()) for the default town, before and after edits', () => {
    const doc = new RoadDoc();
    buildDefaultTown(doc);
    expect(doc.buildings.size).toBeGreaterThan(10);
    expect(doc.toText()).toBe(JSON.stringify(doc.toJSON()));
    // Twice: the second reads the kept texts.
    expect(doc.toText()).toBe(JSON.stringify(doc.toJSON()));

    const first = [...doc.buildings.all()][0]!;
    doc.buildings.put({ ...first, x: first.x + 3 });
    doc.buildings.remove([...doc.buildings.all()][1]!.id);
    const node = [...doc.nodes.values()][0]!;
    doc.addSegment(node.id, doc.addNode({ x: node.x + 40, y: node.y + 30 }).id, 2);
    expect(doc.toText()).toBe(JSON.stringify(doc.toJSON()));

    const clone = doc.clone();
    expect(clone.toText()).toBe(doc.toText());
    const loaded = RoadDoc.fromJSON(JSON.parse(doc.toText()), { repair: false });
    expect(loaded.toText()).toBe(JSON.stringify(loaded.toJSON()));
  });

  it('is JSON.stringify(toJSON()) without buildings', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: 0 });
    doc.addSegment(a.id, doc.addNode({ x: 80, y: 10 }).id, 2);
    expect(doc.toText()).toBe(JSON.stringify(doc.toJSON()));
  });
});
