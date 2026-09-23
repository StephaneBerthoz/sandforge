import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import i18n from '../../i18n';
import type { PiiInventoryObjectResult, PiiInventoryResult } from '@sandforge/shared';
import { CompliancePanel, holdsLabel, searchableObjects } from './CompliancePanel';

interface MutationState {
  mutate: ReturnType<typeof vi.fn>;
  data: unknown;
  loading: boolean;
  error: string | null;
  reset: ReturnType<typeof vi.fn>;
  requestId: string | null;
}

const idle = (): MutationState => ({
  mutate: vi.fn(),
  data: null,
  loading: false,
  error: null,
  reset: vi.fn(),
  requestId: null,
});

let inventory: MutationState;

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => (type === 'dataops:pii-inventory' ? inventory : idle()),
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) =>
    type === 'seed:describe-global'
      ? {
          data: {
            objects: [
              { apiName: 'Contact', label: 'Contact' },
              { apiName: 'Product2', label: 'Product' },
            ],
          },
          loading: false,
          error: null,
          refetch: vi.fn(),
        }
      : { data: { entries: [] }, loading: false, error: null, refetch: vi.fn() },
}));

vi.mock('../../hooks/useFileSave', () => ({
  useFileSave: () => ({ save: vi.fn(), saving: false }),
}));

const contact: PiiInventoryObjectResult = {
  status: 'scanned',
  objectApiName: 'Contact',
  label: 'Contact',
  sampled: 18,
  fields: [
    {
      fieldApiName: 'Email',
      label: 'Email',
      classification: 'PII',
      detectedBy: 'name',
      pattern: 'email',
      filled: 17,
      searchedFor: 'email',
    },
    {
      fieldApiName: 'Notes__c',
      label: 'Notes',
      classification: 'PII',
      detectedBy: 'content',
      pattern: 'email_content',
      filled: 12,
      matched: 3,
    },
    {
      fieldApiName: 'Fax',
      label: 'Fax',
      classification: 'PII',
      detectedBy: 'type',
      pattern: 'phone_type',
      filled: 0,
      searchedFor: 'phone',
    },
  ],
  nameField: { fieldApiName: 'Name', label: 'Full Name' },
};

const product: PiiInventoryObjectResult = {
  status: 'scanned',
  objectApiName: 'Product2',
  label: 'Product',
  sampled: 5,
  fields: [],
  nameField: null,
};

const answer = (objects: PiiInventoryObjectResult[]): PiiInventoryResult => ({
  orgId: 'org-1',
  scannedAt: '2026-09-23T10:00:00.000Z',
  sampleSize: 200,
  objects,
});

beforeEach(() => {
  inventory = idle();
});

describe('CompliancePanel', () => {
  it('reads the objects picked for personal data', () => {
    render(<CompliancePanel orgId="org-1" />);

    fireEvent.click(screen.getByTestId('compliance-object-option-Contact'));
    fireEvent.click(screen.getByTestId('inventory-run-btn'));

    expect(inventory.mutate).toHaveBeenCalledWith({ orgId: 'org-1', objects: ['Contact'] });
  });

  it('lists each field that holds personal data: what, found how, and what the sample says', () => {
    inventory.data = answer([contact, product]);

    render(<CompliancePanel orgId="org-1" />);

    const email = screen.getByTestId('inventory-field-Email');
    expect(email.textContent).toContain('an email address');
    expect(email.textContent).toContain('its name');
    expect(email.textContent).toContain('17 of 18 filled');
    const notes = screen.getByTestId('inventory-field-Notes__c');
    expect(notes.textContent).toContain('its values');
    expect(notes.textContent).toContain('3 of 18 values look like one');
    // Named by the detector, empty on every record sampled: said so.
    expect(screen.getByTestId('inventory-field-Fax').textContent).toContain('Empty in the sample');
    expect(screen.getByTestId('inventory-name-field').textContent).toBe(
      "A request looks for a person's name in Full Name.",
    );
    expect(screen.getByTestId('inventory-object-Product2').textContent).toContain(
      'No field of this object holds personal data',
    );
  });

  it('points a subject request at the objects the inventory found something to search in', () => {
    inventory.data = answer([contact, product]);

    render(<CompliancePanel orgId="org-1" />);

    expect(screen.getByTestId('dsr-objects').textContent).toBe('Looks in: Contact');
  });

  it('asks for an inventory before a request can search', () => {
    render(<CompliancePanel orgId="org-1" />);

    expect(screen.getByTestId('dsr-needs-inventory')).toBeDefined();
  });

  it('keeps an object the org refused, with what it said', () => {
    inventory.data = answer([
      {
        status: 'failed',
        objectApiName: 'Nope__c',
        message: 'INVALID_TYPE: sObject type is not supported.',
      },
    ]);

    render(<CompliancePanel orgId="org-1" />);

    expect(screen.getByTestId('inventory-object-Nope__c').textContent).toBe(
      'Could not read Nope__c: INVALID_TYPE: sObject type is not supported.',
    );
  });

  it('names what a pattern finds in the reader’s words, and the pattern itself when it knows none', () => {
    const t = i18n.getFixedT('en');
    expect(holdsLabel(t, 'mobile_phone')).toBe('a phone number');
    expect(holdsLabel(t, 'iban_content')).toBe('a card or bank account number');
    expect(holdsLabel(t, 'something_new')).toBe('something_new');
  });

  it('searches only objects with something to search in', () => {
    expect(searchableObjects([contact, product])).toEqual(['Contact']);
  });
});
