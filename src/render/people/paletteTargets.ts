import { FloatType, NearestFilter, RGBAFormat, WebGLRenderTarget } from 'three';

/** THE PEOPLE'S BONE PALETTES IN COMMON TARGETS: every palette pass of the same width (`crowdAnimation.ts`) draws its rows into a page shared with the others, at its own rows */
/** DO NOT give each body class or cooked body a float target of its own: one target bound for them all, a range of rows each (its `base` added by the skinning). */

/** Rows of a page: what every WebGL2 device holds (MAX_TEXTURE_SIZE is at least 2048). A pass wanting more has a page of its own. */
const PAGE_ROWS = 2048;

interface Page {
  readonly width: number;
  target: WebGLRenderTarget;
  /** Rows the target has (grown by doubling, up to `PAGE_ROWS`, or more for a page of one pass). */
  height: number;
  readonly slabs: Slab[];
}

/** One pass's rows in a page: [base, base + rows). */
export interface Slab {
  page: Page;
  base: number;
  rows: number;
}

const pages: Page[] = [];

function makeTarget(width: number, rows: number): WebGLRenderTarget {
  return new WebGLRenderTarget(width, rows, {
    type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
}

/** The first rows of `page` with room for `rows` between its slabs (sorted by base), or its end; -1 past what a page holds. */
function roomIn(page: Page, rows: number): number {
  let at = 0;
  for (const slab of page.slabs) {
    if (slab.base - at >= rows) return at;
    at = slab.base + slab.rows;
  }
  return at + rows <= PAGE_ROWS ? at : -1;
}

/** The page's target tall enough for its slabs: a new one, twice the height (its rows are drawn again by every pass the frame they are read). */
function fit(page: Page): void {
  const end = page.slabs.reduce((top, slab) => Math.max(top, slab.base + slab.rows), 0);
  if (end <= page.height) return;
  let height = Math.max(1, page.height);
  while (height < end) height *= 2;
  height = end <= PAGE_ROWS ? Math.min(height, PAGE_ROWS) : end;
  page.target.dispose();
  page.target = makeTarget(page.width, height);
  page.height = height;
}

/** Rows for a pass `width` texels across: in a page of that width with room, or a new page. */
export function takeSlab(width: number, rows: number): Slab {
  for (const page of pages) {
    if (page.width !== width) continue;
    const at = roomIn(page, rows);
    if (at < 0) continue;
    const slab: Slab = { page, base: at, rows };
    page.slabs.push(slab);
    page.slabs.sort((a, b) => a.base - b.base);
    fit(page);
    return slab;
  }
  const page: Page = { width, target: makeTarget(width, rows), height: rows, slabs: [] };
  pages.push(page);
  const slab: Slab = { page, base: 0, rows };
  page.slabs.push(slab);
  return slab;
}

/** The pass's rows given back; an empty page's target let go. */
export function freeSlab(slab: Slab): void {
  const page = slab.page;
  const at = page.slabs.indexOf(slab);
  if (at >= 0) page.slabs.splice(at, 1);
  if (page.slabs.length > 0) return;
  page.target.dispose();
  pages.splice(pages.indexOf(page), 1);
}

/** Room for `rows` rows: grown in place where the rows after it are free, moved elsewhere otherwise (its `page` and `base` then change). */
export function growSlab(slab: Slab, rows: number): void {
  if (rows <= slab.rows) return;
  const page = slab.page;
  const next = page.slabs[page.slabs.indexOf(slab) + 1];
  const limit = next ? next.base : PAGE_ROWS;
  if (slab.base + rows <= limit) {
    slab.rows = rows;
    fit(page);
    return;
  }
  freeSlab(slab);
  const moved = takeSlab(page.width, rows);
  // The same slab object: whoever holds it reads its new place.
  const into = moved.page.slabs.indexOf(moved);
  moved.page.slabs[into] = slab;
  slab.page = moved.page;
  slab.base = moved.base;
  slab.rows = rows;
}
