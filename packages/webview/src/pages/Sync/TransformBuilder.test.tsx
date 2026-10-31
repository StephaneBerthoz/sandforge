import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import { TransformBuilder, type TransformBuilderProps } from './TransformBuilder';
import type { SyncTransformRule } from './TransformBuilder';
import type { FieldInfo } from './FieldMappingCanvas';

/** The target fields of Account, as the describe gives them to the page. */
const FIELDS: FieldInfo[] = [
  { apiName: 'Name', label: 'Account Name', type: 'string' },
  { apiName: 'Description', label: 'Description', type: 'textarea' },
  { apiName: 'NumberOfEmployees', label: 'Employees', type: 'int' },
  { apiName: 'Founded__c', label: 'Founded', type: 'date' },
  { apiName: 'ParentId', label: 'Parent Account', type: 'reference' },
  { apiName: 'Legacy_Key__c', label: 'Legacy Key', type: 'string' },
];

const rules: SyncTransformRule[] = [
  { type: 'uppercase', field: 'Name', objectApiName: 'Account', config: {} },
  { type: 'prefix', field: 'Description', objectApiName: 'Account', config: { prefix: 'SF_' } },
  { type: 'trim', field: 'LastName', objectApiName: 'Contact', config: {} },
];

function renderBuilder(props: Partial<TransformBuilderProps> = {}) {
  const handlers = {
    onAddRule: vi.fn(),
    onRemoveRule: vi.fn(),
    onChangeConfig: vi.fn(),
    onObjectChange: vi.fn(),
  };
  render(
    <TransformBuilder
      rules={rules}
      objects={['Account', 'Contact']}
      objectApiName="Account"
      fields={FIELDS}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

/** The options a select offers, by their value. */
function optionValues(select: HTMLElement): string[] {
  return [...(select as HTMLSelectElement).options].filter((o) => !o.disabled).map((o) => o.value);
}

describe('TransformBuilder', () => {
  it('shows the rules of the object on screen, each on the field it names', () => {
    renderBuilder();

    expect(screen.getByTestId('transform-0-field').textContent).toBe('Name');
    expect(screen.getByTestId('transform-1-field').textContent).toBe('Description');
    // Contact's rule is Contact's alone.
    expect(screen.queryByTestId('transform-2')).toBeNull();
    expect(screen.getByText('Transforms (2)')).toBeDefined();
  });

  it('says on the page what a rule changes and what it leaves', () => {
    renderBuilder();

    expect(screen.getByTestId('transform-intro').textContent).toBe(
      'Each rule changes one field of Account in every record the run writes. Fields without a rule are written as read.',
    );
  });

  it('lets the other objects of the run be picked, and says which one is shown', () => {
    const { onObjectChange } = renderBuilder();

    const picker = screen.getByLabelText('Rules for');
    expect((picker as HTMLSelectElement).value).toBe('Account');
    fireEvent.change(picker, { target: { value: 'Contact' } });

    expect(onObjectChange).toHaveBeenCalledWith('Contact');
  });

  it('asks for no object when the run has one', () => {
    renderBuilder({ objects: ['Account'] });

    expect(screen.queryByLabelText('Rules for')).toBeNull();
  });

  it('adds a rule on the field picked, and only once one is picked', () => {
    const { onAddRule } = renderBuilder();
    const add = screen.getByTestId('add-transform-btn') as HTMLButtonElement;

    // No rule on every field: Add waits for a field.
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: 'Name' } });
    fireEvent.click(add);

    expect(onAddRule).toHaveBeenCalledWith('uppercase', 'Name');
  });

  it('offers neither Id nor the External ID the write matches on', () => {
    renderBuilder({
      fields: [{ apiName: 'Id', label: 'Account ID', type: 'id' }, ...FIELDS],
      matchField: 'Legacy_Key__c',
    });

    const offered = optionValues(screen.getByLabelText('Field'));
    expect(offered).toContain('Name');
    expect(offered).not.toContain('Legacy_Key__c');
    expect(offered).not.toContain('Id');
  });

  it('offers for a rule only the fields it can change', () => {
    renderBuilder();
    const field = screen.getByLabelText('Field');
    const rule = screen.getByLabelText('Rule');

    // A text rule leaves a number, a date and a lookup as read.
    expect(optionValues(field)).toEqual(['Name', 'Description', 'Legacy_Key__c']);
    fireEvent.change(rule, { target: { value: 'format_date' } });
    expect(optionValues(field)).toEqual(['Founded__c']);
    fireEvent.change(rule, { target: { value: 'format_number' } });
    expect(optionValues(field)).toEqual(['NumberOfEmployees']);
  });

  it('drops the field picked when the rule picked next cannot change it', () => {
    const { onAddRule } = renderBuilder();
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: 'Name' } });
    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: 'format_date' } });

    expect((screen.getByLabelText('Field') as HTMLSelectElement).value).toBe('');
    expect((screen.getByTestId('add-transform-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(onAddRule).not.toHaveBeenCalled();
  });

  it('says so when no field of the object takes the rule', () => {
    renderBuilder({ fields: [{ apiName: 'Name', label: 'Account Name', type: 'string' }] });
    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: 'format_date' } });

    expect(screen.getByTestId('transform-no-field').textContent).toBe(
      'No field of Account takes Format date.',
    );
  });

  it('holds the field choice while the fields are read', () => {
    renderBuilder({ fields: [], fieldsLoading: true });

    const field = screen.getByLabelText('Field') as HTMLSelectElement;
    expect(field.disabled).toBe(true);
    expect(field.options[0].textContent).toBe('Reading the fields…');
    expect(screen.queryByTestId('transform-no-field')).toBeNull();
  });

  it('no longer offers Map Value, which has no box for its table', () => {
    renderBuilder();

    expect(optionValues(screen.getByLabelText('Rule'))).not.toContain('map_value');
  });

  it('labels each setting in words, never by its key', () => {
    renderBuilder();

    const prefix = within(screen.getByTestId('transform-1')).getByLabelText('Text before');
    expect((prefix as HTMLInputElement).value).toBe('SF_');
    expect(screen.queryByPlaceholderText('prefix')).toBeNull();
  });

  it('passes a setting typed in to the rule it belongs to', () => {
    const { onChangeConfig } = renderBuilder();

    fireEvent.change(within(screen.getByTestId('transform-1')).getByLabelText('Text before'), {
      target: { value: 'QA-' },
    });

    expect(onChangeConfig).toHaveBeenCalledWith(1, 'prefix', 'QA-');
  });

  it('names its remove button with the rule and the field', () => {
    const { onRemoveRule } = renderBuilder();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Prefix on Description' }));

    expect(onRemoveRule).toHaveBeenCalledWith(1);
    expect(screen.getByTestId('remove-transform-1').textContent).toBe('');
  });

  it('marks a rule saved before rules named a field, on every object, and says what it does', () => {
    const { onRemoveRule } = renderBuilder({
      rules: [{ type: 'trim', config: {} }],
      objectApiName: 'Contact',
    });

    expect(screen.getByTestId('transform-0-every-field').textContent).toBe('Every field');
    expect(screen.getByTestId('transform-every-field-note').textContent).toContain(
      'runs on every field of every object in this run',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Trim on every field' }));
    expect(onRemoveRule).toHaveBeenCalledWith(0);
  });

  it('says the object has no rule, and that its fields are written as read', () => {
    renderBuilder({ rules: [] });

    expect(screen.getByTestId('transform-none').textContent).toBe(
      'No rule on Account: its fields are written as read.',
    );
    expect(screen.queryByTestId('transform-every-field-note')).toBeNull();
  });
});
