import type { Vector3, Vector4 } from 'three';

/** Below this (world units) two inputs of the clouds' shadow map are the same: far under a float32 step of the shader's own coordinates. */
const SAME = 1e-6;

/**
 * What the clouds' shadow map (`CLOUD_SHADOW_MAP_MAIN` in postprocess.ts) was last drawn from, so it is drawn
 * again only when what it shows would change. The map holds the cloud lying over each point of its rectangle
 * (`uShadowRect`) and depends on the clouds (`uCloud`, `uPuff`, `uLife`, `uBase`, `uShow`, `uCloudCount`), the sun
 * (`uSunDir`), the rectangle and its plane (`uShadowPlane`) alone: no time, no noise. The clouds' x and z are kept
 * from the rectangle's low corner, as the shader reads them through it: the wind carrying every cloud and the
 * rectangle with them leaves the map as it was.
 */
export class CloudShadowStamp {
  private held = new Float64Array(0);
  private next = new Float64Array(0);
  private valid = false;

  /** Whether the map drawn from these would differ from the one held; when it would, these become the held. */
  changed(count: number, puffsPerCloud: number, bounds: readonly Vector4[], puffs: readonly Vector4[], lives: readonly number[],
    bases: readonly number[], shows: readonly number[], sun: Vector3, rect: Vector4, plane: number): boolean {
    const length = 7 + count * (7 + puffsPerCloud * 4);
    if (this.next.length < length) this.next = new Float64Array(length);
    const v = this.next;
    const x0 = rect.x, z0 = rect.y;
    let i = 0;
    v[i++] = count; v[i++] = plane; v[i++] = sun.x; v[i++] = sun.y; v[i++] = sun.z; v[i++] = rect.z - x0; v[i++] = rect.w - z0;
    for (let c = 0; c < count; c++) {
      const s = bounds[c]!;
      v[i++] = s.x - x0; v[i++] = s.y; v[i++] = s.z - z0; v[i++] = s.w;
      v[i++] = lives[c]!; v[i++] = bases[c]!; v[i++] = shows[c]!;
      for (let k = 0; k < puffsPerCloud; k++) {
        const p = puffs[c * puffsPerCloud + k]!;
        v[i++] = p.x - x0; v[i++] = p.y; v[i++] = p.z - z0; v[i++] = p.w;
      }
    }
    if (this.valid && this.held.length === length) {
      let same = true;
      for (let j = 0; j < length; j++) {
        if (Math.abs(v[j]! - this.held[j]!) > SAME) { same = false; break; }
      }
      if (same) return false;
    }
    if (this.held.length !== length) this.held = new Float64Array(length);
    this.held.set(v.subarray(0, length));
    this.valid = true;
    return true;
  }

  /** The map no longer holds what was drawn (its target lost or made again): the next call draws. */
  invalidate(): void {
    this.valid = false;
  }
}
