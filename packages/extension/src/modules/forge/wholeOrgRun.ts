/**
 * A clone of the whole org (the ALL depth) as every place that runs one sees
 * it, the Forge panel's handler and the command line alike: what narrows it,
 * what it brings its write gate, how its dry run stops there, and what its
 * question says beside its rows. Kept apart from both so that the two stop
 * the same dry run and put the same question.
 */

import {
  BYTES_PER_MB,
  type ForgeConfig,
  type ForgeGraph,
  type WholeOrgSample,
} from '@sandforge/shared';
import { namespaceOf } from '../checkpoint/checkpointScope.js';
import type {
  WholeOrgAllowance,
  WholeOrgConfirmation,
  WholeOrgConfirmationSample,
} from '../../core/precheck/ProductionGuard.js';
import type { WholeOrgBoundary } from './ForgeExecutor.js';
import { sampleOptionsApplied } from './runFingerprint.js';
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
 * decision on Gaps holds back, those it copies without some of their fields,
 * a sample rather than every record — for its question to say: a whole org
 * that copies part of a table, or
 * part of its records, without saying so is not what was asked for. Carried
 * over from a template or the run it was started from, set on Review, or
 * given on the command line: the configuration does not tell them apart, nor
 * does the question. Absent when nothing does.
 */
export function carriedOf(
  config: Pick<
    ForgeConfig,
    'objectSoqlFilters' | 'excludedObjects' | 'skippedRows' | 'fieldExclusions' | 'sample'
  >,
): WholeOrgCarried | undefined {
  const carried = {
    filters: Object.keys(config.objectSoqlFilters ?? {}).sort(),
    excluded: [...new Set(config.excludedObjects ?? [])].sort(),
    heldBack: [...new Set((config.skippedRows ?? []).map((entry) => entry.object))].sort(),
    fieldsLeftOut: Object.entries(config.fieldExclusions ?? {})
      .filter(([, fields]) => fields.length > 0)
      .map(([object]) => object)
      .sort(),
  } satisfies WholeOrgCarried;
  // A sample copies part of every object: it narrows the run whatever else
  // does, said with its options as they apply, as its fingerprint takes them.
  if (config.sample) return { ...carried, sample: sampleOptionsApplied(config.sample) };
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

/** Why a clone of the whole org that copies no object is refused: see {@link nothingToClone}. */
export const NOTHING_TO_CLONE = 'NOTHING_TO_CLONE';

/**
 * The refusal of a clone of the whole org whose graph copies no object —
 * each left out by name, or none of the source's holding a record the target
 * can take — or nothing when it copies one. Run for real with every object
 * left out by `--exclude-object`, it ended `success` with nothing written and
 * kept a journal, and its dry run said it would take about a minute. Refused
 * before anything is written, as a run past `--max-total` is, by the command
 * line and the panel alike.
 */
export function nothingToClone(
  graph: Pick<ForgeGraph, 'nodes'>,
): { code: typeof NOTHING_TO_CLONE; message: string } | undefined {
  if (graph.nodes.some((node) => node.included)) return undefined;
  const byName = graph.nodes.filter((node) => node.leftOutByUser === true).length;
  return {
    code: NOTHING_TO_CLONE,
    message:
      byName > 0
        ? `Nothing to clone: every object of the source that holds records is left out, ` +
          `${byName} of them by name. Leave fewer out. Nothing was written.`
        : 'Nothing to clone: no object of the source holds records the target can take. ' +
          'Nothing was written.',
  };
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
 * What the question of a sample of the whole org says of it: the records its
 * plan keeps of what the source holds of the run's objects, the storage it
 * takes of what it may take, its seed, draw and share, what held it, what an
 * optional lookup outside it becomes, the children it takes, and when and by
 * what its plan was drawn — a simulation's, with its age. Counts and words:
 * no id of the roots set aside, no path of the plan.
 */
function sampleQuestionOf(sample: WholeOrgSample, now: number): WholeOrgConfirmationSample {
  const sum = (rows: ReadonlyArray<{ rows: number }>): number =>
    rows.reduce((total, entry) => total + entry.rows, 0);
  const sourceRows =
    sample.objects.reduce((total, object) => total + object.sourceRows, 0) +
    sample.noRecordDrawn.reduce((total, object) => total + object.sourceRows, 0);
  const leftEmpty = sum(sample.leftEmpty);
  const { plan } = sample;
  const drawnAt = Date.parse(plan.drawnAt);
  return {
    rows: sample.rows,
    objects: sample.objects.length,
    sourceRows,
    storageMB: sample.storageBytes / BYTES_PER_MB,
    budgetMB: sample.budget.bytes / BYTES_PER_MB,
    ...(sample.budget.automationMB !== undefined && sample.budget.automationMB > 0
      ? { automationMB: sample.budget.automationMB }
      : {}),
    seed: sample.seed,
    draw: sample.draw,
    share: sample.share,
    limitedBy: sample.budget.limitedBy,
    parents: sample.parents,
    children: sample.children,
    drawnAt: plan.drawnAt,
    drawnBy: plan.drawnBy,
    ...(plan.drawnBy === 'dryRun' && Number.isFinite(drawnAt)
      ? { minutesBefore: Math.max(1, Math.ceil((now - drawnAt) / 60_000)) }
      : {}),
    ...(plan.drawnAgain ? { drawnAgain: plan.drawnAgain } : {}),
    ...(plan.ofTheRunRetried ? { ofTheRunRetried: true as const } : {}),
    ...(leftEmpty > 0 ? { leftEmpty } : {}),
    ...(sample.heavyRoots.length > 0 ? { heavyRoots: sample.heavyRoots.length } : {}),
    ...(sample.noRecordDrawn.length > 0 ? { noRecordDrawn: sample.noRecordDrawn.length } : {}),
    ...(sample.newestByIds && sample.newestByIds.length > 0
      ? { newestByIds: [...sample.newestByIds] }
      : {}),
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
 * empty; and the personal fields it copies as they are. Of a sample, what
 * its plan keeps and how it was drawn, before the rest ({@link sampleQuestionOf}).
 *
 * @param input.sample - Of a sample of the whole org, what its plan drew.
 * @param input.now - When the question is put, in epoch milliseconds: the
 *   age of a simulation's plan is said against it.
 */
export function wholeOrgConfirmationOf(input: {
  run: Pick<WholeOrgRun, 'source' | 'graph' | 'anonymizePII' | 'carried'>;
  measures: WholeOrgBoundary;
  plan: WritePlan;
  budget: WholeOrgPriced;
  files?: WholeOrgFilesCheck;
  sample?: WholeOrgSample;
  now?: number;
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
    ...(input.sample ? { sample: sampleQuestionOf(input.sample, input.now ?? Date.now()) } : {}),
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
