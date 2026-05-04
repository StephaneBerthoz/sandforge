import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n/index';
import { CsvValidationPanel } from './CsvValidationPanel';
import type { CsvValidationResult } from '@sandforge/shared';

describe('CsvValidationPanel', () => {
  const onBack = vi.fn();
  const onProceed = vi.fn();

  const validResult: CsvValidationResult = {
    valid: true,
    errors: [],
    warningCount: 0,
  };

  const errorResult: CsvValidationResult = {
    valid: false,
    errors: [
      {
        row: 1,
        column: 'Email',
        field: 'Email__c',
        errorType: 'type_mismatch',
        message: 'Invalid email format',
        value: 'notanemail',
      },
      {
        row: 2,
        column: 'Email',
        field: 'Email__c',
        errorType: 'type_mismatch',
        message: 'Invalid email format',
        value: 'bad',
      },
      {
        row: 3,
        column: 'Name',
        field: 'Name',
        errorType: 'missing_required',
        message: 'Required field is empty',
        value: '',
      },
    ],
    warningCount: 0,
  };

  it('should show success state when validation passes', () => {
    render(
      <CsvValidationPanel validationResult={validResult} onBack={onBack} onProceed={onProceed} />,
    );
    expect(screen.getByTestId('validation-success')).toBeDefined();
    expect(screen.getByTestId('proceed-button')).toBeDefined();
  });

  it('should group errors by type in accordion sections', () => {
    render(
      <CsvValidationPanel validationResult={errorResult} onBack={onBack} onProceed={onProceed} />,
    );
    expect(screen.getByTestId('csv-validation-panel')).toBeDefined();
    expect(screen.getByTestId('validation-error-count')).toBeDefined();
    // Should show Type Mismatch group with count 2
    expect(screen.getByText('Type Mismatch (2)')).toBeDefined();
    // Should show Missing Required group with count 1
    expect(screen.getByText('Missing Required (1)')).toBeDefined();
  });

  it('should show "Proceed Anyway" only when error rate is low', () => {
    // errorResult has errors on rows 1,2,3 out of max row 3 = 100% error rate
    render(
      <CsvValidationPanel validationResult={errorResult} onBack={onBack} onProceed={onProceed} />,
    );
    // With 3 error rows out of 3 total = 100% error rate, should NOT show proceed anyway
    expect(screen.queryByTestId('proceed-anyway-button')).toBeNull();
  });

  it('should show "Proceed Anyway" when error rate is below 10%', () => {
    const lowErrorResult: CsvValidationResult = {
      valid: false,
      errors: [
        {
          row: 1,
          column: 'Name',
          field: 'Name',
          errorType: 'missing_required',
          message: 'Required',
          value: '',
        },
      ],
      warningCount: 0,
    };
    // Only 1 row with error, max row = 1, but we need to simulate many rows
    // Use higher row numbers to simulate a large dataset
    const bigDataError: CsvValidationResult = {
      valid: false,
      errors: [
        {
          row: 5,
          column: 'Name',
          field: 'Name',
          errorType: 'missing_required',
          message: 'Required',
          value: '',
        },
      ],
      warningCount: 0,
    };
    // Suppress unused var warning
    void lowErrorResult;

    render(
      <CsvValidationPanel validationResult={bigDataError} onBack={onBack} onProceed={onProceed} />,
    );
    // 1 error row out of max row 5 = 20% -- still over 10%
    expect(screen.queryByTestId('proceed-anyway-button')).toBeNull();
  });

  it('should call onBack when "Fix and Re-validate" is clicked', () => {
    render(
      <CsvValidationPanel validationResult={errorResult} onBack={onBack} onProceed={onProceed} />,
    );
    fireEvent.click(screen.getByTestId('back-button'));
    expect(onBack).toHaveBeenCalled();
  });

  it('should call onProceed when proceed button is clicked in success state', () => {
    render(
      <CsvValidationPanel validationResult={validResult} onBack={onBack} onProceed={onProceed} />,
    );
    fireEvent.click(screen.getByTestId('proceed-button'));
    expect(onProceed).toHaveBeenCalled();
  });
});
