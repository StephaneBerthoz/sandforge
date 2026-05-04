import React from 'react';
import { useTranslation } from 'react-i18next';
import type { QuickSyncPreview, SyncExecutionResult } from '@sandforge/shared';
import type { BadgeVariant } from '../../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { ProgressBar } from '../../../components/ui/ProgressBar';

/** Props for the QuickSyncPreviewStep component. */
export interface QuickSyncPreviewStepProps {
  /** Preview data from the backend. */
  preview: QuickSyncPreview | null;
  /** Execution result after sync completes. */
  result: SyncExecutionResult | null;
  /** Whether sync is currently executing. */
  isExecuting: boolean;
  /** Callback to execute the sync. */
  onExecute: () => void;
  /** Callback to reset and start a new Quick Sync. */
  onReset: () => void;
  /** Callback to go back to previous step. */
  onBack: () => void;
}

const statusVariant: Record<string, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
};

/**
 * Quick Sync Screen 3: Preview and execute.
 *
 * Before execution: shows preview data with object breakdown, record counts,
 * API call estimates, and a prominent "Sync Now" button.
 * During execution: shows a progress bar.
 * After execution: reuses the SyncPage Step6 results pattern.
 */
export const QuickSyncPreviewStep: React.FC<QuickSyncPreviewStepProps> = ({
  preview,
  result,
  isExecuting,
  onExecute,
  onReset,
  onBack,
}) => {
  const { t } = useTranslation();

  // During execution
  if (isExecuting) {
    return (
      <div className="flex flex-col gap-4 py-4" data-testid="quick-sync-executing">
        <ProgressBar
          value={50}
          max={100}
          label={t('quickSync.executing')}
          showPercent={false}
          variant="default"
        />
      </div>
    );
  }

  // After execution — results view (reuses SyncPage Step6 pattern)
  if (result) {
    return (
      <div className="flex flex-col gap-3" data-testid="quick-sync-results">
        <div className="flex items-center gap-3 text-xs" data-testid="quick-sync-result-summary">
          <Badge variant={statusVariant[result.status]}>
            {result.status === 'success'
              ? t('quickSync.complete')
              : result.status === 'partial'
                ? t('sync.partial')
                : t('sync.failed')}
          </Badge>
          <span>
            {t('sync.totalProcessed')}: <strong>{result.totalProcessed}</strong>
          </span>
          <span>
            {t('sync.totalSuccess')}: <strong>{result.totalSuccess}</strong>
          </span>
          {result.totalFailed > 0 && (
            <span className="text-[var(--vscode-errorForeground,#f48771)]">
              {t('sync.totalFailed')}: <strong>{result.totalFailed}</strong>
            </span>
          )}
        </div>
        {result.objectResults.map((obj) => (
          <Card key={obj.objectApiName}>
            <CardHeader
              title={obj.objectApiName}
              subtitle={`${t(`sync.operations.${obj.operation}`)} — ${obj.success}/${obj.processed}`}
            />
            {obj.errors.length > 0 && (
              <CardBody>
                {obj.errors.map((err, i) => (
                  <p key={i} className="text-[10px] text-[var(--vscode-errorForeground,#f48771)]">
                    {err}
                  </p>
                ))}
              </CardBody>
            )}
          </Card>
        ))}
        <div className="flex justify-center mt-2">
          <Button variant="primary" onClick={onReset} data-testid="quick-sync-new-btn">
            {t('quickSync.newQuickSync')}
          </Button>
        </div>
      </div>
    );
  }

  // Before execution — preview view
  return (
    <div className="flex flex-col gap-4" data-testid="quick-sync-preview-step">
      <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
        {t('quickSync.preview')}
      </p>

      {preview && (
        <>
          {/* Summary bar */}
          <div
            className="flex items-center gap-4 text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]"
            data-testid="quick-sync-preview-summary"
          >
            <Badge variant="info">
              {t('quickSync.objectCount', { count: preview.objects.length })}
            </Badge>
            <span>
              {t('quickSync.totalRecords')}: <strong>{preview.totalRecords}</strong>
            </span>
            <span>
              {t('quickSync.totalApiCalls')}: <strong>{preview.totalApiCalls}</strong>
            </span>
            <span>
              {t('quickSync.estimatedDuration')}:{' '}
              <strong>{t('quickSync.seconds', { count: preview.estimatedDurationSec })}</strong>
            </span>
          </div>

          {/* Per-object table */}
          <div className="flex flex-col gap-2" data-testid="quick-sync-preview-objects">
            {preview.objects.map((obj) => (
              <div
                key={obj.objectApiName}
                className="flex items-center justify-between px-3 py-2 rounded bg-[var(--vscode-editor-background,#1e1e1e)] border border-[var(--vscode-panel-border,#3c3c3c)]"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                    {obj.objectApiName}
                  </span>
                  {obj.isParentDependency && (
                    <Badge variant="warning" className="text-[8px]">
                      {t('quickSync.parentDependency')}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-4 text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                  <span>{obj.recordCount} records</span>
                  <span>{obj.estimatedApiCalls} API</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Navigation */}
      <div className="flex justify-between mt-2">
        <Button variant="ghost" onClick={onBack} data-testid="quick-sync-preview-back">
          {t('quickSync.back')}
        </Button>
        <Button variant="primary" size="lg" onClick={onExecute} data-testid="quick-sync-go-btn">
          {t('quickSync.go')}
        </Button>
      </div>
    </div>
  );
};
