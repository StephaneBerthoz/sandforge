import { describe, it, expect, beforeEach } from 'vitest';
import {
  SchemaAdvisor,
  type ObjectDescribe,
  type FieldDescribe,
  type SchemaIssue,
} from './SchemaAdvisor';

function makeField(overrides: Partial<FieldDescribe> = {}): FieldDescribe {
  return {
    apiName: 'TestField__c',
    label: 'Test Field',
    type: 'text',
    required: false,
    custom: true,
    ...overrides,
  };
}

function makeObject(overrides: Partial<ObjectDescribe> = {}): ObjectDescribe {
  return {
    apiName: 'CustomObject__c',
    label: 'Custom Object',
    custom: true,
    fields: [],
    ...overrides,
  };
}

describe('SchemaAdvisor', () => {
  let advisor: SchemaAdvisor;

  beforeEach(() => {
    advisor = new SchemaAdvisor();
  });

  // --- Unused field detection ---

  it('should detect unused custom fields on objects with zero records', () => {
    const obj = makeObject({
      recordCount: 0,
      fields: [makeField({ apiName: 'Unused__c', label: 'Unused' })],
    });

    const issues = advisor.analyzeObject(obj);
    const unused = issues.find((i) => i.type === 'unused_field');
    expect(unused).toBeDefined();
    expect(unused?.fieldName).toBe('Unused__c');
  });

  it('should not flag standard fields as unused', () => {
    const obj = makeObject({
      recordCount: 0,
      fields: [makeField({ apiName: 'Name', custom: false })],
    });

    const issues = advisor.analyzeObject(obj);
    expect(issues.find((i) => i.type === 'unused_field')).toBeUndefined();
  });

  it('should not flag custom fields when object has records', () => {
    const obj = makeObject({
      recordCount: 100,
      fields: [makeField()],
    });

    const issues = advisor.analyzeObject(obj);
    expect(issues.find((i) => i.type === 'unused_field')).toBeUndefined();
  });

  // --- Naming convention checks ---

  it('should detect custom fields missing __c suffix', () => {
    const obj = makeObject({
      fields: [makeField({ apiName: 'BadName', custom: true })],
    });

    const issues = advisor.analyzeObject(obj);
    const naming = issues.find((i) => i.type === 'naming_convention' && i.fieldName === 'BadName');
    expect(naming).toBeDefined();
    expect(naming?.description).toContain('__c');
  });

  it('should not flag standard fields for naming conventions', () => {
    const obj = makeObject({
      fields: [makeField({ apiName: 'Name', custom: false })],
    });

    const issues = advisor.analyzeObject(obj);
    expect(issues.find((i) => i.type === 'naming_convention')).toBeUndefined();
  });

  it('should detect labels with extra whitespace', () => {
    const obj = makeObject({
      fields: [makeField({ apiName: 'Field__c', label: '  Spaced Label  ' })],
    });

    const issues = advisor.analyzeObject(obj);
    const ws = issues.find((i) => i.description.includes('whitespace'));
    expect(ws).toBeDefined();
  });

  it('should detect labels with consecutive spaces', () => {
    const obj = makeObject({
      fields: [makeField({ apiName: 'Field__c', label: 'Double  Space' })],
    });

    const issues = advisor.analyzeObject(obj);
    const ws = issues.find((i) => i.description.includes('consecutive'));
    expect(ws).toBeDefined();
  });

  // --- Duplicate field detection ---

  it('should detect duplicate labels across objects', () => {
    const objects = [
      makeObject({
        apiName: 'Account',
        fields: [makeField({ apiName: 'Status__c', label: 'Status' })],
      }),
      makeObject({
        apiName: 'Contact',
        fields: [makeField({ apiName: 'Status__c', label: 'Status' })],
      }),
    ];

    const advice = advisor.analyzeSchema(objects);
    const dup = advice.issues.find((i) => i.type === 'duplicate_field');
    expect(dup).toBeDefined();
    expect(dup?.description).toContain('Account');
    expect(dup?.description).toContain('Contact');
  });

  it('should not flag unique labels as duplicates', () => {
    const objects = [
      makeObject({
        apiName: 'Account',
        fields: [makeField({ apiName: 'Revenue__c', label: 'Revenue' })],
      }),
      makeObject({
        apiName: 'Contact',
        fields: [makeField({ apiName: 'Birthday__c', label: 'Birthday' })],
      }),
    ];

    const advice = advisor.analyzeSchema(objects);
    expect(advice.issues.find((i) => i.type === 'duplicate_field')).toBeUndefined();
  });

  // --- Missing relationship detection ---

  it('should detect missing Account-Contact relationship', () => {
    const objects = [
      makeObject({ apiName: 'Account', custom: false, fields: [] }),
      makeObject({
        apiName: 'Contact',
        custom: false,
        fields: [makeField({ apiName: 'Name', custom: false })],
      }),
    ];

    const advice = advisor.analyzeSchema(objects);
    const missing = advice.issues.find(
      (i) => i.type === 'missing_relationship' && i.objectName === 'Contact',
    );
    expect(missing).toBeDefined();
    expect(missing?.description).toContain('Account');
  });

  it('should not flag relationship when AccountId field exists', () => {
    const objects = [
      makeObject({ apiName: 'Account', custom: false, fields: [] }),
      makeObject({
        apiName: 'Contact',
        custom: false,
        fields: [makeField({ apiName: 'AccountId', custom: false })],
      }),
    ];

    const advice = advisor.analyzeSchema(objects);
    const missing = advice.issues.find(
      (i) => i.type === 'missing_relationship' && i.objectName === 'Contact',
    );
    expect(missing).toBeUndefined();
  });

  it('should not flag relationship when referenceTo includes parent', () => {
    const objects = [
      makeObject({ apiName: 'Account', custom: false, fields: [] }),
      makeObject({
        apiName: 'Contact',
        custom: false,
        fields: [
          makeField({
            apiName: 'AccountRef__c',
            custom: true,
            referenceTo: ['Account'],
          }),
        ],
      }),
    ];

    const advice = advisor.analyzeSchema(objects);
    const missing = advice.issues.find(
      (i) =>
        i.type === 'missing_relationship' &&
        i.objectName === 'Contact' &&
        i.description.includes('Account'),
    );
    expect(missing).toBeUndefined();
  });

  // --- Scoring ---

  it('should return score 100 for clean schema', () => {
    const objects = [
      makeObject({
        apiName: 'Account',
        custom: false,
        recordCount: 100,
        fields: [makeField({ apiName: 'Name', custom: false, label: 'Name' })],
      }),
    ];

    const advice = advisor.analyzeSchema(objects);
    expect(advice.score).toBe(100);
  });

  it('should reduce score for issues', () => {
    const obj = makeObject({
      recordCount: 0,
      fields: [
        makeField({ apiName: 'Bad', label: 'Bad', custom: true }),
        makeField({ apiName: 'Wrong', label: '  Wrong  ', custom: true }),
      ],
    });

    const advice = advisor.analyzeSchema([obj]);
    expect(advice.score).toBeLessThan(100);
  });

  it('should clamp score between 0 and 100', () => {
    const fields = Array.from({ length: 3 }, (_, i) =>
      makeField({ apiName: `Bad${i}`, label: `Bad ${i}`, custom: true }),
    );
    const obj = makeObject({ recordCount: 0, fields });

    const advice = advisor.analyzeSchema([obj]);
    expect(advice.score).toBeGreaterThanOrEqual(0);
    expect(advice.score).toBeLessThanOrEqual(100);
  });

  it('should return score 100 for empty schema', () => {
    const advice = advisor.analyzeSchema([]);
    expect(advice.score).toBe(100);
  });

  // --- Recommendations ---

  it('should generate recommendations from issues', () => {
    const issues: SchemaIssue[] = [
      { type: 'unused_field', objectName: 'A', fieldName: 'X', description: '', severity: 'low' },
      {
        type: 'naming_convention',
        objectName: 'B',
        fieldName: 'Y',
        description: '',
        severity: 'low',
      },
      {
        type: 'duplicate_field',
        objectName: 'C',
        fieldName: 'Z',
        description: '',
        severity: 'medium',
      },
      { type: 'missing_relationship', objectName: 'D', description: '', severity: 'high' },
    ];

    const suggestions = advisor.getRecommendations(issues);
    expect(suggestions.length).toBe(4);
    expect(suggestions.some((s) => s.title.includes('unused'))).toBe(true);
    expect(suggestions.some((s) => s.title.includes('naming'))).toBe(true);
    expect(
      suggestions.some((s) => s.title.includes('duplicate') || s.title.includes('Consolidate')),
    ).toBe(true);
    expect(suggestions.some((s) => s.title.includes('relationship'))).toBe(true);
  });

  it('should return empty recommendations for no issues', () => {
    expect(advisor.getRecommendations([])).toEqual([]);
  });

  it('should classify high impact for many unused fields', () => {
    const issues: SchemaIssue[] = Array.from({ length: 15 }, (_, i) => ({
      type: 'unused_field' as const,
      objectName: 'Obj',
      fieldName: `Field${i}__c`,
      description: '',
      severity: 'low' as const,
    }));

    const suggestions = advisor.getRecommendations(issues);
    const unused = suggestions.find((s) => s.title.includes('unused'));
    expect(unused?.impact).toBe('high');
  });

  // --- Full analysis integration ---

  it('should produce a complete advice report', () => {
    const objects = [
      makeObject({
        apiName: 'Account',
        custom: false,
        recordCount: 500,
        fields: [
          makeField({ apiName: 'Name', label: 'Name', custom: false }),
          makeField({ apiName: 'Status__c', label: 'Status', custom: true }),
        ],
      }),
      makeObject({
        apiName: 'Contact',
        custom: false,
        recordCount: 200,
        fields: [
          makeField({
            apiName: 'AccountId',
            label: 'Account',
            custom: false,
            referenceTo: ['Account'],
          }),
          makeField({ apiName: 'Status__c', label: 'Status', custom: true }),
        ],
      }),
    ];

    const advice = advisor.analyzeSchema(objects);
    expect(advice).toHaveProperty('score');
    expect(advice).toHaveProperty('issues');
    expect(advice).toHaveProperty('suggestions');
    expect(typeof advice.score).toBe('number');
    expect(Array.isArray(advice.issues)).toBe(true);
    expect(Array.isArray(advice.suggestions)).toBe(true);
  });
});
