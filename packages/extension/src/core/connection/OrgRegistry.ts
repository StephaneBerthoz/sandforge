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

  /** Retrieve stored credentials for an org. */
  async getCredentials(orgId: string): Promise<ConnectionConfig | undefined> {
    return this.secretVault.getObject<ConnectionConfig>(`${CRED_KEY_PREFIX}${orgId}`);
  }

  /** Update only the metadata (no credential change). */
  updateOrgMetadata(org: SalesforceOrg): void {
    this.configStore.set(`${ORG_KEY_PREFIX}${org.id}`, org, ORG_CATEGORY);
    this.orgManager.addOrg(org);
  }
}
