import { describe, expect, it } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, InstancedBufferAttribute, MeshPhysicalMaterial } from 'three';
import { createPanelJoiner, panelGeometry, panelPaint } from '@render/vehiclePanels';

const joinPanels = createPanelJoiner();

/** A box with a vertex colour, as the vehicles' parts carry one. */
const coloured = (w: number, h: number, d: number, indexed = true): BufferGeometry => {
  const box = new BoxGeometry(w, h, d);
  box.deleteAttribute('uv');
  box.setAttribute('color', new BufferAttribute(new Float32Array(box.getAttribute('position').count * 3).fill(0.5), 3));
  return indexed ? box : box.toNonIndexed();
};

/** Every triangle as its three vertices' positions and colours, in draw order. */
const triangles = (g: BufferGeometry): number[][] => {
  const index = g.getIndex(), position = g.getAttribute('position'), colour = g.getAttribute('color');
  const n = index ? index.count : position.count, out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const v = index ? index.getX(i) : i;
    out.push([position.getX(v), position.getY(v), position.getZ(v), colour.getX(v), colour.getY(v), colour.getZ(v)]);
  }
  return out;
};

describe('vehicle panels', () => {
  it('draws the body triangles, then the panel triangles, with their own numbers', () => {
    const body = coloured(4, 1.4, 1.8), roof = coloured(2, 0.1, 1.6, false);
    const joined = joinPanels(body, roof)!;
    const g = panelGeometry(joined, new InstancedBufferAttribute(new Float32Array(3), 3));
    expect(triangles(g)).toEqual([...triangles(body), ...triangles(roof)]);
    const mark = g.getAttribute('panel'), bodyVertices = body.getAttribute('position').count;
    for (let v = 0; v < mark.count; v++) expect(mark.getX(v)).toBe(v < bodyVertices ? 0 : 1);
  });

  it('shares the joined vertices between levels and gives each mesh its own panel colours', () => {
    const body = coloured(4, 1.4, 1.8), roof = coloured(2, 0.1, 1.6);
    // A coarser level: the same vertices, fewer triangles (`vehicleLevels.ts` shared).
    const coarse = new BufferGeometry();
    for (const name of ['position', 'normal', 'color']) coarse.setAttribute(name, body.getAttribute(name));
    coarse.setIndex(new BufferAttribute(new Uint32Array((body.getIndex()!.array as Uint16Array).slice(0, 12)), 1));
    const fine = joinPanels(body, roof)!, rough = joinPanels(coarse, roof)!;
    expect(joinPanels(body, roof)).toBe(fine);
    expect(rough.attributes.get('position')).toBe(fine.attributes.get('position'));
    expect(rough.index.count).toBe(12 + roof.getIndex()!.count);
    const a = new InstancedBufferAttribute(new Float32Array(3), 3), b = new InstancedBufferAttribute(new Float32Array(3), 3);
    expect(panelGeometry(fine, a).getAttribute('panelColor')).toBe(a);
    expect(panelGeometry(fine, b).getAttribute('panelColor')).toBe(b);
  });

  it('marks a panel left alone at a level as the panel, and joins nothing from nothing', () => {
    const roof = coloured(2, 0.1, 1.6);
    const alone = joinPanels(null, roof)!;
    const mark = alone.attributes.get('panel')!;
    for (let v = 0; v < mark.count; v++) expect(mark.getX(v)).toBe(1);
    expect(joinPanels(null, null)).toBeNull();
    const body = coloured(4, 1.4, 1.8), bare = coloured(2, 0.1, 1.6);
    bare.deleteAttribute('normal');
    expect(joinPanels(body, bare)).toBeNull();
  });

  it('keeps every number of the paint', () => {
    const paint = new MeshPhysicalMaterial({ roughness: 0.38, metalness: 0.28, clearcoat: 1, clearcoatRoughness: 0.07, envMapIntensity: 1.35, vertexColors: true });
    const joined = panelPaint(paint);
    for (const key of ['roughness', 'metalness', 'clearcoat', 'clearcoatRoughness', 'envMapIntensity', 'vertexColors', 'side', 'transparent'] as const) {
      expect(joined[key]).toBe(paint[key]);
    }
    expect(joined.color.getHex()).toBe(paint.color.getHex());
    const shader = { vertexShader: '#include <common>\n#include <color_vertex>', fragmentShader: '', uniforms: {} };
    joined.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain('panel > 0.5 ? panelColor : instanceColor.rgb');
  });
});
