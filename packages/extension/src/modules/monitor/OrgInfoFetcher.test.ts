import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrgInfoFetcher, newestApiVersion } from './OrgInfoFetcher';
import type { OrgInfoConnection } from './OrgInfoFetcher';

function createMockConn(overrides: Partial<OrgInfoConnection> = {}): OrgInfoConnection {
  return {
    latestApiVersion: vi.fn().mockResolvedValue('60.0'),
    queryOrg: vi.fn().mockResolvedValue({
      name: 'Acme Corp',
      orgId: '00D000000000001',
      type: 'Sandbox' as const,
      edition: 'Enterprise Edition',
      instanceName: 'NA100',
    }),
    queryCount: vi.fn().mockResolvedValue(42),
    ...overrides,
  };
}

describe('OrgInfoFetcher', () => {
  let fetcher: OrgInfoFetcher;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-24T12:00:00Z'));
    fetcher = new OrgInfoFetcher(5 * 60 * 1000);
  });

  afterEach(() => {
    // Restore real timers: leaked fake timers poison other test files that
    // share the same vitest worker (e.g. SeedOpsHandler's real-timeout test).
    vi.useRealTimers();
  });

  it('should fetch org info from connection', async () => {
    const conn = createMockConn();
    const result = await fetcher.fetch('org-1', conn);

    expect(result.name).toBe('Acme Corp');
    expect(result.orgId).toBe('00D000000000001');
    expect(result.type).toBe('Sandbox');
    expect(result.edition).toBe('Enterprise Edition');
    expect(result.instanceName).toBe('NA100');
    expect(result.apiVersion).toBe('60.0');
    expect(result.userCount).toBe(42);
    expect(result.customObjectCount).toBe(42);
    expect(result.apexClassCount).toBe(42);
    expect(result.flowCount).toBe(42);
  });

  it('sends no login date: nothing the org answers carries one', async () => {
    // It was filled from `last_login_date` on the identity answer, which has
    // no such key, and fell back to the time of the refresh: always "now".
    const result = await fetcher.fetch('org-1', createMockConn());

    expect(Object.keys(result)).not.toContain('lastLoginDate');
  });

  it('passes the namespace and the creation date on, the date as an ISO timestamp', async () => {
    const conn = createMockConn({
      queryOrg: vi.fn().mockResolvedValue({
        name: 'Acme Corp',
        orgId: '00D000000000001',
        type: 'Sandbox' as const,
        edition: 'Enterprise Edition',
        instanceName: 'EU42S',
        namespacePrefix: 'acme',
        // As the Organization row writes it.
        createdDate: '2026-04-24T10:20:51.000+0000',
      }),
    });

    const result = await fetcher.fetch('org-1', conn);

    expect(result.namespacePrefix).toBe('acme');
    expect(result.createdDate).toBe('2026-04-24T10:20:51.000Z');
  });

  it('leaves out a namespace the org never registered and a date it cannot read', async () => {
    const conn = createMockConn({
      queryOrg: vi.fn().mockResolvedValue({
        name: 'Acme Corp',
        orgId: '00D000000000001',
        type: 'Sandbox' as const,
        edition: 'Enterprise Edition',
        instanceName: 'EU42S',
        namespacePrefix: null,
        createdDate: 'not a date',
      }),
    });

    const result = await fetcher.fetch('org-1', conn);

    expect(Object.keys(result)).not.toContain('namespacePrefix');
    expect(Object.keys(result)).not.toContain('createdDate');
  });

  it('should call all queries in parallel', async () => {
    const conn = createMockConn();
    await fetcher.fetch('org-1', conn);

    expect(conn.latestApiVersion).toHaveBeenCalledTimes(1);
    expect(conn.queryOrg).toHaveBeenCalledTimes(1);
    expect(conn.queryCount).toHaveBeenCalledTimes(4);
  });

  it('should query correct SOQL for counts', async () => {
    const conn = createMockConn();
    await fetcher.fetch('org-1', conn);

    const calls = (conn.queryCount as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: string[]) => c[0],
    );
    expect(calls).toContain('SELECT COUNT() FROM User WHERE IsActive = true');
    expect(calls).toContain(
      "SELECT COUNT() FROM EntityDefinition WHERE DeploymentStatus != null AND QualifiedApiName LIKE '%__c'",
    );
    expect(calls).toContain('SELECT COUNT() FROM ApexClass');
    expect(calls).toContain('SELECT COUNT() FROM FlowDefinitionView WHERE IsActive = true');
  });

  it('counts the custom objects an org has, not every object whose name ends in c', async () => {
    // An org's EntityDefinition, answering COUNT() the way Salesforce does. In
    // a SOQL LIKE, `_` matches any one character, so `'%__c'` is "anything
    // ending in two characters and a c": run against real orgs it counted 41
    // custom objects where describeGlobal listed 5, Topic and ActivityMetric
    // among the 36 standard objects it took for custom ones.
    const entities = [
      { name: 'Account', custom: false },
      { name: 'Topic', custom: false },
      { name: 'PushTopic', custom: false },
      { name: 'ActivityMetric', custom: false },
      { name: 'Invoice__c', custom: true },
      { name: 'Setting__c', custom: true },
      { name: 'Rate__mdt', custom: true },
    ];
    const like = (pattern: string): RegExp =>
      new RegExp(
        `^${pattern
          .split('')
          .map((ch) =>
            ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          )
          .join('')}$`,
      );
    const countEntities = (soql: string): number => {
      const pattern = /QualifiedApiName LIKE '([^']*)'/.exec(soql)?.[1];
      // DeploymentStatus is set on custom entities only.
      const customOnly = /DeploymentStatus != null/.test(soql);
      return entities.filter(
        (e) => (!pattern || like(pattern).test(e.name)) && (!customOnly || e.custom),
      ).length;
    };
    const conn = createMockConn({
      queryCount: vi.fn((soql: string) =>
        Promise.resolve(/FROM EntityDefinition/.test(soql) ? countEntities(soql) : 0),
      ),
    });

    const result = await fetcher.fetch('org-1', conn);

    expect(result.customObjectCount).toBe(2);
  });

  it('should return cached data within TTL', async () => {
    const conn = createMockConn();
    await fetcher.fetch('org-1', conn);

    // Advance 2 minutes (within 5 min TTL)
    vi.advanceTimersByTime(2 * 60 * 1000);

    const result2 = await fetcher.fetch('org-1', conn);
    expect(result2.name).toBe('Acme Corp');

    // the version should only have been read once (cached)
    expect(conn.latestApiVersion).toHaveBeenCalledTimes(1);
  });

  it('should refetch after cache expires', async () => {
    const conn = createMockConn();
    await fetcher.fetch('org-1', conn);

    // Advance past TTL
    vi.advanceTimersByTime(6 * 60 * 1000);

    await fetcher.fetch('org-1', conn);
    expect(conn.latestApiVersion).toHaveBeenCalledTimes(2);
  });

  it('should cache per org', async () => {
    const conn = createMockConn();
    await fetcher.fetch('org-1', conn);
    await fetcher.fetch('org-2', conn);

    // Both orgs fetched independently
    expect(conn.latestApiVersion).toHaveBeenCalledTimes(2);
  });

  it('should clear cache for specific org', async () => {
    const conn = createMockConn();
    await fetcher.fetch('org-1', conn);
    fetcher.clearCache('org-1');

    await fetcher.fetch('org-1', conn);
    expect(conn.latestApiVersion).toHaveBeenCalledTimes(2);
  });

  it('should clear all cache', async () => {
    const conn = createMockConn();
    await fetcher.fetch('org-1', conn);
    await fetcher.fetch('org-2', conn);
    fetcher.clearCache();

    await fetcher.fetch('org-1', conn);
    await fetcher.fetch('org-2', conn);
    expect(conn.latestApiVersion).toHaveBeenCalledTimes(4);
  });

  it('should handle different org types', async () => {
    const conn = createMockConn({
      queryOrg: vi.fn().mockResolvedValue({
        name: 'Prod Org',
        orgId: '00D000000000002',
        type: 'Production',
        edition: 'Unlimited Edition',
      }),
    });
    const result = await fetcher.fetch('org-prod', conn);
    expect(result.type).toBe('Production');
    expect(result.edition).toBe('Unlimited Edition');
  });

  it('should handle varying count values', async () => {
    let callIndex = 0;
    const counts = [150, 30, 85, 12];
    const conn = createMockConn({
      queryCount: vi.fn().mockImplementation(() => {
        const val = counts[callIndex] ?? 0;
        callIndex++;
        return Promise.resolve(val);
      }),
    });
    const result = await fetcher.fetch('org-1', conn);
    expect(result.userCount).toBe(150);
    expect(result.customObjectCount).toBe(30);
    expect(result.apexClassCount).toBe(85);
    expect(result.flowCount).toBe(12);
  });

  it('should propagate connection errors', async () => {
    const conn = createMockConn({
      latestApiVersion: vi.fn().mockRejectedValue(new Error('Auth expired')),
    });
    await expect(fetcher.fetch('org-1', conn)).rejects.toThrow('Auth expired');
  });
});

describe('newestApiVersion', () => {
  /** The tail of a real `GET /services/data` answer, oldest first, as a sandbox served it. */
  const SERVED = [
    { label: "Winter '25", url: '/services/data/v62.0', version: '62.0' },
    { label: "Spring '26", url: '/services/data/v66.0', version: '66.0' },
    { label: "Summer '26", url: '/services/data/v67.0', version: '67.0' },
    { label: "Winter '27", url: '/services/data/v68.0', version: '68.0' },
    { label: 'Latest Release', url: '/services/data/latest', version: '68.0' },
  ];

  it("reads the org's release, not the version a connection speaks", () => {
    expect(newestApiVersion(SERVED)).toBe('68.0');
  });

  it('does not depend on the order the versions come in', () => {
    expect(newestApiVersion([...SERVED].reverse())).toBe('68.0');
  });

  it('refuses an answer that lists no version', () => {
    expect(() => newestApiVersion([])).toThrow('no API version');
    expect(() => newestApiVersion({ error: 'NOT_FOUND' })).toThrow();
  });
});
