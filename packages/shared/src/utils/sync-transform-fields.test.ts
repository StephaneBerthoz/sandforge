import { describe, expect, it } from 'vitest';
import {
  fieldlessTransformRefusal,
  fieldlessTransformRules,
  transformRuleNamesField,
  unreadablePatternRefusal,
  unreadablePatternRules,
} from './sync-transform-fields.js';

describe('transform rules that name no field', () => {
  it('finds the object-level rules without a field, once per object and rule', () => {
    expect(
      fieldlessTransformRules([
        {
          objectApiName: 'Account',
          transformRules: [
            { type: 'uppercase' },
            { type: 'trim', field: 'Name' },
            { type: 'uppercase' },
            { type: 'prefix', field: '  ' },
          ],
        },
        { objectApiName: 'Contact', transformRules: [{ type: 'uppercase' }] },
        { objectApiName: 'Case', transformRules: [{ type: 'map_value', field: 'Status' }] },
        { objectApiName: 'Lead' },
      ]),
    ).toEqual([
      { objectApiName: 'Account', type: 'uppercase' },
      { objectApiName: 'Account', type: 'prefix' },
      { objectApiName: 'Contact', type: 'uppercase' },
    ]);
  });

  it('takes a rule as naming its field only when it names one', () => {
    expect(transformRuleNamesField({ field: 'Name' })).toBe(true);
    expect(transformRuleNamesField({})).toBe(false);
    expect(transformRuleNamesField({ field: '' })).toBe(false);
  });

  it('names the rule and its object, and says what to do', () => {
    expect(fieldlessTransformRefusal([{ objectApiName: 'Account', type: 'uppercase' }])).toBe(
      'The rule Uppercase on Account names no field: open the configuration and pick its ' +
        'field. Without one it would change every field of every record, record types and ' +
        'lookups among them.',
    );
  });

  it('names every rule when there are several', () => {
    expect(
      fieldlessTransformRefusal([
        { objectApiName: 'Account', type: 'regex_replace' },
        { objectApiName: 'Contact', type: 'trim' },
        { objectApiName: 'Case', type: 'map_value' },
      ]),
    ).toMatch(
      /^The rules Regex replace on Account, Trim on Contact and Map value on Case name no field: open the configuration and pick their fields\./,
    );
  });
});

describe('Regex replace rules whose pattern is no regular expression', () => {
  it("finds them among an object's rules and its field mappings' rules, with the field each changes", () => {
    expect(
      unreadablePatternRules([
        {
          objectApiName: 'Account',
          transformRules: [
            { type: 'regex_replace', field: 'Name', config: { regex: '[a-' } },
            { type: 'regex_replace', field: 'Phone', config: { regex: '\\s+' } },
            { type: 'replace', field: 'Site', config: {} },
            // No pattern changes nothing, and is not refused.
            { type: 'regex_replace', field: 'Site', config: { regex: '' } },
          ],
          fieldMappings: [
            {
              targetField: 'Description',
              transformRules: [{ type: 'regex_replace', config: { regex: '(' } }],
            },
          ],
        },
        { objectApiName: 'Contact' },
      ]),
    ).toEqual([
      {
        objectApiName: 'Account',
        field: 'Name',
        pattern: '[a-',
        reason: 'Unterminated character class',
      },
      {
        objectApiName: 'Account',
        field: 'Description',
        pattern: '(',
        reason: 'Unterminated group',
      },
    ]);
  });

  it('names the rule, its object and field, and the pattern, and says what to do', () => {
    expect(
      unreadablePatternRefusal([
        {
          objectApiName: 'Case',
          field: 'Subject',
          pattern: '[a-',
          reason: 'Unterminated character class',
        },
      ]),
    ).toBe(
      'The rule Regex replace on Case.Subject, "[a-" (Unterminated character class) has a ' +
        'pattern that is no regular expression: open the configuration and correct it, or ' +
        'remove the rule. Run, it would stop the run at that object before any of its records ' +
        'is written.',
    );
  });

  it('names every rule when there are several', () => {
    expect(
      unreadablePatternRefusal([
        { objectApiName: 'Case', field: 'Subject', pattern: '[a-', reason: 'r1' },
        { objectApiName: 'Lead', pattern: '(', reason: 'r2' },
      ]),
    ).toMatch(
      /^The rules Regex replace on Case\.Subject, "\[a-" \(r1\) and Regex replace on Lead, "\(" \(r2\) have patterns that are no regular expressions: /,
    );
  });
});
