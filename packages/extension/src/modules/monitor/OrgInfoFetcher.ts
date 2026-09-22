import { z } from 'zod';
import type { OrgInfo } from '@sandforge/shared';

/** `GET /services/data`: every API version the org serves, oldest first. */
const apiVersionsSchema = z.array(z.object({ version: z.string() }));

/**
 * The newest API version an org serves, read from its `/services/data` answer.
 *
 * That is the org's own release. The version shown used to be the one
 * SandForge's connection speaks, which the org does not choose: 62.0 on orgs
 * running 68.0.
 *
 * @param answer - The body of `GET /services/data`, as the org sent it.
 * @throws When the answer lists no version.
 */
export function newestApiVersion(answer: unknown): string {
  const versions = apiVersionsSchema
    .parse(answer)
    .map(({ version }) => version)
    .filter((version) => Number.isFinite(Number(version)));
  if (versions.length === 0) {
    throw new Error('The org listed no API version under /services/data.');
  }
  return versions.reduce((newest, version) =>
    Number(version) > Number(newest) ? version : newest,
  );
}

/** An org's timestamp as an ISO string, or `undefined` when it does not parse. */
function isoTimestamp(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

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

    const [apiVersion, orgRecord, userCount, customObjectCount, apexClassCount, flowCount] =
      await Promise.all([
        conn.latestApiVersion(),
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

    // The panel has a line for both. An org that registered no namespace
    // answers null, and the line leaves that part out.
    const namespacePrefix = orgRecord.namespacePrefix || undefined;
    const createdDate = isoTimestamp(orgRecord.createdDate);

    const info: OrgInfo = {
      name: orgRecord.name,
      orgId: orgRecord.orgId,
      type: orgRecord.type,
      edition: orgRecord.edition,
      instanceName: orgRecord.instanceName,
      apiVersion,
      userCount,
      customObjectCount,
      apexClassCount,
      flowCount,
      ...(namespacePrefix !== undefined ? { namespacePrefix } : {}),
      ...(createdDate !== undefined ? { createdDate } : {}),
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
  /** The newest API version the org serves (see {@link newestApiVersion}). */
  latestApiVersion(): Promise<string>;
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
    /** `NamespacePrefix`: null on an org that registered none. */
    namespacePrefix?: string | null;
    /** `CreatedDate`, as the org wrote it. */
    createdDate?: string | null;
  }>;
  queryCount(soql: string): Promise<number>;
}
