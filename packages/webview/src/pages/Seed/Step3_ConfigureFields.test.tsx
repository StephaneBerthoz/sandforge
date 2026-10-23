import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useCallback, useState } from 'react';
import '../../i18n';
import type { FieldConfig } from './Step3_ConfigureFields';

/** How many times a component of the step asked for its words: once a draw. */
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
import { SUPPORTED_FAKER_METHODS } from '@sandforge/shared';
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

/** The rule types offered, then those shown but not selectable, for one field row. */
function ruleChoices(testId: string): { offered: string[]; disabled: string[] } {
  const ruleSelect = screen.getByTestId(testId).querySelectorAll('select')[0];
  const options = Array.from(ruleSelect.querySelectorAll('option')).filter((o) => o.value !== '');
  return {
    offered: options.filter((o) => !o.disabled).map((o) => o.value),
    disabled: options.filter((o) => o.disabled).map((o) => o.value),
  };
}

describe('Step3ConfigureFields', () => {
  it('offers AI generation only on fields a generated sentence can fill', () => {
    const field = (fieldApiName: string, type: string) => ({
      fieldApiName,
      label: fieldApiName,
      type,
      required: false,
      ruleType: 'static' as const,
      config: {},
    });
    render(
      <Step3ConfigureFields
        objectConfigs={[
          {
            objectApiName: 'Opportunity',
            objectLabel: 'Opportunity',
            fields: [
              field('Description', 'textarea'),
              field('NextStep', 'string'),
              field('Amount', 'currency'),
              field('Probability', 'double'),
              field('CloseDate', 'date'),
              field('IsPrivate', 'boolean'),
              field('Email__c', 'email'),
              field('StageName', 'picklist'),
            ],
          },
        ]}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );

    expect(ruleChoices('field-Opportunity-Description').offered).toContain('ai_generate');
    expect(ruleChoices('field-Opportunity-NextStep').offered).toContain('ai_generate');
    for (const name of [
      'Amount',
      'Probability',
      'CloseDate',
      'IsPrivate',
      'Email__c',
      'StageName',
    ]) {
      const choices = ruleChoices(`field-Opportunity-${name}`);
      expect(choices.offered, name).not.toContain('ai_generate');
      expect(choices.offered, name).toContain('static');
      expect(choices.disabled, name).toEqual([]);
    }
  });

  it('keeps an AI rule already set on a number field visible but not selectable', () => {
    render(
      <Step3ConfigureFields
        objectConfigs={[
          {
            objectApiName: 'Opportunity',
            objectLabel: 'Opportunity',
            fields: [
              {
                fieldApiName: 'Amount',
                label: 'Amount',
                type: 'currency',
                required: false,
                ruleType: 'ai_generate',
                config: { aiPrompt: 'Deal size' },
              },
            ],
          },
        ]}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );

    const choices = ruleChoices('field-Opportunity-Amount');
    expect(choices.offered).not.toContain('ai_generate');
    expect(choices.disabled).toEqual(['ai_generate']);
    const ruleSelect = screen.getByTestId('field-Opportunity-Amount').querySelector('select');
    expect(ruleSelect?.value).toBe('ai_generate');
  });

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

  it('names each control of a field row after its field', () => {
    render(
      <Step3ConfigureFields
        objectConfigs={configs}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Generation rule for Name' })).toBeDefined();
    expect(screen.getByRole('combobox', { name: 'Faker for Name' })).toBeDefined();
    expect(screen.getByRole('combobox', { name: 'Generation rule for Industry' })).toBeDefined();
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

  it('offers the faker methods SandForge generates in a list instead of free text', () => {
    const onChangeConfig = vi.fn();
    render(
      <Step3ConfigureFields
        objectConfigs={[
          {
            objectApiName: 'Account',
            objectLabel: 'Account',
            fields: [
              {
                fieldApiName: 'Name',
                label: 'Name',
                type: 'string',
                required: true,
                ruleType: 'faker',
                config: { fakerMethod: 'company.name' },
              },
            ],
          },
        ]}
        onChangeRule={vi.fn()}
        onChangeConfig={onChangeConfig}
      />,
    );

    const field = screen.getByTestId('field-Account-Name');
    expect(field.querySelector('input')).toBeNull();
    const methodSelect = field.querySelectorAll('select')[1];
    const values = Array.from(methodSelect.querySelectorAll('option'))
      .map((o) => o.value)
      .filter((v) => v !== '');
    expect(values).toEqual([...SUPPORTED_FAKER_METHODS]);
    /* A template written with the faker.js spelling shows the method it resolves to. */
    expect(methodSelect.value).toBe('company');

    fireEvent.change(methodSelect, { target: { value: 'iban' } });
    expect(onChangeConfig).toHaveBeenCalledWith('Account', 'Name', 'fakerMethod', 'iban');
  });

  it('keeps a method nothing generates visible, so the refusal can be traced to it', () => {
    render(
      <Step3ConfigureFields
        objectConfigs={[
          {
            objectApiName: 'Account',
            objectLabel: 'Account',
            fields: [
              {
                fieldApiName: 'Pet__c',
                label: 'Pet',
                type: 'string',
                required: false,
                ruleType: 'faker',
                config: { fakerMethod: 'animal.petName' },
              },
            ],
          },
        ]}
        onChangeRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );

    const methodSelect = screen.getByTestId('field-Account-Pet__c').querySelectorAll('select')[1];
    expect(methodSelect.value).toBe('animal.petName');
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

  describe('an object of hundreds of fields', () => {
    /** An Account with `count` text fields, every third one required. */
    const wide = (count: number): ObjectFieldConfig[] => [
      {
        objectApiName: 'Account',
        objectLabel: 'Account',
        fields: Array.from({ length: count }, (_, i): FieldConfig => ({
          fieldApiName: i === 0 ? 'Name' : `Field${i}__c`,
          label: i === 0 ? 'Account Name' : `Field ${i}`,
          type: 'String',
          required: i % 3 === 0,
          ruleType: 'static',
          config: {},
        })),
      },
    ];

    it('finds a field by its label or its API name, and says how many are shown', () => {
      // The only search found objects, past twenty of them: the three fields
      // an admin wanted sat among 800 rows to scroll past.
      render(
        <Step3ConfigureFields
          objectConfigs={wide(40)}
          onChangeRule={vi.fn()}
          onChangeConfig={vi.fn()}
        />,
      );
      const filter = screen.getByRole('searchbox', { name: 'Find a field of Account' });

      fireEvent.change(filter, { target: { value: 'account name' } });
      expect(screen.getByTestId('field-Account-Name')).toBeDefined();
      expect(screen.queryByTestId('field-Account-Field1__c')).toBeNull();
      expect(screen.getByTestId('field-filter-count-Account').textContent).toBe(
        '1 of 40 fields shown',
      );

      fireEvent.change(filter, { target: { value: 'field12__C' } });
      expect(screen.getByTestId('field-Account-Field12__c')).toBeDefined();
      expect(screen.queryByTestId('field-Account-Name')).toBeNull();

      fireEvent.change(filter, { target: { value: 'nothing like it' } });
      expect(screen.getByTestId('field-filter-none-Account').textContent).toBe(
        'No field matches this filter.',
      );
    });

    it('shows the required fields only, when asked', () => {
      render(
        <Step3ConfigureFields
          objectConfigs={wide(40)}
          onChangeRule={vi.fn()}
          onChangeConfig={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByLabelText('Required only'));

      const rows = screen.getAllByTestId(/^field-Account-/);
      expect(rows).toHaveLength(14);
      expect(screen.queryByTestId('field-Account-Field1__c')).toBeNull();
    });

    it('shows the fields the user set only, when asked, with the other filters', () => {
      // The three fields set among 800 could only be found again by name.
      const [account] = wide(40);
      const fields = account.fields.map((field): FieldConfig =>
        ['Name', 'Field4__c', 'Field7__c'].includes(field.fieldApiName)
          ? { ...field, setByUser: true }
          : field,
      );
      render(
        <Step3ConfigureFields
          objectConfigs={[{ ...account, fields }]}
          onChangeRule={vi.fn()}
          onChangeConfig={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByLabelText('Set by me'));

      expect(screen.getAllByTestId(/^field-Account-/).map((row) => row.dataset.testid)).toEqual([
        'field-Account-Name',
        'field-Account-Field4__c',
        'field-Account-Field7__c',
      ]);
      expect(screen.getByTestId('field-filter-count-Account').textContent).toBe(
        '3 of 40 fields shown',
      );

      // Required as well: of the three, the ones the org requires.
      fireEvent.click(screen.getByLabelText('Required only'));
      expect(screen.getAllByTestId(/^field-Account-/).map((row) => row.dataset.testid)).toEqual([
        'field-Account-Name',
      ]);

      fireEvent.click(screen.getByLabelText('Set by me'));
      expect(screen.getAllByTestId(/^field-Account-/)).toHaveLength(14);
    });

    it('offers no filter on an object of ten fields or fewer', () => {
      render(
        <Step3ConfigureFields
          objectConfigs={wide(10)}
          onChangeRule={vi.fn()}
          onChangeConfig={vi.fn()}
        />,
      );

      expect(screen.queryByTestId('field-filter-Account')).toBeNull();
      expect(screen.getAllByTestId(/^field-Account-/)).toHaveLength(10);
    });

    it('draws the rows of an 800-field object as they scroll into view, not all at once', () => {
      // Every row was drawn as the object opened: about 16 000 elements.
      render(
        <Step3ConfigureFields
          objectConfigs={wide(800)}
          onChangeRule={vi.fn()}
          onChangeConfig={vi.fn()}
        />,
      );

      expect(screen.getByTestId('virtual-list')).toBeDefined();
      expect(screen.queryAllByTestId(/^field-Account-/).length).toBeLessThan(100);
    });

    it('draws again only the row whose value is typed in', () => {
      const changeRule = vi.fn();
      const Harness = () => {
        const [objects, setObjects] = useState(wide(60));
        // Kept from draw to draw, as the wizard's own handler is.
        const change = useCallback(
          (objectApiName: string, fieldApiName: string, key: string, value: string) =>
            setObjects((previous) =>
              previous.map((obj) =>
                obj.objectApiName !== objectApiName
                  ? obj
                  : {
                      ...obj,
                      fields: obj.fields.map((f) =>
                        f.fieldApiName === fieldApiName
                          ? { ...f, config: { ...f.config, [key]: value } }
                          : f,
                      ),
                    },
              ),
            ),
          [],
        );
        return (
          <Step3ConfigureFields
            objectConfigs={objects}
            onChangeRule={changeRule}
            onChangeConfig={change}
          />
        );
      };
      render(<Harness />);
      draws.count = 0;

      fireEvent.change(screen.getByLabelText('Static Value for Field 7'), {
        target: { value: 'A' },
      });

      // The step, the object, and the one row: every row of the object was
      // drawn again at each character.
      expect(draws.count).toBeLessThanOrEqual(3);
      expect((screen.getByLabelText('Static Value for Field 7') as HTMLInputElement).value).toBe(
        'A',
      );
    });
  });
});
