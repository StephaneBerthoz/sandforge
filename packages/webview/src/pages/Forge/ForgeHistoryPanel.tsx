import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { RotateCcw } from 'lucide-react';
import { cn } from '../../theme';
import type { ForgeExecutionResult, ForgeInputMode } from '../../stores/useForgeStore';
import { DEPTH_KEYS } from './useForgeForm';
import type { ForgeRunConfig } from './useForgeForm';

/** Map a run's outcome to its i18n key. */
const STATUS_KEYS: Record<ForgeExecutionResult['status'], string> = {
  success: 'forge.history.statusSuccess',
  partial: 'forge.history.statusPartial',
  failure: 'forge.history.statusFailure',
};

/** Map a run's outcome to the colour it is shown in. */
const STATUS_CLASSES: Record<ForgeExecutionResult['status'], string> = {
  success: 'text-status-success',
  partial: 'text-status-warning',
  failure: 'text-status-error',
};

/** Map the stored input mode to the tab label it was run from. */
const MODE_KEYS: Record<ForgeInputMode, string> = {
  record: 'forge.recordTab',
  soql: 'forge.soqlTab',
  template: 'forge.templateTab',
  ai: 'forge.aiTab',
};

/** The part of a stored config that identifies what was cloned. */
function configSubject(config: ForgeRunConfig): string | undefined {
  switch (config.inputMode) {
    case 'record':
      return config.recordId;
    case 'soql':
      return config.soqlQuery;
    case 'template':
      return config.templateId;
    case 'ai':
      return config.aiPrompt;
  }
}

/** Props for the ForgeHistoryPanel component. */
export interface ForgeHistoryPanelProps {
  /** Past runs the extension persisted, newest first. */
  entries: ForgeExecutionResult[];
  /** Error raised while loading the history, or null. */
  error: string | null;
  /** Refill the Forge form from a past run's configuration. */
  onReuseConfig: (config: ForgeRunConfig) => void;
}

/**
 * Past-runs list with one re-use button per entry.
 *
 * The extension keeps the last 20 runs together with the configuration that
 * produced each one, and nothing read that configuration back: a user cloning
 * the same graph every sprint retyped the whole form each time. Each entry
 * here refills the form from its stored config.
 *
 * It refills rather than launches, because Forge runs in three steps
 * (discover -> plan -> execute): the graph has to be rediscovered against the
 * orgs as they are today, and the user confirms the plan before any write.
 */
export const ForgeHistoryPanel: React.FC<ForgeHistoryPanelProps> = ({
  entries,
  error,
  onReuseConfig,
}) => {
  const { t } = useTranslation();
  const [reusedFrom, setReusedFrom] = useState<string | null>(null);

  if (entries.length === 0) {
    // A background fetch with nothing to show is silent; a failed one says so,
    // rather than leaving the user to wonder where their runs went.
    return error ? (
      <p
        data-testid="forge-history-error"
        role="status"
        className="text-[10px] text-text-muted mt-2"
      >
        {t('forge.history.loadError')}
      </p>
    ) : null;
  }

  return (
    <div data-testid="forge-history-panel" className="flex flex-col gap-1.5 mt-2">
      <div className="text-[10px] text-text-muted uppercase tracking-widest">
        {t('forge.history.title')}
      </div>

      {entries.map((entry) => {
        const config = entry.config;
        const when = format(new Date(entry.timestamp), 'yyyy-MM-dd HH:mm');
        const subject = config ? configSubject(config) : undefined;

        return (
          <div
            key={entry.forgeId}
            data-testid={`forge-history-entry-${entry.forgeId}`}
            className="flex items-center gap-2 px-3 py-2 rounded-md border border-subtle bg-surface-2"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-text-secondary">{when}</span>
                <span className={cn('text-[10px] font-semibold', STATUS_CLASSES[entry.status])}>
                  {t(STATUS_KEYS[entry.status])}
                </span>
              </div>
              {config && (
                <span className="block text-[11px] text-text-muted truncate">
                  {[t(MODE_KEYS[config.inputMode]), subject, t(DEPTH_KEYS[config.depth])]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
            </div>

            <button
              type="button"
              data-testid={`forge-history-rerun-${entry.forgeId}`}
              disabled={!config}
              onClick={() => {
                if (!config) return;
                onReuseConfig(config);
                setReusedFrom(when);
              }}
              title={config ? t('forge.history.reuseHint') : t('forge.history.noConfig')}
              className={cn(
                'shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium',
                'border border-forge/30 bg-forge/5 text-forge',
                'hover:bg-forge/10 hover:border-forge/50 transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-forge/5',
              )}
            >
              <RotateCcw size={11} />
              {t('forge.history.reuse')}
            </button>
          </div>
        );
      })}

      {reusedFrom !== null && (
        <p
          data-testid="forge-history-reused"
          role="status"
          className="text-[10px] text-forge mt-0.5"
        >
          {t('forge.history.reused', { date: reusedFrom })}
        </p>
      )}
    </div>
  );
};
