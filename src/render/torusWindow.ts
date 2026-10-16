/** A SQUARE WINDOW OF TEXELS OVER THE UNBOUNDED WORLD, kept in a texture that wraps round (the toroidal update of clipmaps: Tanner, Migdal & Jones, "The Clipmap", SIGGRAPH 1998; Asirvatham & Hoppe, GPU Gems 2 ch. 2): world texel g lives in texel g mod res, so moving the window rewrites only the texels that came in, never the whole texture */

/** A band of world texels, inclusive: columns gx0..gx1, rows gy0..gy1. */
export type TexelBand = readonly [number, number, number, number];

export class TorusWindow {
  /** The world texel of the window's low corner (west, south). */
  ox: number;
  oy: number;

  constructor(readonly res: number, readonly cell: number, cx = 0, cy = 0) {
    this.ox = Math.floor(cx / cell) - res / 2;
    this.oy = Math.floor(cy / cell) - res / 2;
  }

  /** The window's side, world units: the shader reads world / span with the texture repeating. */
  get span(): number {
    return this.res * this.cell;
  }

  /** The texture's column (or row) of world texel `g`. */
  texel(g: number): number {
    return ((g % this.res) + this.res) % this.res;
  }

  /** The texel index (row by row) of a world point, or -1 off the window. */
  indexAt(x: number, y: number): number {
    const gx = Math.floor(x / this.cell), gy = Math.floor(y / this.cell);
    if (gx < this.ox || gy < this.oy || gx >= this.ox + this.res || gy >= this.oy + this.res) return -1;
    return this.texel(gy) * this.res + this.texel(gx);
  }

  /** A world rectangle's texels on the window (null: none of it is on it). */
  bandOf(rect: readonly [number, number, number, number]): TexelBand | null {
    const gx0 = Math.max(this.ox, Math.floor(rect[0] / this.cell)), gx1 = Math.min(this.ox + this.res - 1, Math.floor(rect[2] / this.cell));
    const gy0 = Math.max(this.oy, Math.floor(rect[1] / this.cell)), gy1 = Math.min(this.oy + this.res - 1, Math.floor(rect[3] / this.cell));
    return gx0 > gx1 || gy0 > gy1 ? null : [gx0, gx1, gy0, gy1];
  }

  /** The whole window as a band. */
  get whole(): TexelBand {
    return [this.ox, this.ox + this.res - 1, this.oy, this.oy + this.res - 1];
  }

  /** Centres the window on (x, y) once it strayed more than `hold` texels: the bands of texels that came in (to write), or null when it stays. */
  follow(x: number, y: number, hold: number): TexelBand[] | null {
    const nx = Math.floor(x / this.cell) - this.res / 2, ny = Math.floor(y / this.cell) - this.res / 2;
    const dx = nx - this.ox, dy = ny - this.oy;
    if (Math.abs(dx) <= hold && Math.abs(dy) <= hold) return null;
    this.ox = nx;
    this.oy = ny;
    const res = this.res;
    if (Math.abs(dx) >= res || Math.abs(dy) >= res) return [this.whole];
    const bands: TexelBand[] = [];
    // The columns come in, all the window's rows; then the rows come in, all its columns (their corner twice: written twice alike).
    if (dx > 0) bands.push([nx + res - dx, nx + res - 1, ny, ny + res - 1]);
    else if (dx < 0) bands.push([nx, nx - dx - 1, ny, ny + res - 1]);
    if (dy > 0) bands.push([nx, nx + res - 1, ny + res - dy, ny + res - 1]);
    else if (dy < 0) bands.push([nx, nx + res - 1, ny, ny - dy - 1]);
    return bands;
  }
}
