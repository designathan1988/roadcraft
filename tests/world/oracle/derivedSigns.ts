import type { Network } from '@world/network';
import { type DerivedSign, signsAtNode } from '@world/roads/derivedSigns';

/** @rebuild The signs the rules put up, every junction of the map in id order. */
export function derivedSigns(net: Network): DerivedSign[] {
  const out: DerivedSign[] = [];
  for (const node of [...net.doc.nodes.keys()].sort((a, b) => a - b)) out.push(...signsAtNode(net, node));
  return out;
}
