import { useMemo } from 'react';
import type {
  MuteAssignment,
  MutePlan,
  MutedAutomationSilenced,
  MutedAutomationStillRunning,
  SeedAutomationPreview,
} from '@sandforge/shared';
import { seedEmailEstimates, seedEmailsRefused } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';

/**
 * How long the read of what the org runs may take: its flows, triggers,
 * processes and rules, their start conditions, the permission sets of a
 * bypass, then its limits. The extension stops it at a minute and says so.
 */
const AUTOMATION_READ_TIMEOUT_MS = 90_000;

/** What `seed:automation` answers. */
interface SeedAutomationAnswer {
  orgId: string;
  objects: string[];
  preview: SeedAutomationPreview;
}

/** What the confirmation knows of what the org runs as the seed's records are created. */
export interface SeedAutomationState {
  /**
   * What was read for the org and the objects asked about; null before. Kept
   * while the same org and objects are read again, until the new answer.
   */
  preview: SeedAutomationPreview | null;
  /** Whether the read is on its way. */
  loading: boolean;
  /** Why the read could not run at all; null otherwise. */
  error: string | null;
  /** Read it again, as it stands now: a bypass assigned since shows as held. */
  readAgain: () => void;
}

/**
 * The read as a seed counts its emails: with the mute ticked, those of what
 * still runs while it holds, as the extension counts them; every sender's
 * otherwise. Counting the senders the mute silences, Start was held back past
 * a day's limit the muted run would not reach.
 */
export function emailsCountedFor(
  preview: SeedAutomationPreview,
  muted: boolean,
): SeedAutomationPreview {
  return muted && preview.emailsPerRecordMuted
    ? { ...preview, emailsPerRecord: preview.emailsPerRecordMuted }
    : preview;
}

/**
 * Whether the seed's records, at the counts set, would take the org past what
 * it has left today of a daily email limit, as the read says: the extension
 * would refuse the run, and Start waits. Not when nothing was read.
 *
 * @param records - The records the seed creates, by object.
 * @param muted - Whether the seed is to mute the org's automation: then only
 *   what still runs counts.
 */
export function refusedForEmails(
  automation: Pick<SeedAutomationState, 'preview'>,
  records: Readonly<Record<string, number>>,
  muted = false,
): boolean {
  return (
    automation.preview !== null &&
    seedEmailsRefused(seedEmailEstimates(emailsCountedFor(automation.preview, muted), records))
  );
}

/**
 * What a seed asked to mute the org's automation would do, planned from the
 * confirmation's read, as the extension plans it from its own: each flow,
 * process or workflow rule the records fire whose condition tests a bypass
 * the user the seed writes as lacks, and that a permission set of the org
 * holds, is silenced by that set; an Apex trigger, an entry whose condition
 * was not read, or one with no such set still runs. What a bypass the user
 * holds keeps quiet is in neither. The preview names a bypass's set alone,
 * not who installed a flow: one a managed package installed is told by the
 * run's result. Where the extension planned the mute itself, its plan is the
 * one: it says what the sets lift beside what they silence, which only the
 * read of what they grant tells.
 */
export function seedMutePlanOf(preview: SeedAutomationPreview): MutePlan {
  if (preview.mute) return preview.mute;
  const setOf = new Map(
    preview.bypasses.flatMap((way) =>
      way.permissionSet ? [[way.permission.toLowerCase(), way.permissionSet] as const] : [],
    ),
  );
  const assign: MuteAssignment[] = [];
  const silenced: MutedAutomationSilenced[] = [];
  const stillRuns: MutedAutomationStillRunning[] = [];
  for (const object of preview.objects) {
    for (const entry of object.entries) {
      if (entry.keptQuiet) continue;
      const named = { objectApiName: object.objectApiName, kind: entry.kind, name: entry.name };
      const lacking =
        entry.kind === 'trigger' ? [] : entry.bypasses.filter((bypass) => bypass.held !== true);
      const silencing = lacking.find((bypass) => setOf.has(bypass.name.toLowerCase()));
      if (silencing) {
        const permissionSet = setOf.get(silencing.name.toLowerCase()) ?? '';
        const chosen = assign.find((set) => set.permissionSet === permissionSet);
        // A custom permission's name is told apart from another's whatever its case.
        const sameName = (permission: string): boolean =>
          permission.toLowerCase() === silencing.name.toLowerCase();
        if (!chosen) {
          assign.push({ permissionSet, label: permissionSet, permissions: [silencing.name] });
        } else if (!chosen.permissions.some(sameName)) {
          chosen.permissions.push(silencing.name);
        }
        silenced.push({ ...named, permission: silencing.name });
        continue;
      }
      stillRuns.push({
        ...named,
        why: lacking.length > 0 ? 'noPermissionSet' : entry.unread ? 'notRead' : 'noBypass',
      });
    }
  }
  for (const set of assign) set.permissions.sort((a, b) => a.localeCompare(b));
  return { assign, silenced, stillRuns };
}

/**
 * What `orgId` runs as a seed creates the records of `objects`, read before
 * Start, once per org and set of objects: a count changed is counted from
 * the same read. Nothing is asked without an org or an object.
 */
export function useSeedAutomation(orgId: string, objects: readonly string[]): SeedAutomationState {
  const key = objects.join(',');
  const payload = useMemo(() => ({ orgId, objects: key ? key.split(',') : [] }), [orgId, key]);
  const query = useBridgeQuery<SeedAutomationAnswer>('seed:automation', payload, {
    errorType: 'seed:automation:error',
    timeoutMs: AUTOMATION_READ_TIMEOUT_MS,
    skip: !orgId || objects.length === 0,
  });
  const { data, loading, error, refetch } = query;
  // An answer for another org or other objects, kept from before, says nothing of these.
  const current = data && data.orgId === orgId && data.objects.join(',') === key ? data : null;
  return useMemo(
    () => ({
      preview: current?.preview ?? null,
      loading,
      error: loading ? null : error,
      readAgain: refetch,
    }),
    [current, loading, error, refetch],
  );
}
