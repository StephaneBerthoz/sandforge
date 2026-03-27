import { describe, it, expect, vi } from 'vitest';
import type { Connection } from 'jsforce';
import { SmartActionAnalyzer } from './SmartActionAnalyzer';
import type { SmartActionAnalyzerDeps } from './SmartActionAnalyzer';

/** Creates a mock jsforce Connection that returns configured counts. */
function createMockConnection(counts: Record<string, number>): Connection {
  return {
    query: vi.fn().mockImplementation((soql: string) => {
      for (const [obj, count] of Object.entries(counts)) {
        if (soql.includes(obj)) {
          return Promise.resolve({ totalSize: count, done: true, records: [] });
        }
      }
      return Promise.resolve({ totalSize: 0, done: true, records: [] });
    }),
  } as unknown as Connection;
}

/** Creates a mock connection that throws on specific objects. */
function createFailingConnection(failOn: string[]): Connection {
  return {
    query: vi.fn().mockImplementation((soql: string) => {
      for (const obj of failOn) {
        if (soql.includes(obj)) {
          return Promise.reject(new Error(`Object ${obj} does not exist`));
        }
      }
      return Promise.resolve({ totalSize: 0, done: true, records: [] });
    }),
  } as unknown as Connection;
}

describe('SmartActionAnalyzer', () => {
  it('should recommend quick-seed when target is empty and no source', async () => {
    const emptyCounts = { Account: 0, Contact: 0, Opportunity: 0, Case: 0, Lead: 0 };
    const mockConn = createMockConnection(emptyCounts);
    const deps: SmartActionAnalyzerDeps = {
      getConnection: vi.fn().mockResolvedValue(mockConn),
    };

    const analyzer = new SmartActionAnalyzer(deps);
    const result = await analyzer.analyzeOrg('target-org-1');

    expect(result.action).toBe('quick-seed');
    expect(result.confidence).toBe(0.9);
    expect(result.reasonKey).toBe('home.smartAction.reasonEmpty');
    expect(result.details.targetOrgId).toBe('target-org-1');
    expect(result.details.recordCounts).toEqual(emptyCounts);
  });

  it('should recommend clone when source has data and target is empty', async () => {
    const emptyCounts = { Account: 0, Contact: 0, Opportunity: 0, Case: 0, Lead: 0 };
    const sourceCounts = { Account: 150, Contact: 300, Opportunity: 50, Case: 10, Lead: 200 };

    const targetConn = createMockConnection(emptyCounts);
    const sourceConn = createMockConnection(sourceCounts);

    const deps: SmartActionAnalyzerDeps = {
      getConnection: vi.fn().mockImplementation((orgId: string) => {
        if (orgId === 'target-org') return Promise.resolve(targetConn);
        return Promise.resolve(sourceConn);
      }),
    };

    const analyzer = new SmartActionAnalyzer(deps);
    const result = await analyzer.analyzeOrg('target-org', 'source-org');

    expect(result.action).toBe('clone');
    expect(result.confidence).toBe(0.85);
    expect(result.reasonKey).toBe('home.smartAction.reasonClone');
    expect(result.details.sourceOrgId).toBe('source-org');
  });

  it('should recommend sync when both orgs have data', async () => {
    const targetCounts = { Account: 50, Contact: 100, Opportunity: 10, Case: 5, Lead: 30 };
    const sourceCounts = { Account: 200, Contact: 400, Opportunity: 80, Case: 20, Lead: 150 };

    const targetConn = createMockConnection(targetCounts);
    const sourceConn = createMockConnection(sourceCounts);

    const deps: SmartActionAnalyzerDeps = {
      getConnection: vi.fn().mockImplementation((orgId: string) => {
        if (orgId === 'target-org') return Promise.resolve(targetConn);
        return Promise.resolve(sourceConn);
      }),
    };

    const analyzer = new SmartActionAnalyzer(deps);
    const result = await analyzer.analyzeOrg('target-org', 'source-org');

    expect(result.action).toBe('sync');
    expect(result.confidence).toBe(0.7);
    expect(result.reasonKey).toBe('home.smartAction.reasonSync');
  });

  it('should return none when target has data and no source provided', async () => {
    const targetCounts = { Account: 50, Contact: 100, Opportunity: 10, Case: 5, Lead: 30 };
    const mockConn = createMockConnection(targetCounts);

    const deps: SmartActionAnalyzerDeps = {
      getConnection: vi.fn().mockResolvedValue(mockConn),
    };

    const analyzer = new SmartActionAnalyzer(deps);
    const result = await analyzer.analyzeOrg('target-org');

    expect(result.action).toBe('none');
    expect(result.confidence).toBe(0);
    expect(result.reasonKey).toBe('');
  });

  it('should handle query failures gracefully (count = 0 for failed objects)', async () => {
    const failConn = createFailingConnection(['Opportunity', 'Case']);
    const deps: SmartActionAnalyzerDeps = {
      getConnection: vi.fn().mockResolvedValue(failConn),
    };

    const analyzer = new SmartActionAnalyzer(deps);
    const result = await analyzer.analyzeOrg('target-org');

    expect(result.action).toBe('quick-seed');
    expect(result.details.recordCounts['Opportunity']).toBe(0);
    expect(result.details.recordCounts['Case']).toBe(0);
  });
});
