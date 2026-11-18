/**
 * What SandForge keeps of a sandbox on this machine, read for its way back
 * into service: the steps are deduced from it (`recoveryStatus.ts`), never
 * from the org, which is asked nothing here.
 *
 * - **The org the sandbox is now** is the one its newest refresh made it, as
 *   the sandbox answered it — never `SalesforceOrg.orgId`, which stays the
 *   Organization Id the entry was registered with. A refresh only
 *   production's history reported names no org yet: nothing of the org now
 *   is read until the sandbox answers, rather than the runs of the org it
 *   was taken for its own. Without a refresh, the org the sandbox answered
 *   as last.
 * - **The org it was before** is the one the refresh names, else the one the
 *   detector still holds for a refresh production alone reported.
 * - **Runs, checkpoints, replays and notes** are filed by Organization Id, in
 *   the stores the command line shares (`~/.sandforge`); **the inventories**
 *   by the sandbox's My Domain host, which survives the refresh; **the
 *   masking runs and the frozen loads** in the audit trail of the window,
 *   by entry, since the refresh was noticed; **what a person acknowledged**
 *   under the refresh's key.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AUDIT_TRAIL_LIMIT,
  checkpointOrganizationIdSchema,
  guardTierOf,
  hostSchema,
  isDevelopmentOrg,
  orgDisplayName,
  recoveryAckKey,
  recoveryAcksSchema,
  type AuditAction,
  type RecoveryAcks,
  type RecoveryStatus,
  type SalesforceOrg,
} from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../audit/auditTrail.js';
import { readInventories } from '../audit/auditStore.js';
import { myDomainHostOf } from '../audit/orgHost.js';
import { organizationKey, type OrgCheckpointStore } from '../checkpoint/OrgCheckpointStore.js';
import type { ReplayStore } from '../checkpoint/replay/replayStore.js';
import { parseManifest } from '../frozendataset/manifest.js';
import type { DetectedSandboxRefresh } from '../monitor/SandboxRefreshDetector.js';
import type { UsersRunStore } from '../users/usersRunStore.js';
import { lastHandoffOf } from './recoveryHandoff.js';
import { refreshKeyOf } from './recoveryProgress.js';
import type { RecoveryFacts } from './recoveryStatus.js';
import { readSavedTesters, recoveryTestersKey } from './recoveryUsers.js';

/** What a sandbox's acknowledgements are keyed by while no refresh of it was noticed. */
export const NO_REFRESH_KEY = 'none';

/** Where SandForge keeps what the facts are read from. */
export interface RecoveryFactsDeps {
  configStore: Pick<ConfigStore, 'get' | 'set' | 'getByCategory'>;
  /** The registered org: `OrgManager.getOrg`. */
  orgOf(entryId: string): SalesforceOrg | undefined;
  /** `SandboxRefreshDetector.refreshesOf`, newest first. */
  refreshesOf(entryId: string): readonly DetectedSandboxRefresh[];
  /** `SandboxRefreshDetector.organizationIdOf`: the org a sandbox answered as last. */
  organizationIdOf(entryId: string): string | undefined;
  /** The checkpoints, shared with the command line. */
  checkpoints(): Promise<Pick<OrgCheckpointStore, 'list'>>;
  /** The replays of the checkpoints into other orgs. */
  replays(): Pick<ReplayStore, 'list'>;
  /** The users runs. */
  users(): Pick<UsersRunStore, 'list'>;
  /** The command lines' folder: the inventories of the jobs and the handoff notes. */
  journalDir: string;
  /** Where the frozen dataset is kept, as the Frozen Dataset page names it. */
  frozenDatasetDir(): string;
  /** How many users the last list read of an org found to bring back, when one was read. */
  usersListed?(entryId: string, organizationId: string): number | undefined;
}

/** Why there are no facts to tell of an entry: it is not registered, or is a production org. */
export type RecoveryFactsRefusal = 'ORG_NOT_FOUND' | 'NOT_A_DEVELOPMENT_ORG';

/** An Organization Id, when `id` is one. */
function organizationIdOrNone(id: string | undefined): string | undefined {
  return id !== undefined && checkpointOrganizationIdSchema.safeParse(id).success ? id : undefined;
}

/** Whether two Organization Ids name one org, whatever their form. */
function sameOrg(a: string, b: string): boolean {
  return organizationKey(a) === organizationKey(b);
}

/** Text of at most `max` characters, else none: what the contract holds of a name. */
function boundedOrNone(text: string | undefined, max: number): string | undefined {
  return text !== undefined && text !== '' && text.length <= max ? text : undefined;
}

/**
 * The key a sandbox's acknowledgements are kept under: its newest refresh's
 * ({@link refreshKeyOf}), or {@link NO_REFRESH_KEY} while none was noticed —
 * a step skipped on a sandbox no refresh was noticed on is not skipped after
 * the next one.
 */
export function recoveryAckKeyOf(
  entryId: string,
  refresh: DetectedSandboxRefresh | undefined,
  organizationIdOf: (entryId: string) => string | undefined,
): string {
  return recoveryAckKey(
    entryId,
    refresh !== undefined ? refreshKeyOf(refresh, organizationIdOf) : NO_REFRESH_KEY,
  );
}

/** The acknowledgements kept under `key`; none when nothing that reads is kept. */
export function readAcks(configStore: Pick<ConfigStore, 'get'>, key: string): RecoveryAcks {
  const parsed = recoveryAcksSchema.safeParse(configStore.get<unknown>(key));
  return parsed.success ? parsed.data : { steps: {} };
}

/**
 * Where the frozen dataset is kept, as the Frozen Dataset page and
 * `sandforge frozen` resolve it: the folder its configuration names, else
 * `dataset` in its sas, else in `~/.sandforge-sas`.
 */
export function frozenDatasetDirOf(
  configStore: Pick<ConfigStore, 'get'>,
  home: string = homedir(),
): string {
  const config = configStore.get<{ sasDir?: unknown; datasetDir?: unknown }>('frozen:config');
  if (typeof config?.datasetDir === 'string' && config.datasetDir !== '') return config.datasetDir;
  const sas =
    typeof config?.sasDir === 'string' && config.sasDir !== ''
      ? config.sasDir
      : join(home, '.sandforge-sas');
  return join(sas, 'dataset');
}

/** The frozen dataset kept in `datasetDir`, as the page shows it; none when its manifest does not read. */
async function frozenManifestOf(
  datasetDir: string,
): Promise<RecoveryFacts['frozenManifest'] | undefined> {
  let text: string;
  try {
    text = await readFile(join(datasetDir, 'manifest.json'), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const manifest = parseManifest(JSON.parse(text));
    const measured = Object.values(manifest.volumetry.measured);
    const sourceAlias = boundedOrNone(manifest.source.orgAlias, 255);
    return {
      frozenAt: new Date(manifest.frozenAt).toISOString(),
      ...(sourceAlias !== undefined ? { sourceAlias } : {}),
      objects: measured.length,
      records: measured.reduce((sum, count) => sum + Math.max(0, Math.trunc(count)), 0),
    };
  } catch {
    return undefined;
  }
}

/** When the newest run of `action` on the entry since `since` ended a success. */
function lastSuccessOf(
  configStore: Pick<ConfigStore, 'get' | 'set'>,
  entryId: string,
  action: AuditAction,
  since: string | undefined,
): string | undefined {
  const from = since !== undefined ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  const entry = new AuditTrailStore(configStore)
    .list({ orgId: entryId, limit: AUDIT_TRAIL_LIMIT })
    .entries.find(
      (one) =>
        one.action === action && one.outcome === 'success' && Date.parse(one.timestamp) > from,
    );
  return entry?.timestamp;
}

/** Whether a saved pipeline starts on the refresh of the entry. */
function refreshPipelineOf(
  configStore: Pick<ConfigStore, 'getByCategory'>,
  entryId: string,
): boolean {
  return Object.values(configStore.getByCategory('pipelines')).some((saved) => {
    const triggers = (saved as { triggers?: unknown } | null)?.triggers;
    return (
      Array.isArray(triggers) &&
      triggers.some((trigger: unknown) => {
        const one = trigger as {
          type?: unknown;
          enabled?: unknown;
          config?: { orgId?: unknown };
        } | null;
        return (
          one?.type === 'sandbox_refresh' && one.enabled !== false && one.config?.orgId === entryId
        );
      })
    );
  });
}

/** The refresh as the page shows it. */
function refreshOf(
  refresh: DetectedSandboxRefresh,
  before: string | undefined,
  orgOf: RecoveryFactsDeps['orgOf'],
): NonNullable<RecoveryStatus['refresh']> {
  const after = organizationIdOrNone(refresh.organizationId);
  const previousInstanceName = boundedOrNone(refresh.previousInstanceName, 40);
  const instanceName = boundedOrNone(refresh.instanceName, 40);
  const production = refresh.reportedBy !== undefined ? orgOf(refresh.reportedBy) : undefined;
  const reportedBy = boundedOrNone(
    production !== undefined ? orgDisplayName(production, production.username) : undefined,
    255,
  );
  return {
    detectedAt: new Date(refresh.detectedAt).toISOString(),
    evidence: refresh.evidence,
    ...(before !== undefined ? { previousOrganizationId: before } : {}),
    ...(after !== undefined ? { organizationId: after } : {}),
    ...(previousInstanceName !== undefined ? { previousInstanceName } : {}),
    ...(instanceName !== undefined ? { instanceName } : {}),
    ...(reportedBy !== undefined ? { reportedBy } : {}),
    // Every refresh noticed forgets what was cached of the org before
    // (`ExtensionHandlers.forgetOrg`), before anything reads it again.
    cachesForgotten: true,
  };
}

/** The org's checkpoints taken to their end, newest first. */
async function readyCheckpointsOf(
  store: Pick<OrgCheckpointStore, 'list'>,
  organizationId: string,
): Promise<
  Array<{ checkpointId: string; name: string; takenAt: string; keptUntilDeleted: boolean }>
> {
  const listed = await store.list({ organizationId });
  return listed
    .flatMap((entry) =>
      entry.checkpoint?.status === 'ready'
        ? [
            {
              checkpointId: entry.checkpointId,
              name: entry.checkpoint.name,
              takenAt: new Date(entry.checkpoint.takenAt).toISOString(),
              keptUntilDeleted: entry.checkpoint.expiresAt === null,
            },
          ]
        : [],
    )
    .sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt));
}

/**
 * What SandForge keeps of a registered org, read for its recovery: see the
 * module's comment. A production org, or one the registry does not know, has
 * none.
 */
export async function recoveryFactsOf(
  deps: RecoveryFactsDeps,
  entryId: string,
): Promise<{ facts: RecoveryFacts } | { refused: RecoveryFactsRefusal }> {
  const org = deps.orgOf(entryId);
  if (org === undefined) return { refused: 'ORG_NOT_FOUND' };
  if (!isDevelopmentOrg(org)) return { refused: 'NOT_A_DEVELOPMENT_ORG' };
  const tier = guardTierOf(org);
  if (tier === 'production') return { refused: 'NOT_A_DEVELOPMENT_ORG' };

  const kind =
    org.orgType === 'Sandbox' ? 'sandbox' : org.orgType === 'Scratch' ? 'scratch' : 'developer';
  // The detector follows sandboxes alone.
  const refresh = kind === 'sandbox' ? deps.refreshesOf(entryId)[0] : undefined;
  const now =
    refresh !== undefined
      ? organizationIdOrNone(refresh.organizationId)
      : organizationIdOrNone(deps.organizationIdOf(entryId) ?? org.orgId);
  const before =
    refresh !== undefined
      ? organizationIdOrNone(
          refresh.previousOrganizationId ??
            (refresh.organizationId === undefined ? deps.organizationIdOf(entryId) : undefined),
        )
      : undefined;
  const host = myDomainHostOf(org.instanceUrl);
  const myDomainHost = host !== undefined && hostSchema.safeParse(host).success ? host : undefined;
  const since = refresh?.detectedAt;

  const store = await deps.checkpoints();
  const checkpointsBefore = before !== undefined ? await readyCheckpointsOf(store, before) : [];
  const checkpointsNow = now !== undefined ? await readyCheckpointsOf(store, now) : [];
  const newestBefore = checkpointsBefore[0];

  let replayedAt: string | undefined;
  if (before !== undefined && now !== undefined) {
    replayedAt = (
      await deps.replays().list({ sourceOrganizationId: before, targetOrganizationId: now })
    )
      .flatMap((replay) =>
        replay.replayedAt !== undefined && replay.removed !== true ? [replay.replayedAt] : [],
      )
      .sort()
      .at(-1);
  }

  const runs = now !== undefined ? await deps.users().list(now) : [];
  const lastRun = runs.find((run) => run.status !== 'running');

  let inventoryBefore: RecoveryFacts['inventoryBefore'];
  let inventoryNowAt: string | undefined;
  if (myDomainHost !== undefined) {
    const { kept } = await readInventories(deps.journalDir, myDomainHost);
    const of = (one: (typeof kept)[number]): boolean =>
      now !== undefined && sameOrg(one.inventory.organizationId, now);
    const earlier = kept.find((one) => !of(one));
    if (earlier !== undefined) {
      inventoryBefore = {
        savedAt: earlier.inventory.savedAt,
        organizationId: earlier.inventory.organizationId,
        jobs: earlier.inventory.jobs.length,
      };
    }
    inventoryNowAt = kept.find(of)?.inventory.savedAt;
  }

  const testers = readSavedTesters(deps.configStore, recoveryTestersKey(myDomainHost, entryId));
  const frozenManifest = await frozenManifestOf(deps.frozenDatasetDir());
  const handoffAt = now !== undefined ? await lastHandoffOf(deps.journalDir, now) : undefined;
  const usersToBringBack = now !== undefined ? deps.usersListed?.(entryId, now) : undefined;
  const maskedAt = lastSuccessOf(deps.configStore, entryId, 'anonymize_execute', since);
  const frozenLoadedAt = lastSuccessOf(deps.configStore, entryId, 'frozen_load', since);

  const facts: RecoveryFacts = {
    orgId: entryId,
    alias: orgDisplayName(org, org.username) || entryId,
    tier,
    kind,
    ...(kind === 'sandbox' && org.sandboxType !== undefined
      ? { sandboxType: org.sandboxType }
      : {}),
    ...(myDomainHost !== undefined ? { myDomainHost } : {}),
    ...(now !== undefined ? { organizationId: now } : {}),
    ...(refresh !== undefined ? { refresh: refreshOf(refresh, before, deps.orgOf) } : {}),
    acks: readAcks(
      deps.configStore,
      recoveryAckKeyOf(entryId, refresh, (id) => deps.organizationIdOf(id)),
    ),
    ...(newestBefore !== undefined
      ? {
          checkpointBefore: {
            checkpointId: newestBefore.checkpointId,
            name: newestBefore.name,
            takenAt: newestBefore.takenAt,
          },
        }
      : {}),
    ...(replayedAt !== undefined ? { replayedAt } : {}),
    checkpointsNow: checkpointsNow.map(({ takenAt, keptUntilDeleted }) => ({
      takenAt,
      keptUntilDeleted,
    })),
    ...(lastRun !== undefined
      ? {
          lastUsersRun: {
            run: lastRun.run,
            at: lastRun.endedAt ?? lastRun.startedAt,
            status: lastRun.status as NonNullable<RecoveryFacts['lastUsersRun']>['status'],
          },
        }
      : {}),
    ...(usersToBringBack !== undefined ? { usersToBringBack } : {}),
    ...(maskedAt !== undefined ? { maskedAt } : {}),
    ...(frozenLoadedAt !== undefined ? { frozenLoadedAt } : {}),
    ...(frozenManifest !== undefined ? { frozenManifest } : {}),
    ...(inventoryBefore !== undefined ? { inventoryBefore } : {}),
    ...(inventoryNowAt !== undefined ? { inventoryNowAt } : {}),
    ...(handoffAt !== undefined ? { handoffAt } : {}),
    ...(testers !== undefined ? { testersSavedAt: testers.savedAt } : {}),
    refreshPipeline: refreshPipelineOf(deps.configStore, entryId),
  };
  return { facts };
}
