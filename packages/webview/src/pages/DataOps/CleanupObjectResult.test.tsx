import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { CleanupObjectResult as CleanupResult } from '@sandforge/shared';
import { CleanupObjectResult } from './CleanupObjectResult';

const contact: CleanupResult = {
  status: 'scanned',
  objectApiName: 'Contact',
  label: 'Contact',
  totalRecords: 100,
  stale: { days: 365, records: 30 },
  orphans: [
    {
      fieldApiName: 'AccountId',
      label: 'Account ID',
      referenceTo: 'Account',
      filled: 95,
      empty: 5,
    },
  ],
  duplicates: {
    keyField: 'Email',
    keyLabel: 'Email',
    groups: [{ value: 'shared@example.com', count: 3 }],
    groupCount: 1,
    recordCount: 3,
    truncated: false,
  },
  keyFields: [
    { fieldApiName: 'Email', label: 'Email' },
    { fieldApiName: 'Phone', label: 'Business Phone' },
  ],
  errors: [],
};

function result(over: Partial<CleanupResult> = {}, busy = false) {
  const handlers = { onKeyChange: vi.fn(), onExport: vi.fn(), onReview: vi.fn() };
  render(
    <CleanupObjectResult
      result={{ ...contact, ...over } as CleanupResult}
      staleDays={365}
      orphanThreshold={0.9}
      duplicateGroupLimit={2000}
      busy={busy}
      {...handlers}
    />,
  );
  return handlers;
}

describe('CleanupObjectResult', () => {
  it('names each recommendation with its count, and the rule behind the orphans', () => {
    result();

    expect(screen.getByTestId('cleanup-stale-count').textContent).toBe(
      '30 records not modified in the last 365 days.',
    );
    expect(screen.getByTestId('cleanup-orphans-AccountId').textContent).toContain(
      'Account ID → Account: filled on 95 of 100 records; 5 leave it empty.',
    );
    expect(screen.getByTestId('cleanup-orphans').textContent).toContain('at least 90%');
    expect(screen.getByTestId('cleanup-duplicate-copies').textContent).toBe(
      'Repeated values of Email: 1. Extra copies: 2.',
    );
  });

  it('exports and reviews the records of the recommendation clicked', () => {
    const { onExport, onReview } = result();

    fireEvent.click(screen.getByTestId('cleanup-stale-export'));
    expect(onExport).toHaveBeenCalledWith({ kind: 'stale', days: 365 });

    fireEvent.click(screen.getByTestId('cleanup-orphans-AccountId-delete'));
    expect(onReview).toHaveBeenCalledWith({ kind: 'orphans', fieldApiName: 'AccountId' });

    fireEvent.click(screen.getByTestId('cleanup-duplicates-delete'));
    expect(onReview).toHaveBeenLastCalledWith({ kind: 'duplicates', keyField: 'Email' });
  });

  it('names what each action acts on to a screen reader, the visible words first', () => {
    result();

    expect(screen.getByTestId('cleanup-stale-delete').getAttribute('aria-label')).toBe(
      'Delete… 30 records not modified in the last 365 days.',
    );
    expect(screen.getByTestId('cleanup-duplicates-export').getAttribute('aria-label')).toBe(
      'Export: the extra copies by Email',
    );
  });

  it('looks for copies by another field when one is picked', () => {
    const { onKeyChange } = result();

    fireEvent.change(screen.getByLabelText('Find duplicates by'), { target: { value: 'Phone' } });

    expect(onKeyChange).toHaveBeenCalledWith('Phone');
  });

  it('offers no action on a recommendation that names no record', () => {
    result({
      stale: { days: 365, records: 0 },
      orphans: [],
      duplicates: { ...contact.duplicates!, groups: [], groupCount: 0, recordCount: 0 },
    });

    expect(screen.queryByTestId('cleanup-stale-delete')).toBeNull();
    expect(screen.getByTestId('cleanup-no-orphans')).toBeDefined();
    expect(screen.getByTestId('cleanup-no-duplicates')).toBeDefined();
  });

  it('starts nothing while a request is in flight', () => {
    result({}, true);

    expect((screen.getByTestId('cleanup-stale-delete') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an object the org refused, with what it said', () => {
    render(
      <CleanupObjectResult
        result={{ status: 'failed', objectApiName: 'Nope__c', message: 'INVALID_TYPE' }}
        staleDays={365}
        orphanThreshold={0.9}
        duplicateGroupLimit={2000}
        busy={false}
        onKeyChange={vi.fn()}
        onExport={vi.fn()}
        onReview={vi.fn()}
      />,
    );

    expect(screen.getByTestId('cleanup-object-Nope__c').textContent).toContain(
      'Could not scan this object: INVALID_TYPE',
    );
  });
});
