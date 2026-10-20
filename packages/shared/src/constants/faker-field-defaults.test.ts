import { describe, it, expect } from 'vitest';
import {
  FAKER_METHOD_BY_FIELD_TYPE,
  FAKER_METHOD_BY_FIELD_NAME,
  defaultFakerMethod,
  describedFieldRule,
  integerDigitsOf,
} from './faker-field-defaults.js';
import { SUPPORTED_FAKER_METHODS } from './faker-methods.js';

const SUPPORTED = new Set<string>(SUPPORTED_FAKER_METHODS);

function described(
  fieldApiName: string,
  type: string,
  extra: Partial<Parameters<typeof describedFieldRule>[0]> = {},
): Parameters<typeof describedFieldRule>[0] {
  return { fieldApiName, type, picklistValues: [], referenceTo: [], length: 0, ...extra };
}

describe('faker field defaults', () => {
  it('names only methods the generator implements', () => {
    for (const method of Object.values(FAKER_METHOD_BY_FIELD_TYPE)) {
      expect(SUPPORTED.has(method)).toBe(true);
    }
    for (const { method } of FAKER_METHOD_BY_FIELD_NAME) {
      expect(SUPPORTED.has(method)).toBe(true);
    }
    expect(SUPPORTED.has(defaultFakerMethod('string', 'Description__c') ?? '')).toBe(true);
  });

  it('picks a method from the field type', () => {
    expect(defaultFakerMethod('email', 'Email')).toBe('email');
    expect(defaultFakerMethod('phone', 'Phone')).toBe('phone');
    expect(defaultFakerMethod('url', 'Website')).toBe('url');
    expect(defaultFakerMethod('date', 'Signed__c')).toBe('pastDate');
    expect(defaultFakerMethod('datetime', 'Closed__c')).toBe('pastDate');
    expect(defaultFakerMethod('currency', 'AnnualRevenue')).toBe('integer');
    expect(defaultFakerMethod('double', 'Score__c')).toBe('integer');
  });

  it('dates a birth decades back and a close in the weeks to come', () => {
    // Every date was drawn before 2024: each contact born a year or two ago,
    // each opportunity already past its close.
    expect(defaultFakerMethod('date', 'Birthdate')).toBe('birthdate');
    expect(defaultFakerMethod('date', 'Birth_Date__c')).toBe('birthdate');
    expect(defaultFakerMethod('date', 'CloseDate')).toBe('futureDate');
  });

  it('reads the field name of a text field', () => {
    expect(defaultFakerMethod('string', 'FirstName')).toBe('firstName');
    expect(defaultFakerMethod('string', 'LastName')).toBe('lastName');
    expect(defaultFakerMethod('string', 'Contact_Name__c')).toBe('name');
    expect(defaultFakerMethod('textarea', 'Description')).toBe('sentence');
  });

  it('reads the parts of an address from their names, standard or custom', () => {
    // Each of them got a lorem sentence.
    expect(defaultFakerMethod('textarea', 'BillingStreet', 'Account')).toBe('streetAddress');
    expect(defaultFakerMethod('textarea', 'Street', 'Lead')).toBe('streetAddress');
    expect(defaultFakerMethod('string', 'MailingCity', 'Contact')).toBe('city');
    expect(defaultFakerMethod('string', 'Office_City__c', 'Account')).toBe('city');
    expect(defaultFakerMethod('string', 'ShippingState', 'Account')).toBe('state');
    expect(defaultFakerMethod('string', 'BillingPostalCode', 'Account')).toBe('zipCode');
    expect(defaultFakerMethod('string', 'Zip_Code__c', 'Account')).toBe('zipCode');
    expect(defaultFakerMethod('string', 'OtherCountry', 'Contact')).toBe('country');
    // Ending in the letters is no address.
    expect(defaultFakerMethod('string', 'RealEstate__c', 'Account')).toBe('sentence');
  });

  it("gives a person's title a job title and a case's subject one a customer would write", () => {
    expect(defaultFakerMethod('string', 'Title', 'Contact')).toBe('jobTitle');
    expect(defaultFakerMethod('string', 'Title', 'Lead')).toBe('jobTitle');
    expect(defaultFakerMethod('string', 'Title', 'Knowledge__kav')).toBe('sentence');
    expect(defaultFakerMethod('string', 'Subject', 'Case')).toBe('caseSubject');
  });

  it("gives the name fields of an object that is not a person a company's name", () => {
    // An account named like a person reads as a contact wherever it is listed.
    expect(defaultFakerMethod('string', 'Name', 'Account')).toBe('company');
    expect(defaultFakerMethod('string', 'Name', 'Opportunity')).toBe('company');
    expect(defaultFakerMethod('string', 'Brand_Name__c', 'Account')).toBe('company');
    expect(defaultFakerMethod('string', 'Name', 'Project__c')).toBe('company');
  });

  it("keeps a person's name on contacts, leads, users and a person account's own fields", () => {
    expect(defaultFakerMethod('string', 'Preferred_Name__c', 'Contact')).toBe('name');
    expect(defaultFakerMethod('string', 'Maiden_Name__c', 'lead')).toBe('name');
    expect(defaultFakerMethod('string', 'Spouse_Name__pc', 'Account')).toBe('name');
    expect(defaultFakerMethod('string', 'PersonAssistantName', 'Account')).toBe('name');
  });

  it('reads whose name a field holds from its own name before its object', () => {
    expect(defaultFakerMethod('string', 'SuppliedName', 'Case')).toBe('name');
    expect(defaultFakerMethod('string', 'Contact_Name__c', 'Opportunity')).toBe('name');
    expect(defaultFakerMethod('string', 'Company', 'Lead')).toBe('company');
    expect(defaultFakerMethod('string', 'CompanyName', 'User')).toBe('company');
    expect(defaultFakerMethod('string', 'Account_Name__c', 'Contact')).toBe('company');
    // A middle name is a given name, on a contact and on a person account alike.
    expect(defaultFakerMethod('string', 'MiddleName', 'Contact')).toBe('firstName');
    expect(defaultFakerMethod('string', 'MiddleName', 'Account')).toBe('firstName');
  });

  it("gives a user's nickname one unique to it, which a person's name is not", () => {
    // A person's name came round every fifteen users, and the org refuses a
    // nickname another of its users holds.
    expect(defaultFakerMethod('string', 'CommunityNickname', 'User')).toBe('nickname');
  });

  it("gives a user's Username a username, which the org refuses a person's name for", () => {
    // `Username` ends in `name`, and on a user it took a person's name: the
    // org refuses a user whose username is not an email address in form.
    expect(defaultFakerMethod('string', 'Username', 'User')).toBe('username');
    expect(
      describedFieldRule(described('Username', 'string', { objectApiName: 'User', length: 80 })),
    ).toEqual({ ruleType: 'faker', config: { fakerMethod: 'username', maxLength: 80 } });
  });

  it("gives a name field of an object nobody named a company's name", () => {
    // The wizard asks for a default knowing the field alone when a field's
    // rule is switched back to faker.
    expect(defaultFakerMethod('string', 'Name')).toBe('company');
    expect(defaultFakerMethod('string', 'Brand_Name__c')).toBe('company');
    expect(defaultFakerMethod('string', 'Spouse_Name__pc')).toBe('name');
  });

  it('names no method for a type no generator fills sensibly', () => {
    expect(defaultFakerMethod('boolean', 'IsActive__c')).toBeUndefined();
    expect(defaultFakerMethod('id', 'Id')).toBeUndefined();
    expect(defaultFakerMethod('base64', 'Body')).toBeUndefined();
  });

  describe('describedFieldRule', () => {
    it('gives a text field a faker rule with a method and the field length', () => {
      expect(describedFieldRule(described('LastName', 'string', { length: 80 }))).toEqual({
        ruleType: 'faker',
        config: { fakerMethod: 'lastName', maxLength: 80 },
      });
    });

    it('leaves an optional text field its name says nothing of blank, and fills a required one', () => {
      // A site, an account number, a department and a year started each read
      // "lorem ipsum dolor sit amet", the year cut to "lore".
      for (const name of ['Site', 'AccountNumber', 'YearStarted', 'Description']) {
        expect(
          describedFieldRule(
            described(name, 'string', { objectApiName: 'Account', required: false }),
          ),
        ).toEqual({ ruleType: 'static', config: {} });
      }
      expect(
        describedFieldRule(described('Code__c', 'string', { length: 20, required: true })),
      ).toEqual({ ruleType: 'faker', config: { fakerMethod: 'sentence', maxLength: 20 } });
      // Its length stays with it, for the rule it is given in Configure.
      expect(
        describedFieldRule(described('Site', 'string', { length: 80, required: false })),
      ).toEqual({ ruleType: 'static', config: { maxLength: 80 } });
      // What its name says is still filled, required or not.
      expect(
        describedFieldRule(
          described('BillingCity', 'string', { objectApiName: 'Account', required: false }),
        ),
      ).toEqual({ ruleType: 'faker', config: { fakerMethod: 'city' } });
      expect(
        describedFieldRule(
          described('Name', 'string', { objectApiName: 'Account', required: true }),
        ),
      ).toEqual({ ruleType: 'faker', config: { fakerMethod: 'company' } });
      // A caller that does not say, the command line, is answered as before.
      expect(describedFieldRule(described('Site', 'string'))).toEqual({
        ruleType: 'faker',
        config: { fakerMethod: 'sentence' },
      });
    });

    it("names its method from the object the field belongs to, a company's name on an account", () => {
      const name = described('Nickname__c', 'string', { length: 40 });
      expect(describedFieldRule({ ...name, objectApiName: 'Account' })).toEqual({
        ruleType: 'faker',
        config: { fakerMethod: 'company', maxLength: 40 },
      });
      expect(describedFieldRule({ ...name, objectApiName: 'Contact' })).toEqual({
        ruleType: 'faker',
        config: { fakerMethod: 'name', maxLength: 40 },
      });
    });

    it('gives a picklist its values, and a lookup its target', () => {
      expect(
        describedFieldRule(described('Rating', 'picklist', { picklistValues: ['Hot', 'Cold'] })),
      ).toEqual({ ruleType: 'picklist_random', config: { picklistValues: ['Hot', 'Cold'] } });
      expect(
        describedFieldRule(described('AccountId', 'reference', { referenceTo: ['Account'] })),
      ).toEqual({
        ruleType: 'reference',
        config: { referenceObject: 'Account', referenceField: 'Id' },
      });
    });

    it('never builds a faker rule without a method', () => {
      expect(describedFieldRule(described('IsActive__c', 'boolean'))).toEqual({
        ruleType: 'static',
        config: { staticValue: false },
      });
      expect(describedFieldRule(described('Body', 'base64'))).toEqual({
        ruleType: 'static',
        config: {},
      });
      expect(describedFieldRule(described('Tier__c', 'picklist'))).toEqual({
        ruleType: 'static',
        config: {},
      });
    });

    it('leaves a coordinate blank, which a number drawn up to 1000 put out of range', () => {
      // Every account of a real sandbox was refused, its billing latitude out of
      // the field's valid range at 966.
      for (const name of ['BillingLatitude', 'ShippingLongitude', 'Site__Latitude__s']) {
        expect(describedFieldRule(described(name, 'double'))).toEqual({
          ruleType: 'static',
          config: {},
        });
      }
      expect(describedFieldRule(described('Score__c', 'double'))).toEqual({
        ruleType: 'faker',
        config: { fakerMethod: 'integer' },
      });
    });

    it('draws a whole number within the digits the field holds', () => {
      // A two-digit score refused every account a wizard run wrote, at 518.
      expect(describedFieldRule(described('Score__c', 'double', { integerDigits: 2 }))).toEqual({
        ruleType: 'faker',
        config: { fakerMethod: 'integer', maxValue: 99 },
      });
      expect(
        describedFieldRule(described('NumberOfEmployees', 'int', { integerDigits: 8 })),
      ).toEqual({ ruleType: 'faker', config: { fakerMethod: 'integer' } });
      expect(describedFieldRule(described('Amount', 'currency', { integerDigits: 16 }))).toEqual({
        ruleType: 'faker',
        config: { fakerMethod: 'integer' },
      });
    });

    it('draws a percentage up to 100, past which an opportunity is refused', () => {
      expect(describedFieldRule(described('Probability', 'percent', { integerDigits: 3 }))).toEqual(
        { ruleType: 'faker', config: { fakerMethod: 'integer', maxValue: 100 } },
      );
      expect(describedFieldRule(described('Discount__c', 'percent', { integerDigits: 2 }))).toEqual(
        { ruleType: 'faker', config: { fakerMethod: 'integer', maxValue: 99 } },
      );
    });
  });

  describe('integerDigitsOf', () => {
    it("reads an integer field's digits, and the precision less the scale of any other number", () => {
      expect(integerDigitsOf({ type: 'int', digits: 9 })).toBe(9);
      expect(integerDigitsOf({ type: 'double', precision: 4, scale: 2 })).toBe(2);
      expect(integerDigitsOf({ type: 'currency', precision: 18, scale: 2 })).toBe(16);
    });

    it('says nothing of a field that gives no digits', () => {
      expect(integerDigitsOf({ type: 'string' })).toBe(0);
      expect(integerDigitsOf({ type: 'int' })).toBe(0);
    });
  });
});
