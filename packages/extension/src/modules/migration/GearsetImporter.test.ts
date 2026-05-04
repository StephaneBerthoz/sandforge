import { describe, it, expect, vi } from 'vitest';
import { GearsetImporter, gearsetReportSchema } from './GearsetImporter';
import type { FileReader, GearsetReport } from './GearsetImporter';

function createMockFileReader(content: string): FileReader {
  return {
    readFile: vi.fn().mockResolvedValue(content),
  };
}

function createRealisticGearsetReport(): GearsetReport {
  return {
    reportName: 'Dev vs QA Comparison',
    sourceOrg: {
      name: 'Dev Sandbox',
      id: 'org-source-001',
    },
    targetOrg: {
      name: 'QA Sandbox',
      id: 'org-target-001',
    },
    comparisonDate: '2026-02-20T10:30:00Z',
    components: [
      {
        componentName: 'AccountTrigger',
        componentType: 'ApexTrigger',
        status: 'Modified',
        sourceLastModified: '2026-02-19T08:00:00Z',
        targetLastModified: '2026-01-15T12:00:00Z',
        details: 'Logic updated for new validation',
      },
      {
        componentName: 'ContactHelper',
        componentType: 'ApexClass',
        status: 'Added',
        sourceLastModified: '2026-02-18T14:00:00Z',
      },
      {
        componentName: 'OldReport',
        componentType: 'Report',
        status: 'Deleted',
        targetLastModified: '2025-12-01T09:00:00Z',
      },
      {
        componentName: 'AdminProfile',
        componentType: 'Profile',
        status: 'Modified',
        sourceLastModified: '2026-02-15T16:00:00Z',
        targetLastModified: '2026-01-20T10:00:00Z',
      },
      {
        componentName: 'AccountLayout',
        componentType: 'Layout',
        status: 'Unchanged',
      },
      {
        componentName: 'DataAccessPermSet',
        componentType: 'PermissionSet',
        status: 'Modified',
        sourceLastModified: '2026-02-10T11:00:00Z',
        targetLastModified: '2026-01-10T09:00:00Z',
      },
      {
        componentName: 'LeadConversionFlow',
        componentType: 'FlowDefinition',
        status: 'Added',
        sourceLastModified: '2026-02-17T13:00:00Z',
      },
      {
        componentName: 'OpportunitySearch',
        componentType: 'LightningComponent',
        status: 'Modified',
      },
    ],
    includeManaged: false,
    includeUnmanaged: true,
    filterTypes: ['ApexClass', 'ApexTrigger', 'Flow'],
  };
}

describe('GearsetImporter', () => {
  describe('import', () => {
    it('should parse and convert a valid Gearset report', async () => {
      const report = createRealisticGearsetReport();
      const reader = createMockFileReader(JSON.stringify(report));
      const importer = new GearsetImporter(reader);

      const result = await importer.import('/path/to/report.json');

      expect(result.name).toBe('Dev vs QA Comparison');
      expect(result.sourceOrgId).toBe('org-source-001');
      expect(result.targetOrgId).toBe('org-target-001');
      expect(result.createdAt).toBe('2026-02-20T10:30:00Z');
    });

    it('should map component types to MetadataComponentType', async () => {
      const report = createRealisticGearsetReport();
      const reader = createMockFileReader(JSON.stringify(report));
      const importer = new GearsetImporter(reader);

      const result = await importer.import('/path/to/report.json');

      expect(result.componentTypes).toContain('ApexTrigger');
      expect(result.componentTypes).toContain('ApexClass');
      expect(result.componentTypes).toContain('Report');
      expect(result.componentTypes).toContain('Profile');
      expect(result.componentTypes).toContain('Flow');
      expect(result.componentTypes).toContain('LightningComponentBundle');
    });

    it('should set mode to full when both permissions and metadata exist', async () => {
      const report = createRealisticGearsetReport();
      const reader = createMockFileReader(JSON.stringify(report));
      const importer = new GearsetImporter(reader);

      const result = await importer.import('/path/to/report.json');

      expect(result.mode).toBe('full');
    });

    it('should set mode to permissions when only permission types exist', async () => {
      const report: GearsetReport = {
        reportName: 'Permission Check',
        sourceOrg: { name: 'Dev', id: 'src-1' },
        targetOrg: { name: 'QA', id: 'tgt-1' },
        comparisonDate: '2026-02-20T10:30:00Z',
        components: [
          {
            componentName: 'Admin',
            componentType: 'Profile',
            status: 'Modified',
          },
          {
            componentName: 'DataAccess',
            componentType: 'PermissionSet',
            status: 'Added',
          },
        ],
        includeManaged: false,
        includeUnmanaged: true,
        filterTypes: [],
      };

      const reader = createMockFileReader(JSON.stringify(report));
      const importer = new GearsetImporter(reader);
      const result = await importer.import('/path/to/report.json');

      expect(result.mode).toBe('permissions');
    });

    it('should set mode to metadata when no permission types exist', async () => {
      const report: GearsetReport = {
        reportName: 'Code Changes',
        sourceOrg: { name: 'Dev', id: 'src-1' },
        targetOrg: { name: 'QA', id: 'tgt-1' },
        comparisonDate: '2026-02-20T10:30:00Z',
        components: [
          {
            componentName: 'MyClass',
            componentType: 'ApexClass',
            status: 'Modified',
          },
        ],
        includeManaged: false,
        includeUnmanaged: true,
        filterTypes: [],
      };

      const reader = createMockFileReader(JSON.stringify(report));
      const importer = new GearsetImporter(reader);
      const result = await importer.import('/path/to/report.json');

      expect(result.mode).toBe('metadata');
    });

    it('should preserve includeManaged and includeUnmanaged flags', async () => {
      const report = createRealisticGearsetReport();
      const reader = createMockFileReader(JSON.stringify(report));
      const importer = new GearsetImporter(reader);

      const result = await importer.import('/path/to/report.json');

      expect(result.includeManaged).toBe(false);
      expect(result.includeUnmanaged).toBe(true);
    });

    it('should throw on invalid JSON', async () => {
      const reader = createMockFileReader('not json');
      const importer = new GearsetImporter(reader);

      await expect(importer.import('/path/to/file.json')).rejects.toThrow();
    });

    it('should throw on missing required fields', async () => {
      const reader = createMockFileReader(JSON.stringify({ reportName: 'X' }));
      const importer = new GearsetImporter(reader);

      await expect(importer.import('/path/to/file.json')).rejects.toThrow();
    });

    it('should map unknown component types to Other', async () => {
      const report: GearsetReport = {
        reportName: 'Unknown Types',
        sourceOrg: { name: 'Dev', id: 'src-1' },
        targetOrg: { name: 'QA', id: 'tgt-1' },
        comparisonDate: '2026-02-20T10:30:00Z',
        components: [
          {
            componentName: 'SomeWidget',
            componentType: 'UnknownWidget',
            status: 'Added',
          },
        ],
        includeManaged: false,
        includeUnmanaged: true,
        filterTypes: [],
      };

      const reader = createMockFileReader(JSON.stringify(report));
      const importer = new GearsetImporter(reader);
      const result = await importer.import('/path/to/report.json');

      expect(result.componentTypes).toContain('Other');
    });
  });

  describe('extractComponentTypes', () => {
    it('should return unique component types', () => {
      const report = createRealisticGearsetReport();
      const reader = createMockFileReader('');
      const importer = new GearsetImporter(reader);

      const types = importer.extractComponentTypes(report);

      // Each type should appear only once
      expect(new Set(types).size).toBe(types.length);
    });

    it('should map FlowDefinition to Flow', () => {
      const report: GearsetReport = {
        reportName: 'Test',
        sourceOrg: { name: 'A', id: '1' },
        targetOrg: { name: 'B', id: '2' },
        comparisonDate: '2026-01-01T00:00:00Z',
        components: [{ componentName: 'MyFlow', componentType: 'FlowDefinition', status: 'Added' }],
        includeManaged: false,
        includeUnmanaged: true,
        filterTypes: [],
      };

      const reader = createMockFileReader('');
      const importer = new GearsetImporter(reader);
      const types = importer.extractComponentTypes(report);

      expect(types).toContain('Flow');
    });
  });

  describe('getSummary', () => {
    it('should count components by status', () => {
      const report = createRealisticGearsetReport();
      const reader = createMockFileReader('');
      const importer = new GearsetImporter(reader);

      const summary = importer.getSummary(report);

      expect(summary.total).toBe(8);
      expect(summary.added).toBe(2);
      expect(summary.deleted).toBe(1);
      expect(summary.modified).toBe(4);
      expect(summary.unchanged).toBe(1);
    });

    it('should handle empty components array', () => {
      const report: GearsetReport = {
        reportName: 'Empty',
        sourceOrg: { name: 'A', id: '1' },
        targetOrg: { name: 'B', id: '2' },
        comparisonDate: '2026-01-01T00:00:00Z',
        components: [],
        includeManaged: false,
        includeUnmanaged: true,
        filterTypes: [],
      };

      const reader = createMockFileReader('');
      const importer = new GearsetImporter(reader);
      const summary = importer.getSummary(report);

      expect(summary.total).toBe(0);
      expect(summary.added).toBe(0);
      expect(summary.deleted).toBe(0);
      expect(summary.modified).toBe(0);
      expect(summary.unchanged).toBe(0);
    });
  });

  describe('gearsetReportSchema', () => {
    it('should validate a correct report', () => {
      const report = createRealisticGearsetReport();
      const result = gearsetReportSchema.safeParse(report);
      expect(result.success).toBe(true);
    });

    it('should reject missing reportName', () => {
      const result = gearsetReportSchema.safeParse({
        sourceOrg: { name: 'A', id: '1' },
        targetOrg: { name: 'B', id: '2' },
        comparisonDate: '2026-01-01',
        components: [],
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid component status', () => {
      const result = gearsetReportSchema.safeParse({
        reportName: 'Test',
        sourceOrg: { name: 'A', id: '1' },
        targetOrg: { name: 'B', id: '2' },
        comparisonDate: '2026-01-01',
        components: [
          {
            componentName: 'X',
            componentType: 'ApexClass',
            status: 'InvalidStatus',
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('should apply defaults for optional fields', () => {
      const data = {
        reportName: 'Test',
        sourceOrg: { name: 'A', id: '1' },
        targetOrg: { name: 'B', id: '2' },
        comparisonDate: '2026-01-01',
        components: [],
      };
      const result = gearsetReportSchema.parse(data);
      expect(result.includeManaged).toBe(false);
      expect(result.includeUnmanaged).toBe(true);
      expect(result.filterTypes).toEqual([]);
    });
  });
});
