/**
 * A clone of the whole org (the ALL depth) as every place that runs one sees
 * it, the Forge panel's handler and the command line alike: what narrows it,
 * what it brings its write gate, how its dry run stops there, and what its
 * question says beside its rows. Kept apart from both so that the two stop
 * the same dry run and put the same question.
 */

import type { ForgeConfig } from '@sandforge/shared';
import { namespaceOf } from '../checkpoint/checkpointScope.js';
import type {
  WholeOrgAllowance,
  WholeOrgConfirmation,
} from '../../core/precheck/ProductionGuard.js';
import type { WholeOrgBoundary } from './ForgeExecutor.js';
import {
  personalFieldsAsIsOf,
  wholeOrgLeftOutOf,
  type ApiBudgetCheck,
  type WholeOrgCost,
  type WholeOrgDryRun,
  type WholeOrgFilesCheck,
  type WholeOrgGraph,
  type WritePlan,
} from './ForgeRunGate.js';

/** What narrows a clone of the whole org, as its question says it: see {@link carriedOf}. */
export type WholeOrgCarried = NonNullable<WholeOrgConfirmation['carried']>;

/**
 * What a clone of the whole org was set to that narrows it — the objects it
 * reads through a filter, those it leaves out by name, those whose rows a
 * decision on Gaps holds back, those it copies without some of their fields
 * — for its question to say: a whole org that copies part of a table, or
 * part of its records, without saying so is not what was asked for. Carried
 * over from a template or the run it was started from, set on Review, or
 * given on the command line: the configuration does not tell them apart, nor
 * does the question. Absent when nothing does.
 */
export function carriedOf(
  config: Pick<
    ForgeConfig,
    'objectSoqlFilters' | 'excludedObjects' | 'skippedRows' | 'fieldExclusions'
  >,
): WholeOrgCarried | undefined {
  const carried: WholeOrgCarried = {
    filters: Object.keys(config.objectSoqlFilters ?? {}).sort(),
    excluded: [...new Set(config.excludedObjects ?? [])].sort(),
    heldBack: [...new Set((config.skippedRows ?? []).map((entry) => entry.object))].sort(),
    fieldsLeftOut: Object.entries(config.fieldExclusions ?? {})
      .filter(([, fields]) => fields.length > 0)
      .map(([object]) => object)
      .sort(),
  };
  return Object.values(carried).some((objects) => objects.length > 0) ? carried : undefined;
}

/** What a clone of the whole org brings its write gate beside any run's: see `ForgeHandler.writeGate`. */
export interface WholeOrgRun {
  /** The source, as the user knows it, and by id. */
  source: string;
  sourceOrgId: string;
  /** Its graph: the nodes it writes, their personal fields, and what discovery left out. */
  graph: WholeOrgGraph;
  /** Whether it anonymizes the personal fields selected on their node. */
  anonymizePII: boolean;
  /** What it was set to that narrows it ({@link carriedOf}). */
  carried?: WholeOrgCarried;
}

/**
 * The dry run of a clone of the whole org, come to its end at its write
 * gate: thrown from the gate once the counts are taken and both orgs' limits
 * read, it stops the executor before a row is read or anything written, and
 * whoever ran it answers with what it holds (`WholeOrgDryRun`).
 */
export class WholeOrgDryRunStop extends Error {
  constructor(readonly dryRun: WholeOrgDryRun) {
    super(
      'The dry run of a clone of the whole org stops at its write gate: nothing was read past ' +
        'the counts, nothing written.',
    );
    this.name = 'WholeOrgDryRunStop';
  }
}

/**
 * Whether `error` is the end of a clone of the whole org's dry run. Read by
 * its name as well as its class, as a gate's stop is: it reaches the bridge
 * through the executor and the orchestrator.
 */
export function isWholeOrgDryRunStop(error: unknown): error is WholeOrgDryRunStop {
  return (
    error instanceof WholeOrgDryRunStop ||
    (error instanceof Error && error.name === 'WholeOrgDryRunStop' && 'dryRun' in error)
  );
}

/** One of an org's allowances of the day, as a clone of the whole org's question says it. */
function allowanceOf(check: ApiBudgetCheck): WholeOrgAllowance {
  return check.verdict === 'unread'
    ? { estimate: check.estimate, unread: check.unread }
    : {
        estimate: check.estimate,
        remaining: check.remaining,
        max: check.max,
        ...(check.verdict === 'near' ? { near: true as const } : {}),
      };
}

/**
 * What the gate of a clone of the whole org priced of both orgs, as its
 * question reads it: the target's requests, every part together, the
 * source's, the target's Bulk API batches when it sends jobs, and how long it
 * writes — a run's write budget (`ForgeWriteBudget`), or what its dry run
 * says of the same (`WholeOrgDryRun`).
 */
export interface WholeOrgPriced {
  api: ApiBudgetCheck;
  wholeOrg: {
    source: ApiBudgetCheck;
    bulkBatches?: ApiBudgetCheck;
    cost: Pick<WholeOrgCost, 'durationSeconds'>;
  };
}

/** What the dry run of a clone of the whole org priced, as its question reads it: see {@link WholeOrgPriced}. */
export function pricedOfTheDryRun(dry: WholeOrgDryRun): WholeOrgPriced {
  return {
    api: dry.targetRequests,
    wholeOrg: {
      source: dry.sourceRequests,
      ...(dry.bulkBatches ? { bulkBatches: dry.bulkBatches } : {}),
      cost: { durationSeconds: dry.durationSeconds },
    },
  };
}

/**
 * What the question of a clone of the whole org says besides its rows and
 * their storage (`WriteConfirmation.wholeOrg`), from what the run measured
 * and what its gate priced: what it leaves out and what narrows it; the
 * requests of both orgs; its jobs, the records they carry and those that go
 * by REST, as the executor will send them, and the target's Bulk API
 * batches; how long it writes; its files against the file storage left; the
 * objects of managed packages it writes, whose package runs its own
 * automation whatever the mute keeps quiet; the phone numbers that go in
 * empty; and the personal fields it copies as they are.
 */
export function wholeOrgConfirmationOf(input: {
  run: Pick<WholeOrgRun, 'source' | 'graph' | 'anonymizePII' | 'carried'>;
  measures: WholeOrgBoundary;
  plan: WritePlan;
  budget: WholeOrgPriced;
  files?: WholeOrgFilesCheck;
}): WholeOrgConfirmation {
  const { run, measures, plan, budget } = input;
  const written = new Set(
    plan.objects.filter(({ rows }) => rows > 0).map(({ objectApiName }) => objectApiName),
  );
  const writes = measures.writes.filter(({ rows }) => rows > 0);
  const sum = (key: 'jobs' | 'jobRows' | 'restRows'): number =>
    writes.reduce((total, write) => total + write[key], 0);
  const jobs = sum('jobs');
  const managed = [...written].filter((name) => namespaceOf(name) !== undefined).sort();
  const personalAsIs = personalFieldsAsIsOf(run.graph.nodes, written, run.anonymizePII);
  const files = input.files && 'check' in input.files ? input.files : undefined;
  const fileCheck = files?.check;
  const blanked = measures.contactPointsBlanked ?? 0;
  const batches = budget.wholeOrg.bulkBatches;
  return {
    source: run.source,
    leftOut: wholeOrgLeftOutOf(run.graph).objects.length,
    ...(run.carried ? { carried: run.carried } : {}),
    targetApi: allowanceOf(budget.api),
    sourceApi: allowanceOf(budget.wholeOrg.source),
    ...(jobs > 0
      ? {
          bulk: {
            jobs,
            jobRows: sum('jobRows'),
            restRows: sum('restRows'),
            ...(batches ? { batches: allowanceOf(batches) } : {}),
          },
        }
      : {}),
    durationSeconds: budget.wholeOrg.cost.durationSeconds,
    restObjects: writes.filter((write) => write.jobs === 0).map((write) => write.objectApiName),
    ...(files && fileCheck && fileCheck.verdict !== 'unread'
      ? {
          fileStorage: {
            files: files.count,
            estimateMB: fileCheck.estimateMB,
            overCeiling:
              measures.files && 'overCeiling' in measures.files ? measures.files.overCeiling : 0,
            remainingMB: fileCheck.remainingMB,
            maxMB: fileCheck.maxMB,
            ...(fileCheck.verdict === 'near' ? { near: true as const } : {}),
          },
        }
      : {}),
    ...(managed.length > 0 ? { managedPackages: managed } : {}),
    ...(blanked > 0 ? { contactPointsBlanked: blanked } : {}),
    ...(personalAsIs.length > 0 ? { personalAsIs } : {}),
  };
}
