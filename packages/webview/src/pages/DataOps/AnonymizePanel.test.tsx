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

  describe('previewing a template', () => {
    // Preview and Apply were wired to one handler, so "Preview" ran the
    // irreversible org write; then it sat disabled under "Coming soon", and
    // then it was gone. It asks a read-only request of its own now.
    const preview = {
      templateId: 'tpl-1',
      objects: [
        {
          objectApiName: 'Contact',
          fields: ['Email', 'Phone'],
          rows: [
            {
              id: '003000000000001',
              before: { Email: 'ada@example.org', Phone: null },
              after: { Email: '***@*******.***', Phone: null },
            },
          ],
        },
        { objectApiName: 'Lead', fields: [], rows: [], error: 'INVALID_TYPE: no Lead here' },
      ],
      fieldsNotFound: [{ objectApiName: 'Contact', fieldApiName: 'Loyalty__c' }],
    };

    it('asks for a preview of the template on screen, with no confirmation, since it writes nothing', () => {
      const onPreview = vi.fn();
      const onApply = vi.fn();
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-1"
          onPreview={onPreview}
          onApply={onApply}
        />,
      );
      fireEvent.click(screen.getByTestId('preview-btn'));
      expect(onPreview).toHaveBeenCalledWith('tpl-1');
      expect(onApply).not.toHaveBeenCalled();
      expect(screen.queryByTestId('danger-title')).toBeNull();
      expect(screen.queryByText('Coming soon')).toBeNull();
    });

    it('shows each masked field of each record, the original beside the masked value', () => {
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-1"
          onPreview={vi.fn()}
          preview={preview}
        />,
      );
      const contact = within(screen.getByTestId('preview-object-Contact'));
      const headers = contact.getAllByRole('columnheader').map((th) => th.textContent);
      expect(headers).toEqual(['Record', 'Field', 'Original', 'Masked']);
      const emailRow = contact.getByText('ada@example.org').closest('tr') as HTMLElement;
      expect(within(emailRow).getByText('003000000000001')).toBeDefined();
      expect(within(emailRow).getByText('***@*******.***')).toBeDefined();
      // An empty field says so on both sides: Apply writes nothing into it.
      const phoneRow = contact.getByText('Phone').closest('tr') as HTMLElement;
      expect(within(phoneRow).getAllByText('(empty)')).toHaveLength(2);
      expect(screen.getByTestId('preview-object-Lead').textContent).toContain(
        'Not read: INVALID_TYPE: no Lead here',
      );
      expect(screen.getByTestId('preview-fields-not-found').textContent).toContain(
        'Contact.Loyalty__c',
      );
    });

    it('shows no preview taken for another template', () => {
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-saved-1"
          onPreview={vi.fn()}
          preview={preview}
        />,
      );
      expect(screen.queryByTestId('preview-data')).toBeNull();
    });

    it('holds Preview while a run masks the org', () => {
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-1"
          onPreview={vi.fn()}
          isApplying
        />,
      );
      expect((screen.getByTestId('preview-btn') as HTMLButtonElement).disabled).toBe(true);
    });
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

  describe('what a restore can bring back', () => {
    // A backup reads each object up to a cap of rows, and a masking run masks
    // every row: the rows past the cap stay masked whatever is restored.
    const coverage = {
      templateId: 'tpl-1',
      backup: { operationId: 'bk-1', timestamp: '2026-10-01T10:00:00.000Z' },
      objects: [
        { objectApiName: 'Contact', count: 30000, backedUp: 2000, truncated: true },
        { objectApiName: 'Lead', count: null, backedUp: 0, truncated: false },
        { objectApiName: 'Account', count: 120, backedUp: 120, truncated: false },
      ],
    };

    it('sets, before Apply, each object’s rows in the org against those the latest backup holds', () => {
      render(
        <AnonymizePanel templates={templates} selectedTemplateId="tpl-1" coverage={coverage} />,
      );

      const box = screen.getByTestId('restore-coverage');
      expect(within(box).getByText('What a restore can bring back')).toBeDefined();
      expect(screen.getByTestId('restore-coverage-backup').textContent).toMatch(
        /^Latest backup of this org: .+\. A restore brings back the rows it holds, and no others\.$/,
      );
      const contact = within(screen.getByTestId('restore-coverage-Contact'));
      expect(contact.getByText('30,000')).toBeDefined();
      expect(contact.getByText('2,000')).toBeDefined();
      expect(
        within(screen.getByTestId('restore-coverage-Lead')).getByText('Not counted'),
      ).toBeDefined();
      // Named where a restore leaves rows masked: past the cap, and only there.
      expect(screen.getByTestId('restore-coverage-shortfall').textContent).toBe(
        'Masked for good past what the backup holds: Contact.',
      );
      // Said ahead of the button that masks.
      expect(
        box.compareDocumentPosition(screen.getByTestId('apply-btn')) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('says the org has no backup to bring anything back from', () => {
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-1"
          coverage={{
            templateId: 'tpl-1',
            objects: [{ objectApiName: 'Contact', count: 5, backedUp: 0, truncated: false }],
          }}
        />,
      );

      expect(screen.getByTestId('restore-coverage-backup').textContent).toBe(
        'This org has no backup on this machine: once masked, no value can be brought back.',
      );
      expect(screen.getByTestId('restore-coverage-shortfall').textContent).toContain('Contact');
    });

    it('shows no answer given for another template than the one on screen', () => {
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-saved-1"
          coverage={coverage}
        />,
      );
      expect(screen.queryByTestId('restore-coverage')).toBeNull();
    });

    it('names in the confirmation the objects and records a restore can never bring back', () => {
      // 1 220 contacts on a Developer Edition, 500 backed up: the confirmation
      // said only 'Anonymize sensitive data'.
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-1"
          coverage={{
            templateId: 'tpl-1',
            backup: { operationId: 'bk-1', timestamp: '2026-10-01T10:00:00.000Z' },
            objects: [
              { objectApiName: 'Contact', count: 1220, backedUp: 500, truncated: true },
              { objectApiName: 'Lead', count: 1, backedUp: 0, truncated: false },
              { objectApiName: 'Account', count: 120, backedUp: 120, truncated: false },
            ],
          }}
        />,
      );

      fireEvent.click(screen.getByTestId('apply-btn'));

      const lost = screen.getByTestId('confirm-unrestorable');
      expect(lost.textContent).toContain(
        'Once masked, these records can never be brought back by a restore:',
      );
      expect(
        within(lost)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Contact: 720 records', 'Lead: 1 record']);
    });

    it('names an object the org did not count when no backup holds it', () => {
      render(
        <AnonymizePanel templates={templates} selectedTemplateId="tpl-1" coverage={coverage} />,
      );

      fireEvent.click(screen.getByTestId('apply-btn'));

      expect(
        within(screen.getByTestId('confirm-unrestorable'))
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Contact: 28,000 records', 'Lead: Not counted']);
    });

    it('says nothing more in the confirmation when the backup holds every record', () => {
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-1"
          coverage={{
            templateId: 'tpl-1',
            backup: { operationId: 'bk-1', timestamp: '2026-10-01T10:00:00.000Z' },
            objects: [{ objectApiName: 'Contact', count: 120, backedUp: 120, truncated: false }],
          }}
        />,
      );

      fireEvent.click(screen.getByTestId('apply-btn'));

      expect(screen.getByTestId('danger-title')).toBeDefined();
      expect(screen.queryByTestId('confirm-unrestorable')).toBeNull();
    });
  });

  describe('a run that stopped short', () => {
    const stopped = {
      templateId: 'tpl-1',
      objects: [{ objectApiName: 'Contact', count: 2500, backedUp: 2500, truncated: false }],
      checkpoint: { id: 'run-1', savedAt: '2026-10-09T10:00:00.000Z' },
    };

    it('offers to resume it beside Apply, and resumes it once the confirmation word is typed', () => {
      const onApply = vi.fn();
      const onResume = vi.fn();
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-1"
          coverage={stopped}
          onApply={onApply}
          onResume={onResume}
        />,
      );
      expect(screen.getByTestId('resume-hint').textContent).toMatch(
        /^The run of .+ stopped before the end\. Resume masks only what it left; Apply masks every record again\.$/,
      );

      fireEvent.click(screen.getByTestId('resume-btn'));
      expect(onResume).not.toHaveBeenCalled();
      expect(screen.getByTestId('danger-title').textContent).toBe('Resume where it stopped');
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Anonymize' } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(onResume).toHaveBeenCalledWith('tpl-1', 'run-1');
      expect(onApply).not.toHaveBeenCalled();
    });

    it('still applies the template whole from Apply', () => {
      const onApply = vi.fn();
      const onResume = vi.fn();
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-1"
          coverage={stopped}
          onApply={onApply}
          onResume={onResume}
        />,
      );

      fireEvent.click(screen.getByTestId('apply-btn'));
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Anonymize' } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(onApply).toHaveBeenCalledWith('tpl-1');
      expect(onResume).not.toHaveBeenCalled();
    });

    it('offers no resume without a run that stopped, nor for another template', () => {
      const { rerender } = render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-1"
          coverage={{ ...stopped, checkpoint: undefined }}
          onResume={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('resume-btn')).toBeNull();

      rerender(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-saved-1"
          coverage={stopped}
          onResume={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('resume-btn')).toBeNull();
      expect(screen.queryByTestId('resume-hint')).toBeNull();
    });

    it('holds Resume while a run goes on', () => {
      render(
        <AnonymizePanel
          templates={templates}
          selectedTemplateId="tpl-1"
          coverage={stopped}
          onResume={vi.fn()}
          isApplying
        />,
      );
      expect((screen.getByTestId('resume-btn') as HTMLButtonElement).disabled).toBe(true);
    });
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
