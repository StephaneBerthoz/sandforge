import type { SalesforceOrg, ConnectionConfig, UUID } from '@sandforge/shared';
import type { ConfigStore } from '../storage/ConfigStore';
import type { SecretVault } from '../storage/SecretVault';
import type { OrgManager } from './OrgManager';
import { logger } from '../../logger.js';

/** Key prefix for org metadata in ConfigStore */
const ORG_KEY_PREFIX = 'org.';
/** Key prefix for org credentials in SecretVault */
const CRED_KEY_PREFIX = 'org-cred.';
/** ConfigStore category for orgs */
const ORG_CATEGORY = 'orgs';

/**
 * Deadline for a single SecretStorage read, in ms.
 *
 * Startup validation (`validateOrgsOnStartup`) walks every registered org
 * SEQUENTIALLY, and each org's check begins with this read — it is the first
 * `await` in `getJsforceConnection`. VS Code backs SecretStorage with the OS
 * keyring (libsecret/gnome-keyring on Linux, and the same path over Remote-SSH
 * or in a container), which does not always answer: with no keyring daemon
 * running, or a keyring whose unlock dialog nothing can display, the promise
 * simply never settles. Unbounded, that single read ends the sweep on org 1 —
 * orgs 2..n are never validated for the rest of the session and their status
 * stays whatever it was when the window opened.
 *
 * 10 s is deliberately generous: a locked keyring that DOES show an unlock
 * prompt must have time to be answered, and a read that is merely slow must
 * still return its token rather than be cut off. It bounds a hang, it does not
 * try to be a latency budget.
 */
const VAULT_READ_TIMEOUT_MS = 10_000;

/**
 * Persistence layer for orgs.
 * Metadata is stored in ConfigStore, credentials in SecretVault.
 * On startup, loadAll() populates OrgManager from ConfigStore.
 */
export class OrgRegistry {
  constructor(
    private configStore: ConfigStore,
    private secretVault: SecretVault,
    private orgManager: OrgManager,
  ) {}

  /**
   * Load all persisted orgs into OrgManager. Called at extension startup.
   *
   * Self-healing: entries are deduped by their Salesforce `orgId` field, not
   * by storage key. Builds from before the `orgId`-as-id scheme wrote entries
   * under different keys for the same org — such ghost copies carry stale (or
   * no) credentials, show up as duplicates in every org list, and their
   * failed auth attempts keep the "authentication expired" loop alive. The
   * canonical survivor is the entry whose key matches its orgId; the others
   * are pruned from ConfigStore and SecretVault.
   */
  loadAll(): void {
    const entries = this.configStore.getByCategory(ORG_CATEGORY);
    const byOrgId = new Map<string, { key: string; org: SalesforceOrg }>();
    const staleKeys: string[] = [];

    for (const [key, value] of Object.entries(entries)) {
      if (!key.startsWith(ORG_KEY_PREFIX)) continue;
      const org = value as SalesforceOrg;
      const identity = org.orgId ?? org.id;
      const entryId = key.slice(ORG_KEY_PREFIX.length);

      const existing = byOrgId.get(identity);
      if (!existing) {
        byOrgId.set(identity, { key, org });
        continue;
      }
      // Duplicate identity: keep the entry whose key matches the identity
      // (canonical scheme). If neither matches, keep the first deterministically.
      if (entryId === identity) {
        staleKeys.push(existing.key);
        byOrgId.set(identity, { key, org });
      } else {
        staleKeys.push(key);
      }
    }

    for (const key of staleKeys) {
      this.configStore.delete(key);
      const ghostId = key.slice(ORG_KEY_PREFIX.length);
      this.secretVault.deleteSecret(`${CRED_KEY_PREFIX}${ghostId}`).catch(() => undefined);
      this.orgManager.removeOrg(ghostId as UUID);
      logger.warn('Pruned duplicate org entry (same orgId as a canonical entry)', { key });
    }

    for (const { org } of byOrgId.values()) {
      this.orgManager.addOrg(org);
    }
  }

  /** Persist org metadata and optional credentials. */
  async saveOrg(org: SalesforceOrg, credentials?: ConnectionConfig): Promise<void> {
    this.configStore.set(`${ORG_KEY_PREFIX}${org.id}`, org, ORG_CATEGORY);
    this.orgManager.addOrg(org);

    if (credentials) {
      await this.secretVault.storeObject(`${CRED_KEY_PREFIX}${org.id}`, credentials);
    }
  }

  /** Remove org from both stores and OrgManager. */
  async removeOrg(orgId: string): Promise<void> {
    this.configStore.delete(`${ORG_KEY_PREFIX}${orgId}`);
    await this.secretVault.deleteSecret(`${CRED_KEY_PREFIX}${orgId}`);
    this.orgManager.removeOrg(orgId);
  }

  /**
   * Retrieve stored credentials for an org.
   *
   * Bounded by {@link VAULT_READ_TIMEOUT_MS}: an unreachable keyring must fail
   * the org, not the activation. It REJECTS on the deadline instead of
   * resolving `undefined`, because `undefined` reads as "no credentials
   * stored" — the caller would tell the user to reconnect an org whose token
   * is perfectly fine, and the startup sweep would mark it `expired` instead
   * of `error`.
   */
  async getCredentials(orgId: string): Promise<ConnectionConfig | undefined> {
    const pending = this.secretVault.getObject<ConnectionConfig>(`${CRED_KEY_PREFIX}${orgId}`);
    // Once the deadline wins the race nothing is listening to `pending` any
    // more; a late rejection would land as an unhandled rejection in the host.
    void pending.catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Secret storage did not answer within ${VAULT_READ_TIMEOUT_MS} ms for org "${orgId}" — the OS keyring may be locked or unavailable.`,
              ),
            );
          }, VAULT_READ_TIMEOUT_MS);
        }),
      ]);
    } finally {
      // Always clear it: a 10 s timer left armed on every credential read
      // would keep the host's event loop busy for nothing.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Update only the metadata (no credential change). */
  updateOrgMetadata(org: SalesforceOrg): void {
    this.configStore.set(`${ORG_KEY_PREFIX}${org.id}`, org, ORG_CATEGORY);
    this.orgManager.addOrg(org);
  }
}
