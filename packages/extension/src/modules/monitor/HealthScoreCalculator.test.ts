import { describe, it, expect } from 'vitest';
import { HealthScoreCalculator } from './HealthScoreCalculator';
import type { ApiLimit } from '@sandforge/shared';

function makeLimit(name: string, max: number, usedPercent: number): ApiLimit {
  const remaining = Math.round(max * (1 - usedPercent / 100));
  return { name, max, remaining, usedPercent };
}

describe('HealthScoreCalculator', () => {
  const calc = new HealthScoreCalculator();

  it('should return 100 for empty limits', () => {
    const report = calc.calculate([]);
    expect(report.overallScore).toBe(100);
    expect(report.overallStatus).toBe('healthy');
    expect(report.factors).toHaveLength(0);
  });

  it('should score healthy when all limits are low', () => {
    const limits = [
      makeLimit('DailyApiRequests', 15000, 20),
      makeLimit('DataStorageMB', 500, 10),
      makeLimit('DailySoqlQueries', 100000, 30),
      makeLimit('DailyDmlStatements', 150000, 25),
      makeLimit('DailyAsyncApexExecutions', 250000, 15),
    ];
    const report = calc.calculate(limits);
    expect(report.overallScore).toBe(100);
    expect(report.overallStatus).toBe('healthy');
    expect(report.topRisks).toHaveLength(0);
  });

  it('should detect warning status', () => {
    const limits = [
      makeLimit('DailyApiRequests', 15000, 82),
      makeLimit('DataStorageMB', 500, 40),
      makeLimit('DailySoqlQueries', 100000, 30),
    ];
    const report = calc.calculate(limits);
    expect(report.overallStatus).toBe('healthy'); // still healthy overall
    const apiCallsFactor = report.factors.find(f => f.name === 'DailyApiRequests');
    expect(apiCallsFactor?.status).toBe('warning');
    expect(apiCallsFactor?.score).toBe(50);
    expect(report.topRisks.length).toBeGreaterThan(0);
  });

  it('should detect critical status', () => {
    const limits = [
      makeLimit('DailyApiRequests', 15000, 96),
      makeLimit('DataStorageMB', 500, 92),
      makeLimit('DailySoqlQueries', 100000, 88),
      makeLimit('DailyDmlStatements', 150000, 91),
      makeLimit('DailyAsyncApexExecutions', 250000, 94),
    ];
    const report = calc.calculate(limits);
    expect(report.overallScore).toBeLessThan(50);
    expect(report.overallStatus).toBe('critical');
    expect(report.topRisks.length).toBeLessThanOrEqual(3);
  });

  it('should generate recommendations for high usage', () => {
    const limits = [makeLimit('DailyApiRequests', 15000, 85)];
    const report = calc.calculate(limits);
    const factor = report.factors.find(f => f.name === 'DailyApiRequests');
    expect(factor?.recommendation).toContain('batch jobs');
  });

  it('should generate urgent recommendations for critical usage', () => {
    const limits = [makeLimit('DataStorageMB', 500, 95)];
    const report = calc.calculate(limits);
    const factor = report.factors.find(f => f.name === 'DataStorageMB');
    expect(factor?.recommendation).toContain('Urgent');
  });

  it('should include detail with usage numbers', () => {
    const limits = [makeLimit('DailyApiRequests', 15000, 83)];
    const report = calc.calculate(limits);
    const factor = report.factors.find(f => f.name === 'DailyApiRequests');
    expect(factor?.detail).toContain('83%');
    expect(factor?.detail).toContain('15');
    expect(factor?.detail).toContain('000');
  });

  it('should build appropriate summary', () => {
    const limits = [
      makeLimit('DailyApiRequests', 15000, 96),
      makeLimit('DataStorageMB', 500, 93),
    ];
    const report = calc.calculate(limits);
    expect(report.summary).toContain('Critical');
  });

  it('should include extra limits with remaining weight', () => {
    const limits = [
      makeLimit('DailyApiRequests', 15000, 20),
      makeLimit('SomeOtherLimit', 5000, 60),
    ];
    const report = calc.calculate(limits);
    expect(report.factors.length).toBe(2);
    const other = report.factors.find(f => f.name === 'SomeOtherLimit');
    expect(other).toBeDefined();
    expect(other?.category).toBe('limits');
  });

  it('should set all factors to stable trend by default', () => {
    const limits = [makeLimit('DailyApiRequests', 15000, 50)];
    const report = calc.calculate(limits);
    expect(report.factors[0].trend).toBe('stable');
  });

  it('should compute weighted score correctly', () => {
    // DailyApiRequests: 40% → score 100 (< 50), weight 0.20
    // DataStorageMB: 80% → score 50 (75-90 bracket), weight 0.20
    // Weighted avg = (100*0.20 + 50*0.20) / 0.40 = 75
    const limits = [
      makeLimit('DailyApiRequests', 15000, 40),
      makeLimit('DataStorageMB', 500, 80),
    ];
    const report = calc.calculate(limits);
    expect(report.overallScore).toBe(75);
    expect(report.overallStatus).toBe('healthy');
  });
});
