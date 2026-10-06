import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BUILTIN_FORGE_TEMPLATES } from '@sandforge/shared';
import type { ForgeTemplate } from '@sandforge/shared';
import i18n from '../../i18n';
import { ForgeTemplatePanel } from './ForgeTemplatePanel';
import type { ForgeTemplatesManager } from './useForgeTemplates';

const SAVED: ForgeTemplate = {
  id: 'tpl-1',
  name: 'Open cases',
  description: '',
  config: {
    inputMode: 'soql',
    soqlQuery: "SELECT Id FROM Case WHERE Status = 'New'",
    depth: 'direct',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
  },
  objectCount: 3,
  recordCount: 40,
  createdAt: '2026-09-01T08:00:00.000Z',
  lastUsedAt: '2026-09-01T08:00:00.000Z',
};

function manager(overrides: Partial<ForgeTemplatesManager> = {}): ForgeTemplatesManager {
  return {
    templates: [SAVED],
    loadError: null,
    importNotMerged: null,
    editingTemplateId: null,
    editName: '',
    setEditName: vi.fn(),
    editDescription: '',
    setEditDescription: vi.fn(),
    handleStartEdit: vi.fn(),
    handleSaveEdit: vi.fn(),
    handleCancelEdit: vi.fn(),
    saving: false,
    saveError: null,
    deleteConfirmId: null,
    requestDeleteTemplate: vi.fn(),
    cancelDeleteTemplate: vi.fn(),
    handleDeleteTemplate: vi.fn(),
    deleteError: null,
    exportTemplate: vi.fn(),
    importTemplateFile: vi.fn(),
    importRefused: null,
    importError: null,
    imported: null,
    ...overrides,
  };
}

function renderPanel(m: ForgeTemplatesManager, selectedTemplate = '') {
  const onSelectTemplate = vi.fn();
  const onApplyTemplate = vi.fn().mockReturnValue('none');
  render(
    <ForgeTemplatePanel
      manager={m}
      selectedTemplate={selectedTemplate}
      onSelectTemplate={onSelectTemplate}
      onApplyTemplate={onApplyTemplate}
      orgs={[]}
    />,
  );
  return { onSelectTemplate, onApplyTemplate };
}

describe('ForgeTemplatePanel', () => {
  it('marks which starter template is selected, for a screen reader too', () => {
    const starter = BUILTIN_FORGE_TEMPLATES[0];
    const { onSelectTemplate } = renderPanel(manager(), starter.id);

    const button = screen.getByTestId(`forge-template-builtin-${starter.id}`);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(onSelectTemplate).toHaveBeenCalledWith(starter.id);
  });

  it('applies a saved template, and says so without naming a target it does not have', () => {
    const { onApplyTemplate } = renderPanel(manager());

    fireEvent.click(screen.getByTestId('forge-template-apply-tpl-1'));

    expect(onApplyTemplate).toHaveBeenCalledWith(SAVED);
    expect(screen.getByTestId('forge-template-applied').textContent).toBe(
      i18n.t('forge.savedTemplate.applied', { name: 'Open cases' }),
    );
  });

  it('labels the rename fields and says why a rename failed', () => {
    renderPanel(
      manager({
        editingTemplateId: 'tpl-1',
        editName: 'Open cases',
        saveError: 'EROFS: read-only file system',
      }),
    );

    expect(screen.getByLabelText(i18n.t('forge.templateName'))).toBeDefined();
    expect(screen.getByLabelText(i18n.t('forge.templateDescription'))).toBeDefined();
    expect(screen.getByTestId('forge-template-save-error').textContent).toBe(
      i18n.t('forge.savedTemplate.saveFailed', { message: 'EROFS: read-only file system' }),
    );
  });

  it('holds the rename while its name is empty or a save is in flight', () => {
    const { unmount } = render(
      <ForgeTemplatePanel
        manager={manager({ editingTemplateId: 'tpl-1', editName: '  ' })}
        selectedTemplate=""
        onSelectTemplate={vi.fn()}
        onApplyTemplate={vi.fn()}
        orgs={[]}
      />,
    );
    expect((screen.getByTestId('forge-template-edit-save') as HTMLButtonElement).disabled).toBe(
      true,
    );
    unmount();

    renderPanel(manager({ editingTemplateId: 'tpl-1', editName: 'Open cases', saving: true }));
    expect((screen.getByTestId('forge-template-edit-save') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('says why a delete failed, and when the list could not be loaded', () => {
    renderPanel(
      manager({
        templates: [],
        deleteError: 'EACCES: permission denied',
        loadError: 'timed out',
      }),
    );

    expect(screen.getByTestId('forge-template-delete-error').textContent).toBe(
      i18n.t('forge.savedTemplate.deleteFailed', { message: 'EACCES: permission denied' }),
    );
    expect(screen.getByTestId('forge-templates-load-error').textContent).toBe(
      i18n.t('forge.savedTemplate.loadFailed'),
    );
  });

  it('says why the templates imported for the workspace are not listed, beside the ones that are', () => {
    renderPanel(manager({ importNotMerged: 'EROFS: read-only file system' }));

    expect(screen.getByTestId('forge-templates-import-not-merged').textContent).toBe(
      i18n.t('forge.savedTemplate.importNotMerged', { message: 'EROFS: read-only file system' }),
    );
    expect(screen.getByTestId('forge-template-tpl-1')).toBeTruthy();
    expect(screen.queryByTestId('forge-templates-load-error')).toBeNull();
  });

  describe('a template as a file', () => {
    it('exports a saved template from its row, named for a screen reader', () => {
      const m = manager();
      renderPanel(m);
      const exportButton = screen.getByTestId('forge-template-export-tpl-1');

      expect(exportButton.getAttribute('aria-label')).toBe('Export Open cases to a file');
      fireEvent.click(exportButton);
      expect(m.exportTemplate).toHaveBeenCalledWith(SAVED);
    });

    it('hands the file picked to the import', () => {
      const m = manager();
      renderPanel(m);
      const picked = new File(['{}'], 'shared.json', { type: 'application/json' });

      fireEvent.change(screen.getByTestId('forge-template-import-file'), {
        target: { files: [picked] },
      });
      expect(m.importTemplateFile).toHaveBeenCalledWith(picked);
    });

    it('says why a file was refused, naming the part the schema refused', () => {
      renderPanel(manager({ importRefused: { reason: 'not_template', where: 'config.depth' } }));
      expect(screen.getByTestId('forge-template-import-refused').textContent).toBe(
        'This file is not a SandForge template: config.depth is missing or not valid.',
      );
    });

    it('says what each refusal is', () => {
      const { unmount } = render(
        <ForgeTemplatePanel
          manager={manager({ importRefused: { reason: 'not_json' } })}
          selectedTemplate=""
          onSelectTemplate={vi.fn()}
          onApplyTemplate={vi.fn()}
          orgs={[]}
        />,
      );
      expect(screen.getByTestId('forge-template-import-refused').textContent).toBe(
        'This file is not JSON: it holds no template.',
      );
      unmount();
      renderPanel(manager({ importRefused: { reason: 'not_template', where: '' } }));
      expect(screen.getByTestId('forge-template-import-refused').textContent).toBe(
        'This file does not hold a template.',
      );
    });

    it('says a template was imported, or why the extension did not keep it', () => {
      const { unmount } = render(
        <ForgeTemplatePanel
          manager={manager({ imported: SAVED })}
          selectedTemplate=""
          onSelectTemplate={vi.fn()}
          onApplyTemplate={vi.fn()}
          orgs={[]}
        />,
      );
      expect(screen.getByTestId('forge-template-imported').textContent).toBe(
        '“Open cases” imported: it is listed under Your templates.',
      );
      unmount();
      renderPanel(manager({ importError: 'EROFS: read-only file system' }));
      expect(screen.getByTestId('forge-template-import-error').textContent).toBe(
        'The template was not imported: EROFS: read-only file system',
      );
    });
  });
});
