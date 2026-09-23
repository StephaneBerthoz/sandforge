import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import type { AnonymizationTemplateRule } from '@sandforge/shared';
import { AnonymizationTemplateEditor } from './AnonymizationTemplateEditor';

const rule = (fieldPattern: string, ruleType: string): AnonymizationTemplateRule => ({
  fieldPattern,
  ruleType,
  description: '',
});

function editor(
  overrides: Partial<React.ComponentProps<typeof AnonymizationTemplateEditor>> = {},
): { onSave: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(
    <AnonymizationTemplateEditor
      initialRules={[]}
      takenNames={['GDPR Standard']}
      onSave={onSave}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onSave, onCancel };
}

const saveButton = () => screen.getByTestId('template-save') as HTMLButtonElement;
const nameInput = () => screen.getByTestId('template-name-input');

describe('AnonymizationTemplateEditor', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('starts empty, and cannot be saved without a rule', () => {
    editor();
    fireEvent.change(nameInput(), { target: { value: 'Mine' } });

    expect(screen.getByTestId('template-no-rules').textContent).toBe(
      'Add at least one rule to save the template.',
    );
    expect(saveButton().disabled).toBe(true);
  });

  it('saves a rule added by hand, trimmed, with the method picked', () => {
    const { onSave } = editor();
    fireEvent.change(nameInput(), { target: { value: '  Cases  ' } });
    fireEvent.click(screen.getByTestId('template-add-rule'));
    fireEvent.change(screen.getByTestId('template-rule-field-0'), {
      target: { value: ' Case.SuppliedEmail ' },
    });
    fireEvent.change(screen.getByTestId('template-rule-method-0'), {
      target: { value: 'nullify' },
    });
    fireEvent.click(saveButton());

    expect(onSave).toHaveBeenCalledWith({
      name: 'Cases',
      rules: [{ fieldPattern: 'Case.SuppliedEmail', ruleType: 'nullify' }],
    });
  });

  it('needs a name before it saves', () => {
    editor({ initialRules: [rule('Contact.Email', 'fake')] });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    expect(saveButton().disabled).toBe(true);
  });

  it('refuses a name a template already goes by, whatever its case', () => {
    editor({ initialRules: [rule('Contact.Email', 'fake')] });
    fireEvent.change(nameInput(), { target: { value: 'gdpr standard' } });

    expect(screen.getByTestId('template-name-taken').textContent).toBe(
      'A template already has this name.',
    );
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
    expect(nameInput().getAttribute('aria-describedby')).toBe(
      screen.getByTestId('template-name-taken').id,
    );
    expect(saveButton().disabled).toBe(true);
  });

  it('says how to write a field it cannot read, next to the field', () => {
    editor({ initialRules: [rule('Email', 'fake')] });
    fireEvent.change(nameInput(), { target: { value: 'Mine' } });

    const field = screen.getByTestId('template-rule-field-0');
    const reason = document.getElementById(field.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe('Write the field as Object.Field, for example Contact.Email.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(saveButton().disabled).toBe(true);
  });

  it('refuses a second rule on the same field', () => {
    editor({ initialRules: [rule('Contact.Email', 'fake'), rule('contact.email', 'mask')] });
    fireEvent.change(nameInput(), { target: { value: 'Mine' } });

    expect(screen.getByTestId('template-rule-1').textContent).toContain(
      'This field already has a rule.',
    );
    expect(saveButton().disabled).toBe(true);
  });

  it('keeps a rule whose method cannot run here on screen, says why, and saves once it is changed', () => {
    // Sandbox Data Scrub writes a placeholder URL it carries itself, and the
    // page sets no value: copied over silently, the rule would write an empty one.
    const { onSave } = editor({
      initialRules: [rule('Account.Website', 'constant'), rule('Contact.Phone', 'nullify')],
    });
    fireEvent.change(nameInput(), { target: { value: 'Mine' } });

    const method = screen.getByTestId('template-rule-method-0') as HTMLSelectElement;
    expect(method.value).toBe('constant');
    expect(screen.getByTestId('template-rule-0').textContent).toContain(
      'Constant needs a setting this page cannot give it: pick another method.',
    );
    expect(method.getAttribute('aria-invalid')).toBe('true');
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(method, { target: { value: 'nullify' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      name: 'Mine',
      rules: [
        { fieldPattern: 'Account.Website', ruleType: 'nullify' },
        { fieldPattern: 'Contact.Phone', ruleType: 'nullify' },
      ],
    });
  });

  it('saves the hash of a template that ships as it is, since the run keys it', () => {
    const { onSave } = editor({ initialRules: [rule('Contact.Email', 'hash')] });
    fireEvent.change(nameInput(), { target: { value: 'Mine' } });

    expect(screen.getByTestId('template-rule-0').textContent).not.toContain('needs a setting');
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      name: 'Mine',
      rules: [{ fieldPattern: 'Contact.Email', ruleType: 'hash' }],
    });
  });

  it('offers only the methods a saved template can run', () => {
    editor();
    fireEvent.click(screen.getByTestId('template-add-rule'));

    const options = Array.from(
      (screen.getByTestId('template-rule-method-0') as HTMLSelectElement).options,
    ).map((option) => option.value);
    expect(options).toEqual(['fake', 'mask', 'hash', 'nullify', 'shuffle', 'preserve_format']);
  });

  it('removes a rule, named by its number for a screen reader', () => {
    editor({ initialRules: [rule('Contact.Email', 'fake'), rule('Contact.Phone', 'mask')] });

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 1' }));

    expect((screen.getByTestId('template-rule-field-0') as HTMLInputElement).value).toBe(
      'Contact.Phone',
    );
    expect(screen.queryByTestId('template-rule-field-1')).toBeNull();
  });

  it('groups each rule under its number', () => {
    editor({ initialRules: [rule('Contact.Email', 'fake')] });

    const group = screen.getByRole('group', { name: 'Rule 1' });
    expect(within(group).getByRole('textbox', { name: 'Field (Object.Field)' })).toBeDefined();
    expect(within(group).getByRole('combobox', { name: 'Method' })).toBeDefined();
  });

  it('cancels without saving', () => {
    const { onSave, onCancel } = editor({ initialRules: [rule('Contact.Email', 'fake')] });
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('does not send a second save while one is on its way', () => {
    const { onSave } = editor({ initialRules: [rule('Contact.Email', 'fake')], saving: true });
    fireEvent.change(nameInput(), { target: { value: 'Mine' } });
    fireEvent.submit(screen.getByTestId('template-editor'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('speaks the language the panel is set to', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    editor({ initialRules: [rule('Contact.MailingPostalCode', 'truncate')] });

    expect(screen.getByTestId('template-rule-0').textContent).toContain(
      'Tronquer nécessite un réglage que cette page ne peut pas lui donner',
    );
  });
});
