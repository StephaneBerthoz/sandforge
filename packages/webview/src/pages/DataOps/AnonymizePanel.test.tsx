import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import { AnonymizePanel } from './AnonymizePanel';
import type { ListedAnonymizationTemplate } from '@sandforge/shared';

/** Templates the way `dataops:anonymization-templates:response` carries them. */
const templates: ListedAnonymizationTemplate[] = [
  {
    id: 'tpl-1',
    name: 'GDPR Template',
    description: 'Anonymize PII for GDPR compliance',
    complianceFramework: 'gdpr',
    rules: [
      { fieldPattern: 'Contact.Email', ruleType: 'mask', description: 'Mask the email.' },
      { fieldPattern: 'Contact.Phone', ruleType: 'fake', description: 'A fake phone number.' },
    ],
  },
  {
    id: 'tpl-saved-1',
    name: 'Support desk',
    description: '',
    complianceFramework: 'custom',
    rules: [{ fieldPattern: 'Case.SuppliedEmail', ruleType: 'nullify', description: '' }],
    saved: true,
  },
];

describe('AnonymizePanel', () => {
  it('should render the panel', () => {
    render(<AnonymizePanel />);
    expect(screen.getByTestId('anonymize-panel')).toBeDefined();
  });

  it('should show empty state when no templates', () => {
    render(<AnonymizePanel />);
    expect(screen.getByText('No templates available')).toBeDefined();
  });

  it('should show template selector', () => {
    render(<AnonymizePanel templates={templates} />);
    expect(screen.getByTestId('template-select')).toBeDefined();
  });

  it('marks a template the user saved in the picker', () => {
    render(<AnonymizePanel templates={templates} />);
    const labels = Array.from(
      (screen.getByTestId('template-select') as HTMLSelectElement).options,
    ).map((option) => option.textContent);
    expect(labels).toContain('GDPR Template');
    expect(labels).toContain('Support desk (saved)');
  });

  it('should call onSelectTemplate when template selected', () => {
    const onSelect = vi.fn();
    render(<AnonymizePanel templates={templates} onSelectTemplate={onSelect} />);
    fireEvent.change(screen.getByTestId('template-select'), { target: { value: 'tpl-1' } });
    expect(onSelect).toHaveBeenCalledWith('tpl-1');
  });

  it('should show template detail when selected', () => {
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" />);
    expect(screen.getByTestId('template-detail')).toBeDefined();
    expect(screen.getAllByText('GDPR Template').length).toBeGreaterThan(0);
  });

  it('should show compliance badge', () => {
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" />);
    expect(screen.getByText('GDPR')).toBeDefined();
  });

  it('names each rule by the field it masks and its method, as the host sends them', () => {
    // The badges read `fieldApiName` and `method`, which no listed template
    // carries: against the host's templates, each one read ": ".
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" />);
    expect(screen.getByText('Contact.Email: Mask')).toBeDefined();
    expect(screen.getByText('Contact.Phone: Fake')).toBeDefined();
  });

  it('counts the rules in the reader’s language, one and many', () => {
    const { rerender } = render(
      <AnonymizePanel templates={templates} selectedTemplateId="tpl-1" />,
    );
    expect(screen.getByTestId('template-rule-count').textContent).toBe('2 rules');
    rerender(<AnonymizePanel templates={templates} selectedTemplateId="tpl-saved-1" />);
    expect(screen.getByTestId('template-rule-count').textContent).toBe('1 rule');
  });

  it('should leave the preview button inert instead of masking data for real', () => {
    // Preview and Apply were wired to one handler, so "Preview" ran the
    // irreversible org write. No dry-run exists in the message contract.
    const onApply = vi.fn();
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" onApply={onApply} />);
    const preview = screen.getByTestId('preview-btn') as HTMLButtonElement;
    expect(preview.disabled).toBe(true);
    fireEvent.click(preview);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('should say the preview is not built yet', () => {
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" />);
    expect(screen.getByTestId('preview-unavailable').textContent).toBe('Coming soon');
  });

  it('should not anonymize on the apply click alone', () => {
    const onApply = vi.fn();
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" onApply={onApply} />);
    fireEvent.click(screen.getByTestId('apply-btn'));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByTestId('danger-title')).toBeDefined();
  });

  it('should anonymize once the confirmation word is typed', () => {
    const onApply = vi.fn();
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" onApply={onApply} />);
    fireEvent.click(screen.getByTestId('apply-btn'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Anonymize' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(onApply).toHaveBeenCalledWith('tpl-1');
  });

  it('applies a template the user saved the way it applies one that ships', () => {
    const onApply = vi.fn();
    render(
      <AnonymizePanel templates={templates} selectedTemplateId="tpl-saved-1" onApply={onApply} />,
    );
    fireEvent.click(screen.getByTestId('apply-btn'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Anonymize' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(onApply).toHaveBeenCalledWith('tpl-saved-1');
  });

  it('should not anonymize when the typed confirmation does not match', () => {
    const onApply = vi.fn();
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" onApply={onApply} />);
    fireEvent.click(screen.getByTestId('apply-btn'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('should show preview data table', () => {
    const previewData = [{ Name: 'J***', Email: '***@***.com' }];
    render(
      <AnonymizePanel templates={templates} selectedTemplateId="tpl-1" previewData={previewData} />,
    );
    expect(screen.getByTestId('preview-data')).toBeDefined();
    expect(screen.getByText('J***')).toBeDefined();
  });

  describe('creating a template', () => {
    it('no longer says Create Template is coming', () => {
      render(<AnonymizePanel templates={templates} onSaveTemplate={vi.fn()} />);
      const button = screen.getByTestId('create-template-btn') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.title).toBe('');
      expect(screen.queryByText('Coming soon')).toBeNull();
    });

    it('opens the editor on the rules of the template on screen', () => {
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-1"
          onSaveTemplate={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByTestId('create-template-btn'));

      const editor = screen.getByTestId('template-editor');
      expect(editor.textContent).toContain('Starts from the rules of GDPR Template');
      expect((screen.getByTestId('template-rule-field-0') as HTMLInputElement).value).toBe(
        'Contact.Email',
      );
      expect((screen.getByTestId('template-rule-method-1') as HTMLSelectElement).value).toBe(
        'fake',
      );
      expect(screen.queryByTestId('template-detail')).toBeNull();
    });

    it('saves the rules on screen under the name given', () => {
      const onSave = vi.fn();
      render(
        <AnonymizePanel templates={templates} selectedTemplateId="tpl-1" onSaveTemplate={onSave} />,
      );
      fireEvent.click(screen.getByTestId('create-template-btn'));
      fireEvent.change(screen.getByTestId('template-name-input'), {
        target: { value: 'Support desk v2' },
      });
      fireEvent.click(screen.getByTestId('template-save'));

      expect(onSave).toHaveBeenCalledWith({
        name: 'Support desk v2',
        rules: [
          { fieldPattern: 'Contact.Email', ruleType: 'mask' },
          { fieldPattern: 'Contact.Phone', ruleType: 'fake' },
        ],
      });
    });

    it('closes the editor once the host has saved the template', () => {
      const props = { templates, onSaveTemplate: vi.fn() };
      const { rerender } = render(<AnonymizePanel {...props} />);
      fireEvent.click(screen.getByTestId('create-template-btn'));

      rerender(<AnonymizePanel {...props} savingTemplate />);
      expect(screen.getByTestId('template-editor')).toBeDefined();
      rerender(<AnonymizePanel {...props} savingTemplate={false} />);

      expect(screen.queryByTestId('template-editor')).toBeNull();
    });

    it('keeps the editor, and what was typed, when the host refuses the save', () => {
      const props = { templates, onSaveTemplate: vi.fn() };
      const { rerender } = render(<AnonymizePanel {...props} />);
      fireEvent.click(screen.getByTestId('create-template-btn'));
      fireEvent.change(screen.getByTestId('template-name-input'), { target: { value: 'Mine' } });

      rerender(<AnonymizePanel {...props} savingTemplate />);
      rerender(
        <AnonymizePanel
          {...props}
          savingTemplate={false}
          saveTemplateError='A template named "Mine" already exists. Pick another name.'
        />,
      );

      expect((screen.getByTestId('template-name-input') as HTMLInputElement).value).toBe('Mine');
    });

    it('goes back to the templates on Cancel, saving nothing', () => {
      const onSave = vi.fn();
      render(<AnonymizePanel templates={templates} onSaveTemplate={onSave} />);
      fireEvent.click(screen.getByTestId('create-template-btn'));
      fireEvent.click(within(screen.getByTestId('template-editor')).getByText('Cancel'));

      expect(screen.queryByTestId('template-editor')).toBeNull();
      expect(screen.getByTestId('template-select')).toBeDefined();
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  describe('deleting a template', () => {
    it('offers no delete for a template that ships', () => {
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-1"
          onDeleteTemplate={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('delete-template-btn')).toBeNull();
      expect(screen.queryByTestId('template-saved-badge')).toBeNull();
    });

    it('deletes a template the user saved once the delete is confirmed', () => {
      const onDelete = vi.fn();
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-saved-1"
          onDeleteTemplate={onDelete}
        />,
      );
      expect(screen.getByTestId('template-saved-badge').textContent).toBe('Saved');

      fireEvent.click(screen.getByTestId('delete-template-btn'));
      expect(onDelete).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('confirm-delete-template-btn'));

      expect(onDelete).toHaveBeenCalledWith('tpl-saved-1');
    });

    it('does not carry a delete asked about one template over to the next one picked', () => {
      const second: ListedAnonymizationTemplate = {
        ...templates[1],
        id: 'tpl-saved-2',
        name: 'Other',
      };
      const all = [...templates, second];
      const { rerender } = render(
        <AnonymizePanel
          templates={all}
          selectedTemplateId="tpl-saved-1"
          onDeleteTemplate={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByTestId('delete-template-btn'));
      expect(screen.getByTestId('confirm-delete-template-btn')).toBeDefined();

      rerender(
        <AnonymizePanel
          templates={all}
          selectedTemplateId="tpl-saved-2"
          onDeleteTemplate={vi.fn()}
        />,
      );

      expect(screen.queryByTestId('confirm-delete-template-btn')).toBeNull();
      expect(screen.getByTestId('delete-template-btn')).toBeDefined();
    });
  });
});
