import {
  RECOVERY_STEP_COUNT,
  orgDisplayName,
  recoveryAckKey,
  recoveryAcksSchema,
} from '@sandforge/shared';
import type { RecoveryProgress, SalesforceOrg } from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { DetectedSandboxRefresh } from '../monitor/SandboxRefreshDetector.js';

/**
 * How far a refreshed sandbox is back into service, as the launcher shows it
 * under its hero: n of N steps, until the recovery is finished.
 */
export interface RecoveryProgressSource {
  /**
   * The progress of the newest refresh noticed on a registered entry, or
   * undefined: none was noticed, the entry is no sandbox, or its recovery was
   * finished.
   */
  progressOf(entryId: string): RecoveryProgress | undefined;
  /**
   * Called each time a progress may have changed (a step done, skipped or
   * finished), so the launcher asks again; absent, the launcher asks on its
   * own occasions alone (a refresh noticed, its view shown). The returned
   * object stops the calls.
   */
  onDidChange?(listener: () => void): { dispose(): void };
}

/** What {@link detectorProgressSource} reads. */
export interface DetectorProgressDeps {
  /** The refreshes noticed on a registered entry, newest first: `SandboxRefreshDetector.refreshesOf`. */
  refreshesOf(entryId: string): readonly DetectedSandboxRefresh[];
  /**
   * The Organization Id a registered sandbox answered as last:
   * `SandboxRefreshDetector.organizationIdOf`. What keys a refresh only
   * production's history reported, until the sandbox answers.
   */
  organizationIdOf?(entryId: string): string | undefined;
  /** The registered org: `OrgManager.getOrg`. */
  orgOf(entryId: string): SalesforceOrg | undefined;
  /** Where a person's acknowledgements are kept, under `recoveryAckKey`. */
  configStore: Pick<ConfigStore, 'get'>;
}

/**
 * What a refresh's acknowledgements are keyed by: the Organization Id the
 * sandbox was before it. A refresh the sandbox answered for names it; one
 * only production's history reported names none until the sandbox answers,
 * and the org the sandbox answered as last, which the detector still holds,
 * is that org: the key a pipeline started by the refresh is told apart by
 * too, and the one the refresh names once the sandbox answers. Else, nothing
 * known of the org before, the instant it was noticed.
 *
 * @param organizationIdOf - `SandboxRefreshDetector.organizationIdOf`.
 */
export function refreshKeyOf(
  refresh: DetectedSandboxRefresh,
  organizationIdOf?: (entryId: string) => string | undefined,
): string {
  return (
    refresh.previousOrganizationId ??
    (refresh.organizationId === undefined ? organizationIdOf?.(refresh.orgId) : undefined) ??
    refresh.detectedAt
  );
}

/**
 * The progress the refresh detector alone can tell: a refresh noticed, and
 * none of its steps known done, out of every step there is. A recovery a
 * person finished is shown no more, until the sandbox is refreshed again.
 * Acknowledgements that cannot be read hide nothing: the launcher keeps
 * offering the page rather than dropping a refresh nobody worked through.
 */
export function detectorProgressSource(deps: DetectorProgressDeps): RecoveryProgressSource {
  const finished = (entryId: string, refresh: DetectedSandboxRefresh): boolean => {
    const acks = recoveryAcksSchema.safeParse(
      deps.configStore.get<unknown>(
        recoveryAckKey(entryId, refreshKeyOf(refresh, deps.organizationIdOf)),
      ),
    );
    return acks.success && acks.data.finishedAt !== undefined;
  };
  return {
    progressOf(entryId) {
      const org = deps.orgOf(entryId);
      // The detector follows sandboxes alone: a record of another kind of
      // org is none of the page's business.
      if (org?.orgType !== 'Sandbox') return undefined;
      const [latest] = deps.refreshesOf(entryId);
      if (latest === undefined || finished(entryId, latest)) return undefined;
      return {
        orgId: entryId,
        alias: orgDisplayName(org, org.username),
        detectedAt: latest.detectedAt,
        done: 0,
        total: RECOVERY_STEP_COUNT,
      };
    },
  };
}

/** How far a recovery is, counted from its steps. */
export interface RecoveryCount {
  done: number;
  total: number;
}

/** What {@link deducedProgressSource} reads, beside what the detector knows. */
export interface DeducedProgressDeps extends DetectorProgressDeps {
  /**
   * Where a sandbox stands, each step deduced from what SandForge keeps
   * (`recoveryProgressOf` of its status); undefined when nothing can be told
   * of it. Reads this machine, never the org.
   */
  statusOf(entryId: string): Promise<RecoveryCount | undefined>;
  /** How long a count is held before the steps are deduced again. */
  ttlMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** A progress deduced from the steps, which can be told a step changed. */
export interface DeducedProgressSource extends RecoveryProgressSource {
  onDidChange(listener: () => void): { dispose(): void };
  /**
   * A step of `entryId` may have changed, or of every sandbox when none is
   * named: its steps are deduced again at once, the count it had shown
   * meanwhile, and the launcher is told to ask.
   */
  invalidate(entryId?: string): void;
}

/** What a count is held for: long enough for a launcher shown twice, short enough for a run of another page. */
export const RECOVERY_PROGRESS_TTL_MS = 30_000;

/**
 * The progress the launcher shows: whether a refresh of a sandbox is to be
 * worked through, and its recovery not finished, as the detector tells it at
 * once ({@link detectorProgressSource}); how far it is, n of N, as its steps
 * are deduced from what SandForge keeps.
 *
 * The launcher asks without waiting, so the steps are deduced behind it: the
 * first answer is the detector's, every step still to do of every step there
 * is, and the deduced count follows, the launcher told to ask again. A count
 * is held a short while, then deduced again on the next ask: a checkpoint
 * taken, a masking run or a replay run from another page shows within it. A
 * step the page changes is said at once ({@link DeducedProgressSource.invalidate}),
 * as is a refresh noticed. A deduction that fails keeps what was shown, and
 * is not tried again before the count would have been.
 */
export function deducedProgressSource(deps: DeducedProgressDeps): DeducedProgressSource {
  const detector = detectorProgressSource(deps);
  const ttlMs = deps.ttlMs ?? RECOVERY_PROGRESS_TTL_MS;
  const now = deps.now ?? (() => Date.now());
  /** The count deduced of each entry, for the refresh it was deduced of, and when. */
  const held = new Map<string, RecoveryCount & { detectedAt: string; at: number }>();
  /** When a deduction of each entry last failed. */
  const failedAt = new Map<string, number>();
  /** Bumped on each invalidation: a deduction begun before it is not kept. */
  const generations = new Map<string, number>();
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();

  const tell = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (err: unknown) {
        deps.log?.(`[recovery] a listener of the progress failed: ${String(err)}`);
      }
    }
  };

  const deduce = (entryId: string, base: RecoveryProgress): void => {
    if (inFlight.has(entryId)) return;
    const failed = failedAt.get(entryId);
    if (failed !== undefined && now() - failed < ttlMs) return;
    const generation = generations.get(entryId) ?? 0;
    inFlight.add(entryId);
    deps.statusOf(entryId).then(
      (counted) => {
        inFlight.delete(entryId);
        failedAt.delete(entryId);
        if ((generations.get(entryId) ?? 0) !== generation) {
          // Invalidated meanwhile: deduced again, from what holds now.
          deduce(entryId, base);
          return;
        }
        const before = held.get(entryId);
        const shown = before !== undefined && before.detectedAt === base.detectedAt ? before : base;
        if (counted === undefined) {
          held.delete(entryId);
          return;
        }
        held.set(entryId, { ...counted, detectedAt: base.detectedAt, at: now() });
        if (shown.done !== counted.done || shown.total !== counted.total) tell();
      },
      (err: unknown) => {
        inFlight.delete(entryId);
        failedAt.set(entryId, now());
        deps.log?.(
          `[recovery] the steps of ${entryId} could not be deduced: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  };

  return {
    progressOf(entryId) {
      const base = detector.progressOf(entryId);
      if (base === undefined) return undefined;
      const known = held.get(entryId);
      const ofThisRefresh = known !== undefined && known.detectedAt === base.detectedAt;
      if (!ofThisRefresh || now() - known.at >= ttlMs) deduce(entryId, base);
      return ofThisRefresh ? { ...base, done: known.done, total: known.total } : base;
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    invalidate(entryId) {
      const ids = entryId !== undefined ? [entryId] : [...held.keys()];
      for (const id of ids) {
        generations.set(id, (generations.get(id) ?? 0) + 1);
        failedAt.delete(id);
        const known = held.get(id);
        // Shown until deduced again: a count that drops to 0 of N between two
        // answers would read as a recovery started over.
        if (known !== undefined) held.set(id, { ...known, at: Number.NEGATIVE_INFINITY });
      }
      tell();
    },
  };
}
