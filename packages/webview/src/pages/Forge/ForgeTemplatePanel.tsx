import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, Check, Pencil, Trash2 } from 'lucide-react';
import { BUILTIN_FORGE_TEMPLATES } from '@sandforge/shared';
import { cn } from '../../theme';
import type { ForgeTemplate } from '../../stores/useForgeStore';
import type { ForgeTemplatesManager } from './useForgeTemplates';

/** Props for the ForgeTemplatePanel component. */
export interface ForgeTemplatePanelProps {
  /** Template CRUD state and handlers from useForgeTemplates. */
  manager: ForgeTemplatesManager;
  /** Currently selected template id. */
  selectedTemplate: string;
  /** Select a template as the form input. */
  onSelectTemplate: (id: string) => void;
  /** Snapshot the current form state for the create-template action. */
  buildTemplateConfig: () => ForgeTemplate['config'];
}

/**
 * Template tab content: create-template form, read-only builtin starter
 * templates, and user-created templates with edit/delete affordances.
 */
export const ForgeTemplatePanel: React.FC<ForgeTemplatePanelProps> = ({
  manager,
  selectedTemplate,
  onSelectTemplate,
  buildTemplateConfig,
}) => {
  const { t } = useTranslation();

  return (
    <div data-testid="forge-input-template" className="flex flex-col gap-2">
      {/* Create template button/form */}
      {manager.showCreateForm ? (
        <div className="flex flex-col gap-2 p-3 rounded-md border border-forge/30 bg-forge/5">
          <input
            type="text"
            data-testid="forge-template-name-input"
            value={manager.newTemplateName}
            onChange={(e) => manager.setNewTemplateName(e.target.value)}
            placeholder={t('forge.templateName')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm',
              'bg-[var(--vscode-input-background,#1e1e3a)]',
              'text-[var(--vscode-input-foreground,#d4d4d4)]',
              'border border-[var(--vscode-input-border,#3a3a5c)]',
              'focus:outline-none focus:border-forge/50',
            )}
          />
          <input
            type="text"
            data-testid="forge-template-desc-input"
            value={manager.newTemplateDescription}
            onChange={(e) => manager.setNewTemplateDescription(e.target.value)}
            placeholder={t('forge.templateDescription')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm',
              'bg-[var(--vscode-input-background,#1e1e3a)]',
              'text-[var(--vscode-input-foreground,#d4d4d4)]',
              'border border-[var(--vscode-input-border,#3a3a5c)]',
              'focus:outline-none focus:border-forge/50',
            )}
          />
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="forge-template-save"
              onClick={() => manager.handleCreateTemplate(buildTemplateConfig())}
              disabled={!manager.newTemplateName.trim()}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-forge text-white disabled:opacity-40"
            >
              <Check size={12} />
              {t('forge.createTemplate')}
            </button>
            <button
              type="button"
              data-testid="forge-template-cancel"
              onClick={manager.cancelCreateForm}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs text-text-muted hover:text-text-primary"
            >
              <X size={12} />
              {t('forge.cancelEdit')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="forge-template-create"
          onClick={manager.openCreateForm}
          className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm border border-dashed border-subtle text-text-muted hover:text-forge hover:border-forge/30 transition-colors"
        >
          <Plus size={14} />
          {t('forge.createTemplate')}
        </button>
      )}

      {/* Starter (builtin) templates section header */}
      {BUILTIN_FORGE_TEMPLATES.length > 0 && (
        <div className="text-[10px] text-text-muted uppercase tracking-widest mt-1">
          {t('forge.starterTemplates')}
        </div>
      )}
      {/* Builtin templates — read-only, no edit/delete */}
      {BUILTIN_FORGE_TEMPLATES.map((tpl) => (
        <button
          key={tpl.id}
          type="button"
          data-testid={`forge-template-builtin-${tpl.id}`}
          onClick={() => onSelectTemplate(tpl.id)}
          className={cn(
            'flex items-start gap-2 px-3 py-2 rounded-md text-sm border transition-colors text-left',
            selectedTemplate === tpl.id
              ? 'border-forge bg-forge/10 text-text-primary'
              : 'border-subtle bg-surface-2 text-text-secondary hover:border-forge/30',
          )}
        >
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{tpl.name}</span>
              <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-forge/20 text-forge font-semibold uppercase tracking-wider">
                {t('forge.starterBadge')}
              </span>
              {tpl.config.maxRecordsPerObject != null && (
                <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 font-mono">
                  ≤ {tpl.config.maxRecordsPerObject}/obj
                </span>
              )}
            </div>
            {tpl.description && (
              <span className="block text-xs text-text-muted mt-0.5">{tpl.description}</span>
            )}
          </div>
        </button>
      ))}

      {/* User templates section header (only if there are any) */}
      {manager.templates.length > 0 && (
        <div className="text-[10px] text-text-muted uppercase tracking-widest mt-2">
          {t('forge.yourTemplates')}
        </div>
      )}
      {/* User-created templates with full edit/delete affordance */}
      {manager.templates.length === 0 && !manager.showCreateForm ? (
        <p className="text-sm text-text-muted italic">{t('forge.noTemplates')}</p>
      ) : (
        manager.templates.map((tpl) => (
          <div
            key={tpl.id}
            className={cn(
              'flex items-start gap-2 px-3 py-2 rounded-md text-sm border transition-colors',
              selectedTemplate === tpl.id
                ? 'border-forge bg-forge/10 text-text-primary'
                : 'border-subtle bg-surface-2 text-text-secondary hover:border-forge/30',
            )}
          >
            {manager.editingTemplateId === tpl.id ? (
              <div className="flex-1 flex flex-col gap-1">
                <input
                  type="text"
                  value={manager.editName}
                  onChange={(e) => manager.setEditName(e.target.value)}
                  data-testid="forge-template-edit-name"
                  className={cn(
                    'px-2 py-1 rounded text-sm',
                    'bg-[var(--vscode-input-background,#1e1e3a)]',
                    'text-[var(--vscode-input-foreground,#d4d4d4)]',
                    'border border-[var(--vscode-input-border,#3a3a5c)]',
                  )}
                />
                <input
                  type="text"
                  value={manager.editDescription}
                  onChange={(e) => manager.setEditDescription(e.target.value)}
                  data-testid="forge-template-edit-desc"
                  className={cn(
                    'px-2 py-1 rounded text-xs',
                    'bg-[var(--vscode-input-background,#1e1e3a)]',
                    'text-[var(--vscode-input-foreground,#d4d4d4)]',
                    'border border-[var(--vscode-input-border,#3a3a5c)]',
                  )}
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={manager.handleSaveEdit}
                    data-testid="forge-template-edit-save"
                    className="text-forge text-xs hover:underline"
                  >
                    <Check size={12} className="inline" /> {t('forge.saveTemplate')}
                  </button>
                  <button
                    type="button"
                    onClick={manager.handleCancelEdit}
                    className="text-text-muted text-xs hover:underline"
                  >
                    <X size={12} className="inline" /> {t('forge.cancelEdit')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onSelectTemplate(tpl.id)}
                  className="flex-1 text-left"
                >
                  <span className="font-medium">{tpl.name}</span>
                  {tpl.description && (
                    <span className="block text-xs text-text-muted mt-0.5">{tpl.description}</span>
                  )}
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    data-testid={`forge-template-edit-${tpl.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      manager.handleStartEdit(tpl);
                    }}
                    className="p-1 text-text-muted hover:text-text-primary transition-colors rounded hover:bg-surface-2"
                    title={t('forge.editTemplate')}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    data-testid={`forge-template-delete-${tpl.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      manager.requestDeleteTemplate(tpl.id);
                    }}
                    className="p-1 text-text-muted hover:text-red-400 transition-colors rounded hover:bg-red-500/10"
                    title={t('forge.deleteTemplate')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))
      )}
    </div>
  );
};
