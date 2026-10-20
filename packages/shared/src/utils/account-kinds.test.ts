import { describe, expect, it } from 'vitest';
import { accountKindRequiring, isPersonAccountField, leftOutForAccountKind } from './account-kinds';

describe('the fields each kind of account takes', () => {
  /** The fields an Account of an org with person accounts lets a write carry. */
  const FIELDS = [
    'Name',
    'Phone',
    'Region__c',
    'Region__pc',
    'FirstName',
    'LastName',
    'PersonEmail',
  ];

  it('takes a business account without any field only a person account holds', () => {
    expect(FIELDS.filter((f) => !leftOutForAccountKind('Account', f, 'business'))).toEqual([
      'Name',
      'Phone',
      'Region__c',
    ]);
  });

  it('takes a person account without the name the platform computes', () => {
    expect(FIELDS.filter((f) => !leftOutForAccountKind('Account', f, 'person'))).toEqual(
      FIELDS.filter((f) => f !== 'Name'),
    );
  });

  it('leaves the fields of any other object alone', () => {
    expect(FIELDS.filter((f) => !leftOutForAccountKind('Contact', f, 'business'))).toEqual(FIELDS);
  });

  it('tells the name parts, the Person fields and the __pc fields for a person account’s alone', () => {
    expect(isPersonAccountField('Salutation')).toBe(true);
    expect(isPersonAccountField('PersonMailingCity')).toBe(true);
    expect(isPersonAccountField('Hobby__pc')).toBe(true);
    expect(isPersonAccountField('Personal_Note__c')).toBe(false);
  });

  it("requires a business account's name and a person account's last name", () => {
    expect(accountKindRequiring('Account', 'Name')).toBe('business');
    expect(accountKindRequiring('Account', 'LastName')).toBe('person');
    expect(accountKindRequiring('Account', 'Phone')).toBeUndefined();
    expect(accountKindRequiring('Contact', 'LastName')).toBeUndefined();
  });
});
