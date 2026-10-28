import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FieldMapper, generateValue } from './FieldMapper';
import type { FieldMapperDependencies } from './FieldMapper';
import { FakerFallback } from './FakerFallback';
import { isReservedPhone } from './LocaleData';
import type { SeedObjectConfig, FieldRule } from '@sandforge/shared';

function createMockDeps(): FieldMapperDependencies {
  return {
    aiGenerator: {
      generate: vi.fn().mockResolvedValue([]),
    } as unknown as FieldMapperDependencies['aiGenerator'],
    fakerFallback: {
      generate: vi.fn().mockReturnValue([]),
    } as unknown as FieldMapperDependencies['fakerFallback'],
  };
}

function createObjectConfig(fieldRules: FieldRule[], recordCount = 3): SeedObjectConfig {
  return {
    objectApiName: 'Account',
    recordCount,
    fieldRules,
    excludedFields: [],
    insertOrder: 0,
    batchSize: 200,
  };
}

describe('FieldMapper', () => {
  let deps: FieldMapperDependencies;
  let mapper: FieldMapper;

  beforeEach(() => {
    deps = createMockDeps();
    mapper = new FieldMapper(deps);
  });

  describe('mapFields', () => {
    it('should return empty array for zero record count', async () => {
      const config = createObjectConfig(
        [{ fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Test' } }],
        0,
      );
      const result = await mapper.mapFields(config, new Map());
      expect(result).toEqual([]);
    });

    it('should return empty array for no field rules', async () => {
      const config = createObjectConfig([], 5);
      const result = await mapper.mapFields(config, new Map());
      expect(result).toEqual([]);
    });

    it('should generate static values for all records', async () => {
      const config = createObjectConfig([
        { fieldApiName: 'Status', ruleType: 'static', config: { staticValue: 'Active' } },
      ]);

      const result = await mapper.mapFields(config, new Map());
      expect(result).toHaveLength(3);
      for (const record of result) {
        expect(record['Status']).toBe('Active');
      }
    });

    it('should generate sequence values', async () => {
      const config = createObjectConfig([
        {
          fieldApiName: 'Code',
          ruleType: 'sequence',
          config: { sequenceStart: 1, sequenceStep: 1, sequencePrefix: 'C-' },
        },
      ]);

      const result = await mapper.mapFields(config, new Map());
      expect(result[0]['Code']).toBe('C-1');
      expect(result[1]['Code']).toBe('C-2');
      expect(result[2]['Code']).toBe('C-3');
    });

    it('should delegate AI rules to aiGenerator', async () => {
      vi.mocked(deps.aiGenerator.generate).mockResolvedValue([
        { Bio: 'AI text 1' },
        { Bio: 'AI text 2' },
      ]);

      const config = createObjectConfig(
        [{ fieldApiName: 'Bio', ruleType: 'ai_generate', config: { aiPrompt: 'Generate bio' } }],
        2,
      );

      const result = await mapper.mapFields(config, new Map());
      expect(deps.aiGenerator.generate).toHaveBeenCalledTimes(1);
      expect(result[0]['Bio']).toBe('AI text 1');
    });

    it('fills ai_generate fields with generated text when the AI call returns no records', async () => {
      const realMapper = new FieldMapper({
        aiGenerator: deps.aiGenerator,
        fakerFallback: new FakerFallback(),
      });
      const config = createObjectConfig(
        [{ fieldApiName: 'Bio', ruleType: 'ai_generate', config: { aiPrompt: 'Generate bio' } }],
        3,
      );

      const result = await realMapper.mapFields(config, new Map());

      expect(result).toHaveLength(3);
      for (const record of result) {
        expect(record['Bio']).toEqual(expect.stringMatching(/\S/));
      }
    });

    it('keeps the values the AI returned and fills only the ones it left out', async () => {
      vi.mocked(deps.aiGenerator.generate).mockResolvedValue([{ Bio: 'AI text 1', Title: 'CEO' }]);
      const realMapper = new FieldMapper({
        aiGenerator: deps.aiGenerator,
        fakerFallback: new FakerFallback(),
      });
      const config = createObjectConfig(
        [
          { fieldApiName: 'Bio', ruleType: 'ai_generate', config: { aiPrompt: 'Generate bio' } },
          { fieldApiName: 'Title', ruleType: 'ai_generate', config: { aiPrompt: 'Job title' } },
        ],
        2,
      );

      const result = await realMapper.mapFields(config, new Map());

      expect(result[0]).toEqual({ Bio: 'AI text 1', Title: 'CEO' });
      expect(result[1]['Bio']).toEqual(expect.stringMatching(/\S/));
      expect(result[1]['Title']).toEqual(expect.stringMatching(/\S/));
    });

    it('cuts the generated sentence of a refused AI call to the field length', async () => {
      const realMapper = new FieldMapper({
        aiGenerator: deps.aiGenerator,
        fakerFallback: new FakerFallback(),
      });
      const config = createObjectConfig(
        [
          {
            fieldApiName: 'Title',
            ruleType: 'ai_generate',
            config: { aiPrompt: 'Job title', maxLength: 20 },
          },
        ],
        8,
      );

      const result = await realMapper.mapFields(config, new Map());

      for (const record of result) {
        const value = record['Title'] as string;
        expect(value.length).toBeLessThanOrEqual(20);
        expect(value).toMatch(/\S/);
      }
    });

    it('cuts an AI answer longer than the field at a word boundary', async () => {
      vi.mocked(deps.aiGenerator.generate).mockResolvedValue([
        { Title: 'Senior Vice President of Customer Operations' },
        { Title: 'Supercalifragilisticexpialidocious' },
      ]);
      const config = createObjectConfig(
        [
          {
            fieldApiName: 'Title',
            ruleType: 'ai_generate',
            config: { aiPrompt: 'Job title', maxLength: 20 },
          },
        ],
        2,
      );

      const result = await mapper.mapFields(config, new Map());

      expect(result[0]['Title']).toBe('Senior Vice');
      expect(result[1]['Title']).toBe('Supercalifragilistic');
    });

    it('cuts a generated faker sentence to the field length', async () => {
      const realMapper = new FieldMapper({
        aiGenerator: deps.aiGenerator,
        fakerFallback: new FakerFallback(),
      });
      const config = createObjectConfig([
        {
          fieldApiName: 'Subject__c',
          ruleType: 'faker',
          config: { fakerMethod: 'sentence', maxLength: 12 },
        },
      ]);

      const result = await realMapper.mapFields(config, new Map());

      for (const record of result) {
        expect((record['Subject__c'] as string).length).toBeLessThanOrEqual(12);
      }
    });

    it('leaves an AI answer whole when the rule sets no length', async () => {
      const long = 'Senior Vice President of Customer Operations';
      vi.mocked(deps.aiGenerator.generate).mockResolvedValue([{ Title: long }]);
      const config = createObjectConfig(
        [{ fieldApiName: 'Title', ruleType: 'ai_generate', config: { aiPrompt: 'Job title' } }],
        1,
      );

      const result = await mapper.mapFields(config, new Map());

      expect(result[0]['Title']).toBe(long);
    });

    it('reports the AI fields that received a generated sentence when the call answered nothing', async () => {
      const realMapper = new FieldMapper({
        aiGenerator: deps.aiGenerator,
        fakerFallback: new FakerFallback(),
      });
      const onAiFallback = vi.fn();
      const config = createObjectConfig([
        { fieldApiName: 'Bio', ruleType: 'ai_generate', config: { aiPrompt: 'Bio' } },
        { fieldApiName: 'Title', ruleType: 'ai_generate', config: { aiPrompt: 'Title' } },
      ]);

      await realMapper.mapFields(config, new Map(), onAiFallback);

      expect(onAiFallback).toHaveBeenCalledWith({ fields: ['Bio', 'Title'], reason: 'no-answer' });
    });

    it('reports only the fields a short AI answer left out', async () => {
      vi.mocked(deps.aiGenerator.generate).mockResolvedValue([
        { Bio: 'AI text 1', Title: 'CEO' },
        { Bio: 'AI text 2' },
      ]);
      const realMapper = new FieldMapper({
        aiGenerator: deps.aiGenerator,
        fakerFallback: new FakerFallback(),
      });
      const onAiFallback = vi.fn();
      const config = createObjectConfig(
        [
          { fieldApiName: 'Bio', ruleType: 'ai_generate', config: { aiPrompt: 'Bio' } },
          { fieldApiName: 'Title', ruleType: 'ai_generate', config: { aiPrompt: 'Title' } },
        ],
        2,
      );

      await realMapper.mapFields(config, new Map(), onAiFallback);

      expect(onAiFallback).toHaveBeenCalledWith({ fields: ['Title'], reason: 'short-answer' });
    });

    it('reports nothing when the AI answered every field', async () => {
      vi.mocked(deps.aiGenerator.generate).mockResolvedValue([{ Bio: 'AI text 1' }]);
      const onAiFallback = vi.fn();
      const config = createObjectConfig(
        [{ fieldApiName: 'Bio', ruleType: 'ai_generate', config: { aiPrompt: 'Bio' } }],
        1,
      );

      await mapper.mapFields(config, new Map(), onAiFallback);

      expect(onAiFallback).not.toHaveBeenCalled();
    });

    it('should delegate faker rules to fakerFallback', async () => {
      vi.mocked(deps.fakerFallback.generate).mockReturnValue([
        { Email: 'test@example.com' },
        { Email: 'other@example.com' },
      ]);

      const config = createObjectConfig(
        [{ fieldApiName: 'Email', ruleType: 'faker', config: { fakerMethod: 'email' } }],
        2,
      );

      const result = await mapper.mapFields(config, new Map());
      expect(deps.fakerFallback.generate).toHaveBeenCalledTimes(1);
      expect(result[0]['Email']).toBe('test@example.com');
    });

    it('should resolve reference fields from existing IDs', async () => {
      const existingIds = new Map([['Account', ['001AAA', '001BBB']]]);
      const config = createObjectConfig(
        [
          {
            fieldApiName: 'AccountId',
            ruleType: 'reference',
            config: { referenceObject: 'Account' },
          },
        ],
        2,
      );

      const result = await mapper.mapFields(config, existingIds);
      for (const record of result) {
        expect(['001AAA', '001BBB']).toContain(record['AccountId']);
      }
    });

    it('should return null for reference with no available IDs', async () => {
      const config = createObjectConfig(
        [
          {
            fieldApiName: 'AccountId',
            ruleType: 'reference',
            config: { referenceObject: 'Account' },
          },
        ],
        1,
      );

      const result = await mapper.mapFields(config, new Map());
      expect(result[0]['AccountId']).toBeNull();
    });

    it('should combine multiple rule types in one record', async () => {
      vi.mocked(deps.fakerFallback.generate).mockReturnValue([{ Email: 'a@b.com' }]);

      const config = createObjectConfig(
        [
          { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Test' } },
          { fieldApiName: 'Email', ruleType: 'faker', config: { fakerMethod: 'email' } },
        ],
        1,
      );

      const result = await mapper.mapFields(config, new Map());
      expect(result[0]['Name']).toBe('Test');
      expect(result[0]['Email']).toBe('a@b.com');
    });

    it('should handle picklist_random rule', async () => {
      const config = createObjectConfig(
        [
          {
            fieldApiName: 'Status',
            ruleType: 'picklist_random',
            config: { picklistValues: ['Open', 'Closed', 'Pending'] },
          },
        ],
        5,
      );

      const result = await mapper.mapFields(config, new Map());
      for (const record of result) {
        expect(['Open', 'Closed', 'Pending']).toContain(record['Status']);
      }
    });

    it("picks a persona's emails and phone numbers as values that reach nobody, as an AI answer's", async () => {
      // A persona's random picks become these values, and an AI-written
      // persona listed real-looking addresses and numbers for contact fields.
      const config = createObjectConfig(
        [
          {
            fieldApiName: 'Email',
            ruleType: 'picklist_random',
            config: { picklistValues: ['jane.doe@acme.com', 'ops@corp.example'] },
          },
          {
            fieldApiName: 'Hotline__c',
            fieldType: 'phone',
            ruleType: 'picklist_random',
            config: { picklistValues: ['+33 6 12 34 56 78'] },
          },
          {
            fieldApiName: 'Note__c',
            ruleType: 'picklist_random',
            config: { picklistValues: ['Call 912 345 678 after six'] },
          },
          {
            fieldApiName: 'Status',
            ruleType: 'picklist_random',
            config: { picklistValues: ['Open'] },
          },
        ],
        20,
      );

      const result = await mapper.mapFields(config, new Map());

      expect(new Set(result.map((record) => record['Email']))).toEqual(
        new Set(['jane.doe@acme.example', 'ops@corp.example']),
      );
      const hotlines = new Set(result.map((record) => record['Hotline__c']));
      expect(hotlines.size).toBe(1);
      const [hotline] = [...hotlines];
      expect(isReservedPhone(String(hotline), 'fr_FR')).toBe(true);
      const notes = new Set(result.map((record) => String(record['Note__c'])));
      expect(notes.size).toBe(1);
      const [note] = [...notes];
      expect(note).not.toContain('912 345 678');
      expect(isReservedPhone(note.replace(/^Call | after six$/g, ''))).toBe(true);
      expect(result.every((record) => record['Status'] === 'Open')).toBe(true);
    });
  });

  describe('close dates and stages', () => {
    const TODAY = new Date('2026-10-20T10:00:00.000Z');
    const opportunity = (closeDate: FieldRule): SeedObjectConfig => ({
      ...createObjectConfig(
        [
          {
            fieldApiName: 'StageName',
            ruleType: 'picklist_random',
            config: {
              picklistValues: ['Prospecting', 'Negotiation/Review', 'Closed Won', 'Closed Lost'],
            },
          },
          closeDate,
        ],
        200,
      ),
      objectApiName: 'Opportunity',
    });

    it('closes a won or lost opportunity before today, and an open one after it', async () => {
      // A close date drawn on its own fell after today for opportunities
      // already won or lost.
      const real = new FieldMapper({
        ...createMockDeps(),
        fakerFallback: new FakerFallback('en_US', { today: () => TODAY }),
      });
      const records = await real.mapFields(
        opportunity({
          fieldApiName: 'CloseDate',
          ruleType: 'faker',
          config: { fakerMethod: 'date.soon' },
        }),
        new Map(),
      );
      const stages = new Set(records.map((r) => r['StageName']));
      expect(stages.size).toBe(4);
      for (const r of records) {
        const close = new Date(String(r['CloseDate'])).getTime();
        if (String(r['StageName']).startsWith('Closed'))
          expect(close).toBeLessThan(TODAY.getTime());
        else expect(close).toBeGreaterThan(TODAY.getTime());
      }
    });

    it('keeps a close date the author set', async () => {
      const real = new FieldMapper({ ...createMockDeps(), fakerFallback: new FakerFallback() });
      const records = await real.mapFields(
        opportunity({
          fieldApiName: 'CloseDate',
          ruleType: 'static',
          config: { staticValue: '2027-01-15' },
        }),
        new Map(),
      );
      expect(records.every((r) => r['CloseDate'] === '2027-01-15')).toBe(true);
    });
  });

  describe('rows', () => {
    const rowsConfig = (
      rows: NonNullable<SeedObjectConfig['rows']>,
      fieldRules: FieldRule[] = [],
    ): SeedObjectConfig => ({
      ...createObjectConfig(fieldRules, rows.length),
      objectApiName: 'Case',
      rows,
    });

    it('gives each record its row’s values as they are, numbers, booleans and nulls included', async () => {
      const records = await mapper.mapFields(
        rowsConfig([
          { key: 'k1', values: { Subject: 'Parcel damaged', Priority__c: 2, IsEscalated: true } },
          { key: 'k2', values: { Subject: 'Refund', Description: null } },
        ]),
        new Map(),
      );
      expect(records).toEqual([
        { Subject: 'Parcel damaged', Priority__c: 2, IsEscalated: true },
        { Subject: 'Refund', Description: null },
      ]);
    });

    it('lets a row’s value win over its rule’s, and the rule fill what the row leaves out', async () => {
      const records = await mapper.mapFields(
        rowsConfig(
          [
            { key: 'k1', values: { Status: 'Closed' } },
            { key: 'k2', values: {} },
          ],
          [{ fieldApiName: 'Status', ruleType: 'static', config: { staticValue: 'New' } }],
        ),
        new Map(),
      );
      expect(records.map((r) => r['Status'])).toEqual(['Closed', 'New']);
    });

    it('starts at the row of the first record of a slice', async () => {
      const config = rowsConfig([
        { key: 'k1', values: { Subject: 'one' } },
        { key: 'k2', values: { Subject: 'two' } },
        { key: 'k3', values: { Subject: 'three' } },
      ]);
      const records = await mapper.mapFields(
        { ...config, recordCount: 2 },
        new Map(),
        undefined,
        1,
      );
      expect(records.map((r) => r['Subject'])).toEqual(['two', 'three']);
    });

    it('moves an address and a phone number a row gives to ones that reach nobody', async () => {
      const [record] = await mapper.mapFields(
        rowsConfig([
          {
            key: 'k1',
            values: {
              SuppliedEmail: 'jane@gmail.com',
              SuppliedPhone: '+33 6 12 34 56 78',
              Description: 'Write to jane@gmail.com or call +33 6 12 34 56 78.',
            },
          },
        ]),
        new Map(),
      );
      expect(record['SuppliedEmail']).toBe('jane@gmail.example');
      expect(isReservedPhone(String(record['SuppliedPhone']))).toBe(true);
      expect(record['Description']).not.toContain('gmail.com');
      expect(record['Description']).not.toContain('12 34 56 78');
    });

    it('cuts a row’s text to the length the org gives its field, else to its rule’s', async () => {
      const [record] = await mapper.mapFields(
        rowsConfig(
          [
            {
              key: 'k1',
              values: {
                Subject: 'My parcel arrived broken today',
                Reason__c: 'Damaged in transit',
              },
            },
          ],
          [{ fieldApiName: 'Reason__c', ruleType: 'static', config: { maxLength: 7 } }],
        ),
        new Map(),
        undefined,
        0,
        new Map([['Subject', 20]]),
      );
      expect(record['Subject']).toBe('My parcel arrived');
      expect(record['Reason__c']).toBe('Damaged');
    });

    it('writes the rows of an object that has no rule', async () => {
      const records = await mapper.mapFields(
        rowsConfig([{ key: 'k1', values: { Subject: 'only rows' } }]),
        new Map(),
      );
      expect(records).toEqual([{ Subject: 'only rows' }]);
    });
  });

  describe('draws', () => {
    it('draws numbers, picks and parents from the draw it is given', async () => {
      const config = createObjectConfig(
        [
          { fieldApiName: 'Score__c', ruleType: 'random', config: { minValue: 0, maxValue: 99 } },
          {
            fieldApiName: 'Tier__c',
            ruleType: 'picklist_random',
            config: { picklistValues: ['A', 'B', 'C'] },
          },
          {
            fieldApiName: 'ParentId',
            ruleType: 'reference',
            config: { referenceObject: 'Account' },
          },
        ],
        5,
      );
      const parents = new Map([['Account', ['001A', '001B', '001C', '001D']]]);
      const draw = (): (() => number) => {
        const values = [0.1, 0.7, 0.4, 0.95, 0.2, 0.55];
        let at = 0;
        return () => values[at++ % values.length];
      };
      const one = await new FieldMapper({ ...createMockDeps(), random: draw() }).mapFields(
        config,
        parents,
      );
      const two = await new FieldMapper({ ...createMockDeps(), random: draw() }).mapFields(
        config,
        parents,
      );
      expect(one).toEqual(two);
      expect(one[0]).toEqual({ Score__c: 10, Tier__c: 'C', ParentId: '001B' });
    });
  });

  describe('generateValue', () => {
    it('should return static value', () => {
      const rule: FieldRule = {
        fieldApiName: 'X',
        ruleType: 'static',
        config: { staticValue: 42 },
      };
      expect(generateValue(rule, 0, new Map())).toBe(42);
    });

    it('should return null for static with no value', () => {
      const rule: FieldRule = { fieldApiName: 'X', ruleType: 'static', config: {} };
      expect(generateValue(rule, 0, new Map())).toBeNull();
    });

    it('should return formula string for formula rule', () => {
      const rule: FieldRule = {
        fieldApiName: 'X',
        ruleType: 'formula',
        config: { formula: 'A + B' },
      };
      expect(generateValue(rule, 0, new Map())).toBe('A + B');
    });

    it('should return null for from_csv rule', () => {
      const rule: FieldRule = {
        fieldApiName: 'X',
        ruleType: 'from_csv',
        config: { csvColumn: 'col1' },
      };
      expect(generateValue(rule, 0, new Map())).toBeNull();
    });

    it('should return null for unknown rule type', () => {
      const rule = {
        fieldApiName: 'X',
        ruleType: 'unknown_type' as FieldRule['ruleType'],
        config: {},
      };
      expect(generateValue(rule, 0, new Map())).toBeNull();
    });
  });
});
