import { describe, it, expect } from 'vitest';
import {
  SAVED_TEMPLATE_METHODS,
  TEMPLATE_FIELD_PATTERN,
  isSavedTemplateMethod,
} from './saved-anonymization-templates.js';

describe('SAVED_TEMPLATE_METHODS', () => {
  it('offers no method that needs a setting the page cannot give it', () => {
    for (const needsSetting of ['constant', 'truncate']) {
      expect(SAVED_TEMPLATE_METHODS).not.toContain(needsSetting);
      expect(isSavedTemplateMethod(needsSetting)).toBe(false);
    }
  });

  it('offers the methods that run with no setting, hash among them since the run keys it', () => {
    expect([...SAVED_TEMPLATE_METHODS]).toEqual([
      'fake',
      'mask',
      'hash',
      'nullify',
      'shuffle',
      'preserve_format',
    ]);
    for (const method of SAVED_TEMPLATE_METHODS) {
      expect(isSavedTemplateMethod(method)).toBe(true);
    }
  });

  it('refuses a method it does not know', () => {
    expect(isSavedTemplateMethod('encrypt')).toBe(false);
    expect(isSavedTemplateMethod('')).toBe(false);
  });
});

describe('TEMPLATE_FIELD_PATTERN', () => {
  it.each(['Contact.Email', 'Account.Phone', 'Custom__c.Secret_Field__c', 'ns__Obj__c.ns__F__c'])(
    'accepts %s',
    (field) => {
      expect(TEMPLATE_FIELD_PATTERN.test(field)).toBe(true);
    },
  );

  it.each([
    'Email',
    'Contact.',
    '.Email',
    'Contact.Email.Extra',
    'Contact Email',
    '1Contact.Email',
  ])('refuses %s', (field) => {
    expect(TEMPLATE_FIELD_PATTERN.test(field)).toBe(false);
  });
});
