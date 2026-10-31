import { describe, expect, it } from 'vitest';
import {
  fieldlessTransformRefusal,
  fieldlessTransformRules,
  transformRuleNamesField,
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
