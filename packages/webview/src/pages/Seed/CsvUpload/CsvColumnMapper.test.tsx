import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n/index';
import { CsvColumnMapper } from './CsvColumnMapper';
import type { CsvColumnMapping, SeedFieldInfo } from '@sandforge/shared';

const mockFields: SeedFieldInfo[] = [
  { apiName: 'Name', label: 'Account Name', type: 'string', required: true, defaultValue: null, unique: false, externalId: false, maxLength: 255 },
  { apiName: 'Email__c', label: 'Email', type: 'email', required: false, defaultValue: null, unique: false, externalId: false, maxLength: 255 },
  { apiName: 'Phone', label: 'Phone', type: 'phone', required: false, defaultValue: null, unique: false, externalId: false, maxLength: 40 },
];

const mockMappings: CsvColumnMapping[] = [
  { csvHeader: 'name', sfFieldApiName: 'Name', sfFieldType: 'string', sfFieldLength: 255 },
  { csvHeader: 'email', sfFieldApiName: '', sfFieldType: '', sfFieldLength: null },
  { csvHeader: 'phone', sfFieldApiName: 'Phone', sfFieldType: 'phone', sfFieldLength: 40 },
];

const mockHeaders = ['name', 'email', 'phone'];

describe('CsvColumnMapper', () => {
  const onMappingChange = vi.fn();

  it('should render all headers with Select dropdowns', () => {
    render(
      <CsvColumnMapper
        headers={mockHeaders}
        columnMappings={mockMappings}
        describeFields={mockFields}
        onMappingChange={onMappingChange}
      />,
    );
    expect(screen.getByTestId('csv-column-mapper')).toBeDefined();
    expect(screen.getByTestId('mapping-row-name')).toBeDefined();
    expect(screen.getByTestId('mapping-row-email')).toBeDefined();
    expect(screen.getByTestId('mapping-row-phone')).toBeDefined();
  });

  it('should pre-select auto-mapped fields in dropdowns', () => {
    render(
      <CsvColumnMapper
        headers={mockHeaders}
        columnMappings={mockMappings}
        describeFields={mockFields}
        onMappingChange={onMappingChange}
      />,
    );
    const nameSelect = screen.getByTestId('mapping-select-name') as HTMLSelectElement;
    expect(nameSelect.value).toBe('Name');
    const emailSelect = screen.getByTestId('mapping-select-email') as HTMLSelectElement;
    expect(emailSelect.value).toBe('');
  });

  it('should call onMappingChange when a selection changes', () => {
    render(
      <CsvColumnMapper
        headers={mockHeaders}
        columnMappings={mockMappings}
        describeFields={mockFields}
        onMappingChange={onMappingChange}
      />,
    );
    const emailSelect = screen.getByTestId('mapping-select-email');
    fireEvent.change(emailSelect, { target: { value: 'Email__c' } });
    expect(onMappingChange).toHaveBeenCalledWith('email', 'Email__c');
  });

  it('should show mapped count summary badge', () => {
    render(
      <CsvColumnMapper
        headers={mockHeaders}
        columnMappings={mockMappings}
        describeFields={mockFields}
        onMappingChange={onMappingChange}
      />,
    );
    // 2 of 3 are mapped (name and phone)
    expect(screen.getByText('2 of 3 columns mapped')).toBeDefined();
  });

  it('should show green check for mapped fields and warning for unmapped', () => {
    render(
      <CsvColumnMapper
        headers={mockHeaders}
        columnMappings={mockMappings}
        describeFields={mockFields}
        onMappingChange={onMappingChange}
      />,
    );
    // Name is mapped - should have check icon
    const nameStatus = screen.getByTestId('mapping-status-name');
    const nameIcon = nameStatus.querySelector('svg');
    expect(nameIcon?.getAttribute('aria-label')).toBe('Mapped');

    // Email is unmapped - should have warning icon
    const emailStatus = screen.getByTestId('mapping-status-email');
    const emailIcon = emailStatus.querySelector('svg');
    expect(emailIcon?.getAttribute('aria-label')).toBe('Unmapped');
  });
});
