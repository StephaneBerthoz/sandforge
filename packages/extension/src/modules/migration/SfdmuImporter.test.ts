import { describe, it, expect, vi } from 'vitest';
import {
  SfdmuImporter,
  sfdmuExportSchema,
} from './SfdmuImporter';
import type { FileReader, SfdmuExport } from './SfdmuImporter';

function createMockFileReader(content: string): FileReader {
  return {
    readFile: vi.fn().mockResolvedValue(content),
  };
}

function createRealisticSfdmuExport(): SfdmuExport {
  return {
    objects: [
      {
        query: 'SELECT Id, Name, Industry, BillingCity FROM Account WHERE IsDeleted = false',
        operation: 'Upsert',
        externalId: 'Name',
        objectName: 'Account',
        master: true,
        excludedFields: ['OwnerId', 'CreatedDate'],
        fieldMapping: [
          { sourceField: 'BillingCity', targetField: 'ShippingCity' },
        ],
        valuesMapping: [
          { fieldName: 'Industry', rawValue: 'Tech', mappedValue: 'Technology' },
          { fieldName: 'Industry', rawValue: 'Fin', mappedValue: 'Financial Services' },
        ],
        deleteOldData: false,
        updateWithMockData: false,
        mockFields: [],
      },
      {
        query: 'SELECT Id, FirstName, LastName, Email, Account.Name FROM Contact',
        operation: 'Insert',
        externalId: 'Email',
        objectName: 'Contact',
        master: true,
        excludedFields: [],
        fieldMapping: [],
        valuesMapping: [],
        deleteOldData: false,
        updateWithMockData: false,
        mockFields: [],
      },
      {
        query: 'SELECT Id, Subject, Status FROM Case',
        operation: 'Readonly',
        objectName: 'Case',
        master: true,
        excludedFields: [],
        fieldMapping: [],
        valuesMapping: [],
        deleteOldData: false,
        updateWithMockData: false,
        mockFields: [],
      },
    ],
    apiVersion: '59.0',
    bulkApiVersion: '2.0',
    allOrNone: false,
  };
}

describe('SfdmuImporter', () => {
  describe('import', () => {
    it('should parse and convert a valid SFDMU export.json', async () => {
      const exportData = createRealisticSfdmuExport();
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const result = await importer.import('/path/to/export.json');

      expect(result.name).toBe('SFDMU Import');
      expect(result.direction).toBe('source_to_target');
      expect(result.mode).toBe('full');
      expect(result.conflictStrategy).toBe('source_wins');
      // Readonly objects are filtered out
      expect(result.objects).toHaveLength(2);
    });

    it('should map SFDMU operations correctly', async () => {
      const exportData = createRealisticSfdmuExport();
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const result = await importer.import('/path/to/export.json');

      expect(result.objects[0].operation).toBe('upsert');
      expect(result.objects[1].operation).toBe('insert');
    });

    it('should map externalId correctly', async () => {
      const exportData = createRealisticSfdmuExport();
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const result = await importer.import('/path/to/export.json');

      expect(result.objects[0].externalIdField).toBe('Name');
      expect(result.objects[1].externalIdField).toBe('Email');
    });

    it('should convert field mappings to FieldMapping[]', async () => {
      const exportData = createRealisticSfdmuExport();
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const result = await importer.import('/path/to/export.json');

      expect(result.objects[0].fieldMappings).toHaveLength(1);
      expect(result.objects[0].fieldMappings[0]).toEqual({
        sourceField: 'BillingCity',
        targetField: 'ShippingCity',
        type: 'rename',
      });
    });

    it('should convert values mappings to TransformRule[]', async () => {
      const exportData = createRealisticSfdmuExport();
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const result = await importer.import('/path/to/export.json');

      expect(result.objects[0].transformRules).toHaveLength(1);
      expect(result.objects[0].transformRules[0].type).toBe('map_value');
      expect(result.objects[0].transformRules[0].config.valueMap).toEqual({
        Tech: 'Technology',
        Fin: 'Financial Services',
      });
    });

    it('should preserve excluded fields', async () => {
      const exportData = createRealisticSfdmuExport();
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const result = await importer.import('/path/to/export.json');

      expect(result.objects[0].excludedFields).toEqual(['OwnerId', 'CreatedDate']);
    });

    it('should assign insertOrder based on array index', async () => {
      const exportData = createRealisticSfdmuExport();
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const result = await importer.import('/path/to/export.json');

      expect(result.objects[0].insertOrder).toBe(1);
      expect(result.objects[1].insertOrder).toBe(2);
    });

    it('should throw on invalid JSON', async () => {
      const reader = createMockFileReader('not json');
      const importer = new SfdmuImporter(reader);

      await expect(importer.import('/path/to/file.json')).rejects.toThrow();
    });

    it('should throw on missing required fields', async () => {
      const reader = createMockFileReader(JSON.stringify({ objects: [] }));
      const importer = new SfdmuImporter(reader);

      await expect(importer.import('/path/to/file.json')).rejects.toThrow();
    });

    it('should set externalIdField to undefined when externalId is Id', async () => {
      const exportData: SfdmuExport = {
        objects: [
          {
            query: 'SELECT Id, Name FROM Account',
            operation: 'Upsert',
            externalId: 'Id',
            objectName: 'Account',
            master: true,
            excludedFields: [],
            fieldMapping: [],
            valuesMapping: [],
            deleteOldData: false,
            updateWithMockData: false,
            mockFields: [],
          },
        ],
      };
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const result = await importer.import('/path/to/export.json');

      expect(result.objects[0].externalIdField).toBeUndefined();
    });

    it('should mark same-name field mappings as direct type', async () => {
      const exportData: SfdmuExport = {
        objects: [
          {
            query: 'SELECT Id, Name FROM Account',
            operation: 'Upsert',
            externalId: 'Name',
            objectName: 'Account',
            master: true,
            excludedFields: [],
            fieldMapping: [
              { sourceField: 'Name', targetField: 'Name' },
            ],
            valuesMapping: [],
            deleteOldData: false,
            updateWithMockData: false,
            mockFields: [],
          },
        ],
      };
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const result = await importer.import('/path/to/export.json');

      expect(result.objects[0].fieldMappings[0].type).toBe('direct');
    });

    it('should preserve query and where/orderBy metadata', async () => {
      const exportData: SfdmuExport = {
        objects: [
          {
            query: 'SELECT Id, Name FROM Account WHERE IsActive = true ORDER BY Name',
            operation: 'Upsert',
            externalId: 'Name',
            objectName: 'Account',
            master: true,
            excludedFields: [],
            fieldMapping: [],
            valuesMapping: [],
            deleteOldData: false,
            updateWithMockData: false,
            mockFields: [],
            where: 'IsActive = true',
            orderBy: 'Name',
          },
        ],
      };
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const result = await importer.import('/path/to/export.json');

      expect(result.objects[0].where).toBe('IsActive = true');
      expect(result.objects[0].orderBy).toBe('Name');
    });
  });

  describe('extractDependencies', () => {
    it('should extract parent/child dependencies from relationship fields', () => {
      const exportData = createRealisticSfdmuExport();
      const reader = createMockFileReader('');
      const importer = new SfdmuImporter(reader);

      const edges = importer.extractDependencies(exportData);

      expect(edges.length).toBeGreaterThanOrEqual(1);
      const accountContactEdge = edges.find(
        (e) => e.parent === 'Account' && e.child === 'Contact'
      );
      expect(accountContactEdge).toBeDefined();
      expect(accountContactEdge?.field).toBe('Account');
    });

    it('should skip non-master objects', () => {
      const exportData: SfdmuExport = {
        objects: [
          {
            query: 'SELECT Id, Name FROM Account',
            operation: 'Upsert',
            objectName: 'Account',
            master: true,
            excludedFields: [],
            fieldMapping: [],
            valuesMapping: [],
            deleteOldData: false,
            updateWithMockData: false,
            mockFields: [],
            externalId: 'Id',
          },
          {
            query: 'SELECT Id, Account.Name FROM Contact',
            operation: 'Insert',
            objectName: 'Contact',
            master: false,
            excludedFields: [],
            fieldMapping: [],
            valuesMapping: [],
            deleteOldData: false,
            updateWithMockData: false,
            mockFields: [],
            externalId: 'Id',
          },
        ],
      };

      const reader = createMockFileReader('');
      const importer = new SfdmuImporter(reader);
      const edges = importer.extractDependencies(exportData);

      // Contact is non-master so no edges from it
      const contactEdges = edges.filter((e) => e.child === 'Contact');
      expect(contactEdges).toHaveLength(0);
    });

    it('should return empty array when no relationships exist', () => {
      const exportData: SfdmuExport = {
        objects: [
          {
            query: 'SELECT Id, Name FROM Account',
            operation: 'Upsert',
            objectName: 'Account',
            master: true,
            excludedFields: [],
            fieldMapping: [],
            valuesMapping: [],
            deleteOldData: false,
            updateWithMockData: false,
            mockFields: [],
            externalId: 'Id',
          },
        ],
      };

      const reader = createMockFileReader('');
      const importer = new SfdmuImporter(reader);
      const edges = importer.extractDependencies(exportData);

      expect(edges).toHaveLength(0);
    });
  });

  describe('sfdmuExportSchema', () => {
    it('should validate a correct SFDMU export', () => {
      const data = createRealisticSfdmuExport();
      const result = sfdmuExportSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should reject empty objects array', () => {
      const result = sfdmuExportSchema.safeParse({ objects: [] });
      expect(result.success).toBe(false);
    });

    it('should reject missing query field', () => {
      const result = sfdmuExportSchema.safeParse({
        objects: [{ operation: 'Upsert', objectName: 'Account' }],
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid operation', () => {
      const result = sfdmuExportSchema.safeParse({
        objects: [{
          query: 'SELECT Id FROM Account',
          operation: 'InvalidOp',
          objectName: 'Account',
        }],
      });
      expect(result.success).toBe(false);
    });

    it('should apply defaults for optional fields', () => {
      const data = {
        objects: [{
          query: 'SELECT Id FROM Account',
          operation: 'Upsert',
          objectName: 'Account',
        }],
      };
      const result = sfdmuExportSchema.parse(data);
      expect(result.objects[0].excludedFields).toEqual([]);
      expect(result.objects[0].master).toBe(true);
      expect(result.objects[0].externalId).toBe('Id');
    });
  });
});
