import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrgInfoFetcher } from './OrgInfoFetcher';
import type { OrgInfoConnection } from './OrgInfoFetcher';

function createMockConn(overrides: Partial<OrgInfoConnection> = {}): OrgInfoConnection {
  return {
    identity: vi.fn().mockResolvedValue({
      instanceName: 'NA100',
      apiVersion: '60.0',
      lastLoginDate: '2026-02-24T09:00:00Z',
    }),
    queryOrg: vi.fn().mockResolvedValue({
      name: 'Acme Corp',
      orgId: '00D000000000001',
      type: 'Sandbox' as const,
      edition: 'Enterprise Edition',
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
    expect(result.lastLoginDate).toBe('2026-02-24T09:00:00Z');
  });

  it('should call all queries in parallel', async () => {
    const conn = createMockConn();
    await fetcher.fetch('org-1', conn);

    expect(conn.identity).toHaveBeenCalledTimes(1);
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
      "SELECT COUNT() FROM EntityDefinition WHERE QualifiedApiName LIKE '%__c'",
    );
    expect(calls).toContain('SELECT COUNT() FROM ApexClass');
    expect(calls).toContain('SELECT COUNT() FROM FlowDefinitionView WHERE IsActive = true');
  });

  it('should return cached data within TTL', async () => {
    const conn = createMockConn();
    await fetcher.fetch('org-1', conn);

    // Advance 2 minutes (within 5 min TTL)
    vi.advanceTimersByTime(2 * 60 * 1000);

    const result2 = await fetcher.fetch('org-1', conn);
    expect(result2.name).toBe('Acme Corp');

    // identity should only have been called once (cached)
    expect(conn.identity).toHaveBeenCalledTimes(1);
  });

  it('should refetch after cache expires', async () => {
    const conn = createMockConn();
    await fetcher.fetch('org-1', conn);

    // Advance past TTL
    vi.advanceTimersByTime(6 * 60 * 1000);

    await fetcher.fetch('org-1', conn);
    expect(conn.identity).toHaveBeenCalledTimes(2);
  });

  it('should cache per org', async () => {
    const conn = createMockConn();
    await fetcher.fetch('org-1', conn);
    await fetcher.fetch('org-2', conn);

    // Both orgs fetched independently
    expect(conn.identity).toHaveBeenCalledTimes(2);
  });

  it('should clear cache for specific org', async () => {
    const conn = createMockConn();
    await fetcher.fetch('org-1', conn);
    fetcher.clearCache('org-1');

    await fetcher.fetch('org-1', conn);
    expect(conn.identity).toHaveBeenCalledTimes(2);
  });

  it('should clear all cache', async () => {
    const conn = createMockConn();
    await fetcher.fetch('org-1', conn);
    await fetcher.fetch('org-2', conn);
    fetcher.clearCache();

    await fetcher.fetch('org-1', conn);
    await fetcher.fetch('org-2', conn);
    expect(conn.identity).toHaveBeenCalledTimes(4);
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
      identity: vi.fn().mockRejectedValue(new Error('Auth expired')),
    });
    await expect(fetcher.fetch('org-1', conn)).rejects.toThrow('Auth expired');
  });
});
