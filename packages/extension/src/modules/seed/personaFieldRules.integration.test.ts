import { describe, it, expect, afterEach, vi } from 'vitest';
import { personaPatternToFieldRule } from '@sandforge/shared';
import type { FieldRule } from '@sandforge/shared';

import type { SeedTemplate } from '@sandforge/shared';

import { AIPersonaManager, type AIPersona } from '../ai/AIPersonaManager';
import { generateValue } from './FieldMapper';
import { FakerFallback } from './FakerFallback';
import { getLocaleData } from './LocaleData';
import { SeedValidator } from './SeedValidator';

/**
 * A persona defines what its data must look like; the seed run must produce
 * values that match that definition. These tests wire the two ends together —
 * built-in persona patterns through the translator, then through the readers
 * that actually build the records (FieldMapper, FakerFallback).
 */

const personas = new AIPersonaManager().getBuiltInPersonas();

function persona(id: string): AIPersona {
  const found = personas.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown built-in persona: ${id}`);
  return found;
}

/** Translate one persona field pattern into the field rule the seed run consumes. */
function ruleFor(personaId: string, fieldApiName: string): FieldRule {
  const pattern = persona(personaId).dataPatterns[fieldApiName];
  if (!pattern) throw new Error(`${personaId} has no pattern for ${fieldApiName}`);
  const translated = personaPatternToFieldRule(pattern);
  if (!translated) throw new Error(`${personaId}.${fieldApiName} translated to nothing`);
  return { fieldApiName, ruleType: translated.ruleType, config: translated.config };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('built-in persona → generated value', () => {
  it('keeps a range inside the bounds the persona declares', () => {
    /* "Assureur français" declares Premium__c between 200 and 5000. */
    const rule = ruleFor('assureur-fr', 'Premium__c');

    vi.spyOn(Math, 'random').mockReturnValue(0);
    const lowest = generateValue(rule, 0, new Map()) as number;

    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const highest = generateValue(rule, 0, new Map()) as number;

    expect(lowest).toBe(200);
    expect(highest).toBeGreaterThanOrEqual(4900);
    expect(highest).toBeLessThanOrEqual(5000);
  });

  it('picks from the list a random_pick persona field declares', () => {
    /* Contract_Type__c: Auto / Habitation / Santé / Vie / Responsabilité Civile. */
    const rule = ruleFor('assureur-fr', 'Contract_Type__c');
    const allowed = persona('assureur-fr').dataPatterns['Contract_Type__c'].params?.[
      'values'
    ] as string[];

    const drawn = Array.from({ length: 20 }, () => generateValue(rule, 0, new Map()));

    expect(drawn).not.toContain(null);
    for (const value of drawn) {
      expect(allowed).toContain(value);
    }
  });

  it('picks from the weighted list a weighted_pick persona field declares', () => {
    /* Plan__c: Free / Starter / Pro / Enterprise, each with a weight. */
    const rule = ruleFor('startup-saas', 'Plan__c');
    const weights = persona('startup-saas').dataPatterns['Plan__c'].params?.['values'] as Record<
      string,
      number
    >;

    const drawn = Array.from({ length: 20 }, () => generateValue(rule, 0, new Map()));

    expect(drawn).not.toContain(null);
    for (const value of drawn) {
      expect(Object.keys(weights)).toContain(value);
    }
  });

  it('applies the sequence prefix the persona declares', () => {
    /* MRN__c is prefixed "MRN-". */
    const rule = ruleFor('hospital-us', 'MRN__c');

    expect(generateValue(rule, 0, new Map())).toMatch(/^MRN-/);
  });

  it('keeps the regex pattern the persona declares', () => {
    /* SIRET__c carries a digit mask; the rule must carry it through. */
    const rule = ruleFor('assureur-fr', 'SIRET__c');

    expect(rule.config.regexPattern).toBe('###########00##');
  });

  it('uses the faker method and locale the persona declares', () => {
    /* Name is a French company name. */
    const rule = ruleFor('assureur-fr', 'Name');
    const [record] = new FakerFallback('en_US').generate([rule], 1);

    expect(getLocaleData('fr').companies).toContain(record['Name']);
  });

  it('produces a template the seed validator accepts', () => {
    /* SeedOrchestrator.execute validates before inserting anything: a picklist
       without values, a faker without a method or a regex without a pattern
       aborts the whole run. */
    const template: SeedTemplate = {
      id: 'template-1',
      name: 'assureur-fr',
      description: '',
      version: 1,
      strategy: 'ai',
      objects: [
        {
          objectApiName: 'Account',
          recordCount: 10,
          batchSize: 200,
          insertOrder: 0,
          excludedFields: [],
          fieldRules: Object.keys(persona('assureur-fr').dataPatterns).map((field) =>
            ruleFor('assureur-fr', field),
          ),
        },
      ],
      tags: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(new SeedValidator().validate(template).errors).toEqual([]);
  });

  it('generates a date for a relative_date persona field', () => {
    /* Delivery_Date__c is a date 1 to 14 days out, not prose. */
    const rule = ruleFor('logistique', 'Delivery_Date__c');
    const [record] = new FakerFallback('fr_FR').generate([rule], 1);

    expect(record['Delivery_Date__c']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
