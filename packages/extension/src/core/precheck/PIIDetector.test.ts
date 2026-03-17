import { describe, it, expect } from 'vitest';
import { PIIDetector } from './PIIDetector';
import type { FieldDescribe } from './PIIDetector';

function field(apiName: string, label: string, type: string = 'string', length?: number): FieldDescribe {
  return { apiName, label, type, length };
}

describe('PIIDetector', () => {
  describe('detectPII — name pattern detection', () => {
    it('should detect Email field by API name', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Contact', [
        field('Email', 'Email Address'),
      ]);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].fieldApiName).toBe('Email');
      expect(result.piiFields[0].classification).toBe('PII');
      expect(result.piiFields[0].detectionMethod).toBe('name_pattern');
    });

    it('should detect Phone and MobilePhone fields', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Contact', [
        field('Phone', 'Phone Number'),
        field('MobilePhone', 'Mobile Phone'),
      ]);

      expect(result.piiFields).toHaveLength(2);
      expect(result.piiFields.every((f) => f.classification === 'PII')).toBe(true);
    });

    it('should detect PersonEmail field', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Account', [
        field('PersonEmail', 'Person Email'),
      ]);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].classification).toBe('PII');
    });

    it('should detect street address fields (MailingStreet, BillingStreet)', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Contact', [
        field('MailingStreet', 'Mailing Street'),
        field('BillingStreet', 'Billing Street'),
      ]);

      expect(result.piiFields).toHaveLength(2);
      expect(result.piiFields.every((f) => f.classification === 'PII')).toBe(true);
    });

    it('should detect SSN and SocialSecurityNumber fields', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Contact', [
        field('SSN__c', 'SSN'),
        field('SocialSecurityNumber__c', 'Social Security Number'),
      ]);

      expect(result.piiFields).toHaveLength(2);
      expect(result.piiFields.every((f) => f.confidence >= 0.99)).toBe(true);
    });

    it('should detect Birthdate and DateOfBirth fields', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Contact', [
        field('Birthdate', 'Birthdate'),
        field('DateOfBirth__c', 'Date of Birth'),
      ]);

      expect(result.piiFields).toHaveLength(2);
      expect(result.piiFields.every((f) => f.classification === 'PII')).toBe(true);
    });

    it('should detect NationalId field', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Contact', [
        field('NationalId__c', 'National ID'),
      ]);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].classification).toBe('PII');
    });

    it('should detect CreditCardNumber field as PCI', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Payment__c', [
        field('CreditCardNumber__c', 'Credit Card Number'),
      ]);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].classification).toBe('PCI');
    });

    it('should detect IBAN and BankAccount fields as PCI', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Payment__c', [
        field('IBAN__c', 'IBAN'),
        field('BankAccount__c', 'Bank Account'),
      ]);

      expect(result.piiFields).toHaveLength(2);
      expect(result.piiFields.every((f) => f.classification === 'PCI')).toBe(true);
    });

    it('should detect medical/health fields as PHI', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Patient__c', [
        field('MedicalHistory__c', 'Medical History'),
        field('Diagnosis__c', 'Diagnosis Code'),
      ]);

      expect(result.piiFields).toHaveLength(2);
      expect(result.piiFields.every((f) => f.classification === 'PHI')).toBe(true);
    });
  });

  describe('detectPII — type analysis detection', () => {
    it('should detect field with email type', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Lead', [
        field('WorkEmail__c', 'Work Email', 'email'),
      ]);

      const pii = result.piiFields.find((f) => f.fieldApiName === 'WorkEmail__c');
      expect(pii).toBeDefined();
      expect(pii?.classification).toBe('PII');
    });

    it('should detect field with phone type', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Lead', [
        field('Fax', 'Fax Number', 'phone'),
      ]);

      const pii = result.piiFields.find((f) => f.fieldApiName === 'Fax');
      expect(pii).toBeDefined();
      expect(pii?.detectionMethod).toBe('type_analysis');
    });

    it('should not duplicate detection when name already matched', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Contact', [
        field('Email', 'Email', 'email'),
      ]);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].detectionMethod).toBe('name_pattern');
    });
  });

  describe('detectPII — content pattern detection', () => {
    it('should detect email addresses in sample data', () => {
      const detector = new PIIDetector();
      const fields = [field('CustomField__c', 'Custom Field')];
      const sampleData = [
        { CustomField__c: 'john@example.com' },
        { CustomField__c: 'jane@test.org' },
      ];

      const result = detector.detectPII('Account', fields, sampleData);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].classification).toBe('PII');
      expect(result.piiFields[0].detectionMethod).toBe('content_pattern');
    });

    it('should detect SSN patterns in sample data', () => {
      const detector = new PIIDetector();
      const fields = [field('TaxId__c', 'Tax ID')];
      const sampleData = [
        { TaxId__c: '123-45-6789' },
        { TaxId__c: '987-65-4321' },
      ];

      const result = detector.detectPII('Contact', fields, sampleData);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].classification).toBe('PII');
      expect(result.piiFields[0].pattern).toBe('ssn_content');
    });

    it('should detect credit card patterns in sample data', () => {
      const detector = new PIIDetector();
      const fields = [field('PaymentRef__c', 'Payment Reference')];
      const sampleData = [
        { PaymentRef__c: '4111-1111-1111-1111' },
      ];

      const result = detector.detectPII('Order', fields, sampleData);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].classification).toBe('PCI');
    });

    it('should detect IBAN patterns in sample data', () => {
      const detector = new PIIDetector();
      const fields = [field('BankRef__c', 'Bank Reference')];
      const sampleData = [
        { BankRef__c: 'DE89370400440532013000' },
      ];

      const result = detector.detectPII('Account', fields, sampleData);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].classification).toBe('PCI');
    });

    it('should skip content detection for already detected fields', () => {
      const detector = new PIIDetector();
      const fields = [field('Email', 'Email Address')];
      const sampleData = [
        { Email: 'test@example.com' },
      ];

      const result = detector.detectPII('Contact', fields, sampleData);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].detectionMethod).toBe('name_pattern');
    });

    it('should not flag fields with non-matching content', () => {
      const detector = new PIIDetector();
      const fields = [field('Description__c', 'Description')];
      const sampleData = [
        { Description__c: 'This is a regular description' },
        { Description__c: 'Nothing sensitive here' },
      ];

      const result = detector.detectPII('Account', fields, sampleData);

      expect(result.piiFields).toHaveLength(0);
    });

    it('should handle null and non-string sample values gracefully', () => {
      const detector = new PIIDetector();
      const fields = [field('Amount__c', 'Amount')];
      const sampleData = [
        { Amount__c: null },
        { Amount__c: 12345 },
        { Amount__c: undefined },
      ];

      const result = detector.detectPII('Order', fields, sampleData);

      expect(result.piiFields).toHaveLength(0);
    });
  });

  describe('detectPII — risk level computation', () => {
    it('should return risk level "none" when no PII fields detected', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Account', [
        field('Name', 'Account Name'),
        field('Industry', 'Industry'),
      ]);

      expect(result.riskLevel).toBe('none');
      expect(result.piiFields).toHaveLength(0);
    });

    it('should return risk level "low" for 1-2 PII fields', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Contact', [
        field('Email', 'Email'),
        field('Name', 'Name'),
      ]);

      expect(result.riskLevel).toBe('low');
    });

    it('should return risk level "medium" for 3-5 PII fields', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Contact', [
        field('Email', 'Email'),
        field('Phone', 'Phone'),
        field('Birthdate', 'Birthdate'),
      ]);

      expect(result.riskLevel).toBe('medium');
    });

    it('should return risk level "high" for 6-10 PII fields', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Contact', [
        field('Email', 'Email'),
        field('Phone', 'Phone'),
        field('MobilePhone', 'Mobile Phone'),
        field('Birthdate', 'Birthdate'),
        field('MailingStreet', 'Mailing Street'),
        field('SSN__c', 'SSN'),
      ]);

      expect(result.riskLevel).toBe('high');
    });

    it('should return risk level "critical" for > 10 PII fields', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Contact', [
        field('Email', 'Email'),
        field('Phone', 'Phone'),
        field('MobilePhone', 'Mobile'),
        field('Birthdate', 'Birthdate'),
        field('MailingStreet', 'Mailing Street'),
        field('BillingStreet', 'Billing Street'),
        field('SSN__c', 'SSN'),
        field('NationalId__c', 'National ID'),
        field('PersonEmail', 'Person Email'),
        field('CreditCardNumber__c', 'Credit Card'),
        field('IBAN__c', 'IBAN'),
      ]);

      expect(result.riskLevel).toBe('critical');
    });
  });

  describe('detectPII — result structure', () => {
    it('should include objectName and totalFields in result', () => {
      const detector = new PIIDetector();
      const fields = [
        field('Name', 'Name'),
        field('Email', 'Email'),
        field('Industry', 'Industry'),
      ];
      const result = detector.detectPII('Contact', fields);

      expect(result.objectName).toBe('Contact');
      expect(result.totalFields).toBe(3);
    });

    it('should handle empty fields array', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('EmptyObject', []);

      expect(result.totalFields).toBe(0);
      expect(result.piiFields).toHaveLength(0);
      expect(result.riskLevel).toBe('none');
    });

    it('should strip __c suffix for pattern matching on custom fields', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Custom__c', [
        field('SSN__c', 'Social Security Number'),
      ]);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].fieldApiName).toBe('SSN__c');
    });
  });

  describe('getPatterns', () => {
    it('should return content detection patterns', () => {
      const detector = new PIIDetector();
      const patterns = detector.getPatterns();

      expect(patterns['email_content']).toBeInstanceOf(RegExp);
      expect(patterns['phone_content']).toBeInstanceOf(RegExp);
      expect(patterns['ssn_content']).toBeInstanceOf(RegExp);
      expect(patterns['credit_card_content']).toBeInstanceOf(RegExp);
      expect(patterns['iban_content']).toBeInstanceOf(RegExp);
    });

    it('should return patterns that match expected content', () => {
      const detector = new PIIDetector();
      const patterns = detector.getPatterns();

      expect(patterns['email_content'].test('user@example.com')).toBe(true);
      expect(patterns['ssn_content'].test('123-45-6789')).toBe(true);
      expect(patterns['credit_card_content'].test('4111 1111 1111 1111')).toBe(true);
      expect(patterns['iban_content'].test('DE89370400440532013000')).toBe(true);
    });
  });

  describe('detectPII — label-based detection', () => {
    it('should detect PII by field label when API name does not match', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Custom__c', [
        field('CustField1__c', 'Email Address'),
      ]);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].classification).toBe('PII');
    });
  });

  describe('detectPII — confidence values', () => {
    it('should adjust content detection confidence based on match ratio', () => {
      const detector = new PIIDetector();
      const fields = [field('Data__c', 'Data')];
      const sampleData = [
        { Data__c: 'user@test.com' },
        { Data__c: 'not an email' },
        { Data__c: 'also not' },
        { Data__c: 'nope' },
      ];

      const result = detector.detectPII('Obj', fields, sampleData);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].confidence).toBeLessThan(0.9);
    });

    it('should give full confidence when all sample data matches', () => {
      const detector = new PIIDetector();
      const fields = [field('Data__c', 'Data')];
      const sampleData = [
        { Data__c: 'user@test.com' },
        { Data__c: 'admin@example.org' },
      ];

      const result = detector.detectPII('Obj', fields, sampleData);

      expect(result.piiFields).toHaveLength(1);
      expect(result.piiFields[0].confidence).toBe(0.9);
    });
  });

  describe('detectPII — multiple classification types', () => {
    it('should correctly mix PII, PHI, and PCI classifications', () => {
      const detector = new PIIDetector();
      const result = detector.detectPII('Sensitive__c', [
        field('Email', 'Email'),
        field('CreditCardNumber__c', 'Credit Card'),
        field('MedicalHistory__c', 'Medical History'),
      ]);

      expect(result.piiFields).toHaveLength(3);

      const classifications = new Set(result.piiFields.map((f) => f.classification));
      expect(classifications.has('PII')).toBe(true);
      expect(classifications.has('PCI')).toBe(true);
      expect(classifications.has('PHI')).toBe(true);
    });
  });
});
