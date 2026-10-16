import { describe, it, expect } from 'vitest';
import type { AutopilotAnonymizationRule, PIIFieldDetection } from '@sandforge/shared';
import { PIIDetector } from '../../core/precheck/PIIDetector';
import { ComplianceEngine } from './ComplianceEngine';
import { SmartAnonymizer } from './SmartAnonymizer';
import type { FieldDescribeResult, ObjectDescribeResult } from './SchemaScanner';
import { detectPersonalFields, personalDataNotCovered, withAiDetections } from './personalFields';

/** A field as a describe gives it. */
function field(name: string, type: string, extra: Partial<FieldDescribeResult> = {}) {
  return {
    name,
    label: name,
    type,
    nillable: true,
    createable: true,
    updateable: true,
    unique: false,
    externalId: false,
    referenceTo: [],
    relationshipName: null,
    defaultValue: null,
    ...extra,
  } satisfies FieldDescribeResult;
}

/** A contact as a describe gives it: names, contact points, stamps. */
const CONTACT: ObjectDescribeResult = {
  name: 'Contact',
  label: 'Contact',
  custom: false,
  keyPrefix: '003',
  recordTypeInfos: [],
  fields: [
    field('Id', 'id', { createable: false, updateable: false }),
    field('FirstName', 'string'),
    field('LastName', 'string'),
    field('Email', 'email'),
    field('Phone', 'phone'),
    field('MobilePhone', 'phone'),
    field('Title', 'string'),
    field('SMS_Number__c', 'string'),
    field('LastModifiedDate', 'datetime', { createable: false, updateable: false }),
    field('Name', 'string', { createable: false, updateable: false }),
  ],
};

/** The rules a framework gives the detector's findings, as the plan builds them. */
function rulesFor(framework: 'gdpr' | 'none'): AutopilotAnonymizationRule[] {
  const engine = new ComplianceEngine();
  const detected =
    framework === 'none'
      ? []
      : detectPersonalFields(new PIIDetector(), new Map([['Contact', CONTACT]]));
  return engine.generateRules(engine.buildProfile(framework, detected));
}

describe('detectPersonalFields', () => {
  it("names a contact's gender and a custom marital status, and a GDPR run empties them", () => {
    const contact: ObjectDescribeResult = {
      ...CONTACT,
      fields: [
        ...CONTACT.fields,
        field('GenderIdentity', 'picklist'),
        field('MaritalStatus__c', 'picklist'),
        field('Religion__c', 'picklist'),
      ],
    };
    const detected = detectPersonalFields(new PIIDetector(), new Map([['Contact', contact]]));
    const engine = new ComplianceEngine();
    const rules = engine.generateRules(engine.buildProfile('gdpr', detected));
    const records = [
      {
        Id: '003xx000001',
        GenderIdentity: 'Female',
        MaritalStatus__c: 'Married',
        Religion__c: 'None',
      },
    ];

    new SmartAnonymizer(undefined, 'gdpr-salt').anonymize(records, rules, 'Contact');

    expect(
      Object.fromEntries(
        detected
          .filter((d) => d.fieldType === 'picklist')
          .map((d) => [d.fieldApiName, d.piiCategory]),
      ),
    ).toEqual({ GenderIdentity: 'PII', MaritalStatus__c: 'PII', Religion__c: 'SENSITIVE' });
    // A made-up value would be refused by the picklist, and the contact with it.
    expect(records[0]).toEqual({
      Id: '003xx000001',
      GenderIdentity: null,
      MaritalStatus__c: null,
      Religion__c: null,
    });
  });

  it("names a contact's names, email and phones, and a text field named for a phone", () => {
    const detected = detectPersonalFields(new PIIDetector(), new Map([['Contact', CONTACT]]));

    expect(detected.map((d) => d.fieldApiName).sort()).toEqual([
      'Email',
      'FirstName',
      'LastName',
      'MobilePhone',
      'Phone',
      'SMS_Number__c',
    ]);
    expect(detected.every((d) => d.piiCategory === 'PII' && d.objectApiName === 'Contact')).toBe(
      true,
    );
  });

  it('leaves out what no insert sets: the composed name, the stamps', () => {
    const detected = detectPersonalFields(new PIIDetector(), new Map([['Contact', CONTACT]]));

    expect(detected.map((d) => d.fieldApiName)).not.toContain('Name');
    expect(detected.map((d) => d.fieldApiName)).not.toContain('LastModifiedDate');
  });
});

describe('the rules a framework gives them', () => {
  it('fakes the names, email and phones of a contact under GDPR', () => {
    // Run for real with --compliance gdpr, the plan counted no personal field
    // at all: the profile's detections came from an AI scan nobody ran.
    const rules = rulesFor('gdpr');

    expect(rules.map((r) => [r.fieldApiName, r.method]).sort()).toEqual([
      ['Email', 'fake'],
      ['FirstName', 'fake'],
      ['LastName', 'fake'],
      ['MobilePhone', 'fake'],
      ['Phone', 'fake'],
      ['SMS_Number__c', 'fake'],
    ]);
  });

  it('gives none under no framework', () => {
    expect(rulesFor('none')).toEqual([]);
  });
});

describe('withAiDetections', () => {
  const detection = (fieldApiName: string, method: PIIFieldDetection['detectionMethod']) =>
    ({
      objectApiName: 'Contact',
      fieldApiName,
      fieldLabel: fieldApiName,
      fieldType: 'string',
      piiCategory: 'PII',
      detectionMethod: method,
      confidence: 0.8,
      suggestedMethod: 'fake',
    }) satisfies PIIFieldDetection;

  it("keeps the detector's finding of a field the scan names too, and adds the scan's others", () => {
    expect(
      withAiDetections(
        [detection('Email', 'field_name')],
        [detection('Email', 'ai'), detection('Notes__c', 'ai')],
      ),
    ).toEqual([detection('Email', 'field_name'), detection('Notes__c', 'ai')]);
  });

  it('keeps every finding of the detector when the scan names none', () => {
    expect(withAiDetections([detection('Email', 'field_name')], [])).toEqual([
      detection('Email', 'field_name'),
    ]);
  });
});

describe('personalDataNotCovered', () => {
  const rule = (objectApiName: string, fieldApiName: string): AutopilotAnonymizationRule => ({
    objectApiName,
    fieldApiName,
    method: 'fake',
    piiCategory: 'PII',
    aiConfidence: 0.9,
    userOverridden: false,
  });

  it('names what a framework expects of a contact or a lead and finds no rule for', () => {
    expect(
      personalDataNotCovered(
        'gdpr',
        ['Lead', 'Contact', 'Account'],
        [rule('Contact', 'FirstName'), rule('Contact', 'Email'), rule('Contact', 'MobilePhone')],
      ),
    ).toEqual([{ objectApiName: 'Lead', missing: ['name', 'email', 'phone'] }]);
  });

  it('says nothing under no framework', () => {
    expect(personalDataNotCovered('none', ['Contact', 'Lead'], [])).toEqual([]);
  });

  it("says nothing of a contact the detector's rules cover", () => {
    expect(personalDataNotCovered('gdpr', ['Contact'], rulesFor('gdpr'))).toEqual([]);
  });
});
