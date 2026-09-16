import type { UUID } from '@sandforge/shared';
import type { OrgRegistry } from './OrgRegistry';
import type { OrgManager } from './OrgManager';
import { getJsforceConnection, withDeadline } from './ConnectionHelper';
import { extractErrorMessage } from '../common/extractErrorMessage.js';

/**
 * Longest the sweep waits for one org before moving on to the next. The
 * connection path bounds its own CLI calls and identity checks, but a refresh
 * chains several of them; this cap is what guarantees an org that never
 * answers costs the orgs after it at most this long.
 */
const ORG_VALIDATION_DEADLINE_MS = 45_000;

/** Dependencies for {@link validateOrgsOnStartup}. */
export interface StartupValidationDeps {
  orgManager: OrgManager;
  orgRegistry: OrgRegistry;
  log: (message: string) => void;
}

/**
 * Proactively validate every registered org once per activation, so an expired
 * token is refreshed (via the SF CLI self-heal in getJsforceConnection) BEFORE
 * the user's first operation hits an auth wall mid-run.
 *
 * Per-org statuses are updated with the RESULT (`connected` / `expired` /
 * `error`), which feeds the sidebar tree and org pickers through the
 * OrgManager change events. There is deliberately no intermediate
 * `refreshing` flip: flipping every org before its check made connected
 * counters visibly tick down one by one during the sweep.
 *
 * Sequential by design: each check may spawn an `sf org display` CLI call and
 * orgs are few — parallelism would only contend on the CLI's auth store. Each
 * org gets at most ORG_VALIDATION_DEADLINE_MS, after which it is marked
 * `error` and the sweep moves on. A check that succeeds after its deadline
 * marks the org `connected`, unless its status is no longer `error` by then; a
 * late failure leaves `error` in place. The
 * deadline only stops waiting: the abandoned check may still be running its
 * CLI calls (and saving a refreshed token) while the next org is checked, so
 * past a deadline two checks can reach the auth store at once.
 * Never throws: one org's failure must not skip the others, and a startup
 * probe must never break activation.
 */
export async function validateOrgsOnStartup(deps: StartupValidationDeps): Promise<void> {
  const { orgManager, orgRegistry, log } = deps;
  const orgs = orgManager.getAllOrgs();
  if (orgs.length === 0) {
    return;
  }

  log(`[startup] Validating ${orgs.length} registered org(s) in the background…`);
  for (const org of orgs) {
    const orgId = org.id as UUID;
    // No intermediate 'refreshing' flip: status changes only on a RESULT.
    // Flipping every org to 'refreshing' first made connected-counts tick
    // down one by one during the sweep — the panel looked like orgs were
    // dying in slow motion.
    const deadlineMessage = `validation did not finish within ${ORG_VALIDATION_DEADLINE_MS / 1000} s`;
    const connecting = getJsforceConnection(org.id, orgRegistry, orgManager);
    try {
      await withDeadline(connecting, ORG_VALIDATION_DEADLINE_MS, deadlineMessage);
      orgManager.updateStatus(orgId, 'connected');
      log(`[startup] Org "${org.alias}" connected.`);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      // Auth problems are user-actionable (re-login) → 'expired'; anything
      // else (network, breaker open, no answer in time…) is a plain 'error'.
      const authRelated = /Authentication expired|No credentials/.test(message);
      orgManager.updateStatus(orgId, authRelated ? 'expired' : 'error');
      log(`[startup] Org "${org.alias}" validation failed: ${message}`);

      // A slow org that does answer would otherwise keep the 'error' set
      // above until something else happened to update it. Only an 'error'
      // is corrected: any other status was set since, by someone who knows
      // more than this sweep.
      if (err instanceof Error && err.message === deadlineMessage) {
        void connecting
          .then(() => {
            if (orgManager.getOrg(orgId)?.status !== 'error') return;
            orgManager.updateStatus(orgId, 'connected');
            log(`[startup] Org "${org.alias}" answered after the deadline: connected.`);
          })
          .catch(() => undefined);
      }
    }
  }
}
