import { describe, it, expect } from 'vitest';
import {
  FAKER_METHOD_ALIASES,
  SUPPORTED_FAKER_METHODS,
  resolveFakerMethod,
} from './faker-methods.js';
import { PREBUILT_SEED_TEMPLATES } from './seed-templates.js';

describe('resolveFakerMethod', () => {
  it('returns a method the generator implements unchanged', () => {
    expect(resolveFakerMethod('iban')).toBe('iban');
  });

  it('maps a faker.js spelling to the method that generates it', () => {
    expect(resolveFakerMethod('finance.iban')).toBe('iban');
    expect(resolveFakerMethod('date.soon')).toBe('futureDate');
  });

  it('returns undefined for a method nothing generates', () => {
    expect(resolveFakerMethod('animal.petName')).toBeUndefined();
    expect(resolveFakerMethod('')).toBeUndefined();
  });

  it('does not resolve names inherited from Object.prototype', () => {
    expect(resolveFakerMethod('constructor')).toBeUndefined();
    expect(resolveFakerMethod('toString')).toBeUndefined();
  });

  it('maps every alias to a supported method', () => {
    for (const target of Object.values(FAKER_METHOD_ALIASES)) {
      expect(SUPPORTED_FAKER_METHODS).toContain(target);
    }
  });

  it('resolves every faker method the prebuilt templates name', () => {
    for (const template of PREBUILT_SEED_TEMPLATES) {
      for (const object of template.objects) {
        for (const rule of object.fieldRules) {
          if (rule.ruleType !== 'faker') continue;
          const method = rule.config.fakerMethod ?? '';
          expect(resolveFakerMethod(method), `${template.id} ${method}`).toBeDefined();
        }
      }
    }
  });
});
