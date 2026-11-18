import { isDevelopmentOrg, orgDisplayName } from '@sandforge/shared';
import type { RecoveryProgress, SalesforceOrg } from '@sandforge/shared';
import { canFill } from '../utils/orgToFill';

/**
 * What the launcher and Home lead with, read from the orgs and the refreshes
 * the extension told of. One rule for both: the launcher offered Forge to a
 * person whose only org was a production org, and whose sessions had all
 * expired, while Home said "Connect your first org" to the same person and
 * the tour sent them to Monitor.
 *
 * Pure, with neither zod nor a store: the launcher's bundle reaches it.
 */

/** What the hero shows; the first rule that holds wins. */
export type Hero =
  /** Rule 0: the org list is not in yet. */
  | { kind: 'none' }
  /** Rule 1: no org registered: the card that connects the first. */
  | { kind: 'firstOrg' }
  /** Rule 2: a refreshed sandbox to bring back into service, n of N steps. */
  | ({ kind: 'afterRefresh' } & RecoveryProgress)
  /** Rule 3: an org to reconnect. */
  | { kind: 'reconnect'; orgId: string; alias: string }
  /** Rule 4: the one org connected, to fill with Seed. */
  | { kind: 'seed'; orgId: string; alias: string }
  /** Rule 5: two orgs connected or more, one to fill: Forge copies into it. */
  | { kind: 'forge' }
  /** Rule 6: production orgs alone: the sandbox to fill is still to add. */
  | { kind: 'addSandbox'; orgId: string; alias: string };

/** What {@link heroFor} reads. */
export interface HeroInput {
  /** The registered orgs; undefined until the extension has answered. */
  orgs: readonly SalesforceOrg[] | undefined;
  selectedOrgId: string | null | undefined;
  /** The sandboxes whose refresh was noticed, as `sidebar:afterRefresh` says them. */
  afterRefresh?: readonly RecoveryProgress[];
}

/**
 * The refreshed sandbox whose recovery the hero leads with: one registered,
 * not a production org, and not finished; the selected org first, else the
 * one refreshed last.
 */
function recoveryToLead(
  orgs: readonly SalesforceOrg[],
  selectedOrgId: string | null | undefined,
  afterRefresh: readonly RecoveryProgress[],
): RecoveryProgress | undefined {
  const open = afterRefresh.filter((progress) => {
    const org = orgs.find((each) => each.id === progress.orgId);
    return org !== undefined && isDevelopmentOrg(org) && progress.done < progress.total;
  });
  const selected = open.find((progress) => progress.orgId === selectedOrgId);
  if (selected) return selected;
  const when = (progress: RecoveryProgress): number => {
    const at = Date.parse(progress.detectedAt);
    return Number.isNaN(at) ? -Infinity : at;
  };
  return open.reduce<RecoveryProgress | undefined>(
    (latest, progress) =>
      latest === undefined || when(progress) > when(latest) ? progress : latest,
    undefined,
  );
}

/** Whether an org's session ended or failed: it is to reconnect. */
const lost = (org: SalesforceOrg): boolean => org.status === 'expired' || org.status === 'error';

/** The hero of the orgs and the refreshes given: the first of the rules 0 to 6 that holds. */
export function heroFor({ orgs, selectedOrgId, afterRefresh = [] }: HeroInput): Hero {
  if (orgs === undefined) return { kind: 'none' };
  if (orgs.length === 0) return { kind: 'firstOrg' };

  const recovery = recoveryToLead(orgs, selectedOrgId, afterRefresh);
  if (recovery) return { kind: 'afterRefresh', ...recovery };

  const named = (org: SalesforceOrg) => ({ orgId: org.id, alias: orgDisplayName(org) });
  const selected = orgs.find((org) => org.id === selectedOrgId);
  const connected = orgs.filter((org) => org.status === 'connected');
  if (selected && lost(selected)) return { kind: 'reconnect', ...named(selected) };
  if (connected.length === 0) {
    const toReconnect = selected ?? orgs.find(lost) ?? orgs[0];
    return { kind: 'reconnect', ...named(toReconnect) };
  }

  const fillable = connected.filter(canFill);
  if (fillable.length > 0 && connected.length === 1) {
    return { kind: 'seed', ...named(fillable[0]) };
  }
  if (fillable.length > 0) return { kind: 'forge' };

  // Every org connected is a production org: Forge copies from it, into a
  // sandbox still to add.
  const production = selected?.status === 'connected' ? selected : connected[0];
  return { kind: 'addSandbox', ...named(production) };
}

/**
 * The list `sidebar:afterRefresh` carries, each entry with the fields the
 * hero reads and no other; undefined when it is not one, the whole of it, so
 * the launcher keeps what it had.
 */
export function afterRefreshOf(payload: unknown): RecoveryProgress[] | undefined {
  if (!Array.isArray(payload)) return undefined;
  const count = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0;
  const read: RecoveryProgress[] = [];
  for (const entry of payload as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { orgId, alias, detectedAt, done, total } = entry as Record<string, unknown>;
    if (
      typeof orgId !== 'string' ||
      typeof alias !== 'string' ||
      typeof detectedAt !== 'string' ||
      !count(done) ||
      !count(total)
    ) {
      return undefined;
    }
    read.push({ orgId, alias, detectedAt, done, total });
  }
  return read;
}
