import { describe, it, expect, beforeEach } from 'vitest';
import { DataQualityScanner } from './DataQualityScanner';

describe('DataQualityScanner', () => {
  let scanner: DataQualityScanner;

  beforeEach(() => {
    scanner = new DataQualityScanner();
  });

  describe('scan', () => {
    it('should produce a scan result with score and rules', () => {
      const records = [
        { Name: 'Alice', Email: 'alice@test.com' },
        { Name: 'Bob', Email: 'bob@test.com' },
      ];

      const result = scanner.scan('org-1', 'Contact', records, ['completeness']);

      expect(result.orgId).toBe('org-1');
      expect(result.objectApiName).toBe('Contact');
      expect(result.totalRecords).toBe(2);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.rules.length).toBeGreaterThan(0);
    });

    it('should run multiple rule types', () => {
      const records = [{ Name: 'Alice', Email: 'alice@test.com' }];

      const result = scanner.scan('org-1', 'Contact', records, [
        'completeness',
        'uniqueness',
      ]);

      expect(result.rules.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle empty records', () => {
      const result = scanner.scan('org-1', 'Contact', [], ['completeness']);

      expect(result.totalRecords).toBe(0);
      expect(result.score).toBe(100);
      expect(result.rules).toHaveLength(0);
    });
  });

  describe('checkCompleteness', () => {
    it('should count filled fields as passed', () => {
      const records = [
        { Name: 'Alice' },
        { Name: 'Bob' },
        { Name: '' },
      ];

      const result = scanner.checkCompleteness(records, 'Name');

      expect(result.passed).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.passRate).toBeCloseTo(2 / 3);
    });

    it('should treat null and undefined as failures', () => {
      const records = [{ Name: null }, { Name: undefined }];

      const result = scanner.checkCompleteness(records, 'Name');

      expect(result.failed).toBe(2);
    });

    it('should collect sample failures', () => {
      const records = [{ Name: '' }];

      const result = scanner.checkCompleteness(records, 'Name');

      expect(result.sampleFailures).toHaveLength(1);
    });
  });

  describe('checkUniqueness', () => {
    it('should detect duplicate values', () => {
      const records = [
        { Email: 'a@b.com' },
        { Email: 'a@b.com' },
        { Email: 'c@d.com' },
      ];

      const result = scanner.checkUniqueness(records, 'Email');

      expect(result.failed).toBe(2);
      expect(result.passed).toBe(1);
    });

    it('should return full pass rate when all values are unique', () => {
      const records = [
        { Email: 'a@b.com' },
        { Email: 'c@d.com' },
      ];

      const result = scanner.checkUniqueness(records, 'Email');

      expect(result.passRate).toBe(1);
    });
  });

  describe('checkFormat', () => {
    it('should validate records against a regex pattern', () => {
      const records = [
        { Code: 'ABC-123' },
        { Code: 'invalid' },
        { Code: 'DEF-456' },
      ];

      const result = scanner.checkFormat(records, 'Code', /^[A-Z]{3}-\d{3}$/);

      expect(result.passed).toBe(2);
      expect(result.failed).toBe(1);
    });

    it('should fail null values', () => {
      const records = [{ Code: null }];

      const result = scanner.checkFormat(records, 'Code', /^.+$/);

      expect(result.failed).toBe(1);
    });
  });

  describe('computeScore', () => {
    it('should return 100 for empty results', () => {
      expect(scanner.computeScore([])).toBe(100);
    });

    it('should compute weighted average of pass rates', () => {
      const results = [
        {
          ruleType: 'completeness' as const,
          fieldApiName: 'Name',
          passed: 8,
          failed: 2,
          passRate: 0.8,
          sampleFailures: [],
        },
        {
          ruleType: 'uniqueness' as const,
          fieldApiName: 'Email',
          passed: 10,
          failed: 0,
          passRate: 1.0,
          sampleFailures: [],
        },
      ];

      const score = scanner.computeScore(results);

      expect(score).toBe(90);
    });

    it('should return 0 for all-failed results', () => {
      const results = [
        {
          ruleType: 'completeness' as const,
          fieldApiName: 'Name',
          passed: 0,
          failed: 10,
          passRate: 0,
          sampleFailures: [],
        },
      ];

      expect(scanner.computeScore(results)).toBe(0);
    });
  });
});
