/**
 * The dry run of an emptying: everything it would delete and leave, read
 * from the org before anything is written, and nothing written.
 *
 * It settles the scope from the org's global describe, describes the
 * objects emptied, then the objects their deletes take records of along —
 * those of their children people work in, and theirs, as far as the
 * lookups that take records along go — and the objects whose lookups would
 * refuse the deletes. It orders the passes, counts what each deletes, what
 * goes along, what is likely refused and what no undo would bring back, and
 * prices the whole against what the org has left today.
 *
 * Every number it gives is a count the org answered, or says why the org did
 * not: a table it could not count is never read as an empty one.
 */

import { CONCURRENT_DESCRIBE_LIMIT } from '../../forge/orgConcurrency.js';
import type { ApiBudget } from '../../forge/ForgeRunGate.js';
import type { GlobalObject } from '../../checkpoint/checkpointScope.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import type { DeleteMode } from '../../../core/removal/deleteRecords.js';
import { inPool } from '../RecordRemoval.js';
import { countEmpty, type Counted, type EmptyCountOrg, type EmptyCounts } from './emptyCounts.js';
import { deletedForGood, emptyCostOf, type EmptyCost } from './emptyCost.js';
import { emptyOrderOf, type BeforeParent, type OrderConstraint } from './emptyOrder.js';
import {
  affectedBy,
  anyRouteCondition,
  emptyDescribeSchema,
  MOST_ROUTE_STEPS,
  relationsOf,
  type EmptyDescribe,
} from './emptyRelations.js';
import {
  emptyScopeOf,
  settleEmptyScope,
  type EmptyLeftOut,
  type EmptyMode,
  type EmptyScope,
  type EmptyScopeRequest,
  type WholeOrgScopeRule,
} from './emptyScope.js';

/** What a dry run of an emptying reads of the org. */
export interface EmptyPreviewOrg extends EmptyCountOrg {
  /** An object's describe, as the org answers it. */
  describe(objectApiName: string): Promise<unknown>;
}

/** What a dry run is asked. */
export interface EmptyPreviewInput {
  /** The org's global describe. */
  global: readonly GlobalObject[];
  /** The names its Tooling API serves; none when it could not say. */
  tooling: readonly string[];
  request: EmptyScopeRequest;
  deleteMode: DeleteMode;
  /** The org's daily API requests, as its `/limits` say, or why they are not known. */
  apiBudget?: ApiBudget | { unread: string };
  /** The org's daily Bulk API batches, as its `/limits` say. */
  bulkBatches?: ApiBudget;
  /** The org's data storage, in MB. */
  dataStorageMB?: number;
  /** The whole-org rule: the emptying one (`emptyingRule`) unless given. */
  rule?: WholeOrgScopeRule;
  /** Asked before each count is sent: see `countEmpty`. */
  stopped?: () => boolean;
}

/** One pass of the dry run, in the order the run takes them. */
export interface EmptyPreviewPass {
  objectApiName: string;
  /** Its records the emptying deletes, every pass together. */
  records: Counted;
  /** Of them, those its own pass sends. */
  sent: Counted;
  archived?: Counted;
  kept?: Counted;
}

/** What an emptying would do, said before it does anything. */
export interface EmptyPreview {
  mode: EmptyMode;
  deleteMode: DeleteMode;
  passes: EmptyPreviewPass[];
  along: EmptyCounts['along'];
  leftOut: EmptyLeftOut[];
  refusals: EmptyCounts['refusals'];
  blockers: EmptyCounts['blockers'];
  /** Pairs whose records go before a record they name, as the platform requires. */
  beforeParent: BeforeParent[];
  /** Constraints of the order that gave way where objects point at each other. */
  unordered: OrderConstraint[];
  /**
   * What an undo would not bring back, counted: empty when the records go
   * for good, which no undo brings back at all (`undo: false`).
   */
  undoLost: EmptyCounts['undoLost'];
  /** Whether an undo can bring the records back from the recycle bin. */
  undo: boolean;
  /** The objects whose records go, emptied and along: what fires as they go is read on these. */
  affected: string[];
  /**
   * Of the objects going along, those whose records past Draft the run sets
   * back to Draft before its first delete — an activated order refuses its
   * own delete and its account's — with the condition that reads the records
   * of it that go along; none where no path to them reads, and then the run
   * leaves them as they are, to be refused.
   */
  toDraftAlong: Array<{ objectApiName: string; condition?: string }>;
  cost: EmptyCost;
  /**
   * What the button says: the records deleted and the objects they belong to;
   * `uncounted`, the objects the org would not count, whose records are not
   * in the sum.
   */
  total: { records: number; objects: number; uncounted: string[] };
  /** The counts sent: what the dry run cost the org, besides its describes. */
  statements: number;
  /** Set when it was stopped before every count was in. */
  stopped?: true;
}

/** Describe each of `names` the org will, by name, and say why it would not the others. */
async function describeAll(
  org: EmptyPreviewOrg,
  names: readonly string[],
  describes: Map<string, EmptyDescribe>,
  errors: Map<string, string>,
): Promise<void> {
  await inPool(
    names.map((name) => async () => {
      try {
        describes.set(name, emptyDescribeSchema.parse(await org.describe(name)));
      } catch (error) {
        errors.set(name, extractErrorMessage(error));
      }
    }),
    CONCURRENT_DESCRIBE_LIMIT,
  );
}

/**
 * `scope` without what `mode` never deletes: deleted for good, a file is not
 * sent at all, as no job sends one (`goesByJob`), and is left out so.
 */
function forTheMode(scope: EmptyScope, mode: DeleteMode): EmptyScope {
  if (mode !== 'hard') return scope;
  const kept = scope.objects.filter((name) => !deletedForGood(name));
  if (kept.length === 0) return scope;
  return {
    ...scope,
    objects: scope.objects.filter(deletedForGood),
    leftOut: [
      ...scope.leftOut,
      ...kept.map((objectApiName) => ({ objectApiName, reason: 'notForGood' as const })),
    ].sort((a, b) =>
      a.objectApiName < b.objectApiName ? -1 : a.objectApiName > b.objectApiName ? 1 : 0,
    ),
  };
}

/** A count's number, or nothing when the org gave none. */
function numberOf(counted: Counted): number | undefined {
  return counted.records;
}

/** The dry run of an emptying: see the module's comment. Nothing is written. */
export async function previewEmpty(
  input: EmptyPreviewInput,
  org: EmptyPreviewOrg,
): Promise<EmptyPreview> {
  const scope = emptyScopeOf(input.global, input.tooling, input.request, input.rule);
  const describes = new Map<string, EmptyDescribe>();
  const errors = new Map<string, string>();
  await describeAll(org, scope.objects, describes, errors);
  const settled = forTheMode(settleEmptyScope(scope, describes, errors), input.deleteMode);

  const canonical = new Map(
    [...scope.worked, ...input.global.map((object) => object.name)].map((name) => [
      name.toLowerCase(),
      name,
    ]),
  );
  const nameOf = (name: string): string => canonical.get(name.toLowerCase()) ?? name;

  // What goes along is read as far as the objects it reaches are described:
  // each round describes the objects the last one reached.
  let affected = affectedBy(settled.objects, scope.worked, describes);
  for (let round = 0; round < MOST_ROUTE_STEPS; round++) {
    const next = affected.undescribed.filter((name) => !describes.has(name) && !errors.has(name));
    if (next.length === 0) break;
    await describeAll(org, next, describes, errors);
    affected = affectedBy(settled.objects, scope.worked, describes);
  }
  // The objects whose lookups would refuse a delete are described too: their
  // count reads the lookup's describe.
  const deleted = (name: string): boolean =>
    affected.emptied.has(name) || affected.routes.has(name);
  const refusing = [
    ...new Set(
      relationsOf(describes, nameOf)
        .filter(
          ({ kind, parent, child }) => kind === 'restricted' && deleted(parent) && !deleted(child),
        )
        .map(({ child }) => child),
    ),
  ].filter((name) => !describes.has(name) && !errors.has(name));
  await describeAll(org, refusing, describes, errors);
  const relations = relationsOf(describes, nameOf);

  const order = emptyOrderOf(affected, relations);
  const counts = await countEmpty({ affected, order, relations, describes }, org, input.stopped, {
    undo: input.deleteMode === 'recycle',
  });

  const uncounted = [
    ...counts.objects.filter((object) => numberOf(object.records) === undefined),
    ...counts.along.filter((object) => numberOf(object.records) === undefined),
  ].map((object) => object.objectApiName);
  const counted = [...counts.objects, ...counts.along]
    .map((object) => numberOf(object.records) ?? 0)
    .filter((records) => records > 0);
  const deletedRecords = counted.reduce((sum, records) => sum + records, 0);
  const activated = counts.refusals
    .filter((refusal) => refusal.code === 'activatedOrder')
    .reduce((sum, refusal) => sum + (numberOf(refusal.records) ?? 0), 0);

  const cost = emptyCostOf({
    mode: input.deleteMode,
    passes: counts.objects.map((object) => ({
      objectApiName: object.objectApiName,
      records: numberOf(object.sent) ?? 0,
    })),
    toDraft: activated,
    deleted: deletedRecords,
    ...(input.apiBudget ? { apiBudget: input.apiBudget } : {}),
    ...(input.bulkBatches ? { bulkBatches: input.bulkBatches } : {}),
    ...(input.dataStorageMB === undefined ? {} : { dataStorageMB: input.dataStorageMB }),
  });

  return {
    mode: scope.mode,
    deleteMode: input.deleteMode,
    passes: counts.objects,
    along: counts.along,
    leftOut: settled.leftOut,
    refusals: counts.refusals,
    blockers: counts.blockers,
    beforeParent: order.beforeParent,
    unordered: order.unordered,
    undoLost: counts.undoLost,
    undo: input.deleteMode === 'recycle',
    affected: [...affected.emptied, ...affected.along].sort(),
    toDraftAlong: order.toDraft
      .filter((name) => !affected.emptied.has(name))
      .map((objectApiName) => {
        const condition = anyRouteCondition(affected.routes.get(objectApiName) ?? [], describes);
        return { objectApiName, ...(condition ? { condition: condition.soql } : {}) };
      }),
    cost,
    total: { records: deletedRecords, objects: counted.length, uncounted },
    statements: counts.statements,
    ...(counts.stopped ? { stopped: true as const } : {}),
  };
}
