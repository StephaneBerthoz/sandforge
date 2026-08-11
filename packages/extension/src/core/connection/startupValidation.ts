import type { UUID } from '@sandforge/shared';
import type { OrgRegistry } from './OrgRegistry';
import type { OrgManager } from './OrgManager';
import { getJsforceConnection } from './ConnectionHelper';
import { extractErrorMessage } from '../common/extractErrorMessage.js';

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
 * orgs are few — parallelism would only contend on the CLI's auth store.
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
    try {
      await getJsforceConnection(org.id, orgRegistry, orgManager);
      orgManager.updateStatus(orgId, 'connected');
      log(`[startup] Org "${org.alias}" connected.`);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      // Auth problems are user-actionable (re-login) → 'expired'; anything
      // else (network, breaker open…) is a plain 'error'.
      const authRelated = /Authentication expired|No credentials/.test(message);
      orgManager.updateStatus(orgId, authRelated ? 'expired' : 'error');
      log(`[startup] Org "${org.alias}" validation failed: ${message}`);
    }
  }
}
