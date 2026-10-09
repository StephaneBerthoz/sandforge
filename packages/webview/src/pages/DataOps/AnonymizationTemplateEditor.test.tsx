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

  it('asks a Constant for its value, and holds Save until it is typed', () => {
    const { onSave } = editor();
    fireEvent.change(nameInput(), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByTestId('template-add-rule'));
    fireEvent.change(screen.getByTestId('template-rule-field-0'), {
      target: { value: 'Account.Website' },
    });
    expect(screen.queryByTestId('template-rule-constant-0')).toBeNull();

    fireEvent.change(screen.getByTestId('template-rule-method-0'), {
      target: { value: 'constant' },
    });
    const value = screen.getByTestId('template-rule-constant-0');
    expect(screen.getByTestId('template-rule-0').textContent).toContain(
      "Constant needs the value it writes in place of the field's.",
    );
    expect(value.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(value.getAttribute('aria-describedby') ?? '')).not.toBeNull();
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(value, { target: { value: 'https://example.com' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      name: 'Mine',
      rules: [
        {
          fieldPattern: 'Account.Website',
          ruleType: 'constant',
          config: { constantValue: 'https://example.com' },
        },
      ],
    });
  });

  it('asks a Truncate how many characters it keeps and from which end, and holds Save until it has a length', () => {
    const { onSave } = editor({ initialRules: [rule('Contact.Phone', 'truncate')] });
    fireEvent.change(nameInput(), { target: { value: 'Mine' } });

    const length = screen.getByTestId('template-rule-truncate-length-0');
    expect(screen.getByTestId('template-rule-0').textContent).toContain(
      'Truncate needs how many characters it keeps: a whole number from 1 to 255.',
    );
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(length, { target: { value: '0' } });
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(length, { target: { value: '4' } });
    expect(saveButton().disabled).toBe(false);
    expect(
      within(screen.getByRole('group', { name: 'Rule 1' })).getByRole('combobox', {
        name: 'Kept from',
      }),
    ).toBeDefined();
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      name: 'Mine',
      rules: [
        {
          fieldPattern: 'Contact.Phone',
          ruleType: 'truncate',
          config: { truncateLength: 4, truncateKeep: 'last' },
        },
      ],
    });
  });

  it('keeps the setting of a rule it starts from: the value a Constant writes, the length and end a Truncate keeps', () => {
    // Sandbox Data Scrub writes a placeholder URL, HIPAA keeps the first three
    // digits of a postal code: carried over without them, neither rule would
    // do what it says.
    const { onSave } = editor({
      initialRules: [
        {
          ...rule('Account.Website', 'constant'),
          config: { constantValue: 'https://example.com' },
        },
        {
          ...rule('Contact.MailingPostalCode', 'truncate'),
          config: { truncateLength: 3, truncateKeep: 'first' },
        },
      ],
    });
    fireEvent.change(nameInput(), { target: { value: 'Mine' } });

    expect((screen.getByTestId('template-rule-constant-0') as HTMLInputElement).value).toBe(
      'https://example.com',
    );
    expect((screen.getByTestId('template-rule-truncate-length-1') as HTMLInputElement).value).toBe(
      '3',
    );
    expect((screen.getByTestId('template-rule-truncate-keep-1') as HTMLSelectElement).value).toBe(
      'first',
    );
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      name: 'Mine',
      rules: [
        {
          fieldPattern: 'Account.Website',
          ruleType: 'constant',
          config: { constantValue: 'https://example.com' },
        },
        {
          fieldPattern: 'Contact.MailingPostalCode',
          ruleType: 'truncate',
          config: { truncateLength: 3, truncateKeep: 'first' },
        },
      ],
    });
  });

  it('sends no setting with a method that takes none, even one typed before the method changed', () => {
    const { onSave } = editor({
      initialRules: [
        {
          ...rule('Account.Website', 'constant'),
          config: { constantValue: 'https://example.com' },
        },
      ],
    });
    fireEvent.change(nameInput(), { target: { value: 'Mine' } });
    fireEvent.change(screen.getByTestId('template-rule-method-0'), {
      target: { value: 'nullify' },
    });
    expect(screen.queryByTestId('template-rule-constant-0')).toBeNull();

    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      name: 'Mine',
      rules: [{ fieldPattern: 'Account.Website', ruleType: 'nullify' }],
    });
  });

  it('keeps a rule whose method a template cannot save on screen, says why, and saves once it is changed', () => {
    const { onSave } = editor({ initialRules: [rule('Contact.Birthdate', 'age_band')] });
    fireEvent.change(nameInput(), { target: { value: 'Mine' } });

    const method = screen.getByTestId('template-rule-method-0') as HTMLSelectElement;
    expect(method.value).toBe('age_band');
    expect(screen.getByTestId('template-rule-0').textContent).toContain(
      'age_band cannot be saved in a template: pick another method.',
    );
    expect(method.getAttribute('aria-invalid')).toBe('true');
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(method, { target: { value: 'nullify' } });
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      name: 'Mine',
      rules: [{ fieldPattern: 'Contact.Birthdate', ruleType: 'nullify' }],
    });
  });

  it('saves the hash of a template that ships as it is, since the run keys it', () => {
    const { onSave } = editor({ initialRules: [rule('Contact.Email', 'hash')] });
    fireEvent.change(nameInput(), { target: { value: 'Mine' } });

    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      name: 'Mine',
      rules: [{ fieldPattern: 'Contact.Email', ruleType: 'hash' }],
    });
  });

  it('offers every method a run applies', () => {
    editor();
    fireEvent.click(screen.getByTestId('template-add-rule'));

    const options = Array.from(
      (screen.getByTestId('template-rule-method-0') as HTMLSelectElement).options,
    ).map((option) => option.value);
    expect(options).toEqual([
      'fake',
      'mask',
      'hash',
      'nullify',
      'shuffle',
      'preserve_format',
      'constant',
      'truncate',
    ]);
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
      "Tronquer a besoin du nombre de caractères qu'il conserve",
    );
    expect(screen.getByText('Caractères conservés')).toBeDefined();
  });
});
