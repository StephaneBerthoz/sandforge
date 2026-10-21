import { describe, it, expect } from 'vitest';
import { objectLabelOf, objectLabelsOf } from './objectLabels';

describe('objectLabelOf', () => {
  it('names an object by the label the describe gave it', () => {
    const labels = objectLabelsOf([
      { apiName: 'Invoice__c', label: 'Invoice' },
      { apiName: 'Account', label: 'Compte' },
    ]);

    expect(objectLabelOf('Invoice__c', labels)).toBe('Invoice');
    expect(objectLabelOf('Account', labels)).toBe('Compte');
  });

  it('falls back to the API name where no describe named the object', () => {
    const labels = objectLabelsOf([{ apiName: 'Contact', label: '  ' }, { apiName: 'Case' }]);

    expect(objectLabelOf('Contact', labels)).toBe('Contact');
    expect(objectLabelOf('Case', labels)).toBe('Case');
    expect(objectLabelOf('Lead', labels)).toBe('Lead');
    expect(objectLabelOf('Lead')).toBe('Lead');
  });

  it('keeps the first label a describe gave an object, trimmed', () => {
    const labels = objectLabelsOf([
      { apiName: 'Account', label: ' Account ' },
      { apiName: 'Account', label: 'Other' },
    ]);

    expect(objectLabelOf('Account', labels)).toBe('Account');
    expect(labels.size).toBe(1);
  });
});
