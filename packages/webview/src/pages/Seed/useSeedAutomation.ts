import { useMemo } from 'react';
import type { SeedAutomationPreview } from '@sandforge/shared';
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
 * Whether the seed's records, at the counts set, would take the org past what
 * it has left today of a daily email limit, as the read says: the extension
 * would refuse the run, and Start waits. Not when nothing was read.
 *
 * @param records - The records the seed creates, by object.
 */
export function refusedForEmails(
  automation: Pick<SeedAutomationState, 'preview'>,
  records: Readonly<Record<string, number>>,
): boolean {
  return (
    automation.preview !== null &&
    seedEmailsRefused(seedEmailEstimates(automation.preview, records))
  );
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
