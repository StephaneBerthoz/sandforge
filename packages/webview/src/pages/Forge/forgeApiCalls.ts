/**
 * Discovery's estimate of the calls a Forge run makes, for where the run has
 * not counted them yet.
 *
 * Discovery puts one call on each 200 rows of every table it counts: a guess
 * at the writes of whole tables, made before anything is read. A clone of one
 * record writes the few rows of each table its record reaches, and reads,
 * describes and a second pass besides; a starter template's graph skips
 * discovery and holds each estimate at zero. The results screen used to add
 * the estimates up as the calls a run consumed. A run counts the calls it
 * made (`ForgeExecutionResult.apiCalls`), and this is shown only where no
 * count is known, said to be an estimate.
 */
import type { ForgeGraphNode } from '@sandforge/shared';

/**
 * The calls discovery put on the objects the run takes, added up; null when
 * one of them was never counted, its estimate a placeholder zero.
 */
export function estimatedApiCallsOf(nodes: readonly ForgeGraphNode[]): number | null {
  const taken = nodes.filter((node) => node.included);
  if (taken.some((node) => node.recordCountUnknown === true)) return null;
  return taken.reduce((sum, node) => sum + node.estimatedApiCalls, 0);
}
