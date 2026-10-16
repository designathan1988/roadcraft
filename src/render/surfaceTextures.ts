import type { CompressedTexture, Texture } from 'three';

/** The surfaces baked at build time (`bake/catalogue.ts`), by name, as `surfaceBakeClient.ts` read them: every material takes its maps from here */

export interface SurfaceBake {
  readonly map: Texture;
  readonly normalMap: Texture;
  readonly roughnessMap: Texture;
}

/** Every mip level's texels, or none once let go. */
function hasTexels(texture: CompressedTexture): boolean {
  return texture.mipmaps.every((level) => level.data !== null);
}

/** The page's one set of baked textures: what it read, and where to read let-go texels again. */
class SurfaceTextureSet {
  readonly byName = new Map<string, CompressedTexture>();
  /** Textures whose texels were let go and are wanted again, until they come. */
  readonly wanted = new Set<string>();
  /** The build's files, fetched anew (`surfaceBakeClient.ts`); null keeps the texels. */
  source: ((names: readonly string[]) => void) | null = null;

  /** DO NOT keep a texture's texels once uploaded: some 250 MB of the page's heap were copies of what the GPU holds. */
  readonly letTexelsGo = (texture: Texture): void => {
    if (!this.source) return;
    for (const level of (texture as CompressedTexture).mipmaps) (level as { data: unknown }).data = null;
  };

  /** These textures' texels wanted again (to be uploaded anew); once until they come. */
  want(names: readonly string[]): void {
    const fresh = names.filter((name) => !this.wanted.has(name));
    if (fresh.length === 0 || !this.source) return;
    for (const name of fresh) this.wanted.add(name);
    this.source(fresh);
  }
}

const surfaces = new SurfaceTextureSet();

/** The textures read from the build's files (`surfaceBakeClient.ts`), and where to read them again. */
export function primeSurfaceTextures(loaded: ReadonlyMap<string, CompressedTexture>, source: (names: readonly string[]) => void): void {
  surfaces.source = source;
  for (const [name, texture] of loaded) {
    texture.onUpdate = surfaces.letTexelsGo;
    surfaces.byName.set(name, texture);
  }
}

/** Texels read again: each let-go texture given its own and uploaded anew (it lets them go again after). */
export function refillSurfaceTexels(loaded: ReadonlyMap<string, CompressedTexture>): void {
  for (const [name, fresh] of loaded) {
    const texture = surfaces.byName.get(name);
    if (!texture || !surfaces.wanted.delete(name) || hasTexels(texture)) continue;
    texture.mipmaps = fresh.mipmaps;
    texture.needsUpdate = true;
  }
}

/** Every baked texture let go, its texels needed again (the WebGL context restored). */
export function wantAllTexels(): void {
  surfaces.want([...surfaces.byName].filter(([, texture]) => !hasTexels(texture)).map(([name]) => name));
}

/** A baked texture by name, its anisotropy at least `anisotropy`; undefined where none was read (a worker, a test). */
function surfaceTextureOrNone(name: string, anisotropy: number): Texture | undefined {
  const texture = surfaces.byName.get(name);
  if (!texture || texture.anisotropy >= anisotropy) return texture;
  texture.anisotropy = anisotropy;
  // Texels let go: uploaded anew only once they are read back (an upload of none would draw it black).
  if (hasTexels(texture)) texture.needsUpdate = true;
  else surfaces.want([name]);
  return texture;
}

/** A baked texture by name (`bake/catalogue.ts`); the shaders need it, so a missing one is an error. */
export function surfaceTexture(name: string, anisotropy: number): Texture {
  const texture = surfaceTextureOrNone(name, anisotropy);
  if (!texture) throw new Error(`Baked surface texture ${name} not loaded: cooked/surfaces (surface-bake-plugin) is missing it`);
  return texture;
}

/** A surface's colour, normal and roughness maps; undefined where none were read (a worker, a test). */
export function surfaceMaps(key: string, anisotropy: number): SurfaceBake | undefined {
  const map = surfaceTextureOrNone(`${key}:map`, anisotropy);
  const normalMap = surfaceTextureOrNone(`${key}:normal`, anisotropy);
  const roughnessMap = surfaceTextureOrNone(`${key}:rough`, anisotropy);
  return map && normalMap && roughnessMap ? { map, normalMap, roughnessMap } : undefined;
}

/** A surface's three maps, which its material's shader needs. */
export function requireSurfaceMaps(key: string, anisotropy: number): SurfaceBake {
  return {
    map: surfaceTexture(`${key}:map`, anisotropy),
    normalMap: surfaceTexture(`${key}:normal`, anisotropy),
    roughnessMap: surfaceTexture(`${key}:rough`, anisotropy),
  };
}

export function disposeSurfaceTextures(): void {
  for (const texture of surfaces.byName.values()) texture.dispose();
  surfaces.byName.clear();
  surfaces.wanted.clear();
}
