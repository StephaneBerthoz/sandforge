/**
 * What the Forge history keeps of a clone of the whole org: the run as any
 * other, its graph made small.
 *
 * The history lives in the extension's global state, which VS Code writes
 * whole at every change, and keeps twenty runs. A clone of the whole org has
 * up to two thousand nodes, twenty thousand relations between them and a list
 * of every object of the source it left out — sixteen thousand names on a
 * large org, each with its reason — which kept in each entry put megabytes
 * into every write of the history, and twenty of them into its memory. Its
 * entry keeps:
 *
 * - the nodes, which name what the run copied and are what the history,
 *   the reports, the export of the results and a retry read of the graph;
 * - no relation: no reader of an entry walks them — a removal orders the
 *   objects by what the run created and the org's own describes — and the
 *   graph of a clone of the whole org is never reused from the history, it
 *   is discovered again. The graph says so (`withoutEdges`): opened from the
 *   history, the page holds it as the run's graph, and a Retry sent it back
 *   to be run without the relations that order the parents and map the
 *   lookups; the run refuses it;
 * - of what it left out, a count by reason (`leftOutCounts`), what the
 *   history says of it;
 * - none of the ids of records the platform deletes with one the run created
 *   (`idRemapWithTheirRecord`) once the run keeps its ids in its journal
 *   (`remapInJournal`), where they are marked: the executor already leaves
 *   them out of its summary past the bound, and an entry never holds more.
 */

import type {
  ForgeExecutionResult,
  ForgeLeftOutCount,
  ForgeLeftOutReason,
} from '@sandforge/shared';

/**
 * The entry the history keeps of `result`, the result of a clone of the whole
 * org: see the module's comment. The result the run answers its page with is
 * left whole.
 */
export function wholeOrgHistoryEntry(result: ForgeExecutionResult): ForgeExecutionResult {
  const { leftOut, ...graph } = result.graph;
  const counts = new Map<ForgeLeftOutReason, number>();
  for (const object of leftOut ?? []) {
    counts.set(object.reason, (counts.get(object.reason) ?? 0) + 1);
  }
  const leftOutCounts: ForgeLeftOutCount[] = [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  const { idRemapWithTheirRecord, ...entry } = result;
  const withTheirRecord = result.remapInJournal ? undefined : idRemapWithTheirRecord;
  return {
    ...entry,
    graph: { ...graph, edges: [], withoutEdges: true },
    ...(leftOutCounts.length > 0 ? { leftOutCounts } : {}),
    ...(withTheirRecord ? { idRemapWithTheirRecord: withTheirRecord } : {}),
  };
}
