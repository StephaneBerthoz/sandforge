import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useCallback, useState } from 'react';
import '../../../i18n/index';
import { CsvColumnMapper } from './CsvColumnMapper';
import type { CsvColumnMapping, SeedFieldInfo } from '@sandforge/shared';

/** How many times a component of the mapper asked for its words: once a draw. */
const draws = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: (...args: Parameters<typeof actual.useTranslation>) => {
      draws.count += 1;
      return actual.useTranslation(...args);
    },
  };
});

const mockFields: SeedFieldInfo[] = [
  {
    apiName: 'Name',
    label: 'Account Name',
    type: 'string',
    required: true,
    defaultValue: null,
    unique: false,
    externalId: false,
    maxLength: 255,
  },
  {
    apiName: 'Email__c',
    label: 'Email',
    type: 'email',
    required: false,
    defaultValue: null,
    unique: false,
    externalId: false,
    maxLength: 255,
  },
  {
    apiName: 'Phone',
    label: 'Phone',
    type: 'phone',
    required: false,
    defaultValue: null,
    unique: false,
    externalId: false,
    maxLength: 40,
  },
];

const mockMappings: CsvColumnMapping[] = [
  { csvHeader: 'name', sfFieldApiName: 'Name', sfFieldType: 'string', sfFieldLength: 255 },
  { csvHeader: 'email', sfFieldApiName: '', sfFieldType: '', sfFieldLength: null },
  { csvHeader: 'phone', sfFieldApiName: 'Phone', sfFieldType: 'phone', sfFieldLength: 40 },
];

const mockHeaders = ['name', 'email', 'phone'];

describe('CsvColumnMapper', () => {
  const onMappingChange = vi.fn();

  it('should render all headers with a field box each', () => {
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

  it('should fill in the auto-mapped fields, and name each box after its column', () => {
    render(
      <CsvColumnMapper
        headers={mockHeaders}
        columnMappings={mockMappings}
        describeFields={mockFields}
        onMappingChange={onMappingChange}
      />,
    );
    const nameBox = screen.getByTestId('mapping-select-name') as HTMLInputElement;
    expect(nameBox.value).toBe('Name');
    expect(screen.getByTestId('mapping-field-name').textContent).toBe('Account Name · string');
    const emailBox = screen.getByTestId('mapping-select-email') as HTMLInputElement;
    expect(emailBox.value).toBe('');
    expect(screen.getByRole('combobox', { name: 'Salesforce field for email' })).toBe(emailBox);
  });

  it('should call onMappingChange when a field is picked from the list', () => {
    onMappingChange.mockClear();
    render(
      <CsvColumnMapper
        headers={mockHeaders}
        columnMappings={mockMappings}
        describeFields={mockFields}
        onMappingChange={onMappingChange}
      />,
    );
    const emailBox = screen.getByTestId('mapping-select-email');
    fireEvent.change(emailBox, { target: { value: 'Email__c' } });
    expect(onMappingChange).toHaveBeenCalledWith('email', 'Email__c');
  });

  it('maps a field typed by its label, case aside, as the box is left', () => {
    onMappingChange.mockClear();
    render(
      <CsvColumnMapper
        headers={mockHeaders}
        columnMappings={mockMappings}
        describeFields={mockFields}
        onMappingChange={onMappingChange}
      />,
    );
    const emailBox = screen.getByTestId('mapping-select-email') as HTMLInputElement;
    fireEvent.change(emailBox, { target: { value: 'email' } });
    expect(onMappingChange).not.toHaveBeenCalled();

    fireEvent.blur(emailBox);

    expect(onMappingChange).toHaveBeenCalledWith('email', 'Email__c');
    expect(emailBox.value).toBe('Email__c');
  });

  it('takes back a name that is no field, and leaves a column emptied unmapped', () => {
    onMappingChange.mockClear();
    render(
      <CsvColumnMapper
        headers={mockHeaders}
        columnMappings={mockMappings}
        describeFields={mockFields}
        onMappingChange={onMappingChange}
      />,
    );
    const nameBox = screen.getByTestId('mapping-select-name') as HTMLInputElement;
    fireEvent.change(nameBox, { target: { value: 'Nowhere__c' } });
    fireEvent.blur(nameBox);
    expect(nameBox.value).toBe('Name');
    expect(onMappingChange).not.toHaveBeenCalled();

    fireEvent.change(nameBox, { target: { value: '' } });
    expect(onMappingChange).toHaveBeenCalledWith('name', '');
  });

  it('lists the fields once for every column, not once a column', () => {
    // 300 columns onto an 800-field object drew 300 selects of 801 options:
    // 240 000 options, drawn again at every change.
    const fields: SeedFieldInfo[] = Array.from({ length: 800 }, (_, i) => ({
      ...mockFields[0],
      apiName: `Field${i}__c`,
      label: `Field ${i}`,
    }));
    const headers = Array.from({ length: 300 }, (_, i) => `Column ${i}`);
    const mappings = headers.map((csvHeader, i) => ({
      csvHeader,
      sfFieldApiName: `Field${i}__c`,
      sfFieldType: 'string',
      sfFieldLength: 255,
    }));
    const { container } = render(
      <CsvColumnMapper
        headers={headers}
        columnMappings={mappings}
        describeFields={fields}
        onMappingChange={onMappingChange}
      />,
    );

    expect(container.querySelectorAll('option')).toHaveLength(800);
    expect(container.querySelectorAll('[data-testid^="mapping-row-"]')).toHaveLength(300);
  });

  it('draws again only the row whose mapping changed', () => {
    const headers = Array.from({ length: 50 }, (_, i) => `Column ${i}`);
    const Harness = () => {
      const [mappings, setMappings] = useState<CsvColumnMapping[]>(
        headers.map((csvHeader) => ({
          csvHeader,
          sfFieldApiName: '',
          sfFieldType: '',
          sfFieldLength: null,
        })),
      );
      // Kept from draw to draw, as the import's own handler is.
      const change = useCallback(
        (csvHeader: string, sfFieldApiName: string) =>
          setMappings((previous) =>
            previous.map((m) => (m.csvHeader === csvHeader ? { ...m, sfFieldApiName } : m)),
          ),
        [],
      );
      return (
        <CsvColumnMapper
          headers={headers}
          columnMappings={mappings}
          describeFields={mockFields}
          onMappingChange={change}
        />
      );
    };
    render(<Harness />);
    draws.count = 0;

    fireEvent.change(screen.getByTestId('mapping-select-Column 7'), { target: { value: 'Phone' } });

    // The mapper, and the one row (twice, as it takes the new mapping into
    // its box): all fifty rows were drawn again, every option with them.
    expect(draws.count).toBeLessThanOrEqual(3);
    expect((screen.getByTestId('mapping-select-Column 7') as HTMLInputElement).value).toBe('Phone');
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
