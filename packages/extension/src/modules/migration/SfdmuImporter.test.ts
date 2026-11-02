import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { syncConfigSchema } from '@sandforge/shared';
import { SfdmuImporter, SfdmuTargetObjectError, sfdmuExportSchema } from './SfdmuImporter';
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
        fieldMapping: [{ sourceField: 'BillingCity', targetField: 'ShippingCity' }],
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
        externalId: 'Id',
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

      expect(result.objects[0].transformRules).toEqual([
        {
          type: 'map_value',
          field: 'Industry',
          config: { valueMap: { Tech: 'Technology', Fin: 'Financial Services' } },
        },
      ]);
    });

    it('gives each field its own value mapping, naming the field', async () => {
      // Grouped by field and the field then dropped, every group ran on every
      // field of the record: "New" meant for Status became "Open" in Subject.
      const reader = createMockFileReader(
        readFileSync(join(__dirname, 'fixtures', 'export.json'), 'utf8'),
      );

      const result = await new SfdmuImporter(reader).import('/path/to/export.json');

      expect(result.objects[0].transformRules).toEqual([
        {
          type: 'map_value',
          field: 'Status',
          config: { valueMap: { New: 'Open', Escalated: 'Working' } },
        },
      ]);
    });

    it('names a field the export renames as the target calls it, where the rule runs', async () => {
      const exportData = createRealisticSfdmuExport();
      exportData.objects[0].valuesMapping = [
        { fieldName: 'BillingCity', rawValue: 'Paris', mappedValue: 'PARIS' },
        { fieldName: 'Industry', rawValue: 'Tech', mappedValue: 'Technology' },
      ];
      const importer = new SfdmuImporter(createMockFileReader(JSON.stringify(exportData)));

      const result = await importer.import('/path/to/export.json');

      // BillingCity is written to ShippingCity; the rule runs on the mapped record.
      expect(result.objects[0].transformRules.map((rule) => rule.field)).toEqual([
        'ShippingCity',
        'Industry',
      ]);
    });

    it('converts to a configuration the sync schema takes whole, each rule with its field', async () => {
      const reader = createMockFileReader(
        readFileSync(join(__dirname, 'fixtures', 'export.json'), 'utf8'),
      );
      const config = await new SfdmuImporter(reader).import('/path/to/export.json');

      const parsed = syncConfigSchema.parse(config);

      expect(parsed.objects[0].transformRules[0].field).toBe('Status');
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
            fieldMapping: [{ sourceField: 'Name', targetField: 'Name' }],
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

  describe('a target object', () => {
    /** An export of Account with this `fieldMapping`, as the file writes it. */
    const accountMapped = (fieldMapping: unknown[], more: Record<string, unknown> = {}): string =>
      JSON.stringify({
        objects: [
          {
            query: 'SELECT Id, Name FROM Account',
            operation: 'Upsert',
            externalId: 'Name',
            objectName: 'Account',
            useFieldMapping: true,
            fieldMapping,
            ...more,
          },
        ],
      });

    const importing = (content: string) =>
      new SfdmuImporter(createMockFileReader(content)).import('/path/to/export.json');

    const refusalOf = async (content: string): Promise<SfdmuTargetObjectError> => {
      const refusal: unknown = await importing(content).catch((err: unknown) => err);
      expect(refusal).toBeInstanceOf(SfdmuTargetObjectError);
      return refusal as SfdmuTargetObjectError;
    };

    it('refuses an object sent to another, naming it, where it goes and its fields, rather than writing them on the source object', async () => {
      // It came out as `object: Account`, `Name → Company`, without a word.
      const refusal = await refusalOf(
        accountMapped([{ targetObject: 'Lead', sourceField: 'Name', targetField: 'Company' }]),
      );

      expect(refusal.objects).toEqual(['Account → Lead (Name → Company)']);
      expect(refusal.message).toContain('Nothing was imported');
      expect(refusal.message).toContain('Account → Lead (Name → Company)');
    });

    it('reads the target as SFDMU documents it, on an entry of its own beside the fields', async () => {
      const refusal = await refusalOf(
        accountMapped([
          { targetObject: 'Staff__c' },
          { sourceField: 'Name', targetField: 'Full_Name__c' },
          { sourceField: 'Phone', targetField: 'Mobile__c' },
        ]),
      );

      expect(refusal.objects).toEqual([
        'Account → Staff__c (Name → Full_Name__c, Phone → Mobile__c)',
      ]);
    });

    it('names an object sent to another with no field mapped', async () => {
      const refusal = await refusalOf(accountMapped([{ targetObject: 'Lead' }]));

      expect(refusal.objects).toEqual(['Account → Lead']);
    });

    it('names every object refused, and imports none of the others', async () => {
      const refusal = await refusalOf(
        JSON.stringify({
          objects: [
            {
              query: 'SELECT Id, Name FROM Account',
              operation: 'Insert',
              objectName: 'Account',
              fieldMapping: [{ targetObject: 'Lead' }],
            },
            { query: 'SELECT Id FROM Case', operation: 'Insert', objectName: 'Case' },
            {
              query: 'SELECT Id, LastName FROM Contact',
              operation: 'Insert',
              objectName: 'Contact',
              fieldMapping: [{ targetObject: 'Staff__c' }],
            },
          ],
        }),
      );

      expect(refusal.objects).toEqual(['Account → Lead', 'Contact → Staff__c']);
    });

    it('refuses it with useFieldMapping off too, as the fields would still be converted onto the source object', async () => {
      const refusal = await refusalOf(
        accountMapped([{ targetObject: 'Lead', sourceField: 'Name', targetField: 'Company' }], {
          useFieldMapping: false,
        }),
      );

      expect(refusal.objects).toEqual(['Account → Lead (Name → Company)']);
    });

    it('takes the last target named, as SFDMU does', async () => {
      const refusal = await refusalOf(
        accountMapped([{ targetObject: 'Account' }, { targetObject: 'Lead' }]),
      );
      expect(refusal.objects).toEqual(['Account → Lead']);

      const config = await importing(
        accountMapped([{ targetObject: 'Lead' }, { targetObject: 'Account' }]),
      );
      expect(config.objects[0].objectApiName).toBe('Account');
    });

    it('takes a target that names the object itself, whatever its case, for no target at all', async () => {
      const config = await importing(
        accountMapped([
          { targetObject: 'ACCOUNT' },
          { sourceField: 'BillingCity', targetField: 'ShippingCity' },
        ]),
      );

      expect(config.objects[0].objectApiName).toBe('Account');
      // The entry of the target maps no field: only the rename is left of the mapping.
      expect(config.objects[0].fieldMappings).toEqual([
        { sourceField: 'BillingCity', targetField: 'ShippingCity', type: 'rename' },
      ]);
    });

    it('takes an empty target for none, as SFDMU does', async () => {
      const config = await importing(
        accountMapped([{ targetObject: '', sourceField: 'Name', targetField: 'Name' }]),
      );

      expect(config.objects[0].fieldMappings).toEqual([
        { sourceField: 'Name', targetField: 'Name', type: 'direct' },
      ]);
    });

    it('does not refuse a Readonly object: it is left out, and nothing is written for it', async () => {
      const config = await importing(
        JSON.stringify({
          objects: [
            {
              query: 'SELECT Id FROM Account',
              operation: 'Readonly',
              objectName: 'Account',
              fieldMapping: [{ targetObject: 'Lead' }],
            },
            { query: 'SELECT Id FROM Case', operation: 'Insert', objectName: 'Case' },
          ],
        }),
      );

      expect(config.objects.map((object) => object.objectApiName)).toEqual(['Case']);
    });

    it.each([
      ['half a field pair', { sourceField: 'Name' }],
      ['half a field pair beside a target', { targetObject: 'Account', targetField: 'Name' }],
      ['an entry that names nothing', {}],
      ['an empty target and no field', { targetObject: '' }],
    ])('still refuses %s, which maps nothing', (_label, entry) => {
      const result = sfdmuExportSchema.safeParse({
        objects: [
          {
            query: 'SELECT Id FROM Account',
            operation: 'Insert',
            objectName: 'Account',
            fieldMapping: [entry],
          },
        ],
      });

      expect(result.success).toBe(false);
    });
  });

  describe('extractDependencies', () => {
    it('should extract parent/child dependencies from relationship fields', () => {
      const exportData = createRealisticSfdmuExport();
      const reader = createMockFileReader('');
      const importer = new SfdmuImporter(reader);

      const edges = importer.extractDependencies(exportData);

      expect(edges.length).toBeGreaterThanOrEqual(1);
      const accountContactEdge = edges.find((e) => e.parent === 'Account' && e.child === 'Contact');
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
        objects: [
          {
            query: 'SELECT Id FROM Account',
            operation: 'InvalidOp',
            objectName: 'Account',
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('should apply defaults for optional fields', () => {
      const data = {
        objects: [
          {
            query: 'SELECT Id FROM Account',
            operation: 'Upsert',
            objectName: 'Account',
          },
        ],
      };
      const result = sfdmuExportSchema.parse(data);
      expect(result.objects[0].excludedFields).toEqual([]);
      expect(result.objects[0].master).toBe(true);
      expect(result.objects[0].externalId).toBe('Id');
    });
  });
});
