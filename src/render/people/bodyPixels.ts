/** A procedural class's body baked from its shape basis (`crowdBodies.ts`): on the page or in the bake worker (`citizenBake.worker.ts`) */

/** A body's every vertex move from its shape coefficients `c`: the shape basis summed (`stride` texels, RGBA, as the bodies texture holds them). */
export function bodyPixels(shapePixels: Float32Array, vertexCount: number, shapes: number, c: Float32Array, stride: number): Float32Array {
  const pixels = new Float32Array(stride * 4);
  for (let v = 0; v < vertexCount; v++) {
    let x = 0, y = 0, z = 0;
    const base = v * shapes * 4;
    for (let k = 0; k < shapes; k++) {
      const w = c[k] ?? 0;
      if (w === 0) continue;
      const t = base + k * 4;
      x += w * shapePixels[t]!; y += w * shapePixels[t + 1]!; z += w * shapePixels[t + 2]!;
    }
    const o = v * 4;
    pixels[o] = x; pixels[o + 1] = y; pixels[o + 2] = z;
  }
  return pixels;
}
