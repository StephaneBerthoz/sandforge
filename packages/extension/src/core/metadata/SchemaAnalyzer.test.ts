import { describe, it, expect } from 'vitest';
import { SchemaAnalyzer } from './SchemaAnalyzer';
import type { ObjectDescribe, FieldDescribe, RecordTypeInfo } from './MetadataReader';

function createMockField(overrides: Partial<FieldDescribe> = {}): FieldDescribe {
  return {
    name: 'TestField__c',
    label: 'Test Field',
    type: 'string',
    length: 255,
    nillable: true,
    createable: true,
    updateable: true,
    externalId: false,
    referenceTo: [],
    relationshipName: null,
    picklistValues: [],
    defaultValue: null,
    calculated: false,
    autoNumber: false,
    unique: false,
    ...overrides,
  };
}

function createMockObjectDescribe(
  name: string,
  fields: FieldDescribe[] = [],
  overrides: Partial<ObjectDescribe> = {},
): ObjectDescribe {
  return {
    name,
    label: name,
    labelPlural: `${name}s`,
    keyPrefix: '001',
    custom: name.endsWith('__c'),
    createable: true,
    updateable: true,
    deletable: true,
    queryable: true,
    fields,
    recordTypeInfos: [],
    childRelationships: [],
    ...overrides,
  };
}

function generateFields(count: number, overrides: Partial<FieldDescribe> = {}): FieldDescribe[] {
  return Array.from({ length: count }, (_, i) =>
    createMockField({ name: `Field${i}__c`, label: `Field ${i}`, ...overrides }),
  );
}

describe('SchemaAnalyzer', () => {
  const analyzer = new SchemaAnalyzer();

  describe('analyzeObject', () => {
    it('should analyze a simple object correctly', () => {
      const fields = [
        createMockField({ name: 'Name', createable: true, nillable: false }),
        createMockField({ name: 'Description', createable: true, nillable: true }),
        createMockField({ name: 'Id', createable: false }),
      ];
      const describe = createMockObjectDescribe('Account', fields);

      const analysis = analyzer.analyzeObject(describe);

      expect(analysis.objectName).toBe('Account');
      expect(analysis.totalFields).toBe(3);
      expect(analysis.creatableFields).toBe(2);
      expect(analysis.requiredFields).toBe(1);
      expect(analysis.complexity).toBe('simple');
    });

    it('should detect custom fields', () => {
      const fields = [
        createMockField({ name: 'Name' }),
        createMockField({ name: 'Custom1__c' }),
        createMockField({ name: 'Custom2__c' }),
      ];
      const describe = createMockObjectDescribe('Account', fields);

      const analysis = analyzer.analyzeObject(describe);

      expect(analysis.customFieldCount).toBe(2);
    });

    it('should count reference and external ID fields', () => {
      const fields = [
        createMockField({ name: 'AccountId', referenceTo: ['Account'] }),
        createMockField({ name: 'OwnerId', referenceTo: ['User'] }),
        createMockField({ name: 'ExtId__c', externalId: true }),
        createMockField({ name: 'Name' }),
      ];
      const describe = createMockObjectDescribe('Contact', fields);

      const analysis = analyzer.analyzeObject(describe);

      expect(analysis.referenceFields).toBe(2);
      expect(analysis.externalIdFields).toBe(1);
    });

    it('should detect record types', () => {
      const recordTypes: RecordTypeInfo[] = [
        { recordTypeId: '012000000000001', name: 'Standard', developerName: 'Standard', active: true, defaultRecordTypeMapping: true },
        { recordTypeId: '012000000000002', name: 'Custom', developerName: 'Custom', active: true, defaultRecordTypeMapping: false },
      ];
      const describe = createMockObjectDescribe('Account', [createMockField()], { recordTypeInfos: recordTypes });

      const analysis = analyzer.analyzeObject(describe);

      expect(analysis.hasRecordTypes).toBe(true);
      expect(analysis.recordTypeCount).toBe(2);
    });

    it('should assess complexity as simple for small objects', () => {
      const fields = generateFields(10);
      const describe = createMockObjectDescribe('Simple__c', fields);

      const analysis = analyzer.analyzeObject(describe);

      expect(analysis.complexity).toBe('simple');
    });

    it('should assess complexity as moderate for medium objects', () => {
      const fields = generateFields(40);
      const describe = createMockObjectDescribe('Medium__c', fields);

      const analysis = analyzer.analyzeObject(describe);

      expect(analysis.complexity).toBe('moderate');
    });

    it('should assess complexity as complex for large objects', () => {
      const fields = generateFields(120);
      const describe = createMockObjectDescribe('Large__c', fields);

      const analysis = analyzer.analyzeObject(describe);

      expect(analysis.complexity).toBe('complex');
    });

    it('should assess complexity as complex when many reference fields exist', () => {
      const fields = Array.from({ length: 12 }, (_, i) =>
        createMockField({ name: `Ref${i}__c`, referenceTo: ['Account'] }),
      );
      const describe = createMockObjectDescribe('RefHeavy__c', fields);

      const analysis = analyzer.analyzeObject(describe);

      expect(analysis.complexity).toBe('complex');
    });
  });

  describe('analyzeFields', () => {
    it('should analyze each field with correct properties', () => {
      const fields = [
        createMockField({ name: 'Name', createable: true, nillable: false }),
        createMockField({ name: 'AccountId', referenceTo: ['Account'], type: 'reference' }),
        createMockField({ name: 'ExtId__c', externalId: true }),
      ];
      const describe = createMockObjectDescribe('Contact', fields);

      const analysis = analyzer.analyzeFields(describe);

      expect(analysis).toHaveLength(3);
      expect(analysis[0]).toMatchObject({
        fieldName: 'Name',
        isRequired: true,
        isReference: false,
        isCustom: false,
      });
      expect(analysis[1]).toMatchObject({
        fieldName: 'AccountId',
        isReference: true,
        referenceTo: ['Account'],
      });
      expect(analysis[2]).toMatchObject({
        fieldName: 'ExtId__c',
        isExternalId: true,
        isCustom: true,
      });
    });
  });

  describe('suggestExternalIdField', () => {
    it('should return undefined when no external ID fields exist', () => {
      const describe = createMockObjectDescribe('Account', [createMockField({ name: 'Name' })]);

      expect(analyzer.suggestExternalIdField(describe)).toBeUndefined();
    });

    it('should prefer custom external ID fields', () => {
      const fields = [
        createMockField({ name: 'Id', externalId: true }),
        createMockField({ name: 'CustomExtId__c', externalId: true }),
      ];
      const describe = createMockObjectDescribe('Account', fields);

      expect(analyzer.suggestExternalIdField(describe)).toBe('CustomExtId__c');
    });

    it('should fall back to standard external ID when no custom exists', () => {
      const fields = [
        createMockField({ name: 'Id', externalId: true }),
        createMockField({ name: 'Name' }),
      ];
      const describe = createMockObjectDescribe('Account', fields);

      expect(analyzer.suggestExternalIdField(describe)).toBe('Id');
    });
  });

  describe('suggestBatchSize', () => {
    it('should return 200 for simple objects', () => {
      const fields = generateFields(20);
      const describe = createMockObjectDescribe('Simple__c', fields);

      expect(analyzer.suggestBatchSize(describe)).toBe(200);
    });

    it('should return 100 for medium objects with 51-100 creatable fields', () => {
      const fields = generateFields(60);
      const describe = createMockObjectDescribe('Medium__c', fields);

      expect(analyzer.suggestBatchSize(describe)).toBe(100);
    });

    it('should return 50 for objects with large text fields', () => {
      const fields = [
        ...generateFields(10),
        createMockField({ name: 'BigText__c', type: 'textarea', length: 32000 }),
      ];
      const describe = createMockObjectDescribe('BigText__c', fields);

      expect(analyzer.suggestBatchSize(describe)).toBe(50);
    });

    it('should return 50 for objects with over 100 creatable fields', () => {
      const fields = generateFields(110);
      const describe = createMockObjectDescribe('Huge__c', fields);

      expect(analyzer.suggestBatchSize(describe)).toBe(50);
    });
  });

  describe('estimatedRecordSize', () => {
    it('should estimate size based on field types', () => {
      const fields = [
        createMockField({ name: 'BoolField', type: 'boolean', length: 0, createable: true }),
        createMockField({ name: 'NumField', type: 'int', length: 0, createable: true }),
        createMockField({ name: 'RefField', type: 'reference', length: 18, createable: true }),
        createMockField({ name: 'TextField', type: 'string', length: 100, createable: true }),
        createMockField({ name: 'ReadOnly', type: 'string', length: 100, createable: false }),
      ];
      const describe = createMockObjectDescribe('Mixed', fields);

      const analysis = analyzer.analyzeObject(describe);

      // boolean=1 + int=8 + reference=18 + string=100 = 127 (ReadOnly excluded)
      expect(analysis.estimatedRecordSize).toBe(127);
    });
  });
});
