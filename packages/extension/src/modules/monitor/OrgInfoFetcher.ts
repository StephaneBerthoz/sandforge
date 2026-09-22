import type { OrgInfo } from '@sandforge/shared';

/**
 * Fetches org-level metadata for the Monitor overview panel.
 * Uses the Salesforce Tooling API and REST API to gather
 * edition, instance, user count, and metadata component counts.
 */
export class OrgInfoFetcher {
  private readonly cache: Map<string, { data: OrgInfo; fetchedAt: number }> = new Map();
  private readonly cacheTtlMs: number;

  constructor(cacheTtlMs = 5 * 60 * 1000) {
    this.cacheTtlMs = cacheTtlMs;
  }

  /** Fetch org info, returning cached data if still fresh. */
  async fetch(orgId: string, conn: OrgInfoConnection): Promise<OrgInfo> {
    const cached = this.cache.get(orgId);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.data;
    }

    const [identity, orgRecord, userCount, customObjectCount, apexClassCount, flowCount] =
      await Promise.all([
        conn.identity(),
        conn.queryOrg(),
        conn.queryCount('SELECT COUNT() FROM User WHERE IsActive = true'),
        // In a LIKE, `_` matches any one character: `'%__c'` alone also counts
        // Topic, PushTopic and every *Metric object. EntityDefinition ignores
        // an escaped `\_`, so the pattern is kept and narrowed to custom
        // entities (the only ones with a DeploymentStatus), among which only
        // the `__c` suffix ends in a c.
        conn.queryCount(
          "SELECT COUNT() FROM EntityDefinition WHERE DeploymentStatus != null AND QualifiedApiName LIKE '%__c'",
        ),
        conn.queryCount('SELECT COUNT() FROM ApexClass'),
        conn.queryCount('SELECT COUNT() FROM FlowDefinitionView WHERE IsActive = true'),
      ]);

    const info: OrgInfo = {
      name: orgRecord.name,
      orgId: orgRecord.orgId,
      type: orgRecord.type,
      edition: orgRecord.edition,
      instanceName: orgRecord.instanceName,
      apiVersion: identity.apiVersion,
      userCount,
      customObjectCount,
      apexClassCount,
      flowCount,
      lastLoginDate: identity.lastLoginDate,
    };

    this.cache.set(orgId, { data: info, fetchedAt: Date.now() });
    return info;
  }

  /** Clear cached data for an org (or all orgs). */
  clearCache(orgId?: string): void {
    if (orgId) {
      this.cache.delete(orgId);
    } else {
      this.cache.clear();
    }
  }
}

/** Abstraction over the Salesforce connection for testability. */
export interface OrgInfoConnection {
  identity(): Promise<{ apiVersion: string; lastLoginDate: string }>;
  /**
   * The org's own Organization row. The instance is read here and not from
   * the identity URL, whose answer carries no instance name at all.
   */
  queryOrg(): Promise<{
    name: string;
    orgId: string;
    type: OrgInfo['type'];
    edition: string;
    instanceName: string;
  }>;
  queryCount(soql: string): Promise<number>;
}
