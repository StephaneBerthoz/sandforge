import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '../../i18n';
import type { DataQualityFieldFill, DataQualityUnmeasuredField } from '@sandforge/shared';
import { FieldFill, isMostlyEmpty, isRequiredButEmpty } from './FieldFill';

/** The fields of a Contact of 18 records: one nobody fills. */
const FIELDS: DataQualityFieldFill[] = [
  { fieldApiName: 'Fax', label: 'Fax', filled: 0, required: false },
  { fieldApiName: 'Salutation', label: 'Salutation', filled: 7, required: false },
  { fieldApiName: 'Phone', label: 'Phone', filled: 13, required: false },
  { fieldApiName: 'Email', label: 'Email', filled: 17, required: false },
  { fieldApiName: 'LastName', label: 'Last Name', filled: 18, required: true },
];

const renderFill = (
  fields: DataQualityFieldFill[] = FIELDS,
  unmeasured: DataQualityUnmeasuredField[] = [],
  totalRecords = 18,
) =>
  render(
    <FieldFill
      fields={fields}
      unmeasured={unmeasured}
      totalRecords={totalRecords}
      singleFieldQueries={20}
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

describe('FieldFill', () => {
  it('says how many of the fields counted most records leave empty', () => {
    renderFill();
    expect(screen.getByTestId('quality-summary-empty').textContent).toBe('2 of 5 counted');
  });

  it('lists the fields filled on fewer than half of the records, and flags the ones never filled', () => {
    renderFill();

    const table = screen.getByTestId('quality-mostly-empty-table');
    expect(within(table).getByTestId('quality-field-Fax').textContent).toContain('Always empty');
    expect(within(table).getByTestId('quality-field-Salutation').textContent).toContain('38.9%');
    expect(within(table).queryByTestId('quality-field-Phone')).toBeNull();
  });

  it('shows the required fields some records leave empty, with how many records fill them', () => {
    renderFill([{ fieldApiName: 'LastName', label: 'Last Name', filled: 16, required: true }]);

    const table = screen.getByTestId('quality-required-empty-table');
    expect(within(table).getByTestId('quality-field-LastName').textContent).toContain('16');
  });

  it('leaves the required section out when every required field is filled', () => {
    renderFill();
    expect(screen.queryByTestId('quality-required-empty')).toBeNull();
  });

  it('lists every field counted, folded', () => {
    renderFill();
    expect(screen.getByTestId('quality-all-fields').textContent).toContain('Last Name');
  });

  it('names the fields it could not count, with the reason for each group', () => {
    renderFill(FIELDS, [
      { fieldApiName: 'Description', label: 'Description', reason: 'not-countable' },
      { fieldApiName: 'Brand__c', label: 'Brand', reason: 'query-budget' },
    ]);

    expect(screen.getByText('Not counted (2)')).toBeDefined();
    expect(screen.getByTestId('quality-unmeasured-not-countable').textContent).toContain(
      'Description',
    );
    expect(screen.getByTestId('quality-unmeasured-query-budget').textContent).toContain(
      'at most 20 of those per object',
    );
  });

  it('calls no field empty on an object without records', () => {
    renderFill([], [], 0);

    expect(screen.queryByTestId('quality-mostly-empty')).toBeNull();
    expect(screen.queryByTestId('quality-all-fields')).toBeNull();
  });
});
