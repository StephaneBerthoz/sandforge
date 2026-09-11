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
  });
});
