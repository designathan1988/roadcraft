import { RoadDoc, type SerializedDoc } from '@world/doc';
import { Network, type NetworkBake } from '@world/network';
import type { JobScope } from './jobs/jobScope';

/**
 * A CITY'S NETWORK SOLVED OFF THE PAGE WHILE THE CURTAIN IS UP (`main.ts` openCityNow): the document opened here as the page opens it
 * (`editor/history.ts` restoreInto), its network built whole and handed back as solved (`Network.exportBake`); the page's own build
 * takes every junction and ribbon whose inputs are the same (`NetworkBuild.takeBakes`) and solves only the others. DO NOT solve a large
 * city's every junction on the page: 1.6 s of its opening blocked in `Network.rebuild` for the city of 70,000 buildings (2026-10-22).
 */

export interface NetworkBakeAsk {
  readonly id: number;
  /** The document as the page restores it (its buildings in `table`, `prepareCity`). */
  readonly data: SerializedDoc;
  readonly table: ArrayBufferLike | null;
  /** Whether the page restores it unrepaired (`restoreInto`: a generated city). */
  readonly generated: boolean;
}

export type NetworkBakeReply = { readonly id: number; readonly bake?: NetworkBake; readonly error?: string };

/** The network of `ask`'s document, solved whole and exported (`Network.exportBake`). */
export function bakeNetwork(ask: Omit<NetworkBakeAsk, 'id'>): NetworkBake {
  const doc = new RoadDoc();
  doc.replaceFromJSON(ask.data, { ...(ask.generated ? { repair: false } : {}), ...(ask.table ? { buildingTable: ask.table } : {}), whole: true });
  const net = new Network(doc);
  net.rebuild({ full: true });
  return net.exportBake(doc.nodes.keys(), doc.segments.keys());
}

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<NetworkBakeAsk>) => {
    const ask = event.data;
    try {
      scope.postMessage({ id: ask.id, bake: bakeNetwork(ask) } satisfies NetworkBakeReply);
    } catch (error) {
      // Said on the worker's console; the page solves the network itself (`main.ts` networkBakeOf).
      console.error('[networkBake] the network could not be solved off the page', error);
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies NetworkBakeReply);
    }
  };
}
