import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import type {
  DataQualityObjectResult,
  DataQualityObjectScan,
  DataQualityScanBounds,
} from '@sandforge/shared';
import { QualityObjectResult, isMostlyEmpty, isRequiredButEmpty } from './QualityObjectResult';

const BOUNDS: DataQualityScanBounds = {
  duplicateGroupLimit: 2000,
  duplicateSample: 20,
  singleFieldQueries: 20,
};

/** A Contact of 18 records: one field nobody fills, one repeated email. */
function contact(overrides: Partial<DataQualityObjectScan> = {}): DataQualityObjectScan {
  return {
    status: 'scanned',
    objectApiName: 'Contact',
    label: 'Contact',
    totalRecords: 18,
    fields: [
      { fieldApiName: 'Fax', label: 'Fax', filled: 0, required: false },
      { fieldApiName: 'Salutation', label: 'Salutation', filled: 7, required: false },
      { fieldApiName: 'Phone', label: 'Phone', filled: 13, required: false },
      { fieldApiName: 'Email', label: 'Email', filled: 17, required: false },
      { fieldApiName: 'LastName', label: 'Last Name', filled: 18, required: true },
    ],
    unmeasured: [],
    duplicates: {
      keyField: 'Email',
      keyLabel: 'Email',
      groups: [{ value: 'shared@example.com', count: 2 }],
      groupCount: 1,
      recordCount: 2,
      truncated: false,
    },
    stale: { days: 365, records: 3 },
    keyFields: [
      { fieldApiName: 'Email', label: 'Email' },
      { fieldApiName: 'Phone', label: 'Phone' },
    ],
    errors: [],
    ...overrides,
  };
}

const renderResult = (
  result: DataQualityObjectResult = contact(),
  props: Partial<React.ComponentProps<typeof QualityObjectResult>> = {},
) =>
  render(
    <QualityObjectResult
      result={result}
      bounds={BOUNDS}
      staleDays={365}
      onKeyChange={vi.fn()}
      busy={false}
      {...props}
    />,
  );

describe('isMostlyEmpty', () => {
  it('calls a field mostly empty when fewer than half of the records fill it', () => {
    const field = { fieldApiName: 'F', label: 'F', filled: 8, required: false };
    expect(isMostlyEmpty(field, 17)).toBe(true);
    expect(isMostlyEmpty(field, 16)).toBe(false);
  });

  it('calls no field of an object without records empty', () => {
    expect(isMostlyEmpty({ fieldApiName: 'F', label: 'F', filled: 0, required: false }, 0)).toBe(
      false,
    );
  });
});

describe('isRequiredButEmpty', () => {
  it('flags a required field only when some record leaves it empty', () => {
    const required = { fieldApiName: 'R', label: 'R', filled: 17, required: true };
    expect(isRequiredButEmpty(required, 18)).toBe(true);
    expect(isRequiredButEmpty(required, 17)).toBe(false);
    expect(isRequiredButEmpty({ ...required, required: false }, 18)).toBe(false);
  });
});

describe('QualityObjectResult', () => {
  it('sums the object up: mostly empty fields, required gaps, repeated records, stale records', () => {
    renderResult();

    expect(screen.getByTestId('quality-total').textContent).toBe('18 records');
    expect(screen.getByTestId('quality-summary-empty').textContent).toBe('2 of 5 counted');
    expect(screen.getByTestId('quality-summary-required').textContent).toBe('0');
    expect(screen.getByTestId('quality-summary-duplicates').textContent).toBe('2 records');
    expect(screen.getByTestId('quality-summary-stale').textContent).toBe('3 (16.7%)');
  });

  it('lists the fields filled on fewer than half of the records, and flags the ones never filled', () => {
    renderResult();

    const table = screen.getByTestId('quality-mostly-empty-table');
    expect(within(table).getByTestId('quality-field-Fax').textContent).toContain('Always empty');
    expect(within(table).getByTestId('quality-field-Salutation').textContent).toContain('38.9%');
    expect(within(table).queryByTestId('quality-field-Phone')).toBeNull();
  });

  it('shows the required fields some records leave empty, with how many records fill them', () => {
    renderResult(
      contact({
        fields: [{ fieldApiName: 'LastName', label: 'Last Name', filled: 16, required: true }],
      }),
    );

    expect(screen.getByTestId('quality-summary-required').textContent).toBe('1');
    const table = screen.getByTestId('quality-required-empty-table');
    expect(within(table).getByTestId('quality-field-LastName').textContent).toContain('16');
  });

  it('leaves the required section out when every required field is filled', () => {
    renderResult();
    expect(screen.queryByTestId('quality-required-empty')).toBeNull();
  });

  it('lists the repeated values of the key, most repeated first', () => {
    renderResult();

    expect(screen.getByTestId('quality-duplicate-summary').textContent).toBe(
      '1 value of Email is carried by 2 records.',
    );
    const table = screen.getByTestId('quality-duplicate-table');
    expect(within(table).getByText('shared@example.com')).toBeDefined();
  });

  it('says the duplicate search stopped at its limit when it did', () => {
    renderResult(
      contact({
        duplicates: {
          keyField: 'Email',
          keyLabel: 'Email',
          groups: [{ value: 'a@example.com', count: 3 }],
          groupCount: 2000,
          recordCount: 4001,
          truncated: true,
        },
      }),
    );

    expect(screen.getByTestId('quality-duplicates-truncated').textContent).toContain('2,000');
    expect(screen.getByText('The 1 most repeated of 2,000 values.')).toBeDefined();
  });

  it('says so when no value of the key repeats', () => {
    renderResult(
      contact({
        duplicates: {
          keyField: 'Email',
          keyLabel: 'Email',
          groups: [],
          groupCount: 0,
          recordCount: 0,
          truncated: false,
        },
      }),
    );

    expect(screen.getByTestId('quality-no-duplicates').textContent).toBe(
      'No value of Email is carried by more than one record.',
    );
    expect(screen.queryByTestId('quality-duplicate-table')).toBeNull();
  });

  it('offers the fields the org can group by, and asks for another key when one is picked', () => {
    const onKeyChange = vi.fn();
    renderResult(contact(), { onKeyChange });

    const select = screen.getByLabelText('Find duplicates by') as HTMLSelectElement;
    expect(select.value).toBe('Email');
    fireEvent.change(select, { target: { value: 'Phone' } });

    expect(onKeyChange).toHaveBeenCalledWith('Phone');
  });

  it('holds the key still while a scan is in flight', () => {
    renderResult(contact(), { busy: true });
    expect((screen.getByLabelText('Find duplicates by') as HTMLSelectElement).disabled).toBe(true);
  });

  it('names the fields it could not count, with the reason for each group', () => {
    renderResult(
      contact({
        unmeasured: [
          { fieldApiName: 'Description', label: 'Description', reason: 'not-countable' },
          { fieldApiName: 'Brand__c', label: 'Brand', reason: 'query-budget' },
        ],
      }),
    );

    expect(screen.getByText('Not counted (2)')).toBeDefined();
    expect(screen.getByTestId('quality-unmeasured-not-countable').textContent).toContain(
      'Description',
    );
    expect(screen.getByTestId('quality-unmeasured-query-budget').textContent).toContain(
      'at most 20 of those per object',
    );
  });

  it('shows what the org said about a check it refused, next to the checks that stood', () => {
    renderResult(
      contact({
        duplicates: null,
        errors: [{ check: 'duplicates', message: 'QUERY_TIMEOUT: too long' }],
      }),
    );

    expect(screen.getByTestId('quality-errors').textContent).toBe(
      'Duplicates: QUERY_TIMEOUT: too long',
    );
    expect(screen.getByTestId('quality-summary-duplicates').textContent).toBe('Not measured');
    expect(screen.getByTestId('quality-mostly-empty-table')).toBeDefined();
  });

  it('says there is nothing to measure on an object without records', () => {
    renderResult(contact({ totalRecords: 0, fields: [], duplicates: null, stale: null }));

    expect(screen.getByTestId('quality-no-records')).toBeDefined();
    expect(screen.queryByTestId('quality-summary')).toBeNull();
  });

  it('shows why an object could not be scanned', () => {
    renderResult({ status: 'failed', objectApiName: 'Missing__c', message: 'INVALID_TYPE' });

    expect(screen.getByTestId('quality-object-failed').textContent).toBe(
      'Could not scan this object: INVALID_TYPE',
    );
  });
});
