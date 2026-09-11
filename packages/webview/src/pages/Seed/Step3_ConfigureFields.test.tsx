import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { Step3ConfigureFields, categorizeObject } from './Step3_ConfigureFields';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';

const configs: ObjectFieldConfig[] = [
  {
    objectApiName: 'Account',
    objectLabel: 'Account',
    fields: [
      {
        fieldApiName: 'Name',
        label: 'Name',
        type: 'String',
        required: true,
        ruleType: 'faker',
        config: { fakerMethod: 'company.name' },
      },
      {
        fieldApiName: 'Industry',
        label: 'Industry',
        type: 'Picklist',
        required: false,
        ruleType: 'picklist_random',
        config: {},
      },
    ],
  },
  {
    objectApiName: 'Contact',
    objectLabel: 'Contact',
    fields: [
      {
        fieldApiName: 'FirstName',
        label: 'First Name',
        type: 'String',
        required: false,
        ruleType: 'faker',
        config: {},
      },
    ],
  },
];

describe('Step3ConfigureFields', () => {
  it('should render the step', () => {
    render(
      <Step3ConfigureFields
        objectConfigs={configs}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    expect(screen.getByTestId('step-configure-fields')).toBeDefined();
  });

  it('should render object headers', () => {
    render(
      <Step3ConfigureFields
        objectConfigs={configs}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    expect(screen.getByTestId('obj-header-Account')).toBeDefined();
    expect(screen.getByTestId('obj-header-Contact')).toBeDefined();
  });

  it('should expand first object by default', () => {
    render(
      <Step3ConfigureFields
        objectConfigs={configs}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    expect(screen.getByTestId('field-Account-Name')).toBeDefined();
    expect(screen.getByTestId('field-Account-Industry')).toBeDefined();
  });

  it('should show required indicator', () => {
    render(
      <Step3ConfigureFields
        objectConfigs={configs}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    const nameField = screen.getByTestId('field-Account-Name');
    expect(nameField.textContent).toContain('*');
  });

  it('should toggle object expansion', () => {
    render(
      <Step3ConfigureFields
        objectConfigs={configs}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('obj-header-Contact'));
    expect(screen.getByTestId('field-Contact-FirstName')).toBeDefined();
  });

  it('should display field type', () => {
    render(
      <Step3ConfigureFields
        objectConfigs={configs}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    const nameField = screen.getByTestId('field-Account-Name');
    expect(nameField.textContent).toContain('String');
  });

  it('should show field count badge', () => {
    render(
      <Step3ConfigureFields
        objectConfigs={configs}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    const header = screen.getByTestId('obj-header-Account');
    expect(header.textContent).toContain('2');
  });

  it('should render sequence input for sequence rule type', () => {
    const seqConfigs: ObjectFieldConfig[] = [
      {
        objectApiName: 'Account',
        objectLabel: 'Account',
        fields: [
          {
            fieldApiName: 'Code__c',
            label: 'Code',
            type: 'String',
            required: false,
            ruleType: 'sequence',
            config: { sequencePrefix: 'ACC-' },
          },
        ],
      },
    ];
    render(
      <Step3ConfigureFields
        objectConfigs={seqConfigs}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    const field = screen.getByTestId('field-Account-Code__c');
    const input = field.querySelector('input');
    expect(input).toBeDefined();
    expect(input?.value).toBe('ACC-');
  });

  it('should render regex input for regex rule type', () => {
    const regexConfigs: ObjectFieldConfig[] = [
      {
        objectApiName: 'Account',
        objectLabel: 'Account',
        fields: [
          {
            fieldApiName: 'Pattern__c',
            label: 'Pattern',
            type: 'String',
            required: false,
            ruleType: 'regex',
            config: { regexPattern: '[A-Z]{3}' },
          },
        ],
      },
    ];
    render(
      <Step3ConfigureFields
        objectConfigs={regexConfigs}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    const field = screen.getByTestId('field-Account-Pattern__c');
    const input = field.querySelector('input');
    expect(input).toBeDefined();
    expect(input?.value).toBe('[A-Z]{3}');
  });

  it('should show grouped view with search filter for >20 objects', () => {
    const makeField = (name: string) => ({
      fieldApiName: name,
      label: name,
      type: 'String',
      required: false,
      ruleType: 'faker' as const,
      config: {},
    });

    // Generate 25 objects: 10 standard + 10 custom + 5 managed
    const largeConfigs: ObjectFieldConfig[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        objectApiName: `Obj${i}`,
        objectLabel: `Obj ${i}`,
        fields: [makeField('Field1')],
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        objectApiName: `Custom${i}__c`,
        objectLabel: `Custom ${i}`,
        fields: [makeField('Field1')],
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        objectApiName: `ns__Managed${i}__c`,
        objectLabel: `Managed ${i}`,
        fields: [makeField('Field1')],
      })),
    ];

    render(
      <Step3ConfigureFields
        objectConfigs={largeConfigs}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );

    // Should show search filter
    expect(screen.getByTestId('configure-search-filter')).toBeDefined();
    // Should show grouped accordion
    expect(screen.getByTestId('configure-grouped-accordion')).toBeDefined();
  });

  it('should not show grouped view for <=20 objects', () => {
    render(
      <Step3ConfigureFields
        objectConfigs={configs}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('configure-search-filter')).toBeNull();
    expect(screen.queryByTestId('configure-grouped-accordion')).toBeNull();
  });

  it('should filter objects by search term in grouped view', () => {
    const makeField = (name: string) => ({
      fieldApiName: name,
      label: name,
      type: 'String',
      required: false,
      ruleType: 'faker' as const,
      config: {},
    });

    const largeConfigs: ObjectFieldConfig[] = Array.from({ length: 22 }, (_, i) => ({
      objectApiName: i === 0 ? 'UniqueSearchTarget' : `Obj${i}`,
      objectLabel: i === 0 ? 'Unique Search Target' : `Obj ${i}`,
      fields: [makeField('Field1')],
    }));

    render(
      <Step3ConfigureFields
        objectConfigs={largeConfigs}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );

    const searchInput = screen.getByTestId('configure-search-filter');
    fireEvent.change(searchInput, { target: { value: 'UniqueSearch' } });

    // Only the matching object's header should appear
    expect(screen.getByTestId('obj-header-UniqueSearchTarget')).toBeDefined();
    expect(screen.queryByTestId('obj-header-Obj1')).toBeNull();
  });
});

describe('categorizeObject', () => {
  it('should categorize standard objects', () => {
    expect(categorizeObject('Account')).toBe('standard');
    expect(categorizeObject('Contact')).toBe('standard');
    expect(categorizeObject('Lead')).toBe('standard');
  });

  it('should categorize custom objects', () => {
    expect(categorizeObject('MyObject__c')).toBe('custom');
    expect(categorizeObject('Invoice__c')).toBe('custom');
  });

  it('should categorize managed package objects', () => {
    expect(categorizeObject('ns__ManagedObj__c')).toBe('managed');
    expect(categorizeObject('copado__Deployment__c')).toBe('managed');
  });
});
