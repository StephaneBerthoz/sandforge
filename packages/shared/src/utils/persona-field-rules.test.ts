import { describe, it, expect } from 'vitest';

import { mapGeneratorToRuleType, personaPatternToFieldRule } from './persona-field-rules.js';

describe('mapGeneratorToRuleType', () => {
  it('should map faker to faker', () => {
    expect(mapGeneratorToRuleType('faker')).toBe('faker');
  });

  it('should map random_pick to picklist_random', () => {
    expect(mapGeneratorToRuleType('random_pick')).toBe('picklist_random');
  });

  it('should map weighted_pick to picklist_random', () => {
    expect(mapGeneratorToRuleType('weighted_pick')).toBe('picklist_random');
  });

  it('should map range to random', () => {
    expect(mapGeneratorToRuleType('range')).toBe('random');
  });

  it('should map sequence to sequence', () => {
    expect(mapGeneratorToRuleType('sequence')).toBe('sequence');
  });

  it('should map pattern to regex', () => {
    expect(mapGeneratorToRuleType('pattern')).toBe('regex');
  });

  it('should map ai_generate to ai_generate', () => {
    expect(mapGeneratorToRuleType('ai_generate')).toBe('ai_generate');
  });

  it('should map relative_date to faker', () => {
    expect(mapGeneratorToRuleType('relative_date')).toBe('faker');
  });

  it('should return null for unknown generator', () => {
    expect(mapGeneratorToRuleType('unknown_type')).toBeNull();
  });
});

describe('personaPatternToFieldRule', () => {
  it('returns null when the generator has no rule type', () => {
    expect(
      personaPatternToFieldRule({ fieldType: 'string', generator: 'unknown_type', examples: [] }),
    ).toBeNull();
  });

  it('carries an ai_generate instruction to the aiPrompt config key', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'textarea',
      generator: 'ai_generate',
      params: { prompt: 'Product review, 1-3 sentences, realistic tone' },
      examples: [],
    });

    expect(rule).toEqual({
      ruleType: 'ai_generate',
      config: { aiPrompt: 'Product review, 1-3 sentences, realistic tone' },
    });
  });

  it('carries range bounds to minValue/maxValue', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'currency',
      generator: 'range',
      params: { min: 200, max: 5000, currency: 'EUR' },
      examples: [],
    });

    /* `currency` has no contract key: emitting it would only be dropped by
       seedConfigSchema on the way to the extension. */
    expect(rule).toEqual({ ruleType: 'random', config: { minValue: 200, maxValue: 5000 } });
  });

  it('reads range bounds a custom persona stored as strings', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'number',
      generator: 'range',
      params: { min: '1', max: '5' },
      examples: [],
    });

    expect(rule?.config).toEqual({ minValue: 1, maxValue: 5 });
  });

  it('carries a random_pick list to picklistValues', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'picklist',
      generator: 'random_pick',
      params: { values: ['Auto', 'Habitation', 'Santé'] },
      examples: [],
    });

    expect(rule).toEqual({
      ruleType: 'picklist_random',
      config: { picklistValues: ['Auto', 'Habitation', 'Santé'] },
    });
  });

  it('carries the values of a weighted_pick to picklistValues', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'picklist',
      generator: 'weighted_pick',
      params: { values: { Free: 0.4, Starter: 0.25, Pro: 0.2, Enterprise: 0.15 } },
      examples: [],
    });

    /* The contract carries no weights — the allowed values are what survives. */
    expect(rule).toEqual({
      ruleType: 'picklist_random',
      config: { picklistValues: ['Free', 'Starter', 'Pro', 'Enterprise'] },
    });
  });

  it('carries a sequence prefix, start and step', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'string',
      generator: 'sequence',
      params: { prefix: 'MRN-', start: 100, step: 2, padLength: 8 },
      examples: [],
    });

    /* padLength has no contract key; the prefix and the progression do. */
    expect(rule).toEqual({
      ruleType: 'sequence',
      config: { sequencePrefix: 'MRN-', sequenceStart: 100, sequenceStep: 2 },
    });
  });

  it('carries a pattern to regexPattern', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'string',
      generator: 'pattern',
      params: { pattern: '###########00##' },
      examples: [],
    });

    expect(rule).toEqual({ ruleType: 'regex', config: { regexPattern: '###########00##' } });
  });

  it('translates a faker.js method name to the one the reader knows', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'string',
      generator: 'faker',
      params: { method: 'company.name', locale: 'fr' },
      examples: [],
    });

    expect(rule).toEqual({
      ruleType: 'faker',
      config: { fakerMethod: 'company', fakerLocale: 'fr' },
    });
  });

  it('leaves an unaliased faker method untouched', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'string',
      generator: 'faker',
      params: { method: 'email' },
      examples: [],
    });

    expect(rule?.config).toEqual({ fakerMethod: 'email' });
  });

  it('turns a relative_date window into a dated faker method', () => {
    const future = personaPatternToFieldRule({
      fieldType: 'date',
      generator: 'relative_date',
      params: { minDaysFromNow: 1, maxDaysFromNow: 14 },
      examples: [],
    });
    const past = personaPatternToFieldRule({
      fieldType: 'date',
      generator: 'relative_date',
      params: { minDaysFromNow: -30, maxDaysFromNow: -1 },
      examples: [],
    });

    expect(future?.config).toEqual({ fakerMethod: 'futureDate' });
    expect(past?.config).toEqual({ fakerMethod: 'pastDate' });
  });

  it('accepts params already written with contract keys', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'number',
      generator: 'range',
      params: { minValue: 3, maxValue: 9 },
      examples: [],
    });

    expect(rule?.config).toEqual({ minValue: 3, maxValue: 9 });
  });

  it('emits an empty config when the pattern carries no params', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'string',
      generator: 'faker',
      examples: [],
    });

    expect(rule).toEqual({ ruleType: 'faker', config: {} });
    expect(Object.keys(rule?.config ?? {})).toEqual([]);
  });

  /* ----------------------------------------------------------------- *
   * Contract keys win, and the persona alias is only a fallback.
   * ----------------------------------------------------------------- */

  it('prefers the contract key over the persona alias for a faker method', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'string',
      generator: 'faker',
      params: { fakerMethod: 'email', method: 'company.name', fakerLocale: 'de', locale: 'fr' },
      examples: [],
    });

    expect(rule?.config).toEqual({ fakerMethod: 'email', fakerLocale: 'de' });
  });

  it('prefers the contract keys over the persona aliases for a sequence', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'string',
      generator: 'sequence',
      params: {
        sequencePrefix: 'INV-',
        prefix: 'MRN-',
        sequenceStart: 500,
        start: 1,
        sequenceStep: 5,
        step: 1,
      },
      examples: [],
    });

    expect(rule?.config).toEqual({
      sequencePrefix: 'INV-',
      sequenceStart: 500,
      sequenceStep: 5,
    });
  });

  it('prefers the contract key over the persona alias for a pattern', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'string',
      generator: 'pattern',
      params: { regexPattern: '[A-Z]{3}', pattern: '###' },
      examples: [],
    });

    expect(rule?.config).toEqual({ regexPattern: '[A-Z]{3}' });
  });

  it('prefers the contract key over the persona alias for an AI instruction', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'textarea',
      generator: 'ai_generate',
      params: { aiPrompt: 'contract wording', prompt: 'persona wording' },
      examples: [],
    });

    expect(rule?.config).toEqual({ aiPrompt: 'contract wording' });
  });

  it('prefers the contract key over the persona alias for a picklist', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'picklist',
      generator: 'random_pick',
      params: { picklistValues: ['Gold'], values: ['Silver'] },
      examples: [],
    });

    expect(rule?.config).toEqual({ picklistValues: ['Gold'] });
  });

  /* ----------------------------------------------------------------- *
   * A key that is present but unusable falls through to the next one,
   * and a config key is only emitted when a value was actually read.
   * ----------------------------------------------------------------- */

  it('skips an empty string and reads the next candidate', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'string',
      generator: 'faker',
      params: { fakerMethod: '', method: 'email' },
      examples: [],
    });

    expect(rule?.config).toEqual({ fakerMethod: 'email' });
  });

  it('skips a non-finite number and reads the next candidate', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'number',
      generator: 'range',
      params: { minValue: Number.NaN, min: 7 },
      examples: [],
    });

    expect(rule?.config).toEqual({ minValue: 7 });
  });

  it('skips a blank string and reads the next candidate', () => {
    // `Number('   ')` is 0: a blank left in a persona used to become a real
    // bound of zero instead of falling through to the value beside it.
    const rule = personaPatternToFieldRule({
      fieldType: 'number',
      generator: 'range',
      params: { minValue: '   ', min: 7 },
      examples: [],
    });

    expect(rule?.config).toEqual({ minValue: 7 });
  });

  it('skips a string that is not a number and reads the next candidate', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'number',
      generator: 'range',
      params: { minValue: 'about ten', min: 7 },
      examples: [],
    });

    expect(rule?.config).toEqual({ minValue: 7 });
  });

  it('skips a value that is neither number nor string', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'number',
      generator: 'range',
      params: { minValue: false, min: 7 },
      examples: [],
    });

    expect(rule?.config).toEqual({ minValue: 7 });
  });

  it('emits no key at all for a generator whose params say nothing', () => {
    // `toEqual` treats `{ fakerMethod: undefined }` as `{}`, which is how a
    // config key set to undefined reached the extension unnoticed. The keys
    // are what the schema looks at, so the keys are what is asserted.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['faker', {}],
      ['range', {}],
      ['sequence', {}],
      ['pattern', {}],
      ['ai_generate', {}],
      ['random_pick', {}],
      ['weighted_pick', {}],
    ];

    for (const [generator, params] of cases) {
      const rule = personaPatternToFieldRule({
        fieldType: 'string',
        generator,
        params,
        examples: [],
      });
      expect(Object.keys(rule?.config ?? { unread: true })).toEqual([]);
    }
  });

  it('emits only the bound the params actually carry', () => {
    const minOnly = personaPatternToFieldRule({
      fieldType: 'number',
      generator: 'range',
      params: { min: 4 },
      examples: [],
    });
    const maxOnly = personaPatternToFieldRule({
      fieldType: 'number',
      generator: 'range',
      params: { max: 9 },
      examples: [],
    });

    expect(Object.keys(minOnly?.config ?? {})).toEqual(['minValue']);
    expect(Object.keys(maxOnly?.config ?? {})).toEqual(['maxValue']);
  });

  it('emits only the sequence parts the params actually carry', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'string',
      generator: 'sequence',
      params: { start: 10 },
      examples: [],
    });

    expect(Object.keys(rule?.config ?? {})).toEqual(['sequenceStart']);
  });

  /* ----------------------------------------------------------------- *
   * Picklist values: what is a value, and what is not a list at all.
   * ----------------------------------------------------------------- */

  it('drops the holes in a picklist rather than turning them into values', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'picklist',
      generator: 'random_pick',
      params: { values: ['Auto', null, undefined, 'Santé'] },
      examples: [],
    });

    // Kept as written, a hole becomes the literal string "null" — a picklist
    // value no org has.
    expect(rule?.config).toEqual({ picklistValues: ['Auto', 'Santé'] });
  });

  it('reads nothing from a picklist that is a bare string', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'picklist',
      generator: 'random_pick',
      params: { values: 'Auto' },
      examples: [],
    });

    // Indexing a string would yield ['0', '1', '2', '3'].
    expect(Object.keys(rule?.config ?? {})).toEqual([]);
  });

  it('reads nothing from a null picklist', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'picklist',
      generator: 'random_pick',
      params: { values: null },
      examples: [],
    });

    expect(Object.keys(rule?.config ?? {})).toEqual([]);
  });

  it('numbers in a picklist reach the contract as strings', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'picklist',
      generator: 'weighted_pick',
      params: { values: [1, 2] },
      examples: [],
    });

    expect(rule?.config).toEqual({ picklistValues: ['1', '2'] });
  });

  /* ----------------------------------------------------------------- *
   * relative_date: which end of the window decides the direction.
   * ----------------------------------------------------------------- */

  it('reads the far end of a relative_date window first', () => {
    // A window that starts in the past and ends in the future is a future
    // date: `maxDaysFromNow` decides, not the bound that happens to be first.
    const rule = personaPatternToFieldRule({
      fieldType: 'date',
      generator: 'relative_date',
      params: { maxDaysFromNow: 10, minDaysFromNow: -5 },
      examples: [],
    });

    expect(rule?.config).toEqual({ fakerMethod: 'futureDate' });
  });

  it('falls back to the near end when the window has no far end', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'date',
      generator: 'relative_date',
      params: { minDaysFromNow: -30 },
      examples: [],
    });

    expect(rule?.config).toEqual({ fakerMethod: 'pastDate' });
  });

  it('treats a window ending today as a future date', () => {
    const rule = personaPatternToFieldRule({
      fieldType: 'date',
      generator: 'relative_date',
      params: { maxDaysFromNow: 0 },
      examples: [],
    });

    expect(rule?.config).toEqual({ fakerMethod: 'futureDate' });
  });
});
