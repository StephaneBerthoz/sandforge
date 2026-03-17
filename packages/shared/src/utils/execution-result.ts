/**
 * Utilities for aggregating and evaluating execution results
 * across SandForge modules (Seed, Sync, Forge, etc.).
 */

/** Input item shape for {@link determineExecutionStatus}. */
interface StatusItem {
  success: boolean;
}

/** Input item shape for {@link aggregateResults}. */
interface AggregateItem {
  recordCount: number;
  errorCount: number;
}

/**
 * Determines the overall execution status from a list of result items.
 *
 * - All success returns `'success'`
 * - All failed returns `'failed'`
 * - Mixed returns `'partial'`
 * - Empty array returns `'success'` (vacuous truth)
 *
 * @param results - Array of items with a `success` boolean.
 * @returns The aggregate status string.
 */
export function determineExecutionStatus(
  results: StatusItem[],
): 'success' | 'partial' | 'failed' {
  if (results.length === 0) return 'success';

  const successCount = results.filter((r) => r.success).length;

  if (successCount === results.length) return 'success';
  if (successCount === 0) return 'failed';
  return 'partial';
}

/**
 * Aggregates record and error counts from multiple result items.
 *
 * @param results - Array of items with `recordCount` and `errorCount`.
 * @returns Totals for records, errors, and the computed success rate (0..100).
 */
export function aggregateResults<T extends AggregateItem>(
  results: T[],
): { totalRecords: number; totalErrors: number; successRate: number } {
  let totalRecords = 0;
  let totalErrors = 0;

  for (const r of results) {
    totalRecords += r.recordCount;
    totalErrors += r.errorCount;
  }

  const successRate =
    totalRecords === 0
      ? 100
      : Math.round(((totalRecords - totalErrors) / totalRecords) * 10_000) / 100;

  return { totalRecords, totalErrors, successRate };
}
