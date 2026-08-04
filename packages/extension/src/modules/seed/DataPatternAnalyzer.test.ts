import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataPatternAnalyzer } from './DataPatternAnalyzer';
import type { FetchSampleDataFn, SampleDataResponse } from './DataPatternAnalyzer';

function createSampleResponse(overrides?: Partial<SampleDataResponse>): SampleDataResponse {
  return {
    records: [
      { Name: 'Acme Corp', Email: 'info@acme.com', Industry: 'Tech' },
      { Name: 'Globex Inc', Email: 'info@globex.com', Industry: 'Tech' },
      { Name: 'Initech', Email: null, Industry: 'Finance' },
    ],
    fields: [
      { name: 'Name', type: 'string', nillable: false },
      { name: 'Email', type: 'email', nillable: true },
      { name: 'Industry', type: 'string', nillable: true },
    ],
    totalCount: 100,
    ...overrides,
  };
}

describe('DataPatternAnalyzer', () => {
  let analyzer: DataPatternAnalyzer;
  let fetchSampleData: FetchSampleDataFn;

  beforeEach(() => {
    fetchSampleData = vi
      .fn<Parameters<FetchSampleDataFn>, ReturnType<FetchSampleDataFn>>()
      .mockResolvedValue(createSampleResponse());
    analyzer = new DataPatternAnalyzer(fetchSampleData);
  });

  describe('analyze', () => {
    it('should call fetchSampleData with correct parameters', async () => {
      await analyzer.analyze('org-1', 'Account');
      expect(fetchSampleData).toHaveBeenCalledWith('org-1', 'Account');
    });

    it('should return the correct object name', async () => {
      const result = await analyzer.analyze('org-1', 'Account');
      expect(result.objectName).toBe('Account');
    });

    it('should return the correct record count', async () => {
      const result = await analyzer.analyze('org-1', 'Account');
      expect(result.recordCount).toBe(100);
    });

    it('should analyze all fields', async () => {
      const result = await analyzer.analyze('org-1', 'Account');
      expect(result.fieldPatterns).toHaveLength(3);
    });

    it('should calculate null percentage correctly', async () => {
      const result = await analyzer.analyze('org-1', 'Account');
      const emailPattern = result.fieldPatterns.find((p) => p.fieldName === 'Email');

      expect(emailPattern).toBeDefined();
      expect(emailPattern!.nullPercent).toBeCloseTo(33.33, 1);
    });

    it('should calculate unique percentage correctly', async () => {
      const result = await analyzer.analyze('org-1', 'Account');
      const namePattern = result.fieldPatterns.find((p) => p.fieldName === 'Name');

      expect(namePattern).toBeDefined();
      expect(namePattern!.uniquePercent).toBe(100);
    });

    it('should suggest reference rule for reference fields', async () => {
      fetchSampleData = vi
        .fn<Parameters<FetchSampleDataFn>, ReturnType<FetchSampleDataFn>>()
        .mockResolvedValue({
          records: [{ AccountId: '001A' }],
          fields: [
            { name: 'AccountId', type: 'reference', nillable: true, referenceTo: ['Account'] },
          ],
          totalCount: 50,
        });
      analyzer = new DataPatternAnalyzer(fetchSampleData);

      const result = await analyzer.analyze('org-1', 'Contact');
      expect(result.fieldPatterns[0].suggestedRule).toBe('reference');
    });

    it('should suggest picklist_random for picklist fields', async () => {
      fetchSampleData = vi
        .fn<Parameters<FetchSampleDataFn>, ReturnType<FetchSampleDataFn>>()
        .mockResolvedValue({
          records: [{ Status: 'Open' }],
          fields: [
            {
              name: 'Status',
              type: 'picklist',
              nillable: false,
              picklistValues: ['Open', 'Closed'],
            },
          ],
          totalCount: 50,
        });
      analyzer = new DataPatternAnalyzer(fetchSampleData);

      const result = await analyzer.analyze('org-1', 'Case');
      expect(result.fieldPatterns[0].suggestedRule).toBe('picklist_random');
    });

    it('should suggest faker for email fields', async () => {
      fetchSampleData = vi
        .fn<Parameters<FetchSampleDataFn>, ReturnType<FetchSampleDataFn>>()
        .mockResolvedValue({
          records: [{ Email: 'a@b.com' }],
          fields: [{ name: 'Email', type: 'email', nillable: true }],
          totalCount: 50,
        });
      analyzer = new DataPatternAnalyzer(fetchSampleData);

      const result = await analyzer.analyze('org-1', 'Contact');
      expect(result.fieldPatterns[0].suggestedRule).toBe('faker');
    });

    it('should suggest static for low-uniqueness fields', async () => {
      fetchSampleData = vi
        .fn<Parameters<FetchSampleDataFn>, ReturnType<FetchSampleDataFn>>()
        .mockResolvedValue({
          records: Array.from({ length: 20 }, () => ({ Country: 'US' })),
          fields: [{ name: 'Country', type: 'string', nillable: false }],
          totalCount: 200,
        });
      analyzer = new DataPatternAnalyzer(fetchSampleData);

      const result = await analyzer.analyze('org-1', 'Account');
      expect(result.fieldPatterns[0].suggestedRule).toBe('static');
    });

    it('should suggest sequence for high-uniqueness fields', async () => {
      const records = Array.from({ length: 20 }, (_, i) => ({ Code: `CODE-${i}` }));
      fetchSampleData = vi
        .fn<Parameters<FetchSampleDataFn>, ReturnType<FetchSampleDataFn>>()
        .mockResolvedValue({
          records,
          fields: [{ name: 'Code', type: 'string', nillable: false }],
          totalCount: 200,
        });
      analyzer = new DataPatternAnalyzer(fetchSampleData);

      const result = await analyzer.analyze('org-1', 'Account');
      expect(result.fieldPatterns[0].suggestedRule).toBe('sequence');
    });

    it('should limit sample values to 5', async () => {
      const records = Array.from({ length: 20 }, (_, i) => ({ Name: `Name-${i}` }));
      fetchSampleData = vi
        .fn<Parameters<FetchSampleDataFn>, ReturnType<FetchSampleDataFn>>()
        .mockResolvedValue({
          records,
          fields: [{ name: 'Name', type: 'string', nillable: false }],
          totalCount: 200,
        });
      analyzer = new DataPatternAnalyzer(fetchSampleData);

      const result = await analyzer.analyze('org-1', 'Account');
      expect(result.fieldPatterns[0].sampleValues.length).toBeLessThanOrEqual(5);
    });

    it('should handle empty records gracefully', async () => {
      fetchSampleData = vi
        .fn<Parameters<FetchSampleDataFn>, ReturnType<FetchSampleDataFn>>()
        .mockResolvedValue({
          records: [],
          fields: [{ name: 'Name', type: 'string', nillable: false }],
          totalCount: 0,
        });
      analyzer = new DataPatternAnalyzer(fetchSampleData);

      const result = await analyzer.analyze('org-1', 'Account');
      expect(result.fieldPatterns[0].nullPercent).toBe(0);
      expect(result.fieldPatterns[0].uniquePercent).toBe(0);
    });

    it('should propagate fetch errors', async () => {
      fetchSampleData = vi
        .fn<Parameters<FetchSampleDataFn>, ReturnType<FetchSampleDataFn>>()
        .mockRejectedValue(new Error('Network error'));
      analyzer = new DataPatternAnalyzer(fetchSampleData);

      await expect(analyzer.analyze('org-1', 'Account')).rejects.toThrow('Network error');
    });
  });
});
