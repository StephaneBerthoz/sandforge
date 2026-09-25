import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Check, Pencil, Trash2 } from 'lucide-react';
import { BUILTIN_FORGE_TEMPLATES } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { cn } from '../../theme';
import type { ForgeTemplate } from '../../stores/useForgeStore';
import type { ForgeTemplatesManager } from './useForgeTemplates';
import { DEPTH_KEYS } from './useForgeForm';
import type { TemplateTargetOutcome } from './useForgeForm';
import { INPUT_MODE_KEYS, configSubject } from './forgeRunConfig';

/** Props for the ForgeTemplatePanel component. */
export interface ForgeTemplatePanelProps {
  /** Saved-template state and handlers from useForgeTemplates. */
  manager: ForgeTemplatesManager;
  /** Currently selected template id. */
  selectedTemplate: string;
  /** Select a starter template; the root record is asked for below the list. */
  onSelectTemplate: (id: string) => void;
  /** Apply a saved template to the form; says what became of its target org. */
  onApplyTemplate: (template: ForgeTemplate) => TemplateTargetOutcome;
  /** Connected orgs, to name the org a template writes to. */
  orgs: SalesforceOrg[];
}

/** What the last apply did, as the status line says it. */
interface AppliedTemplate {
  name: string;
  target: TemplateTargetOutcome;
  targetLabel: string;
}

/** The name an org is shown under. */
function orgLabel(org: SalesforceOrg): string {
  return org.alias || org.username;
}

/**
 * Template tab content: the read-only starter templates, then the templates
 * saved from finished runs, each with apply, rename and delete.
 *
 * A template is saved from a run's results, where its configuration is whole.
 * The tab used to offer "Create Template" from the form instead, and on this
 * tab the form's input mode is `template` itself: every template made that
 * way kept neither a record id nor a query. Selected, it ran on whatever
 * record id the Record tab still held, out of sight, or could not run at all.
 */
export const ForgeTemplatePanel: React.FC<ForgeTemplatePanelProps> = ({
  manager,
  selectedTemplate,
  onSelectTemplate,
  onApplyTemplate,
  orgs,
}) => {
  const { t } = useTranslation();
  const [applied, setApplied] = useState<AppliedTemplate | null>(null);

  const targetLabelOf = (tpl: ForgeTemplate): string | null => {
    if (!tpl.targetOrgId) return null;
    const org = orgs.find((o) => o.id === tpl.targetOrgId);
    return org ? orgLabel(org) : t('forge.savedTemplate.targetNotConnected');
  };

  const apply = (tpl: ForgeTemplate): void => {
    const target = onApplyTemplate(tpl);
    const org = orgs.find((o) => o.id === tpl.targetOrgId);
    setApplied({ name: tpl.name, target, targetLabel: org ? orgLabel(org) : '' });
  };

  return (
    <div data-testid="forge-input-template" className="flex flex-col gap-2">
      {/* Starter (builtin) templates section header */}
      {BUILTIN_FORGE_TEMPLATES.length > 0 && (
        <div className="text-[10px] text-text-secondary uppercase tracking-widest">
          {t('forge.starterTemplates')}
        </div>
      )}
      {/* Builtin templates — read-only, no edit/delete */}
      {BUILTIN_FORGE_TEMPLATES.map((tpl) => (
        <button
          key={tpl.id}
          type="button"
          data-testid={`forge-template-builtin-${tpl.id}`}
          aria-pressed={selectedTemplate === tpl.id}
          onClick={() => {
            setApplied(null);
            onSelectTemplate(tpl.id);
          }}
          className={cn(
            'flex items-start gap-2 px-3 py-2 rounded-md text-sm border transition-colors text-left',
            // The border marks the selection; the tint stays light enough for the
            // badges' own tints to be laid over it.
            selectedTemplate === tpl.id
              ? 'border-forge bg-forge/5 text-text-primary'
              : 'border-subtle bg-surface-2 text-text-secondary hover:border-forge/30',
          )}
        >
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{tpl.name}</span>
              <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-sm bg-forge/10 text-hue-forge font-semibold uppercase tracking-wider">
                {t('forge.starterBadge')}
              </span>
              {tpl.config.maxRecordsPerObject != null && (
                <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-sm bg-status-warning/10 text-status-warning font-mono">
                  ≤ {tpl.config.maxRecordsPerObject}/obj
                </span>
              )}
            </div>
            {tpl.description && (
              <span
                className={cn(
                  'block text-xs mt-0.5',
                  selectedTemplate === tpl.id ? 'text-text-primary' : 'text-text-secondary',
                )}
              >
                {tpl.description}
              </span>
            )}
          </div>
        </button>
      ))}

      <div className="text-[10px] text-text-secondary uppercase tracking-widest mt-2">
        {t('forge.yourTemplates')}
      </div>
      {manager.loadError && (
        <p
          data-testid="forge-templates-load-error"
          role="status"
          className="text-xs text-text-secondary"
        >
          {t('forge.savedTemplate.loadFailed')}
        </p>
      )}
      {manager.importNotMerged && (
        <p
          data-testid="forge-templates-import-not-merged"
          role="status"
          className="text-xs text-text-secondary"
        >
          {t('forge.savedTemplate.importNotMerged', { message: manager.importNotMerged })}
        </p>
      )}
      {manager.templates.length === 0 ? (
        <p className="text-sm text-text-secondary italic" data-testid="forge-templates-empty">
          {t('forge.noTemplates')}
        </p>
      ) : (
        manager.templates.map((tpl) => {
          const selected = selectedTemplate === tpl.id;
          const subject = configSubject(tpl.config);
          const target = targetLabelOf(tpl);
          return (
            <div
              key={tpl.id}
              data-testid={`forge-template-${tpl.id}`}
              className={cn(
                'flex items-start gap-2 px-3 py-2 rounded-md text-sm border transition-colors',
                selected
                  ? 'border-forge bg-forge/5 text-text-primary'
                  : 'border-subtle bg-surface-2 text-text-secondary hover:border-forge/30',
              )}
            >
              {manager.editingTemplateId === tpl.id ? (
                <div className="flex-1 flex flex-col gap-1">
                  <input
                    type="text"
                    value={manager.editName}
                    onChange={(e) => manager.setEditName(e.target.value)}
                    aria-label={t('forge.templateName')}
                    maxLength={120}
                    data-testid="forge-template-edit-name"
                    className={cn(
                      'px-2 py-1 rounded-sm text-sm',
                      'bg-(--sf-bg-input)',
                      'text-(--sf-text-input)',
                      'border border-(--sf-border-input)',
                    )}
                  />
                  <input
                    type="text"
                    value={manager.editDescription}
                    onChange={(e) => manager.setEditDescription(e.target.value)}
                    aria-label={t('forge.templateDescription')}
                    maxLength={500}
                    data-testid="forge-template-edit-desc"
                    className={cn(
                      'px-2 py-1 rounded-sm text-xs',
                      'bg-(--sf-bg-input)',
                      'text-(--sf-text-input)',
                      'border border-(--sf-border-input)',
                    )}
                  />
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={manager.handleSaveEdit}
                      disabled={!manager.editName.trim() || manager.saving}
                      data-testid="forge-template-edit-save"
                      className="text-hue-forge text-xs hover:underline disabled:opacity-40"
                    >
                      <Check size={12} className="inline" /> {t('common.save')}
                    </button>
                    <button
                      type="button"
                      onClick={manager.handleCancelEdit}
                      className={cn(
                        'text-xs hover:underline',
                        selected ? 'text-text-primary' : 'text-text-secondary',
                      )}
                    >
                      <X size={12} className="inline" /> {t('forge.cancelEdit')}
                    </button>
                  </div>
                  {manager.saveError && (
                    <p
                      role="alert"
                      data-testid="forge-template-save-error"
                      className="text-xs text-status-error"
                    >
                      {t('forge.savedTemplate.saveFailed', { message: manager.saveError })}
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    data-testid={`forge-template-apply-${tpl.id}`}
                    aria-pressed={selected}
                    onClick={() => apply(tpl)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <span className="font-medium">{tpl.name}</span>
                    {tpl.description && (
                      <span
                        className={cn(
                          'block text-xs mt-0.5',
                          selected ? 'text-text-primary' : 'text-text-secondary',
                        )}
                      >
                        {tpl.description}
                      </span>
                    )}
                    <span
                      data-testid={`forge-template-summary-${tpl.id}`}
                      className={cn(
                        'block text-[11px] mt-0.5 truncate',
                        selected ? 'text-text-primary' : 'text-text-secondary',
                      )}
                    >
                      {[
                        t(INPUT_MODE_KEYS[tpl.config.inputMode]),
                        subject,
                        t(DEPTH_KEYS[tpl.config.depth]),
                        target && t('forge.savedTemplate.summaryTarget', { org: target }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      data-testid={`forge-template-edit-${tpl.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        manager.handleStartEdit(tpl);
                      }}
                      className="p-1 text-text-secondary hover:text-text-primary transition-colors rounded-sm hover:bg-surface-2"
                      aria-label={t('forge.savedTemplate.renameLabel', { name: tpl.name })}
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
                      className="p-1 text-text-secondary hover:text-status-error transition-colors rounded-sm hover:bg-status-error/10"
                      aria-label={t('forge.savedTemplate.deleteLabel', { name: tpl.name })}
                      title={t('forge.deleteTemplate')}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })
      )}
      {manager.deleteError && (
        <p
          role="alert"
          data-testid="forge-template-delete-error"
          className="text-xs text-status-error"
        >
          {t('forge.savedTemplate.deleteFailed', { message: manager.deleteError })}
        </p>
      )}
      {applied && (
        <p role="status" data-testid="forge-template-applied" className="text-xs text-text-primary">
          {t('forge.savedTemplate.applied', { name: applied.name })}
          {applied.target === 'set' &&
            ` ${t('forge.savedTemplate.targetSet', { org: applied.targetLabel })}`}
          {applied.target === 'missing' && ` ${t('forge.savedTemplate.targetMissing')}`}
        </p>
      )}
    </div>
  );
};
