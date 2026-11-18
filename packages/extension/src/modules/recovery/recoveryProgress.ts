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
  /** The registered org: `OrgManager.getOrg`. */
  orgOf(entryId: string): SalesforceOrg | undefined;
  /** Where a person's acknowledgements are kept, under `recoveryAckKey`. */
  configStore: Pick<ConfigStore, 'get'>;
}

/**
 * What a refresh's acknowledgements are keyed by: the Organization Id the
 * sandbox was before it, which a refresh noticed by the sandbox or by
 * production's history always names; else the instant it was noticed.
 */
export function refreshKeyOf(refresh: DetectedSandboxRefresh): string {
  return refresh.previousOrganizationId ?? refresh.detectedAt;
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
      deps.configStore.get<unknown>(recoveryAckKey(entryId, refreshKeyOf(refresh))),
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
