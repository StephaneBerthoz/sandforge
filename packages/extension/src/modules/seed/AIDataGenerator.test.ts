import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIDataGenerator, buildPrompt, parseAIResponse } from './AIDataGenerator';
import type { CallAIFn } from './AIDataGenerator';
import { isReservedPhone } from './LocaleData';
import type { FieldRule } from '@sandforge/shared';

function createFieldRule(overrides?: Partial<FieldRule>): FieldRule {
  return {
    fieldApiName: 'Name',
    ruleType: 'ai_generate',
    config: { aiPrompt: 'Generate a realistic company name' },
    ...overrides,
  };
}

describe('AIDataGenerator', () => {
  let callAI: CallAIFn;
  let generator: AIDataGenerator;

  beforeEach(() => {
    callAI = vi
      .fn<CallAIFn>()
      .mockResolvedValue(JSON.stringify([{ Name: 'Acme Corp' }, { Name: 'Globex Inc' }]));
    generator = new AIDataGenerator(callAI);
  });

  describe('generate', () => {
    it('should return empty array for zero count', async () => {
      const result = await generator.generate([createFieldRule()], 0);
      expect(result).toEqual([]);
    });

    it('should return empty array for empty field rules', async () => {
      const result = await generator.generate([], 5);
      expect(result).toEqual([]);
    });

    it('should call AI and parse response', async () => {
      const rules = [createFieldRule()];
      const result = await generator.generate(rules, 2);

      expect(callAI).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ Name: 'Acme Corp' });
    });

    it('should truncate results to requested count', async () => {
      vi.mocked(callAI).mockResolvedValue(
        JSON.stringify([{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }]),
      );
      const result = await generator.generate([createFieldRule()], 2);
      expect(result).toHaveLength(2);
    });

    it('should batch large requests into multiple AI calls', async () => {
      let callCount = 0;
      vi.mocked(callAI).mockImplementation(async () => {
        callCount++;
        const records = Array.from({ length: 50 }, (_, i) => ({ Name: `Record ${i}` }));
        return JSON.stringify(records);
      });

      const result = await generator.generate([createFieldRule()], 100);

      expect(callCount).toBe(2);
      expect(result).toHaveLength(100);
    });

    it('should include persona in the prompt when provided', async () => {
      await generator.generate([createFieldRule()], 1, 'Healthcare startup CEO');

      const promptArg = vi.mocked(callAI).mock.calls[0][0];
      expect(promptArg).toContain('Persona: Healthcare startup CEO');
    });

    it('should not include persona when not provided', async () => {
      await generator.generate([createFieldRule()], 1);

      const promptArg = vi.mocked(callAI).mock.calls[0][0];
      expect(promptArg).not.toContain('Persona:');
    });

    it('should handle AI returning a single object instead of array', async () => {
      vi.mocked(callAI).mockResolvedValue(JSON.stringify({ Name: 'Solo Corp' }));

      const result = await generator.generate([createFieldRule()], 1);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ Name: 'Solo Corp' });
    });

    it('should handle negative count gracefully', async () => {
      const result = await generator.generate([createFieldRule()], -5);
      expect(result).toEqual([]);
    });

    it('should propagate AI call errors', async () => {
      vi.mocked(callAI).mockRejectedValue(new Error('AI service unavailable'));

      await expect(generator.generate([createFieldRule()], 1)).rejects.toThrow(
        'AI service unavailable',
      );
    });
  });

  describe('buildPrompt', () => {
    it('should include field descriptions', () => {
      const rules = [
        createFieldRule({ fieldApiName: 'Email', config: { aiPrompt: 'business email' } }),
      ];
      const prompt = buildPrompt(rules, 5);

      expect(prompt).toContain('Email');
      expect(prompt).toContain('business email');
      expect(prompt).toContain('5');
    });

    it('should include range constraints when present', () => {
      const rules = [
        createFieldRule({
          fieldApiName: 'Revenue',
          config: { minValue: 1000, maxValue: 50000 },
        }),
      ];
      const prompt = buildPrompt(rules, 3);

      expect(prompt).toContain('1000');
      expect(prompt).toContain('50000');
    });

    it('should include length constraints when present', () => {
      const rules = [
        createFieldRule({
          fieldApiName: 'Code',
          config: { minLength: 3, maxLength: 10 },
        }),
      ];
      const prompt = buildPrompt(rules, 2);

      expect(prompt).toContain('3');
      expect(prompt).toContain('10');
    });

    it('should include persona when provided', () => {
      const prompt = buildPrompt([createFieldRule()], 5, 'Tech startup');
      expect(prompt).toContain('Persona: Tech startup');
    });

    it('should request JSON array output format', () => {
      const prompt = buildPrompt([createFieldRule()], 1);
      expect(prompt).toContain('JSON array');
    });

    it('asks for email addresses on reserved domains and phone numbers nobody holds', () => {
      const prompt = buildPrompt([createFieldRule()], 1);

      expect(prompt).toContain('example.com, example.net, example.org');
      expect(prompt).toContain('.example, .invalid or .test');
      for (const format of ['+1 212-555-01XX', '+33 1 99 00 XX XX', '+49 30 23125 XXX']) {
        expect(prompt).toContain(format);
      }
    });
  });

  describe('the contact details of an answer', () => {
    /** The records the generator keeps from a model answering `rows`. */
    async function kept(
      rows: Record<string, unknown>[],
      rules: FieldRule[] = [createFieldRule({ fieldApiName: 'Description' })],
    ): Promise<Record<string, unknown>[]> {
      const generator = new AIDataGenerator(async () => JSON.stringify(rows));
      return generator.generate(rules, rows.length);
    }

    it('moves an email address off a domain somebody owns, keeping the name the model chose', async () => {
      const [record] = await kept([
        { Email__c: 'jane.doe@acme.com', Description: 'Write to Sales@Globex.co.uk today.' },
      ]);

      expect(record['Email__c']).toBe('jane.doe@acme.example');
      expect(record['Description']).toBe('Write to Sales@Globex.co.example today.');
    });

    it('keeps an address already on a reserved domain as the model wrote it', async () => {
      const addresses = ['a@example.org', 'b@mail.example.com', 'c@corp.example', 'd@x.invalid'];
      const records = await kept(addresses.map((address) => ({ Email__c: address })));

      expect(records.map((r) => r['Email__c'])).toEqual(addresses);
    });

    it('replaces a phone number someone may hold, in a field the rule or the name says holds one', async () => {
      const [record] = await kept(
        [{ Line__c: '+33 6 12 34 56 78', MobilePhone: '+49 30 1234567', Fax: 4158675309 }],
        [createFieldRule({ fieldApiName: 'Line__c', fieldType: 'phone' })],
      );

      // The country the model wrote is kept, inside the range nobody holds.
      expect(record['Line__c']).toMatch(/^\+33 [1-6] \d{2} \d{2} \d{2} \d{2}$/);
      expect(isReservedPhone(String(record['Line__c']), 'fr_FR')).toBe(true);
      expect(isReservedPhone(String(record['MobilePhone']), 'de_DE')).toBe(true);
      // A number with no country becomes one of the default locale's.
      expect(isReservedPhone(String(record['Fax']), 'en_US')).toBe(true);
    });

    it('keeps a phone number nobody holds as the model wrote it', async () => {
      const [record] = await kept([{ Phone: '+1 (212) 555-0142', MobilePhone: '06 39 98 12 34' }]);

      expect(record).toEqual({ Phone: '+1 (212) 555-0142', MobilePhone: '06 39 98 12 34' });
    });

    it('replaces the numbers written in free text, and leaves amounts, dates and identifiers alone', async () => {
      const untouched = [
        '12 345 678 EUR',
        '01/02/2024',
        'FR76 3000 6000 0112 3456 7890 189',
        '123 456 789 00012',
        '+1 212-555-0187',
      ];
      const [record] = await kept([
        {
          Description:
            'Call (415) 867-5309, +44 20 7123 4567 or 06 12 34 56 78. ' + untouched.join('; '),
          Mobile_Plan__c: 'Unlimited 5G',
        },
      ]);
      const description = String(record['Description']);

      for (const dialable of ['(415) 867-5309', '+44 20 7123 4567', '06 12 34 56 78']) {
        expect(description).not.toContain(dialable);
      }
      // None names a supported country, so each becomes one of the default locale's.
      const replaced = /^Call (.+), (.+) or (.+?)\. /.exec(description)?.slice(1) ?? [];
      expect(replaced).toHaveLength(3);
      for (const number of replaced) {
        expect(isReservedPhone(number, 'en_US'), number).toBe(true);
      }
      for (const value of untouched) {
        expect(description).toContain(value);
      }
      expect(record['Mobile_Plan__c']).toBe('Unlimited 5G');
    });

    it('replaces the Spanish and Brazilian numbers written the national way, with no + nor leading 0', async () => {
      const untouched = [
        '912 345 678,50 €',
        '€ 712 345 678',
        '1 912 345 678',
        '623 456 789 00012',
        '312 345 678',
        '11 90123-4567',
      ];
      const [record] = await kept([
        {
          Description:
            'Llame al 912 345 678 o al 612 34 56 78; ligue para 11 91234-5678. ' +
            untouched.join('; '),
        },
      ]);
      const description = String(record['Description']);

      for (const dialable of ['912 345 678 o', '612 34 56 78', '11 91234-5678']) {
        expect(description).not.toContain(dialable);
      }
      const replaced =
        /^Llame al (.+) o al (.+); ligue para (.+?)\. /.exec(description)?.slice(1) ?? [];
      expect(replaced).toHaveLength(3);
      for (const number of replaced) {
        expect(isReservedPhone(number), number).toBe(true);
      }
      // Amounts and identifiers stay, and so do the numbers nobody holds: a
      // Spanish one starting with 3, a Brazilian mobile starting with 90.
      for (const value of untouched) {
        expect(description).toContain(value);
      }
    });
  });

  describe('parseAIResponse', () => {
    it('should parse a valid JSON array', () => {
      const result = parseAIResponse('[{"name": "Alice"}, {"name": "Bob"}]');
      expect(result).toHaveLength(2);
    });

    it('should handle markdown code blocks', () => {
      const response = '```json\n[{"name": "Alice"}]\n```';
      const result = parseAIResponse(response);
      expect(result).toHaveLength(1);
    });

    it('should handle a single JSON object', () => {
      const result = parseAIResponse('{"name": "Solo"}');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ name: 'Solo' });
    });

    it('should filter out non-object items in array', () => {
      const result = parseAIResponse('[{"name": "Alice"}, 42, "string", null]');
      expect(result).toHaveLength(1);
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseAIResponse('not json')).toThrow();
    });
  });
});
