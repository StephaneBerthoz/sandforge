import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TransformPipeline } from './TransformPipeline';
import type { TransformRule, SyncObjectConfig } from '@sandforge/shared';

function createObjectConfig(overrides?: Partial<SyncObjectConfig>): SyncObjectConfig {
  return {
    objectApiName: 'Account',
    operation: 'upsert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 1,
    ...overrides,
  };
}

describe('TransformPipeline', () => {
  let pipeline: TransformPipeline;

  beforeEach(() => {
    pipeline = new TransformPipeline();
  });

  describe('transform', () => {
    it('should apply uppercase rule', () => {
      const rules: TransformRule[] = [{ type: 'uppercase', config: {} }];
      expect(pipeline.transform('hello', rules)).toBe('HELLO');
    });

    it('should apply lowercase rule', () => {
      const rules: TransformRule[] = [{ type: 'lowercase', config: {} }];
      expect(pipeline.transform('HELLO', rules)).toBe('hello');
    });

    it('should apply trim rule', () => {
      const rules: TransformRule[] = [{ type: 'trim', config: {} }];
      expect(pipeline.transform('  hello  ', rules)).toBe('hello');
    });

    it('should apply truncate rule', () => {
      const rules: TransformRule[] = [{ type: 'truncate', config: { length: 5 } }];
      expect(pipeline.transform('hello world', rules)).toBe('hello');
    });

    it('should apply prefix rule', () => {
      const rules: TransformRule[] = [{ type: 'prefix', config: { prefix: 'SF-' } }];
      expect(pipeline.transform('001', rules)).toBe('SF-001');
    });

    it('should apply suffix rule', () => {
      const rules: TransformRule[] = [{ type: 'suffix', config: { suffix: '-v2' } }];
      expect(pipeline.transform('item', rules)).toBe('item-v2');
    });

    it('should apply replace rule replacing all occurrences', () => {
      const rules: TransformRule[] = [
        { type: 'replace', config: { search: 'foo', replace: 'bar' } },
      ];
      expect(pipeline.transform('foo and foo', rules)).toBe('bar and bar');
    });

    it('should apply regex_replace rule', () => {
      const rules: TransformRule[] = [
        { type: 'regex_replace', config: { regex: '\\d+', replace: 'X' } },
      ];
      expect(pipeline.transform('abc123def456', rules)).toBe('abcXdefX');
    });

    it('should apply map_value rule when value exists in map', () => {
      const rules: TransformRule[] = [
        {
          type: 'map_value',
          config: { valueMap: { US: 'United States', FR: 'France' } },
        },
      ];
      expect(pipeline.transform('US', rules)).toBe('United States');
    });

    it('should return original value for map_value when key not found', () => {
      const rules: TransformRule[] = [
        {
          type: 'map_value',
          config: { valueMap: { US: 'United States' } },
        },
      ];
      expect(pipeline.transform('UK', rules)).toBe('UK');
    });

    it('should apply default_value when value is null', () => {
      const rules: TransformRule[] = [{ type: 'default_value', config: { defaultValue: 'N/A' } }];
      expect(pipeline.transform(null, rules)).toBe('N/A');
    });

    it('should not apply default_value when value is present', () => {
      const rules: TransformRule[] = [{ type: 'default_value', config: { defaultValue: 'N/A' } }];
      expect(pipeline.transform('Hello', rules)).toBe('Hello');
    });

    it('should chain multiple rules in sequence', () => {
      const rules: TransformRule[] = [
        { type: 'trim', config: {} },
        { type: 'uppercase', config: {} },
        { type: 'prefix', config: { prefix: '[' } },
        { type: 'suffix', config: { suffix: ']' } },
      ];
      expect(pipeline.transform('  hello  ', rules)).toBe('[HELLO]');
    });

    it('should handle format_date rule', () => {
      const rules: TransformRule[] = [
        { type: 'format_date', config: { dateFormat: 'YYYY-MM-DD' } },
      ];
      const result = pipeline.transform('2026-03-15T10:30:00Z', rules);
      expect(result).toBe('2026-03-15');
    });

    it('should return original string for invalid date in format_date', () => {
      const rules: TransformRule[] = [
        { type: 'format_date', config: { dateFormat: 'YYYY-MM-DD' } },
      ];
      expect(pipeline.transform('not-a-date', rules)).toBe('not-a-date');
    });
  });

  describe('transformRecord', () => {
    it('should apply object-level transform rules to the fields they name', () => {
      const config = createObjectConfig({
        transformRules: [
          { type: 'trim', field: 'Name', config: {} },
          { type: 'trim', field: 'Industry', config: {} },
        ],
      });
      const record = { Name: '  Acme  ', Industry: '  Tech  ' };

      const result = pipeline.transformRecord(record, config);
      expect(result).toEqual({ Name: 'Acme', Industry: 'Tech' });
    });

    it("leaves a field mapping's rules to the mapping, which applies them once with its value", () => {
      // Applied by the mapping and again here, a transform mapping's prefix
      // went on twice: "X-X-acme".
      const config = createObjectConfig({
        fieldMappings: [
          {
            sourceField: 'Name',
            targetField: 'Name',
            type: 'transform',
            transformRules: [{ type: 'prefix', config: { prefix: 'X-' } }],
          },
        ],
      });
      const record = { Name: 'X-acme', Industry: 'tech' };

      const result = pipeline.transformRecord(record, config);
      expect(result).toEqual({ Name: 'X-acme', Industry: 'tech' });
    });

    it('should not modify the original record', () => {
      const config = createObjectConfig({
        transformRules: [{ type: 'uppercase', field: 'Name', config: {} }],
      });
      const record = { Name: 'acme' };

      pipeline.transformRecord(record, config);
      expect(record.Name).toBe('acme');
    });

    it('should return unchanged record when no rules are defined', () => {
      const config = createObjectConfig();
      const record = { Name: 'Acme', Industry: 'Tech' };

      const result = pipeline.transformRecord(record, config);
      expect(result).toEqual(record);
    });
  });
  describe('a rule that names a field', () => {
    it('changes that field alone, and the others are written as read', () => {
      // Each rule ran over every key of the record: an Uppercase meant for
      // Name rewrote Description, Industry and every other text with it.
      const config = createObjectConfig({
        transformRules: [{ type: 'uppercase', field: 'Name', config: {} }],
      });
      const record = {
        Id: '001S1',
        Name: 'acme',
        Description: 'kept as typed',
        Industry: 'acme',
        Phone: null,
        NumberOfEmployees: 250,
      };

      expect(pipeline.transformRecord(record, config)).toEqual({
        ...record,
        Name: 'ACME',
      });
    });

    it('finds its field whatever the case it is named in, as Salesforce does', () => {
      const config = createObjectConfig({
        transformRules: [
          { type: 'map_value', field: 'status', config: { valueMap: { New: 'Open' } } },
        ],
      });

      expect(pipeline.transformRecord({ Subject: 'New', Status: 'New' }, config)).toEqual({
        Subject: 'New',
        Status: 'Open',
      });
    });

    it('adds nothing when the record does not carry the field', () => {
      // A real-time change carries only what changed, and an update would
      // write the default over what the target holds.
      const config = createObjectConfig({
        transformRules: [
          { type: 'default_value', field: 'Rating', config: { defaultValue: 'Warm' } },
        ],
      });

      expect(pipeline.transformRecord({ Name: 'Acme' }, config)).toEqual({ Name: 'Acme' });
    });

    it('leaves the key the write matches on and Id as they are, even when it names them', () => {
      const config = createObjectConfig({
        externalIdField: 'Ext_Id__c',
        transformRules: [
          { type: 'prefix', field: 'Ext_Id__c', config: { prefix: 'X-' } },
          { type: 'prefix', field: 'Id', config: { prefix: 'X-' } },
        ],
      });

      expect(
        pipeline.transformRecord({ Id: '001S1', Ext_Id__c: 'KEY-1', Name: 'Acme' }, config),
      ).toEqual({ Id: '001S1', Ext_Id__c: 'KEY-1', Name: 'Acme' });
    });
  });

  describe('an empty field', () => {
    it.each(['uppercase', 'lowercase', 'trim', 'truncate', 'prefix', 'suffix', 'replace'] as const)(
      'stays empty under %s, never ""',
      (type) => {
        // String(value ?? '') wrote "" into every field the source left empty.
        const rule: TransformRule = {
          type,
          config: { length: 3, prefix: 'X-', suffix: '-X', search: 'a', replace: 'b' },
        };

        expect(pipeline.transform(null, [rule])).toBeNull();
        expect(pipeline.transform(undefined, [rule])).toBeUndefined();
      },
    );

    it('stays empty under a date, a number or a formula rule', () => {
      expect(pipeline.transform(null, [{ type: 'format_date', config: {} }])).toBeNull();
      expect(pipeline.transform(null, [{ type: 'format_number', config: {} }])).toBeNull();
      expect(pipeline.transform('', [{ type: 'format_number', config: {} }])).toBe('');
      expect(
        pipeline.transform(null, [{ type: 'custom_formula', config: { formula: 'VALUE + 1' } }]),
      ).toBeNull();
    });

    it('is still filled by a default value, the rule meant for it', () => {
      expect(
        pipeline.transform(null, [{ type: 'default_value', config: { defaultValue: 'N/A' } }]),
      ).toBe('N/A');
    });

    it('leaves a number and a checkbox as they are under a text rule', () => {
      const rules: TransformRule[] = [{ type: 'uppercase', config: {} }];

      expect(pipeline.transform(250, rules)).toBe(250);
      expect(pipeline.transform(false, rules)).toBe(false);
    });
  });

  describe('a rule with nothing to apply', () => {
    it('changes nothing when Replace has nothing to find', () => {
      // An empty search matched between every two characters: "A-c-m-e".
      expect(pipeline.transform('Acme', [{ type: 'replace', config: { replace: '-' } }])).toBe(
        'Acme',
      );
      expect(
        pipeline.transform('Acme', [
          { type: 'regex_replace', config: { regex: '', replace: '-' } },
        ]),
      ).toBe('Acme');
    });

    it('leaves the number as read when the formula cannot be worked out', () => {
      // It returned the expression's text, which a number field refuses.
      expect(
        pipeline.transform(250, [
          { type: 'custom_formula', config: { formula: 'VALUE * 1.1 + 2' } },
        ]),
      ).toBe(250);
      expect(
        pipeline.transform(250, [{ type: 'custom_formula', config: { formula: 'VALUE / 0' } }]),
      ).toBe(250);
      expect(
        pipeline.transform('250', [{ type: 'custom_formula', config: { formula: 'VALUE * 2' } }]),
      ).toBe(500);
    });
  });

  describe('a date', () => {
    const zone = process.env.TZ;
    afterEach(() => {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    });

    it('keeps its day on a machine west of Greenwich', () => {
      // Read in the machine's zone, 2026-03-15 was written 2026-03-14 there.
      process.env.TZ = 'America/Los_Angeles';
      const rules: TransformRule[] = [
        { type: 'format_date', config: { dateFormat: 'DD/MM/YYYY' } },
      ];

      expect(pipeline.transform('2026-03-15', rules)).toBe('15/03/2026');
      expect(pipeline.transform('2026-03-15T23:30:00.000+0000', rules)).toBe('15/03/2026');
    });
  });

  describe('a rule that names no field', () => {
    it('is refused, not run on every field of the record', () => {
      // Run on every field, an Uppercase with no field upper-cased the
      // RecordTypeId with the name, and the run held both accounts back as of
      // a record type the target has not.
      const config = createObjectConfig({
        transformRules: [{ type: 'uppercase', config: {} }],
      });
      const record = { Name: 'acme', RecordTypeId: '012S1', ParentId: '001S1' };

      expect(() => pipeline.transformRecord(record, config)).toThrow(
        'The rule Uppercase on Account names no field: open the configuration and pick its field.',
      );
      expect(record).toEqual({
        Name: 'acme',
        RecordTypeId: '012S1',
        ParentId: '001S1',
      });
    });

    it('is refused beside rules that name theirs, each such rule named', () => {
      const config = createObjectConfig({
        objectApiName: 'Contact',
        transformRules: [
          { type: 'uppercase', field: 'LastName', config: {} },
          { type: 'trim', config: {} },
          { type: 'prefix', config: { prefix: 'X-' } },
        ],
      });

      expect(() => pipeline.transformRecord({ LastName: 'doe' }, config)).toThrow(
        'The rules Trim on Contact and Prefix on Contact name no field',
      );
    });
  });

  describe('a Regex replace whose pattern is no regular expression', () => {
    it('is refused naming the rule, its object and field, and the pattern, before the record is changed', () => {
      // It threw JavaScript's own SyntaxError, "Invalid regular expression:
      // /[a-/g: Unterminated character class", which named neither.
      const config = createObjectConfig({
        transformRules: [
          { type: 'uppercase', field: 'Name', config: {} },
          { type: 'regex_replace', field: 'Phone', config: { regex: '[a-', replace: '' } },
        ],
      });
      const record = { Name: 'acme', Phone: '+33 1' };

      expect(() => pipeline.transformRecord(record, config)).toThrow(
        'The rule Regex replace on Account.Phone, "[a-" (Unterminated character class) has a ' +
          'pattern that is no regular expression: open the configuration and correct it, or ' +
          'remove the rule.',
      );
      expect(record).toEqual({ Name: 'acme', Phone: '+33 1' });
    });

    it('is said in words where a value meets it, never as a bare SyntaxError', () => {
      const rules: TransformRule[] = [{ type: 'regex_replace', config: { regex: '(' } }];

      expect(() => pipeline.transform('text', rules)).toThrow(
        'The pattern "(" of a Regex replace rule is no regular expression: ',
      );
    });
  });

  describe('the field a write matches on', () => {
    it('is Id when the object upserts on no external id', () => {
      const config = createObjectConfig({
        transformRules: [
          { type: 'uppercase', field: 'Id', config: {} },
          { type: 'uppercase', field: 'Name', config: {} },
        ],
      });

      const result = pipeline.transformRecord({ Id: '001abc', Name: 'Acme' }, config);

      expect(result.Id).toBe('001abc');
      expect(result.Name).toBe('ACME');
    });
  });
});
