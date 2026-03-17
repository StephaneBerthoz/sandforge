import { describe, it, expect } from 'vitest';
import { OrgHealthScoreCalculator } from './OrgHealthScoreCalculator';
import type { OrgMetadataCounts, OrgSecuritySettings } from './OrgHealthScoreCalculator';
import type { ApiLimit } from '@sandforge/shared';

function makeLimit(name: string, max: number, usedPercent: number): ApiLimit {
  const remaining = Math.round(max * (1 - usedPercent / 100));
  return { name, max, remaining, usedPercent };
}

function makeSecuritySettings(overrides?: Partial<OrgSecuritySettings>): OrgSecuritySettings {
  return {
    passwordMinLength: 12,
    passwordComplexity: true,
    sessionTimeout: 120,
    mfaEnabled: true,
    ipRestrictions: true,
    ...overrides,
  };
}

function makeMetadataCounts(overrides?: Partial<OrgMetadataCounts>): OrgMetadataCounts {
  return {
    customObjectCount: 30,
    customFieldCount: 100,
    apexClassCount: 50,
    ...overrides,
  };
}

describe('OrgHealthScoreCalculator', () => {
  const calc = new OrgHealthScoreCalculator();

  it('should return 5 dimensions', () => {
    const result = calc.calculate(
      [makeLimit('DailyApiRequests', 15000, 20), makeLimit('DataStorageMB', 500, 10)],
      undefined,
      90,
      makeMetadataCounts(),
      makeSecuritySettings(),
    );
    expect(result.dimensions).toHaveLength(5);
    expect(result.dimensions.map((d) => d.name)).toEqual([
      'apiUsage',
      'storageUsage',
      'metadataComplexity',
      'codeCoverage',
      'securitySettings',
    ]);
  });

  it('should score high when everything is healthy', () => {
    const result = calc.calculate(
      [makeLimit('DailyApiRequests', 15000, 10), makeLimit('DataStorageMB', 500, 10)],
      undefined,
      95,
      makeMetadataCounts(),
      makeSecuritySettings(),
    );
    expect(result.overallScore).toBeGreaterThanOrEqual(90);
    expect(result.recommendations).toHaveLength(0);
  });

  it('should detect high API usage and generate recommendation', () => {
    const result = calc.calculate(
      [makeLimit('DailyApiRequests', 15000, 85), makeLimit('DataStorageMB', 500, 20)],
      undefined,
      80,
      makeMetadataCounts(),
      makeSecuritySettings(),
    );
    const apiDim = result.dimensions.find((d) => d.name === 'apiUsage');
    expect(apiDim?.score).toBeLessThan(50);
    expect(result.recommendations.some((r) => r.includes('API usage'))).toBe(true);
  });

  it('should detect high storage usage', () => {
    const result = calc.calculate(
      [makeLimit('DailyApiRequests', 15000, 10), makeLimit('DataStorageMB', 500, 90)],
      undefined,
      80,
      makeMetadataCounts(),
      makeSecuritySettings(),
    );
    const storageDim = result.dimensions.find((d) => d.name === 'storageUsage');
    expect(storageDim?.score).toBeLessThan(30);
    expect(result.recommendations.some((r) => r.includes('Storage'))).toBe(true);
  });

  it('should detect low code coverage', () => {
    const result = calc.calculate(
      [makeLimit('DailyApiRequests', 15000, 10), makeLimit('DataStorageMB', 500, 10)],
      undefined,
      50,
      makeMetadataCounts(),
      makeSecuritySettings(),
    );
    const coverageDim = result.dimensions.find((d) => d.name === 'codeCoverage');
    expect(coverageDim?.score).toBeLessThan(30);
    expect(result.recommendations.some((r) => r.includes('coverage'))).toBe(true);
  });

  it('should detect weak security settings', () => {
    const result = calc.calculate(
      [makeLimit('DailyApiRequests', 15000, 10), makeLimit('DataStorageMB', 500, 10)],
      undefined,
      80,
      makeMetadataCounts(),
      makeSecuritySettings({ mfaEnabled: false, passwordMinLength: 6, passwordComplexity: false }),
    );
    const secDim = result.dimensions.find((d) => d.name === 'securitySettings');
    expect(secDim?.score).toBeLessThan(60);
    expect(result.recommendations.some((r) => r.includes('security'))).toBe(true);
  });

  it('should handle missing limits gracefully', () => {
    const result = calc.calculate(
      [],
      undefined,
      80,
      makeMetadataCounts(),
      makeSecuritySettings(),
    );
    const apiDim = result.dimensions.find((d) => d.name === 'apiUsage');
    expect(apiDim?.score).toBe(100);
  });

  it('should handle missing security settings', () => {
    const result = calc.calculate(
      [makeLimit('DailyApiRequests', 15000, 10), makeLimit('DataStorageMB', 500, 10)],
      undefined,
      80,
      makeMetadataCounts(),
    );
    const secDim = result.dimensions.find((d) => d.name === 'securitySettings');
    expect(secDim?.score).toBe(50);
  });

  it('should detect high metadata complexity', () => {
    const result = calc.calculate(
      [makeLimit('DailyApiRequests', 15000, 10), makeLimit('DataStorageMB', 500, 10)],
      undefined,
      80,
      makeMetadataCounts({ customObjectCount: 400, customFieldCount: 1800, apexClassCount: 900 }),
      makeSecuritySettings(),
    );
    const metaDim = result.dimensions.find((d) => d.name === 'metadataComplexity');
    expect(metaDim?.score).toBeLessThan(40);
    expect(result.recommendations.some((r) => r.includes('metadata'))).toBe(true);
  });

  it('should produce overall score between 0 and 100', () => {
    const result = calc.calculate(
      [makeLimit('DailyApiRequests', 15000, 96), makeLimit('DataStorageMB', 500, 98)],
      undefined,
      30,
      makeMetadataCounts({ customObjectCount: 600, customFieldCount: 3000, apexClassCount: 1500 }),
      makeSecuritySettings({ mfaEnabled: false, passwordMinLength: 4, passwordComplexity: false, ipRestrictions: false }),
    );
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
  });

  it('should use orgInfo counts when metadataCounts not provided', () => {
    const result = calc.calculate(
      [makeLimit('DailyApiRequests', 15000, 10), makeLimit('DataStorageMB', 500, 10)],
      { customObjectCount: 200, apexClassCount: 400 } as import('@sandforge/shared').OrgInfo,
      80,
      undefined,
      makeSecuritySettings(),
    );
    const metaDim = result.dimensions.find((d) => d.name === 'metadataComplexity');
    expect(metaDim?.detail).toContain('200 custom objects');
  });
});
