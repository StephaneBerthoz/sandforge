/**
 * The sweep asked with the removal of a run, as the panel's removals of a
 * Forge run, a Sync run, a Seed run and a Frozen load make it: in the parts
 * the removal makes it in around the run's own records (`sweepParts`), judged
 * by Production Guard before its first delete, recorded once in the audit
 * trail beside the removal, and what it found made for the run kept for the
 * next one.
 *
 * Made in one go before the run's records, the sweep deleted an asset a case
 * of the run named before the case, and the org refused it ("associated with
 * the following cases"); and what it would take with the run's records in
 * cascade held them back all the same, the removal reading it as a record
 * that stays. In parts, the removal reads the run's records, the sweep takes
 * what goes before them, the removal deletes them — what the sweep takes
 * holding none of them back — and the sweep takes what waited for them.
 */

import type {
  AuditAction,
  AuditLogEntry,
  ForgeSweepResult,
  ForgeWrittenBetween,
  GuardDecision,
} from '@sandforge/shared';

import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  consultProductionGuard,
  type ConsultedGuard,
} from '../../core/precheck/consultProductionGuard.js';
import type { SafetyTier } from '../../core/precheck/ProductionGuard.js';
import {
  compositeConnectionOf,
  compositeReader,
} from '../../modules/checkpoint/compositeQueries.js';
import type { SplitAllowance } from '../../core/common/governorLimit.js';
import { removalOrg } from '../../modules/forge/ForgeRunRemoval.js';
import {
  sweepCountsOf,
  sweepFoundCount,
  sweepFoundObjects,
  sweepParts,
  type SweepInput,
  type SweepOptions,
  type SweepOrg,
  type SweepParts,
  type SweepTies,
} from '../../modules/forge/ForgeRunSweep.js';
import { quoteSyncCopiesOf } from '../../modules/forge/quoteSyncCopies.js';
import { LATE_WITHIN_MS, madeKept, TIE_LEAD_MS } from '../../modules/forge/sweepTies.js';
import type { SyncRunKept, SyncRunRemovalState } from '../../modules/sync/SyncRunCreations.js';

/** A sweep that did not run, whose refusal or failure says why. */
const SWEEP_NOT_RUN: ForgeSweepResult = {
  status: 'cancelled',
  objects: [],
  unread: [],
  handWork: [],
};

/**
 * The org a sweep reads and deletes in: a removal's, its counts sent five to
 * a composite, which costs the org one request of its day as one query does.
 */
export function sweepOrgOf(
  conn: Parameters<typeof removalOrg>[0],
  context: string,
  signal?: AbortSignal,
): SweepOrg {
  return {
    ...removalOrg(conn, context),
    counts: sweepCountsOf(compositeReader(compositeConnectionOf(conn), signal)),
  };
}

/**
 * What a sweep is told, the lines the platform copied as the run wrote under a
 * quote it synced among what it never takes: those are the removal's, named
 * in its plan (`platformCopies`) and taken at their object's turn. Listed by
 * the sweep too, they were named twice, and deleted by whichever came first.
 * Read as the removal reads them; a run the target did not date, or that
 * synced no quote of its own, reads nothing.
 */
export async function withoutPlatformCopies(
  input: SweepInput,
  org: Parameters<typeof quoteSyncCopiesOf>[0],
): Promise<SweepInput> {
  const start = Date.parse(input.writtenBetween?.first ?? '');
  const end = Date.parse(input.writtenBetween?.last ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return input;
  const { created } = input;
  const keys = new Set(created.flatMap(({ ids }) => ids.map((id) => id.slice(0, 15))));
  const copies = await quoteSyncCopiesOf(
    org,
    {
      has: (key) => keys.has(key),
      start,
      end,
      ...(input.runUserId ? { user: input.runUserId.slice(0, 15) } : {}),
    },
    created.filter((object) => object.objectApiName === 'Quote').flatMap(({ ids }) => ids),
    new Set(created.map((object) => object.objectApiName)),
  );
  const copied = new Set(
    copies.flatMap((object) => object.copies.map((copy) => copy.id.slice(0, 15))),
  );
  if (copied.size === 0) return input;
  const { remap } = input;
  return { ...input, remap: { has: (key) => remap.has(key) || copied.has(key) } };
}

/**
 * The sweep asked with a removal, in the parts the removal makes it in
 * around the run's records (`SweepParts`), and what it did once it is through.
 */
export interface RemovalSweep {
  /**
   * Find what to take, and ask, deleting nothing: made before a mute's lease
   * is taken, so that a person answering Production Guard holds no permission
   * set assigned. `first` makes it when nobody has.
   */
  ask(): Promise<void>;
  /**
   * The objects it deletes records of, once `ask` has read them: what the
   * removal adds to the objects it plans its mute from. Nothing for a sweep
   * refused, declined, or that could not read.
   */
  readonly takes: readonly string[];
  /**
   * Delete what goes before the run's records; whether it deleted anything.
   * Handed the removal's allowance of smaller calls, the sweep spends it for
   * the calls a governor limit refused, here and once the run's records are
   * deleted: one bound for the two.
   */
  first(allowance?: SplitAllowance): Promise<boolean>;
  /** Once the run's records are deleted, what waited for them; whether it deleted anything. */
  afterRemoval(): Promise<boolean>;
  /** What the sweep takes, which holds none of the run's records back: filled by `first`. */
  readonly automationMade: ReadonlySet<string>;
  /**
   * What the sweep did so far, recording and keeping nothing: what `settle`
   * says once it is through.
   */
  result(): ForgeSweepResult;
  /**
   * What the sweep did, recorded in the audit trail beside the removal, and
   * what it found made for the run kept for the next one: once, however
   * often it is asked.
   */
  settle(): Promise<ForgeSweepResult>;
}

/** How a removal's sweep is made, beside what it is told of the run. */
export interface RemovalSweepRequest {
  /** What the sweep is told of the run, read as the removal begins, or why it could not be. */
  input: () => Promise<SweepInput | { refused: string }>;
  /** The org it reads and deletes in: see {@link sweepOrgOf}. */
  org: SweepOrg;
  /** What the removal asked of it: what changed, what came late, what is tied to nothing. */
  options: Omit<SweepOptions, 'approve'>;
  /** Production Guard, which judges its deletes as the delete they are, before the first. */
  guard: ConsultedGuard;
  /** What the guard judges: a delete, in the org at the tier the run's writes took it for. */
  guardOf: { orgId: string; orgTier: SafetyTier; operation: 'delete'; module: string };
  /**
   * Told once what the sweep did and what Production Guard decided of it:
   * the audit trail's entry beside the removal's, a decision undefined for a
   * sweep that asked nothing.
   */
  onGuardDecision: (result: ForgeSweepResult, decision: GuardDecision | undefined) => void;
  /**
   * Keep what it found made for the run, for the next sweep
   * (`SweepTies.madeEarlier`), and what it found made late
   * (`SweepTies.lateEarlier`), but what it said gone (`SweepParts.gone`),
   * found now or kept before: no next sweep looks for it.
   */
  keepMade?: (
    made: ReadonlySet<string>,
    late: ReadonlySet<string>,
    gone: ReadonlySet<string>,
  ) => Promise<void>;
}

/**
 * The sweep of a removal, in its parts around the run's own records: what
 * the target's automation made for the run, as its user, that the run's id
 * map does not hold — only what is tied to the run's records, what came late
 * or is tied to nothing listed and kept unless the removal asks for it —
 * judged by Production Guard as a delete before the first one, then deleted,
 * children first, until the removal's Cancel. A part that throws ends the
 * sweep in failure, and the removal goes on; a sweep whose input could not
 * be read deletes nothing.
 */
export async function removalSweepOf(request: RemovalSweepRequest): Promise<RemovalSweep> {
  let guardDecision: GuardDecision | undefined;
  let parts: SweepParts | undefined;
  /** Why the sweep did not run, or what it failed on. */
  let stopped: ForgeSweepResult | undefined;
  try {
    const input = await request.input();
    if ('refused' in input) {
      stopped = { ...SWEEP_NOT_RUN, status: 'refused', refusal: input.refused };
    } else {
      parts = sweepParts(request.org, input, {
        ...request.options,
        approve: async (listing) => {
          const { check, decision } = await consultProductionGuard(request.guard, {
            ...request.guardOf,
            objectName: sweepFoundObjects(listing).join(', '),
            recordCount: sweepFoundCount(listing),
          });
          guardDecision = decision;
          if (decision === 'refused') {
            return `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`;
          }
          if (decision === 'declined')
            return 'Operation cancelled by user (confirmation declined).';
          return undefined;
        },
      });
    }
  } catch (err: unknown) {
    stopped = { ...SWEEP_NOT_RUN, status: 'failure', refusal: extractErrorMessage(err) };
  }
  const part = async (run: (sweep: SweepParts) => Promise<boolean>): Promise<boolean> => {
    if (!parts || stopped) return false;
    try {
      return await run(parts);
    } catch (err: unknown) {
      stopped = { ...parts.result(), status: 'failure', refusal: extractErrorMessage(err) };
      return false;
    }
  };
  let settled: Promise<ForgeSweepResult> | undefined;
  return {
    automationMade: parts?.automationMade ?? new Set<string>(),
    ask: async () => {
      await part(async (sweep) => {
        await sweep.ask();
        return false;
      });
    },
    get takes() {
      return stopped ? [] : (parts?.takes ?? []);
    },
    first: (allowance) => part((sweep) => sweep.first(allowance)),
    afterRemoval: () => part((sweep) => sweep.afterRemoval()),
    result: () => stopped ?? parts?.result() ?? SWEEP_NOT_RUN,
    settle: () => {
      settled ??= (async () => {
        const result = stopped ?? parts?.result() ?? SWEEP_NOT_RUN;
        request.onGuardDecision(result, guardDecision);
        // What it found made for the run, read before its first delete: once
        // a removal deleted the record one was tied to, the org may have
        // cleared the lookup that told it, and the next sweep listed it as
        // tied to nothing — or, made late, found it in no class. What it
        // said gone leaves what is kept.
        if (parts && (parts.made.size > 0 || parts.late.size > 0 || parts.gone.size > 0)) {
          await request.keepMade?.(parts.made, parts.late, parts.gone).catch(() => undefined);
        }
        return result;
      })();
      return settled;
    },
  };
}

/** The audit trail's code for a sweep refused: Production Guard's, or the sweep's own. */
export function sweepRefusalCode(guard: GuardDecision | undefined): string {
  return guard ? 'GUARD_BLOCKED' : 'SWEEP_REFUSED';
}

/**
 * A run of this machine that wrote to a target, as the sweep of another run's
 * removal there is told of it: its records, and when it wrote, in epoch
 * milliseconds — on the org's clock where the run kept the target's dates,
 * on this machine's otherwise.
 */
export interface LocalRun {
  ids: readonly string[];
  from: number;
  to: number;
  /**
   * Set for a run that wrote records nothing here names any more, or never
   * did: a Forge run past the bound whose journal is gone, a module that
   * keeps no run file (`auditedRunsOf`). What it wrote cannot be left out of
   * the sweep, but it counts as a run of the window all the same.
   */
  idsUntold?: true;
}

/**
 * The runs of the other modules of this machine on an org, as the sweep of a
 * module's run is told of them: put together where the handlers are
 * (`ExtensionHandlers`), each module keeping its runs its own way. Those of a
 * module alone left two runs of one user, a Sync run and a clone, to sweep
 * each other's records. When the run a sweep follows wrote is handed over for
 * what is costly to read outside of it.
 */
export type OtherModuleRuns = (
  targetOrgId: string,
  written: ForgeWrittenBetween | undefined,
) => Promise<LocalRun[]>;

/**
 * How far apart in time two runs may stand and still be taken to have
 * written in the same window: this machine's clock, which dates the runs that
 * kept no date of the org's, may stand a little off the org's.
 */
export const OTHER_RUN_LEEWAY_MS = 60_000;

/**
 * Of the runs of this machine, those that wrote to the target while the run
 * a sweep follows did, or in the span after it the sweep reads for what came
 * late (`LATE_WITHIN_MS`): their records are never swept, and while there is
 * one, what is tied to nothing is not either — whose it is cannot be told
 * (`SweepTies.otherRuns`). A run that cannot be dated, or with no record, is
 * none of them.
 */
export function otherRunsInSweep(
  written: ForgeWrittenBetween | undefined,
  runs: readonly LocalRun[],
): Array<{ ids: string[]; idsUntold?: true }> {
  return runs
    .filter((run) => (run.ids.length > 0 || run.idsUntold === true) && inSweepWindow(written, run))
    .map((run) => ({ ids: [...run.ids], ...(run.idsUntold ? { idsUntold: true as const } : {}) }));
}

/**
 * Whether a run of this machine wrote while the run a sweep follows did, or
 * in the span after it the sweep reads for what came late (`otherRunsInSweep`).
 */
export function inSweepWindow(
  written: ForgeWrittenBetween | undefined,
  run: Pick<LocalRun, 'from' | 'to'>,
): boolean {
  const first = Date.parse(written?.first ?? '');
  const last = Math.max(first, Date.parse(written?.last ?? ''));
  if (!Number.isFinite(first) || !Number.isFinite(last)) return false;
  return (
    Number.isFinite(run.from) &&
    Number.isFinite(run.to) &&
    run.from <= last + LATE_WITHIN_MS + OTHER_RUN_LEEWAY_MS &&
    Math.max(run.from, run.to) >= first - TIE_LEAD_MS - OTHER_RUN_LEEWAY_MS
  );
}

/**
 * The writes the audit trail alone keeps of: what no run file names, for a
 * sweep of another module's run. Only their end is dated: a run that wrote in
 * the window and ended past it, more than a quarter of an hour on, is not seen.
 */
const WRITES_WITH_NO_RUN_FILE: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'autopilot_execute',
  'anonymize_execute',
  'subject_erase',
  'backup_restore',
  'checkpoint_rewind',
  'checkpoint_undo',
  // A load keeps its mapping in its sas folder, which another module's sweep does not know.
  'frozen_load',
]);

/**
 * The runs the audit trail names of an org that no run file does, as the sweep
 * of a run of another module is told of them, dated by when each ended: what
 * they wrote is not named, and they count all the same. Nothing of a run that
 * was stopped before it wrote.
 *
 * @param own - The action of the module the sweep is for, which tells its own runs apart.
 */
export function auditedRunsOf(
  entries: ReadonlyArray<Pick<AuditLogEntry, 'action' | 'outcome' | 'timestamp'>>,
  own?: AuditAction,
): LocalRun[] {
  return entries
    .filter(
      (entry) =>
        WRITES_WITH_NO_RUN_FILE.has(entry.action) &&
        entry.action !== own &&
        entry.outcome !== 'stopped',
    )
    .map((entry) => {
      const at = Date.parse(entry.timestamp);
      return { ids: [], idsUntold: true, from: at, to: at };
    });
}

/**
 * A Sync or a Seed run kept on this machine as the sweep of another run's
 * removal is told of it: the records it created and wrote over, and when it
 * wrote, on this machine's clock — its first write to its last.
 */
export function keptRunOf(run: SyncRunKept): LocalRun {
  const from = Date.parse(run.firstWrittenAt ?? run.startedAt);
  const to = Date.parse(run.lastWriteAt ?? run.lastWrittenAt ?? run.end?.at ?? run.startedAt);
  return {
    ids: [...run.created, ...(run.overwritten ?? [])].flatMap(({ ids }) => ids),
    from,
    to: Number.isFinite(to) ? to : from,
  };
}

/** The runs among `runs` that wrote to an org, as a sweep is told of them, `except` left out. */
export function keptRunsOn(
  runs: readonly SyncRunKept[],
  targetOrgId: string,
  except?: string,
): LocalRun[] {
  return runs
    .filter((run) => run.targetOrgId === targetOrgId && run.runId !== except)
    .map(keptRunOf);
}

/**
 * What ties a record to a Sync or a Seed run beside its records (`SweepTies`):
 * the records of the other runs of this machine that wrote to its target in
 * its window — its module's, `kept`, and the other modules' —, when its first
 * removal began, and what the sweeps of its earlier removals found made for
 * it, and made late. What its mute kept quiet and what still ran, its file
 * does not keep.
 */
export async function keptRunTies(
  run: SyncRunKept,
  written: ForgeWrittenBetween | undefined,
  kept: readonly SyncRunKept[],
  otherModules: OtherModuleRuns,
): Promise<Omit<SweepTies, 'writtenOver'>> {
  const elsewhere = await otherModules(run.targetOrgId, written).catch(() => []);
  const began = removalBeganOf(run.removal?.removalSpans);
  const made = run.removal?.madeEarlier;
  const late = run.removal?.lateEarlier;
  return {
    otherRuns: otherRunsInSweep(written, [
      ...keptRunsOn(kept, run.targetOrgId, run.runId),
      ...elsewhere,
    ]),
    ...(began ? { removalBegan: began } : {}),
    ...(made && made.length > 0 ? { madeEarlier: made } : {}),
    ...(late && late.length > 0 ? { lateEarlier: late } : {}),
  };
}

/**
 * A Sync or a Seed run's removal state with what its sweep found made for it
 * and made late kept beside what earlier sweeps found (`SweepTies.madeEarlier`,
 * `SweepTies.lateEarlier`), as a Frozen load keeps both: what came late and
 * was left, its tie gone with the run's record, was found in no class by the
 * next sweep, and `--sweep-late` took nothing of it. What the sweep said gone
 * is kept no more.
 */
export function withSweepFinds(
  state: SyncRunRemovalState,
  made: Iterable<string>,
  late: Iterable<string>,
  gone: Iterable<string> = [],
): SyncRunRemovalState {
  const said = [...gone];
  const madeEarlier = madeKept(state.madeEarlier, made, said);
  const lateEarlier = madeKept(state.lateEarlier, late, said);
  const rest = { ...state };
  delete rest.madeEarlier;
  delete rest.lateEarlier;
  return {
    ...rest,
    ...(madeEarlier.length > 0 ? { madeEarlier } : {}),
    ...(lateEarlier.length > 0 ? { lateEarlier } : {}),
  };
}

/**
 * When the earliest of a run's removals that wrote began, on the org's clock
 * (`SweepTies.removalBegan`): what was created since is a removal's doing.
 */
export function removalBeganOf(
  spans: ReadonlyArray<{ first: string }> | undefined,
): string | undefined {
  let earliest: { at: number; first: string } | undefined;
  for (const span of spans ?? []) {
    const at = Date.parse(span.first);
    if (Number.isFinite(at) && (!earliest || at < earliest.at))
      earliest = { at, first: span.first };
  }
  return earliest?.first;
}
