import type { SalesforceOrg, ConnectionConfig } from '@sandforge/shared';
import type { ConfigStore } from '../storage/ConfigStore';
import type { SecretVault } from '../storage/SecretVault';
import type { OrgManager } from './OrgManager';

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

  /** Load all persisted orgs into OrgManager. Called at extension startup. */
  loadAll(): void {
    const entries = this.configStore.getByCategory(ORG_CATEGORY);
    for (const [key, value] of Object.entries(entries)) {
      if (key.startsWith(ORG_KEY_PREFIX)) {
        const org = value as SalesforceOrg;
        this.orgManager.addOrg(org);
      }
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
