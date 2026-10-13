import type { PipelineCondition } from '@sandforge/shared';
import {
  COMPARE_DIFFERENCE_COUNT,
  PRECHECK_VARIABLES,
  PREVIOUS_STEP_STATUS,
} from '@sandforge/shared';

/**
 * The conditions the Step Config Panel offers a Condition step: the values a
 * run hands on, which the extension's Condition evaluates — how the previous
 * step went, the differences a Compare found, a Pre-check's readings. Each
 * kind is one condition the extension already reads: a choice here writes it,
 * and a condition written elsewhere (a Marketplace template) is read back as
 * the kind it is, or shown as it stands.
 */

/** A condition the panel offers. */
export type ConditionKind =
  | 'previousSucceeded'
  | 'previousFailed'
  | 'compareDifferences'
  | 'apiUsage'
  | 'storageUsage'
  | 'recentErrors'
  | 'failedJobs';

/** Every kind, in the order the panel lists them. */
export const CONDITION_KINDS: readonly ConditionKind[] = [
  'previousSucceeded',
  'previousFailed',
  'compareDifferences',
  'apiUsage',
  'storageUsage',
  'recentErrors',
  'failedJobs',
];

/** The kinds that compare a count or a percentage with a number the reader sets. */
const THRESHOLD_FIELDS: Readonly<Partial<Record<ConditionKind, string>>> = {
  compareDifferences: COMPARE_DIFFERENCE_COUNT,
  apiUsage: PRECHECK_VARIABLES.apiLimits,
  storageUsage: PRECHECK_VARIABLES.storage,
  recentErrors: PRECHECK_VARIABLES.recentErrors,
  failedJobs: PRECHECK_VARIABLES.failedJobs,
};

/** The kinds that read a percentage, which goes no higher than 100. */
const PERCENT_KINDS: ReadonlySet<ConditionKind> = new Set(['apiUsage', 'storageUsage']);

/** Whether a kind compares with a number the reader sets. */
export function takesThreshold(kind: ConditionKind): boolean {
  return THRESHOLD_FIELDS[kind] !== undefined;
}

/** The highest number a kind's threshold may be: 100 for a percentage, none for a count. */
export function thresholdMax(kind: ConditionKind): number | undefined {
  return PERCENT_KINDS.has(kind) ? 100 : undefined;
}

/**
 * The condition a kind stands for. A kind with a threshold holds when the
 * value is above it: "more than N differences", "API usage above N%".
 * @param kind - The kind chosen
 * @param threshold - The number it compares with; 0 when not set
 */
export function conditionFor(kind: ConditionKind, threshold = 0): PipelineCondition {
  const field = THRESHOLD_FIELDS[kind];
  if (field !== undefined) return { field, operator: 'gt', value: threshold };
  return {
    field: PREVIOUS_STEP_STATUS,
    operator: 'eq',
    value: kind === 'previousFailed' ? 'failed' : 'succeeded',
  };
}

/**
 * The kind a condition is, and its threshold, or undefined for a condition
 * none of the kinds writes.
 * @param condition - The condition a step holds
 */
export function kindOf(
  condition: PipelineCondition | undefined,
): { kind: ConditionKind; threshold?: number } | undefined {
  if (!condition) return undefined;
  const { field, operator, value } = condition;
  if (field === PREVIOUS_STEP_STATUS && operator === 'eq') {
    if (value === 'succeeded') return { kind: 'previousSucceeded' };
    if (value === 'failed') return { kind: 'previousFailed' };
    return undefined;
  }
  if (operator !== 'gt' || typeof value !== 'number') return undefined;
  const kind = CONDITION_KINDS.find((candidate) => THRESHOLD_FIELDS[candidate] === field);
  return kind === undefined ? undefined : { kind, threshold: value };
}
