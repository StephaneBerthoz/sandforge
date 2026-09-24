import type { ForgeGraphNode } from '../types/forge.types.js';

/**
 * Whether discovery left a node out of the run because its table is empty:
 * counted, and none there. A node whose describe or count failed is left out
 * as well, for its error, which is worth saying.
 *
 * Such tables are most of a graph: a clone of one opportunity between two
 * sandboxes reached 400 objects, 315 of them empty tables left out, and what
 * named or counted the objects of the run from its graph named or counted
 * those with the rest. One rule for every place that sets them apart, so the
 * clone command's summary and a run's report agree on which they are.
 */
export function leftOutAsEmptyTable(
  node: Pick<ForgeGraphNode, 'included' | 'recordCount' | 'status'>,
): boolean {
  return !node.included && node.recordCount === 0 && node.status !== 'error';
}
