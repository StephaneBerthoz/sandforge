import { describe, it, expect, beforeEach } from 'vitest';
import { AnomalyDetector, type DataSample } from './AnomalyDetector';

describe('AnomalyDetector', () => {
  let detector: AnomalyDetector;

  beforeEach(() => {
    detector = new AnomalyDetector();
  });

  // --- Empty data handling ---

  it('should return empty report for zero records', () => {
    const sample: DataSample = { fields: ['Name'], records: [] };
    const report = detector.detectAnomalies(sample, 'Account');

    expect(report.objectName).toBe('Account');
    expect(report.totalRecords).toBe(0);
    expect(report.anomalies).toEqual([]);
    expect(report.score).toBe(0);
    expect(report.scannedAt).toBeDefined();
  });

  // --- Outlier detection ---

  it('should detect numeric outliers beyond 3 standard deviations', () => {
    const records = [
      ...Array.from({ length: 20 }, (_, i) => ({ Amount: 100 + i })),
      { Amount: 10000 },
    ];
    const sample: DataSample = { fields: ['Amount'], records };
    const report = detector.detectAnomalies(sample, 'Opportunity');

    const outlier = report.anomalies.find((a) => a.type === 'outlier' && a.field === 'Amount');
    expect(outlier).toBeDefined();
    expect(outlier?.affectedRecords).toBeGreaterThan(0);
    expect(outlier?.examples).toContain(10000);
  });

  it('should not flag outliers when all values are similar', () => {
    const records = Array.from({ length: 10 }, () => ({ Amount: 100 }));
    const sample: DataSample = { fields: ['Amount'], records };
    const report = detector.detectAnomalies(sample, 'Opportunity');

    const outlier = report.anomalies.find((a) => a.type === 'outlier');
    expect(outlier).toBeUndefined();
  });

  // --- Pattern detection (burst creation) ---

  it('should detect burst creation patterns in date fields', () => {
    const baseTime = new Date('2025-01-15T10:00:00Z').getTime();
    const records = Array.from({ length: 20 }, (_, i) => ({
      CreatedDate: new Date(baseTime + i * 10_000).toISOString(),
    }));
    const sample: DataSample = { fields: ['CreatedDate'], records };
    const report = detector.detectAnomalies(sample, 'Lead');

    const pattern = report.anomalies.find((a) => a.type === 'pattern');
    expect(pattern).toBeDefined();
    expect(pattern?.description).toContain('1-minute');
  });

  it('should not flag patterns when records are spread over time', () => {
    const baseTime = new Date('2025-01-15T10:00:00Z').getTime();
    const records = Array.from({ length: 10 }, (_, i) => ({
      CreatedDate: new Date(baseTime + i * 3_600_000).toISOString(),
    }));
    const sample: DataSample = { fields: ['CreatedDate'], records };
    const report = detector.detectAnomalies(sample, 'Lead');

    const pattern = report.anomalies.find((a) => a.type === 'pattern');
    expect(pattern).toBeUndefined();
  });

  // --- Inconsistency detection ---

  it('should detect future dates in timestamp fields', () => {
    const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const records = [{ CreatedDate: '2024-01-01T00:00:00Z' }, { CreatedDate: futureDate }];
    const sample: DataSample = { fields: ['CreatedDate'], records };
    const report = detector.detectAnomalies(sample, 'Account');

    const inconsistency = report.anomalies.find(
      (a) => a.type === 'inconsistency' && a.field === 'CreatedDate',
    );
    expect(inconsistency).toBeDefined();
    expect(inconsistency?.affectedRecords).toBe(1);
  });

  it('should detect negative amounts', () => {
    const records = [{ Amount: 100 }, { Amount: -50 }, { Amount: 200 }];
    const sample: DataSample = { fields: ['Amount'], records };
    const report = detector.detectAnomalies(sample, 'Opportunity');

    const inconsistency = report.anomalies.find(
      (a) => a.type === 'inconsistency' && a.field === 'Amount',
    );
    expect(inconsistency).toBeDefined();
    expect(inconsistency?.description).toContain('negative');
  });

  it('should not flag negative values on non-amount fields', () => {
    const records = [{ CustomScore: -10 }, { CustomScore: 20 }];
    const sample: DataSample = { fields: ['CustomScore'], records };
    const report = detector.detectAnomalies(sample, 'Account');

    const negativeAnomaly = report.anomalies.find(
      (a) => a.type === 'inconsistency' && a.description.includes('negative'),
    );
    expect(negativeAnomaly).toBeUndefined();
  });

  // --- Empty field detection ---

  it('should detect mostly empty fields', () => {
    const records = [
      { Industry: null },
      { Industry: null },
      { Industry: null },
      { Industry: null },
      { Industry: null },
      { Industry: null },
      { Industry: null },
      { Industry: null },
      { Industry: null },
      { Industry: null },
      { Industry: 'Tech' },
    ];
    const sample: DataSample = { fields: ['Industry'], records };
    const report = detector.detectAnomalies(sample, 'Account');

    const empty = report.anomalies.find((a) => a.type === 'empty' && a.field === 'Industry');
    expect(empty).toBeDefined();
    expect(empty?.affectedRecords).toBe(10);
  });

  it('should not flag fields that are entirely empty', () => {
    const records = Array.from({ length: 5 }, () => ({ Description: null }));
    const sample: DataSample = { fields: ['Description'], records };
    const report = detector.detectAnomalies(sample, 'Account');

    const empty = report.anomalies.find((a) => a.type === 'empty');
    expect(empty).toBeUndefined();
  });

  // --- Duplicate detection ---

  it('should detect duplicate name values', () => {
    const records = [
      { Name: 'John Doe' },
      { Name: 'Jane Smith' },
      { Name: 'John Doe' },
      { Name: 'Bob Wilson' },
    ];
    const sample: DataSample = { fields: ['Name'], records };
    const report = detector.detectAnomalies(sample, 'Contact');

    const dup = report.anomalies.find((a) => a.type === 'duplicate' && a.field === 'Name');
    expect(dup).toBeDefined();
    expect(dup?.examples.some((e) => String(e).includes('john doe'))).toBe(true);
  });

  it('should detect duplicate email values', () => {
    const records = [{ Email: 'a@test.com' }, { Email: 'b@test.com' }, { Email: 'A@Test.com' }];
    const sample: DataSample = { fields: ['Email'], records };
    const report = detector.detectAnomalies(sample, 'Contact');

    const dup = report.anomalies.find((a) => a.type === 'duplicate' && a.field === 'Email');
    expect(dup).toBeDefined();
  });

  it('should not flag duplicates on non-name non-email fields', () => {
    const records = [{ Status: 'Active' }, { Status: 'Active' }];
    const sample: DataSample = { fields: ['Status'], records };
    const report = detector.detectAnomalies(sample, 'Account');

    const dup = report.anomalies.find((a) => a.type === 'duplicate');
    expect(dup).toBeUndefined();
  });

  // --- Score calculation ---

  it('should compute score proportional to anomalies', () => {
    const records = [
      ...Array.from({ length: 20 }, (_, i) => ({ Amount: 100 + i })),
      { Amount: 100000 },
    ];
    const sample: DataSample = { fields: ['Amount'], records };
    const report = detector.detectAnomalies(sample, 'Opportunity');

    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });

  it('should return score 0 for clean data', () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      Name: `Record ${i}`,
      Value: 100 + i,
    }));
    const sample: DataSample = { fields: ['Name', 'Value'], records };
    const report = detector.detectAnomalies(sample, 'Account');

    expect(report.score).toBe(0);
  });

  // --- getFieldStatistics ---

  it('should compute correct field statistics', () => {
    const sample: DataSample = {
      fields: ['Value'],
      records: [{ Value: 10 }, { Value: 20 }, { Value: 30 }, { Value: null }],
    };

    const stats = detector.getFieldStatistics(sample, 'Value');
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(30);
    expect(stats.avg).toBe(20);
    expect(stats.nullCount).toBe(1);
    expect(stats.uniqueCount).toBe(4);
    expect(stats.stdDev).toBeCloseTo(8.165, 2);
  });

  it('should return zero stats for all-null field', () => {
    const sample: DataSample = {
      fields: ['Missing'],
      records: [{ Missing: null }, { Missing: undefined }],
    };

    const stats = detector.getFieldStatistics(sample, 'Missing');
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(0);
    expect(stats.avg).toBe(0);
    expect(stats.stdDev).toBe(0);
    expect(stats.nullCount).toBe(2);
  });

  it('should count unique values correctly', () => {
    const sample: DataSample = {
      fields: ['Status'],
      records: [
        { Status: 'Active' },
        { Status: 'Active' },
        { Status: 'Inactive' },
        { Status: null },
      ],
    };

    const stats = detector.getFieldStatistics(sample, 'Status');
    expect(stats.uniqueCount).toBe(3);
  });

  // --- Report metadata ---

  it('should include scannedAt timestamp in ISO format', () => {
    const sample: DataSample = { fields: ['X'], records: [{ X: 1 }] };
    const report = detector.detectAnomalies(sample, 'Test');
    expect(() => new Date(report.scannedAt)).not.toThrow();
    expect(report.scannedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
