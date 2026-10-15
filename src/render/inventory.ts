import type { BufferAttribute, BufferGeometry, InstancedMesh, InterleavedBuffer, Material, Mesh, Object3D, Texture } from 'three';

/**
 * THE INVENTORY OF EVERYTHING THE SCENE HOLDS: each layer of the world and each
 * kind of mesh in it, with its meshes, instances, vertices, triangles, the bytes
 * its buffers take on the GPU and the bytes still held by a JavaScript array,
 * its draw calls, materials and textures - and the figures that show where a
 * problem is: bytes a vertex, triangles a draw, the share of the vertices that
 * is skirts or slivers' worth, how much of it is out of the view.
 *
 * Read from the scene itself (`countMemory` in `memoryCounters.ts` counts the
 * totals; this says who holds them), so a layer that grows out of proportion
 * shows in one table: the road surfaces were 1.4 GB of a 2,560 m city's 1.7 GB
 * of geometry, and their curb ramps alone 341 MB, which no total showed
 * (2026-10-15). Pure: no DOM, no renderer.
 */

/** One row: a kind of mesh in a layer. */
export interface InventoryRow {
  /** The layer (the scene's child the mesh hangs under, then its child: `world / road-network`). */
  readonly layer: string;
  /** The kind of mesh, its name without the tile or hash suffix. */
  readonly kind: string;
  readonly meshes: number;
  /** Meshes visible and in the scene, the ones a frame may draw. */
  readonly shown: number;
  /** The instances of the instanced ones (a plain mesh counts one). */
  readonly instances: number;
  /** Vertices of the geometries (shared geometries once). */
  readonly vertices: number;
  /** Triangles drawn when every instance is: indices / 3 times instances. */
  readonly triangles: number;
  /** Bytes of the buffers on the GPU (vertex, index, instance matrices and colours), a shared buffer once. */
  readonly gpuBytes: number;
  /** Of those, the bytes a JavaScript array still holds (`mesh/gpuOnly.ts` lets the rest go). */
  readonly cpuBytes: number;
  readonly materials: number;
  readonly textures: number;
}

/** A figure that says a row is out of proportion. */
export interface InventoryFlag {
  readonly row: InventoryRow;
  readonly what: string;
}

export interface Inventory {
  readonly rows: readonly InventoryRow[];
  readonly flags: readonly InventoryFlag[];
  readonly totals: { meshes: number; vertices: number; triangles: number; gpuBytes: number; cpuBytes: number };
}

type Attribute = BufferAttribute & { readonly isInterleavedBufferAttribute?: boolean; readonly data?: InterleavedBuffer };
type Holder = Object3D & { readonly geometry?: BufferGeometry; readonly material?: Material | Material[]; readonly isMesh?: boolean; readonly isInstancedMesh?: boolean };

/** A name without what tells one tile or one block from another: digits, hashes, `-ground`, `-alignment-12`. */
function kindOf(name: string, fallback: string): string {
  const base = name || fallback;
  return base.replace(/-(ground|alignment-?\d*|bridge|tunnel|viaduct|elevated)\b.*$/, '').replace(/[-_:.]?[0-9a-f]{6,}$/i, '').replace(/[-_:.]\d+$/, '') || fallback;
}

const MB = 1_000_000;

/** The thresholds of the flags: a figure past one is where to look first. */
export const FLAGS = {
  /** A mesh of one layer holding more than this share of the scene's geometry. */
  dominantShare: 0.2,
  /** Bytes a vertex: position, normal, uv, colour and section are 56; more is padding or extra attributes. */
  bytesPerVertex: 70,
  /** Triangles a mesh: one draw this big loses the culling. */
  trianglesPerMesh: 150_000,
  /** Shown meshes with fewer triangles than this each are draw-call bound. */
  tinyMesh: 60,
  /** A kind with this many meshes of that few triangles. */
  tinyCount: 400,
} as const;

/**
 * Counts the scene under `root`: a row per layer and kind of mesh, the flags,
 * the totals. `root` is the scene; the first two levels of the hierarchy name
 * the layer (a child of the scene, then its child when the child is a group).
 */
export function sceneInventory(root: Object3D): Inventory {
  const rows = new Map<string, {
    layer: string; kind: string; meshes: number; shown: number; instances: number; vertices: number; triangles: number;
    gpuBytes: number; cpuBytes: number; materials: Set<Material>; textures: Set<Texture>;
  }>();
  const buffers = new Set<object>();
  const geometries = new Set<BufferGeometry>();

  const walk = (object: Object3D, top: string, second: string, visible: boolean): void => {
    const holder = object as Holder;
    const shown = visible && object.visible;
    if (holder.geometry && (holder.isMesh || (holder as { isLine?: boolean }).isLine || (holder as { isPoints?: boolean }).isPoints)) {
      const g = holder.geometry;
      const layer = second ? `${top} / ${second}` : top;
      const kind = kindOf(object.name, holder.isInstancedMesh ? 'instanced' : object.type);
      const key = `${layer}\u0000${kind}`;
      let row = rows.get(key);
      if (!row) rows.set(key, row = { layer, kind, meshes: 0, shown: 0, instances: 0, vertices: 0, triangles: 0, gpuBytes: 0, cpuBytes: 0, materials: new Set(), textures: new Set() });
      row.meshes++;
      if (shown) row.shown++;
      // A block of road whose own mesh has been given back to the GPU (`mesh/roadResidency.ts`: its far level is drawn)
      // holds no buffer: it is counted as a mesh, its bytes are not.
      const resident = (object.userData.lod as { full?: boolean } | undefined)?.full !== false;
      const instances = holder.isInstancedMesh ? (holder as unknown as InstancedMesh).count : 1;
      row.instances += instances;
      const position = g.getAttribute('position') as Attribute | undefined;
      const vertices = position ? position.count : 0;
      const indices = g.index ? g.index.count : vertices;
      // A geometry shared by several meshes is counted once; the instances multiply what it draws.
      if (!geometries.has(g)) { geometries.add(g); row.vertices += vertices; }
      row.triangles += (indices / 3) * instances;
      const add = (a: Attribute | null | undefined): void => {
        if (!a || !resident) return;
        const owner: { array: (ArrayLike<number> & { byteLength?: number }) | null; count: number; itemSize?: number; stride?: number } =
          a.isInterleavedBufferAttribute && a.data ? a.data as never : a as never;
        if (buffers.has(owner)) return;
        buffers.add(owner);
        const array = owner.array;
        const bytes = array ? array.byteLength ?? array.length * 4 : owner.count * (owner.stride ?? owner.itemSize ?? 1) * 4;
        row!.gpuBytes += bytes;
        if (array) row!.cpuBytes += bytes;
      };
      for (const a of Object.values(g.attributes)) add(a as Attribute);
      add(g.index as Attribute | null);
      if (holder.isInstancedMesh) {
        const im = holder as unknown as InstancedMesh;
        add(im.instanceMatrix as Attribute);
        add(im.instanceColor as Attribute | null);
      }
      for (const material of Array.isArray(holder.material) ? holder.material : holder.material ? [holder.material] : []) {
        row.materials.add(material);
        for (const value of Object.values(material as unknown as Record<string, unknown>)) if ((value as Texture | null)?.isTexture) row.textures.add(value as Texture);
      }
    }
    for (const child of object.children) {
      // The layer is the scene's child; the second level is its child when that is a group (no geometry of its own).
      if (object === root) walk(child, child.name || child.type, '', shown);
      else if (!second && !holder.geometry) walk(child, top, child.name || child.type, shown);
      else walk(child, top, second, shown);
    }
  };
  walk(root, '', '', true);

  const list: InventoryRow[] = [...rows.values()].map((r) => ({
    layer: r.layer, kind: r.kind, meshes: r.meshes, shown: r.shown, instances: r.instances, vertices: r.vertices,
    triangles: Math.round(r.triangles), gpuBytes: r.gpuBytes, cpuBytes: r.cpuBytes, materials: r.materials.size, textures: r.textures.size,
  })).sort((a, b) => b.gpuBytes - a.gpuBytes);

  const totals = { meshes: 0, vertices: 0, triangles: 0, gpuBytes: 0, cpuBytes: 0 };
  for (const r of list) {
    totals.meshes += r.meshes; totals.vertices += r.vertices; totals.triangles += r.triangles; totals.gpuBytes += r.gpuBytes; totals.cpuBytes += r.cpuBytes;
  }

  const flags: InventoryFlag[] = [];
  for (const r of list) {
    if (totals.gpuBytes > 0 && r.gpuBytes / totals.gpuBytes > FLAGS.dominantShare) {
      flags.push({ row: r, what: `${Math.round((100 * r.gpuBytes) / totals.gpuBytes)}% of the scene's geometry (${(r.gpuBytes / MB).toFixed(0)} MB)` });
    }
    if (r.vertices > 0 && r.gpuBytes / r.vertices > FLAGS.bytesPerVertex && r.instances === r.meshes) {
      flags.push({ row: r, what: `${(r.gpuBytes / r.vertices).toFixed(0)} bytes a vertex (a plain surface is ~60)` });
    }
    if (r.meshes > 0 && r.triangles / r.meshes > FLAGS.trianglesPerMesh && r.instances === r.meshes) {
      flags.push({ row: r, what: `${Math.round(r.triangles / r.meshes)} triangles a mesh: one draw too big to cull` });
    }
    if (r.meshes >= FLAGS.tinyCount && r.triangles / r.meshes < FLAGS.tinyMesh) {
      flags.push({ row: r, what: `${r.meshes} meshes of ${Math.round(r.triangles / r.meshes)} triangles: draw calls, not triangles, are the cost` });
    }
    if (r.cpuBytes > 20 * MB) {
      flags.push({ row: r, what: `${(r.cpuBytes / MB).toFixed(0)} MB still held by JavaScript arrays after upload` });
    }
    if (r.shown < r.meshes && r.gpuBytes > 50 * MB) {
      flags.push({ row: r, what: `${r.meshes - r.shown} of ${r.meshes} meshes hidden but holding ${(r.gpuBytes / MB).toFixed(0)} MB on the GPU` });
    }
  }
  return { rows: list, flags, totals };
}

/** The inventory as a table, the `top` largest rows first, then the flags. */
export function formatInventory(inventory: Inventory, top = 40): string {
  const mb = (bytes: number): string => (bytes / MB).toFixed(1).padStart(8);
  const num = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)).padStart(8);
  const lines = [`${'layer / kind'.padEnd(58)} ${'meshes'.padStart(7)} ${'shown'.padStart(6)} ${'instances'.padStart(9)} ${'vertices'.padStart(8)} ${'triangles'.padStart(9)} ${'GPU MB'.padStart(8)} ${'CPU MB'.padStart(8)} mat tex`];
  for (const r of inventory.rows.slice(0, top)) {
    lines.push(`${(`${r.layer} / ${r.kind}`).slice(0, 58).padEnd(58)} ${String(r.meshes).padStart(7)} ${String(r.shown).padStart(6)} ${num(r.instances).padStart(9)} ${num(r.vertices)} ${num(r.triangles).padStart(9)} ${mb(r.gpuBytes)} ${mb(r.cpuBytes)} ${String(r.materials).padStart(3)} ${String(r.textures).padStart(3)}`);
  }
  const t = inventory.totals;
  lines.push(`${'TOTAL'.padEnd(58)} ${String(t.meshes).padStart(7)} ${''.padStart(6)} ${''.padStart(9)} ${num(t.vertices)} ${num(t.triangles).padStart(9)} ${mb(t.gpuBytes)} ${mb(t.cpuBytes)}`);
  if (inventory.flags.length) {
    lines.push('', 'FLAGS');
    for (const f of inventory.flags) lines.push(`  ${f.row.layer} / ${f.row.kind}: ${f.what}`);
  }
  return lines.join('\n');
}

/** Typed shorthand for callers holding a mesh: a mesh's own vertex count. */
export function vertexCount(mesh: Mesh): number {
  return mesh.geometry.getAttribute('position')?.count ?? 0;
}
