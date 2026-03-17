import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ReviewMetadataTab } from './ReviewMetadataTab';
import type { MetadataDiffEntry } from '../../stores/useForgeStore';

/* ---- Mocks ---- */

let mockDiffs: MetadataDiffEntry[] = [];

vi.mock('../../stores/useForgeStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        get metadataDiffs() {
          return mockDiffs;
        },
      }),
    {
      getState: () => ({
        metadataDiffs: mockDiffs,
      }),
    },
  );
  return { useForgeStore: store };
});

/* ---- Tests ---- */

describe('ReviewMetadataTab', () => {
  it('should render with data-testid', () => {
    mockDiffs = [];
    render(<ReviewMetadataTab />);
    expect(screen.getByTestId('review-metadata-tab')).toBeDefined();
  });

  it('should show "no diffs" message when diffs list is empty', () => {
    mockDiffs = [];
    render(<ReviewMetadataTab />);
    expect(screen.getByTestId('no-diffs')).toBeDefined();
  });

  it('should render diff entries with severity badges when diffs exist', () => {
    mockDiffs = [
      {
        objectApiName: 'Account',
        fieldApiName: 'CustomField__c',
        issue: 'missing',
        severity: 'error',
        details: 'Field does not exist in target org',
      },
      {
        objectApiName: 'Contact',
        fieldApiName: 'Phone',
        issue: 'type_mismatch',
        severity: 'warning',
        details: 'Field type differs: Text vs Number',
      },
      {
        objectApiName: 'Lead',
        fieldApiName: 'Status',
        issue: 'permission_denied',
        severity: 'info',
        details: 'Field is not createable in target',
      },
    ];
    render(<ReviewMetadataTab />);
    expect(screen.queryByTestId('no-diffs')).toBeNull();
    expect(screen.getByTestId('diff-0')).toBeDefined();
    expect(screen.getByTestId('diff-1')).toBeDefined();
    expect(screen.getByTestId('diff-2')).toBeDefined();
  });

  it('should display object and field names in diff entries', () => {
    mockDiffs = [
      {
        objectApiName: 'Account',
        fieldApiName: 'CustomField__c',
        issue: 'missing',
        severity: 'error',
        details: 'Field does not exist in target org',
      },
    ];
    render(<ReviewMetadataTab />);
    const diff0 = screen.getByTestId('diff-0');
    expect(diff0.textContent).toContain('Account.CustomField__c');
  });

  it('should display severity badge text in uppercase', () => {
    mockDiffs = [
      {
        objectApiName: 'Account',
        fieldApiName: 'Name',
        issue: 'missing',
        severity: 'warning',
        details: 'Missing field',
      },
    ];
    render(<ReviewMetadataTab />);
    const diff0 = screen.getByTestId('diff-0');
    expect(diff0.textContent).toContain('WARNING');
  });

  it('should display diff count in summary text', () => {
    mockDiffs = [
      {
        objectApiName: 'Account',
        fieldApiName: 'A',
        issue: 'missing',
        severity: 'error',
        details: 'x',
      },
      {
        objectApiName: 'Contact',
        fieldApiName: 'B',
        issue: 'type_mismatch',
        severity: 'warning',
        details: 'y',
      },
    ];
    render(<ReviewMetadataTab />);
    const tab = screen.getByTestId('review-metadata-tab');
    expect(tab.textContent).toContain('2');
  });
});
