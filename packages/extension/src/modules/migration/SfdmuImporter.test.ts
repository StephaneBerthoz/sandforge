import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { syncConfigSchema } from '@sandforge/shared';
import {
  SfdmuImporter,
  SfdmuRefusal,
  SfdmuTargetObjectError,
  sfdmuExportSchema,
} from './SfdmuImporter';
import type { FileReader, SfdmuExport } from './SfdmuImporter';
import { syncConfigPayloadSchema } from '../../bridge/validatePayload';

/** An export.json alone in its folder, as the disk answers for the rest. */
function createMockFileReader(content: string): FileReader {
  return {
    readFile: vi.fn(async (path: string) => {
      if (path.endsWith('.json')) return content;
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
    }),
  };
}

/** The disk itself, for the fixtures: their mapping files sit beside them. */
const fromDisk: FileReader = { readFile: async (path) => readFileSync(path, 'utf8') };

const fixture = (...path: string[]): string => join(__dirname, 'fixtures', ...path);

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
        useFieldMapping: true,
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

      const { config: result } = await importer.import('/path/to/export.json');

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

      const { config: result } = await importer.import('/path/to/export.json');

      expect(result.objects[0].operation).toBe('upsert');
      expect(result.objects[1].operation).toBe('insert');
    });

    it('should map externalId correctly', async () => {
      const exportData = createRealisticSfdmuExport();
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const { config: result } = await importer.import('/path/to/export.json');

      expect(result.objects[0].externalIdField).toBe('Name');
      expect(result.objects[1].externalIdField).toBe('Email');
    });

    it('should convert field mappings to FieldMapping[]', async () => {
      const exportData = createRealisticSfdmuExport();
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const { config: result } = await importer.import('/path/to/export.json');

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

      const { config: result } = await importer.import('/path/to/export.json');

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
      const { config: result } = await new SfdmuImporter(fromDisk).import(fixture('export.json'));

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

      const { config: result } = await importer.import('/path/to/export.json');

      // BillingCity is written to ShippingCity; the rule runs on the mapped record.
      expect(result.objects[0].transformRules.map((rule) => rule.field)).toEqual([
        'ShippingCity',
        'Industry',
      ]);
    });

    it('converts to a configuration the sync schema takes whole, each rule with its field', async () => {
      const { config } = await new SfdmuImporter(fromDisk).import(fixture('export.json'));

      const parsed = syncConfigSchema.parse(config);

      expect(parsed.objects[0].transformRules[0].field).toBe('Status');
    });

    it('should preserve excluded fields', async () => {
      const exportData = createRealisticSfdmuExport();
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const { config: result } = await importer.import('/path/to/export.json');

      expect(result.objects[0].excludedFields).toEqual(['OwnerId', 'CreatedDate']);
    });

    it('should assign insertOrder based on array index', async () => {
      const exportData = createRealisticSfdmuExport();
      const reader = createMockFileReader(JSON.stringify(exportData));
      const importer = new SfdmuImporter(reader);

      const { config: result } = await importer.import('/path/to/export.json');

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

      const { config: result } = await importer.import('/path/to/export.json');

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
            useFieldMapping: true,
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

      const { config: result } = await importer.import('/path/to/export.json');

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

      const { config: result } = await importer.import('/path/to/export.json');

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

    const importing = async (content: string) =>
      (await new SfdmuImporter(createMockFileReader(content)).import('/path/to/export.json'))
        .config;

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
              useFieldMapping: true,
              fieldMapping: [{ targetObject: 'Lead' }],
            },
            { query: 'SELECT Id FROM Case', operation: 'Insert', objectName: 'Case' },
            {
              query: 'SELECT Id, LastName FROM Contact',
              operation: 'Insert',
              objectName: 'Contact',
              useFieldMapping: true,
              fieldMapping: [{ targetObject: 'Staff__c' }],
            },
          ],
        }),
      );

      expect(refusal.objects).toEqual(['Account → Lead', 'Contact → Staff__c']);
    });

    it('takes no target with useFieldMapping off, as SFDMU reads no mapping then', async () => {
      const config = await importing(
        accountMapped([{ targetObject: 'Lead', sourceField: 'Name', targetField: 'Company' }], {
          useFieldMapping: false,
        }),
      );

      expect(config.objects[0]).toMatchObject({ objectApiName: 'Account', fieldMappings: [] });
    });

    it('reads a target named in the FieldMapping.csv beside the export', async () => {
      const refusal: unknown = await new SfdmuImporter(fromDisk)
        .import(fixture('published', 'field-mapping', 'export.json'))
        .catch((err: unknown) => err);

      expect(refusal).toBeInstanceOf(SfdmuTargetObjectError);
      expect((refusal as SfdmuTargetObjectError).objects).toEqual([
        'Account → TestObject__c (ParentId → ParentTestObject__c, ExternalID__c → External_ID__c)',
      ]);
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

  describe('a real export.json', () => {
    const importing = (name: string) =>
      new SfdmuImporter(fromDisk).import(fixture('published', name, 'export.json'));

    /** The notes on an object, by code and detail. */
    const notesOn = (
      notes: Awaited<ReturnType<typeof importing>>['notes'],
      object: string,
    ): Array<[string, string?]> =>
      notes
        .filter((note) => note.object === object)
        .map((note) => (note.detail === undefined ? [note.code] : [note.code, note.detail]));

    it('imports the example of SFDMU’s README: the object from the query, the filter with it', async () => {
      // It ended on `objects.0.objectName: Invalid input`: no real file has that key.
      const { config, notes } = await importing('simple');

      expect(config.objects).toMatchObject([
        { objectApiName: 'Contact', operation: 'upsert', externalIdField: 'LastName' },
        {
          objectApiName: 'Account',
          operation: 'upsert',
          externalIdField: 'Name',
          where: "Name = 'John Smith'",
        },
      ]);
      // The slave object is read whole by Sync: said, not lost.
      expect(notesOn(notes, 'Contact')).toEqual([['upsertKey', 'LastName'], ['notMaster']]);
      expect(notesOn(notes, 'Account')).toEqual([['upsertKey', 'Name']]);
      expect(notes[0]).toEqual({ code: 'everyField' });
    });

    it.each(['simple', 'lookups', 'mock-fields', 'field-mapping-csv', 'values-mapping'])(
      'converts the %s example to what Sync’s boundary takes whole',
      async (name) => {
        const { config } = await importing(name);

        const checked = syncConfigPayloadSchema.safeParse(config);

        expect(checked.error?.issues).toBeUndefined();
      },
    );

    it('imports objects related by lookups in the order of the file, each with its key', async () => {
      const { config } = await importing('lookups');

      expect(config.objects.map((object) => [object.objectApiName, object.insertOrder])).toEqual([
        ['Account', 1],
        ['TestObject__c', 2],
        ['TestObject2__c', 3],
        ['TestObject3__c', 4],
      ]);
      expect(config.objects[0].where).toBe("Name LIKE 'TEST_ACC_%'");
      expect(config.objects[1].where).toBeUndefined();
    });

    it('imports the object sets of SFDMU’s example: the deletes by hierarchy left out, each said', async () => {
      const { config, notes } = await importing('object-sets');

      expect(config.objects).toMatchObject([
        { objectApiName: 'Account', operation: 'insert', where: "Name LIKE '%Account To Insert%'" },
        { objectApiName: 'Opportunity', operation: 'insert' },
      ]);
      expect(notes).toContainEqual({ code: 'objectSets', detail: '2' });
      expect(notesOn(notes, 'Account')).toEqual([['deletesElsewhere', 'DeleteHierarchy']]);
      expect(notesOn(notes, 'Opportunity')).toEqual([
        ['deletesElsewhere', 'DeleteHierarchy'],
        ['notMaster'],
      ]);
    });

    it('leaves the fields SFDMU fakes out of the write, and says so', async () => {
      // `mockFields` as objects ended on a Zod error: the schema took strings.
      const { config, notes } = await importing('mock-fields');

      expect(config.objects[0].excludedFields).toEqual(['Name']);
      expect(notesOn(notes, 'Account')).toContainEqual(['mockFields', 'Name']);
    });

    it('reads FieldMapping.csv with the export’s own entries over it, and only for the objects it has', async () => {
      const { config, notes } = await importing('field-mapping-csv');

      expect(config.objects).toHaveLength(1);
      expect(config.objects[0].fieldMappings).toEqual([
        { sourceField: 'ParentId', targetField: 'ParentTestObject__c', type: 'rename' },
        { sourceField: 'ExternalID__c', targetField: 'External_ID__c', type: 'rename' },
      ]);
      expect(notes.filter((note) => note.code === 'mappingFileUnread')).toEqual([]);
    });

    it('reads ValueMapping.csv, and names the rows a value mapping rule cannot apply', async () => {
      const { config, notes } = await importing('values-mapping');

      expect(config.objects[0].transformRules).toEqual([
        { type: 'map_value', field: 'Rating', config: { valueMap: { Hot: 'Warm' } } },
      ]);
      expect(notesOn(notes, 'Account')).toEqual([
        ['valueRows', 'Rating (Cold), TEST__c (/\\b(a|the) long[\\w]*\\b/), TEST__c (DDMM)'],
      ]);
    });

    it('imports the export of SFDMU’s own test suite, saying what each object leaves behind', async () => {
      const { config, notes } = await importing('sfdmu-test-suite');

      expect(config.objects.map((object) => object.objectApiName)).toEqual([
        'Account',
        'TestObject2__c',
        'Language__c',
        'TestObject3__c',
        'TestObject_Description__c',
        'TestObject__c',
        'TestObject4__c',
        'TestObject5__c',
      ]);
      expect(config.objects[0]).toMatchObject({
        externalIdField: 'Name',
        fieldMappings: [{ sourceField: 'Id', targetField: 'ExternalID__c', type: 'rename' }],
        where: "(Name LIKE 'ACC_%') OR (Name LIKE 'Rams%')",
      });
      // A composite key is no key for Sync: the object goes in without one.
      expect(config.objects[4].externalIdField).toBeUndefined();

      expect(notes).toContainEqual({
        code: 'settings',
        detail: 'allOrNone, apiVersion, allowFieldTruncation, bulkApiVersion',
      });
      expect(notesOn(notes, 'Account')).toEqual([
        ['upsertKey', 'Name'],
        ['deleteOldData'],
        ['settings', 'useCSVValuesMapping'],
      ]);
      // `updateWithMockData` with no `mockFields`: SFDMU fakes nothing there.
      expect(notesOn(notes, 'TestObject2__c')).toEqual([['deleteOldData']]);
      expect(notesOn(notes, 'TestObject3__c')).toEqual([
        ['deleteOldData'],
        ['mockFields', 'Name, an__c, Date__c, Test__c'],
      ]);
      expect(notesOn(notes, 'TestObject_Description__c')).toEqual([
        ['unusableKey', 'Language__r.LangCode__c;TestObject__r.Name'],
        ['deleteOldData'],
      ]);
      expect(notesOn(notes, 'Attachment')).toEqual([['excluded']]);
      expect(notesOn(notes, 'Note')).toEqual([['excluded']]);
    });
  });

  describe('naming the object', () => {
    const importing = (objects: unknown[]) =>
      new SfdmuImporter(createMockFileReader(JSON.stringify({ objects }))).import(
        '/path/to/export.json',
      );

    it('takes it from the query whatever its layout, its case, an alias or a subquery', async () => {
      const { config } = await importing([
        {
          query: `select a.Id,
            (SELECT Id FROM Contacts),
            a.Name
          from Account a
          where a.Name != 'x FROM Lead'
          order by a.Name desc`,
          operation: 'Insert',
        },
      ]);

      expect(config.objects[0]).toMatchObject({
        objectApiName: 'Account',
        where: "Name != 'x FROM Lead'",
        orderBy: 'Name desc',
      });
    });

    it('reads name, and objectName, where no FROM can be read, and says the query was not', async () => {
      const { config, notes } = await importing([
        { query: 'SELECT Id', name: 'Account', operation: 'Insert' },
        { query: 'SELECT Id', objectName: 'Contact', operation: 'Insert' },
      ]);

      expect(config.objects.map((object) => object.objectApiName)).toEqual(['Account', 'Contact']);
      expect(notes).toContainEqual({ code: 'queryUnread', object: 'Account' });
      expect(notes).toContainEqual({ code: 'queryUnread', object: 'Contact' });
    });

    it('takes the query over a name that differs, as SFDMU blanks name, and says so', async () => {
      const { config, notes } = await importing([
        { query: 'SELECT Id FROM Contact', name: 'Account', operation: 'Insert' },
      ]);

      expect(config.objects[0].objectApiName).toBe('Contact');
      expect(notes).toContainEqual({ code: 'nameDiffers', object: 'Contact', detail: 'Account' });
    });

    it('says nothing of a name that agrees with the query', async () => {
      const { notes } = await importing([
        { query: 'SELECT Id FROM Account', objectName: 'account', operation: 'Insert' },
      ]);

      expect(notes.filter((note) => note.code === 'nameDiffers')).toEqual([]);
    });

    it('leaves out an entry with a name and no query, which SFDMU drops, and says so', async () => {
      const { config, notes } = await importing([
        { name: 'Account', operation: 'Upsert' },
        { query: 'SELECT Id FROM Case', operation: 'Insert' },
      ]);

      expect(config.objects.map((object) => object.objectApiName)).toEqual(['Case']);
      expect(notes).toContainEqual({ code: 'noQuery', object: 'Account' });
    });
  });

  describe('a file it cannot import', () => {
    const refusalOf = async (content: string): Promise<SfdmuRefusal> => {
      const refusal: unknown = await new SfdmuImporter(createMockFileReader(content))
        .import('/path/to/export.json')
        .catch((err: unknown) => err);
      expect(refusal).toBeInstanceOf(SfdmuRefusal);
      return refusal as SfdmuRefusal;
    };

    it('refuses an entry that names no object anywhere, by its place, in words', async () => {
      const refusal = await refusalOf(
        JSON.stringify({
          objects: [
            { query: 'SELECT Id FROM Account', operation: 'Insert' },
            { query: 'SELECT Id', operation: 'Insert' },
            { operation: 'Insert' },
          ],
          objectSets: [{ objects: [{ query: 'FROM' }] }],
        }),
      );

      expect(refusal.code).toBe('OBJECT_NOT_NAMED');
      expect(refusal.objects).toEqual([
        'objects[1] (SELECT Id)',
        'objects[2]',
        'objectSets[0].objects[0] (FROM)',
      ]);
      expect(refusal.message).toMatch(/^Nothing was imported: no object can be read/);
    });

    it('refuses a file that is not JSON, naming the file', async () => {
      const refusal = await refusalOf('not json');

      expect(refusal.code).toBe('NOT_JSON');
      expect(refusal.message).toContain('export.json is not JSON');
    });

    it.each([
      ['an empty object', '{}'],
      ['an empty list of objects', '{ "objects": [] }'],
      ['empty sets', '{ "objects": [], "objectSets": [{ "objects": [] }] }'],
      ['a list', '[]'],
      ['a number', '42'],
    ])('refuses %s as a file that lists no object', async (_label, content) => {
      const refusal = await refusalOf(content);

      expect(refusal.code).toBe('NO_OBJECTS');
    });

    it('names each entry of a kind SFDMU’s format does not hold, never Zod’s issues', async () => {
      const refusal = await refusalOf(
        JSON.stringify({
          objects: [
            {
              query: 'SELECT Id FROM Account',
              useFieldMapping: 'yes',
              fieldMapping: [{ sourceField: 'Name' }],
            },
          ],
        }),
      );

      expect(refusal.code).toBe('INVALID_EXPORT');
      expect(refusal.objects).toEqual(['objects[0].useFieldMapping', 'objects[0].fieldMapping[0]']);
      expect(refusal.message).not.toContain('invalid_type');
      expect(refusal.message).not.toContain('"path"');
    });
  });

  describe('what SFDMU would do and the configuration does not', () => {
    const importing = (script: Record<string, unknown>) =>
      new SfdmuImporter(createMockFileReader(JSON.stringify(script))).import(
        '/path/to/export.json',
      );
    const importingObject = (object: Record<string, unknown>) =>
      importing({ objects: [{ query: 'SELECT Id, Name FROM Account', ...object }] });

    it('ignores a fieldMapping with useFieldMapping absent, as SFDMU does, and says so', async () => {
      // The rename was applied all the same: a field SFDMU writes as read went elsewhere.
      const { config, notes } = await importingObject({
        operation: 'Insert',
        fieldMapping: [{ sourceField: 'BillingCity', targetField: 'ShippingCity' }],
      });

      expect(config.objects[0].fieldMappings).toEqual([]);
      expect(notes).toContainEqual({ code: 'fieldMappingOff', object: 'Account', detail: '1' });
    });

    it('applies it with useFieldMapping on, and says nothing of it', async () => {
      const { config, notes } = await importingObject({
        operation: 'Insert',
        useFieldMapping: true,
        fieldMapping: [{ sourceField: 'BillingCity', targetField: 'ShippingCity' }],
      });

      expect(config.objects[0].fieldMappings).toHaveLength(1);
      expect(notes.filter((note) => note.code === 'fieldMappingOff')).toEqual([]);
    });

    it('leaves out an object marked excluded, whatever its operation', async () => {
      const { config, notes } = await importingObject({ operation: 'Upsert', excluded: true });

      expect(config.objects).toEqual([]);
      expect(notes).toEqual([{ code: 'excluded', object: 'Account' }]);
    });

    it('reads no operation as SFDMU’s Readonly, and any case of one', async () => {
      const unnamed = await importingObject({});
      expect(unnamed.config.objects).toEqual([]);
      expect(unnamed.notes).toEqual([{ code: 'readonly', object: 'Account' }]);

      const lower = await importingObject({ operation: 'insert' });
      expect(lower.config.objects[0].operation).toBe('insert');
    });

    it('leaves out an operation SFDMU has no such name for, naming it', async () => {
      const { config, notes } = await importingObject({ operation: 'Merge' });

      expect(config.objects).toEqual([]);
      expect(notes).toEqual([{ code: 'unknownOperation', object: 'Account', detail: 'Merge' }]);
    });

    it.each([
      ['HardDelete', {}, 'HardDelete'],
      ['Delete', {}, 'Delete'],
      ['Delete', { hardDelete: true }, 'HardDelete'],
    ])('carries %s as Sync’s delete and says how it differs', async (operation, flags, detail) => {
      // `HardDelete` is one of SFDMU's operations, and ended on a Zod error here.
      const { config, notes } = await importingObject({ operation, ...flags });

      expect(config.objects[0].operation).toBe('delete');
      expect(notes).toContainEqual({ code: 'delete', object: 'Account', detail });
    });

    it.each([
      ['DeleteSource', {}, 'DeleteSource'],
      ['DeleteHierarchy', {}, 'DeleteHierarchy'],
      ['Delete', { deleteFromSource: true }, 'deleteFromSource'],
      ['Delete', { deleteByHierarchy: true }, 'deleteByHierarchy'],
    ])('never turns %s into a delete in the target', async (operation, flags, detail) => {
      // `DeleteSource` became Sync's delete: on the target, the org it leaves alone.
      const { config, notes } = await importingObject({ operation, ...flags });

      expect(config.objects).toEqual([]);
      expect(notes).toEqual([{ code: 'deletesElsewhere', object: 'Account', detail }]);
    });

    it('leaves out an object faked whole: it has no fields to leave out', async () => {
      const { config, notes } = await importingObject({
        operation: 'Insert',
        updateWithMockData: true,
        mockFields: [{ name: 'all', pattern: 'name', excludeNames: ['Id'] }],
      });

      expect(config.objects).toEqual([]);
      expect(notes).toEqual([{ code: 'mockAllFields', object: 'Account' }]);
    });

    it('does nothing of mockFields with updateWithMockData off, as SFDMU does', async () => {
      const { config, notes } = await importingObject({
        operation: 'Insert',
        mockFields: [{ name: 'Name', pattern: 'name' }],
      });

      expect(config.objects[0].excludedFields).toEqual([]);
      expect(notes.filter((note) => note.code === 'mockFields')).toEqual([]);
    });

    it('takes bulkApiVersion as a number, and says Sync does not read it', async () => {
      const { notes } = await importing({
        bulkApiVersion: 2.0,
        objects: [{ query: 'SELECT Id FROM Account', operation: 'Insert' }],
      });

      expect(notes).toContainEqual({ code: 'settings', detail: 'bulkApiVersion' });
    });

    it('names a key it does not know, of the file and of an object, and fails on neither', async () => {
      const { config, notes } = await importing({
        $schema: 'https://example.invalid/export.schema.json',
        someFutureSetting: { deep: true },
        promptOnMissingParentObjects: false,
        orgs: [{ name: 'source', accessToken: 'not-a-real-token' }],
        objects: [
          {
            query: 'SELECT Id FROM Account',
            operation: 'Insert',
            someFutureFlag: 1,
            skipExistingRecords: true,
            alwaysUseRestApi: false,
            beforeAddons: [],
          },
        ],
      });

      expect(config.objects).toHaveLength(1);
      expect(notes).toContainEqual({ code: 'settings', detail: 'someFutureSetting' });
      expect(notes).toContainEqual({
        code: 'settings',
        object: 'Account',
        detail: 'someFutureFlag, skipExistingRecords',
      });
      expect(JSON.stringify(notes)).not.toContain('not-a-real-token');
    });

    it('keeps the first entry of an object two sets name, and says which it left out', async () => {
      const { config, notes } = await importing({
        objects: [{ query: 'SELECT Id FROM Account', operation: 'Insert' }],
        objectSets: [{ objects: [{ query: 'SELECT Id, Name FROM ACCOUNT', operation: 'Update' }] }],
      });

      expect(config.objects).toMatchObject([{ objectApiName: 'Account', operation: 'insert' }]);
      expect(notes).toContainEqual({
        code: 'duplicate',
        object: 'ACCOUNT',
        detail: 'objectSets[0].objects[0]',
      });
    });

    it('says the query’s cap and what else Sync does not run of it', async () => {
      const { config, notes } = await importingObject({
        operation: 'Insert',
        query: 'SELECT Id FROM Account ORDER BY Name LIMIT 10 OFFSET 5 ALL ROWS',
      });

      expect(config.objects[0].orderBy).toBe('Name');
      expect(notes).toContainEqual({ code: 'limit', object: 'Account', detail: '10' });
      expect(notes).toContainEqual({ code: 'queryClause', object: 'Account', detail: 'OFFSET 5' });
      expect(notes).toContainEqual({ code: 'queryClause', object: 'Account', detail: 'ALL ROWS' });
    });

    it('says a filter Sync would refuse, and keeps it on the object’s row to rewrite', async () => {
      const where = 'Id IN (SELECT AccountId FROM Contact)';
      const { config, notes } = await importingObject({
        operation: 'Insert',
        query: `SELECT Id FROM Account WHERE ${where}`,
      });

      expect(config.objects[0].where).toBe(where);
      expect(notes).toContainEqual({ code: 'whereRefused', object: 'Account' });
    });

    it('says, and drops, an order Sync would refuse, as no box on the page could change it', async () => {
      const { config, notes } = await importingObject({
        operation: 'Insert',
        query: 'SELECT Id FROM Account ORDER BY COUNT(Id)',
      });

      expect(config.objects[0].orderBy).toBeUndefined();
      expect(notes).toContainEqual({
        code: 'queryClause',
        object: 'Account',
        detail: 'ORDER BY COUNT(Id)',
      });
    });

    it('says an update finds its record by Id, not by the key SFDMU matches on', async () => {
      const { notes } = await importingObject({ operation: 'Update', externalId: 'Name' });

      expect(notes).toContainEqual({ code: 'updateKey', object: 'Account', detail: 'Name' });
    });

    it('leaves a composite key out, for the object’s row to ask for one', async () => {
      const { config, notes } = await importingObject({
        operation: 'Upsert',
        externalId: 'Name;Phone',
      });

      expect(config.objects[0].externalIdField).toBeUndefined();
      expect(notes).toContainEqual({
        code: 'unusableKey',
        object: 'Account',
        detail: 'Name;Phone',
      });
    });

    it('says nothing of a custom External ID on an upsert', async () => {
      const { notes } = await importingObject({ operation: 'Upsert', externalId: 'Ext__c' });

      expect(notes.filter((note) => note.object === 'Account')).toEqual([]);
    });

    it('says a file of deletes alone copies no field', async () => {
      const { notes } = await importingObject({ operation: 'Delete' });

      expect(notes.filter((note) => note.code === 'everyField')).toEqual([]);
    });

    it('says a mapping file with other columns was not read', async () => {
      const reader: FileReader = {
        readFile: async (path) =>
          path.endsWith('.json')
            ? JSON.stringify({
                objects: [
                  { query: 'SELECT Id FROM Account', operation: 'Insert', useFieldMapping: true },
                ],
              })
            : 'Object,Field\nAccount,Name\n',
      };

      const { notes } = await new SfdmuImporter(reader).import('/path/to/export.json');

      expect(notes).toContainEqual({ code: 'mappingFileUnread', detail: 'FieldMapping.csv' });
    });

    it('does not take a mapping file it could not read for an absent one', async () => {
      const reader: FileReader = {
        readFile: async (path) => {
          if (path.endsWith('.json')) {
            return JSON.stringify({
              objects: [
                { query: 'SELECT Id FROM Account', operation: 'Insert', useValuesMapping: true },
              ],
            });
          }
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        },
      };

      await expect(new SfdmuImporter(reader).import('/path/to/export.json')).rejects.toThrow(
        'EACCES',
      );
    });

    it.each([
      ['semicolon', ';'],
      [';', ';'],
      ['tab', '\t'],
      ['\t', '\t'],
    ])('reads the mapping files with the delimiter the export sets, %j', async (asked, cell) => {
      const reader: FileReader = {
        readFile: async (path) =>
          path.endsWith('.json')
            ? JSON.stringify({
                csvFileDelimiter: asked,
                objects: [
                  { query: 'SELECT Id FROM Account', operation: 'Insert', useFieldMapping: true },
                ],
              })
            : ['ObjectName', 'FieldName', 'Target'].join(cell) +
              '\n' +
              ['Account', 'Name', 'Title__c'].join(cell) +
              '\n',
      };

      const { config } = await new SfdmuImporter(reader).import('/path/to/export.json');

      expect(config.objects[0].fieldMappings).toEqual([
        { sourceField: 'Name', targetField: 'Title__c', type: 'rename' },
      ]);
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

    it('finds a parent whatever the case its query writes it in', () => {
      const exportData: SfdmuExport = {
        objects: [
          {
            query: 'select Id, Name from account',
            operation: 'Upsert',
            externalId: 'Name',
            master: true,
          },
          {
            query: 'SELECT Id, Account.Name FROM Contact',
            operation: 'Upsert',
            externalId: 'Email',
            master: true,
          },
        ],
      } as unknown as SfdmuExport;
      const importer = new SfdmuImporter(createMockFileReader(''));

      expect(importer.extractDependencies(exportData)).toEqual([
        { parent: 'account', child: 'Contact', field: 'Account' },
      ]);
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

    it('takes an export whose objects are all in objectSets, as SFDMU asks for one or the other', () => {
      const result = sfdmuExportSchema.safeParse({
        objectSets: [{ objects: [{ query: 'SELECT Id FROM Account' }] }],
      });
      expect(result.success).toBe(true);
    });

    it('takes any key it does not know, as SFDMU does', () => {
      const result = sfdmuExportSchema.safeParse({
        someFutureSetting: { deep: true },
        objects: [{ query: 'SELECT Id FROM Account', someFutureFlag: 1 }],
      });
      expect(result.success).toBe(true);
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
