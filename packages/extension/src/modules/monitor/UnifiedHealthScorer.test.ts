import { describe, it, expect, vi } from 'vitest';
import { UnifiedHealthScorer } from './UnifiedHealthScorer';
import type { UnifiedHealthInput, MetadataCounts, SecuritySettings } from './UnifiedHealthScorer';
import type { ApiLimit, TrendData } from '@sandforge/shared';
import type { TrendStorage } from './TrendStorage';

/** Helper to create an ApiLimit with computed remaining. */
function makeLimit(name: string, max: number, usedPercent: number): ApiLimit {
  const remaining = Math.round(max * (1 - usedPercent / 100));
  return { name, max, remaining, usedPercent };
}

/** Helper to create a mock TrendStorage with controlled responses. */
function makeMockTrendStorage(
  trendMap: Record<string, Partial<TrendData>>,
): TrendStorage {
  return {
    getTrendData: vi.fn(((_orgId: string, limitName: string): TrendData => ({
      limitName,
      direction: 'stable',
      changePercent: 0,
      sparklineData: [],
      ...trendMap[limitName],
    })) as TrendStorage['getTrendData']),
    record: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
    purge: vi.fn(),
  } as unknown as TrendStorage;
}

/** Helper to create full security settings. */
function makeSecuritySettings(overrides?: Partial<SecuritySettings>): SecuritySettings {
  return {
    passwordMinLength: 12,
    passwordComplexity: true,
    sessionTimeout: 120,
    mfaEnabled: true,
    ipRestrictions: true,
    ...overrides,
  };
}

/** Helper to create metadata counts. */
function makeMetadataCounts(overrides?: Partial<MetadataCounts>): MetadataCounts {
  return {
    customObjectCount: 30,
    customFieldCount: 100,
    apexClassCount: 50,
    ...overrides,
  };
}

describe('UnifiedHealthScorer', () => {
  const scorer = new UnifiedHealthScorer();

  it('should return 100 for empty limits', () => {
    const input: UnifiedHealthInput = { limits: [], orgId: 'org-1' };
    const report = scorer.calculate(input);
    expect(report.overallScore).toBe(100);
    expect(report.overallStatus).toBe('healthy');
    expect(report.factors).toHaveLength(0);
  });

  it('should score healthy when all limits are low usage', () => {
    const input: UnifiedHealthInput = {
      limits: [
        makeLimit('DailyApiRequests', 15000, 20),
        makeLimit('DataStorageMB', 500, 10),
        makeLimit('DailySoqlQueries', 100000, 30),
        makeLimit('DailyDmlStatements', 150000, 25),
        makeLimit('DailyAsyncApexExecutions', 250000, 15),
      ],
      orgId: 'org-1',
    };
    const report = scorer.calculate(input);
    expect(report.overallScore).toBeGreaterThanOrEqual(80);
    expect(report.overallStatus).toBe('healthy');
    expect(report.topRisks).toHaveLength(0);
  });

  it('should detect warning status for moderate usage', () => {
    const input: UnifiedHealthInput = {
      limits: [
        makeLimit('DailyApiRequests', 15000, 65),
        makeLimit('DataStorageMB', 500, 40),
        makeLimit('DailySoqlQueries', 100000, 30),
      ],
      orgId: 'org-1',
    };
    const report = scorer.calculate(input);
    const apiCallsFactor = report.factors.find((f) => f.name === 'DailyApiRequests');
    expect(apiCallsFactor).toBeDefined();
    // 65% usage: 70 - (65-50)*1.4 = 70 - 21 = 49 -> warning
    expect(apiCallsFactor!.status).toBe('warning');
    expect(report.topRisks.length).toBeGreaterThan(0);
  });

  it('should detect critical status for high usage', () => {
    const input: UnifiedHealthInput = {
      limits: [
        makeLimit('DailyApiRequests', 15000, 96),
        makeLimit('DataStorageMB', 500, 92),
        makeLimit('DailySoqlQueries', 100000, 95),
        makeLimit('DailyDmlStatements', 150000, 91),
        makeLimit('DailyAsyncApexExecutions', 250000, 94),
      ],
      orgId: 'org-1',
    };
    const report = scorer.calculate(input);
    expect(report.overallScore).toBeLessThan(20);
    expect(report.overallStatus).toBe('critical');
    expect(report.topRisks.length).toBeLessThanOrEqual(3);
  });

  it('should use linear interpolation with no cliff effects', () => {
    const input49: UnifiedHealthInput = {
      limits: [makeLimit('DailyApiRequests', 15000, 49)],
      orgId: 'org-1',
    };
    const input51: UnifiedHealthInput = {
      limits: [makeLimit('DailyApiRequests', 15000, 51)],
      orgId: 'org-1',
    };
    const report49 = scorer.calculate(input49);
    const report51 = scorer.calculate(input51);

    const score49 = report49.factors.find((f) => f.name === 'DailyApiRequests')!.score;
    const score51 = report51.factors.find((f) => f.name === 'DailyApiRequests')!.score;

    // With linear interpolation, the difference should be small (< 5 points)
    expect(Math.abs(score49 - score51)).toBeLessThan(5);
    // 49%: 100 - 49*0.6 = 70.6 -> 71
    // 51%: 70 - (51-50)*1.4 = 68.6 -> 69
    expect(score49).toBe(71);
    expect(score51).toBe(69);
  });

  it('should integrate trend data as degrading penalty', () => {
    const limitsData = [makeLimit('DailyApiRequests', 15000, 50)];

    // Without trend data
    const inputNoTrend: UnifiedHealthInput = {
      limits: limitsData,
      orgId: 'org-1',
    };
    const reportNoTrend = scorer.calculate(inputNoTrend);
    const scoreNoTrend = reportNoTrend.factors.find((f) => f.name === 'DailyApiRequests')!.score;

    // With degrading trend (direction: up, changePercent: 20)
    const mockTrendStorage = makeMockTrendStorage({
      DailyApiRequests: { direction: 'up', changePercent: 20 },
    });
    const inputWithTrend: UnifiedHealthInput = {
      limits: limitsData,
      orgId: 'org-1',
      trendStorage: mockTrendStorage,
    };
    const reportWithTrend = scorer.calculate(inputWithTrend);
    const scoreWithTrend = reportWithTrend.factors.find((f) => f.name === 'DailyApiRequests')!.score;

    // The score with degrading trend should be lower
    expect(scoreWithTrend).toBeLessThan(scoreNoTrend);
    // Penalty for 20% change = min(15, 20 * 0.5) = 10
    expect(scoreNoTrend - scoreWithTrend).toBe(10);
  });

  it('should map trend directions correctly', () => {
    const limits = [
      makeLimit('DailyApiRequests', 15000, 50),
      makeLimit('DataStorageMB', 500, 30),
      makeLimit('DailySoqlQueries', 100000, 20),
    ];

    const mockTrendStorage = makeMockTrendStorage({
      DailyApiRequests: { direction: 'up', changePercent: 10 },
      DataStorageMB: { direction: 'down', changePercent: -5 },
      DailySoqlQueries: { direction: 'stable', changePercent: 1 },
    });

    const input: UnifiedHealthInput = {
      limits,
      orgId: 'org-1',
      trendStorage: mockTrendStorage,
    };
    const report = scorer.calculate(input);

    const apiFactor = report.factors.find((f) => f.name === 'DailyApiRequests');
    const storageFactor = report.factors.find((f) => f.name === 'DataStorageMB');
    const soqlFactor = report.factors.find((f) => f.name === 'DailySoqlQueries');

    expect(apiFactor!.trend).toBe('degrading');
    expect(storageFactor!.trend).toBe('improving');
    expect(soqlFactor!.trend).toBe('stable');
  });

  it('should skip metadata/coverage/security dimensions when data is missing', () => {
    const input: UnifiedHealthInput = {
      limits: [
        makeLimit('DailyApiRequests', 15000, 20),
        makeLimit('DataStorageMB', 500, 10),
      ],
      orgId: 'org-1',
    };
    const report = scorer.calculate(input);

    // Only limit-category factors should be present
    const categories = new Set(report.factors.map((f) => f.category));
    expect(categories.has('metadata')).toBe(false);
    expect(categories.has('coverage')).toBe(false);
    expect(categories.has('security')).toBe(false);
  });

  it('should include metadata/coverage/security dimensions when data is provided', () => {
    const input: UnifiedHealthInput = {
      limits: [
        makeLimit('DailyApiRequests', 15000, 20),
        makeLimit('DataStorageMB', 500, 10),
        makeLimit('DailySoqlQueries', 100000, 15),
        makeLimit('DailyDmlStatements', 150000, 12),
        makeLimit('DailyAsyncApexExecutions', 250000, 8),
      ],
      orgId: 'org-1',
      codeCoverage: 85,
      metadataCounts: makeMetadataCounts(),
      securitySettings: makeSecuritySettings(),
    };
    const report = scorer.calculate(input);

    // 5 core limit factors + 3 optional dimensions = 8 factors
    expect(report.factors.length).toBeGreaterThanOrEqual(8);

    const categories = new Set(report.factors.map((f) => f.category));
    expect(categories.has('metadata')).toBe(true);
    expect(categories.has('coverage')).toBe(true);
    expect(categories.has('security')).toBe(true);
  });

  it('should not default unavailable dimensions to optimistic scores', () => {
    const input: UnifiedHealthInput = {
      limits: [makeLimit('DailyApiRequests', 15000, 20)],
      orgId: 'org-1',
    };
    const report = scorer.calculate(input);

    // No factor should have a default score of 75 or 50 for missing data
    for (const factor of report.factors) {
      // All present factors should be scored from actual data, not defaults
      expect(factor.category).not.toBe('coverage');
      expect(factor.category).not.toBe('security');
      expect(factor.category).not.toBe('metadata');
    }
  });

  it('should produce overall score between 0 and 100 for any input combination', () => {
    // Extreme low values
    const inputLow: UnifiedHealthInput = {
      limits: [],
      orgId: 'org-1',
    };
    const reportLow = scorer.calculate(inputLow);
    expect(reportLow.overallScore).toBeGreaterThanOrEqual(0);
    expect(reportLow.overallScore).toBeLessThanOrEqual(100);

    // Extreme high values
    const inputHigh: UnifiedHealthInput = {
      limits: [
        makeLimit('DailyApiRequests', 15000, 100),
        makeLimit('DataStorageMB', 500, 100),
        makeLimit('DailySoqlQueries', 100000, 100),
        makeLimit('DailyDmlStatements', 150000, 100),
        makeLimit('DailyAsyncApexExecutions', 250000, 100),
      ],
      orgId: 'org-1',
      codeCoverage: 0,
      metadataCounts: makeMetadataCounts({ customObjectCount: 600, customFieldCount: 3000, apexClassCount: 1500 }),
      securitySettings: makeSecuritySettings({ mfaEnabled: false, passwordMinLength: 4, passwordComplexity: false, ipRestrictions: false }),
    };
    const reportHigh = scorer.calculate(inputHigh);
    expect(reportHigh.overallScore).toBeGreaterThanOrEqual(0);
    expect(reportHigh.overallScore).toBeLessThanOrEqual(100);
  });

  it('should generate recommendations for unhealthy factors', () => {
    const input: UnifiedHealthInput = {
      limits: [
        makeLimit('DailyApiRequests', 15000, 85),
        makeLimit('DataStorageMB', 500, 92),
      ],
      orgId: 'org-1',
    };
    const report = scorer.calculate(input);

    const apiFactor = report.factors.find((f) => f.name === 'DailyApiRequests');
    expect(apiFactor!.recommendation).toContain('batch jobs');

    const storageFactor = report.factors.find((f) => f.name === 'DataStorageMB');
    expect(storageFactor!.recommendation).toContain('Urgent');
    expect(storageFactor!.recommendation).toContain('archiving');
  });

  it('should redistribute weights when optional dimensions are present', () => {
    const baseLimits = [
      makeLimit('DailyApiRequests', 15000, 20),
      makeLimit('DataStorageMB', 500, 10),
    ];

    // Without optional dimensions
    const inputNoOpt: UnifiedHealthInput = { limits: baseLimits, orgId: 'org-1' };
    const reportNoOpt = scorer.calculate(inputNoOpt);
    const limitsWeightNoOpt = reportNoOpt.factors.reduce((sum, f) => sum + f.weight, 0);

    // With all 3 optional dimensions
    const inputAllOpt: UnifiedHealthInput = {
      limits: baseLimits,
      orgId: 'org-1',
      codeCoverage: 80,
      metadataCounts: makeMetadataCounts(),
      securitySettings: makeSecuritySettings(),
    };
    const reportAllOpt = scorer.calculate(inputAllOpt);
    const limitsWeightAllOpt = reportAllOpt.factors
      .filter((f) => f.category !== 'metadata' && f.category !== 'coverage' && f.category !== 'security')
      .reduce((sum, f) => sum + f.weight, 0);

    // Limit weights should be smaller when optional dimensions are present
    expect(limitsWeightAllOpt).toBeLessThan(limitsWeightNoOpt);
  });

  it('should cap trend penalty at 15 points', () => {
    const limits = [makeLimit('DailyApiRequests', 15000, 50)];

    // Extreme trend: 60% change -> penalty = min(15, 60*0.5) = 15
    const mockTrendStorage = makeMockTrendStorage({
      DailyApiRequests: { direction: 'up', changePercent: 60 },
    });

    const inputNoTrend: UnifiedHealthInput = { limits, orgId: 'org-1' };
    const inputWithTrend: UnifiedHealthInput = {
      limits,
      orgId: 'org-1',
      trendStorage: mockTrendStorage,
    };

    const scoreNoTrend = scorer.calculate(inputNoTrend).factors[0].score;
    const scoreWithTrend = scorer.calculate(inputWithTrend).factors[0].score;

    expect(scoreNoTrend - scoreWithTrend).toBe(15);
  });

  it('should build appropriate summary for each status level', () => {
    // Healthy with no risks
    const healthyInput: UnifiedHealthInput = {
      limits: [makeLimit('DailyApiRequests', 15000, 10)],
      orgId: 'org-1',
    };
    expect(scorer.calculate(healthyInput).summary).toContain('healthy');

    // Critical
    const criticalInput: UnifiedHealthInput = {
      limits: [
        makeLimit('DailyApiRequests', 15000, 96),
        makeLimit('DataStorageMB', 500, 95),
      ],
      orgId: 'org-1',
    };
    expect(scorer.calculate(criticalInput).summary).toContain('Critical');
  });

  it('should include extra limits with remaining weight', () => {
    const input: UnifiedHealthInput = {
      limits: [
        makeLimit('DailyApiRequests', 15000, 20),
        makeLimit('SomeOtherLimit', 5000, 60),
      ],
      orgId: 'org-1',
    };
    const report = scorer.calculate(input);
    expect(report.factors.length).toBe(2);
    const other = report.factors.find((f) => f.name === 'SomeOtherLimit');
    expect(other).toBeDefined();
    expect(other!.category).toBe('limits');
  });
});
