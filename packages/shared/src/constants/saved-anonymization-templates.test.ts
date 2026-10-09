import { describe, it, expect } from 'vitest';
import {
  SAVED_TEMPLATE_METHODS,
  TEMPLATE_FIELD_PATTERN,
  isSavedTemplateMethod,
  savedRuleSettingProblem,
  savedTemplateRuleSchema,
} from './saved-anonymization-templates.js';

describe('SAVED_TEMPLATE_METHODS', () => {
  it('offers every method a run applies, Constant and Truncate among them now a rule carries their setting', () => {
    expect([...SAVED_TEMPLATE_METHODS]).toEqual([
      'fake',
      'mask',
      'hash',
      'nullify',
      'shuffle',
      'preserve_format',
      'constant',
      'truncate',
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

describe('savedRuleSettingProblem', () => {
  it('asks a Constant for the value it writes', () => {
    expect(savedRuleSettingProblem('constant', undefined)).toBe('constantValueMissing');
    expect(savedRuleSettingProblem('constant', { constantValue: '   ' })).toBe(
      'constantValueMissing',
    );
    expect(savedRuleSettingProblem('constant', { constantValue: 'x'.repeat(256) })).toBe(
      'constantValueMissing',
    );
    expect(savedRuleSettingProblem('constant', { constantValue: 'https://example.com' })).toBe(
      undefined,
    );
  });

  it('lets a Mask keep a whole number of characters at the end, from 0 to 255, or none', () => {
    // The GDPR template's phone keeps its last four: saved without it, the
    // mask ran to the end of the value.
    expect(savedRuleSettingProblem('mask', undefined)).toBe(undefined);
    expect(savedRuleSettingProblem('mask', { maskKeepLast: 4 })).toBe(undefined);
    expect(savedRuleSettingProblem('mask', { maskKeepLast: 0 })).toBe(undefined);
    expect(savedRuleSettingProblem('mask', { maskKeepLast: -1 })).toBe('maskKeepLastInvalid');
    expect(savedRuleSettingProblem('mask', { maskKeepLast: 1.5 })).toBe('maskKeepLastInvalid');
    expect(savedRuleSettingProblem('fake', { maskKeepLast: 4 })).toBe('settingNotTaken');
  });

  it('asks a Truncate for a whole length from 1 to 255, and lets it say which end it keeps', () => {
    expect(savedRuleSettingProblem('truncate', undefined)).toBe('truncateLengthMissing');
    expect(savedRuleSettingProblem('truncate', { truncateLength: 0 })).toBe(
      'truncateLengthMissing',
    );
    expect(savedRuleSettingProblem('truncate', { truncateLength: 2.5 })).toBe(
      'truncateLengthMissing',
    );
    expect(savedRuleSettingProblem('truncate', { truncateLength: 256 })).toBe(
      'truncateLengthMissing',
    );
    expect(savedRuleSettingProblem('truncate', { truncateLength: 3, truncateKeep: 'first' })).toBe(
      undefined,
    );
    expect(savedRuleSettingProblem('truncate', { truncateLength: 4 })).toBe(undefined);
  });

  it('refuses a setting another method reads, and asks nothing of a method that needs none', () => {
    expect(savedRuleSettingProblem('fake', { constantValue: 'left over' })).toBe('settingNotTaken');
    expect(savedRuleSettingProblem('constant', { constantValue: 'x', truncateLength: 3 })).toBe(
      'settingNotTaken',
    );
    expect(savedRuleSettingProblem('hash', undefined)).toBe(undefined);
    expect(savedRuleSettingProblem('mask', {})).toBe(undefined);
  });
});

describe('savedTemplateRuleSchema', () => {
  it('keeps the settings of a rule that needs them', () => {
    const parsed = savedTemplateRuleSchema.safeParse({
      fieldPattern: 'Contact.MailingPostalCode',
      ruleType: 'truncate',
      config: { truncateLength: 3, truncateKeep: 'first' },
    });
    expect(parsed.success && parsed.data.config).toEqual({
      truncateLength: 3,
      truncateKeep: 'first',
    });
  });

  it.each([
    ['a Constant with no value', { ruleType: 'constant' }],
    ['a Truncate with no length', { ruleType: 'truncate', config: { truncateKeep: 'last' } }],
    ['a salt, which no template carries', { ruleType: 'hash', config: { hashSalt: 'secret' } }],
    ['a setting of another method', { ruleType: 'fake', config: { truncateLength: 3 } }],
  ])('refuses %s', (_what, rule) => {
    expect(
      savedTemplateRuleSchema.safeParse({ fieldPattern: 'Contact.Email', ...rule }).success,
    ).toBe(false);
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
