/** THE ROADS THE NEXT SOLVE READS THE GROUND UNDER, AS LAST WORKED OUT (`elevation.ts` roadsToRead), and what for (`key`: what they were worked out of). DO NOT work them out again every frame the solve waits on the stations' job (`renderer.ts` buildWorld returns and is asked again each frame): each time joined every change of the network since the last solve into new sets, 365 MB of a 95 s opening on the page (allocation profile ap1, 2026-10-17). No key (a moved ground's region, asked once): never kept. */
export class RoadsRead<T> {
  private kept: { readonly key: readonly unknown[]; readonly roads: T } | null = null;

  of(key: readonly unknown[] | null, work: () => T): T {
    const known = this.kept;
    if (key && known && known.key.length === key.length && known.key.every((k, i) => k === key[i])) return known.roads;
    const roads = work();
    this.kept = key ? { key, roads } : null;
    return roads;
  }
}
