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
 *   them out of its summary past the bound, and an entry never holds more;
 * - of a sample, how it was drawn and what was written of each object — the
 *   seed, the draw, the share, the SHA-256 of its plan, the counts, the
 *   lookups written empty per field —, never
 *   an id nor the place of its plan, which live and go with the run's
 *   journal; and of the options it was drawn with, none of the plan it was
 *   given: run again from the history, it is drawn again with the same
 *   options, a dry run's plan being a day's at most.
 */

import type {
  ForgeExecutionResult,
  ForgeLeftOutCount,
  ForgeLeftOutReason,
  WholeOrgSampleResult,
} from '@sandforge/shared';

/**
 * What the history keeps of a sample's result: the fields its type names,
 * taken one by one, so that what a result spread from the plan's report
 * carries besides — the ids of the roots set aside, the plan's path — stays
 * out.
 */
function sampleKept(sample: WholeOrgSampleResult): WholeOrgSampleResult {
  return {
    seed: sample.seed,
    draw: sample.draw,
    share: sample.share,
    sha256: sample.sha256,
    drawnAt: sample.drawnAt,
    ...(sample.drawnBy ? { drawnBy: sample.drawnBy } : {}),
    ...(sample.drawnAgain ? { drawnAgain: sample.drawnAgain } : {}),
    ...(sample.ofTheRunRetried ? { ofTheRunRetried: true as const } : {}),
    objects: sample.objects.map((object) => ({
      objectApiName: object.objectApiName,
      sourceRows: object.sourceRows,
      kept: object.kept,
      roots: object.roots,
      below: object.below,
      asParents: object.asParents,
      ...(object.whole ? { whole: object.whole } : {}),
      ...(object.childrenCut
        ? { childrenCut: object.childrenCut.map(({ field, rows }) => ({ field, rows })) }
        : {}),
      written: object.written,
      goneSinceTheSample: object.goneSinceTheSample,
      changedSinceTheSample: object.changedSinceTheSample,
    })),
    ...(sample.leftEmpty
      ? {
          leftEmpty: sample.leftEmpty.map(({ objectApiName, field, rows }) => ({
            objectApiName,
            field,
            rows,
          })),
        }
      : {}),
  };
}

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
  const { idRemapWithTheirRecord, sample, config, ...entry } = result;
  const withTheirRecord = result.remapInJournal ? undefined : idRemapWithTheirRecord;
  // The options of a sample, without the plan it was given.
  const drawAgain = config?.sample ? { ...config.sample } : undefined;
  if (drawAgain) delete drawAgain.plan;
  return {
    ...entry,
    graph: { ...graph, edges: [], withoutEdges: true },
    ...(config ? { config: drawAgain ? { ...config, sample: drawAgain } : config } : {}),
    ...(sample ? { sample: sampleKept(sample) } : {}),
    ...(leftOutCounts.length > 0 ? { leftOutCounts } : {}),
    ...(withTheirRecord ? { idRemapWithTheirRecord: withTheirRecord } : {}),
  };
}
