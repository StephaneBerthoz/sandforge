import React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Sparkles, Settings } from 'lucide-react';
import type { ForgePlanProblem } from '@sandforge/shared';
import { cn } from '../../theme';
import type { ForgeAIPlanState } from './useForgeAIPlan';

/** The sentence each kind of problem is said in. */
const PROBLEM_KEYS: Record<ForgePlanProblem['kind'], string> = {
  'no-from': 'forge.ai.problem.noFrom',
  'object-missing': 'forge.ai.problem.objectMissing',
  'describe-failed': 'forge.ai.problem.describeFailed',
  'field-missing': 'forge.ai.problem.fieldMissing',
  'relationship-missing': 'forge.ai.problem.relationshipMissing',
  'org-refused': 'forge.ai.problem.orgRefused',
};

/** Props for the ForgeAIPanel component. */
export interface ForgeAIPanelProps {
  /** The AI tab's state, from useForgeAIPlan. */
  ai: ForgeAIPlanState;
  /** An AI provider is set up: AI is on and a key is stored. */
  aiAvailable: boolean;
  /** The org the query is read from and checked against; drafting waits for one. */
  sourceOrgId: string;
  /** Open Settings, where the provider is set up. */
  onOpenSettings: () => void;
}

const FIELD_CLASSES = cn(
  'w-full px-3 py-2 rounded-md text-sm resize-y',
  'bg-(--sf-bg-input)',
  'text-(--sf-text-input)',
  'border border-(--sf-border-input)',
  'focus:outline-hidden focus:border-forge/50',
);

/**
 * The AI tab: a description of the records to clone goes to the model, and
 * the query it drafts comes back checked against the source org, in a field
 * the user can edit. Nothing runs from here: the form's Discover button starts
 * discovery, and only once the query as it reads has passed the check.
 */
export const ForgeAIPanel: React.FC<ForgeAIPanelProps> = ({
  ai,
  aiAvailable,
  sourceOrgId,
  onOpenSettings,
}) => {
  const { t } = useTranslation();

  if (!aiAvailable || ai.notConfigured) {
    return (
      <div
        data-testid="forge-ai-not-configured"
        className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-2 p-3"
      >
        <p className="text-sm font-medium text-text-primary">{t('forge.ai.notConfiguredTitle')}</p>
        <p className="text-xs text-text-secondary">{t('forge.ai.notConfiguredBody')}</p>
        <button
          type="button"
          data-testid="forge-ai-open-settings"
          onClick={onOpenSettings}
          className={cn(
            'self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
            'border border-forge/30 bg-forge/5 text-hue-forge hover:bg-forge/10',
          )}
        >
          <Settings size={12} />
          {t('ai.notConfigured.configureButton')}
        </button>
      </div>
    );
  }

  const verdict = ai.verdict;
  const hasDraft = ai.draft.trim().length > 0;
  const canDraft = ai.prompt.trim().length > 0 && sourceOrgId.length > 0 && !ai.busy;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="forge-ai-prompt" className="text-xs font-medium text-text-primary">
        {t('forge.ai.promptLabel')}
      </label>
      <textarea
        id="forge-ai-prompt"
        data-testid="forge-input-ai"
        value={ai.prompt}
        onChange={(e) => ai.setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canDraft) {
            e.preventDefault();
            ai.requestDraft();
          }
        }}
        placeholder={t('forge.ai.promptPlaceholder')}
        rows={3}
        maxLength={2000}
        aria-describedby={sourceOrgId ? undefined : 'forge-ai-need-source'}
        className={FIELD_CLASSES}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="forge-ai-draft-btn"
          disabled={!canDraft}
          onClick={ai.requestDraft}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
            'border border-forge/30 bg-forge/5 text-hue-forge hover:bg-forge/10',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          )}
        >
          {ai.busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {t('forge.ai.draft')}
        </button>
        {!sourceOrgId && (
          <span id="forge-ai-need-source" className="text-[10px] text-text-secondary">
            {t('forge.ai.needSource')}
          </span>
        )}
      </div>
      <p role="status" data-testid="forge-ai-busy" className="text-[10px] text-text-secondary">
        {ai.busy ? t('forge.ai.busy') : ''}
      </p>

      {ai.error && (
        <p role="alert" data-testid="forge-ai-error" className="text-xs text-status-error">
          {t('forge.ai.failed', { message: ai.error })}
        </p>
      )}

      {(hasDraft || verdict) && (
        <div className="flex flex-col gap-1.5 mt-1">
          {verdict?.rootObject && (
            <p data-testid="forge-ai-root" className="text-xs text-text-primary">
              {t('forge.ai.rootObject', {
                label: verdict.rootLabel ?? verdict.rootObject,
                object: verdict.rootObject,
              })}
            </p>
          )}
          <label htmlFor="forge-ai-query" className="text-xs font-medium text-text-primary">
            {t('forge.ai.queryLabel')}
          </label>
          <textarea
            id="forge-ai-query"
            data-testid="forge-ai-query"
            value={ai.draft}
            onChange={(e) => ai.setDraft(e.target.value)}
            rows={4}
            aria-describedby="forge-ai-verdict"
            className={cn(FIELD_CLASSES, 'font-mono')}
          />
          {verdict?.explanation && (
            <p data-testid="forge-ai-explanation" className="text-xs text-text-secondary">
              {verdict.explanation}
            </p>
          )}
          <div id="forge-ai-verdict">
            {ai.checked && verdict && (
              <p
                role="status"
                data-testid="forge-ai-checked"
                className="text-xs text-status-success"
              >
                {t('forge.ai.checked', {
                  object: verdict.rootObject,
                  count: verdict.fieldsChecked,
                })}
              </p>
            )}
            {ai.stale && (
              <p role="status" data-testid="forge-ai-stale" className="text-xs text-status-warning">
                {t('forge.ai.stale')}
              </p>
            )}
            {verdict && !ai.stale && !verdict.success && (
              <div
                role="alert"
                data-testid="forge-ai-problems"
                className="text-xs text-status-error"
              >
                <p>{t('forge.ai.problemsTitle')}</p>
                <ul className="list-disc ml-4">
                  {verdict.problems.map((problem, index) => (
                    <li key={`${problem.kind}-${index}`}>
                      {t(PROBLEM_KEYS[problem.kind], problem)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          {hasDraft && !ai.checked && (
            <button
              type="button"
              data-testid="forge-ai-recheck"
              disabled={ai.busy || !sourceOrgId}
              onClick={ai.recheck}
              className={cn(
                'self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
                'border border-subtle text-text-primary hover:border-forge/50',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              {t('forge.ai.recheck')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
