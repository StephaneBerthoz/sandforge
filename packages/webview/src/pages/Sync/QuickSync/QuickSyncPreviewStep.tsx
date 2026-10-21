import React from 'react';
import { useTranslation } from 'react-i18next';
import type { QuickSyncPreview, SyncExecutionResult } from '@sandforge/shared';
import type { BadgeVariant } from '../../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { ProgressBar } from '../../../components/ui/ProgressBar';
import { SyncRunControls } from '../SyncRunControls';
import { RecordErrorGroups } from '../../../components/ui/RecordErrorGroups';
import { SyncPricebookLine } from '../SyncPricebookLine';
import { ForgeCurrenciesResult } from '../../Forge/ForgeCurrenciesResult';
import { PriceCurrenciesResult } from '../../Forge/PriceCurrenciesResult';
import { SyncEarlierCopiesNotice } from '../SyncEarlierCopies';
import { SyncRunRemoval } from '../SyncRunRemoval';
import { SyncWrittenLines, hasWrittenLines } from '../SyncWrittenLines';
import { ForgeContactPointsResult } from '../../Forge/ForgeContactPointsResult';

/** Props for the QuickSyncPreviewStep component. */
export interface QuickSyncPreviewStepProps {
  /** Preview data from the backend. */
  preview: QuickSyncPreview | null;
  /** Execution result after sync completes. */
  result: SyncExecutionResult | null;
  /** Whether sync is currently executing. */
  isExecuting: boolean;
  /** The id the extension runs the sync under, once sent: what Pause and Cancel name. */
  runOperationId?: string | null;
  /** Callback to execute the sync. */
  onExecute: () => void;
  /** Callback to reset and start a new Quick Sync. */
  onReset: () => void;
  /** Callback to go back to previous step. */
  onBack: () => void;
  /** The orgs the sync goes between: what the last run between them left in the target is said. */
  sourceOrgId?: string;
  targetOrgId?: string;
  /** Open the history entry of the run of this operation id; absent, the results offer no way there. */
  onOpenHistory?: (operationId: string) => void;
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
  runOperationId = null,
  onExecute,
  onReset,
  onBack,
  sourceOrgId = '',
  targetOrgId = '',
  onOpenHistory,
}) => {
  const { t } = useTranslation();

  // During execution
  if (isExecuting) {
    return (
      <div className="flex flex-col gap-4 py-4" data-testid="quick-sync-executing">
        {/* Quick Sync hears no figure until the run ends: the bar says it is
            busy, not a percentage. */}
        <ProgressBar indeterminate label={t('quickSync.executing')} variant="default" />
        <SyncRunControls operationId={runOperationId} kind="run" />
      </div>
    );
  }

  // After execution — results view (reuses SyncPage Step6 pattern)
  if (result) {
    return (
      <div className="flex flex-col gap-3" data-testid="quick-sync-results">
        <div className="flex items-center gap-3 text-xs" data-testid="quick-sync-result-summary">
          {/* A run a cancel stopped reads as cancelled, as on the Sync tab. */}
          {result.cancelled ? (
            <Badge variant="default">{t('home.opStatus.cancelled')}</Badge>
          ) : (
            <Badge variant={statusVariant[result.status]}>
              {result.status === 'success'
                ? t('quickSync.complete')
                : result.status === 'partial'
                  ? t('sync.partial')
                  : t('sync.failed')}
            </Badge>
          )}
          <span>
            {t('sync.totalProcessed')}: <strong>{result.totalProcessed}</strong>
          </span>
          <span>
            {t('sync.totalSuccess')}: <strong>{result.totalSuccess}</strong>
          </span>
          {result.totalFailed > 0 && (
            <span className="text-status-error">
              {t('sync.totalFailed')}: <strong>{result.totalFailed}</strong>
            </span>
          )}
        </div>
        {/* What the run created, and its removal, as the Sync tab offers it:
            Quick Sync inserts every record, so a wrong pick or a run started
            twice was taken back only from the History tab, which nothing here
            named. */}
        {result.created && (
          <SyncRunRemoval runId={result.created.runId} testId="quick-sync-result-removal" />
        )}
        {/* The emails and phone numbers it wrote, said once for the run. */}
        {result.contactPoints && <ForgeContactPointsResult report={result.contactPoints} />}
        {result.objectResults.map((obj) => (
          <Card key={obj.objectApiName}>
            <CardHeader
              title={obj.objectApiName}
              subtitle={`${t(`sync.operations.${obj.operation}`)} — ${obj.success}/${obj.processed}`}
            />
            {(obj.errors.length > 0 ||
              obj.standardPricebookMatched ||
              hasWrittenLines(obj) ||
              (obj.currenciesReplaced?.length ?? 0) > 0 ||
              (obj.pricesSettled?.length ?? 0) > 0) && (
              <CardBody>
                {/* No refusal: said beside the object's line, as the Sync tab says it. */}
                {obj.standardPricebookMatched && (
                  <SyncPricebookLine testId={`quick-sync-result-pricebook-${obj.objectApiName}`} />
                )}
                <SyncWrittenLines
                  result={obj}
                  testId={`quick-sync-result-written-${obj.objectApiName}`}
                />
                <RecordErrorGroups
                  objectApiName={obj.objectApiName}
                  errors={obj.errors}
                  {...(obj.refusalsDropped
                    ? {
                        recordsFailed: obj.failed,
                        recordsListed: obj.failed - obj.refusalsDropped,
                      }
                    : {})}
                  testIdPrefix="quick-sync-result"
                />
                {/* No refusal either: the rows written in another currency, and
                    the prices read in one the target lacks, said as the Sync
                    tab and its history say them. Quick Sync runs the same
                    sync, and its results said neither. */}
                {obj.currenciesReplaced && obj.currenciesReplaced.length > 0 && (
                  <ForgeCurrenciesResult entries={obj.currenciesReplaced} />
                )}
                {obj.pricesSettled && obj.pricesSettled.length > 0 && (
                  <PriceCurrenciesResult entries={obj.pricesSettled} />
                )}
              </CardBody>
            )}
          </Card>
        ))}
        {/* What comes next: a second Quick Sync inserts the same records
            again, and the run's history entry holds what it wrote. */}
        {result.created && (
          <p className="text-xs text-text-secondary" data-testid="quick-sync-again-inserts">
            {t('quickSync.againInserts')}
          </p>
        )}
        <div className="flex justify-center gap-(--sf-space-2) mt-2">
          {onOpenHistory && (
            <Button
              variant="secondary"
              onClick={() => onOpenHistory(result.operationId)}
              data-testid="quick-sync-open-history"
            >
              {t('quickSync.openHistory')}
            </Button>
          )}
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
      <p className="text-xs text-(--sf-text-secondary)">{t('quickSync.preview')}</p>

      {preview && (
        <>
          {/* Summary bar */}
          <div
            className="flex items-center gap-4 text-xs text-(--sf-text-primary)"
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
                className="flex items-center justify-between px-3 py-2 rounded-sm bg-(--sf-bg-primary) border border-(--sf-border)"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-(--sf-text-primary)">
                    {obj.objectApiName}
                  </span>
                  {obj.isParentDependency && (
                    <Badge variant="warning" className="text-[8px]">
                      {t('quickSync.parentDependency')}
                    </Badge>
                  )}
                </div>
                {/* The records are counted; the calls are a guess — one for
                    each batch of them — and are said to be one, as the
                    summary above says its own. */}
                <div className="flex items-center gap-4 text-[10px] text-(--sf-text-secondary)">
                  <span>{t('common.recordCount', { count: obj.recordCount })}</span>
                  <span>{t('common.estimatedApiCallCount', { count: obj.estimatedApiCalls })}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Quick Sync inserts every record, every time: what the last run
          between these orgs created that is still in the target is said
          before it inserts it again. */}
      {preview && (
        <SyncEarlierCopiesNotice
          sourceOrgId={sourceOrgId}
          targetOrgId={targetOrgId}
          objects={preview.objects.map((obj) => obj.objectApiName)}
          context="quickSync"
          testId="quick-sync-earlier-copies"
        />
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
