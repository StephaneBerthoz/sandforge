import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BaseMessage,
  RecoveryProgress,
  RecoveryStatus,
  RecoveryStepId,
  SalesforceOrg,
} from '@sandforge/shared';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useMessageListener } from '../../hooks/useMessageBus';

/** What Home knows of the refreshed sandboxes: what its hero reads. */
export interface RecoveryLeads {
  /** The sandboxes whose refresh was noticed, n of N steps each, as `heroFor` reads them. */
  afterRefresh: RecoveryProgress[];
  /**
   * The step a sandbox's recovery is at: the first still to do, else the
   * first refused, which Finish alone ends. Undefined when every step is done,
   * skipped or does not apply, or the sandbox was not asked about.
   */
  nextStepOf: (orgId: string) => RecoveryStepId | undefined;
}

/** `recovery:status:response`, as far as Home reads it. */
type StatusAnswer = BaseMessage & { payload?: { status?: unknown } };

/**
 * Whether an answer holds a status Home can read: the extension validates
 * what it sends, and Home, which parses no schema on its first paint, reads
 * only the fields its hero shows.
 */
function isStatus(value: unknown): value is RecoveryStatus {
  if (typeof value !== 'object' || value === null) return false;
  const status = value as Record<string, unknown>;
  return (
    typeof status.orgId === 'string' &&
    typeof status.alias === 'string' &&
    typeof status.done === 'number' &&
    typeof status.total === 'number' &&
    Array.isArray(status.steps)
  );
}

/** The registered sandboxes, by entry: the only kind of org a refresh happens to. */
function sandboxIdsOf(orgs: readonly SalesforceOrg[] | undefined): string[] {
  return (orgs ?? [])
    .filter((org) => org.orgType === 'Sandbox')
    .map((org) => org.id)
    .sort();
}

/**
 * Where each registered sandbox stands after its refresh, asked of the
 * extension (`recovery:status`, the question the Back into service page asks)
 * as Home opens and whenever the sandboxes registered change.
 *
 * The launcher hears of the refreshes on a channel of its own; Home, a panel,
 * asks. Each sandbox is asked once: the answer is deduced from what SandForge
 * keeps on this machine, the org itself is not read. A sandbox the extension
 * refuses or does not answer for leads nothing, and Home keeps the hero the
 * other rules give.
 */
export function useRecoveryLeads(orgs: readonly SalesforceOrg[] | undefined): RecoveryLeads {
  const [statuses, setStatuses] = useState<Readonly<Record<string, RecoveryStatus>>>({});
  /** The requests this page sent: an answer to another is none of its business. */
  const asked = useRef(new Set<string>());
  const sandboxIds = sandboxIdsOf(orgs);
  const key = sandboxIds.join('\n');

  useEffect(() => {
    if (key === '') return;
    for (const orgId of key.split('\n')) {
      asked.current.add(sendBridgeMessage('recovery:status', { orgId }));
    }
  }, [key]);

  useMessageListener<StatusAnswer>(
    'recovery:status:response',
    useCallback((msg) => {
      if (msg.correlationId === undefined || !asked.current.has(msg.correlationId)) return;
      asked.current.delete(msg.correlationId);
      const status = msg.payload?.status;
      if (!isStatus(status)) return;
      setStatuses((held) => ({ ...held, [status.orgId]: status }));
    }, []),
  );

  return useMemo(() => {
    const registered = new Set(key.split('\n'));
    const known = Object.values(statuses).filter((status) => registered.has(status.orgId));
    const afterRefresh = known.flatMap((status) =>
      status.refresh === undefined
        ? []
        : [
            {
              orgId: status.orgId,
              alias: status.alias,
              detectedAt: status.refresh.detectedAt,
              done: status.done,
              total: status.total,
            },
          ],
    );
    const nextStepOf = (orgId: string): RecoveryStepId | undefined => {
      const steps = statuses[orgId]?.steps ?? [];
      return (
        steps.find((step) => step.status === 'todo') ??
        steps.find((step) => step.status === 'refused')
      )?.id;
    };
    return { afterRefresh, nextStepOf };
  }, [key, statuses]);
}
